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
