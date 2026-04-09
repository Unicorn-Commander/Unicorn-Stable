-- Stable — PostgreSQL initialisation
-- Runs once on first container start via docker-entrypoint-initdb.d

-- Enable useful extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- trigram fuzzy search on messages

-- The application schema is managed by Alembic migrations.
-- This file only sets up extensions and the database role.
