#!/usr/bin/env python3
"""Archive empty legacy ``chat-with-majik-*`` rooms created by the old flow.

The default is a dry run.  Matching rooms are archived, never deleted, and a
second run is a no-op because archived rows are excluded from the match.

    python scripts/archive_buggy_chat_with_rooms.py
    python scripts/archive_buggy_chat_with_rooms.py --apply
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from sqlalchemy import exists, select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _parse(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply", action="store_true", help="archive matches; default is dry-run"
    )
    return parser.parse_args(argv)


async def _run(args: argparse.Namespace) -> int:
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.config import get_settings
    from app.models.message import Message
    from app.models.room import Room, RoomType

    settings = get_settings()
    engine = create_async_engine(settings.database_url, pool_pre_ping=True)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with sessions() as db:
            stmt = select(Room).where(
                Room.name.like("chat-with-majik-%"),
                Room.room_type == RoomType.DM,
                Room.is_archived.is_(False),
                ~exists(select(Message.id).where(Message.room_id == Room.id)),
            ).order_by(Room.name)
            rooms = list((await db.execute(stmt)).scalars().all())
            if args.apply:
                for room in rooms:
                    room.is_archived = True
                await db.commit()
            action = "archived" if args.apply else "would_archive"
            print(f"matched={len(rooms)} {action}={len(rooms)} dry_run={not args.apply}")
            for room in rooms:
                print(f"  {room.id} {room.name}")
    finally:
        await engine.dispose()
    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        return asyncio.run(_run(_parse(argv)))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
