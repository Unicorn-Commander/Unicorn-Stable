"""Persist agent backends and verified canonical runner chats.

Revision ID: 020_agent_backend
Revises: 019_control_key_voice

No rooms, memberships, profiles or gateway scopes are created or widened.
Other runner seats remain closed until an operator records their canonical
profile-subscribed room in participants.metadata.canonical_dm_room.
"""
from alembic import op
import sqlalchemy as sa
revision = '020_agent_backend'
down_revision = '019_control_key_voice'
branch_labels = None
depends_on = None


def upgrade():
    # Existing credential-backed seats are external runners regardless of
    # which room a newly created DM happens to name. Retain explicit settings.
    op.execute(sa.text('''
        UPDATE participants p SET metadata = COALESCE(p.metadata, '{}'::jsonb) ||
            jsonb_build_object('backend', CASE WHEN EXISTS (
                SELECT 1 FROM agent_gateway_keys k
                WHERE p.keycloak_sub = 'brigade:' || k.agent_id
            ) THEN 'runner' ELSE 'brigade' END)
        WHERE p.participant_type = 'agent' AND NOT COALESCE(p.metadata, '{}'::jsonb) ? 'backend'
    '''))
    for agent_id, slug in [('persephone', 'persephone'), ('codex-astra', 'codex-astra'), ('claude-code', 'rook-aaron')]:
        op.execute(sa.text('''
            UPDATE participants SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                jsonb_build_object('backend', 'runner', 'canonical_dm_room', CAST(:slug AS text))
            WHERE keycloak_sub = :sub AND participant_type = 'agent'
              AND NOT COALESCE(metadata, '{}'::jsonb) ? 'canonical_dm_room'
        ''').bindparams(slug=slug, sub='brigade:'+agent_id))


def downgrade():
    # Leave identity/provisioning facts intact: removing them would route
    # runner seats back to Brigade. Previous code ignores these JSONB keys.
    pass
