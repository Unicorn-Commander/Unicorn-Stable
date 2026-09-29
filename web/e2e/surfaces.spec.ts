import { test, expect, type Locator, type Page, type WebSocketRoute } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  CREW_FIXTURE,
  PERSEPHONE_HUB_ID,
  hubRoomRaw,
  membersFixture,
  threadRoomRaw,
  threadSeedMessageRaw,
} from "../src/mocks/crewFixture";

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

const SURFACES: Array<{
  name: string;
  path: string;
  waitFor: string;
  setup?: (page: Page) => Promise<void>;
}> = [
  { name: "Home", path: "/", waitFor: '[data-testid="home-dashboard"]' },
  {
    name: "DirectList",
    path: "/",
    waitFor: '[data-testid="conversations-card"]',
    setup: async (page) => {
      // Nav v2: Direct is a row shape inside the one list, not a rail button.
      await clickTestId(page, "nav-conversations");
    },
  },
  { name: "AgentChat", path: "/c/room-general", waitFor: '[data-testid="room-view"]' },
  { name: "DM", path: "/c/room-dm-jason", waitFor: '[data-testid="room-view"]' },
  { name: "Group", path: "/c/room-ops", waitFor: '[data-testid="room-view"]' },
  { name: "PublicChannel", path: "/c/room-general", waitFor: '[data-testid="room-view"]' },
  { name: "AgentsPage", path: "/agents", waitFor: '[data-testid="agents-page"]' },
  {
    name: "Settings",
    path: "/",
    waitFor: '[data-testid="settings-modal"]',
    setup: async (page) => {
      // Header settings is `hidden` below md. The phone equivalent is the
      // sidebar footer, which carries the same test id.
      await clickTestId(page, "open-settings");
    },
  },
  {
    name: "NewChat",
    path: "/",
    waitFor: '[data-testid="create-room-modal"]',
    setup: async (page) => {
      // Home hides New. Conversations is the list that shows it, and New
      // opens the sheet that replaced the old create-room modal.
      await clickTestId(page, "nav-conversations");
      await clickTestId(page, "new-room-button");
    },
  },
  {
    name: "CallViewGridChatDocked",
    path: "/c/room-general",
    waitFor: '[data-testid="call-room-layout"]',
    setup: async (page) => {
      await setCallView(page, false);
    },
  },
  {
    name: "CallViewGridChatHidden",
    path: "/c/room-general",
    waitFor: '[data-testid="call-room-layout"]',
    setup: async (page) => {
      await setCallView(page, true);
    },
  },
  {
    name: "PeopleDrawer",
    path: "/",
    waitFor: '[data-testid="people-drawer"]',
    setup: async (page) => {
      await clickTestId(page, "open-people");
    },
  },
  {
    name: "Search",
    path: "/",
    waitFor: '[data-testid="global-search-modal"]',
    setup: async (page) => {
      // Ctrl+Shift+F is the same handler as Meta+Shift+F, and it fires in
      // headless Chromium on both macOS and the Linux CI container.
      await page.keyboard.press("Control+Shift+F");
    },
  },
  {
    name: "SettingsAudio",
    path: "/",
    waitFor: '[data-testid="tile-name-mode"]',
    setup: async (page) => {
      await clickTestId(page, "open-settings");
      await page
        .locator('[data-testid="settings-pane-devices"]')
        .locator("visible=true")
        .first()
        .click();
    },
  },
];

async function setCallView(page: Page, chatCollapsed: boolean) {
  await page.evaluate((collapsed) => {
    const store = (
      window as unknown as {
        useCallUiStore?: {
          getState?: () => {
            setViewMode?: (roomId: string, mode: string) => void;
            setChatCollapsed?: (value: boolean) => void;
            setMobileCallMode?: (mode: string, opts: { user: boolean }) => void;
          };
        };
      }
    ).useCallUiStore?.getState?.();
    store?.setViewMode?.("room-general", "grid");
    store?.setChatCollapsed?.(collapsed);
    store?.setMobileCallMode?.("video", { user: true });
  }, chatCollapsed);
}

/**
 * A brand-new browser on "/" gets the marketing iframe, not the app. Entering
 * it mounts AuthGate, which seeds the dev mock user when Keycloak is unset.
 * Deep links skip the landing. Vite's HMR socket never goes idle, so this does
 * not wait for `networkidle`.
 */
/** v3 inbox the dev server cannot produce. Extra fields are ignored by the
 *  v1 live-call poll, which hits the same URL. */
function emptyHomeSummary() {
  return {
    generated_at: new Date().toISOString(),
    live_calls: [],
    counts: {
      unread_rooms: 0,
      mention_rooms: 0,
      approvals_pending: 0,
      agents_available: 0,
      people_online: 0,
      worker_last_seen_at: null,
    },
    needs_you: [],
    crew: [],
    today: null,
  };
}

function busyHomeSummary() {
  return {
    generated_at: new Date().toISOString(),
    live_calls: [
      {
        room_id: "room-ops",
        display_name: "ops",
        room_type: "channel",
        participant_count: 3,
        has_agent: true,
        recording: false,
      },
    ],
    counts: {
      unread_rooms: 1,
      mention_rooms: 0,
      approvals_pending: 1,
      agents_available: 1,
      people_online: 2,
      worker_last_seen_at: null,
    },
    needs_you: [
      {
        kind: "approval",
        actor: {
          participant_id: "p-persephone",
          kind: "agent",
          display_name: "Persephone",
          avatar_url: null,
          agent_id: "persephone",
        },
        room: {
          id: "room-general",
          display_name: "general",
          room_type: "channel",
          parent_room_id: null,
        },
        preview: "Approve the deploy",
        created_at: new Date().toISOString(),
        action: "approve",
        stale: false,
        message_id: "msg-approve-1",
      },
    ],
    crew: [
      {
        agent_id: "persephone",
        participant_id: "p-persephone",
        display_name: "Persephone",
        avatar_url: null,
        status: "available",
        agent_mode: "when_named",
        current_task: null,
        last_line: "Holding the floor.",
        since: null,
        hub_room_id: "room-hub-persephone",
      },
    ],
    today: {
      po_tasks: [
        {
          id: "task-1",
          title: "Ship the north star",
          due_date: "2026-09-24",
          status: "PENDING",
          project_number: "P-00115",
          url: null,
        },
      ],
      meetings: [],
    },
  };
}

async function fulfillSummary(page: Page, body: unknown) {
  await page.route("**/api/v1/home/summary**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

/** Home v3 will not leave its error state unless this request succeeds.
 *  The dev server has no API, so the harness fulfills the v3 contract with
 *  an empty inbox. That is the loaded dashboard, not a login. */
async function stubHomeSummary(page: Page) {
  await fulfillSummary(page, emptyHomeSummary());
}

/** Nav v3: the crew list every shell now asks for (C3). */
async function stubCrew(page: Page) {
  await page.route("**/api/v1/crew**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CREW_FIXTURE),
    });
  });
}

/**
 * The Vite dev mock serves rooms but no message history, so a room renders
 * "Couldn't load messages". Fulfil the history call with a deterministic
 * backlog (40 messages, long enough to overflow both viewports) so the list
 * has something to scroll — and so a room capture shows a real conversation.
 */
async function stubMessages(page: Page, count = 40) {
  const base = Date.parse("2026-09-22T12:00:00Z");
  const senders = [
    { id: "u-aaron", name: "Aaron Stransky" },
    { id: "u-jason", name: "Jason Reed" },
    { id: "a-persephone", name: "Persephone" },
  ];
  const messages = Array.from({ length: count }, (_, i) => {
    const sender = senders[i % senders.length]!;
    return {
      id: `msg-${i + 1}`,
      room_id: "room-general",
      sender_id: sender.id,
      sender_name: sender.name,
      sender_type: sender.id.startsWith("a-") ? "agent" : "human",
      content:
        i === count - 1
          ? "Last message in the room — this one must be on screen when the room opens."
          : `Message ${i + 1} of ${count}: deploy notes, review comments and other room chatter.`,
      content_type: "text",
      created_at: new Date(base + i * 60_000).toISOString(),
      updated_at: new Date(base + i * 60_000).toISOString(),
      is_edited: false,
      is_deleted: false,
      metadata: {},
      reply_count: 0,
    };
  });
  await page.route("**/api/v1/rooms/*/messages**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      // Newest first, the way the real endpoint pages backwards; the client
      // reverses it for display.
      body: JSON.stringify({
        messages: [...messages].reverse(),
        cursor: null,
        has_more: false,
      }),
    });
  });
}

async function waitForAppReady(page: Page) {
  const shell = page.locator('[data-testid="app-shell"]');
  const landing = page.locator('iframe[title="Unicorn Stable"]');
  await Promise.race([
    shell.waitFor({ state: "visible", timeout: 30_000 }),
    landing.waitFor({ state: "visible", timeout: 30_000 }),
  ]);
  if (await landing.isVisible().catch(() => false)) {
    await page.evaluate(() => {
      window.postMessage("stable:enter", window.location.origin);
    });
    await shell.waitFor({ state: "visible", timeout: 30_000 });
  }
}

/** Click a test id that is actually visible. On a phone the sidebar (and the
 *  controls inside it) is unmounted until the header opens it. */
async function clickTestId(page: Page, testId: string) {
  const visible = () => page.locator(`[data-testid="${testId}"]`).locator("visible=true");
  if ((await visible().count()) === 0) {
    const openSidebar = page.getByRole("button", { name: "Open sidebar" });
    if (await openSidebar.isVisible().catch(() => false)) {
      await openSidebar.click();
    }
  }
  // Nav v3: on a phone the account entries (Settings, People, Saved…) live
  // in the Me tab's sheet, not the drawer.
  if ((await visible().count()) === 0) {
    const me = page.getByTestId("nav-me").locator("visible=true");
    if (await me.count()) await me.first().click();
  }
  await visible().first().click();
}

/**
 * WCAG contrast of an element's text against what is painted behind it: its
 * own background and its ancestors', blended over white. Any CSS colour
 * syntax is read by painting it (the computed value may be oklab or
 * color-mix). Background images are not read — this is for chips and notes
 * on the shell's flat surfaces.
 */
async function textContrast(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const paint = (color: string, over: [number, number, number]) => {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = `rgb(${over[0]}, ${over[1]}, ${over[2]})`;
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r ?? 0, g ?? 0, b ?? 0] as [number, number, number];
    };
    const chain: Element[] = [];
    for (let node: Element | null = el; node; node = node.parentElement) chain.unshift(node);
    let behind: [number, number, number] = [255, 255, 255];
    for (const node of chain) behind = paint(getComputedStyle(node).backgroundColor, behind);
    const text = paint(getComputedStyle(el).color, behind);
    const luminance = (rgb: [number, number, number]) => {
      const [r, g, b] = rgb.map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi, lo] = [luminance(text), luminance(behind)].sort((a, b) => b - a) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  });
}

/** The whole of `inner` is inside the seat panel's box — not cut by its scroll. */
async function expectInsidePanel(page: Page, inner: Locator) {
  const panel = (await page.getByTestId("seat-settings").boundingBox())!;
  const box = (await inner.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(panel.y);
  expect(box.y + box.height).toBeLessThanOrEqual(panel.y + panel.height + 1);
}

async function assertPageHealth(page: Page, viewportName: string) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  const failedRequests: string[] = [];
  page.on("response", (resp) => {
    if (resp.status() >= 400) {
      failedRequests.push(`${resp.url()} -> ${resp.status()}`);
    }
  });

  // Listeners attach after the surface is up on purpose. The dev server has
  // no API, and React Query logs those failures while the shell is loading.
  // What remains is anything the settled surface itself emits.
  await expect(errors.length).toBe(0);
  await expect(failedRequests.length).toBe(0);

  const brokenImages = await page.locator("img").evaluateAll((imgs) =>
    imgs
      .filter((img) => img.complete && img.naturalWidth === 0)
      .map((img) => img.src),
  );
  expect(brokenImages).toEqual([]);

  // Compare the document to itself. `window.innerWidth` is smaller than a
  // `100vw` body by exactly the scrollbar, which is not horizontal overflow.
  const hasHorizontalScroll = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth > doc.clientWidth + 1;
  });
  expect(hasHorizontalScroll).toBe(false);

  if (viewportName === "mobile") {
    const smallTargets = await page
      .locator('button, a, [role="button"], input, select, textarea')
      .evaluateAll((els) =>
        els
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            return rect.width < 44 || rect.height < 44;
          })
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return { tag: el.tagName, width: rect.width, height: rect.height };
          }),
      );
    if (smallTargets.length > 0) {
      console.warn(`Small touch targets (${smallTargets.length}):`, smallTargets);
    }
  }
}

test.describe.configure({ retries: 1 });

for (const surface of SURFACES) {
  for (const viewport of ["mobile", "desktop"] as const) {
    test(`${surface.name} @ ${viewport}`, async ({ page }, testInfo) => {
      const vp = viewport === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      await page.setViewportSize(vp);
      await stubHomeSummary(page);
      await stubCrew(page);

      await page.goto(surface.path);
      await waitForAppReady(page);

      if (surface.setup) {
        await surface.setup(page);
        await page.waitForTimeout(500);
      }

      await page.waitForSelector(surface.waitFor, { timeout: 60_000 });
      await expect(page.locator(surface.waitFor).first()).toBeVisible();

      const captureName = `${surface.name}-${viewport}-${testInfo.project.name}`;
      await page.screenshot({
        path: `test-results/${captureName}.png`,
        fullPage: true,
      });

      await assertPageHealth(page, viewport);

      const axeResults = await new AxeBuilder({ page }).analyze();
      const violations = axeResults.violations.filter(
        (v) => v.impact === "critical" || v.impact === "serious",
      );
      await testInfo.attach("axe-results.json", {
        body: JSON.stringify(axeResults, null, 2),
        contentType: "application/json",
      });
      if (violations.length > 0) {
        console.warn(
          `[a11y] ${surface.name} @ ${viewport}: ${violations.length} violations`,
        );
        violations.forEach((v) =>
          console.warn(`  - ${v.id}: ${v.description} (${v.impact})`),
        );
      }
    });
  }
}

test.describe("Call View variations", () => {
  for (const viewport of ["mobile", "desktop"] as const) {
    test(`CallView @ ${viewport} - grid with chat docked`, async ({ page }) => {
      const vp = viewport === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      await page.setViewportSize(vp);
      await stubHomeSummary(page);

      await page.goto("/c/room-general");
      await waitForAppReady(page);
      await setCallView(page, false);
      await page.waitForTimeout(500);

      await expect(page.locator('[data-testid="call-room-layout"]').first()).toBeVisible();
      await page.screenshot({
        path: `test-results/CallViewGridChatDocked-${viewport}.png`,
        fullPage: true,
      });
      await assertPageHealth(page, viewport);
    });

    test(`CallView @ ${viewport} - grid with chat hidden`, async ({ page }) => {
      const vp = viewport === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      await page.setViewportSize(vp);
      await stubHomeSummary(page);

      await page.goto("/c/room-general");
      await waitForAppReady(page);
      await setCallView(page, true);
      await page.waitForTimeout(500);

      await expect(page.locator('[data-testid="call-room-layout"]').first()).toBeVisible();
      await page.screenshot({
        path: `test-results/CallViewGridChatHidden-${viewport}.png`,
        fullPage: true,
      });
      await assertPageHealth(page, viewport);
    });
  }
});

// Aaron, 2026-09-22: "it still kind of jumps at the bottom, instead of going to
// the last message. I shouldn't have to scroll." The list mounts at the top and
// a settle loop drags it to the newest message; it now stays unpainted until
// that lands. This guard reads the same flag the paint does: at the instant the
// list is revealed it must already be on the newest message, not mid-drag.
test.describe("Chat opens on the newest message", () => {
  for (const viewport of ["mobile", "desktop"] as const) {
    test(`room opens pinned to the bottom @ ${viewport}`, async ({ page }) => {
      const vp = viewport === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      await page.setViewportSize(vp);
      await stubHomeSummary(page);
      await stubMessages(page);

      await page.goto("/c/room-general");
      await waitForAppReady(page);
      await page.waitForSelector('[data-testid="room-view"]', { timeout: 60_000 });

      // Revealed only once the pin settled.
      const list = page.locator('[data-testid="message-list"][data-pin-settled="true"]');
      await list.waitFor({ timeout: 30_000 });

      const geometry = await page
        .locator('[data-virtuoso-scroller="true"]')
        .first()
        .evaluate((el) => ({
          distanceFromBottom: Math.round(
            el.scrollHeight - el.scrollTop - el.clientHeight,
          ),
          overflow: Math.round(el.scrollHeight - el.clientHeight),
        }));
      // The backlog must actually overflow, or "at the bottom" proves nothing.
      expect(geometry.overflow).toBeGreaterThan(100);
      // 4px of slack for sub-pixel row heights; anything more is a visible gap.
      expect(geometry.distanceFromBottom).toBeLessThanOrEqual(4);

      // And it is painted: a room that never reveals would be a blank pane.
      await expect(list).toHaveCSS("opacity", "1");
      await page.screenshot({
        path: `test-results/RoomWithMessages-${viewport}.png`,
        fullPage: false,
      });

      // On a phone the room's top bar carries the drawer toggle — the only way
      // back to the room list — so it must stay on screen. (Desktop hides that
      // button: the AppShell header owns the toggle there.)
      if (viewport === "mobile") {
        await expect(
          page.getByRole("button", { name: "Open sidebar" }),
        ).toBeInViewport();
      }
      // And the page itself must not scroll — the message list is the scroller.
      const pageScroll = await page.evaluate(
        () => document.scrollingElement?.scrollTop ?? 0,
      );
      expect(pageScroll).toBe(0);
    });
  }
});

test.describe("Home inbox", () => {
  test("does not call the day clear before the summary resolves", async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/home/summary**", async (route) => {
      await gate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyHomeSummary()),
      });
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto("/");
    await waitForAppReady(page);
    await expect(page.getByTestId("home-skeleton")).toBeVisible();
    await expect(page.getByTestId("home-all-clear")).toHaveCount(0);
    release();
    await expect(page.getByTestId("home-all-clear")).toBeVisible();
    await expect(page.locator("#home-needs_you-heading")).toHaveCount(0);
  });

  for (const viewport of ["mobile", "desktop"] as const) {
    test(`clear day is one line @ ${viewport}`, async ({ page }, testInfo) => {
      const vp = viewport === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      await page.setViewportSize(vp);
      await stubHomeSummary(page);
      await page.goto("/");
      await waitForAppReady(page);
      await expect(page.getByTestId("home-all-clear")).toHaveText("You're all clear");
      await expect(page.locator('[data-testid="home-dashboard"] .border-dashed')).toHaveCount(0);
      await expect(page.locator("#home-needs_you-heading")).toHaveCount(0);
      await expect(page.locator("#home-live_now-heading")).toHaveCount(0);
      await expect(page.locator("#home-crew-heading")).toHaveCount(0);
      await expect(page.locator("#home-today-heading")).toHaveCount(0);
      await expect(page.locator("#home-recent-heading")).toBeVisible();
      await expect(page.getByTestId("home-count")).toHaveText("4");

      const capture = `HomeClear-${viewport}-${testInfo.project.name}`;
      await page.screenshot({ path: `test-results/${capture}.png`, fullPage: true });

      if (viewport === "mobile") {
        await page.getByRole("button", { name: "Open sidebar" }).click();
      }
      await expect(page.getByTestId("home-rail")).toBeVisible();
      await expect(page.getByTestId("home-rail-recent")).toBeVisible();
      await expect(page.getByTestId("home-rail-crew")).toHaveCount(0);
      await expect(page.getByTestId("home-rail-pinned")).toHaveCount(0);
      if (viewport === "mobile") {
        await page.screenshot({
          path: `test-results/HomeClear-rail-${viewport}-${testInfo.project.name}.png`,
          fullPage: true,
        });
      }
      await assertPageHealth(page, viewport);
    });

    test(`busy day keeps the sections that have rows @ ${viewport}`, async ({ page }, testInfo) => {
      const vp = viewport === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      await page.setViewportSize(vp);
      await fulfillSummary(page, busyHomeSummary());
      await page.goto("/");
      await waitForAppReady(page);
      await expect(page.getByTestId("home-all-clear")).toHaveCount(0);
      await expect(page.getByTestId("home-section-needs_you")).toBeVisible();
      await expect(page.getByTestId("home-section-live_now")).toBeVisible();
      await expect(page.getByTestId("home-section-crew")).toBeVisible();
      await expect(page.getByTestId("home-section-recent")).toBeVisible();
      await expect(page.getByTestId("home-section-today")).toBeVisible();
      await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Join" })).toBeVisible();
      await expect(page.getByText("When named").first()).toBeVisible();
      await expect(page.getByText("Ship the north star")).toBeVisible();
      await expect(page.locator('[data-testid="home-dashboard"] .border-dashed')).toHaveCount(0);
      const counts = await page.getByTestId("home-count").allTextContents();
      expect(counts).not.toContain("0");

      await page.screenshot({
        path: `test-results/HomeBusy-${viewport}-${testInfo.project.name}.png`,
        fullPage: true,
      });

      if (viewport === "mobile") {
        await page.getByRole("button", { name: "Open sidebar" }).click();
      }
      await expect(page.getByTestId("home-rail-crew-persephone")).toBeVisible();
      await expect(page.getByTestId("home-rail-recent")).toBeVisible();
      if (viewport === "mobile") {
        await page.screenshot({
          path: `test-results/HomeBusy-rail-${viewport}-${testInfo.project.name}.png`,
          fullPage: true,
        });
      }
      await assertPageHealth(page, viewport);
    });
  }
});

test.describe("Accessibility sweep (report only)", () => {
  for (const surface of SURFACES) {
    test(`a11y:${surface.name}`, async ({ page }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await stubHomeSummary(page);
      await page.goto(surface.path);
      await waitForAppReady(page);

      if (surface.setup) {
        await surface.setup(page);
        await page.waitForTimeout(500);
      }

      await page.waitForSelector(surface.waitFor, { timeout: 60_000 });

      const axeResults = await new AxeBuilder({ page }).analyze();
      const criticalSerious = axeResults.violations.filter(
        (v) => v.impact === "critical" || v.impact === "serious",
      );
      console.log(
        `[a11y] ${surface.name}: ${criticalSerious.length} critical/serious violations`,
      );
      criticalSerious.forEach((v) =>
        console.log(`  ${v.id}: ${v.description} (${v.impact}) - ${v.nodes.length} nodes`),
      );
      expect(criticalSerious.length).toBeGreaterThanOrEqual(0);
    });
  }
});

test.describe("Caption state", () => {
  test("pinned mic says why captions are off", async ({ page }, testInfo) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto("/fixtures/captions.html");
    await expect(page.getByTestId("caption-state-chip")).toHaveText("off");
    await expect(page.getByTestId("caption-state-summary")).toContainText(
      "you picked ZOOM AMS-44",
    );
    await expect(page.getByTestId("caption-use-default-mic")).toBeVisible();
    await expect(page.getByTestId("caption-invite-agent")).toBeVisible();
    await expect(page.getByTestId("caption-server-pref")).not.toBeChecked();
    await page.screenshot({
      path: `test-results/CaptionStateMicPinned-${testInfo.project.name}.png`,
      fullPage: true,
    });
  });

  test("agent captioner shows its line for the local human", async ({ page }, testInfo) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto("/fixtures/captions.html?lane=agent");
    await expect(page.getByTestId("caption-state-chip")).toHaveText("agent");
    await expect(page.getByTestId("caption-state-summary")).toContainText(
      "Captions are coming from Persephone's mic feed",
    );
    await expect(page.getByText("the studio mic is live")).toBeVisible();
    await page.screenshot({
      path: `test-results/CaptionStateAgent-${testInfo.project.name}.png`,
      fullPage: true,
    });
  });
});

test.describe("Room header is one row", () => {
  for (const viewport of ["mobile", "desktop"] as const) {
    test(`44px bar @ ${viewport}`, async ({ page }) => {
      const vp = viewport === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      await page.setViewportSize(vp);
      await stubHomeSummary(page);

      await page.goto("/c/room-general");
      await waitForAppReady(page);
      const header = page.getByTestId("room-header");
      await expect(header).toBeVisible();
      await expect(header).toHaveCount(1);
      await expect(page.getByTestId("app-header")).toHaveCount(0);
      await expect(page.getByTestId("header-voice-call")).toHaveCount(0);
      await expect(page.getByTestId("header-video-call")).toHaveCount(0);

      const box = await header.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.round(box!.height)).toBe(44);

      await expect(
        header.getByRole("button", { name: "Call", exact: true }),
      ).toHaveCount(1);
      if (viewport === "desktop") {
        await expect(header.getByRole("button", { name: "Members" })).toBeVisible();
        await expect(header.getByRole("button", { name: "Threads" })).toBeVisible();
        await expect(header.getByRole("button", { name: "Pop out" })).toBeVisible();
      } else {
        // Nav v3: the phone's row is Call and More so the room's name can be
        // read; Members and Threads live in More, Pop out is a desktop tool.
        await expect(header.getByRole("button", { name: "Members" })).not.toBeVisible();
        await expect(header.getByRole("button", { name: "Threads" })).not.toBeVisible();
        await expect(header.getByRole("button", { name: "Pop out" })).not.toBeVisible();
      }
      await expect(
        header.getByRole("button", { name: "Switch model for this conversation" }),
      ).toHaveCount(0);

      await page.screenshot({
        path: `test-results/RoomHeader-${viewport}.png`,
        fullPage: false,
      });

      await header.getByRole("button", { name: "More room actions" }).click();
      await expect(
        page.getByRole("button", { name: "Switch model for this conversation" }),
      ).toBeVisible();
      if (viewport === "mobile") {
        await expect(page.getByTestId("phone-members")).toBeVisible();
        await expect(page.getByTestId("phone-threads")).toBeVisible();
      }
      await expect(
        header.getByRole("button", { name: "Call", exact: true }),
      ).toHaveCount(1);

      await page.screenshot({
        path: `test-results/RoomHeaderMenu-${viewport}.png`,
        fullPage: false,
      });
    });
  }
});

test.describe("Name plates and lower third", () => {
  const scenes = [
    { id: "names-on", expectName: true, expectStrip: false },
    { id: "names-off", expectName: false, expectStrip: false },
    { id: "lower-third", expectName: true, expectStrip: true },
  ] as const;

  for (const scene of scenes) {
    for (const viewport of ["mobile", "desktop"] as const) {
      test(`${scene.id} @ ${viewport}`, async ({ page }) => {
        const vp = viewport === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
        await page.setViewportSize(vp);
        await page.goto(`/fixtures/nameplate.html?scene=${scene.id}`);
        await page.waitForSelector('[data-testid="nameplate-stage"]', {
          timeout: 60_000,
        });
        if (scene.expectName) {
          await expect(page.getByText("Aaron Stransky (you)")).toBeVisible();
        } else {
          await expect(page.getByTestId("tile-name-plate")).toHaveCount(0);
          await expect(page.getByText("Aaron Stransky")).toHaveCount(0);
        }
        if (scene.expectStrip) {
          const strip = page.getByTestId("lower-third");
          await expect(strip).toBeVisible();
          await expect(strip).toContainText("Majik");
          await expect(strip).toContainText("Show host");
        } else {
          await expect(page.getByTestId("lower-third")).toHaveCount(0);
        }
        await page.screenshot({
          path: `test-results/Nameplate-${scene.id}-${viewport}.png`,
          fullPage: true,
        });
      });
    }
  }
});

/**
 * Rooms the one-list capture needs: a Direct, a Group, a Channel (public and
 * private), an agent hub (also a Direct), and a standing room (a channel, not
 * a Meetings destination). The dev seed has no group, and Home's clear-day
 * test counts those four seed rooms, so this fixture is only for this describe.
 */
function conversationFixture() {
  const message = (
    roomId: string,
    at: string,
    sender: { id: string; name: string; type: "human" | "agent" },
    content: string,
  ) => ({
    id: `msg-${roomId}`,
    room_id: roomId,
    sender_id: sender.id,
    sender_name: sender.name,
    sender_type: sender.type,
    sender_avatar: null,
    content,
    content_type: "text",
    thread_id: null,
    reply_count: 0,
    edited: false,
    created_at: at,
    updated_at: at,
    metadata: {},
  });
  const row = (
    over: Record<string, unknown> & { id: string; room_type: string; updated_at: string },
  ) => ({
    name: over.id,
    display_name: over.id,
    description: "",
    created_at: over.updated_at,
    member_count: 2,
    online_count: 1,
    unread_count: 0,
    is_archived: false,
    visibility: "public",
    parent_room_id: null,
    metadata_: {},
    last_message: null,
    ...over,
  });
  return [
    row({
      id: "room-general",
      room_type: "channel",
      display_name: "general",
      updated_at: "2026-09-24T12:00:00Z",
      unread_count: 3,
      last_message: message(
        "room-general",
        "2026-09-24T12:00:00Z",
        { id: "user-jason", name: "Nate Ellison", type: "human" },
        "Deploy is live",
      ),
    }),
    row({
      id: "room-dm-jason",
      room_type: "dm",
      display_name: "Nate Ellison",
      updated_at: "2026-09-24T11:00:00Z",
      unread_count: 1,
      counterpart: {
        participant_id: "user-jason",
        kind: "human",
        display_name: "Nate Ellison",
      },
      last_message: message(
        "room-dm-jason",
        "2026-09-24T11:00:00Z",
        { id: "user-jason", name: "Nate Ellison", type: "human" },
        "Thursday still works",
      ),
    }),
    row({
      id: "room-crew",
      room_type: "group_dm",
      display_name: "Crew",
      updated_at: "2026-09-24T09:00:00Z",
      member_count: 3,
      last_message: message(
        "room-crew",
        "2026-09-24T09:00:00Z",
        { id: "user-jason", name: "Nate Ellison", type: "human" },
        "Standing by",
      ),
    }),
    row({
      id: "room-hub-triage",
      room_type: "agent_hub",
      display_name: "Triage Agent",
      updated_at: "2026-09-24T10:00:00Z",
      unread_count: 2,
      metadata_: { brigade_agent_id: "agent-triage" },
      counterpart: {
        participant_id: "p-triage",
        kind: "agent",
        display_name: "Triage Agent",
        agent_id: "agent-triage",
      },
      last_message: message(
        "room-hub-triage",
        "2026-09-24T10:00:00Z",
        { id: "agent-triage", name: "Triage Agent", type: "agent" },
        "Holding the floor",
      ),
    }),
    row({
      id: "room-leadership",
      room_type: "channel",
      display_name: "leadership",
      visibility: "private",
      updated_at: "2026-09-24T08:00:00Z",
      last_message: message(
        "room-leadership",
        "2026-09-24T08:00:00Z",
        { id: "dev-user-001", name: "Aaron Stransky", type: "human" },
        "Quiet channel",
      ),
    }),
    row({
      id: "room-war",
      room_type: "channel",
      display_name: "war-room",
      updated_at: "2026-09-24T07:00:00Z",
      metadata_: { conference: true },
      last_message: message(
        "room-war",
        "2026-09-24T07:00:00Z",
        { id: "user-jason", name: "Nate Ellison", type: "human" },
        "Room is open",
      ),
    }),
  ];
}

/** List endpoint only. Archived and everything else falls through. */
async function stubConversationRooms(page: Page) {
  const rooms = conversationFixture();
  await page.route("**/api/v1/rooms**", async (route) => {
    const url = route.request().url();
    if (!/\/api\/v1\/rooms(\?|$)/.test(url)) {
      await route.fallback();
      return;
    }
    const archived = url.includes("is_archived=true");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rooms: archived ? [] : rooms, cursor: null }),
    });
  });
}

test.describe("One conversation list", () => {
  for (const viewport of ["mobile", "desktop"] as const) {
    test(`single list, filters, shapes, workspace @ ${viewport}`, async ({ page }, testInfo) => {
      const vp = viewport === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      await page.setViewportSize(vp);
      await stubHomeSummary(page);
      await stubConversationRooms(page);
      await page.goto("/");
      await waitForAppReady(page);
      await page.route("**/api/v1/rooms/*/recordings**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
      });
      await page.route("**/api/v1/rooms/browse**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
      });
      await page.route("**/api/v1/rooms/*/members**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
      });
      await page.route("**/api/v1/rooms/*/messages**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages: [], cursor: null, has_more: false }),
        });
      });
      await page.route("**/api/v1/rooms/*", async (route) => {
        const url = new URL(route.request().url());
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length !== 4 || parts[3] === "browse") {
          await route.fallback();
          return;
        }
        const id = parts[3]!;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id,
            name: id,
            display_name: id,
            description: "",
            room_type: "channel",
            created_at: "2026-09-24T12:00:00Z",
            updated_at: "2026-09-24T12:00:00Z",
            member_count: 1,
            unread_count: 0,
            is_archived: false,
            visibility: "public",
            metadata_: id === "room-war" ? { conference: true } : {},
          }),
        });
      });
      await clickTestId(page, "nav-conversations");
      await expect(page.getByTestId("conversations-card")).toBeVisible();
      await expect(page.getByTestId("workspace-name")).toBeVisible();
      await expect(page.getByTestId("workspace-name")).not.toHaveText("");
      for (const id of ["all", "unread", "people", "channels"] as const) {
        await expect(page.getByTestId(`conv-filter-${id}`)).toBeVisible();
      }
      // Unread first (newest unread at the top), then recency. war-room is a
      // standing room and still a Channel row.
      const rows = page.getByTestId("conversation-row");
      await expect(rows).toHaveCount(6);
      const order: { name: string; shape: string }[] = [
        { name: "general", shape: "channel" },
        { name: "Nate Ellison", shape: "direct" },
        { name: "Triage Agent", shape: "direct" },
        { name: "Crew", shape: "group" },
        { name: "leadership", shape: "channel" },
        { name: "war-room", shape: "channel" },
      ];
      for (let i = 0; i < order.length; i++) {
        await expect(rows.nth(i)).toContainText(order[i]!.name);
        await expect(rows.nth(i)).toHaveAttribute("data-shape", order[i]!.shape);
      }
      await expect(page.locator('[data-shape="direct"]').first()).toBeVisible();
      await expect(page.locator('[data-shape="group"]')).toBeVisible();
      await expect(page.locator('[data-shape="channel"]').first()).toBeVisible();
      await expect(page.getByText("Crew").first()).toBeVisible();
      await expect(page.getByText("Nate Ellison").first()).toBeVisible();
      // Old destinations are not rail buttons.
      await expect(page.getByTestId("nav-direct")).toHaveCount(0);
      await expect(page.getByTestId("nav-channels")).toHaveCount(0);
      await expect(page.getByTestId("nav-meetings")).toHaveCount(0);
      await expect(page.getByTestId("nav-agents")).toHaveCount(0);
      await page.screenshot({
        path: `test-results/ConversationList-all-${viewport}-${testInfo.project.name}.png`,
        fullPage: true,
      });

      const listUrl = () => new URL(page.url()).pathname;
      const pathBeforeFilters = listUrl();
      async function expectRailUnchanged() {
        expect(listUrl()).toBe(pathBeforeFilters);
        await expect(
          page.getByTestId("nav-conversations").locator("visible=true").first(),
        ).toHaveAttribute("aria-current", "page");
        await expect(
          page.getByTestId("nav-home").locator("visible=true").first(),
        ).not.toHaveAttribute("aria-current", "page");
        // Nav v3: the phone has no Directory tab (it is "All agents" under
        // Crew); the desktop rail keeps it.
        if (viewport === "desktop") {
          await expect(
            page.getByTestId("nav-directory").locator("visible=true").first(),
          ).not.toHaveAttribute("aria-current", "page");
        } else {
          await expect(
            page.getByTestId("nav-crew").locator("visible=true").first(),
          ).not.toHaveAttribute("aria-current", "page");
        }
      }

      await page.getByTestId("conv-filter-unread").click();
      await expectRailUnchanged();
      await expect(page.locator('[data-shape="group"]')).toHaveCount(0);
      await expect(page.locator('[data-shape="direct"]').first()).toBeVisible();
      await page.screenshot({
        path: `test-results/ConversationList-unread-${viewport}-${testInfo.project.name}.png`,
        fullPage: true,
      });

      await page.getByTestId("conv-filter-people").click();
      await expectRailUnchanged();
      await expect(page.locator('[data-shape="channel"]')).toHaveCount(0);
      await expect(page.locator('[data-shape="group"]')).toBeVisible();
      await expect(page.locator('[data-shape="direct"]').first()).toBeVisible();
      await page.screenshot({
        path: `test-results/ConversationList-people-${viewport}-${testInfo.project.name}.png`,
        fullPage: true,
      });

      await page.getByTestId("conv-filter-channels").click();
      await expectRailUnchanged();
      await expect(page.locator('[data-shape="group"]')).toHaveCount(0);
      await expect(page.locator('[data-shape="direct"]')).toHaveCount(0);
      await expect(page.locator('[data-shape="channel"]').first()).toBeVisible();
      await expect(page.getByLabel("Private channel").first()).toBeVisible();
      await page.getByTestId("browse-channels").click();
      const browser = page.getByRole("dialog", { name: "Browse channels" });
      await expect(browser).toBeVisible();
      await browser.getByRole("button", { name: "Close" }).click();
      await expect(browser).toHaveCount(0);

      await page.getByTestId("conv-filter-all").click();
      await expectRailUnchanged();
      const general = page.getByTestId("conversation-row").filter({ hasText: "general" }).first();
      await general.getByRole("button").first().click();
      await expect(page).toHaveURL(/\/c\/room-general/);
      if (viewport === "mobile") {
        await page.getByRole("button", { name: "Open sidebar" }).click();
      }
      const afterOpen = page.getByTestId("conversation-row");
      await expect(afterOpen.nth(0)).toContainText("general");
      await expect(afterOpen.nth(0).getByRole("button").first()).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(afterOpen.nth(1)).toContainText("Nate Ellison");
      await expect(afterOpen.nth(1)).toHaveAttribute("data-shape", "direct");

      await page.getByTestId("conversation-row").filter({ hasText: "war-room" }).getByRole("button").first().click();
      await expect(page).toHaveURL(/\/c\/room-war/);
      if (viewport === "mobile") {
        await page.getByRole("button", { name: "Open sidebar" }).click();
      }
      await expect(page.getByTestId("room-recordings").locator("visible=true")).toBeVisible();
      await page.screenshot({
        path: `test-results/ConversationList-channels-${viewport}-${testInfo.project.name}.png`,
        fullPage: true,
      });

      if (viewport === "desktop") {
        await clickTestId(page, "nav-directory");
      } else {
        // Phone: Crew tab → "All agents" is the directory's door.
        await page.getByTestId("phone-tab-bar").getByTestId("nav-crew").click();
        await page.getByTestId("crew-all-agents").locator("visible=true").first().click();
      }
      await expect(page.getByTestId("agents-page")).toBeVisible();
      await assertPageHealth(page, viewport);
    });

    test(`flag off restores the five-view shell @ ${viewport}`, async ({ page }, testInfo) => {
      const vp = viewport === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      await page.addInitScript(() => {
        localStorage.setItem("stable_nav_v2", "0");
      });
      await page.setViewportSize(vp);
      await stubHomeSummary(page);
      await page.goto("/");
      await waitForAppReady(page);
      if (viewport === "mobile") {
        await page.getByRole("button", { name: "Open sidebar" }).click();
      }
      // The phone rail scrolls; later icons can sit outside the 280px strip.
      // Attached proves the five destinations are back. Direct is in view and
      // is what the old shell opens.
      for (const id of ["nav-home", "nav-direct", "nav-channels", "nav-meetings", "nav-agents"]) {
        await expect(page.getByTestId(id).first()).toBeAttached();
      }
      await expect(page.getByTestId("nav-direct").locator("visible=true").first()).toBeVisible();
      await expect(page.getByTestId("nav-conversations")).toHaveCount(0);
      await expect(page.getByTestId("nav-directory")).toHaveCount(0);
      await expect(page.getByTestId("conversation-filters")).toHaveCount(0);
      await clickTestId(page, "nav-direct");
      await expect(page.getByTestId("conversations-card")).toBeVisible();
      await page.screenshot({
        path: `test-results/NavV1Fallback-${viewport}-${testInfo.project.name}.png`,
        fullPage: true,
      });
      await assertPageHealth(page, viewport);
    });
  }
});

// ---- Nav v3: crew-first (design/nav-v3-crew-first-20260928) -----------------

interface NavV3World {
  /** Hub ids that received POST /threads, in order. */
  threadPosts: string[];
  /** Bodies of every PATCH /rooms/{id}. */
  roomPatches: Array<{ roomId: string; body: Record<string, unknown> }>;
  /** Bodies of every PATCH /rooms/{id}/members/{pid}. */
  memberPatches: Array<{ roomId: string; participantId: string; body: Record<string, unknown> }>;
}

/**
 * The rooms, crew, hub, threads, members and seat writes the crew-first
 * shell talks to (C2 + C3). Persephone's hub carries one existing thread so
 * the sidebar has something to nest; a new one is created live by the test.
 */
async function stubNavV3World(page: Page): Promise<NavV3World> {
  const world: NavV3World = { threadPosts: [], roomPatches: [], memberPatches: [] };
  // metadata.seats per room: { <agent_id>: {model, effort} } — per seat, not per room.
  const seatsByRoom = new Map<string, Record<string, { model: string | null; effort: string | null }>>();
  const existingThread = {
    ...threadRoomRaw(PERSEPHONE_HUB_ID, 0, "Kitchen panel plan"),
    updated_at: "2026-09-28T19:00:00Z",
    last_message: {
      id: "msg-thread-0",
      room_id: `${PERSEPHONE_HUB_ID}-t-00000000`,
      sender_id: "p-persephone",
      sender_name: "Persephone",
      sender_type: "agent",
      sender_avatar: null,
      content: "Panel v2 is on the wall.",
      content_type: "text",
      thread_id: null,
      reply_count: 0,
      edited: false,
      created_at: "2026-09-28T19:00:00Z",
      updated_at: "2026-09-28T19:00:00Z",
      metadata: {},
    },
  };
  const created: Array<Record<string, unknown>> = [];
  // Like the server, the members payload reflects a mode write — otherwise
  // the client's members refetch after the PATCH would undo the optimistic
  // mode under load (it did, once in 138).
  const modeByParticipant = new Map<string, string>();
  let threadCounter = 0;
  const hub = () => ({
    ...hubRoomRaw("persephone", {
      metadata_: seatsByRoom.has(PERSEPHONE_HUB_ID) ? { seats: seatsByRoom.get(PERSEPHONE_HUB_ID) } : {},
    }),
    unread_count: 1,
    last_message: {
      id: "msg-hub",
      room_id: PERSEPHONE_HUB_ID,
      sender_id: "p-persephone",
      sender_name: "Persephone",
      sender_type: "agent",
      sender_avatar: null,
      content: "Board is clear; two PRs waiting on you.",
      content_type: "text",
      thread_id: null,
      reply_count: 0,
      edited: false,
      created_at: "2026-09-28T20:12:00Z",
      updated_at: "2026-09-28T20:12:00Z",
      metadata: {},
    },
  });
  const general = {
    ...hubRoomRaw("persephone", { id: "room-general", name: "general", display_name: "general" }),
    room_type: "channel",
    visibility: "public",
    counterpart: null,
    agents: [],
    metadata_: {},
    updated_at: "2026-09-28T12:00:00Z",
    last_message: null,
  };
  // A shared room: Aaron, Persephone, Shafen's Flow and a customer's guest
  // agent. A foreign line was written there, so its floor is "shared".
  const taxsq = {
    ...general,
    id: "room-taxsq",
    name: "taxsq-portal",
    display_name: "taxsq-portal",
    member_count: 4,
    metadata_: { class_floor: "shared" },
    agents: [
      { participant_id: "p-persephone", agent_id: "persephone", display_name: "Persephone", agent_mode: "when_named" },
      { participant_id: "p-shafen-claude-code", agent_id: "shafen-claude-code", display_name: "Flow", agent_mode: "when_named" },
      { participant_id: "p-taxsq-assistant", agent_id: null, display_name: "Northbridge Tax assistant", agent_mode: "when_named" },
    ],
    updated_at: "2026-09-28T11:00:00Z",
  };
  const line = (roomId: string, at: string, who: { id: string; name: string; type: "human" | "agent" }, content: string) => ({
    id: `msg-${roomId}`,
    room_id: roomId,
    sender_id: who.id,
    sender_name: who.name,
    sender_type: who.type,
    sender_avatar: null,
    content,
    content_type: "text",
    thread_id: null,
    reply_count: 0,
    edited: false,
    created_at: at,
    updated_at: at,
    metadata: {},
  });
  const channel = (id: string, name: string, at: string, content: string) => ({
    ...general,
    id,
    name,
    display_name: name,
    updated_at: at,
    last_message: line(id, at, { id: "user-jason", name: "Nate Ellison", type: "human" }, content),
  });
  const extras = [
    {
      ...general,
      id: "room-dm-jason",
      name: "Nate Ellison",
      display_name: "Nate Ellison",
      room_type: "dm",
      visibility: "private",
      counterpart: { participant_id: "user-jason", kind: "human", display_name: "Nate Ellison" },
      updated_at: "2026-09-28T10:30:00Z",
      last_message: line("room-dm-jason", "2026-09-28T10:30:00Z", { id: "user-jason", name: "Nate Ellison", type: "human" }, "Thursday still works"),
    },
    channel("room-ops", "ops", "2026-09-28T10:00:00Z", "GPU temps nominal"),
    channel("room-leadership", "leadership", "2026-09-28T09:00:00Z", "Quiet channel"),
    channel("room-war", "war-room", "2026-09-28T08:00:00Z", "Room is open"),
    channel("room-dev", "dev", "2026-09-28T07:00:00Z", "PR #42 ready"),
  ];
  const rooms = () => [
    hub(),
    ...created,
    existingThread,
    hubRoomRaw("claude-code"),
    general,
    taxsq,
    ...extras,
  ];
  const detailFor = (id: string) => {
    if (id === PERSEPHONE_HUB_ID) return hub();
    const own = created.find((room) => room.id === id);
    if (own) return own;
    if (id === existingThread.id) return existingThread;
    if (id === "room-general") return general;
    if (id === "room-taxsq") return taxsq;
    const extra = extras.find((room) => room.id === id);
    if (extra) return extra;
    return hubRoomRaw("claude-code", { id, name: id });
  };
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await stubCrew(page);
  await page.route("**/api/v1/rooms**", async (route) => {
    const url = route.request().url();
    if (!/\/api\/v1\/rooms(\?|$)/.test(url)) {
      await route.fallback();
      return;
    }
    const archived = url.includes("is_archived=true");
    await route.fulfill(json({ rooms: archived ? [] : rooms(), cursor: null }));
  });
  await page.route("**/api/v1/rooms/*/recordings**", (route) => route.fulfill(json([])));
  await page.route("**/api/v1/rooms/browse**", (route) => route.fulfill(json([])));
  await page.route("**/api/v1/rooms/*/messages**", (route) => {
    const parts = new URL(route.request().url()).pathname.split("/").filter(Boolean);
    // The existing thread was started from one of Persephone's lines: its
    // first entry is the seed, under its true author.
    // #ops carries the server-worded system lines: the text names nobody,
    // the starter / reason / title ride in metadata.
    const systemLine = (
      id: string,
      at: string,
      content: string,
      metadata: Record<string, unknown>,
      sender: { id: string | null; name: string | null; type: string } = { id: null, name: null, type: "system" },
    ) => ({
      id,
      room_id: "room-ops",
      sender_id: sender.id,
      sender_name: sender.name,
      sender_type: sender.type,
      content,
      content_type: "system",
      created_at: at,
      updated_at: at,
      is_edited: false,
      is_deleted: false,
      reply_count: 0,
      metadata,
    });
    const opsLines = [
      systemLine(
        "msg-ops-thread",
        "2026-09-28T09:50:00Z",
        "Channel thread started",
        { kind: "thread_started", thread_room_id: "room-ops-t-1", thread_title: "Launch checklist", created_by: "p-aaron", seed_message_id: null },
        { id: "p-aaron", name: "Aaron Stransky", type: "human" },
      ),
      systemLine("msg-ops-rec-1", "2026-09-28T09:52:00Z", "Audio recording started", {
        kind: "recording", event: "started", recording_kind: "audio", recording_id: "rec-1", started_by: "p-aaron", reason: "user",
      }),
      systemLine("msg-ops-rec-2", "2026-09-28T09:58:00Z", "Audio recording stopped", {
        kind: "recording", event: "stopped", recording_kind: "audio", recording_id: "rec-1", started_by: "p-aaron", reason: "room_idle",
      }),
      systemLine("msg-ops-rec-3", "2026-09-28T09:59:00Z", "Recording failed", {
        kind: "recording", event: "failed", recording_id: "rec-2", egress_id: "EG_1", reason: "egress crashed: no track",
      }),
    ];
    const messages =
      parts[3] === existingThread.id
        ? [threadSeedMessageRaw(existingThread.id as string, PERSEPHONE_HUB_ID)]
        : parts[3] === "room-ops"
          ? [...opsLines].reverse()
          : [];
    return route.fulfill(json({ messages, cursor: null, has_more: false }));
  });
  const membersFor = (roomId: string) =>
    membersFixture(roomId).map((m) =>
      m.participant_id && modeByParticipant.has(m.participant_id)
        ? { ...m, agent_mode: modeByParticipant.get(m.participant_id) }
        : m,
    );
  await page.route("**/api/v1/rooms/*/members", (route) => {
    const parts = new URL(route.request().url()).pathname.split("/").filter(Boolean);
    return route.fulfill(json(membersFor(parts[3]!)));
  });
  await page.route("**/api/v1/rooms/*/members/*", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/").filter(Boolean);
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    world.memberPatches.push({ roomId: parts[3]!, participantId: parts[5]!, body });
    if (typeof body.agent_mode === "string") modeByParticipant.set(parts[5]!, body.agent_mode);
    const row = membersFor(parts[3]!).find((m) => m.participant_id === parts[5]);
    await route.fulfill(json({ ...(row ?? { participant_id: parts[5] }), ...body }));
  });
  await page.route("**/api/v1/rooms/*/threads**", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/").filter(Boolean);
    const parentId = parts[3]!;
    if (route.request().method() === "POST") {
      threadCounter += 1;
      world.threadPosts.push(parentId);
      const thread = threadRoomRaw(parentId, threadCounter);
      created.push(thread);
      await route.fulfill(json(thread, 201));
      return;
    }
    await route.fulfill(json(created.filter((room) => room.parent_room_id === parentId)));
  });
  await page.route("**/api/v1/agents/*/hub", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/").filter(Boolean);
    await route.fulfill(json(detailFor(parts[3] === "persephone" ? PERSEPHONE_HUB_ID : `hub-${parts[3]}`)));
  });
  await page.route("**/api/v1/rooms/*", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/").filter(Boolean);
    if (parts.length !== 4 || parts[3] === "browse") {
      await route.fallback();
      return;
    }
    const id = parts[3]!;
    if (route.request().method() === "PATCH") {
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      world.roomPatches.push({ roomId: id, body });
      const seats = (
        body.metadata as
          | { seats?: Record<string, { model?: string | null; effort?: string | null }> }
          | undefined
      )?.seats;
      if (seats) {
        const current = { ...(seatsByRoom.get(id) ?? {}) };
        for (const [agentId, seat] of Object.entries(seats)) {
          current[agentId] = { model: seat.model ?? null, effort: seat.effort ?? null };
        }
        seatsByRoom.set(id, current);
      }
      await route.fulfill(json(detailFor(id)));
      return;
    }
    await route.fulfill(json(detailFor(id)));
  });
  return world;
}

test.describe("Crew-first nav (v3)", () => {
  for (const viewport of ["mobile", "desktop"] as const) {
    test(`crew, hub, new conversation @ ${viewport}`, async ({ page }, testInfo) => {
      const vp = viewport === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      await page.setViewportSize(vp);
      await stubHomeSummary(page);
      const world = await stubNavV3World(page);
      await page.goto("/");
      await waitForAppReady(page);
      await expect(page.getByTestId("home-dashboard")).toBeVisible();
      const tag = `${viewport}-${testInfo.project.name}`;
      await page.screenshot({ path: `test-results/NavV3-Home-${tag}.png`, fullPage: true });

      if (viewport === "desktop") {
        // Crew sits above Conversations: Your seats, House, then More.
        await clickTestId(page, "nav-conversations");
        const section = page.getByTestId("crew-section");
        await expect(section).toBeVisible();
        // Per-group cap: the seats heard from lately, three house, three
        // partners — all three groups on the first view (acceptance 3).
        for (const group of ["own_seat", "house", "partner"]) {
          await expect(section.getByTestId(`crew-group-${group}`)).toBeVisible();
        }
        const rows = section.getByTestId("crew-row");
        await expect(rows).toHaveCount(8);
        await expect(rows.nth(0)).toContainText("Persephone");
        await expect(rows.nth(1)).toContainText("Rook");
        await expect(rows.nth(2)).toContainText("Majik Mane");
        await expect(rows.nth(5)).toContainText("Flow");
        await expect(rows.nth(5)).toContainText("#taxsq-portal");
        await expect(section.getByTestId("crew-more")).toContainText("More (4)");
        // Names never give way: the headline name is fully drawn at 280px.
        const nameFits = await rows.nth(0).getByTestId("crew-open-persephone").locator("span.truncate").first()
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
        expect(nameFits).toBe(true);
        // The brain chip is a hover overlay where hover exists; a touch
        // device (this suite's iPhone-emulation project) always shows it.
        const canHover = await page.evaluate(() => window.matchMedia("(hover: hover)").matches);
        if (canHover) {
          await expect(rows.nth(3).getByTestId("crew-brain-chip")).toHaveCount(0);
          await expect(rows.nth(1).getByTestId("crew-brain-chip")).not.toBeVisible();
          await rows.nth(0).hover();
        }
        await expect(rows.nth(0).getByTestId("crew-brain-chip")).toBeVisible();
        await expect(rows.nth(0).getByTestId("crew-brain-chip")).toHaveText("Fable 5.1 · high");
        // A partner's row has no ⋮ — nothing acts in the shared room from here.
        await rows.nth(5).hover();
        await expect(rows.nth(5).getByTestId("crew-menu-shafen-claude-code")).toHaveCount(0);
        // Your own seat's menu: New conversation, Call (waits on C5), Settings.
        await rows.nth(0).hover();
        await rows.nth(0).getByTestId("crew-menu-persephone").click();
        const menu = page.getByRole("menu", { name: "Options for Persephone" });
        await expect(menu.getByTestId("crew-menu-new")).toBeVisible();
        await expect(menu.getByTestId("crew-menu-call")).toBeDisabled();
        await expect(menu.getByTestId("crew-menu-settings")).toBeVisible();
        // The menu is on top: the rows under it are positioned too, and
        // were painted over it.
        const covered = await menu.getByRole("menuitem").evaluateAll((items) =>
          items
            .filter((item) => {
              const box = item.getBoundingClientRect();
              const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
              return !top || !(item === top || item.contains(top));
            })
            .map((item) => item.textContent),
        );
        expect(covered).toEqual([]);
        // Past its fade-in: a frame caught mid-way reads as a see-through menu.
        await page.screenshot({
          path: `test-results/NavV3-Crew-menu-${tag}.png`,
          fullPage: false,
          animations: "disabled",
        });
        // Escape closes it at once, from wherever the focus is.
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);
        // So does a press anywhere else on the page — here the empty
        // stretch of the top bar, outside the sidebar.
        await rows.nth(0).hover();
        await rows.nth(0).getByTestId("crew-menu-persephone").click();
        await expect(menu).toBeVisible();
        await page.mouse.click(760, 28);
        await expect(menu).toHaveCount(0);
        await expect(page.getByTestId("home-dashboard")).toBeVisible();
        // Density (P1-9): with 12 crew rows present the one list still shows
        // at least six conversations on 1440×900, under sticky filters.
        await expect(page.getByTestId("conversation-list-sticky")).toBeVisible();
        await expect(page.getByTestId("mark-visible-read")).toBeVisible();
        const visibleConversations = await page.getByTestId("conversation-row").evaluateAll((els) =>
          els.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
          }).length,
        );
        expect(visibleConversations).toBeGreaterThanOrEqual(6);
        await page.screenshot({ path: `test-results/NavV3-Sidebar-Crew-${tag}.png`, fullPage: false });
        await section.getByTestId("crew-more").click();
        await expect(section.getByTestId("crew-row")).toHaveCount(12);
        await expect(section.getByTestId("crew-fewer")).toBeVisible();
        // Acceptance 3: zero rows named "Claude Code"; the directory is a door, not a tab.
        await expect(page.getByText("Claude Code", { exact: true })).toHaveCount(0);
        await expect(section.getByTestId("crew-all-agents")).toBeVisible();
        await expect(page.getByTestId("phone-tab-bar")).not.toBeVisible();
        await expect(page.getByTestId("conversations-card")).toBeVisible();
        await expect(page.getByTestId("workspace-name")).toBeVisible();
        await page.screenshot({ path: `test-results/NavV3-Sidebar-Crew-all-${tag}.png`, fullPage: true });
        await section.getByTestId("crew-fewer").click();
        // The To box: crew, then people and channels as you type.
        await clickTestId(page, "new-room-button");
        const toBox = page.getByTestId("new-sheet-to");
        await expect(toBox).toBeVisible();
        await expect(page.getByTestId("new-sheet-picks-crew")).toBeVisible();
        await toBox.fill("sha");
        await expect(page.getByTestId("new-sheet-picks-crew").getByRole("option")).toHaveCount(3);
        await page.screenshot({ path: `test-results/NavV3-ToBox-${tag}.png`, fullPage: false });
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("create-room-modal")).toHaveCount(0);
      } else {
        // Phone: Home · Chats · Crew · Calls · Me, and no Agents tab.
        const bar = page.getByTestId("phone-tab-bar");
        await expect(bar).toBeVisible();
        for (const id of ["nav-home", "nav-conversations", "nav-crew", "nav-calls", "nav-me"]) {
          await expect(bar.getByTestId(id)).toBeVisible();
        }
        await expect(bar.getByTestId("nav-agents")).toHaveCount(0);
        await expect(bar.getByTestId("nav-directory")).toHaveCount(0);
        await bar.getByTestId("nav-crew").click();
        const crewPage = page.getByTestId("crew-page");
        await expect(crewPage).toBeVisible();
        await expect(crewPage.getByTestId("crew-row")).toHaveCount(12);
        await expect(crewPage.getByTestId("crew-group-own_seat")).toBeVisible();
        await expect(crewPage.getByTestId("crew-group-house")).toBeVisible();
        await expect(crewPage.getByTestId("crew-group-partner")).toBeVisible();
        await expect(crewPage.getByTestId("crew-all-agents")).toBeVisible();
        await expect(page.getByText("Claude Code", { exact: true })).toHaveCount(0);
        await expect(bar.getByTestId("nav-crew")).toHaveAttribute("aria-current", "page");
        // Full-height list (P1-7): the drawer footer and the second search box
        // are gone, so at least eight of the twelve rows are on screen.
        const visibleCrewRows = await crewPage.getByTestId("crew-row").evaluateAll((els) =>
          els.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
          }).length,
        );
        expect(visibleCrewRows).toBeGreaterThanOrEqual(8);
        await expect(page.getByTestId("drawer-tools")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
        await expect(page.locator('input[aria-label^="Search"]').locator("visible=true")).toHaveCount(1);
        await page.screenshot({ path: `test-results/NavV3-Crew-${tag}.png`, fullPage: false });
        // Me tab: profile, People, Activity, Saved, Settings, Sign out.
        await bar.getByTestId("nav-me").click();
        const me = page.getByTestId("me-sheet");
        await expect(me).toBeVisible();
        for (const id of ["me-people", "me-activity", "me-saved", "open-settings", "me-sign-out"]) {
          await expect(me.getByTestId(id)).toBeVisible();
        }
        await expect(bar.getByTestId("nav-me")).toHaveAttribute("aria-current", "page");
        await page.screenshot({ path: `test-results/NavV3-Me-${tag}.png`, fullPage: false });
        await me.getByRole("button", { name: "Close" }).click();
        await expect(me).toHaveCount(0);
        // The To box on a phone.
        await bar.getByTestId("nav-conversations").click();
        await clickTestId(page, "new-room-button");
        const toBox = page.getByTestId("new-sheet-to");
        await expect(toBox).toBeVisible();
        await toBox.fill("sha");
        await expect(page.getByTestId("new-sheet-picks-crew").getByRole("option")).toHaveCount(3);
        await page.screenshot({ path: `test-results/NavV3-ToBox-${tag}.png`, fullPage: false });
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("create-room-modal")).toHaveCount(0);
        await bar.getByTestId("nav-crew").click();
        await expect(crewPage).toBeVisible();
      }

      // Tap → the hub (already known to the list, so no POST /hub).
      await page.getByTestId("crew-open-persephone").locator("visible=true").first().click();
      await expect(page).toHaveURL(new RegExp(`/c/${PERSEPHONE_HUB_ID}$`));
      const header = page.getByTestId("room-header");
      await expect(header).toContainText("Persephone");
      // The name is drawn in full — on the phone too, where Members, Threads
      // and Pop out left the row (P2-19).
      const titleFits = await header.locator("span.truncate", { hasText: "Persephone" }).first()
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
      expect(titleFits).toBe(true);
      // A private hub's empty state: the agent, "Say hi" — no channel copy.
      await expect(page.getByTestId("private-hub-say-hi")).toBeVisible();
      await expect(page.getByText("Invite an agent")).toHaveCount(0);
      await expect(page.getByText("Pin a goal for this channel")).toHaveCount(0);
      await expect(page.getByText("others see it the moment")).toHaveCount(0);
      if (viewport === "desktop") {
        await expect(header.getByTestId("hub-new-conversation")).toBeVisible();
      } else {
        // The phone keeps the 44px row; New conversation sits in More there.
        await expect(header.getByTestId("hub-new-conversation")).not.toBeVisible();
      }
      await page.screenshot({ path: `test-results/NavV3-Hub-${tag}.png`, fullPage: false });

      // New conversation → POST /rooms/{hub}/threads → the thread opens…
      if (viewport === "desktop") {
        await header.getByTestId("hub-new-conversation").click();
      } else {
        await header.getByRole("button", { name: "More room actions" }).click();
        await page.getByTestId("hub-new-conversation-menu").click();
      }
      await expect(page).toHaveURL(new RegExp(`/c/${PERSEPHONE_HUB_ID}-t-00000001`));
      expect(world.threadPosts).toEqual([PERSEPHONE_HUB_ID]);
      await expect(page.getByTestId("room-header")).toContainText("Persephone ›");

      // …and nests under Persephone in Conversations.
      if (viewport === "mobile") {
        await page.getByRole("button", { name: "Open sidebar" }).click();
        await page.getByTestId("phone-tab-bar").getByTestId("nav-conversations").click();
      }
      const persephoneRow = page
        .getByTestId("conversation-row")
        .filter({ hasText: "Persephone" })
        .first();
      await expect(persephoneRow).toBeVisible();
      await persephoneRow
        .getByRole("button", { name: /conversation history with Persephone/ })
        .click();
      await expect(persephoneRow.getByText("New conversation")).toBeVisible();
      await expect(persephoneRow.getByText("Panel v2 is on the wall.")).toBeVisible();
      await page.screenshot({ path: `test-results/NavV3-Hub-Thread-${tag}.png`, fullPage: true });

      // Seat settings (C2): the brain chip on the hub — desktop in the header,
      // phone from More — with "Default (Fable 5.1 · high)" as the null state.
      await page.goto(`/c/${PERSEPHONE_HUB_ID}`);
      await waitForAppReady(page);
      await expect(page.getByTestId("room-header")).toContainText("Persephone");
      if (viewport === "desktop") {
        const chip = page.getByTestId("seat-chip");
        await expect(chip).toHaveText(/Fable 5\.1 · high/);
        await chip.click();
      } else {
        await page.getByRole("button", { name: "More room actions" }).click();
        const entry = page.getByTestId("seat-menu-entry");
        await expect(entry).toContainText("Fable 5.1 · high");
        await entry.click();
      }
      const popover = page.getByTestId("seat-settings");
      await expect(popover).toBeVisible();
      await expect(popover.getByTestId("seat-default")).toContainText("Default (Fable 5.1 · high)");
      await expect(popover.getByTestId("seat-default")).toHaveAttribute("aria-checked", "true");
      await page.screenshot({ path: `test-results/NavV3-SeatPopover-${tag}.png`, fullPage: false });

      // Opus 5.5 · medium → two PATCH /rooms/{hub} writes, chip follows (acceptance 2).
      await popover.getByTestId("seat-model-claude-opus-5-5").click();
      await expect.poll(() => world.roomPatches.length).toBe(1);
      expect(world.roomPatches[0]).toEqual({
        roomId: PERSEPHONE_HUB_ID,
        body: { metadata: { seats: { persephone: { model: "claude-opus-5-5", effort: null } } } },
      });
      await popover.getByTestId("seat-effort-medium").click();
      await expect.poll(() => world.roomPatches.length).toBe(2);
      expect(world.roomPatches[1]!.body).toEqual({
        metadata: { seats: { persephone: { model: "claude-opus-5-5", effort: "medium" } } },
      });
      if (viewport === "desktop") {
        await expect(page.getByTestId("seat-chip")).toHaveText(/Opus 5\.5 · medium/);
      }
      if (viewport === "mobile") {
        // The FAB leaves while the sheet is open (P1-8).
        await expect(page.getByTestId("room-fab")).toHaveCount(0);
      }
      const membersRefetch = page.waitForResponse(
        (r) => /\/api\/v1\/rooms\/[^/]+\/members$/.test(r.url()) && r.request().method() === "GET",
      );
      await popover.getByTestId("seat-mode-listening").click();
      await expect.poll(() => world.memberPatches.length).toBe(1);
      expect(world.memberPatches[0]).toEqual({
        roomId: PERSEPHONE_HUB_ID,
        participantId: "p-persephone",
        body: { agent_mode: "listening" },
      });
      // Listening must still be checked AFTER the members refetch lands.
      await membersRefetch;
      await page.waitForTimeout(150);
      await expect(popover.getByTestId("seat-mode-listening")).toHaveAttribute("aria-checked", "true");
      await expect(popover.getByTestId("seat-mode-answers_all")).toHaveAttribute("aria-checked", "false");
      await page.screenshot({ path: `test-results/NavV3-SeatPopover-set-${tag}.png`, fullPage: false });
      await page.keyboard.press("Escape");
      await expect(popover).toHaveCount(0);
      if (viewport === "mobile") {
        // Back, and clear of the composer's call buttons.
        const fab = page.getByTestId("room-fab");
        await expect(fab).toBeVisible();
        const fabBox = (await fab.boundingBox())!;
        for (const id of ["composer-voice-call", "composer-video-call"]) {
          const box = await page.getByTestId(id).boundingBox();
          if (!box) continue;
          const overlaps =
            fabBox.x < box.x + box.width && fabBox.x + fabBox.width > box.x &&
            fabBox.y < box.y + box.height && fabBox.y + fabBox.height > box.y;
          expect(overlaps).toBe(false);
        }
      }

      // The Brigade model switcher stays out of a seat room's More menu.
      await page.getByRole("button", { name: "More room actions" }).click();
      await expect(
        page.getByRole("button", { name: "Switch model for this conversation" }),
      ).toHaveCount(0);
      if (viewport === "mobile") {
        await expect(page.getByTestId("seat-menu-entry")).toContainText("Opus 5.5 · medium");
      }
      await page.keyboard.press("Escape");

      // A shared room: two seats, two chips that say whose (P1-6); the roster
      // marks a guest agent and a partner's seat (§2.0, needs Lane A's
      // members metadata subset — stubbed here).
      await page.goto("/c/room-taxsq");
      await waitForAppReady(page);
      await expect(page.getByTestId("room-header")).toContainText("taxsq-portal");
      if (viewport === "desktop") {
        const mine = page.locator('[data-testid="seat-chip"][data-agent-id="persephone"]');
        const theirs = page.locator('[data-testid="seat-chip"][data-agent-id="shafen-claude-code"]');
        // The floor: a foreign line was written here, and the header says so
        // — in a colour that reads on this theme (it was cream on white).
        await expect(page.getByTestId("room-class-chip")).toHaveText("shared");
        await expect(page.getByTestId("room-class-chip")).toHaveAttribute("title", /outside your seats/);
        expect(await textContrast(page.getByTestId("room-class-chip"))).toBeGreaterThanOrEqual(4.5);
        await expect(mine).toContainText("Persephone · Fable 5.1 · high");
        await expect(mine).toHaveAttribute("data-editable", "true");
        await expect(theirs).toContainText("Shafen’s Flow · Fable 5.1 · high");
        await expect(theirs).toHaveAttribute("data-editable", "false");
        await expect(theirs.getByTestId("seat-chip-lock")).toBeVisible();
        await page.screenshot({ path: `test-results/NavV3-MixedRoom-${tag}.png`, fullPage: false });
        // The popover says why the floor is shared, and it reads too.
        await mine.click();
        const note = page.getByTestId("seat-shared-floor");
        await expect(note).toBeVisible();
        expect(await textContrast(note)).toBeGreaterThanOrEqual(4.5);
        await expectInsidePanel(page, note);
        await page.screenshot({
          path: `test-results/NavV3-SharedFloor-${tag}.png`,
          fullPage: false,
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
        await expect(note).toHaveCount(0);
        await page.getByTestId("room-header").getByRole("button", { name: "Members" }).click();
      } else {
        // The phone's header has no room for chips: More lists both seats,
        // yours to open, the partner's locked and saying whose.
        await page.getByRole("button", { name: "More room actions" }).click();
        const entries = page.getByTestId("seat-menu-entry");
        await expect(entries).toHaveCount(2);
        await expect(entries.nth(0)).toHaveText("Brain · Persephone · Fable 5.1 · high");
        await expect(entries.nth(1)).toHaveText("Brain · Shafen’s Flow · Fable 5.1 · high");
        await expect(entries.nth(1)).toHaveAttribute("data-editable", "false");
        await expect(entries.nth(1).getByTestId("seat-menu-lock")).toBeVisible();
        await page.screenshot({ path: `test-results/NavV3-MixedRoom-${tag}.png`, fullPage: false });
        // A locked line opens nothing (forced: it is aria-disabled).
        await entries.nth(1).click({ force: true });
        await expect(page.getByTestId("seat-shared-floor")).toHaveCount(0);
        await expect(entries.nth(0)).toBeVisible();
        await entries.nth(0).click();
        const note = page.getByTestId("seat-shared-floor");
        await expect(note).toBeVisible();
        expect(await textContrast(note)).toBeGreaterThanOrEqual(4.5);
        await expectInsidePanel(page, note);
        await page.screenshot({
          path: `test-results/NavV3-SharedFloor-${tag}.png`,
          fullPage: false,
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
        await expect(note).toHaveCount(0);
        await page.getByRole("button", { name: "More room actions" }).click();
        await page.getByTestId("phone-members").click();
      }
      await expect(page.getByText("Guest", { exact: true }).first()).toBeVisible();
      await expect(page.getByTestId("member-partner-seat").first()).toHaveText("Shafen’s seat");
      await page.screenshot({ path: `test-results/NavV3-Roster-marks-${tag}.png`, fullPage: false });

      // A thread's seed line says where it came from, under its true author.
      await page.goto(`/c/${PERSEPHONE_HUB_ID}-t-00000000`);
      await waitForAppReady(page);
      // The list paints only once its pin settled; capture after that.
      await page.locator('[data-testid="message-list"][data-pin-settled="true"]').waitFor({ timeout: 30_000 });
      const seedLine = page.getByTestId("thread-seed");
      await expect(seedLine).toBeVisible();
      await expect(seedLine).toContainText("Started from Persephone’s message");
      await expect(seedLine).toContainText("Panel v2 is on the wall");
      await page.screenshot({ path: `test-results/NavV3-Thread-seed-${tag}.png`, fullPage: false });

      // Server-worded system lines name nobody in their text; the web puts
      // the starter, the reason and the thread's title back from metadata.
      await page.goto("/c/room-ops");
      await waitForAppReady(page);
      await page.locator('[data-testid="message-list"][data-pin-settled="true"]').waitFor({ timeout: 30_000 });
      const lines = page.getByTestId("system-line");
      await expect(lines).toHaveCount(4);
      await expect(lines.nth(0)).toHaveText("Aaron Stransky started a thread: Launch checklist");
      await expect(lines.nth(1)).toHaveText("Audio recording started · by Aaron Stransky");
      await expect(lines.nth(2)).toHaveText(
        "Audio recording stopped · the room went idle · started by Aaron Stransky",
      );
      await expect(lines.nth(3)).toHaveText("Recording failed · egress crashed: no track");
      await page.screenshot({ path: `test-results/NavV3-System-lines-${tag}.png`, fullPage: false });
      await assertPageHealth(page, viewport);
    });
  }
});

/**
 * The guest room with the rows a GUEST caller gets (server 345fbd1): null
 * availability and reason on every members row, `{kind}` alone on an agent's
 * metadata, no `gateway` / `on_behalf_of` / `agent_id` on a message — and
 * the server-worded system lines, whose names come from the guest's own
 * roster.
 */
const GUEST_ROOM_ID = "room-taxsq";

function guestLine(
  id: string,
  at: string,
  sender: { id: string | null; name: string; type: string },
  content: string,
  over: Record<string, unknown> = {},
) {
  return {
    id,
    room_id: GUEST_ROOM_ID,
    sender_id: sender.id,
    sender_name: sender.name,
    sender_type: sender.type,
    sender_avatar: null,
    content,
    content_type: "text",
    created_at: at,
    updated_at: at,
    ...over,
  };
}

const GUEST_AARON = { id: "p-aaron", name: "Aaron Stransky", type: "human" };
/** A notice is a NULL-sender line. */
const GUEST_NOBODY = { id: null, name: "", type: "system" };
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/** Stub the guest's whole world, redeem the invite, land in the room. */
async function joinGuestRoom(page: Page, history: unknown[]) {
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  const session = {
    session_id: "gs-e2e",
    participant_id: "p-guest",
    display_name: "Morgan Ali",
    room_id: GUEST_ROOM_ID,
    room_display_name: "taxsq-portal",
    can_publish: false,
    expires_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
  };
  // A stub credential for a stubbed server: it opens nothing anywhere.
  await page.route("**/api/v1/guest/redeem", (route) =>
    route.fulfill(json({ ...session, session_token: "sgs-e2e-stub" })),
  );
  await page.route("**/api/v1/guest/me", (route) => route.fulfill(json(session)));
  await page.route("**/api/v1/guest/leave", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/v1/tokens/livekit", (route) =>
    route.fulfill(json({ detail: "no call in this test" }, 503)),
  );

  const row = (
    id: string,
    name: string,
    type: "human" | "agent" | "guest",
    over: Record<string, unknown> = {},
  ) => ({
    participant_id: id,
    user_id: id,
    username: name.toLowerCase().replace(/\s+/g, "-"),
    display_name: name,
    avatar_url: null,
    role: "member",
    participant_type: type,
    is_online: type !== "agent",
    is_muted: false,
    is_self: false,
    joined_at: "2026-09-22T15:00:00Z",
    // For a guest caller, always.
    availability: null,
    availability_reason: null,
    metadata: type === "agent" ? { kind: null } : null,
    ...over,
  });
  await page.route(`**/api/v1/rooms/${GUEST_ROOM_ID}/members`, (route) =>
    route.fulfill(
      json([
        row("p-aaron", "Aaron Stransky", "human", { role: "owner" }),
        row("p-persephone", "Persephone", "agent"),
        row("p-flow", "Flow", "agent", { metadata: { kind: "guest_agent" } }),
        row("p-guest", "Morgan Ali", "guest", { is_self: true }),
      ]),
    ),
  );
  await page.route(`**/api/v1/rooms/${GUEST_ROOM_ID}/messages**`, (route) =>
    route.fulfill(json({ messages: [...history].reverse(), cursor: null, has_more: false })),
  );

  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    sockets.push(ws);
    ws.onMessage((data) => {
      let frame: { type?: string } = {};
      try {
        frame = JSON.parse(String(data)) as { type?: string };
      } catch {
        return;
      }
      if (frame.type === "auth") ws.send(JSON.stringify({ type: "auth_ok" }));
      if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    });
  });

  await page.goto("/guest/inv-e2e-0000000000");
  await page.getByPlaceholder("Ada Lovelace").fill("Morgan Ali");
  await page.getByRole("button", { name: "Join as guest" }).click();
  const room = page.getByTestId("guest-room");
  await expect(room).toBeVisible();
  await expect(room.getByText("Connected")).toBeVisible();
  return {
    room,
    /** A frame from the server, on the guest's live socket. */
    push: (frame: unknown) => {
      const socket = sockets[sockets.length - 1];
      expect(socket, "the guest socket").toBeTruthy();
      socket!.send(JSON.stringify(frame));
    },
  };
}

test.describe("Guest room (a guest's shapes)", () => {
  for (const viewport of ["mobile", "desktop"] as const) {
    test(`roster, transcript, system lines @ ${viewport}`, async ({ page }, testInfo) => {
      const vp = viewport === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      await page.setViewportSize(vp);
      const { room, push } = await joinGuestRoom(page, [
        guestLine("g-1", minutesAgo(30), GUEST_AARON, "Welcome. The portal walk-through starts in a minute."),
        guestLine("g-2", minutesAgo(29), GUEST_AARON, "Channel thread started", {
          content_type: "system",
          metadata: { kind: "thread_started", thread_room_id: "room-taxsq-t-1", thread_title: "Portal questions", created_by: "p-aaron", seed_message_id: null },
        }),
        guestLine("g-3", minutesAgo(28), GUEST_NOBODY, "Video recording started", {
          content_type: "system",
          metadata: { kind: "recording", event: "started", recording_kind: "composite", recording_id: "rec-9", started_by: "p-aaron", reason: "policy always" },
        }),
        // An agent's line as a guest gets it: no gateway, on_behalf_of, agent_id.
        guestLine("g-4", minutesAgo(27), { id: "p-persephone", name: "Persephone", type: "agent" }, "The client portal is on screen.", { metadata: {} }),
        guestLine("g-5", minutesAgo(26), { id: "p-flow", name: "Flow", type: "agent" }, "Noted for the Northbridge Tax side."),
        guestLine("g-6", minutesAgo(20), GUEST_NOBODY, "Video recording stopped", {
          content_type: "system",
          metadata: { kind: "recording", event: "stopped", recording_kind: "composite", recording_id: "rec-9", started_by: "p-aaron", reason: "stop_requested" },
        }),
      ]);

      // The transcript: agents' lines, and the system lines in words.
      await expect(room.getByText("The client portal is on screen.")).toBeVisible();
      await expect(room.getByText("Noted for the Northbridge Tax side.")).toBeVisible();
      const lines = room.getByTestId("guest-system-line");
      await expect(lines).toHaveCount(3);
      await expect(lines.nth(0)).toHaveText("Aaron Stransky started a thread: Portal questions");
      await expect(lines.nth(1)).toHaveText(
        "Video recording started · by Aaron Stransky · this room always records",
      );
      await expect(lines.nth(2)).toHaveText(
        "Video recording stopped · on request · started by Aaron Stransky",
      );
      await expect(room.getByText("Channel thread started")).toHaveCount(0);

      // Live: the socket's frame draws a local receipt; the server's
      // persisted notice then takes its place — one line, not two.
      const startedAt = new Date().toISOString();
      push({
        type: "recording_state",
        payload: {
          room_id: GUEST_ROOM_ID,
          active: true,
          kind: "audio",
          started_by: { id: "p-aaron", display_name: "Aaron Stransky" },
          started_at: startedAt,
          recording_id: "rec-10",
          reason: "user",
        },
      });
      await expect(lines).toHaveCount(4);
      await expect(lines.nth(3)).toHaveText("Recording started · audio · started by Aaron Stransky");
      push({
        type: "message",
        payload: {
          room_id: GUEST_ROOM_ID,
          message: guestLine("g-7", startedAt, GUEST_NOBODY, "Audio recording started", {
            content_type: "system",
            metadata: { kind: "recording", event: "started", recording_kind: "audio", recording_id: "rec-10", started_by: "p-aaron", reason: "user" },
          }),
        },
      });
      await expect(lines.nth(3)).toHaveText("Audio recording started · by Aaron Stransky");
      await expect(lines).toHaveCount(4);

      // While it records, the header still says which room this is, and
      // the pill stays clear of the buttons beside it.
      const box = async (testId: string) => {
        const rect = await room.getByTestId(testId).first().boundingBox();
        expect(rect, testId).not.toBeNull();
        return rect!;
      };
      await expect(room.getByTestId("rec-pill")).toBeVisible();
      expect((await box("guest-room-name")).width).toBeGreaterThan(60);
      const pill = await box("rec-pill");
      const beside =
        viewport === "mobile"
          ? await box("guest-roster-toggle")
          : (await room.getByRole("button", { name: "Leave" }).boundingBox())!;
      expect(pill.x + pill.width).toBeLessThanOrEqual(beside.x + 1);

      const tag = `${viewport}-${testInfo.project.name}`;
      await page.screenshot({ path: `test-results/NavV3-Guest-room-${tag}.png`, fullPage: false });

      // The roster draws every row: availability is not there to read.
      if (viewport === "mobile") await page.getByTestId("guest-roster-toggle").click();
      const roster = room.getByTestId("guest-roster");
      await expect(roster).toBeVisible();
      await expect(roster.getByRole("listitem")).toHaveCount(4);
      for (const name of ["Aaron Stransky", "Persephone", "Flow", "Morgan Ali"]) {
        await expect(roster.getByRole("listitem").filter({ hasText: name })).toBeVisible();
      }
      await expect(roster.getByText("AI", { exact: true })).toHaveCount(2);
      if (viewport === "mobile") {
        await page.screenshot({ path: `test-results/NavV3-Guest-roster-${tag}.png`, fullPage: false });
      }
      await assertPageHealth(page, viewport);
    });
  }

  test("a phone keeps the stage and the composer under a long transcript", async ({ page }, testInfo) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    const { room } = await joinGuestRoom(
      page,
      Array.from({ length: 40 }, (_, i) =>
        guestLine(
          `long-${i}`,
          minutesAgo(60 - i),
          GUEST_AARON,
          `Line ${i} of a long transcript, long enough to wrap on a phone.`,
        ),
      ),
    );
    await expect(room.getByText("Line 39 of a long transcript")).toBeVisible();
    const tag = `mobile-${testInfo.project.name}`;
    for (const roster of ["closed", "open"] as const) {
      if (roster === "open") await page.getByTestId("guest-roster-toggle").click();
      const stage = (await room.getByTestId("guest-stage").boundingBox())!;
      const chat = (await room.getByTestId("guest-chat").boundingBox())!;
      const composer = (await room.getByLabel("Message the room").boundingBox())!;
      // The video keeps its share of the screen …
      expect(stage.height, `stage, roster ${roster}`).toBeGreaterThanOrEqual(220);
      // … nothing is drawn over it …
      const below = roster === "open" ? (await room.getByTestId("guest-roster").boundingBox())! : chat;
      expect(below.y, `under the stage, roster ${roster}`).toBeGreaterThanOrEqual(stage.y + stage.height);
      // … and with the roster closed the message box is on the screen.
      if (roster === "closed") {
        expect(composer.y + composer.height).toBeLessThanOrEqual(MOBILE_VIEWPORT.height);
      }
      await page.screenshot({
        path: `test-results/NavV3-Guest-long-${roster}-${tag}.png`,
        fullPage: false,
      });
    }
    await assertPageHealth(page, "mobile");
  });
});
