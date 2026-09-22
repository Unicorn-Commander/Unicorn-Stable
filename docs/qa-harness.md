# QA Harness — Stable UX L9

**Task:** P-00115 (4d385ecf-368b-4e89-ac54-1fe8c6be2622)  
**Branch:** feat/ux-l9-qa-rebased  
**Author:** nemotron-3-ultra-free (free OpenCode), rebased onto integ/ux-north-star-20260922  
**Date:** 2026-09-21

---

## Overview

This harness provides automated visual regression and accessibility testing for the Stable web app. It captures 12 primary surfaces at two viewport sizes (390×844 mobile, 1440×900 desktop), runs axe-core accessibility sweeps, and establishes the first component test pattern with vitest + @testing-library/react.

All tests run headless against the Vite dev server using the repo's dev-mode mock user (no Keycloak required).

---

## Quick Start

```bash
cd web
npm ci
npm run dev -- --host 127.0.0.1 --port 5173   # one terminal
npx playwright test                           # another; reuses that server
```

The harness pins port 5173 (`web/playwright.config.ts`). Vite's own default in this repo is 3000. A fresh browser on `/` sees the marketing iframe first; the suite posts `stable:enter` so AuthGate can seed the dev mock user. Do not point the suite at `vite preview`: production mode does not seed that user.

Playwright does not wait for `networkidle`. The dev server's HMR socket never goes idle.

Artifacts: `web/test-results/*.png` (screenshots), `web/playwright-report/` (HTML report).

---

## Surfaces Captured (12 × 2 viewports = 24 images)

| Surface | Route / Trigger | Selector |
|---------|-----------------|----------|
| Home | `/` | `[data-testid="home-dashboard"]` |
| Direct List | `/` + nav "Chats" | `[data-testid="conversations-card"]` |
| Agent Chat | `/c/room-general` | `[data-testid="room-view"]` |
| DM | `/c/room-dm-jason` | `[data-testid="room-view"]` |
| Group | `/c/room-ops` | `[data-testid="room-view"]` |
| Public Channel | `/c/room-general` | `[data-testid="room-view"]` |
| Agents Page | `/agents` | `[data-testid="agents-page"]` |
| Settings | `/` + Settings (`open-settings`; phone uses the sidebar footer) | `[data-testid="settings-modal"]` |
| New Chat | `/` + New room (`new-room-button` on the home greeting; the sidebar New chat control is hidden on Home) | `[data-testid="create-room-modal"]` |
| Call View Grid + Chat Docked | `/c/room-general` + viewMode=grid, chatCollapsed=false | `[data-testid="call-room-layout"]` |
| Call View Grid + Chat Hidden | `/c/room-general` + viewMode=grid, chatCollapsed=true | `[data-testid="call-room-layout"]` |
| People Drawer | `/` + People button | `[data-testid="people-drawer"]` |
| Search | `/` + Ctrl+Shift+F (same handler as ⌘⇧F) | `[data-testid="global-search-modal"]` |

Each capture asserts:
- Zero console errors and failed requests emitted after the surface has settled. The dev server has no API, so React Query's load-time 404s are not part of this check.
- Zero broken images (`complete && naturalWidth === 0`). An image that has not finished loading is not counted.
- No horizontal page scroll (`documentElement.scrollWidth` vs `clientWidth`).
- Mobile touch targets under 44×44 are logged, not failed. Many real controls are still smaller; that is a product finding, not a harness failure.

axe-core critical and serious violations are logged and attached. They do not fail the test.

---

## CI: `.forgejo/workflows/ci.yml`

A new job `web-e2e` runs on the `legacy1` runner (Docker-in-Docker sandbox). It installs the same way the `web` job does: checkout, `actions/setup-node` Node 22, `npm ci --no-audit --no-fund`. Neither job uses `actions/cache` — the job container is discarded. Chromium and its apt libraries are installed inside that container (`npx playwright install --with-deps chromium`). `npm run build` is the typecheck and bundle gate. `npx playwright test` then starts the Vite dev server on port 5173 itself.

```yaml
web-e2e:
  runs-on: legacy1
  steps:
    - checkout
    - setup-node (Node 22)
    - npm ci
    - npx playwright install --with-deps chromium
    - npm run build
    - npx playwright test --reporter=html
    - upload playwright-report artifact (7 days)
    - upload test-results screenshots artifact (7 days)
```

### How to Read the Job Log

1. Open the Forgejo Actions tab → click the `web-e2e` job for your push/PR.
2. The **test list** shows each surface × viewport combination (e.g., `Home @ mobile`, `Home @ desktop`).
3. Click a failed test to see:
   - Console errors / failed requests
   - Screenshot diff (if using visual regression)
   - axe-core violations (logged to console, attached as `axe-results.json`)
4. Download the `playwright-report` artifact for the full HTML report with traces.
5. Download the `playwright-screenshots` artifact for raw PNGs.

> **Tip:** A task log is ONE job. Identify the job by its name (`web-e2e`) and run number before reading its result.

---

## Accessibility Sweep (axe-core)

- Runs on every surface in both viewports
- **Reports only** (does not gate CI in v1)
- Violations with `impact: critical` or `serious` are logged to console and attached to the test as `axe-results.json`
- View in CI: Click a test → Attachments → `axe-results.json`

---

## Component Tests: vitest + @testing-library/react

First component test established for `web/src/components/ui/Avatar.tsx`:

```bash
cd web
npm run test:unit  # runs all vitest tests including Avatar.test.tsx
```

**Pattern:**
- Mock `lib/avatar.ts` resolution (`resolveAvatar`)
- Mock `window.getComputedStyle` + `matchMedia` in `vitest.setup.ts`
- Test image/emoji/initials fallback, sizes, ring, rounding, alt, className, privacy attrs
- 19 tests, all passing

**Files:**
- `web/vitest.config.ts` — jsdom environment, React plugin, setup file
- `web/vitest.setup.ts` — @testing-library/jest-dom, mocks
- `web/src/components/ui/__tests__/Avatar.test.tsx` — test suite

---

## uishot Login Profile (Ad-Hoc Captures)

For manual/one-off captures outside CI, use the **uishot** tool with the `stable` profile. No secrets stored.

### Profile Recipe

```json
{
  "name": "stable",
  "url": "http://localhost:3000",
  "viewport": { "width": 1440, "height": 900 },
  "waitFor": "[data-testid=\"app-shell\"]",
  "actions": [
    { "type": "wait", "ms": 1000 }
  ],
  "output": "./uishot-captures/"
}
```

### Usage

```bash
# Terminal 1: start dev server (uses dev mock user)
cd web && npm run dev

# Terminal 2: capture all surfaces
npx uishot capture --profile stable --all

# Or capture a specific surface
npx uishot capture --profile stable --selector '[data-testid="home-dashboard"]' --out home-desktop.png
```

### Mobile Capture

```json
{
  "name": "stable-mobile",
  "extends": "stable",
  "viewport": { "width": 390, "height": 844 }
}
```

```bash
npx uishot capture --profile stable-mobile --all
```

> **No credentials needed.** The dev-mode mock user (Aaron Stransky, `dev-user-001`) is seeded automatically by `AuthGate` when `VITE_KEYCLOAK_URL` is unset and `import.meta.env.DEV === true`. See `web/src/App.tsx:127-259`.

---

## Gates (Local Verification)

Run all gates before pushing:

```bash
cd web
npm ci
npx tsc --noEmit          # TypeScript typecheck
npm run test:unit         # vitest (815 tests)
npx playwright test       # e2e (24 captures + a11y)
```

All must pass. If a gate cannot run here, the failure reason is printed explicitly.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `webServer` timeout in Playwright | Ensure `npm run dev` is running on port 3000 before `npx playwright test` |
| `isAuthenticated()` false in tests | Dev mock user only seeds in `AuthGate` — tests must navigate to `/` first |
| axe-core violations noise | Expected in v1 — violations are reported, not gated |
| Flaky mobile touch-target check | Only warns; does not fail. Adjust component padding if needed. |
| `legacy1` runner unavailable | Job will queue. Ensure runner is registered in Forgejo Actions. |

---

## Files Added/Modified

```
web/
├── playwright.config.ts
├── vitest.config.ts
├── vitest.setup.ts
├── e2e/
│   └── surfaces.spec.ts
├── src/
│   ├── components/
│   │   ├── ui/__tests__/Avatar.test.tsx
│   │   ├── Layout/
│   │   │   ├── AppShell.tsx           (+ data-testid="app-shell")
│   │   │   ├── Header.tsx             (+ data-testid="open-people", "open-settings")
│   │   │   └── SettingsModal.tsx      (+ data-testid="settings-modal")
│   │   ├── Sidebar/
│   │   │   ├── ViewSwitcher.tsx       (+ data-testid="nav-*")
│   │   │   ├── NewChatButton.tsx      (+ data-testid="new-room-button")
│   │   │   └── CreateRoomModal.tsx    (+ data-testid="create-room-modal")
│   │   ├── Home/
│   │   │   ├── HomeDashboard.tsx      (+ data-testid="home-dashboard")
│   │   │   └── widgets/ConversationsCard.tsx (+ data-testid="conversations-card")
│   │   ├── Agents/AgentsPage.tsx      (+ data-testid="agents-page")
│   │   ├── Room/
│   │   │   ├── RoomView.tsx           (+ data-testid="room-view")
│   │   │   └── CallRoomLayout.tsx     (+ data-testid="call-room-layout")
│   │   └── Layout/
│   │       ├── PeopleDrawer.tsx       (+ data-testid="people-drawer")
│   │       └── GlobalSearchModal.tsx  (+ data-testid="global-search-modal")
└── package.json                       (+ playwright, axe-core, testing-library deps)

.forgejo/workflows/ci.yml              (+ web-e2e job)

docs/
└── qa-harness.md                      (this file)
```

---

## Next Steps (v2+)

- Visual regression with pixel diff (baseline images in repo)
- Gate axe-core critical/serious violations
- Add more component tests (Button, Input, Modal, etc.)
- Integrate with Project-Ops for automatic result posting
- Mobile-specific test matrix (safe areas, keyboard, orientation)

---

*Generated as part of L9 QA harness delivery for P-00115.*