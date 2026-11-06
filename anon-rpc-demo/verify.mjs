// Headless check of the demo. It starts server.mjs, opens the page in
// Chromium, prints the page console, and exits 0 when the demo is done.
// Usage: node verify.mjs [worker]   (default: nox)
// Set CHROMIUM_PATH to use a specific Chromium binary.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const worker = process.argv[2] ?? "nox";
const port = process.env.PORT ?? "5174";
const timeoutMs = Number(process.env.VERIFY_TIMEOUT_MS ?? 180_000);

// Find a Chromium binary. First CHROMIUM_PATH, then the Playwright default,
// then the newest Chromium in the Playwright cache.
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const fallback = chromium.executablePath();
  if (existsSync(fallback)) return fallback;
  const cache = process.platform === "darwin"
    ? join(homedir(), "Library/Caches/ms-playwright")
    : join(homedir(), ".cache/ms-playwright");
  const candidates = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const dir of candidates) {
    for (const rel of [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      "chrome-linux/chrome",
      "chrome-linux64/chrome",
    ]) {
      const p = join(cache, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  throw new Error("no Chromium found. Run `npx playwright-core install chromium` or set CHROMIUM_PATH.");
}

const server = spawn(process.execPath, ["server.mjs"], { env: { ...process.env, PORT: port }, stdio: ["ignore", "inherit", "inherit"] });
await new Promise((r) => setTimeout(r, 500));

const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
let code = 1;
try {
  const page = await browser.newPage();
  page.on("console", (m) => console.log(`page> ${m.text()}`));
  page.on("pageerror", (e) => console.log(`page error> ${e.message}`));
  await page.goto(`http://localhost:${port}/?worker=${worker}`);
  await page.waitForFunction(() => document.body.dataset.status !== undefined, null, { timeout: timeoutMs });
  const status = await page.evaluate(() => document.body.dataset.status);
  console.log(`verify: status=${status}`);
  code = status === "done" ? 0 : 1;
} finally {
  await browser.close();
  server.kill();
}
process.exit(code);
