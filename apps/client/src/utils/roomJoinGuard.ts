import type { CanvasModel, CanvasRole, LayerModel, ServerRole } from '@atelier/shared';

// ============================================================================
// D1: 多人繪茶選房與進房競態防護（純邏輯）
// ============================================================================

export interface CanvasTargetContext {
  serverOrigin: string;
  isOfflineMode: boolean;
}

export interface CommitCanvasFetchParams {
  requestSeq: number;
  latestSeq: number;
  requestTarget: CanvasTargetContext;
  currentTarget: CanvasTargetContext;
  gatewayResolving: boolean;
}

export interface CommitGatewayResolveParams {
  resolveSeq: number;
  latestResolveSeq: number;
  requestTarget: CanvasTargetContext;
  currentTarget: CanvasTargetContext;
}

export interface ResolveTargetCanvasInput {
  canvases: ReadonlyArray<Pick<CanvasModel, 'id'>>;
  pendingGatewayCanvasId?: string | null;
  liveActiveCanvasId?: string | null;
  sharedRoomId?: string | null;
  savedCanvasId?: string | null;
}

export interface AutoSelectFallbackInput {
  showGateway: boolean;
  gatewayResolving: boolean;
  canvases: ReadonlyArray<Pick<CanvasModel, 'id'>>;
  activeCanvasId: string | null;
  pendingGatewayCanvasId?: string | null;
  sharedRoomId?: string | null;
  savedCanvasId?: string | null;
}

function isLocalCanvasId(id: string | null | undefined): boolean {
  return Boolean(id && id.startsWith('local_'));
}

/**
 * 過濾跨模式殘留的初始 activeCanvasId：
 * - 離線模式僅允許 `local_*`，排除 `?room=` 與線上 UUID
 * - 線上模式排除 `local_*` 殘留
 */
export function resolveInitialActiveCanvasId(params: {
  isOfflineMode: boolean;
  sharedRoomId?: string | null;
  savedCanvasId?: string | null;
}): string | null {
  if (params.isOfflineMode) {
    return isLocalCanvasId(params.savedCanvasId) ? params.savedCanvasId! : null;
  }
  if (params.sharedRoomId && !isLocalCanvasId(params.sharedRoomId)) {
    return params.sharedRoomId;
  }
  if (params.savedCanvasId && !isLocalCanvasId(params.savedCanvasId)) {
    return params.savedCanvasId;
  }
  return null;
}

/** 判斷 fetchCanvases 回應是否仍為最新世代且未遭大廳切房鎖定 */
export function shouldCommitCanvasFetch(params: CommitCanvasFetchParams): boolean {
  if (params.requestSeq !== params.latestSeq) return false;
  if (params.gatewayResolving) return false;
  return (
    params.requestTarget.serverOrigin === params.currentTarget.serverOrigin &&
    params.requestTarget.isOfflineMode === params.currentTarget.isOfflineMode
  );
}

/** 判斷 handleGatewayResolve 非同步結果是否仍屬最新一次大廳操作 */
export function shouldCommitGatewayResolve(params: CommitGatewayResolveParams): boolean {
  if (params.resolveSeq !== params.latestResolveSeq) return false;
  return (
    params.requestTarget.serverOrigin === params.currentTarget.serverOrigin &&
    params.requestTarget.isOfflineMode === params.currentTarget.isOfflineMode
  );
}

/**
 * 嚴格依 id 解析最終應進入的房間（絕不以 title 匹配，避免同名房間進錯）：
 * 1. pendingGatewayCanvasId（大廳點選 / 繼續上次指定房）
 * 2. liveActiveCanvasId（SocketContext 即時 activeCanvasIdRef.current，絕非過期閉包）
 * 3. sharedRoomId（URL ?room=...）
 * 4. savedCanvasId（localStorage['atelier_active_canvas_id']）
 * 5. canvases[0].id（目標房確實已不存在時的優雅退回）
 */
export function resolveTargetCanvasId(input: ResolveTargetCanvasInput): string | null {
  if (input.canvases.length === 0) return null;
  const validIds = new Set(input.canvases.map((c) => c.id));
  const candidates = [
    input.pendingGatewayCanvasId,
    input.liveActiveCanvasId,
    input.sharedRoomId,
    input.savedCanvasId,
  ];
  for (const candidate of candidates) {
    if (candidate && validIds.has(candidate)) {
      return candidate;
    }
  }
  return input.canvases[0].id;
}

/**
 * 防止 useEffect([canvases, activeCanvasId]) 在大廳開啟或切換解析中蓋掉正在切換的房間；
 * 僅當不在大廳、非解析中、清單非空且目前 activeCanvasId 不在清單內時，才安全退回。
 */
export function resolveAutoSelectCanvasId(input: AutoSelectFallbackInput): string | null {
  if (input.showGateway || input.gatewayResolving) return null;
  if (input.canvases.length === 0) return null;
  if (input.activeCanvasId && input.canvases.some((c) => c.id === input.activeCanvasId)) {
    return null;
  }
  return resolveTargetCanvasId({
    canvases: input.canvases,
    pendingGatewayCanvasId: input.pendingGatewayCanvasId,
    liveActiveCanvasId: input.activeCanvasId,
    sharedRoomId: input.sharedRoomId,
    savedCanvasId: input.savedCanvasId,
  });
}

// ============================================================================
// D2: 本機畫師污染阻斷、權限判定、自動選層與引導狀態機（純邏輯）
// ============================================================================

export const LOCAL_ARTIST_USER_ID = 'local-artist';
export const BLOCKED_ONLINE_GUEST_NAMES: ReadonlySet<string> = new Set([
  '本機畫師',
  'local_artist',
  'local-artist',
]);

export interface GuardUserLike {
  id: string;
  serverRole?: ServerRole | string;
  displayName?: string | null;
}

export interface RoomMemberRoleLike {
  userId: string;
  canvasRole?: CanvasRole | string;
  role?: CanvasRole | string;
  displayName?: string | null;
}

export interface LayerDrawContext {
  user?: GuardUserLike | null;
  userId?: string | null;
  isGuest: boolean;
  isCanvasViewer: boolean;
}

export interface OwnerDisplayOptions {
  currentUserId?: string | null;
  roomMembers?: ReadonlyArray<{ userId: string; displayName: string }>;
  isOfflineCanvas?: boolean;
  labels: {
    myLayer: string;
    publicLayer: string;
    painterPrefix: string;
  };
}

export interface LayerOwnerDisplay {
  label: string;
  isOwner: boolean;
  isPublicUnclaimed: boolean;
  isSharedAll: boolean;
  wasSanitizedLocalArtist: boolean;
}

export type LayerGuidanceKind =
  | 'none'
  | 'drawable'
  | 'guest_login_required'
  | 'viewer_readonly'
  | 'switch_to_drawable'
  | 'claim_public_layer'
  | 'create_my_layer';

export type LayerGuidanceReason =
  | 'guest'
  | 'viewer'
  | 'other_owner'
  | 'public_unclaimed'
  | 'locked'
  | 'group'
  | 'no_selection';

export interface LayerGuidanceInput {
  layers: ReadonlyArray<LayerModel>;
  activeLayerId: string | null;
  user?: GuardUserLike | null;
  userId?: string | null;
  isGuest: boolean;
  isCanvasViewer: boolean;
  canCreateLayer: boolean;
}

export interface LayerGuidanceState {
  kind: LayerGuidanceKind;
  reason?: LayerGuidanceReason;
  switchTargetLayerId: string | null;
  switchTargetLayerName: string | null;
  claimTargetLayerId: string | null;
  canCreateLayer: boolean;
}

function resolveUserId(ctx: LayerDrawContext): string | null {
  return ctx.user?.id ?? ctx.userId ?? null;
}

function getSortedDescendingLayers(layers: ReadonlyArray<LayerModel>): LayerModel[] {
  return [...layers]
    .reverse()
    .sort((a, b) => (b.sortOrder ?? 0) - (a.sortOrder ?? 0));
}

export function isBlockedOnlineGuestName(rawName: string | null | undefined): boolean {
  const trimmed = rawName?.trim() ?? '';
  if (!trimmed) return false;
  return (
    BLOCKED_ONLINE_GUEST_NAMES.has(trimmed) ||
    BLOCKED_ONLINE_GUEST_NAMES.has(trimmed.toLowerCase())
  );
}

/** 阻斷 '本機畫師' / 'local_artist' / 'local-artist' 或空白流入線上訪客/開房名稱 */
export function sanitizeOnlineGuestName(
  rawName: string | null | undefined,
  fallback: string = '訪客畫師'
): string {
  const trimmed = rawName?.trim() ?? '';
  if (!trimmed || isBlockedOnlineGuestName(trimmed)) {
    return fallback;
  }
  return trimmed;
}

/** 檢查是否為離線佔位畫師 */
export function isLocalArtistUser(user: Pick<GuardUserLike, 'id'> | null | undefined): boolean {
  return Boolean(user && user.id === LOCAL_ARTIST_USER_ID);
}

/** 解析線上/離線圖層擁有者顯示名稱，於線上模式攔截殘留之「本機畫師」/ local-artist */
export function resolveLayerOwnerDisplay(
  layer: LayerModel,
  options: OwnerDisplayOptions
): LayerOwnerDisplay {
  const isOwner = Boolean(options.currentUserId && layer.ownerId === options.currentUserId);
  const isPublicUnclaimed = Boolean(layer.isPublic || !layer.ownerId);
  const isSharedAll = Boolean(!isPublicUnclaimed && layer.ownerId && layer.aclMode === 'shared_all');

  if (isPublicUnclaimed) {
    return {
      label: options.labels.publicLayer,
      isOwner: false,
      isPublicUnclaimed: true,
      isSharedAll: false,
      wasSanitizedLocalArtist: false,
    };
  }

  if (isOwner) {
    return {
      label: options.labels.myLayer,
      isOwner: true,
      isPublicUnclaimed: false,
      isSharedAll,
      wasSanitizedLocalArtist: false,
    };
  }

  const memberName =
    options.roomMembers?.find((m) => m.userId === layer.ownerId)?.displayName?.trim() ?? '';
  const layerName = layer.ownerDisplayName?.trim() ?? '';
  const origAuthor = layer.meta?.originalAuthor?.trim() ?? '';
  const suffix = `#${(layer.ownerId || '????').slice(-4)}`;
  const fallbackLabel = `${options.labels.painterPrefix} ${suffix}`;

  if (options.isOfflineCanvas) {
    return {
      label: memberName || layerName || origAuthor || fallbackLabel,
      isOwner: false,
      isPublicUnclaimed: false,
      isSharedAll,
      wasSanitizedLocalArtist: false,
    };
  }

  const ownerIsLocalArtist = layer.ownerId === LOCAL_ARTIST_USER_ID;
  let wasSanitizedLocalArtist = ownerIsLocalArtist;
  const candidates = [memberName, layerName, origAuthor];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isBlockedOnlineGuestName(candidate)) {
      wasSanitizedLocalArtist = true;
      continue;
    }
    return {
      label: candidate,
      isOwner: false,
      isPublicUnclaimed: false,
      isSharedAll,
      wasSanitizedLocalArtist,
    };
  }

  return {
    label: fallbackLabel,
    isOwner: false,
    isPublicUnclaimed: false,
    isSharedAll,
    wasSanitizedLocalArtist,
  };
}

/** 與 CanvasWorkspace.tsx:484-498 完全一致的畫布角色解析 */
export function resolveCanvasRoleForUser(
  userId: string | undefined,
  members: ReadonlyArray<RoomMemberRoleLike>,
  canvasOwnerId?: string | null
): CanvasRole | undefined {
  if (!userId) return undefined;
  const raw = members.find((m) => m.userId === userId);
  const roleRaw = raw ? raw.canvasRole ?? raw.role : undefined;
  if (roleRaw === 'owner' || roleRaw === 'admin' || roleRaw === 'editor' || roleRaw === 'viewer') {
    return roleRaw;
  }
  if (canvasOwnerId && canvasOwnerId === userId) return 'owner';
  return undefined;
}

/** 與 CanvasWorkspace.tsx:500 完全一致的 Viewer 判定（serverRole === 'admin' 豁免） */
export function isCanvasViewerForUser(params: {
  user: GuardUserLike | null | undefined;
  isGuest: boolean;
  members?: ReadonlyArray<RoomMemberRoleLike>;
  canvasOwnerId?: string | null;
}): boolean {
  if (params.isGuest || !params.user?.id || params.user.serverRole === 'admin') {
    return false;
  }
  const role = resolveCanvasRoleForUser(params.user.id, params.members ?? [], params.canvasOwnerId);
  return role === 'viewer';
}

/**
 * 與 packages/shared/src/permissions/layer-acl.ts 與 CanvasWorkspace.canEditPixels 完全一致的圖層可繪判定：
 * - 訪客 / 旁觀者 / 已鎖定 / 群組資料夾一律不可繪
 * - 蒙版（mask）委派至父圖層權限（父層若為 group 則視同 raster 套用其權限與鎖定狀態）
 * - 僅擁有者（ownerId === userId）或「已擁有者且非公開之 shared_all」（!isPublic && ownerId && aclMode === 'shared_all'）可直接繪製
 * - 不對 isAdmin 放行他人 owner_only 或未接管 isPublic 圖層
 */
export function isLayerDrawableForUser(
  layer: LayerModel | null | undefined,
  ctx: LayerDrawContext,
  allLayers?: ReadonlyArray<LayerModel>
): boolean {
  if (!layer) return false;
  if (ctx.isGuest || ctx.isCanvasViewer) return false;

  const uid = resolveUserId(ctx);
  let target: LayerModel = layer;

  if (layer.layerType === 'mask') {
    if (layer.isLocked) return false;
    const parent = layer.parentId && allLayers ? allLayers.find((l) => l.id === layer.parentId) : undefined;
    if (parent) {
      target = parent.layerType === 'group' ? { ...parent, layerType: 'raster' } : parent;
    }
  }

  if (target.isLocked || target.layerType === 'group') return false;
  if (uid && target.ownerId === uid) return true;
  if (!target.isPublic && Boolean(target.ownerId) && target.aclMode === 'shared_all') return true;
  return false;
}

/** 判斷使用者是否可接管指定公開/無主圖層 */
export function isLayerClaimableByUser(
  layer: LayerModel | null | undefined,
  ctx: LayerDrawContext
): boolean {
  if (!layer) return false;
  if (ctx.isGuest || ctx.isCanvasViewer) return false;
  const uid = resolveUserId(ctx);
  if (!uid) return false;
  if (layer.isLocked || layer.layerType === 'group' || layer.layerType === 'mask') return false;
  if (layer.ownerId === uid) return false;
  return Boolean(layer.isPublic || !layer.ownerId);
}

/** 判斷使用者是否已擁有至少一個可直接繪製的非資料夾/非蒙版未鎖圖層（修復 App.tsx:58） */
export function ownsDrawableLayerForUser(
  layers: ReadonlyArray<LayerModel>,
  ctx: LayerDrawContext
): boolean {
  if (ctx.isGuest || ctx.isCanvasViewer) return false;
  const uid = resolveUserId(ctx);
  if (!uid) return false;
  return layers.some(
    (l) =>
      l.ownerId === uid &&
      !l.isLocked &&
      l.layerType !== 'group' &&
      l.layerType !== 'mask'
  );
}

/** 判斷 fetchLayers 是否應跳過 autoAssign 自動建個人層 */
export function shouldSkipAutoAssign(params: {
  autoAssign: boolean;
  isOfflineCanvas: boolean;
  authLoading: boolean;
  layers: ReadonlyArray<LayerModel>;
  hintLayerId: string | null;
  alreadyTried: boolean;
  ctx: LayerDrawContext;
}): boolean {
  if (!params.autoAssign) return true;
  if (params.authLoading) return true;
  if (params.layers.length === 0) return true;
  if (params.ctx.isGuest || params.ctx.isCanvasViewer) return true;
  const uid = resolveUserId(params.ctx);
  if (!uid) return true;
  if (!params.isOfflineCanvas && uid === LOCAL_ARTIST_USER_ID) return true;
  if (params.hintLayerId) return true;
  if (params.alreadyTried) return true;
  if (ownsDrawableLayerForUser(params.layers, params.ctx)) return true;
  return false;
}

/**
 * 進房自動選層（排除 group/mask）：
 * 1. 仍對當前使用者可繪之有效 hintLayerId
 * 2. 自己未鎖層
 * 3. !isPublic && ownerId && shared_all 未鎖層
 * 4. 可接管 isPublic || !ownerId 未鎖層
 * 5. topUnlocked
 * 6. topFirst[0]
 */
export function pickBestInitialLayer(
  layers: ReadonlyArray<LayerModel>,
  ctx: LayerDrawContext,
  hintLayerId?: string | null
): LayerModel | null {
  if (layers.length === 0) return null;
  const topFirst = getSortedDescendingLayers(layers).filter(
    (l) => l.layerType !== 'group' && l.layerType !== 'mask'
  );
  const uid = resolveUserId(ctx);

  if (hintLayerId) {
    const hinted = topFirst.find(
      (l) => l.id === hintLayerId && isLayerDrawableForUser(l, ctx, layers)
    );
    if (hinted) return hinted;
  }

  if (!ctx.isGuest && !ctx.isCanvasViewer && uid) {
    const myUnlocked = topFirst.find((l) => l.ownerId === uid && !l.isLocked);
    if (myUnlocked) return myUnlocked;
  }

  if (!ctx.isGuest && !ctx.isCanvasViewer) {
    const sharedAll = topFirst.find(
      (l) => !l.isPublic && Boolean(l.ownerId) && l.aclMode === 'shared_all' && !l.isLocked
    );
    if (sharedAll) return sharedAll;
  }

  const claimablePublic = topFirst.find(
    (l) => (l.isPublic || !l.ownerId) && !l.isLocked
  );
  if (claimablePublic) return claimablePublic;

  const topUnlocked = topFirst.find((l) => !l.isLocked);
  if (topUnlocked) return topUnlocked;

  return topFirst[0] ?? layers[0] ?? null;
}

/** 搜尋目前使用者可直接繪製的非蒙版圖層（優先自己擁有，其次 shared_all） */
export function findDrawableLayer(
  layers: ReadonlyArray<LayerModel>,
  ctx: LayerDrawContext
): LayerModel | null {
  const uid = resolveUserId(ctx);
  const candidates = getSortedDescendingLayers(layers).filter(
    (l) => l.layerType !== 'mask' && isLayerDrawableForUser(l, ctx, layers)
  );
  if (candidates.length === 0) return null;
  if (uid) {
    const own = candidates.find((l) => l.ownerId === uid);
    if (own) return own;
  }
  return candidates[0];
}

/** 檢查場上是否至少有一層目前使用者可直接繪製的圖層（修復 LayerPanel.tsx:928） */
export function hasAnyDrawableLayerForUser(
  layers: ReadonlyArray<LayerModel>,
  ctx: LayerDrawContext
): boolean {
  return Boolean(findDrawableLayer(layers, ctx));
}

/**
 * LayerPanel 不可繪引導條狀態機（Case A–E）：
 * - 'none': layers（不含 mask）為空
 * - 'drawable': 當前選定圖層可繪，不顯示引導條
 * - 'guest_login_required' (Case A): 訪客需登入
 * - 'viewer_readonly' (Case B): 旁觀者唯讀
 * - 'claim_public_layer' (Case D): 選中可接管之公開/無主圖層（附帶可選 switchTargetLayerId）
 * - 'switch_to_drawable' (Case C): 場上有可繪圖層，引導一鍵切換
 * - 'create_my_layer' (Case E): 場上無任何可繪圖層，引導建立專屬圖層
 */
export function getLayerDrawGuidanceState(input: LayerGuidanceInput): LayerGuidanceState {
  const visibleLayers = input.layers.filter((l) => l.layerType !== 'mask');
  if (visibleLayers.length === 0) {
    return {
      kind: 'none',
      switchTargetLayerId: null,
      switchTargetLayerName: null,
      claimTargetLayerId: null,
      canCreateLayer: input.canCreateLayer,
    };
  }

  const ctx: LayerDrawContext = {
    user: input.user,
    userId: input.userId,
    isGuest: input.isGuest,
    isCanvasViewer: input.isCanvasViewer,
  };

  const rawActive = input.layers.find((l) => l.id === input.activeLayerId) ?? null;
  if (rawActive && isLayerDrawableForUser(rawActive, ctx, input.layers)) {
    return {
      kind: 'drawable',
      switchTargetLayerId: null,
      switchTargetLayerName: null,
      claimTargetLayerId: null,
      canCreateLayer: input.canCreateLayer,
    };
  }

  if (input.isGuest) {
    return {
      kind: 'guest_login_required',
      reason: 'guest',
      switchTargetLayerId: null,
      switchTargetLayerName: null,
      claimTargetLayerId: null,
      canCreateLayer: false,
    };
  }

  if (input.isCanvasViewer) {
    return {
      kind: 'viewer_readonly',
      reason: 'viewer',
      switchTargetLayerId: null,
      switchTargetLayerName: null,
      claimTargetLayerId: null,
      canCreateLayer: false,
    };
  }

  const drawableCandidate = findDrawableLayer(visibleLayers, ctx);
  const displayActive =
    (rawActive?.layerType === 'mask'
      ? visibleLayers.find((l) => l.id === rawActive.parentId)
      : rawActive) ?? null;

  let reason: LayerGuidanceReason;
  if (!displayActive) {
    reason = 'no_selection';
  } else if (rawActive?.isLocked || displayActive.isLocked) {
    reason = 'locked';
  } else if (displayActive.layerType === 'group' && rawActive?.layerType !== 'mask') {
    reason = 'group';
  } else if (displayActive.isPublic || !displayActive.ownerId) {
    reason = 'public_unclaimed';
  } else {
    reason = 'other_owner';
  }

  if (displayActive && isLayerClaimableByUser(displayActive, ctx)) {
    return {
      kind: 'claim_public_layer',
      reason: 'public_unclaimed',
      switchTargetLayerId: drawableCandidate?.id ?? null,
      switchTargetLayerName: drawableCandidate?.name ?? null,
      claimTargetLayerId: displayActive.id,
      canCreateLayer: input.canCreateLayer,
    };
  }

  if (drawableCandidate) {
    return {
      kind: 'switch_to_drawable',
      reason,
      switchTargetLayerId: drawableCandidate.id,
      switchTargetLayerName: drawableCandidate.name,
      claimTargetLayerId: null,
      canCreateLayer: input.canCreateLayer,
    };
  }

  return {
    kind: 'create_my_layer',
    reason,
    switchTargetLayerId: null,
    switchTargetLayerName: null,
    claimTargetLayerId: null,
    canCreateLayer: input.canCreateLayer,
  };
}

// ============================================================================
// D3: 單機離線畫布分頁關閉管理（非破壞性關閉，資料仍留於 IndexedDB 最近畫布）
// ============================================================================

export const CLOSED_OFFLINE_TABS_KEY = 'atelier_closed_offline_tabs';

export function parseClosedOfflineCanvasIds(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((item): item is string => typeof item === 'string' && isLocalCanvasId(item))
    );
  } catch {
    return new Set();
  }
}

export function loadClosedOfflineCanvasIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  return parseClosedOfflineCanvasIds(localStorage.getItem(CLOSED_OFFLINE_TABS_KEY));
}

export function saveClosedOfflineCanvasIds(ids: ReadonlySet<string>): void {
  if (typeof window === 'undefined') return;
  try {
    const valid = Array.from(ids).filter((id) => isLocalCanvasId(id));
    localStorage.setItem(CLOSED_OFFLINE_TABS_KEY, JSON.stringify(valid));
  } catch {
    // Ignore storage quota error
  }
}

/** 過濾出單機模式目前未關閉的畫布分頁，並自動排除非 local_* 的受污染 ID */
export function filterVisibleOfflineCanvases<T extends Pick<CanvasModel, 'id'>>(
  allCanvases: ReadonlyArray<T>,
  closedIds: ReadonlySet<string>
): T[] {
  return allCanvases.filter((c) => isLocalCanvasId(c.id) && !closedIds.has(c.id));
}

/** 關閉指定分頁後，依相鄰分頁原則（優先右方，否則左方）決定下一個作用中畫布 ID */
export function resolveNextCanvasAfterClose<T extends Pick<CanvasModel, 'id'>>(
  visibleCanvases: ReadonlyArray<T>,
  closingId: string
): string | null {
  const idx = visibleCanvases.findIndex((c) => c.id === closingId);
  if (idx === -1) return visibleCanvases[0]?.id ?? null;
  const remaining = visibleCanvases.filter((c) => c.id !== closingId);
  if (remaining.length === 0) return null;
  const nextIdx = Math.min(idx, remaining.length - 1);
  return remaining[nextIdx].id;
}
