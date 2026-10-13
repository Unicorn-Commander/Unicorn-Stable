#!/usr/bin/env bash
# =============================================================================
# Unicorn Stable — self-host installer
# =============================================================================
# Brings up the full Stable stack (Postgres, Redis, LiveKit, backend, web, and
# by default a bundled Keycloak) from a fresh clone, on one machine, using
# docker-compose.selfhost.yml. Interactive on a terminal, fully scriptable via
# flags / environment variables for CI.
#
#   ./install.sh                  # interactive
#   ./install.sh --yes            # accept defaults, no prompts
#   ./install.sh --yes --host example.com --web-port 9401 --project mystable
#   ./install.sh --env-only       # write .env + rendered configs, don't start
#
# Idempotent: re-running preserves every secret already in .env, re-renders the
# derived config files, and re-runs `docker compose up -d` (a no-op when
# nothing changed).
#
# Requirements: bash, coreutils, docker with the compose plugin. openssl and
# curl are used when present; /dev/urandom and bash /dev/tcp are the fallbacks.
#
# IMPORTANT — auth is Keycloak OIDC and is NOT optional. There is no local
# username/password mode in Stable. This installer either provisions a bundled
# Keycloak (default; realm + clients + first admin user imported for you) or
# wires the stack to a Keycloak you already operate (--no-keycloak plus the
# --keycloak-* flags). See DEPLOYMENT.md for the manual realm/client recipe.
# =============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.selfhost.yml"
ENV_FILE="$ROOT/.env"
ENV_MARKER="# Managed by install.sh (Unicorn Stable self-host)"
SELFHOST_DIR="$ROOT/deploy/selfhost"

# ----------------------------------------------------------------------------
# Output helpers
# ----------------------------------------------------------------------------
if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_OFF=$'\033[0m'
else
  C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_OFF=""
fi
say()  { printf '%s\n' "${C_GREEN}▸${C_OFF} $*"; }
note() { printf '%s\n' "  $*"; }
warn() { printf '%s\n' "${C_YELLOW}⚠${C_OFF} $*" >&2; }
die()  { printf '%s\n' "${C_RED}✗ $*${C_OFF}" >&2; exit 1; }

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'
Flags (each also honours the environment variable in brackets):
  --host ADDR                Address browsers AND containers will use to reach
                             this machine — a LAN IP or DNS name, not
                             "localhost" [STABLE_HOST; default: auto-detected]
  --project NAME             docker compose project name [STABLE_PROJECT]
  --web-port N               Web UI port                [STABLE_WEB_PORT=8401]
  --backend-port N           Backend port (loopback)    [STABLE_BACKEND_PORT=8400]
  --livekit-ws-port N        LiveKit signaling          [STABLE_LIVEKIT_WS_PORT=7880]
  --livekit-tcp-port N       LiveKit TCP media          [STABLE_LIVEKIT_TCP_PORT=7881]
  --livekit-udp-port N       LiveKit UDP media          [STABLE_LIVEKIT_UDP_PORT=7882]
  --postgres-port N          Postgres port (loopback)   [STABLE_POSTGRES_PORT=5433]
  --redis-port N             Redis port (loopback)      [STABLE_REDIS_PORT=6381]
  --admin-user NAME          First Stable user          [STABLE_ADMIN_USER=admin]
  --admin-email EMAIL        First user's email         [STABLE_ADMIN_EMAIL]
  --with-agents              Enable the optional agent runtime [STABLE_WITH_AGENTS=1]
  --no-keycloak              Do NOT run the bundled Keycloak; use an external
                             one via the flags below [STABLE_BUNDLED_KEYCLOAK=0]
  --keycloak-url URL         External Keycloak base URL       [KEYCLOAK_URL]
  --keycloak-realm NAME      Realm                            [KEYCLOAK_REALM=stable]
  --keycloak-web-client-id   Public (browser) client id       [KEYCLOAK_WEB_CLIENT_ID=stable-web]
  --keycloak-client-id       Backend client id                [KEYCLOAK_CLIENT_ID=stable-backend]
  --keycloak-client-secret   Backend client secret            [KEYCLOAK_CLIENT_SECRET]
  --env-only                 Generate .env + configs, skip docker compose up
  --force-env                Overwrite a .env this installer did not create
  --skip-port-check          Skip the TCP port availability probe
  --yes, -y                  Non-interactive; accept defaults
  --help, -h                 This help
EOF
}

# ----------------------------------------------------------------------------
# Small utilities (openssl/curl preferred, portable fallbacks otherwise)
# ----------------------------------------------------------------------------
rand_hex() { # rand_hex <bytes>
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

rand_alnum() { # rand_alnum <chars> — human-typable secret
  LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c "$1" || true
  printf ''
}

port_busy() { # port_busy <port> — 0 when something listens on 127.0.0.1:<port>
  local p="$1"
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    exec 3>&- 3<&- 2>/dev/null || true
    return 0
  fi
  return 1
}

http_status() { # http_status <url> — prints the status code, 000 on failure
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null -m 10 -w '%{http_code}' "$url" 2>/dev/null || printf '000'
    return 0
  fi
  # bash-only fallback (http:// URLs, host:port/path)
  local rest="${url#http://}" hostport path line
  hostport="${rest%%/*}"; path="/${rest#*/}"; [ "$path" = "/$rest" ] && path="/"
  local host="${hostport%%:*}" port="${hostport##*:}"
  [ "$host" = "$port" ] && port=80
  if ! exec 3<>"/dev/tcp/$host/$port" 2>/dev/null; then printf '000'; return 0; fi
  printf 'GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n' "$path" "$host" >&3
  IFS= read -r line <&3 || true
  exec 3>&- 3<&- 2>/dev/null || true
  if [[ $line =~ HTTP/[0-9.]+\ ([0-9]{3}) ]]; then printf '%s' "${BASH_REMATCH[1]}"; else printf '000'; fi
}

wait_for() { # wait_for <label> <url> <timeout_s> [<accept_regex>]
  local label="$1" url="$2" timeout="$3" accept="${4:-200}" waited=0 code
  printf '  waiting for %s ' "$label"
  while :; do
    code="$(http_status "$url")"
    if [[ $code =~ ^($accept)$ ]]; then printf '%s\n' " ${C_GREEN}ok${C_OFF} (HTTP $code, ${waited}s)"; return 0; fi
    if [ "$waited" -ge "$timeout" ]; then
      printf '\n'
      warn "$label not ready after ${timeout}s (last HTTP status: $code, url: $url)"
      return 1
    fi
    printf '.'
    sleep 3; waited=$((waited + 3))
  done
}

env_get() { # env_get <key> — read a value from the existing .env (last wins)
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

keep_or() { # keep_or <key> <fresh-value> — prefer the value already in .env
  local existing
  existing="$(env_get "$1")"
  if [ -n "$existing" ]; then printf '%s' "$existing"; else printf '%s' "$2"; fi
}

detect_host() {
  local ip=""
  case "$(uname -s)" in
    Darwin)
      ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
      [ -n "$ip" ] || ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
      ;;
    *)
      ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
      [ -n "$ip" ] || ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src") print $(i+1); exit}' || true)"
      ;;
  esac
  printf '%s' "$ip"
}

prompt() { # prompt <question> <default> -> REPLY
  local q="$1" d="$2"
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then REPLY="$d"; return 0; fi
  read -r -p "$q [$d]: " REPLY
  [ -n "$REPLY" ] || REPLY="$d"
}

prompt_yn() { # prompt_yn <question> <Y|N default> -> 0=yes 1=no
  local q="$1" d="$2" a
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then a="$d"; else read -r -p "$q [$d]: " a; [ -n "$a" ] || a="$d"; fi
  case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ----------------------------------------------------------------------------
# Defaults (env overrides), then flag parsing (flags win)
# ----------------------------------------------------------------------------
STABLE_HOST="${STABLE_HOST:-}"
PROJECT="${STABLE_PROJECT:-stable-selfhost}"
WEB_PORT="${STABLE_WEB_PORT:-8401}"
BACKEND_PORT="${STABLE_BACKEND_PORT:-8400}"
LK_WS_PORT="${STABLE_LIVEKIT_WS_PORT:-7880}"
LK_TCP_PORT="${STABLE_LIVEKIT_TCP_PORT:-7881}"
LK_UDP_PORT="${STABLE_LIVEKIT_UDP_PORT:-7882}"
PG_PORT="${STABLE_POSTGRES_PORT:-5433}"
REDIS_PORT="${STABLE_REDIS_PORT:-6381}"
ADMIN_USER="${STABLE_ADMIN_USER:-admin}"
ADMIN_EMAIL="${STABLE_ADMIN_EMAIL:-}"
WITH_AGENTS="${STABLE_WITH_AGENTS:-0}"
BUNDLED_KEYCLOAK="${STABLE_BUNDLED_KEYCLOAK:-1}"
EXT_KEYCLOAK_URL="${KEYCLOAK_URL:-}"
KEYCLOAK_REALM_IN="${KEYCLOAK_REALM:-stable}"
KEYCLOAK_WEB_CLIENT_ID="${KEYCLOAK_WEB_CLIENT_ID:-stable-web}"
KEYCLOAK_CLIENT_ID_IN="${KEYCLOAK_CLIENT_ID:-stable-backend}"
KEYCLOAK_CLIENT_SECRET_IN="${KEYCLOAK_CLIENT_SECRET:-}"
ENV_ONLY=0
FORCE_ENV="${STABLE_FORCE_ENV:-0}"
SKIP_PORT_CHECK=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host)                 STABLE_HOST="$2"; shift 2 ;;
    --project)              PROJECT="$2"; shift 2 ;;
    --web-port)             WEB_PORT="$2"; shift 2 ;;
    --backend-port)         BACKEND_PORT="$2"; shift 2 ;;
    --livekit-ws-port)      LK_WS_PORT="$2"; shift 2 ;;
    --livekit-tcp-port)     LK_TCP_PORT="$2"; shift 2 ;;
    --livekit-udp-port)     LK_UDP_PORT="$2"; shift 2 ;;
    --postgres-port)        PG_PORT="$2"; shift 2 ;;
    --redis-port)           REDIS_PORT="$2"; shift 2 ;;
    --admin-user)           ADMIN_USER="$2"; shift 2 ;;
    --admin-email)          ADMIN_EMAIL="$2"; shift 2 ;;
    --with-agents)          WITH_AGENTS=1; shift ;;
    --no-keycloak)          BUNDLED_KEYCLOAK=0; shift ;;
    --keycloak-url)         EXT_KEYCLOAK_URL="$2"; shift 2 ;;
    --keycloak-realm)       KEYCLOAK_REALM_IN="$2"; shift 2 ;;
    --keycloak-web-client-id) KEYCLOAK_WEB_CLIENT_ID="$2"; shift 2 ;;
    --keycloak-client-id)   KEYCLOAK_CLIENT_ID_IN="$2"; shift 2 ;;
    --keycloak-client-secret) KEYCLOAK_CLIENT_SECRET_IN="$2"; shift 2 ;;
    --env-only)             ENV_ONLY=1; shift ;;
    --force-env)            FORCE_ENV=1; shift ;;
    --skip-port-check)      SKIP_PORT_CHECK=1; shift ;;
    --yes|-y)               ASSUME_YES=1; shift ;;
    --help|-h)              usage; exit 0 ;;
    *) die "Unknown flag: $1 (see --help)" ;;
  esac
done

for p in "$WEB_PORT" "$BACKEND_PORT" "$LK_WS_PORT" "$LK_TCP_PORT" "$LK_UDP_PORT" "$PG_PORT" "$REDIS_PORT"; do
  case "$p" in (*[!0-9]*|'') die "Port values must be numeric (got: '$p')";; esac
done

# ----------------------------------------------------------------------------
# Prerequisites
# ----------------------------------------------------------------------------
say "Checking prerequisites"
command -v docker >/dev/null 2>&1 || die "docker is not installed (https://docs.docker.com/engine/install/)"
docker info >/dev/null 2>&1 || die "The docker daemon is not running (or you lack permission to talk to it)"
docker compose version >/dev/null 2>&1 || die "The docker compose PLUGIN (v2) is required: 'docker compose version' failed"
[ -f "$COMPOSE_FILE" ] || die "docker-compose.selfhost.yml not found next to install.sh — run from a full clone"
command -v openssl >/dev/null 2>&1 || warn "openssl not found — falling back to /dev/urandom for secret generation"
note "docker $(docker info --format '{{.ServerVersion}}' 2>/dev/null || echo '?') / $(docker compose version --short 2>/dev/null || echo compose)"

# ----------------------------------------------------------------------------
# Interactive decisions
# ----------------------------------------------------------------------------
if [ -z "$STABLE_HOST" ]; then
  STABLE_HOST="$(keep_or STABLE_HOST "$(detect_host)")"
fi
prompt "Address browsers will use to reach this machine (LAN IP or DNS name)" "${STABLE_HOST:-localhost}"
STABLE_HOST="$REPLY"
[ -n "$STABLE_HOST" ] || die "A host address is required (--host)"

if [ "$BUNDLED_KEYCLOAK" = "1" ] && { [ "$STABLE_HOST" = "localhost" ] || [ "$STABLE_HOST" = "127.0.0.1" ]; }; then
  if [ "${STABLE_ALLOW_LOCALHOST:-0}" != "1" ]; then
    die "STABLE_HOST=localhost cannot work with the bundled Keycloak: the backend \
container must reach the Keycloak URL, and 'localhost' inside a container is the \
container itself. Use the host name or address reachable by your browser (e.g. --host example.com), \
or set STABLE_ALLOW_LOCALHOST=1 if you really know better."
  fi
  warn "Proceeding with localhost — backend JWKS fetch will likely fail (STABLE_ALLOW_LOCALHOST=1)"
fi

if [ "$BUNDLED_KEYCLOAK" = "1" ]; then
  if ! prompt_yn "Run the bundled Keycloak identity provider? (Stable requires Keycloak; answering 'n' means you must point me at yours)" "Y"; then
    BUNDLED_KEYCLOAK=0
  fi
fi
if [ "$BUNDLED_KEYCLOAK" = "0" ]; then
  if [ -z "$EXT_KEYCLOAK_URL" ]; then
    prompt "External Keycloak base URL (must be reachable from browsers AND from the backend container, e.g. https://auth.example.com)" ""
    EXT_KEYCLOAK_URL="$REPLY"
  fi
  [ -n "$EXT_KEYCLOAK_URL" ] || die "--no-keycloak requires --keycloak-url (Stable cannot run without an OIDC provider)"
fi

if [ "$WITH_AGENTS" != "1" ]; then
  if prompt_yn "Enable the optional AI agent runtime? (needs model provider keys; can be enabled later)" "N"; then
    WITH_AGENTS=1
  fi
fi

prompt "First Stable user (created in the bundled realm)" "$ADMIN_USER"
ADMIN_USER="$REPLY"
[ -n "$ADMIN_EMAIL" ] || ADMIN_EMAIL="$(keep_or STABLE_ADMIN_EMAIL "${ADMIN_USER}@stable.local")"
prompt "Email for that user" "$ADMIN_EMAIL"
ADMIN_EMAIL="$REPLY"

# ----------------------------------------------------------------------------
# Port availability (skipped when this project already has containers)
# ----------------------------------------------------------------------------
existing_containers="$(docker compose -f "$COMPOSE_FILE" -p "$PROJECT" ps -q 2>/dev/null || true)"
if [ "$SKIP_PORT_CHECK" != "1" ] && [ -z "$existing_containers" ]; then
  say "Checking port availability"
  busy=""
  for spec in "web:$WEB_PORT" "backend:$BACKEND_PORT" "livekit-ws:$LK_WS_PORT" "livekit-tcp:$LK_TCP_PORT" "postgres:$PG_PORT" "redis:$REDIS_PORT"; do
    if port_busy "${spec#*:}"; then busy="$busy $spec"; fi
  done
  if [ -n "$busy" ]; then
    die "These TCP ports are already in use:$busy — remap with the --*-port flags (see --help)"
  fi
  note "ports free: web=$WEB_PORT backend=$BACKEND_PORT livekit=$LK_WS_PORT/$LK_TCP_PORT/$LK_UDP_PORT pg=$PG_PORT redis=$REDIS_PORT"
elif [ -n "$existing_containers" ]; then
  note "existing '$PROJECT' containers found — skipping port probe (re-run)"
fi

# ----------------------------------------------------------------------------
# .env generation (secrets preserved across re-runs)
# ----------------------------------------------------------------------------
if [ -f "$ENV_FILE" ] && ! head -1 "$ENV_FILE" | grep -qF "$ENV_MARKER"; then
  if [ "$FORCE_ENV" != "1" ]; then
    die ".env exists but was not created by this installer — refusing to overwrite. \
If this machine runs the operator stack (docker-compose.yml), do NOT run install.sh here. \
Otherwise re-run with --force-env (the old file is backed up first)."
  fi
fi
if [ -f "$ENV_FILE" ]; then
  backup="$ENV_FILE.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$ENV_FILE" "$backup"
  note "backed up existing .env → ${backup#"$ROOT"/}"
fi

say "Generating .env (existing secrets are preserved)"
POSTGRES_PASSWORD="$(keep_or POSTGRES_PASSWORD "$(rand_hex 24)")"
REDIS_PASSWORD="$(keep_or REDIS_PASSWORD "$(rand_hex 24)")"
LIVEKIT_API_KEY="$(keep_or LIVEKIT_API_KEY "LK$(rand_hex 6)")"
LIVEKIT_API_SECRET="$(keep_or LIVEKIT_API_SECRET "$(rand_hex 32)")"
INTERNAL_AGENT_SECRET="$(keep_or INTERNAL_AGENT_SECRET "$(rand_hex 32)")"
GATEWAY_KEY_ADMIN_SECRET="$(keep_or GATEWAY_KEY_ADMIN_SECRET "$(rand_hex 32)")"
UPLOAD_URL_SECRET="$(keep_or UPLOAD_URL_SECRET "$(rand_hex 32)")"
KEYCLOAK_DB_PASSWORD="$(keep_or KEYCLOAK_DB_PASSWORD "$(rand_hex 24)")"
KEYCLOAK_ADMIN_USER="$(keep_or KEYCLOAK_ADMIN_USER "kcadmin")"
KEYCLOAK_ADMIN_PASSWORD="$(keep_or KEYCLOAK_ADMIN_PASSWORD "$(rand_alnum 20)")"
STABLE_ADMIN_PASSWORD="$(keep_or STABLE_ADMIN_PASSWORD "$(rand_alnum 16)")"
if [ "$BUNDLED_KEYCLOAK" = "1" ]; then
  KEYCLOAK_URL_OUT="http://$STABLE_HOST:$WEB_PORT/auth"
  KEYCLOAK_CLIENT_SECRET_OUT="$(keep_or KEYCLOAK_CLIENT_SECRET "$(rand_hex 24)")"
else
  KEYCLOAK_URL_OUT="$EXT_KEYCLOAK_URL"
  KEYCLOAK_CLIENT_SECRET_OUT="${KEYCLOAK_CLIENT_SECRET_IN:-$(keep_or KEYCLOAK_CLIENT_SECRET "")}"
fi

PREVIOUS_HOST="$(env_get STABLE_HOST)"
WEB_ORIGIN="http://$STABLE_HOST:$WEB_PORT"
GIT_SHA="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
GIT_SHA_FULL="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

PROFILES=""
[ "$BUNDLED_KEYCLOAK" = "1" ] && PROFILES="keycloak"
if [ "$WITH_AGENTS" = "1" ]; then PROFILES="${PROFILES:+$PROFILES,}agents"; fi

# Optional integrations: carry existing values forward so re-runs never lose
# manual edits made below the marker line.
BRIGADE_BASE_URL_OUT="$(env_get BRIGADE_BASE_URL)"
BRIGADE_API_BASE_URL_OUT="$(env_get BRIGADE_API_BASE_URL)"
BRIGADE_AVATAR_BASE_URL_OUT="$(env_get BRIGADE_AVATAR_BASE_URL)"
BRIGADE_API_KEY_OUT="$(env_get BRIGADE_API_KEY)"
TRUSTED_ISSUER_HOSTS_OUT="$(env_get TRUSTED_ISSUER_HOSTS)"
KOKORO_BASE_URL_OUT="$(env_get KOKORO_BASE_URL)"
WHISPER_BASE_URL_OUT="$(env_get WHISPER_BASE_URL)"
STABLE_CSP_EXTRA_SCRIPT_OUT="$(env_get STABLE_CSP_EXTRA_SCRIPT)"
STABLE_CSP_EXTRA_FRAME_OUT="$(env_get STABLE_CSP_EXTRA_FRAME)"
STABLE_ANALYTICS_SCRIPT_URL_OUT="$(env_get STABLE_ANALYTICS_SCRIPT_URL)"
STABLE_ANALYTICS_WEBSITE_ID_OUT="$(env_get STABLE_ANALYTICS_WEBSITE_ID)"
STABLE_APP_URL_OUT="$(env_get STABLE_APP_URL)"
STABLE_MARKETING_BASE_URL_OUT="$(env_get STABLE_MARKETING_BASE_URL)"
STABLE_CONTACT_EMAIL_OUT="$(env_get STABLE_CONTACT_EMAIL)"
STABLE_SOURCE_URL_OUT="$(env_get STABLE_SOURCE_URL)"
ANTHROPIC_API_KEY_OUT="$(env_get ANTHROPIC_API_KEY)"
OPENAI_API_KEY_OUT="$(env_get OPENAI_API_KEY)"
OPENROUTER_API_KEY_OUT="$(env_get OPENROUTER_API_KEY)"
SENTRY_DSN_OUT="$(env_get SENTRY_DSN)"

cat > "$ENV_FILE" <<EOF
$ENV_MARKER
# Generated: $BUILD_TIME   (re-running install.sh preserves the secrets below)
# Reference for every variable: .env.example

# --- topology ---------------------------------------------------------------
STABLE_HOST=$STABLE_HOST
STABLE_PROJECT=$PROJECT
STABLE_WEB_PORT=$WEB_PORT
STABLE_BACKEND_PORT=$BACKEND_PORT
STABLE_LIVEKIT_WS_PORT=$LK_WS_PORT
STABLE_LIVEKIT_TCP_PORT=$LK_TCP_PORT
STABLE_LIVEKIT_UDP_PORT=$LK_UDP_PORT
STABLE_POSTGRES_PORT=$PG_PORT
STABLE_REDIS_PORT=$REDIS_PORT
COMPOSE_PROFILES=$PROFILES

# --- generated secrets (KEEP THIS FILE PRIVATE; chmod 600) ------------------
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
REDIS_PASSWORD=$REDIS_PASSWORD
LIVEKIT_API_KEY=$LIVEKIT_API_KEY
LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET
INTERNAL_AGENT_SECRET=$INTERNAL_AGENT_SECRET
GATEWAY_KEY_ADMIN_SECRET=$GATEWAY_KEY_ADMIN_SECRET
UPLOAD_URL_SECRET=$UPLOAD_URL_SECRET

# --- identity (Keycloak OIDC — REQUIRED) ------------------------------------
KEYCLOAK_URL=$KEYCLOAK_URL_OUT
KEYCLOAK_REALM=$KEYCLOAK_REALM_IN
TRUSTED_ISSUER_HOSTS=$TRUSTED_ISSUER_HOSTS_OUT
KEYCLOAK_CLIENT_ID=$KEYCLOAK_CLIENT_ID_IN
KEYCLOAK_CLIENT_SECRET=$KEYCLOAK_CLIENT_SECRET_OUT
# Realm search is correct here: this install's Keycloak realm belongs to the installing organization.
USER_SEARCH_SCOPE=realm
KEYCLOAK_WEB_CLIENT_ID=$KEYCLOAK_WEB_CLIENT_ID
KEYCLOAK_DB_PASSWORD=$KEYCLOAK_DB_PASSWORD
KEYCLOAK_ADMIN_USER=$KEYCLOAK_ADMIN_USER
KEYCLOAK_ADMIN_PASSWORD=$KEYCLOAK_ADMIN_PASSWORD
STABLE_ADMIN_USER=$ADMIN_USER
STABLE_ADMIN_EMAIL=$ADMIN_EMAIL
STABLE_ADMIN_PASSWORD=$STABLE_ADMIN_PASSWORD

# --- derived URLs -----------------------------------------------------------
PUBLIC_BASE_URL=$WEB_ORIGIN
CORS_ORIGINS=$WEB_ORIGIN
LIVEKIT_PUBLIC_URL=ws://$STABLE_HOST:$LK_WS_PORT
STABLE_CSP_EXTRA_CONNECT=ws://$STABLE_HOST:$LK_WS_PORT http://$STABLE_HOST:$LK_WS_PORT
STABLE_CSP_EXTRA_SCRIPT=$STABLE_CSP_EXTRA_SCRIPT_OUT
STABLE_CSP_EXTRA_FRAME=$STABLE_CSP_EXTRA_FRAME_OUT
STABLE_KEYCLOAK_UPSTREAM=keycloak:8080

# --- build provenance -------------------------------------------------------
STABLE_GIT_SHA=$GIT_SHA
STABLE_GIT_SHA_FULL=$GIT_SHA_FULL
STABLE_BUILD_TIME=$BUILD_TIME

# --- optional integrations (empty = feature off / degrades gracefully) ------
BRIGADE_BASE_URL=$BRIGADE_BASE_URL_OUT
BRIGADE_API_BASE_URL=$BRIGADE_API_BASE_URL_OUT
BRIGADE_AVATAR_BASE_URL=$BRIGADE_AVATAR_BASE_URL_OUT
BRIGADE_API_KEY=$BRIGADE_API_KEY_OUT
KOKORO_BASE_URL=$KOKORO_BASE_URL_OUT
WHISPER_BASE_URL=$WHISPER_BASE_URL_OUT
STABLE_ANALYTICS_SCRIPT_URL=$STABLE_ANALYTICS_SCRIPT_URL_OUT
STABLE_ANALYTICS_WEBSITE_ID=$STABLE_ANALYTICS_WEBSITE_ID_OUT
STABLE_APP_URL=$STABLE_APP_URL_OUT
STABLE_MARKETING_BASE_URL=$STABLE_MARKETING_BASE_URL_OUT
STABLE_CONTACT_EMAIL=$STABLE_CONTACT_EMAIL_OUT
STABLE_SOURCE_URL=$STABLE_SOURCE_URL_OUT
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY_OUT
OPENAI_API_KEY=$OPENAI_API_KEY_OUT
OPENROUTER_API_KEY=$OPENROUTER_API_KEY_OUT
SENTRY_DSN=$SENTRY_DSN_OUT
EOF
chmod 600 "$ENV_FILE"
note "wrote .env (chmod 600)"

# ----------------------------------------------------------------------------
# Rendered configuration files
# ----------------------------------------------------------------------------
say "Rendering configuration"

# LiveKit — all substituted values are [A-Za-z0-9.:-], safe for sed with |
sed -e "s|__LK_WS_PORT__|$LK_WS_PORT|g" \
    -e "s|__LK_TCP_PORT__|$LK_TCP_PORT|g" \
    -e "s|__LK_UDP_PORT__|$LK_UDP_PORT|g" \
    -e "s|__STABLE_HOST__|$STABLE_HOST|g" \
    -e "s|__REDIS_PASSWORD__|$REDIS_PASSWORD|g" \
    -e "s|__LIVEKIT_API_KEY__|$LIVEKIT_API_KEY|g" \
    -e "s|__LIVEKIT_API_SECRET__|$LIVEKIT_API_SECRET|g" \
    "$SELFHOST_DIR/livekit.selfhost.yaml.template" > "$SELFHOST_DIR/livekit.yaml"
note "deploy/selfhost/livekit.yaml"

# Instance descriptor — how the SPA learns its API + Keycloak at runtime
cat > "$SELFHOST_DIR/instances.json" <<EOF
[
  {
    "id": "home",
    "name": "Stable",
    "icon": "S",
    "webOrigin": "$WEB_ORIGIN",
    "apiBaseUrl": "$WEB_ORIGIN",
    "trustedOrigins": "$BRIGADE_AVATAR_BASE_URL_OUT",
    "analyticsScriptUrl": "$STABLE_ANALYTICS_SCRIPT_URL_OUT",
    "analyticsWebsiteId": "$STABLE_ANALYTICS_WEBSITE_ID_OUT",
    "appUrl": "$STABLE_APP_URL_OUT",
    "marketingBaseUrl": "$STABLE_MARKETING_BASE_URL_OUT",
    "contactEmail": "$STABLE_CONTACT_EMAIL_OUT",
    "sourceUrl": "$STABLE_SOURCE_URL_OUT",
    "keycloak": {
      "url": "$KEYCLOAK_URL_OUT",
      "realm": "$KEYCLOAK_REALM_IN",
      "clientId": "$KEYCLOAK_WEB_CLIENT_ID"
    }
  }
]
EOF
note "deploy/selfhost/instances.json"

# Keycloak realm import (bundled mode)
if [ "$BUNDLED_KEYCLOAK" = "1" ]; then
  mkdir -p "$SELFHOST_DIR/keycloak-import"
  sed -e "s|__KEYCLOAK_REALM__|$KEYCLOAK_REALM_IN|g" \
      -e "s|__WEB_ORIGIN__|$WEB_ORIGIN|g" \
      -e "s|__BACKEND_CLIENT_SECRET__|$KEYCLOAK_CLIENT_SECRET_OUT|g" \
      -e "s|__ADMIN_USERNAME__|$ADMIN_USER|g" \
      -e "s|__ADMIN_EMAIL__|$ADMIN_EMAIL|g" \
      -e "s|__ADMIN_PASSWORD__|$STABLE_ADMIN_PASSWORD|g" \
      "$SELFHOST_DIR/keycloak-realm.template.json" > "$SELFHOST_DIR/keycloak-import/stable-realm.json"
  chmod 600 "$SELFHOST_DIR/keycloak-import/stable-realm.json"
  note "deploy/selfhost/keycloak-import/stable-realm.json"
  if [ -n "$PREVIOUS_HOST" ] && [ "$PREVIOUS_HOST" != "$STABLE_HOST" ]; then
    warn "STABLE_HOST changed ($PREVIOUS_HOST → $STABLE_HOST). Keycloak SKIPS import for an existing realm,"
    warn "so update the '$KEYCLOAK_WEB_CLIENT_ID' client redirect URIs/web origins in the admin console,"
    warn "or wipe the stack (docker compose -p $PROJECT down -v) for a clean re-import."
  fi
fi

if [ "$ENV_ONLY" = "1" ]; then
  say "--env-only: configuration written. Start later with:"
  note "docker compose -f docker-compose.selfhost.yml -p $PROJECT up -d --build"
  exit 0
fi

# ----------------------------------------------------------------------------
# Bring the stack up
# ----------------------------------------------------------------------------
# Make the generated .env AUTHORITATIVE for compose interpolation. docker
# compose prefers the caller's OS environment over --env-file, so a var the
# user's shell happens to export (BRIGADE_API_KEY, OPENAI_API_KEY, …) would
# silently override what we just wrote — the running containers and the .env
# on disk would disagree. Exporting every pair from the file closes that gap.
# (Parsed line-by-line, not `source`d: values may contain spaces.)
while IFS= read -r _line; do
  case "$_line" in
    [A-Za-z_]*=*) export "${_line%%=*}=${_line#*=}" ;;
  esac
done < "$ENV_FILE"
compose() { docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
export COMPOSE_PROFILES="$PROFILES"

say "Starting postgres first (the bundled Keycloak needs its database)"
compose up -d postgres
printf '  waiting for postgres '
waited=0
until compose exec -T postgres pg_isready -U stable -d stable >/dev/null 2>&1; do
  [ "$waited" -ge 120 ] && { printf '\n'; die "postgres did not become ready in 120s (docker compose -p $PROJECT logs postgres)"; }
  printf '.'; sleep 3; waited=$((waited + 3))
done
printf ' %s\n' "${C_GREEN}ok${C_OFF}"

if [ "$BUNDLED_KEYCLOAK" = "1" ]; then
  say "Ensuring the Keycloak database exists"
  compose exec -T postgres psql -U stable -d stable -v ON_ERROR_STOP=1 -q \
    -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='keycloak') THEN CREATE ROLE keycloak LOGIN; END IF; END \$\$;" \
    -c "ALTER ROLE keycloak WITH LOGIN PASSWORD '$KEYCLOAK_DB_PASSWORD';"
  if ! compose exec -T postgres psql -U stable -d stable -tAc "SELECT 1 FROM pg_database WHERE datname='keycloak'" | grep -q 1; then
    compose exec -T postgres psql -U stable -d stable -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE keycloak OWNER keycloak;"
  fi
  note "database 'keycloak' ready"
fi

say "Building images and starting the stack (first build takes a few minutes)"
compose up -d --build

# ----------------------------------------------------------------------------
# Health gates
# ----------------------------------------------------------------------------
say "Waiting for services"
wait_for "backend liveness (/live)" "http://127.0.0.1:$BACKEND_PORT/live" 240 \
  || die "Backend never became live — docker compose -p $PROJECT logs backend"

if [ "$BUNDLED_KEYCLOAK" = "1" ]; then
  wait_for "Keycloak realm '$KEYCLOAK_REALM_IN' (through the web proxy)" \
    "http://127.0.0.1:$WEB_PORT/auth/realms/$KEYCLOAK_REALM_IN/.well-known/openid-configuration" 420 \
    || die "Keycloak realm not reachable — docker compose -p $PROJECT logs keycloak web"
fi

if ! wait_for "backend readiness (/health — needs DB, Redis, LiveKit AND Keycloak JWKS)" \
    "http://127.0.0.1:$BACKEND_PORT/health" 420; then
  warn "The backend retries the Keycloak JWKS fetch every 60s; if this keeps failing, check that"
  warn "  1) $KEYCLOAK_URL_OUT is reachable FROM INSIDE a container:"
  warn "     docker compose -p $PROJECT exec backend curl -s $KEYCLOAK_URL_OUT/realms/$KEYCLOAK_REALM_IN/.well-known/openid-configuration"
  warn "  2) no firewall blocks containers from reaching $STABLE_HOST:$WEB_PORT (the 'hairpin' path)"
  die "Backend readiness failed — docker compose -p $PROJECT logs backend"
fi

wait_for "web client" "http://127.0.0.1:$WEB_PORT/" 120 \
  || die "Web client not serving — docker compose -p $PROJECT logs web"

# ----------------------------------------------------------------------------
# Done
# ----------------------------------------------------------------------------
printf '\n'
printf '%s\n' "${C_BOLD}${C_GREEN}Unicorn Stable is up.${C_OFF}"
printf '\n'
printf '%s\n' "  ${C_BOLD}Open:${C_OFF}      $WEB_ORIGIN"
if [ "$BUNDLED_KEYCLOAK" = "1" ]; then
  printf '%s\n' "  ${C_BOLD}Sign in:${C_OFF}   $ADMIN_USER / $STABLE_ADMIN_PASSWORD"
  printf '%s\n' "  ${C_BOLD}Keycloak:${C_OFF}  $WEB_ORIGIN/auth/admin/  ($KEYCLOAK_ADMIN_USER / $KEYCLOAK_ADMIN_PASSWORD)"
  printf '%s\n' "             → add users: realm '$KEYCLOAK_REALM_IN' → Users → Add user (set a password under Credentials)"
fi
printf '\n'
printf '%s\n' "  Use $WEB_ORIGIN exactly as printed — the OIDC issuer and CSP are bound to it."
printf '%s\n' "  Credentials + secrets live in .env (kept out of git; back it up somewhere safe)."
printf '\n'
printf '%s\n' "  Next steps:"
printf '%s\n' "    • TLS + a real domain, backups, upgrades:   DEPLOYMENT.md"
printf '%s\n' "    • Voice (TTS/STT), agents, RAG, Brigade:    .env.example (optional sections)"
printf '%s\n' "    • Stop:            docker compose -p $PROJECT down"
printf '%s\n' "    • Stop + wipe:     docker compose -p $PROJECT down -v"
printf '%s\n' "    • Logs:            docker compose -p $PROJECT logs -f backend"
printf '\n'
