# VPSDeck

English | [Tiếng Việt](README.vi.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Rust 1.90+](https://img.shields.io/badge/rust-1.90%2B-orange.svg)](https://www.rust-lang.org)
[![Node 20+ (build only)](https://img.shields.io/badge/node-20%2B%20(build%20only)-green.svg)](https://nodejs.org)

A web control panel for a fleet of Linux servers: browse files, open a real
terminal, watch resources. Agentless — the managed machines only need SSH.

The whole server side is **one Rust binary**. It terminates TLS, serves the web
UI, answers the REST API and carries the terminal WebSocket. No nginx, no Node
process in production, nothing installed on the machines you manage.

```
Browser ──HTTPS/WSS──> vpsdeck gateway ──SSH/SFTP──> server 1..N
                        (single process)
```

---

## Why it exists

The first version was Spring Boot + Next.js behind nginx. Four problems showed
up in daily use; each was fixed at the cause, not at the symptom:

| Symptom | Actual cause | Fix |
|---|---|---|
| Vietnamese text broke in the terminal | Each 8 KB chunk was decoded on its own, so 3-byte characters were cut at the boundary | Send **binary frames** and let `xterm.js` reassemble with its stateful UTF-8 decoder |
| `tar`/`zip` killed the terminal session | The WebSocket send buffer had a ceiling; crossing it **closed the session** | Real backpressure: `await` the send, keep the SSH window small, so the remote process slows down instead |
| A directory with tens of thousands of files froze the page | The whole directory was returned, sorted in the browser, and every row went into the DOM | Server-side paging and sorting, virtual scrolling, SQLite index for recursive search |
| Sorting by date was wrong | `mtime` was a **preformatted string**, compared as a string | `mtime` is a numeric epoch; names use natural order (`file2` before `file10`) |

Measured on a real server (Ubuntu 22.04, 4,971 entries in one directory):
listing with `find -printf` takes **138 ms**, the same listing over SFTP
`read_dir` takes **1.47 s** — 10.6× slower. So listing goes through `find` and
SFTP is used only for file contents. Streaming a 15.7 MB archive through the
terminal sustains ~18 MB/s with no dropped bytes and no reconnect.

---

## Features

**File manager**
- Server-side paging, 1,000 rows per page, fetched as you scroll
- Virtual scrolling: a directory of 4,972 files keeps ~33 `<tr>` in the DOM
- Sorting on the server: directories first, natural name order, epoch dates
- Search the current directory, or **recursively through the whole subtree**
  via a SQLite index; with no index yet it falls back to `find` so results
  still appear immediately
- Drag-and-drop upload (the whole page is a drop zone), streamed download up
  to 10 GB
- Monaco editor, image/video preview, archive creation, permission changes
- **Pinned directory per server**: entering that server opens the pinned path
- **Dual pane**, FileZilla style: browse your local disk on the right, drag
  left to upload. Each tab keeps its own pane and its own folder.

**Terminal**
- `xterm.js` with the WebGL renderer, `unicode11`, and screen restore on
  reconnect
- Vietnamese input and rendering work correctly; reconnect uses exponential
  backoff
- Multiple tabs, one SSH session each

**Operations**
- SSH passwords sealed with AES-256-GCM; the key lives in the environment,
  never in the database
- Argon2id login, JWT sessions; the WebSocket requires a token too
- CPU/RAM/disk for every managed server and for the host running the panel

---

## Requirements

| | Version | Needed for |
|---|---|---|
| Rust | 1.90+ | Building the gateway |
| Node.js | 20+ | Building the web UI (build time only, not in production) |
| Managed servers | SSH + GNU coreutils | Nothing is installed on them |

---

## Quick start

```bash
git clone https://github.com/jakeemma2012/vpsdeck.git
cd vpsdeck

# 1. Build the web UI into static files
cd Tools/frontend && npm install && npm run build   # -> out/

# 2. Configure the gateway
cd ../backend/gateway-rs
umask 077
{
  echo "JAKE_SECRET_KEY=$(openssl rand -base64 32)"
  echo "JAKE_JWT_SECRET=$(openssl rand -base64 48)"
  echo "JAKE_BIND=127.0.0.1:8080"
  echo "JAKE_DB=./data/jake.db"
  echo "JAKE_STATIC_DIR=../../frontend/out"
  echo "JAKE_ADMIN_USER=admin"
  echo "JAKE_ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
} > .env
grep JAKE_ADMIN_PASSWORD .env     # keep this password

# 3. Run
cd ../../.. && ./scripts/vpsdeck.sh start
```

Open `http://127.0.0.1:8080`, log in, add your first server.

`scripts/vpsdeck.sh` takes `start`, `stop`, `restart`, `status` and `logs`. It
builds whatever is missing or stale, then runs the single binary. To run the
binary directly instead:

```bash
cd Tools/backend/gateway-rs
cargo build --release
set -a && . ./.env && set +a
./target/release/gateway-rs
```

Full list of environment variables:
[`Tools/backend/gateway-rs/ENV.md`](Tools/backend/gateway-rs/ENV.md).

### HTTPS

```bash
JAKE_TLS_CERT=/path/to/fullchain.pem
JAKE_TLS_KEY=/path/to/privkey.pem
```

Worth enabling for two reasons beyond transport encryption: the session token
travels over the WebSocket, and the dual-pane local browser needs a secure
context to open folders on the user's machine.

---

## Layout

```
Tools/
├── backend/gateway-rs/        Rust gateway — the entire server side
│   ├── src/
│   │   ├── main.rs            Bootstrap, router, TLS, static files
│   │   ├── config.rs          Configuration from the environment
│   │   ├── crypto.rs          AES-256-GCM for SSH passwords
│   │   ├── auth.rs            Argon2id + JWT, middleware
│   │   ├── db.rs              SQLite, models, column migration
│   │   ├── ssh.rs             russh connection pool, exec, SFTP
│   │   ├── terminal.rs        Terminal WebSocket
│   │   ├── files.rs           Listing, paging, indexing, search
│   │   └── routes.rs          REST handlers
│   ├── migrations/            SQLite schema
│   └── migrate-from-h2.sh     Import from the old Java version
│
└── frontend/                  Next.js 16, exported as static files
    ├── src/lib/
    │   ├── terminal-core.ts   xterm + addons + WebSocket protocol
    │   ├── local-fs.ts        Local disk browsing
    │   └── api.ts             REST client
    ├── src/app/dashboard/     Pages
    └── e2e/                   Tests driving a real browser

scripts/vpsdeck.sh             start | stop | restart | status | logs
```

Code comments and commit messages are in Vietnamese; everything a user or
operator reads — this README, `ENV.md`, the control script — is in English.

---

## Tests

```bash
# Gateway
cd Tools/backend/gateway-rs
cargo test
cargo clippy -- -D warnings

# Web UI, against a real Chromium
cd Tools/frontend
npm i -D playwright && npx playwright install chromium
BASE=http://127.0.0.1:8080 PW='<admin password>' node e2e/test.mjs
```

The browser suite exists because type checking and HTTP status codes are **not
enough** here: a Next.js error page still returns 200 OK, and WebGL draws the
terminal into a canvas, so there is no DOM text to assert on. What it covers
and which bugs it has caught:
[`Tools/frontend/e2e/README.md`](Tools/frontend/e2e/README.md).

---

## Security

What the project does:

- SSH passwords are sealed with AES-256-GCM; the key comes from the
  environment and is **not** stored in the database file. A stolen database
  without the key decrypts to nothing.
- The API never returns a password or private key to the client, only a
  present/absent flag.
- Every user-supplied path is quoted before it reaches a shell command.
- `rm -rf` is refused for 18 system directories.
- The terminal WebSocket requires a valid token, checked before the upgrade.
- The gateway refuses to start without its keys — there are no defaults.

What it does **not** do yet; read this before exposing it to the internet:

- No rate limit on failed logins. Use a strong password, put the panel behind
  a VPN, or add a rate limit at a reverse proxy.
- Tokens cannot be revoked before they expire, and changing a password does
  not invalidate existing ones. To kick everyone out, change
  `JAKE_JWT_SECRET` and restart.
- SSH host keys are not pinned (equivalent to `StrictHostKeyChecking=no`).

**Back up `JAKE_SECRET_KEY` together with the database file.** Losing the
key means losing every stored SSH password, with no way back.

---

## Migrating from the Java version

```bash
cd Tools/backend/gateway-rs
./migrate-from-h2.sh        # H2 -> SQLite
```

The script runs once and refuses to run again if the target database already
has data. SSH passwords land in SQLite as plaintext and are re-sealed on the
**first** gateway start. Login accounts are not carried over (the old bcrypt
hashes are not reused); set one with `JAKE_ADMIN_USER` /
`JAKE_ADMIN_PASSWORD`.

---

## License

MIT © Jake — see [LICENSE](LICENSE).
