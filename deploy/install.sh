#!/usr/bin/env bash
# AI LeadGen — one-command installer for an Ubuntu 22.04/24.04 VPS.
#
#   sudo bash deploy/install.sh [domain]          (default domain: leadgen.dealpost.co.in)
#
# Safe to re-run: existing .env files and secrets are kept, code is rebuilt, processes reloaded.
# Flags (env vars):
#   SKIP_SYSTEM=1   don't install apt packages / Node / MongoDB / PM2
#   SKIP_NGINX=1    don't touch Nginx or Certbot
#   CERT_EMAIL=...  email for Let's Encrypt (default: first PLATFORM_ADMIN_EMAILS entry)
set -Eeuo pipefail

DOMAIN="${1:-${DOMAIN:-leadgen.dealpost.co.in}}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_EMAIL="${ADMIN_EMAIL:-prawinkumar2k4@gmail.com}"
CERT_EMAIL="${CERT_EMAIL:-$ADMIN_EMAIL}"
N8N_URL="${N8N_URL:-https://n8n.dealpost.co.in}"
RUN_AS="${SUDO_USER:-$(id -un)}"

c_ok=$'\e[32m'; c_warn=$'\e[33m'; c_err=$'\e[31m'; c_b=$'\e[1m'; c_0=$'\e[0m'
step() { printf '\n%s==> %s%s\n' "$c_b" "$*" "$c_0"; }
ok()   { printf '%s  ✓ %s%s\n' "$c_ok" "$*" "$c_0"; }
warn() { printf '%s  ! %s%s\n' "$c_warn" "$*" "$c_0"; }
die()  { printf '%s  ✗ %s%s\n' "$c_err" "$*" "$c_0" >&2; exit 1; }
trap 'die "Failed at line $LINENO: $BASH_COMMAND"' ERR

as_user() { if [[ $(id -un) == "$RUN_AS" ]]; then "$@"; else sudo -u "$RUN_AS" -H "$@"; fi; }
need_root() { [[ $EUID -eq 0 ]] || die "Run with sudo for system setup (or set SKIP_SYSTEM=1 SKIP_NGINX=1)."; }
rand() { openssl rand -hex "${1:-32}"; }
# Name of the process listening on a TCP port (empty if free)
port_owner() {
  ss -ltnpH "sport = :$1" 2>/dev/null | head -1 | sed -E 's/.*users:\(\("([^"]+)".*/\1/' || true
}

# Read KEY from an env file
env_get() { grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
# Set KEY=VALUE in an env file only if missing or empty (keeps existing secrets)
env_default() {
  local file=$1 key=$2 val=$3
  if grep -qE "^$key=.+" "$file"; then return; fi
  if grep -qE "^$key=" "$file"; then sed -i "s|^$key=.*|$key=$val|" "$file"; else echo "$key=$val" >> "$file"; fi
}
# Force KEY=VALUE (non-secret settings that follow the domain)
env_set() {
  local file=$1 key=$2 val=$3
  if grep -qE "^$key=" "$file"; then sed -i "s|^$key=.*|$key=$val|" "$file"; else echo "$key=$val" >> "$file"; fi
}

printf '%sAI LeadGen installer%s\n  domain:  %s\n  app dir: %s\n  user:    %s\n' "$c_b" "$c_0" "$DOMAIN" "$APP_DIR" "$RUN_AS"

# ---------------------------------------------------------------- 1. system packages
if [[ "${SKIP_SYSTEM:-0}" != 1 ]]; then
  need_root
  step "System packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg openssl python3 python3-venv python3-pip build-essential >/dev/null
  ok "base packages"

  if ! command -v node >/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  fi
  ok "Node $(node -v)"

  command -v pm2 >/dev/null || npm i -g pm2 >/dev/null 2>&1
  ok "PM2 $(pm2 -v)"

  if ! command -v mongod >/dev/null && ! (ss -ltn | grep -q ':27017 '); then
    . /etc/os-release
    curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-8.0.gpg --yes
    echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu ${VERSION_CODENAME}/mongodb-org/8.0 multiverse" > /etc/apt/sources.list.d/mongodb-org-8.0.list
    apt-get update -qq && apt-get install -y -qq mongodb-org >/dev/null
    systemctl enable --now mongod >/dev/null
    sleep 3
  fi
  ss -ltn | grep -q '127.0.0.1:27017\|:27017 ' && ok "MongoDB listening on 27017" || die "MongoDB is not running (systemctl status mongod)"
  if ss -ltn | grep -qE '0\.0\.0\.0:27017|\*:27017|\[::\]:27017'; then
    warn "MongoDB is listening on all interfaces. Set bindIp: 127.0.0.1 in /etc/mongod.conf, or keep port 27017 closed in UFW."
  fi
fi

for bin in node npm python3 openssl; do command -v $bin >/dev/null || die "$bin is required"; done

# ---------------------------------------------------------------- 2. configuration
step "Configuration"
S="$APP_DIR/server/.env"; A="$APP_DIR/analyzer/.env"
[[ -f $S ]] || { cp "$APP_DIR/server/.env.example" "$S"; ok "created server/.env"; }
[[ -f $A ]] || { cp "$APP_DIR/analyzer/.env.example" "$A"; ok "created analyzer/.env"; }

BASE="https://$DOMAIN"
[[ "${SKIP_NGINX:-0}" == 1 && "${LOCAL_TEST:-0}" == 1 ]] && BASE="http://127.0.0.1:4000"
env_set "$S" NODE_ENV production
env_set "$S" APP_URL "$BASE"
env_set "$S" API_URL "$BASE"
env_set "$S" CORS_ORIGINS "$BASE"
env_set "$S" N8N_BASE_URL "$N8N_URL"
env_set "$S" ANALYZER_URL "http://127.0.0.1:8000"
env_set "$S" ANALYZER_PUBLIC_URL "$BASE/analyzer"
env_set "$S" RUN_WORKER false
env_default "$S" MONGODB_URI "mongodb://127.0.0.1:27017/ai_leadgen"
env_default "$S" PLATFORM_ADMIN_EMAILS "$ADMIN_EMAIL"
env_default "$S" AUTOMATION_MODE n8n
env_default "$S" JWT_SECRET "$(rand 32)"
env_default "$S" ENCRYPTION_KEY "$(rand 32)"
env_default "$S" N8N_WEBHOOK_SECRET "$(rand 32)"
env_default "$S" ANALYZER_TOKEN "$(rand 24)"
env_set "$A" ANALYZER_TOKEN "$(env_get "$S" ANALYZER_TOKEN)"
env_set "$A" ANALYZER_USER_AGENT "AILeadGenBot/1.0 (+$BASE)"
chmod 600 "$S" "$A"; chown "$RUN_AS" "$S" "$A" 2>/dev/null || true
ok "secrets generated (existing values kept)"

MODE=$(env_get "$S" AUTOMATION_MODE)
if [[ $MODE == direct ]]; then
  [[ -n $(env_get "$S" ANTHROPIC_API_KEY) ]] || warn "direct mode: ANTHROPIC_API_KEY is empty, so scoring will use the rule-based fallback"
  [[ -n $(env_get "$S" GOOGLE_PLACES_API_KEY) ]] || warn "direct mode: GOOGLE_PLACES_API_KEY is empty, so searches will fail"
  [[ -n $(env_get "$S" SMTP_URL) ]] || warn "direct mode: SMTP_URL is empty, so approved emails can't be sent"
fi

# ---------------------------------------------------------------- 3. build
step "Build"
chown -R "$RUN_AS" "$APP_DIR" 2>/dev/null || true
( cd "$APP_DIR/server" && as_user npm ci --no-audit --no-fund --loglevel=error && as_user npm run build --silent )
ok "API built"
( cd "$APP_DIR/analyzer" && { [[ -x .venv/bin/python ]] || as_user python3 -m venv .venv; } && as_user .venv/bin/pip install -q -r requirements.txt )
ok "analyzer environment ready"
( cd "$APP_DIR/web" && as_user npm ci --no-audit --no-fund --loglevel=error && as_user npm run build --silent >/dev/null )
ok "frontend built ($(du -sh "$APP_DIR/web/dist" | cut -f1))"

# ---------------------------------------------------------------- 4. processes
step "Processes (PM2)"
command -v pm2 >/dev/null || die "pm2 not found (npm i -g pm2)"
( cd "$APP_DIR" && as_user pm2 startOrReload deploy/ecosystem.config.cjs --update-env >/dev/null )
as_user pm2 save >/dev/null
if [[ $EUID -eq 0 && "${SKIP_SYSTEM:-0}" != 1 ]]; then
  pm2 startup systemd -u "$RUN_AS" --hp "$(getent passwd "$RUN_AS" | cut -d: -f6)" >/dev/null 2>&1 || true
fi
ok "leadgen-api, leadgen-worker, leadgen-analyzer running"

wait_for() { for _ in $(seq 1 30); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
wait_for http://127.0.0.1:4000/api/health || die "API did not start: pm2 logs leadgen-api"
health=$(curl -fsS http://127.0.0.1:4000/api/health)
[[ $health == *'"db":true'* ]] || die "API is up but cannot reach MongoDB: $health"
ok "API healthy: $health"
wait_for http://127.0.0.1:8000/health || die "Analyzer did not start: pm2 logs leadgen-analyzer"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8000/analyze -H 'content-type: application/json' -d '{"url":"example.com"}')
[[ $code == 401 ]] && ok "analyzer healthy and rejects calls without its token" || die "Analyzer token check failed (HTTP $code)"

# ---------------------------------------------------------------- 5. Nginx + TLS
if [[ "${SKIP_NGINX:-0}" != 1 ]]; then
  need_root
  step "Nginx and HTTPS"
  owner80=$(port_owner 80)
  if [[ -n $owner80 && $owner80 != nginx ]]; then
    die "Port 80 is used by '$owner80', not Nginx. On Hostinger's n8n template this is Docker/Traefik.
     The app is running on 127.0.0.1:4000. Tell Claude which proxy owns 80/443 and it will generate the right config,
     or re-run with SKIP_NGINX=1 and route $DOMAIN to 127.0.0.1:4000 (API, /u/, /t/), :8000 (/analyzer/) and $APP_DIR/web/dist yourself."
  fi
  command -v nginx >/dev/null || apt-get install -y -qq nginx >/dev/null
  command -v certbot >/dev/null || apt-get install -y -qq certbot python3-certbot-nginx >/dev/null

  site=/etc/nginx/sites-available/leadgen
  sed -e "s|leadgen.example.com|$DOMAIN|g" -e "s|/var/www/ai-leadgen|$APP_DIR|g" "$APP_DIR/deploy/nginx-leadgen.conf" > "$site"
  ln -sf "$site" /etc/nginx/sites-enabled/leadgen
  # Nginx needs to read web/dist
  d="$APP_DIR"; while [[ $d != / ]]; do chmod o+x "$d" 2>/dev/null || true; d=$(dirname "$d"); done
  nginx -t -q && systemctl reload nginx
  ok "Nginx site for $DOMAIN"

  if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
    ufw allow 'Nginx Full' >/dev/null && ok "UFW allows 80/443"
  fi

  server_ip=$(curl -fsS4 https://api.ipify.org 2>/dev/null || true)
  dns_ip=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
  ip_label=${server_ip:-"(this server's public IP)"}
  if [[ -z $dns_ip ]]; then
    warn "DNS for $DOMAIN does not resolve yet. Add an A record pointing to $ip_label, then run: certbot --nginx -d $DOMAIN"
  elif [[ -n $server_ip && $dns_ip != "$server_ip" ]]; then
    warn "$DOMAIN points to $dns_ip but this server is $server_ip. Fix the A record, then run: certbot --nginx -d $DOMAIN"
  elif [[ -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --reinstall --redirect >/dev/null 2>&1 || true
    ok "HTTPS certificate already present"
  else
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$CERT_EMAIL" --redirect >/dev/null && ok "HTTPS certificate issued"
  fi
  sleep 1
  pub=$(curl -fsS "https://$DOMAIN/api/health" 2>/dev/null || true)
  [[ $pub == *'"ok":true'* ]] && ok "public health check: https://$DOMAIN/api/health" || warn "https://$DOMAIN/api/health not reachable yet (DNS/TLS pending)"
fi

# ---------------------------------------------------------------- 6. what to paste into n8n
step "Next: n8n credentials (n8n.dealpost.co.in → Credentials → Add)"
cat <<EOF
  1. Header Auth  "LeadGen Webhook Auth"
       Name:  X-LeadGen-Key
       Value: $(env_get "$S" N8N_WEBHOOK_SECRET)
  2. Header Auth  "LeadGen Analyzer Token"
       Name:  Authorization
       Value: Bearer $(env_get "$S" ANALYZER_TOKEN)
  3. Header Auth  "Google Places API Key"
       Name:  X-Goog-Api-Key
       Value: <your Google Cloud key with Places API (New) enabled>
  4. Gmail OAuth2 "Gmail (outreach sender)"  → sign in with the sending mailbox

  Then open each "AI LeadGen" workflow, pick these credentials on the nodes marked with a warning, and publish.
  Sign up at $BASE with $(env_get "$S" PLATFORM_ADMIN_EMAILS | cut -d, -f1) to get the admin dashboard.
EOF
printf '\n%sDone.%s Logs: pm2 logs   Re-run this script after every code update.\n' "$c_ok" "$c_0"
