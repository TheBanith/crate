# Crate

**Fill the crate. The DJ digs.**

A party music queue app: guests scan a QR code, upload tracks into a shared crate, and watch the DJ drag requests into the play order — with a 100% serverless backend.

- **Guests:** join with a 6-character room code + nickname (no account), upload audio tracks, see the queue, watch what's playing in real time.
- **DJ:** draggable request queue, seek/volume controls, auto-advance, veto tracks, withdraw guests' songs, and a projection-friendly **Display mode** (huge now-playing + QR join screen).
- **Rooms are ephemeral:** every party auto-wipes after 48 hours.

Everything is one Cloudflare Worker with a per-room [Durable Object](https://developers.cloudflare.com/durable-objects/) and static assets — no build step, no runtime npm dependencies.

## How it works

```
Guest phones ──QR──▶ index.html ──POST /api/upload──┐
DJ browser ─────────▶ dj.html  ──WS /ws/<code>───────┼─▶ Worker (routing, auth)
                                                     └─▶ Room DO (per-party SQLite)
                                                          R2 bucket ── audio blobs
```

- **Auth:** stateless `HttpOnly` session cookies. The DJ cookie `h_<CODE>` identifies the room host; guest cookies `g_<CODE>` identify one person. Hashes are stored in the DO's SQLite, so a leaked database never reveals raw tokens.
- **State:** queue order, people, play counts, veto history and now-playing live in the room's SQLite. Every mutation broadcasts the full state over the room's WebSocket — guests and the DJ see identical, lag-free views.
- **Audio:** uploads are buffered fully (50 MB cap) and streamed to an R2 bucket keyed `audio/<track-id>`, then served back with proper `Range`/`HEAD` support so seeking in `<audio>` works natively.
- **Lifecycle:** a 48-hour alarm ends any party and wipes all state.

## Project structure

```
crate/
├── public/                static site (served by the Worker)
│   ├── index.html         guest UI — landing join + crate queue
│   ├── dj.html            DJ console (drag-to-order, controls, display mode)
│   ├── style.css          full design system + disco motion layer
│   └── js/
│       ├── common.js      tiny helpers (fetch wrapper, QR render, toasts)
│       ├── guest.js        guest page logic
│       └── dj.js          DJ console logic
├── src/
│   ├── worker.js          routing / auth / API + static fall-through
│   ├── room.js            the Room Durable Object (state, WS, audio I/O)
│   └── util.js            shared helpers (time fmt, cookie sign/verify, room codes)
├── selftest.mjs           23-check end-to-end test suite against a live server
├── teaser/
│   └── index.html         self-contained motion teaser (open directly in a browser)
├── wrangler.jsonc         Worker config (assets, DO binding, R2 bucket, migration)
├── package.json
└── deploy/
    └── vps-deploy.sh      self-hosting on any VPS (Node + wrangler dev + Caddy)
```

## Quickstart (local)

Requires Node 20+ (wrangler is the only dev dependency).

```bash
npm install
npx wrangler dev --port 8790 --ip 127.0.0.1
```

- DJ console: http://127.0.0.1:8790/dj
- Guest page: http://127.0.0.1:8790/

> **Windows note:** if your environment sets a SOCKS/HTTP proxy (e.g. `socks5h://127.0.0.1:10808`), clear it for wrangler — `HTTP_PROXY= HTTPS_PROXY= wrangler dev ...` — otherwise the workerd runtime crashes on startup.

## Testing

```bash
node selftest.mjs http://127.0.0.1:8790
```

23 checks: room lifecycle, join/leave, upload validation (extension, size, session), reorder rights (guest vs DJ), play/next/veto/withdraw, counter mechanics, ranged reads (206), HEAD, 403 paths, and end-party wipe.

## Teaser

Live: **[thebanith.github.io/crate/teaser](https://thebanith.github.io/crate/teaser/)** — or open `teaser/index.html` directly in a browser (self-contained, no build). A ~16s looping promo of the core ritual: scan to join, fill the crate, the DJ digs, drop the track. It reuses the app's design tokens verbatim, respects `prefers-reduced-motion` (static poster, no autoplay), and has pause/replay controls.

## Deploying

### Cloudflare Workers

```bash
npm install
npx wrangler deploy
```

Requires: a Cloudflare account, **R2 enabled** (`wrangler r2 bucket create crate-audio`), and the Durable Object migration in `wrangler.jsonc` (already configured, applies on first deploy).

The account's storage needs no payment card to run within the free tier; audio blobs are the only large-volume storage. As an alternative for accounts without R2, audio can instead live in the room's DO SQLite (5 GB free total per account) — the endpoints stay identical.

### Self-hosting on a VPS

See [`deploy/vps-deploy.sh`](deploy/vps-deploy.sh) — installs Node 22 + Caddy, drops a systemd unit in `/opt/crate`, and proxies your domain with automatic HTTPS. Zero code changes: the same Worker runs under `wrangler dev`.

This project was live at `https://dj.cestmoi.ir` via exactly that script.

## Design

The UI is a dark, neon-club design system defined entirely with CSS custom properties (magenta / cyan / violet accent trio, layered glow, motion tokens). All decorative motion is CSS-keyframe based and fully disabled under `prefers-reduced-motion`. Text is rendered with `textContent` only (no `innerHTML` with user data).

## License

[MIT](LICENSE)
