# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub on this repository:

[https://github.com/Unicorn-Commander/Unicorn-Stable/security/advisories/new](https://github.com/Unicorn-Commander/Unicorn-Stable/security/advisories/new)

This repository does not publish a `security@` address. Please do not open a public GitHub issue for a security report.

Include what you can:

- The affected component (`server`, `web`, `agents`, or a file under `tools/`)
- A version or git revision
- The steps you ran, with secrets replaced by `<placeholder>`
- The impact you observed

Do not include live tokens, passwords, `.env` files, gateway keys, or broadcast tokens.

## What the software already enforces

These are properties of this tree, not a promise about a particular deployment:

- In production the API refuses to start when `LIVEKIT_API_SECRET` is unset or still the built-in default (`server/app/main.py`).
- Gateway keys are stored as a SHA-256 hash. The raw key is returned once at mint. An expired or revoked key is rejected (`server/app/auth/gateway_auth.py`).
- Broadcast links are credentials. The server stores a hash, returns the raw token once, and revoke takes effect immediately (`server/app/api/broadcast.py`).
- Guest links expire, and a reaper drops expired guest publishers from LiveKit.

A stock self-host install (`./install.sh`, `docker-compose.selfhost.yml`) does not pass `GATEWAY_ENABLED`. The code default is false, so gateway message routes answer 404 until an operator turns the flag on and forwards it into the backend container. `GET /api/v1/gateway/health` reports the flag.
