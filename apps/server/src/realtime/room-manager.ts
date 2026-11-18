import { Server as SocketIOServer, Socket } from 'socket.io';
import * as socketParser from 'socket.io-parser';
import { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  tileSocketParser,
  AtelierPacket,
  calculatePainterLevel,
  canUserPerformLayerAction,
  CanvasSticker,
  CursorPacket,
  decodePacket,
  DRAW_OP_TYPES,
  DRAW_TIME_MAX_GAP_MS,
  encodePacket,
  LayerAction,
  MemberPresence,
  OpBroadcastPacket,
  OpCommitPacket,
  OpRejectedPacket,
  PresenceUpdatePacket,
  PreviewDabPacket,
  RoomMemberInfo,
  RoomStatePacket,
  TilePatchPacket,
  UserPayload,
} from '@atelier/shared';
import { getCanvasById, getCanvasMembership, hasCanvasGroupAccess, incrementCanvasSeq, joinCanvas } from '../services/canvas.service';
import {
  claimLayer,
  getAclLayer,
  getLayerById,
  getLayerPermissionForUser,
  getLayersByCanvasId,
  releaseLayer,
  reorderLayer,
  reorderLayersList,
  transferLayer,
} from '../services/layer.service';
import { db, sqlite } from '../db';
import { canvasOps } from '../db/schema';
import { findUserById, verifyPassword } from '../services/auth.service';
import { createCheckpointInBackground } from '../services/snapshot.service';
import { addMemberDrawTime, getMemberDrawTime, listCanvasRoster, loadStrokeTotals, touchMembersLastSeen } from '../services/presence.service';

/** Connected members' last-seen time is refreshed this often, so a crashed server loses at most this much */
const LAST_SEEN_REFRESH_MS = 60_000;

const PALETTE = [
  '#FF5722',
  '#4CAF50',
  '#2196F3',
  '#9C27B0',
  '#FF9800',
  '#00BCD4',
  '#E91E63',
  '#3F51B5',
  '#009688',
  '#795548',
];

/** A busy receiver's previews are gathered this long, then sent as one message */
const PREVIEW_COALESCE_MS = 16;
/** Packets still unsent on a receiver's link above which its previews slow down further (ops are never held) */
const PREVIEW_BACKLOG_LIMIT = 24;
const PREVIEW_CONGESTED_MS = 80;
/** Per stroke, the most preview dabs held for a congested receiver (the newest are kept) */
const PREVIEW_MAX_HELD_DABS = 600;

const LAYER_MANAGE_EVENTS = new Set([
  'release_layer',
  'claim_layer',
  'transfer_layer',
  'reorder_layer',
  'reorder_layers',
]);

export class RealtimeRoomManager {
  private io: SocketIOServer;
  // canvasId -> Map<socketId, RoomMemberInfo>
  private roomMembers = new Map<string, Map<string, RoomMemberInfo>>();
  // canvasId -> Map<stickerId, CanvasSticker>
  private canvasStickers = new Map<string, Map<string, CanvasSticker>>();
  // canvasId -> Set<socketId> of users currently in WebRTC Voice Room
  private voiceRooms = new Map<string, Map<string, { isMuted: boolean; isSpeaking: boolean }>>();
  // userId -> stroke count
  private userStrokes = new Map<string, number>();
  // canvasId -> total strokes count
  private canvasTotalStrokes = new Map<string, number>();
  // `${canvasId}|${userId}` -> drawing time: each gap of at most DRAW_TIME_MAX_GAP_MS between two
  // of the user's drawing ops is credited, so a long pause (or an open but idle tab) adds nothing
  private drawClocks = new Map<string, { lastOpAt: number; drawTimeMs: number }>();

  constructor(server: FastifyInstance) {
    this.restoreStrokeTotals();
    this.io = new SocketIOServer(server.server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
      parser: tileSocketParser(socketParser), // more than 10 tiles per op, see tileSocketParser
      // A message over this limit also drops the connection: a full repaint of a 2048px canvas
      // is up to 16MB of tiles before compression
      maxHttpBufferSize: 1e8, // 100MB
      // Live previews and room state are repetitive JSON: compressed with the connection's running
      // dictionary they shrink several times (what decides whether a weak 4G link keeps up)
      // Level 1 and more parallel zlib jobs: the default level and limit of 10 queued previews (+20 ms on a LAN)
      perMessageDeflate: { threshold: 256, zlibDeflateOptions: { level: 1 }, concurrencyLimit: 64 },
    });

    this.setupAuthMiddleware(server);
    this.setupConnectionHandlers();
    setInterval(() => this.refreshLastSeen(), LAST_SEEN_REFRESH_MS).unref();
  }

  private restoreStrokeTotals() {
    this.userStrokes.clear();
    this.canvasTotalStrokes.clear();
    for (const { canvasId, userId, count } of loadStrokeTotals()) {
      this.userStrokes.set(userId, (this.userStrokes.get(userId) ?? 0) + count);
      this.canvasTotalStrokes.set(canvasId, (this.canvasTotalStrokes.get(canvasId) ?? 0) + count);
    }
  }

  private drawClock(canvasId: string, userId: string) {
    const key = `${canvasId}|${userId}`;
    let clock = this.drawClocks.get(key);
    if (!clock) {
      clock = { lastOpAt: 0, drawTimeMs: getMemberDrawTime(canvasId, userId) ?? 0 };
      this.drawClocks.set(key, clock);
    }
    return clock;
  }

  private refreshLastSeen() {
    try {
      for (const [canvasId, members] of this.roomMembers) {
        const ids = new Set<string>();
        for (const m of members.values()) if (!m.isGuest) ids.add(m.userId);
        if (ids.size) touchMembersLastSeen(canvasId, ids);
      }
    } catch (err) {
      console.error('[Presence] Failed to refresh last-seen times:', err);
    }
  }

  /** The client reports its own activity: idle after a while without input, online on the next input */
  private handlePresence(socket: Socket, data: { canvasId: string; presence: MemberPresence }) {
    if (data.presence !== 'online' && data.presence !== 'idle') return;
    const member = this.roomMembers.get(data.canvasId)?.get(socket.id);
    if (!member || member.presence === data.presence) return;
    member.presence = data.presence;
    const packet: PresenceUpdatePacket = {
      canvasId: data.canvasId,
      socketId: socket.id,
      userId: member.userId,
      presence: data.presence,
    };
    this.io.to(`canvas_${data.canvasId}`).emit('presence_update', packet);
  }

  private setupAuthMiddleware(server: FastifyInstance) {
    this.io.use(async (socket, next) => {
      try {
        const token =
          socket.handshake.auth?.token ||
          socket.handshake.headers?.authorization?.replace('Bearer ', '') ||
          socket.handshake.query?.token;

        if (token && typeof token === 'string') {
          try {
            const decoded = server.jwt.verify<UserPayload>(token);
            // Verify user still exists in DB
            const user = findUserById(decoded.id);
            if (user && user.isActive) {
              socket.data.user = {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
                serverRole: user.serverRole,
                avatarUrl: user.avatarUrl,
              };
              socket.data.isGuest = false;
              return next();
            }
          } catch (jwtErr) {
            console.warn(`[Socket.io] JWT verification failed for socket ${socket.id}:`, (jwtErr as Error).message);
          }
        }

        // Guest / Anonymous user fallback
        const guestNick = socket.handshake.auth?.displayName || `訪客 ${socket.id.slice(0, 4)}`;
        socket.data.user = {
          id: `guest_${socket.id}`,
          username: `guest_${socket.id.slice(0, 5)}`,
          displayName: guestNick,
          serverRole: 'member',
          avatarUrl: null,
        };
        socket.data.isGuest = true;
        next();
      } catch (err) {
        next(err as Error);
      }
    });
  }

  private setupConnectionHandlers() {
    this.io.on('connection', (socket: Socket) => {
      const user = socket.data.user as UserPayload;
      const isGuest = Boolean(socket.data.isGuest);
      const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
      socket.data.color = color;

      // Send initial auth ack
      socket.emit('auth_ack', {
        user,
        isGuest,
      });

      // One gate for every canvas-scoped event: the socket must have passed join_canvas (and its
      // room password) first, and anonymous guests stay view-only for layer ownership/ordering.
      // Checked at dispatch time, not in socket.use: middleware runs before the handler of a
      // join_canvas sent just ahead of the event, and would drop it.
      const allowed = (event: string, data: unknown): boolean => {
        if (!data || typeof data !== 'object') return false; // every handler dereferences its payload
        if (event === 'leave_canvas') return true;

        const canvasId = (data as { canvasId?: unknown }).canvasId;
        const inRoom = typeof canvasId === 'string' && socket.rooms.has(`canvas_${canvasId}`);
        // Chat outside any real canvas is the lobby channel and needs no room
        const isLobbyChat = event === 'chat_message' && (typeof canvasId !== 'string' || !getCanvasById(canvasId));
        if (!inRoom && !isLobbyChat) {
          if (event !== 'cursor' && event !== 'preview_dab') {
            socket.emit('error', { code: 'NOT_IN_ROOM', message: '尚未加入此畫布房間，操作已忽略' });
          }
          return false;
        }
        if (isGuest && LAYER_MANAGE_EVENTS.has(event)) {
          socket.emit('error', { code: 'PERMISSION_DENIED', message: '訪客無法接管、釋放或排序圖層，請先登入帳號' });
          return false;
        }
        return true;
      };
      const on = <T>(event: string, handler: (data: T) => void) =>
        socket.on(event, (data: T) => {
          if (allowed(event, data)) handler(data);
        });

      // Clock sync (not a canvas event): clients put previews' sentAt on the server clock, so a
      // receiver's "now − sentAt" is the real delay even when two devices' clocks disagree
      socket.on('time_sync', (_data: unknown, ack?: (serverNow: number) => void) => {
        if (typeof ack === 'function') ack(Date.now());
      });

      // Join Canvas handler
      socket.on('join_canvas', async (data: { canvasId: string; password?: string }) => {
        await this.handleJoinCanvas(socket, data?.canvasId, data?.password);
      });

      // Leave Canvas handler
      on('leave_canvas', (data: { canvasId: string }) => {
        this.handleLeaveCanvas(socket, data.canvasId);
      });

      on('presence', (data: { canvasId: string; presence: MemberPresence }) => {
        this.handlePresence(socket, data);
      });

      // Transient Cursor stream
      on('cursor', (data: { canvasId: string; x: number; y: number; pressure?: number; isDrawing?: boolean; brushSize?: number }) => {
        this.handleCursor(socket, data);
      });

      // Transient Preview Brush Dabs stream
      on('preview_dab', (data: { canvasId: string; layerId: string; color: string; brushSize: number; dabs: Array<{ x: number; y: number; pressure: number }> }) => {
        this.handlePreviewDab(socket, data);
      });

      // Authoritative Op Commit
      on('op_commit', (data: { canvasId: string; layerId: string; opType: string; payload: unknown; clientSeq?: number }) => {
        this.handleOpCommit(socket, data);
      });

      // Tile Patch (Incremental Tile Diff / Scoped Undo-Redo)
      on('tile_patch', (data: TilePatchPacket) => {
        this.handleTilePatch(socket, data);
      });

      // Layer Permission Management Handlers
      on('release_layer', (data: { canvasId: string; layerId: string }) => {
        this.handleReleaseLayer(socket, data);
      });

      on('claim_layer', (data: { canvasId: string; layerId: string; force?: boolean }) => {
        this.handleClaimLayer(socket, data);
      });

      on('reorder_layer', (data: { canvasId: string; layerId: string; newSortOrder: number }) => {
        this.handleReorderLayer(socket, data);
      });

      on('transfer_layer', (data: { canvasId: string; layerId: string; targetUserId: string }) => {
        this.handleTransferLayer(socket, data);
      });

      on('reorder_layers', (data: { canvasId: string; layerIds: string[] }) => {
        this.handleReorderLayers(socket, data);
      });

      // Generic Binary MessagePack Packet Handler
      socket.on('binary_packet', (rawBuffer: Buffer | Uint8Array) => {
        this.handleBinaryPacket(socket, rawBuffer);
      });

      // WebRTC Voice Signaling Handlers
      on('voice_join', (data: { canvasId: string }) => {
        this.handleVoiceJoin(socket, data.canvasId);
      });

      on('voice_leave', (data: { canvasId: string }) => {
        this.handleVoiceLeave(socket, data.canvasId);
      });

      on(
        'voice_signal',
        (data: {
          canvasId: string;
          targetSocketId?: string;
          targetUserId?: string;
          signalType: string;
          signalData?: any;
        }) => {
          this.handleVoiceSignal(socket, data);
        }
      );

      on(
        'voice_state',
        (data: { canvasId: string; isMuted: boolean; isSpeaking: boolean }) => {
          this.handleVoiceState(socket, data);
        }
      );

      // Admin Voice Controls: Force Mute & Kick from Voice Room
      on(
        'admin_voice_force_mute',
        (data: { canvasId: string; targetSocketId?: string; targetUserId?: string }) => {
          const user = socket.data.user as UserPayload;
          if (!user) return;
          const isAdmin = this.isCanvasAdmin(data.canvasId, user);
          if (!isAdmin) {
            socket.emit('error', { message: '您不是管理員或房主，無權強制閉麥' });
            return;
          }
          const target = data.targetSocketId && this.io.sockets.sockets.get(data.targetSocketId);
          if (target && this.voiceRooms.get(data.canvasId)?.has(target.id)) {
            this.io.to(target.id).emit('voice_force_muted', {
              canvasId: data.canvasId,
              byDisplayName: user.displayName,
            });
            this.handleVoiceState(target, { canvasId: data.canvasId, isMuted: true, isSpeaking: false });
          }
        }
      );

      on(
        'admin_voice_kick',
        (data: { canvasId: string; targetSocketId?: string; targetUserId?: string }) => {
          const user = socket.data.user as UserPayload;
          if (!user) return;
          const isAdmin = this.isCanvasAdmin(data.canvasId, user);
          if (!isAdmin) {
            socket.emit('error', { message: '您不是管理員或房主，無權踢出語音' });
            return;
          }
          if (data.targetSocketId && this.roomMembers.get(data.canvasId)?.has(data.targetSocketId)) {
            const targetSocket = this.io.sockets.sockets.get(data.targetSocketId);
            if (targetSocket) {
              this.handleVoiceLeave(targetSocket, data.canvasId);
            }
            this.io.to(data.targetSocketId).emit('voice_kicked', {
              canvasId: data.canvasId,
              byDisplayName: user.displayName,
            });
          }
        }
      );

      // WebRTC DataChannel P2P Tile Offload Signaling Handlers
      on(
        'p2p_signal',
        (data: { canvasId: string; targetSocketId?: string; signal: any }) => {
          const payload = {
            canvasId: data.canvasId,
            senderSocketId: socket.id,
            targetSocketId: data.targetSocketId,
            signal: data.signal,
          };
          if (data.targetSocketId) {
            this.io.to(data.targetSocketId).emit('p2p_signal', payload);
          } else {
            socket.to(`canvas_${data.canvasId}`).emit('p2p_signal', payload);
          }
        }
      );

      // Canvas Floating Stickers / Reference Pins Handlers
      on(
        'sticker_add',
        (data: { canvasId: string; sticker: CanvasSticker }) => {
          this.handleStickerAdd(socket, data);
        }
      );

      on(
        'sticker_update',
        (data: { canvasId: string; stickerId: string; updates: Partial<CanvasSticker> }) => {
          this.handleStickerUpdate(socket, data);
        }
      );

      on(
        'sticker_remove',
        (data: { canvasId: string; stickerId: string }) => {
          this.handleStickerRemove(socket, data);
        }
      );

      // Realtime Canvas Text Chat Message handler
      on('chat_message', (data: { canvasId?: string; text: string; id?: string }) => {
        if (!data || !data.text || !data.text.trim()) return;
        const targetCanvasId = data.canvasId || 'default';
        const roomName = `canvas_${targetCanvasId}`;
        if (!socket.rooms.has(roomName)) {
          socket.join(roomName);
        }
        const user = socket.data.user as UserPayload;
        const chatItem = {
          id: data.id || Math.random().toString(36).substring(2, 10),
          canvasId: targetCanvasId,
          userId: user?.id || `guest_${socket.id.slice(0, 5)}`,
          displayName: user?.displayName || socket.handshake.auth?.displayName || '訪客畫師',
          avatarUrl: user?.avatarUrl || null,
          color: socket.data.color || '#6366F1',
          text: data.text.trim().slice(0, 500),
          timestamp: Date.now(),
        };
        this.io.to(roomName).emit('chat_message', chatItem);
      });

      // Disconnect cleanup
      socket.on('disconnect', () => {
        const out = this.previewOutbox.get(socket.id);
        if (out?.timer) clearTimeout(out.timer);
        this.previewOutbox.delete(socket.id);
        this.handleDisconnect(socket);
      });

      // A reconnecting client names its canvas in the handshake. Join it now, before any event
      // is dispatched: socket.io flushes the ops it buffered while offline ahead of the client's
      // own join_canvas, and the room gate above would drop them.
      const handshakeCanvasId = socket.handshake.auth?.canvasId;
      if (typeof handshakeCanvasId === 'string') {
        void this.handleJoinCanvas(socket, handshakeCanvasId, socket.handshake.auth?.password);
      }
    });
  }

  private async handleJoinCanvas(socket: Socket, canvasId: string, password?: string) {
    const canvas = typeof canvasId === 'string' ? getCanvasById(canvasId) : null;
    if (!canvas) {
      socket.emit('error', { code: 'CANVAS_NOT_FOUND', message: '畫布不存在' });
      return;
    }

    const user = socket.data.user as UserPayload;
    const isGuest = Boolean(socket.data.isGuest);
    const membership = !isGuest ? getCanvasMembership(canvasId, user.id) : null;
    const groupAccess = !isGuest && hasCanvasGroupAccess(canvas.group?.id, user.id);

    // Room password lock verification (members already proved the password via REST /join)
    if (canvas.roomPassHash && !membership && !groupAccess && user.id !== canvas.ownerId && user.serverRole !== 'admin') {
      if (typeof password !== 'string' || !password) {
        socket.emit('error', { code: 'PASSWORD_REQUIRED', message: '此畫布已設有房間密碼，請輸入密碼進入' });
        return;
      }
      const valid = await verifyPassword(password, canvas.roomPassHash);
      if (!valid) {
        socket.emit('error', { code: 'PASSWORD_INVALID', message: '畫布房間密碼錯誤' });
        return;
      }
    }

    if (groupAccess && !membership) await joinCanvas(canvasId, user.id);
    const roomName = `canvas_${canvasId}`;
    socket.join(roomName);

    const userStrokeCount = this.userStrokes.get(user.id) || 0;
    const userLevel = calculatePainterLevel(userStrokeCount).level;
    // A socket joins twice per connection (handshake, then join_canvas): keep the presence it reported
    const previous = this.roomMembers.get(canvasId)?.get(socket.id);
    if (!isGuest) {
      try {
        touchMembersLastSeen(canvasId, [user.id]);
      } catch (err) {
        console.error('[Presence] Failed to record join:', err);
      }
    }

    const memberInfo: RoomMemberInfo = {
      socketId: socket.id,
      userId: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      serverRole: isGuest ? 'guest' : user.serverRole,
      canvasRole: membership?.role || (canvas.ownerId === user.id ? 'owner' : undefined),
      isGuest,
      color: socket.data.color,
      joinedAt: Date.now(),
      strokeCount: userStrokeCount,
      level: userLevel,
      presence: previous?.presence ?? 'online',
      drawTimeMs: isGuest ? undefined : this.drawClock(canvasId, user.id).drawTimeMs,
    };

    if (!this.roomMembers.has(canvasId)) {
      this.roomMembers.set(canvasId, new Map());
    }
    this.roomMembers.get(canvasId)!.set(socket.id, memberInfo);

    // Track which canvases this socket joined
    if (!socket.data.joinedCanvases) {
      socket.data.joinedCanvases = new Set<string>();
    }
    (socket.data.joinedCanvases as Set<string>).add(canvasId);

    // Broadcast room members to all sockets in this canvas
    this.broadcastRoomState(canvasId);

    // Sync active stickers for this canvas
    const stickersMap = this.canvasStickers.get(canvasId);
    if (stickersMap && stickersMap.size > 0) {
      socket.emit('sticker_sync', {
        canvasId,
        stickers: Array.from(stickersMap.values()),
      });
    }

    // Sync active voice members
    const voiceUsers = this.getVoiceUsers(canvasId, socket.id);
    if (voiceUsers.length > 0) socket.emit('voice_room_users', { canvasId, users: voiceUsers });
  }

  private handleLeaveCanvas(socket: Socket, canvasId: string) {
    this.handleVoiceLeave(socket, canvasId);

    const user = socket.data.user as UserPayload;
    if (user?.id) {
      this.io.to(`canvas_${canvasId}`).emit('cursor_remove', {
        canvasId,
        userId: user.id,
      });
    }

    const roomName = `canvas_${canvasId}`;
    socket.leave(roomName);

    const members = this.roomMembers.get(canvasId);
    if (members) {
      const left = members.get(socket.id);
      members.delete(socket.id);
      // Their last tab on this canvas: that is when they were last online
      if (left && !left.isGuest && ![...members.values()].some((m) => m.userId === left.userId)) {
        try {
          touchMembersLastSeen(canvasId, [left.userId]);
        } catch (err) {
          console.error('[Presence] Failed to record leave:', err);
        }
        this.drawClocks.delete(`${canvasId}|${left.userId}`);
      }
      if (members.size === 0) {
        this.roomMembers.delete(canvasId);
      } else {
        this.broadcastRoomState(canvasId);
      }
    }

    if (socket.data.joinedCanvases) {
      (socket.data.joinedCanvases as Set<string>).delete(canvasId);
    }
  }

  private handleCursor(
    socket: Socket,
    data: { canvasId: string; x: number; y: number; pressure?: number; isDrawing?: boolean; brushSize?: number }
  ) {
    const user = socket.data.user as UserPayload;
    const isGuest = Boolean(socket.data.isGuest);

    const cursorPacket: CursorPacket = {
      type: 'CURSOR',
      canvasId: data.canvasId,
      userId: user.id,
      displayName: user.displayName,
      // No avatarUrl: it is a data URL (~10 KB) and cursors go out 30 times a second to everyone;
      // clients take it from room_state's member list instead
      x: data.x,
      y: data.y,
      pressure: data.pressure,
      color: socket.data.color,
      brushSize: data.brushSize || 8,
      isDrawing: isGuest ? false : data.isDrawing, // Guests cannot draw
    };

    // Transient: volatile, so a congested receiver skips stale positions instead of queueing them
    socket.to(`canvas_${data.canvasId}`).volatile.emit('cursor', cursorPacket);
  }

  private handlePreviewDab(
    socket: Socket,
    data: {
      canvasId: string;
      layerId: string;
      color: string;
      brushSize: number;
      opacity?: number;
      isEraser?: boolean;
      sentAt?: number;
      dabs: Array<{ x: number; y: number; pressure: number }>;
    }
  ) {
    const isGuest = Boolean(socket.data.isGuest);
    if (isGuest) {
      // Guests are view-only, cannot emit preview brush strokes
      return;
    }
    if (!data || !Array.isArray(data.dabs) || data.dabs.length > 512) return;

    const user = socket.data.user as UserPayload;
    // Previews arrive ~40 times a second per painter: the permission answer is reused for a
    // second (three DB reads per packet otherwise). Committed ops are always checked in full.
    const cacheKey = `${data.canvasId}:${data.layerId}:${data.isEraser ? 'e' : 'd'}`;
    const cached = socket.data.previewAcl as { key: string; allowed: boolean; at: number } | undefined;
    if (cached && cached.key === cacheKey && Date.now() - cached.at < 1000) {
      if (cached.allowed) this.forwardPreview(socket, user, data);
      return;
    }
    const layer = getLayerById(data.layerId);
    if (!layer || layer.canvasId !== data.canvasId) return;

    const canvasMember = getCanvasMembership(data.canvasId, user.id);
    const aclLayer = getAclLayer(layer);
    const layerPerm = getLayerPermissionForUser(aclLayer.id, user.id);

    const check = canUserPerformLayerAction(
      {
        user,
        canvasMember,
        layer: aclLayer,
        layerPermission: layerPerm,
      },
      data.isEraser ? 'erase' : 'draw'
    );

    socket.data.previewAcl = { key: cacheKey, allowed: check.allowed, at: Date.now() };
    if (check.allowed) this.forwardPreview(socket, user, data);
  }

  private forwardPreview(
    socket: Socket,
    user: UserPayload,
    data: { canvasId: string; layerId: string; color: string; brushSize: number; opacity?: number; isEraser?: boolean; sentAt?: number; dabs: Array<{ x: number; y: number; pressure: number }> }
  ) {
    const packet: PreviewDabPacket = {
      type: 'PREVIEW_DAB',
      canvasId: data.canvasId,
      userId: user.id,
      socketId: socket.id,
      sentAt: typeof data.sentAt === 'number' ? data.sentAt : undefined,
      layerId: data.layerId,
      color: data.color,
      brushSize: data.brushSize,
      opacity: data.opacity,
      isEraser: data.isEraser,
      dabs: data.dabs,
    };
    // Not volatile: under load that dropped about a quarter of previews (gaps in live strokes).
    // Not one broadcast per packet either: every message is deflated separately per receiver, and
    // 15 painters × 40 previews/s saturated zlib's thread pool (~1 s of queueing on one PC).
    const room = this.io.sockets.adapter.rooms.get(`canvas_${data.canvasId}`);
    for (const id of room ?? []) {
      if (id === socket.id) continue;
      const target = this.io.sockets.sockets.get(id);
      if (target) this.sendPreview(target, packet);
    }
  }

  /** Previews waiting for a busy receiver, merged (receiver socket id → packets in arrival order) */
  private previewOutbox = new Map<string, { packets: PreviewDabPacket[]; timer: NodeJS.Timeout | null }>();

  /**
   * An idle link gets the preview now; a busy one (a message still being compressed / written)
   * gets everything that piled up as one `preview_batch` a moment later, consecutive packets of a
   * painter merged into one. A receiver whose write buffer keeps growing is sent previews less
   * often still. Only previews: ops never wait here and are never thinned.
   */
  private sendPreview(target: Socket, packet: PreviewDabPacket) {
    const conn = target.conn as unknown as { writeBuffer?: unknown[]; transport?: { writable?: boolean } };
    let out = this.previewOutbox.get(target.id);
    const roomSize = this.io.sockets.adapter.rooms.get(`canvas_${packet.canvasId}`)?.size ?? 1;
    const busy = roomSize > 3 || (conn.writeBuffer?.length ?? 0) > 0 || conn.transport?.writable === false;
    if (!busy && !out?.packets.length) {
      target.emit('preview_dab', packet);
      return;
    }
    if (!out) this.previewOutbox.set(target.id, (out = { packets: [], timer: null }));
    const last = out.packets[out.packets.length - 1];
    if (last && last.socketId === packet.socketId && last.layerId === packet.layerId && last.color === packet.color
      && last.brushSize === packet.brushSize && last.opacity === packet.opacity && last.isEraser === packet.isEraser) {
      // Same stroke: one packet; the oldest sentAt stays, so the receiver's latency figure is honest
      last.dabs = last.dabs.concat(packet.dabs);
    } else {
      out.packets.push({ ...packet, dabs: packet.dabs.slice() });
    }
    if (!out.timer) out.timer = setTimeout(() => this.flushPreviews(target.id), PREVIEW_COALESCE_MS);
  }

  private flushPreviews(socketId: string) {
    const out = this.previewOutbox.get(socketId);
    if (!out) return;
    out.timer = null;
    const target = this.io.sockets.sockets.get(socketId);
    if (!target) {
      this.previewOutbox.delete(socketId);
      return;
    }
    const backlog = (target.conn as unknown as { writeBuffer?: unknown[] }).writeBuffer?.length ?? 0;
    if (backlog > PREVIEW_BACKLOG_LIMIT) {
      // Congested link: wait longer, and keep only each stroke's newest dabs (its op replaces the preview anyway)
      for (const p of out.packets) if (p.dabs.length > PREVIEW_MAX_HELD_DABS) p.dabs = p.dabs.slice(-PREVIEW_MAX_HELD_DABS);
      out.timer = setTimeout(() => this.flushPreviews(socketId), PREVIEW_CONGESTED_MS);
      return;
    }
    const packets = out.packets;
    out.packets = [];
    if (packets.length) target.emit('preview_batch', packets);
  }

  private isCanvasAdmin(canvasId: string, user: UserPayload): boolean {
    if (user.serverRole === 'admin') return true;
    const canvas = getCanvasById(canvasId);
    if (canvas && canvas.ownerId === user.id) return true;
    const membership = getCanvasMembership(canvasId, user.id);
    return Boolean(membership && (membership.role === 'owner' || membership.role === 'admin'));
  }

  private handleReleaseLayer(socket: Socket, data: { canvasId: string; layerId: string }) {
    const user = socket.data.user as UserPayload;
    if (!user) {
      socket.emit('error', { code: 'PERMISSION_DENIED', message: '無效的使用者身分' });
      return;
    }
    const isAdmin = this.isCanvasAdmin(data.canvasId, user);
    try {
      const updated = releaseLayer(data.canvasId, data.layerId, user.id, isAdmin);
      this.io.to(`canvas_${data.canvasId}`).emit('layer_updated', {
        canvasId: data.canvasId,
        layer: updated,
        action: 'release',
        byUser: user.displayName,
      });
      const allLayers = getLayersByCanvasId(data.canvasId);
      this.io.to(`canvas_${data.canvasId}`).emit('layers_sync', {
        canvasId: data.canvasId,
        layers: allLayers,
      });
    } catch (err: any) {
      socket.emit('error', { code: 'LAYER_ERROR', message: err.message });
    }
  }

  private handleClaimLayer(socket: Socket, data: { canvasId: string; layerId: string; force?: boolean }) {
    const user = socket.data.user as UserPayload;
    if (!user) {
      socket.emit('error', { code: 'PERMISSION_DENIED', message: '無效的使用者身分' });
      return;
    }
    const isAdmin = this.isCanvasAdmin(data.canvasId, user);
    const force = Boolean(data.force);

    if (force && !isAdmin) {
      socket.emit('error', { code: 'PERMISSION_DENIED', message: '只有管理員或房主可強制接管圖層' });
      return;
    }

    try {
      const updated = claimLayer(data.canvasId, data.layerId, user.id, force, isAdmin);
      this.io.to(`canvas_${data.canvasId}`).emit('layer_updated', {
        canvasId: data.canvasId,
        layer: updated,
        action: force ? 'force_claim' : 'claim',
        byUser: user.displayName,
      });
      const allLayers = getLayersByCanvasId(data.canvasId);
      this.io.to(`canvas_${data.canvasId}`).emit('layers_sync', {
        canvasId: data.canvasId,
        layers: allLayers,
      });
    } catch (err: any) {
      socket.emit('error', { code: 'LAYER_ERROR', message: err.message });
    }
  }

  private handleTransferLayer(socket: Socket, data: { canvasId: string; layerId: string; targetUserId: string }) {
    const user = socket.data.user as UserPayload;
    if (!user) {
      socket.emit('error', { code: 'PERMISSION_DENIED', message: '無效的使用者身分' });
      return;
    }
    const isAdmin = this.isCanvasAdmin(data.canvasId, user);
    try {
      const updated = transferLayer(data.canvasId, data.layerId, data.targetUserId, user.id, isAdmin);
      this.io.to(`canvas_${data.canvasId}`).emit('layer_updated', {
        canvasId: data.canvasId,
        layer: updated,
        action: 'transfer',
        byUser: user.displayName,
      });
      const allLayers = getLayersByCanvasId(data.canvasId);
      this.io.to(`canvas_${data.canvasId}`).emit('layers_sync', {
        canvasId: data.canvasId,
        layers: allLayers,
      });
    } catch (err: any) {
      socket.emit('error', { code: 'LAYER_ERROR', message: err.message });
    }
  }

  private handleReorderLayer(socket: Socket, data: { canvasId: string; layerId: string; newSortOrder: number }) {
    const user = socket.data.user as UserPayload;
    if (!user) {
      socket.emit('error', { code: 'PERMISSION_DENIED', message: '無效的使用者身分' });
      return;
    }
    const isAdmin = this.isCanvasAdmin(data.canvasId, user);

    try {
      const updated = reorderLayer(data.canvasId, data.layerId, data.newSortOrder, user.id, isAdmin);
      const allLayers = getLayersByCanvasId(data.canvasId);
      this.io.to(`canvas_${data.canvasId}`).emit('layers_sync', {
        canvasId: data.canvasId,
        layers: allLayers,
      });
    } catch (err: any) {
      socket.emit('error', { code: 'LAYER_ERROR', message: err.message });
    }
  }

  private handleReorderLayers(socket: Socket, data: { canvasId: string; layerIds: string[] }) {
    const user = socket.data.user as UserPayload;
    if (!user) {
      socket.emit('error', { code: 'PERMISSION_DENIED', message: '無效的使用者身分' });
      return;
    }
    const isAdmin = this.isCanvasAdmin(data.canvasId, user);

    try {
      if (!Array.isArray(data.layerIds)) throw new Error('layerIds 必須為陣列');
      const allLayers = reorderLayersList(data.canvasId, data.layerIds, user.id, isAdmin);
      this.io.to(`canvas_${data.canvasId}`).emit('layers_sync', {
        canvasId: data.canvasId,
        layers: allLayers,
      });
    } catch (err: any) {
      socket.emit('error', { code: 'LAYER_ERROR', message: err.message });
    }
  }

  private handleOpCommit(
    socket: Socket,
    data: { canvasId: string; layerId: string; opType: string; payload: unknown; clientSeq?: number }
  ) {
    this.commitOp(
      {
        user: socket.data.user as UserPayload,
        isGuest: Boolean(socket.data.isGuest),
        socketId: socket.id,
        reject: (rejected, guest) => {
          socket.emit('op_rejected', rejected);
          if (guest) socket.emit('error', { code: 'PERMISSION_DENIED', message: rejected.reason });
        },
      },
      data
    );
  }

  /**
   * Checks, sequences, stores and broadcasts one op. Sockets and REST (capsule restore writing
   * pixels into a new canvas) go through here alike. Returns the seq, or null when rejected.
   */
  public commitOp(
    origin: { user: UserPayload; isGuest?: boolean; socketId?: string; reject: (rejected: OpRejectedPacket, guest?: boolean) => void },
    data: { canvasId: string; layerId: string; opType: string; payload: unknown; clientSeq?: number }
  ): number | null {
    const { isGuest, user } = origin;
    if (!data || typeof data.layerId !== 'string' || typeof data.opType !== 'string') return null;

    // 1. Guest check
    if (isGuest) {
      const rejected: OpRejectedPacket = {
        type: 'OP_REJECTED',
        canvasId: data.canvasId,
        clientSeq: data.clientSeq,
        reason: '訪客（匿名用戶）僅具備即時檢視畫布權限，無法進行繪圖或編輯，請先登入帳號。',
      };
      origin.reject(rejected, true);
      return null;
    }

    // 2. Fetch layer
    const layer = getLayerById(data.layerId);
    if (!layer || layer.canvasId !== data.canvasId) {
      origin.reject({
        type: 'OP_REJECTED',
        canvasId: data.canvasId,
        clientSeq: data.clientSeq,
        reason: '目標圖層不存在或與當前畫布不匹配。',
      });
      return null;
    }

    // 3. Map opType to action
    let action: LayerAction = 'draw';
    const upperOp = data.opType.toUpperCase();
    if (upperOp === 'ERASE') action = 'erase';
    else if (upperOp === 'FILTER' || upperOp === 'LIQUIFY') action = 'filter';
    else if (upperOp === 'LAYER_OP' || upperOp === 'RENAME' || upperOp === 'BLEND_MODE') action = 'modify_props';
    else if (upperOp === 'TILE_PATCH') action = (data.payload as any)?.isEraser ? 'erase' : 'draw';

    // 4. ACL Check
    const canvasMember = getCanvasMembership(data.canvasId, user.id);
    const aclLayer = getAclLayer(layer);
    const layerPerm = getLayerPermissionForUser(aclLayer.id, user.id);

    const check = canUserPerformLayerAction(
      {
        user,
        canvasMember,
        layer: aclLayer,
        layerPermission: layerPerm,
      },
      action
    );

    if (!check.allowed) {
      const rejected: OpRejectedPacket = {
        type: 'OP_REJECTED',
        canvasId: data.canvasId,
        clientSeq: data.clientSeq,
        reason: check.reason || '無權限在該圖層執行操作。',
      };
      origin.reject(rejected);
      return null;
    }

    let payload = data.payload;
    if (upperOp === 'TILE_PATCH' && payload && typeof payload === 'object') {
      const patch = payload as TilePatchPacket;
      if (patch.historyTiles !== undefined) {
        const target = patch.targetOpSeq;
        const source = typeof target === 'number' && Number.isInteger(target) && target > 0 &&
          (patch.actionDesc === 'UNDO' || patch.actionDesc === 'REDO')
          ? db.select({ opType: canvasOps.opType }).from(canvasOps).where(and(
            eq(canvasOps.canvasId, data.canvasId),
            eq(canvasOps.layerId, data.layerId),
            eq(canvasOps.userId, user.id),
            eq(canvasOps.seq, target),
          )).get()
          : undefined;
        if ((source?.opType !== 'STROKE' && source?.opType !== 'ERASE' && source?.opType !== 'TILE_PATCH') ||
          !Array.isArray(patch.historyTiles)) {
          const { historyTiles: _history, ...visiblePatch } = patch;
          payload = visiblePatch;
        }
      }
    }

    // 5. Encode payload as binary MessagePack blob for SQLite canvas_ops table
    const now = Date.now();
    const payloadBytes = Buffer.from(encodePacket({
      type: 'OP_COMMIT',
      canvasId: data.canvasId,
      layerId: data.layerId,
      opType: data.opType,
      payload,
      clientSeq: data.clientSeq,
    } as any));

    // 6. Sequence + persist atomically, so a failed insert never burns a seq that replay would miss
    const seq = sqlite.transaction(() => {
      const nextSeq = incrementCanvasSeq(data.canvasId);
      db.insert(canvasOps).values({
        canvasId: data.canvasId,
        seq: nextSeq,
        userId: user.id,
        layerId: data.layerId,
        opType: data.opType,
        payloadBlob: payloadBytes,
        createdAt: now,
      }).run();
      return nextSeq;
    })();

    // 7. Authoritative Broadcast to all room participants
    const broadcastPacket: OpBroadcastPacket = {
      type: 'OP_BROADCAST',
      canvasId: data.canvasId,
      seq,
      userId: user.id,
      socketId: origin.socketId ?? '',
      displayName: user.displayName,
      layerId: data.layerId,
      opType: data.opType,
      payload,
      timestamp: now,
    };

    this.io.to(`canvas_${data.canvasId}`).emit('op_broadcast', broadcastPacket);

    // Track stroke counts & gamification level for all brush, eraser, lasso, and fill operations
    const isCountableStroke = DRAW_OP_TYPES.includes(data.opType.toUpperCase());

    if (isCountableStroke) {
      const userCount = (this.userStrokes.get(user.id) || 0) + 1;
      this.userStrokes.set(user.id, userCount);

      const canvasTotal = (this.canvasTotalStrokes.get(data.canvasId) || 0) + 1;
      this.canvasTotalStrokes.set(data.canvasId, canvasTotal);

      // Drawing time: only ops painted live (a socket), not REST bulk writes such as a capsule restore
      let drawTimeMs: number | undefined;
      if (origin.socketId) {
        const clock = this.drawClock(data.canvasId, user.id);
        const gap = now - clock.lastOpAt;
        if (clock.lastOpAt > 0 && gap > 0 && gap <= DRAW_TIME_MAX_GAP_MS) {
          clock.drawTimeMs += gap;
          try {
            addMemberDrawTime(data.canvasId, user.id, gap);
          } catch (err) {
            console.error('[Presence] Failed to store drawing time:', err);
          }
        }
        clock.lastOpAt = now;
        drawTimeMs = clock.drawTimeMs;
      }

      const memberMap = this.roomMembers.get(data.canvasId);
      if (memberMap && origin.socketId && memberMap.has(origin.socketId)) {
        const mem = memberMap.get(origin.socketId)!;
        mem.strokeCount = userCount;
        mem.level = calculatePainterLevel(userCount).level;
      }
      if (memberMap && drawTimeMs !== undefined) {
        for (const mem of memberMap.values()) if (mem.userId === user.id) mem.drawTimeMs = drawTimeMs;
      }

      this.io.to(`canvas_${data.canvasId}`).emit('stroke_stats_update', {
        canvasId: data.canvasId,
        userId: user.id,
        strokeCount: userCount,
        level: calculatePainterLevel(userCount).level,
        totalCanvasStrokes: canvasTotal,
        drawTimeMs,
      });
    }

    // 8. Every 50 ops, fold the op log into a real checkpoint so loading stays bounded. The fold
    // runs in a worker thread (snapshot.service), so it never holds up previews or later ops.
    if (seq > 0 && seq % 50 === 0) setImmediate(async () => {
      try {
        const snap = await createCheckpointInBackground(data.canvasId, seq);
        if (snap) {
          this.io.to(`canvas_${data.canvasId}`).emit('checkpoint_created', {
            canvasId: data.canvasId,
            seq,
            snapshotId: snap.id,
            timestamp: now,
          });
        }
      } catch (snapErr) {
        console.error(`[Checkpoint] Failed to auto-generate snapshot for canvas ${data.canvasId}:`, snapErr);
      }
    });
    return seq;
  }

  private handleTilePatch(socket: Socket, data: TilePatchPacket) {
    this.handleOpCommit(socket, {
      canvasId: data.canvasId,
      layerId: data.layerId,
      opType: 'TILE_PATCH',
      payload: data,
      clientSeq: data.clientSeq,
    });
  }

  private handleBinaryPacket(socket: Socket, rawBuffer: Buffer | Uint8Array) {
    try {
      const packet = decodePacket(rawBuffer) as AtelierPacket;

      // Binary packets bypass the socket.use gate, so repeat its room check here
      const canvasId = (packet as { canvasId?: string }).canvasId;
      if (packet.type !== 'JOIN_CANVAS' && !socket.rooms.has(`canvas_${canvasId}`)) return;

      switch (packet.type) {
        case 'JOIN_CANVAS':
          this.handleJoinCanvas(socket, packet.canvasId);
          break;
        case 'LEAVE_CANVAS':
          this.handleLeaveCanvas(socket, packet.canvasId);
          break;
        case 'CURSOR':
          this.handleCursor(socket, packet);
          break;
        case 'PREVIEW_DAB':
          this.handlePreviewDab(socket, packet);
          break;
        case 'OP_COMMIT':
          this.handleOpCommit(socket, packet);
          break;
        case 'TILE_PATCH':
          this.handleTilePatch(socket, packet);
          break;
        default:
          console.warn(`[Socket.io] Unhandled binary packet type: ${(packet as any).type}`);
      }
    } catch (err) {
      console.error('[Socket.io] Failed to decode binary packet:', err);
    }
  }

  private handleDisconnect(socket: Socket) {
    if (socket.data.joinedCanvases) {
      for (const canvasId of (socket.data.joinedCanvases as Set<string>)) {
        this.handleLeaveCanvas(socket, canvasId);
      }
    }
  }

  private getVoiceUsers(canvasId: string, ownSocketId: string) {
    const members = this.roomMembers.get(canvasId);
    return Array.from(this.voiceRooms.get(canvasId) ?? []).flatMap(([socketId, state]) => {
      const member = members?.get(socketId);
      if (socketId === ownSocketId || !member) return [];
      return [{ socketId, userId: member.userId, displayName: member.displayName, ...state }];
    });
  }

  private handleVoiceJoin(socket: Socket, canvasId: string) {
    if (!this.voiceRooms.has(canvasId)) {
      this.voiceRooms.set(canvasId, new Map());
    }
    const voice = this.voiceRooms.get(canvasId)!;
    if (voice.has(socket.id)) return;
    const state = { isMuted: false, isSpeaking: false };
    voice.set(socket.id, state);
    socket.join(`voice_${canvasId}`);

    const user = socket.data.user as UserPayload;
    socket.to(`canvas_${canvasId}`).emit('voice_user_joined', {
      canvasId,
      socketId: socket.id,
      userId: user.id,
      displayName: user.displayName,
      ...state,
    });

    socket.emit('voice_room_users', {
      canvasId,
      users: this.getVoiceUsers(canvasId, socket.id),
    });
  }

  private handleVoiceLeave(socket: Socket, canvasId: string) {
    const voice = this.voiceRooms.get(canvasId);
    if (voice?.delete(socket.id)) {
      if (voice.size === 0) this.voiceRooms.delete(canvasId);
      socket.leave(`voice_${canvasId}`);
      const user = socket.data.user as UserPayload;
      this.io.to(`canvas_${canvasId}`).emit('voice_user_left', {
        canvasId,
        socketId: socket.id,
        userId: user?.id,
      });
    }
  }

  private handleVoiceSignal(
    socket: Socket,
    data: {
      canvasId: string;
      targetSocketId?: string;
      targetUserId?: string;
      signalType: string;
      signalData?: any;
    }
  ) {
    const user = socket.data.user as UserPayload;
    const payload = {
      canvasId: data.canvasId,
      fromSocketId: socket.id,
      fromUserId: user.id,
      fromDisplayName: user.displayName,
      signalType: data.signalType,
      signalData: data.signalData,
    };

    if (data.targetSocketId) {
      this.io.to(data.targetSocketId).emit('voice_signal', payload);
    } else {
      socket.to(`canvas_${data.canvasId}`).emit('voice_signal', payload);
    }
  }

  private handleVoiceState(
    socket: Socket,
    data: { canvasId: string; isMuted: boolean; isSpeaking: boolean }
  ) {
    const state = this.voiceRooms.get(data.canvasId)?.get(socket.id);
    if (!state) return;
    state.isMuted = data.isMuted === true;
    state.isSpeaking = !state.isMuted && data.isSpeaking === true;
    const user = socket.data.user as UserPayload;
    this.io.to(`canvas_${data.canvasId}`).emit('voice_state', {
      canvasId: data.canvasId,
      socketId: socket.id,
      userId: user.id,
      displayName: user.displayName,
      ...state,
      inVoice: true,
    });
  }

  private handleStickerAdd(
    socket: Socket,
    data: { canvasId: string; sticker: CanvasSticker }
  ) {
    if (!this.canvasStickers.has(data.canvasId)) {
      this.canvasStickers.set(data.canvasId, new Map());
    }
    const map = this.canvasStickers.get(data.canvasId)!;
    map.set(data.sticker.id, data.sticker);

    // Broadcast to room
    this.io.to(`canvas_${data.canvasId}`).emit('sticker_added', {
      canvasId: data.canvasId,
      sticker: data.sticker,
    });
  }

  private handleStickerUpdate(
    socket: Socket,
    data: { canvasId: string; stickerId: string; updates: Partial<CanvasSticker> }
  ) {
    const map = this.canvasStickers.get(data.canvasId);
    if (map && map.has(data.stickerId)) {
      const existing = map.get(data.stickerId)!;
      const updated = { ...existing, ...data.updates };
      map.set(data.stickerId, updated);

      this.io.to(`canvas_${data.canvasId}`).emit('sticker_updated', {
        canvasId: data.canvasId,
        stickerId: data.stickerId,
        updates: data.updates,
      });
    }
  }

  private handleStickerRemove(
    socket: Socket,
    data: { canvasId: string; stickerId: string }
  ) {
    const map = this.canvasStickers.get(data.canvasId);
    if (map) {
      map.delete(data.stickerId);
      this.io.to(`canvas_${data.canvasId}`).emit('sticker_removed', {
        canvasId: data.canvasId,
        stickerId: data.stickerId,
      });
    }
  }

  private broadcastRoomState(canvasId: string) {
    const membersMap = this.roomMembers.get(canvasId);
    const members = Array.from(membersMap?.values() ?? [], (member) => {
      const strokeCount = this.userStrokes.get(member.userId) ?? 0;
      return { ...member, strokeCount, level: calculatePainterLevel(strokeCount).level };
    });
    const canvas = getCanvasById(canvasId);
    const onlineIds = new Set(members.map((m) => m.userId));
    let offlineMembers: RoomStatePacket['offlineMembers'] = [];
    try {
      const publicRoom = canvas?.accessMode === 'invite' && !canvas.roomPassHash;
      offlineMembers = listCanvasRoster(canvasId, publicRoom).filter((m) => !onlineIds.has(m.userId));
    } catch (err) {
      console.error('[Presence] Failed to list canvas members:', err);
    }

    const roomState: RoomStatePacket & { totalCanvasStrokes: number } = {
      type: 'ROOM_STATE',
      canvasId,
      latestSeq: canvas ? canvas.latestSeq : 0,
      members,
      offlineMembers,
      totalCanvasStrokes: this.canvasTotalStrokes.get(canvasId) || 0,
    };

    this.io.to(`canvas_${canvasId}`).emit('room_state', roomState);
  }

  /**
   * Pushes the layer stack to a room after a REST mutation; sockets only hear about socket-side
   * changes otherwise, and ops on a layer a client has never heard of are silently dropped there.
   */
  public broadcastLayers(canvasId: string) {
    // To everyone, the requester included: their other devices and tabs need it too
    this.io.to(`canvas_${canvasId}`).emit('layers_sync', {
      canvasId,
      layers: getLayersByCanvasId(canvasId),
    });
  }

  /** Tells everyone in the room (the resizer's other tabs too) to rebuild the canvas at its new size */
  public broadcastCanvasResized(canvasId: string, width: number, height: number, shifted: boolean = false) {
    this.io.to(`canvas_${canvasId}`).emit('canvas_resized', shifted ? { canvasId, width, height, shifted: true } : { canvasId, width, height });
  }

  /** Drops all realtime state of a deleted canvas */
  public closeRoom(canvasId: string) {
    this.io.in(`canvas_${canvasId}`).socketsLeave(`canvas_${canvasId}`);
    this.roomMembers.delete(canvasId);
    this.canvasStickers.delete(canvasId);
    this.voiceRooms.delete(canvasId);
    this.restoreStrokeTotals();
    for (const key of this.drawClocks.keys()) if (key.startsWith(`${canvasId}|`)) this.drawClocks.delete(key);
  }

  public disconnectUser(userId: string): void {
    for (const socket of this.io.sockets.sockets.values()) {
      if (socket.data.user?.id === userId) socket.disconnect(true);
    }
  }

  public getConnectedClientsCount(): number {
    return this.io.engine.clientsCount;
  }
}
