#!/usr/bin/env bash
# Crate — self-host deploy for any VPS (Ubuntu/Debian).
# Installs Node 22, Caddy, the app in /opt/crate, a systemd unit, and HTTPS for a domain.

set -euo pipefail

DOMAIN="${1:-}"
INSTALL_DIR=/opt/crate
SERVICE=crate
PORT=8790

if [ -z "$DOMAIN" ]; then
  echo "usage: $0 <domain>" >&2
  echo "example: $0 dj.example.com" >&2
  exit 1
fi

echo "==> base system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg

echo "==> Node.js 22"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Caddy (reverse proxy + automatic HTTPS)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y caddy
fi

echo "==> app files (run from a checkout of this repo)"
mkdir -p "$INSTALL_DIR"
rsync -a --delete --exclude node_modules --exclude .wrangler --exclude '*.log' \
  ./ "$INSTALL_DIR"/
cd "$INSTALL_DIR"
npm install --omit=dev || npm install

echo "==> systemd unit"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Crate party app
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/npx wrangler dev --port $PORT --ip 127.0.0.1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$SERVICE"

echo "==> Caddy"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT
}
EOF
systemctl reload caddy || systemctl restart caddy

if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
fi

echo "==> verify"
sleep 5
systemctl is-active "$SERVICE" caddy
curl -s -o /dev/null -w "local app:  %{http_code}\n" "http://127.0.0.1:$PORT/"
curl -sk -o /dev/null -w "public site: %{http_code}\n" "https://$DOMAIN/"

echo "==> done: https://$DOMAIN  (DJ console: /dj)"
