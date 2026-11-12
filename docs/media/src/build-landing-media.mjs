// Landing page media from an E2E run: trimmed GIFs plus a still WebP poster for each.
// The page shows the poster first and loads the GIF only when it scrolls into view.
//
//   npm run e2e                                         record (writes e2e/results/gifs)
//   node docs/media/src/build-landing-media.mjs --sheet  contact sheets in e2e/results/sheets, to pick frames
//   node docs/media/src/build-landing-media.mjs          write landing/assets/media/*.gif and posters/*.webp
//
// A GIF listed in STILL_ONLY only gets a poster.
// Frames are decoded with Chromium's ImageDecoder and re-encoded with e2e/lib/gif.js, so no ffmpeg is needed.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { writeGif } from '../../../e2e/lib/gif.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const GIFS = path.join(ROOT, 'e2e', 'results', 'gifs');
const SHEETS = path.join(ROOT, 'e2e', 'results', 'sheets');
const MEDIA = path.join(ROOT, 'landing', 'assets', 'media');
const POSTERS = path.join(MEDIA, 'posters');

// name on the landing page → E2E recording (file name prefix), frames to keep [start, end), poster frame
// counted from start (-1 = last). start skips the sign-in at the beginning of each recording.
const CLIPS = {
  'results-overview': { src: '05-results-summary-numbers', start: 11, poster: 1 },
  'findings-filter': { src: '05-results-search-filters', start: 11, poster: 44 },
  history: { src: '05-results-scan-history', start: 11, poster: 7 },
  'report-export': { src: '06-reports-export-a-client', start: 11, poster: 26 },
  'share-password': { src: '06-reports-password-link', start: 11, end: 60, poster: 23 },
  'auto-setup-github': { src: '09-auto-setup-github-adds', start: 11, poster: 29 },
  setup: { src: '01-setup-admin-picks', start: 9, end: 47, poster: 3 },
};
const STILL_ONLY = {}; // GIFs that only need a poster (none now: Fig. 2 is an HTML diagram)

const sheet = process.argv.includes('--sheet');
const browser = await chromium.launch();
const page = await browser.newPage();
// ImageDecoder needs a secure context: serve a blank page from a routed https URL
await page.route('https://media.local/', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>media</title>' }));
await page.goto('https://media.local/');

/** Every frame of a GIF as { png: Buffer, delay: ms } (composited, full size) */
async function decode(file) {
  const b64 = fs.readFileSync(file).toString('base64');
  const frames = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dec = new ImageDecoder({ data: bytes, type: 'image/gif' });
    await dec.tracks.ready;
    const out = [];
    for (let i = 0; i < dec.tracks.selectedTrack.frameCount; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const c = new OffscreenCanvas(image.displayWidth, image.displayHeight);
      c.getContext('2d').drawImage(image, 0, 0);
      const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let s = ''; for (let k = 0; k < buf.length; k += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(k, k + 0x8000));
      out.push({ png: btoa(s), delay: Math.round((image.duration || 100000) / 1000) });
      image.close();
    }
    return out;
  }, b64);
  return frames.map((f) => ({ png: Buffer.from(f.png, 'base64'), delay: f.delay }));
}

/** PNG frame → WebP poster, at most maxW wide */
async function webp(png, maxW = 1280) {
  const b64 = await page.evaluate(async ({ b64, maxW }) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
    const k = Math.min(1, maxW / bmp.width);
    const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/webp', quality: 0.86 })).arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, { b64: png.toString('base64'), maxW });
  return Buffer.from(b64, 'base64');
}

/** Numbered thumbnails of every frame, to choose start and poster */
async function contactSheet(name, frames) {
  const thumbs = frames.map((f) => f.png.toString('base64'));
  const html = `<!doctype html><style>body{margin:0;background:#222;display:grid;grid-template-columns:repeat(6,320px);gap:4px;font:14px sans-serif;color:#fff}
    figure{margin:0;position:relative}img{width:320px;display:block}figcaption{position:absolute;left:4px;top:4px;background:#000c;padding:1px 5px}</style>
    ${thumbs.map((t, i) => `<figure><img src="data:image/png;base64,${t}"><figcaption>${i}</figcaption></figure>`).join('')}`;
  const p = await browser.newPage({ viewport: { width: 6 * 324, height: 800 } });
  await p.setContent(html, { waitUntil: 'load' });
  fs.mkdirSync(SHEETS, { recursive: true });
  await p.screenshot({ path: path.join(SHEETS, `${name}.png`), fullPage: true });
  await p.close();
}

const pick = (frames, i) => frames[i < 0 ? frames.length + i : Math.min(i, frames.length - 1)];
fs.mkdirSync(POSTERS, { recursive: true });

for (const [name, clip] of Object.entries(CLIPS)) {
  const src = fs.readdirSync(GIFS).find((f) => f.startsWith(clip.src) && f.endsWith('.gif'));
  if (!src) { console.warn(`${name}: no recording starting with ${clip.src} in ${GIFS}`); continue; }
  const frames = await decode(path.join(GIFS, src));
  if (sheet) { await contactSheet(name, frames); console.log(`${name}: ${frames.length} frames → sheets/${name}.png`); continue; }
  const kept = frames.slice(clip.start, clip.end ?? frames.length);
  const out = path.join(MEDIA, `${name}.gif`);
  const info = writeGif(kept, out, { lastDelay: 2600 });
  fs.writeFileSync(path.join(POSTERS, `${name}.webp`), await webp(pick(kept, clip.poster).png));
  console.log(`${name}: ${src} frames ${clip.start}..${(clip.end ?? frames.length) - 1} → ${info.width}x${info.height}, ${info.frames} frames, ${Math.round(fs.statSync(out).size / 1024)} KB`);
}

if (!sheet) {
  for (const [name, still] of Object.entries(STILL_ONLY)) {
    const file = path.join(MEDIA, `${name}.gif`);
    if (!fs.existsSync(file)) continue;
    const frames = await decode(file);
    fs.writeFileSync(path.join(POSTERS, `${name}.webp`), await webp(pick(frames, still.poster).png));
    console.log(`${name}: poster only`);
  }
}
await browser.close();
