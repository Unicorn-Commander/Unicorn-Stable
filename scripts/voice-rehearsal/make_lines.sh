#!/usr/bin/env bash
# Runs on a Mac (needs `say` and ffmpeg). Writes the six rehearsal lines as
# 16 kHz mono 16-bit WAVs, the format voice_probe.py expects.
# usage: make_lines.sh <out dir>
set -euo pipefail
OUT="${1:?usage: make_lines.sh <out dir>}"; mkdir -p "$OUT"
line() { say -v Samantha -o "$OUT/$1.aiff" "$2" && ffmpeg -nostdin -loglevel error -y -i "$OUT/$1.aiff" -ar 16000 -ac 1 -sample_fmt s16 "$OUT/$1.wav" && rm -f "$OUT/$1.aiff"; }
line 01-name-grok   "Grok, in one sentence, what is the point of a rehearsal?"
line 02-followup    "And why does that matter for a live show?"
line 03-name-zen    "Zen, tell me one thing you would change about tonight's plan."
line 04-unaddressed "Does anyone know what time it is right now?"
line 05-bargein     "Stop. Hold on, I need to interrupt you for a second."
line 06-name-shox   "Shox, what is two plus two?"
ls -la "$OUT"
