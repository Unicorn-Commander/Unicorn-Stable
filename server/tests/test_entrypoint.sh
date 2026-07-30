#!/usr/bin/env bash
set -eu

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fake_bin="$(mktemp -d)"
sentinel="${fake_bin}/uvicorn-started"
trap 'rm -rf "${fake_bin}"' EXIT

cat >"${fake_bin}/alembic" <<'EOF'
#!/usr/bin/env bash
exit 42
EOF
cat >"${fake_bin}/uvicorn" <<EOF
#!/usr/bin/env bash
touch "${sentinel}"
EOF
chmod +x "${fake_bin}/alembic" "${fake_bin}/uvicorn"

set +e
PATH="${fake_bin}:${PATH}" "${server_root}/entrypoint.sh" >/dev/null 2>&1
result=$?
set -e

if [ "${result}" -ne 42 ]; then
  echo "expected migration exit 42, got ${result}" >&2
  exit 1
fi
if [ -e "${sentinel}" ]; then
  echo "uvicorn started after a failed migration" >&2
  exit 1
fi
if ! grep -q -- "--no-access-log" "${server_root}/entrypoint.sh"; then
  echo "uvicorn access logging is enabled and can expose WebSocket tokens" >&2
  exit 1
fi
if ! grep -q -- "--log-level warning" "${server_root}/entrypoint.sh"; then
  echo "uvicorn WebSocket protocol logging can expose query-string tokens" >&2
  exit 1
fi
echo "PASS — migration failure prevents server startup"
