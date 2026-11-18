// Builds every Lumina Drift icon from one square, full-bleed artwork PNG.
//
//   node scripts/generate-icons.mjs [source.png]
//
// Default source: resources/icon-source.png (not packaged — extraResources lists files one by one).
// Writes resources/icon.ico, resources/icon.png, resources/lumina-file.ico,
// public/logo.svg and public/logo-wordmark.svg. No dependencies: zlib only.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resDir = path.resolve(__dirname, '../resources');
const publicDir = path.resolve(__dirname, '../public');
const sourcePath = path.resolve(process.argv[2] || path.join(resDir, 'icon-source.png'));

// ---------------------------------------------------------------- PNG I/O

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function encodePngRGBA(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 8-bit, non-interlaced grey / grey+alpha / RGB / RGBA PNG → RGBA buffer. */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Source is not a PNG file');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (bitDepth !== 8 || interlace !== 0 || !channels) {
    throw new Error(`Unsupported PNG (bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}); re-save it as 8-bit RGB/RGBA`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (channels >= 3) {
        out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2];
      } else {
        out[d] = out[d + 1] = out[d + 2] = cur[s];
      }
      out[d + 3] = channels === 4 ? cur[s + 3] : channels === 2 ? cur[s + 1] : 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, rgba: out };
}

// ---------------------------------------------------------------- colour + geometry helpers

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb8(l) {
  const v = l <= 0 ? 0 : l >= 1 ? 1 : l;
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(c * 255);
}

function clamp(v, min = 0, max = 255) {
  return v < min ? min : v > max ? max : Math.round(v);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function sdRoundedBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// ---------------------------------------------------------------- source artwork

const source = decodePng(fs.readFileSync(sourcePath));
const SW = source.width;
const SH = source.height;

/** Premultiplied linear-light RGBA, so downsampling keeps glows bright instead of muddy. */
const sourceLinear = (() => {
  const lin = new Float32Array(SW * SH * 4);
  for (let i = 0; i < SW * SH; i++) {
    const a = source.rgba[i * 4 + 3] / 255;
    lin[i * 4] = SRGB_TO_LINEAR[source.rgba[i * 4]] * a;
    lin[i * 4 + 1] = SRGB_TO_LINEAR[source.rgba[i * 4 + 1]] * a;
    lin[i * 4 + 2] = SRGB_TO_LINEAR[source.rgba[i * 4 + 2]] * a;
    lin[i * 4 + 3] = a;
  }
  return lin;
})();

/** Background = mean of the four corner patches; the mark = rows/columns that clearly differ from it. */
const markBox = (() => {
  const patch = Math.max(4, Math.round(SW / 64));
  let br = 0, bg = 0, bb = 0, count = 0;
  for (const [cx, cy] of [[0, 0], [SW - patch, 0], [0, SH - patch], [SW - patch, SH - patch]]) {
    for (let y = cy; y < cy + patch; y++) {
      for (let x = cx; x < cx + patch; x++) {
        const i = (y * SW + x) * 4;
        br += source.rgba[i]; bg += source.rgba[i + 1]; bb += source.rgba[i + 2]; count++;
      }
    }
  }
  br /= count; bg /= count; bb /= count;
  const cols = new Uint32Array(SW);
  const rows = new Uint32Array(SH);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const i = (y * SW + x) * 4;
      const diff = Math.max(Math.abs(source.rgba[i] - br), Math.abs(source.rgba[i + 1] - bg), Math.abs(source.rgba[i + 2] - bb));
      if (diff > 64) { cols[x]++; rows[y]++; }
    }
  }
  const minRun = Math.max(4, Math.round(SW * 0.006)); // ignores tiny sparkles
  const first = (arr) => arr.findIndex((v) => v >= minRun);
  const last = (arr) => arr.length - 1 - [...arr].reverse().findIndex((v) => v >= minRun);
  const x0 = first(cols), x1 = last(cols), y0 = first(rows), y1 = last(rows);
  const darkBackground = (0.2126 * br + 0.7152 * bg + 0.0722 * bb) < 128;
  if (x0 < 0 || y0 < 0) return { x0: 0, y0: 0, x1: SW - 1, y1: SH - 1, darkBackground };
  return { x0, x1, y0, y1, darkBackground };
})();

/** Square crop window that makes the mark span `fill` of the tile, centred on the mark. */
function cropWindow(fill) {
  const markSide = Math.max(markBox.x1 - markBox.x0 + 1, markBox.y1 - markBox.y0 + 1);
  const side = Math.min(SW, SH, markSide / fill);
  const cx = (markBox.x0 + markBox.x1 + 1) / 2;
  const cy = (markBox.y0 + markBox.y1 + 1) / 2;
  return {
    sx: Math.min(Math.max(cx - side / 2, 0), SW - side),
    sy: Math.min(Math.max(cy - side / 2, 0), SH - side),
    side,
  };
}

/** Area-average a square source window down to n×n (premultiplied linear). */
function resampleSquare({ sx, sy, side }, n) {
  const out = new Float32Array(n * n * 4);
  const scale = side / n;
  for (let oy = 0; oy < n; oy++) {
    const y0 = sy + oy * scale, y1 = y0 + scale;
    for (let ox = 0; ox < n; ox++) {
      const x0 = sx + ox * scale, x1 = x0 + scale;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        if (yy < 0 || yy >= SH) continue;
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        if (wy <= 0) continue;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          if (xx < 0 || xx >= SW) continue;
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (yy * SW + xx) * 4;
          r += sourceLinear[i] * w; g += sourceLinear[i + 1] * w; b += sourceLinear[i + 2] * w; a += sourceLinear[i + 3] * w;
          wsum += w;
        }
      }
      const o = (oy * n + ox) * 4;
      if (wsum > 0) { out[o] = r / wsum; out[o + 1] = g / wsum; out[o + 2] = b / wsum; out[o + 3] = a / wsum; }
    }
  }
  return out;
}

/**
 * The app tile: the artwork cropped around its mark, masked to a rounded square with
 * anti-aliased edges and a faint inner rim so the tile still separates from a same-colour taskbar.
 *   inset  — transparent padding in px on each side
 *   fill   — share of the tile the mark spans (smaller sizes zoom in so the mark stays readable)
 *   radius — corner radius as a share of the tile side (0 = square, no mask)
 */
function renderTile(n, { inset = 0, fill = 0.76, radius = 0.225, rim = true } = {}) {
  const t = n - inset * 2;
  const art = resampleSquare(cropWindow(fill), t);
  const out = Buffer.alloc(n * n * 4);
  const ss = 4;
  const half = t / 2;
  const r = radius * t;
  const rimWidth = Math.max(1, t / 160);
  const rimColor = markBox.darkBackground ? 1 : 0;
  const rimStrength = markBox.darkBackground ? 0.12 : 0.08;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4;
      const tx = x - inset, ty = y - inset;
      if (tx < 0 || ty < 0 || tx >= t || ty >= t) continue;
      let coverage = 1;
      if (radius > 0) {
        let inside = 0;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            if (sdRoundedBox(tx + (sx + 0.5) / ss, ty + (sy + 0.5) / ss, half, half, half, half, r) <= 0) inside++;
          }
        }
        coverage = inside / (ss * ss);
      }
      if (coverage === 0) continue;
      const i = (ty * t + tx) * 4;
      const a = art[i + 3];
      let lr = a > 0 ? art[i] / a : 0, lg = a > 0 ? art[i + 1] / a : 0, lb = a > 0 ? art[i + 2] / a : 0;
      if (rim) {
        const d = -sdRoundedBox(tx + 0.5, ty + 0.5, half, half, half, half, r); // distance inside the edge
        const k = rimStrength * (1 - smoothstep(0, rimWidth, d));
        lr = lerp(lr, rimColor, k); lg = lerp(lg, rimColor, k); lb = lerp(lb, rimColor, k);
      }
      out[o] = linearToSrgb8(lr);
      out[o + 1] = linearToSrgb8(lg);
      out[o + 2] = linearToSrgb8(lb);
      out[o + 3] = clamp(coverage * a * 255);
    }
  }
  return out;
}

/** Windows-style padding: 1px at 16, 16px at 256. Small sizes zoom in on the mark. */
function renderAppIcon(size) {
  return renderTile(size, {
    inset: Math.max(1, Math.floor(size / 16)),
    fill: size <= 32 ? 0.84 : 0.76,
  });
}

function sampleBilinear(rgba, n, fx, fy) {
  const x = Math.min(Math.max(fx - 0.5, 0), n - 1);
  const y = Math.min(Math.max(fy - 0.5, 0), n - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, n - 1), y1 = Math.min(y0 + 1, n - 1);
  const tx = x - x0, ty = y - y0;
  const px = (xx, yy, c) => rgba[(yy * n + xx) * 4 + c];
  const ch = (c) => lerp(lerp(px(x0, y0, c), px(x1, y0, c), tx), lerp(px(x0, y1, c), px(x1, y1, c), tx), ty);
  return { r: ch(0), g: ch(1), b: ch(2) };
}

// ---------------------------------------------------------------- .lumina document icon

const BADGE = { cx: 0.74, cy: 0.76, half: 0.17, radius: 0.06 };

function renderLuminaFileIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const badgePx = Math.max(4, Math.round(BADGE.half * 2 * size));
  const badgeArt = renderTile(badgePx, { inset: 0, fill: 0.84, radius: 0, rim: false });
  for (let y = 0; y < size; y++) {
    const ny = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size;
      const idx = (y * size + x) * 4;

      // Document page card (with subtle rounded corners)
      const dPage = sdRoundedBox(nx, ny, 0.48, 0.50, 0.36, 0.44, 0.06);
      const alphaPage = 1 - smoothstep(-0.005, 0.007, dPage);

      // App-tile badge in the bottom-right
      const dBadge = sdRoundedBox(nx, ny, BADGE.cx, BADGE.cy, BADGE.half, BADGE.half, BADGE.radius);
      const alphaBadge = 1 - smoothstep(-0.005, 0.007, dBadge);

      const totalAlpha = Math.max(alphaPage, alphaBadge);
      if (totalAlpha <= 0) continue;

      // Page base: crisp studio white/slate frame with inner artwork canvas
      let r = 242, g = 245, b = 252;

      const dCanvas = sdRoundedBox(nx, ny, 0.48, 0.46, 0.30, 0.33, 0.03);
      const inCanvas = 1 - smoothstep(-0.004, 0.006, dCanvas);
      if (inCanvas > 0) {
        const split = nx - 0.48 + 0.08 * Math.sin(ny * 6.0);
        const side = smoothstep(-0.08, 0.08, split);
        const cr = lerp(34, 244, side);
        const cg = lerp(195, 78, side);
        const cb = lerp(255, 162, side);

        const dFrame = Math.abs(sdRoundedBox(nx, ny, 0.48, 0.45, 0.09, 0.13, 0.01));
        const frameGlow = 1 - smoothstep(0.012, 0.026, dFrame);
        r = lerp(r, lerp(cr, 250, frameGlow), inCanvas);
        g = lerp(g, lerp(cg, 190, frameGlow), inCanvas);
        b = lerp(b, lerp(cb, 60, frameGlow), inCanvas);
      }

      if (alphaBadge > 0) {
        const bx = ((nx - (BADGE.cx - BADGE.half)) / (BADGE.half * 2)) * badgePx;
        const by = ((ny - (BADGE.cy - BADGE.half)) / (BADGE.half * 2)) * badgePx;
        const art = sampleBilinear(badgeArt, badgePx, bx, by);
        r = lerp(r, art.r, alphaBadge);
        g = lerp(g, art.g, alphaBadge);
        b = lerp(b, art.b, alphaBadge);
      }

      buf[idx] = clamp(r);
      buf[idx + 1] = clamp(g);
      buf[idx + 2] = clamp(b);
      buf[idx + 3] = clamp(totalAlpha * 255);
    }
  }
  return buf;
}

// ---------------------------------------------------------------- containers

function buildIcoFile(sizes, renderFn) {
  const pngBuffers = sizes.map((sz) => encodePngRGBA(sz, sz, renderFn(sz)));
  const count = sizes.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = ICO
  header.writeUInt16LE(count, 4);

  const dirEntries = Buffer.alloc(count * 16);
  let offset = 6 + count * 16;
  for (let i = 0; i < count; i++) {
    const sz = sizes[i];
    const png = pngBuffers[i];
    const e = i * 16;
    dirEntries[e + 0] = sz >= 256 ? 0 : sz;
    dirEntries[e + 1] = sz >= 256 ? 0 : sz;
    dirEntries.writeUInt16LE(1, e + 4); // colour planes
    dirEntries.writeUInt16LE(32, e + 6); // bits per pixel
    dirEntries.writeUInt32LE(png.length, e + 8);
    dirEntries.writeUInt32LE(offset, e + 12);
    offset += png.length;
  }
  return Buffer.concat([header, dirEntries, ...pngBuffers]);
}

function logoSvg(png, viewBox, body, title) {
  const href = `data:image/png;base64,${png.toString('base64')}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="none" role="img" aria-labelledby="title">
  <title id="title">${title}</title>
${body(href)}
</svg>
`;
}

// ---------------------------------------------------------------- write

fs.mkdirSync(resDir, { recursive: true });

const icoSizes = [256, 64, 48, 40, 32, 24, 20, 16];
const appIco = buildIcoFile(icoSizes, renderAppIcon);
const luminaIco = buildIcoFile([256, 64, 48, 32, 24, 16], renderLuminaFileIcon);
fs.writeFileSync(path.join(resDir, 'icon.ico'), appIco);
fs.writeFileSync(path.join(resDir, 'lumina-file.ico'), luminaIco);
fs.writeFileSync(path.join(resDir, 'icon.png'), encodePngRGBA(256, 256, renderAppIcon(256)));

// Web logo: no padding (the page sets the size); 160px covers 44px at 3x.
const webPng = encodePngRGBA(160, 160, renderTile(160, { fill: 0.8 }));
fs.writeFileSync(
  path.join(publicDir, 'logo.svg'),
  logoSvg(webPng, '0 0 160 160', (href) => `  <image width="160" height="160" href="${href}"/>`, 'Lumina Drift — flowing light'),
);
fs.writeFileSync(
  path.join(publicDir, 'logo-wordmark.svg'),
  logoSvg(webPng, '0 0 840 256', (href) => `  <image x="24" y="24" width="208" height="208" href="${href}"/>
  <g fill="#F4F4F5" font-family="Inter, 'Noto Sans TC', system-ui, sans-serif">
    <text x="286" y="132" font-size="86" font-weight="600" letter-spacing="-3">Lumina Drift</text>
    <text x="290" y="191" font-size="34" font-weight="400" letter-spacing="8">流光</text>
  </g>`, 'Lumina Drift · 流光'),
);

console.log(`Source ${path.relative(process.cwd(), sourcePath)} (${SW}x${SH}), mark box ${markBox.x0},${markBox.y0} → ${markBox.x1},${markBox.y1}`);
console.log(`Generated icon.ico (${appIco.length} bytes), lumina-file.ico (${luminaIco.length} bytes), icon.png in ${resDir}`);
console.log(`Generated logo.svg and logo-wordmark.svg (${webPng.length} byte tile) in ${publicDir}`);
