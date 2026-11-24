import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  downsampleRgbaPremul4x4,
  MIP_KERNEL_DEEP,
  MIP_KERNEL_L1,
  mipKernelForLevel,
  MipmapView,
} from '../src/engine/MipmapView.ts';
import { ATLAS_MIP_LEVELS, PITCH } from '../src/engine/TileAtlas.ts';
import { LayerManager } from '../src/engine/LayerManager.ts';
import { BRUSH_TOOL_DEFAULTS, loadBrushTool } from '../src/engine/brushToolSettings.ts';
import { generatePencilTipPixels } from '../src/engine/BrushRenderer.ts';
import { FLOATS_PER_DAB, StrokeWorkerEngine } from '../src/workers/stroke.worker.ts';

function makeSolidRgba(w: number, h: number, r: number, g: number, b: number, a: number): Uint8Array {
  const buf = new Uint8Array(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  }
  return buf;
}

test('A1 mipmap 4x4 kernel preserves DC, suppresses Nyquist moire, sharpens 1px lines, and respects premul & slot isolation', () => {
  // 1. Flat grey / semi-transparent DC conservation
  const flat = makeSolidRgba(32, 32, 120, 90, 60, 180);
  const flatDown = downsampleRgbaPremul4x4(flat, 32, 32, 16, 16, MIP_KERNEL_L1);
  for (let i = 0; i < flatDown.length; i += 4) {
    assert.ok(Math.abs(flatDown[i] - 120) <= 1);
    assert.ok(Math.abs(flatDown[i + 1] - 90) <= 1);
    assert.ok(Math.abs(flatDown[i + 2] - 60) <= 1);
    assert.ok(Math.abs(flatDown[i + 3] - 180) <= 1);
  }

  // 2. Nyquist checkerboard (1px alternating black/transparent) produces uniform mid-tone without moire oscillation
  const checker = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const idx = (y * 32 + x) * 4;
      const on = (x + y) % 2 === 0;
      checker[idx] = 0;
      checker[idx + 1] = 0;
      checker[idx + 2] = 0;
      checker[idx + 3] = on ? 255 : 0;
    }
  }
  const checkerDown = downsampleRgbaPremul4x4(checker, 32, 32, 16, 16, MIP_KERNEL_L1);
  const interiorAlphas: number[] = [];
  for (let y = 2; y < 14; y++) {
    for (let x = 2; x < 14; x++) {
      interiorAlphas.push(checkerDown[(y * 16 + x) * 4 + 3]);
    }
  }
  const checkerMean = interiorAlphas.reduce((s, v) => s + v, 0) / interiorAlphas.length;
  const checkerStd = Math.sqrt(
    interiorAlphas.reduce((s, v) => s + (v - checkerMean) ** 2, 0) / interiorAlphas.length
  );
  assert.ok(checkerStd <= 2, `Nyquist checkerboard std should be <= 2, got ${checkerStd.toFixed(2)}`);

  // 3. 1px solid black line at L1 retains higher peak alpha (>= 148) than 2x2 box (128)
  const lineSrc = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++) {
    const idx = (y * 32 + 16) * 4; // 1px vertical black line
    lineSrc[idx + 3] = 255;
  }
  const lineDown = downsampleRgbaPremul4x4(lineSrc, 32, 32, 16, 16, mipKernelForLevel(1));
  let peakLineAlpha = 0;
  for (let x = 0; x < 16; x++) {
    peakLineAlpha = Math.max(peakLineAlpha, lineDown[(8 * 16 + x) * 4 + 3]);
  }
  assert.ok(peakLineAlpha >= 148, `1px line L1 peak alpha expected >= 148, got ${peakLineAlpha}`);

  // 4. Premultiplied alpha invariant (rgb <= a) on high-contrast white edge against transparent
  const edgeSrc = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++) {
    for (let x = 14; x < 18; x++) {
      const idx = (y * 32 + x) * 4;
      edgeSrc[idx] = 255;
      edgeSrc[idx + 1] = 255;
      edgeSrc[idx + 2] = 255;
      edgeSrc[idx + 3] = 255;
    }
  }
  const edgeDown = downsampleRgbaPremul4x4(edgeSrc, 32, 32, 16, 16, MIP_KERNEL_L1);
  for (let i = 0; i < edgeDown.length; i += 4) {
    const a = edgeDown[i + 3];
    assert.ok(edgeDown[i] <= a && edgeDown[i + 1] <= a && edgeDown[i + 2] <= a);
  }

  // 5. TileAtlas slot isolation: neighbor slot solid red, target slot transparent -> 0 bleed across 3 mip levels
  assert.equal(PITCH, 264);
  const w0 = PITCH * 2;
  const h0 = PITCH;
  const atlasBuf = new Uint8Array(w0 * h0 * 4);
  for (let y = 0; y < h0; y++) {
    for (let x = 0; x < PITCH; x++) {
      const idx = (y * w0 + x) * 4;
      atlasBuf[idx] = 255;
      atlasBuf[idx + 1] = 0;
      atlasBuf[idx + 2] = 0;
      atlasBuf[idx + 3] = 255;
    }
  }
  let cur = atlasBuf;
  let curW = w0;
  let curH = h0;
  for (let level = 1; level < ATLAS_MIP_LEVELS; level++) {
    const nextW = curW >> 1;
    const nextH = curH >> 1;
    const levelPitch = PITCH >> (level - 1);
    cur = downsampleRgbaPremul4x4(cur, curW, curH, nextW, nextH, mipKernelForLevel(level), levelPitch);
    curW = nextW;
    curH = nextH;
    const slotMid = curW >> 1;
    for (let y = 0; y < curH; y++) {
      for (let x = slotMid; x < curW; x++) {
        const idx = (y * curW + x) * 4;
        assert.equal(cur[idx], 0, `red bleed into transparent slot at level=${level} (${x},${y})`);
        assert.equal(cur[idx + 3], 0, `alpha bleed into transparent slot at level=${level} (${x},${y})`);
      }
    }
  }
  assert.deepEqual(mipKernelForLevel(2), MIP_KERNEL_DEEP);
});

test('A1 MipmapView & LayerManager WebGL2 contract configures sharp resampler, slotPitch, suspend, and cleanup', () => {
  const texParams = new Map<number, number>();
  const uniformCalls: Array<{ name: string; vals: number[] }> = [];
  let drawCalls = 0;
  let generateMipmapCalls = 0;
  let resetStateCalls = 0;
  let deletedProgram = 0;
  let deletedVao = 0;
  let deletedFbo = 0;

  const mockProgram = { id: 'prog' };
  const mockVao = { id: 'vao' };
  const mockFbo = { id: 'fbo' };
  const uniformLocs = new Map<object, string>();
  const mockGl = {
    TEXTURE_2D: 0x0de1,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE0: 0x84c0,
    TEXTURE_BASE_LEVEL: 0x813c,
    TEXTURE_MAX_LEVEL: 0x813d,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    NEAREST: 0x2600,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    LINEAR: 0x2601,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    FRAMEBUFFER: 0x8d40,
    FRAMEBUFFER_BINDING: 0x8ca6,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    VIEWPORT: 0x0ba2,
    COLOR_WRITEMASK: 0x0c23,
    SCISSOR_TEST: 0x0c11,
    BLEND: 0x0be2,
    DEPTH_TEST: 0x0b71,
    STENCIL_TEST: 0x0b90,
    CULL_FACE: 0x0b44,
    TRIANGLES: 0x0004,
    activeTexture: () => {},
    texImage2D: () => {},
    texParameteri: (_target: number, pname: number, param: number) => { texParams.set(pname, param); },
    getTexParameter: (_target: number, pname: number) => texParams.get(pname) ?? 0x2601,
    generateMipmap: () => { generateMipmapCalls++; },
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    deleteShader: () => {},
    createProgram: () => mockProgram,
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    deleteProgram: () => { deletedProgram++; },
    createVertexArray: () => mockVao,
    deleteVertexArray: () => { deletedVao++; },
    bindVertexArray: () => {},
    createFramebuffer: () => mockFbo,
    deleteFramebuffer: () => { deletedFbo++; },
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => 0x8cd5,
    getParameter: (pname: number) => {
      if (pname === 0x0ba2) return [0, 0, 800, 600];
      if (pname === 0x0c23) return [true, true, true, true];
      return null;
    },
    isEnabled: () => false,
    enable: () => {},
    disable: () => {},
    colorMask: () => {},
    useProgram: () => {},
    getUniformLocation: (_prog: unknown, name: string) => {
      const loc = { name };
      uniformLocs.set(loc, name);
      return loc;
    },
    uniform1i: (loc: object, v: number) => uniformCalls.push({ name: uniformLocs.get(loc) || '', vals: [v] }),
    uniform2i: (loc: object, x: number, y: number) => uniformCalls.push({ name: uniformLocs.get(loc) || '', vals: [x, y] }),
    uniform4f: (loc: object, a: number, b: number, c: number, d: number) => uniformCalls.push({ name: uniformLocs.get(loc) || '', vals: [a, b, c, d] }),
    viewport: () => {},
    drawArrays: () => { drawCalls++; },
  };

  const mockRenderer = {
    gl: mockGl,
    context: { webGLVersion: 2 },
    renderTarget: { bind: () => {} },
    render: () => {},
    resetState: () => { resetStateCalls++; },
    texture: {
      bindSource: () => {},
      getGlSource: () => ({
        target: 0x0de1,
        internalFormat: 0x8058,
        format: 0x1908,
        type: 0x1401,
        texture: { id: 'gltex' },
      }),
    },
  };

  const mips = new MipmapView(mockRenderer as never);
  assert.equal(mips.supported, true);

  const source = {
    destroyed: false,
    pixelWidth: PITCH * 8,
    pixelHeight: PITCH * 8,
    mipLevelCount: 1,
    style: { update: () => {} },
    once: () => {},
    off: () => {},
  };

  mips.ensure(source as never, ATLAS_MIP_LEVELS, PITCH);
  assert.equal(generateMipmapCalls, 0, 'custom WebGL2 resampler should run instead of gl.generateMipmap');
  assert.equal(drawCalls, ATLAS_MIP_LEVELS - 1);
  assert.equal(resetStateCalls, 1);
  assert.equal(texParams.get(mockGl.TEXTURE_BASE_LEVEL), 0);
  assert.equal(texParams.get(mockGl.TEXTURE_MAX_LEVEL), ATLAS_MIP_LEVELS - 1);
  const slotPitchUniforms = uniformCalls.filter((c) => c.name === 'uSlotPitch').map((c) => c.vals[0]);
  assert.deepEqual(slotPitchUniforms, [264, 132, 66]);

  // LayerManager.prepareView & setPixelated contract
  let suspended = false;
  let released = false;
  const ensuredCalls: Array<{ levels: number; slotPitch?: number }> = [];
  let atlasMagFilter = 'linear';
  const fakeLayerManager = {
    mips: {
      supported: true,
      suspend: () => { suspended = true; },
      releaseIdle: () => { released = true; },
      ensure: (_src: unknown, levels: number, slotPitch?: number) => { ensuredCalls.push({ levels, slotPitch }); },
    },
    atlas: {
      setMagFilter: (mode: string) => { atlasMagFilter = mode; },
      pageTextures: () => [{ source }],
    },
    layersMap: new Map(),
    preview: { rt: null, sprite: { parent: null }, display: { visible: false }, shown: false },
    magFilter: 'linear',
    solo: false,
    visiblePages: new Set<number>(),
    ensureResidentMips: () => {},
    onStageChange: () => {},
  };

  LayerManager.prototype.prepareView.call(fakeLayerManager, 0.5);
  LayerManager.prototype.prepareView.call(fakeLayerManager, 0.84);
  assert.equal(ensuredCalls.length, 2);
  assert.deepEqual(ensuredCalls[0], { levels: ATLAS_MIP_LEVELS, slotPitch: PITCH });

  LayerManager.prototype.prepareView.call(fakeLayerManager, 0.85);
  assert.equal(suspended, true);
  assert.equal(released, true);

  LayerManager.prototype.setPixelated.call(fakeLayerManager, true);
  assert.equal(atlasMagFilter, 'nearest');
  suspended = false;
  LayerManager.prototype.prepareView.call(fakeLayerManager, 1.0);
  assert.equal(suspended, true);

  mips.destroy();
  assert.equal(deletedProgram, 1);
  assert.equal(deletedVao, 1);
  assert.equal(deletedFbo, 1);
});

test('A3 brushToolSettings defaults and v2->v3 pencil.flow migration', () => {
  assert.equal(BRUSH_TOOL_DEFAULTS.pencil.flow, 1);
  assert.equal(BRUSH_TOOL_DEFAULTS.pencil.brushType, 'pencil');

  const store = new Map<string, string>();
  const prevStorage = (globalThis as { localStorage?: Storage }).localStorage;
  (globalThis as { localStorage: Storage }).localStorage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => { store.delete(k); },
    setItem: (k: string, v: string) => { store.set(k, v); },
  };
  try {
    store.set('atelier_brush_tools', JSON.stringify({
      brushDefaultsVersion: 2,
      pencil: { flow: 0.85, size: 12 },
    }));
    const migrated = loadBrushTool('pencil');
    assert.equal(migrated.flow, 1);
    assert.equal(migrated.size, 12);

    store.set('atelier_brush_tools', JSON.stringify({
      brushDefaultsVersion: 2,
      pencil: { flow: 0.42 },
    }));
    const preserved = loadBrushTool('pencil');
    assert.equal(preserved.flow, 0.42);
  } finally {
    if (prevStorage === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      (globalThis as { localStorage: Storage }).localStorage = prevStorage;
    }
  }
});

test('A3 generatePencilTipPixels produces coherent paper grain contrast and full-saturation peaks', () => {
  for (const bucket of [16, 24, 48]) {
    const tip = generatePencilTipPixels(0.85, 'medium', bucket);
    const center = tip.texSize / 2;
    const innerR = Math.max(0, tip.bucket * 0.5 - Math.max(0.5, tip.bucket * 0.5 * 0.15 * 0.85));
    const alphas: number[] = [];
    for (let y = 0; y < tip.texSize; y++) {
      for (let x = 0; x < tip.texSize; x++) {
        if (Math.hypot(x + 0.5 - center, y + 0.5 - center) <= innerR) {
          alphas.push(tip.data[(y * tip.texSize + x) * 4 + 3]);
        }
      }
    }
    const sorted = [...alphas].sort((a, b) => a - b);
    const mean = alphas.reduce((s, v) => s + v, 0) / alphas.length / 255;
    const std = Math.sqrt(alphas.reduce((s, v) => s + (v / 255 - mean) ** 2, 0) / alphas.length);
    const p10 = sorted[Math.floor(sorted.length * 0.1)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const maxByte = sorted[sorted.length - 1];

    assert.ok(mean >= 0.50 && mean <= 0.72, `bucket=${bucket} meanAlpha=${mean.toFixed(3)} out of [0.50, 0.72]`);
    assert.ok(std >= 0.28, `bucket=${bucket} stdAlpha=${std.toFixed(3)} < 0.28`);
    assert.equal(maxByte, 255, `bucket=${bucket} peak should reach 255`);
    assert.ok(p90 >= 245, `bucket=${bucket} top 10% expected >= 245, got ${p90}`);
    assert.ok(p10 <= 40, `bucket=${bucket} bottom 10% expected <= 40, got ${p10}`);
  }
});

/** 8-bit rgba8unorm software compositor matching BrushRenderer's bilinear sampling and per-dab rotation */
function compositePencilDabs8Bit(
  canvasW: number,
  canvasH: number,
  dabs: Float32Array,
  hardness = 0.85,
  passes = 1,
): Uint8Array {
  const buf = new Uint8Array(canvasW * canvasH);
  const tipCache = new Map<number, ReturnType<typeof generatePencilTipPixels>>();
  const getTip = (diameter: number) => {
    const key = Math.max(16, Math.ceil(diameter));
    let tip = tipCache.get(key);
    if (!tip) {
      tip = generatePencilTipPixels(hardness, 'medium', diameter);
      tipCache.set(key, tip);
    }
    return tip;
  };

  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < dabs.length; i += FLOATS_PER_DAB) {
      const cx = dabs[i];
      const cy = dabs[i + 1];
      const size = dabs[i + 2];
      const dabAlpha = dabs[i + 4];
      const baseRot = dabs[i + 5];
      if (size <= 0 || dabAlpha <= 0) continue;

      const tip = getTip(size);
      const rot = baseRot + Math.sin(cx * 12.9898 + cy * 78.233) * Math.PI;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const dispW = size * tip.scaleRatio;
      const half = dispW * 0.5;
      const rBound = Math.ceil(half * 1.45);
      const minX = Math.max(0, Math.floor(cx - rBound));
      const maxX = Math.min(canvasW - 1, Math.ceil(cx + rBound));
      const minY = Math.max(0, Math.floor(cy - rBound));
      const maxY = Math.min(canvasH - 1, Math.ceil(cy + rBound));

      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const dx = px + 0.5 - cx;
          const dy = py + 0.5 - cy;
          const lx = dx * cos + dy * sin;
          const ly = -dx * sin + dy * cos;
          const u = (lx / dispW + 0.5) * tip.texSize - 0.5;
          const v = (ly / dispW + 0.5) * tip.texSize - 0.5;
          if (u < -0.5 || v < -0.5 || u > tip.texSize - 0.5 || v > tip.texSize - 0.5) continue;

          const x0 = Math.max(0, Math.min(tip.texSize - 1, Math.floor(u)));
          const y0 = Math.max(0, Math.min(tip.texSize - 1, Math.floor(v)));
          const x1 = Math.min(tip.texSize - 1, x0 + 1);
          const y1 = Math.min(tip.texSize - 1, y0 + 1);
          const fx = Math.max(0, Math.min(1, u - x0));
          const fy = Math.max(0, Math.min(1, v - y0));

          const a00 = tip.data[(y0 * tip.texSize + x0) * 4 + 3] / 255;
          const a10 = tip.data[(y0 * tip.texSize + x1) * 4 + 3] / 255;
          const a01 = tip.data[(y1 * tip.texSize + x0) * 4 + 3] / 255;
          const a11 = tip.data[(y1 * tip.texSize + x1) * 4 + 3] / 255;
          const tipA = (a00 * (1 - fx) + a10 * fx) * (1 - fy) + (a01 * (1 - fx) + a11 * fx) * fy;
          const srcA = tipA * dabAlpha;
          if (srcA <= 0) continue;

          const idx = py * canvasW + px;
          const dstA = buf[idx] / 255;
          buf[idx] = Math.min(255, Math.round((srcA + dstA * (1 - srcA)) * 255));
        }
      }
    }
  }
  return buf;
}

function runHorizontalPencil(size: number, pressure: number, opacity = 1, flow = 1): Float32Array {
  const engine = new StrokeWorkerEngine();
  const cfg = {
    size,
    minSize: 0,
    hardness: 0.85,
    flow,
    spacing: 0.02,
    isEraser: false,
    opacity,
    stabilizerLevel: 0,
    followSamples: true,
    scatter: 0,
    pressureCurve: 'linear' as const,
    brushType: 'pencil' as const,
    colorMixing: 0,
    antiAlias: 'medium' as const,
  };
  const chunks: number[] = [];
  const push = (arr: Float32Array) => { for (let i = 0; i < arr.length; i++) chunks.push(arr[i]); };
  push(engine.initStroke(cfg, { x: 20, y: 24, pressure, time: 0 }));
  for (let x = 30; x <= 140; x += 10) {
    push(engine.addRawPoints([{ x, y: 24, pressure, time: x }]));
  }
  push(engine.finishStroke({ x: 140, y: 24, pressure, time: 150 }));
  return new Float32Array(chunks);
}

function centerlineStats(buf: Uint8Array, canvasW: number, y = 24, xStart = 35, xEnd = 125) {
  const vals: number[] = [];
  for (let x = xStart; x <= xEnd; x++) vals.push(buf[y * canvasW + x]);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  return { mean, std, min, max };
}

test('A3 8-bit pencil compositing shows clear grain on light pressure, deep black on heavy pressure, and honors opacity cap', () => {
  const W = 160;
  const H = 48;

  // Light pressure: clear paper tooth grain, neither invisible nor flat solid
  for (const [size, p] of [[8, 0.25], [8, 0.35], [20, 0.25]] as const) {
    const dabs = runHorizontalPencil(size, p);
    const buf = compositePencilDabs8Bit(W, H, dabs);
    const st = centerlineStats(buf, W);
    assert.ok(st.mean >= 45 && st.mean <= 130, `light size=${size} p=${p} mean=${st.mean.toFixed(1)} out of [45, 130]`);
    assert.ok(st.std >= 8, `light size=${size} p=${p} std=${st.std.toFixed(1)} < 8`);
    assert.ok(st.max - st.min >= 35, `light size=${size} p=${p} range=${st.max - st.min} < 35`);
  }

  // Heavy pressure: solid dark black
  for (const size of [8, 20]) {
    const dabs100 = runHorizontalPencil(size, 1.0);
    const st100 = centerlineStats(compositePencilDabs8Bit(W, H, dabs100, 0.85, 1), W);
    assert.ok(st100.mean >= 242, `heavy p=1.0 size=${size} mean=${st100.mean.toFixed(1)} < 242`);

    const dabs85 = runHorizontalPencil(size, 0.85);
    const st85Single = centerlineStats(compositePencilDabs8Bit(W, H, dabs85, 0.85, 1), W);
    const st85Double = centerlineStats(compositePencilDabs8Bit(W, H, dabs85, 0.85, 2), W);
    assert.ok(st85Single.mean >= 210, `heavy p=0.85 1-pass size=${size} mean=${st85Single.mean.toFixed(1)} < 210`);
    assert.ok(st85Double.mean >= 245, `heavy p=0.85 2-pass size=${size} mean=${st85Double.mean.toFixed(1)} < 245`);
  }

  // Opacity slider cap must be strictly obeyed
  const dabsCap = runHorizontalPencil(8, 1.0, 0.30, 1.0);
  const stCap = centerlineStats(compositePencilDabs8Bit(W, H, dabsCap), W);
  assert.ok(stCap.mean <= 95, `opacity=0.30 cap exceeded: mean=${stCap.mean.toFixed(1)}`);
});

test('A3 leaves pen, brush, and airbrush dab size/alpha completely unchanged', () => {
  const sampleSingleDab = (cfg: Parameters<StrokeWorkerEngine['initStroke']>[0], pressure: number) => {
    const engine = new StrokeWorkerEngine();
    const dabs = engine.initStroke(cfg, { x: 10, y: 10, pressure, time: 0 });
    return { size: dabs[2], alpha: dabs[4] };
  };

  // 1. pen (preset_csp_gpen)
  const pen = sampleSingleDab({
    size: 14, minSize: 0, hardness: 1, flow: 1, spacing: 0.02,
    isEraser: false, opacity: 1, stabilizerLevel: 4, followSamples: true,
    scatter: 0, pressureCurve: 'linear', brushType: 'pen', colorMixing: 0, antiAlias: 'medium',
  }, 0.5);
  assert.ok(Math.abs(pen.size - 7.0) < 1e-6);
  assert.ok(Math.abs(pen.alpha - (0.78 + 0.22 * Math.sqrt(0.5))) < 1e-6);

  // 2. brush (standard soft-ish brush)
  const brush = sampleSingleDab({
    size: 20, minSize: 0, hardness: 0.8, flow: 0.7, spacing: 0.05,
    isEraser: false, opacity: 0.9, stabilizerLevel: 3, followSamples: true,
    scatter: 0, pressureCurve: 'linear', brushType: 'brush', colorMixing: 0, antiAlias: 'medium',
  }, 0.6);
  const expectedBrushPass = 0.7 * 0.9 * Math.pow(0.6, 1.35);
  const expectedBrushOverlap = Math.max(1.2, 0.55 / 0.05);
  const expectedBrushAlpha = 1 - Math.pow(1 - expectedBrushPass, 1 / expectedBrushOverlap);
  assert.ok(Math.abs(brush.size - 12.0) < 1e-6);
  assert.ok(Math.abs(brush.alpha - expectedBrushAlpha) < 1e-6);

  // 3. airbrush
  const air = sampleSingleDab({
    size: 40, minSize: 0, hardness: 0.1, flow: 0.6, spacing: 0.04,
    isEraser: false, opacity: 0.8, stabilizerLevel: 2, followSamples: true,
    scatter: 0, pressureCurve: 'linear', brushType: 'airbrush', colorMixing: 0, antiAlias: 'medium',
  }, 0.5);
  const expectedAirSize = 40 * (0.72 + 0.28 * 0.5);
  const expectedAirStep = Math.max(0.25, expectedAirSize * Math.min(0.08, 0.04));
  const expectedAirOverlap = Math.max(1, 0.63 * expectedAirSize / expectedAirStep);
  const expectedAirPass = 0.6 * 0.8 * Math.pow(0.5, 1.4);
  const expectedAirAlpha = 1 - Math.pow(1 - expectedAirPass, 1 / expectedAirOverlap);
  assert.ok(Math.abs(air.size - Math.fround(expectedAirSize)) < 1e-6);
  assert.ok(Math.abs(air.alpha - Math.fround(expectedAirAlpha)) < 1e-6);
});
