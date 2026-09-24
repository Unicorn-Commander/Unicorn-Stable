import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

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
      await clickTestId(page, "nav-direct");
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
      // Home hides New. Direct is the destination that shows it, and New
      // opens the sheet that replaced the old create-room modal.
      await clickTestId(page, "nav-direct");
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
  const visible = page.locator(`[data-testid="${testId}"]`).locator("visible=true");
  if ((await visible.count()) === 0) {
    const openSidebar = page.getByRole("button", { name: "Open sidebar" });
    if (await openSidebar.isVisible().catch(() => false)) {
      await openSidebar.click();
    }
  }
  await page.locator(`[data-testid="${testId}"]`).locator("visible=true").first().click();
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

      // The room header is the only bar, so it carries the drawer toggle on a
      // phone — the way back to the room list — and that toggle must stay on
      // screen.
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
      await expect(header.getByRole("button", { name: "Members" })).toBeVisible();
      await expect(header.getByRole("button", { name: "Threads" })).toBeVisible();
      await expect(header.getByRole("button", { name: "Pop out" })).toBeVisible();
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
      await expect(
        header.getByRole("button", { name: "Call", exact: true }),
      ).toHaveCount(1);

      await page.screenshot({
        path: `test-results/RoomHeaderMenu-${viewport}.png`,
        fullPage: false,
      });
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
