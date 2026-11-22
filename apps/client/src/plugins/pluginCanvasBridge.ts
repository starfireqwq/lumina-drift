import {
  canUserCreateLayer,
  canUserPerformLayerAction,
  DEFAULT_TILE_SIZE,
  evaluateEasing,
  evaluateTransformKeyframes,
  normalizeBrushDynamics,
  type BlendMode,
  type BrushDynamicsConfig,
  type BrushMixMode,
  type BrushTextureBlendMode,
  type CanvasMemberModel,
  type CelMark,
  type DualBrushBlendMode,
  type KeyframeEasing,
  type LayerMeta,
  type LayerModel,
  type LayerPermissionModel,
  type ScopedUndoOp,
  type SelectionSnapshot,
  type TileCoord,
  type TileData,
  type TimelineLabel,
  type TransformKeyframe,
  type UserModel,
  type UserPayload,
} from '@atelier/shared';
import {
  MAX_HOLD,
  MAX_TIMELINE_FRAMES,
  celEntriesOf,
  normalizeTimelineLabels,
  removeTimelineLabel,
  removeTransformKeyframe,
  upsertTimelineLabel,
  upsertTransformKeyframe,
} from '../engine/AnimationEngine';
import {
  PLUGIN_LIMITS,
  type PluginLayerInfo,
  type PluginRect,
  type PluginTimelineState,
  type PluginTimelineTrackInfo,
} from './pluginApi';
import {
  getPluginEasing,
  listAllEasingPresets,
  registerPluginEasing,
  resolveEasingBezierById,
  unregisterPluginEasing,
  validateBezierTuple,
} from './pluginEasingRegistry';
import type { PluginRpcHandler, PluginRpcMethod } from './pluginRpc';

const VALID_BLEND_MODES = new Set<string>([
  'normal',
  'darken',
  'multiply',
  'color_burn',
  'linear_burn',
  'darker_color',
  'lighten',
  'screen',
  'color_dodge',
  'add',
  'glow',
  'lighter_color',
  'overlay',
  'soft_light',
  'hard_light',
  'vivid_light',
  'linear_light',
  'pin_light',
  'hard_mix',
  'difference',
  'exclusion',
  'subtract',
  'divide',
  'hue',
  'saturation',
  'color',
  'luminosity',
]);

const ALLOWED_LAYER_UPDATE_KEYS = new Set([
  'name',
  'isVisible',
  'opacity',
  'blendMode',
  'alphaLocked',
  'clipToBelow',
]);

/**
 * Converts premultiplied RGBA bytes (LayerManager format) to straight RGBA bytes (Plugin API v2 format).
 */
export function premultipliedToStraight(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 0) {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
    } else if (a === 255) {
      out[i] = src[i];
      out[i + 1] = src[i + 1];
      out[i + 2] = src[i + 2];
      out[i + 3] = 255;
    } else {
      const inv = 255 / a;
      out[i] = Math.min(255, Math.round(src[i] * inv));
      out[i + 1] = Math.min(255, Math.round(src[i + 1] * inv));
      out[i + 2] = Math.min(255, Math.round(src[i + 2] * inv));
      out[i + 3] = a;
    }
  }
  return out;
}

/**
 * Converts straight RGBA bytes (Plugin API v2 format) to premultiplied RGBA bytes (LayerManager format).
 */
export function straightToPremultiplied(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 0) {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
    } else if (a === 255) {
      out[i] = src[i];
      out[i + 1] = src[i + 1];
      out[i + 2] = src[i + 2];
      out[i + 3] = 255;
    } else {
      const k = a / 255;
      out[i] = Math.round(src[i] * k);
      out[i + 1] = Math.round(src[i + 1] * k);
      out[i + 2] = Math.round(src[i + 2] * k);
      out[i + 3] = a;
    }
  }
  return out;
}

export interface PluginAclContext {
  user: UserPayload | UserModel | null;
  isGuest: boolean;
  canvasMember?: CanvasMemberModel | null;
  getLayerPermission?: (layerId: string) => LayerPermissionModel | null | undefined;
}

export interface PluginBrushState {
  color: string;
  secondaryColor?: string;
  size: number;
  minSize?: number;
  opacity?: number;
  flow?: number;
  hardness?: number;
  spacing?: number;
  scatter?: number;
  roundness?: number;
  tipAngle?: number;
  angleMode?: 'direction' | 'pen' | 'fixed';
  tiltSize?: number;
  isEraser?: boolean;
  mixMode?: BrushMixMode;
  colorMixing?: number;
  paintAmount?: number;
  colorStretch?: number;
  fgBgMix?: number;
  wetEdges?: boolean;
  hueJitter?: number;
  satJitter?: number;
  valJitter?: number;
  textureDensity?: number;
  textureScale?: number;
  textureInvert?: boolean;
  textureBlendMode?: BrushTextureBlendMode;
  dualBrush?: boolean;
  dualSize?: number;
  dualScatter?: number;
  dualBlendMode?: DualBrushBlendMode;
  dynamics?: BrushDynamicsConfig;
}

export type PluginBrushPatch = Partial<Omit<PluginBrushState, 'isEraser'>>;

export interface PluginTimelineBridge {
  getFps(): number;
  getLength(): number;
  getCurrentFrame(): number;
  getIsPlaying(): boolean;
  getLoop(): boolean;
  getRange(): { start: number; end: number } | null;
  setCurrentFrame(frame: number): void;
  setLoop(loop: boolean): void;
  setRange(range: { start: number; end: number } | null): void;
}

export interface PluginSelectionBridge {
  getInfo(): { hasSelection: boolean; bounds: PluginRect | null };
  captureSnapshot(): SelectionSnapshot | null;
  restoreSnapshot(snapshot: SelectionSnapshot | null): void;
  readMaskRect(rect: PluginRect): Uint8Array | null;
  writeMaskRect(rect: PluginRect, data: Uint8Array, mode: 'replace' | 'add' | 'subtract'): void;
  selectRect(rect: PluginRect, mode: 'replace' | 'add' | 'subtract'): void;
  selectEllipse(rect: PluginRect, mode: 'replace' | 'add' | 'subtract'): void;
  selectPolygon(points: Array<{ x: number; y: number }>, mode: 'replace' | 'add' | 'subtract'): void;
  clear(): void;
  invert(): void;
  expand(radius: number): void;
  contract(radius: number): void;
  feather(radius: number): void;
}

export interface PluginCanvasHostAdapter {
  canvasWidth: number;
  canvasHeight: number;
  tileSize?: number;
  acl: PluginAclContext;
  getLayers(): LayerModel[];
  getActiveLayerId(): string | null;
  setActiveLayer(layerId: string): void;
  getBrush?(): PluginBrushState;
  setBrush?(patch: PluginBrushPatch): void;
  createLayer(opts: {
    name: string;
    layerType: 'raster' | 'group';
    blendMode: BlendMode;
    opacity: number;
    parentId: string | null;
    aboveLayerId: string | null;
    select: boolean;
  }): Promise<LayerModel | null>;
  updateLayerProps(layerId: string, patch: Partial<LayerModel>): Promise<void>;
  reorderLayers(layerId: string, ascendingIds: string[], parentIdPatch?: string | null): Promise<void>;
  deleteLayer(layerId: string, opts?: { keepContents?: boolean }): Promise<boolean>;
  restoreDeletedLayer(model: LayerModel, tiles: TileData[], belowId: string | null): Promise<LayerModel | null>;
  getOccupiedTiles(layerId: string): TileCoord[] | null;
  readLayerTile(layerId: string, col: number, row: number): Promise<Uint8Array>;
  readLayerRect(layerId: string, rect: PluginRect): Promise<Uint8Array>;
  readCompositeRect(rect: PluginRect, includeBackground: boolean): Promise<Uint8Array>;
  applyLayerTiles(layerId: string, tiles: TileData[]): void;
  commitTilePatch(layerId: string, tiles: TileData[], desc: string, beforeTiles: TileData[]): void;
  pushUndoOp(op: ScopedUndoOp): void;
  onTransactionCommitted?(): void;
  selection?: PluginSelectionBridge;
  timeline?: PluginTimelineBridge;
}

export function parsePluginRect(
  raw: unknown,
  canvasWidth: number,
  canvasHeight: number,
  maxDim: number = PLUGIN_LIMITS.maxTileRegionDim,
): PluginRect {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Expected rect object { x, y, width, height }.');
  }
  const r = raw as Record<string, unknown>;
  const x = r.x;
  const y = r.y;
  const width = r.width;
  const height = r.height;
  if (
    typeof x !== 'number' || !Number.isInteger(x) ||
    typeof y !== 'number' || !Number.isInteger(y) ||
    typeof width !== 'number' || !Number.isInteger(width) ||
    typeof height !== 'number' || !Number.isInteger(height)
  ) {
    throw new Error('Rect coordinates and dimensions must be integers.');
  }
  if (width <= 0 || height <= 0 || width > maxDim || height > maxDim) {
    throw new Error(`Rect width and height must be between 1 and ${maxDim} px.`);
  }
  if (x < 0 || y < 0 || x + width > canvasWidth || y + height > canvasHeight) {
    throw new Error(`Rect (${x},${y},${width}x${height}) is outside canvas bounds (${canvasWidth}x${canvasHeight}).`);
  }
  return { x, y, width, height };
}

function resolveEffectivePixelTarget(raw: LayerModel, layers: LayerModel[]): LayerModel {
  if (raw.layerType === 'mask' && raw.parentId) {
    const parent = layers.find((l) => l.id === raw.parentId);
    if (parent) {
      return parent.layerType === 'group' ? { ...parent, layerType: 'raster' } : parent;
    }
  }
  return raw;
}

export function canPluginEditLayerPixels(
  raw: LayerModel,
  layers: LayerModel[],
  acl: PluginAclContext,
): { allowed: boolean; reason?: string } {
  if (acl.isGuest || !acl.user) {
    return { allowed: false, reason: 'Guests cannot modify layer pixels.' };
  }
  if (raw.layerType === 'group') {
    return { allowed: false, reason: 'Cannot edit pixels on a group layer.' };
  }
  if (raw.isLocked) {
    return { allowed: false, reason: 'Layer is locked.' };
  }
  const target = resolveEffectivePixelTarget(raw, layers);
  const res = canUserPerformLayerAction(
    {
      user: acl.user,
      canvasMember: acl.canvasMember,
      layer: target,
      layerPermission: acl.getLayerPermission?.(target.id),
    },
    'draw',
  );
  if (!res.allowed) return res;
  // Mirror client workspace rule: owner or explicitly shared_all non-public owned layer (or custom perm granted above)
  const isOwner = target.ownerId === acl.user.id;
  const isSharedAll = !target.isPublic && Boolean(target.ownerId) && target.aclMode === 'shared_all';
  const isCustomAllowed = target.aclMode === 'custom' && Boolean(acl.getLayerPermission?.(target.id)?.canDraw);
  if (!isOwner && !isSharedAll && !isCustomAllowed) {
    return { allowed: false, reason: 'No pixel edit permission on this layer.' };
  }
  return { allowed: true };
}

export function canPluginManageLayerAction(
  layer: LayerModel,
  action: 'modify_props' | 'reorder' | 'delete',
  acl: PluginAclContext,
): { allowed: boolean; reason?: string } {
  if (acl.isGuest || !acl.user) {
    return { allowed: false, reason: 'Guests cannot modify layers.' };
  }
  // Never allow modifying locked layers via plugins (even for owners, to protect locked work)
  if (layer.isLocked) {
    return { allowed: false, reason: 'Layer is locked.' };
  }
  return canUserPerformLayerAction(
    {
      user: acl.user,
      canvasMember: acl.canvasMember,
      layer,
      layerPermission: acl.getLayerPermission?.(layer.id),
    },
    action,
  );
}

export function canPluginCreateLayer(acl: PluginAclContext): { allowed: boolean; reason?: string } {
  if (acl.isGuest || !acl.user) {
    return { allowed: false, reason: 'Guests cannot create layers.' };
  }
  if (!canUserCreateLayer(acl.user, acl.canvasMember)) {
    return { allowed: false, reason: 'Viewers cannot create layers.' };
  }
  return { allowed: true };
}

export function canPluginWriteTimeline(acl: PluginAclContext): { allowed: boolean; reason?: string } {
  if (acl.isGuest || !acl.user) {
    return { allowed: false, reason: 'Guests cannot modify timeline or keyframes.' };
  }
  if (acl.canvasMember?.role === 'viewer' || !canUserCreateLayer(acl.user, acl.canvasMember)) {
    return { allowed: false, reason: 'Viewers cannot modify timeline or keyframes.' };
  }
  return { allowed: true };
}

export function toPluginLayerInfo(
  layer: LayerModel,
  layers: LayerModel[],
  acl: PluginAclContext,
): PluginLayerInfo {
  const maskLayer = layers.find((l) => l.layerType === 'mask' && l.parentId === layer.id);
  const canEdit = canPluginEditLayerPixels(layer, layers, acl).allowed;
  const canManage =
    canPluginManageLayerAction(layer, 'modify_props', acl).allowed &&
    canPluginManageLayerAction(layer, 'delete', acl).allowed;

  return {
    id: layer.id,
    parentId: layer.parentId ?? null,
    name: layer.name,
    layerType:
      layer.layerType === 'folder' || layer.layerType === 'group'
        ? 'group'
        : layer.layerType === 'vector' || layer.layerType === 'text' || layer.layerType === 'mask'
          ? layer.layerType
          : 'raster',
    blendMode: layer.blendMode,
    opacity: layer.opacity,
    isVisible: layer.isVisible,
    isLocked: layer.isLocked,
    alphaLocked: Boolean(layer.alphaLocked),
    clipToBelow: Boolean(layer.clipToBelow),
    sortOrder: layer.sortOrder,
    isOwnedByMe: Boolean(acl.user && layer.ownerId === acl.user.id),
    canEditPixels: canEdit,
    canManage,
    maskLayerId: maskLayer ? maskLayer.id : null,
  };
}

interface StagedTile {
  col: number;
  row: number;
  width: number;
  height: number;
  before: Uint8Array; // premultiplied RGBA
  staged: Uint8Array; // premultiplied RGBA
}

interface DeletedLayerRecord {
  model: LayerModel;
  tiles: TileData[];
  belowId: string | null;
  aboveId: string | null;
}

function tileKey(col: number, row: number): string {
  return `${col}_${row}`;
}

function isAllZero(data: Uint8Array): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return false;
  }
  return true;
}

function checkNoParentCycle(layers: LayerModel[], layerId: string, newParentId: string | null): void {
  if (!newParentId) return;
  if (newParentId === layerId) throw new Error('Cannot set a layer as its own parent.');
  const byId = new Map(layers.map((l) => [l.id, l]));
  const parent = byId.get(newParentId);
  if (!parent || parent.layerType !== 'group') {
    throw new Error('parentId must reference an existing group layer.');
  }
  let cur: LayerModel | undefined = parent;
  const visited = new Set<string>([layerId]);
  while (cur) {
    if (visited.has(cur.id)) throw new Error('Circular parent hierarchy is not allowed.');
    visited.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
}

export interface PluginTransactionOptions {
  pluginId?: string;
  groupId?: string;
}

export class PluginCanvasTransaction {
  readonly groupId: string;
  private readonly pluginId: string;
  private readonly tileSize: number;
  private readonly cols: number;
  private readonly rows: number;

  private readonly stagedTiles = new Map<string, Map<string, StagedTile>>();
  private readonly previewAppliedLayers = new Set<string>();
  private readonly createdLayers = new Map<string, LayerModel>();
  private readonly createdOrder: string[] = [];
  private readonly updatedOriginals = new Map<string, Partial<LayerModel>>();
  private readonly metaUndoRecords = new Map<string, { before: LayerMeta | null; after: LayerMeta | null }>();
  private initialSortOrder: string[] | null = null;
  private readonly deletedLayers: DeletedLayerRecord[] = [];
  private selectionBeforeSnapshot: SelectionSnapshot | null | undefined = undefined;
  private selectionModified = false;
  private timelineBefore: {
    currentFrame?: number;
    loop?: boolean;
    range?: { start: number; end: number } | null;
  } = {};
  private readonly easingUndoLog: Array<{
    id: string;
    prev: { pluginId: string; label: string; bezier: [number, number, number, number] } | null;
  }> = [];
  private closed = false;

  constructor(private readonly adapter: PluginCanvasHostAdapter, options?: PluginTransactionOptions) {
    this.pluginId = options?.pluginId || 'plugin';
    this.groupId = options?.groupId || `plugin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.tileSize = adapter.tileSize ?? DEFAULT_TILE_SIZE;
    this.cols = Math.ceil(adapter.canvasWidth / this.tileSize);
    this.rows = Math.ceil(adapter.canvasHeight / this.tileSize);
  }

  /**
   * Pushes currently staged pixel edits to the canvas for live preview during custom-tool dragging
   * without committing undo entries or broadcasting network patches yet.
   * Any previewed tiles are reverted to `tile.before` if `rollback()` is called.
   */
  flushPreview(): void {
    if (this.closed) return;
    for (const [layerId, layerMap] of this.stagedTiles.entries()) {
      const tiles: TileData[] = [];
      for (const tile of layerMap.values()) {
        let changed = false;
        for (let i = 0; i < tile.staged.length; i++) {
          if (tile.staged[i] !== tile.before[i]) {
            changed = true;
            break;
          }
        }
        if (!changed) continue;
        tiles.push({
          col: tile.col,
          row: tile.row,
          width: tile.width,
          height: tile.height,
          compression: 'raw',
          data: tile.staged,
          byteLength: tile.staged.byteLength,
        });
      }
      if (tiles.length > 0) {
        this.previewAppliedLayers.add(layerId);
        this.adapter.applyLayerTiles(layerId, tiles);
      }
    }
  }

  private async updateLayerMetaTransactional(layer: LayerModel, nextMeta: LayerMeta): Promise<void> {
    const existing = this.metaUndoRecords.get(layer.id);
    if (!existing) {
      const beforeClone = layer.meta ? structuredClone(layer.meta) : null;
      this.metaUndoRecords.set(layer.id, { before: beforeClone, after: structuredClone(nextMeta) });
    } else {
      existing.after = structuredClone(nextMeta);
    }
    await this.adapter.updateLayerProps(layer.id, { meta: nextMeta });
  }

  private getAnimationFolders(): LayerModel[] {
    return this.getSortedLayers().filter(
      (l) => (l.layerType === 'group' || l.layerType === 'folder') && Boolean(l.meta?.animation),
    );
  }

  private resolveTargetAnimationFolder(folderId: unknown): LayerModel {
    const folders = this.getAnimationFolders();
    if (typeof folderId === 'string' && folderId.trim()) {
      const found = folders.find((f) => f.id === folderId.trim());
      if (!found) throw new Error(`Animation folder not found: ${folderId}`);
      return found;
    }
    if (folders.length === 0) {
      throw new Error('No animation folder found on this canvas.');
    }
    return folders[0];
  }

  private buildTimelineTracks(): PluginTimelineTrackInfo[] {
    const layers = this.getSortedLayers();
    const folders = this.getAnimationFolders();
    return folders.map((folder) => {
      const entries = celEntriesOf(layers, folder.id);
      let cursor = 0;
      const mapped = entries.map((entry) => {
        const startFrame = cursor;
        cursor += entry.hold;
        const entryLayer = layers.find((l) => l.id === entry.id);
        const canManage = entryLayer
          ? canPluginManageLayerAction(entryLayer, 'modify_props', this.adapter.acl).allowed
          : false;
        return {
          id: entry.id,
          label: entry.label,
          startFrame,
          hold: entry.hold,
          ...(entry.ref !== undefined ? { ref: entry.ref } : {}),
          ...(entry.blank ? { blank: true } : {}),
          ...(entry.mark ? { mark: entry.mark } : {}),
          ...(entry.note ? { note: entry.note } : {}),
          ownerId: entry.ownerId,
          isGroup: entry.isGroup,
          canManage,
        };
      });
      return {
        folderId: folder.id,
        name: folder.name,
        ownerId: folder.ownerId ?? null,
        shared: Boolean(folder.meta?.animation?.shared),
        canManage: canPluginManageLayerAction(folder, 'modify_props', this.adapter.acl).allowed,
        labels: normalizeTimelineLabels(folder.meta?.animation?.labels),
        entries: mapped,
      };
    });
  }

  private tileDimensions(col: number, row: number): { width: number; height: number } {
    const width = Math.min(this.tileSize, this.adapter.canvasWidth - col * this.tileSize);
    const height = Math.min(this.tileSize, this.adapter.canvasHeight - row * this.tileSize);
    return { width, height };
  }

  private async ensureStagedTile(layerId: string, col: number, row: number): Promise<StagedTile> {
    let layerMap = this.stagedTiles.get(layerId);
    if (!layerMap) {
      layerMap = new Map();
      this.stagedTiles.set(layerId, layerMap);
    }
    const key = tileKey(col, row);
    const existing = layerMap.get(key);
    if (existing) return existing;

    const { width, height } = this.tileDimensions(col, row);
    const isFreshCreated = this.createdLayers.has(layerId);
    const before = isFreshCreated
      ? new Uint8Array(width * height * 4)
      : (await this.adapter.readLayerTile(layerId, col, row)).slice();
    const staged = before.slice();
    const entry: StagedTile = { col, row, width, height, before, staged };
    layerMap.set(key, entry);
    return entry;
  }

  private captureSelectionBeforeIfNeeded() {
    if (!this.selectionModified && this.adapter.selection) {
      this.selectionBeforeSnapshot = this.adapter.selection.captureSnapshot();
      this.selectionModified = true;
    }
  }

  private getSortedLayers(): LayerModel[] {
    return [...this.adapter.getLayers()].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  private requireLayer(layerId: unknown): LayerModel {
    if (typeof layerId !== 'string' || !layerId.trim()) {
      throw new Error('Invalid layerId.');
    }
    const layer = this.adapter.getLayers().find((l) => l.id === layerId);
    if (!layer) throw new Error(`Layer not found: ${layerId}`);
    return layer;
  }

  createRpcHandler(v3Handler?: PluginRpcHandler): PluginRpcHandler {
    return async (method: PluginRpcMethod, params: unknown, buffer?: ArrayBuffer) => {
      if (this.closed) throw new Error('Plugin transaction is already closed.');
      const obj = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;

      switch (method) {
        case 'brush.get': {
          const brush = this.adapter.getBrush?.();
          if (!brush) throw new Error('Brush state is unavailable.');
          return { result: brush };
        }

        case 'brush.set': {
          if (!this.adapter.setBrush) throw new Error('Brush control is unavailable.');
          const patch = parsePluginBrushPatch(obj);
          this.adapter.setBrush(patch);
          return { result: null };
        }

        case 'layers.list': {
          const layers = this.getSortedLayers();
          return { result: layers.map((l) => toPluginLayerInfo(l, layers, this.adapter.acl)) };
        }

        case 'layers.get': {
          const layers = this.adapter.getLayers();
          const layer = typeof obj.layerId === 'string' ? layers.find((l) => l.id === obj.layerId) : undefined;
          return { result: layer ? toPluginLayerInfo(layer, layers, this.adapter.acl) : null };
        }

        case 'layers.getActive': {
          const activeId = this.adapter.getActiveLayerId();
          if (!activeId) return { result: null };
          const layers = this.adapter.getLayers();
          const layer = layers.find((l) => l.id === activeId);
          return { result: layer ? toPluginLayerInfo(layer, layers, this.adapter.acl) : null };
        }

        case 'layers.create': {
          const perm = canPluginCreateLayer(this.adapter.acl);
          if (!perm.allowed) throw new Error(perm.reason || 'Cannot create layer.');

          const name = typeof obj.name === 'string' ? obj.name.trim() : '';
          if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
            throw new Error('Invalid layer name.');
          }
          const layerType = obj.layerType === undefined ? 'raster' : obj.layerType;
          if (layerType !== 'raster' && layerType !== 'group') {
            throw new Error('layerType must be "raster" or "group".');
          }
          const blendMode = obj.blendMode === undefined ? 'normal' : String(obj.blendMode);
          if (!VALID_BLEND_MODES.has(blendMode)) {
            throw new Error(`Invalid blendMode: ${blendMode}`);
          }
          const opacity = obj.opacity === undefined ? 1 : Number(obj.opacity);
          if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
            throw new Error('Layer opacity must be between 0 and 1.');
          }
          const parentId = obj.parentId === undefined || obj.parentId === null ? null : String(obj.parentId);
          if (parentId !== null) {
            const parent = this.adapter.getLayers().find((l) => l.id === parentId);
            if (!parent || parent.layerType !== 'group') {
              throw new Error('parentId must reference an existing group layer.');
            }
          }
          const aboveLayerId =
            obj.aboveLayerId === undefined || obj.aboveLayerId === null ? null : String(obj.aboveLayerId);
          if (aboveLayerId !== null && !this.adapter.getLayers().some((l) => l.id === aboveLayerId)) {
            throw new Error(`aboveLayerId not found: ${aboveLayerId}`);
          }
          const select = obj.select === true;

          const created = await this.adapter.createLayer({
            name,
            layerType,
            blendMode: blendMode as BlendMode,
            opacity,
            parentId,
            aboveLayerId,
            select,
          });
          if (!created) throw new Error('Failed to create layer.');

          this.createdLayers.set(created.id, created);
          this.createdOrder.push(created.id);

          const layers = this.adapter.getLayers();
          const refreshed = layers.find((l) => l.id === created.id) ?? created;
          return { result: toPluginLayerInfo(refreshed, layers, this.adapter.acl) };
        }

        case 'layers.update': {
          const layer = this.requireLayer(obj.layerId);
          const perm = canPluginManageLayerAction(layer, 'modify_props', this.adapter.acl);
          if (!perm.allowed) throw new Error(perm.reason || 'No permission to update layer.');

          const rawPatch = obj.patch;
          if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
            throw new Error('Expected patch object.');
          }
          const patchObj = rawPatch as Record<string, unknown>;
          const keys = Object.keys(patchObj);
          if (keys.length === 0) throw new Error('Patch cannot be empty.');
          for (const key of keys) {
            if (!ALLOWED_LAYER_UPDATE_KEYS.has(key)) {
              throw new Error(`Disallowed layer property in plugin update: ${key}`);
            }
          }

          const cleanPatch: Partial<LayerModel> = {};
          if (patchObj.name !== undefined) {
            const name = typeof patchObj.name === 'string' ? patchObj.name.trim() : '';
            if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
              throw new Error('Invalid layer name.');
            }
            cleanPatch.name = name;
          }
          if (patchObj.isVisible !== undefined) {
            if (typeof patchObj.isVisible !== 'boolean') throw new Error('isVisible must be boolean.');
            cleanPatch.isVisible = patchObj.isVisible;
          }
          if (patchObj.opacity !== undefined) {
            if (typeof patchObj.opacity !== 'number' || !Number.isFinite(patchObj.opacity) || patchObj.opacity < 0 || patchObj.opacity > 1) {
              throw new Error('opacity must be between 0 and 1.');
            }
            cleanPatch.opacity = patchObj.opacity;
          }
          if (patchObj.blendMode !== undefined) {
            if (typeof patchObj.blendMode !== 'string' || !VALID_BLEND_MODES.has(patchObj.blendMode)) {
              throw new Error(`Invalid blendMode: ${String(patchObj.blendMode)}`);
            }
            cleanPatch.blendMode = patchObj.blendMode as BlendMode;
          }
          if (patchObj.alphaLocked !== undefined) {
            if (typeof patchObj.alphaLocked !== 'boolean') throw new Error('alphaLocked must be boolean.');
            cleanPatch.alphaLocked = patchObj.alphaLocked;
          }
          if (patchObj.clipToBelow !== undefined) {
            if (typeof patchObj.clipToBelow !== 'boolean') throw new Error('clipToBelow must be boolean.');
            cleanPatch.clipToBelow = patchObj.clipToBelow;
          }

          if (!this.createdLayers.has(layer.id) && !this.updatedOriginals.has(layer.id)) {
            this.updatedOriginals.set(layer.id, {
              name: layer.name,
              isVisible: layer.isVisible,
              opacity: layer.opacity,
              blendMode: layer.blendMode,
              alphaLocked: layer.alphaLocked,
              clipToBelow: layer.clipToBelow,
            });
          }

          await this.adapter.updateLayerProps(layer.id, cleanPatch);
          const layers = this.adapter.getLayers();
          const updated = layers.find((l) => l.id === layer.id) ?? { ...layer, ...cleanPatch };
          return { result: toPluginLayerInfo(updated, layers, this.adapter.acl) };
        }

        case 'layers.reorder': {
          const layer = this.requireLayer(obj.layerId);
          if (layer.layerType === 'mask') throw new Error('Mask layers cannot be reordered independently.');
          const perm = canPluginManageLayerAction(layer, 'reorder', this.adapter.acl);
          if (!perm.allowed) throw new Error(perm.reason || 'No permission to reorder layer.');

          const layers = this.getSortedLayers();
          const nonMasks = layers.filter((l) => l.layerType !== 'mask');
          if (!this.initialSortOrder) {
            this.initialSortOrder = nonMasks.map((l) => l.id);
          }

          const hasParentPatch = Object.prototype.hasOwnProperty.call(obj, 'parentId');
          const nextParentId = hasParentPatch
            ? obj.parentId === null || obj.parentId === undefined
              ? null
              : String(obj.parentId)
            : undefined;
          if (hasParentPatch) {
            checkNoParentCycle(layers, layer.id, nextParentId ?? null);
            if (!this.createdLayers.has(layer.id) && !this.updatedOriginals.has(layer.id)) {
              this.updatedOriginals.set(layer.id, { parentId: layer.parentId });
            } else if (this.updatedOriginals.has(layer.id) && !('parentId' in this.updatedOriginals.get(layer.id)!)) {
              this.updatedOriginals.get(layer.id)!.parentId = layer.parentId;
            }
          }

          const ids = nonMasks.map((l) => l.id).filter((id) => id !== layer.id);
          const aboveLayerId =
            obj.aboveLayerId === undefined || obj.aboveLayerId === null ? null : String(obj.aboveLayerId);
          if (aboveLayerId === null) {
            ids.unshift(layer.id);
          } else {
            const idx = ids.indexOf(aboveLayerId);
            if (idx < 0) throw new Error(`aboveLayerId not found: ${aboveLayerId}`);
            ids.splice(idx + 1, 0, layer.id);
          }

          await this.adapter.reorderLayers(layer.id, ids, nextParentId);
          return { result: null };
        }

        case 'layers.delete': {
          const layer = this.requireLayer(obj.layerId);
          const perm = canPluginManageLayerAction(layer, 'delete', this.adapter.acl);
          if (!perm.allowed) throw new Error(perm.reason || 'No permission to delete layer.');

          const wasCreatedHere = this.createdLayers.has(layer.id);
          let snapshotTiles: TileData[] = [];
          let belowId: string | null = null;
          let aboveId: string | null = null;

          if (!wasCreatedHere) {
            const sorted = this.getSortedLayers().filter((l) => l.layerType !== 'mask');
            const idx = sorted.findIndex((l) => l.id === layer.id);
            belowId = idx > 0 ? sorted[idx - 1].id : null;
            aboveId = idx >= 0 && idx + 1 < sorted.length ? sorted[idx + 1].id : null;

            if (layer.layerType !== 'group') {
              const occupied = this.adapter.getOccupiedTiles(layer.id);
              const coords: TileCoord[] = occupied ?? [];
              if (!occupied) {
                for (let row = 0; row < this.rows; row++) {
                  for (let col = 0; col < this.cols; col++) coords.push({ col, row });
                }
              }
              for (const { col, row } of coords) {
                const staged = this.stagedTiles.get(layer.id)?.get(tileKey(col, row));
                const raw = staged ? staged.before : await this.adapter.readLayerTile(layer.id, col, row);
                if (!isAllZero(raw)) {
                  const { width, height } = this.tileDimensions(col, row);
                  snapshotTiles.push({
                    col,
                    row,
                    width,
                    height,
                    compression: 'raw',
                    data: raw.slice(),
                    byteLength: raw.byteLength,
                  });
                }
              }
            }
          }

          const ok = await this.adapter.deleteLayer(layer.id, { keepContents: true });
          if (!ok) throw new Error('Failed to delete layer.');

          if (wasCreatedHere) {
            this.createdLayers.delete(layer.id);
            const idx = this.createdOrder.indexOf(layer.id);
            if (idx >= 0) this.createdOrder.splice(idx, 1);
          } else {
            this.deletedLayers.push({ model: { ...layer }, tiles: snapshotTiles, belowId, aboveId });
          }
          this.stagedTiles.delete(layer.id);
          return { result: null };
        }

        case 'layers.setActive': {
          const layer = this.requireLayer(obj.layerId);
          this.adapter.setActiveLayer(layer.id);
          return { result: null };
        }

        case 'pixels.getNonEmptyBounds': {
          const layer = this.requireLayer(obj.layerId);
          if (layer.layerType === 'group') return { result: null };

          const stagedMap = this.stagedTiles.get(layer.id);
          const occupied = this.createdLayers.has(layer.id)
            ? []
            : this.adapter.getOccupiedTiles(layer.id);

          const coordMap = new Map<string, TileCoord>();
          if (occupied === null) {
            for (let row = 0; row < this.rows; row++) {
              for (let col = 0; col < this.cols; col++) {
                coordMap.set(tileKey(col, row), { col, row });
              }
            }
          } else {
            for (const c of occupied) coordMap.set(tileKey(c.col, c.row), c);
          }
          if (stagedMap) {
            for (const t of stagedMap.values()) {
              coordMap.set(tileKey(t.col, t.row), { col: t.col, row: t.row });
            }
          }

          let minX = Infinity;
          let minY = Infinity;
          let maxX = -1;
          let maxY = -1;

          for (const { col, row } of coordMap.values()) {
            const staged = stagedMap?.get(tileKey(col, row));
            const px = staged ? staged.staged : await this.adapter.readLayerTile(layer.id, col, row);
            const { width, height } = this.tileDimensions(col, row);
            const tx = col * this.tileSize;
            const ty = row * this.tileSize;
            for (let y = 0; y < height; y++) {
              const rowOffset = y * width * 4;
              for (let x = 0; x < width; x++) {
                if (px[rowOffset + x * 4 + 3] !== 0) {
                  const gx = tx + x;
                  const gy = ty + y;
                  if (gx < minX) minX = gx;
                  if (gy < minY) minY = gy;
                  if (gx > maxX) maxX = gx;
                  if (gy > maxY) maxY = gy;
                }
              }
            }
          }

          if (maxX < minX || maxY < minY) return { result: null };
          return {
            result: {
              x: minX,
              y: minY,
              width: maxX - minX + 1,
              height: maxY - minY + 1,
            } satisfies PluginRect,
          };
        }

        case 'pixels.read': {
          const layer = this.requireLayer(obj.layerId);
          if (layer.layerType === 'group') {
            throw new Error('Cannot read pixels from a group layer.');
          }
          const rect = parsePluginRect(obj.rect, this.adapter.canvasWidth, this.adapter.canvasHeight);
          const stagedMap = this.stagedTiles.get(layer.id);

          let premul: Uint8Array;
          if (!stagedMap || stagedMap.size === 0) {
            premul = this.createdLayers.has(layer.id)
              ? new Uint8Array(rect.width * rect.height * 4)
              : await this.adapter.readLayerRect(layer.id, rect);
          } else {
            premul = new Uint8Array(rect.width * rect.height * 4);
            const colStart = Math.floor(rect.x / this.tileSize);
            const colEnd = Math.floor((rect.x + rect.width - 1) / this.tileSize);
            const rowStart = Math.floor(rect.y / this.tileSize);
            const rowEnd = Math.floor((rect.y + rect.height - 1) / this.tileSize);

            for (let row = rowStart; row <= rowEnd; row++) {
              for (let col = colStart; col <= colEnd; col++) {
                const tx = col * this.tileSize;
                const ty = row * this.tileSize;
                const ix0 = Math.max(rect.x, tx);
                const iy0 = Math.max(rect.y, ty);
                const ix1 = Math.min(rect.x + rect.width, tx + this.tileSize);
                const iy1 = Math.min(rect.y + rect.height, ty + this.tileSize);
                const sw = ix1 - ix0;
                const sh = iy1 - iy0;
                const staged = stagedMap.get(tileKey(col, row));
                const tilePx = staged
                  ? staged.staged
                  : this.createdLayers.has(layer.id)
                    ? new Uint8Array(this.tileDimensions(col, row).width * this.tileDimensions(col, row).height * 4)
                    : await this.adapter.readLayerTile(layer.id, col, row);
                const tileW = this.tileDimensions(col, row).width;
                for (let ry = 0; ry < sh; ry++) {
                  const srcOff = ((iy0 - ty + ry) * tileW + (ix0 - tx)) * 4;
                  const dstOff = ((iy0 - rect.y + ry) * rect.width + (ix0 - rect.x)) * 4;
                  premul.set(tilePx.subarray(srcOff, srcOff + sw * 4), dstOff);
                }
              }
            }
          }

          const straight = premultipliedToStraight(premul);
          return {
            result: rect,
            buffer: straight.buffer.slice(straight.byteOffset, straight.byteOffset + straight.byteLength) as ArrayBuffer,
          };
        }

        case 'pixels.readComposite': {
          const rect = parsePluginRect(obj.rect, this.adapter.canvasWidth, this.adapter.canvasHeight);
          const opts = (obj.opts && typeof obj.opts === 'object' ? obj.opts : {}) as { includeBackground?: unknown };
          const premul = await this.adapter.readCompositeRect(rect, opts.includeBackground === true);
          const straight = premultipliedToStraight(premul);
          return {
            result: rect,
            buffer: straight.buffer.slice(straight.byteOffset, straight.byteOffset + straight.byteLength) as ArrayBuffer,
          };
        }

        case 'pixels.write': {
          const layer = this.requireLayer(obj.layerId);
          const perm = canPluginEditLayerPixels(layer, this.adapter.getLayers(), this.adapter.acl);
          if (!perm.allowed) throw new Error(perm.reason || 'No pixel edit permission on this layer.');

          const patchObj = (obj.patch && typeof obj.patch === 'object' ? obj.patch : null) as Record<string, unknown> | null;
          if (!patchObj) throw new Error('Expected patch object.');
          const rect = parsePluginRect(patchObj, this.adapter.canvasWidth, this.adapter.canvasHeight);
          if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== rect.width * rect.height * 4) {
            throw new Error(`Expected RGBA Uint8Array of length ${rect.width * rect.height * 4}.`);
          }

          const srcStraight = new Uint8Array(buffer);
          const respectAlphaLock = patchObj.respectAlphaLock !== false && Boolean(layer.alphaLocked);
          const respectSelection = patchObj.respectSelection !== false;
          const selMask = respectSelection && this.adapter.selection
            ? this.adapter.selection.readMaskRect(rect)
            : null;

          const colStart = Math.floor(rect.x / this.tileSize);
          const colEnd = Math.floor((rect.x + rect.width - 1) / this.tileSize);
          const rowStart = Math.floor(rect.y / this.tileSize);
          const rowEnd = Math.floor((rect.y + rect.height - 1) / this.tileSize);

          for (let row = rowStart; row <= rowEnd; row++) {
            for (let col = colStart; col <= colEnd; col++) {
              const tile = await this.ensureStagedTile(layer.id, col, row);
              const tx = col * this.tileSize;
              const ty = row * this.tileSize;
              const ix0 = Math.max(rect.x, tx);
              const iy0 = Math.max(rect.y, ty);
              const ix1 = Math.min(rect.x + rect.width, tx + tile.width);
              const iy1 = Math.min(rect.y + rect.height, ty + tile.height);

              for (let gy = iy0; gy < iy1; gy++) {
                const sy = gy - rect.y;
                const dy = gy - ty;
                for (let gx = ix0; gx < ix1; gx++) {
                  const sx = gx - rect.x;
                  const dx = gx - tx;
                  const maskVal = selMask ? selMask[sy * rect.width + sx] : 255;
                  if (maskVal === 0) continue;

                  const sIdx = (sy * rect.width + sx) * 4;
                  const dIdx = (dy * tile.width + dx) * 4;

                  const sr = srcStraight[sIdx];
                  const sg = srcStraight[sIdx + 1];
                  const sb = srcStraight[sIdx + 2];
                  let sa = srcStraight[sIdx + 3];

                  const oldPr = tile.staged[dIdx];
                  const oldPg = tile.staged[dIdx + 1];
                  const oldPb = tile.staged[dIdx + 2];
                  const oldA = tile.staged[dIdx + 3];

                  if (respectAlphaLock) {
                    if (oldA === 0) continue;
                    sa = oldA;
                  }

                  const newK = sa / 255;
                  const newPr = Math.round(sr * newK);
                  const newPg = Math.round(sg * newK);
                  const newPb = Math.round(sb * newK);

                  if (maskVal === 255) {
                    tile.staged[dIdx] = newPr;
                    tile.staged[dIdx + 1] = newPg;
                    tile.staged[dIdx + 2] = newPb;
                    tile.staged[dIdx + 3] = sa;
                  } else {
                    const t = maskVal / 255;
                    const invT = 1 - t;
                    tile.staged[dIdx] = Math.round(oldPr * invT + newPr * t);
                    tile.staged[dIdx + 1] = Math.round(oldPg * invT + newPg * t);
                    tile.staged[dIdx + 2] = Math.round(oldPb * invT + newPb * t);
                    tile.staged[dIdx + 3] = Math.round(oldA * invT + sa * t);
                  }
                }
              }
            }
          }

          return { result: null };
        }

        // Selection RPCs (wired fully in Batch 4; validated here when selection bridge is provided)
        case 'selection.getInfo': {
          if (!this.adapter.selection) throw new Error('Selection engine is unavailable.');
          return { result: this.adapter.selection.getInfo() };
        }

        case 'selection.readMask': {
          if (!this.adapter.selection) throw new Error('Selection engine is unavailable.');
          const rect = parsePluginRect(obj.rect, this.adapter.canvasWidth, this.adapter.canvasHeight);
          const mask = this.adapter.selection.readMaskRect(rect) ?? new Uint8Array(rect.width * rect.height);
          return {
            result: rect,
            buffer: mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength) as ArrayBuffer,
          };
        }

        case 'selection.writeMask': {
          if (!this.adapter.selection) throw new Error('Selection engine is unavailable.');
          const patchObj = (obj.patch && typeof obj.patch === 'object' ? obj.patch : null) as Record<string, unknown> | null;
          if (!patchObj) throw new Error('Expected mask patch object.');
          const rect = parsePluginRect(patchObj, this.adapter.canvasWidth, this.adapter.canvasHeight);
          if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== rect.width * rect.height) {
            throw new Error(`Expected mask Uint8Array of length ${rect.width * rect.height}.`);
          }
          const mode = parseCombineMode(obj.mode);
          this.captureSelectionBeforeIfNeeded();
          this.adapter.selection.writeMaskRect(rect, new Uint8Array(buffer), mode);
          return { result: null };
        }

        case 'selection.selectRect': {
          if (!this.adapter.selection) throw new Error('Selection engine is unavailable.');
          const rect = parsePluginRect(obj.rect, this.adapter.canvasWidth, this.adapter.canvasHeight, Math.max(this.adapter.canvasWidth, this.adapter.canvasHeight));
          const mode = parseCombineMode(obj.mode);
          this.captureSelectionBeforeIfNeeded();
          this.adapter.selection.selectRect(rect, mode);
          return { result: null };
        }

        case 'selection.selectEllipse': {
          if (!this.adapter.selection) throw new Error('Selection engine is unavailable.');
          const rect = parsePluginRect(obj.rect, this.adapter.canvasWidth, this.adapter.canvasHeight, Math.max(this.adapter.canvasWidth, this.adapter.canvasHeight));
          const mode = parseCombineMode(obj.mode);
          this.captureSelectionBeforeIfNeeded();
          this.adapter.selection.selectEllipse(rect, mode);
          return { result: null };
        }

        case 'selection.selectPolygon': {
          if (!this.adapter.selection) throw new Error('Selection engine is unavailable.');
          if (!Array.isArray(obj.points) || obj.points.length < 3 || obj.points.length > PLUGIN_LIMITS.maxPolygonPoints) {
            throw new Error(`Polygon requires between 3 and ${PLUGIN_LIMITS.maxPolygonPoints} points.`);
          }
          const points = obj.points.map((pt) => {
            if (!pt || typeof pt !== 'object') throw new Error('Invalid polygon point.');
            const p = pt as { x?: unknown; y?: unknown };
            if (typeof p.x !== 'number' || !Number.isFinite(p.x) || typeof p.y !== 'number' || !Number.isFinite(p.y)) {
              throw new Error('Polygon coordinates must be finite numbers.');
            }
            return { x: p.x, y: p.y };
          });
          const mode = parseCombineMode(obj.mode);
          this.captureSelectionBeforeIfNeeded();
          this.adapter.selection.selectPolygon(points, mode);
          return { result: null };
        }

        case 'selection.clear': {
          if (!this.adapter.selection) throw new Error('Selection engine is unavailable.');
          this.captureSelectionBeforeIfNeeded();
          this.adapter.selection.clear();
          return { result: null };
        }

        case 'selection.invert': {
          if (!this.adapter.selection) throw new Error('Selection engine is unavailable.');
          this.captureSelectionBeforeIfNeeded();
          this.adapter.selection.invert();
          return { result: null };
        }

        case 'selection.expand': {
          if (!this.adapter.selection) throw new Error('Selection engine is unavailable.');
          const radius = parseSelectionRadius(obj.radius);
          this.captureSelectionBeforeIfNeeded();
          this.adapter.selection.expand(radius);
          return { result: null };
        }

        case 'selection.contract': {
          if (!this.adapter.selection) throw new Error('Selection engine is unavailable.');
          const radius = parseSelectionRadius(obj.radius);
          this.captureSelectionBeforeIfNeeded();
          this.adapter.selection.contract(radius);
          return { result: null };
        }

        case 'selection.feather': {
          if (!this.adapter.selection) throw new Error('Selection engine is unavailable.');
          const radius = parseSelectionRadius(obj.radius);
          this.captureSelectionBeforeIfNeeded();
          this.adapter.selection.feather(radius);
          return { result: null };
        }

        // ---------- v2.5 Timeline RPCs ----------
        case 'timeline.getState': {
          const tl = this.adapter.timeline;
          const tracks = this.buildTimelineTracks();
          const primaryFolder = this.getAnimationFolders()[0];
          const longestTrack = tracks.reduce(
            (max, track) => Math.max(max, track.entries.reduce((sum, e) => sum + e.hold, 0)),
            0,
          );
          const state: PluginTimelineState = {
            fps: tl ? tl.getFps() : (primaryFolder?.meta?.animation?.fps ?? 12),
            length: tl ? tl.getLength() : (primaryFolder?.meta?.animation?.length ?? Math.max(24, longestTrack)),
            currentFrame: tl ? tl.getCurrentFrame() : 0,
            isPlaying: tl ? tl.getIsPlaying() : false,
            loop: tl ? tl.getLoop() : true,
            range: tl ? tl.getRange() : null,
            tracks,
          };
          return { result: state };
        }

        case 'timeline.setFrame': {
          const check = canPluginWriteTimeline(this.adapter.acl);
          if (!check.allowed) throw new Error(check.reason || 'Not allowed to modify timeline.');
          if (!this.adapter.timeline) throw new Error('Timeline engine is unavailable.');
          const frame = Number(obj.frame);
          if (!Number.isInteger(frame) || frame < 0 || frame >= MAX_TIMELINE_FRAMES) {
            throw new Error(`Frame must be an integer between 0 and ${MAX_TIMELINE_FRAMES - 1}.`);
          }
          if (this.timelineBefore.currentFrame === undefined) {
            this.timelineBefore.currentFrame = this.adapter.timeline.getCurrentFrame();
          }
          this.adapter.timeline.setCurrentFrame(frame);
          return { result: { currentFrame: frame } };
        }

        case 'timeline.setFps': {
          const check = canPluginWriteTimeline(this.adapter.acl);
          if (!check.allowed) throw new Error(check.reason || 'Not allowed to modify timeline.');
          const fps = Number(obj.fps);
          if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
            throw new Error('FPS must be an integer between 1 and 60.');
          }
          const folder = this.resolveTargetAnimationFolder(obj.folderId);
          const perm = canPluginManageLayerAction(folder, 'modify_props', this.adapter.acl);
          if (!perm.allowed) throw new Error(perm.reason || 'Not allowed to modify this animation folder.');
          const nextAnimation: NonNullable<LayerMeta['animation']> = {
            ...(folder.meta?.animation ?? {}),
            fps,
          };
          await this.updateLayerMetaTransactional(folder, { ...(folder.meta ?? {}), animation: nextAnimation });
          return { result: { folderId: folder.id, fps } };
        }

        case 'timeline.setLength': {
          const check = canPluginWriteTimeline(this.adapter.acl);
          if (!check.allowed) throw new Error(check.reason || 'Not allowed to modify timeline.');
          const rawLen = obj.length;
          let length: number | null;
          if (rawLen === null) {
            length = null;
          } else {
            const n = Number(rawLen);
            if (!Number.isInteger(n) || n < 1 || n > MAX_TIMELINE_FRAMES) {
              throw new Error(`Timeline length must be null or an integer between 1 and ${MAX_TIMELINE_FRAMES}.`);
            }
            length = n;
          }
          const folder = this.resolveTargetAnimationFolder(obj.folderId);
          const perm = canPluginManageLayerAction(folder, 'modify_props', this.adapter.acl);
          if (!perm.allowed) throw new Error(perm.reason || 'Not allowed to modify this animation folder.');
          const nextAnimation: NonNullable<LayerMeta['animation']> = {
            fps: 12,
            ...(folder.meta?.animation ?? {}),
          };
          if (length !== null) nextAnimation.length = length;
          else delete nextAnimation.length;
          await this.updateLayerMetaTransactional(folder, { ...(folder.meta ?? {}), animation: nextAnimation });
          return { result: { folderId: folder.id, length } };
        }

        case 'timeline.setRange': {
          const check = canPluginWriteTimeline(this.adapter.acl);
          if (!check.allowed) throw new Error(check.reason || 'Not allowed to modify timeline.');
          if (!this.adapter.timeline) throw new Error('Timeline engine is unavailable.');
          let range: { start: number; end: number } | null;
          if (obj.range === null) {
            range = null;
          } else if (obj.range && typeof obj.range === 'object' && !Array.isArray(obj.range)) {
            const r = obj.range as { start?: unknown; end?: unknown };
            const start = Number(r.start);
            const end = Number(r.end);
            if (
              !Number.isInteger(start) ||
              !Number.isInteger(end) ||
              start < 0 ||
              end < start ||
              end >= MAX_TIMELINE_FRAMES
            ) {
              throw new Error(`Invalid playback range (0 <= start <= end < ${MAX_TIMELINE_FRAMES}).`);
            }
            range = { start, end };
          } else {
            throw new Error('Expected range { start, end } or null.');
          }
          if (this.timelineBefore.range === undefined) {
            this.timelineBefore.range = this.adapter.timeline.getRange();
          }
          this.adapter.timeline.setRange(range);
          return { result: { range } };
        }

        case 'timeline.setLoop': {
          const check = canPluginWriteTimeline(this.adapter.acl);
          if (!check.allowed) throw new Error(check.reason || 'Not allowed to modify timeline.');
          if (!this.adapter.timeline) throw new Error('Timeline engine is unavailable.');
          if (typeof obj.loop !== 'boolean') throw new Error('loop must be boolean.');
          if (this.timelineBefore.loop === undefined) {
            this.timelineBefore.loop = this.adapter.timeline.getLoop();
          }
          this.adapter.timeline.setLoop(obj.loop);
          return { result: { loop: obj.loop } };
        }

        case 'timeline.listLabels': {
          const folders = this.getAnimationFolders();
          if (folders.length === 0) return { result: [] };
          const folder = obj.folderId !== undefined ? this.resolveTargetAnimationFolder(obj.folderId) : folders[0];
          return { result: normalizeTimelineLabels(folder.meta?.animation?.labels) };
        }

        case 'timeline.setLabel': {
          const check = canPluginWriteTimeline(this.adapter.acl);
          if (!check.allowed) throw new Error(check.reason || 'Not allowed to modify timeline.');
          const frame = Number(obj.frame);
          if (!Number.isInteger(frame) || frame < 0 || frame >= MAX_TIMELINE_FRAMES) {
            throw new Error(`Frame must be an integer between 0 and ${MAX_TIMELINE_FRAMES - 1}.`);
          }
          if (typeof obj.text !== 'string' || /[\u0000-\u001f\u007f]/.test(obj.text)) {
            throw new Error('Label text must be a valid string.');
          }
          const folder = this.resolveTargetAnimationFolder(obj.folderId);
          const perm = canPluginManageLayerAction(folder, 'modify_props', this.adapter.acl);
          if (!perm.allowed) throw new Error(perm.reason || 'Not allowed to modify this animation folder.');
          const nextLabels = upsertTimelineLabel(folder.meta?.animation?.labels, frame, obj.text);
          if (nextLabels.length > PLUGIN_LIMITS.maxTimelineLabels) {
            throw new Error(`At most ${PLUGIN_LIMITS.maxTimelineLabels} timeline labels are allowed.`);
          }
          const nextAnimation: NonNullable<LayerMeta['animation']> = {
            fps: 12,
            ...(folder.meta?.animation ?? {}),
          };
          if (nextLabels.length > 0) nextAnimation.labels = nextLabels;
          else delete nextAnimation.labels;
          await this.updateLayerMetaTransactional(folder, { ...(folder.meta ?? {}), animation: nextAnimation });
          return { result: nextLabels };
        }

        case 'timeline.removeLabel': {
          const check = canPluginWriteTimeline(this.adapter.acl);
          if (!check.allowed) throw new Error(check.reason || 'Not allowed to modify timeline.');
          const frame = Number(obj.frame);
          if (!Number.isInteger(frame) || frame < 0 || frame >= MAX_TIMELINE_FRAMES) {
            throw new Error(`Frame must be an integer between 0 and ${MAX_TIMELINE_FRAMES - 1}.`);
          }
          const folder = this.resolveTargetAnimationFolder(obj.folderId);
          const perm = canPluginManageLayerAction(folder, 'modify_props', this.adapter.acl);
          if (!perm.allowed) throw new Error(perm.reason || 'Not allowed to modify this animation folder.');
          const nextLabels = removeTimelineLabel(folder.meta?.animation?.labels, frame);
          const nextAnimation: NonNullable<LayerMeta['animation']> = {
            fps: 12,
            ...(folder.meta?.animation ?? {}),
          };
          if (nextLabels.length > 0) nextAnimation.labels = nextLabels;
          else delete nextAnimation.labels;
          await this.updateLayerMetaTransactional(folder, { ...(folder.meta ?? {}), animation: nextAnimation });
          return { result: nextLabels };
        }

        case 'timeline.updateCel': {
          const check = canPluginWriteTimeline(this.adapter.acl);
          if (!check.allowed) throw new Error(check.reason || 'Not allowed to modify timeline.');
          const layer = this.requireLayer(obj.entryId);
          const parent = layer.parentId ? this.adapter.getLayers().find((l) => l.id === layer.parentId) : null;
          if (!parent || !parent.meta?.animation) {
            throw new Error('Target layer is not an animation cel entry.');
          }
          const perm = canPluginManageLayerAction(layer, 'modify_props', this.adapter.acl);
          if (!perm.allowed) throw new Error(perm.reason || 'Not allowed to modify this cel.');
          const cel: NonNullable<LayerMeta['cel']> = { ...(layer.meta?.cel ?? {}) };
          let touched = false;
          if (obj.hold !== undefined) {
            const hold = Number(obj.hold);
            if (!Number.isInteger(hold) || hold < 1 || hold > MAX_HOLD) {
              throw new Error(`Cel hold must be an integer between 1 and ${MAX_HOLD}.`);
            }
            if (hold > 1) cel.hold = hold;
            else delete cel.hold;
            touched = true;
          }
          if (obj.mark !== undefined) {
            if (obj.mark === null || obj.mark === '') delete cel.mark;
            else if (obj.mark === 'key' || obj.mark === 'inbetween') cel.mark = obj.mark as CelMark;
            else throw new Error('Cel mark must be "key", "inbetween", or null.');
            touched = true;
          }
          if (obj.note !== undefined) {
            if (obj.note === null || obj.note === '') {
              delete cel.note;
            } else if (typeof obj.note === 'string' && !/[\u0000-\u001f\u007f]/.test(obj.note)) {
              const cleaned = obj.note.trim().slice(0, 120);
              if (cleaned) cel.note = cleaned;
              else delete cel.note;
            } else {
              throw new Error('Cel note must be a string or null.');
            }
            touched = true;
          }
          if (!touched) throw new Error('Provide hold, mark, or note to timeline.updateCel.');
          const nextMeta: LayerMeta = { ...(layer.meta ?? {}) };
          if (Object.keys(cel).length > 0) nextMeta.cel = cel;
          else delete nextMeta.cel;
          await this.updateLayerMetaTransactional(layer, nextMeta);
          return { result: { entryId: layer.id, cel: nextMeta.cel ?? {} } };
        }

        // ---------- v2.5 Keyframes RPCs ----------
        case 'keyframes.list': {
          const layer = this.requireLayer(obj.layerId);
          const list = [...(layer.meta?.keyframes ?? [])].sort((a, b) => a.frame - b.frame);
          return { result: list };
        }

        case 'keyframes.evaluate': {
          const layer = this.requireLayer(obj.layerId);
          const frame =
            obj.frame === undefined
              ? (this.adapter.timeline?.getCurrentFrame() ?? 0)
              : Number(obj.frame);
          if (!Number.isFinite(frame) || frame < 0 || frame >= MAX_TIMELINE_FRAMES) {
            throw new Error(`Frame must be between 0 and ${MAX_TIMELINE_FRAMES - 1}.`);
          }
          const evaluated = evaluateTransformKeyframes(
            layer.meta?.keyframes,
            frame,
            this.adapter.canvasWidth / 2,
            this.adapter.canvasHeight / 2,
          );
          return { result: evaluated };
        }

        case 'keyframes.set': {
          const check = canPluginWriteTimeline(this.adapter.acl);
          if (!check.allowed) throw new Error(check.reason || 'Not allowed to modify keyframes.');
          const layer = this.requireLayer(obj.layerId);
          const perm = canPluginManageLayerAction(layer, 'modify_props', this.adapter.acl);
          if (!perm.allowed) throw new Error(perm.reason || 'Not allowed to modify keyframes on this layer.');
          const existing = layer.meta?.keyframes ?? [];
          const parsedKf = parsePluginKeyframe(
            obj.keyframe,
            existing,
            this.adapter.canvasWidth / 2,
            this.adapter.canvasHeight / 2,
          );
          const nextList = upsertTransformKeyframe(existing, parsedKf);
          if (nextList.length > PLUGIN_LIMITS.maxKeyframesPerLayer) {
            throw new Error(`At most ${PLUGIN_LIMITS.maxKeyframesPerLayer} keyframes per layer are allowed.`);
          }
          await this.updateLayerMetaTransactional(layer, { ...(layer.meta ?? {}), keyframes: nextList });
          return { result: nextList };
        }

        case 'keyframes.setBatch': {
          const check = canPluginWriteTimeline(this.adapter.acl);
          if (!check.allowed) throw new Error(check.reason || 'Not allowed to modify keyframes.');
          // Normalize either { items: [{ layerId, keyframes, replace? }] } or { layerId, keyframes, replace? }
          const rawItems = Array.isArray(obj.items)
            ? obj.items
            : obj.layerId !== undefined
              ? [{ layerId: obj.layerId, keyframes: obj.keyframes, replace: obj.replace }]
              : null;
          if (!rawItems || rawItems.length === 0) {
            throw new Error('keyframes.setBatch requires a non-empty items array or { layerId, keyframes }.');
          }
          if (rawItems.length > 64) {
            throw new Error('keyframes.setBatch accepts at most 64 layer entries per call.');
          }

          // Atomic pre-validation phase: verify EVERY layer ACL and keyframe payload BEFORE any mutation.
          const planned: Array<{ layer: LayerModel; nextKeyframes: TransformKeyframe[] }> = [];
          const plannedByLayer = new Map<string, TransformKeyframe[]>();
          for (const rawEntry of rawItems) {
            if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
              throw new Error('Each batch entry must be an object { layerId, keyframes }.');
            }
            const entry = rawEntry as { layerId?: unknown; keyframes?: unknown; replace?: unknown };
            const layer = this.requireLayer(entry.layerId);
            const perm = canPluginManageLayerAction(layer, 'modify_props', this.adapter.acl);
            if (!perm.allowed) {
              throw new Error(perm.reason || `Not allowed to modify keyframes on layer ${layer.id}; batch rejected.`);
            }
            if (!Array.isArray(entry.keyframes)) {
              throw new Error('Batch entry keyframes must be an array.');
            }
            const replace = entry.replace === true;
            let working = replace ? [] : [...(plannedByLayer.get(layer.id) ?? layer.meta?.keyframes ?? [])];
            for (const rawKf of entry.keyframes) {
              const parsed = parsePluginKeyframe(
                rawKf,
                working,
                this.adapter.canvasWidth / 2,
                this.adapter.canvasHeight / 2,
              );
              working = upsertTransformKeyframe(working, parsed);
            }
            if (working.length > PLUGIN_LIMITS.maxKeyframesPerLayer) {
              throw new Error(`At most ${PLUGIN_LIMITS.maxKeyframesPerLayer} keyframes per layer are allowed.`);
            }
            plannedByLayer.set(layer.id, working);
            planned.push({ layer, nextKeyframes: working });
          }

          // Apply phase: all ACL checks succeeded, commit every layer's keyframes
          const summary: Array<{ layerId: string; count: number }> = [];
          const seen = new Set<string>();
          for (let i = planned.length - 1; i >= 0; i--) {
            const { layer } = planned[i];
            if (seen.has(layer.id)) continue;
            seen.add(layer.id);
          }
          for (const [layerId, nextKeyframes] of plannedByLayer.entries()) {
            const latestLayer = this.requireLayer(layerId);
            await this.updateLayerMetaTransactional(latestLayer, {
              ...(latestLayer.meta ?? {}),
              keyframes: nextKeyframes,
            });
            summary.push({ layerId, count: nextKeyframes.length });
          }
          return { result: { updated: summary } };
        }

        case 'keyframes.remove': {
          const check = canPluginWriteTimeline(this.adapter.acl);
          if (!check.allowed) throw new Error(check.reason || 'Not allowed to modify keyframes.');
          const layer = this.requireLayer(obj.layerId);
          const perm = canPluginManageLayerAction(layer, 'modify_props', this.adapter.acl);
          if (!perm.allowed) throw new Error(perm.reason || 'Not allowed to modify keyframes on this layer.');
          const frame = Number(obj.frame);
          if (!Number.isInteger(frame) || frame < 0 || frame >= MAX_TIMELINE_FRAMES) {
            throw new Error(`Frame must be an integer between 0 and ${MAX_TIMELINE_FRAMES - 1}.`);
          }
          const nextList = removeTransformKeyframe(layer.meta?.keyframes ?? [], frame);
          const nextMeta: LayerMeta = { ...(layer.meta ?? {}) };
          if (nextList.length > 0) nextMeta.keyframes = nextList;
          else delete nextMeta.keyframes;
          await this.updateLayerMetaTransactional(layer, nextMeta);
          return { result: nextList };
        }

        case 'keyframes.clear': {
          const check = canPluginWriteTimeline(this.adapter.acl);
          if (!check.allowed) throw new Error(check.reason || 'Not allowed to modify keyframes.');
          const layer = this.requireLayer(obj.layerId);
          const perm = canPluginManageLayerAction(layer, 'modify_props', this.adapter.acl);
          if (!perm.allowed) throw new Error(perm.reason || 'Not allowed to modify keyframes on this layer.');
          const nextMeta: LayerMeta = { ...(layer.meta ?? {}) };
          delete nextMeta.keyframes;
          await this.updateLayerMetaTransactional(layer, nextMeta);
          return { result: [] };
        }

        // ---------- v2.5 Easing RPCs ----------
        case 'easing.listPresets': {
          return { result: listAllEasingPresets() };
        }

        case 'easing.register': {
          const check = canPluginWriteTimeline(this.adapter.acl);
          if (!check.allowed) throw new Error(check.reason || 'Not allowed to register custom easing.');
          if (typeof obj.id !== 'string' || !obj.id.trim()) {
            throw new Error('easing.register requires a valid string id.');
          }
          const bezier = validateBezierTuple(obj.bezier);
          const label = typeof obj.label === 'string' ? obj.label : obj.id;
          const prevEntry = getPluginEasing(obj.id.trim());
          const registered = registerPluginEasing(
            this.pluginId,
            obj.id,
            label,
            bezier,
            PLUGIN_LIMITS.maxCustomEasingsPerPlugin,
          );
          this.easingUndoLog.push({
            id: registered.id,
            prev: prevEntry ? { ...prevEntry, bezier: [...prevEntry.bezier] as [number, number, number, number] } : null,
          });
          return {
            result: {
              id: registered.id,
              label: registered.label,
              bezier: [...registered.bezier],
              source: 'plugin',
              pluginId: registered.pluginId,
            },
          };
        }

        case 'easing.unregister': {
          const check = canPluginWriteTimeline(this.adapter.acl);
          if (!check.allowed) throw new Error(check.reason || 'Not allowed to unregister custom easing.');
          if (typeof obj.id !== 'string' || !obj.id.trim()) {
            throw new Error('easing.unregister requires a valid string id.');
          }
          const cleanId = obj.id.trim();
          const prevEntry = getPluginEasing(cleanId);
          const removed = unregisterPluginEasing(this.pluginId, cleanId);
          if (removed && prevEntry) {
            this.easingUndoLog.push({
              id: cleanId,
              prev: { ...prevEntry, bezier: [...prevEntry.bezier] as [number, number, number, number] },
            });
          }
          return { result: { removed } };
        }

        case 'easing.evaluate': {
          const t = Number(obj.t);
          if (!Number.isFinite(t)) throw new Error('t must be a finite number.');
          let easingKind: KeyframeEasing = 'linear';
          let bezier: [number, number, number, number] | undefined;
          if (typeof obj.presetId === 'string' && obj.presetId.trim()) {
            const resolved = resolveEasingBezierById(obj.presetId.trim());
            if (!resolved) throw new Error(`Unknown easing preset: ${obj.presetId}`);
            easingKind = 'cubicBezier';
            bezier = resolved;
          } else {
            if (obj.easing !== undefined) {
              easingKind = parseEasingKind(obj.easing);
            }
            if (obj.bezier !== undefined) {
              bezier = validateBezierTuple(obj.bezier);
              if (obj.easing === undefined) easingKind = 'cubicBezier';
            }
          }
          return { result: { value: evaluateEasing(t, easingKind, bezier) } };
        }

        case 'bridge.listTools':
        case 'bridge.invoke':
        case 'mcp.serverStatus':
        case 'mcp.listServers':
        case 'mcp.listTools':
        case 'mcp.callTool': {
          if (!v3Handler) {
            throw new Error('Plugin API v3.0 desktop bridges and local MCP are unavailable in this environment.');
          }
          return v3Handler(method, params, buffer);
        }
      }
    };
  }

  /**
   * Commits all staged pixel writes and pushes grouped ScopedUndoOps (single Ctrl+Z undo).
   */
  commit(desc: string): void {
    if (this.closed) return;
    this.closed = true;

    const userId = this.adapter.acl.user?.id || 'guest';
    const now = Date.now();
    let opCounter = 0;
    const nextOpId = () => `${this.groupId}_${++opCounter}`;

    // 1. Created layers (with any staged pixels written into them)
    for (const layerId of this.createdOrder) {
      const model = this.adapter.getLayers().find((l) => l.id === layerId) ?? this.createdLayers.get(layerId);
      if (!model) continue;
      const layerMap = this.stagedTiles.get(layerId);
      const afterTiles: TileData[] = [];
      const beforeTiles: TileData[] = [];
      if (layerMap) {
        for (const tile of layerMap.values()) {
          if (!isAllZero(tile.staged)) {
            beforeTiles.push({
              col: tile.col,
              row: tile.row,
              width: tile.width,
              height: tile.height,
              compression: 'raw',
              data: tile.before,
              byteLength: tile.before.byteLength,
            });
            afterTiles.push({
              col: tile.col,
              row: tile.row,
              width: tile.width,
              height: tile.height,
              compression: 'raw',
              data: tile.staged,
              byteLength: tile.staged.byteLength,
            });
          }
        }
      }

      if (afterTiles.length > 0) {
        this.adapter.applyLayerTiles(layerId, afterTiles);
        this.adapter.commitTilePatch(layerId, afterTiles, desc, beforeTiles);
      }

      this.adapter.pushUndoOp({
        opId: nextOpId(),
        userId,
        layerId,
        opType: 'PLUGIN_LAYER_CREATE',
        groupId: this.groupId,
        beforeTiles: [],
        afterTiles,
        timestamp: now,
        desc,
        layerCreated: { model: { ...model } },
      });
    }

    // 2. Existing layers with staged pixel edits
    for (const [layerId, layerMap] of this.stagedTiles.entries()) {
      if (this.createdLayers.has(layerId)) continue;
      const beforeTiles: TileData[] = [];
      const afterTiles: TileData[] = [];
      for (const tile of layerMap.values()) {
        let changed = false;
        for (let i = 0; i < tile.staged.length; i++) {
          if (tile.staged[i] !== tile.before[i]) {
            changed = true;
            break;
          }
        }
        if (!changed) continue;
        beforeTiles.push({
          col: tile.col,
          row: tile.row,
          width: tile.width,
          height: tile.height,
          compression: 'raw',
          data: tile.before,
          byteLength: tile.before.byteLength,
        });
        afterTiles.push({
          col: tile.col,
          row: tile.row,
          width: tile.width,
          height: tile.height,
          compression: 'raw',
          data: tile.staged,
          byteLength: tile.staged.byteLength,
        });
      }

      if (afterTiles.length > 0) {
        this.adapter.applyLayerTiles(layerId, afterTiles);
        this.adapter.pushUndoOp({
          opId: nextOpId(),
          userId,
          layerId,
          opType: 'PLUGIN_PIXEL_EDIT',
          groupId: this.groupId,
          beforeTiles,
          afterTiles,
          timestamp: now,
          desc,
        });
        this.adapter.commitTilePatch(layerId, afterTiles, desc, beforeTiles);
      }
    }

    // 3. Deleted pre-existing layers
    for (const rec of this.deletedLayers) {
      this.adapter.pushUndoOp({
        opId: nextOpId(),
        userId,
        layerId: rec.model.id,
        opType: 'LAYER_DELETE',
        groupId: this.groupId,
        beforeTiles: [],
        afterTiles: [],
        timestamp: now,
        desc,
        layerRemoved: {
          model: rec.model,
          tiles: rec.tiles,
          below: rec.belowId,
          above: rec.aboveId,
        },
      });
    }

    // 4. Selection snapshot (if selection changed during the plugin run)
    if (this.selectionModified && this.adapter.selection) {
      const targetLayerId =
        this.adapter.getActiveLayerId() ?? this.adapter.getLayers()[0]?.id ?? '__selection__';
      this.adapter.pushUndoOp({
        opId: nextOpId(),
        userId,
        layerId: targetLayerId,
        opType: 'PLUGIN_SELECTION',
        groupId: this.groupId,
        beforeTiles: [],
        afterTiles: [],
        timestamp: now,
        desc,
        selectionBefore: this.selectionBeforeSnapshot ?? null,
        selectionAfter: this.adapter.selection.captureSnapshot(),
      });
    }

    // 5. Layer metadata edits (timeline settings, frame labels, cels, keyframes)
    for (const [layerId, rec] of this.metaUndoRecords.entries()) {
      if (this.createdLayers.has(layerId)) continue;
      if (this.deletedLayers.some((d) => d.model.id === layerId)) continue;
      this.adapter.pushUndoOp({
        opId: nextOpId(),
        userId,
        layerId,
        opType: 'PLUGIN_TIMELINE',
        groupId: this.groupId,
        beforeTiles: [],
        afterTiles: [],
        metaBefore: rec.before,
        metaAfter: rec.after,
        timestamp: now,
        desc,
      });
    }

    this.stagedTiles.clear();
    this.previewAppliedLayers.clear();
    this.metaUndoRecords.clear();
    this.easingUndoLog.length = 0;
    this.adapter.onTransactionCommitted?.();
  }

  /**
   * Rolls back all uncommitted pixel staging (including live tool previews),
   * created/updated/reordered/deleted layers, metadata/timeline edits, custom easings,
   * and selection changes.
   */
  async rollback(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Revert any tiles that were rendered for live preview during custom-tool dragging
    for (const layerId of this.previewAppliedLayers) {
      if (this.createdLayers.has(layerId)) continue;
      const layerMap = this.stagedTiles.get(layerId);
      if (!layerMap) continue;
      const restoreTiles: TileData[] = [];
      for (const tile of layerMap.values()) {
        restoreTiles.push({
          col: tile.col,
          row: tile.row,
          width: tile.width,
          height: tile.height,
          compression: 'raw',
          data: tile.before,
          byteLength: tile.before.byteLength,
        });
      }
      if (restoreTiles.length > 0) {
        try {
          this.adapter.applyLayerTiles(layerId, restoreTiles);
        } catch {
          // Best-effort revert
        }
      }
    }
    this.previewAppliedLayers.clear();
    // Discard all staged pixel writes
    this.stagedTiles.clear();

    // Restore timeline/keyframe metadata edits
    for (const [layerId, rec] of this.metaUndoRecords.entries()) {
      if (this.createdLayers.has(layerId)) continue;
      try {
        await this.adapter.updateLayerProps(layerId, { meta: rec.before });
      } catch {
        // Best-effort restore
      }
    }
    this.metaUndoRecords.clear();

    // Restore transient timeline state (playhead, loop, playback range)
    if (this.adapter.timeline) {
      try {
        if (this.timelineBefore.currentFrame !== undefined) {
          this.adapter.timeline.setCurrentFrame(this.timelineBefore.currentFrame);
        }
        if (this.timelineBefore.loop !== undefined) {
          this.adapter.timeline.setLoop(this.timelineBefore.loop);
        }
        if (this.timelineBefore.range !== undefined) {
          this.adapter.timeline.setRange(this.timelineBefore.range);
        }
      } catch {
        // Best-effort restore
      }
    }
    this.timelineBefore = {};

    // Restore custom easing registrations in reverse order
    for (let i = this.easingUndoLog.length - 1; i >= 0; i--) {
      const entry = this.easingUndoLog[i];
      try {
        if (entry.prev) {
          registerPluginEasing(
            entry.prev.pluginId,
            entry.id,
            entry.prev.label,
            entry.prev.bezier,
            PLUGIN_LIMITS.maxCustomEasingsPerPlugin,
          );
        } else {
          unregisterPluginEasing(this.pluginId, entry.id);
        }
      } catch {
        // Best-effort restore
      }
    }
    this.easingUndoLog.length = 0;

    // Remove newly created layers in reverse order
    for (let i = this.createdOrder.length - 1; i >= 0; i--) {
      const id = this.createdOrder[i];
      try {
        await this.adapter.deleteLayer(id, { keepContents: true });
      } catch {
        // Best-effort cleanup
      }
    }
    this.createdOrder.length = 0;
    this.createdLayers.clear();

    // Restore deleted pre-existing layers in reverse order
    for (let i = this.deletedLayers.length - 1; i >= 0; i--) {
      const rec = this.deletedLayers[i];
      try {
        await this.adapter.restoreDeletedLayer(rec.model, rec.tiles, rec.belowId);
      } catch {
        // Best-effort restore
      }
    }
    this.deletedLayers.length = 0;

    // Restore modified layer properties
    for (const [layerId, original] of this.updatedOriginals.entries()) {
      try {
        await this.adapter.updateLayerProps(layerId, original);
      } catch {
        // Best-effort restore
      }
    }
    this.updatedOriginals.clear();

    // Restore original sort order if reordered
    if (this.initialSortOrder && this.initialSortOrder.length > 0) {
      try {
        await this.adapter.reorderLayers(this.initialSortOrder[0], this.initialSortOrder);
      } catch {
        // Best-effort restore
      }
      this.initialSortOrder = null;
    }

    // Restore selection snapshot if modified
    if (this.selectionModified && this.adapter.selection) {
      this.adapter.selection.restoreSnapshot(this.selectionBeforeSnapshot ?? null);
      this.selectionModified = false;
    }
  }
}

function parseCombineMode(mode: unknown): 'replace' | 'add' | 'subtract' {
  if (mode === undefined || mode === 'replace') return 'replace';
  if (mode === 'add' || mode === 'subtract') return mode;
  throw new Error('Selection mode must be "replace", "add", or "subtract".');
}

function parseSelectionRadius(radius: unknown): number {
  if (
    typeof radius !== 'number' ||
    !Number.isInteger(radius) ||
    radius < 1 ||
    radius > PLUGIN_LIMITS.maxSelectionRadius
  ) {
    throw new Error(`Selection radius must be an integer between 1 and ${PLUGIN_LIMITS.maxSelectionRadius}.`);
  }
  return radius;
}

const VALID_EASING_KINDS = new Set<KeyframeEasing>([
  'linear',
  'easeIn',
  'easeOut',
  'easeInOut',
  'step',
  'cubicBezier',
]);

function parseEasingKind(raw: unknown): KeyframeEasing {
  if (typeof raw === 'string' && VALID_EASING_KINDS.has(raw as KeyframeEasing)) {
    return raw as KeyframeEasing;
  }
  throw new Error('Easing must be "linear", "easeIn", "easeOut", "easeInOut", "step", or "cubicBezier".');
}

function parsePluginKeyframe(
  raw: unknown,
  existing: ReadonlyArray<TransformKeyframe>,
  defaultPivotX: number,
  defaultPivotY: number,
): TransformKeyframe {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Keyframe must be an object with an integer frame.');
  }
  const obj = raw as Record<string, unknown>;
  const frame = Number(obj.frame);
  if (!Number.isInteger(frame) || frame < 0 || frame >= MAX_TIMELINE_FRAMES) {
    throw new Error(`Keyframe frame must be an integer between 0 and ${MAX_TIMELINE_FRAMES - 1}.`);
  }

  const prev = existing.find((k) => k.frame === frame);
  const fallback = prev ?? evaluateTransformKeyframes(existing, frame, defaultPivotX, defaultPivotY);

  const readNum = (key: string, fallbackVal: number, min: number, max: number): number => {
    if (obj[key] === undefined) return fallbackVal;
    const v = Number(obj[key]);
    if (!Number.isFinite(v) || v < min || v > max) {
      throw new Error(`Keyframe ${key} must be between ${min} and ${max}.`);
    }
    return v;
  };

  let easing: KeyframeEasing = prev?.easing ?? 'linear';
  let bezier: [number, number, number, number] | undefined = prev?.bezier ? [...prev.bezier] : undefined;

  if (typeof obj.presetId === 'string' && obj.presetId.trim()) {
    const resolved = resolveEasingBezierById(obj.presetId.trim());
    if (!resolved) throw new Error(`Unknown easing preset: ${obj.presetId}`);
    easing = 'cubicBezier';
    bezier = resolved;
  } else {
    if (obj.easing !== undefined) {
      easing = parseEasingKind(obj.easing);
    }
    if (obj.bezier !== undefined) {
      bezier = validateBezierTuple(obj.bezier);
      if (obj.easing === undefined) easing = 'cubicBezier';
    }
  }

  if (easing !== 'cubicBezier') {
    bezier = undefined;
  } else if (!bezier) {
    bezier = [0.42, 0, 0.58, 1];
  }

  const opacity = readNum('opacity', prev?.opacity ?? fallback.opacity ?? 1, 0, 1);

  return {
    frame,
    x: readNum('x', fallback.x, -100_000, 100_000),
    y: readNum('y', fallback.y, -100_000, 100_000),
    scaleX: readNum('scaleX', fallback.scaleX, -100, 100),
    scaleY: readNum('scaleY', fallback.scaleY, -100, 100),
    rotation: readNum('rotation', fallback.rotation, -Math.PI * 100, Math.PI * 100),
    pivotX: readNum('pivotX', fallback.pivotX, -100_000, 100_000),
    pivotY: readNum('pivotY', fallback.pivotY, -100_000, 100_000),
    opacity,
    easing,
    ...(bezier ? { bezier } : {}),
  };
}

const VALID_MIX_MODES = new Set<BrushMixMode>(['blend', 'smudge', 'dilute']);
const VALID_TEXTURE_BLEND_MODES = new Set<BrushTextureBlendMode>(['subtract', 'multiply', 'overlay']);
const VALID_DUAL_BLEND_MODES = new Set<DualBrushBlendMode>(['multiply', 'subtract', 'darken']);
const VALID_ANGLE_MODES = new Set<'direction' | 'pen' | 'fixed'>(['direction', 'pen', 'fixed']);

export function parsePluginBrushPatch(obj: Record<string, unknown>): PluginBrushPatch {
  if (obj.stabilizerLevel !== undefined) {
    throw new Error('Plugins cannot modify brush stabilizer settings.');
  }
  const patch: PluginBrushPatch = {};

  const parseHex = (key: 'color' | 'secondaryColor') => {
    if (obj[key] === undefined) return;
    const val = String(obj[key]);
    if (!/^#[0-9a-f]{6}$/i.test(val)) {
      throw new Error(`Expected a #RRGGBB color for ${key}.`);
    }
    patch[key] = val;
  };
  parseHex('color');
  parseHex('secondaryColor');

  const parseBounded = <K extends keyof PluginBrushPatch>(key: K, min: number, max: number) => {
    if (obj[key as string] === undefined) return;
    const v = Number(obj[key as string]);
    if (!Number.isFinite(v) || v < min || v > max) {
      throw new Error(`Brush ${String(key)} must be between ${min} and ${max}.`);
    }
    patch[key] = v as PluginBrushPatch[K];
  };

  parseBounded('size', 1, 1000);
  parseBounded('minSize', 0, 1);
  parseBounded('opacity', 0, 1);
  parseBounded('flow', 0.01, 1);
  parseBounded('hardness', 0, 1);
  parseBounded('spacing', 0.02, 1.5);
  parseBounded('scatter', 0, 3);
  parseBounded('roundness', 0.1, 1);
  parseBounded('tipAngle', -360, 360);
  parseBounded('tiltSize', 0, 1);
  parseBounded('colorMixing', 0, 1);
  parseBounded('paintAmount', 0, 1);
  parseBounded('colorStretch', 0, 1);
  parseBounded('fgBgMix', 0, 1);
  parseBounded('hueJitter', 0, 1);
  parseBounded('satJitter', 0, 1);
  parseBounded('valJitter', 0, 1);
  parseBounded('textureDensity', 0, 1);
  parseBounded('textureScale', 0.5, 4);
  parseBounded('dualSize', 0.1, 1);
  parseBounded('dualScatter', 0, 2);

  const parseBool = <K extends 'wetEdges' | 'textureInvert' | 'dualBrush'>(key: K) => {
    if (obj[key] === undefined) return;
    if (typeof obj[key] !== 'boolean') {
      throw new Error(`Brush ${key} must be boolean.`);
    }
    patch[key] = obj[key] as boolean;
  };
  parseBool('wetEdges');
  parseBool('textureInvert');
  parseBool('dualBrush');

  if (obj.mixMode !== undefined) {
    if (typeof obj.mixMode !== 'string' || !VALID_MIX_MODES.has(obj.mixMode as BrushMixMode)) {
      throw new Error('Brush mixMode must be "blend", "smudge", or "dilute".');
    }
    patch.mixMode = obj.mixMode as BrushMixMode;
  }
  if (obj.textureBlendMode !== undefined) {
    if (
      typeof obj.textureBlendMode !== 'string' ||
      !VALID_TEXTURE_BLEND_MODES.has(obj.textureBlendMode as BrushTextureBlendMode)
    ) {
      throw new Error('Brush textureBlendMode must be "subtract", "multiply", or "overlay".');
    }
    patch.textureBlendMode = obj.textureBlendMode as BrushTextureBlendMode;
  }
  if (obj.dualBlendMode !== undefined) {
    if (
      typeof obj.dualBlendMode !== 'string' ||
      !VALID_DUAL_BLEND_MODES.has(obj.dualBlendMode as DualBrushBlendMode)
    ) {
      throw new Error('Brush dualBlendMode must be "multiply", "subtract", or "darken".');
    }
    patch.dualBlendMode = obj.dualBlendMode as DualBrushBlendMode;
  }
  if (obj.angleMode !== undefined) {
    if (
      typeof obj.angleMode !== 'string' ||
      !VALID_ANGLE_MODES.has(obj.angleMode as 'direction' | 'pen' | 'fixed')
    ) {
      throw new Error('Brush angleMode must be "direction", "pen", or "fixed".');
    }
    patch.angleMode = obj.angleMode as 'direction' | 'pen' | 'fixed';
  }
  if (obj.dynamics !== undefined) {
    if (!obj.dynamics || typeof obj.dynamics !== 'object' || Array.isArray(obj.dynamics)) {
      throw new Error('Brush dynamics must be an object.');
    }
    const normalized = normalizeBrushDynamics(obj.dynamics as Partial<BrushDynamicsConfig>);
    if (normalized) patch.dynamics = normalized;
  }

  if (Object.keys(patch).length === 0) {
    throw new Error('Provide at least one valid brush property to brush.set.');
  }
  return patch;
}
