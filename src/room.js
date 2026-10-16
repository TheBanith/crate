import { DurableObject } from 'cloudflare:workers';
import { sha256hex, randHex, parseCookies } from './util.js';

const WIPE_MS = 48 * 3600 * 1000;

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  q(sql, ...args) {
    return this.ctx.storage.sql.exec(sql, ...args).toArray();
  }

  x(sql, ...args) {
    this.ctx.storage.sql.exec(sql, ...args);
  }

  ensure() {
    if (this._ready) return;
    this.x(
      'CREATE TABLE IF NOT EXISTS room (k INTEGER PRIMARY KEY CHECK (k = 1), name TEXT, host_hash TEXT, created INTEGER, last_touch INTEGER, now_track INTEGER, now_started INTEGER)'
    );
    this.x(
      'CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT UNIQUE, name TEXT, sort_order INTEGER, pinned INTEGER DEFAULT 0, played INTEGER DEFAULT 0)'
    );
    this.x(
      'CREATE TABLE IF NOT EXISTS tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER, title TEXT, path TEXT UNIQUE, ext TEXT, size INTEGER DEFAULT 0, duration REAL DEFAULT 0, status TEXT DEFAULT \'queued\', played_at INTEGER)'
    );
    this._ready = true;
  }

  room() {
    const r = this.q('SELECT * FROM room WHERE k = 1');
    return r[0] || null;
  }

  state(room) {
    room = room || this.room();
    if (!room) return null;
    const people = this.q('SELECT * FROM people ORDER BY sort_order ASC, id ASC');
    const tracks = this.q('SELECT * FROM tracks ORDER BY id ASC');
    const byPerson = {};
    for (const t of tracks) {
      const list = (byPerson[Number(t.person_id)] = byPerson[Number(t.person_id)] || []);
      list.push({
        id: Number(t.id),
        title: t.title,
        path: t.path,
        duration: Number(t.duration) || 0,
        status: t.status,
        playedAt: t.played_at == null ? null : Number(t.played_at),
      });
    }
    return {
      code: this.ctx.id.name,
      name: room.name,
      created: Number(room.created),
      nowTrack: room.now_track == null ? null : Number(room.now_track),
      nowStarted: room.now_started == null ? null : Number(room.now_started),
      people: people.map((p) => ({
        id: Number(p.id),
        name: p.name,
        sortOrder: Number(p.sort_order),
        pinned: !!p.pinned,
        played: Number(p.played) || 0,
        tracks: byPerson[Number(p.id)] || [],
      })),
    };
  }

  push(st) {
    const s = JSON.stringify(st);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(s);
      } catch {}
    }
  }

  touch() {
    this.x('UPDATE room SET last_touch = ?1 WHERE k = 1', Date.now());
    try {
      this.ctx.storage.setAlarm(Date.now() + WIPE_MS);
    } catch {}
  }

  async who(rand) {
    if (!rand) return null;
    const room = this.room();
    if (!room) return null;
    const h = await sha256hex(rand);
    if (h === room.host_hash) return 'host';
    const p = this.q('SELECT id FROM people WHERE token_hash = ?1', h);
    return p[0] ? 'guest' : null;
  }

  farewell() {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ ended: true }));
        ws.close(1000, 'ended');
      } catch {}
    }
  }

  async wipe() {
    const tracks = this.q('SELECT path FROM tracks');
    const paths = tracks.map((t) => t.path).filter(Boolean);
    for (let i = 0; i < paths.length; i += 500) {
      try {
        await this.env.AUDIO.delete(paths.slice(i, i + 500));
      } catch {}
    }
    this.x('DELETE FROM tracks');
    this.x('DELETE FROM people');
    this.x('DELETE FROM room');
    try {
      this.ctx.storage.setAlarm(null);
    } catch {}
  }

  async create(name) {
    this.ensure();
    if (this.room()) return { error: 'exists' };
    const hostRand = randHex(24);
    const hostHash = await sha256hex(hostRand);
    const now = Date.now();
    this.x(
      'INSERT INTO room (k, name, host_hash, created, last_touch, now_track, now_started) VALUES (1, ?1, ?2, ?3, ?4, NULL, NULL)',
      String(name || 'Party').trim().slice(0, 40) || 'Party',
      hostHash,
      now,
      now
    );
    try {
      this.ctx.storage.setAlarm(now + WIPE_MS);
    } catch {}
    return { hostRand, state: this.state() };
  }

  async join(name, guestRand) {
    this.ensure();
    const room = this.room();
    if (!room) return { error: 'gone' };
    const cleanName = String(name || 'Guest').trim().slice(0, 24) || 'Guest';
    if (guestRand) {
      const h = await sha256hex(guestRand);
      const p = this.q('SELECT id FROM people WHERE token_hash = ?1', h);
      if (p[0]) {
        this.x('UPDATE people SET name = ?1 WHERE id = ?2', cleanName, Number(p[0].id));
        this.touch();
        const st = this.state();
        this.push(st);
        return { guestRand, me: Number(p[0].id), state: st };
      }
    }
    const newRand = randHex(24);
    const h = await sha256hex(newRand);
    const max = this.q('SELECT COALESCE(MAX(sort_order), 0) AS m FROM people');
    this.x(
      'INSERT INTO people (token_hash, name, sort_order, pinned, played) VALUES (?1, ?2, ?3, 0, 0)',
      h,
      cleanName,
      (Number(max[0].m) || 0) + 10
    );
    const row = this.q('SELECT last_insert_rowid() AS id');
    this.touch();
    const st = this.state();
    this.push(st);
    return { guestRand: newRand, me: Number(row[0].id), state: st };
  }

  async read(rand) {
    this.ensure();
    const room = this.room();
    if (!room) return { error: 'gone' };
    let role = null;
    let me = null;
    if (rand) {
      const h = await sha256hex(rand);
      if (h === room.host_hash) {
        role = 'host';
      } else {
        const p = this.q('SELECT id FROM people WHERE token_hash = ?1', h);
        if (p[0]) {
          role = 'guest';
          me = Number(p[0].id);
        }
      }
    }
    return { state: this.state(room), meta: { role, me } };
  }

  async addTrack(rand, title, path, ext, size, duration) {
    this.ensure();
    const room = this.room();
    if (!room) return { error: 'gone' };
    if (!rand) return { error: 'forbidden' };
    const h = await sha256hex(rand);
    const p = this.q('SELECT id FROM people WHERE token_hash = ?1', h);
    if (!p[0]) return { error: 'forbidden' };
    const dur = Number(duration);
    this.x(
      'INSERT INTO tracks (person_id, title, path, ext, size, duration, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, \'queued\')',
      Number(p[0].id),
      String(title || 'Untitled').trim().slice(0, 80) || 'Untitled',
      path,
      ext,
      Number(size) || 0,
      Number.isFinite(dur) ? Math.min(Math.max(dur, 0), 86400) : 0
    );
    this.touch();
    const st = this.state();
    this.push(st);
    return { state: st };
  }

  async play(rand, trackId) {
    this.ensure();
    const room = this.room();
    if (!room) return { error: 'gone' };
    if ((await this.who(rand)) !== 'host') return { error: 'forbidden' };
    const now = Date.now();
    if (trackId == null) {
      this.x('UPDATE room SET now_track = NULL, now_started = NULL WHERE k = 1');
    } else {
      const t = this.q('SELECT * FROM tracks WHERE id = ?1', Number(trackId));
      if (!t[0]) return { error: 'bad' };
      this.x(
        'UPDATE tracks SET status = \'played\', played_at = ?1 WHERE id = ?2',
        now,
        Number(trackId)
      );
      const pid = Number(t[0].person_id);
      const person = this.q('SELECT * FROM people WHERE id = ?1', pid);
      if (!person[0]) return { error: 'bad' };
      if (person[0].pinned) {
        this.x('UPDATE people SET played = played + 1 WHERE id = ?1', pid);
      } else {
        const max = this.q('SELECT COALESCE(MAX(sort_order), 0) AS m FROM people');
        this.x(
          'UPDATE people SET played = played + 1, sort_order = ?1 WHERE id = ?2',
          (Number(max[0].m) || 0) + 10,
          pid
        );
      }
      this.x('UPDATE room SET now_track = ?1, now_started = ?2 WHERE k = 1', Number(trackId), now);
    }
    this.touch();
    const st = this.state();
    this.push(st);
    return { state: st };
  }

  async reorder(rand, ids) {
    this.ensure();
    if (!this.room()) return { error: 'gone' };
    if ((await this.who(rand)) !== 'host') return { error: 'forbidden' };
    if (!Array.isArray(ids) || ids.length > 500) return { error: 'bad' };
    for (let i = 0; i < ids.length; i++) {
      const id = Number(ids[i]);
      if (Number.isFinite(id)) this.x('UPDATE people SET sort_order = ?1 WHERE id = ?2', i * 10, id);
    }
    this.touch();
    const st = this.state();
    this.push(st);
    return { state: st };
  }

  async pin(rand, personId, on) {
    this.ensure();
    if (!this.room()) return { error: 'gone' };
    if ((await this.who(rand)) !== 'host') return { error: 'forbidden' };
    const pid = Number(personId);
    if (!Number.isFinite(pid)) return { error: 'bad' };
    if (on) {
      const min = this.q('SELECT MIN(sort_order) AS m FROM people');
      this.x(
        'UPDATE people SET pinned = 1, sort_order = ?1 WHERE id = ?2',
        (min[0].m == null ? 0 : Number(min[0].m)) - 10,
        pid
      );
    } else {
      this.x('UPDATE people SET pinned = 0 WHERE id = ?1', pid);
    }
    this.touch();
    const st = this.state();
    this.push(st);
    return { state: st };
  }

  async veto(rand, trackId) {
    this.ensure();
    const room = this.room();
    if (!room) return { error: 'gone' };
    if ((await this.who(rand)) !== 'host') return { error: 'forbidden' };
    const t = this.q('SELECT * FROM tracks WHERE id = ?1', Number(trackId));
    if (!t[0]) return { error: 'bad' };
    if (t[0].status !== 'queued') return { error: 'bad' };
    this.x('DELETE FROM tracks WHERE id = ?1', Number(trackId));
    this.x('DELETE FROM people WHERE id = ?1 AND played = 0 AND NOT EXISTS (SELECT 1 FROM tracks WHERE person_id = people.id)', Number(t[0].person_id));
    try {
      if (t[0].path) await this.env.AUDIO.delete(t[0].path);
    } catch {}
    this.touch();
    const st = this.state();
    this.push(st);
    return { state: st };
  }

  async sortLeastPlayed(rand) {
    this.ensure();
    if (!this.room()) return { error: 'gone' };
    if ((await this.who(rand)) !== 'host') return { error: 'forbidden' };
    const people = this.q('SELECT id FROM people ORDER BY played ASC, id ASC');
    for (let i = 0; i < people.length; i++) {
      this.x('UPDATE people SET sort_order = ?1 WHERE id = ?2', i * 10, Number(people[i].id));
    }
    this.touch();
    const st = this.state();
    this.push(st);
    return { state: st };
  }

  async withdraw(rand) {
    this.ensure();
    const room = this.room();
    if (!room) return { error: 'gone' };
    if (!rand) return { error: 'forbidden' };
    const h = await sha256hex(rand);
    const p = this.q('SELECT * FROM people WHERE token_hash = ?1', h);
    if (!p[0]) return { error: 'forbidden' };
    const pid = Number(p[0].id);
    const queued = this.q('SELECT path FROM tracks WHERE person_id = ?1 AND status = \'queued\'', pid);
    this.x('DELETE FROM tracks WHERE person_id = ?1 AND status = \'queued\'', pid);
    for (const row of queued) {
      try {
        if (row.path) await this.env.AUDIO.delete(row.path);
      } catch {}
    }
    const left = this.q('SELECT COUNT(*) AS c FROM tracks WHERE person_id = ?1', pid);
    if ((Number(left[0].c) || 0) === 0 && (Number(p[0].played) || 0) === 0) {
      this.x('DELETE FROM people WHERE id = ?1', pid);
    }
    this.touch();
    const st = this.state();
    this.push(st);
    return { state: st };
  }

  async end(rand) {
    this.ensure();
    if (!this.room()) return { error: 'gone' };
    if ((await this.who(rand)) !== 'host') return { error: 'forbidden' };
    this.farewell();
    await this.wipe();
    return { ended: true };
  }

  async fileAuth(rand, path) {
    this.ensure();
    const room = this.room();
    if (!room) return { error: 'gone' };
    if (!rand) return { error: 'forbidden' };
    const h = await sha256hex(rand);
    if (h !== room.host_hash) {
      const p = this.q('SELECT id FROM people WHERE token_hash = ?1', h);
      if (!p[0]) return { error: 'forbidden' };
    }
    const t = this.q('SELECT size FROM tracks WHERE path = ?1', path);
    if (!t[0]) return { error: 'gone' };
    return { ok: true, size: Number(t[0].size) || 0 };
  }

  async alarm() {
    this.ensure();
    const room = this.room();
    if (!room) return;
    if (Date.now() - (Number(room.last_touch) || 0) > WIPE_MS) {
      this.farewell();
      await this.wipe();
    } else {
      this.ctx.storage.setAlarm(Date.now() + WIPE_MS);
    }
  }

  async fetch(request) {
    this.ensure();
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('not found', { status: 404 });
    }
    const code = this.ctx.id.name;
    const cookies = parseCookies(request);
    const rand = cookies['h_' + code] || cookies['g_' + code] || null;
    const role = await this.who(rand);
    if (!role) return new Response('forbidden', { status: 403 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    try {
      this.ctx.storage.setWebSocketAutoResponse(new Request('ping'), new Response('pong'));
    } catch {}
    const room = this.room();
    try {
      server.send(JSON.stringify(room ? this.state(room) : { ended: true }));
    } catch {}
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, msg) {
    if (msg === 'ping') {
      try {
        ws.send('pong');
      } catch {}
    }
  }
}
