#!/usr/bin/env bash
# Runs ON the Stable host (bigboy). Plays rehearsal lines into a room as a
# synthetic human, samples egress/agents/livekit CPU every 5 s, then dumps the
# relay log, the voice_dispatch decisions, the chat lines and the room's
# recordings into an evidence folder.
#
# usage: run_rehearsal.sh <lines dir> [wav ...]
#   env ROOM            LiveKit room name   (default stable-voice-rehearsal-0924)
#   env PROBE_IDENTITY  a HUMAN identity: <username>_<participant uuid>; the relay
#                       drops anything else as unattributed
#   env GAP             seconds of silence between lines (default 14)
#   env OUT             evidence folder (default ~/stable-rehearsal/evidence-<utc>)
# With no wavs, all six lines play in the order the rehearsal was designed for.
set -uo pipefail
LINES="${1:?usage: run_rehearsal.sh <lines dir> [wav ...]}"; shift
ROOM="${ROOM:-stable-voice-rehearsal-0924}"
PROBE_IDENTITY="${PROBE_IDENTITY:?set PROBE_IDENTITY=<username>_<participant uuid>}"
GAP="${GAP:-14}"
OUT="${OUT:-$HOME/stable-rehearsal/evidence-$(date -u +%Y%m%dT%H%M%SZ)}"; mkdir -p "$OUT"
[ $# -gt 0 ] || set -- 01-name-grok.wav 02-followup.wav 03-name-zen.wav 04-unaddressed.wav 06-name-shox.wav 05-bargein.wav
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "start=$START room=$ROOM out=$OUT"
HERE="$(cd "$(dirname "$0")" && pwd)"
docker exec stable-agents mkdir -p /tmp/rehearsal
docker cp "$HERE/voice_probe.py" stable-agents:/tmp/rehearsal/voice_probe.py
WAVS=()
for w in "$@"; do docker cp "$LINES/$w" stable-agents:/tmp/rehearsal/"$w"; WAVS+=("/tmp/rehearsal/$w"); done
( while true; do docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' stable-egress stable-agents stable-livekit 2>/dev/null | sed "s/^/$(date -u +%H:%M:%S) /"; sleep 5; done ) > "$OUT/stats.log" 2>&1 &
STATS=$!
docker exec -e PROBE_IDENTITY="$PROBE_IDENTITY" -e PROBE_TAIL_SECONDS=75 stable-agents \
  python3 /tmp/rehearsal/voice_probe.py "$ROOM" "$GAP" "${WAVS[@]}" 2>&1 | tee "$OUT/probe.log"
kill $STATS 2>/dev/null
sleep 25
echo "== relay log"
docker logs stable-agents --since "$START" 2>&1 \
  | grep -E "voice_relay_(started|heard_addressed|heard_not_addressed|heard_but_unattributed|address_near_miss|cast_dispatch|persona_dispatch|floor_handed_over|cast_dispatch_failed|floor_unavailable|spoke|interrupted|reply_cut|queued|gate_target|talk_gate|own_stt_failed|ears_failed)|voice_dispatch|voice_floor|floor_" \
  | grep -v '"message"' | cut -c1-330 | tee "$OUT/relay.log" | tail -60
cat > "$OUT/evidence.sql" <<SQL
\\echo == egress rows
select left(id::text,8), kind, status, created_at, started_at, ended_at, file_path, file_size_bytes, duration_seconds, left(coalesce(error,''),120), handoff_status from call_egresses where livekit_room_name='$ROOM' order by created_at desc limit 5;
\\echo == dispatch events
select occurred_at, agent_identity, left(event_data::text,260) from agent_events where event_type='voice_dispatch' and occurred_at >= '$START' order by occurred_at;
\\echo == chat lines
select m.created_at, m.content_type, p.username, p.participant_type, left(m.content,140), m.metadata->>'via' from messages m join rooms r on r.id=m.room_id left join participants p on p.id=m.sender_id where r.livekit_room_name='$ROOM' and m.created_at >= '$START' order by m.created_at;
SQL
# No `-i` on docker exec: stdin is the file, and -i inside an ssh heredoc eats the rest of a script.
docker cp "$OUT/evidence.sql" stable-postgres:/tmp/rehearsal-evidence.sql
docker exec stable-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -A -f /tmp/rehearsal-evidence.sql; rm -f /tmp/rehearsal-evidence.sql' | tee "$OUT/evidence.txt"
echo "== stats peak"; sort -k3 -t' ' -rn "$OUT/stats.log" | head -3; echo "out=$OUT"
