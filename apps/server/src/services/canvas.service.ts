import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { and, eq, gt, sql } from 'drizzle-orm';
import { db, sqlite } from '../db';
import { config } from '../config';
import { canvases, canvasGroups, canvasGroupMembers, canvasMembers, layers, canvasOps, canvasSnapshots } from '../db/schema';
import {
  CanvasMemberModel,
  CanvasModel,
  CanvasSnapshotBundle,
  clampDpi,
  CreateCanvasDto,
  DEFAULT_TILE_SIZE,
  UpdateCanvasDto,
} from '@atelier/shared';
import { hashPassword, verifyPassword } from './auth.service';
import { foldLayerTiles, loadLatestBundle } from './checkpoint-fold';
import { getLayersByCanvasId } from './layer.service';
import { saveSnapshot } from './snapshot.service';
import {
  listSnapshotRowsDesc,
  shiftLayerSnapshot,
  shiftLegacyOpsSince,
  shiftTextLayersMeta,
} from './canvas-resize';

const selectCanvases = () => db.select({ canvas: canvases, group: canvasGroups }).from(canvases)
  .leftJoin(canvasGroups, eq(canvases.groupId, canvasGroups.id));

const toCanvasModel = ({ canvas, group }: {
  canvas: typeof canvases.$inferSelect;
  group: typeof canvasGroups.$inferSelect | null;
}): CanvasModel => {
  const { groupId: _groupId, ...record } = canvas;
  return {
    ...record,
    accessMode: canvas.accessMode as CanvasModel['accessMode'],
    roomPassHash: group ? group.roomPassHash : canvas.roomPassHash,
    ...(group ? { group: { id: group.id, title: group.title, ownerId: group.ownerId } } : {}),
  };
};

export function listCanvases(): CanvasModel[] {
  return selectCanvases().orderBy(canvases.createdAt).all().map(toCanvasModel);
}

export function getCanvasById(canvasId: string): CanvasModel | null {
  const row = selectCanvases().where(eq(canvases.id, canvasId)).get();
  return row ? toCanvasModel(row) : null;
}

export function hasCanvasGroupAccess(groupId: string | undefined, userId: string): boolean {
  if (!groupId) return false;
  return Boolean(db.select({ groupId: canvasGroupMembers.groupId }).from(canvasGroupMembers)
    .where(and(eq(canvasGroupMembers.groupId, groupId), eq(canvasGroupMembers.userId, userId))).get());
}

export function getCanvasMembership(canvasId: string, userId: string): CanvasMemberModel | null {
  const r = db
    .select()
    .from(canvasMembers)
    .where(and(eq(canvasMembers.canvasId, canvasId), eq(canvasMembers.userId, userId)))
    .get();
  if (!r) return null;
  return {
    canvasId: r.canvasId,
    userId: r.userId,
    role: r.role as any,
    canCreateLayer: Boolean(r.canCreateLayer),
    canDeleteOtherLayer: Boolean(r.canDeleteOtherLayer),
    canExport: Boolean(r.canExport),
    canManageMembers: Boolean(r.canManageMembers),
    joinedAt: r.joinedAt,
  };
}

export async function createCanvas(userId: string, dto: CreateCanvasDto): Promise<CanvasModel> {
  const canvasId = crypto.randomUUID();
  const now = Date.now();
  const inviteCode = 'ATELIER-' + nanoid(6).toUpperCase();

  const groupTitle = dto.newGroupTitle?.trim();
  if (dto.newGroupTitle !== undefined && (!groupTitle || groupTitle.length > 80 || dto.groupId)) {
    throw new Error('請輸入 1～80 字的畫布組名稱');
  }
  if (dto.groupId && dto.roomPassword) throw new Error('組內畫布沿用畫布組的密碼');

  let roomPassHash: string | null = null;
  if (dto.roomPassword && dto.roomPassword.trim()) {
    roomPassHash = await hashPassword(dto.roomPassword.trim());
  }

  const width = dto.width || 2048;
  const height = dto.height || 2048;
  assertCanvasSize(width, height);

  const groupId = groupTitle ? crypto.randomUUID() : dto.groupId;
  return sqlite.transaction(() => {
    if (groupTitle && groupId) {
      db.insert(canvasGroups).values({ id: groupId, ownerId: userId, title: groupTitle, roomPassHash }).run();
    } else if (groupId) {
      const group = db.select({ ownerId: canvasGroups.ownerId }).from(canvasGroups).where(eq(canvasGroups.id, groupId)).get();
      if (group?.ownerId !== userId) throw new Error('只有畫布組的建立者可以在組內新增畫布');
    }

    const newCanvas = {
      id: canvasId,
      ownerId: userId,
      title: (typeof dto.title === 'string' && dto.title.trim()) || '未命名畫布',
      width,
      height,
      dpi: clampDpi(dto.dpi),
      bgColor: dto.bgColor || '#FFFFFF',
      accessMode: dto.accessMode || 'invite',
      inviteCode,
      roomPassHash: groupId ? null : roomPassHash,
      groupId,
      latestSeq: 0,
      createdAt: now,
      updatedAt: now,
    };

    db.insert(canvases).values(newCanvas).run();

    // Add creator as owner
    db.insert(canvasMembers).values({
      canvasId,
      userId,
      role: 'owner',
      canCreateLayer: 1,
      canDeleteOtherLayer: 1,
      canExport: 1,
      canManageMembers: 1,
      joinedAt: now,
    }).run();

    // Create default Background Layer
    const bgLayerId = crypto.randomUUID();
    db.insert(layers).values({
      id: bgLayerId,
      canvasId,
      ownerId: userId,
      name: '背景層 (Background)',
      layerType: 'raster',
      blendMode: 'normal',
      opacity: 1.0,
      isVisible: 1,
      isLocked: 1,
      alphaLocked: 0,
      clipToBelow: 0,
      sortOrder: 0,
      aclMode: 'shared_all',
      createdAt: now,
      updatedAt: now,
    }).run();

    // Create default Layer 1
    const layer1Id = crypto.randomUUID();
    db.insert(layers).values({
      id: layer1Id,
      canvasId,
      ownerId: userId,
      name: '圖層 1 (Layer 1)',
      layerType: 'raster',
      blendMode: 'normal',
      opacity: 1.0,
      isVisible: 1,
      isLocked: 0,
      alphaLocked: 0,
      clipToBelow: 0,
      sortOrder: 1,
      aclMode: 'shared_all',
      createdAt: now,
      updatedAt: now,
    }).run();

    return getCanvasById(canvasId)!;
  })();
}

export async function updateCanvas(
  canvasId: string,
  dto: UpdateCanvasDto
): Promise<CanvasModel> {
  const current = getCanvasById(canvasId);
  if (!current) throw new Error('畫布不存在');

  const updates: Record<string, any> = {
    updatedAt: Date.now(),
  };

  if (dto.title !== undefined) updates.title = dto.title.trim();
  if (dto.bgColor !== undefined) updates.bgColor = dto.bgColor;
  if (dto.accessMode !== undefined) updates.accessMode = dto.accessMode;
  if (dto.roomPassword !== undefined) {
    if (current.group) throw new Error('組內畫布共用畫布組的密碼');
    updates.roomPassHash = dto.roomPassword ? await hashPassword(dto.roomPassword) : null;
  }

  db.update(canvases).set(updates).where(eq(canvases.id, canvasId)).run();
  return getCanvasById(canvasId)!;
}

export function deleteCanvas(canvasId: string): void {
  // Cascade clean-up associated records to prevent foreign key errors or orphans (all or nothing)
  sqlite.transaction(() => {
    db.delete(canvasOps).where(eq(canvasOps.canvasId, canvasId)).run();
    db.delete(canvasSnapshots).where(eq(canvasSnapshots.canvasId, canvasId)).run();
    db.delete(layers).where(eq(layers.canvasId, canvasId)).run();
    db.delete(canvasMembers).where(eq(canvasMembers.canvasId, canvasId)).run();
    db.delete(canvases).where(eq(canvases.id, canvasId)).run();
  })();

  // Snapshot bundles live on disk; the id check keeps the recursive delete inside snapshotsDir
  if (/^[\w-]+$/.test(canvasId)) {
    fs.rmSync(path.join(config.snapshotsDir, canvasId), { recursive: true, force: true });
  }
}

export async function joinCanvas(
  canvasId: string,
  userId: string,
  password?: string
): Promise<CanvasMemberModel> {
  const canvas = getCanvasById(canvasId);
  if (!canvas) throw new Error('畫布不存在');

  const existingMember = getCanvasMembership(canvasId, userId);
  if (existingMember) return existingMember;

  if (canvas.roomPassHash && !hasCanvasGroupAccess(canvas.group?.id, userId)) {
    if (!password) {
      throw new Error('此畫布房間已設有密碼保護，請輸入房間密碼');
    }
    const valid = await verifyPassword(password, canvas.roomPassHash);
    if (!valid) throw new Error('畫布房間密碼錯誤');
  }

  const now = Date.now();
  sqlite.transaction(() => {
    if (canvas.group && canvas.roomPassHash) {
      db.insert(canvasGroupMembers).values({ groupId: canvas.group.id, userId }).onConflictDoNothing().run();
    }
    db.insert(canvasMembers).values({
      canvasId,
      userId,
      role: 'editor',
      canCreateLayer: 1,
      canDeleteOtherLayer: 0,
      canExport: 1,
      canManageMembers: 0,
      joinedAt: now,
    }).onConflictDoNothing().run();
  })();

  return getCanvasMembership(canvasId, userId)!;
}

export function incrementCanvasSeq(canvasId: string): number {
  db.update(canvases)
    .set({
      latestSeq: sql`${canvases.latestSeq} + 1`,
      updatedAt: Date.now(),
    })
    .where(eq(canvases.id, canvasId))
    .run();

  const c = getCanvasById(canvasId);
  return c ? c.latestSeq : 0;
}

function assertCanvasSize(width: number, height: number) {
  const ok = (n: number) => Number.isInteger(n) && n >= 64 && n <= 16384;
  if (!ok(width) || !ok(height)) {
    throw new Error('畫布尺寸必須介於 64x64 至 16384x16384 像素之間');
  }
}

export interface ResizeCanvasResult {
  canvas: CanvasModel;
  contentShifted: boolean;
  textShifted: boolean;
}

export function resizeCanvasWithShift(
  canvasId: string,
  width: number,
  height: number,
  offsetX: number = 0,
  offsetY: number = 0,
  dpi?: number
): ResizeCanvasResult {
  assertCanvasSize(width, height);
  const ox = Math.trunc(offsetX);
  const oy = Math.trunc(offsetY);
  if (!Number.isFinite(ox) || !Number.isFinite(oy)) {
    throw new Error('無效的畫布偏移量');
  }

  const prev = getCanvasById(canvasId);
  if (!prev) throw new Error('畫布不存在');
  const nextDpi = dpi !== undefined && Number.isFinite(dpi) ? clampDpi(dpi) : prev.dpi;

  const now = Date.now();
  const needsContentShift = ox !== 0 || oy !== 0 || width < prev.width || height < prev.height;
  const textShifted = needsContentShift ? shiftTextLayersMeta(canvasId, ox, oy) : false;
  let contentShifted = textShifted;

  if (needsContentShift && prev.latestSeq > 0) {
    const snapshots = listSnapshotRowsDesc(canvasId);
    const canvasLayers = getLayersByCanvasId(canvasId);
    const foldSrc = {
      snapshots,
      layers: canvasLayers.map((l) => ({ id: l.id, name: l.name })),
      opsSince: (since: number) =>
        db
          .select({ seq: canvasOps.seq, layerId: canvasOps.layerId, payloadBlob: canvasOps.payloadBlob })
          .from(canvasOps)
          .where(and(eq(canvasOps.canvasId, canvasId), gt(canvasOps.seq, since)))
          .orderBy(canvasOps.seq)
          .all(),
    };

    const folded = foldLayerTiles(foldSrc, prev.latestSeq);
    if (folded !== null) {
      const hasContent = folded.some((l) => (l.tiles?.length ?? 0) > 0 || (l.vectorStrokes?.length ?? 0) > 0);
      if (hasContent) {
        const shiftedLayers = folded.map((l) => shiftLayerSnapshot(l, ox, oy, width, height, DEFAULT_TILE_SIZE));
        const newSeq = sqlite.transaction(() => {
          db.update(canvases).set({ width, height, dpi: nextDpi, updatedAt: now }).where(eq(canvases.id, canvasId)).run();
          return incrementCanvasSeq(canvasId);
        })();
        const bundle: CanvasSnapshotBundle = {
          canvasId,
          seq: newSeq,
          tileSize: DEFAULT_TILE_SIZE,
          width,
          height,
          layers: shiftedLayers,
          createdAt: now,
          authoritative: true,
        };
        saveSnapshot(canvasId, newSeq, bundle);
        contentShifted = true;
      } else {
        db.update(canvases).set({ width, height, dpi: nextDpi, updatedAt: now }).where(eq(canvases.id, canvasId)).run();
      }
    } else {
      // Legacy fallback: canvas contains pre-tile samplePoints ops
      const base = loadLatestBundle(snapshots);
      shiftLegacyOpsSince(canvasId, base ? base.seq : 0, ox, oy, width, height);
      const newSeq = sqlite.transaction(() => {
        db.update(canvases).set({ width, height, dpi: nextDpi, updatedAt: now }).where(eq(canvases.id, canvasId)).run();
        return base ? incrementCanvasSeq(canvasId) : prev.latestSeq;
      })();
      if (base) {
        const shiftedBaseLayers = (base.bundle.layers || []).map((l) =>
          shiftLayerSnapshot(l, ox, oy, width, height, base.bundle.tileSize || DEFAULT_TILE_SIZE)
        );
        saveSnapshot(canvasId, newSeq, {
          canvasId,
          seq: newSeq,
          tileSize: base.bundle.tileSize || DEFAULT_TILE_SIZE,
          width,
          height,
          layers: shiftedBaseLayers,
          createdAt: now,
          authoritative: true,
        });
      }
      contentShifted = true;
    }
  } else {
    db.update(canvases)
      .set({
        width,
        height,
        dpi: nextDpi,
        updatedAt: now,
      })
      .where(eq(canvases.id, canvasId))
      .run();
  }

  const updated = getCanvasById(canvasId);
  if (!updated) throw new Error('畫布不存在');
  return { canvas: updated, contentShifted, textShifted };
}

export function resizeCanvas(canvasId: string, width: number, height: number): CanvasModel {
  return resizeCanvasWithShift(canvasId, width, height, 0, 0).canvas;
}
