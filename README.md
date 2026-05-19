# ForgeShift

ForgeShift is a self-hosted shift and task scheduling platform for teams.

It provides a calendar-first workflow for rotas, reusable templates, task lists, role-based administration, and release visibility from GitHub Releases.

## Core Features

- Calendar views: month and week layout with day/shift detail panels
- Shift management: create, edit, and assign shifts by user, date, time, and location
- Task lists: attach reusable task lists to days/shifts with color indicators
- Templates: apply repeatable weekly patterns to speed up rota planning
- Team and role controls: Member, Shift Lead, Manager, Administrator
- Security controls: password hashing + peppering, 2FA support, reset flows, audit log
- Build visibility: environment badge, version display, and in-app Updates page
- Mobile-ready UI: responsive layouts for phone, tablet, and desktop

## Environment Channels

ForgeShift supports two deployment channels for normal installs:

- `staging` = pre-release validation channel (`-rc` versions)
- `main` = production channel (stable releases)

`develop` remains a developer-only branch/workflow and is intentionally excluded from installer choices.

## Tech Stack

- Frontend: Vanilla HTML/CSS/JavaScript
- Backend: Node.js + Express
- Database: SQLite
- Auth/session: JWT cookies
- Deployment target: Linux VM/LXC (Proxmox scripts included)

## Quick Start (Local)

```bash
git clone https://github.com/loucas781/ForgeShift.git
cd ForgeShift
cp .env.example .env.staging
# edit .env.staging values (JWT_SECRET, PASSWORD_PEPPER, APP_URL, etc.)
npm install
NODE_ENV=staging node server/index.js
```

Open:

- `http://localhost:3000/signup.html` for first-time admin creation
- `http://localhost:3000` for the app

## Proxmox One-Command Install

Run on the Proxmox host:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/loucas781/ForgeShift/main/proxmox/ct/forgeshift.sh)"
```

The installer will:

1. Create a Debian 12 LXC
2. Install Node.js + dependencies
3. Clone the correct branch (`staging` or `main`)
4. Generate `.env.<environment>`
5. Run DB migrations
6. Start `forgeshift` as a `systemd` service

## Developer Proxmox Install (3 Channels)

Developer-only installer (from `develop` branch), with `development`, `staging`, and `main` options:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/loucas781/ForgeShift/develop/proxmox/ct/forgeshift-dev.sh)"
```

This flow installs a developer update helper:

- `/opt/forgeshift/update-dev.sh`

## Updating an Installed Instance

Inside the container:

```bash
bash /opt/forgeshift/update.sh
```

Update behavior:

- `staging` environments update from `origin/staging`
- `main` environments update from `origin/main`

## Build & Release Visibility (In-App Updates Page)

The Settings → Updates page reads GitHub Releases for `GITHUB_REPO`.

- `staging` builds compare against published **pre-releases**
- `main` builds compare against published **releases**

Only published GitHub releases are shown as available updates.

## Environment Variables

See `.env.example` for all options.

Important values:

- `JWT_SECRET`: signing secret for auth tokens
- `PASSWORD_PEPPER`: extra secret mixed into password hashing
- `DATABASE_PATH`: SQLite DB file path
- `APP_URL`: public app URL for links and feeds
- `APP_ENV`: deployment channel (`staging` or `production`)
- `GITHUB_REPO`: release source repo (`owner/repo`)
- `GITHUB_TOKEN`: optional token for higher GitHub API rate limits

## Security Notes

- Passwords are hashed with bcrypt and protected with a server-side pepper
- Sensitive actions are audited
- Role checks gate admin features
- `COOKIE_SECURE=true` is recommended behind HTTPS
- Keep `.env.*` files private and never commit them

## Repository Layout

- `public/` - frontend pages, styles, and client scripts
- `server/` - API, auth, DB migration, and backend logic
- `proxmox/ct/` - host-side Proxmox LXC creation script
- `proxmox/install/` - in-container install/bootstrap script
- `.github/workflows/` - CI/versioning workflows

## Licence

ForgeShift Web is source-available proprietary software.

You may self-host and use this software for personal or internal business purposes only.

You may not copy, modify, redistribute, resell, rebrand, sublicense, or create derivative works from this project without prior written permission from the copyright holder, except where required for ordinary installation, configuration, or self-hosted operation.

You may not provide this software, or any modified version of it, as a hosted service, SaaS product, managed service, commercial platform, or competing product without prior written permission.
