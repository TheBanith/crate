export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
export const EXT_OK = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'flac'];

export async function api(path, body) {
  const opts =
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        };
  const res = await fetch(path, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || 'http ' + res.status);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

export function errMsg(e) {
  const m = {
    forbidden: 'Not allowed.',
    gone: 'This party is over.',
    bad: 'Bad request.',
    'too large': 'That file is over 50MB.',
    server: 'Server hiccup, try again.',
    failed: 'Upload failed, try again.',
    added: 'Added to the crate.',
    linkbad: 'That link is not a YouTube or SoundCloud track.',
    searchoff: 'YouTube search needs an API key on the server.',
  };
  return (e && e.data && m[e.data.error]) || (e && e.message) || 'Something went wrong.';
}

export function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  s = Math.floor(s);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

export function getMeta(code) {
  try {
    return JSON.parse(sessionStorage.getItem('crate.meta.' + code)) || null;
  } catch {
    return null;
  }
}

export function setMeta(code, meta) {
  try {
    sessionStorage.setItem('crate.meta.' + code, JSON.stringify(meta));
    sessionStorage.setItem('crate.last', code);
  } catch {}
}

export function connectRoom(code, onState) {
  let ws = null;
  let closed = false;
  let fails = 0;
  let pingTimer = null;
  let pollTimer = null;

  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/state?code=' + code);
        if (!res.ok) {
          onState({ ended: true });
          close();
          return;
        }
        const data = await res.json();
        if (data.state) onState(data.state);
      } catch {}
    }, 5000);
  }

  function stopPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function open() {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      ws = new WebSocket(proto + '//' + location.host + '/ws/' + code);
    } catch {
      schedule();
      return;
    }
    ws.onopen = () => {
      fails = 0;
      stopPoll();
      stopPing();
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === 1) {
          try {
            ws.send('ping');
          } catch {}
        }
      }, 25000);
    };
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d && typeof d === 'object') onState(d);
      } catch {}
    };
    ws.onclose = () => {
      stopPing();
      if (closed) return;
      fails += 1;
      if (fails >= 3) startPoll();
      schedule();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  function schedule() {
    if (closed) return;
    setTimeout(open, 1500 + Math.random() * 1500);
  }

  function close() {
    closed = true;
    stopPing();
    stopPoll();
    try {
      if (ws) ws.close();
    } catch {}
  }

  open();
  return { close };
}

export function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}

export function firstQueued(state) {
  if (!state || !state.people) return null;
  for (const p of state.people) {
    for (const t of p.tracks) {
      if (t.status === 'queued') return { track: t, person: p };
    }
  }
  return null;
}

export function findTrack(state, id) {
  if (!state || !state.people) return null;
  for (const p of state.people) {
    for (const t of p.tracks) {
      if (t.id === id) return { track: t, person: p };
    }
  }
  return null;
}
