# 📅 ForgeShift — Shift Rota Management System

A production-ready, server-hosted shift rota management system built with **Node.js**, **Express**, and **SQLite**. Ships with a full Proxmox LXC installer, iCal calendar feeds, Docker support, and Nginx configs.

---

## 🚀 Proxmox Install (Recommended)

### On your Proxmox host shell:

```bash
wget -O create-lxc.sh https://raw.githubusercontent.com/YOUR_ORG/forgeshift/main/proxmox/create-lxc.sh
chmod +x create-lxc.sh

bash create-lxc.sh production   # or staging / develop
```

The script will prompt for container ID, hostname, RAM, disk, cores and port (all defaulted), then:
- Download Ubuntu 22.04 template if needed
- Create and start the LXC container
- Generate a secure SESSION_SECRET and write .env into the container
- Run setup.sh inside the container (Node.js 20, PM2, Nginx, UFW, migrations, seed)
- Print the container IP and all access URLs

### Container management

```bash
pct enter <CTID>                           # Shell into container
pct exec <CTID> -- pm2 logs forgeshift      # Live logs
pct exec <CTID> -- pm2 restart forgeshift   # Restart app
pct stop <CTID>                            # Stop container
```

---

## 📅 iCal Calendar Feeds

Subscribe to shift rotas in Google Calendar, Apple Calendar, Outlook, or any iCal app.

1. Log in → **My Profile** → **iCal / Calendar Feeds**
2. Click **Generate iCal Token**
3. Copy the feed URL and subscribe in your calendar app

| Feed | Path | Access |
|------|------|--------|
| My shifts | `/api/ical/<token>/my-shifts.ics` | All users |
| Full team | `/api/ical/<token>/team.ics` | Admin only |
| Specific user | `/api/ical/<token>/user/<userId>.ics` | Admin only |

Feeds cover 3 months past to 12 months ahead and refresh hourly.

**How to subscribe:**
- **Google Calendar** — Other calendars → + → From URL
- **Apple Calendar** — File → New Calendar Subscription
- **Outlook** — Add calendar → Subscribe from web

Tokens are stored as SHA-256 hashes. Revoke or regenerate any time from My Profile.

---

## 🏗 Tech Stack

Node.js 20 · Express 4 · SQLite (better-sqlite3) · bcrypt · PM2 · Nginx · Docker

---

## 🖥 Other Deployment Options

### Direct server

```bash
git clone https://github.com/YOUR_ORG/forgeshift.git && cd forgeshift
cp .env.example .env   # Edit: set SESSION_SECRET and ADMIN_PASSWORD
npm run setup          # migrate + seed
npm start
```

### Docker Compose

```bash
cp .env.example .env
docker compose up -d                        # production
docker compose --profile staging up -d     # staging
docker compose --profile dev up            # development
```

---

## 📁 Project Structure

```
forgeshift/
├── proxmox/
│   ├── create-lxc.sh    # Proxmox host: creates LXC container
│   └── setup.sh         # Container bootstrap: Node, PM2, Nginx, UFW
├── src/
│   ├── server.js
│   ├── config/database.js
│   ├── middleware/auth.js
│   └── routes/
│       ├── auth.js      # Login, logout, register
│       ├── shifts.js    # Shift CRUD
│       ├── ical.js      # iCal feeds + token management
│       └── api.js       # Templates, users, locations, settings
├── public/
│   ├── index.html
│   ├── css/styles.css
│   └── js/
│       ├── api.js       # REST + iCal client
│       ├── state.js
│       ├── utils.js
│       └── app.js       # Full SPA renderer
├── scripts/
│   ├── migrate.js       # Schema (includes ical_tokens table)
│   └── seed.js
├── deploy/
│   ├── nginx.conf
│   └── forgeshift.service
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

---

## 🔒 Security

bcrypt · Helmet.js · Rate limiting · Server-side sessions · httpOnly cookies · iCal tokens hashed as SHA-256 · Input validation via express-validator

---

## 🔑 Default Credentials

```
Email    : admin@forgeshift.app
Password : ChangeMe123!
```

> ⚠️ Change these immediately after first login.
