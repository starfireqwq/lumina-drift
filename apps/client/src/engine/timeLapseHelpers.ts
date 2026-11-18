import { DEFAULT_TILE_SIZE, getTileBounds, LayerModel, TileData } from '@atelier/shared';

export interface ReplayParticipantInfo {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  color: string;
  opCount?: number;
}

export interface OpCursorTarget {
  x: number;
  y: number;
  points: Array<{ x: number; y: number; pressure?: number }>;
  brushSize: number;
  brushColor: string;
  isEraser: boolean;
}

export interface SeekStepTile {
  layerId: string;
  tile: TileData;
}

export interface SeekReplayPlan {
  /** Ops to execute sequentially (e.g. after last LAYER_CLEAR up through any tile-less legacy ops) */
  sequentialOps: any[];
  /** Deduplicated latest tiles to apply directly per layer after sequentialOps */
  latestTiles: SeekStepTile[];
}

export function decodeBase64Bytes(input: string): Uint8Array {
  const clean = input.replace(/^data:[^;]+;base64,/, '');
  if (!clean) return new Uint8Array(0);
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(clean, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Normalizes tile bytes from Uint8Array, ArrayBuffer, typed array view, base64 string,
 * Node JSON Buffer `{ type: 'Buffer', data }`, array, or `{ "0": ... }` object.
 */
export function normalizeReplayTileBytes(data: unknown): Uint8Array {
  if (!data) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === 'string') {
    return decodeBase64Bytes(data);
  }
  if (typeof data === 'object') {
    const obj = data as { type?: unknown; data?: unknown };
    if (Array.isArray(obj.data)) {
      return new Uint8Array(obj.data);
    }
    if (Array.isArray(data)) {
      return new Uint8Array(data);
    }
    const vals = Object.values(data as Record<string, unknown>);
    if (vals.length > 0 && typeof vals[0] === 'number') {
      return new Uint8Array(vals as number[]);
    }
  }
  return new Uint8Array(0);
}

/**
 * Converts premultiplied RGBA bytes (stored by GPU tile readback) into straight alpha RGBA
 * expected by Canvas 2D ImageData / putImageData.
 */
export function unpremultiplyRgba(src: Uint8Array, dst: Uint8ClampedArray): void {
  const len = Math.min(src.length, dst.length);
  for (let i = 0; i < len; i += 4) {
    const a = src[i + 3];
    if (a === 0) {
      dst[i] = 0;
      dst[i + 1] = 0;
      dst[i + 2] = 0;
      dst[i + 3] = 0;
    } else if (a === 255) {
      dst[i] = src[i];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i + 2];
      dst[i + 3] = 255;
    } else {
      const k = 255 / a;
      dst[i] = src[i] * k;
      dst[i + 1] = src[i + 1] * k;
      dst[i + 2] = src[i + 2] * k;
      dst[i + 3] = a;
    }
  }
}

export function resolveTileDimensions(
  tile: { col: number; row: number; width?: number; height?: number },
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number; width: number; height: number } | null {
  if (!Number.isInteger(tile.col) || !Number.isInteger(tile.row) || tile.col < 0 || tile.row < 0) {
    return null;
  }
  const bounds = getTileBounds(tile.col, tile.row, DEFAULT_TILE_SIZE, canvasWidth, canvasHeight);
  const width = Number.isFinite(tile.width) && (tile.width ?? 0) > 0 ? Math.min(tile.width!, DEFAULT_TILE_SIZE) : bounds.width;
  const height = Number.isFinite(tile.height) && (tile.height ?? 0) > 0 ? Math.min(tile.height!, DEFAULT_TILE_SIZE) : bounds.height;
  if (bounds.x >= canvasWidth || bounds.y >= canvasHeight || width <= 0 || height <= 0) {
    return null;
  }
  return { x: bounds.x, y: bounds.y, width, height };
}

function clampCoord(val: number, max: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, Math.min(max, val));
}

/**
 * Extracts the active brush trajectory / position from an op payload so Time-Lapse Replay
 * can render every collaborator's moving brush cursor, avatar, and display name.
 */
export function extractOpCursorTarget(
  op: any,
  canvasWidth: number,
  canvasHeight: number
): OpCursorTarget | null {
  if (!op) return null;
  const payload = op.payload;
  const opType = (op.opType || '').toUpperCase();
  const isEraser = opType === 'ERASE' || Boolean(payload?.isEraser);
  const brushSize = Number.isFinite(payload?.size) && payload.size > 0 ? payload.size : 14;
  const brushColor = typeof payload?.color === 'string' && payload.color ? payload.color : '#6366F1';

  const rawPoints =
    Array.isArray(payload?.samplePoints) && payload.samplePoints.length > 0
      ? payload.samplePoints
      : Array.isArray(payload?.allPoints) && payload.allPoints.length > 0
        ? payload.allPoints
        : null;

  if (rawPoints) {
    const points: Array<{ x: number; y: number; pressure?: number }> = [];
    for (const p of rawPoints) {
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        points.push({
          x: clampCoord(p.x, canvasWidth),
          y: clampCoord(p.y, canvasHeight),
          ...(Number.isFinite(p.pressure) ? { pressure: p.pressure } : {}),
        });
      }
    }
    if (points.length > 0) {
      const end = points[points.length - 1];
      return { x: end.x, y: end.y, points, brushSize, brushColor, isEraser };
    }
  }

  if (Array.isArray(payload?.vectorAdded) && payload.vectorAdded.length > 0) {
    const anchors: Array<{ x: number; y: number; pressure?: number }> = [];
    for (const s of payload.vectorAdded) {
      if (!Array.isArray(s?.anchors)) continue;
      for (const a of s.anchors) {
        if (a && Number.isFinite(a.x) && Number.isFinite(a.y)) {
          anchors.push({ x: clampCoord(a.x, canvasWidth), y: clampCoord(a.y, canvasHeight), pressure: a.pressure });
        }
      }
    }
    if (anchors.length > 0) {
      const end = anchors[anchors.length - 1];
      return { x: end.x, y: end.y, points: anchors, brushSize, brushColor, isEraser };
    }
  }

  const b = payload?.bounds;
  if (b && typeof b === 'object') {
    if (Number.isFinite(b.minX) && Number.isFinite(b.maxX) && Number.isFinite(b.minY) && Number.isFinite(b.maxY)) {
      const x = clampCoord((b.minX + b.maxX) / 2, canvasWidth);
      const y = clampCoord((b.minY + b.maxY) / 2, canvasHeight);
      return { x, y, points: [{ x, y }], brushSize, brushColor, isEraser };
    }
    if (Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height)) {
      const x = clampCoord(b.x + b.width / 2, canvasWidth);
      const y = clampCoord(b.y + b.height / 2, canvasHeight);
      return { x, y, points: [{ x, y }], brushSize, brushColor, isEraser };
    }
  }

  if (Array.isArray(payload?.tiles) && payload.tiles.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const t of payload.tiles) {
      const dim = t ? resolveTileDimensions(t, canvasWidth, canvasHeight) : null;
      if (!dim) continue;
      if (dim.x < minX) minX = dim.x;
      if (dim.y < minY) minY = dim.y;
      if (dim.x + dim.width > maxX) maxX = dim.x + dim.width;
      if (dim.y + dim.height > maxY) maxY = dim.y + dim.height;
    }
    if (Number.isFinite(minX) && Number.isFinite(maxX)) {
      const x = clampCoord((minX + maxX) / 2, canvasWidth);
      const y = clampCoord((minY + maxY) / 2, canvasHeight);
      return { x, y, points: [{ x, y }], brushSize, brushColor, isEraser };
    }
  }

  return null;
}

const MASK_ACTION_DESCS = new Set(['加圖層蒙版', '復原：蒙版回來了', '貼上圖層蒙版']);

/**
 * Returns true if an op targets or creates a layer mask (`layerType === 'mask'`),
 * including legacy mask patches whose mask layer was later deleted/undone via Ctrl+Z.
 */
export function isMaskTimeLapseOp(op: any, maskLayerIds?: ReadonlySet<string>): boolean {
  if (!op || typeof op !== 'object') return false;
  if (typeof op.layerId === 'string' && maskLayerIds?.has(op.layerId)) return true;
  const opType = typeof op.opType === 'string' ? op.opType.toUpperCase() : '';
  if (opType === 'MASK') return true;
  if (op.layerType === 'mask' || op.payload?.layerType === 'mask' || op.payload?.isMask === true) {
    return true;
  }
  const desc = typeof op.payload?.actionDesc === 'string' ? op.payload.actionDesc : '';
  return MASK_ACTION_DESCS.has(desc);
}

/**
 * Filters out all operations belonging to mask layers (both active and deleted/Ctrl+Z'd)
 * and deleted layers (such as cancelled image imports or deleted scratch/corrupted layers)
 * so Time-Lapse Replay only displays actual artwork strokes, colors, and canvas operations.
 */
export function filterTimeLapseOps(
  ops: any[],
  layers: ReadonlyArray<Pick<LayerModel, 'id' | 'layerType'>> = []
): { ops: any[]; maskLayerIds: Set<string>; activeLayerIds: Set<string> } {
  const maskLayerIds = new Set<string>();
  const activeLayerIds = new Set<string>();
  for (const layer of layers) {
    if (layer?.layerType === 'mask' && layer.id) {
      maskLayerIds.add(layer.id);
    } else if (layer?.id) {
      activeLayerIds.add(layer.id);
    }
  }
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ops: [], maskLayerIds, activeLayerIds };
  }
  for (const op of ops) {
    if (op && typeof op.layerId === 'string' && isMaskTimeLapseOp(op)) {
      maskLayerIds.add(op.layerId);
    }
  }
  const enforceActiveLayers = activeLayerIds.size > 0;
  const filtered = ops.filter(
    (op) =>
      Boolean(op) &&
      !isMaskTimeLapseOp(op, maskLayerIds) &&
      (!enforceActiveLayers || (typeof op.layerId === 'string' && activeLayerIds.has(op.layerId)))
  );
  return { ops: filtered, maskLayerIds, activeLayerIds };
}

/**
 * Reconciles historical ops with the authoritative canvas snapshot bundle when a canvas
 * has been resized/shifted or had pre-snapshot ghost tiles cleared.
 * - Detects if pre-resize ops were shifted by `(dCol, dRow)` when the canvas was expanded/resized,
 *   shifting pre-resize tile coordinates and samplePoints into the post-resize coordinate space.
 * - Drops pre-snapshot orphaned tiles that do not exist in the authoritative snapshot bundle.
 */
export function reconcileTimeLapseOpsWithSnapshot(
  ops: any[],
  snapshotBundle: {
    seq?: number;
    layers?: ReadonlyArray<{ layerId: string; tiles?: ReadonlyArray<{ col: number; row: number; data?: unknown }> }>;
  } | null | undefined,
  rawOpsForGapDetection?: ReadonlyArray<{ seq?: number }>
): any[] {
  const snapSeq = Number(snapshotBundle?.seq) || 0;
  if (!Array.isArray(ops) || ops.length === 0 || !snapshotBundle || !Array.isArray(snapshotBundle.layers) || snapSeq <= 0) {
    return ops;
  }

  const snapTileKeysByLayer = new Map<string, Set<string>>();
  for (const layer of snapshotBundle.layers) {
    if (!layer?.layerId) continue;
    const keys = new Set<string>();
    for (const t of layer.tiles || []) {
      if (t && Number.isInteger(t.col) && Number.isInteger(t.row)) {
        keys.add(`${t.col}_${t.row}`);
      }
    }
    snapTileKeysByLayer.set(layer.layerId, keys);
  }

  if (snapTileKeysByLayer.size === 0) return ops;

  // Detect dominant integer tile shift (dCol, dRow) for pre-snapshot ops whose tiles were shifted by resizeCanvas
  const votes = new Map<string, number>();
  const maxSeqForVote = new Map<string, number>();
  for (const op of ops) {
    const seq = Number(op?.seq) || 0;
    if (seq > snapSeq || !op?.layerId) continue;
    const snapSet = snapTileKeysByLayer.get(op.layerId);
    if (!snapSet || snapSet.size === 0) continue;
    const tiles = op.payload?.tiles;
    if (!Array.isArray(tiles)) continue;
    for (const t of tiles) {
      if (!t || !Number.isInteger(t.col) || !Number.isInteger(t.row)) continue;
      if (snapSet.has(`${t.col}_${t.row}`)) continue;
      for (const sk of snapSet) {
        const [sc, sr] = sk.split('_').map(Number);
        const dc = sc - t.col;
        const dr = sr - t.row;
        if (dc === 0 && dr === 0) continue;
        const vk = `${dc}_${dr}`;
        votes.set(vk, (votes.get(vk) || 0) + 1);
        maxSeqForVote.set(vk, Math.max(maxSeqForVote.get(vk) || 0, seq));
      }
    }
  }

  let bestKey = '0_0';
  let bestVotes = 0;
  for (const [vk, cnt] of votes) {
    if (cnt > bestVotes) {
      bestVotes = cnt;
      bestKey = vk;
    }
  }

  const [dCol, dRow] = bestVotes >= 3 ? bestKey.split('_').map(Number) : [0, 0];
  const hasShift = dCol !== 0 || dRow !== 0;
  let resizeCutoffSeq = hasShift ? (maxSeqForVote.get(bestKey) || 0) : 0;
  if (hasShift) {
    const gapSource = rawOpsForGapDetection && rawOpsForGapDetection.length > 1 ? rawOpsForGapDetection : ops;
    for (let i = 1; i < gapSource.length; i++) {
      const prevS = Number(gapSource[i - 1]?.seq) || 0;
      const currS = Number(gapSource[i]?.seq) || 0;
      if (prevS >= resizeCutoffSeq && prevS <= snapSeq && currS > prevS + 1) {
        resizeCutoffSeq = prevS;
        break;
      }
    }
  }

  const shiftPoints = (pts: any[], dx: number, dy: number) =>
    pts.map((p) => (p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { ...p, x: p.x + dx, y: p.y + dy } : p));

  const reconciled: any[] = [];
  for (const op of ops) {
    const seq = Number(op?.seq) || 0;
    if (seq > snapSeq || !op?.layerId || !snapTileKeysByLayer.has(op.layerId)) {
      reconciled.push(op);
      continue;
    }
    const snapSet = snapTileKeysByLayer.get(op.layerId)!;
    const tiles = op.payload?.tiles;
    if (!Array.isArray(tiles) || tiles.length === 0) {
      if (snapSet.size > 0) reconciled.push(op);
      continue;
    }
    if (snapSet.size === 0) {
      // Layer has 0 tiles in the authoritative snapshot: drop pre-snapshot ghost ops
      continue;
    }

    const preferShift = hasShift && seq > 0 && seq <= resizeCutoffSeq;
    let shiftedAny = false;
    const nextTiles: any[] = [];
    for (const t of tiles) {
      if (!t || !Number.isInteger(t.col) || !Number.isInteger(t.row)) continue;
      const directKey = `${t.col}_${t.row}`;
      const shiftedKey = `${t.col + dCol}_${t.row + dRow}`;
      if (preferShift && snapSet.has(shiftedKey)) {
        nextTiles.push({ ...t, col: t.col + dCol, row: t.row + dRow });
        shiftedAny = true;
      } else if (snapSet.has(directKey)) {
        nextTiles.push(t);
      } else if (hasShift && snapSet.has(shiftedKey)) {
        nextTiles.push({ ...t, col: t.col + dCol, row: t.row + dRow });
        shiftedAny = true;
      }
    }

    if (nextTiles.length === 0) continue;

    if (!shiftedAny && nextTiles.length === tiles.length) {
      reconciled.push(op);
      continue;
    }

    const dx = shiftedAny ? dCol * DEFAULT_TILE_SIZE : 0;
    const dy = shiftedAny ? dRow * DEFAULT_TILE_SIZE : 0;
    reconciled.push({
      ...op,
      payload: {
        ...op.payload,
        tiles: nextTiles,
        ...(shiftedAny && Array.isArray(op.payload?.samplePoints)
          ? { samplePoints: shiftPoints(op.payload.samplePoints, dx, dy) }
          : {}),
        ...(shiftedAny && Array.isArray(op.payload?.allPoints)
          ? { allPoints: shiftPoints(op.payload.allPoints, dx, dy) }
          : {}),
      },
    });
  }

  return reconciled;
}

/**
 * Computes an optimal, pixel-exact replay plan for `seek(targetIndex)`.
 * Skips redundant earlier tile writes per `(layerId, col, row)` after the last `LAYER_CLEAR`
 * and any tile-less legacy stroke operations, turning 8,483-op scrubs into tens of tile blits.
 */
export function computeSeekReplayPlan(ops: any[], targetIndex: number): SeekReplayPlan {
  const clamped = Math.max(0, Math.min(targetIndex, ops.length));
  const lastClearByLayer = new Map<string, number>();
  const lastTilelessByLayer = new Map<string, number>();

  for (let i = 0; i < clamped; i++) {
    const op = ops[i];
    if (!op?.layerId) continue;
    const opType = (op.opType || '').toUpperCase();
    const hasTiles = Array.isArray(op.payload?.tiles) && op.payload.tiles.length > 0;
    if (opType === 'LAYER_CLEAR') {
      lastClearByLayer.set(op.layerId, i);
      lastTilelessByLayer.set(op.layerId, -1);
    } else if (!hasTiles) {
      const hasLegacyDraw =
        ((opType === 'STROKE' || opType === 'ERASE') && Array.isArray(op.payload?.samplePoints) && op.payload.samplePoints.length > 0) ||
        (Array.isArray(op.payload?.vectorAdded) && op.payload.vectorAdded.length > 0);
      if (hasLegacyDraw) {
        lastTilelessByLayer.set(op.layerId, i);
      }
    }
  }

  const sequentialOps: any[] = [];
  for (let i = 0; i < clamped; i++) {
    const op = ops[i];
    if (!op?.layerId) continue;
    const clearIdx = lastClearByLayer.get(op.layerId) ?? -1;
    if (i <= clearIdx) continue;
    const tilelessIdx = lastTilelessByLayer.get(op.layerId) ?? -1;
    if (i <= tilelessIdx) {
      sequentialOps.push(op);
    }
  }

  const seenTiles = new Set<string>();
  const reversedLatest: SeekStepTile[] = [];
  for (let i = clamped - 1; i >= 0; i--) {
    const op = ops[i];
    if (!op?.layerId) continue;
    const clearIdx = lastClearByLayer.get(op.layerId) ?? -1;
    const tilelessIdx = lastTilelessByLayer.get(op.layerId) ?? -1;
    const floorIdx = Math.max(clearIdx, tilelessIdx);
    if (i <= floorIdx) continue;
    const tiles = op.payload?.tiles;
    if (!Array.isArray(tiles) || tiles.length === 0) continue;
    for (const tile of tiles) {
      if (!tile || !Number.isInteger(tile.col) || !Number.isInteger(tile.row)) continue;
      const key = `${op.layerId}\0${tile.col}_${tile.row}`;
      if (seenTiles.has(key)) continue;
      seenTiles.add(key);
      reversedLatest.push({ layerId: op.layerId, tile });
    }
  }

  reversedLatest.reverse();
  return { sequentialOps, latestTiles: reversedLatest };
}
