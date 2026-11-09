// Builds docs/media/architecture.gif: an animated flow chart of how ScanHub works.
// Usage: node docs/media/src/build-architecture.mjs   (logos are in docs/media/src/logos, see its README)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { writeGif } from '../../../e2e/lib/gif.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const iconDir = path.join(here, 'logos');
const iconPath = (slug) => fs.readFileSync(path.join(iconDir, slug + '.svg'), 'utf8').match(/ d="([^"]+)"/)[1];

let html = fs.readFileSync(path.join(here, 'architecture.html'), 'utf8');
html = html.replace(/\{\{icon:([a-z0-9]+)\}\}/g, (_, s) => iconPath(s));
html = html.replace(/\{\{img:([\w.-]+)\}\}/g, (_, f) => `data:${f.endsWith('.png') ? 'image/png' : 'image/svg+xml'};base64,${fs.readFileSync(path.join(iconDir, f)).toString('base64')}`);
html = html.replace('{{logo}}', fs.readFileSync(path.join(here, '../../../public/logo-dark.svg'), 'utf8'));

const FRAMES = Number(process.env.FRAMES || 64);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.setContent(html);
if (process.env.PREVIEW) { // PREVIEW=0.3,0.5 out-dir: write still frames only
  for (const t of process.env.PREVIEW.split(',')) {
    await page.evaluate((v) => window.setT(v), Number(t));
    await page.screenshot({ path: path.join(process.argv[2] || '.', `arch-${t}.png`) });
  }
  await browser.close();
  process.exit(0);
}
const frames = [];
for (let i = 0; i < FRAMES; i++) {
  await page.evaluate((t) => window.setT(t), i / FRAMES);
  frames.push({ png: await page.screenshot() });
}
await browser.close();
const out = path.join(here, '../architecture.gif');
const info = writeGif(frames, out, { maxWidth: 1100, delay: 90, lastDelay: 90 });
console.log(out, info, Math.round(fs.statSync(out).size / 1024) + ' KB');
