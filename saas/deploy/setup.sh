#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# MM Bot SaaS — Oracle Cloud Ubuntu 22.04 Setup Script
# ═══════════════════════════════════════════════════════════════════════════════
# Usage (as root or sudo user):
#   curl -fsSL https://raw.githubusercontent.com/youruser/mm-bot/main/saas/deploy/setup.sh | bash
#   — or —
#   git clone <repo> mm-bot && cd mm-bot && bash saas/deploy/setup.sh
#
# After running:
#   1. Edit /etc/mmbot.env with your real secrets
#   2. Run: source /etc/mmbot.env && pm2 start /home/ubuntu/mm-bot/saas/deploy/ecosystem.config.js
#   3. Set up SSL: certbot --nginx -d your-domain.com
# ═══════════════════════════════════════════════════════════════════════════════

set -Eeuo pipefail
trap 'echo "[setup] ERROR at line $LINENO" >&2; exit 1' ERR

REPO_DIR="/home/ubuntu/mm-bot"
NODE_VERSION="20"
PG_VERSION="15"
DB_NAME="mmbot"
DB_USER="mmbot"

log() { echo "[setup] $(date +%H:%M:%S) — $*"; }

# ── Must run as root ──────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    echo "[setup] Please run as root: sudo bash saas/deploy/setup.sh" >&2
    exit 1
fi

log "Starting MM Bot SaaS setup on $(lsb_release -ds)"

# ── System update ─────────────────────────────────────────────────────────────
log "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
    curl wget gnupg ca-certificates lsb-release \
    build-essential git unzip openssl ufw fail2ban

# ── Node.js 20 (via NodeSource) ───────────────────────────────────────────────
log "Installing Node.js ${NODE_VERSION}..."
if ! command -v node &>/dev/null || [[ $(node -e "process.exit(+process.version.slice(1).split('.')[0] < ${NODE_VERSION})"; echo $?) -eq 0 ]]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
    apt-get install -y -qq nodejs
fi
log "Node $(node --version) / npm $(npm --version)"

# ── PM2 ───────────────────────────────────────────────────────────────────────
log "Installing PM2..."
npm install -g pm2 --silent
pm2 startup systemd -u ubuntu --hp /home/ubuntu | tail -1 | bash || true

# ── Redis 7 ───────────────────────────────────────────────────────────────────
log "Installing Redis 7..."
curl -fsSL https://packages.redis.io/gpg | gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" \
    > /etc/apt/sources.list.d/redis.list
apt-get update -qq
apt-get install -y -qq redis-server

# Secure Redis: bind localhost only + require password
REDIS_PASSWORD=$(openssl rand -hex 32)
sed -i \
    -e 's/^bind .*/bind 127.0.0.1 -::1/' \
    -e 's/^# requirepass .*/requirepass '"${REDIS_PASSWORD}"'/' \
    /etc/redis/redis.conf
systemctl restart redis-server
systemctl enable redis-server
log "Redis installed. Password stored in /etc/mmbot.env"

# ── PostgreSQL 15 ─────────────────────────────────────────────────────────────
log "Installing PostgreSQL ${PG_VERSION}..."
curl -fsSL "https://www.postgresql.org/media/keys/ACCC4CF8.asc" \
    | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg
echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] \
    http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
apt-get update -qq
apt-get install -y -qq "postgresql-${PG_VERSION}"

systemctl start postgresql
systemctl enable postgresql

# Create DB user + database
DB_PASSWORD=$(openssl rand -hex 32)
sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';" || true
sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};" || true

log "PostgreSQL installed. DB: ${DB_NAME}, User: ${DB_USER}"

# ── Nginx ─────────────────────────────────────────────────────────────────────
log "Installing Nginx..."
apt-get install -y -qq nginx certbot python3-certbot-nginx

# ── Clone / update repo ───────────────────────────────────────────────────────
log "Setting up application directory..."
if [[ -d "${REPO_DIR}/.git" ]]; then
    log "Repo exists, pulling latest..."
    sudo -u ubuntu git -C "${REPO_DIR}" pull
else
    log "Cloning repository (update URL below if needed)..."
    # Replace with your actual repo URL before running
    REPO_URL="${MMBOT_REPO_URL:-https://github.com/youruser/mm-bot.git}"
    sudo -u ubuntu git clone "${REPO_URL}" "${REPO_DIR}"
fi

# ── Install Node dependencies ─────────────────────────────────────────────────
log "Installing npm dependencies..."
sudo -u ubuntu npm --prefix "${REPO_DIR}" install --production --silent
sudo -u ubuntu npm --prefix "${REPO_DIR}/saas/api" install --production --silent

# ── Create logs directory ─────────────────────────────────────────────────────
mkdir -p "${REPO_DIR}/logs"
chown -R ubuntu:ubuntu "${REPO_DIR}/logs"

# ── Generate secrets ──────────────────────────────────────────────────────────
JWT_SECRET=$(openssl rand -hex 48)
ENCRYPTION_KEY=$(openssl rand -hex 32)
ADMIN_SECRET=$(openssl rand -hex 24)

# ── Write environment file ────────────────────────────────────────────────────
log "Writing /etc/mmbot.env..."
cat > /etc/mmbot.env <<EOF
# MM Bot SaaS — Environment Variables
# Generated by setup.sh on $(date)
# Edit this file then: source /etc/mmbot.env && pm2 restart all

NODE_ENV=production
PORT=3000

# JWT
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=24h

# AES-256-GCM encryption key (64 hex chars = 32 bytes)
ENCRYPTION_KEY=${ENCRYPTION_KEY}

# PostgreSQL
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=${DB_NAME}
PGUSER=${DB_USER}
PGPASSWORD=${DB_PASSWORD}

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=${REDIS_PASSWORD}

# CORS — set to your frontend domain in production
CORS_ORIGIN=*

# Admin
ADMIN_SECRET=${ADMIN_SECRET}

# Global kill switch (set to true to emergency-stop all bots)
GLOBAL_KILL_SWITCH=false

# Telegram platform bot token
# Create at @BotFather → copy token here, then users register via PUT /auth/telegram
TELEGRAM_BOT_TOKEN=

# BTC reference price for sizing calculations (update periodically or via cron)
BTC_PRICE_USDT=70000
EOF

chmod 600 /etc/mmbot.env
log "/etc/mmbot.env written (secrets generated)"

# ── Source env for DB migration ───────────────────────────────────────────────
set -a; source /etc/mmbot.env; set +a

# Run DB schema migration
log "Running database migration..."
sudo -u ubuntu \
    env $(cat /etc/mmbot.env | grep -v '^#' | xargs) \
    node "${REPO_DIR}/saas/api/src/db/migrate.js"

# ── Nginx config ──────────────────────────────────────────────────────────────
log "Configuring Nginx..."
cp "${REPO_DIR}/saas/deploy/nginx.conf" /etc/nginx/sites-available/mmbot
ln -sf /etc/nginx/sites-available/mmbot /etc/nginx/sites-enabled/mmbot
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
systemctl enable nginx

# ── UFW Firewall ──────────────────────────────────────────────────────────────
log "Configuring firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
# Block public access to Redis and PostgreSQL (bind to localhost only)
ufw --force enable

# ── fail2ban ──────────────────────────────────────────────────────────────────
systemctl enable fail2ban
systemctl start fail2ban

# ── PM2 start ─────────────────────────────────────────────────────────────────
log "Starting services with PM2..."
sudo -u ubuntu \
    env $(cat /etc/mmbot.env | grep -v '^#' | xargs) \
    pm2 start "${REPO_DIR}/saas/deploy/ecosystem.config.js"

sudo -u ubuntu pm2 save

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " MM Bot SaaS — Setup Complete"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo " Secrets saved to: /etc/mmbot.env"
echo " App directory:    ${REPO_DIR}"
echo " Logs:             ${REPO_DIR}/logs/"
echo ""
echo " Next steps:"
echo "   1. Update your domain in /etc/nginx/sites-available/mmbot"
echo "   2. Run: certbot --nginx -d your-domain.com"
echo "   3. Check: pm2 status"
echo "   4. Check: pm2 logs mmbot-api"
echo ""
echo " API health: http://$(curl -s ifconfig.me)/health"
echo ""
echo " IMPORTANT: Set CORS_ORIGIN in /etc/mmbot.env to your frontend domain"
echo "            then: source /etc/mmbot.env && pm2 restart all"
echo "═══════════════════════════════════════════════════════════════"
