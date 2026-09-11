const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("fs");
const path = require("path");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      const status = new EventTarget(); status.state = "granted";
      Object.defineProperty(navigator, "permissions", { value: { query: async () => status } });
    });
    await page.goto("http://127.0.0.1:5191/fixtures/mic-meter.html");
    await page.getByRole("button", { name: "Start signal" }).click();
    await page
      .getByRole("meter", { name: "Mic signal", exact: true })
      .waitFor();
    const out = path.resolve("../docs/receipts/voice-polish");
    fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, "mic-signal.png") });
    await page.getByRole("button", { name: "Silence", exact: true }).click();
    await page
      .getByRole("meter", { name: "No mic signal", exact: true })
      .waitFor();
    await page.screenshot({ path: path.join(out, "mic-silence.png") });
    await page.getByRole("button", { name: "Toggle mute" }).click();
    await page.getByRole("meter", { name: "Mic muted", exact: true }).waitFor();
    await page.getByText("Mic permission: granted", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Simulate interrupted capture" }).click();
    await page.getByRole("alert").filter({ hasText: "Microphone interrupted" }).waitFor();
    await page.screenshot({ path: path.join(out, "mic-interrupted.png") });
    const reports = await page.evaluate(() => window.micDiagnostics);
    if (!reports.some((r) => r.reason === "track_change" && r.track_muted === true)) throw Error("Missing interruption diagnostic");
    if (errors.length) throw Error(errors.join("\n"));
    console.log(
      "PASS: signal, silence and muted meter states; no browser errors",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
