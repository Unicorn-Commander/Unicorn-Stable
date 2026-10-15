#!/usr/bin/env bash
# Unicorn Stable — provision a per-org instance (offering C: one stack per org).
#
# Generates an isolated stack (own DB/redis/livekit/backend/agents/web, own
# secrets, own org UUID, own domains + LiveKit media-port block) from the
# canonical base compose. Inherits every hardening default from the base.
#
# This script does the DETERMINISTIC, SAFE parts (secrets, port allocation,
# artifact rendering). It STOPS before the steps that need human decisions or
# external systems (DNS, Keycloak realm/client, firewall, Brigade roster) and
# prints them as a runbook. Re-run with --deploy once those are done.
#
# Usage:
#   provision-org.sh <slug>                 # render artifacts + print runbook
#   provision-org.sh <slug> --deploy        # also bring the stack up + smoke-test
#   provision-org.sh <slug> --allow-existing # candidate compose + sorted diff
#
# <slug>: lowercase [a-z0-9-], the org's short name (e.g. "acme"). Everything
#         derives from it: stable-acme-* and the configured deployment domain.
set -euo pipefail

SLUG="${1:-}"
DEPLOY=""
ALLOW_EXISTING=""
ARG_INDEX=0
for ARG in "$@"; do
  if [[ "$ARG_INDEX" -eq 0 ]]; then
    ARG_INDEX=1
    continue
  fi
  case "$ARG" in
    --deploy) DEPLOY=1 ;;
    --allow-existing) ALLOW_EXISTING=1 ;;
    *)
      echo "usage: $0 <slug> [--deploy] [--allow-existing]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$SLUG" || ! "$SLUG" =~ ^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$ ]]; then
  echo "usage: $0 <slug> [--deploy]   (slug: lowercase a-z0-9-, 2-32 chars)" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # repo root
BASE_COMPOSE="$ROOT/docker-compose.yml"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORG_DIR="$ROOT/deploy/per-org/instances/$SLUG"
COMPOSE_OUT="$ORG_DIR/docker-compose.yml"
EXISTING_COMPOSE=""
if [[ -f "$COMPOSE_OUT" ]]; then
  if [[ -z "$ALLOW_EXISTING" ]]; then
    echo "refusing to render over existing compose: $COMPOSE_OUT" >&2
    echo "pass --allow-existing to write a candidate and print the diff" >&2
    exit 3
  fi
  if [[ -n "$DEPLOY" ]]; then
    echo "refusing --deploy with --allow-existing: the candidate is not deployed" >&2
    exit 2
  fi
  EXISTING_COMPOSE=1
fi
DOMAIN_BASE="${STABLE_DOMAIN_BASE:-example.com}"
APP_DOMAIN="${STABLE_DOMAIN:-$SLUG.$DOMAIN_BASE}"
LIVEKIT_DOMAIN_VALUE="${LIVEKIT_DOMAIN:-$SLUG-livekit.$DOMAIN_BASE}"
TURN_DOMAIN_VALUE="${TURN_DOMAIN:-$SLUG-turn.$DOMAIN_BASE}"
WS_DOMAIN="${STABLE_WS_DOMAIN:-$SLUG-ws.$DOMAIN_BASE}"
PUBLIC_BASE_URL_VALUE="${PUBLIC_BASE_URL:-https://$APP_DOMAIN}"
LIVEKIT_PUBLIC_URL_VALUE="${LIVEKIT_PUBLIC_URL:-wss://$LIVEKIT_DOMAIN_VALUE}"
CORS_ORIGINS_VALUE="${CORS_ORIGINS:-$PUBLIC_BASE_URL_VALUE}"
STABLE_CSP_EXTRA_SCRIPT_VALUE="${STABLE_CSP_EXTRA_SCRIPT:-}"
STABLE_CSP_EXTRA_FRAME_VALUE="${STABLE_CSP_EXTRA_FRAME:-}"
VAPID_SUBJECT_VALUE="${VAPID_SUBJECT:-}"
KEYCLOAK_URL_VALUE="${KEYCLOAK_URL:-}"
KEYCLOAK_REALM_VALUE="${KEYCLOAK_REALM:-stable}"
TRUSTED_ISSUER_HOSTS_VALUE="${TRUSTED_ISSUER_HOSTS:-}"
BRIGADE_BASE_URL_VALUE="${BRIGADE_BASE_URL:-}"
METERING_REPORT_URL_VALUE="${METERING_REPORT_URL:-}"
WHISPER_BASE_URL_VALUE="${WHISPER_BASE_URL:-}"
KOKORO_BASE_URL_VALUE="${KOKORO_BASE_URL:-}"
# Document RAG. The two flags must be a real boolean (an empty value fails
# settings validation), and the model names default to the code's.
RAG_ENABLED_VALUE="${RAG_ENABLED:-false}"
QDRANT_URL_VALUE="${QDRANT_URL:-}"
INFINITY_URL_VALUE="${INFINITY_URL:-}"
EMBEDDING_MODEL_VALUE="${EMBEDDING_MODEL:-BAAI/bge-m3}"
RERANK_MODEL_VALUE="${RERANK_MODEL:-BAAI/bge-reranker-v2-m3}"
CONTEXT_ENABLED_VALUE="${CONTEXT_ENABLED:-false}"
CONTEXT_LLM_URL_VALUE="${CONTEXT_LLM_URL:-}"
BRIGADE_API_BASE_URL_VALUE="${BRIGADE_API_BASE_URL:-}"
BRIGADE_AVATAR_BASE_URL_VALUE="${BRIGADE_AVATAR_BASE_URL:-}"
HELP_AGENT_BASE_URL_VALUE="${HELP_AGENT_BASE_URL:-}"

echo "▶ provision Stable org: slug=$SLUG dir=$ORG_DIR"
mkdir -p "$ORG_DIR"

gen() { python3 -c "import secrets,string; print(''.join(secrets.choice(string.ascii_letters+string.digits) for _ in range($1)))"; }

# --- 1) allocate a LiveKit media-port block (the hard multi-instance limit) --
# Scan for a free 3-port block starting at 7890, stepping by 10, avoiding the
# dogfood 7880-7882 and anything already bound on the host.
port_free() { ! (ss -lntu 2>/dev/null || netstat -lntu 2>/dev/null) | grep -q ":$1 "; }
LK_API=""
for base in $(seq 7890 10 8090); do
  if port_free "$base" && port_free "$((base+1))" && port_free "$((base+2))"; then
    LK_API=$base; LK_TCP=$((base+1)); LK_UDP=$((base+2)); break
  fi
done
[[ -z "$LK_API" ]] && { echo "no free LiveKit port block found" >&2; exit 1; }
echo "  ✓ LiveKit port block: api=$LK_API tcp=$LK_TCP udp=$LK_UDP"

# --- 2) generate per-org secrets + identity --------------------------------
ORG_UUID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
PG_PW="$(gen 40)"; REDIS_PW="$(gen 40)"; LK_KEY="API$(gen 12)"; LK_SECRET="$(gen 48)"
INTERNAL_SECRET="$(gen 48)"; UPLOAD_SECRET="$(gen 48)"; WEBHOOK_SECRET="$(gen 40)"
echo "  ✓ generated secrets + org_id=$ORG_UUID"

# VAPID keypair (web push). Correct EC P-256 base64url encoding via
# `cryptography`. Best-effort: if the lib is absent, leave blank (push disabled).
VAPID_PUB=""; VAPID_PRIV=""
if VAPID_OUT="$(python3 - 2>/dev/null <<'PY'
import base64
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
pk = ec.generate_private_key(ec.SECP256R1())
priv = pk.private_numbers().private_value.to_bytes(32, "big")
pub = pk.public_key().public_bytes(
    serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
b = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode()
print(b(pub), b(priv))
PY
)"; then
  VAPID_PUB="${VAPID_OUT%% *}"; VAPID_PRIV="${VAPID_OUT##* }"
  echo "  ✓ generated VAPID keypair"
fi
[[ -z "$VAPID_PUB" ]] && echo "  ⚠ VAPID keypair not generated (cryptography absent) — web push disabled until set"

# --- 3) render the per-org .env from the template --------------------------
ENV_OUT="$ORG_DIR/.env"
sed \
  -e "s|__SLUG__|$SLUG|g" \
  -e "s|__ORG_UUID__|$ORG_UUID|g" \
  -e "s|__LK_API__|$LK_API|g" -e "s|__LK_TCP__|$LK_TCP|g" -e "s|__LK_UDP__|$LK_UDP|g" \
  -e "s|__APP_DOMAIN__|$APP_DOMAIN|g" \
  -e "s|__LIVEKIT_DOMAIN__|$LIVEKIT_DOMAIN_VALUE|g" \
  -e "s|__TURN_DOMAIN__|$TURN_DOMAIN_VALUE|g" \
  -e "s|__PUBLIC_BASE_URL__|$PUBLIC_BASE_URL_VALUE|g" \
  -e "s|__LIVEKIT_PUBLIC_URL__|$LIVEKIT_PUBLIC_URL_VALUE|g" \
  -e "s|__CORS_ORIGINS__|$CORS_ORIGINS_VALUE|g" \
  -e "s|__CSP_EXTRA_SCRIPT__|$STABLE_CSP_EXTRA_SCRIPT_VALUE|g" \
  -e "s|__CSP_EXTRA_FRAME__|$STABLE_CSP_EXTRA_FRAME_VALUE|g" \
  -e "s|__VAPID_SUBJECT__|$VAPID_SUBJECT_VALUE|g" \
  -e "s|__KEYCLOAK_URL__|$KEYCLOAK_URL_VALUE|g" \
  -e "s|__KC_REALM__|$KEYCLOAK_REALM_VALUE|g" \
  -e "s|__TRUSTED_ISSUER_HOSTS__|$TRUSTED_ISSUER_HOSTS_VALUE|g" \
  -e "s|__KC_CLIENT__|stable-$SLUG|g" -e "s|__KC_SECRET__||g" \
  -e "s|__BRIGADE_BASE_URL__|$BRIGADE_BASE_URL_VALUE|g" \
  -e "s|__METERING_REPORT_URL__|$METERING_REPORT_URL_VALUE|g" \
  -e "s|__WHISPER_BASE_URL__|$WHISPER_BASE_URL_VALUE|g" \
  -e "s|__KOKORO_BASE_URL__|$KOKORO_BASE_URL_VALUE|g" \
  -e "s|__RAG_ENABLED__|$RAG_ENABLED_VALUE|g" \
  -e "s|__QDRANT_URL__|$QDRANT_URL_VALUE|g" \
  -e "s|__INFINITY_URL__|$INFINITY_URL_VALUE|g" \
  -e "s|__EMBEDDING_MODEL__|$EMBEDDING_MODEL_VALUE|g" \
  -e "s|__RERANK_MODEL__|$RERANK_MODEL_VALUE|g" \
  -e "s|__CONTEXT_ENABLED__|$CONTEXT_ENABLED_VALUE|g" \
  -e "s|__CONTEXT_LLM_URL__|$CONTEXT_LLM_URL_VALUE|g" \
  -e "s|__BRIGADE_API_BASE_URL__|$BRIGADE_API_BASE_URL_VALUE|g" \
  -e "s|__BRIGADE_AVATAR_BASE_URL__|$BRIGADE_AVATAR_BASE_URL_VALUE|g" \
  -e "s|__HELP_AGENT_BASE_URL__|$HELP_AGENT_BASE_URL_VALUE|g" \
  "$HERE/env.tmpl" > "$ENV_OUT"
# fill generated secrets (use a temp to avoid sed-escaping secret chars)
python3 - "$ENV_OUT" "$PG_PW" "$REDIS_PW" "$LK_KEY" "$LK_SECRET" "$INTERNAL_SECRET" "$UPLOAD_SECRET" "$WEBHOOK_SECRET" "$VAPID_PUB" "$VAPID_PRIV" <<'PY'
import sys
f,pg,rd,lkk,lks,ints,ups,wh,vpub,vpriv = sys.argv[1:11]
sub = {
 "POSTGRES_PASSWORD=__GEN__":f"POSTGRES_PASSWORD={pg}",
 "REDIS_PASSWORD=__GEN__":f"REDIS_PASSWORD={rd}",
 "LIVEKIT_API_KEY=__GEN_KEY__":f"LIVEKIT_API_KEY={lkk}",
 "LIVEKIT_API_SECRET=__GEN__":f"LIVEKIT_API_SECRET={lks}",
 "INTERNAL_AGENT_SECRET=__GEN__":f"INTERNAL_AGENT_SECRET={ints}",
 "UPLOAD_URL_SECRET=__GEN__":f"UPLOAD_URL_SECRET={ups}",
 "INCOMING_WEBHOOK_SECRET=__GEN__":f"INCOMING_WEBHOOK_SECRET={wh}",
 "VAPID_PUBLIC_KEY=__GEN_VAPID_PUB__":f"VAPID_PUBLIC_KEY={vpub}",
 "VAPID_PRIVATE_KEY=__GEN_VAPID_PRIV__":f"VAPID_PRIVATE_KEY={vpriv}",
 "BRIGADE_API_KEY=__BRIGADE_KEY__":"BRIGADE_API_KEY=",
 "METERING_KEY=__BILLING_KEY__":"METERING_KEY=",
}
t=open(f).read()
for k,v in sub.items(): t=t.replace(k,v)
open(f,"w").write(t)
PY
chmod 600 "$ENV_OUT"
echo "  ✓ rendered $ENV_OUT (mode 600)"

# --- 4) render the per-org compose from the canonical base -----------------
if [[ -n "$ALLOW_EXISTING" ]]; then
  python3 "$HERE/render_compose.py" \
    "$BASE_COMPOSE" "$ORG_DIR/docker-compose.yml" \
    "$SLUG" "$APP_DOMAIN" "$LIVEKIT_DOMAIN_VALUE" "$TURN_DOMAIN_VALUE" \
    "$LK_API" "$LK_TCP" "$LK_UDP" "$WS_DOMAIN" --allow-existing
else
  python3 "$HERE/render_compose.py" \
    "$BASE_COMPOSE" "$ORG_DIR/docker-compose.yml" \
    "$SLUG" "$APP_DOMAIN" "$LIVEKIT_DOMAIN_VALUE" "$TURN_DOMAIN_VALUE" \
    "$LK_API" "$LK_TCP" "$LK_UDP" "$WS_DOMAIN"
fi

# Reminder printed in the runbook below: $WS_DOMAIN must be a
# DNS-only (grey) A record straight to this box — the websocket host exists
# precisely to bypass the CDN (h3/h2 extended-CONNECT stalls websockets), so
# proxying it would defeat the point.

# --- 4b) seed this org's federation server-rail list -----------------------
# The web service mounts $ORG_DIR/instances.json over the image's baked list.
# If the file is missing Docker silently creates a DIRECTORY at that path and
# nginx 404s the rail instead of serving it, so create it now. `[]` is the
# correct single-instance default; edit it to federate this org with others.
if [[ ! -f "$ORG_DIR/instances.json" ]]; then
  echo '[]' > "$ORG_DIR/instances.json"
  echo "  ✓ seeded $ORG_DIR/instances.json (single-instance default)"
fi

# --- 5) render per-org livekit.yaml (own key/secret + redis password) ------
LK_YAML_SRC="$ROOT/server/livekit.yaml.example"
[[ -f "$LK_YAML_SRC" ]] || LK_YAML_SRC="$ROOT/server/livekit.yaml"
python3 - "$LK_YAML_SRC" "$ORG_DIR/livekit.yaml" "$LK_KEY" "$LK_SECRET" "$REDIS_PW" <<'PY'
import sys, yaml
src,out,key,secret,rpw = sys.argv[1:6]
try:
    d = yaml.safe_load(open(src)) or {}
except Exception:
    d = {}
d.setdefault("port",7880)
d["keys"] = {key: secret}
d.setdefault("redis",{})["address"]="redis:6379"
d["redis"]["password"]=rpw
d.setdefault("room",{})["auto_create"]=True
yaml.safe_dump(d,open(out,"w"),sort_keys=False)
print("  ✓ rendered", out)
PY
chmod 600 "$ORG_DIR/livekit.yaml"

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo " ARTIFACTS READY in $ORG_DIR"
if [[ -n "$EXISTING_COMPOSE" ]]; then
  echo "   .env  docker-compose.yml.candidate  livekit.yaml"
else
  echo "   .env  docker-compose.yml  livekit.yaml"
fi
echo "════════════════════════════════════════════════════════════════════"
echo " MANUAL STEPS before --deploy (need decisions / external systems):"
echo "  1. DNS (Cloudflare): A/AAAA for"
echo "       $APP_DOMAIN"
echo "       $LIVEKIT_DOMAIN_VALUE"
echo "       $TURN_DOMAIN_VALUE   -> this host"
echo "  2. Keycloak: create client 'stable-$SLUG' in realm $KEYCLOAK_REALM_VALUE (or a per-org"
echo "     realm — see project_per_org_sso_design), set redirect URIs to the"
echo "     domain above, paste the client secret into KEYCLOAK_CLIENT_SECRET."
echo "  3. Firewall: open UDP $LK_UDP (LiveKit media) + TCP $LK_TCP to this host."
echo "  4. Brigade: scope the org's agent roster (accessPolicy) + set"
echo "     BRIGADE_API_KEY; set METERING_KEY for billing."
echo "  5. Then: $0 $SLUG --deploy"
echo "════════════════════════════════════════════════════════════════════"

if [[ -z "$DEPLOY" ]]; then
  exit 0
fi

# --- 6) deploy + smoke test -------------------------------------------------
echo "▶ deploying stack for $SLUG…"
cd "$ORG_DIR"
docker compose --env-file .env -p "stable-$SLUG" up -d
echo "  ⏳ settling…"; sleep 10
docker compose -p "stable-$SLUG" ps
code="$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_BASE_URL_VALUE/" || echo 000)"
echo "  🌐 $PUBLIC_BASE_URL_VALUE/ -> HTTP $code"
[[ "$code" =~ ^(2|3)[0-9][0-9]$ ]] && echo "✅ $SLUG provisioned + live." || {
  echo "❌ external check failed ($code) — check DNS/cert/Keycloak; stack is up, debug with: docker compose -p stable-$SLUG logs" >&2
  exit 1
}
