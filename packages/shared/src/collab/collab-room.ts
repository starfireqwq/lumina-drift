export const VIEWPORT_MIN_ZOOM = 0.05;
export const VIEWPORT_MAX_ZOOM = 32;

export interface ViewportCameraState {
  /** Canvas-space X at the center of the viewport */
  centerX: number;
  /** Canvas-space Y at the center of the viewport */
  centerY: number;
  /** Physical-normalized zoom (cssZoom * displayScale) */
  zoom: number;
  /** Viewport rotation in radians */
  rotation: number;
  /** Horizontal flip */
  mirrorX?: boolean;
  updatedAt: number;
}

export interface MemberViewportPacket {
  canvasId: string;
  userId: string;
  socketId: string;
  camera: ViewportCameraState;
  activeTool?: string;
}

export interface FollowStatePacket {
  canvasId: string;
  /** targetUserId -> list of distinct follower userIds */
  followersByTarget: Record<string, string[]>;
}

export interface MemberToolUpdatePacket {
  canvasId: string;
  socketId: string;
  userId: string;
  activeTool: string;
}

export const GRID_MIN_DIM = 1;
export const GRID_MAX_DIM = 12;

export interface CanvasGridSlot {
  slotIndex: number;
  row: number;
  col: number;
  userId: string;
  displayName: string;
  color: string;
  label?: string;
  claimedAt: number;
}

export interface CanvasGridConfig {
  enabled: boolean;
  rows: number;
  cols: number;
  showLabels: boolean;
  slots: CanvasGridSlot[];
  updatedAt: number;
}

export const MAX_ROOM_SWATCHES = 128;
export const MAX_ROOM_REFERENCE_ITEMS = 24;
export const MAX_ROOM_REFERENCE_DATA_URL_BYTES = 2 * 1024 * 1024;

export interface RoomSwatch {
  id: string;
  hex: string;
  name?: string;
  addedBy: string;
  addedByName: string;
  createdAt: number;
}

export interface RoomReferenceItem {
  id: string;
  title: string;
  imageDataUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  rotation: number;
  opacity: number;
  zIndex: number;
  locked?: boolean;
  addedBy: string;
  addedByName: string;
  updatedAt: number;
}

export interface RoomReferenceBoardState {
  items: RoomReferenceItem[];
  lockedByAdmin: boolean;
  updatedAt: number;
}

export interface RoomCollabStateSnapshot {
  canvasId: string;
  grid: CanvasGridConfig;
  swatches: RoomSwatch[];
  referenceBoard: RoomReferenceBoardState;
  followersByTarget?: Record<string, string[]>;
  latestCameras?: Record<string, ViewportCameraState>;
}

export interface RoomCollabActorRole {
  serverRole?: string | null;
  canvasRole?: string | null;
  isCanvasOwner?: boolean;
  isGuest?: boolean;
}

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function canManageRoomCollab(role?: RoomCollabActorRole | null): boolean {
  if (!role || role.isGuest || role.serverRole === 'guest') return false;
  return Boolean(
    role.serverRole === 'admin' ||
      role.isCanvasOwner ||
      role.canvasRole === 'owner' ||
      role.canvasRole === 'admin'
  );
}

export function canEditRoomCollab(role?: RoomCollabActorRole | null): boolean {
  if (!role || role.isGuest || role.serverRole === 'guest') return false;
  if (role.canvasRole === 'viewer') return false;
  return true;
}

export function sanitizeViewportCamera(
  input: Partial<ViewportCameraState> | null | undefined,
  now = Date.now()
): ViewportCameraState | null {
  if (!input || typeof input !== 'object') return null;
  const centerX = Number(input.centerX);
  const centerY = Number(input.centerY);
  const zoom = Number(input.zoom);
  const rotation = Number(input.rotation ?? 0);
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY) || !Number.isFinite(zoom) || !Number.isFinite(rotation)) {
    return null;
  }
  const normalizedRot = ((rotation % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const signedRot = normalizedRot > Math.PI ? normalizedRot - Math.PI * 2 : normalizedRot;
  return {
    centerX: clampNumber(centerX, -1_000_000, 1_000_000),
    centerY: clampNumber(centerY, -1_000_000, 1_000_000),
    zoom: clampNumber(zoom, VIEWPORT_MIN_ZOOM, VIEWPORT_MAX_ZOOM),
    rotation: signedRot,
    mirrorX: Boolean(input.mirrorX),
    updatedAt: typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) ? input.updatedAt : now,
  };
}

/**
 * Converts a local CanvasViewport state (screen-dependent panX/panY + CSS zoom)
 * into a screen-independent ViewportCameraState centered on canvas coordinates.
 */
export function viewportStateToCamera(
  state: { panX: number; panY: number; zoom: number; rotation: number; mirrorX?: boolean },
  viewWidth: number,
  viewHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  displayScale = 1,
  now = Date.now()
): ViewportCameraState {
  const safeZoom = Math.max(VIEWPORT_MIN_ZOOM, Number.isFinite(state.zoom) ? state.zoom : 1);
  const safeDisplayScale = Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1;
  const rot = Number.isFinite(state.rotation) ? state.rotation : 0;
  const mirrorX = Boolean(state.mirrorX);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const dxS = viewWidth / 2 - state.panX;
  const dyS = viewHeight / 2 - state.panY;
  const rx = dxS * cos + dyS * sin;
  const ry = -dxS * sin + dyS * cos;
  const sx = mirrorX ? -safeZoom : safeZoom;
  const sy = safeZoom;
  const centerX = canvasWidth / 2 + rx / sx;
  const centerY = canvasHeight / 2 + ry / sy;
  return {
    centerX,
    centerY,
    zoom: clampNumber(safeZoom * safeDisplayScale, VIEWPORT_MIN_ZOOM, VIEWPORT_MAX_ZOOM),
    rotation: rot,
    mirrorX,
    updatedAt: now,
  };
}

/**
 * Inverse of viewportStateToCamera: maps a shared ViewportCameraState to local CanvasViewport state.
 */
export function cameraToViewportState(
  camera: ViewportCameraState,
  viewWidth: number,
  viewHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  displayScale = 1
): { panX: number; panY: number; zoom: number; rotation: number; mirrorX: boolean } {
  const safeDisplayScale = Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1;
  const zoom = clampNumber(camera.zoom / safeDisplayScale, VIEWPORT_MIN_ZOOM, VIEWPORT_MAX_ZOOM);
  const rot = Number.isFinite(camera.rotation) ? camera.rotation : 0;
  const mirrorX = Boolean(camera.mirrorX);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const dx = camera.centerX - canvasWidth / 2;
  const dy = camera.centerY - canvasHeight / 2;
  const sx = mirrorX ? -zoom : zoom;
  const sy = zoom;
  const panX = viewWidth / 2 - (dx * sx * cos - dy * sy * sin);
  const panY = viewHeight / 2 - (dx * sx * sin + dy * sy * cos);
  return { panX, panY, zoom, rotation: rot, mirrorX };
}

export function createDefaultGridConfig(now = Date.now()): CanvasGridConfig {
  return {
    enabled: false,
    rows: 2,
    cols: 2,
    showLabels: true,
    slots: [],
    updatedAt: now,
  };
}

export function getGridSlotLabel(row: number, col: number): string {
  const rowChar = String.fromCharCode(65 + clampNumber(Math.floor(row), 0, 25));
  return `${rowChar}${Math.floor(col) + 1}`;
}

export function normalizeGridConfig(
  input: Partial<CanvasGridConfig> | null | undefined,
  now = Date.now()
): CanvasGridConfig {
  if (!input || typeof input !== 'object') return createDefaultGridConfig(now);
  const rows = Math.round(clampNumber(Number(input.rows ?? 2), GRID_MIN_DIM, GRID_MAX_DIM));
  const cols = Math.round(clampNumber(Number(input.cols ?? 2), GRID_MIN_DIM, GRID_MAX_DIM));
  const total = rows * cols;
  const seen = new Set<number>();
  const slots: CanvasGridSlot[] = [];

  if (Array.isArray(input.slots)) {
    for (const raw of input.slots) {
      if (!raw || typeof raw !== 'object') continue;
      const idx = Math.floor(Number(raw.slotIndex));
      if (!Number.isFinite(idx) || idx < 0 || idx >= total || seen.has(idx)) continue;
      const userId = typeof raw.userId === 'string' ? raw.userId.trim() : '';
      if (!userId) continue;
      seen.add(idx);
      const displayName = typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim().slice(0, 64) : userId;
      const color = typeof raw.color === 'string' && raw.color.trim() ? raw.color.trim().slice(0, 32) : '#6366F1';
      const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 40) : undefined;
      slots.push({
        slotIndex: idx,
        row: Math.floor(idx / cols),
        col: idx % cols,
        userId,
        displayName,
        color,
        ...(label ? { label } : {}),
        claimedAt: typeof raw.claimedAt === 'number' && Number.isFinite(raw.claimedAt) ? raw.claimedAt : now,
      });
    }
  }

  slots.sort((a, b) => a.slotIndex - b.slotIndex);

  return {
    enabled: Boolean(input.enabled),
    rows,
    cols,
    showLabels: input.showLabels !== false,
    slots,
    updatedAt: typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) ? input.updatedAt : now,
  };
}

export function getGridSlotRect(
  config: Pick<CanvasGridConfig, 'rows' | 'cols'>,
  slotIndex: number,
  canvasWidth: number,
  canvasHeight: number
): { slotIndex: number; row: number; col: number; x: number; y: number; width: number; height: number } | null {
  const rows = Math.round(clampNumber(config.rows, GRID_MIN_DIM, GRID_MAX_DIM));
  const cols = Math.round(clampNumber(config.cols, GRID_MIN_DIM, GRID_MAX_DIM));
  const total = rows * cols;
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= total) return null;
  if (!Number.isFinite(canvasWidth) || !Number.isFinite(canvasHeight) || canvasWidth <= 0 || canvasHeight <= 0) return null;
  const row = Math.floor(slotIndex / cols);
  const col = slotIndex % cols;
  const cellW = canvasWidth / cols;
  const cellH = canvasHeight / rows;
  return {
    slotIndex,
    row,
    col,
    x: col * cellW,
    y: row * cellH,
    width: cellW,
    height: cellH,
  };
}

export function getGridSlotCamera(
  config: Pick<CanvasGridConfig, 'rows' | 'cols'>,
  slotIndex: number,
  canvasWidth: number,
  canvasHeight: number,
  viewWidth: number,
  viewHeight: number,
  displayScale = 1,
  paddingRatio = 0.84
): ViewportCameraState | null {
  const rect = getGridSlotRect(config, slotIndex, canvasWidth, canvasHeight);
  if (!rect || viewWidth <= 0 || viewHeight <= 0) return null;
  const safeDisplayScale = Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1;
  const fitCssZoom = Math.min(
    (viewWidth * paddingRatio) / Math.max(1, rect.width),
    (viewHeight * paddingRatio) / Math.max(1, rect.height)
  );
  const physicalZoom = clampNumber(fitCssZoom * safeDisplayScale, VIEWPORT_MIN_ZOOM, VIEWPORT_MAX_ZOOM);
  return {
    centerX: rect.x + rect.width / 2,
    centerY: rect.y + rect.height / 2,
    zoom: physicalZoom,
    rotation: 0,
    mirrorX: false,
    updatedAt: Date.now(),
  };
}

export function claimGridSlot(
  config: CanvasGridConfig,
  slotIndex: number,
  claimant: { userId: string; displayName: string; color: string; label?: string },
  options?: { force?: boolean; now?: number }
): { ok: boolean; reason?: 'disabled' | 'invalid_slot' | 'already_claimed'; config: CanvasGridConfig } {
  const now = options?.now ?? Date.now();
  const normalized = normalizeGridConfig(config, now);
  if (!normalized.enabled) return { ok: false, reason: 'disabled', config: normalized };
  const total = normalized.rows * normalized.cols;
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= total) {
    return { ok: false, reason: 'invalid_slot', config: normalized };
  }
  const existing = normalized.slots.find((s) => s.slotIndex === slotIndex);
  if (existing && existing.userId !== claimant.userId && !options?.force) {
    return { ok: false, reason: 'already_claimed', config: normalized };
  }
  const cleanLabel = typeof claimant.label === 'string' && claimant.label.trim() ? claimant.label.trim().slice(0, 40) : undefined;
  const nextSlot: CanvasGridSlot = {
    slotIndex,
    row: Math.floor(slotIndex / normalized.cols),
    col: slotIndex % normalized.cols,
    userId: claimant.userId,
    displayName: claimant.displayName.trim().slice(0, 64) || claimant.userId,
    color: claimant.color || '#6366F1',
    ...(cleanLabel ? { label: cleanLabel } : {}),
    claimedAt: now,
  };
  const nextSlots = [...normalized.slots.filter((s) => s.slotIndex !== slotIndex), nextSlot].sort(
    (a, b) => a.slotIndex - b.slotIndex
  );
  return {
    ok: true,
    config: {
      ...normalized,
      slots: nextSlots,
      updatedAt: now,
    },
  };
}

export function releaseGridSlot(
  config: CanvasGridConfig,
  slotIndex: number,
  actor: { userId: string; canForce?: boolean },
  now = Date.now()
): { ok: boolean; reason?: 'invalid_slot' | 'not_claimed' | 'not_owner'; config: CanvasGridConfig } {
  const normalized = normalizeGridConfig(config, now);
  const total = normalized.rows * normalized.cols;
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= total) {
    return { ok: false, reason: 'invalid_slot', config: normalized };
  }
  const existing = normalized.slots.find((s) => s.slotIndex === slotIndex);
  if (!existing) return { ok: false, reason: 'not_claimed', config: normalized };
  if (existing.userId !== actor.userId && !actor.canForce) {
    return { ok: false, reason: 'not_owner', config: normalized };
  }
  return {
    ok: true,
    config: {
      ...normalized,
      slots: normalized.slots.filter((s) => s.slotIndex !== slotIndex),
      updatedAt: now,
    },
  };
}

export function normalizeRoomHexColor(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const shortMatch = /^#?([0-9a-fA-F]{3})$/.exec(trimmed);
  if (shortMatch) {
    const [r, g, b] = shortMatch[1].split('');
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  const longMatch = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
  if (longMatch) return `#${longMatch[1]}`.toUpperCase();
  return null;
}

export function normalizeRoomSwatches(input: unknown): RoomSwatch[] {
  if (!Array.isArray(input)) return [];
  const out: RoomSwatch[] = [];
  const seenIds = new Set<string>();
  const seenHex = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Partial<RoomSwatch>;
    const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim().slice(0, 64) : '';
    const hex = typeof rec.hex === 'string' ? normalizeRoomHexColor(rec.hex) : null;
    const addedBy = typeof rec.addedBy === 'string' && rec.addedBy.trim() ? rec.addedBy.trim() : '';
    if (!id || !hex || !addedBy || seenIds.has(id) || seenHex.has(hex)) continue;
    seenIds.add(id);
    seenHex.add(hex);
    const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim().slice(0, 40) : undefined;
    out.push({
      id,
      hex,
      ...(name ? { name } : {}),
      addedBy,
      addedByName:
        typeof rec.addedByName === 'string' && rec.addedByName.trim() ? rec.addedByName.trim().slice(0, 64) : addedBy,
      createdAt: typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : Date.now(),
    });
    if (out.length >= MAX_ROOM_SWATCHES) break;
  }
  return out;
}

export function addRoomSwatch(
  list: RoomSwatch[],
  entry: { id: string; hex: string; name?: string; addedBy: string; addedByName: string; createdAt?: number }
): { ok: boolean; reason?: 'invalid_color' | 'duplicate' | 'limit_reached'; swatches: RoomSwatch[]; swatch?: RoomSwatch } {
  const normalizedList = normalizeRoomSwatches(list);
  const hex = normalizeRoomHexColor(entry.hex);
  if (!hex) return { ok: false, reason: 'invalid_color', swatches: normalizedList };
  if (normalizedList.some((s) => s.hex === hex)) {
    return { ok: false, reason: 'duplicate', swatches: normalizedList };
  }
  if (normalizedList.length >= MAX_ROOM_SWATCHES) {
    return { ok: false, reason: 'limit_reached', swatches: normalizedList };
  }
  const cleanName = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 40) : undefined;
  const swatch: RoomSwatch = {
    id: entry.id.trim().slice(0, 64),
    hex,
    ...(cleanName ? { name: cleanName } : {}),
    addedBy: entry.addedBy,
    addedByName: entry.addedByName.trim().slice(0, 64) || entry.addedBy,
    createdAt: entry.createdAt ?? Date.now(),
  };
  return { ok: true, swatches: [...normalizedList, swatch], swatch };
}

export function removeRoomSwatch(
  list: RoomSwatch[],
  swatchId: string,
  actor: { userId: string; canForce?: boolean }
): { ok: boolean; reason?: 'not_found' | 'forbidden'; swatches: RoomSwatch[] } {
  const normalizedList = normalizeRoomSwatches(list);
  const target = normalizedList.find((s) => s.id === swatchId);
  if (!target) return { ok: false, reason: 'not_found', swatches: normalizedList };
  if (target.addedBy !== actor.userId && !actor.canForce) {
    return { ok: false, reason: 'forbidden', swatches: normalizedList };
  }
  return { ok: true, swatches: normalizedList.filter((s) => s.id !== swatchId) };
}

export function createDefaultReferenceBoard(now = Date.now()): RoomReferenceBoardState {
  return {
    items: [],
    lockedByAdmin: false,
    updatedAt: now,
  };
}

export function isAllowedReferenceImageDataUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  if (url.length === 0 || url.length > MAX_ROOM_REFERENCE_DATA_URL_BYTES) return false;
  return /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(url);
}

export function normalizeReferenceItem(raw: Partial<RoomReferenceItem> | null | undefined, now = Date.now()): RoomReferenceItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 64) : '';
  if (!id || !isAllowedReferenceImageDataUrl(raw.imageDataUrl)) return null;
  const addedBy = typeof raw.addedBy === 'string' && raw.addedBy.trim() ? raw.addedBy.trim() : '';
  if (!addedBy) return null;
  return {
    id,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 80) : 'Reference',
    imageDataUrl: raw.imageDataUrl,
    x: Math.round(clampNumber(Number(raw.x ?? 16), -4000, 4000)),
    y: Math.round(clampNumber(Number(raw.y ?? 16), -4000, 4000)),
    width: Math.round(clampNumber(Number(raw.width ?? 220), 64, 2048)),
    height: Math.round(clampNumber(Number(raw.height ?? 220), 64, 2048)),
    scale: Number(clampNumber(Number(raw.scale ?? 1), 0.1, 8).toFixed(3)),
    rotation: Math.round(clampNumber(Number(raw.rotation ?? 0), -180, 180)),
    opacity: Number(clampNumber(Number(raw.opacity ?? 1), 0.1, 1).toFixed(2)),
    zIndex: Math.round(clampNumber(Number(raw.zIndex ?? 0), 0, 10000)),
    locked: Boolean(raw.locked),
    addedBy,
    addedByName:
      typeof raw.addedByName === 'string' && raw.addedByName.trim() ? raw.addedByName.trim().slice(0, 64) : addedBy,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
  };
}

export function normalizeReferenceBoard(input: unknown, now = Date.now()): RoomReferenceBoardState {
  if (!input || typeof input !== 'object') return createDefaultReferenceBoard(now);
  const rec = input as Partial<RoomReferenceBoardState>;
  const items: RoomReferenceItem[] = [];
  const seen = new Set<string>();
  if (Array.isArray(rec.items)) {
    for (const raw of rec.items) {
      const normalized = normalizeReferenceItem(raw, now);
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      items.push(normalized);
      if (items.length >= MAX_ROOM_REFERENCE_ITEMS) break;
    }
  }
  items.sort((a, b) => a.zIndex - b.zIndex || a.updatedAt - b.updatedAt);
  return {
    items,
    lockedByAdmin: Boolean(rec.lockedByAdmin),
    updatedAt: typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : now,
  };
}
