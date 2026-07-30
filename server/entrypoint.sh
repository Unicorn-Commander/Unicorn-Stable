#!/usr/bin/env bash
# Stable backend entrypoint: run alembic migrations, then start uvicorn.
# Migrations are idempotent (alembic tracks state in the DB), so running on
# every boot is safe and ensures fresh deployments come up with schema applied.
set -e

echo "[entrypoint] running alembic upgrade head"
alembic upgrade head

echo "[entrypoint] starting uvicorn"
exec uvicorn app.main:app --host 0.0.0.0 --port 8400 --workers 4 --loop uvloop --http httptools
