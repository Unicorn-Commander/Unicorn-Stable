#!/usr/bin/env bash
# Unicorn Stable — reproducible, safe deploy.
#
# Encodes the deploy discipline that was previously tribal knowledge:
#   * refuse to build from a dirty tree (prod must be reproducible from a commit)
#   * stamp the git SHA + build time into the image (provenance)
#   * rollback-tag the current :latest BEFORE replacing it
#   * CPU-cap the build so it doesn't starve the inference boxes
#   * recreate only the target service(s), then verify health + external HTTP 200
#
# Usage:
#   scripts/deploy.sh backend            # build+deploy backend
#   scripts/deploy.sh web                # build+deploy web
#   scripts/deploy.sh backend web        # both
#   ALLOW_DIRTY=1 scripts/deploy.sh web  # escape hatch (discouraged)
#
# Env knobs:
#   PROJECT       compose project name           (default: unicorn-stable)
#   EXTERNAL_URL  URL to verify after deploy      (default: http://localhost/)
#   CPU_QUOTA     docker build --cpu-quota        (default: 600000)
#   CPU_PERIOD    docker build --cpu-period       (default: 100000)
set -euo pipefail

PROJECT="${PROJECT:-unicorn-stable}"
EXTERNAL_URL="${EXTERNAL_URL:-http://localhost/}"
CPU_QUOTA="${CPU_QUOTA:-600000}"
CPU_PERIOD="${CPU_PERIOD:-100000}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <service> [service...]   (services: backend web agents)" >&2
  exit 2
fi

# --- provenance ------------------------------------------------------------
GIT_SHA="$(git rev-parse --short=12 HEAD)"
GIT_SHA_FULL="$(git rev-parse HEAD)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DIRTY=""
if ! git diff --quiet || ! git diff --cached --quiet; then
  DIRTY="1"
fi

if [[ -n "$DIRTY" ]]; then
  if [[ "${ALLOW_DIRTY:-}" == "1" ]]; then
    echo "⚠️  Working tree is DIRTY — building anyway (ALLOW_DIRTY=1). Image will be tagged +dirty." >&2
    GIT_SHA="${GIT_SHA}+dirty"
  else
    echo "✋ Refusing to deploy from a dirty working tree — commit or stash first." >&2
    echo "   (set ALLOW_DIRTY=1 to override; the image will be marked +dirty)" >&2
    git status -s >&2
    exit 1
  fi
fi

echo "▶ deploy: project=$PROJECT sha=$GIT_SHA build_time=$BUILD_TIME services=$*"

STAMP="$(date -u +%Y%m%d-%H%M%S)"

declare -A IMG=( [backend]="${PROJECT}-backend" [web]="${PROJECT}-web" [agents]="${PROJECT}-agent-runtime" )
declare -A CTX=( [backend]="./server" [web]="./web" [agents]="./agents" )
declare -A COMPOSE_SVC=( [backend]="backend" [web]="web" [agents]="agent-runtime" )
compose_services=()

for svc in "$@"; do
  img="${IMG[$svc]:-}"
  ctx="${CTX[$svc]:-}"
  compose_svc="${COMPOSE_SVC[$svc]:-}"
  if [[ -z "$img" || -z "$ctx" || -z "$compose_svc" ]]; then echo "unknown service: $svc" >&2; exit 2; fi
  compose_services+=("$compose_svc")

  # 1) rollback-tag the currently-deployed image (if any)
  if docker image inspect "${img}:latest" >/dev/null 2>&1; then
    rb="${img}:rollback-${STAMP}"
    docker tag "${img}:latest" "$rb"
    echo "  ↩ rollback tag: $rb"
  fi

  # 2) CPU-capped build, stamping provenance as build args + labels
  echo "  ⚙ building ${img}:latest from ${ctx} (cpu-capped)…"
  DOCKER_BUILDKIT=1 docker build \
    --cpu-quota "$CPU_QUOTA" --cpu-period "$CPU_PERIOD" \
    --build-arg "GIT_SHA=${GIT_SHA}" \
    --build-arg "GIT_SHA_FULL=${GIT_SHA_FULL}" \
    --build-arg "BUILD_TIME=${BUILD_TIME}" \
    -t "${img}:latest" -t "${img}:${GIT_SHA}" \
    "$ctx"
done

# 3) recreate the target services from the freshly-built :latest
echo "  ♻ recreating: $*"
docker compose -p "$PROJECT" up -d --no-deps --force-recreate "${compose_services[@]}"

# 4) verify — docker health + external HTTP
echo "  ⏳ waiting for containers to settle…"
sleep 6
docker compose -p "$PROJECT" ps

# Container liveness only proves the process is running. A backend deploy is
# not successful until its schema, database, Redis, LiveKit, identity keys,
# audit credential, and configured release gates are ready.
for svc in "$@"; do
  if [[ "$svc" == "backend" ]]; then
    backend_ready=""
    for _attempt in $(seq 1 18); do
      if docker compose -p "$PROJECT" exec -T backend \
        python -c "import urllib.request; urllib.request.urlopen('http://localhost:8400/ready', timeout=5)" \
        >/dev/null 2>&1; then
        backend_ready="1"
        break
      fi
      sleep 5
    done
    if [[ -z "$backend_ready" ]]; then
      echo "❌ backend readiness failed — process is alive but cannot serve real traffic." >&2
      exit 1
    fi
    echo "  ✓ backend readiness gate passed"
  fi
done

code="$(curl -s -o /dev/null -w '%{http_code}' "$EXTERNAL_URL" || echo 000)"
echo "  🌐 external ${EXTERNAL_URL} -> HTTP ${code}"
if ! [[ "$code" =~ ^(2|3)[0-9][0-9]$ ]]; then
  echo "❌ external check failed (HTTP $code) — investigate; rollback tags are ${STAMP}." >&2
  exit 1
fi

# 5) verify the federation server rail — HTTP 200 is NOT enough.
# The web image bakes an empty instances.json; the real list is a bind mount.
# Lose the mount and nginx still returns 200 while serving `[]`, so the rail
# goes dark with every other check green. Assert the ARTIFACT.
for svc in "$@"; do
  if [[ "$svc" == "web" ]]; then
    python3 "$ROOT/scripts/check_server_rail.py" "$PROJECT" "$EXTERNAL_URL" || {
      echo "❌ server rail check failed — rollback tags are ${STAMP}." >&2
      exit 1
    }
    python3 "$ROOT/scripts/check_landing_frame.py" "$EXTERNAL_URL" || {
      echo "❌ landing frame check failed — rollback tags are ${STAMP}." >&2
      exit 1
    }
  fi
done

first_service="$1"
first_compose_service="${COMPOSE_SVC[$first_service]}"
echo "✅ deploy OK (sha=$GIT_SHA). Rollback with: docker tag ${IMG[$first_service]}:rollback-${STAMP} ${IMG[$first_service]}:latest && docker compose -p $PROJECT up -d --no-deps --force-recreate $first_compose_service"
