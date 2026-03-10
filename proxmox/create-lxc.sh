#!/bin/bash
# ForgeShift — Proxmox LXC Creation Script
# Run this on your Proxmox HOST shell (not inside a container)
# Usage: bash create-lxc.sh [develop|staging|production]

set -e

ENV=${1:-production}

if [[ "$ENV" != "develop" && "$ENV" != "staging" && "$ENV" != "production" ]]; then
  echo "Usage: bash create-lxc.sh [develop|staging|production]"
  exit 1
fi

# ── Environment defaults ───────────────────────────────────────────
case "$ENV" in
  production)
    DEFAULT_CTID=200
    DEFAULT_HOSTNAME="forgeshift"
    DEFAULT_RAM=512
    DEFAULT_DISK=4
    DEFAULT_CORES=1
    ;;
  staging)
    DEFAULT_CTID=201
    DEFAULT_HOSTNAME="forgeshift-staging"
    DEFAULT_RAM=512
    DEFAULT_DISK=4
    DEFAULT_CORES=1
    ;;
  develop)
    DEFAULT_CTID=202
    DEFAULT_HOSTNAME="forgeshift-dev"
    DEFAULT_RAM=512
    DEFAULT_DISK=4
    DEFAULT_CORES=1
    ;;
esac

echo ""
echo "=========================================="
echo " ForgeShift — Proxmox LXC Setup: $ENV"
echo "=========================================="
echo ""

# ── Confirm Proxmox host ───────────────────────────────────────────
if ! command -v pveversion &>/dev/null; then
  echo "Error: This script must be run on a Proxmox VE host."
  exit 1
fi
echo "  Proxmox VE detected: $(pveversion | grep -oP '\d+\.\d+' | head -1)"
echo ""

# ── [1/6] Storage selection ────────────────────────────────────────
echo "[1/6] Selecting storage..."
STORAGES=$(pvesm status --content rootdir 2>/dev/null | awk 'NR>1 && $2=="active" {print $1}')
if [ -z "$STORAGES" ]; then
  STORAGES="local-lvm"
fi

echo ""
echo "  Available storage pools:"
i=1
declare -A STORAGE_MAP
while IFS= read -r s; do
  echo "    $i) $s"
  STORAGE_MAP[$i]="$s"
  ((i++))
done <<< "$STORAGES"
echo ""
read -rp "  Select storage [1]: " STORAGE_CHOICE
STORAGE_CHOICE=${STORAGE_CHOICE:-1}
STORAGE=${STORAGE_MAP[$STORAGE_CHOICE]:-local-lvm}
echo "      Storage: $STORAGE"

# ── [2/6] Ubuntu template ──────────────────────────────────────────
echo ""
echo "[2/6] Checking Ubuntu 22.04 template..."
TEMPLATE_STORAGE=$(pvesm status --content vztmpl 2>/dev/null | awk 'NR>1 && $2=="active" {print $1}' | head -1)
TEMPLATE_STORAGE=${TEMPLATE_STORAGE:-local}

TEMPLATE=$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep "ubuntu-22.04-standard" | awk '{print $1}' | tail -1)

if [ -z "$TEMPLATE" ]; then
  echo "      Downloading Ubuntu 22.04 template..."
  pveam update > /dev/null 2>&1
  pveam download "$TEMPLATE_STORAGE" ubuntu-22.04-standard_22.04-1_amd64.tar.zst
  TEMPLATE="${TEMPLATE_STORAGE}:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst"
  echo "      Template downloaded"
else
  echo "      Template found: $TEMPLATE"
fi

# ── [3/6] Container configuration ─────────────────────────────────
echo ""
echo "[3/6] Container configuration..."
echo ""

read -rp "  Container ID    [$DEFAULT_CTID]: "    CTID;     CTID=${CTID:-$DEFAULT_CTID}
read -rp "  Hostname        [$DEFAULT_HOSTNAME]: " HOSTNAME; HOSTNAME=${HOSTNAME:-$DEFAULT_HOSTNAME}
read -rp "  RAM (MB)        [$DEFAULT_RAM]: "      RAM;      RAM=${RAM:-$DEFAULT_RAM}
read -rp "  Disk size (GB)  [$DEFAULT_DISK]: "     DISK;     DISK=${DISK:-$DEFAULT_DISK}
read -rp "  CPU cores       [$DEFAULT_CORES]: "    CORES;    CORES=${CORES:-$DEFAULT_CORES}
read -rp "  App port        [3000]: "               APP_PORT; APP_PORT=${APP_PORT:-3000}

echo ""
read -s -rp "  Root password for container: " ROOT_PASS
echo ""

if [ -z "$ROOT_PASS" ]; then
  ROOT_PASS=$(openssl rand -base64 16)
  echo "      No password entered — generated: $ROOT_PASS"
  echo "      Save this now, it will not be shown again."
fi

if pct status "$CTID" &>/dev/null; then
  echo ""
  echo "  Warning: Container $CTID already exists!"
  read -rp "  Delete and recreate it? [y/N]: " CONFIRM
  [[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "  Aborted."; exit 0; }
  pct stop "$CTID" 2>/dev/null || true
  pct destroy "$CTID" --purge 2>/dev/null || true
  echo "      Existing container removed"
fi

# ── [4/6] Create container ─────────────────────────────────────────
echo ""
echo "[4/6] Creating LXC container $CTID..."
pct create "$CTID" "$TEMPLATE" \
  --hostname  "$HOSTNAME" \
  --cores     "$CORES" \
  --memory    "$RAM" \
  --swap      512 \
  --rootfs    "${STORAGE}:${DISK}" \
  --net0      name=eth0,bridge=vmbr0,ip=dhcp \
  --ostype    ubuntu \
  --unprivileged 1 \
  --features  nesting=1 \
  --password  "$ROOT_PASS" \
  --start     1 \
  --onboot    1 \
  --description "ForgeShift $ENV — Shift Rota Management"

echo "      Container created and started"
echo "      Waiting for container to boot..."
sleep 8

CT_IP=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$CT_IP" ]; then
  echo "      Container IP: $CT_IP"
else
  echo "      Could not detect IP yet — check with: pct exec $CTID -- hostname -I"
  CT_IP="<container-ip>"
fi

# ── [5/6] Environment & bootstrap ─────────────────────────────────
echo ""
echo "[5/6] Writing environment config..."

SESSION_SECRET=$(openssl rand -hex 64)

pct exec "$CTID" -- bash -c "mkdir -p /opt/forgeshift/data"
pct exec "$CTID" -- bash -c "cat > /opt/forgeshift/.env << 'ENVEOF'
NODE_ENV=$ENV
PORT=$APP_PORT
HOST=0.0.0.0
SESSION_SECRET=$SESSION_SECRET
SESSION_MAX_AGE=604800000
DB_PATH=./data/forgeshift.db
SESSION_DB_PATH=./data/sessions.db
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=200
AUTH_RATE_LIMIT_WINDOW_MS=900000
AUTH_RATE_LIMIT_MAX=20
ADMIN_EMAIL=admin@forgeshift.app
ADMIN_USERNAME=admin
ADMIN_PASSWORD=ChangeMe123!
ADMIN_NAME=Administrator
TRUST_PROXY=1
COOKIE_SECURE=false
COOKIE_SAME_SITE=strict
ICAL_CALENDAR_NAME=ForgeShift
ENVEOF"

echo "      .env written to container"

# ── [6/6] Run bootstrap ────────────────────────────────────────────
echo ""
echo "[6/6] Running bootstrap inside container..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pct push "$CTID" "$SCRIPT_DIR/setup.sh" /root/setup.sh
pct exec "$CTID" -- chmod +x /root/setup.sh
pct exec "$CTID" -- bash /root/setup.sh "$ENV"

# ── Summary ────────────────────────────────────────────────────────
echo ""
echo "=========================================="
echo " ForgeShift $ENV is ready!"
echo "=========================================="
echo ""
echo " Container   : $CTID ($HOSTNAME)"
echo " IP Address  : $CT_IP"
echo " App URL     : http://$CT_IP"
echo ""
echo " Default login:"
echo "   Email    : admin@forgeshift.app"
echo "   Password : ChangeMe123!"
echo ""
echo " iCal feeds (get token from My Profile after login):"
echo "   Personal : http://$CT_IP/api/ical/<token>/my-shifts.ics"
echo "   Team     : http://$CT_IP/api/ical/<token>/team.ics  (admin only)"
echo ""
echo " Management:"
echo "   Shell    : pct enter $CTID"
echo "   Logs     : pct exec $CTID -- pm2 logs forgeshift"
echo "   Restart  : pct exec $CTID -- pm2 restart forgeshift"
echo "   Stop CT  : pct stop $CTID"
echo ""
echo " Next steps:"
echo " 1. Visit http://$CT_IP and log in"
echo " 2. Change the admin password immediately"
echo " 3. Deploy your app files to /opt/forgeshift if not already done:"
echo ""
echo "    pct enter $CTID"
echo "    cd /opt/forgeshift"
echo "    git clone https://github.com/YOUR_ORG/forgeshift.git ."
echo "    git checkout $ENV"
echo "    npm ci --omit=dev"
echo "    node scripts/migrate.js"
echo "    node scripts/seed.js"
echo "    pm2 start ecosystem.config.js"
echo "    pm2 save"
echo ""
echo " !! Change the admin password after first login!"
echo ""
