#!/usr/bin/env bash
# Unicorn Stable — tear down a per-org instance (reversible-ish).
#
# Stops + removes the org's containers. By default KEEPS the data volumes and
# the rendered artifacts (so it's recoverable). Pass --purge to also delete the
# volumes (DESTRUCTIVE — the org's DB + uploads are gone) and the instance dir.
#
# Usage:
#   deprovision-org.sh <slug>            # stop + remove containers, keep data
#   deprovision-org.sh <slug> --purge    # also delete volumes + artifacts
set -euo pipefail

SLUG="${1:-}"
PURGE=""
[[ "${2:-}" == "--purge" ]] && PURGE=1
[[ -z "$SLUG" ]] && { echo "usage: $0 <slug> [--purge]" >&2; exit 2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ORG_DIR="$ROOT/deploy/per-org/instances/$SLUG"
PROJ="stable-$SLUG"

echo "▶ deprovision $SLUG (purge=${PURGE:-0})"
if [[ -n "$PURGE" ]]; then
  read -r -p "  PURGE will DELETE $SLUG's database + uploads. Type the slug to confirm: " ans
  [[ "$ans" == "$SLUG" ]] || { echo "aborted."; exit 1; }
  docker compose -p "$PROJ" down -v || true
  rm -rf "$ORG_DIR"
  echo "  ✓ purged containers, volumes, and $ORG_DIR"
else
  docker compose -p "$PROJ" down || true
  echo "  ✓ stopped + removed containers (volumes + $ORG_DIR kept; re-up to restore)"
fi
