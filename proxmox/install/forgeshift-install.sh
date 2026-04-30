#!/usr/bin/env bash
# ForgeShift — LXC In-Container Install Script
# Called by the host script via: pct exec <ctid> -- bash /tmp/forgeshift-install.sh <env>
# Do NOT run this directly on your workstation.

set -euo pipefail

export LANG=C LC_ALL=C DEBIAN_FRONTEND=noninteractive

GN=$(echo "\033[1;92m"); RD=$(echo "\033[01;31m"); YW=$(echo "\033[33m"); CL=$(echo "\033[m")
msg_info()  { echo -e "  💡  ${YW}${1}...${CL}"; }
msg_ok()    { echo -e "  ✓   ${GN}${1}${CL}"; }
msg_error() { echo -e "  ✖   ${RD}${1}${CL}"; exit 1; }

# ── Environment ────────────────────────────────────────────────────────────────
APP_ENV="${1:-staging}"
if [[ "$APP_ENV" != "staging" && "$APP_ENV" != "main" && "$APP_ENV" != "production" ]]; then
  echo "Usage: $0 [staging|main]"; exit 1
fi
[[ "$APP_ENV" == "main" ]] && APP_ENV="production"
COOKIE_SECURE="false"
[[ "$APP_ENV" == "production" || "$APP_ENV" == "staging" ]] && COOKIE_SECURE="true"
msg_ok "Deploying environment: ${APP_ENV}"

# ── 1. OS update ───────────────────────────────────────────────────────────────
msg_info "Updating OS packages"
apt-get update -qq
apt-get upgrade -y -qq 2>&1 | tail -3
msg_ok "OS packages updated"

# ── 2. Base dependencies ───────────────────────────────────────────────────────
msg_info "Installing base dependencies"
apt-get install -y -qq curl git gnupg ca-certificates openssl build-essential python3
msg_ok "Base dependencies ready"

# ── 3. Node.js 20 ─────────────────────────────────────────────────────────────
msg_info "Installing Node.js 20"
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get install -y -qq nodejs
msg_ok "Node.js $(node --version) / npm $(npm --version) installed"

# ── 4. Clone ForgeShift ────────────────────────────────────────────────────────
msg_info "Cloning ForgeShift"
# ── Repository URL ─────────────────────────────────────────────────────────────
REPO_URL="https://github.com/loucas781/ForgeShift.git"
CLONE_BRANCH="main"
[[ "$APP_ENV" == "staging" ]] && CLONE_BRANCH="staging"
rm -rf /opt/forgeshift
git clone --branch "$CLONE_BRANCH" --single-branch --quiet "$REPO_URL" /opt/forgeshift 2>/dev/null \
  || git clone --quiet "$REPO_URL" /opt/forgeshift 2>/dev/null \
  || msg_error "Failed to clone repository. Check the REPO_URL in the install script."
msg_ok "ForgeShift cloned"

# ── 5. npm install ─────────────────────────────────────────────────────────────
msg_info "Updating npm to latest"
HOME=/root npm install -g npm --cache /tmp/npm-cache --unsafe-perm --no-audit --no-fund --silent 2>&1 || true
msg_ok "npm $(npm --version) ready"

msg_info "Installing Node.js dependencies"
cd /opt/forgeshift
mkdir -p /tmp/npm-cache /tmp/npm-tmp
chmod 777 /tmp/npm-cache /tmp/npm-tmp

# better-sqlite3 needs build tools — already installed above
HOME=/root npm install \
  --omit=dev \
  --cache /tmp/npm-cache \
  --unsafe-perm \
  --no-audit \
  --no-fund \
  2>&1 | tail -5 || msg_error "npm install failed — check output above"
msg_ok "Node.js dependencies installed"

# ── 6. Write .env ──────────────────────────────────────────────────────────────
msg_info "Writing configuration"
JWT_SECRET=$(openssl rand -hex 48)
PASSWORD_PEPPER=$(openssl rand -hex 32)
SERVER_IP=$(hostname -I | awk '{print $1}')

cat > /opt/forgeshift/.env.${APP_ENV} << ENVEOF
NODE_ENV=${APP_ENV}
PORT=3000
APP_NAME=ForgeShift
APP_ENV=${APP_ENV}
APP_URL=http://${SERVER_IP}:3000
JWT_SECRET=${JWT_SECRET}
PASSWORD_PEPPER=${PASSWORD_PEPPER}
DATABASE_PATH=/opt/forgeshift/data/forgeshift.db
COOKIE_SECURE=${COOKIE_SECURE}
TRUST_PROXY=false
COOKIE_MAX_AGE_HOURS=72
ENVEOF

# Create data directory with correct permissions
mkdir -p /opt/forgeshift/data
mkdir -p /opt/forgeshift/public/uploads/avatars
chmod 755 /opt/forgeshift/public/uploads/avatars
msg_ok "Configuration written (.env.${APP_ENV})"

# ── 7. Database migration ──────────────────────────────────────────────────────
msg_info "Running database migration"
cd /opt/forgeshift
HOME=/root NODE_ENV=${APP_ENV} node server/db/migrate.js \
  || msg_error "Database migration failed"
msg_ok "Database schema ready"

# ── 8. systemd service ─────────────────────────────────────────────────────────
msg_info "Creating ForgeShift service"
cat > /etc/systemd/system/forgeshift.service << SVCEOF
[Unit]
Description=ForgeShift Rota Management
After=network.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/forgeshift
Environment=NODE_ENV=${APP_ENV}
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=forgeshift

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable forgeshift --now
msg_ok "ForgeShift service started"

# ── 9. Enable root console autologin (Proxmox pct console) ───────────────────
msg_info "Configuring root console autologin"
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/override.conf << 'GETTYEOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear %I $TERM
GETTYEOF

# Proxmox console can attach via serial in some templates/setups.
mkdir -p /etc/systemd/system/serial-getty@ttyS0.service.d
cat > /etc/systemd/system/serial-getty@ttyS0.service.d/override.conf << 'SERIALGETTYEOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --keep-baud 115200,38400,9600 %I $TERM
SERIALGETTYEOF

systemctl daemon-reload
systemctl restart getty@tty1 || true
systemctl restart serial-getty@ttyS0 || true
msg_ok "Root console autologin enabled"

# ── 10. Verify service is running ──────────────────────────────────────────────
msg_info "Verifying service"
sleep 3
if systemctl is-active --quiet forgeshift; then
  msg_ok "Service is running"
else
  echo ""
  echo "  ⚠️  Service failed to start. Check logs with: journalctl -u forgeshift -n 50"
  journalctl -u forgeshift -n 20 --no-pager || true
  exit 1
fi

# ── 11. Update helper script ───────────────────────────────────────────────────
cat > /opt/forgeshift/update.sh << 'UPDATEEOF'
#!/usr/bin/env bash
set -e
cd /opt/forgeshift

# Detect environment from whichever .env.* file exists
if [[ -f .env.staging ]]; then
  APP_ENV=staging
  TARGET_BRANCH=staging
else
  APP_ENV=production
  TARGET_BRANCH=main
fi

echo "Updating ForgeShift (${APP_ENV})..."

# Keep .env files safe
echo ".env.*" >> .git/info/exclude 2>/dev/null || true

git fetch origin
git reset --hard origin/${TARGET_BRANCH}

mkdir -p /tmp/npm-cache
HOME=/root npm install --omit=dev --cache /tmp/npm-cache --unsafe-perm --no-audit --no-fund

HOME=/root NODE_ENV=${APP_ENV} node server/db/migrate.js
systemctl restart forgeshift
echo "✓ ForgeShift updated to $(cat .version 2>/dev/null || echo 'unknown')"
UPDATEEOF
chmod +x /opt/forgeshift/update.sh

echo ""
msg_ok "ForgeShift installation complete — running at http://localhost:3000"
echo ""
echo "  💡  Visit http://$(hostname -I | awk '{print $1}'):3000/signup.html to create the first admin account."
echo ""
