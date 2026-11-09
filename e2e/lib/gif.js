// Turns PNG frames into one animated GIF, in pure JS (no ffmpeg).
// Each frame stores only the pixels that changed since the last one (the rest is transparent),
// so a smooth, many-frame recording stays small.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);
const { GIFEncoder, quantize } = require('gifenc');

const BG = [20, 20, 21]; // page background of the dark theme
const DRIFT = 12; // also redraw a pixel once what the viewer sees is this far (summed RGB) from the truth
const EXACT = 96; // the most common colours of each frame (backgrounds, borders, text) are kept exact,
                  // so a repainted background matches the untouched background around it (no ghost outlines)

/** A 255-colour palette for these pixels: the top colours exactly, the rest quantized; plus an index per pixel */
function paletteFor(sample) {
  const counts = new Map();
  for (let k = 0; k < sample.length; k += 4) {
    const key = (sample[k] << 16) | (sample[k + 1] << 8) | sample[k + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let palette;
  if (counts.size <= 255) palette = [...counts.keys()].map((c) => [c >> 16, (c >> 8) & 255, c & 255]);
  else {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, EXACT).map(([c]) => c);
    const rest = quantize(sample, 255 - EXACT, { format: 'rgb565' });
    palette = [...top.map((c) => [c >> 16, (c >> 8) & 255, c & 255]), ...rest];
  }
  const near = new Map(); // colour -> nearest palette index, full precision
  const lookup = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    let best = near.get(key);
    if (best !== undefined) return best;
    let bd = Infinity;
    for (let j = 0; j < palette.length; j++) {
      const c = palette[j], d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
      if (d < bd) { bd = d; best = j; if (!d) break; }
    }
    near.set(key, best);
    return best;
  };
  return { palette, lookup };
}

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
 * frames: [{ png: Buffer, delay?: ms }] in order. Writes the GIF to outPath.
 * Width is about maxWidth (smaller pages are not upscaled). A frame's own `delay` wins over the
 * default `delay`; the last frame holds `lastDelay`. Frames identical to the previous one are merged.
 */
export function writeGif(frames, outPath, { maxWidth = 1280, delay = 1000, lastDelay = 2600 } = {}) {
  if (!frames.length) return null;
  const first = PNG.sync.read(frames[0].png);
  const scale = Math.min(1, maxWidth / first.width);
  const W = Math.round(first.width * scale), H = Math.round(first.height * scale);
  const N = W * H;
  const shown = new Uint8ClampedArray(N * 4); // what a viewer currently sees
  let prev = null;                            // the previous source frame, exact
  const gif = GIFEncoder();
  let pending = null; // a frame is written once we know how long it stays
  let written = 0;

  const flush = (extraLast) => {
    if (!pending) return;
    const ms = extraLast ?? pending.delay;
    gif.writeFrame(pending.index, W, H, { palette: pending.palette, delay: Math.max(20, Math.round(ms)), repeat: 0,
      transparent: pending.transparent, transparentIndex: 255, dispose: 1 });
    written++;
    pending = null;
  };

  frames.forEach((f, i) => {
    const img = i === 0 ? first : PNG.sync.read(f.png);
    const rgba = fit(img.data, img.width, img.height, W, H);
    const ms = f.delay ?? delay;
    const changed = new Uint8Array(N);
    let count = 0;
    for (let p = 0; p < N; p++) {
      const o = p * 4;
      // any real change is redrawn (a slow fade must not leave a ghost behind)
      if (i === 0 || rgba[o] !== prev[o] || rgba[o + 1] !== prev[o + 1] || rgba[o + 2] !== prev[o + 2]
        || Math.abs(rgba[o] - shown[o]) + Math.abs(rgba[o + 1] - shown[o + 1]) + Math.abs(rgba[o + 2] - shown[o + 2]) > DRIFT) { changed[p] = 1; count++; }
    }
    prev = rgba;
    if (!count) { if (pending) pending.delay += ms; return; } // nothing new on screen: just hold longer
    flush();
    // palette from the changed pixels only, index 255 kept for "unchanged"
    const sample = new Uint8ClampedArray(count * 4);
    for (let p = 0, k = 0; p < N; p++) if (changed[p]) { sample.set(rgba.subarray(p * 4, p * 4 + 4), k); k += 4; }
    const { palette, lookup } = paletteFor(sample);
    while (palette.length < 256) palette.push([0, 0, 0]);
    const index = new Uint8Array(N);
    for (let p = 0; p < N; p++) {
      if (!changed[p]) { index[p] = 255; continue; }
      const o = p * 4;
      const c = palette[index[p] = lookup(rgba[o], rgba[o + 1], rgba[o + 2])];
      shown[o] = c[0]; shown[o + 1] = c[1]; shown[o + 2] = c[2];
    }
    pending = { index, palette, delay: ms, transparent: i > 0 };
  });
  if (pending) flush(Math.max(pending.delay, lastDelay));
  gif.finish();
  fs.writeFileSync(outPath, gif.bytes());
  return { width: W, height: H, frames: written };
}
