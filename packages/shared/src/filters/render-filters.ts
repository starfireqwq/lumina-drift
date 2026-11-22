/**
 * Render filters (描繪): Perlin noise, grid pattern, and manga focus lines.
 * Pure functions on premultiplied RGBA, no DOM, deterministic output so preview matches apply.
 */

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

function parseHex(hex: string, fallback = '#111111') {
  const clean = /^#[0-9a-f]{6}$/i.test(hex) ? hex : fallback;
  const n = parseInt(clean.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Standard deterministic 256-entry permutation table for 2D gradient Perlin noise */
const PERM = new Uint8Array(512);
(() => {
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  let seed = 0x5eed1234;
  for (let i = 255; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const tmp = base[i];
    base[i] = base[j];
    base[j] = tmp;
  }
  for (let i = 0; i < 512; i++) PERM[i] = base[i & 255];
})();

const GRAD_X = [1, -1, 1, -1, 1, -1, 0, 0];
const GRAD_Y = [1, 1, -1, -1, 0, 0, 1, -1];

function fade(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function grad2(hash: number, x: number, y: number) {
  const h = hash & 7;
  return GRAD_X[h] * x + GRAD_Y[h] * y;
}

function perlin2(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const X = xi & 255;
  const Y = yi & 255;
  const u = fade(xf);
  const v = fade(yf);
  const aa = PERM[PERM[X] + Y];
  const ab = PERM[PERM[X] + Y + 1];
  const ba = PERM[PERM[X + 1] + Y];
  const bb = PERM[PERM[X + 1] + Y + 1];
  const x1 = grad2(aa, xf, yf) + u * (grad2(ba, xf - 1, yf) - grad2(aa, xf, yf));
  const x2 = grad2(ab, xf, yf - 1) + u * (grad2(bb, xf - 1, yf - 1) - grad2(ab, xf, yf - 1));
  return x1 + v * (x2 - x1);
}

/**
 * 柏林雜訊: deterministic multi-octave 2D Perlin noise rendered as opaque greyscale.
 * `scale` is the base feature size in pixels; `amplitude` (0–100) controls contrast;
 * `persistence` (0.1–0.9) is the per-octave decay; `octaves` (1–6) is layer count.
 */
export function perlinNoise(
  width: number,
  height: number,
  scale: number,
  amplitude: number,
  persistence: number,
  octaves: number,
  offsetX: number,
  offsetY: number,
) {
  const output = new Uint8Array(width * height * 4);
  const invScale = 1 / Math.max(2, scale);
  const contrast = Math.min(1.6, Math.max(0, amplitude / 100) * 1.2);
  const decay = Math.min(0.95, Math.max(0.05, persistence));
  const layers = Math.min(6, Math.max(1, Math.round(octaves)));

  let norm = 0;
  let w = 1;
  for (let o = 0; o < layers; o++) {
    norm += w;
    w *= decay;
  }
  const invNorm = norm > 0 ? 1 / norm : 1;

  for (let y = 0; y < height; y++) {
    const by = (y + offsetY) * invScale;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const bx = (x + offsetX) * invScale;
      let sum = 0;
      let freq = 1;
      let amp = 1;
      for (let o = 0; o < layers; o++) {
        sum += perlin2(bx * freq, by * freq) * amp;
        freq *= 2;
        amp *= decay;
      }
      // perlin2 spans roughly [-0.85, 0.85]; map to [0, 255] around mid-grey 127.5
      const v = Math.round(clamp255(127.5 + sum * invNorm * 165 * contrast));
      const i = (row + x) * 4;
      output[i] = v;
      output[i + 1] = v;
      output[i + 2] = v;
      output[i + 3] = 255;
    }
  }
  return output;
}

/** Porter-Duff source-over composite of a straight-colour stroke with coverage `alpha` [0..1] onto premultiplied pixel */
function overPixel(buf: Uint8Array, i: number, sr: number, sg: number, sb: number, alpha: number) {
  if (alpha <= 0) return;
  const inv = 1 - alpha;
  buf[i] = Math.round(clamp255(sr * alpha + buf[i] * inv));
  buf[i + 1] = Math.round(clamp255(sg * alpha + buf[i + 1] * inv));
  buf[i + 2] = Math.round(clamp255(sb * alpha + buf[i + 2] * inv));
  buf[i + 3] = Math.round(clamp255(255 * alpha + buf[i + 3] * inv));
}

/**
 * 格線: anti-aliased grid composited over the layer's pixels (so an empty layer receives a clean
 * transparent grid, and an artwork layer gets a non-destructive grid overlay).
 */
export function gridPattern(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  cell: number,
  lineWidth: number,
  hex: string,
  opacity: number,
  offsetX: number,
  offsetY: number,
) {
  const output = new Uint8Array(pixels);
  const step = Math.max(2, Math.round(cell));
  const half = Math.max(0.5, lineWidth * 0.5);
  const alphaMax = Math.min(1, Math.max(0, opacity / 100));
  if (alphaMax <= 0) return output;
  const { r, g, b } = parseHex(hex, '#6366f1');

  const distToLine = (coord: number, offset: number) => {
    const m = (((coord - offset) % step) + step) % step;
    return Math.min(m, step - m);
  };

  const covX = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const d = distToLine(x, offsetX);
    covX[x] = d <= half - 0.5 ? 1 : d >= half + 0.5 ? 0 : half + 0.5 - d;
  }
  for (let y = 0; y < height; y++) {
    const dy = distToLine(y, offsetY);
    const cy = dy <= half - 0.5 ? 1 : dy >= half + 0.5 ? 0 : half + 0.5 - dy;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const cov = cy > covX[x] ? cy : covX[x];
      if (cov <= 0) continue;
      overPixel(output, (row + x) * 4, r, g, b, cov * alphaMax);
    }
  }
  return output;
}

/** Deterministic integer hash to [0, 1) */
function hash01(n: number, salt: number) {
  let x = (n * 374761393 + salt * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/**
 * 集中線: tapered radial manga focus lines around (cx, cy), composited over the existing pixels.
 * `innerRadius` is a percentage (0–100) of half the canvas shorter side so it stays proportionate
 * across canvas sizes and draft previews.
 */
export function focusLines(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  density: number,
  lineWidth: number,
  innerRadiusPct: number,
  jitterPct: number,
  hex: string,
) {
  const output = new Uint8Array(pixels);
  const count = Math.min(240, Math.max(6, Math.round(density)));
  const sector = (Math.PI * 2) / count;
  const maxR = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy)) || 1;
  const baseInner = Math.min(width, height) * 0.5 * Math.min(1, Math.max(0, innerRadiusPct / 100));
  const jitter = Math.min(1, Math.max(0, jitterPct / 100));
  const halfW = Math.max(0.5, lineWidth * 0.5);
  const { r: sr, g: sg, b: sb } = parseHex(hex, '#111111');

  // Precompute per-sector deterministic ray parameters
  const rayAngle = new Float64Array(count);
  const rayStart = new Float64Array(count);
  const rayHalfWidth = new Float64Array(count);
  for (let s = 0; s < count; s++) {
    const aJitter = (hash01(s, 11) - 0.5) * 0.7 * jitter * sector;
    rayAngle[s] = (s + 0.5) * sector + aJitter;
    const rJitter = 1 + (hash01(s, 29) - 0.5) * 0.7 * jitter;
    rayStart[s] = Math.max(2, baseInner * rJitter);
    const wJitter = 1 + (hash01(s, 53) - 0.5) * 0.8 * jitter;
    rayHalfWidth[s] = Math.max(0.4, halfW * wJitter);
  }

  const TWO_PI = Math.PI * 2;
  for (let y = 0; y < height; y++) {
    const dy = y - cy;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) continue;
      let theta = Math.atan2(dy, dx);
      if (theta < 0) theta += TWO_PI;
      const centerSector = Math.floor(theta / sector) % count;

      let bestCov = 0;
      for (let off = -1; off <= 1; off++) {
        const s = (centerSector + off + count) % count;
        const start = rayStart[s];
        if (dist <= start) continue;
        let da = theta - rayAngle[s];
        if (da > Math.PI) da -= TWO_PI;
        else if (da < -Math.PI) da += TWO_PI;
        const perp = Math.abs(da) * dist;
        // Taper smoothly from 0 at start radius to full width toward outer edge
        const span = Math.max(1, maxR - start);
        const progress = Math.min(1, (dist - start) / span);
        const targetHalf = rayHalfWidth[s] * Math.pow(progress, 0.75);
        if (perp > targetHalf + 1) continue;
        // Smooth longitudinal tip fade-in over the first 4 pixels past start
        const tipFade = Math.min(1, (dist - start) / 4);
        const cov = (perp <= targetHalf - 0.5 ? 1 : perp >= targetHalf + 0.5 ? 0 : targetHalf + 0.5 - perp) * tipFade;
        if (cov > bestCov) bestCov = cov;
      }
      if (bestCov > 0) overPixel(output, (row + x) * 4, sr, sg, sb, bestCov);
    }
  }
  return output;
}
