import assert from 'node:assert/strict';

const BASE = process.argv[2] || process.env.CRATE_URL || '';
if (!BASE) {
  console.error('usage: node selftest.mjs <base-url>');
  process.exit(2);
}
const base = BASE.replace(/\/+$/, '');

let passed = 0;
function ok(label) {
  passed++;
  console.log('  ok  ' + label);
}

async function call(method, path, opts = {}) {
  const jar = opts.jar || {};
  const headers = { ...(opts.headers || {}) };
  const cookieHeader = Object.entries(jar)
    .map(([k, v]) => k + '=' + v)
    .join('; ');
  if (cookieHeader) headers.Cookie = cookieHeader;
  let body;
  if (opts.raw !== undefined) {
    body = opts.raw;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(base + path, { method, headers, body });
  let setList = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (!setList.length && res.headers.get('set-cookie')) {
    setList = [res.headers.get('set-cookie')];
  }
  const newJar = { ...jar };
  for (const c of setList) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) {
      const name = pair.slice(0, i).trim();
      if (/^(h|g)_[A-Z2-9]{6}$/.test(name)) newJar[name] = pair.slice(i + 1).trim();
    }
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, jar: newJar, headers: res.headers };
}

function makeWav(ms = 120) {
  const rate = 8000;
  const samples = Math.floor((rate * ms) / 1000);
  const buf = Buffer.alloc(44 + samples);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i++) buf[44 + i] = 128 + Math.round(30 * Math.sin(i / 4));
  return buf;
}

function person(state, id) {
  return (state.people || []).find((p) => p.id === id) || null;
}

async function run() {
  console.log('crate selftest -> ' + base);
  const wav = makeWav();

  let r = await call('POST', '/api/room', { body: { name: 'Selftest' } });
  assert.equal(r.status, 200, 'create room status');
  const code = r.data.code;
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/, 'room code format');
  const hostJar = r.jar;
  assert.ok(hostJar['h_' + code], 'host cookie set');
  ok('create room + host cookie');

  r = await call('GET', '/api/state?code=' + code, { jar: hostJar });
  assert.equal(r.status, 200, 'host state status');
  assert.equal(r.data.meta.role, 'host', 'host role');
  ok('host sees role=host');

  r = await call('GET', '/api/state?code=' + code);
  assert.equal(r.status, 200, 'anon state status');
  assert.equal(r.data.meta.role, null, 'anon role');
  ok('anonymous read allowed, no role');

  r = await call('POST', '/api/join', { body: { code, name: 'Alice' } });
  assert.equal(r.status, 200, 'join A status');
  const jarA = r.jar;
  const meA = r.data.meta.me;
  assert.ok(jarA['g_' + code], 'A cookie set');
  assert.equal(r.data.meta.role, 'guest', 'A role');
  ok('guest A joins');

  r = await call('POST', '/api/join', { body: { code, name: 'Bob' } });
  assert.equal(r.status, 200, 'join B status');
  const jarB = r.jar;
  const meB = r.data.meta.me;
  assert.ok(jarB['g_' + code], 'B cookie set');
  ok('guest B joins');

  const uploadPath = (title, ext) =>
    '/api/upload?' +
    new URLSearchParams({ code, title, duration: '0.12', ext }).toString();

  r = await call('POST', uploadPath('Alice Song One', 'wav'), {
    jar: jarA,
    raw: wav,
    headers: { 'Content-Type': 'audio/wav' },
  });
  assert.equal(r.status, 200, 'upload1 status: ' + JSON.stringify(r.data));
  let alice = person(r.data.state, meA);
  assert.ok(alice && alice.tracks.length === 1, 'A has track after upload');
  const t1 = alice.tracks[0];
  ok('guest uploads a track');

  r = await call('POST', uploadPath('Alice Song Two', 'wav'), {
    jar: jarA,
    raw: wav,
    headers: { 'Content-Type': 'audio/wav' },
  });
  assert.equal(r.status, 200, 'upload2 status');
  const t2 = r.data.state.people.find((p) => p.id === meA).tracks[1];
  assert.ok(t2, 'A has second track');
  ok('second upload queued');

  r = await call('POST', uploadPath('Evil', 'exe'), {
    jar: jarA,
    raw: wav,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  assert.equal(r.status, 400, 'bad ext rejected');
  ok('bad extension rejected');

  r = await call('POST', uploadPath('No Cookie', 'wav'), {
    raw: wav,
    headers: { 'Content-Type': 'audio/wav' },
  });
  assert.equal(r.status, 403, 'cookieless upload rejected');
  ok('upload without session rejected');

  r = await call('POST', '/api/reorder', {
    jar: jarA,
    body: { code, personIds: [meB, meA] },
  });
  assert.equal(r.status, 403, 'guest reorder rejected');
  ok('guest cannot reorder');

  r = await call('POST', '/api/reorder', {
    jar: hostJar,
    body: { code, personIds: [meA, meB] },
  });
  assert.equal(r.status, 200, 'host reorder status');
  assert.equal(r.data.state.people[0].id, meA, 'order A first');
  assert.equal(r.data.state.people[1].id, meB, 'order B second');
  ok('host reorder works');

  r = await call('POST', '/api/play', { jar: hostJar, body: { code, trackId: t1.id } });
  assert.equal(r.status, 200, 'play status');
  let st = r.data.state;
  assert.equal(st.nowTrack, t1.id, 'now playing set');
  alice = person(st, meA);
  assert.equal(alice.played, 1, 'A played counter');
  assert.equal(alice.tracks.find((t) => t.id === t1.id).status, 'played', 't1 marked played');
  assert.equal(st.people[0].id, meB, 'A dropped to bottom after play');
  assert.equal(st.people[1].id, meA, 'A is last');
  ok('play marks played, bumps counter, drops requester to bottom');

  const hostCookie = 'h_' + code + '=' + hostJar['h_' + code];

  let res = await fetch(base + '/file/' + code + '/' + t1.path, {
    headers: { Cookie: hostCookie },
  });
  assert.equal(res.status, 200, 'file GET status');
  let bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.length, wav.length, 'file full length');
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF', 'file content');
  ok('full file stream with session cookie');

  res = await fetch(base + '/file/' + code + '/' + t1.path, {
    headers: { Cookie: hostCookie, Range: 'bytes=0-9' },
  });
  assert.equal(res.status, 206, 'range status');
  assert.equal(res.headers.get('content-range'), 'bytes 0-9/' + wav.length, 'content-range');
  bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.length, 10, 'range length');
  ok('ranged read (seek support) returns 206');

  res = await fetch(base + '/file/' + code + '/' + t1.path, {
    method: 'HEAD',
    headers: { Cookie: hostCookie },
  });
  assert.equal(res.status, 200, 'HEAD status');
  ok('HEAD request supported');

  res = await fetch(base + '/file/' + code + '/' + t1.path);
  const noAuth = res.status;
  res = await fetch(base + '/file/' + code + '/' + t1.path, {
    headers: { Cookie: 'g_' + code + '=deadbeef' },
  });
  assert.equal(res.status, 403, 'bad session rejected');
  assert.equal(noAuth, 403, 'missing session rejected');
  ok('file access requires valid session');

  r = await call('POST', '/api/withdraw', { jar: jarA, body: { code } });
  assert.equal(r.status, 200, 'withdraw status');
  st = r.data.state;
  alice = person(st, meA);
  assert.ok(alice, 'A still present (has played history)');
  assert.equal(alice.tracks.length, 1, 'queued t2 removed');
  assert.equal(alice.tracks[0].id, t1.id, 'played t1 kept');
  assert.equal(alice.played, 1, 'counter kept');
  ok('withdraw removes only queued tracks');

  r = await call('POST', uploadPath('Bob Track', 'wav'), {
    jar: jarB,
    raw: wav,
    headers: { 'Content-Type': 'audio/wav' },
  });
  assert.equal(r.status, 200, 'B upload status');
  const t3 = r.data.state.people.find((p) => p.id === meB).tracks[0];
  assert.ok(t3, 'B has track');

  r = await call('POST', '/api/veto', { jar: hostJar, body: { code, trackId: t3.id } });
  assert.equal(r.status, 200, 'veto status');
  st = r.data.state;
  assert.equal(person(st, meB), null, 'B removed after veto (no tracks, no plays)');
  ok('veto removes track and empt requester');

  r = await call('POST', '/api/sort', { jar: hostJar, body: { code } });
  assert.equal(r.status, 200, 'sort status');
  ok('sort by least played runs');

  r = await call('POST', '/api/play', { jar: hostJar, body: { code, trackId: null } });
  assert.equal(r.status, 200, 'clear now status');
  assert.equal(r.data.state.nowTrack, null, 'now cleared');
  ok('now-playing can be cleared');

  r = await call('POST', '/api/end', { jar: hostJar, body: { code } });
  assert.equal(r.status, 200, 'end status');
  assert.equal(r.data.ended, true, 'ended flag');
  ok('end party wipes the room');

  r = await call('GET', '/api/state?code=' + code, { jar: hostJar });
  assert.equal(r.status, 404, 'state gone after end');
  r = await call('POST', '/api/join', { body: { code, name: 'Late' } });
  assert.equal(r.status, 404, 'join rejected after end');
  ok('room is gone after end');

  r = await call('POST', '/api/join', { body: { code: 'XXXXXX', name: 'Nope' } });
  assert.equal(r.status, 404, 'unknown room rejected');
  ok('unknown room code rejected');

  console.log('\nall ' + passed + ' checks passed');
}

run().catch((e) => {
  console.error('\nFAILED: ' + (e && e.message ? e.message : e));
  if (e && e.stack) console.error(e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
});
