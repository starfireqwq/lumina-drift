/**
 * Blur, distort and sharpen filters (模糊、變形、銳化). Pure functions on premultiplied RGBA, no
 * DOM, written from general image-processing methods: a running sum along slanted lines for
 * motion blur, repeated sparse passes for zoom blur, inverse mapping with bilinear sampling for
 * the distortions, and unsharp masking.
 */
import { tripleBoxBlur } from './effect-filters';

export type MotionDirection = 'both' | 'forward' | 'backward';

/**
 * 動態模糊: every pixel averages the pixels along a line `distance` long at `degrees`
 * (0 = right, 90 = up). Forward smears the picture along the angle, backward against it.
 * Each pixel is read a fixed number of times, however long the blur.
 */
export function motionBlur(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, distance: number, degrees: number, direction: MotionDirection) {
  const output = new Uint8Array(pixels);
  if (distance < 1) return output;
  const angle = degrees * Math.PI / 180;
  const ux = Math.cos(angle);
  const uy = -Math.sin(angle);
  const xMajor = Math.abs(ux) >= Math.abs(uy);
  const major = xMajor ? width : height;
  const minor = xMajor ? height : width;
  const slope = xMajor ? uy / ux : ux / uy;
  const steps = Math.max(1, Math.round(distance / Math.hypot(1, slope)));
  // Window of steps along the angle, then turned into steps along the major axis
  let lo = direction === 'forward' ? -steps : direction === 'backward' ? 0 : -Math.floor(steps / 2);
  let hi = direction === 'forward' ? 0 : direction === 'backward' ? steps : steps - Math.floor(steps / 2);
  if ((xMajor ? ux : uy) < 0) [lo, hi] = [-hi, -lo];
  const count = hi - lo + 1;
  const shift = Math.ceil(major * Math.abs(slope)) + 1;
  const line = new Int32Array(major);
  for (let start = -shift; start < minor + shift; start++) {
    let n = 0;
    for (let m = 0; m < major; m++) {
      const c = start + Math.round(m * slope);
      if (c < 0 || c >= minor) continue;
      line[n++] = xMajor ? c * width + m : m * width + c;
    }
    if (!n) continue;
    const at = (j: number) => line[j < 0 ? 0 : j >= n ? n - 1 : j] * 4;
    for (let channel = 0; channel < 4; channel++) {
      let sum = 0;
      for (let k = lo; k <= hi; k++) sum += pixels[at(k) + channel];
      for (let j = 0; j < n; j++) {
        output[line[j] * 4 + channel] = Math.round(sum / count);
        sum -= pixels[at(j + lo) + channel];
        sum += pixels[at(j + hi + 1) + channel];
      }
    }
  }
  return output;
}

/** Bilinear read of premultiplied RGBA at (x, y) into `out`; outside the picture is clear */
function sample(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, x: number, y: number, out: Float64Array) {
  out.fill(0);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  for (let j = 0; j < 2; j++) {
    const yy = y0 + j;
    if (yy < 0 || yy >= height) continue;
    const wy = j ? fy : 1 - fy;
    for (let i = 0; i < 2; i++) {
      const xx = x0 + i;
      if (xx < 0 || xx >= width) continue;
      const w = (i ? fx : 1 - fx) * wy;
      if (!w) continue;
      const p = (yy * width + xx) * 4;
      out[0] += pixels[p] * w;
      out[1] += pixels[p + 1] * w;
      out[2] += pixels[p + 2] * w;
      out[3] += pixels[p + 3] * w;
    }
  }
}

/** Fills each pixel from where `source(x, y)` says it comes from (null = leave the pixel as it is) */
function remap(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, source: (x: number, y: number) => [number, number] | null) {
  const output = new Uint8Array(pixels);
  const color = new Float64Array(4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = source(x, y);
      if (!from) continue;
      sample(pixels, width, height, from[0], from[1], color);
      const i = (y * width + x) * 4;
      for (let k = 0; k < 4; k++) output[i + k] = Math.round(color[k]);
    }
  }
  return output;
}

export type ZoomDirection = 'both' | 'in' | 'out';

/**
 * 放射模糊: smears along the lines through the centre. `strength` (1–100) is how far, as a share
 * of each pixel's distance from the centre; in pulls from nearer the centre, out from farther.
 * Three sparse passes of six reads add up to 216 evenly spread reads.
 */
export function zoomBlur(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, cx: number, cy: number, strength: number, direction: ZoomDirection) {
  const span = Math.min(100, Math.max(0, strength)) / 200;
  if (!span) return new Uint8Array(pixels);
  const taps = 6;
  let start = direction === 'in' ? -span : direction === 'out' ? 0 : -span / 2;
  let current: Uint8Array | Uint8ClampedArray = pixels;
  let step = span / taps;
  // A read's column depends only on x and its row only on y: both are worked out once per pass
  const columns = new Int32Array(taps * width);
  const rows = new Int32Array(taps);
  for (let pass = 0; pass < 3; pass++) {
    const next = new Uint8Array(pixels.length);
    for (let t = 0; t < taps; t++) {
      const scale = 1 + start + t * step;
      for (let x = 0; x < width; x++) columns[t * width + x] = Math.min(width - 1, Math.max(0, Math.round(cx + (x - cx) * scale)));
    }
    for (let y = 0; y < height; y++) {
      const dy = y - cy;
      for (let t = 0; t < taps; t++) {
        const scale = 1 + start + t * step;
        rows[t] = Math.min(height - 1, Math.max(0, Math.round(cy + dy * scale))) * width;
      }
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let t = 0; t < taps; t++) {
          const p = (rows[t] + columns[t * width + x]) * 4;
          r += current[p];
          g += current[p + 1];
          b += current[p + 2];
          a += current[p + 3];
        }
        const i = (y * width + x) * 4;
        next[i] = Math.round(r / taps);
        next[i + 1] = Math.round(g / taps);
        next[i + 2] = Math.round(b / taps);
        next[i + 3] = Math.round(a / taps);
      }
    }
    current = next;
    start = 0;
    step /= taps;
  }
  return current as Uint8Array;
}

/**
 * 柔化: a light 3 × 3 blur (1-2-1 weights), done as a row pass and a column pass. The row sums are
 * kept whole (three rows at a time), so the result is the same as the 3 × 3 sum rounded once.
 */
export function soften(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number) {
  const output = new Uint8Array(pixels.length);
  const len = width * 4;
  if (!len || !height) return output;
  const rowSums = (y: number, into: Uint16Array) => {
    const base = y * len;
    for (let i = 0; i < len; i++) {
      const left = i < 4 ? i : i - 4;
      const right = i >= len - 4 ? i : i + 4;
      into[i] = pixels[base + left] + 2 * pixels[base + i] + pixels[base + right];
    }
  };
  let above = new Uint16Array(len), middle = new Uint16Array(len), below = new Uint16Array(len);
  rowSums(0, middle);
  above.set(middle);
  for (let y = 0; y < height; y++) {
    if (y + 1 < height) rowSums(y + 1, below);
    else below.set(middle);
    const row = y * len;
    // Math.round(sum / 16), .5 rounding up
    for (let i = 0; i < len; i++) output[row + i] = (above[i] + 2 * middle[i] + below[i] + 8) >> 4;
    [above, middle, below] = [middle, below, above];
  }
  return output;
}

export type WaveDirection = 'horizontal' | 'vertical' | 'both';

/** 波浪: rows sway sideways (horizontal), columns sway up and down (vertical), or both */
export function wave(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, direction: WaveDirection, amplitude: number, wavelength: number) {
  const k = (2 * Math.PI) / Math.max(1, wavelength);
  const sideways = direction !== 'vertical';
  const upDown = direction !== 'horizontal';
  return remap(pixels, width, height, (x, y) => [
    sideways ? x - amplitude * Math.sin(y * k) : x,
    upDown ? y - amplitude * Math.sin(x * k) : y,
  ]);
}

/**
 * 球面化: inside an ellipse round the centre, positive strength bulges the middle out, negative
 * pinches it in. `squash` (−90…90 %) flattens the ellipse across (negative) or down (positive).
 */
export function spherize(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, cx: number, cy: number,
  strength: number, radius: number, squash: number) {
  const s = Math.min(100, Math.max(-100, strength)) / 100;
  if (!s) return new Uint8Array(pixels);
  const exponent = s > 0 ? 1 + 1.5 * s : 1 / (1 - 1.5 * s);
  const rx = Math.max(1, radius * (squash < 0 ? 1 + squash / 100 : 1));
  const ry = Math.max(1, radius * (squash > 0 ? 1 - squash / 100 : 1));
  return remap(pixels, width, height, (x, y) => {
    const nx = (x - cx) / rx;
    const ny = (y - cy) / ry;
    const d = Math.hypot(nx, ny);
    if (d >= 1 || d === 0) return null;
    const factor = Math.pow(d, exponent) / d;
    return [cx + nx * factor * rx, cy + ny * factor * ry];
  });
}

/**
 * 銳化 / 進階銳化 (unsharp mask): each channel moves away from a blurred copy by `amount` %,
 * where it differs by at least `threshold`. Colour never exceeds alpha (premultiplied).
 */
export function unsharpMask(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, radius: number, amount: number, threshold: number) {
  // Three box passes of the radius itself, so each step of the radius slider blurs a little more
  const blurred = tripleBoxBlur(pixels, width, height, radius);
  const gain = Math.max(0, amount) / 100;
  const output = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    for (let k = 0; k < 4; k++) {
      const v = pixels[i + k];
      const diff = v - blurred[i + k];
      output[i + k] = Math.abs(diff) < threshold ? v : Math.min(255, Math.max(0, Math.round(v + diff * gain)));
    }
    const a = output[i + 3];
    for (let k = 0; k < 3; k++) if (output[i + k] > a) output[i + k] = a;
  }
  return output;
}
