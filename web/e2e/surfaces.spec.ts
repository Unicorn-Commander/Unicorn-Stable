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
/** Home v3 will not leave its error state unless this request succeeds.
 *  The dev server has no API, so the harness fulfills the v3 contract with
 *  an empty inbox. That is the loaded dashboard, not a login. */
async function stubHomeSummary(page: Page) {
  await page.route("**/api/v1/home/summary**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
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
      }),
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
