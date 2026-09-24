#!/usr/bin/env node
// Renders the settings popup in headless Chrome with the extension installed,
// once in light and once in dark colour scheme, and saves screenshots.
//
//   node test/popup-screenshot.mjs [--out test/out] [--chrome /usr/bin/google-chrome]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : [])).filter((e) => e.length)
);
const outDir = path.resolve(args.out || path.join(here, 'out'));
const chromePath = args.chrome || '/usr/bin/google-chrome';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  enableExtensions: true,
  args: ['--no-sandbox', '--hide-scrollbars'],
  defaultViewport: { width: 360, height: 480 },
});

try {
  const id = await browser.installExtension(repoRoot);
  const page = await browser.newPage();
  for (const scheme of ['light', 'dark']) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await page.goto(`chrome-extension://${id}/popup/popup.html`, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 200));
    const size = await page.evaluate(() => ({ w: document.body.scrollWidth, h: document.body.scrollHeight }));
    const file = path.join(outDir, `popup-${scheme}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: size.w, height: size.h } });
    console.log(`${file} (${size.w}x${size.h})`);
  }
} finally {
  await browser.close();
}
