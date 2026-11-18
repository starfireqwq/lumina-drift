import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { findUserById, promoteGuestToMember, verifyPassword } from '../services/auth.service';
import {
  CanvasModel,
  CanvasSnapshotBundle,
  CreateCanvasDto,
  JoinCanvasDto,
  UpdateCanvasDto,
  UserPayload,
} from '@atelier/shared';
import {
  createCanvas,
  deleteCanvas,
  getCanvasById,
  getCanvasMembership,
  hasCanvasGroupAccess,
  joinCanvas,
  listCanvases,
  resizeCanvasWithShift,
  updateCanvas,
} from '../services/canvas.service';
import { getLayersByCanvasId } from '../services/layer.service';
import {
  autoCreateCheckpoint,
  getLatestSnapshot,
  getOpsSince,
  saveSnapshot,
} from '../services/snapshot.service';

// Clients only need to know a room is locked, never the password hash itself
const toPublic = (c: CanvasModel) => ({ ...c, roomPassHash: null, hasPassword: Boolean(c.roomPassHash) });

/**
 * Reads of a password room's content (layers, snapshot, ops): its owner, a server admin or a member
 * (signed in), or anyone sending the room password in `X-Room-Password` (URI-encoded; guests have no
 * membership). The same rule as join_canvas on the socket.
 */
export async function canReadCanvas(fastify: FastifyInstance, request: FastifyRequest, canvas: CanvasModel): Promise<boolean> {
  if (!canvas.roomPassHash) return true;
  const auth = request.headers.authorization;
  if (auth) {
    try {
      const { id } = fastify.jwt.verify<UserPayload>(auth.replace('Bearer ', ''));
      // Re-read the account like `authenticate`: a frozen or demoted user loses access at once
      const user = findUserById(id);
      if (user?.isActive && (user.serverRole === 'admin' || canvas.ownerId === user.id ||
        getCanvasMembership(canvas.id, user.id) || hasCanvasGroupAccess(canvas.group?.id, user.id))) {
        return true;
      }
    } catch {
      // bad token: fall through to the password header
    }
  }
  const header = request.headers['x-room-password'];
  if (typeof header !== 'string' || !header) return false;
  let password = header;
  try {
    password = decodeURIComponent(header);
  } catch {
    // not encoded: use as sent
  }
  return verifyPassword(password, canvas.roomPassHash);
}

export const ROOM_LOCKED = { error: '此畫布已設有房間密碼，請先輸入密碼', code: 'PASSWORD_REQUIRED' };

export const canvasRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/canvases - List all canvases (accessible by everyone or guests)
  fastify.get('/', async () => {
    return { canvases: listCanvases().map(toPublic) };
  });

  // POST /api/canvases - Create a new canvas (creator automatically becomes room owner/admin)
  const createOptions = {
    preHandler: [fastify.authenticate],
    handler: async (request: FastifyRequest<{ Body: CreateCanvasDto }>, reply: FastifyReply) => {
      let user = request.user as UserPayload;
      const dto = request.body || { title: '未命名畫布' };

      try {
        let promotedToken: string | undefined;
        if (user.serverRole === 'guest') {
          const promoted = promoteGuestToMember(user.id);
          if (promoted) {
            user = promoted;
            promotedToken = fastify.jwt.sign({
              id: user.id,
              username: user.username,
              displayName: user.displayName,
              serverRole: user.serverRole,
            });
          }
        }
        const canvas = await createCanvas(user.id, dto);
        const layers = getLayersByCanvasId(canvas.id);
        const membership = getCanvasMembership(canvas.id, user.id);
        return reply.code(201).send({
          canvas: toPublic(canvas),
          layers,
          myMembership: membership,
          ...(promotedToken ? { token: promotedToken, user } : {}),
        });
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    },
  };
  fastify.post<{ Body: CreateCanvasDto }>('/', createOptions);
  fastify.post<{ Body: CreateCanvasDto }>('/grouped', createOptions);

  // GET /api/canvases/:id - Get canvas details and layer list
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;
    const canvas = getCanvasById(id);
    if (!canvas) {
      return reply.code(404).send({ error: '畫布不存在' });
    }

    // A locked room's details stay public (title, size, hasPassword), its layers do not
    const layers = (await canReadCanvas(fastify, request, canvas)) ? getLayersByCanvasId(id) : [];

    // Optional user membership check if authorization header is present
    let myMembership = null;
    let hasGroupAccess = false;
    const authHeader = request.headers.authorization;
    if (authHeader) {
      try {
        const token = authHeader.replace('Bearer ', '');
        const decoded = fastify.jwt.verify<UserPayload>(token);
        const user = findUserById(decoded.id);
        if (user?.isActive) {
          myMembership = getCanvasMembership(id, user.id);
          hasGroupAccess = hasCanvasGroupAccess(canvas.group?.id, user.id);
        }
      } catch {
        // Ignore token errors for public view
      }
    }

    return reply.send({
      canvas: toPublic(canvas),
      layers,
      myMembership,
      hasGroupAccess,
    });
  });

  // PATCH /api/canvases/:id - Rename or update canvas (requires owner or admin)
  fastify.patch<{ Params: { id: string }; Body: UpdateCanvasDto }>('/:id', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const { id } = request.params;
      const user = request.user as UserPayload;
      const canvas = getCanvasById(id);
      if (!canvas) return reply.code(404).send({ error: '畫布不存在' });

      const membership = getCanvasMembership(id, user.id);
      const isAllowed =
        user.serverRole === 'admin' ||
        canvas.ownerId === user.id ||
        (membership && (membership.role === 'owner' || membership.role === 'admin'));

      if (!isAllowed) {
        return reply.code(403).send({ error: '僅畫布擁有者或系統管理員可修改畫布設定' });
      }

      try {
        const updated = await updateCanvas(id, request.body || {});
        return reply.send({ canvas: toPublic(updated) });
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    },
  });

  // DELETE /api/canvases/:id - Delete canvas (requires owner or admin)
  fastify.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const { id } = request.params;
      const user = request.user as UserPayload;
      const canvas = getCanvasById(id);
      if (!canvas) return reply.code(404).send({ error: '畫布不存在' });

      const membership = getCanvasMembership(id, user.id);
      const isAllowed =
        user.serverRole === 'admin' ||
        canvas.ownerId === user.id ||
        (membership && membership.role === 'owner');

      if (!isAllowed) {
        return reply.code(403).send({ error: '僅畫布擁有者或系統管理員可刪除畫布' });
      }

      deleteCanvas(id);
      fastify.roomManager.closeRoom(id);
      return reply.send({ success: true, message: '畫布已成功刪除' });
    },
  });

  // POST /api/canvases/join - Join canvas by invite code or password
  fastify.post<{ Body: JoinCanvasDto }>('/join', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const user = request.user as UserPayload;
      const { canvasId, inviteCode, roomPassword } = request.body || ({} as JoinCanvasDto);

      let targetCanvasId = canvasId;

      if (!targetCanvasId && typeof inviteCode === 'string') {
        const all = listCanvases();
        const found = all.find((c) => c.inviteCode === inviteCode.trim());
        if (!found) {
          return reply.code(404).send({ error: '無效的畫布邀請代碼' });
        }
        targetCanvasId = found.id;
      }

      if (!targetCanvasId) {
        return reply.code(400).send({ error: '請提供畫布 ID 或邀請碼' });
      }

      try {
        const member = await joinCanvas(targetCanvasId, user.id, roomPassword);
        const canvas = getCanvasById(targetCanvasId)!;
        const layers = getLayersByCanvasId(targetCanvasId);
        return reply.send({ canvas: toPublic(canvas), layers, myMembership: member });
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    },
  });

  // GET /api/canvases/:id/snapshot - Download latest canvas checkpoint snapshot
  fastify.get<{ Params: { id: string } }>('/:id/snapshot', async (request, reply) => {
    const { id } = request.params;
    const canvas = getCanvasById(id);
    if (!canvas) return reply.code(404).send({ error: '畫布不存在' });
    if (!(await canReadCanvas(fastify, request, canvas))) return reply.code(403).send(ROOM_LOCKED);

    let latest = getLatestSnapshot(id);
    // Canvases that predate folded checkpoints (or fell 50+ ops behind) get one on first load,
    // so a client never has to replay the whole history
    if (canvas.latestSeq - (latest?.model.seq ?? 0) >= 50 && autoCreateCheckpoint(id)) {
      latest = getLatestSnapshot(id);
    }
    if (!latest) {
      return reply.send({ snapshot: null, bundle: null });
    }
    return reply.send({ snapshot: latest.model, bundle: latest.bundle });
  });

  // POST /api/canvases/:id/snapshot - Create/save a checkpoint snapshot
  fastify.post<{ Params: { id: string }; Body: { bundle: CanvasSnapshotBundle; seq?: number } }>(
    '/:id/snapshot',
    {
      preHandler: [fastify.authenticate],
      handler: async (request, reply) => {
        const { id } = request.params;
        const user = request.user as UserPayload;
        const canvas = getCanvasById(id);
        if (!canvas) return reply.code(404).send({ error: '畫布不存在' });

        const membership = getCanvasMembership(id, user.id);
        const isAllowed =
          user.serverRole === 'admin' ||
          canvas.ownerId === user.id ||
          (membership && (membership.role === 'owner' || membership.role === 'admin' || membership.role === 'editor'));

        if (!isAllowed) {
          return reply.code(403).send({ error: '無權限建立快照' });
        }

        const { bundle, seq } = request.body || ({} as { bundle?: CanvasSnapshotBundle; seq?: number });
        if (!bundle || !Array.isArray(bundle.layers)) {
          return reply.code(400).send({ error: '未提供快照資料 bundle' });
        }

        // seq names the file on disk and tells clients which ops to skip on load,
        // so it must be an integer that has really been committed
        const snapshotSeq = seq !== undefined ? seq : canvas.latestSeq;
        if (!Number.isInteger(snapshotSeq) || snapshotSeq < 0 || snapshotSeq > canvas.latestSeq) {
          return reply.code(400).send({ error: '快照序號無效' });
        }
        const saved = saveSnapshot(id, snapshotSeq, bundle);
        return reply.code(201).send({ snapshot: saved });
      },
    }
  );

  // GET /api/canvases/:id/ops - Incremental ops replay since a given sequence number
  fastify.get<{ Params: { id: string }; Querystring: { sinceSeq?: string; since?: string } }>(
    '/:id/ops',
    async (request, reply) => {
      const { id } = request.params;
      const canvas = getCanvasById(id);
      if (!canvas) return reply.code(404).send({ error: '畫布不存在' });
      if (!(await canReadCanvas(fastify, request, canvas))) return reply.code(403).send(ROOM_LOCKED);

      // `since` is what shipped clients send; ignoring it silently replayed the entire history
      const parsed = parseInt(request.query.sinceSeq ?? request.query.since ?? '0', 10);
      const sinceSeq = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      const ops = getOpsSince(id, sinceSeq);
      return reply.send({ canvasId: id, sinceSeq, latestSeq: canvas.latestSeq, ops });
    }
  );

  // PATCH /api/canvases/:id/resize - Resize canvas dimensions (with optional content offset anchor and DPI)
  fastify.patch<{ Params: { id: string }; Body: { width: number; height: number; offsetX?: number; offsetY?: number; dpi?: number } }>(
    '/:id/resize',
    {
      preHandler: [fastify.authenticate],
      handler: async (request, reply) => {
        const { id } = request.params;
        const user = request.user as UserPayload;
        const canvas = getCanvasById(id);
        if (!canvas) return reply.code(404).send({ error: '畫布不存在' });

        const membership = getCanvasMembership(id, user.id);
        const isAllowed =
          user.serverRole === 'admin' ||
          canvas.ownerId === user.id ||
          (membership && (membership.role === 'owner' || membership.role === 'admin'));

        if (!isAllowed) {
          return reply.code(403).send({ error: '僅擁有者或管理員可調整畫布尺寸' });
        }

        const { width, height, offsetX = 0, offsetY = 0, dpi } = request.body || {};
        if (!width || !height) {
          return reply.code(400).send({ error: '必須提供寬度與高度' });
        }
        if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
          return reply.code(400).send({ error: '無效的畫布錨定偏移量' });
        }

        try {
          const { canvas: updated, contentShifted, textShifted } = resizeCanvasWithShift(id, width, height, offsetX, offsetY, dpi);
          if (textShifted) {
            fastify.roomManager.broadcastLayers(id);
          }
          fastify.roomManager.broadcastCanvasResized(id, updated.width, updated.height, contentShifted);
          return reply.send({ canvas: toPublic(updated), shifted: contentShifted });
        } catch (err: any) {
          return reply.code(400).send({ error: err.message });
        }
      },
    }
  );
};
