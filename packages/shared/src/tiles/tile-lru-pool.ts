/**
 * Phase 6.3: Deterministic GPU Tile Texture LRU Pool & VRAM Budget Controller.
 *
 * Tracks resident warm GPU tiles across layers for large canvases (4K–8K+),
 * enforcing both tile-count and VRAM-byte ceilings with high/low-water hysteresis
 * and clean-before-dirty eviction priority to avoid GPU readback stalls.
 */

export interface TileLruBudgetConfig {
  /** Maximum active GPU tiles before spilling offscreen tiles to CPU LRU */
  maxTiles: number;
  /** Maximum active GPU bytes before spilling offscreen tiles to CPU LRU */
  maxBytes: number;
  /** Target utilization fraction after eviction (default 0.85 to avoid per-frame thrashing) */
  lowWaterRatio?: number;
  /** Maximum dirty tiles evicted per tick when GPU readback is required (default 12) */
  maxDirtyEvictBatch?: number;
}

export interface TileLruEntryMeta {
  layerId: string;
  tileKey: string;
  bytes: number;
  clean: boolean;
  inViewport: boolean;
  pinned: boolean;
}

export interface TileLruRecord extends TileLruEntryMeta {
  id: string;
  lastUsedMs: number;
}

export interface TileLruEvictionPlan {
  cleanIds: string[];
  dirtyIds: string[];
  estimatedReclaimedBytes: number;
  deficitTiles: number;
  deficitBytes: number;
}

export interface TileLruPoolStats {
  activeTiles: number;
  activeBytes: number;
  maxTiles: number;
  maxBytes: number;
  peakTiles: number;
  peakBytes: number;
  totalEvictions: number;
  cleanEvictions: number;
  dirtyEvictions: number;
  reheatHits: number;
  utilizationRatio: number;
}

/**
 * Computes recommended GPU tile count & VRAM byte budget for large canvases (4K–8K+)
 * based on canvas dimensions and device memory heuristics.
 */
export function computeRecommendedGpuTileBudget(
  canvasWidth: number,
  canvasHeight: number,
  deviceMemoryGb?: number,
  isCoarsePointer: boolean = false
): { maxTiles: number; maxBytes: number; maxPooledAtlasPages: number } {
  const px = Math.max(1, canvasWidth) * Math.max(1, canvasHeight);
  const is8K = px >= 64 * 1024 * 1024; // >= 8192x8192
  const is4K = px >= 16 * 1024 * 1024; // >= 4096x4096
  const lowMem = isCoarsePointer || (deviceMemoryGb !== undefined && deviceMemoryGb <= 4);

  if (lowMem) {
    return {
      maxTiles: is8K ? 576 : is4K ? 640 : 768,
      maxBytes: (is8K ? 160 : 192) * 1024 * 1024,
      maxPooledAtlasPages: 1,
    };
  }
  if (is8K) {
    // Cap 8K+ canvases tightly so pan/zoom & multi-layer strokes stay within ~320 MB VRAM
    return {
      maxTiles: 1024,
      maxBytes: 320 * 1024 * 1024,
      maxPooledAtlasPages: 3,
    };
  }
  if (is4K) {
    return {
      maxTiles: 1280,
      maxBytes: 384 * 1024 * 1024,
      maxPooledAtlasPages: 2,
    };
  }
  return {
    maxTiles: 1536,
    maxBytes: 448 * 1024 * 1024,
    maxPooledAtlasPages: 2,
  };
}

export class TileGpuLruPool {
  private entries = new Map<string, TileLruRecord>();
  private maxTiles: number;
  private maxBytes: number;
  private lowWaterRatio: number;
  private maxDirtyEvictBatch: number;

  private activeBytes = 0;
  private peakTiles = 0;
  private peakBytes = 0;
  private totalEvictions = 0;
  private cleanEvictions = 0;
  private dirtyEvictions = 0;
  private reheatHits = 0;

  constructor(config: TileLruBudgetConfig) {
    this.maxTiles = Math.max(16, Math.round(config.maxTiles));
    this.maxBytes = Math.max(4 * 1024 * 1024, Math.round(config.maxBytes));
    this.lowWaterRatio = Math.max(0.5, Math.min(0.98, config.lowWaterRatio ?? 0.85));
    this.maxDirtyEvictBatch = Math.max(1, Math.min(64, Math.round(config.maxDirtyEvictBatch ?? 12)));
  }

  public setBudget(patch: Partial<TileLruBudgetConfig>): void {
    if (patch.maxTiles !== undefined) {
      this.maxTiles = Math.max(16, Math.round(patch.maxTiles));
    }
    if (patch.maxBytes !== undefined) {
      this.maxBytes = Math.max(4 * 1024 * 1024, Math.round(patch.maxBytes));
    }
    if (patch.lowWaterRatio !== undefined) {
      this.lowWaterRatio = Math.max(0.5, Math.min(0.98, patch.lowWaterRatio));
    }
    if (patch.maxDirtyEvictBatch !== undefined) {
      this.maxDirtyEvictBatch = Math.max(1, Math.min(64, Math.round(patch.maxDirtyEvictBatch)));
    }
  }

  /** Inserts or promotes a GPU tile to Most-Recently-Used in O(1) time. */
  public touch(id: string, meta: TileLruEntryMeta, nowMs: number = Date.now()): void {
    const existing = this.entries.get(id);
    if (existing) {
      this.activeBytes -= existing.bytes;
      this.entries.delete(id);
    }
    const safeBytes = Math.max(0, Math.round(meta.bytes));
    const rec: TileLruRecord = {
      id,
      layerId: meta.layerId,
      tileKey: meta.tileKey,
      bytes: safeBytes,
      clean: meta.clean,
      inViewport: meta.inViewport,
      pinned: meta.pinned,
      lastUsedMs: nowMs,
    };
    this.entries.set(id, rec);
    this.activeBytes += safeBytes;
    if (this.entries.size > this.peakTiles) this.peakTiles = this.entries.size;
    if (this.activeBytes > this.peakBytes) this.peakBytes = this.activeBytes;
  }

  public markClean(id: string, clean: boolean): void {
    const rec = this.entries.get(id);
    if (rec) rec.clean = clean;
  }

  public setInViewport(id: string, inViewport: boolean, nowMs?: number): void {
    const rec = this.entries.get(id);
    if (!rec) return;
    rec.inViewport = inViewport;
    if (inViewport) {
      rec.lastUsedMs = nowMs ?? Date.now();
      this.entries.delete(id);
      this.entries.set(id, rec);
    }
  }

  public setPinned(id: string, pinned: boolean): void {
    const rec = this.entries.get(id);
    if (rec) rec.pinned = pinned;
  }

  public remove(id: string): boolean {
    const rec = this.entries.get(id);
    if (!rec) return false;
    this.activeBytes = Math.max(0, this.activeBytes - rec.bytes);
    this.entries.delete(id);
    return true;
  }

  public recordEviction(id: string, kind: 'clean' | 'dirty'): boolean {
    const removed = this.remove(id);
    if (removed) {
      this.totalEvictions++;
      if (kind === 'clean') this.cleanEvictions++;
      else this.dirtyEvictions++;
    }
    return removed;
  }

  public recordReheat(): void {
    this.reheatHits++;
  }

  public clearLayer(layerId: string): number {
    let removed = 0;
    for (const [id, rec] of this.entries) {
      if (rec.layerId === layerId) {
        this.activeBytes = Math.max(0, this.activeBytes - rec.bytes);
        this.entries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  public clear(): void {
    this.entries.clear();
    this.activeBytes = 0;
  }

  public isOverBudget(): boolean {
    return this.entries.size > this.maxTiles || this.activeBytes > this.maxBytes;
  }

  /**
   * Selects least-recently-used offscreen tiles to evict down to low-water hysteresis target.
   * Clean tiles are prioritized first (zero GPU readPixels cost), followed by bounded dirty batches.
   */
  public planEviction(opts?: {
    targetTiles?: number;
    targetBytes?: number;
    maxDirtyBatch?: number;
    force?: boolean;
  }): TileLruEvictionPlan {
    const over = this.isOverBudget();
    if (!over && !opts?.force) {
      return {
        cleanIds: [],
        dirtyIds: [],
        estimatedReclaimedBytes: 0,
        deficitTiles: 0,
        deficitBytes: 0,
      };
    }

    const targetTiles = opts?.targetTiles ?? Math.floor(this.maxTiles * this.lowWaterRatio);
    const targetBytes = opts?.targetBytes ?? Math.floor(this.maxBytes * this.lowWaterRatio);
    const deficitTiles = Math.max(0, this.entries.size - targetTiles);
    const deficitBytes = Math.max(0, this.activeBytes - targetBytes);
    if (deficitTiles === 0 && deficitBytes === 0) {
      return {
        cleanIds: [],
        dirtyIds: [],
        estimatedReclaimedBytes: 0,
        deficitTiles: 0,
        deficitBytes: 0,
      };
    }

    // Adaptive dirty batch cap: double throughput when > 125% over ceiling
    const severePressure =
      this.entries.size > this.maxTiles * 1.25 || this.activeBytes > this.maxBytes * 1.25;
    const dirtyCap = opts?.maxDirtyBatch ?? (severePressure ? this.maxDirtyEvictBatch * 2 : this.maxDirtyEvictBatch);

    const cleanIds: string[] = [];
    const dirtyIds: string[] = [];
    let reclaimedTiles = 0;
    let reclaimedBytes = 0;

    // Pass 1 (LRU order): evict clean offscreen tiles first (zero GPU readback stall)
    for (const rec of this.entries.values()) {
      if (reclaimedTiles >= deficitTiles && reclaimedBytes >= deficitBytes) break;
      if (rec.pinned || rec.inViewport || !rec.clean) continue;
      cleanIds.push(rec.id);
      reclaimedTiles++;
      reclaimedBytes += rec.bytes;
    }

    // Pass 2 (LRU order): evict dirty offscreen tiles up to bounded GPU readback batch
    if (reclaimedTiles < deficitTiles || reclaimedBytes < deficitBytes) {
      for (const rec of this.entries.values()) {
        if (dirtyIds.length >= dirtyCap) break;
        if (reclaimedTiles >= deficitTiles && reclaimedBytes >= deficitBytes) break;
        if (rec.pinned || rec.inViewport || rec.clean) continue;
        dirtyIds.push(rec.id);
        reclaimedTiles++;
        reclaimedBytes += rec.bytes;
      }
    }

    return {
      cleanIds,
      dirtyIds,
      estimatedReclaimedBytes: reclaimedBytes,
      deficitTiles,
      deficitBytes,
    };
  }

  public getStats(): TileLruPoolStats {
    const tileRatio = this.maxTiles > 0 ? this.entries.size / this.maxTiles : 0;
    const byteRatio = this.maxBytes > 0 ? this.activeBytes / this.maxBytes : 0;
    return {
      activeTiles: this.entries.size,
      activeBytes: this.activeBytes,
      maxTiles: this.maxTiles,
      maxBytes: this.maxBytes,
      peakTiles: this.peakTiles,
      peakBytes: this.peakBytes,
      totalEvictions: this.totalEvictions,
      cleanEvictions: this.cleanEvictions,
      dirtyEvictions: this.dirtyEvictions,
      reheatHits: this.reheatHits,
      utilizationRatio: Math.round(Math.max(tileRatio, byteRatio) * 1000) / 1000,
    };
  }
}
