import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, sqlite } from '../db';
import { layers, layerPermissions, users } from '../db/schema';
import { getCanvasById } from './canvas.service';
import {
  CreateLayerDto,
  LayerMeta,
  LayerModel,
  LayerPermissionModel,
  SetLayerPermissionDto,
  UpdateLayerDto,
} from '@atelier/shared';

function clampOpacity(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

const MAX_META_BYTES = 32 * 1024;

/** meta arrives from clients: a plain object of bounded size, or null to clear it */
function serializeMeta(meta: unknown): string | null {
  if (meta === null) return null;
  if (typeof meta !== 'object' || Array.isArray(meta)) throw new Error('meta 必須是物件');
  const json = JSON.stringify(meta);
  if (json.length > MAX_META_BYTES) throw new Error('meta 太大（上限 32KB）');
  return json;
}

function parseMeta(json: string | null | undefined): LayerMeta | null {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Permissions on a mask are its layer's: whoever may paint the layer may paint its mask */
export function getAclLayer(layer: LayerModel): LayerModel {
  const target = layer.layerType === 'mask' && layer.parentId ? getLayerById(layer.parentId) : null;
  if (!target) return layer;
  // A group has no pixels, but its mask does: painted under the group's ownership, lock and ACL
  return target.layerType === 'group' ? { ...target, layerType: 'raster' } : target;
}

export function ensureUserExists(userId: string) {
  if (!userId) return;
  const existing = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!existing) {
    try {
      db.insert(users)
        .values({
          id: userId,
          username: userId,
          displayName: userId.startsWith('guest_') ? `訪客 ${userId.slice(-4)}` : userId,
          passwordHash: 'guest_hash',
          serverRole: 'member',
          isActive: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .onConflictDoNothing()
        .run();
    } catch (e) {
      console.warn('[ensureUserExists] Failed to insert stub user:', e);
    }
  }
}

export function getLayersByCanvasId(canvasId: string): LayerModel[] {
  const rows = db
    .select({
      layer: layers,
      ownerDisplayName: users.displayName,
    })
    .from(layers)
    .leftJoin(users, eq(layers.ownerId, users.id))
    .where(eq(layers.canvasId, canvasId))
    .orderBy(layers.sortOrder)
    .all();

  return rows.map(({ layer: r, ownerDisplayName }) => ({
    id: r.id,
    canvasId: r.canvasId,
    parentId: r.parentId,
    ownerId: r.ownerId ? r.ownerId : null,
    ownerDisplayName: ownerDisplayName ?? null,
    name: r.name,
    layerType: r.layerType as any,
    blendMode: r.blendMode,
    opacity: r.opacity,
    isVisible: Boolean(r.isVisible),
    isLocked: Boolean(r.isLocked),
    alphaLocked: Boolean(r.alphaLocked),
    clipToBelow: Boolean(r.clipToBelow),
    screentoneEnabled: Boolean(r.screentoneEnabled),
    screentoneLpi: r.screentoneLpi ?? 40,
    screentoneAngle: r.screentoneAngle ?? 45,
    screentoneDotScale: r.screentoneDotScale ?? 1.0,
    sortOrder: r.sortOrder,
    aclMode: r.aclMode as any,
    isPublic: Boolean(r.isPublic),
    meta: parseMeta(r.meta),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export function getLayerById(layerId: string): LayerModel | null {
  const row = db
    .select({
      layer: layers,
      ownerDisplayName: users.displayName,
    })
    .from(layers)
    .leftJoin(users, eq(layers.ownerId, users.id))
    .where(eq(layers.id, layerId))
    .get();

  if (!row) return null;
  const { layer: r, ownerDisplayName } = row;
  return {
    id: r.id,
    canvasId: r.canvasId,
    parentId: r.parentId,
    ownerId: r.ownerId ? r.ownerId : null,
    ownerDisplayName: ownerDisplayName ?? null,
    name: r.name,
    layerType: r.layerType as any,
    blendMode: r.blendMode,
    opacity: r.opacity,
    isVisible: Boolean(r.isVisible),
    isLocked: Boolean(r.isLocked),
    alphaLocked: Boolean(r.alphaLocked),
    clipToBelow: Boolean(r.clipToBelow),
    screentoneEnabled: Boolean(r.screentoneEnabled),
    screentoneLpi: r.screentoneLpi ?? 40,
    screentoneAngle: r.screentoneAngle ?? 45,
    screentoneDotScale: r.screentoneDotScale ?? 1.0,
    sortOrder: r.sortOrder,
    aclMode: r.aclMode as any,
    isPublic: Boolean(r.isPublic),
    meta: parseMeta(r.meta),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function createLayer(
  canvasId: string,
  userId: string,
  dto: CreateLayerDto
): LayerModel {
  ensureUserExists(userId);
  const id = crypto.randomUUID();
  const now = Date.now();
  const meta = dto.meta === undefined ? null : serializeMeta(dto.meta);

  if (dto.layerType === 'mask') {
    const target = dto.parentId ? getLayerById(dto.parentId) : null;
    // Layers and groups (a group mask hides everything inside it) take a mask; masks do not
    if (!target || target.canvasId !== canvasId || target.layerType === 'mask') {
      throw new Error('蒙版必須加在同一張畫布的圖層或圖層組上');
    }
    if (getLayersByCanvasId(canvasId).some((l) => l.layerType === 'mask' && l.parentId === target.id)) {
      throw new Error('此圖層已經有蒙版');
    }
  }

  // Find sort_order: if dto.aboveLayerId is provided, place directly above that layer
  const existingLayers = getLayersByCanvasId(canvasId).sort((a, b) => a.sortOrder - b.sortOrder);
  let computedSortOrder: number;

  // Directly below a layer = directly above the one under it (the very bottom: everything moves up)
  const belowIdx = dto.belowLayerId ? existingLayers.findIndex((l) => l.id === dto.belowLayerId) : -1;
  if (belowIdx > 0) dto = { ...dto, aboveLayerId: existingLayers[belowIdx - 1].id };
  if (dto.sortOrder !== undefined) {
    computedSortOrder = dto.sortOrder;
  } else if (belowIdx === 0) {
    computedSortOrder = existingLayers[0].sortOrder;
    for (const l of existingLayers) {
      db.update(layers).set({ sortOrder: l.sortOrder + 10, updatedAt: now }).where(eq(layers.id, l.id)).run();
    }
  } else if (dto.aboveLayerId) {
    const targetIdx = existingLayers.findIndex((l) => l.id === dto.aboveLayerId);
    if (targetIdx !== -1) {
      const target = existingLayers[targetIdx];
      computedSortOrder = target.sortOrder + 5;
      // Shift all layers above target to maintain clean sorting
      for (let i = targetIdx + 1; i < existingLayers.length; i++) {
        db.update(layers)
          .set({ sortOrder: existingLayers[i].sortOrder + 10, updatedAt: now })
          .where(eq(layers.id, existingLayers[i].id))
          .run();
      }
    } else {
      const maxOrder = existingLayers.length > 0 ? Math.max(...existingLayers.map((l) => l.sortOrder)) : -1;
      computedSortOrder = maxOrder + 10;
    }
  } else {
    const maxOrder = existingLayers.length > 0 ? Math.max(...existingLayers.map((l) => l.sortOrder)) : -1;
    computedSortOrder = maxOrder + 10;
  }

  const newLayer = {
    id,
    canvasId,
    parentId: dto.parentId || null,
    ownerId: userId,
    name: (typeof dto.name === 'string' && dto.name.trim()) || `圖層 ${existingLayers.length + 1}`,
    layerType: dto.layerType || 'raster',
    blendMode: dto.blendMode || 'normal',
    opacity: dto.opacity !== undefined ? clampOpacity(dto.opacity) : 1.0,
    isVisible: 1,
    isLocked: 0,
    alphaLocked: 0,
    clipToBelow: 0,
    screentoneEnabled: dto.screentoneEnabled ? 1 : 0,
    screentoneLpi: dto.screentoneLpi ?? 40,
    screentoneAngle: dto.screentoneAngle ?? 45,
    screentoneDotScale: dto.screentoneDotScale ?? 1.0,
    sortOrder: computedSortOrder,
    aclMode: dto.aclMode || 'owner_only',
    isPublic: dto.isPublic ? 1 : 0,
    meta,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(layers).values(newLayer).run();
  // A new layer in a group joins its content (made above the group's row, it becomes its top layer)
  tidyLayerTree(canvasId);
  return getLayerById(id)!;
}

export function updateLayer(layerId: string, dto: UpdateLayerDto): LayerModel {
  const existing = getLayerById(layerId);
  if (!existing) throw new Error('圖層不存在');

  const updates: Record<string, any> = {
    updatedAt: Date.now(),
  };

  if (dto.parentId) {
    const parent = getLayerById(dto.parentId);
    if (!parent || parent.canvasId !== existing.canvasId || parent.id === layerId || (existing.layerType !== 'mask' && parent.layerType !== 'group')) {
      throw new Error('無效的父圖層');
    }
    // A group cannot go inside its own content
    for (let p: LayerModel | null = parent, depth = 0; p && depth < 64; p = p.parentId ? getLayerById(p.parentId) : null, depth++) {
      if (p.id === layerId) throw new Error('圖層組不能放進自己裡面');
    }
  }

  if (typeof dto.name === 'string' && dto.name.trim()) updates.name = dto.name.trim();
  if (dto.blendMode !== undefined) updates.blendMode = dto.blendMode;
  if (dto.opacity !== undefined) updates.opacity = clampOpacity(dto.opacity);
  if (dto.isVisible !== undefined) updates.isVisible = dto.isVisible ? 1 : 0;
  if (dto.isLocked !== undefined) updates.isLocked = dto.isLocked ? 1 : 0;
  if (dto.alphaLocked !== undefined) updates.alphaLocked = dto.alphaLocked ? 1 : 0;
  if (dto.clipToBelow !== undefined) updates.clipToBelow = dto.clipToBelow ? 1 : 0;
  if (dto.screentoneEnabled !== undefined) updates.screentoneEnabled = dto.screentoneEnabled ? 1 : 0;
  if (dto.screentoneLpi !== undefined) updates.screentoneLpi = dto.screentoneLpi;
  if (dto.screentoneAngle !== undefined) updates.screentoneAngle = dto.screentoneAngle;
  if (dto.screentoneDotScale !== undefined) updates.screentoneDotScale = dto.screentoneDotScale;
  if (dto.sortOrder !== undefined) updates.sortOrder = dto.sortOrder;
  if (dto.parentId !== undefined) updates.parentId = dto.parentId;
  if (dto.aclMode !== undefined) updates.aclMode = dto.aclMode;
  if (dto.isPublic !== undefined) updates.isPublic = dto.isPublic ? 1 : 0;
  if (dto.meta !== undefined) updates.meta = serializeMeta(dto.meta);
  // Rasterize: a text layer becomes plain pixels and drops its editable source
  if (dto.layerType === 'raster' && existing.layerType === 'text') {
    updates.layerType = 'raster';
    updates.meta = null;
  }

  db.update(layers).set(updates).where(eq(layers.id, layerId)).run();
  // Into / out of a group: the layer (a group: with its content) moves to its new place in the list
  if ((dto.parentId !== undefined && (dto.parentId || null) !== (existing.parentId || null)) || dto.sortOrder !== undefined) {
    tidyLayerTree(existing.canvasId);
  }
  return getLayerById(layerId)!;
}

export function releaseLayer(
  canvasId: string,
  layerId: string,
  userId: string,
  isAdmin: boolean = false
): LayerModel {
  const layer = getLayerById(layerId);
  if (!layer || layer.canvasId !== canvasId) throw new Error('圖層不存在');
  const canvas = getCanvasById(canvasId);
  const isRoomHost = canvas?.ownerId === userId;

  if (!isAdmin && !isRoomHost && layer.ownerId && layer.ownerId !== userId) {
    throw new Error('只有圖層擁有者或房主可以釋放此圖層');
  }

  db.update(layers)
    .set({
      ownerId: null,
      isPublic: 1,
      updatedAt: Date.now(),
    })
    .where(eq(layers.id, layerId))
    .run();

  return getLayerById(layerId)!;
}

export function claimLayer(
  canvasId: string,
  layerId: string,
  userId: string,
  force: boolean = false,
  isAdmin: boolean = false
): LayerModel {
  const layer = getLayerById(layerId);
  if (!layer || layer.canvasId !== canvasId) throw new Error('圖層不存在');

  if (force) {
    if (!isAdmin) {
      throw new Error('只有管理員可以強制接管此圖層');
    }
  } else {
    // If layer has an owner and is not public, non-owner non-admin cannot claim
    if (layer.ownerId && !layer.isPublic && layer.ownerId !== userId && !isAdmin) {
      throw new Error('此圖層尚未開放拿取');
    }
  }

  ensureUserExists(userId);

  db.update(layers)
    .set({
      ownerId: userId,
      isPublic: 0,
      updatedAt: Date.now(),
    })
    .where(eq(layers.id, layerId))
    .run();

  return getLayerById(layerId)!;
}

/**
 * Transfer layer to a specific player
 * Any owner can give their layer to another player.
 * Admins can force-transfer any player's layer to another player.
 */
export function transferLayer(
  canvasId: string,
  layerId: string,
  targetUserId: string,
  operatorUserId: string,
  isAdmin: boolean = false
): LayerModel {
  // Never mint a stub account here: an arbitrary targetUserId would squat that username forever
  if (!db.select({ id: users.id }).from(users).where(eq(users.id, targetUserId)).get()) {
    throw new Error('目標使用者不存在或為未登入訪客，無法轉交圖層');
  }
  const layer = getLayerById(layerId);
  if (!layer || layer.canvasId !== canvasId) throw new Error('圖層不存在');
  const canvas = getCanvasById(canvasId);
  const isRoomHost = canvas?.ownerId === operatorUserId;

  if (!isAdmin && !isRoomHost && layer.ownerId && layer.ownerId !== operatorUserId) {
    throw new Error('只有圖層擁有者、房主或管理員可以轉交此圖層');
  }

  db.update(layers)
    .set({
      ownerId: targetUserId,
      isPublic: 0,
      updatedAt: Date.now(),
    })
    .where(eq(layers.id, layerId))
    .run();

  return getLayerById(layerId)!;
}

export function reorderLayersList(
  canvasId: string,
  orderedLayerIds: string[], // ascending: layerIds[0] is bottom (lowest sortOrder), layerIds[last] is top
  userId: string,
  isAdmin: boolean = false
): LayerModel[] {
  const currentLayers = getLayersByCanvasId(canvasId);
  const layerMap = new Map(currentLayers.map((l) => [l.id, l]));

  for (let i = 0; i < orderedLayerIds.length; i++) {
    const id = orderedLayerIds[i];
    const layer = layerMap.get(id);
    if (!layer) continue;
    const newOrder = (i + 1) * 10;
    if (layer.sortOrder !== newOrder) {
      db.update(layers)
        .set({
          sortOrder: newOrder,
          updatedAt: Date.now(),
        })
        .where(eq(layers.id, id))
        .run();
    }
  }

  tidyLayerTree(canvasId);
  return getLayersByCanvasId(canvasId);
}

export function reorderLayer(
  canvasId: string,
  layerId: string,
  newSortOrder: number,
  userId: string,
  isAdmin: boolean = false
): LayerModel {
  const allLayers = getLayersByCanvasId(canvasId);
  const target = allLayers.find((l) => l.id === layerId);
  if (!target || target.canvasId !== canvasId) throw new Error('圖層不存在');

  if (!isAdmin && target.ownerId && target.ownerId !== userId && !target.isPublic) {
    throw new Error('非圖層擁有者無法移動該圖層');
  }

  // Robust array reordering: remove target, insert at target index, re-index clean 10-multiples
  const remaining = allLayers.filter((l) => l.id !== layerId);
  let insertIndex = remaining.findIndex((l) => l.sortOrder >= newSortOrder);
  if (insertIndex === -1) {
    insertIndex = remaining.length;
  }
  remaining.splice(insertIndex, 0, target);

  for (let i = 0; i < remaining.length; i++) {
    const l = remaining[i];
    const cleanOrder = (i + 1) * 10;
    db.update(layers)
      .set({
        sortOrder: cleanOrder,
        updatedAt: Date.now(),
      })
      .where(eq(layers.id, l.id))
      .run();
  }

  tidyLayerTree(canvasId);
  return getLayerById(layerId)!;
}

/**
 * Deletes a layer; its mask goes with it. A group takes everything inside it along (nested groups
 * too), except layers `mayDelete` refuses (other painters' or locked ones): those move up out of
 * it, whole, into the deleted group's parent. Without `withContents` a group's content just moves
 * up. Returns what was deleted and what moved up.
 */
export function deleteLayer(
  layerId: string,
  opts: { withContents?: boolean; mayDelete?: (layer: LayerModel) => boolean } = {}
): { deleted: string[]; lifted: string[] } {
  const target = getLayerById(layerId);
  if (!target) return { deleted: [], lifted: [] };
  const all = getLayersByCanvasId(target.canvasId);
  const childrenOf = new Map<string, LayerModel[]>();
  for (const l of all) {
    if (l.layerType === 'mask' || !l.parentId) continue;
    const list = childrenOf.get(l.parentId) ?? [];
    list.push(l);
    childrenOf.set(l.parentId, list);
  }
  const deleted = [target.id];
  const lifted: string[] = [];
  const seen = new Set(deleted);
  const walk = (groupId: string) => {
    for (const child of childrenOf.get(groupId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if (opts.withContents && (!opts.mayDelete || opts.mayDelete(child))) {
        deleted.push(child.id);
        walk(child.id);
      } else {
        lifted.push(child.id); // kept whole, with its own content
      }
    }
  };
  if (target.layerType === 'group') walk(target.id);

  sqlite.transaction(() => {
    const now = Date.now();
    for (const id of lifted) db.update(layers).set({ parentId: target.parentId ?? null, updatedAt: now }).where(eq(layers.id, id)).run();
    for (const id of deleted) {
      db.delete(layers).where(and(eq(layers.parentId, id), eq(layers.layerType, 'mask'))).run();
      db.delete(layers).where(eq(layers.id, id)).run();
    }
  })();
  tidyLayerTree(target.canvasId);
  return { deleted, lifted };
}

/**
 * Compositing is one flat order, the layer panel shows it as a tree: this keeps them the same.
 * Every group sits right above its own content (its children keep their order, each followed by
 * their own content), a mask sits right above its layer, and a parent that no longer exists is
 * cleared. Siblings keep their order (a group's place is its own row's). Writes only when
 * something was out of place; returns whether it did.
 */
export function tidyLayerTree(canvasId: string): boolean {
  const all = getLayersByCanvasId(canvasId);
  const byId = new Map(all.map((l) => [l.id, l]));
  const byOrder = (a: LayerModel, b: LayerModel) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const orphans: string[] = [];
  const parentOf = new Map<string, string | null>();
  for (const l of all) {
    if (l.layerType === 'mask') continue;
    const parent = l.parentId ? byId.get(l.parentId) : undefined;
    if (l.parentId && !parent) orphans.push(l.id);
    parentOf.set(l.id, parent?.layerType === 'group' ? parent.id : null);
  }
  // A parent chain that loops back to a layer is cut at that layer
  for (const l of all) {
    if (l.layerType === 'mask') continue;
    const seen = new Set<string>();
    for (let p = parentOf.get(l.id) ?? null; p; p = parentOf.get(p) ?? null) {
      if (p === l.id) {
        parentOf.set(l.id, null);
        break;
      }
      if (seen.has(p)) break;
      seen.add(p);
    }
  }
  const children = new Map<string | null, LayerModel[]>();
  const masksOf = new Map<string, LayerModel[]>();
  const strayMasks: LayerModel[] = [];
  for (const l of all) {
    if (l.layerType === 'mask') {
      const owner = l.parentId ? byId.get(l.parentId) : undefined;
      if (owner && owner.layerType !== 'mask') masksOf.set(owner.id, [...(masksOf.get(owner.id) ?? []), l]);
      else strayMasks.push(l);
      continue;
    }
    const key = parentOf.get(l.id) ?? null;
    children.set(key, [...(children.get(key) ?? []), l]);
  }
  const order: LayerModel[] = [...strayMasks];
  const emit = (l: LayerModel) => {
    if (l.layerType === 'group') for (const c of (children.get(l.id) ?? []).sort(byOrder)) emit(c);
    order.push(l);
    for (const m of masksOf.get(l.id) ?? []) order.push(m);
  };
  for (const root of (children.get(null) ?? []).sort(byOrder)) emit(root);

  const current = [...all].sort(byOrder);
  const moved = order.length !== current.length || order.some((l, i) => l.id !== current[i].id);
  if (!moved && orphans.length === 0) return false;
  sqlite.transaction(() => {
    const now = Date.now();
    for (const id of orphans) db.update(layers).set({ parentId: null, updatedAt: now }).where(eq(layers.id, id)).run();
    if (!moved) return;
    order.forEach((l, i) => {
      if (l.sortOrder !== (i + 1) * 10) db.update(layers).set({ sortOrder: (i + 1) * 10, updatedAt: now }).where(eq(layers.id, l.id)).run();
    });
  })();
  return true;
}

export function getLayerPermissions(layerId: string): LayerPermissionModel[] {
  const rows = db.select().from(layerPermissions).where(eq(layerPermissions.layerId, layerId)).all();
  return rows.map((r) => ({
    layerId: r.layerId,
    userId: r.userId,
    canDraw: Boolean(r.canDraw),
    canErase: Boolean(r.canErase),
    canFilter: Boolean(r.canFilter),
    canModifyProps: Boolean(r.canModifyProps),
  }));
}

export function getLayerPermissionForUser(
  layerId: string,
  userId: string
): LayerPermissionModel | null {
  const r = db
    .select()
    .from(layerPermissions)
    .where(and(eq(layerPermissions.layerId, layerId), eq(layerPermissions.userId, userId)))
    .get();
  if (!r) return null;
  return {
    layerId: r.layerId,
    userId: r.userId,
    canDraw: Boolean(r.canDraw),
    canErase: Boolean(r.canErase),
    canFilter: Boolean(r.canFilter),
    canModifyProps: Boolean(r.canModifyProps),
  };
}

export function setLayerPermission(
  layerId: string,
  dto: SetLayerPermissionDto
): LayerPermissionModel {
  const existing = getLayerPermissionForUser(layerId, dto.userId);

  if (existing) {
    db.update(layerPermissions)
      .set({
        canDraw: dto.canDraw !== undefined ? (dto.canDraw ? 1 : 0) : existing.canDraw ? 1 : 0,
        canErase: dto.canErase !== undefined ? (dto.canErase ? 1 : 0) : existing.canErase ? 1 : 0,
        canFilter: dto.canFilter !== undefined ? (dto.canFilter ? 1 : 0) : existing.canFilter ? 1 : 0,
        canModifyProps:
          dto.canModifyProps !== undefined
            ? (dto.canModifyProps ? 1 : 0)
            : existing.canModifyProps
            ? 1
            : 0,
      })
      .where(and(eq(layerPermissions.layerId, layerId), eq(layerPermissions.userId, dto.userId)))
      .run();
  } else {
    db.insert(layerPermissions).values({
      layerId,
      userId: dto.userId,
      canDraw: dto.canDraw !== undefined ? (dto.canDraw ? 1 : 0) : 1,
      canErase: dto.canErase !== undefined ? (dto.canErase ? 1 : 0) : 1,
      canFilter: dto.canFilter !== undefined ? (dto.canFilter ? 1 : 0) : 1,
      canModifyProps: dto.canModifyProps !== undefined ? (dto.canModifyProps ? 1 : 0) : 0,
    }).run();
  }

  return getLayerPermissionForUser(layerId, dto.userId)!;
}
