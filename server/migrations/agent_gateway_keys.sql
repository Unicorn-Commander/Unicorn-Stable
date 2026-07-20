-- ORCH-1 — agent_gateway_keys table. Idempotent; applied at deploy time (avoids
-- the Alembic multi-head hazard on Stable). Matches app/models/agent_gateway_key.py.
CREATE TABLE IF NOT EXISTS agent_gateway_keys (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key_hash       VARCHAR(64) NOT NULL,
    key_prefix     VARCHAR(16) NOT NULL,
    agent_id       VARCHAR(100) NOT NULL,
    label          VARCHAR(255),
    allowed_rooms  JSONB NOT NULL DEFAULT '["*"]'::jsonb,
    rate_limit_rpm INTEGER NOT NULL DEFAULT 30,
    created_by     VARCHAR(255),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_gateway_keys_key_hash ON agent_gateway_keys (key_hash);
CREATE INDEX IF NOT EXISTS ix_agent_gateway_keys_key_hash ON agent_gateway_keys (key_hash);
