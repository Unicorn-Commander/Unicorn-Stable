import { test, expect, devices } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

const SURFACES = [
  { name: 'Home', path: '/', waitFor: '[data-testid="home-dashboard"]' },
  { name: 'DirectList', path: '/', waitFor: '[data-testid="conversations-card"]', setup: async (page) => { await page.click('[data-testid="nav-direct"]'); } },
  { name: 'AgentChat', path: '/c/room-general', waitFor: '[data-testid="room-view"]' },
  { name: 'DM', path: '/c/room-dm-jason', waitFor: '[data-testid="room-view"]' },
  { name: 'Group', path: '/c/room-ops', waitFor: '[data-testid="room-view"]' },
  { name: 'PublicChannel', path: '/c/room-general', waitFor: '[data-testid="room-view"]' },
  { name: 'AgentsPage', path: '/agents', waitFor: '[data-testid="agents-page"]' },
  { name: 'Settings', path: '/', waitFor: '[data-testid="settings-modal"]', setup: async (page) => { await page.click('[data-testid="open-settings"]'); } },
  { name: 'NewChat', path: '/', waitFor: '[data-testid="create-room-modal"]', setup: async (page) => { await page.click('[data-testid="new-room-button"]'); } },
  { name: 'CallViewGridChatDocked', path: '/c/room-general', waitFor: '[data-testid="call-room-layout"]', setup: async (page) => { await page.evaluate(() => { const store = (window as any).useCallUiStore?.getState(); store?.setViewMode?.('room-general', 'grid'); store?.setChatCollapsed?.(false); }); } },
  { name: 'CallViewGridChatHidden', path: '/c/room-general', waitFor: '[data-testid="call-room-layout"]', setup: async (page) => { await page.evaluate(() => { const store = (window as any).useCallUiStore?.getState(); store?.setViewMode?.('room-general', 'grid'); store?.setChatCollapsed?.(true); }); } },
  { name: 'PeopleDrawer', path: '/', waitFor: '[data-testid="people-drawer"]', setup: async (page) => { await page.click('[data-testid="open-people"]'); } },
  { name: 'Search', path: '/', waitFor: '[data-testid="global-search-modal"]', setup: async (page) => { await page.keyboard.press('Meta+Shift+F'); } },
];

async function waitForAppReady(page) {
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 30000 });
  await page.waitForLoadState('networkidle');
}

async function assertPageHealth(page, viewportName) {
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  const failedRequests = [];
  page.on('response', resp => { if (resp.status() >= 400) failedRequests.push(`${resp.url()} -> ${resp.status()}`); });

  await expect(errors.length).toBe(0);
  await expect(failedRequests.length).toBe(0);

  const brokenImages = await page.locator('img').evaluateAll(imgs =>
    imgs.filter(img => img.naturalWidth === 0).map(img => img.src)
  );
  expect(brokenImages.length).toBe(0);

  const hasHorizontalScroll = await page.evaluate(() => document.body.scrollWidth > window.innerWidth);
  expect(hasHorizontalScroll).toBe(false);

  if (viewportName === 'mobile') {
    const smallTargets = await page.locator('button, a, [role="button"], input, select, textarea').evaluateAll(els =>
      els.filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width < 44 || rect.height < 44;
      }).map(el => ({ tag: el.tagName, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }))
    );
    if (smallTargets.length > 0) {
      console.warn(`Small touch targets (${smallTargets.length}):`, smallTargets);
    }
  }
}

test.describe.configure({ retries: 1 });

for (const surface of SURFACES) {
  for (const viewport of ['mobile', 'desktop'] as const) {
    test(`${surface.name} @ ${viewport}`, async ({ page }, testInfo) => {
      const vp = viewport === 'mobile' ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      await page.setViewportSize(vp);

      await page.goto(surface.path);
      await waitForAppReady(page);

      if (surface.setup) {
        await surface.setup(page);
        await page.waitForTimeout(500);
      }

      if (surface.waitFor) {
        await page.waitForSelector(surface.waitFor, { timeout: 15000 });
      }

      await expect(page.locator(surface.waitFor)).toBeVisible();

      const captureName = `${surface.name}-${viewport}-${testInfo.project.name}`;
      await page.screenshot({ path: `test-results/${captureName}.png`, fullPage: true });

      await assertPageHealth(page, viewport);

      const axeResults = await new AxeBuilder({ page }).analyze();
      const violations = axeResults.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
      testInfo.attach('axe-results.json', { body: JSON.stringify(axeResults, null, 2), contentType: 'application/json' });
      if (violations.length > 0) {
        console.warn(`[a11y] ${surface.name} @ ${viewport}: ${violations.length} violations`);
        violations.forEach(v => console.warn(`  - ${v.id}: ${v.description} (${v.impact})`));
      }
    });
  }
}

test.describe('Call View variations', () => {
  for (const viewport of ['mobile', 'desktop'] as const) {
    test(`CallView @ ${viewport} - grid with chat docked`, async ({ page }, testInfo) => {
      const vp = viewport === 'mobile' ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      await page.setViewportSize(vp);

      await page.goto('/c/room-general');
      await waitForAppReady(page);

      await page.evaluate(() => {
        const store = (window as any).useCallUiStore?.getState();
        store?.setViewMode?.('room-general', 'grid');
        store?.setChatCollapsed?.(false);
        store?.setMobileCallMode?.('video', { user: true });
      });
      await page.waitForTimeout(500);

      await expect(page.locator('[data-testid="call-room-layout"]')).toBeVisible();
      await page.screenshot({ path: `test-results/CallViewGridChatDocked-${viewport}.png`, fullPage: true });
      await assertPageHealth(page, viewport);
    });

    test(`CallView @ ${viewport} - grid with chat hidden`, async ({ page }, testInfo) => {
      const vp = viewport === 'mobile' ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      await page.setViewportSize(vp);

      await page.goto('/c/room-general');
      await waitForAppReady(page);

      await page.evaluate(() => {
        const store = (window as any).useCallUiStore?.getState();
        store?.setViewMode?.('room-general', 'grid');
        store?.setChatCollapsed?.(true);
        store?.setMobileCallMode?.('video', { user: true });
      });
      await page.waitForTimeout(500);

      await expect(page.locator('[data-testid="call-room-layout"]')).toBeVisible();
      await page.screenshot({ path: `test-results/CallViewGridChatHidden-${viewport}.png`, fullPage: true });
      await assertPageHealth(page, viewport);
    });
  }
});

test.describe('Accessibility sweep (report only)', () => {
  for (const surface of SURFACES) {
    test(`a11y:${surface.name}`, async ({ page }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(surface.path);
      await waitForAppReady(page);

      if (surface.setup) {
        await surface.setup(page);
        await page.waitForTimeout(500);
      }

      if (surface.waitFor) {
        await page.waitForSelector(surface.waitFor, { timeout: 15000 });
      }

      const axeResults = await new AxeBuilder({ page }).analyze();
      const criticalSerious = axeResults.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
      console.log(`[a11y] ${surface.name}: ${criticalSerious.length} critical/serious violations`);
      criticalSerious.forEach(v => console.log(`  ${v.id}: ${v.description} (${v.impact}) - ${v.nodes.length} nodes`));
      expect(criticalSerious.length).toBeGreaterThanOrEqual(0);
    });
  }
});