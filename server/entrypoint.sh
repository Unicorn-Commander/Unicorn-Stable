#!/usr/bin/env bash
# Stable backend entrypoint: run alembic migrations, then start uvicorn.
# Migrations are idempotent (alembic tracks state in the DB), so running on
# every boot is safe and ensures fresh deployments come up with schema applied.
set -e

echo "[entrypoint] running alembic upgrade head"
# Never serve against an unknown schema.  Alembic is idempotent and already
# knows whether the database is at head; swallowing a non-zero exit here made
# the container look healthy while every schema-dependent request failed.
if alembic upgrade head; then
  echo "[entrypoint] database schema is at head"
else
  migration_status=$?
  echo "[entrypoint] FATAL: alembic upgrade failed (exit ${migration_status}); refusing to start uvicorn." >&2
  exit "${migration_status}"
fi

echo "[entrypoint] starting uvicorn"
# The application emits request-id-aware structured HTTP and WebSocket events.
# Uvicorn's default access logger would duplicate those events and, critically,
# includes the raw WebSocket query string where the browser join token lives.
exec uvicorn app.main:app --host 0.0.0.0 --port 8400 --workers 4 --loop uvloop --http httptools --no-access-log
