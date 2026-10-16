import { Room } from './room.js';
import { genCode, randHex, parseCookies, json, setCookie, normCode, CODE_RE } from './util.js';

export { Room };

const MAX_UPLOAD = 50 * 1024 * 1024;
const EXTS = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
};

function stubOf(env, code) {
  return env.ROOM.get(env.ROOM.idFromName(code));
}

function errStatus(error) {
  return { exists: 409, gone: 404, forbidden: 403, bad: 400 }[error] || 500;
}

function respond(r) {
  if (r && r.error) return json({ error: r.error }, errStatus(r.error));
  return json(r || {});
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function guestRandFor(request, code) {
  return parseCookies(request)['g_' + code] || null;
}

function hostRandFor(request, code) {
  return parseCookies(request)['h_' + code] || null;
}

function checkOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

function extOf(key) {
  const m = /\.([a-z0-9]+)$/i.exec(key);
  return m ? m[1].toLowerCase() : '';
}

function fileHeaders(key, ext, size, etag) {
  const headers = new Headers({
    'Content-Type': EXTS[ext] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  });
  if (etag) headers.set('ETag', etag);
  return headers;
}

async function handleFile(request, env, url, parts) {
  const code = normCode(parts[1]);
  const key = parts.slice(2).join('/');
  if (!CODE_RE.test(code) || !CODE_RE.test(key.split('/')[0] || '')) {
    return json({ error: 'bad' }, 400);
  }
  if (!/^[A-Za-z0-9]+\/[A-Za-z0-9]+\.[a-z0-9]+$/.test(key)) {
    return json({ error: 'bad' }, 400);
  }
  const rand = hostRandFor(request, code) || guestRandFor(request, code);
  const info = await stubOf(env, code).fileAuth(rand, key);
  if (info.error) return respond(info);

  const ext = extOf(key);
  const rangeHeader = request.headers.get('Range');

  if (request.method === 'HEAD') {
    const head = await env.AUDIO.head(key);
    if (!head) return json({ error: 'gone' }, 404);
    const headers = fileHeaders(key, ext, head.size, head.httpEtag);
    let status = 200;
    if (rangeHeader) {
      const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      if (m && m[1] !== '') {
        const start = Number(m[1]);
        const end = m[2] !== '' ? Math.min(Number(m[2]), head.size - 1) : head.size - 1;
        if (start > 0 || m[2] !== '') {
          status = 206;
          headers.set('Content-Range', `bytes ${start}-${end}/${head.size}`);
        }
      }
    }
    return new Response(null, { status, headers });
  }

  const obj = await env.AUDIO.get(
    key,
    rangeHeader ? { range: new Headers({ Range: rangeHeader }) } : {}
  );
  if (!obj) return json({ error: 'gone' }, 404);
  const total = info.size > 0 ? info.size : obj.size;
  const headers = fileHeaders(key, ext, total, obj.httpEtag);
  let status = 200;
  const r = obj.range;
  if (rangeHeader && r) {
    status = 206;
    let start = 0;
    let len = total;
    if (r.offset !== undefined) {
      start = r.offset;
      len = r.length !== undefined ? r.length : total - start;
    } else if (r.suffix !== undefined) {
      len = Math.min(r.suffix, total);
      start = total - len;
    } else if (r.length !== undefined) {
      len = r.length;
      start = total - len;
    }
    if (start < 0) {
      len += start;
      start = 0;
    }
    headers.set('Content-Range', `bytes ${start}-${start + len - 1}/${total}`);
  }
  return new Response(obj.body, { status, headers });
}

function parseISO8601Dur(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(s || ''));
  if (!m) return 0;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}

const ytCache = new Map();

async function ytSearch(env, q) {
  if (!env.YT_API_KEY) return { results: [], searchOpen: false };
  const key = q.toLowerCase();
  const now = Date.now();
  const hit = ytCache.get(key);
  if (hit && now - hit.at < 10 * 60 * 1000) return { results: hit.results, searchOpen: true };
  try {
    const url =
      'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=8&q=' +
      encodeURIComponent(q) +
      '&key=' +
      encodeURIComponent(env.YT_API_KEY);
    const res = await fetch(url);
    if (!res.ok) return { results: [], searchOpen: true };
    const data = await res.json();
    const ids = (data.items || [])
      .map((i) => (i.id && i.id.videoId) || null)
      .filter(Boolean)
      .slice(0, 8);
    if (!ids.length) {
      ytCache.set(key, { at: now, results: [] });
      return { results: [], searchOpen: true };
    }
    const vres = await fetch(
      'https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=' +
        ids.join(',') +
        '&key=' +
        encodeURIComponent(env.YT_API_KEY)
    );
    if (!vres.ok) return { results: [], searchOpen: true };
    const vdata = await vres.json();
    const results = (vdata.items || []).map((v) => ({
      id: v.id,
      title: String((v.snippet && v.snippet.title) || 'Untitled').slice(0, 80),
      thumb:
        (v.snippet &&
          v.snippet.thumbnails &&
          (v.snippet.thumbnails.medium || v.snippet.thumbnails.default) &&
          (v.snippet.thumbnails.medium || v.snippet.thumbnails.default).url) ||
        '',
      duration: parseISO8601Dur(v.contentDetails && v.contentDetails.duration),
    }));
    if (ytCache.size > 200) ytCache.delete(ytCache.keys().next().value);
    ytCache.set(key, { at: now, results });
    return { results, searchOpen: true };
  } catch {
    return { results: [], searchOpen: true };
  }
}

function ytIdFromUrl(u) {
  let m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(u);
  if (m) return m[1];
  m = /(?:youtu\.be\/|youtube\.com\/(?:embed|shorts|live)\/)([A-Za-z0-9_-]{11})/.exec(u);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(u)) return u;
  return null;
}

function scIdFromUrl(u) {
  const m = /^soundcloud\.com\/[\w-]+\/[\w-]+(?:\/[\w-]+)?\/?(?:[?#].*)?$/.exec(String(u || '').replace(/^https?:\/\/(www\.|m\.)?/i, '').trim());
  if (!m) return null;
  return m[0];
}

async function resolveLink(rawUrl) {
  const u = String(rawUrl || '').trim();
  if (!u) return { error: 'bad' };
  const yt = ytIdFromUrl(u);
  if (yt) return { source: 'yt', externalId: yt, title: 'YouTube video ' + yt, thumb: '', duration: 0 };
  const sc = scIdFromUrl(u);
  if (sc) {
    let title = 'SoundCloud track';
    let thumb = '';
    try {
      const res = await fetch('https://soundcloud.com/oembed?format=json&url=' + encodeURIComponent('https://' + sc));
      if (res.ok) {
        const data = await res.json();
        if (data.title) title = String(data.title).slice(0, 80);
        if (data.thumbnail_url) thumb = String(data.thumbnail_url).slice(0, 500);
      }
    } catch {}
    return { source: 'sc', externalId: sc, title, thumb, duration: 0 };
  }
  return { error: 'bad' };
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/room' && method === 'POST') {
    if (!checkOrigin(request, url)) return json({ error: 'forbidden' }, 403);
    const body = await readJSON(request);
    for (let i = 0; i < 4; i++) {
      const code = genCode();
      const r = await stubOf(env, code).create(body && body.name);
      if (r && r.error === 'exists') continue;
      if (r && r.error) return respond(r);
      const res = json({ code, state: r.state });
      setCookie(res, 'h_' + code, r.hostRand);
      return res;
    }
    return json({ error: 'busy' }, 503);
  }

  if (path === '/api/join' && method === 'POST') {
    if (!checkOrigin(request, url)) return json({ error: 'forbidden' }, 403);
    const body = await readJSON(request);
    const code = normCode(body && body.code);
    if (!CODE_RE.test(code)) return json({ error: 'bad' }, 400);
    const r = await stubOf(env, code).join(body && body.name, guestRandFor(request, code));
    if (r.error) return respond(r);
    const res = json({ state: r.state, meta: { role: 'guest', me: r.me } });
    setCookie(res, 'g_' + code, r.guestRand);
    return res;
  }

  if (path === '/api/state' && method === 'GET') {
    const code = normCode(url.searchParams.get('code'));
    if (!CODE_RE.test(code)) return json({ error: 'bad' }, 400);
    const rand = hostRandFor(request, code) || guestRandFor(request, code);
    const r = await stubOf(env, code).read(rand);
    return respond(r);
  }

  if (path === '/api/upload' && method === 'POST') {
    if (!checkOrigin(request, url)) return json({ error: 'forbidden' }, 403);
    const code = normCode(url.searchParams.get('code'));
    if (!CODE_RE.test(code)) return json({ error: 'bad' }, 400);
    const ext = String(url.searchParams.get('ext') || '').toLowerCase();
    if (!EXTS[ext]) return json({ error: 'bad' }, 400);
    const rand = guestRandFor(request, code);
    if (!rand) return json({ error: 'forbidden' }, 403);
    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_UPLOAD) return json({ error: 'too large' }, 413);
    if (!request.body) return json({ error: 'bad' }, 400);
    const path = `${code}/${randHex(16)}.${ext}`;
    const put = await env.AUDIO.put(path, request.body, {
      httpMetadata: { contentType: EXTS[ext] },
    });
    if (!put) return json({ error: 'upload failed' }, 500);
    const r = await stubOf(env, code).addTrack(
      rand,
      url.searchParams.get('title'),
      path,
      ext,
      put.size,
      Number(url.searchParams.get('duration'))
    );
    if (r.error) {
      try {
        await env.AUDIO.delete(path);
      } catch {}
      return respond(r);
    }
    return respond(r);
  }

  if (path === '/api/ytsearch' && method === 'GET') {
    const code = normCode(url.searchParams.get('code'));
    if (!CODE_RE.test(code)) return json({ error: 'bad' }, 400);
    const rand = hostRandFor(request, code) || guestRandFor(request, code);
    if (!rand) return json({ error: 'forbidden' }, 403);
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);
    if (!q) return json({ error: 'bad' }, 400);
    return json(await ytSearch(env, q));
  }

  if (path === '/api/addlink' && method === 'POST') {
    if (!checkOrigin(request, url)) return json({ error: 'forbidden' }, 403);
    const body = await readJSON(request);
    const code = normCode(body && body.code);
    if (!CODE_RE.test(code)) return json({ error: 'bad' }, 400);
    const rand = guestRandFor(request, code);
    if (!rand) return json({ error: 'forbidden' }, 403);
    const r = await resolveLink(body && body.url);
    if (r.error) return respond(r);
    return respond(
      await stubOf(env, code).addExternal(
        rand,
        r.title,
        r.source,
        r.externalId,
        r.thumb,
        r.duration
      )
    );
  }

  const mutations = {
    '/api/play': async (stub, rand, body) => stub.play(rand, body.trackId == null ? null : Number(body.trackId)),
    '/api/reorder': async (stub, rand, body) => stub.reorder(rand, body.personIds),
    '/api/pin': async (stub, rand, body) => stub.pin(rand, Number(body.personId), !!body.on),
    '/api/veto': async (stub, rand, body) => stub.veto(rand, Number(body.trackId)),
    '/api/sort': async (stub, rand) => stub.sortLeastPlayed(rand),
    '/api/withdraw': async (stub, rand) => stub.withdraw(rand),
    '/api/end': async (stub, rand) => stub.end(rand),
  };

  const mutation = mutations[path];
  if (mutation && method === 'POST') {
    if (!checkOrigin(request, url)) return json({ error: 'forbidden' }, 403);
    const body = await readJSON(request);
    const code = normCode(body && body.code);
    if (!CODE_RE.test(code)) return json({ error: 'bad' }, 400);
    const rand = hostRandFor(request, code) || guestRandFor(request, code);
    if (!rand) return json({ error: 'forbidden' }, 403);
    const r = await mutation(stubOf(env, code), rand, body);
    return respond(r);
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      if (parts[0] === 'api') return await handleApi(request, env, url);
      if (parts[0] === 'file') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return json({ error: 'bad' }, 405);
        }
        return await handleFile(request, env, url, parts);
      }
      if (parts[0] === 'ws') {
        const code = normCode(parts[1]);
        if (!CODE_RE.test(code)) return json({ error: 'bad' }, 400);
        if (request.headers.get('Upgrade') !== 'websocket') {
          return json({ error: 'bad' }, 400);
        }
        const origin = request.headers.get('Origin');
        if (origin && new URL(origin).host !== url.host) {
          return new Response('forbidden', { status: 403 });
        }
        return stubOf(env, code).fetch(request);
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e);
      return json({ error: 'server' }, 500);
    }
  },
};
