// Builds docs/media/banner.png (2560x1280) from banner.html, the logo in public/ and an app screenshot.
// The E2E results spec saves the screenshot and its numbers to e2e/results/shots/ (npm run e2e first).
// Usage: node docs/media/src/build-banner.mjs [screenshot.png]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const shot = process.argv[2] || path.join(root, 'e2e/results/shots/repo.png');
const numsFile = path.join(path.dirname(shot), 'repo.json');
const nums = fs.existsSync(numsFile) ? JSON.parse(fs.readFileSync(numsFile, 'utf8')) : { open: 68, new: '+2', fixed: 2 };

let html = fs.readFileSync(path.join(here, 'banner.html'), 'utf8')
  .replace('{{logo}}', fs.readFileSync(path.join(root, 'public/logo-dark.svg'), 'utf8'))
  .replace('{{shot}}', 'data:image/png;base64,' + fs.readFileSync(shot).toString('base64'))
  .replace('{{open}}', nums.open).replace('{{new}}', nums.new).replace('{{fixed}}', nums.fixed);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: 'load' });
const out = path.join(root, 'docs/media/banner.png');
await page.screenshot({ path: out });
await browser.close();
console.log(out);
