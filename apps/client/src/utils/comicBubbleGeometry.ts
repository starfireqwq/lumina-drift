/**
 * Pure geometry, vector command IR, dual-layer union / seamless transparency
 * rendering, and text layout module for comic speech balloons.
 *
 * Zero relative runtime imports and zero transpile-only TypeScript syntax so it
 * runs identically in Vite, `tsc --noEmit`, and `node --experimental-strip-types`.
 */

export type BalloonShape = 'oval' | 'rect' | 'spiky' | 'thought';
export type TextOrientation = 'horizontal' | 'vertical';

export interface ComicPoint {
  x: number;
  y: number;
}

export interface ComicRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComicBalloonItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: BalloonShape;
  cornerRadius?: number;
  /** Relative to balloon center (cx, cy) */
  tailPos: ComicPoint;
  tailEnabled: boolean;
  /**
   * Aspect-normalized angle in degrees [0, 360) around balloon perimeter
   * (0 = +x right, 90 = +y bottom, 180 = -x left, 270 = -y top).
   * Undefined means auto-align toward `tailPos`.
   */
  tailBaseAngle?: number;
  /** Tail base width along the perimeter in canvas px (default 28) */
  tailWidth?: number;
  /** Tail curvature factor in [-1, 1] (0 = straight, default 0) */
  tailCurve?: number;
  /** Text line height multiplier (default 1.25) */
  lineHeight?: number;
  /** Deterministic seed for spiky / thought shapes (defaults to balloon id) */
  shapeSeed?: number | string;
  bgColor: string;
  borderColor: string;
  borderWidth: number;
  text: string;
  fontSize: number;
  fontColor: string;
  fontFamily: string;
  orientation: TextOrientation;
  strokeColor: string;
  strokeWidth: number;
}

export type PathCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'Q'; cx: number; cy: number; x: number; y: number }
  | { type: 'C'; cx1: number; cy1: number; cx2: number; cy2: number; x: number; y: number }
  | { type: 'Z' };

export interface CanvasPathTarget {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
  closePath(): void;
}

export interface OffscreenCanvasLike {
  width: number;
  height: number;
  getContext(contextId: '2d'): CanvasRenderingContext2D | null;
}

export type OffscreenCanvasFactory = (width: number, height: number) => OffscreenCanvasLike | null;

export interface ResolvedTailParams {
  tailBaseAngle: number;
  isAutoBaseAngle: boolean;
  tailWidth: number;
  tailCurve: number;
}

export interface PerimeterSample {
  point: ComicPoint;
  normal: ComicPoint;
  tangent: ComicPoint;
  arcLength: number;
  perimeter: number;
}

export interface BalloonGeometryResult {
  center: ComicPoint;
  bodyCommands: PathCommand[];
  tailCommands: PathCommand[];
  dotCommands: PathCommand[][];
  isTailSpliced: boolean;
  tailSuppressed: boolean;
  /** Canvas-space coordinates */
  tailBaseCenter: ComicPoint;
  tailBaseLeft: ComicPoint;
  tailBaseRight: ComicPoint;
  tailTip: ComicPoint;
  tailCurveHandle: ComicPoint;
  ctrlLeft: ComicPoint;
  ctrlRight: ComicPoint;
  /** Center-relative coordinates for overlay handles */
  tailLocal: {
    baseCenter: ComicPoint;
    baseLeft: ComicPoint;
    baseRight: ComicPoint;
    tip: ComicPoint;
    curveHandle: ComicPoint;
    chordLength: number;
    maxBend: number;
  };
  resolvedTail: ResolvedTailParams;
  bounds: ComicRect;
  safeTextBounds: ComicRect;
}

export interface BalloonTextItem {
  text: string;
  x: number;
  y: number;
  rotationDeg: number;
}

export interface BalloonTextLayout {
  orientation: TextOrientation;
  font: string;
  fontSize: number;
  lineHeightPx: number;
  safeBounds: ComicRect;
  items: BalloonTextItem[];
}

export interface BalloonRenderPlan {
  geometry: BalloonGeometryResult;
  mode: 'opaque-dual-layer' | 'isolated-alpha';
  bgAlpha: number;
  borderAlpha: number;
  borderWidth: number;
  hasFill: boolean;
  hasBorder: boolean;
  shapes: PathCommand[][];
  strokes: Array<{ commands: PathCommand[]; lineWidth: number; strokeStyle: string }>;
  punchOuts: PathCommand[][];
  fills: Array<{ commands: PathCommand[]; fillStyle: string }>;
}

export const DEFAULT_TAIL_WIDTH = 28;
export const DEFAULT_TAIL_CURVE = 0;
export const DEFAULT_LINE_HEIGHT = 1.25;

const KAPPA = 0.5522847498307936; // 4 * (Math.SQRT2 - 1) / 3
const MIN_BALLOON_W = 20;
const MIN_BALLOON_H = 20;

export function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return val < min ? min : val > max ? max : val;
}

export function normalizeAngleDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 90;
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function roundCoord(n: number): number {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

function lerpPoint(a: ComicPoint, b: ComicPoint, t: number): ComicPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function normalizeVec(x: number, y: number, fallbackX = 0, fallbackY = 1): ComicPoint {
  const len = Math.hypot(x, y);
  if (len < 1e-9) return { x: fallbackX, y: fallbackY };
  return { x: x / len, y: y / len };
}

export function resolveBalloonTailParams(
  b: Pick<ComicBalloonItem, 'tailPos' | 'tailBaseAngle' | 'tailWidth' | 'tailCurve'> & {
    width?: number;
    height?: number;
  }
): ResolvedTailParams {
  const rx = Math.max(10, (b.width ?? 200) / 2);
  const ry = Math.max(10, (b.height ?? 110) / 2);
  const tx = b.tailPos?.x ?? 0;
  const ty = b.tailPos?.y ?? 0;
  const hasDir = Number.isFinite(tx) && Number.isFinite(ty) && Math.hypot(tx, ty) > 1e-6;
  const autoAngleDeg = hasDir ? (Math.atan2(ty / ry, tx / rx) * 180) / Math.PI : 90;

  const isAutoBaseAngle =
    b.tailBaseAngle === undefined || b.tailBaseAngle === null || !Number.isFinite(b.tailBaseAngle);
  const tailBaseAngle = normalizeAngleDeg(isAutoBaseAngle ? autoAngleDeg : (b.tailBaseAngle as number));

  const rawWidth =
    typeof b.tailWidth === 'number' && Number.isFinite(b.tailWidth) ? b.tailWidth : DEFAULT_TAIL_WIDTH;
  const tailWidth = clamp(rawWidth, 8, 80);

  const rawCurve =
    typeof b.tailCurve === 'number' && Number.isFinite(b.tailCurve) ? b.tailCurve : DEFAULT_TAIL_CURVE;
  const tailCurve = clamp(rawCurve, -1, 1);

  return {
    tailBaseAngle,
    isAutoBaseAngle,
    tailWidth,
    tailCurve,
  };
}

// --- Color helpers ----------------------------------------------------------

export function parseColorAlpha(color: string | undefined | null): number {
  if (!color) return 0;
  const s = color.trim().toLowerCase();
  if (!s || s === 'transparent' || s === 'none') return 0;

  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) return 1;
    if (hex.length === 4) {
      const a = parseInt(hex[3] + hex[3], 16);
      return Number.isFinite(a) ? clamp(a / 255, 0, 1) : 1;
    }
    if (hex.length === 6) return 1;
    if (hex.length === 8) {
      const a = parseInt(hex.slice(6, 8), 16);
      return Number.isFinite(a) ? clamp(a / 255, 0, 1) : 1;
    }
    return 1;
  }

  const rgbaMatch = s.match(/^rgba?\(\s*([^)]+)\s*\)$/);
  if (rgbaMatch) {
    const inner = rgbaMatch[1];
    if (inner.includes('/')) {
      const [, alphaPart] = inner.split('/');
      if (alphaPart !== undefined) {
        const aStr = alphaPart.trim();
        if (aStr.endsWith('%')) {
          const pct = parseFloat(aStr.slice(0, -1));
          return Number.isFinite(pct) ? clamp(pct / 100, 0, 1) : 1;
        }
        const a = parseFloat(aStr);
        return Number.isFinite(a) ? clamp(a, 0, 1) : 1;
      }
    }
    const parts = inner.split(',').map((p) => p.trim());
    if (parts.length >= 4) {
      const aStr = parts[3];
      if (aStr.endsWith('%')) {
        const pct = parseFloat(aStr.slice(0, -1));
        return Number.isFinite(pct) ? clamp(pct / 100, 0, 1) : 1;
      }
      const a = parseFloat(aStr);
      return Number.isFinite(a) ? clamp(a, 0, 1) : 1;
    }
    return 1;
  }

  return 1;
}

export function toOpaqueRgbColor(color: string | undefined | null): string {
  if (!color) return '#000000';
  const s = color.trim();
  const lower = s.toLowerCase();
  if (!lower || lower === 'transparent' || lower === 'none') return '#000000';

  if (lower.startsWith('#')) {
    const hex = lower.slice(1);
    if (hex.length === 3) return s;
    if (hex.length === 4) {
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    }
    if (hex.length === 6) return s;
    if (hex.length === 8) {
      return `#${hex.slice(0, 6)}`;
    }
    return s;
  }

  const rgbaMatch = lower.match(/^rgba?\(\s*([^)]+)\s*\)$/);
  if (rgbaMatch) {
    const inner = rgbaMatch[1].split('/')[0].trim();
    const parts = inner.includes(',') ? inner.split(',').map((p) => p.trim()) : inner.split(/\s+/);
    if (parts.length >= 3) {
      return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
    }
  }

  return s;
}

// --- Deterministic PRNG -----------------------------------------------------

function hashSeed(seed: number | string): number {
  const str = String(seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h || 1;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Path IR serialization --------------------------------------------------

export function commandsToSvgPath(cmds: PathCommand[]): string {
  const parts: string[] = [];
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    if (c.type === 'M') {
      parts.push(`M ${roundCoord(c.x)} ${roundCoord(c.y)}`);
    } else if (c.type === 'L') {
      parts.push(`L ${roundCoord(c.x)} ${roundCoord(c.y)}`);
    } else if (c.type === 'Q') {
      parts.push(`Q ${roundCoord(c.cx)} ${roundCoord(c.cy)} ${roundCoord(c.x)} ${roundCoord(c.y)}`);
    } else if (c.type === 'C') {
      parts.push(
        `C ${roundCoord(c.cx1)} ${roundCoord(c.cy1)} ${roundCoord(c.cx2)} ${roundCoord(c.cy2)} ${roundCoord(c.x)} ${roundCoord(c.y)}`
      );
    } else {
      parts.push('Z');
    }
  }
  return parts.join(' ');
}

export function traceCommandsToCtx(ctx: CanvasPathTarget, cmds: PathCommand[]): void {
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    if (c.type === 'M') {
      ctx.moveTo(c.x, c.y);
    } else if (c.type === 'L') {
      ctx.lineTo(c.x, c.y);
    } else if (c.type === 'Q') {
      ctx.quadraticCurveTo(c.cx, c.cy, c.x, c.y);
    } else if (c.type === 'C') {
      ctx.bezierCurveTo(c.cx1, c.cy1, c.cx2, c.cy2, c.x, c.y);
    } else {
      ctx.closePath();
    }
  }
}

function translateCommands(cmds: PathCommand[], dx: number, dy: number): PathCommand[] {
  return cmds.map((c): PathCommand => {
    if (c.type === 'M') return { type: 'M', x: c.x + dx, y: c.y + dy };
    if (c.type === 'L') return { type: 'L', x: c.x + dx, y: c.y + dy };
    if (c.type === 'Q') return { type: 'Q', cx: c.cx + dx, cy: c.cy + dy, x: c.x + dx, y: c.y + dy };
    if (c.type === 'C') {
      return {
        type: 'C',
        cx1: c.cx1 + dx,
        cy1: c.cy1 + dy,
        cx2: c.cx2 + dx,
        cy2: c.cy2 + dy,
        x: c.x + dx,
        y: c.y + dy,
      };
    }
    return { type: 'Z' };
  });
}

// --- Shape perimeter & body builders (center-relative coordinates) ----------

function buildCircleCommands(cx: number, cy: number, r: number): PathCommand[] {
  const k = r * KAPPA;
  return [
    { type: 'M', x: cx + r, y: cy },
    { type: 'C', cx1: cx + r, cy1: cy + k, cx2: cx + k, cy2: cy + r, x: cx, y: cy + r },
    { type: 'C', cx1: cx - k, cy1: cy + r, cx2: cx - r, cy2: cy + k, x: cx - r, y: cy },
    { type: 'C', cx1: cx - r, cy1: cy - k, cx2: cx - k, cy2: cy - r, x: cx, y: cy - r },
    { type: 'C', cx1: cx + k, cy1: cy - r, cx2: cx + r, cy2: cy - k, x: cx + r, y: cy },
    { type: 'Z' },
  ];
}

function buildOvalBodyLocal(rx: number, ry: number): PathCommand[] {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    { type: 'M', x: rx, y: 0 },
    { type: 'C', cx1: rx, cy1: ky, cx2: kx, cy2: ry, x: 0, y: ry },
    { type: 'C', cx1: -kx, cy1: ry, cx2: -rx, cy2: ky, x: -rx, y: 0 },
    { type: 'C', cx1: -rx, cy1: -ky, cx2: -kx, cy2: -ry, x: 0, y: -ry },
    { type: 'C', cx1: kx, cy1: -ry, cx2: rx, cy2: -ky, x: rx, y: 0 },
    { type: 'Z' },
  ];
}

function ellipsePointAtParam(rx: number, ry: number, phi: number): {
  point: ComicPoint;
  normal: ComicPoint;
  tangent: ComicPoint;
} {
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const point = { x: rx * cosP, y: ry * sinP };
  const tx = -rx * sinP;
  const ty = ry * cosP;
  const tangent = normalizeVec(tx, ty, 0, 1);
  const normal = normalizeVec(ry * cosP, rx * sinP, 1, 0);
  return { point, normal, tangent };
}

function ellipsePerimeter(rx: number, ry: number): number {
  const steps = 128;
  const dt = (Math.PI * 2) / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    sum += Math.hypot(-rx * Math.sin(t), ry * Math.cos(t)) * dt;
  }
  return sum;
}

function advanceEllipseParamByArc(rx: number, ry: number, phi0: number, deltaS: number): number {
  const sub = 8;
  const stepS = deltaS / sub;
  let phi = phi0;
  for (let i = 0; i < sub; i++) {
    const speed1 = Math.max(1e-6, Math.hypot(-rx * Math.sin(phi), ry * Math.cos(phi)));
    const midPhi = phi + (0.5 * stepS) / speed1;
    const speedMid = Math.max(1e-6, Math.hypot(-rx * Math.sin(midPhi), ry * Math.cos(midPhi)));
    phi += stepS / speedMid;
  }
  return phi;
}

function buildRectBodyLocal(rx: number, ry: number, cornerRadius: number): PathCommand[] {
  const r = clamp(cornerRadius, 0, Math.min(rx, ry));
  if (r <= 0.5) {
    return [
      { type: 'M', x: rx, y: -ry },
      { type: 'L', x: rx, y: ry },
      { type: 'L', x: -rx, y: ry },
      { type: 'L', x: -rx, y: -ry },
      { type: 'Z' },
    ];
  }
  const ix = rx - r;
  const iy = ry - r;
  const k = r * KAPPA;
  return [
    { type: 'M', x: rx, y: -iy },
    { type: 'L', x: rx, y: iy },
    { type: 'C', cx1: rx, cy1: iy + k, cx2: ix + k, cy2: ry, x: ix, y: ry },
    { type: 'L', x: -ix, y: ry },
    { type: 'C', cx1: -ix - k, cy1: ry, cx2: -rx, cy2: iy + k, x: -rx, y: iy },
    { type: 'L', x: -rx, y: -iy },
    { type: 'C', cx1: -rx, cy1: -iy - k, cx2: -ix - k, cy2: -ry, x: -ix, y: -ry },
    { type: 'L', x: ix, y: -ry },
    { type: 'C', cx1: ix + k, cy1: -ry, cx2: rx, cy2: -iy - k, x: rx, y: -iy },
    { type: 'Z' },
  ];
}

function rectPerimeterLength(rx: number, ry: number, r: number): number {
  const ix = rx - r;
  const iy = ry - r;
  return 4 * ix + 4 * iy + 2 * Math.PI * r;
}

function rectSampleAtArcLength(rx: number, ry: number, r: number, rawS: number): PerimeterSample {
  const ix = rx - r;
  const iy = ry - r;
  const total = rectPerimeterLength(rx, ry, r);
  const s = ((rawS % total) + total) % total;
  const arc = 0.5 * Math.PI * r;

  let rem = s;
  // 1. Right-bottom half edge: (rx, 0) -> (rx, iy)
  if (rem <= iy) {
    return {
      point: { x: rx, y: rem },
      normal: { x: 1, y: 0 },
      tangent: { x: 0, y: 1 },
      arcLength: s,
      perimeter: total,
    };
  }
  rem -= iy;

  // 2. Bottom-right corner: center (ix, iy), angle 0 -> pi/2
  if (rem <= arc && r > 1e-6) {
    const a = (rem / arc) * (Math.PI * 0.5);
    return {
      point: { x: ix + r * Math.cos(a), y: iy + r * Math.sin(a) },
      normal: { x: Math.cos(a), y: Math.sin(a) },
      tangent: { x: -Math.sin(a), y: Math.cos(a) },
      arcLength: s,
      perimeter: total,
    };
  }
  rem -= arc;

  // 3. Bottom edge: (ix, ry) -> (-ix, ry)
  if (rem <= 2 * ix) {
    return {
      point: { x: ix - rem, y: ry },
      normal: { x: 0, y: 1 },
      tangent: { x: -1, y: 0 },
      arcLength: s,
      perimeter: total,
    };
  }
  rem -= 2 * ix;

  // 4. Bottom-left corner: center (-ix, iy), angle pi/2 -> pi
  if (rem <= arc && r > 1e-6) {
    const a = Math.PI * 0.5 + (rem / arc) * (Math.PI * 0.5);
    return {
      point: { x: -ix + r * Math.cos(a), y: iy + r * Math.sin(a) },
      normal: { x: Math.cos(a), y: Math.sin(a) },
      tangent: { x: -Math.sin(a), y: Math.cos(a) },
      arcLength: s,
      perimeter: total,
    };
  }
  rem -= arc;

  // 5. Left edge: (-rx, iy) -> (-rx, -iy)
  if (rem <= 2 * iy) {
    return {
      point: { x: -rx, y: iy - rem },
      normal: { x: -1, y: 0 },
      tangent: { x: 0, y: -1 },
      arcLength: s,
      perimeter: total,
    };
  }
  rem -= 2 * iy;

  // 6. Top-left corner: center (-ix, -iy), angle pi -> 3pi/2
  if (rem <= arc && r > 1e-6) {
    const a = Math.PI + (rem / arc) * (Math.PI * 0.5);
    return {
      point: { x: -ix + r * Math.cos(a), y: -iy + r * Math.sin(a) },
      normal: { x: Math.cos(a), y: Math.sin(a) },
      tangent: { x: -Math.sin(a), y: Math.cos(a) },
      arcLength: s,
      perimeter: total,
    };
  }
  rem -= arc;

  // 7. Top edge: (-ix, -ry) -> (ix, -ry)
  if (rem <= 2 * ix) {
    return {
      point: { x: -ix + rem, y: -ry },
      normal: { x: 0, y: -1 },
      tangent: { x: 1, y: 0 },
      arcLength: s,
      perimeter: total,
    };
  }
  rem -= 2 * ix;

  // 8. Top-right corner: center (ix, -iy), angle 3pi/2 -> 2pi
  if (rem <= arc && r > 1e-6) {
    const a = Math.PI * 1.5 + (rem / arc) * (Math.PI * 0.5);
    return {
      point: { x: ix + r * Math.cos(a), y: -iy + r * Math.sin(a) },
      normal: { x: Math.cos(a), y: Math.sin(a) },
      tangent: { x: -Math.sin(a), y: Math.cos(a) },
      arcLength: s,
      perimeter: total,
    };
  }
  rem -= arc;

  // 9. Right-top half edge: (rx, -iy) -> (rx, 0)
  return {
    point: { x: rx, y: -iy + Math.min(iy, Math.max(0, rem)) },
    normal: { x: 1, y: 0 },
    tangent: { x: 0, y: 1 },
    arcLength: s,
    perimeter: total,
  };
}

function rectPerimeterAtAngle(rx: number, ry: number, cornerRadius: number, angleDeg: number): PerimeterSample {
  const r = clamp(cornerRadius, 0, Math.min(rx, ry));
  const t = degToRad(angleDeg);
  const dx = rx * Math.cos(t);
  const dy = ry * Math.sin(t);
  const sx = Math.abs(dx) > 1e-9 ? rx / Math.abs(dx) : Infinity;
  const sy = Math.abs(dy) > 1e-9 ? ry / Math.abs(dy) : Infinity;
  const sBox = Math.min(sx, sy);
  const px = sBox * dx;
  const py = sBox * dy;
  const ix = rx - r;
  const iy = ry - r;

  let point: ComicPoint;
  let normal: ComicPoint;
  let arcLength: number;
  const arc = 0.5 * Math.PI * r;
  const total = rectPerimeterLength(rx, ry, r);

  if (r > 1e-6 && Math.abs(px) > ix + 1e-6 && Math.abs(py) > iy + 1e-6) {
    const kx = (dx >= 0 ? 1 : -1) * ix;
    const ky = (dy >= 0 ? 1 : -1) * iy;
    const a = dx * dx + dy * dy;
    const b = -(dx * kx + dy * ky);
    const c = kx * kx + ky * ky - r * r;
    const disc = Math.max(0, b * b - a * c);
    const s = (-b + Math.sqrt(disc)) / Math.max(1e-9, a);
    point = { x: s * dx, y: s * dy };
    normal = normalizeVec(point.x - kx, point.y - ky, 1, 0);

    const cornerAngle = normalizeAngleDeg((Math.atan2(point.y - ky, point.x - kx) * 180) / Math.PI);
    if (dx >= 0 && dy >= 0) {
      arcLength = iy + (degToRad(cornerAngle) / (Math.PI * 0.5)) * arc;
    } else if (dx < 0 && dy >= 0) {
      arcLength = iy + arc + 2 * ix + (degToRad(cornerAngle - 90) / (Math.PI * 0.5)) * arc;
    } else if (dx < 0 && dy < 0) {
      arcLength = iy + 2 * arc + 2 * ix + 2 * iy + (degToRad(cornerAngle - 180) / (Math.PI * 0.5)) * arc;
    } else {
      arcLength = iy + 3 * arc + 4 * ix + 2 * iy + (degToRad(cornerAngle - 270) / (Math.PI * 0.5)) * arc;
    }
  } else {
    point = { x: px, y: py };
    if (sx < sy) {
      if (dx >= 0) {
        normal = { x: 1, y: 0 };
        arcLength = py >= 0 ? py : total + (py >= -iy ? py : -iy);
      } else {
        normal = { x: -1, y: 0 };
        arcLength = iy + 2 * arc + 2 * ix + (iy - py);
      }
    } else {
      if (dy >= 0) {
        normal = { x: 0, y: 1 };
        arcLength = iy + arc + (ix - px);
      } else {
        normal = { x: 0, y: -1 };
        arcLength = iy + 3 * arc + 2 * ix + 2 * iy + (px + ix);
      }
    }
  }

  return {
    point,
    normal,
    tangent: { x: -normal.y, y: normal.x },
    arcLength: ((arcLength % total) + total) % total,
    perimeter: total,
  };
}

// --- Polyline perimeter helpers for spiky & thought -------------------------

interface PolygonRing {
  vertices: ComicPoint[];
  cumLengths: number[];
  perimeter: number;
}

function buildPolygonRing(vertices: ComicPoint[]): PolygonRing {
  const n = vertices.length;
  const cumLengths = new Array<number>(n + 1);
  cumLengths[0] = 0;
  for (let i = 0; i < n; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    cumLengths[i + 1] = cumLengths[i] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  return {
    vertices,
    cumLengths,
    perimeter: Math.max(1e-6, cumLengths[n]),
  };
}

function sampleRingAtArcLength(ring: PolygonRing, rawS: number): PerimeterSample {
  const total = ring.perimeter;
  const s = ((rawS % total) + total) % total;
  const n = ring.vertices.length;
  for (let i = 0; i < n; i++) {
    const s0 = ring.cumLengths[i];
    const s1 = ring.cumLengths[i + 1];
    if (s <= s1 || i === n - 1) {
      const a = ring.vertices[i];
      const b = ring.vertices[(i + 1) % n];
      const segLen = Math.max(1e-9, s1 - s0);
      const t = clamp((s - s0) / segLen, 0, 1);
      const point = lerpPoint(a, b, t);
      const tangent = normalizeVec(b.x - a.x, b.y - a.y, 0, 1);
      const normal = { x: tangent.y, y: -tangent.x };
      return { point, normal, tangent, arcLength: s, perimeter: total };
    }
  }
  const v0 = ring.vertices[0];
  return { point: v0, normal: { x: 1, y: 0 }, tangent: { x: 0, y: 1 }, arcLength: 0, perimeter: total };
}

function intersectRayWithRing(ring: PolygonRing, dirX: number, dirY: number): {
  sample: PerimeterSample;
  edgeIndex: number;
} {
  const n = ring.vertices.length;
  let bestDist = -1;
  let bestSample: PerimeterSample | null = null;
  let bestEdge = 0;

  for (let i = 0; i < n; i++) {
    const a = ring.vertices[i];
    const b = ring.vertices[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = dirX * ey - dirY * ex;
    if (Math.abs(denom) < 1e-9) continue;
    const tRay = (a.x * ey - a.y * ex) / denom;
    const uSeg = (a.x * dirY - a.y * dirX) / denom;
    if (tRay > 1e-6 && uSeg >= -1e-6 && uSeg <= 1 + 1e-6) {
      const uClamped = clamp(uSeg, 0, 1);
      const dist = tRay;
      if (dist > bestDist) {
        bestDist = dist;
        const point = lerpPoint(a, b, uClamped);
        const tangent = normalizeVec(ex, ey, 0, 1);
        const normal = { x: tangent.y, y: -tangent.x };
        const s0 = ring.cumLengths[i];
        const s1 = ring.cumLengths[i + 1];
        const arcLength = s0 + uClamped * (s1 - s0);
        bestSample = { point, normal, tangent, arcLength, perimeter: ring.perimeter };
        bestEdge = i;
      }
    }
  }

  if (bestSample) {
    return { sample: bestSample, edgeIndex: bestEdge };
  }
  return { sample: sampleRingAtArcLength(ring, 0), edgeIndex: 0 };
}

function pointInPolygon(p: ComicPoint, vertices: ComicPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].x;
    const yi = vertices[i].y;
    const xj = vertices[j].x;
    const yj = vertices[j].y;
    const intersect =
      yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function buildSpikyVertices(rx: number, ry: number, seedInput: number | string): ComicPoint[] {
  const rand = mulberry32(hashSeed(seedInput));
  const w = rx * 2;
  const h = ry * 2;
  const spikeCount = clamp(Math.round((w + h) / 28), 12, 28);
  const totalVerts = spikeCount * 2;
  const dPhi = Math.PI / spikeCount;
  const verts: ComicPoint[] = [];

  for (let k = 0; k < totalVerts; k++) {
    const isOuter = k % 2 === 0;
    const jitter = (rand() - 0.5) * 0.24 * dPhi;
    const phi = k * dPhi + jitter;
    const scale = isOuter ? 0.9 + rand() * 0.1 : 0.64 + rand() * 0.14;
    verts.push({
      x: rx * scale * Math.cos(phi),
      y: ry * scale * Math.sin(phi),
    });
  }
  return verts;
}

interface ThoughtLobe {
  a: ComicPoint;
  cp1: ComicPoint;
  cp2: ComicPoint;
  b: ComicPoint;
}

function buildThoughtLobes(rx: number, ry: number, seedInput: number | string): {
  lobes: ThoughtLobe[];
  sampledRing: PolygonRing;
} {
  const rand = mulberry32(hashSeed(seedInput));
  const w = rx * 2;
  const h = ry * 2;
  const lobeCount = clamp(Math.round((w + h) / 36), 10, 20);
  const ax = rx * 0.76;
  const ay = ry * 0.76;
  const dPhi = (Math.PI * 2) / lobeCount;

  const anchors: ComicPoint[] = [];
  for (let i = 0; i < lobeCount; i++) {
    const phi = i * dPhi + (rand() - 0.5) * 0.16 * dPhi;
    anchors.push({
      x: ax * Math.cos(phi),
      y: ay * Math.sin(phi),
    });
  }

  const lobes: ThoughtLobe[] = [];
  const sampled: ComicPoint[] = [];
  const subSteps = 16;

  for (let i = 0; i < lobeCount; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % lobeCount];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const d = Math.max(1e-6, Math.hypot(vx, vy));
    let nx = vy / d;
    let ny = -vx / d;
    const midX = (a.x + b.x) * 0.5;
    const midY = (a.y + b.y) * 0.5;
    if (nx * midX + ny * midY < 0) {
      nx = -nx;
      ny = -ny;
    }

    const scale = 0.88 + rand() * 0.24;
    const bulgeH = Math.min(d * 0.44 * scale, Math.min(rx, ry) * 0.28);
    const offset = (4 / 3) * bulgeH;
    const cp1 = { x: a.x + nx * offset, y: a.y + ny * offset };
    const cp2 = { x: b.x + nx * offset, y: b.y + ny * offset };
    lobes.push({ a, cp1, cp2, b });

    for (let s = 0; s < subSteps; s++) {
      const t = s / subSteps;
      const mt = 1 - t;
      sampled.push({
        x: mt * mt * mt * a.x + 3 * mt * mt * t * cp1.x + 3 * mt * t * t * cp2.x + t * t * t * b.x,
        y: mt * mt * mt * a.y + 3 * mt * mt * t * cp1.y + 3 * mt * t * t * cp2.y + t * t * t * b.y,
      });
    }
  }

  return { lobes, sampledRing: buildPolygonRing(sampled) };
}

function thoughtLobesToCommands(lobes: ThoughtLobe[]): PathCommand[] {
  if (lobes.length === 0) return [];
  const cmds: PathCommand[] = [{ type: 'M', x: lobes[0].a.x, y: lobes[0].a.y }];
  for (let i = 0; i < lobes.length; i++) {
    const l = lobes[i];
    cmds.push({ type: 'C', cx1: l.cp1.x, cy1: l.cp1.y, cx2: l.cp2.x, cy2: l.cp2.y, x: l.b.x, y: l.b.y });
  }
  cmds.push({ type: 'Z' });
  return cmds;
}

// --- Public Perimeter Evaluator ---------------------------------------------

export function evalBalloonPerimeterPoint(
  params: {
    shape: BalloonShape;
    width: number;
    height: number;
    cornerRadius?: number;
    shapeSeed?: number | string;
    id?: string;
  },
  angleDeg: number
): PerimeterSample {
  const w = Math.max(MIN_BALLOON_W, params.width);
  const h = Math.max(MIN_BALLOON_H, params.height);
  const rx = w / 2;
  const ry = h / 2;
  const normDeg = normalizeAngleDeg(angleDeg);
  const rad = degToRad(normDeg);

  if (params.shape === 'oval') {
    const perim = ellipsePerimeter(rx, ry);
    const { point, normal, tangent } = ellipsePointAtParam(rx, ry, rad);
    // Arc length from phi = 0 clockwise
    const steps = 64;
    const dPhi = rad / steps;
    let arc = 0;
    for (let i = 0; i < steps; i++) {
      const p = (i + 0.5) * dPhi;
      arc += Math.hypot(-rx * Math.sin(p), ry * Math.cos(p)) * dPhi;
    }
    return { point, normal, tangent, arcLength: arc, perimeter: perim };
  }

  if (params.shape === 'rect') {
    return rectPerimeterAtAngle(rx, ry, params.cornerRadius ?? 0, normDeg);
  }

  if (params.shape === 'spiky') {
    const verts = buildSpikyVertices(rx, ry, params.shapeSeed ?? params.id ?? 'spiky');
    const ring = buildPolygonRing(verts);
    return intersectRayWithRing(ring, rx * Math.cos(rad), ry * Math.sin(rad)).sample;
  }

  // thought
  const { sampledRing } = buildThoughtLobes(rx, ry, params.shapeSeed ?? params.id ?? 'thought');
  return intersectRayWithRing(sampledRing, rx * Math.cos(rad), ry * Math.sin(rad)).sample;
}

// --- Tail & Complete Geometry Builder ---------------------------------------

function isTipInsideOrTooClose(
  shape: BalloonShape,
  rx: number,
  ry: number,
  cornerRadius: number,
  ringVerts: ComicPoint[] | null,
  tip: ComicPoint,
  baseCenter: ComicPoint,
  baseNormal: ComicPoint
): boolean {
  const distToBase = Math.hypot(tip.x - baseCenter.x, tip.y - baseCenter.y);
  if (distToBase < 6) return true;
  const outwardProj = (tip.x - baseCenter.x) * baseNormal.x + (tip.y - baseCenter.y) * baseNormal.y;
  if (outwardProj <= 4) return true;

  if (shape === 'oval') {
    const normSq = (tip.x / rx) ** 2 + (tip.y / ry) ** 2;
    return normSq <= 1.0;
  }
  if (shape === 'rect') {
    const r = clamp(cornerRadius, 0, Math.min(rx, ry));
    const ix = rx - r;
    const iy = ry - r;
    const qx = Math.abs(tip.x) - ix;
    const qy = Math.abs(tip.y) - iy;
    const sdf = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    return sdf <= 0;
  }
  if (ringVerts) {
    return pointInPolygon(tip, ringVerts);
  }
  return false;
}

function computeMaxTailBend(_shape: BalloonShape, chordLength: number): number {
  return chordLength * 0.4;
}

function distancePointToSegment(p: ComicPoint, a: ComicPoint, b: ComicPoint): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq <= 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = clamp(((p.x - a.x) * vx + (p.y - a.y) * vy) / lenSq, 0, 1);
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

function distancePointToPolygon(p: ComicPoint, vertices: ComicPoint[]): number {
  if (vertices.length === 0) return Infinity;
  let minD = Infinity;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const d = distancePointToSegment(p, a, b);
    if (d < minD) minD = d;
  }
  return minD;
}

function flattenClosedPathForCheck(cmds: PathCommand[], curveSteps = 12): ComicPoint[] {
  const raw: ComicPoint[] = [];
  let cx = 0;
  let cy = 0;
  for (const c of cmds) {
    if (c.type === 'M' || c.type === 'L') {
      raw.push({ x: c.x, y: c.y });
      cx = c.x;
      cy = c.y;
    } else if (c.type === 'Q') {
      const ts: number[] = [0.005, 0.008, 0.015];
      for (let i = 1; i < curveSteps; i++) {
        const t = i / curveSteps;
        if (t > 0.015 && t < 0.985) ts.push(t);
      }
      ts.push(0.985, 0.992, 0.995, 1);
      for (const t of ts) {
        const mt = 1 - t;
        raw.push({
          x: mt * mt * cx + 2 * mt * t * c.cx + t * t * c.x,
          y: mt * mt * cy + 2 * mt * t * c.cy + t * t * c.y,
        });
      }
      cx = c.x;
      cy = c.y;
    } else if (c.type === 'C') {
      for (let i = 1; i <= curveSteps; i++) {
        const t = i / curveSteps;
        const mt = 1 - t;
        raw.push({
          x: mt * mt * mt * cx + 3 * mt * mt * t * c.cx1 + 3 * mt * t * t * c.cx2 + t * t * t * c.x,
          y: mt * mt * mt * cy + 3 * mt * mt * t * c.cy1 + 3 * mt * t * t * c.cy2 + t * t * t * c.y,
        });
      }
      cx = c.x;
      cy = c.y;
    }
  }
  const pts: ComicPoint[] = [];
  for (const p of raw) {
    if (pts.length === 0 || Math.hypot(p.x - pts[pts.length - 1].x, p.y - pts[pts.length - 1].y) > 1e-6) {
      pts.push(p);
    }
  }
  if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= 1e-6) {
    pts.pop();
  }
  return pts;
}

function orient2D(a: ComicPoint, b: ComicPoint, c: ComicPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect2D(a: ComicPoint, b: ComicPoint, c: ComicPoint, d: ComicPoint): boolean {
  const eps = 1e-7;
  if (
    Math.max(a.x, b.x) < Math.min(c.x, d.x) - eps ||
    Math.max(c.x, d.x) < Math.min(a.x, b.x) - eps ||
    Math.max(a.y, b.y) < Math.min(c.y, d.y) - eps ||
    Math.max(c.y, d.y) < Math.min(a.y, b.y) - eps
  ) {
    return false;
  }
  const d1 = orient2D(c, d, a);
  const d2 = orient2D(c, d, b);
  const d3 = orient2D(a, b, c);
  const d4 = orient2D(a, b, d);
  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) {
    return true;
  }
  const onSeg = (p: ComicPoint, q: ComicPoint, r: ComicPoint) =>
    r.x >= Math.min(p.x, q.x) - eps &&
    r.x <= Math.max(p.x, q.x) + eps &&
    r.y >= Math.min(p.y, q.y) - eps &&
    r.y <= Math.max(p.y, q.y) + eps;
  if (Math.abs(d1) <= eps && onSeg(c, d, a)) return true;
  if (Math.abs(d2) <= eps && onSeg(c, d, b)) return true;
  if (Math.abs(d3) <= eps && onSeg(a, b, c)) return true;
  if (Math.abs(d4) <= eps && onSeg(a, b, d)) return true;
  return false;
}

function hasPathSelfIntersection(cmds: PathCommand[], curveSteps = 64): boolean {
  const pts = flattenClosedPathForCheck(cmds, curveSteps);
  const n = pts.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsIntersect2D(a, b, pts[j], pts[(j + 1) % n])) {
        return true;
      }
    }
  }
  return false;
}

function hasValidTipTangents(
  pStart: ComicPoint,
  ctrlL: ComicPoint,
  tip: ComicPoint,
  ctrlR: ComicPoint,
  pEnd: ComicPoint
): boolean {
  const baseSign = orient2D(pStart, tip, pEnd);
  const tipSign = orient2D(ctrlL, tip, ctrlR);
  if (Math.abs(baseSign) > 1e-6 && baseSign * tipSign <= 1e-4) {
    return false;
  }
  return true;
}

function buildSplicedSpikyBody(
  ring: PolygonRing,
  sStart: number,
  sEnd: number,
  pLeft: ComicPoint,
  ctrlLeft: ComicPoint,
  tip: ComicPoint,
  ctrlRight: ComicPoint,
  pRight: ComicPoint
): PathCommand[] {
  const total = ring.perimeter;
  const norm = (s: number) => ((s % total) + total) % total;
  const a = norm(sStart);
  const b = norm(sEnd);

  // Collect vertices strictly after `b` along clockwise perimeter [b -> a]
  const findAfterIndex = (s: number): number => {
    for (let i = 0; i < ring.vertices.length; i++) {
      if (ring.cumLengths[i] > s + 1e-6) return i;
    }
    return 0;
  };

  const cmds: PathCommand[] = [{ type: 'M', x: pLeft.x, y: pLeft.y }];
  cmds.push({ type: 'Q', cx: ctrlLeft.x, cy: ctrlLeft.y, x: tip.x, y: tip.y });
  cmds.push({ type: 'Q', cx: ctrlRight.x, cy: ctrlRight.y, x: pRight.x, y: pRight.y });

  const idxStart = findAfterIndex(b);
  const n = ring.vertices.length;
  // Walk clockwise from idxStart until we cross `a`
  const spanFromBToA = norm(a - b);
  let walked = 0;
  let prevS = b;
  for (let step = 0; step < n; step++) {
    const idx = (idxStart + step) % n;
    const vS = ring.cumLengths[idx];
    const delta = step === 0 && idxStart !== 0 && vS >= prevS ? vS - prevS : norm(vS - prevS);
    if (walked + delta >= spanFromBToA - 1e-4) break;
    walked += delta;
    prevS = vS;
    const v = ring.vertices[idx];
    cmds.push({ type: 'L', x: v.x, y: v.y });
  }

  cmds.push({ type: 'Z' });
  return cmds;
}

function collectSpikyFallbackReturnVertices(
  ring: PolygonRing,
  sStart: number,
  sEnd: number
): ComicPoint[] {
  const total = ring.perimeter;
  const norm = (s: number) => ((s % total) + total) % total;
  const a = norm(sStart);
  const b = norm(sEnd);
  const span = norm(b - a);
  const n = ring.vertices.length;
  let edgeR = n - 1;
  for (let i = 0; i < n; i++) {
    if (b < ring.cumLengths[i + 1] - 1e-9 || i === n - 1) {
      edgeR = i;
      break;
    }
  }
  const verts: ComicPoint[] = [];
  for (let step = 0; step < n; step++) {
    const idx = (edgeR - step + n) % n;
    const backDist = norm(b - ring.cumLengths[idx]);
    if (backDist <= 1e-5) continue;
    if (backDist >= span - 1e-5) break;
    verts.push(ring.vertices[idx]);
  }
  return verts;
}

function isReturnPathInsidePolygon(
  pRIn: ComicPoint,
  retPts: ComicPoint[],
  pLIn: ComicPoint,
  polyVerts: ComicPoint[]
): boolean {
  const m = polyVerts.length;
  if (m < 3 || !pointInPolygon(pRIn, polyVerts)) return false;
  const chain = [pRIn, ...retPts, pLIn];
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    if (!pointInPolygon(lerpPoint(a, b, 0.5), polyVerts) || !pointInPolygon(b, polyVerts)) {
      return false;
    }
    for (let k = 0; k < m; k++) {
      if (segmentsIntersect2D(a, b, polyVerts[k], polyVerts[(k + 1) % m])) {
        return false;
      }
    }
  }
  return true;
}

function buildThoughtDotCommands(
  pEdge: ComicPoint,
  tip: ComicPoint,
  tailWidth: number,
  tailCurve: number,
  borderWidth: number,
  maxBend: number,
  cloudVertices: ComicPoint[]
): PathCommand[][] {
  const dx = tip.x - pEdge.x;
  const dy = tip.y - pEdge.y;
  const L = Math.hypot(dx, dy);
  if (L < 12) return [];

  const ux = dx / L;
  const uy = dy / L;
  const perpX = -uy;
  const perpY = ux;
  const midX = (pEdge.x + tip.x) * 0.5;
  const midY = (pEdge.y + tip.y) * 0.5;
  const cSpineX = midX + perpX * (2 * tailCurve * maxBend);
  const cSpineY = midY + perpY * (2 * tailCurve * maxBend);

  // Sample quadratic spine to get arc-length positions
  const samples = 64;
  const pts: ComicPoint[] = [];
  const cum: number[] = [0];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const mt = 1 - t;
    const pt = {
      x: mt * mt * pEdge.x + 2 * mt * t * cSpineX + t * t * tip.x,
      y: mt * mt * pEdge.y + 2 * mt * t * cSpineY + t * t * tip.y,
    };
    pts.push(pt);
    if (i > 0) {
      cum.push(cum[i - 1] + Math.hypot(pt.x - pts[i - 1].x, pt.y - pts[i - 1].y));
    }
  }
  const spineLen = cum[samples];
  const pointAtDist = (dist: number): ComicPoint => {
    const target = clamp(dist, 0, spineLen);
    for (let i = 1; i <= samples; i++) {
      if (cum[i] >= target) {
        const seg = Math.max(1e-6, cum[i] - cum[i - 1]);
        return lerpPoint(pts[i - 1], pts[i], (target - cum[i - 1]) / seg);
      }
    }
    return pts[samples];
  };

  const baseR = clamp(tailWidth * 0.28, 4, 16);
  const bw = Math.max(0, borderWidth || 0);
  const minDotGap = Math.max(2, bw * 2 + 1);
  const ratiosList = [
    [1.0, 0.65, 0.36],
    [1.0, 0.55],
    [0.85],
    [0.55],
    [0.38],
  ];
  const cloudPad = bw * 2 + (bw > 0 ? 1.5 : 0.5);

  for (const ratios of ratiosList) {
    const rawRadii = ratios.map((r) => baseR * r);
    const totalDiameters = rawRadii.reduce((acc, r) => acc + r * 2, 0);
    const minRequiredGaps = cloudPad + minDotGap * (rawRadii.length - 1);

    let scale = 1;
    if (minRequiredGaps + totalDiameters > spineLen) {
      scale = (spineLen - minRequiredGaps) / Math.max(1e-6, totalDiameters);
    }
    if (scale < 0.38) continue;

    const radii = rawRadii.map((r) => Math.max(2.5, r * scale));
    const placed: Array<{ center: ComicPoint; r: number; s: number }> = [];
    let valid = true;
    const stepSize = Math.max(0.5, spineLen / 96);

    for (let i = 0; i < radii.length; i++) {
      const r = radii[i];
      const sStart =
        i === 0
          ? cloudPad + r
          : placed[i - 1].s + placed[i - 1].r + minDotGap + r;
      const sMax = spineLen - r + 1;
      if (sStart > sMax) {
        valid = false;
        break;
      }

      let chosen: { center: ComicPoint; s: number } | null = null;
      for (let s = sStart; s <= sMax + 1e-6; s += stepSize) {
        const sClamped = Math.min(s, sMax);
        const c = pointAtDist(sClamped);
        if (cloudVertices.length > 0) {
          if (pointInPolygon(c, cloudVertices)) continue;
          if (distancePointToPolygon(c, cloudVertices) < r + cloudPad) continue;
        }
        let overlapsPrev = false;
        for (let p = 0; p < placed.length; p++) {
          const prev = placed[p];
          if (Math.hypot(c.x - prev.center.x, c.y - prev.center.y) < prev.r + r + minDotGap) {
            overlapsPrev = true;
            break;
          }
        }
        if (!overlapsPrev) {
          chosen = { center: c, s: sClamped };
          break;
        }
      }

      if (!chosen) {
        valid = false;
        break;
      }
      placed.push({ center: chosen.center, r, s: chosen.s });
    }

    if (valid && placed.length > 0) {
      return placed.map((d) => buildCircleCommands(d.center.x, d.center.y, d.r));
    }
  }

  return [];
}

function computeCommandsBounds(cmdLists: PathCommand[][], margin: number): ComicRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const includePt = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const cmds of cmdLists) {
    let curX = 0;
    let curY = 0;
    for (const c of cmds) {
      if (c.type === 'M' || c.type === 'L') {
        includePt(c.x, c.y);
        curX = c.x;
        curY = c.y;
      } else if (c.type === 'Q') {
        // Include exact analytical quadratic extrema plus 16-segment sampling
        const denomX = curX - 2 * c.cx + c.x;
        if (Math.abs(denomX) > 1e-9) {
          const tx = (curX - c.cx) / denomX;
          if (tx > 0 && tx < 1) {
            const mt = 1 - tx;
            includePt(
              mt * mt * curX + 2 * mt * tx * c.cx + tx * tx * c.x,
              mt * mt * curY + 2 * mt * tx * c.cy + tx * tx * c.y
            );
          }
        }
        const denomY = curY - 2 * c.cy + c.y;
        if (Math.abs(denomY) > 1e-9) {
          const ty = (curY - c.cy) / denomY;
          if (ty > 0 && ty < 1) {
            const mt = 1 - ty;
            includePt(
              mt * mt * curX + 2 * mt * ty * c.cx + ty * ty * c.x,
              mt * mt * curY + 2 * mt * ty * c.cy + ty * ty * c.y
            );
          }
        }
        for (let i = 1; i <= 16; i++) {
          const t = i / 16;
          const mt = 1 - t;
          includePt(
            mt * mt * curX + 2 * mt * t * c.cx + t * t * c.x,
            mt * mt * curY + 2 * mt * t * c.cy + t * t * c.y
          );
        }
        curX = c.x;
        curY = c.y;
      } else if (c.type === 'C') {
        for (let i = 1; i <= 16; i++) {
          const t = i / 16;
          const mt = 1 - t;
          includePt(
            mt * mt * mt * curX + 3 * mt * mt * t * c.cx1 + 3 * mt * t * t * c.cx2 + t * t * t * c.x,
            mt * mt * mt * curY + 3 * mt * mt * t * c.cy1 + 3 * mt * t * t * c.cy2 + t * t * t * c.y
          );
        }
        curX = c.x;
        curY = c.y;
      }
    }
  }

  if (!Number.isFinite(minX)) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }

  return {
    x: minX - margin,
    y: minY - margin,
    width: maxX - minX + margin * 2,
    height: maxY - minY + margin * 2,
  };
}

export function getBalloonTextBounds(b: Pick<ComicBalloonItem, 'x' | 'y' | 'width' | 'height' | 'shape' | 'fontSize'>): ComicRect {
  const w = Math.max(MIN_BALLOON_W, b.width);
  const h = Math.max(MIN_BALLOON_H, b.height);
  const pad = Math.max(8, (b.fontSize || 16) * 0.35);

  let insetX = pad;
  let insetY = pad;
  if (b.shape === 'oval') {
    insetX = Math.max(pad, w * 0.14);
    insetY = Math.max(pad, h * 0.14);
  } else if (b.shape === 'spiky' || b.shape === 'thought') {
    insetX = Math.max(pad, w * 0.19);
    insetY = Math.max(pad, h * 0.19);
  }

  const maxInsetX = Math.max(0, (w - 16) * 0.5);
  const maxInsetY = Math.max(0, (h - 16) * 0.5);
  insetX = Math.min(insetX, maxInsetX);
  insetY = Math.min(insetY, maxInsetY);

  return {
    x: b.x + insetX,
    y: b.y + insetY,
    width: Math.max(16, w - insetX * 2),
    height: Math.max(16, h - insetY * 2),
  };
}

export function buildBalloonGeometry(b: ComicBalloonItem): BalloonGeometryResult {
  const w = Math.max(MIN_BALLOON_W, b.width);
  const h = Math.max(MIN_BALLOON_H, b.height);
  const rx = w / 2;
  const ry = h / 2;
  const cx = b.x + rx;
  const cy = b.y + ry;
  const resolvedTail = resolveBalloonTailParams({ ...b, width: w, height: h });
  const seed = b.shapeSeed ?? b.id;
  const cornerRadius = b.cornerRadius ?? 0;

  let bodyLocal: PathCommand[];
  let spikyRing: PolygonRing | null = null;
  let thoughtData: { lobes: ThoughtLobe[]; sampledRing: PolygonRing } | null = null;

  if (b.shape === 'oval') {
    bodyLocal = buildOvalBodyLocal(rx, ry);
  } else if (b.shape === 'rect') {
    bodyLocal = buildRectBodyLocal(rx, ry, cornerRadius);
  } else if (b.shape === 'spiky') {
    const verts = buildSpikyVertices(rx, ry, seed);
    spikyRing = buildPolygonRing(verts);
    bodyLocal = [
      { type: 'M', x: verts[0].x, y: verts[0].y },
      ...verts.slice(1).map((v): PathCommand => ({ type: 'L', x: v.x, y: v.y })),
      { type: 'Z' },
    ];
  } else {
    thoughtData = buildThoughtLobes(rx, ry, seed);
    bodyLocal = thoughtLobesToCommands(thoughtData.lobes);
  }

  // Evaluate perimeter base center
  let baseSample: PerimeterSample;
  if (b.shape === 'oval') {
    baseSample = evalBalloonPerimeterPoint({ shape: 'oval', width: w, height: h }, resolvedTail.tailBaseAngle);
  } else if (b.shape === 'rect') {
    baseSample = rectPerimeterAtAngle(rx, ry, cornerRadius, resolvedTail.tailBaseAngle);
  } else if (spikyRing) {
    const rad = degToRad(resolvedTail.tailBaseAngle);
    baseSample = intersectRayWithRing(spikyRing, rx * Math.cos(rad), ry * Math.sin(rad)).sample;
  } else {
    const rad = degToRad(resolvedTail.tailBaseAngle);
    baseSample = intersectRayWithRing(thoughtData!.sampledRing, rx * Math.cos(rad), ry * Math.sin(rad)).sample;
  }

  const maxHalfW = Math.min(baseSample.perimeter * 0.175, Math.min(w, h) * 0.48);
  const halfW = clamp(resolvedTail.tailWidth * 0.5, 3, Math.max(3, maxHalfW));

  let leftSample: PerimeterSample;
  let rightSample: PerimeterSample;
  if (b.shape === 'oval') {
    const phi0 = degToRad(resolvedTail.tailBaseAngle);
    const phiL = advanceEllipseParamByArc(rx, ry, phi0, -halfW);
    const phiR = advanceEllipseParamByArc(rx, ry, phi0, halfW);
    const eL = ellipsePointAtParam(rx, ry, phiL);
    const eR = ellipsePointAtParam(rx, ry, phiR);
    leftSample = { ...eL, arcLength: baseSample.arcLength - halfW, perimeter: baseSample.perimeter };
    rightSample = { ...eR, arcLength: baseSample.arcLength + halfW, perimeter: baseSample.perimeter };
  } else if (b.shape === 'rect') {
    const r = clamp(cornerRadius, 0, Math.min(rx, ry));
    leftSample = rectSampleAtArcLength(rx, ry, r, baseSample.arcLength - halfW);
    rightSample = rectSampleAtArcLength(rx, ry, r, baseSample.arcLength + halfW);
  } else if (spikyRing) {
    leftSample = sampleRingAtArcLength(spikyRing, baseSample.arcLength - halfW);
    rightSample = sampleRingAtArcLength(spikyRing, baseSample.arcLength + halfW);
  } else {
    leftSample = sampleRingAtArcLength(thoughtData!.sampledRing, baseSample.arcLength - halfW);
    rightSample = sampleRingAtArcLength(thoughtData!.sampledRing, baseSample.arcLength + halfW);
  }

  const tipLocal: ComicPoint = {
    x: Number.isFinite(b.tailPos?.x) ? b.tailPos.x : 0,
    y: Number.isFinite(b.tailPos?.y) ? b.tailPos.y : 0,
  };

  const baseMid = lerpPoint(leftSample.point, rightSample.point, 0.5);
  const chordDx = tipLocal.x - baseMid.x;
  const chordDy = tipLocal.y - baseMid.y;
  const chordLength = Math.hypot(chordDx, chordDy);
  const chordU = normalizeVec(chordDx, chordDy, baseSample.normal.x, baseSample.normal.y);
  const chordPerp = { x: -chordU.y, y: chordU.x };
  const maxBend = computeMaxTailBend(b.shape, chordLength);

  let effectiveCurveOffset = resolvedTail.tailCurve * maxBend;
  const makeCtrlLeft = (pStart: ComicPoint, offset: number): ComicPoint => ({
    x: (pStart.x + tipLocal.x) * 0.5 + chordPerp.x * (2 * offset),
    y: (pStart.y + tipLocal.y) * 0.5 + chordPerp.y * (2 * offset),
  });
  const makeCtrlRight = (pEnd: ComicPoint, offset: number): ComicPoint => ({
    x: (tipLocal.x + pEnd.x) * 0.5 + chordPerp.x * (2 * offset),
    y: (tipLocal.y + pEnd.y) * 0.5 + chordPerp.y * (2 * offset),
  });

  const ringVerts = spikyRing ? spikyRing.vertices : thoughtData ? thoughtData.sampledRing.vertices : null;
  const tailSuppressed =
    !b.tailEnabled ||
    isTipInsideOrTooClose(
      b.shape,
      rx,
      ry,
      cornerRadius,
      ringVerts,
      tipLocal,
      baseSample.point,
      baseSample.normal
    );

  let tailLocal: PathCommand[] = [];
  let dotsLocal: PathCommand[][] = [];
  let isTailSpliced = false;

  if (!tailSuppressed) {
    if (b.shape === 'thought') {
      dotsLocal = buildThoughtDotCommands(
        baseSample.point,
        tipLocal,
        resolvedTail.tailWidth,
        resolvedTail.tailCurve,
        b.borderWidth,
        maxBend,
        thoughtData!.sampledRing.vertices
      );
    } else if (b.shape === 'spiky' && spikyRing) {
      const trySplice = (offset: number) => {
        const cL = makeCtrlLeft(leftSample.point, offset);
        const cR = makeCtrlRight(rightSample.point, offset);
        const body = buildSplicedSpikyBody(
          spikyRing!,
          leftSample.arcLength,
          rightSample.arcLength,
          leftSample.point,
          cL,
          tipLocal,
          cR,
          rightSample.point
        );
        const ok =
          hasValidTipTangents(leftSample.point, cL, tipLocal, cR, rightSample.point) &&
          !hasPathSelfIntersection(body, 64);
        return { body, ok };
      };

      const candidate = trySplice(effectiveCurveOffset);
      if (candidate.ok) {
        bodyLocal = candidate.body;
        isTailSpliced = true;
      } else {
        const straightCandidate = Math.abs(effectiveCurveOffset) > 1e-6 ? trySplice(0) : candidate;
        if (straightCandidate.ok) {
          let lo = 0;
          let hi = 1;
          const baseOffset = effectiveCurveOffset;
          for (let iter = 0; iter < 12; iter++) {
            const mid = (lo + hi) * 0.5;
            if (trySplice(baseOffset * mid).ok) {
              lo = mid;
            } else {
              hi = mid;
            }
          }
          // Back off slightly from grazing tangency so curves stay strictly clear of adjacent spike edges
          let safeAlpha = lo * 0.85;
          let best = trySplice(baseOffset * safeAlpha);
          while (safeAlpha > 1e-4 && !best.ok) {
            safeAlpha *= 0.7;
            best = trySplice(baseOffset * safeAlpha);
          }
          if (!best.ok) {
            safeAlpha = 0;
            best = straightCandidate;
          }
          effectiveCurveOffset = baseOffset * safeAlpha;
          bodyLocal = best.body;
          isTailSpliced = true;
        } else {
          // Extreme oblique tip behind an adjacent spike: safely fall back to dual-layer union
          // with interior return path that stays strictly inside the spiky polygon.
          const inward = Math.min(2.5, Math.min(rx, ry) * 0.15);
          const rL = Math.max(1e-6, Math.hypot(leftSample.point.x, leftSample.point.y));
          const rR = Math.max(1e-6, Math.hypot(rightSample.point.x, rightSample.point.y));
          const alphaL = Math.max(0.25, 1 - inward / rL);
          const alphaR = Math.max(0.25, 1 - inward / rR);
          const backVerts = collectSpikyFallbackReturnVertices(
            spikyRing,
            leftSample.arcLength,
            rightSample.arcLength
          );
          const shallowAlpha = Math.min(alphaL, alphaR, 0.94);

          const buildFallbackWithScale = (offset: number, baseScale: number) => {
            const pL = {
              x: leftSample.point.x * alphaL * baseScale,
              y: leftSample.point.y * alphaL * baseScale,
            };
            const pR = {
              x: rightSample.point.x * alphaR * baseScale,
              y: rightSample.point.y * alphaR * baseScale,
            };
            const cL = makeCtrlLeft(pL, offset);
            const cR = makeCtrlRight(pR, offset);
            const tangentsOk = hasValidTipTangents(pL, cL, tipLocal, cR, pR);
            const retAlpha = Math.min(shallowAlpha * baseScale, 0.94);
            const returnCandidates: ComicPoint[][] = [
              backVerts.map((v) => ({ x: v.x * retAlpha, y: v.y * retAlpha })),
              backVerts.map((v) => ({
                x: v.x * Math.min(0.55, retAlpha * 0.6),
                y: v.y * Math.min(0.55, retAlpha * 0.6),
              })),
              [{ x: 0, y: 0 }],
              [],
            ];
            for (const retPts of returnCandidates) {
              const cmds: PathCommand[] = [
                { type: 'M', x: pL.x, y: pL.y },
                { type: 'Q', cx: cL.x, cy: cL.y, x: tipLocal.x, y: tipLocal.y },
                { type: 'Q', cx: cR.x, cy: cR.y, x: pR.x, y: pR.y },
                ...retPts.map((pt): PathCommand => ({ type: 'L', x: pt.x, y: pt.y })),
                { type: 'Z' },
              ];
              if (
                isReturnPathInsidePolygon(pR, retPts, pL, spikyRing!.vertices) &&
                !hasPathSelfIntersection(cmds, 64)
              ) {
                return { cmds, ok: tangentsOk, nonIntersecting: true };
              }
            }
            const fallbackRet = returnCandidates[returnCandidates.length - 1];
            const cmds: PathCommand[] = [
              { type: 'M', x: pL.x, y: pL.y },
              { type: 'Q', cx: cL.x, cy: cL.y, x: tipLocal.x, y: tipLocal.y },
              { type: 'Q', cx: cR.x, cy: cR.y, x: pR.x, y: pR.y },
              ...fallbackRet.map((pt): PathCommand => ({ type: 'L', x: pt.x, y: pt.y })),
              { type: 'Z' },
            ];
            return { cmds, ok: false, nonIntersecting: false };
          };

          const buildFallbackTail = (offset: number) => {
            for (const bs of [1.0, 0.7, 0.45, 0.25]) {
              const res = buildFallbackWithScale(offset, bs);
              if (res.nonIntersecting) {
                return { cmds: res.cmds, ok: res.ok };
              }
            }
            const res = buildFallbackWithScale(offset, 0.25);
            return { cmds: res.cmds, ok: false };
          };
          let fallbackTail = buildFallbackTail(effectiveCurveOffset);
          if (!fallbackTail.ok && Math.abs(effectiveCurveOffset) > 1e-6) {
            let lo = 0;
            let hi = 1;
            const baseOffset = effectiveCurveOffset;
            for (let iter = 0; iter < 12; iter++) {
              const mid = (lo + hi) * 0.5;
              if (buildFallbackTail(baseOffset * mid).ok) {
                lo = mid;
              } else {
                hi = mid;
              }
            }
            let safeAlpha = lo * 0.85;
            let bestTail = buildFallbackTail(baseOffset * safeAlpha);
            while (safeAlpha > 1e-4 && !bestTail.ok) {
              safeAlpha *= 0.7;
              bestTail = buildFallbackTail(baseOffset * safeAlpha);
            }
            if (!bestTail.ok) {
              safeAlpha = 0;
              bestTail = buildFallbackTail(0);
            }
            effectiveCurveOffset = baseOffset * safeAlpha;
            fallbackTail = bestTail;
          }
          tailLocal = fallbackTail.cmds;
          isTailSpliced = false;
        }
      }
    } else {
      // Subpixel inward offset so tail base sits solidly inside body fill
      const inward = Math.min(1.5, Math.min(rx, ry) * 0.15);
      const pLIn = {
        x: leftSample.point.x - leftSample.normal.x * inward,
        y: leftSample.point.y - leftSample.normal.y * inward,
      };
      const pRIn = {
        x: rightSample.point.x - rightSample.normal.x * inward,
        y: rightSample.point.y - rightSample.normal.y * inward,
      };
      const buildSmoothTail = (offset: number) => {
        const ctrlLIn = makeCtrlLeft(pLIn, offset);
        const ctrlRIn = makeCtrlRight(pRIn, offset);
        const cmds: PathCommand[] = [
          { type: 'M', x: pLIn.x, y: pLIn.y },
          { type: 'Q', cx: ctrlLIn.x, cy: ctrlLIn.y, x: tipLocal.x, y: tipLocal.y },
          { type: 'Q', cx: ctrlRIn.x, cy: ctrlRIn.y, x: pRIn.x, y: pRIn.y },
          { type: 'Z' },
        ];
        const ok =
          hasValidTipTangents(pLIn, ctrlLIn, tipLocal, ctrlRIn, pRIn) &&
          !hasPathSelfIntersection(cmds, 64);
        return { cmds, ok };
      };
      let smoothTail = buildSmoothTail(effectiveCurveOffset);
      if (!smoothTail.ok && Math.abs(effectiveCurveOffset) > 1e-6) {
        let lo = 0;
        let hi = 1;
        const baseOffset = effectiveCurveOffset;
        for (let iter = 0; iter < 12; iter++) {
          const mid = (lo + hi) * 0.5;
          if (buildSmoothTail(baseOffset * mid).ok) {
            lo = mid;
          } else {
            hi = mid;
          }
        }
        let safeAlpha = lo * 0.85;
        let bestTail = buildSmoothTail(baseOffset * safeAlpha);
        while (safeAlpha > 1e-4 && !bestTail.ok) {
          safeAlpha *= 0.7;
          bestTail = buildSmoothTail(baseOffset * safeAlpha);
        }
        if (!bestTail.ok) {
          safeAlpha = 0;
          bestTail = buildSmoothTail(0);
        }
        effectiveCurveOffset = baseOffset * safeAlpha;
        smoothTail = bestTail;
      }
      tailLocal = smoothTail.cmds;
    }
  }

  const curveHandleLocal: ComicPoint = {
    x: (baseMid.x + tipLocal.x) * 0.5 + chordPerp.x * effectiveCurveOffset,
    y: (baseMid.y + tipLocal.y) * 0.5 + chordPerp.y * effectiveCurveOffset,
  };
  const ctrlLeftLocal = makeCtrlLeft(leftSample.point, effectiveCurveOffset);
  const ctrlRightLocal = makeCtrlRight(rightSample.point, effectiveCurveOffset);

  const bodyCommands = translateCommands(bodyLocal, cx, cy);
  const tailCommands = tailLocal.length > 0 ? translateCommands(tailLocal, cx, cy) : [];
  const dotCommands = dotsLocal.map((d) => translateCommands(d, cx, cy));

  const margin = Math.ceil(Math.max(0, b.borderWidth || 0) + 4);
  const bounds = computeCommandsBounds([bodyCommands, ...(tailCommands.length ? [tailCommands] : []), ...dotCommands], margin);

  return {
    center: { x: cx, y: cy },
    bodyCommands,
    tailCommands,
    dotCommands,
    isTailSpliced,
    tailSuppressed,
    tailBaseCenter: { x: cx + baseSample.point.x, y: cy + baseSample.point.y },
    tailBaseLeft: { x: cx + leftSample.point.x, y: cy + leftSample.point.y },
    tailBaseRight: { x: cx + rightSample.point.x, y: cy + rightSample.point.y },
    tailTip: { x: cx + tipLocal.x, y: cy + tipLocal.y },
    tailCurveHandle: { x: cx + curveHandleLocal.x, y: cy + curveHandleLocal.y },
    ctrlLeft: { x: cx + ctrlLeftLocal.x, y: cy + ctrlLeftLocal.y },
    ctrlRight: { x: cx + ctrlRightLocal.x, y: cy + ctrlRightLocal.y },
    tailLocal: {
      baseCenter: baseSample.point,
      baseLeft: leftSample.point,
      baseRight: rightSample.point,
      tip: tipLocal,
      curveHandle: curveHandleLocal,
      chordLength,
      maxBend,
    },
    resolvedTail,
    bounds,
    safeTextBounds: getBalloonTextBounds(b),
  };
}

// --- Dual-Layer Union & Seamless Transparency Canvas Renderer ---------------

const defaultOffscreenFactory: OffscreenCanvasFactory = (width, height) => {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height) as unknown as OffscreenCanvasLike;
  }
  return null;
};

export function buildBalloonRenderPlan(balloon: ComicBalloonItem): BalloonRenderPlan {
  const geom = buildBalloonGeometry(balloon);
  const bgAlpha = parseColorAlpha(balloon.bgColor);
  const borderAlpha = parseColorAlpha(balloon.borderColor);
  const borderWidth = Math.max(0, balloon.borderWidth || 0);
  const hasFill = bgAlpha > 0.001;
  const hasBorder = borderWidth > 0.001 && borderAlpha > 0.001;

  const shapes: PathCommand[][] = [geom.bodyCommands];
  if (geom.tailCommands.length > 0) shapes.push(geom.tailCommands);
  for (let i = 0; i < geom.dotCommands.length; i++) {
    shapes.push(geom.dotCommands[i]);
  }

  const isOpaqueDualLayer = hasFill && bgAlpha >= 0.999 && (!hasBorder || borderAlpha >= 0.999);
  const mode: BalloonRenderPlan['mode'] = isOpaqueDualLayer ? 'opaque-dual-layer' : 'isolated-alpha';

  const strokeStyle = isOpaqueDualLayer ? balloon.borderColor : toOpaqueRgbColor(balloon.borderColor);
  const fillStyle = isOpaqueDualLayer ? balloon.bgColor : toOpaqueRgbColor(balloon.bgColor);

  const strokes = hasBorder
    ? shapes.map((commands) => ({
        commands,
        lineWidth: borderWidth * 2,
        strokeStyle,
      }))
    : [];

  const punchOuts = !isOpaqueDualLayer && hasBorder ? shapes.slice() : [];

  const fills = hasFill
    ? shapes.map((commands) => ({
        commands,
        fillStyle,
      }))
    : [];

  return {
    geometry: geom,
    mode,
    bgAlpha,
    borderAlpha,
    borderWidth,
    hasFill,
    hasBorder,
    shapes,
    strokes,
    punchOuts,
    fills,
  };
}

export function renderBalloonToCanvas(
  ctx: CanvasRenderingContext2D,
  balloon: ComicBalloonItem,
  createOffscreenCanvas: OffscreenCanvasFactory = defaultOffscreenFactory
): BalloonGeometryResult {
  const plan = buildBalloonRenderPlan(balloon);
  const geom = plan.geometry;

  // Fast path: opaque fill & opaque border (dual-layer union: 2x stroke first, fill second)
  if (plan.mode === 'opaque-dual-layer') {
    ctx.save();
    if (plan.hasBorder && plan.strokes.length > 0) {
      ctx.strokeStyle = plan.strokes[0].strokeStyle;
      ctx.lineWidth = plan.strokes[0].lineWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.miterLimit = 2.5;
      for (let i = 0; i < plan.strokes.length; i++) {
        ctx.beginPath();
        traceCommandsToCtx(ctx, plan.strokes[i].commands);
        ctx.stroke();
      }
    }
    if (plan.fills.length > 0) {
      ctx.fillStyle = plan.fills[0].fillStyle;
      for (let i = 0; i < plan.fills.length; i++) {
        ctx.beginPath();
        traceCommandsToCtx(ctx, plan.fills[i].commands);
        ctx.fill();
      }
    }
    ctx.restore();
    return geom;
  }

  // Transparent or semi-transparent path: isolated offscreen buffers prevent seams & double-alpha
  const ox = Math.floor(geom.bounds.x);
  const oy = Math.floor(geom.bounds.y);
  const ow = Math.max(1, Math.ceil(geom.bounds.x + geom.bounds.width) - ox);
  const oh = Math.max(1, Math.ceil(geom.bounds.y + geom.bounds.height) - oy);

  if (plan.hasFill && plan.fills.length > 0) {
    const fillCanvas = createOffscreenCanvas(ow, oh);
    const fctx = fillCanvas?.getContext('2d');
    if (fctx) {
      fctx.save();
      fctx.translate(-ox, -oy);
      fctx.fillStyle = plan.fills[0].fillStyle;
      for (let i = 0; i < plan.fills.length; i++) {
        fctx.beginPath();
        traceCommandsToCtx(fctx, plan.fills[i].commands);
        fctx.fill();
      }
      fctx.restore();

      ctx.save();
      ctx.globalAlpha = plan.bgAlpha;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(fillCanvas as unknown as CanvasImageSource, ox, oy);
      ctx.restore();
    }
  }

  if (plan.hasBorder && plan.strokes.length > 0) {
    const borderCanvas = createOffscreenCanvas(ow, oh);
    const bctx = borderCanvas?.getContext('2d');
    if (bctx) {
      bctx.save();
      bctx.translate(-ox, -oy);
      bctx.strokeStyle = plan.strokes[0].strokeStyle;
      bctx.lineWidth = plan.strokes[0].lineWidth;
      bctx.lineJoin = 'round';
      bctx.lineCap = 'round';
      bctx.miterLimit = 2.5;
      for (let i = 0; i < plan.strokes.length; i++) {
        bctx.beginPath();
        traceCommandsToCtx(bctx, plan.strokes[i].commands);
        bctx.stroke();
      }
      // Punch out interior + body/tail intersection seams so only 1x exterior outline remains
      bctx.globalCompositeOperation = 'destination-out';
      bctx.fillStyle = '#000000';
      for (let i = 0; i < plan.punchOuts.length; i++) {
        bctx.beginPath();
        traceCommandsToCtx(bctx, plan.punchOuts[i]);
        bctx.fill();
      }
      bctx.restore();

      ctx.save();
      ctx.globalAlpha = plan.borderAlpha;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(borderCanvas as unknown as CanvasImageSource, ox, oy);
      ctx.restore();
    }
  }

  return geom;
}

// --- Self-contained Text Layout & Vertical Writing (Horizontal + Tategaki) ---

const VERTICAL_FORMS: Record<string, string> = {
  '「': '﹁',
  '」': '﹂',
  '『': '﹃',
  '』': '﹄',
  '（': '︵',
  '）': '︶',
  '(': '︵',
  ')': '︶',
  '【': '︻',
  '】': '︼',
  '《': '︽',
  '》': '︾',
  '〈': '︿',
  '〉': '﹀',
  '［': '﹇',
  '］': '﹈',
  '｛': '︷',
  '｝': '︸',
  '〔': '︹',
  '〕': '︺',
  'ー': '丨',
  '—': '︱',
  '…': '︙',
  '‥': '︰',
  '～': '≀',
  '~': '≀',
  '，': '︐',
  '、': '︑',
  '。': '︒',
  '：': '︓',
  '；': '︔',
  '！': '︕',
  '？': '︖',
};

type VerticalRun =
  | { kind: 'glyph'; text: string }
  | { kind: 'sideways'; text: string }
  | { kind: 'tcy'; text: string };

function buildVerticalRuns(line: string): VerticalRun[] {
  const out: VerticalRun[] = [];
  const chars = Array.from(line);
  for (let i = 0; i < chars.length; ) {
    if (/[!-~]/.test(chars[i]) && !(chars[i] in VERTICAL_FORMS)) {
      let j = i;
      while (
        j < chars.length &&
        (/[!-~]/.test(chars[j]) || (chars[j] === ' ' && /[!-~]/.test(chars[j + 1] ?? ''))) &&
        !(chars[j] in VERTICAL_FORMS)
      ) {
        j++;
      }
      const text = chars.slice(i, j).join('');
      out.push(/^\d{1,2}$/.test(text) ? { kind: 'tcy', text } : { kind: 'sideways', text });
      i = j;
    } else {
      out.push({ kind: 'glyph', text: VERTICAL_FORMS[chars[i]] ?? chars[i] });
      i++;
    }
  }
  return out;
}

let cachedMeasureCtx: CanvasRenderingContext2D | null = null;

function defaultMeasureTextWidth(text: string, font: string, fontSize: number): number {
  if (typeof document !== 'undefined') {
    if (!cachedMeasureCtx) {
      const c = document.createElement('canvas');
      cachedMeasureCtx = c.getContext('2d');
    }
    if (cachedMeasureCtx) {
      cachedMeasureCtx.font = font;
      return cachedMeasureCtx.measureText(text).width;
    }
  }
  let w = 0;
  for (const ch of Array.from(text)) {
    w += /[\u0020-\u007e]/.test(ch) ? fontSize * 0.58 : fontSize;
  }
  return w;
}

function wrapHorizontalParagraph(
  paragraph: string,
  maxWidth: number,
  measure: (text: string) => number
): string[] {
  if (!paragraph) return [''];
  const chars = Array.from(paragraph);
  const lines: string[] = [];
  let current = '';

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const candidate = current + ch;
    if (current.length > 0 && measure(candidate) > maxWidth) {
      // Try breaking at last space if ASCII word wrap applies
      const lastSpace = current.lastIndexOf(' ');
      if (lastSpace > 0 && /[A-Za-z0-9]/.test(ch)) {
        lines.push(current.slice(0, lastSpace));
        current = current.slice(lastSpace + 1) + ch;
      } else {
        lines.push(current);
        current = ch === ' ' ? '' : ch;
      }
    } else {
      current = candidate;
    }
  }
  if (current.length > 0 || lines.length === 0) {
    lines.push(current);
  }
  return lines;
}

export function layoutBalloonText(
  b: Pick<
    ComicBalloonItem,
    'x' | 'y' | 'width' | 'height' | 'shape' | 'text' | 'fontSize' | 'fontFamily' | 'orientation' | 'lineHeight'
  >,
  measureWidth?: (text: string, font: string) => number
): BalloonTextLayout {
  const fontSize = Math.max(8, b.fontSize || 16);
  const lineMult = clamp(b.lineHeight ?? DEFAULT_LINE_HEIGHT, 0.8, 2.5);
  const lineHeightPx = fontSize * lineMult;
  const font = `bold ${fontSize}px ${b.fontFamily || 'sans-serif'}`;
  const safeBounds = getBalloonTextBounds(b);
  const measure = (txt: string) =>
    measureWidth ? measureWidth(txt, font) : defaultMeasureTextWidth(txt, font, fontSize);

  const rawText = b.text ?? '';
  const paragraphs = rawText.split(/\r?\n/);

  if (b.orientation === 'vertical') {
    const glyphAdv = fontSize * 1.05;
    const colSpacing = lineHeightPx;
    const maxColHeight = Math.max(glyphAdv, safeBounds.height);

    type ColItem = { text: string; relY: number; rotationDeg: number };
    const columns: Array<{ height: number; items: ColItem[] }> = [];

    for (const para of paragraphs) {
      const runs = buildVerticalRuns(para);
      if (runs.length === 0) {
        columns.push({ height: glyphAdv, items: [] });
        continue;
      }

      let colItems: ColItem[] = [];
      let yCursor = 0;

      for (const run of runs) {
        if (run.kind === 'sideways') {
          const w = Math.max(glyphAdv, measure(run.text));
          if (colItems.length > 0 && yCursor + w > maxColHeight) {
            columns.push({ height: yCursor, items: colItems });
            colItems = [];
            yCursor = 0;
          }
          colItems.push({ text: run.text, relY: yCursor + w * 0.5, rotationDeg: 90 });
          yCursor += w;
        } else {
          if (colItems.length > 0 && yCursor + glyphAdv > maxColHeight) {
            columns.push({ height: yCursor, items: colItems });
            colItems = [];
            yCursor = 0;
          }
          colItems.push({ text: run.text, relY: yCursor + glyphAdv * 0.5, rotationDeg: 0 });
          yCursor += glyphAdv;
        }
      }
      columns.push({ height: yCursor, items: colItems });
    }

    const numCols = columns.length;
    const totalW = Math.max(colSpacing, (numCols - 1) * colSpacing + fontSize);
    const maxH = columns.reduce((m, c) => Math.max(m, c.height), glyphAdv);
    const blockLeft = safeBounds.x + (safeBounds.width - totalW) * 0.5;
    const rightColCenterX = blockLeft + totalW - fontSize * 0.5;
    const blockTop = safeBounds.y + (safeBounds.height - maxH) * 0.5;

    const items: BalloonTextItem[] = [];
    for (let cIdx = 0; cIdx < numCols; cIdx++) {
      const col = columns[cIdx];
      const cx = rightColCenterX - cIdx * colSpacing;
      for (const it of col.items) {
        items.push({
          text: it.text,
          x: cx,
          y: blockTop + it.relY,
          rotationDeg: it.rotationDeg,
        });
      }
    }

    return {
      orientation: 'vertical',
      font,
      fontSize,
      lineHeightPx,
      safeBounds,
      items,
    };
  }

  // Horizontal layout
  const lines: string[] = [];
  for (const para of paragraphs) {
    lines.push(...wrapHorizontalParagraph(para, safeBounds.width, measure));
  }

  const totalH = lines.length * lineHeightPx;
  const centerX = safeBounds.x + safeBounds.width * 0.5;
  const startY = safeBounds.y + (safeBounds.height - totalH) * 0.5 + lineHeightPx * 0.5;

  const items: BalloonTextItem[] = lines.map((line, i) => ({
    text: line,
    x: centerX,
    y: startY + i * lineHeightPx,
    rotationDeg: 0,
  }));

  return {
    orientation: 'horizontal',
    font,
    fontSize,
    lineHeightPx,
    safeBounds,
    items,
  };
}

export function renderBalloonTextToCanvas(
  ctx: CanvasRenderingContext2D,
  b: ComicBalloonItem,
  measureWidth?: (text: string, font: string) => number
): BalloonTextLayout {
  const layout = layoutBalloonText(b, measureWidth);
  if (!b.text) return layout;

  ctx.save();
  ctx.font = layout.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < layout.items.length; i++) {
    const it = layout.items[i];
    if (!it.text) continue;
    ctx.save();
    ctx.translate(it.x, it.y);
    if (it.rotationDeg !== 0) {
      ctx.rotate(degToRad(it.rotationDeg));
    }
    if (b.strokeWidth > 0 && parseColorAlpha(b.strokeColor) > 0.001) {
      ctx.strokeStyle = b.strokeColor;
      ctx.lineWidth = b.strokeWidth * 2;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.strokeText(it.text, 0, 0);
    }
    ctx.fillStyle = b.fontColor;
    ctx.fillText(it.text, 0, 0);
    ctx.restore();
  }

  ctx.restore();
  return layout;
}
