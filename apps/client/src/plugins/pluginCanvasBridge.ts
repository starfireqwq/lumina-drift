import {
  canUserCreateLayer,
  canUserPerformLayerAction,
  DEFAULT_TILE_SIZE,
  type BlendMode,
  type CanvasMemberModel,
  type LayerModel,
  type LayerPermissionModel,
  type ScopedUndoOp,
  type SelectionSnapshot,
  type TileCoord,
  type TileData,
  type UserModel,
  type UserPayload,
} from '@atelier/shared';
import {
  PLUGIN_LIMITS,
  type PluginLayerInfo,
  type PluginRect,
} from './pluginApi';
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
  size: number;
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
  setBrush?(patch: { color?: string; size?: number }): void;
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

export class PluginCanvasTransaction {
  readonly groupId: string;
  private readonly tileSize: number;
  private readonly cols: number;
  private readonly rows: number;

  private readonly stagedTiles = new Map<string, Map<string, StagedTile>>();
  private readonly createdLayers = new Map<string, LayerModel>();
  private readonly createdOrder: string[] = [];
  private readonly updatedOriginals = new Map<string, Partial<LayerModel>>();
  private initialSortOrder: string[] | null = null;
  private readonly deletedLayers: DeletedLayerRecord[] = [];
  private selectionBeforeSnapshot: SelectionSnapshot | null | undefined = undefined;
  private selectionModified = false;
  private closed = false;

  constructor(private readonly adapter: PluginCanvasHostAdapter) {
    this.groupId = `plugin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.tileSize = adapter.tileSize ?? DEFAULT_TILE_SIZE;
    this.cols = Math.ceil(adapter.canvasWidth / this.tileSize);
    this.rows = Math.ceil(adapter.canvasHeight / this.tileSize);
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

  createRpcHandler(): PluginRpcHandler {
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
          const color = obj.color === undefined ? undefined : String(obj.color);
          if (color !== undefined && !/^#[0-9a-f]{6}$/i.test(color)) {
            throw new Error('Expected a #RRGGBB color.');
          }
          const size = obj.size === undefined ? undefined : Number(obj.size);
          if (size !== undefined && (!Number.isFinite(size) || size < 1 || size > 1000)) {
            throw new Error('Brush size must be between 1 and 1000.');
          }
          if (color === undefined && size === undefined) {
            throw new Error('Provide color or size to brush.set.');
          }
          this.adapter.setBrush({ ...(color !== undefined ? { color } : {}), ...(size !== undefined ? { size } : {}) });
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

    this.stagedTiles.clear();
    this.adapter.onTransactionCommitted?.();
  }

  /**
   * Rolls back all uncommitted pixel staging, created/updated/reordered/deleted layers, and selection changes.
   */
  async rollback(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Discard all staged pixel writes (never applied to canvas)
    this.stagedTiles.clear();

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
