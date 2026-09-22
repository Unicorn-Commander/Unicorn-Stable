#!/usr/bin/env python3
"""Set rooms' recording policy in bulk, from inside the backend container.

The deploy step for instances that recorded every call before design §8
(``CALL_RECORDING_ENABLED=true``): migration 023 defaults every room to
``off``, so run this right after it to keep today's behaviour on purpose:

    docker compose exec backend python scripts/set_recording_policy.py \
        --policy always --kind audio --all-active

Options:
    --policy {off,on_request,always}   required
    --kind   {audio,composite,track}   optional; leave unset to keep each room's
    --all-active                        every non-archived room
    --room <uuid>                       one room (repeatable)
    --dry-run                           report, write nothing
    --actor <name>                      audit identity (default cli:<user>)

Same function as ``POST /admin/recording/policy``; every changed room gets an
``agent_events`` audit row (event_type=recording_policy_changed). Exit codes:
0 ok, 2 bad input, 1 database error.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import sys
from pathlib import Path

# Runs from /home/stable/server in the image (WORKDIR) or from server/ here.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _parse(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="set_recording_policy",
        description="Set rooms.recording_policy / recording_kind in bulk (design §8).",
    )
    parser.add_argument("--policy", required=True, choices=("off", "on_request", "always"))
    parser.add_argument("--kind", choices=("audio", "composite", "track"), default=None)
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--all-active", action="store_true", help="every non-archived room")
    scope.add_argument("--room", action="append", default=None, help="room id (repeatable)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--actor", default=None, help="audit identity")
    parser.add_argument("--json", action="store_true", help="print the summary as JSON")
    return parser.parse_args(argv)


async def _run(args: argparse.Namespace) -> int:
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.config import get_settings
    from app.services.recording_policy_admin import (
        PolicyChangeError,
        apply_recording_policy,
    )

    settings = get_settings()
    engine = create_async_engine(settings.database_url, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    actor = args.actor or f"cli:{os.environ.get('USER') or getpass.getuser() or 'operator'}"
    try:
        async with session_factory() as db:
            summary = await apply_recording_policy(
                db,
                policy=args.policy,
                kind=args.kind,
                room_ids=args.room,
                all_active=bool(args.all_active),
                actor=actor,
                via="cli",
                dry_run=bool(args.dry_run),
            )
    except PolicyChangeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    finally:
        await engine.dispose()

    if args.json:
        print(json.dumps(summary, indent=2, default=str))
        return 0
    verb = "would change" if summary["dry_run"] else "changed"
    print(
        f"policy={summary['policy']} kind={summary['kind'] or '(keep)'} "
        f"matched={summary['matched']} {verb}={summary['changed']} "
        f"unchanged={summary['unchanged']}"
    )
    for row in summary["rooms"]:
        prev = row["previous"]
        mark = "~" if (prev["policy"], prev["kind"]) != (row["policy"], row["kind"]) else "="
        print(
            f"  {mark} {row['room_id']}  {row.get('name') or ''}: "
            f"{prev['policy']}/{prev['kind']} -> {row['policy']}/{row['kind']}"
        )
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parse(argv)
    try:
        return asyncio.run(_run(args))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # database / config trouble
        print(f"error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
