export type ColorWheelMode = 'hsv-square' | 'hls-triangle';

export interface TriangleVerts {
  c: [number, number];
  w: [number, number];
  k: [number, number];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360;
  const ss = Math.max(0, Math.min(1, s));
  const ll = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  let r1 = 0, g1 = 0, b1 = 0;
  if (hh < 60) { r1 = c; g1 = x; }
  else if (hh < 120) { r1 = x; g1 = c; }
  else if (hh < 180) { g1 = c; b1 = x; }
  else if (hh < 240) { g1 = x; b1 = c; }
  else if (hh < 300) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = (60 * ((gn - bn) / d) + 360) % 360;
    else if (max === gn) h = 60 * ((bn - rn) / d) + 120;
    else h = 60 * ((rn - gn) / d) + 240;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [Math.round(h), s, l];
}

export function getTriangleVertices(cx: number, cy: number, radius: number, hueDeg: number): TriangleVerts {
  const aC = (hueDeg * Math.PI) / 180;
  const aW = aC - (2 * Math.PI) / 3;
  const aK = aC + (2 * Math.PI) / 3;
  return {
    c: [cx + Math.cos(aC) * radius, cy + Math.sin(aC) * radius],
    w: [cx + Math.cos(aW) * radius, cy + Math.sin(aW) * radius],
    k: [cx + Math.cos(aK) * radius, cy + Math.sin(aK) * radius],
  };
}

export function hsvToBarycentric(s: number, v: number): [number, number, number] {
  const ss = Math.max(0, Math.min(1, s));
  const vv = Math.max(0, Math.min(1, v));
  const wc = vv * ss;
  const ww = vv * (1 - ss);
  const wk = Math.max(0, 1 - vv);
  return [wc, ww, wk];
}

export function barycentricToHsv(hueDeg: number, wc: number, ww: number, fallbackSat = 0): [number, number, number] {
  const c = Math.max(0, Math.min(1, wc));
  const w = Math.max(0, Math.min(1 - c, ww));
  const v = Math.max(0, Math.min(1, c + w));
  const s = v <= 1e-5 ? fallbackSat : Math.max(0, Math.min(1, c / v));
  return [((hueDeg % 360) + 360) % 360, s, v];
}

export function clampPointToTriangleBarycentric(px: number, py: number, tri: TriangleVerts): [number, number, number] {
  const [x1, y1] = tri.c;
  const [x2, y2] = tri.w;
  const [x3, y3] = tri.k;
  const denom = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
  if (Math.abs(denom) < 1e-6) return [1, 0, 0];
  const wc = ((y2 - y3) * (px - x3) + (x3 - x2) * (py - y3)) / denom;
  const ww = ((y3 - y1) * (px - x3) + (x1 - x3) * (py - y3)) / denom;
  const wk = 1 - wc - ww;
  if (wc >= 0 && ww >= 0 && wk >= 0) return [wc, ww, wk];

  const edges: Array<{ a: [number, number]; b: [number, number]; idxA: 0 | 1 | 2; idxB: 0 | 1 | 2 }> = [
    { a: tri.c, b: tri.w, idxA: 0, idxB: 1 },
    { a: tri.w, b: tri.k, idxA: 1, idxB: 2 },
    { a: tri.k, b: tri.c, idxA: 2, idxB: 0 },
  ];
  let bestDistSq = Infinity;
  let best: [number, number, number] = [1, 0, 0];
  for (const e of edges) {
    const abx = e.b[0] - e.a[0];
    const aby = e.b[1] - e.a[1];
    const lenSq = abx * abx + aby * aby || 1;
    const t = Math.max(0, Math.min(1, ((px - e.a[0]) * abx + (py - e.a[1]) * aby) / lenSq));
    const qx = e.a[0] + abx * t;
    const qy = e.a[1] + aby * t;
    const dSq = (px - qx) * (px - qx) + (py - qy) * (py - qy);
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      const out: [number, number, number] = [0, 0, 0];
      out[e.idxA] = 1 - t;
      out[e.idxB] = t;
      best = out;
    }
  }
  return best;
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = (h % 360 + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  v = Math.max(0, Math.min(1, v));

  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let r1 = 0, g1 = 0, b1 = 0;
  if (h >= 0 && h < 60) {
    r1 = c; g1 = x; b1 = 0;
  } else if (h >= 60 && h < 120) {
    r1 = x; g1 = c; b1 = 0;
  } else if (h >= 120 && h < 180) {
    r1 = 0; g1 = c; b1 = x;
  } else if (h >= 180 && h < 240) {
    r1 = 0; g1 = x; b1 = c;
  } else if (h >= 240 && h < 300) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }

  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  let cleaned = hex.replace('#', '');
  if (cleaned.length === 3) {
    cleaned = cleaned.split('').map((c) => c + c).join('');
  }
  const num = parseInt(cleaned, 16);
  if (isNaN(num)) return [0, 0, 0];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const diff = max - min;

  let h = 0;
  if (diff === 0) {
    h = 0;
  } else if (max === r) {
    h = (60 * ((g - b) / diff) + 360) % 360;
  } else if (max === g) {
    h = 60 * ((b - r) / diff) + 120;
  } else {
    h = 60 * ((r - g) / diff) + 240;
  }

  const s = max === 0 ? 0 : diff / max;
  const v = max;
  return [Math.round(h), s, v];
}
