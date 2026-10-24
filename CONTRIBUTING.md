# Contributing to Unicorn Stable

Issues and pull requests are welcome.

## What to keep configurable

Realm names, hostnames, voice endpoints, TURN, and other per-deployment facts belong in environment variables. [`.env.example`](.env.example) is the list. Do not hard-code a host, a customer, or a secret. That boundary is what lets one image run in more than one place.

Do not commit a real `.env`, a gateway key, or a LiveKit secret. Use `<placeholder>` values in examples.

## Tests and lint

Web, from `web/`:

```bash
npm install
npm run lint
npm run test:unit
npm run build
```

`npm run test:unit` is Vitest. There is no `npm test` script. End-to-end tests are `npx playwright test` (see `playwright.config.ts`). The config starts the Vite dev server.

API, from `server/`:

```bash
python -m pip install -e . pytest pytest-asyncio
pytest
```

`server/pyproject.toml` also documents `uv sync --group dev`. Pytest is set to `asyncio_mode = auto` and collects `tests`.

Agent workers, from `agents/`:

```bash
python -m pip install -e . pytest
pytest
```

## Running a change

[`./install.sh`](install.sh) is the full stack. For a single process, the commands are in the README under [Run from source](README.md#run-from-source). Auth is Keycloak. There is no local-account switch.

## Licence

Contributions are made under the Apache License 2.0, the same licence as the repository (see [LICENSE](LICENSE)). By opening a pull request you confirm you wrote the change or have the right to submit it under that licence.
