import {
  api,
  errMsg,
  fmtTime,
  toast,
  connectRoom,
  getMeta,
  setMeta,
  firstQueued,
  CODE_RE,
  EXT_OK,
} from './common.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let code = null;
let meta = null;
let state = null;
let channel = null;
let picked = null;
let pickedDur = 0;
let titleEdited = false;
let npRaf = null;

const landing = $('landing');
const app = $('app');

function showLanding() {
  landing.hidden = false;
  app.hidden = true;
}

function showApp() {
  landing.hidden = true;
  app.hidden = false;
  $('codeFoot').textContent = code;
  connectNow();
}

function connectNow() {
  if (channel) channel.close();
  channel = connectRoom(code, (s) => {
    if (s.ended || s.error) {
      toast('The party is over.');
      setTimeout(() => {
        try {
          sessionStorage.removeItem('crate.meta.' + code);
        } catch {}
        location.href = '/';
      }, 1500);
      return;
    }
    state = s;
    render();
  });
}

async function loadState() {
  const res = await fetch('/api/state?code=' + code);
  if (!res.ok) throw { data: { error: 'gone' }, status: res.status };
  const data = await res.json();
  state = data.state;
  if (data.meta && data.meta.role) meta = data.meta;
  render();
}

function render() {
  if (!state) return;
  renderNowPlaying();
  renderQueue();
  renderMine();
}

function renderNowPlaying() {
  const box = $('npTitle');
  const person = $('npPerson');
  if (!state.nowTrack) {
    box.textContent = 'Nothing yet';
    person.textContent = 'Waiting for the DJ to spin something';
    $('npFill').style.width = '0%';
    $('npCur').textContent = '0:00';
    $('npRem').textContent = '0:00';
    return;
  }
  let found = null;
  for (const p of state.people) {
    for (const t of p.tracks) if (t.id === state.nowTrack) found = { t, p };
  }
  if (!found) {
    box.textContent = 'Loading...';
    person.textContent = '';
    return;
  }
  box.textContent = found.t.title;
  person.textContent = 'from ' + found.p.name;
  if (npRaf) cancelAnimationFrame(npRaf);
  const tick = () => {
    if (!state.nowTrack) return;
    const dur = found.t.duration || 0;
    const el = Math.max(0, (Date.now() - (state.nowStarted || Date.now())) / 1000);
    $('npCur').textContent = fmtTime(el);
    $('npRem').textContent = dur ? fmtTime(Math.max(dur - el, 0)) : '';
    $('npFill').style.width = dur ? Math.min(100, (el / dur) * 100) + '%' : '0%';
    npRaf = requestAnimationFrame(tick);
  };
  tick();
}

function renderQueue() {
  const list = $('queueList');
  list.textContent = '';
  const next = firstQueued(state);
  const banner = $('nextBanner');
  if (next && meta && meta.role === 'guest' && next.person.id === meta.me) {
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
  const people = state.people || [];
  for (const p of people) {
    const queued = p.tracks.filter((t) => t.status === 'queued');
    const isMe = meta && meta.role === 'guest' && p.id === meta.me;
    if (queued.length === 0 && !isMe && p.played === 0) continue;
    const card = document.createElement('div');
    card.className = 'person' + (isMe ? ' me' : '') + (p.pinned ? ' pinned' : '');
    const head = document.createElement('div');
    head.className = 'person-head';
    const nm = document.createElement('span');
    nm.className = 'person-name';
    nm.textContent = p.name + (isMe ? ' (you)' : '');
    head.appendChild(nm);
    if (p.pinned) {
      const pin = document.createElement('span');
      pin.className = 'badge';
      pin.textContent = 'ON DECK';
      head.appendChild(pin);
    }
    if (p.played > 0) {
      const c = document.createElement('span');
      c.className = 'badge played';
      c.textContent = 'played ' + p.played + 'x';
      head.appendChild(c);
    }
    card.appendChild(head);
    if (queued.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = p.played > 0 ? 'everything played' : 'no tracks yet';
      card.appendChild(empty);
    }
    for (const t of queued) {
      const row = document.createElement('div');
      row.className = 'track' + (next && next.track.id === t.id ? ' next' : '');
      if (t.thumb || t.source === 'yt') {
        const art = document.createElement('img');
        art.className = 'track-art';
        art.alt = '';
        art.loading = 'lazy';
        art.referrerPolicy = 'no-referrer';
        art.src = t.thumb || (t.source === 'yt' ? 'https://i.ytimg.com/vi/' + t.externalId + '/default.jpg' : '');
        row.appendChild(art);
      }
      if (t.source && t.source !== 'file') {
        const src = document.createElement('span');
        src.className = 'badge src-' + t.source;
        src.textContent = t.source === 'yt' ? 'YT' : 'SC';
        row.appendChild(src);
      }
      const tt = document.createElement('span');
      tt.className = 'track-title';
      tt.textContent = t.title;
      const td = document.createElement('span');
      td.className = 'track-dur';
      td.textContent = t.duration ? fmtTime(t.duration) : '';
      row.appendChild(tt);
      row.appendChild(td);
      card.appendChild(row);
    }
    list.appendChild(card);
  }
  if (!list.children.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'The crate is empty. Be the first to drop something in.';
    list.appendChild(empty);
  }
}

function renderMine() {
  const withdraw = $('withdrawBtn');
  const status = $('myStatus');
  if (meta && meta.role === 'guest' && state.people) {
    const me = state.people.find((p) => p.id === meta.me);
    withdraw.hidden = !me;
    if (me) {
      const q = me.tracks.filter((t) => t.status === 'queued').length;
      status.textContent = q
        ? 'You have ' + q + ' song' + (q === 1 ? '' : 's') + ' in the crate'
        : 'You have nothing queued';
    } else {
      status.textContent = '';
    }
  } else {
    withdraw.hidden = true;
    status.textContent = '';
  }
}

async function enter(d) {
  meta = d.meta;
  state = d.state;
  setMeta(code, meta);
  showApp();
  render();
}

$('startBtn').addEventListener('click', async () => {
  $('startBtn').disabled = true;
  try {
    const d = await api('/api/room', { name: 'Party' });
    location.href = '/dj.html?c=' + d.code;
  } catch (e) {
    toast(errMsg(e));
    $('startBtn').disabled = false;
  }
});

$('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = $('codeInput').value.toUpperCase().trim();
  const name = $('nameInput').value.trim();
  if (!CODE_RE.test(c)) {
    showLandingErr('Room codes are 6 characters.');
    return;
  }
  if (!name) {
    showLandingErr('Pick a name so the DJ knows who to thank.');
    return;
  }
  try {
    const d = await api('/api/join', { code: c, name });
    code = c;
    await enter(d);
  } catch (err) {
    showLandingErr(errMsg(err));
  }
});

function showLandingErr(msg) {
  const el = $('landingErr');
  el.textContent = msg;
  el.hidden = false;
}

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

$('fileInput').addEventListener('change', async () => {
  const file = $('fileInput').files && $('fileInput').files[0];
  picked = null;
  pickedDur = 0;
  $('uploadBtn').disabled = true;
  const msg = $('fileMsg');
  if (!file) {
    $('fileLabel').textContent = 'Choose an audio file';
    msg.hidden = true;
    return;
  }
  const ext = extOf(file.name);
  if (!EXT_OK.includes(ext)) {
    msg.hidden = false;
    msg.textContent = 'Unsupported type. Use mp3, m4a, wav, ogg or flac.';
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    msg.hidden = false;
    msg.textContent = 'That file is over 50MB.';
    return;
  }
  msg.hidden = false;
  msg.textContent = 'Checking the file plays...';
  try {
    pickedDur = await probe(file);
  } catch {
    msg.textContent = "This file can't be played in a browser. Try an mp3.";
    return;
  }
  picked = file;
  $('fileLabel').textContent = file.name;
  msg.textContent = 'Ready: ' + fmtTime(pickedDur);
  if (!titleEdited) {
    $('titleInput').value = file.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').slice(0, 80);
  }
  $('uploadBtn').disabled = false;
});

function probe(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    let done = false;
    const finish = (ok, dur) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      a.removeAttribute('src');
      ok ? resolve(dur || 0) : reject(new Error('bad file'));
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => finish(true, isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => finish(false);
    setTimeout(() => finish(false), 10000);
    a.src = url;
  });
}

$('titleInput').addEventListener('input', () => {
  titleEdited = $('titleInput').value.length > 0;
});

$('uploadBtn').addEventListener('click', () => {
  if (!picked) return;
  const title = $('titleInput').value.trim() || picked.name;
  const ext = extOf(picked.name);
  $('uploadBtn').disabled = true;
  $('progWrap').hidden = false;
  $('progFill').style.width = '0%';
  const xhr = new XMLHttpRequest();
  const qs = new URLSearchParams({
    code,
    title,
    duration: String(pickedDur || 0),
    ext,
  });
  xhr.open('POST', '/api/upload?' + qs.toString());
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      $('progFill').style.width = Math.round((e.loaded / e.total) * 100) + '%';
    }
  };
  xhr.onload = () => {
    $('progWrap').hidden = true;
    let data = null;
    try {
      data = JSON.parse(xhr.responseText);
    } catch {}
    if (xhr.status === 200) {
      toast('Added to the crate.');
      picked = null;
      titleEdited = false;
      $('fileInput').value = '';
      $('fileLabel').textContent = 'Choose an audio file';
      $('titleInput').value = '';
      $('fileMsg').hidden = true;
      if (data.state) {
        state = data.state;
        render();
      }
    } else {
      toast(errMsg({ data }));
      $('uploadBtn').disabled = false;
    }
  };
  xhr.onerror = () => {
    $('progWrap').hidden = true;
    toast('Upload failed, try again.');
    $('uploadBtn').disabled = false;
  };
  xhr.send(picked);
});

$('withdrawBtn').addEventListener('click', async () => {
  if (!confirm('Remove your queued songs from the crate?')) return;
  try {
    const d = await api('/api/withdraw', { code });
    state = d.state;
    render();
    toast('Your songs were removed.');
  } catch (e) {
    toast(errMsg(e));
  }
});

const srcTabs = [
  ['tabUpload', 'paneUpload'],
  ['tabTube', 'paneTube'],
  ['tabLink', 'paneLink'],
];

for (const [tabId, paneId] of srcTabs) {
  $(tabId).addEventListener('click', () => {
    for (const [t, p] of srcTabs) {
      const on = t === tabId;
      $(t).classList.toggle('on', on);
      $(t).setAttribute('aria-selected', on ? 'true' : 'false');
      $(p).hidden = !on;
    }
  });
}

function renderYtItem(box, item) {
  const row = document.createElement('div');
  row.className = 'yt-item';
  if (item.thumb) {
    const art = document.createElement('img');
    art.className = 'track-art';
    art.alt = '';
    art.loading = 'lazy';
    art.referrerPolicy = 'no-referrer';
    art.src = item.thumb;
    row.appendChild(art);
  }
  const tt = document.createElement('span');
  tt.className = 'track-title';
  tt.textContent = item.title;
  row.appendChild(tt);
  const add = document.createElement('button');
  add.className = 'mini primary-mini';
  add.textContent = 'Add';
  add.addEventListener('click', async () => {
    add.disabled = true;
    try {
      const d = await api('/api/addlink', {
        code,
        url: 'https://www.youtube.com/watch?v=' + item.id,
      });
      state = d.state;
      render();
      toast('Added to the crate.');
    } catch (e) {
      toast(errMsg(e));
      add.disabled = false;
    }
  });
  row.appendChild(add);
  box.appendChild(row);
}

$('ytForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('ytQuery').value.trim();
  const box = $('ytList');
  const msg = $('ytMsg');
  box.textContent = '';
  msg.hidden = true;
  if (!q) return;
  msg.hidden = false;
  msg.textContent = 'Searching...';
  try {
    const res = await fetch('/api/ytsearch?code=' + code + '&q=' + encodeURIComponent(q));
    const d = await res.json();
    if (!res.ok) throw { data: d };
    if (!d.searchOpen) {
      msg.textContent = 'YouTube search needs an API key on the server. Paste a link instead.';
      return;
    }
    if (!d.results || !d.results.length) {
      msg.textContent = 'No results. Try different words.';
      return;
    }
    msg.hidden = true;
    for (const item of d.results) renderYtItem(box, item);
  } catch (err) {
    msg.hidden = false;
    msg.textContent = errMsg(err);
  }
});

$('linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('linkInput');
  const msg = $('linkMsg');
  msg.hidden = true;
  const link = input.value.trim();
  if (!link) return;
  try {
    const d = await api('/api/addlink', { code, url: link });
    state = d.state;
    render();
    input.value = '';
    toast('Added to the crate.');
  } catch (err) {
    msg.hidden = false;
    msg.textContent = err.data && err.data.error === 'bad' ? 'That link is not a YouTube or SoundCloud track.' : errMsg(err);
  }
});

async function boot() {
  const q = (params.get('c') || '').toUpperCase();
  if (q && CODE_RE.test(q)) {
    $('codeInput').value = q;
  }
  let last = null;
  try {
    last = sessionStorage.getItem('crate.last');
  } catch {}
  const tryCode = q || last;
  if (tryCode && CODE_RE.test(tryCode)) {
    const saved = getMeta(tryCode);
    if (saved && saved.role === 'guest') {
      code = tryCode;
      try {
        await loadState();
        showApp();
        return;
      } catch {
        code = null;
        try {
          sessionStorage.removeItem('crate.meta.' + tryCode);
          sessionStorage.removeItem('crate.last');
        } catch {}
      }
    }
  }
  showLanding();
}

boot();
