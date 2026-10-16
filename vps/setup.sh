#!/usr/bin/env bash
# One-shot installer for flashpoint-api-proxy on a fresh Ubuntu VM (Oracle Cloud Always
# Free, or any VPS). Run from the folder that holds server.mjs:
#
#     sudo bash setup.sh
#
# What it does:
#   - installs Node 22 and Caddy (automatic HTTPS) from their official apt repos
#   - asks for API_FOOTBALL_KEY and CLIENT_TOKEN without echoing them, stores them in a
#     root-only file, and never puts them on a command line or in shell history
#   - runs server.mjs as a locked-down systemd service that restarts on crash and on boot
#   - gives it a free HTTPS address, <ip-with-dashes>.sslip.io, so no domain is needed
#   - opens ports 80/443 in the VM's own firewall, enforces key-only SSH, and turns on
#     automatic security updates
#
# Safe to re-run: it's how you change the API key later (press Enter at a prompt to keep
# the current value) or pick up a new server.mjs.

set -euo pipefail

APP_DIR=/opt/flashpoint-api-proxy
ENV_FILE=/etc/flashpoint-api-proxy.env
SERVICE=flashpoint-api-proxy
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run this with sudo:  sudo bash setup.sh"
[[ -f "$SCRIPT_DIR/server.mjs" ]] || die "server.mjs must be in the same folder as setup.sh"
command -v apt-get >/dev/null || die "This script expects Ubuntu (apt-get not found)"

# ---------------------------------------------------------------------------------------
say "Secrets"
existing_key=""; existing_token=""
if [[ -f "$ENV_FILE" ]]; then
  existing_key="$(sed -n 's/^API_FOOTBALL_KEY=//p' "$ENV_FILE")"
  existing_token="$(sed -n 's/^CLIENT_TOKEN=//p' "$ENV_FILE")"
fi

prompt_secret() { # $1 label, $2 existing value -> prints chosen value
  local label="$1" current="$2" value hint=""
  [[ -n "$current" ]] && hint=" (Enter keeps current …${current: -4})"
  while true; do
    read -rsp "  $label$hint: " value </dev/tty; echo >&2
    value="${value//[[:space:]]/}"            # stray spaces/newlines from pasting
    [[ -z "$value" && -n "$current" ]] && value="$current"
    [[ -n "$value" ]] && { printf '%s' "$value"; return; }
    echo "  (can't be empty)" >&2
  done
}
API_FOOTBALL_KEY="$(prompt_secret "API-Football key" "$existing_key")"
CLIENT_TOKEN="$(prompt_secret "Client token (same as the app's BackendConfig.clientToken)" "$existing_token")"
[[ ${#CLIENT_TOKEN} -ge 32 ]] || die "Client token looks too short — copy line 2 of .dev.vars"

umask 077
printf 'API_FOOTBALL_KEY=%s\nCLIENT_TOKEN=%s\n' "$API_FOOTBALL_KEY" "$CLIENT_TOKEN" > "$ENV_FILE"
chown root:root "$ENV_FILE"; chmod 600 "$ENV_FILE"
umask 022
unset API_FOOTBALL_KEY CLIENT_TOKEN existing_key existing_token

# ---------------------------------------------------------------------------------------
say "Finding this server's public IP"
PUBLIC_IP="${PUBLIC_IP:-$(curl -fsS --max-time 10 https://api.ipify.org || true)}"
[[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Couldn't detect public IP. Re-run as: sudo PUBLIC_IP=x.x.x.x bash setup.sh"
DOMAIN="${PUBLIC_IP//./-}.sslip.io"
echo "  $PUBLIC_IP  ->  https://$DOMAIN"

# ---------------------------------------------------------------------------------------
say "Installing packages (takes a few minutes on the free VM)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl gnupg debian-keyring debian-archive-keyring \
  apt-transport-https unattended-upgrades

if ! node --version 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi
echo "  node $(node --version)"

if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi
echo "  $(caddy version | head -1)"

# ---------------------------------------------------------------------------------------
say "Installing the proxy service"
install -d -m 755 "$APP_DIR"
install -m 644 "$SCRIPT_DIR/server.mjs" "$APP_DIR/server.mjs"

cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=Flashpoint API-Football proxy
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$(command -v node) $APP_DIR/server.mjs
EnvironmentFile=$ENV_FILE
Environment=HOST=127.0.0.1 PORT=8787 NODE_ENV=production
Restart=always
RestartSec=2

# Runs as a throwaway unprivileged user with a read-only view of the system.
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=yes
LockPersonality=yes
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

for _ in $(seq 1 20); do
  curl -fsS --max-time 2 http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 2 http://127.0.0.1:8787/healthz >/dev/null \
  || { journalctl -u "$SERVICE" -n 30 --no-pager; die "Proxy didn't start (log above)"; }
echo "  proxy running on 127.0.0.1:8787"

# ---------------------------------------------------------------------------------------
say "Configuring HTTPS for $DOMAIN"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:8787
}
CADDY
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null
systemctl restart caddy

# ---------------------------------------------------------------------------------------
say "Opening ports 80 and 443 in the VM firewall"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  echo "  ufw: allowed 80, 443"
fi
# Oracle's Ubuntu images ship iptables rules that REJECT everything but SSH. New ACCEPT
# rules have to go *above* that REJECT, then be saved so they survive a reboot.
if command -v iptables >/dev/null && iptables -S INPUT | grep -q -- '-j REJECT'; then
  reject_line="$(iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}')"
  for port in 443 80; do
    iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null \
      || iptables -I INPUT "$reject_line" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null; then
    netfilter-persistent save >/dev/null 2>&1
  else
    apt-get install -yq iptables-persistent >/dev/null && netfilter-persistent save >/dev/null 2>&1
  fi
  echo "  iptables: allowed 80, 443 (saved)"
fi

# ---------------------------------------------------------------------------------------
say "Hardening SSH and enabling automatic security updates"
# You're logged in with an SSH key right now, so turning off passwords can't lock you out.
cat > /etc/ssh/sshd_config.d/99-flashpoint.conf <<'SSHD'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
SSHD
if sshd -t 2>/dev/null; then
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  echo "  ssh: key-only, no root login"
else
  rm -f /etc/ssh/sshd_config.d/99-flashpoint.conf
  echo "  ssh: left unchanged (config test failed)"
fi
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT
echo "  unattended security upgrades: on"

# ---------------------------------------------------------------------------------------
say "Waiting for the HTTPS certificate (up to ~2 minutes)"
ok=""
for _ in $(seq 1 24); do
  if curl -fsS --max-time 5 "https://$DOMAIN/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done

if [[ -n "$ok" ]]; then
  printf '\n\033[1;32mDone.\033[0m Your proxy is live at:\n\n    https://%s\n\n' "$DOMAIN"
  echo "Test it from your Mac (in the flashpoint-api-proxy folder, after 'source .dev.vars'):"
  echo "    curl -s \"https://$DOMAIN/fixtures?date=\$(date +%F)\" -H \"x-flashpoint-client: \$CLIENT_TOKEN\" | head -c 300"
else
  cat <<MSG

The proxy is running, but HTTPS at https://$DOMAIN isn't answering yet.
Most likely cause: ports 80 and 443 aren't open in Oracle's Security List
(Networking > Virtual cloud networks > your VCN > Security Lists > Default > Add Ingress Rules:
source 0.0.0.0/0, TCP, destination ports 80 and 443).
Add them, then check again with:   curl https://$DOMAIN/healthz
Certificate logs:                  sudo journalctl -u caddy -n 50 --no-pager
MSG
fi
