"""Gateway keys may be promoted to room voice-settings controllers.

Revision ID: 019_control_key_voice
Revises: 018a_agent_gateway_keys
Create Date: 2026-09-02

The native Talk Controls desk app holds a gateway key (agent_id
``talk-controls-app``) and cannot durably hold a user JWT, so PATCH
/rooms/{id}/voice-settings learns to accept a gateway key bearer for the rooms
that key is scoped to. ``can_manage_voice_settings`` is the explicit grant for
any other key; ``talk-controls-app`` is granted implicitly by agent id AND
flipped on here so the row says what the code does.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# NOTE: alembic_version.version_num is varchar(32) — keep ids short.
revision: str = "019_control_key_voice"
down_revision: Union[str, None] = "018a_agent_gateway_keys"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "agent_gateway_keys",
        sa.Column(
            "can_manage_voice_settings",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )
    op.execute(
        "UPDATE agent_gateway_keys SET can_manage_voice_settings = true "
        "WHERE agent_id = 'talk-controls-app'"
    )


def downgrade() -> None:
    op.drop_column("agent_gateway_keys", "can_manage_voice_settings")
