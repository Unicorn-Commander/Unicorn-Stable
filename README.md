# Stable

Stable is a web application with a FastAPI server, a React web client, LiveKit calls, room-scoped agents, and optional integrations (`server/`, `web/`, `agents/`, `docker-compose.selfhost.yml`).

## Quick start

The quick start runs from this checkout and uses the bundled sign-in server.

Requirements are Bash, coreutils, Docker with a running daemon, and the Docker Compose plugin (`install.sh`).

```bash
./install.sh
```

The installer asks for the browser address and the first Stable user's name and email, writes `.env`, renders the service configuration, starts `docker-compose.selfhost.yml`, and waits for backend `/live`, backend `/health`, and the web root (`install.sh`).

By default, the installer starts the bundled Keycloak OIDC service and imports its realm, clients, and first user; Stable has no local-account mode (`install.sh`).

To use an existing Keycloak service, pass `--no-keycloak`, `--keycloak-url`, and the other `--keycloak-*` options shown by `./install.sh --help` (`install.sh`).

Use `./install.sh --env-only` to write `.env` and rendered configuration without starting Compose (`install.sh`).

The installer preserves existing values in an installer-managed `.env` when it is run again (`install.sh`).

## Services

The self-host Compose file defines PostgreSQL, Redis, LiveKit, the backend, and the web client, with bundled Keycloak and the agent runtime enabled through Compose profiles (`docker-compose.selfhost.yml`).

The web service serves the client and proxies `/api`, `/ws`, and bundled `/auth` paths (`docker-compose.selfhost.yml`).

The backend applies Alembic migrations at startup and exposes liveness and readiness checks used by the installer (`docker-compose.selfhost.yml`, `server/app/main.py`).

## Application behavior

- Rooms use `channel`, `group_dm`, `dm`, and server-created `agent_hub` types; channels can be public or private, and threads are child rooms (`server/app/models/room.py`, `server/app/services/room_service.py`).
- Home uses a composer-first layout, Crew rows, seat settings, populated attention zones, live-call data, and a Today block (`web/src/components/Home/HomeDashboard.tsx`, `server/app/api/home.py`, `server/app/api/crew.py`).
- A runner seat can have a per-conversation model and effort setting stored in `metadata.seats[agent_id]` (`web/src/lib/seatSettings.ts`, `server/app/services/room_class.py`).
- Calls can carry human tracks and, when enabled, an agent face published as a LiveKit camera track (`agents/agent_runtime/puppet_video.py`, `agents/voice_relay/agent.py`).
- Room recording supports `off`, `on_request`, and `always` policies, audio or composite manual capture, a recorder entitlement, a recordings list, and presigned downloads (`server/app/services/recording_policy.py`, `server/app/api/recording.py`).
- Transcript exports and recording handoff can use the optional Meeting-Ops integration through durable outbox paths (`server/app/api/transcripts.py`, `server/app/services/meeting_ops.py`, `server/app/services/call_recording.py`).
- Owners can create one-participant OBS broadcast credentials with camera or screen sources and optional audio; room members see the active-feed consent surface and viewer counts (`server/app/api/broadcast.py`, `web/src/lib/broadcast.ts`).
- Agent gateway keys support room allowlists, `@member` scope, explicit expiry choices, and explicit history floors (`server/app/api/gateway.py`, `server/app/auth/gateway_auth.py`).

## Source layout

- `server/` contains the FastAPI application, models, schemas, services, and Alembic migrations.
- `web/` contains the React client and browser API client.
- `agents/` contains the optional agent runtime and voice relay.
- `docker-compose.selfhost.yml` contains the self-host service graph.
- `deploy/per-org/` contains the one-deployment-per-organization provisioning path (`deploy/per-org/provision-org.sh`).

## Further documentation

- [Current status](STATUS.md) lists implemented behavior and the remaining gaps.
- [Architecture](ARCHITECTURE.md) maps components and flows to source files.
- [Usage conventions](docs/stable-usage-conventions.md) describes room, agent, recording, and broadcast choices.
- [Changelog](CHANGELOG.md) lists dated changes with their commit subjects.

## License

The repository is licensed under the GNU Affero General Public License v3.0 (`LICENSE`).
