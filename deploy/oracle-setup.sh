#!/usr/bin/env bash
# One-time setup of the Wanna Tennis bot + website on an Oracle Cloud Always Free
# Ubuntu server (x86 E2.1.Micro or Arm A1). Safe to run again (updates in place).
#
#   bash oracle-setup.sh <hostname>        e.g.  bash oracle-setup.sh 129-150-1-2.sslip.io
#
# Afterwards, from the Mac (bot stopped there first):
#   scp .env and data/app.db to the server  -> see README "Always-on server (Oracle)"
set -euo pipefail

HOST="${1:?usage: bash oracle-setup.sh <hostname, e.g. 129-150-1-2.sslip.io>}"
APP=/opt/wannatennis
REPO=https://github.com/FranceFlapjack/wannatennis.git
SVC_USER=wannatennis

say() { printf '\n\033[1;32m== %s\033[0m\n' "$*"; }

say "Packages"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates gnupg xz-utils \
  debian-keyring debian-archive-keyring apt-transport-https iptables-persistent >/dev/null

say "Node.js 22 (official build, checksum verified)"
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "unsupported CPU $(uname -m)"; exit 1 ;; esac
if ! /usr/local/bin/node -v 2>/dev/null | grep -q '^v22\.'; then
  TMP=$(mktemp -d)
  curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$TMP/SHASUMS256.txt"
  TARBALL=$(grep -oE "node-v22\.[0-9.]+-linux-${ARCH}\.tar\.xz" "$TMP/SHASUMS256.txt" | head -1)
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$TARBALL" -o "$TMP/$TARBALL"
  (cd "$TMP" && grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c -)
  sudo tar -xJf "$TMP/$TARBALL" -C /usr/local --strip-components=1 --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE'
  rm -rf "$TMP"
fi
/usr/local/bin/node -v

say "Caddy (HTTPS in front of the app, certificates automatic)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq caddy >/dev/null
fi
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$HOST {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF

say "App user + code in $APP"
id "$SVC_USER" >/dev/null 2>&1 || sudo useradd --system --home "$APP" --shell /usr/sbin/nologin "$SVC_USER"
if [ -d "$APP/.git" ]; then sudo -u "$SVC_USER" git -C "$APP" pull --ff-only
else sudo mkdir -p "$APP" && sudo chown "$SVC_USER": "$APP" && sudo -u "$SVC_USER" git clone -q "$REPO" "$APP"; fi
sudo -u "$SVC_USER" mkdir -p "$APP/data"

say "Service (starts on boot, restarts if it crashes)"
sudo tee /etc/systemd/system/wannatennis.service >/dev/null <<EOF
[Unit]
Description=Wanna Tennis - LINE bot + website
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
WorkingDirectory=$APP
ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000
# these win over .env (copied from the Mac, where PUBLIC_URL was the tunnel)
Environment=PUBLIC_URL=https://$HOST
Environment=PROXY_IP_HEADER=x-forwarded-for

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable -q wannatennis caddy

say "Firewall inside the server: open 80 + 443 (Oracle images reject everything else)"
for PORT in 443 80; do
  if ! sudo iptables -C INPUT -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT 2>/dev/null; then
    N=$(sudo iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}')
    if [ -n "$N" ]; then sudo iptables -I INPUT "$N" -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT
    else sudo iptables -A INPUT -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT; fi
  fi
done
sudo netfilter-persistent save >/dev/null

say "Start"
sudo systemctl restart wannatennis
sudo systemctl reload-or-restart caddy
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break; sleep 1; done
systemctl --no-pager --lines=0 status wannatennis caddy | grep -E '●|Active:' || true
curl -fsS http://127.0.0.1:3000/api/health && echo || echo "app not answering yet — see: journalctl -u wannatennis -n 50"
echo
echo "Next: copy .env (+ data/app.db) from the Mac, then: sudo systemctl restart wannatennis"
echo "Logs: journalctl -u wannatennis -f        Webhook: https://$HOST/line/webhook"
