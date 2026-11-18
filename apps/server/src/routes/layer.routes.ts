import { FastifyPluginAsync } from 'fastify';
import {
  canUserCreateLayer,
  canUserPerformLayerAction,
  CreateLayerDto,
  LayerModel,
  SetLayerPermissionDto,
  TileData,
  UpdateLayerDto,
  UserPayload,
  VectorStroke,
} from '@atelier/shared';
import {
  claimLayer,
  createLayer,
  deleteLayer,
  getAclLayer,
  getLayerById,
  getLayerPermissionForUser,
  getLayerPermissions,
  getLayersByCanvasId,
  releaseLayer,
  reorderLayer,
  reorderLayersList,
  setLayerPermission,
  tidyLayerTree,
  transferLayer,
  updateLayer,
} from '../services/layer.service';
import { getCanvasById, getCanvasMembership } from '../services/canvas.service';
import { canReadCanvas, ROOM_LOCKED } from './canvas.routes';
import { canAddToFolder, listFolderAccess, requestFolderAccess, resolveFolderAccess } from '../services/folder-access';

/** True when the user is server admin OR creator/owner/admin of this canvas room */
function isCanvasAdmin(canvasId: string, user: UserPayload): boolean {
  if (user.serverRole === 'admin') return true;
  const canvas = getCanvasById(canvasId);
  if (canvas && canvas.ownerId === user.id) return true;
  const membership = getCanvasMembership(canvasId, user.id);
  return Boolean(membership && (membership.role === 'owner' || membership.role === 'admin'));
}

/** Folder membership is granted by the specific folder owner. */
function parentDenied(parentId: string, canvasId: string, user: UserPayload): string | null {
  const parent = getLayerById(parentId);
  if (!parent || parent.canvasId !== canvasId || parent.layerType !== 'group') return '目的資料夾不存在。';
  return canAddToFolder(parent, user.id) ? null : '這個資料夾需要擁有者授權，才能新增或移入圖層。';
}
function validVectorStroke(stroke: VectorStroke): boolean {
  return Boolean(stroke && typeof stroke.id === 'string' && stroke.id && typeof stroke.color === 'string'
    && [stroke.opacity, stroke.baseWidth, stroke.createdAt].every(Number.isFinite)
    && stroke.bounds && [stroke.bounds.minX, stroke.bounds.minY, stroke.bounds.maxX, stroke.bounds.maxY].every(Number.isFinite)
    && Array.isArray(stroke.anchors) && stroke.anchors.length > 0
    && stroke.anchors.every((a) => a && [a.x, a.y, a.pressure, a.width].every(Number.isFinite)
      && [a.cp1x, a.cp1y, a.cp2x, a.cp2y].every((n) => n === undefined || Number.isFinite(n))));
}

export const layerRoutes: FastifyPluginAsync = async (fastify) => {
  // Every successful layer mutation over REST is pushed to the canvas room; other painters
  // otherwise never learn about new/renamed/deleted layers and drop the ops drawn on them.
  fastify.addHook('onResponse', async (request, reply) => {
    // Pixel writes (/tiles) are ops: they reach the room as op_broadcast, the layer list did not change
    if (request.method !== 'GET' && reply.statusCode < 300 && !request.url.split('?')[0].endsWith('/tiles')) {
      fastify.roomManager.broadcastLayers((request.params as { id: string }).id);
    }
  });

  // GET /api/canvases/:id/layers
  fastify.get<{ Params: { id: string } }>('/:id/layers', async (request, reply) => {
    const { id } = request.params;
    const canvas = getCanvasById(id);
    if (!canvas) return reply.code(404).send({ error: '畫布不存在' });
    if (!(await canReadCanvas(fastify, request, canvas))) return reply.code(403).send(ROOM_LOCKED);

    // Canvases saved before groups kept their content right below them get put in order once
    if (tidyLayerTree(id)) fastify.roomManager.broadcastLayers(id);
    const layers = getLayersByCanvasId(id);
    return reply.send({ layers });
  });

  // POST /api/canvases/:id/layers - Create layer
  fastify.post<{ Params: { id: string }; Body: CreateLayerDto }>('/:id/layers', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const { id } = request.params;
      const user = request.user as UserPayload;

      const canvas = getCanvasById(id);
      if (!canvas) return reply.code(404).send({ error: '畫布不存在' });

      const membership = getCanvasMembership(id, user.id);
      if (!canUserCreateLayer(user, membership)) {
        return reply.code(403).send({ error: '你沒有在此畫布建立新圖層的權限' });
      }

      if (request.body?.layerType !== 'mask' && request.body?.parentId) {
        const denied = parentDenied(request.body.parentId, id, user);
        if (denied) return reply.code(403).send({ error: denied });
      }
      // Adding a mask changes the target layer, so it needs the right to edit that layer
      const target = request.body?.layerType === 'mask' && request.body.parentId ? getLayerById(request.body.parentId) : null;
      if (target && target.canvasId === id) {
        const check = canUserPerformLayerAction(
          { user, canvasMember: membership, layer: target, layerPermission: getLayerPermissionForUser(target.id, user.id) },
          'modify_props'
        );
        if (!check.allowed) return reply.code(403).send({ error: check.reason || '無權限替該圖層加蒙版' });
      }
      try {
        const layer = createLayer(id, user.id, request.body || ({} as CreateLayerDto));
        return reply.code(201).send({ layer });
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    },
  });

  // PATCH /api/canvases/:id/layers/:layerId - Update layer properties
  fastify.patch<{ Params: { id: string; layerId: string }; Body: UpdateLayerDto }>(
    '/:id/layers/:layerId',
    {
      preHandler: [fastify.authenticate],
      handler: async (request, reply) => {
        const { id, layerId } = request.params;
        const user = request.user as UserPayload;

        const layer = getLayerById(layerId);
        if (!layer || layer.canvasId !== id) {
          return reply.code(404).send({ error: '圖層不存在' });
        }

        const membership = getCanvasMembership(id, user.id);
        const aclLayer = getAclLayer(layer);
        const layerPerm = getLayerPermissionForUser(aclLayer.id, user.id);
        const props = request.body || {};
        const isLockOnly = typeof props.isLocked === 'boolean' && Object.keys(props).length === 1;
        const changesAnimationSharing = props.meta !== undefined && props.meta?.animation?.shared !== layer.meta?.animation?.shared;
        if (aclLayer.ownerId !== user.id && (props.aclMode !== undefined || changesAnimationSharing)) {
          return reply.code(403).send({ error: '只有圖層擁有者可以變更共用權限。' });
        }

        const check = canUserPerformLayerAction(
          {
            user,
            canvasMember: membership,
            layer: aclLayer,
            layerPermission: layerPerm,
          },
          isLockOnly ? 'lock' : 'modify_props'
        );

        if (!check.allowed) {
          return reply.code(403).send({ error: check.reason || '無權限修改該圖層屬性' });
        }
        const newParent = request.body?.parentId;
        if (newParent && newParent !== layer.parentId && layer.layerType !== 'mask') {
          const denied = parentDenied(newParent, id, user);
          if (denied) return reply.code(403).send({ error: denied });
        }

        try {
          const updated = updateLayer(layerId, props);
          return reply.send({ layer: updated });
        } catch (err: any) {
          return reply.code(400).send({ error: err.message });
        }
      },
    }
  );

  // Capsule restore writes tiles and vector geometry as ordinary ops, with the same ACL and sequencing as socket ops.
  fastify.post<{ Params: { id: string; layerId: string }; Body: { tiles?: Array<{ col: number; row: number; width: number; height: number; compression?: string; data: string }>; actionDesc?: string; vectorAdded?: VectorStroke[] } }>(
    '/:id/layers/:layerId/tiles',
    {
      preHandler: [fastify.authenticate],
      bodyLimit: 48 * 1024 * 1024,
      handler: async (request, reply) => {
        const { id, layerId } = request.params;
        const user = request.user as UserPayload;
        const input = request.body?.tiles;
        const vectors = request.body?.vectorAdded;
        if (vectors !== undefined) {
          if (input !== undefined || !Array.isArray(vectors) || !vectors.length || vectors.length > 48 || !vectors.every(validVectorStroke)) {
            return reply.code(400).send({ error: '向量線條格式不正確' });
          }
          const layer = getLayerById(layerId);
          if (!layer || layer.canvasId !== id) return reply.code(404).send({ error: '目標圖層不存在或與當前畫布不匹配。' });
          if (layer.layerType !== 'vector') return reply.code(400).send({ error: '只能將向量線條寫入向量圖層' });
        }
        const MAX_TILE = 256;
        if (vectors === undefined && (!Array.isArray(input) || input.length === 0 || input.length > 256)) {
          return reply.code(400).send({ error: '需要 1–256 個圖塊' });
        }
        const tiles: TileData[] = [];
        for (const t of input ?? []) {
          const ok = t && Number.isInteger(t.col) && Number.isInteger(t.row) && t.col >= 0 && t.row >= 0
            && Number.isInteger(t.width) && Number.isInteger(t.height) && t.width > 0 && t.height > 0 && t.width <= MAX_TILE && t.height <= MAX_TILE
            && (t.compression === 'lz4' || t.compression === 'raw') && typeof t.data === 'string';
          if (!ok) return reply.code(400).send({ error: '圖塊格式不正確' });
          const data = new Uint8Array(Buffer.from(t.data, 'base64'));
          if (data.byteLength > MAX_TILE * MAX_TILE * 4 + 1024 || (t.compression === 'raw' && data.byteLength !== t.width * t.height * 4)) {
            return reply.code(400).send({ error: '圖塊資料大小不正確' });
          }
          tiles.push({ col: t.col, row: t.row, width: t.width, height: t.height, compression: t.compression as TileData["compression"], data, byteLength: data.byteLength });
        }
        let rejected: string | null = null;
        const seq = fastify.roomManager.commitOp(
          { user, reject: (r) => { rejected = r.reason; } },
          {
            canvasId: id,
            layerId,
            opType: vectors ? 'VECTOR_EDIT' : 'TILE_PATCH',
            payload: vectors
              ? { tiles, vectorRemovedIds: [], vectorAdded: vectors.map((stroke) => ({ ...stroke, layerId })) }
              : { type: 'TILE_PATCH', canvasId: id, layerId, tiles, actionDesc: typeof request.body?.actionDesc === 'string' ? request.body.actionDesc.slice(0, 80) : undefined },
          }
        );
        if (seq === null) return reply.code(rejected === '目標圖層不存在或與當前畫布不匹配。' ? 404 : 403).send({ error: rejected ?? '無法寫入圖塊' });
        return reply.code(201).send({ seq });
      },
    }
  );

  // DELETE /api/canvases/:id/layers/:layerId - Delete layer
  fastify.delete<{ Params: { id: string; layerId: string } }>(
    '/:id/layers/:layerId',
    {
      preHandler: [fastify.authenticate],
      handler: async (request, reply) => {
        const { id, layerId } = request.params;
        const user = request.user as UserPayload;

        const layer = getLayerById(layerId);
        if (!layer || layer.canvasId !== id) {
          return reply.code(404).send({ error: '圖層不存在' });
        }

        const membership = getCanvasMembership(id, user.id);
        const aclLayer = getAclLayer(layer);
        const layerPerm = getLayerPermissionForUser(aclLayer.id, user.id);

        const check = canUserPerformLayerAction(
          {
            user,
            canvasMember: membership,
            layer: aclLayer,
            layerPermission: layerPerm,
          },
          'delete'
        );

        if (!check.allowed) {
          return reply.code(403).send({ error: check.reason || '無權限刪除該圖層' });
        }

        // ?contents=1: a group goes with everything inside it that is this painter's own (and not locked).
        // Other painters' layers are never deleted in passing, not even by the room owner: they move out.
        const withContents = (request.query as { contents?: string } | undefined)?.contents === '1';
        const mayDelete = (l: LayerModel) =>
          l.ownerId === user.id && canUserPerformLayerAction(
            { user, canvasMember: membership, layer: getAclLayer(l), layerPermission: getLayerPermissionForUser(getAclLayer(l).id, user.id) },
            'delete'
          ).allowed;
        const { deleted, lifted } = deleteLayer(layerId, { withContents, mayDelete });
        return reply.send({ success: true, message: '圖層已刪除', deletedIds: deleted, liftedIds: lifted });
      },
    }
  );

  // POST /api/canvases/:id/layers/:layerId/release - Release / Vacate layer
  fastify.post<{ Params: { id: string; layerId: string } }>(
    '/:id/layers/:layerId/release',
    {
      preHandler: [fastify.authenticate],
      handler: async (request, reply) => {
        const { id, layerId } = request.params;
        const user = request.user as UserPayload;
        const isAdmin = isCanvasAdmin(id, user);

        try {
          const updated = releaseLayer(id, layerId, user.id, isAdmin);
          return reply.send({ layer: updated });
        } catch (err: any) {
          return reply.code(403).send({ error: err.message });
        }
      },
    }
  );

  // POST /api/canvases/:id/layers/:layerId/claim - Claim / Take over layer
  fastify.post<{ Params: { id: string; layerId: string }; Body?: { force?: boolean } }>(
    '/:id/layers/:layerId/claim',
    {
      preHandler: [fastify.authenticate],
      handler: async (request, reply) => {
        const { id, layerId } = request.params;
        const user = request.user as UserPayload;
        const isAdmin = isCanvasAdmin(id, user);
        const force = Boolean(request.body?.force);

        try {
          const updated = claimLayer(id, layerId, user.id, force, isAdmin);
          return reply.send({ layer: updated });
        } catch (err: any) {
          return reply.code(403).send({ error: err.message });
        }
      },
    }
  );

  // POST /api/canvases/:id/layers/:layerId/transfer - Transfer layer to specified user
  fastify.post<{ Params: { id: string; layerId: string }; Body: { targetUserId: string } }>(
    '/:id/layers/:layerId/transfer',
    {
      preHandler: [fastify.authenticate],
      handler: async (request, reply) => {
        const { id, layerId } = request.params;
        const { targetUserId } = request.body || {};
        const user = request.user as UserPayload;
        const isAdmin = isCanvasAdmin(id, user);

        if (!targetUserId) {
          return reply.code(400).send({ error: '請指定目標接收畫友 (targetUserId)' });
        }

        try {
          const updated = transferLayer(id, layerId, targetUserId, user.id, isAdmin);
          return reply.send({ layer: updated });
        } catch (err: any) {
          return reply.code(403).send({ error: err.message });
        }
      },
    }
  );

  // POST /api/canvases/:id/layers/reorder - Batch Reorder all layers
  fastify.post<{ Params: { id: string }; Body: { layerIds: string[] } }>(
    '/:id/layers/reorder',
    {
      preHandler: [fastify.authenticate],
      handler: async (request, reply) => {
        const { id } = request.params;
        const user = request.user as UserPayload;
        const isAdmin = isCanvasAdmin(id, user);
        const { layerIds } = request.body || ({} as { layerIds: string[] });

        if (!Array.isArray(layerIds)) {
          return reply.code(400).send({ error: 'layerIds 必須為陣列' });
        }

        try {
          const updated = reorderLayersList(id, layerIds, user.id, isAdmin);
          return reply.send({ layers: updated });
        } catch (err: any) {
          return reply.code(403).send({ error: err.message });
        }
      },
    }
  );

  // POST /api/canvases/:id/layers/:layerId/reorder - Reorder layer
  fastify.post<{ Params: { id: string; layerId: string }; Body: { newSortOrder: number } }>(
    '/:id/layers/:layerId/reorder',
    {
      preHandler: [fastify.authenticate],
      handler: async (request, reply) => {
        const { id, layerId } = request.params;
        const user = request.user as UserPayload;
        const isAdmin = isCanvasAdmin(id, user);
        const { newSortOrder } = request.body || ({} as { newSortOrder: number });

        if (typeof newSortOrder !== 'number' || !Number.isFinite(newSortOrder)) {
          return reply.code(400).send({ error: 'newSortOrder 必須為數字' });
        }

        try {
          const updated = reorderLayer(id, layerId, newSortOrder, user.id, isAdmin);
          return reply.send({ layer: updated });
        } catch (err: any) {
          return reply.code(403).send({ error: err.message });
        }
      },
    }
  );

  const folderAccessPreHandlers = [fastify.authenticate, async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const { id } = request.params as { id: string };
    const canvas = getCanvasById(id);
    if (!canvas) return reply.code(404).send({ error: '畫布不存在。' });
    if (!(await canReadCanvas(fastify, request, canvas))) return reply.code(403).send(ROOM_LOCKED);
    if ((request.user as UserPayload).serverRole === 'guest') return reply.code(403).send({ error: '請先登入。' });
  }];

  fastify.get<{ Params: { id: string } }>('/:id/folder-access', { preHandler: folderAccessPreHandlers }, async (request) => {
    return { requests: listFolderAccess(request.params.id, (request.user as UserPayload).id) };
  });

  fastify.post<{ Params: { id: string; layerId: string } }>('/:id/layers/:layerId/folder-access', { preHandler: folderAccessPreHandlers }, async (request, reply) => {
    const { id, layerId } = request.params;
    const user = request.user as UserPayload;
    const folder = getLayerById(layerId);
    if (!folder || folder.canvasId !== id || folder.layerType !== 'group' || !folder.ownerId) {
      return reply.code(404).send({ error: '找不到有擁有者的資料夾。' });
    }
    if (user.id !== folder.ownerId) requestFolderAccess(folder.id, user.id, folder.ownerId);
    return { requests: listFolderAccess(id, user.id) };
  });

  fastify.patch<{ Params: { id: string; layerId: string; requesterId: string }; Body: { approved: boolean } }>(
    '/:id/layers/:layerId/folder-access/:requesterId', { preHandler: folderAccessPreHandlers }, async (request, reply) => {
      const { id, layerId, requesterId } = request.params;
      const user = request.user as UserPayload;
      const folder = getLayerById(layerId);
      if (!folder || folder.canvasId !== id || folder.layerType !== 'group') return reply.code(404).send({ error: '資料夾不存在。' });
      if (folder.ownerId !== user.id) return reply.code(403).send({ error: '只有資料夾擁有者能審核申請。' });
      if (typeof request.body?.approved !== 'boolean') return reply.code(400).send({ error: '請指定是否同意。' });
      if (!resolveFolderAccess(layerId, requesterId, user.id, request.body.approved)) return reply.code(404).send({ error: '申請已處理或不存在。' });
      return { requests: listFolderAccess(id, user.id) };
    },
  );

  // GET /api/canvases/:id/layers/:layerId/permissions
  fastify.get<{ Params: { id: string; layerId: string } }>(
    '/:id/layers/:layerId/permissions',
    {
      preHandler: [fastify.authenticate],
      handler: async (request, reply) => {
        const { id, layerId } = request.params;
        const layer = getLayerById(layerId);
        if (!layer || layer.canvasId !== id) {
          return reply.code(404).send({ error: '圖層不存在' });
        }
        const permissions = getLayerPermissions(layerId);
        return reply.send({ permissions });
      },
    }
  );

  // POST /api/canvases/:id/layers/:layerId/permissions - Set user custom permissions
  fastify.post<{ Params: { id: string; layerId: string }; Body: SetLayerPermissionDto }>(
    '/:id/layers/:layerId/permissions',
    {
      preHandler: [fastify.authenticate],
      handler: async (request, reply) => {
        const { id, layerId } = request.params;
        const user = request.user as UserPayload;

        const layer = getLayerById(layerId);
        if (!layer || layer.canvasId !== id) {
          return reply.code(404).send({ error: '圖層不存在' });
        }

        if (layer.ownerId !== user.id) {
          return reply.code(403).send({ error: '只有圖層擁有者可以設定圖層權限。' });
        }
        try {
          if (typeof request.body?.userId !== 'string') throw new Error('請指定授權對象 (userId)');
          const perm = setLayerPermission(layerId, request.body);
          return reply.send({ permission: perm });
        } catch (err: any) {
          return reply.code(400).send({ error: err.message });
        }
      },
    }
  );
};
