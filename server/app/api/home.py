from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_current_user, get_db, get_livekit
from app.models.agent import AgentEvent
from app.models.artifact import Artifact, ArtifactVersion
from app.models.message import ContentType, Message
from app.models.participant import Participant, ParticipantStatus, ParticipantType
from app.models.room import MemberRole, Room, RoomMember, TranscriptExport
from app.services.livekit_service import LiveKitService

router = APIRouter()


class LiveCall(BaseModel):
    room_id: str
    display_name: str
    room_type: str
    participant_count: int
    has_agent: bool


class AgentActivity(BaseModel):
    message_id: str
    room_id: str
    room_name: str
    sender_id: str
    sender_name: str
    preview: str
    created_at: datetime


class RecentArtifact(BaseModel):
    id: str
    room_id: str
    room_name: str
    title: str
    kind: str
    author_kind: str
    updated_at: datetime


class RecentTranscript(BaseModel):
    id: str
    room_id: str
    room_name: str
    status: str
    created_at: datetime


class HomeCounts(BaseModel):
    unread_rooms: int
    mention_rooms: int
    approvals_pending: int
    agents_available: int
    people_online: int
    worker_last_seen_at: datetime | None


class HomeSummary(BaseModel):
    generated_at: datetime
    live_calls: list[LiveCall]
    agent_activity: list[AgentActivity]
    recent_artifacts: list[RecentArtifact]
    recent_transcripts: list[RecentTranscript]
    counts: HomeCounts


@router.get("/home/summary", response_model=HomeSummary)
async def get_home_summary(
    user: Annotated[dict[str, Any], Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    livekit: Annotated[LiveKitService, Depends(get_livekit)],
) -> HomeSummary:
    participant_id = uuid.UUID(str(user["participant_id"]))
    member_rooms = select(RoomMember.room_id).where(RoomMember.participant_id == participant_id)

    room_rows = (await db.execute(
        select(Room).where(Room.id.in_(member_rooms), Room.is_archived.is_(False))
    )).scalars().all()
    room_by_lk = {r.livekit_room_name: r for r in room_rows}
    live_calls: list[LiveCall] = []
    for lk_room in await livekit.list_rooms(names=list(room_by_lk)):
        count = int(getattr(lk_room, "num_participants", 0) or 0)
        if count < 1:
            continue
        room = room_by_lk.get(lk_room.name)
        if room is None:
            continue
        occupancy = await livekit.get_room(lk_room.name)
        participants = occupancy["participants"]
        live_calls.append(LiveCall(
            room_id=str(room.id), display_name=room.display_name,
            room_type=room.room_type.value, participant_count=count,
            has_agent=any(str(getattr(p, "identity", "")).startswith("agent-") for p in participants),
        ))

    activity_rows = (await db.execute(
        select(Message, Room.display_name, Participant.display_name)
        .join(Room, Room.id == Message.room_id)
        .join(RoomMember, and_(RoomMember.room_id == Message.room_id, RoomMember.participant_id == participant_id))
        .join(Participant, Participant.id == Message.sender_id)
        .where(Participant.participant_type == ParticipantType.AGENT, Message.is_deleted.is_(False))
        .order_by(Message.created_at.desc()).limit(20)
    )).all()
    agent_activity = [AgentActivity(
        message_id=str(m.id), room_id=str(m.room_id), room_name=room_name,
        sender_id=str(m.sender_id), sender_name=sender_name,
        preview=(m.content[:140] + ("…" if len(m.content) > 140 else "")), created_at=m.created_at,
    ) for m, room_name, sender_name in activity_rows]

    artifact_rows = (await db.execute(
        select(Artifact, Room.display_name, ArtifactVersion.author_kind)
        .join(Room, Room.id == Artifact.room_id)
        .join(RoomMember, and_(RoomMember.room_id == Artifact.room_id, RoomMember.participant_id == participant_id))
        .outerjoin(ArtifactVersion, ArtifactVersion.id == Artifact.current_version_id)
        .order_by(Artifact.updated_at.desc()).limit(10)
    )).all()
    artifacts = [RecentArtifact(
        id=str(a.id), room_id=str(a.room_id), room_name=room_name, title=a.title,
        kind=a.kind.value, author_kind=(author_kind.value if author_kind else "human"), updated_at=a.updated_at,
    ) for a, room_name, author_kind in artifact_rows]

    transcript_rows = (await db.execute(
        select(TranscriptExport, Room.display_name)
        .join(Room, Room.id == TranscriptExport.room_id)
        .join(RoomMember, and_(RoomMember.room_id == TranscriptExport.room_id, RoomMember.participant_id == participant_id))
        .order_by(TranscriptExport.created_at.desc()).limit(5)
    )).all()
    transcripts = [RecentTranscript(
        id=str(t.id), room_id=str(t.room_id), room_name=room_name,
        status=t.status, created_at=t.created_at,
    ) for t, room_name in transcript_rows]

    unread = (await db.execute(
        select(func.count(func.distinct(Message.room_id)))
        .join(RoomMember, and_(RoomMember.room_id == Message.room_id, RoomMember.participant_id == participant_id))
        .where(Message.is_deleted.is_(False), Message.sender_id != participant_id,
               or_(RoomMember.last_read_at.is_(None), Message.created_at > RoomMember.last_read_at))
    )).scalar_one()
    mention = (await db.execute(
        select(func.count(func.distinct(Message.room_id)))
        .join(RoomMember, and_(RoomMember.room_id == Message.room_id, RoomMember.participant_id == participant_id))
        .where(Message.is_deleted.is_(False), Message.sender_id != participant_id,
               or_(RoomMember.last_read_at.is_(None), Message.created_at > RoomMember.last_read_at),
               Message.content.ilike(f"%@{user.get('username', '')}%"))
    )).scalar_one()
    approvals = (await db.execute(
        select(func.count(Message.id)).join(RoomMember, and_(RoomMember.room_id == Message.room_id,
            RoomMember.participant_id == participant_id,
            RoomMember.role.in_([MemberRole.OWNER, MemberRole.ADMIN])))
        .where(Message.content_type == ContentType.AGENT_ACTION, Message.is_deleted.is_(False),
               or_(Message.metadata_.is_(None), Message.metadata_["decision"].as_string().is_(None)))
    )).scalar_one()
    agents_available = (await db.execute(
        select(func.count(Participant.id)).where(
            Participant.participant_type == ParticipantType.AGENT,
            Participant.status != ParticipantStatus.OFFLINE,
        )
    )).scalar_one()
    people_online = (await db.execute(
        select(func.count(Participant.id)).where(Participant.participant_type == ParticipantType.HUMAN,
                                                  Participant.status == ParticipantStatus.ONLINE)
    )).scalar_one()
    worker_last_seen = (await db.execute(
        select(func.max(AgentEvent.received_at)).where(AgentEvent.event_type == "worker_heartbeat")
    )).scalar_one_or_none()

    return HomeSummary(
        generated_at=datetime.now(timezone.utc), live_calls=live_calls,
        agent_activity=agent_activity, recent_artifacts=artifacts, recent_transcripts=transcripts,
        counts=HomeCounts(unread_rooms=unread, mention_rooms=mention,
            approvals_pending=approvals, agents_available=agents_available,
            people_online=people_online, worker_last_seen_at=worker_last_seen),
    )
