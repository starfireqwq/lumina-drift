import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LINE_HEIGHT,
  DEFAULT_TAIL_CURVE,
  DEFAULT_TAIL_WIDTH,
  type CanvasPathTarget,
  type ComicBalloonItem,
  type OffscreenCanvasLike,
  type PathCommand,
  buildBalloonGeometry,
  buildBalloonRenderPlan,
  commandsToSvgPath,
  evalBalloonPerimeterPoint,
  layoutBalloonText,
  renderBalloonToCanvas,
  resolveBalloonTailParams,
  traceCommandsToCtx,
} from '../src/utils/comicBubbleGeometry.ts';

function makeBalloon(overrides: Partial<ComicBalloonItem> = {}): ComicBalloonItem {
  return {
    id: 'balloon_test_1',
    x: 40,
    y: 40,
    width: 160,
    height: 100,
    shape: 'oval',
    cornerRadius: 12,
    tailPos: { x: 0, y: 95 },
    tailEnabled: true,
    bgColor: '#FFFFFF',
    borderColor: '#000000',
    borderWidth: 4,
    text: '測試對白',
    fontSize: 18,
    fontColor: '#000000',
    fontFamily: 'sans-serif',
    orientation: 'horizontal',
    strokeColor: '#FFFFFF',
    strokeWidth: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Mock Canvas 2D + Pure TS Offscreen RGBA Scanline Rasterizer
// ---------------------------------------------------------------------------

type RecordedOp =
  | { op: 'beginPath' }
  | { op: 'moveTo'; x: number; y: number }
  | { op: 'lineTo'; x: number; y: number }
  | { op: 'quadraticCurveTo'; cx: number; cy: number; x: number; y: number }
  | { op: 'bezierCurveTo'; cx1: number; cy1: number; cx2: number; cy2: number; x: number; y: number }
  | { op: 'closePath' }
  | { op: 'stroke'; lineWidth: number; strokeStyle: string; lineJoin: string; lineCap: string }
  | { op: 'fill'; fillStyle: string; composite: string; globalAlpha: number }
  | { op: 'drawImage'; width: number; height: number; dx: number; dy: number; globalAlpha: number; composite: string };

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseTestColor(color: string): RGBA {
  const s = color.trim().toLowerCase();
  if (s === 'transparent' || s === 'none') return { r: 0, g: 0, b: 0, a: 0 };
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 255,
      };
    }
  }
  const m = s.match(/^rgba?\(\s*([^)]+)\s*\)$/);
  if (m) {
    const parts = m[1].split(',').map((p) => p.trim());
    return {
      r: Math.round(parseFloat(parts[0]) || 0),
      g: Math.round(parseFloat(parts[1]) || 0),
      b: Math.round(parseFloat(parts[2]) || 0),
      a: parts[3] !== undefined ? Math.round(parseFloat(parts[3]) * 255) : 255,
    };
  }
  return { r: 0, g: 0, b: 0, a: 255 };
}

function flattenSubpaths(cmds: PathCommand[]): Array<{ points: Array<{ x: number; y: number }>; closed: boolean }> {
  const subpaths: Array<{ points: Array<{ x: number; y: number }>; closed: boolean }> = [];
  let cur: Array<{ x: number; y: number }> = [];
  let closed = false;
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;

  for (const c of cmds) {
    if (c.type === 'M') {
      if (cur.length > 0) subpaths.push({ points: cur, closed });
      cur = [{ x: c.x, y: c.y }];
      closed = false;
      sx = cx = c.x;
      sy = cy = c.y;
    } else if (c.type === 'L') {
      cur.push({ x: c.x, y: c.y });
      cx = c.x;
      cy = c.y;
    } else if (c.type === 'Q') {
      const steps = 20;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        cur.push({
          x: mt * mt * cx + 2 * mt * t * c.cx + t * t * c.x,
          y: mt * mt * cy + 2 * mt * t * c.cy + t * t * c.y,
        });
      }
      cx = c.x;
      cy = c.y;
    } else if (c.type === 'C') {
      const steps = 20;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        cur.push({
          x: mt * mt * mt * cx + 3 * mt * mt * t * c.cx1 + 3 * mt * t * t * c.cx2 + t * t * t * c.x,
          y: mt * mt * mt * cy + 3 * mt * mt * t * c.cy1 + 3 * mt * t * t * c.cy2 + t * t * t * c.y,
        });
      }
      cx = c.x;
      cy = c.y;
    } else if (c.type === 'Z') {
      closed = true;
      cx = sx;
      cy = sy;
    }
  }
  if (cur.length > 0) subpaths.push({ points: cur, closed });
  return subpaths;
}

function pointInPoly(px: number, py: number, pts: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-12) return wx * wx + wy * wy;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq));
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return dx * dx + dy * dy;
}

class RasterMockCanvas implements OffscreenCanvasLike {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  ops: RecordedOp[] = [];
  ctx: RasterMockContext;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
    this.ctx = new RasterMockContext(this);
  }

  getContext(_contextId: '2d'): CanvasRenderingContext2D | null {
    return this.ctx as unknown as CanvasRenderingContext2D;
  }

  getPixel(x: number, y: number): RGBA {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) return { r: 0, g: 0, b: 0, a: 0 };
    const idx = (iy * this.width + ix) * 4;
    return {
      r: this.pixels[idx],
      g: this.pixels[idx + 1],
      b: this.pixels[idx + 2],
      a: this.pixels[idx + 3],
    };
  }
}

class RasterMockContext implements CanvasPathTarget {
  canvas: RasterMockCanvas;
  fillStyle = '#000000';
  strokeStyle = '#000000';
  lineWidth = 1;
  lineJoin = 'miter';
  lineCap = 'butt';
  miterLimit = 10;
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';

  private tx = 0;
  private ty = 0;
  private stack: Array<{
    fillStyle: string;
    strokeStyle: string;
    lineWidth: number;
    lineJoin: string;
    lineCap: string;
    miterLimit: number;
    globalAlpha: number;
    globalCompositeOperation: string;
    tx: number;
    ty: number;
  }> = [];
  private path: PathCommand[] = [];

  constructor(canvas: RasterMockCanvas) {
    this.canvas = canvas;
  }

  save(): void {
    this.stack.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      lineJoin: this.lineJoin,
      lineCap: this.lineCap,
      miterLimit: this.miterLimit,
      globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation,
      tx: this.tx,
      ty: this.ty,
    });
  }

  restore(): void {
    const s = this.stack.pop();
    if (!s) return;
    this.fillStyle = s.fillStyle;
    this.strokeStyle = s.strokeStyle;
    this.lineWidth = s.lineWidth;
    this.lineJoin = s.lineJoin;
    this.lineCap = s.lineCap;
    this.miterLimit = s.miterLimit;
    this.globalAlpha = s.globalAlpha;
    this.globalCompositeOperation = s.globalCompositeOperation;
    this.tx = s.tx;
    this.ty = s.ty;
  }

  translate(x: number, y: number): void {
    this.tx += x;
    this.ty += y;
  }

  beginPath(): void {
    this.path = [];
    this.canvas.ops.push({ op: 'beginPath' });
  }

  moveTo(x: number, y: number): void {
    this.path.push({ type: 'M', x: x + this.tx, y: y + this.ty });
    this.canvas.ops.push({ op: 'moveTo', x, y });
  }

  lineTo(x: number, y: number): void {
    this.path.push({ type: 'L', x: x + this.tx, y: y + this.ty });
    this.canvas.ops.push({ op: 'lineTo', x, y });
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.path.push({ type: 'Q', cx: cx + this.tx, cy: cy + this.ty, x: x + this.tx, y: y + this.ty });
    this.canvas.ops.push({ op: 'quadraticCurveTo', cx, cy, x, y });
  }

  bezierCurveTo(cx1: number, cy1: number, cx2: number, cy2: number, x: number, y: number): void {
    this.path.push({
      type: 'C',
      cx1: cx1 + this.tx,
      cy1: cy1 + this.ty,
      cx2: cx2 + this.tx,
      cy2: cy2 + this.ty,
      x: x + this.tx,
      y: y + this.ty,
    });
    this.canvas.ops.push({ op: 'bezierCurveTo', cx1, cy1, cx2, cy2, x, y });
  }

  closePath(): void {
    this.path.push({ type: 'Z' });
    this.canvas.ops.push({ op: 'closePath' });
  }

  private blendPixel(idx: number, sr: number, sg: number, sb: number, sa01: number): void {
    if (sa01 <= 0) return;
    const p = this.canvas.pixels;
    if (this.globalCompositeOperation === 'destination-out') {
      const keep = Math.max(0, 1 - sa01);
      p[idx] = Math.round(p[idx] * keep);
      p[idx + 1] = Math.round(p[idx + 1] * keep);
      p[idx + 2] = Math.round(p[idx + 2] * keep);
      p[idx + 3] = Math.round(p[idx + 3] * keep);
      return;
    }
    const da = p[idx + 3] / 255;
    const outA = sa01 + da * (1 - sa01);
    if (outA <= 1e-6) {
      p[idx] = p[idx + 1] = p[idx + 2] = p[idx + 3] = 0;
      return;
    }
    p[idx] = Math.round((sr * sa01 + p[idx] * da * (1 - sa01)) / outA);
    p[idx + 1] = Math.round((sg * sa01 + p[idx + 1] * da * (1 - sa01)) / outA);
    p[idx + 2] = Math.round((sb * sa01 + p[idx + 2] * da * (1 - sa01)) / outA);
    p[idx + 3] = Math.round(outA * 255);
  }

  fill(): void {
    this.canvas.ops.push({
      op: 'fill',
      fillStyle: this.fillStyle,
      composite: this.globalCompositeOperation,
      globalAlpha: this.globalAlpha,
    });
    const rgba = parseTestColor(this.fillStyle);
    const sa01 = (rgba.a / 255) * this.globalAlpha;
    const subpaths = flattenSubpaths(this.path);
    const w = this.canvas.width;
    const h = this.canvas.height;
    for (let y = 0; y < h; y++) {
      const py = y + 0.5;
      for (let x = 0; x < w; x++) {
        const px = x + 0.5;
        let hit = false;
        for (const sp of subpaths) {
          if (pointInPoly(px, py, sp.points)) {
            hit = !hit;
          }
        }
        if (hit) {
          this.blendPixel((y * w + x) * 4, rgba.r, rgba.g, rgba.b, sa01);
        }
      }
    }
  }

  stroke(): void {
    this.canvas.ops.push({
      op: 'stroke',
      lineWidth: this.lineWidth,
      strokeStyle: this.strokeStyle,
      lineJoin: this.lineJoin,
      lineCap: this.lineCap,
    });
    const rgba = parseTestColor(this.strokeStyle);
    const sa01 = (rgba.a / 255) * this.globalAlpha;
    const halfW = this.lineWidth * 0.5;
    const halfWSq = halfW * halfW;
    const subpaths = flattenSubpaths(this.path);
    const w = this.canvas.width;
    const h = this.canvas.height;

    for (let y = 0; y < h; y++) {
      const py = y + 0.5;
      for (let x = 0; x < w; x++) {
        const px = x + 0.5;
        let minSq = Infinity;
        for (const sp of subpaths) {
          const pts = sp.points;
          const count = sp.closed ? pts.length : pts.length - 1;
          for (let i = 0; i < count; i++) {
            const a = pts[i];
            const b = pts[(i + 1) % pts.length];
            const dSq = distToSegmentSq(px, py, a.x, a.y, b.x, b.y);
            if (dSq < minSq) minSq = dSq;
          }
        }
        if (minSq <= halfWSq) {
          this.blendPixel((y * w + x) * 4, rgba.r, rgba.g, rgba.b, sa01);
        }
      }
    }
  }

  drawImage(img: unknown, dx: number, dy: number): void {
    const src = img as RasterMockCanvas;
    this.canvas.ops.push({
      op: 'drawImage',
      width: src.width,
      height: src.height,
      dx,
      dy,
      globalAlpha: this.globalAlpha,
      composite: this.globalCompositeOperation,
    });
    const ix0 = Math.round(dx + this.tx);
    const iy0 = Math.round(dy + this.ty);
    for (let sy = 0; sy < src.height; sy++) {
      const ty = iy0 + sy;
      if (ty < 0 || ty >= this.canvas.height) continue;
      for (let sx = 0; sx < src.width; sx++) {
        const tx = ix0 + sx;
        if (tx < 0 || tx >= this.canvas.width) continue;
        const sIdx = (sy * src.width + sx) * 4;
        const sa01 = (src.pixels[sIdx + 3] / 255) * this.globalAlpha;
        if (sa01 <= 0) continue;
        this.blendPixel(
          (ty * this.canvas.width + tx) * 4,
          src.pixels[sIdx],
          src.pixels[sIdx + 1],
          src.pixels[sIdx + 2],
          sa01
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Test Suite
// ---------------------------------------------------------------------------

test('resolveBalloonTailParams preserves legacy defaults and auto-aligns toward tailPos', () => {
  const legacy = resolveBalloonTailParams({
    width: 200,
    height: 100,
    tailPos: { x: 100, y: 0 },
  });
  assert.equal(legacy.isAutoBaseAngle, true);
  assert.equal(legacy.tailBaseAngle, 0);
  assert.equal(legacy.tailWidth, DEFAULT_TAIL_WIDTH);
  assert.equal(DEFAULT_TAIL_WIDTH, 28);
  assert.equal(legacy.tailCurve, DEFAULT_TAIL_CURVE);

  // Aspect-normalized angle: for w=200 (rx=100), h=100 (ry=50), (100, 50) maps to 45 deg
  const aspectDiag = resolveBalloonTailParams({
    width: 200,
    height: 100,
    tailPos: { x: 100, y: 50 },
  });
  assert.ok(Math.abs(aspectDiag.tailBaseAngle - 45) < 1e-6);

  // Clamping & explicit base angle
  const clamped = resolveBalloonTailParams({
    width: 200,
    height: 100,
    tailPos: { x: 0, y: 90 },
    tailBaseAngle: -90,
    tailWidth: 999,
    tailCurve: -5,
  });
  assert.equal(clamped.isAutoBaseAngle, false);
  assert.equal(clamped.tailBaseAngle, 270);
  assert.equal(clamped.tailWidth, 80);
  assert.equal(clamped.tailCurve, -1);
});

test('all 4 shapes evaluate exact perimeter points at arbitrary angles (not locked to bottom center)', () => {
  const angles = [0, 45, 90, 135, 180, 225, 270, 315];

  for (const angle of angles) {
    const ovalSample = evalBalloonPerimeterPoint(
      { shape: 'oval', width: 240, height: 120 },
      angle
    );
    const normEq = (ovalSample.point.x / 120) ** 2 + (ovalSample.point.y / 60) ** 2;
    assert.ok(Math.abs(normEq - 1) < 1e-6, `oval perimeter mismatch at ${angle}deg: ${normEq}`);

    const rectSample = evalBalloonPerimeterPoint(
      { shape: 'rect', width: 200, height: 120, cornerRadius: 24 },
      angle
    );
    const ix = 100 - 24;
    const iy = 60 - 24;
    const qx = Math.abs(rectSample.point.x) - ix;
    const qy = Math.abs(rectSample.point.y) - iy;
    const sdf = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 24;
    assert.ok(Math.abs(sdf) < 1e-6, `rounded rect SDF mismatch at ${angle}deg: ${sdf}`);
  }

  // Verify base moves freely around top/left/right/bottom instead of hardcoding bottom center
  const topTail = buildBalloonGeometry(
    makeBalloon({ shape: 'oval', tailBaseAngle: 270, tailPos: { x: 0, y: -120 } })
  );
  assert.ok(topTail.tailLocal.baseCenter.y < -45);
  assert.ok(Math.abs(topTail.tailLocal.baseCenter.x) < 1e-6);

  const rightTail = buildBalloonGeometry(
    makeBalloon({ shape: 'rect', tailBaseAngle: 0, tailPos: { x: 140, y: 0 }, tailWidth: 36 })
  );
  assert.ok(rightTail.tailLocal.baseCenter.x > 75);
  const baseChord = Math.hypot(
    rightTail.tailLocal.baseRight.x - rightTail.tailLocal.baseLeft.x,
    rightTail.tailLocal.baseRight.y - rightTail.tailLocal.baseLeft.y
  );
  assert.ok(Math.abs(baseChord - 36) < 2, `expected tailWidth ~36, got ${baseChord}`);

  // Spiky determinism & spliced perimeter
  const spikyA = buildBalloonGeometry(
    makeBalloon({ id: 'spiky_seed_1', shape: 'spiky', tailBaseAngle: 30, tailPos: { x: 140, y: 80 } })
  );
  const spikyB = buildBalloonGeometry(
    makeBalloon({ id: 'spiky_seed_1', shape: 'spiky', tailBaseAngle: 30, tailPos: { x: 140, y: 80 } })
  );
  assert.deepEqual(spikyA.bodyCommands, spikyB.bodyCommands);
  assert.equal(spikyA.isTailSpliced, true);
  assert.equal(spikyA.tailCommands.length, 0);

  // Thought clouds produce non-overlapping trailing dots that stay outside the cloud
  const thought = buildBalloonGeometry(
    makeBalloon({
      id: 'thought_1',
      shape: 'thought',
      tailBaseAngle: 90,
      tailPos: { x: 0, y: 150 },
      tailWidth: 32,
      borderWidth: 3,
    })
  );
  assert.ok(thought.dotCommands.length >= 1 && thought.dotCommands.length <= 3);
  assert.equal(thought.tailCommands.length, 0);
});

test('tailCurve bends symmetrically and degenerates cleanly when tip is inside or too close', () => {
  const straight = buildBalloonGeometry(makeBalloon({ tailCurve: 0, tailBaseAngle: 90, tailPos: { x: 0, y: 120 } }));
  const posCurve = buildBalloonGeometry(makeBalloon({ tailCurve: 0.6, tailBaseAngle: 90, tailPos: { x: 0, y: 120 } }));
  const negCurve = buildBalloonGeometry(makeBalloon({ tailCurve: -0.6, tailBaseAngle: 90, tailPos: { x: 0, y: 120 } }));

  assert.ok(Math.abs(straight.tailLocal.curveHandle.x) < 1e-6);
  assert.ok(Math.abs(posCurve.tailLocal.curveHandle.x + negCurve.tailLocal.curveHandle.x) < 1e-6);
  assert.ok(Math.abs(posCurve.tailLocal.curveHandle.y - negCurve.tailLocal.curveHandle.y) < 1e-6);
  assert.notEqual(posCurve.tailLocal.curveHandle.x, 0);

  // Tip inside body -> suppressed (no inverted internal spike)
  const insideTip = buildBalloonGeometry(makeBalloon({ tailPos: { x: 5, y: 5 }, tailEnabled: true }));
  assert.equal(insideTip.tailSuppressed, true);
  assert.equal(insideTip.tailCommands.length, 0);
  assert.equal(insideTip.dotCommands.length, 0);
});

test('SVG path string and Canvas 2D commands match within 1e-6', () => {
  const shapes: Array<ComicBalloonItem['shape']> = ['oval', 'rect', 'spiky', 'thought'];
  for (const shape of shapes) {
    const geom = buildBalloonGeometry(
      makeBalloon({ shape, tailBaseAngle: 45, tailPos: { x: 130, y: 110 }, tailCurve: 0.4 })
    );
    const cmds = geom.bodyCommands;
    const svgD = commandsToSvgPath(cmds);

    const canvas = new RasterMockCanvas(400, 400);
    const recorded: PathCommand[] = [];
    const proxy: CanvasPathTarget = {
      moveTo: (x, y) => recorded.push({ type: 'M', x, y }),
      lineTo: (x, y) => recorded.push({ type: 'L', x, y }),
      quadraticCurveTo: (cx, cy, x, y) => recorded.push({ type: 'Q', cx, cy, x, y }),
      bezierCurveTo: (cx1, cy1, cx2, cy2, x, y) => recorded.push({ type: 'C', cx1, cy1, cx2, cy2, x, y }),
      closePath: () => recorded.push({ type: 'Z' }),
    };
    traceCommandsToCtx(proxy, cmds);
    assert.ok(canvas.width === 400);

    const tokens = svgD.match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) ?? [];
    let ti = 0;
    for (const cmd of recorded) {
      const op = tokens[ti++];
      assert.equal(op, cmd.type);
      if (cmd.type === 'M' || cmd.type === 'L') {
        assert.ok(Math.abs(parseFloat(tokens[ti++]) - cmd.x) < 1e-6);
        assert.ok(Math.abs(parseFloat(tokens[ti++]) - cmd.y) < 1e-6);
      } else if (cmd.type === 'Q') {
        assert.ok(Math.abs(parseFloat(tokens[ti++]) - cmd.cx) < 1e-6);
        assert.ok(Math.abs(parseFloat(tokens[ti++]) - cmd.cy) < 1e-6);
        assert.ok(Math.abs(parseFloat(tokens[ti++]) - cmd.x) < 1e-6);
        assert.ok(Math.abs(parseFloat(tokens[ti++]) - cmd.y) < 1e-6);
      } else if (cmd.type === 'C') {
        assert.ok(Math.abs(parseFloat(tokens[ti++]) - cmd.cx1) < 1e-6);
        assert.ok(Math.abs(parseFloat(tokens[ti++]) - cmd.cy1) < 1e-6);
        assert.ok(Math.abs(parseFloat(tokens[ti++]) - cmd.cx2) < 1e-6);
        assert.ok(Math.abs(parseFloat(tokens[ti++]) - cmd.cy2) < 1e-6);
        assert.ok(Math.abs(parseFloat(tokens[ti++]) - cmd.x) < 1e-6);
        assert.ok(Math.abs(parseFloat(tokens[ti++]) - cmd.y) < 1e-6);
      }
    }
    assert.equal(ti, tokens.length);
  }
});

test('dual-layer union & offscreen rasterization eliminate interior junction seams across opaque, transparent, and translucent fills', () => {
  const baseBalloon = {
    x: 40,
    y: 40,
    width: 160,
    height: 100,
    shape: 'oval' as const,
    tailBaseAngle: 90,
    tailPos: { x: 0, y: 110 },
    tailWidth: 30,
    tailCurve: 0,
    borderColor: '#000000',
    borderWidth: 4,
  };

  // A. Opaque #FFFFFF fill: strokes first (2x borderWidth), fills second, zero black seam at junction
  {
    const b = makeBalloon({ ...baseBalloon, bgColor: '#FFFFFF' });
    const plan = buildBalloonRenderPlan(b);
    assert.equal(plan.mode, 'opaque-dual-layer');

    const mainCanvas = new RasterMockCanvas(240, 240);
    renderBalloonToCanvas(
      mainCanvas.getContext('2d')!,
      b,
      (w, h) => new RasterMockCanvas(w, h)
    );

    const strokeIdx = mainCanvas.ops.findIndex((o) => o.op === 'stroke');
    const fillIdx = mainCanvas.ops.findIndex((o) => o.op === 'fill');
    assert.ok(strokeIdx >= 0 && fillIdx > strokeIdx, 'strokes must precede fills');
    assert.equal(
      mainCanvas.ops.slice(fillIdx).some((o) => o.op === 'stroke'),
      false,
      'fill phase must never call stroke()'
    );

    // Junction chord at y = 140 (cy + ry = 90 + 50), x in [115..125] must be pure #FFFFFF
    for (let x = 115; x <= 125; x++) {
      for (let y = 138; y <= 142; y++) {
        const px = mainCanvas.getPixel(x, y);
        assert.deepEqual(px, { r: 255, g: 255, b: 255, a: 255 }, `seam at (${x},${y})`);
      }
    }
    // Top exterior border at x = 120, y = 38 must be #000000
    assert.deepEqual(mainCanvas.getPixel(120, 38), { r: 0, g: 0, b: 0, a: 255 });
  }

  // B. Transparent fill ('transparent'): isolated offscreen destination-out punches out interior & junction seam
  {
    const b = makeBalloon({ ...baseBalloon, bgColor: 'transparent' });
    const plan = buildBalloonRenderPlan(b);
    assert.equal(plan.mode, 'isolated-alpha');
    assert.equal(plan.hasFill, false);
    assert.ok(plan.punchOuts.length === 2);

    const mainCanvas = new RasterMockCanvas(240, 240);
    const offscreens: RasterMockCanvas[] = [];
    renderBalloonToCanvas(
      mainCanvas.getContext('2d')!,
      b,
      (w, h) => {
        const c = new RasterMockCanvas(w, h);
        offscreens.push(c);
        return c;
      }
    );

    assert.equal(offscreens.length, 1);
    assert.ok(
      offscreens[0].ops.some((o) => o.op === 'fill' && o.composite === 'destination-out'),
      'border offscreen must use destination-out punch-out'
    );

    // Junction interior pixels must be fully transparent (alpha === 0)
    for (let x = 115; x <= 125; x++) {
      for (let y = 138; y <= 142; y++) {
        const px = mainCanvas.getPixel(x, y);
        assert.equal(px.a, 0, `unexpected opaque seam at (${x},${y}): alpha=${px.a}`);
      }
    }
    // Top exterior border must still be solid black, and interior must remain transparent
    assert.deepEqual(mainCanvas.getPixel(120, 38), { r: 0, g: 0, b: 0, a: 255 });
    assert.equal(mainCanvas.getPixel(120, 90).a, 0);
  }

  // C. Semi-transparent fill ('rgba(255, 255, 255, 0.5)'): uniform interior alpha, zero double-alpha crescent, preserves backdrop
  {
    const b = makeBalloon({ ...baseBalloon, bgColor: 'rgba(255, 255, 255, 0.5)' });
    const mainCanvas = new RasterMockCanvas(240, 240);
    // Paint a dark-blue backdrop line underneath to prove destination-out does NOT punch through underlying layers
    const ctx = mainCanvas.getContext('2d')!;
    ctx.fillStyle = '#002244';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(240, 0);
    ctx.lineTo(240, 240);
    ctx.lineTo(0, 240);
    ctx.closePath();
    ctx.fill();

    renderBalloonToCanvas(ctx, b, (w, h) => new RasterMockCanvas(w, h));

    const centerPx = mainCanvas.getPixel(120, 90);
    const junctionPx = mainCanvas.getPixel(120, 140);
    const tailInteriorPx = mainCanvas.getPixel(120, 148);
    assert.deepEqual(junctionPx, centerPx, 'junction must have identical color to center (no seam or double alpha)');
    assert.deepEqual(tailInteriorPx, centerPx, 'tail interior must have identical alpha to body center');
    // Backdrop outside balloon remains untouched (#002244)
    assert.deepEqual(mainCanvas.getPixel(5, 5), { r: 0, g: 34, b: 68, a: 255 });
  }
});

test('layoutBalloonText handles horizontal wrapping and vertical tategaki punctuation rotation without DOM', () => {
  const horiz = layoutBalloonText(
    makeBalloon({
      text: '第一行\n這是一段很長很長會超過氣泡安全寬度的測試文字',
      width: 160,
      height: 120,
      fontSize: 16,
      lineHeight: DEFAULT_LINE_HEIGHT,
      orientation: 'horizontal',
    })
  );
  assert.ok(horiz.items.length >= 3);
  for (let i = 1; i < horiz.items.length; i++) {
    assert.ok(horiz.items[i].y > horiz.items[i - 1].y);
    assert.equal(horiz.items[i].rotationDeg, 0);
  }

  const vert = layoutBalloonText(
    makeBalloon({
      text: '「你好！ABC」',
      width: 180,
      height: 180,
      fontSize: 18,
      orientation: 'vertical',
    })
  );
  const texts = vert.items.map((it) => it.text);
  assert.ok(texts.includes('﹁'), 'expected rotated opening bracket ﹁');
  assert.ok(texts.includes('﹂'), 'expected rotated closing bracket ﹂');
  const asciiRun = vert.items.find((it) => it.text === 'ABC');
  assert.ok(asciiRun && asciiRun.rotationDeg === 90, 'expected sideways ASCII run rotated 90deg');
});

function flattenPathForTest(cmds: PathCommand[], curveSteps = 32): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  let cx = 0;
  let cy = 0;
  for (const c of cmds) {
    if (c.type === 'M' || c.type === 'L') {
      pts.push({ x: c.x, y: c.y });
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
        pts.push({
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
        pts.push({
          x: mt * mt * mt * cx + 3 * mt * mt * t * c.cx1 + 3 * mt * t * t * c.cx2 + t * t * t * c.x,
          y: mt * mt * mt * cy + 3 * mt * mt * t * c.cy1 + 3 * mt * t * t * c.cy2 + t * t * t * c.y,
        });
      }
      cx = c.x;
      cy = c.y;
    }
  }
  const clean: Array<{ x: number; y: number }> = [];
  for (const p of pts) {
    if (clean.length === 0 || Math.hypot(p.x - clean[clean.length - 1].x, p.y - clean[clean.length - 1].y) > 1e-6) {
      clean.push(p);
    }
  }
  if (clean.length > 1 && Math.hypot(clean[0].x - clean[clean.length - 1].x, clean[0].y - clean[clean.length - 1].y) <= 1e-6) {
    clean.pop();
  }
  return clean;
}

function orient2DTest(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersectTest(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number }
): boolean {
  const eps = 1e-7;
  if (
    Math.max(a.x, b.x) < Math.min(c.x, d.x) - eps ||
    Math.max(c.x, d.x) < Math.min(a.x, b.x) - eps ||
    Math.max(a.y, b.y) < Math.min(c.y, d.y) - eps ||
    Math.max(c.y, d.y) < Math.min(a.y, b.y) - eps
  ) {
    return false;
  }
  const d1 = orient2DTest(c, d, a);
  const d2 = orient2DTest(c, d, b);
  const d3 = orient2DTest(a, b, c);
  const d4 = orient2DTest(a, b, d);
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

function hasSelfIntersectionTest(cmds: PathCommand[], curveSteps = 64): boolean {
  const p = flattenPathForTest(cmds, curveSteps);
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsIntersectTest(a, b, p[j], p[(j + 1) % n])) return true;
    }
  }
  return false;
}

function pointInPolygonTest(p: { x: number; y: number }, verts: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i].x;
    const yi = verts[i].y;
    const xj = verts[j].x;
    const yj = verts[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function distToPolygonTest(p: { x: number; y: number }, verts: Array<{ x: number; y: number }>): number {
  let minD = Infinity;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const l2 = vx * vx + vy * vy;
    const t = l2 <= 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2));
    minD = Math.min(minD, Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy)));
  }
  return minD;
}

function extractCircleMetrics(cmds: PathCommand[]): { cx: number; cy: number; r: number } {
  const pts = flattenPathForTest(cmds, 12);
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  const cx = sx / pts.length;
  const cy = sy / pts.length;
  let r = 0;
  for (const p of pts) {
    r += Math.hypot(p.x - cx, p.y - cy);
  }
  return { cx, cy, r: r / pts.length };
}

test('thought cloud short tail with extreme tailCurve keeps all dots outside cloud and stroke-separated', () => {
  const borderWidth = 4;
  for (let deg = 0; deg < 360; deg += 5) {
    for (const tc of [-1, -0.5, 0, 0.5, 1]) {
      for (const dist of [30, 80]) {
        const perim = evalBalloonPerimeterPoint({ shape: 'thought', width: 200, height: 140, id: 'thought_adv' }, deg);
        const tip = { x: perim.point.x + perim.normal.x * dist, y: perim.point.y + perim.normal.y * dist };
        const geom = buildBalloonGeometry(
          makeBalloon({
            id: 'thought_adv',
            x: 0,
            y: 0,
            width: 200,
            height: 140,
            shape: 'thought',
            tailBaseAngle: deg,
            tailPos: tip,
            tailWidth: 40,
            tailCurve: tc,
            borderWidth,
          })
        );
        const cloudVerts = flattenPathForTest(geom.bodyCommands, 16);
        const circles = geom.dotCommands.map(extractCircleMetrics);
        for (let i = 0; i < circles.length; i++) {
          const c = circles[i];
          assert.equal(
            pointInPolygonTest({ x: c.cx, y: c.cy }, cloudVerts),
            false,
            `thought dot inside cloud at deg=${deg}, tc=${tc}, dist=${dist}`
          );
          const cloudClearance = distToPolygonTest({ x: c.cx, y: c.cy }, cloudVerts);
          assert.ok(
            cloudClearance >= c.r + borderWidth * 2 - 0.15,
            `thought dot overlaps cloud border (${cloudClearance} < ${c.r + borderWidth * 2}) at deg=${deg}, tc=${tc}, dist=${dist}`
          );
          for (let j = i + 1; j < circles.length; j++) {
            const d = Math.hypot(c.cx - circles[j].cx, c.cy - circles[j].cy);
            assert.ok(
              d >= c.r + circles[j].r + borderWidth * 2,
              `thought dot borders overlap (${d} < ${c.r + circles[j].r + borderWidth * 2}) at deg=${deg}, tc=${tc}, dist=${dist}`
            );
          }
        }
      }
    }
  }
});

test('spiky balloon has zero self-intersections across 72 angles and extreme tailCurve, and handles exact splice boundary', () => {
  for (let deg = 0; deg < 360; deg += 5) {
    for (const tc of [-1, -0.5, 0, 0.5, 1]) {
      for (const dist of [25, 80]) {
        const perim = evalBalloonPerimeterPoint({ shape: 'spiky', width: 220, height: 140, id: 'spiky_adv' }, deg);
        const rad = (deg * Math.PI) / 180;
        const tip =
          dist === 80
            ? { x: (110 + dist) * Math.cos(rad), y: (70 + dist) * Math.sin(rad) }
            : { x: perim.point.x + perim.normal.x * dist, y: perim.point.y + perim.normal.y * dist };
        const geom = buildBalloonGeometry(
          makeBalloon({
            id: 'spiky_adv',
            x: 0,
            y: 0,
            width: 220,
            height: 140,
            shape: 'spiky',
            tailBaseAngle: deg,
            tailPos: tip,
            tailWidth: 28,
            tailCurve: tc,
            borderWidth: 3,
          })
        );
        assert.ok(geom.bodyCommands.length >= 15, `degenerate spiky body at deg=${deg}, tc=${tc}, dist=${dist}`);
        assert.equal(
          hasSelfIntersectionTest(geom.bodyCommands),
          false,
          `spiky body self-intersects at deg=${deg}, tc=${tc}, dist=${dist}`
        );
        if (geom.tailCommands.length > 0) {
          assert.equal(
            hasSelfIntersectionTest(geom.tailCommands),
            false,
            `spiky fallback tail self-intersects at deg=${deg}, tc=${tc}, dist=${dist}`
          );
        }
      }
    }
  }

  // Exact vertex-boundary splice precision regression: right splice landing just past a vertex (cumLengths[i] + 5e-7)
  const base = evalBalloonPerimeterPoint({ shape: 'spiky', width: 220, height: 140, id: 'spiky_exact' }, 0);
  let prevN = base.normal;
  let cornerArc: number | null = null;
  for (let deg = 0.01; deg < 60; deg += 0.01) {
    const s = evalBalloonPerimeterPoint({ shape: 'spiky', width: 220, height: 140, id: 'spiky_exact' }, deg);
    if (s.normal.x * prevN.x + s.normal.y * prevN.y < 0.99) {
      let lo = deg - 0.01;
      let hi = deg;
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) * 0.5;
        const sm = evalBalloonPerimeterPoint({ shape: 'spiky', width: 220, height: 140, id: 'spiky_exact' }, mid);
        if (sm.normal.x * prevN.x + sm.normal.y * prevN.y > 0.999) lo = mid;
        else hi = mid;
      }
      cornerArc = evalBalloonPerimeterPoint({ shape: 'spiky', width: 220, height: 140, id: 'spiky_exact' }, hi).arcLength;
      break;
    }
    prevN = s.normal;
  }
  assert.ok(cornerArc !== null, 'expected to locate a spiky vertex corner arc length');
  const tailWidth = (cornerArc - base.arcLength + 5e-7) * 2;
  const exactGeom = buildBalloonGeometry(
    makeBalloon({
      id: 'spiky_exact',
      x: 0,
      y: 0,
      width: 220,
      height: 140,
      shape: 'spiky',
      tailBaseAngle: 0,
      tailPos: { x: 200, y: 0 },
      tailWidth,
      tailCurve: 0,
    })
  );
  assert.ok(exactGeom.bodyCommands.length >= 20, 'spiky vertices must not be dropped at exact boundary');
  assert.equal(exactGeom.isTailSpliced, true);
});

test('computeCommandsBounds tightly encloses long curved tails without edge clipping', () => {
  const geom = buildBalloonGeometry(
    makeBalloon({
      id: 'long_curve',
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      shape: 'oval',
      tailBaseAngle: 90,
      tailPos: { x: 0, y: 860 },
      tailCurve: 1,
      borderWidth: 4,
    })
  );
  const pts = [...flattenPathForTest(geom.bodyCommands, 64), ...flattenPathForTest(geom.tailCommands, 64)];
  for (const p of pts) {
    assert.ok(p.x >= geom.bounds.x + 4 - 1e-6);
    assert.ok(p.x <= geom.bounds.x + geom.bounds.width - 4 + 1e-6);
    assert.ok(p.y >= geom.bounds.y + 4 - 1e-6);
    assert.ok(p.y <= geom.bounds.y + geom.bounds.height - 4 + 1e-6);
  }
});

test('adversarial minimal repros: oval/rect short & oblique tail, thought 2*bw clearance, spiky fallback valley containment', () => {
  // 1. oval short tail figure-8 repro
  const reproOval = buildBalloonGeometry(
    makeBalloon({
      id: 'repro_oval_si',
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      shape: 'oval',
      tailBaseAngle: 0,
      tailPos: { x: 111.05273192803463, y: 4.6730201077038 },
      tailEnabled: true,
      tailWidth: 28,
      tailCurve: -1,
      borderWidth: 4,
    })
  );
  assert.equal(reproOval.tailSuppressed, false);
  assert.equal(hasSelfIntersectionTest(reproOval.tailCommands, 128), false, 'repro_oval_si tail must not self-intersect');

  // 2. rect long oblique tail repro
  const reproRect = buildBalloonGeometry(
    makeBalloon({
      id: 'repro_rect_si',
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      shape: 'rect',
      cornerRadius: 12,
      tailBaseAngle: 135,
      tailPos: { x: 29.74, y: 247.34 },
      tailEnabled: true,
      tailWidth: 28,
      tailCurve: -1,
      borderWidth: 4,
    })
  );
  assert.equal(reproRect.tailSuppressed, false);
  assert.equal(hasSelfIntersectionTest(reproRect.tailCommands, 128), false, 'repro_rect_si tail must not self-intersect');

  // 3. thought t_real 2*bw cloud stroke separation repro
  const tReal = buildBalloonGeometry(
    makeBalloon({
      id: 't_real',
      x: 0,
      y: 0,
      width: 200,
      height: 140,
      shape: 'thought',
      tailBaseAngle: 0,
      tailPos: { x: 118.4, y: 4.5 },
      tailEnabled: true,
      tailWidth: 28,
      tailCurve: 0.5,
      borderWidth: 4,
    })
  );
  const tRealCloud = flattenPathForTest(tReal.bodyCommands, 32);
  for (const dot of tReal.dotCommands) {
    const c = extractCircleMetrics(dot);
    assert.equal(pointInPolygonTest({ x: c.cx, y: c.cy }, tRealCloud), false);
    const clearance = distToPolygonTest({ x: c.cx, y: c.cy }, tRealCloud);
    assert.ok(clearance >= c.r + 4 * 2 - 0.15, `t_real dot overlaps cloud stroke: ${clearance} < ${c.r + 8}`);
  }

  // 4. spiky_220 fallback tail return path must stay strictly inside spiky body polygon
  const spiky220 = buildBalloonGeometry(
    makeBalloon({
      id: 'spiky_220',
      x: 0,
      y: 0,
      width: 220,
      height: 140,
      shape: 'spiky',
      tailBaseAngle: 10,
      tailPos: { x: 70.26226195819955, y: 42.58086370706259 },
      tailEnabled: true,
      tailWidth: 28,
      tailCurve: -1,
      borderWidth: 4,
    })
  );
  assert.equal(spiky220.isTailSpliced, false);
  assert.ok(spiky220.tailCommands.length > 0);
  assert.equal(hasSelfIntersectionTest(spiky220.tailCommands, 128), false, 'spiky_220 tail must not self-intersect');
  const spikyBodyVerts = flattenPathForTest(spiky220.bodyCommands, 16);
  // All return vertices after the two Q commands (and closing segments back to M) must stay inside body polygon
  const qEndIdx = spiky220.tailCommands.findIndex((c, idx) => idx > 0 && c.type === 'Q' && spiky220.tailCommands[idx + 1]?.type !== 'Q');
  assert.ok(qEndIdx >= 2);
  const mCmd = spiky220.tailCommands[0] as Extract<PathCommand, { type: 'M' }>;
  const q2Cmd = spiky220.tailCommands[qEndIdx] as Extract<PathCommand, { type: 'Q' }>;
  const retChain: Array<{ x: number; y: number }> = [{ x: q2Cmd.x, y: q2Cmd.y }];
  for (let i = qEndIdx + 1; i < spiky220.tailCommands.length; i++) {
    const cmd = spiky220.tailCommands[i];
    if (cmd.type === 'L') retChain.push({ x: cmd.x, y: cmd.y });
  }
  retChain.push({ x: mCmd.x, y: mCmd.y });
  for (let i = 0; i < retChain.length - 1; i++) {
    for (let s = 0; s <= 10; s++) {
      const t = s / 10;
      const pt = {
        x: retChain[i].x + (retChain[i + 1].x - retChain[i].x) * t,
        y: retChain[i].y + (retChain[i + 1].y - retChain[i].y) * t,
      };
      assert.equal(
        pointInPolygonTest(pt, spikyBodyVerts),
        true,
        `spiky_220 fallback return point (${pt.x.toFixed(2)}, ${pt.y.toFixed(2)}) escaped body polygon`
      );
    }
  }
});

test('standard & randomized adversarial stress: zero oval/rect self-intersections, thought 2*bw clearance, spiky fallback containment', () => {
  // 1. oval & rect 2160 cases each (standard 200x120)
  for (const shape of ['oval', 'rect'] as const) {
    for (let deg = 0; deg < 360; deg += 15) {
      for (const tc of [-1, -0.5, 0, 0.5, 1]) {
        for (const dist of [12, 24, 50, 100, 150, 200]) {
          for (const offAng of [-0.5, 0, 0.5]) {
            const perim = evalBalloonPerimeterPoint({ shape, width: 200, height: 120, cornerRadius: 12 }, deg);
            const cos = Math.cos(offAng);
            const sin = Math.sin(offAng);
            const dx = perim.normal.x * cos - perim.normal.y * sin;
            const dy = perim.normal.x * sin + perim.normal.y * cos;
            const tip = { x: perim.point.x + dx * dist, y: perim.point.y + dy * dist };
            const geom = buildBalloonGeometry(
              makeBalloon({
                id: `std_${shape}`,
                x: 0,
                y: 0,
                width: 200,
                height: 120,
                shape,
                cornerRadius: 12,
                tailBaseAngle: deg,
                tailPos: tip,
                tailWidth: 28,
                tailCurve: tc,
                borderWidth: 4,
              })
            );
            if (geom.tailCommands.length > 0) {
              assert.equal(
                hasSelfIntersectionTest(geom.tailCommands, 64),
                false,
                `${shape} tail self-intersects at deg=${deg}, tc=${tc}, dist=${dist}, offAng=${offAng}`
              );
            }
          }
        }
      }
    }
  }

  // 2. thought 900 cases per borderWidth (bw = 4, 8, 10)
  for (const bw of [4, 8, 10]) {
    for (let deg = 0; deg < 360; deg += 10) {
      for (const tc of [-1, -0.5, 0, 0.5, 1]) {
        for (const dist of [15, 25, 35, 50, 80]) {
          const perim = evalBalloonPerimeterPoint({ shape: 'thought', width: 200, height: 140, id: 'thought_bw' }, deg);
          const tip = { x: perim.point.x + perim.normal.x * dist, y: perim.point.y + perim.normal.y * dist };
          const geom = buildBalloonGeometry(
            makeBalloon({
              id: 'thought_bw',
              x: 0,
              y: 0,
              width: 200,
              height: 140,
              shape: 'thought',
              tailBaseAngle: deg,
              tailPos: tip,
              tailWidth: 28,
              tailCurve: tc,
              borderWidth: bw,
            })
          );
          const cloudVerts = flattenPathForTest(geom.bodyCommands, 24);
          const circles = geom.dotCommands.map(extractCircleMetrics);
          for (let i = 0; i < circles.length; i++) {
            const c = circles[i];
            assert.equal(pointInPolygonTest({ x: c.cx, y: c.cy }, cloudVerts), false);
            const dCloud = distToPolygonTest({ x: c.cx, y: c.cy }, cloudVerts);
            assert.ok(
              dCloud >= c.r + bw * 2 - 0.15,
              `thought dot/cloud border overlap bw=${bw} deg=${deg} tc=${tc} dist=${dist}: ${dCloud} < ${c.r + bw * 2}`
            );
            for (let j = i + 1; j < circles.length; j++) {
              const d = Math.hypot(c.cx - circles[j].cx, c.cy - circles[j].cy);
              assert.ok(d >= c.r + circles[j].r + bw * 2 - 0.15);
            }
          }
        }
      }
    }
  }

  // 3. spiky oblique sweep (576 cases)
  for (let deg = 0; deg < 360; deg += 5) {
    for (const tc of [-1, 1]) {
      for (const offAng of [-0.8, -0.5, 0.5, 0.8]) {
        const perim = evalBalloonPerimeterPoint({ shape: 'spiky', width: 220, height: 140, id: 'spiky_obq' }, deg);
        const cos = Math.cos(offAng);
        const sin = Math.sin(offAng);
        const dx = perim.normal.x * cos - perim.normal.y * sin;
        const dy = perim.normal.x * sin + perim.normal.y * cos;
        const tip = { x: perim.point.x + dx * 35, y: perim.point.y + dy * 35 };
        const geom = buildBalloonGeometry(
          makeBalloon({
            id: 'spiky_obq',
            x: 0,
            y: 0,
            width: 220,
            height: 140,
            shape: 'spiky',
            tailBaseAngle: deg,
            tailPos: tip,
            tailWidth: 28,
            tailCurve: tc,
            borderWidth: 4,
          })
        );
        assert.equal(hasSelfIntersectionTest(geom.bodyCommands, 64), false);
        if (!geom.isTailSpliced && geom.tailCommands.length > 0) {
          assert.equal(hasSelfIntersectionTest(geom.tailCommands, 64), false);
          const bodyVerts = flattenPathForTest(geom.bodyCommands, 16);
          const qEndIdx = geom.tailCommands.findIndex((c, idx) => idx > 0 && c.type === 'Q' && geom.tailCommands[idx + 1]?.type !== 'Q');
          const mCmd = geom.tailCommands[0] as Extract<PathCommand, { type: 'M' }>;
          const q2Cmd = geom.tailCommands[qEndIdx] as Extract<PathCommand, { type: 'Q' }>;
          const retChain: Array<{ x: number; y: number }> = [{ x: q2Cmd.x, y: q2Cmd.y }];
          for (let i = qEndIdx + 1; i < geom.tailCommands.length; i++) {
            const cmd = geom.tailCommands[i];
            if (cmd.type === 'L') retChain.push({ x: cmd.x, y: cmd.y });
          }
          retChain.push({ x: mCmd.x, y: mCmd.y });
          for (let i = 0; i < retChain.length - 1; i++) {
            for (let s = 1; s < 10; s++) {
              const t = s / 10;
              const pt = {
                x: retChain[i].x + (retChain[i + 1].x - retChain[i].x) * t,
                y: retChain[i].y + (retChain[i + 1].y - retChain[i].y) * t,
              };
              assert.equal(
                pointInPolygonTest(pt, bodyVerts),
                true,
                `spiky fallback return escaped body at deg=${deg}, tc=${tc}, offAng=${offAng}`
              );
            }
          }
        }
      }
    }
  }
});

test('randomized extreme aspect/origin/width/curve stress (2000 cases) preserves all geometric invariants', () => {
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
  const shapes: Array<ComicBalloonItem['shape']> = ['oval', 'rect', 'spiky', 'thought'];
  const dims: Array<[number, number]> = [
    [20, 20],
    [500, 30],
    [30, 500],
    [200, 120],
    [220, 140],
    [1200, 900],
  ];
  const origins: Array<[number, number]> = [
    [0, 0],
    [-350, -240],
    [-1200, -900],
    [400, 300],
  ];

  for (let k = 0; k < 2000; k++) {
    const shape = shapes[k % 4];
    const [w, h] = rnd() < 0.5 ? pick(dims) : [20 + rnd() * 1180, 20 + rnd() * 880];
    const [x, y] = pick(origins);
    const bw = pick([0, 1, 4, 8, 10, 20]);
    const deg = rnd() * 360;
    const offAng = (rnd() - 0.5) * 2.4;
    const dist = 5 + rnd() * 300;
    const cornerRadius = pick([0, 12, 999]);
    const perim = evalBalloonPerimeterPoint({ shape, width: w, height: h, cornerRadius, id: `rand_${k}` }, deg);
    const cos = Math.cos(offAng);
    const sin = Math.sin(offAng);
    const dx = perim.normal.x * cos - perim.normal.y * sin;
    const dy = perim.normal.x * sin + perim.normal.y * cos;
    const balloon = makeBalloon({
      id: `rand_${k}`,
      x,
      y,
      width: w,
      height: h,
      shape,
      cornerRadius,
      tailBaseAngle: rnd() < 0.2 ? undefined : deg,
      tailPos: { x: perim.point.x + dx * dist, y: perim.point.y + dy * dist },
      tailWidth: 1 + rnd() * 199,
      tailCurve: -2 + rnd() * 4,
      borderWidth: bw,
    });
    const geom = buildBalloonGeometry(balloon);
    buildBalloonRenderPlan(balloon);

    if ((shape === 'oval' || shape === 'rect') && geom.tailCommands.length > 0) {
      assert.equal(hasSelfIntersectionTest(geom.tailCommands, 64), false, `${shape} random k=${k} tail self-intersects`);
    }
    if (shape === 'spiky') {
      assert.equal(hasSelfIntersectionTest(geom.bodyCommands, 64), false, `spiky random k=${k} body self-intersects`);
      if (!geom.isTailSpliced && geom.tailCommands.length > 0) {
        assert.equal(hasSelfIntersectionTest(geom.tailCommands, 64), false, `spiky random k=${k} fallback tail self-intersects`);
        const bodyVerts = flattenPathForTest(geom.bodyCommands, 16);
        const qEndIdx = geom.tailCommands.findIndex((c, idx) => idx > 0 && c.type === 'Q' && geom.tailCommands[idx + 1]?.type !== 'Q');
        const mCmd = geom.tailCommands[0] as Extract<PathCommand, { type: 'M' }>;
        const q2Cmd = geom.tailCommands[qEndIdx] as Extract<PathCommand, { type: 'Q' }>;
        const retChain: Array<{ x: number; y: number }> = [{ x: q2Cmd.x, y: q2Cmd.y }];
        for (let i = qEndIdx + 1; i < geom.tailCommands.length; i++) {
          const cmd = geom.tailCommands[i];
          if (cmd.type === 'L') retChain.push({ x: cmd.x, y: cmd.y });
        }
        retChain.push({ x: mCmd.x, y: mCmd.y });
        for (let i = 0; i < retChain.length - 1; i++) {
          for (let s = 1; s < 10; s++) {
            const t = s / 10;
            assert.equal(
              pointInPolygonTest(
                { x: retChain[i].x + (retChain[i + 1].x - retChain[i].x) * t, y: retChain[i].y + (retChain[i + 1].y - retChain[i].y) * t },
                bodyVerts
              ),
              true,
              `spiky random k=${k} fallback return escaped body`
            );
          }
        }
      }
    }
    if (shape === 'thought' && geom.dotCommands.length > 0) {
      const cloudVerts = flattenPathForTest(geom.bodyCommands, 32);
      const circles = geom.dotCommands.map(extractCircleMetrics);
      for (let i = 0; i < circles.length; i++) {
        const c = circles[i];
        assert.equal(pointInPolygonTest({ x: c.cx, y: c.cy }, cloudVerts), false, `thought random k=${k} dot inside cloud`);
        const dCloud = distToPolygonTest({ x: c.cx, y: c.cy }, cloudVerts);
        assert.ok(dCloud >= c.r + bw * 2 - 0.1, `thought random k=${k} dot overlaps cloud stroke`);
        for (let j = i + 1; j < circles.length; j++) {
          assert.ok(Math.hypot(c.cx - circles[j].cx, c.cy - circles[j].cy) >= c.r + circles[j].r + bw * 2 - 0.1);
        }
      }
    }
    for (const cmds of [geom.bodyCommands, ...(geom.tailCommands.length ? [geom.tailCommands] : []), ...geom.dotCommands]) {
      for (const pt of flattenPathForTest(cmds, 32)) {
        assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y));
        assert.ok(pt.x >= geom.bounds.x - 1e-6 && pt.x <= geom.bounds.x + geom.bounds.width + 1e-6);
        assert.ok(pt.y >= geom.bounds.y - 1e-6 && pt.y <= geom.bounds.y + geom.bounds.height + 1e-6);
      }
    }
  }
});
