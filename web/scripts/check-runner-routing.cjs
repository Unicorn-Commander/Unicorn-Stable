const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("fs");
const path = require("path");
const out = path.resolve(
  process.env.RECEIPT_DIR || "../docs/receipts/runner-agent-routing",
);
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const requests = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.pathname.startsWith("/api/")) {
      requests.push({ path: url.pathname, method: req.method() });
      let body = {};
      if (url.pathname.endsWith("/chat-route"))
        body = { backend: "runner", room_id: "canonical-fixture" };
      else if (url.pathname.endsWith("/rooms/canonical-fixture"))
        body = {
          id: "canonical-fixture",
          name: "fixture-room",
          display_name: "Demo runner",
          room_type: "dm",
          members: [],
        };
      else if (url.pathname.endsWith("/messages"))
        body = { messages: [], has_more: false };
      else if (url.pathname.endsWith("/members")) body = { members: [] };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    }
    if (url.hostname !== "127.0.0.1") return route.abort();
    return route.continue();
  });
  await page.goto("http://127.0.0.1:5189/fixtures/runner-routing.html");
  await page.getByRole("button", { name: "Start chat", exact: true }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".glass-heavy")].every(
      (el) => !el.style.opacity || Number(el.style.opacity) > 0.99,
    ),
  );
  await page.screenshot({ path: path.join(out, "picker.png") });
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  await page.waitForURL("**/c/canonical-fixture");
  await page.getByRole("button", { name: "Simulate upstream failure" }).click();
  await page.getByText("Agent couldn't answer", { exact: true }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".glass-heavy")].every(
      (el) => !el.style.opacity || Number(el.style.opacity) > 0.99,
    ),
  );
  await page.screenshot({ path: path.join(out, "toast.png") });
  if (requests.some((r) => r.method === "POST"))
    throw new Error("Unexpected POST: " + JSON.stringify(requests));
  if (errors.length) throw new Error(errors.join("\n"));
  fs.writeFileSync(
    path.join(out, "browser.json"),
    JSON.stringify({ url: page.url(), requests, errors }, null, 2),
  );
  console.log(JSON.stringify({ url: page.url(), requests, errors }));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
