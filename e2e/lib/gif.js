// Turns the PNG screenshots of a test into one animated GIF, in pure JS (no ffmpeg).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const BG = [20, 20, 21]; // page background of the dark theme

/** Area-average downscale of RGBA data into a w x h box, letterboxed into W x H */
function fit(src, sw, sh, W, H) {
  const scale = Math.min(W / sw, H / sh, 1);
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  const ox = Math.floor((W - w) / 2), oy = 0;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { out[i * 4] = BG[0]; out[i * 4 + 1] = BG[1]; out[i * 4 + 2] = BG[2]; out[i * 4 + 3] = 255; }
  const fx = sw / w, fy = sh / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < sh; yy++) {
        let p = (yy * sw + x0) * 4;
        for (let xx = x0; xx < x1 && xx < sw; xx++, p += 4) { r += src[p]; g += src[p + 1]; b += src[p + 2]; n++; }
      }
      const o = ((y + oy) * W + x + ox) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * frames: [{ png: Buffer }] in order. Writes the GIF to outPath.
 * Width is about maxWidth (smaller pages are not upscaled); every frame holds `delay` ms, the last one `lastDelay`.
 */
export function writeGif(frames, outPath, { maxWidth = 1280, delay = 1000, lastDelay = 2600 } = {}) {
  const decoded = frames.map((f) => PNG.sync.read(f.png));
  if (!decoded.length) return null;
  const first = decoded[0];
  const scale = Math.min(1, maxWidth / first.width);
  const W = Math.round(first.width * scale), H = Math.round(first.height * scale);
  const gif = GIFEncoder();
  decoded.forEach((img, i) => {
    const rgba = fit(img.data, img.width, img.height, W, H);
    const palette = quantize(rgba, 256, { format: 'rgb565' });
    const index = applyPalette(rgba, palette, 'rgb565');
    gif.writeFrame(index, W, H, { palette, delay: i === decoded.length - 1 ? lastDelay : delay, repeat: 0 });
  });
  gif.finish();
  fs.writeFileSync(outPath, gif.bytes());
  return { width: W, height: H, frames: decoded.length };
}
