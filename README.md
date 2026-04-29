# ForgeShift

Self-hosted **shift rota management** — vanilla HTML/CSS/JS + Node.js/Express + SQLite.

## Features

- 📅 **Calendar** — month and week views, click any day to add or edit shifts
- 📍 **Locations** — assign locations per shift, configurable colour coding
- 📋 **Templates** — reusable weekly shift patterns, apply to any team member for any week
- 🎨 **Colour-coded notes** — per-day notes with a colour tint applied to the calendar cell
- 👥 **User management** — admin creates, deactivates, resets passwords and deletes accounts
- 🔐 **Auth** — JWT cookies, HMAC-SHA256 pepper + bcrypt (12 rounds), transparent pepper rotation
- 📲 **iCal export** — subscribe to your rota in Google Calendar, Apple Calendar or Outlook
- 🌙 **Themes** — light, dark, OLED black — system-level, persisted per browser
- 📱 **Mobile responsive** — scales across desktop, tablet and phone
- 🚀 **Environments** — develop / staging / production with version badge in the UI
- 🔄 **Auto-versioning** — GitHub Actions increments build counter on every push

---

## Proxmox LXC Install

Run this **on your Proxmox host** (not inside a container):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/loucas781/ForgeShift/develop/proxmox/ct/forgeshift.sh)"
```

The script will:
1. Present a `whiptail` TUI — choose default or advanced settings (CPU, RAM, disk, network, environment)
2. Download a Debian 12 template automatically if one isn't already present
3. Create and start the LXC container
4. Push the in-container install script and run it — installs Node.js 20, clones the repo, writes `.env`, runs migrations, and starts the `forgeshift` systemd service
5. Print the app URL and generated root password when complete

**After install:** visit `http://<container-ip>:3000/signup.html` — the first account created automatically becomes admin.

---

## Updating ForgeShift

Once installed, an `update.sh` script is placed at `/opt/forgeshift/update.sh` inside the container. To update to the latest version, run from your **Proxmox host**:

```bash
pct exec <CTID> -- bash /opt/forgeshift/update.sh
```

Replace `<CTID>` with your container ID (e.g. `100`). The update script will:
1. Pull the latest code from `origin/develop`
2. Run `npm install` to pick up any new dependencies
3. Run database migrations (additive only — no data loss)
4. Restart the `forgeshift` systemd service

You can also run it directly if you have a shell inside the container:

```bash
bash /opt/forgeshift/update.sh
```

---

## Quick Start (local dev)

```bash
git clone https://github.com/loucas781/ForgeShift.git
cd ForgeShift
cp .env.example .env.development
# Edit .env.development — fill in JWT_SECRET and PASSWORD_PEPPER
npm install
node server/index.js
# Open http://localhost:3000/signup.html to create the first admin account
```

---

## GitHub Actions — Versioning

Enable in repo **Settings → Actions → General → Read and write permissions**.

| Branch | Behaviour |
|---|---|
| `develop` | Increments build counter on every push — e.g. `0.0.1-dev.42` |
| `staging` | Bumps patch + `-rc` suffix on PR merge, creates the Git tag, and publishes a GitHub prerelease — e.g. `0.0.2-rc` |
| `main` | Bumps minor, clean version, creates the Git tag, and publishes a GitHub release — e.g. `0.1.0` |

The version is displayed in the topbar env badge (`development v0.0.1-dev.42`), on the login page footer, and in Settings → Build Info.

The Settings → Updates page checks published GitHub Releases for this repository. Production builds only compare against full releases, staging builds only compare against GitHub prereleases, and development builds are shown as unreleased builds rather than updateable releases.

---

## Environment Variables

| Variable | Description |
|---|---|
| `JWT_SECRET` | JWT signing secret — generate: `openssl rand -hex 48` |
| `PASSWORD_PEPPER` | HMAC pepper mixed into every password hash — generate: `openssl rand -hex 32` |
| `DATABASE_PATH` | SQLite file path (default: `./data/forgeshift.db`) |
| `GITHUB_REPO` | GitHub repo used by the Updates page, in `owner/repo` format |
| `GITHUB_TOKEN` | Optional GitHub token to reduce rate-limit risk when checking releases |
| `PORT` | HTTP server port (default: `3000`) |
| `APP_URL` | Public-facing URL — used in iCal feed links |
| `COOKIE_SECURE` | Set `true` when running behind HTTPS |
| `TRUST_PROXY` | Set `true` when behind a reverse proxy (nginx, Caddy, NPM) |
| `COOKIE_MAX_AGE_HOURS` | Session length in hours (default: `72`) |

---

## Security

- **Passwords** — HMAC-SHA256 pepper applied before bcrypt (12 rounds); pepper never stored in the database
- **Pepper rotation** — set `PASSWORD_PEPPER_OLD=<old value>` alongside a new `PASSWORD_PEPPER`; passwords are transparently re-hashed on next successful login
- **Password reset** — two-step flow: URL token is SHA-256 hashed before DB storage and consumed immediately on validation, exchanged for a short-lived in-memory session key
- **Rate limiting** — 20 auth attempts per IP per 15 minutes (disabled in development)
- **Last-admin guard** — cannot delete, demote, or deactivate the only admin account
- **Audit log** — all sensitive operations (login, user create/delete, password reset, shift changes) written to `audit_log` table; failures never surface to callers
- **`.env` files** — never committed; only `.env.example` is in the repository
