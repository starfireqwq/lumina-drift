/**
 * Outline brush (描邊筆刷): after a stroke, every pixel of the stroke colour in the area is one
 * region and a ring of the outline colour is drawn just outside it. Strokes of the same colour
 * therefore merge under one outer outline; the ring is painted over any other colour, so a new
 * colour's outline sits on top of what was there instead of blending into it.
 */
export interface OutlineSettings {
  enabled: boolean;
  width: number; // px
  color: string; // #rrggbb
}

const parseHex = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', '').slice(0, 6).padEnd(6, '0'), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// Colour distance per channel (anti-aliased / mixed edges just outside it get the ring)
const TOLERANCE = 40;
const MIN_ALPHA = 96;
/** Fainter stroke-coloured pixels are the stroke's own soft edge: the ring goes under them */
const FAINT_ALPHA = 8;
/** The ring also reaches this far under the region's edge, behind its anti-aliased pixels */
const UNDER_EDGE = 2;

/** Two-pass chamfer distance (orthogonal 1, diagonal √2) to the nearest 0: close to Euclidean, linear time */
const chamfer = (dist: Float32Array, w: number, h: number) => {
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let d = dist[p];
      if (d === 0) continue;
      if (x > 0) d = Math.min(d, dist[p - 1] + 1);
      if (y > 0) {
        d = Math.min(d, dist[p - w] + 1);
        if (x > 0) d = Math.min(d, dist[p - w - 1] + D);
        if (x < w - 1) d = Math.min(d, dist[p - w + 1] + D);
      }
      dist[p] = d;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x;
      let d = dist[p];
      if (d === 0) continue;
      if (x < w - 1) d = Math.min(d, dist[p + 1] + 1);
      if (y < h - 1) {
        d = Math.min(d, dist[p + w] + 1);
        if (x < w - 1) d = Math.min(d, dist[p + w + 1] + D);
        if (x > 0) d = Math.min(d, dist[p + w - 1] + D);
      }
      dist[p] = d;
    }
  }
};

/**
 * px: premultiplied RGBA of a w×h window, modified in place.
 * Returns true when any pixel changed.
 */
export const applyColorOutline = (px: Uint8Array, w: number, h: number, strokeColor: string, outline: OutlineSettings): boolean => {
  const [cr, cg, cb] = parseHex(strokeColor);
  const [or, og, ob] = parseHex(outline.color);
  const n = w * h;
  const INF = 1e9;
  const dist = new Float32Array(n); // to the region (0 inside)
  const inner = new Float32Array(n); // inside the region: to the nearest pixel outside it
  /** 1 where the pixel has the stroke colour (any visible alpha): the stroke or its soft edge */
  const strokeish = new Uint8Array(n);
  let any = false;

  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const a = px[i + 3];
    let inRegion = false;
    if (a >= FAINT_ALPHA) {
      const k = 255 / a;
      if (Math.abs(px[i] * k - cr) <= TOLERANCE && Math.abs(px[i + 1] * k - cg) <= TOLERANCE && Math.abs(px[i + 2] * k - cb) <= TOLERANCE) {
        strokeish[p] = 1;
        inRegion = a >= MIN_ALPHA;
      }
    }
    dist[p] = inRegion ? 0 : INF;
    inner[p] = inRegion ? INF : 0;
    if (inRegion) any = true;
  }
  if (!any) return false;
  chamfer(dist, w, h);
  chamfer(inner, w, h);

  let changed = false;
  // Solid for `width` px, then a one-pixel anti-aliased fade
  const reach = outline.width + 1;
  for (let p = 0; p < n; p++) {
    const d = dist[p];
    const i = p * 4;
    const a = px[i + 3] / 255;
    if (strokeish[p]) {
      // The stroke's own pixels: the ring is laid UNDER them (a border drawn below the stroke, as
      // in CSP), up to UNDER_EDGE px inside the region's edge. Its semi-transparent anti-aliased
      // edge then blends into the ring instead of letting the background show between them (the
      // gap the old ring-on-top left). Deeper inside, a translucent stroke is left as it is.
      const cover = d === 0 ? Math.min(1, Math.max(0, UNDER_EDGE + 1 - inner[p])) : Math.min(1, Math.max(0, reach - d));
      if (cover <= a) continue;
      const add = cover - a; // premultiplied: stroke OVER (ring at `cover`) = px + ring × (cover − a)
      px[i] = Math.min(255, Math.round(px[i] + or * add));
      px[i + 1] = Math.min(255, Math.round(px[i + 1] + og * add));
      px[i + 2] = Math.min(255, Math.round(px[i + 2] + ob * add));
      px[i + 3] = Math.round(255 * cover);
      changed = true;
      continue;
    }
    if (d === 0 || d >= reach) continue;
    // Anything else in the ring (empty space, other colours): the ring is painted on top
    const ao = Math.min(1, reach - d);
    px[i] = Math.round(or * ao + px[i] * (1 - ao));
    px[i + 1] = Math.round(og * ao + px[i + 1] * (1 - ao));
    px[i + 2] = Math.round(ob * ao + px[i + 2] * (1 - ao));
    px[i + 3] = Math.round(255 * ao + px[i + 3] * (1 - ao));
    changed = true;
  }
  return changed;
};
