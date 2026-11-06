// Find Chromium for playwright-core: CHROMIUM_PATH, the Playwright default, then the newest
// cached Chromium (the same rules as packages/prover/dev/gate.ts).

import { existsSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

export function findChromium(): string {
  const configured = process.env["CHROMIUM_PATH"];
  if (configured !== undefined && configured !== "") return configured;
  const fallback = chromium.executablePath();
  if (existsSync(fallback)) return fallback;
  const cache = platform() === "darwin" ? join(homedir(), "Library/Caches/ms-playwright") : join(homedir(), ".cache/ms-playwright");
  const dirs = existsSync(cache)
    ? readdirSync(cache)
        .filter((dir) => /^chromium-\d+$/.test(dir))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    : [];
  for (const dir of dirs) {
    for (const rel of [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      "chrome-linux/chrome",
      "chrome-linux64/chrome",
    ]) {
      const path = join(cache, dir, rel);
      if (existsSync(path)) return path;
    }
  }
  throw new Error("no Chromium found. Run `npx playwright-core install chromium` or set CHROMIUM_PATH.");
}
