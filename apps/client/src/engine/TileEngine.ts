import {
  BufferImageSource,
  CanvasSource,
  Container,
  Graphics,
  Rectangle,
  Renderer,
  RenderTexture,
  Sprite,
  Texture,
} from 'pixi.js';
import {
  compressTileBuffer,
  decompressTileBuffer,
  DEFAULT_TILE_SIZE,
  getDirtyTilesForBoundingBox,
  getDirtyTilesForPoints,
  getGridDimensions,
  getTileBounds,
  tileKey,
  TileCompression,
  TileCoord,
  TileData,
} from '@atelier/shared';

/**
 * Normalizes tile data into Uint8Array from various formats (Uint8Array, ArrayBuffer, JSON Buffer, Array, Object)
 */
export function normalizeTileBytes(data: any): Uint8Array {
  if (!data) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data?.buffer instanceof ArrayBuffer) {
    return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.length);
  }
  if (data && data.type === 'Buffer' && Array.isArray(data.data)) {
    return new Uint8Array(data.data);
  }
  if (data && Array.isArray(data.data)) {
    return new Uint8Array(data.data);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(data);
  }
  if (typeof data === 'object') {
    const vals = Object.values(data);
    if (vals.length > 0 && typeof vals[0] === 'number') {
      return new Uint8Array(vals as number[]);
    }
  }
  return new Uint8Array(0);
}

/** Pooled PBO read-back in GPU waves of 24 tiles so large commits never block the compositor */
const PBO_TILE_BYTES = 256 * 256 * 4;
const READ_WAVE_RECTS = 24;
const READ_CHUNK_BYTES = 524288;
const READ_BUDGET_MS = 3;

interface ReadJob {
  gl: WebGL2RenderingContext;
  renderer: any;
  renderTexture: RenderTexture;
  rects: Array<{ x: number; y: number; w: number; h: number }>;
  out: Uint8Array[];
  nextSubmit: number;
  remaining: number;
  resolve: (v: Uint8Array[]) => void;
}

interface ActiveWave {
  gl: WebGL2RenderingContext;
  sync: WebGLSync;
  entries: Array<{ job: ReadJob; idx: number; buf: WebGLBuffer; pooled: boolean }>;
  readCursor: number;
  ready: boolean;
}

export class TileEngine {
  private renderer: Renderer;
  public canvasWidth: number;
  public canvasHeight: number;
  public tileSize: number;

  // Reusable 2D canvas for extracting and encoding tile RGBA
  private scratchCanvas: HTMLCanvasElement;
  private scratchCtx: CanvasRenderingContext2D;
  private pboPool: WebGLBuffer[] = [];
  private readJobs: ReadJob[] = [];
  private activeWaves: ActiveWave[] = [];
  private submitScheduled = false;
  private waveDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimers = new Set<ReturnType<typeof setTimeout>>();
  private destroyed = false;

  constructor(
    renderer: Renderer,
    canvasWidth: number,
    canvasHeight: number,
    tileSize: number = DEFAULT_TILE_SIZE
  ) {
    this.renderer = renderer;
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
    this.tileSize = tileSize;

    this.scratchCanvas = document.createElement('canvas');
    this.scratchCanvas.width = tileSize;
    this.scratchCanvas.height = tileSize;
    this.scratchCtx = this.scratchCanvas.getContext('2d', { willReadFrequently: true })!;
  }

  public updateDimensions(width: number, height: number, tileSize?: number) {
    this.canvasWidth = width;
    this.canvasHeight = height;
    if (tileSize && tileSize > 0) this.tileSize = tileSize;
  }

  /**
   * Identifies all dirty tiles touched by a set of points with radius
   */
  public getDirtyTilesForPoints(
    points: Array<{ x: number; y: number; radius?: number }>,
    defaultRadius: number = 12
  ): TileCoord[] {
    return getDirtyTilesForPoints(
      points,
      defaultRadius,
      this.tileSize,
      this.canvasWidth,
      this.canvasHeight
    );
  }

  /**
   * Identifies dirty tiles in a bounding box
   */
  public getDirtyTilesForBounds(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number
  ): TileCoord[] {
    return getDirtyTilesForBoundingBox(
      minX,
      minY,
      maxX,
      maxY,
      this.tileSize,
      this.canvasWidth,
      this.canvasHeight
    );
  }

  public getAllTileCoords(): TileCoord[] {
    return this.getDirtyTilesForBounds(0, 0, this.canvasWidth, this.canvasHeight);
  }

  /**
   * Reads a sub-rectangle of a layer as premultiplied RGBA (exactly what the GPU stores).
   * Pixi's extract.pixels ignores `frame` for texture targets and returns the whole texture,
   * so a framed view of the same source is read instead. Callers pass integer, in-bounds rects.
   */
  public readRegion(renderTexture: RenderTexture, x: number, y: number, width: number, height: number): Uint8Array {
    const view = new Texture({ source: renderTexture.source, frame: new Rectangle(x, y, width, height) });
    const { pixels } = this.renderer.extract.pixels({ target: view });
    view.destroy(false);
    return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  }

  /**
   * Replaces a sub-rectangle with premultiplied RGBA bytes. No blending: pixels a tool moved
   * away must really disappear instead of showing through from underneath.
   */
  public writeRegion(
    renderTexture: RenderTexture,
    x: number,
    y: number,
    width: number,
    height: number,
    premultiplied: Uint8Array
  ) {
    const source = new BufferImageSource({
      resource: premultiplied,
      width,
      height,
      format: 'rgba8unorm',
      alphaMode: 'premultiplied-alpha',
      scaleMode: 'nearest',
    });
    const texture = new Texture({ source });
    const sprite = new Sprite(texture);
    sprite.position.set(x, y);
    sprite.blendMode = 'none';
    // The sprite must be a child: Pixi ignores blendMode on the root handed to render(), so a
    // root sprite is alpha-blended over the old pixels and transparent ones never replace them
    const holder = new Container();
    holder.addChild(sprite);
    this.renderer.render({ container: holder, target: renderTexture, clear: false });
    texture.destroy(true);
    holder.destroy({ children: true });
  }

  /** Erases a sub-rectangle to fully transparent */
  public clearRegion(renderTexture: RenderTexture, x: number, y: number, width: number, height: number) {
    this.writeRegion(renderTexture, x, y, width, height, new Uint8Array(width * height * 4));
  }

  /** Copies a sub-rectangle into a 2D canvas, un-premultiplied as canvas ImageData expects */
  public regionToCanvas(
    renderTexture: RenderTexture,
    x: number,
    y: number,
    width: number,
    height: number
  ): HTMLCanvasElement {
    const src = this.readRegion(renderTexture, x, y, width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(width, height);
    const dst = img.data; // Uint8ClampedArray rounds and clamps the divisions below
    for (let i = 0; i < src.length; i += 4) {
      const a = src[i + 3];
      if (a === 0) continue;
      const k = 255 / a;
      dst[i] = src[i] * k;
      dst[i + 1] = src[i + 1] * k;
      dst[i + 2] = src[i + 2] * k;
      dst[i + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /** Composites a 2D canvas onto a layer at (x, y) with normal alpha blending */
  public stampCanvas(renderTexture: RenderTexture, canvas: HTMLCanvasElement, x: number, y: number) {
    // Not Texture.from: it caches per canvas, and the destroy below would poison that cache
    const texture = new Texture({ source: new CanvasSource({ resource: canvas }) });
    const sprite = new Sprite(texture);
    sprite.position.set(x, y);
    this.renderer.render({ container: sprite, target: renderTexture, clear: false });
    texture.destroy(true);
  }

  public extractTileData(
    renderTexture: RenderTexture,
    col: number,
    row: number,
    compression: TileCompression = 'lz4'
  ): TileData {
    return this.extractTilesBatch(renderTexture, [{ col, row }], compression)[0];
  }

  /** Packs one tile's premultiplied RGBA */
  private packTile(col: number, row: number, width: number, height: number, rgba: Uint8Array, compression: TileCompression): TileData {
    if (compression === 'lz4') {
      const { data } = compressTileBuffer(rgba, 'lz4');
      return { col, row, width, height, compression: 'lz4', data, byteLength: data.byteLength };
    }
    return { col, row, width, height, compression: 'raw', data: rgba, byteLength: rgba.byteLength };
  }

  /**
   * Tiles of a layer. Reads back only what is needed: per tile row, one strip spanning the wanted
   * columns. (It used to read the whole texture for every call: 305 MB per stroke on a 10000×8000
   * canvas, a freeze of half a second or more after each stroke.)
   */
  public extractTilesBatch(
    renderTexture: RenderTexture,
    coords: TileCoord[],
    compression: TileCompression = 'lz4'
  ): TileData[] {
    if (coords.length === 0) return [];
    const ts = this.tileSize;
    const out = new Map<string, TileData>();
    const byRow = new Map<number, TileCoord[]>();
    for (const c of coords) byRow.set(c.row, [...(byRow.get(c.row) ?? []), c]);

    for (const [row, cs] of byRow) {
      const valid = cs.filter((c) => {
        const b = getTileBounds(c.col, c.row, ts, this.canvasWidth, this.canvasHeight);
        if (b.width > 0 && b.height > 0) return true;
        out.set(`${c.col}_${c.row}`, { col: c.col, row: c.row, width: 0, height: 0, compression: 'raw', data: new Uint8Array(0) });
        return false;
      });
      if (!valid.length) continue;
      const minCol = Math.min(...valid.map((c) => c.col));
      const maxCol = Math.max(...valid.map((c) => c.col));
      const x0 = minCol * ts;
      const y0 = row * ts;
      const x1 = Math.min(this.canvasWidth, (maxCol + 1) * ts);
      const y1 = Math.min(this.canvasHeight, y0 + ts);
      const stripW = x1 - x0;
      const strip = this.readRegion(renderTexture, x0, y0, stripW, y1 - y0);
      for (const c of valid) {
        const b = getTileBounds(c.col, c.row, ts, this.canvasWidth, this.canvasHeight);
        const tileRgba = new Uint8Array(b.width * b.height * 4);
        for (let y = 0; y < b.height; y++) {
          const src = (y * stripW + (b.x - x0)) * 4;
          tileRgba.set(strip.subarray(src, src + b.width * 4), y * b.width * 4);
        }
        out.set(`${c.col}_${c.row}`, this.packTile(c.col, c.row, b.width, b.height, tileRgba, compression));
      }
    }
    return coords.map((c) => out.get(`${c.col}_${c.row}`)!);
  }

  /**
   * Reads rectangles back without stalling the page (WebGL2 pixel-pack buffers + a fence): the copies
   * are queued in order with the drawing, so they hold the pixels as of this call even if the layer
   * is drawn on before they arrive. Each synchronous readRegion waits for the GPU (~1.4 ms on
   * Windows/ANGLE); a long stroke's commit made ~150 of them. WebGL1 falls back to readRegion.
   */
  public readRegionsAsync(renderTexture: RenderTexture, rects: Array<{ x: number; y: number; w: number; h: number }>): Promise<Uint8Array[]> {
    if (this.destroyed || !rects.length || renderTexture.destroyed) {
      return Promise.resolve(rects.map((r) => new Uint8Array(Math.max(0, r.w * r.h * 4))));
    }
    const renderer = this.renderer as any;
    const gl = renderer.gl as WebGL2RenderingContext | undefined;
    if (!gl || typeof gl.fenceSync !== 'function' || !renderer.gc || !renderer.texture?._boundTextures) {
      return Promise.resolve(rects.map((r) => this.readRegion(renderTexture, r.x, r.y, r.w, r.h)));
    }
    return new Promise((resolve) => {
      this.readJobs.push({
        gl,
        renderer,
        renderTexture,
        rects,
        out: new Array<Uint8Array>(rects.length),
        nextSubmit: 0,
        remaining: rects.length,
        resolve,
      });
      if (!this.submitScheduled) {
        this.submitScheduled = true;
        queueMicrotask(() => {
          this.submitScheduled = false;
          if (!this.destroyed) this.tryStartWave();
        });
      }
    });
  }

  /** Submits any remaining unqueued GPU reads before a subsequent tool mutates atlas slots */
  public flushReads() {
    if (!this.destroyed && this.readJobs.length > 0) this.submitWave(Infinity);
  }

  private allocPbo(gl: WebGL2RenderingContext, bytes: number): { buf: WebGLBuffer; pooled: boolean } {
    const canPool = bytes <= PBO_TILE_BYTES;
    if (canPool && this.pboPool.length > 0) {
      return { buf: this.pboPool.pop()!, pooled: true };
    }
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, canPool ? PBO_TILE_BYTES : bytes, gl.STREAM_READ);
    return { buf, pooled: canPool };
  }

  private releasePbo(gl: WebGL2RenderingContext, buf: WebGLBuffer, pooled: boolean) {
    if (pooled && !this.destroyed && this.pboPool.length < 64 && !gl.isContextLost()) {
      this.pboPool.push(buf);
    } else if (!gl.isContextLost()) {
      gl.deleteBuffer(buf);
    }
  }

  private tryStartWave() {
    if (!this.destroyed && this.activeWaves.length === 0 && this.readJobs.length > 0) {
      this.submitWave(READ_WAVE_RECTS);
    }
  }

  private submitWave(maxRects: number) {
    if (this.destroyed || !this.readJobs.length) return;
    const entries: ActiveWave['entries'] = [];
    const gl = this.readJobs[0].gl;
    if (gl.isContextLost()) {
      this.destroy();
      return;
    }
    let boundTex: RenderTexture | null = null;
    while (this.readJobs.length > 0 && entries.length < maxRects) {
      const job = this.readJobs[0];
      // Disarm safely if Pixi tore down the renderer or target while the microtask/wave was queued.
      if (job.renderTexture.destroyed || !job.renderer?.gc || !job.renderer.texture?._boundTextures) {
        job.resolve(job.rects.map((r, i) => job.out[i] ?? new Uint8Array(Math.max(0, r.w * r.h * 4))));
        this.readJobs.shift();
        continue;
      }
      if (job.renderTexture !== boundTex) {
        const glTarget = job.renderer.renderTarget.getGpuRenderTarget(job.renderer.renderTarget.getRenderTarget(job.renderTexture));
        job.renderer.renderTarget.adaptor.bindFramebuffer(glTarget.resolveTargetFramebuffer);
        boundTex = job.renderTexture;
      }
      while (job.nextSubmit < job.rects.length && entries.length < maxRects) {
        const idx = job.nextSubmit++;
        const r = job.rects[idx];
        const { buf, pooled } = this.allocPbo(gl, r.w * r.h * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
        gl.readPixels(r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        entries.push({ job, idx, buf, pooled });
      }
      if (job.nextSubmit >= job.rects.length) this.readJobs.shift();
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    if (!entries.length) return;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
    gl.flush();
    const wave: ActiveWave = { gl, sync, entries, readCursor: 0, ready: false };
    this.activeWaves.push(wave);
    let timerId: ReturnType<typeof setTimeout>;
    const poll = () => {
      this.pollTimers.delete(timerId);
      if (this.destroyed) {
        try { if (!gl.isContextLost()) gl.deleteSync(sync); } catch {}
        return;
      }
      if (!gl.isContextLost() && gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) {
        timerId = setTimeout(poll, 2);
        this.pollTimers.add(timerId);
        return;
      }
      gl.deleteSync(sync);
      wave.ready = true;
      this.scheduleWaveDrain();
    };
    timerId = setTimeout(poll, 2);
    this.pollTimers.add(timerId);
  }

  private scheduleWaveDrain() {
    if (this.destroyed || this.waveDrainTimer !== null || !this.activeWaves.length || !this.activeWaves.every((w) => w.ready)) return;
    this.waveDrainTimer = setTimeout(this.pumpWaveDrain, 0);
  }

  private pumpWaveDrain = () => {
    this.waveDrainTimer = null;
    if (this.destroyed || !this.activeWaves.length || !this.activeWaves.every((w) => w.ready)) return;
    const t0 = performance.now();
    let bytes = 0;
    while (this.activeWaves.length > 0) {
      if (this.destroyed) return;
      const wave = this.activeWaves[0];
      const { gl, entries } = wave;
      while (wave.readCursor < entries.length) {
        if (bytes > 0 && (bytes >= READ_CHUNK_BYTES || performance.now() - t0 >= READ_BUDGET_MS)) {
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          this.scheduleWaveDrain();
          return;
        }
        const entry = entries[wave.readCursor++];
        const r = entry.job.rects[entry.idx];
        const px = new Uint8Array(r.w * r.h * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, entry.buf);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px);
        this.releasePbo(gl, entry.buf, entry.pooled);
        entry.job.out[entry.idx] = px;
        bytes += px.byteLength;
        if (--entry.job.remaining === 0) entry.job.resolve(entry.job.out);
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.activeWaves.shift();
    }
    this.tryStartWave();
  };

  /** Cancels pending async GPU read-backs and frees PBO/sync resources before the Pixi renderer is destroyed. */
  public destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.waveDrainTimer !== null) {
      clearTimeout(this.waveDrainTimer);
      this.waveDrainTimer = null;
    }
    for (const timer of this.pollTimers) clearTimeout(timer);
    this.pollTimers.clear();
    const gl = (this.renderer as any)?.gl as WebGL2RenderingContext | undefined;
    const pendingJobs = new Set<ReadJob>(this.readJobs);
    for (const wave of this.activeWaves) {
      try { if (!wave.gl.isContextLost()) wave.gl.deleteSync(wave.sync); } catch {}
      for (const entry of wave.entries) {
        pendingJobs.add(entry.job);
        try { if (!wave.gl.isContextLost()) wave.gl.deleteBuffer(entry.buf); } catch {}
      }
    }
    this.activeWaves.length = 0;
    this.readJobs.length = 0;
    for (const job of pendingJobs) {
      if (job.remaining > 0) {
        job.remaining = 0;
        job.resolve(job.rects.map((r, i) => job.out[i] ?? new Uint8Array(Math.max(0, r.w * r.h * 4))));
      }
    }
    if (gl && !gl.isContextLost()) {
      for (const buf of this.pboPool) {
        try { gl.deleteBuffer(buf); } catch {}
      }
    }
    this.pboPool.length = 0;
  }

  /** extractTilesBatch(…, 'raw') read with readRegionsAsync: one strip per tile row, cut into tiles */
  public async extractTilesRawAsync(renderTexture: RenderTexture, coords: TileCoord[]): Promise<TileData[]> {
    const ts = this.tileSize;
    const byRow = new Map<number, TileCoord[]>();
    for (const c of coords) byRow.set(c.row, [...(byRow.get(c.row) ?? []), c]);
    const strips: Array<{ x: number; y: number; w: number; h: number; tiles: TileCoord[] }> = [];
    for (const [row, cs] of byRow) {
      const valid = cs.filter((c) => {
        const b = getTileBounds(c.col, c.row, ts, this.canvasWidth, this.canvasHeight);
        return b.width > 0 && b.height > 0;
      });
      if (!valid.length) continue;
      const x = Math.min(...valid.map((c) => c.col)) * ts;
      const y = row * ts;
      strips.push({ x, y, w: Math.min(this.canvasWidth, (Math.max(...valid.map((c) => c.col)) + 1) * ts) - x, h: Math.min(this.canvasHeight, y + ts) - y, tiles: valid });
    }
    const data = await this.readRegionsAsync(renderTexture, strips);
    const out = new Map<string, TileData>();
    strips.forEach((s, i) => {
      for (const c of s.tiles) {
        const b = getTileBounds(c.col, c.row, ts, this.canvasWidth, this.canvasHeight);
        const px = new Uint8Array(b.width * b.height * 4);
        for (let y = 0; y < b.height; y++) {
          const src = (y * s.w + (b.x - s.x)) * 4;
          px.set(data[i].subarray(src, src + b.width * 4), y * b.width * 4);
        }
        out.set(`${c.col}_${c.row}`, { col: c.col, row: c.row, width: b.width, height: b.height, compression: 'raw', data: px, byteLength: px.byteLength });
      }
    });
    return coords.map((c) => out.get(`${c.col}_${c.row}`) ?? { col: c.col, row: c.row, width: 0, height: 0, compression: 'raw', data: new Uint8Array(0) });
  }

  /**
   * Extracts all tiles covering the specified coords
   */
  public extractMultipleTiles(
    renderTexture: RenderTexture,
    coords: TileCoord[],
    compression: TileCompression = 'lz4'
  ): TileData[] {
    return this.extractTilesBatch(renderTexture, coords, compression);
  }

  /**
   * Extracts a tile directly from an in-memory full RGBA canvas buffer
   */
  public extractTileFromBuffer(
    buffer: Uint8Array,
    col: number,
    row: number,
    compression: TileCompression = 'lz4'
  ): TileData {
    const bounds = getTileBounds(col, row, this.tileSize, this.canvasWidth, this.canvasHeight);
    if (bounds.width <= 0 || bounds.height <= 0) {
      return {
        col,
        row,
        width: 0,
        height: 0,
        compression: 'raw',
        data: new Uint8Array(0),
      };
    }

    const tileRgba = new Uint8Array(bounds.width * bounds.height * 4);
    for (let y = 0; y < bounds.height; y++) {
      const srcOffset = ((bounds.y + y) * this.canvasWidth + bounds.x) * 4;
      const dstOffset = y * bounds.width * 4;
      tileRgba.set(buffer.subarray(srcOffset, srcOffset + bounds.width * 4), dstOffset);
    }

    if (compression === 'lz4') {
      const { data } = compressTileBuffer(tileRgba, 'lz4');
      return {
        col,
        row,
        width: bounds.width,
        height: bounds.height,
        compression: 'lz4',
        data,
        byteLength: data.byteLength,
      };
    }

    return {
      col,
      row,
      width: bounds.width,
      height: bounds.height,
      compression: 'raw',
      data: tileRgba,
      byteLength: tileRgba.byteLength,
    };
  }

  /**
   * Extracts multiple tiles from an in-memory full RGBA canvas buffer
   */
  public extractMultipleTilesFromBuffer(
    buffer: Uint8Array,
    coords: TileCoord[],
    compression: TileCompression = 'lz4'
  ): TileData[] {
    return coords.map((c) => this.extractTileFromBuffer(buffer, c.col, c.row, compression));
  }

  /** Tile bytes as a Uint8Array, whatever form the transport delivered them in */
  public normalizeTileData(data: any): Uint8Array {
    return normalizeTileBytes(data);
  }

  /**
   * Stitches/restores a tile back onto a layer's RenderTexture
   */
  public applyTileData(renderTexture: RenderTexture, tile: TileData) {
    // One code path: rendering the tile sprite as the root (as this used to) ignores its
    // 'none' blend mode, so transparent pixels never replaced what was underneath
    this.applyTileBatch(renderTexture, [tile]);
  }

  /**
   * Applies a full batch of tile updates onto a layer's RenderTexture with zero glitching
   */
  public applyTileBatch(renderTexture: RenderTexture, tiles: TileData[]) {
    if (!tiles || tiles.length === 0) return;

    const batchContainer = new Container();
    const texturesToDestroy: Texture[] = [];

    for (const tile of tiles) {
      if (!tile || tile.width <= 0 || tile.height <= 0) continue;

      const bounds = getTileBounds(
        tile.col,
        tile.row,
        this.tileSize,
        this.canvasWidth,
        this.canvasHeight
      );

      const rawBytes = this.normalizeTileData(tile.data);
      let rawRgba: Uint8Array;
      const expectedLen = tile.width * tile.height * 4;

      if (tile.compression === 'lz4') {
        rawRgba = decompressTileBuffer(rawBytes, 'lz4', expectedLen);
      } else {
        rawRgba = rawBytes;
      }

      if (!rawRgba || rawRgba.length < expectedLen) continue;

      const source = new BufferImageSource({
        resource: rawRgba,
        width: tile.width,
        height: tile.height,
        format: 'rgba8unorm',
        // Tiles hold premultiplied RGBA (GPU readback). Premultiplying again on upload darkened
        // every soft edge a little more on each sync, undo and reload.
        alphaMode: 'premultiplied-alpha',
        scaleMode: 'nearest',
      });
      const tileTexture = new Texture({ source });
      texturesToDestroy.push(tileTexture);

      const tileSprite = new Sprite(tileTexture);
      tileSprite.position.set(bounds.x, bounds.y);
      tileSprite.blendMode = 'none';
      batchContainer.addChild(tileSprite);
    }

    if (batchContainer.children.length > 0) {
      this.renderer.render({
        container: batchContainer,
        target: renderTexture,
        clear: false,
      });
    }

    for (const tex of texturesToDestroy) {
      tex.destroy(true);
    }
    batchContainer.destroy({ children: true });
  }
}
