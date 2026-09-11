const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("fs");
const path = require("path");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const out = path.resolve("../docs/receipts/mobile-facetime");
    fs.mkdirSync(out, { recursive: true });
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1"
        ? route.continue()
        : route.abort(),
    );
    await page.goto("http://127.0.0.1:5190/fixtures/mobile-call.html");
    await page.waitForFunction(
      () => document.querySelector("video")?.readyState >= 2,
    );
    const stage = await page.getByTestId("portrait-call-stage").boundingBox();
    const remote = await page.getByTestId("remote-video").boundingBox();
    if (JSON.stringify(stage) !== JSON.stringify(remote))
      throw Error("Remote does not fill stage");
    if (
      (await page
        .getByTestId("remote-video")
        .evaluate((el) => getComputedStyle(el).objectFit)) !== "cover"
    )
      throw Error("Video does not cover");
    await page.screenshot({ path: path.join(out, "portrait.png") });
    const handle = page.getByRole("button", { name: "Move self-view" });
    const bounds = await handle.boundingBox();
    await page.mouse.move(bounds.x + 40, bounds.y + 10);
    await page.mouse.down();
    await page.mouse.move(-150, 1000, { steps: 8 });
    await page.mouse.up();
    const pip = await page.getByTestId("self-view").boundingBox();
    if (pip.x < 0 || pip.y + pip.height > 844 - 120)
      throw Error("Self-view escaped bounds");
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    const keyed = await page.getByTestId("self-view").boundingBox();
    if (keyed.x !== pip.x + 16) throw Error("Keyboard did not move self-view");
    await page.screenshot({ path: path.join(out, "dragged.png") });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.getByTestId("landscape-grid").waitFor();
    if (await page.getByTestId("portrait-call-stage").count())
      throw Error("Portrait stage survived landscape");
    await page.screenshot({ path: path.join(out, "landscape.png") });
    if (errors.length) throw Error(errors.join("\n"));
    fs.writeFileSync(
      path.join(out, "browser.json"),
      JSON.stringify({ stage, remote, pip, errors }, null, 2),
    );
    console.log(
      "PASS: cover bounds, drag clamp, keyboard move, landscape grid; no browser errors",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
