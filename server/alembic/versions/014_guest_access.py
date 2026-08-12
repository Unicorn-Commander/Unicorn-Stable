"""Guest access — invites, sessions, and the 'guest' participant type.

Revision ID: 014_guest_access
Revises: 013_broadcast_tokens
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# NOTE: revision ids are stored in alembic_version.version_num, a varchar(32).
# "014_guest_access" is 16 chars. A 33-char id once rolled back an entire
# migration at the version stamp — keep these short.
revision = "014_guest_access"
down_revision = "013_broadcast_tokens"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # participant_type_enum += 'guest'
    # ------------------------------------------------------------------
    # A guest is a THIRD kind of participant, not a flavour of human. That
    # matters because ~10 queries filter on `participant_type = 'human'` —
    # notably the INSTANCE-WIDE people directory, user search, mention-email
    # targeting, push targeting, DM/group creation targets, approver
    # resolution, and email-identity linking. Typing guests as human would put
    # every stranger who ever joined one call into every user's People
    # directory forever. This one value excludes them from all of it by
    # construction.
    #
    # ADD VALUE IF NOT EXISTS is transaction-safe on PostgreSQL 12+ (this
    # deployment runs 16). The new label may not be USED until the transaction
    # commits — nothing here inserts a guest row, so that is fine. It is also
    # idempotent, so a re-run or a partially-applied deploy is harmless.
    #
    # `MemberRole.GUEST` needs no migration: 'guest' was already a value of
    # member_role_enum, pre-carved and never assigned until now.
    op.execute("ALTER TYPE participant_type_enum ADD VALUE IF NOT EXISTS 'guest'")

    # ------------------------------------------------------------------
    # guest_invites — the SHAREABLE link
    # ------------------------------------------------------------------
    op.create_table(
        "guest_invites",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("uuid_generate_v4()"),
        ),
        # SHA-256 of the raw token. The raw value is returned once at mint and
        # never stored — same contract as agent_gateway_keys / broadcast_tokens.
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("token_prefix", sa.String(length=16), nullable=False),
        sa.Column(
            "room_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("rooms.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # "pbkdf2_sha256$<iters>$<salt>$<hash>" — never plaintext.
        sa.Column("passphrase_hash", sa.String(length=255), nullable=True),
        sa.Column(
            "can_publish", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        # NULL = unlimited. Enforced by an atomic conditional UPDATE at
        # redemption so two guests cannot race through the last seat.
        sa.Column("max_uses", sa.Integer(), nullable=True),
        sa.Column(
            "use_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("label", sa.String(length=255), nullable=True),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("participants.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_guest_invites_token_hash", "guest_invites", ["token_hash"], unique=True
    )
    op.create_index("ix_guest_invites_room_id", "guest_invites", ["room_id"])

    # ------------------------------------------------------------------
    # guest_sessions — the PER-PERSON credential
    # ------------------------------------------------------------------
    # Split from the invite on purpose: the invite is shareable and therefore
    # never an API credential, while a session names exactly one Participant
    # and one room and can be revoked on its own (boot one guest) or as a
    # cascade from its invite (kill the link, kill everyone who used it).
    op.create_table(
        "guest_sessions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("uuid_generate_v4()"),
        ),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("token_prefix", sa.String(length=16), nullable=False),
        sa.Column(
            "invite_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("guest_invites.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Denormalized from the invite: this is the value the authorization
        # path compares a requested room against, so it is kept in hand rather
        # than behind a join a refactor could drop. Written once, at
        # redemption; never re-pointed.
        sa.Column(
            "room_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("rooms.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "participant_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("participants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Attacker-chosen; sanitized and length-capped before it lands here.
        sa.Column("display_name", sa.String(length=64), nullable=False),
        sa.Column(
            "can_publish", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_guest_sessions_token_hash", "guest_sessions", ["token_hash"], unique=True
    )
    op.create_index("ix_guest_sessions_invite_id", "guest_sessions", ["invite_id"])
    op.create_index("ix_guest_sessions_room_id", "guest_sessions", ["room_id"])
    op.create_index(
        "ix_guest_sessions_participant_id", "guest_sessions", ["participant_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_guest_sessions_participant_id", table_name="guest_sessions")
    op.drop_index("ix_guest_sessions_room_id", table_name="guest_sessions")
    op.drop_index("ix_guest_sessions_invite_id", table_name="guest_sessions")
    op.drop_index("ix_guest_sessions_token_hash", table_name="guest_sessions")
    op.drop_table("guest_sessions")

    op.drop_index("ix_guest_invites_room_id", table_name="guest_invites")
    op.drop_index("ix_guest_invites_token_hash", table_name="guest_invites")
    op.drop_table("guest_invites")

    # The 'guest' value is deliberately LEFT on participant_type_enum.
    # PostgreSQL cannot drop an enum label; removing it means recreating the
    # type and rewriting every column that uses it, and any participants row
    # already typed 'guest' would block that anyway. An unused extra label is
    # inert, and leaving it makes this downgrade safe to run on a database
    # that has real guests in it — it drops the credential tables (which is the
    # point) without touching the rows those guests authored.
