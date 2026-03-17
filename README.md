# ForgeShift

Self-hosted **shift rota management** — vanilla HTML/CSS/JS + Node.js/Express + SQLite.

## Features

- 📅 **Calendar** — month and week views, click to add/edit shifts
- 📍 **Locations** — assign locations per shift day, configurable colour coding
- 📋 **Templates** — reusable weekly shift patterns, apply to any team member
- 🎨 **Colour-coded notes** — per-day notes with colour tint
- 👥 **User management** — admin creates/deactivates/deletes accounts
- 🔐 **Auth** — JWT cookies, HMAC-SHA256 pepper + bcrypt, pepper rotation
- 📲 **iCal export** — subscribe to your rota in Google/Apple/Outlook Calendar
- 🌙 **Themes** — light, dark, OLED black (system-level preference)
- 📱 **Mobile responsive** — works on desktop, tablet and phone
- 🚀 **Environments** — develop / staging / production
- 🔄 **Version bumping** — GitHub Actions auto-increments build counter

## Quick Start (local)

```bash
git clone https://github.com/YOUR_USER/forgeshift.git
cd forgeshift
cp .env.example .env.development
# Fill in JWT_SECRET and PASSWORD_PEPPER in .env.development
npm install
node server/index.js
# Open http://localhost:3000/signup.html to create the first admin account
```

## Proxmox LXC Install

Run this **on your Proxmox host** (not inside a container):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/YOUR_USER/forgeshift/main/proxmox/ct/forgeshift.sh)"
```

The script will:
1. Show a `whiptail` TUI to configure the LXC (or use defaults)
2. Download a Debian 12 template if needed
3. Create and start the container
4. Run the in-container install script automatically
5. Print the app URL and container root password when done

**After install:** visit `http://<container-ip>:3000/signup.html` to create the first admin account.

> **Before deploying:** edit `GITHUB_RAW` in `proxmox/ct/forgeshift.sh` and `REPO_URL` in `proxmox/install/forgeshift-install.sh` to point to your repository.

## GitHub Actions

Set up in repo Settings → Actions → General → **Read and write permissions**.

Three branches:
- `develop` — auto-increments build counter on every push
- `staging`  — bumps patch version + `-rc` suffix on PR merge
- `main`     — bumps minor version, clean production tag

## Environment Variables

| Variable | Description |
|---|---|
| `JWT_SECRET` | JWT signing secret — `openssl rand -hex 48` |
| `PASSWORD_PEPPER` | HMAC pepper for bcrypt — `openssl rand -hex 32` |
| `DATABASE_PATH` | SQLite file path (default: `./data/forgeshift.db`) |
| `PORT` | Server port (default: `3000`) |
| `COOKIE_SECURE` | Set `true` behind HTTPS |
| `TRUST_PROXY` | Set `true` behind nginx/Caddy |

## Security

- Passwords: HMAC-SHA256 pepper → bcrypt (12 rounds)
- Pepper rotation: set `PASSWORD_PEPPER_OLD` + new `PASSWORD_PEPPER` — passwords re-hashed transparently on next login
- Tokens: SHA-256 hashed before storage; two-step reset flow (URL token → in-memory session key)
- Rate limiting: 20 auth attempts per IP per 15 min
- Last-admin guard: cannot delete or demote the only admin
- Audit log: all sensitive operations written to `audit_log` table
