#!/bin/bash
# ForgeShift — Server Bootstrap Script
# Run as root on a fresh Ubuntu 22.04 LXC container
# Usage: bash setup.sh [develop|staging|production]

set -e

ENV=${1:-production}

if [[ "$ENV" != "develop" && "$ENV" != "staging" && "$ENV" != "production" ]]; then
  echo "Usage: bash setup.sh [develop|staging|production]"
  exit 1
fi

APP_DIR="/opt/forgeshift"
APP_PORT=$(grep "^PORT=" "$APP_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "3000")

echo ""
echo "=========================================="
echo " ForgeShift — Setting up: $ENV"
echo "=========================================="
echo ""

# ── System updates ─────────────────────────────────────────────────
echo "[1/8] Updating system..."
apt-get update -qq && apt-get upgrade -y -qq
apt-get install -y -qq \
  curl wget git ufw nginx \
  ca-certificates gnupg lsb-release \
  openssl sqlite3
echo "      Done."

# ── Node.js 20 ─────────────────────────────────────────────────────
echo "[2/8] Installing Node.js 20..."
if command -v node &>/dev/null && node --version | grep -q "v20"; then
  echo "      Node.js $(node --version) already installed, skipping"
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs
  echo "      Node: $(node --version)  npm: $(npm --version)"
fi

# ── PM2 ────────────────────────────────────────────────────────────
echo "[3/8] Installing PM2..."
if command -v pm2 &>/dev/null; then
  echo "      PM2 $(pm2 --version) already installed, skipping"
else
  npm install -g pm2 --quiet
  echo "      PM2: $(pm2 --version)"
fi

# ── App user ───────────────────────────────────────────────────────
echo "[4/8] Creating app user..."
if id "forgeshift" &>/dev/null; then
  echo "      forgeshift user already exists, skipping"
else
  useradd -r -m -s /bin/bash -d "$APP_DIR" forgeshift
  echo "      forgeshift user created"
fi

# ── App directory & dependencies ───────────────────────────────────
echo "[5/8] Setting up application..."
mkdir -p "$APP_DIR/data"

if [ -f "$APP_DIR/package.json" ]; then
  cd "$APP_DIR"
  echo "      Installing npm dependencies..."
  npm ci --omit=dev --quiet
  echo "      Running database migrations..."
  node scripts/migrate.js
  echo "      Seeding database (pepper from .env)..."
  node scripts/seed.js
else
  echo ""
  echo "  !! ACTION REQUIRED:"
  echo "  No application files found at $APP_DIR"
  echo "  Deploy your files then run:"
  echo ""
  echo "    cd $APP_DIR"
  echo "    npm ci --omit=dev"
  echo "    node scripts/migrate.js"
  echo "    node scripts/seed.js"
  echo ""
fi

chown -R forgeshift:forgeshift "$APP_DIR" 2>/dev/null || true
chmod 750 "$APP_DIR/data" 2>/dev/null || true

# ── PM2 service ────────────────────────────────────────────────────
echo "[6/8] Configuring PM2..."
cat > "$APP_DIR/ecosystem.config.js" << ECOEOF
module.exports = {
  apps: [{
    name:    'forgeshift',
    script:  'src/server.js',
    cwd:     '${APP_DIR}',
    instances: 1,
    exec_mode: 'fork',
    watch:   false,
    max_memory_restart: '400M',
    env: { NODE_ENV: '${ENV}' },
    error_file: '${APP_DIR}/data/pm2-error.log',
    out_file:   '${APP_DIR}/data/pm2-out.log',
    merge_logs: true,
    time: true,
  }]
};
ECOEOF

if [ -f "$APP_DIR/src/server.js" ]; then
  cd "$APP_DIR"
  if pm2 list 2>/dev/null | grep -q "forgeshift"; then
    pm2 restart forgeshift --update-env > /dev/null
    echo "      PM2 process restarted"
  else
    pm2 start "$APP_DIR/ecosystem.config.js" > /dev/null 2>&1
    echo "      PM2 process started"
  fi
  pm2 save --force > /dev/null 2>&1
fi

env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd \
  -u forgeshift --hp "$APP_DIR" > /dev/null 2>&1 || \
  pm2 startup systemd -u root --hp /root > /dev/null 2>&1 || true
echo "      PM2 configured to start on boot"

# ── Nginx ──────────────────────────────────────────────────────────
echo "[7/8] Configuring Nginx..."
cat > /etc/nginx/sites-available/forgeshift << NGINX
server {
    listen 80 default_server;
    server_name _;

    proxy_read_timeout      60s;
    proxy_connect_timeout   60s;
    proxy_send_timeout      60s;

    add_header X-Frame-Options       "SAMEORIGIN"  always;
    add_header X-Content-Type-Options "nosniff"    always;

    # iCal feeds — always fresh, no caching
    location /api/ical/ {
        proxy_pass         http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        add_header         Cache-Control     "no-store, no-cache";
        expires            -1;
    }

    # Static assets
    location ~* \.(css|js|png|ico|svg|woff2?)$ {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_set_header Host \$host;
        expires 1d;
        add_header Cache-Control "public, immutable";
    }

    # Everything else
    location / {
        proxy_pass         http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/forgeshift /etc/nginx/sites-enabled/forgeshift
rm -f /etc/nginx/sites-enabled/default
nginx -t > /dev/null 2>&1 && systemctl restart nginx && systemctl enable nginx --quiet
echo "      Nginx configured and running"

# ── Firewall ───────────────────────────────────────────────────────
echo "[8/8] Configuring firewall..."
ufw allow OpenSSH       > /dev/null 2>&1
ufw allow 'Nginx HTTP'  > /dev/null 2>&1
ufw --force enable      > /dev/null 2>&1
echo "      UFW enabled (SSH + HTTP allowed)"

# ── Summary ────────────────────────────────────────────────────────
CT_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<ip-address>")

echo ""
echo "=========================================="
echo " Setup complete!"
echo "=========================================="
echo ""
echo " Environment : $ENV"
echo " App URL     : http://$CT_IP"
echo " App Dir     : $APP_DIR"
echo ""
echo " Default login:"
echo "   Email    : admin@forgeshift.app"
echo "   Password : ChangeMe123!"
echo ""
echo " iCal feeds (get your token from My Profile after login):"
echo "   Personal : http://$CT_IP/api/ical/<token>/my-shifts.ics"
echo "   Team     : http://$CT_IP/api/ical/<token>/team.ics  (admin only)"
echo ""
echo " Useful commands:"
echo "   pm2 logs forgeshift       — live log tail"
echo "   pm2 restart forgeshift    — restart app"
echo "   pm2 status               — process status"
echo ""
echo " !! Change the admin password after first login!"
echo ""
