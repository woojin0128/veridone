#!/usr/bin/env node
// Renders site/og/og.html into site/assets/og.png (the social preview image). Needs Playwright:
//   node site/og/render.mjs            (uses a global or local `playwright` install)
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  ({ chromium } = createRequire(path.join(globalRoot, '/'))('playwright'));
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(`file://${path.join(here, 'og.html')}`);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: path.join(here, '..', 'assets', 'og.png') });
await browser.close();
console.log('Wrote site/assets/og.png');
