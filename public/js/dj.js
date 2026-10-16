import {
  api,
  errMsg,
  fmtTime,
  toast,
  connectRoom,
  firstQueued,
  findTrack,
  CODE_RE,
} from './common.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const audio = $('audio');
const code = (params.get('c') || '').toUpperCase();

let state = null;
let channel = null;
let dragging = null;
let pendingState = null;
let raf = null;
let autoAdv = true;
let vol = 80;

function setFill(el, pct) {
  el.style.setProperty('--p', pct + '%');
}

function loadPrefs() {
  try {
    const a = localStorage.getItem('crate.auto');
    if (a !== null) autoAdv = a === '1';
    const v = Number(localStorage.getItem('crate.vol'));
    if (Number.isFinite(v) && v >= 0 && v <= 100) vol = v;
  } catch {}
  $('autoAdv').checked = autoAdv;
  $('vol').value = vol;
  setFill($('vol'), vol);
  audio.volume = vol / 100;
}

function savePrefs() {
  try {
    localStorage.setItem('crate.auto', autoAdv ? '1' : '0');
    localStorage.setItem('crate.vol', String(vol));
  } catch {}
}

function endedScreen() {
  if (channel) channel.close();
  $('djApp').hidden = true;
  const d = document.createElement('div');
  d.className = 'denied';
  d.innerHTML = '';
  const logo = document.createElement('div');
  logo.className = 'logo';
  logo.textContent = 'CRATE';
  const p = document.createElement('p');
  p.textContent = 'Party over. The crate is empty now.';
  const a = document.createElement('a');
  a.className = 'primary big';
  a.href = '/';
  a.textContent = 'Start a new one';
  d.appendChild(logo);
  d.appendChild(p);
  d.appendChild(a);
  document.body.appendChild(d);
}

function connectNow() {
  if (channel) channel.close();
  channel = connectRoom(code, (s) => {
    if (s.ended || s.error === 'gone') {
      endedScreen();
      return;
    }
    if (dragging) {
      pendingState = s;
      return;
    }
    state = s;
    render();
  });
}

function personOf(id) {
  return (state.people || []).find((p) => p.id === id) || null;
}

function setText(el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove('np-in');
  void el.offsetWidth;
  el.classList.add('np-in');
}

function renderUpNext() {
  const box = $('upNext');
  const next = state ? firstQueued(state) : null;
  box.textContent = '';
  const tag = document.createElement('span');
  tag.className = 'un-tag';
  tag.textContent = 'Up next';
  const title = document.createElement('span');
  title.className = 'un-title';
  title.textContent = next ? next.track.title : 'the crate is empty';
  box.appendChild(tag);
  box.appendChild(title);
  if (next) {
    const who = document.createElement('span');
    who.className = 'un-who';
    who.textContent = 'from ' + next.person.name;
    box.appendChild(who);
  }
}

function renderNow() {
  const found = state.nowTrack ? findTrack(state, state.nowTrack) : null;
  if (!found) {
    setText($('nowTitle'), 'Nothing yet');
    $('nowTitle').classList.add('idle');
    $('nowPerson').textContent = '';
    return;
  }
  $('nowTitle').classList.remove('idle');
  setText($('nowTitle'), found.track.title);
  $('nowPerson').textContent = 'from ' + found.person.name;
}

function render() {
  if (!state) return;
  renderNow();
  renderUpNext();
  renderQueue();
  renderHistory();
}

function renderQueue() {
  const list = $('queueList');
  list.textContent = '';
  const next = firstQueued(state);
  const people = state.people || [];
  for (const p of people) {
    const queued = p.tracks.filter((t) => t.status === 'queued');
    if (queued.length === 0 && p.played === 0) continue;
    const card = document.createElement('div');
    card.className = 'person dj-person' + (p.pinned ? ' pinned' : '');
    card.draggable = true;
    card.dataset.id = String(p.id);

    const head = document.createElement('div');
    head.className = 'person-head';
    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '::';
    const nm = document.createElement('span');
    nm.className = 'person-name';
    nm.textContent = p.name;
    head.appendChild(grip);
    head.appendChild(nm);
    if (p.pinned) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'PINNED';
      head.appendChild(b);
    }
    if (p.played > 0) {
      const b = document.createElement('span');
      b.className = 'badge played';
      b.textContent = 'played ' + p.played + 'x';
      head.appendChild(b);
    }
    const pinBtn = document.createElement('button');
    pinBtn.className = 'mini';
    pinBtn.textContent = p.pinned ? 'Unpin' : 'Pin';
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pinPerson(p.id, !p.pinned);
    });
    head.appendChild(pinBtn);
    card.appendChild(head);

    for (const t of queued) {
      const row = document.createElement('div');
      row.className = 'track' + (next && next.track.id === t.id ? ' next' : '');
      const tt = document.createElement('span');
      tt.className = 'track-title';
      tt.textContent = t.title;
      const td = document.createElement('span');
      td.className = 'track-dur';
      td.textContent = t.duration ? fmtTime(t.duration) : '';
      const play = document.createElement('button');
      play.className = 'mini primary-mini';
      play.textContent = 'Play';
      play.addEventListener('click', (e) => {
        e.stopPropagation();
        startTrack(t, p);
      });
      const veto = document.createElement('button');
      veto.className = 'mini danger-mini';
      veto.textContent = 'Veto';
      veto.addEventListener('click', (e) => {
        e.stopPropagation();
        vetoTrack(t);
      });
      row.appendChild(tt);
      row.appendChild(td);
      row.appendChild(play);
      row.appendChild(veto);
      card.appendChild(row);
    }

    if (queued.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = 'all played';
      card.appendChild(empty);
    }

    card.addEventListener('dragstart', (e) => {
      dragging = p.id;
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', String(p.id));
      } catch {}
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      dragging = null;
      if (pendingState) {
        state = pendingState;
        pendingState = null;
        render();
      }
    });
    card.addEventListener('dragover', (e) => {
      if (dragging == null || dragging === p.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      card.classList.add('dropto');
    });
    card.addEventListener('dragleave', () => card.classList.remove('dropto'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove('dropto');
      reorderBefore(dragging, p.id);
    });

    list.appendChild(card);
  }
  if (!list.children.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No requests yet. Show people the QR code.';
    list.appendChild(empty);
  }
}

const queueList = $('queueList');
queueList.addEventListener('dragover', (e) => {
  if (dragging == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});
queueList.addEventListener('drop', (e) => {
  if (dragging == null) return;
  e.preventDefault();
  reorderBefore(dragging, null);
});

function reorderBefore(dragId, beforeId) {
  const ids = (state.people || []).map((p) => p.id);
  const from = ids.indexOf(Number(dragId));
  if (from < 0) return;
  ids.splice(from, 1);
  if (beforeId != null) {
    const to = ids.indexOf(Number(beforeId));
    if (to >= 0) ids.splice(to, 0, Number(dragId));
    else ids.push(Number(dragId));
  } else {
    ids.push(Number(dragId));
  }
  api('/api/reorder', { code, personIds: ids })
    .then((d) => {
      state = d.state;
      render();
    })
    .catch((e) => toast(errMsg(e)));
}

function renderHistory() {
  const list = $('historyList');
  list.textContent = '';
  const rows = [];
  for (const p of state.people || []) {
    for (const t of p.tracks) {
      if (t.status === 'played' && t.playedAt) rows.push({ t, p });
    }
  }
  rows.sort((a, b) => b.t.playedAt - a.t.playedAt);
  $('historyEmpty').hidden = rows.length > 0;
  for (const r of rows.slice(0, 30)) {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'hist-time';
    const d = new Date(r.t.playedAt);
    time.textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const tt = document.createElement('span');
    tt.className = 'hist-title';
    tt.textContent = r.t.title;
    const who = document.createElement('span');
    who.className = 'hist-who';
    who.textContent = r.p.name;
    li.appendChild(time);
    li.appendChild(tt);
    li.appendChild(who);
    list.appendChild(li);
  }
}

function trackPath(t) {
  return '/file/' + code + '/' + t.path;
}

function startTrack(t, p) {
  api('/api/play', { code, trackId: t.id })
    .then((d) => {
      state = d.state;
      render();
      audio.src = trackPath(t);
      audio.play().catch(() => toast('Press Play to start the audio.'));
    })
    .catch((e) => toast(errMsg(e)));
}

function advance() {
  const next = firstQueued(state);
  if (next) {
    startTrack(next.track, next.person);
  } else {
    api('/api/play', { code, trackId: null })
      .then((d) => {
        state = d.state;
        render();
      })
      .catch(() => {});
  }
}

function clearNow() {
  api('/api/play', { code, trackId: null })
    .then((d) => {
      state = d.state;
      render();
    })
    .catch((e) => toast(errMsg(e)));
}

function pinPerson(id, on) {
  api('/api/pin', { code, personId: id, on })
    .then((d) => {
      state = d.state;
      render();
    })
    .catch((e) => toast(errMsg(e)));
}

function vetoTrack(t) {
  if (!confirm('Veto "' + t.title + '"? It gets removed.')) return;
  api('/api/veto', { code, trackId: t.id })
    .then((d) => {
      state = d.state;
      render();
      toast('Vetoed.');
    })
    .catch((e) => toast(errMsg(e)));
}

function togglePlay() {
  if (!audio.src) {
    const next = firstQueued(state);
    if (next) startTrack(next.track, next.person);
    else toast('The crate is empty.');
    return;
  }
  if (audio.paused) audio.play().catch(() => toast('Autoplay blocked, click again.'));
  else audio.pause();
}

function tick() {
  const dur = audio.duration || 0;
  const cur = audio.currentTime || 0;
  $('tCur').textContent = fmtTime(cur);
  $('tRem').textContent = dur ? '-' + fmtTime(Math.max(dur - cur, 0)) : '';
  const seek = $('seek');
  const active = seek.matches(':active') || document.activeElement === seek;
  if (!active && dur) seek.value = String(Math.round((cur / dur) * 1000));
  setFill(seek, Number(seek.value) / 10);
  raf = requestAnimationFrame(tick);
}

function syncPlaying() {
  const on = !!audio.src && !audio.paused;
  document.body.classList.toggle('playing', on);
  const btn = $('bigPlay');
  btn.classList.toggle('is-playing', on);
  btn.textContent = on ? 'Pause' : 'Play';
}

function bindControls() {
  $('bigPlay').addEventListener('click', togglePlay);
  $('seek').addEventListener('input', () => {
    if (audio.duration) audio.currentTime = ($('seek').value / 1000) * audio.duration;
  });
  $('vol').addEventListener('input', () => {
    vol = Number($('vol').value);
    audio.volume = vol / 100;
    setFill($('vol'), vol);
    savePrefs();
  });
  $('autoAdv').addEventListener('change', () => {
    autoAdv = $('autoAdv').checked;
    savePrefs();
  });
  $('sortBtn').addEventListener('click', () => {
    api('/api/sort', { code })
      .then((d) => {
        state = d.state;
        render();
        toast('Sorted by least played.');
      })
      .catch((e) => toast(errMsg(e)));
  });
  $('displayBtn').addEventListener('click', () => {
    document.body.classList.toggle('display');
  });
  $('endBtn').addEventListener('click', async () => {
    if (!confirm('End the party? Everything gets wiped.')) return;
    try {
      await api('/api/end', { code });
    } catch {}
    try {
      sessionStorage.removeItem('crate.meta.' + code);
      sessionStorage.removeItem('crate.last');
    } catch {}
    location.href = '/';
  });

  audio.addEventListener('play', syncPlaying);
  audio.addEventListener('playing', syncPlaying);
  audio.addEventListener('pause', syncPlaying);
  audio.addEventListener('ended', () => {
    syncPlaying();
    if (autoAdv) advance();
    else clearNow();
  });
  audio.addEventListener('error', () => {
    if (audio.src) toast('Could not play that file.');
  });

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'KeyN') {
      const next = firstQueued(state);
      if (next) startTrack(next.track, next.person);
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 5);
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
    } else if (e.code === 'ArrowUp') {
      e.preventDefault();
      vol = Math.min(100, vol + 5);
      $('vol').value = vol;
      audio.volume = vol / 100;
      setFill($('vol'), vol);
      savePrefs();
    } else if (e.code === 'ArrowDown') {
      e.preventDefault();
      vol = Math.max(0, vol - 5);
      $('vol').value = vol;
      audio.volume = vol / 100;
      setFill($('vol'), vol);
      savePrefs();
    } else if (e.code === 'KeyD') {
      document.body.classList.toggle('display');
    }
  });
}

function renderQR() {
  try {
    const url = location.origin + '/?c=' + code;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    let svg = '';
    try {
      svg = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    } catch {
      svg = qr.createSvgTag(5, 2);
    }
    $('qrCode').innerHTML = svg;
  } catch {}
}

function restorePosition(found) {
  audio.src = trackPath(found.track);
  audio.addEventListener(
    'loadedmetadata',
    () => {
      const elapsed = state.nowStarted ? (Date.now() - state.nowStarted) / 1000 : 0;
      if (isFinite(audio.duration) && elapsed >= audio.duration - 0.5) {
        if (autoAdv) advance();
        else audio.currentTime = Math.max(0, audio.duration - 0.5);
      } else {
        audio.currentTime = elapsed;
      }
    },
    { once: true }
  );
}

async function boot() {
  if (!CODE_RE.test(code)) {
    $('denied').hidden = false;
    return;
  }
  loadPrefs();
  bindControls();
  syncPlaying();
  let data;
  try {
    const res = await fetch('/api/state?code=' + code);
    data = await res.json();
    if (!res.ok) throw data;
  } catch {
    $('denied').hidden = false;
    return;
  }
  if (!data.meta || data.meta.role !== 'host') {
    $('denied').hidden = false;
    return;
  }
  state = data.state;
  $('djApp').hidden = false;
  $('codeBadge').textContent = code;
  $('codeBig').textContent = code;
  $('roomName').textContent = (state.name || 'Party') + ' — room ' + code;
  renderQR();
  render();
  connectNow();
  if (state.nowTrack) {
    const found = findTrack(state, state.nowTrack);
    if (found) restorePosition(found);
  }
  raf = requestAnimationFrame(tick);
}

boot();
