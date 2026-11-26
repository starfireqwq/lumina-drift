import React, { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { io as socketIO, Socket } from 'socket.io-client';
import * as socketParser from 'socket.io-parser';
import {
  tileSocketParser,
  calculatePainterLevel,
  CanvasSticker,
  ChatMessage,
  CursorPacket,
  LayerModel,
  MemberPresence,
  OfflineMemberInfo,
  OpBroadcastPacket,
  OpRejectedPacket,
  PainterLevelInfo,
  PRESENCE_IDLE_AFTER_MS,
  PresenceUpdatePacket,
  PreviewDabPacket,
  RoomMemberInfo,
  RoomStatePacket,
  TileData,
  TilePatchPacket,
} from '@atelier/shared';
import { useAuth } from './AuthContext';
import { ApiService } from '../services/api';
import { LOCAL_ARTIST_ID, OfflineSessionStore } from '../services/offlineStore';
import { VoiceChatManager, VoiceChatState } from '../engine/VoiceChatManager';
import { P2PTileManager, P2PStats } from '../engine/P2PTileManager';
import { getUserColor } from '../utils/userColors';
import { sharedRoomFromLocation } from '../utils/serverLinks';
import { resolveInitialActiveCanvasId, sanitizeOnlineGuestName } from '../utils/roomJoinGuard';

export interface EventLogItem {
  id: string;
  time: string;
  type: 'OP' | 'MEMBER' | 'CURSOR' | 'ERROR' | 'LAYER';
  message: string;
  color?: string;
}

type TilePatchMeta = Pick<TilePatchPacket, 'targetOpSeq' | 'historyTiles'> & {
  baseSeq?: number;
  clientOpId?: string;
  layerType?: LayerModel['layerType'];
};

/** Delay of one other painter's live previews (ms, last ~200 packets) */
export interface PreviewLatencyStat {
  socketId: string;
  userId: string;
  p50: number;
  p95: number;
  last: number;
  count: number;
}

export interface SocketTelemetrySnapshot {
  eventLogs: EventLogItem[];
  personalStrokes: number;
  totalCanvasStrokes: number;
  painterLevel: PainterLevelInfo;
  p2pStats: P2PStats;
  memberStats: Map<string, MemberStat>;
}

/** Live per-user figures that change with every op (drawTimeMs: on the active canvas) */
export interface MemberStat {
  strokeCount: number;
  level: number;
  drawTimeMs?: number;
}

interface SocketTelemetryContextValue {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => SocketTelemetrySnapshot;
  clearLogs: () => void;
}

interface SocketContextType {
  socket: Socket | null;
  isConnected: boolean;
  activeCanvasId: string | null;
  members: RoomMemberInfo[];
  /** Members of the active canvas with no connected tab, most recently seen first */
  offlineMembers: OfflineMemberInfo[];
  // Live, high-rate streams bypass React state: re-rendering every consumer (the whole workspace)
  // on each cursor / preview packet starved the main thread once several painters drew at once
  getRemoteCursors: () => Map<string, CursorPacket>;
  subscribeRemoteCursors: (cb: () => void) => () => void;
  subscribePreviewDabs: (cb: (packet: PreviewDabPacket) => void) => () => void;
  /** How late other painters' live previews arrive (server clock, so device clocks do not matter) */
  getPreviewLatency: () => PreviewLatencyStat[];
  /** Called as soon as remote ops are queued (drain them with takeBroadcastOps) */
  subscribeOps: (cb: () => void) => () => void;
  takeBroadcastOps: () => OpBroadcastPacket[]; // drains every remote op received since the last call
  /** Latest canvas op sequence number observed by this client */
  getLatestSeq: () => number;
  /** Called when the server assigns a seq number to an op this socket committed */
  subscribeOwnOpSeq: (cb: (clientOpId: string, seq: number, layerId: string) => void) => () => void;
  layerUpdateEvent: { layer: LayerModel; action: string; byUser: string } | null;
  stickers: CanvasSticker[];
  voiceState: VoiceChatState;
  p2pTileManager: P2PTileManager;
  joinCanvas: (canvasId: string) => void;
  getActiveCanvasId: () => string | null;
  clearActiveCanvas: () => void;
  emitCursor: (x: number, y: number, isDrawing?: boolean, brushSize?: number) => void;
  emitPreviewDab: (
    layerId: string,
    dabs: Array<{ x: number; y: number; pressure: number }>,
    color: string,
    brushSize: number,
    opacity?: number,
    isEraser?: boolean,
    quickShapePreviewId?: number
  ) => void;
  commitOp: (layerId: string, opType: string, payload: unknown) => void;
  flushCanvasWrites: () => Promise<void>;
  commitTilePatch: (
    layerId: string,
    tiles: TileData[],
    isUndo?: boolean,
    actionDesc?: string,
    meta?: TilePatchMeta
  ) => void;
  releaseLayer: (layerId: string) => void;
  claimLayer: (layerId: string, force?: boolean) => void;
  transferLayer: (layerId: string, targetUserId: string) => void;
  reorderLayer: (layerId: string, newSortOrder: number) => void;
  reorderLayersList: (layerIds: string[]) => void;
  layersSyncEvent: { canvasId: string; layers: LayerModel[] } | null;
  /** Someone in the room resized the canvas: the workspace rebuilds at this size */
  canvasResizedEvent: { canvasId: string; width: number; height: number; shifted?: boolean } | null;
  canvasUpdatedEvent: { canvasId: string; title: string; bgColor: string; accessMode: string; updatedAt: number; byUser: string } | null;
  addSticker: (sticker: Omit<CanvasSticker, 'id' | 'createdAt'>) => void;
  updateSticker: (stickerId: string, updates: Partial<CanvasSticker>) => void;
  removeSticker: (stickerId: string) => void;
  joinVoice: () => Promise<void>;
  setVoiceInputDevice: (id: string) => Promise<void>;
  setVoiceOutputDevice: (id: string) => Promise<void>;
  leaveVoice: () => void;
  toggleVoiceMute: () => boolean;
  adminForceMuteVoice?: (targetSocketId: string, targetUserId?: string) => void;
  adminKickVoice?: (targetSocketId: string, targetUserId?: string) => void;
  chatMessages: ChatMessage[];
  sendChatMessage: (text: string) => void;
  serverUrl: string;
  reconnectServer: (newServerUrl?: string) => void;
  /** Set when the server refused the active canvas for a missing / wrong room password */
  roomAccessError: { canvasId: string; code: 'PASSWORD_REQUIRED' | 'PASSWORD_INVALID'; message: string } | null;
  /** Retries joining a password room; the password is kept for reconnects in this tab */
  unlockRoom: (canvasId: string, password: string) => void;
}

const SocketContext = createContext<SocketContextType | undefined>(undefined);
const SocketTelemetryContext = createContext<SocketTelemetryContextValue | undefined>(undefined);

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token, user, isGuest, isLoading: authLoading } = useAuth();
  const socketRef = useRef<Socket | null>(null);
  const userRef = useRef(user);
  userRef.current = user;
  const [roomAccessError, setRoomAccessError] = useState<SocketContextType['roomAccessError']>(null);
  const joinPayload = (canvasId: string) => {
    const password = ApiService.getRoomPassword(canvasId);
    return password ? { canvasId, password } : { canvasId };
  };
  const voiceManagerRef = useRef<VoiceChatManager>(null!);
  voiceManagerRef.current ??= new VoiceChatManager();

  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return resolveInitialActiveCanvasId({
        isOfflineMode: OfflineSessionStore.isOfflineMode(),
        sharedRoomId: sharedRoomFromLocation(),
        savedCanvasId: localStorage.getItem('atelier_active_canvas_id'),
      });
    }
    return null;
  });
  const activeCanvasIdRef = useRef<string | null>(activeCanvasId);
  activeCanvasIdRef.current = activeCanvasId;
  // Emitters are captured once by the canvas engine, so they must read live values through refs
  const isGuestRef = useRef<boolean>(isGuest);
  isGuestRef.current = isGuest;
  // Remote ops are queued, not held in state: React batches state updates, so two ops arriving
  // together would otherwise collapse into one and the first would never be drawn
  const opQueueRef = useRef<OpBroadcastPacket[]>([]);
  const latestSeqRef = useRef<number>(0);
  const pendingCanvasWrites = useRef(new Map<string, { socket: Socket; opId: string }>());
  const joinedCanvasIdRef = useRef<string | null>(null);
  const [members, setMembers] = useState<RoomMemberInfo[]>([]);
  const [offlineMembers, setOfflineMembers] = useState<OfflineMemberInfo[]>([]);
  /** What this tab last reported: idle after a while without input (see the presence effect) */
  const presenceRef = useRef<MemberPresence>('online');
  const remoteCursorsRef = useRef(new Map<string, CursorPacket>());
  const cursorListenersRef = useRef(new Set<() => void>());
  const previewListenersRef = useRef(new Set<(packet: PreviewDabPacket) => void>());
  const opListenersRef = useRef(new Set<() => void>());
  const ownOpSeqListenersRef = useRef(new Set<(clientOpId: string, seq: number, layerId: string) => void>());
  /** Same call shape as the old state setter, but only the cursor layer hears about it */
  const setRemoteCursors = (update: Map<string, CursorPacket> | ((prev: Map<string, CursorPacket>) => Map<string, CursorPacket>)) => {
    const next = typeof update === 'function' ? update(remoteCursorsRef.current) : update;
    if (next === remoteCursorsRef.current) return;
    remoteCursorsRef.current = next;
    cursorListenersRef.current.forEach((l) => l());
  };
  // Preview latency: our clock's offset to the server, and the last delays per sending socket
  const clockOffsetRef = useRef(0);
  const latencyRef = useRef(new Map<string, { userId: string; samples: number[]; at: number }>());
  const [liveStreams] = useState(() => ({
    getPreviewLatency: (): PreviewLatencyStat[] => {
      const now = Date.now();
      const out: PreviewLatencyStat[] = [];
      for (const [socketId, s] of latencyRef.current) {
        if (now - s.at > 60000 || s.samples.length === 0) continue; // only painters drawing in the last minute
        const sorted = [...s.samples].sort((a, b) => a - b);
        const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
        out.push({ socketId, userId: s.userId, p50: q(0.5), p95: q(0.95), last: s.samples[s.samples.length - 1], count: s.samples.length });
      }
      return out;
    },
    getRemoteCursors: () => remoteCursorsRef.current,

    subscribeRemoteCursors: (cb: () => void) => {
      cursorListenersRef.current.add(cb);
      return () => { cursorListenersRef.current.delete(cb); };
    },
    subscribePreviewDabs: (cb: (packet: PreviewDabPacket) => void) => {
      previewListenersRef.current.add(cb);
      return () => { previewListenersRef.current.delete(cb); };
    },
    subscribeOps: (cb: () => void) => {
      opListenersRef.current.add(cb);
      return () => { opListenersRef.current.delete(cb); };
    },
    getLatestSeq: () => latestSeqRef.current,
    subscribeOwnOpSeq: (cb: (clientOpId: string, seq: number, layerId: string) => void) => {
      ownOpSeqListenersRef.current.add(cb);
      return () => { ownOpSeqListenersRef.current.delete(cb); };
    },
  }));
  // For the browser load test (tests/load-browsers.ts), like window.__debugPixi
  (window as unknown as { __atelierLatency?: () => PreviewLatencyStat[] }).__atelierLatency = liveStreams.getPreviewLatency;

  // Status that follows every op (log lines, stroke stats, P2P) lives outside SocketContext React
  // state so busy multi-painter rooms only re-render the tiny panels that actually show telemetry.
  const p2pManagerRef = useRef<P2PTileManager>(new P2PTileManager());
  const telemetryListenersRef = useRef(new Set<() => void>());
  const telemetryRef = useRef<SocketTelemetrySnapshot>({
    eventLogs: [],
    personalStrokes: 0,
    totalCanvasStrokes: 0,
    painterLevel: calculatePainterLevel(0),
    p2pStats: p2pManagerRef.current.getStats(),
    memberStats: new Map(),
  });
  const notifyTelemetry = () => {
    telemetryRef.current = { ...telemetryRef.current };
    telemetryListenersRef.current.forEach((l) => l());
  };
  const uiBatchRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    logs: Array<{ type: EventLogItem['type']; message: string; color?: string }>;
    totalCanvasStrokes?: number;
    personalStrokes?: number;
    memberUpdates: Map<string, MemberStat>;
  }>({ timer: null, logs: [], memberUpdates: new Map() });
  const scheduleUiFlush = () => {
    const batch = uiBatchRef.current;
    if (batch.timer) return;
    batch.timer = setTimeout(() => {
      const { logs, totalCanvasStrokes, personalStrokes, memberUpdates } = batch;
      batch.timer = null;
      batch.logs = [];
      batch.totalCanvasStrokes = undefined;
      batch.personalStrokes = undefined;
      batch.memberUpdates = new Map();
      const cur = telemetryRef.current;
      let changed = false;
      let nextLogs = cur.eventLogs;
      if (logs.length) {
        const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
        const recent = logs.slice(-50).reverse().map((l) => ({
          id: Math.random().toString(36).slice(2),
          time,
          type: l.type,
          message: l.message,
          color: l.color,
        }));
        nextLogs = [...recent, ...cur.eventLogs].slice(0, 50);
        changed = true;
      }
      let nextTotal = cur.totalCanvasStrokes;
      if (totalCanvasStrokes !== undefined && totalCanvasStrokes !== cur.totalCanvasStrokes) {
        nextTotal = totalCanvasStrokes;
        changed = true;
      }
      let nextPersonal = cur.personalStrokes;
      let nextLevel = cur.painterLevel;
      if (personalStrokes !== undefined && personalStrokes !== cur.personalStrokes) {
        nextPersonal = personalStrokes;
        nextLevel = calculatePainterLevel(personalStrokes);
        changed = true;
      }
      let nextMembers = cur.memberStats;
      if (memberUpdates.size > 0) {
        nextMembers = new Map(cur.memberStats);
        memberUpdates.forEach((v, k) => nextMembers.set(k, v));
        changed = true;
      }
      if (changed) {
        telemetryRef.current = {
          ...cur,
          eventLogs: nextLogs,
          totalCanvasStrokes: nextTotal,
          personalStrokes: nextPersonal,
          painterLevel: nextLevel,
          memberStats: nextMembers,
        };
        telemetryListenersRef.current.forEach((l) => l());
      }
    }, 300);
  };
  const [telemetryContextValue] = useState<SocketTelemetryContextValue>(() => ({
    subscribe: (cb: () => void) => {
      telemetryListenersRef.current.add(cb);
      return () => { telemetryListenersRef.current.delete(cb); };
    },
    getSnapshot: () => telemetryRef.current,
    clearLogs: () => {
      uiBatchRef.current.logs = [];
      telemetryRef.current = { ...telemetryRef.current, eventLogs: [] };
      telemetryListenersRef.current.forEach((l) => l());
    },
  }));
  const [layerUpdateEvent, setLayerUpdateEvent] = useState<{ layer: LayerModel; action: string; byUser: string } | null>(null);
  const [layersSyncEvent, setLayersSyncEvent] = useState<{ canvasId: string; layers: LayerModel[] } | null>(null);
  const [canvasResizedEvent, setCanvasResizedEvent] = useState<SocketContextType['canvasResizedEvent']>(null);
  const [canvasUpdatedEvent, setCanvasUpdatedEvent] = useState<SocketContextType['canvasUpdatedEvent']>(null);

  // Phase 6: Stickers & Voice state
  const [stickers, setStickers] = useState<CanvasSticker[]>([]);
  const [voiceState, setVoiceState] = useState<VoiceChatState>(voiceManagerRef.current.getState());

  // Dynamic server endpoint connection
  const [currentServerUrl, setCurrentServerUrl] = useState<string>(() =>
    OfflineSessionStore.isOfflineMode() ? 'offline' : ApiService.getServerUrl()
  );
  // Realtime Text Chat Room State
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  const sendChatMessage = (text: string) => {
    if (!text.trim()) return;
    const cid = activeCanvasIdRef.current || activeCanvasId || 'canvas_global';
    const msgId = 'msg_' + Math.random().toString(36).substring(2, 10);
    const localMsg: ChatMessage = {
      id: msgId,
      canvasId: cid,
      userId: user?.id || 'guest',
      displayName: user?.displayName || '訪客畫師',
      avatarUrl: user?.avatarUrl || null,
      color: user?.id ? getUserColor(user.id).hex : '#6366F1',
      text: text.trim().slice(0, 500),
      timestamp: Date.now(),
    };
    // Optimistic UI: display immediately in drawer!
    setChatMessages((prev) => [...prev.slice(-99), localMsg]);

    if (socketRef.current) {
      socketRef.current.emit('chat_message', {
        canvasId: cid,
        text: text.trim(),
        id: msgId,
      });
    }
  };

  const reconnectServer = (newServerUrl?: string) => {
    if (newServerUrl === 'offline') {
      OfflineSessionStore.setSessionMode('offline');
      setCurrentServerUrl('offline');
      return;
    }
    if (OfflineSessionStore.isOfflineMode()) {
      OfflineSessionStore.setSessionMode('collaborative');
      setMembers((prev) => (prev.some((m) => m.userId === LOCAL_ARTIST_ID) ? [] : prev));
    }
    if (newServerUrl !== undefined) ApiService.setServerUrl(newServerUrl);
    setCurrentServerUrl(ApiService.getServerUrl());
  };

  useEffect(() => {
    const onServerChanged = () => {
      if (!OfflineSessionStore.isOfflineMode()) setCurrentServerUrl(ApiService.getServerUrl());
    };
    window.addEventListener('atelier:server-changed', onServerChanged);
    return () => window.removeEventListener('atelier:server-changed', onServerChanged);
  }, []);

  useEffect(() => {
    return voiceManagerRef.current.subscribe((state) => {
      setVoiceState(state);
    });
  }, []);

  useEffect(() => {
    return p2pManagerRef.current.subscribe((stats) => {
      telemetryRef.current.p2pStats = stats;
      notifyTelemetry();
    });
  }, []);

  useEffect(() => {
    voiceManagerRef.current.setCanvasId(activeCanvasId);
    p2pManagerRef.current.setCanvas(activeCanvasId, user?.id || 'guest');
  }, [activeCanvasId, user?.id]);

  const addLog = (type: EventLogItem['type'], message: string, color?: string) => {
    uiBatchRef.current.logs.push({ type, message, color });
    if (uiBatchRef.current.logs.length > 100) uiBatchRef.current.logs.splice(0, uiBatchRef.current.logs.length - 50);
    scheduleUiFlush();
  };

  const enqueueOp = (op: OpBroadcastPacket) => {
    opQueueRef.current.push(op);
    opListenersRef.current.forEach((l) => l());
    scheduleUiFlush();
  };
  const takeBroadcastOps = () => opQueueRef.current.splice(0);

  useEffect(() => {
    // Wait for AuthContext to settle: connecting before /auth/me returned and again after it
    // (the user object changed) opened two sockets on every page load
    if (authLoading) {
      if (!OfflineSessionStore.isOfflineMode() && currentServerUrl !== 'offline') {
        setMembers((prev) => (prev.some((m) => m.userId === LOCAL_ARTIST_ID) ? [] : prev));
      }
      return;
    }
    if (OfflineSessionStore.isOfflineMode() || currentServerUrl === 'offline') {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      joinedCanvasIdRef.current = null;
      setRoomAccessError(null);
      setIsConnected(false);
      setMembers([
        {
          socketId: 'local_offline',
          userId: LOCAL_ARTIST_ID,
          displayName: userRef.current?.displayName || '本機畫師',
          serverRole: 'admin',
          isGuest: false,
          joinedAt: Date.now(),
          presence: 'online',
          color: '#6366F1',
        },
      ]);
      return;
    }
    setMembers((prev) => (prev.some((m) => m.userId === LOCAL_ARTIST_ID) ? [] : prev));
    // Connect to Socket.io with specified server endpoint or relative origin
    const target = currentServerUrl || '/';

    const socket = socketIO(target, {
      // A function, so every (re)connection sends the canvas that is active right now: the server
      // joins it during the handshake, before the ops buffered while offline are flushed.
      // (socket.io flushes that buffer before 'connect' fires, i.e. before join_canvas below.)
      auth: (cb) => {
        const liveId = activeCanvasIdRef.current;
        const onlineCanvasId = liveId && !OfflineSessionStore.isOfflineCanvas(liveId) ? liveId : null;
        cb({
          token: token || undefined,
          displayName: sanitizeOnlineGuestName(userRef.current?.displayName, '訪客'),
          ...(onlineCanvasId && joinPayload(onlineCanvasId)),
        });
      },
      transports: ['websocket', 'polling'],
      autoConnect: true,
      parser: tileSocketParser(socketParser), // more than 10 tiles per op, see tileSocketParser
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      // Clock offset to the server from the fastest of a few round trips (half the round trip each way)
      let best = Infinity;
      for (let i = 0; i < 5; i++) {
        setTimeout(() => {
          const t0 = Date.now();
          socket.timeout(3000).emit('time_sync', null, (err: unknown, serverNow: number) => {
            const rtt = Date.now() - t0;
            if (err || typeof serverNow !== 'number' || rtt >= best) return;
            best = rtt;
            clockOffsetRef.current = serverNow - (t0 + rtt / 2);
          });
        }, i * 200);
      }
      addLog('MEMBER', `已建立即時連線 (Socket ID: ${socket.id})`, '#10B981');
      const liveId = activeCanvasIdRef.current;
      if (liveId && !OfflineSessionStore.isOfflineCanvas(liveId)) {
        joinedCanvasIdRef.current = liveId;
        socket.emit('join_canvas', joinPayload(liveId));
      }
      voiceManagerRef.current.init(socket);
      p2pManagerRef.current.init(socket, (p2pPacket) => {
        if (p2pPacket.canvasId === activeCanvasIdRef.current) {
          enqueueOp({
            type: 'OP_BROADCAST',
            canvasId: p2pPacket.canvasId,
            seq: 0,
            userId: p2pPacket.senderUserId,
            displayName: 'P2P 畫友',
            layerId: p2pPacket.layerId,
            opType: 'TILE_PATCH',
            payload: {
              tiles: p2pPacket.tiles,
              clientOpId: p2pPacket.clientOpId,
              baseSeq: p2pPacket.baseSeq,
              ...(p2pPacket.samplePoints?.length && p2pPacket.size
                ? { samplePoints: p2pPacket.samplePoints, size: p2pPacket.size }
                : {}),
            },
            timestamp: p2pPacket.timestamp,
          });
        }
      });
    });

    socket.on('connect_error', (err) => {
      console.warn('[Socket] Connect error:', err.message);
      setIsConnected(false);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      addLog('MEMBER', '與伺服器中斷連線', '#EF4444');
    });

    socket.on('auth_ack', (data) => {
      console.log('[Socket] Auth ACK:', data);
    });

    socket.on('chat_message', (msg: ChatMessage) => {
      setChatMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev.slice(-99), msg];
      });
      addLog('MEMBER', `💬 [${msg.displayName}]: ${msg.text}`, msg.color || '#6366F1');
    });

    socket.on('sticker_sync', (data: { canvasId: string; stickers: CanvasSticker[] }) => {
      setStickers(data.stickers || []);
    });

    socket.on('sticker_added', (data: { canvasId: string; sticker: CanvasSticker }) => {
      setStickers((prev) => [...prev.filter((s) => s.id !== data.sticker.id), data.sticker]);
      addLog('OP', `${data.sticker.ownerName} 釘選了「${data.sticker.title || '貼圖'}」`, '#8B5CF6');
    });

    socket.on(
      'sticker_updated',
      (data: { canvasId: string; stickerId: string; updates: Partial<CanvasSticker> }) => {
        setStickers((prev) =>
          prev.map((s) => (s.id === data.stickerId ? { ...s, ...data.updates } : s))
        );
      }
    );

    socket.on('sticker_removed', (data: { canvasId: string; stickerId: string }) => {
      setStickers((prev) => prev.filter((s) => s.id !== data.stickerId));
    });

    socket.on('room_state', (state: RoomStatePacket & { totalCanvasStrokes?: number }) => {
      if (state.canvasId === activeCanvasIdRef.current) {
        // Joined: any password prompt for this canvas is answered
        setRoomAccessError((prev) => (prev?.canvasId === state.canvasId ? null : prev));
        setMembers(state.members);
        setOfflineMembers(state.offlineMembers ?? []);
        // A (re)joined socket starts out online on the server: tell it if this tab is idle
        const mine = state.members.find((m) => m.socketId === socket.id);
        if (mine && (mine.presence ?? 'online') !== presenceRef.current) {
          socket.emit('presence', { canvasId: state.canvasId, presence: presenceRef.current });
        }

        // A rejoin after a dropped connection reports a newer seq than the last op seen here:
        // those ops were broadcast while this socket was away, so fetch exactly that gap
        const seenSeq = latestSeqRef.current;
        latestSeqRef.current = Math.max(seenSeq, state.latestSeq);
        if (seenSeq > 0 && state.latestSeq > seenSeq) {
          ApiService.getOpsSince(state.canvasId, seenSeq)
            .then((res) => {
              if (state.canvasId !== activeCanvasIdRef.current) return;
              for (const op of res?.ops || []) {
                enqueueOp({ type: 'OP_BROADCAST', displayName: '', timestamp: op.createdAt, ...op });
              }
            })
            .catch((err) => console.warn('[Socket] Missed-op catch-up failed:', err));
        }

        const nextStats = new Map<string, MemberStat>();
        for (const m of state.members) {
          if (m.strokeCount !== undefined) {
            nextStats.set(m.userId, { strokeCount: m.strokeCount, level: m.level ?? 1, drawTimeMs: m.drawTimeMs });
          }
        }
        telemetryRef.current.memberStats = nextStats;
        if (state.totalCanvasStrokes !== undefined) {
          telemetryRef.current.totalCanvasStrokes = state.totalCanvasStrokes;
        }
        const myMem = state.members.find((m) => m.userId === user?.id);
        if (myMem?.strokeCount !== undefined) {
          telemetryRef.current.personalStrokes = myMem.strokeCount;
          telemetryRef.current.painterLevel = calculatePainterLevel(myMem.strokeCount);
        }
        notifyTelemetry();
        p2pManagerRef.current.syncRoomMembers(state.members.map((m) => m.socketId));

        // Purge obsolete remote cursors from members who left / logged in with new identity
        const activeUserIds = new Set(state.members.map((m) => m.userId));
        setRemoteCursors((prev) => {
          let changed = false;
          const next = new Map(prev);
          for (const uid of next.keys()) {
            if (!activeUserIds.has(uid) || uid === user?.id) {
              next.delete(uid);
              changed = true;
            }
          }
          return changed ? next : prev;
        });

        addLog('MEMBER', `房間狀態更新：目前在線人數 ${state.members.length} 人`, '#3B82F6');
      }
    });

    socket.on('cursor_remove', (data: { canvasId: string; userId: string }) => {
      if (data.canvasId === activeCanvasIdRef.current) {
        setRemoteCursors((prev) => {
          if (!prev.has(data.userId)) return prev;
          const next = new Map(prev);
          next.delete(data.userId);
          return next;
        });
      }
    });

    socket.on(
      'stroke_stats_update',
      (data: {
        canvasId: string;
        userId: string;
        strokeCount: number;
        level: number;
        totalCanvasStrokes: number;
        drawTimeMs?: number;
      }) => {
        if (data.canvasId === activeCanvasIdRef.current) {
          const batch = uiBatchRef.current;
          batch.totalCanvasStrokes = data.totalCanvasStrokes;
          if (data.userId === user?.id) {
            batch.personalStrokes = data.strokeCount;
          }
          const drawTimeMs = data.drawTimeMs
            ?? batch.memberUpdates.get(data.userId)?.drawTimeMs
            ?? telemetryRef.current.memberStats.get(data.userId)?.drawTimeMs;
          batch.memberUpdates.set(data.userId, { strokeCount: data.strokeCount, level: data.level, drawTimeMs });
          scheduleUiFlush();
        }
      }
    );

    socket.on('presence_update', (p: PresenceUpdatePacket) => {
      if (p.canvasId !== activeCanvasIdRef.current) return;
      setMembers((prev) => prev.map((m) => (m.socketId === p.socketId ? { ...m, presence: p.presence } : m)));
    });

    socket.on('cursor', (cursor: CursorPacket) => {
      if (cursor.canvasId === activeCanvasIdRef.current && cursor.userId !== user?.id) {
        remoteCursorsRef.current.set(cursor.userId, cursor);
        cursorListenersRef.current.forEach((l) => l());
      }
    });

    // A busy link gets several painters' previews merged into one message (server: sendPreview)
    socket.on('preview_batch', (packets: PreviewDabPacket[]) => {
      if (Array.isArray(packets)) packets.forEach(onPreview);
    });
    socket.on('preview_dab', (packet: PreviewDabPacket) => onPreview(packet));
    function onPreview(packet: PreviewDabPacket) {
      if (packet?.canvasId === activeCanvasIdRef.current) {
        previewListenersRef.current.forEach((l) => l(packet));
        if (typeof packet.sentAt === 'number') {
          const key = packet.socketId ?? packet.userId;
          const s = latencyRef.current.get(key) ?? { userId: packet.userId, samples: [], at: 0 };
          s.samples.push(Math.max(0, Date.now() + clockOffsetRef.current - packet.sentAt));
          if (s.samples.length > 200) s.samples.shift();
          s.at = Date.now();
          latencyRef.current.set(key, s);
        }
      }
    }

    socket.on('op_broadcast', (op: OpBroadcastPacket) => {
      const pending = pendingCanvasWrites.current.get(op.canvasId);
      if (pending?.socket === socket && op.socketId === socket.id && pending.opId === (op.payload as any)?.clientOpId) {
        pendingCanvasWrites.current.delete(op.canvasId);
      }
      if (op.canvasId === activeCanvasIdRef.current) {
        latestSeqRef.current = Math.max(latestSeqRef.current, op.seq);
        // Skip our own echo by socket, not by user: the same account on a second device must sync
        if (op.socketId !== socket.id) {
          opQueueRef.current.push(op);
          opListenersRef.current.forEach((l) => l());
        } else {
          const clientOpId = (op.payload as any)?.clientOpId;
          if (typeof clientOpId === 'string' && op.seq > 0) {
            ownOpSeqListenersRef.current.forEach((l) => l(clientOpId, op.seq, op.layerId ?? ''));
          }
        }
        addLog(
          'OP',
          `#${op.seq} [${op.opType}] 來自 ${op.displayName}`,
          '#F59E0B'
        );
      }
    });

    socket.on('checkpoint_created', (data: { canvasId: string; seq: number; snapshotId: string; timestamp: number }) => {
      if (data.canvasId === activeCanvasIdRef.current) {
        addLog('OP', `[檢查點快照] 畫布已自動產生增量快照 #${data.seq}`, '#10B981');
      }
    });

    socket.on('layer_updated', (data: { canvasId: string; layer: LayerModel; action: string; byUser: string }) => {
      if (data.canvasId === activeCanvasIdRef.current) {
        setLayerUpdateEvent(data);
        if (data.action === 'create' || data.action === 'update') return;
        const actionText =
          data.action === 'release'
            ? '已釋放圖層為所有人皆可拿取'
            : data.action === 'force_claim'
            ? '管理員強制接管了圖層'
            : '已接管圖層';
        addLog(
          'LAYER',
          `[圖層異動] ${data.byUser} ${actionText}「${data.layer.name}」`,
          '#A855F7'
        );
      }
    });

    socket.on('layers_sync', (data: { canvasId: string; layers: LayerModel[] }) => {
      if (data.canvasId === activeCanvasIdRef.current) {
        setLayersSyncEvent(data);
        addLog('LAYER', `[圖層同步] 圖層堆疊順序已更新 (共 ${data.layers.length} 層)`, '#10B981');
      }
    });

    socket.on('canvas_resized', (data: { canvasId: string; width: number; height: number; shifted?: boolean }) => {
      setCanvasResizedEvent(data);
      addLog('LAYER', `[畫布] 尺寸已調整為 ${data.width}×${data.height}`, '#10B981');
    });

    socket.on('canvas_updated', setCanvasUpdatedEvent);

    socket.on('op_rejected', (rej: OpRejectedPacket) => {
      addLog('ERROR', `操作遭拒絕: ${rej.reason}`, '#EF4444');
    });

    socket.on('error', (err: { code: string; message: string }) => {
      if (err.code === 'PASSWORD_REQUIRED' || err.code === 'PASSWORD_INVALID') {
        const canvasId = activeCanvasIdRef.current;
        if (canvasId) {
          if (err.code === 'PASSWORD_INVALID') {
            ApiService.setRoomPassword(canvasId, null);
          }
          setRoomAccessError({ canvasId, code: err.code, message: err.message });
        }
        return;
      }
      addLog('ERROR', `[${err.code}] ${err.message}`, '#EF4444');
    });

    return () => {
      socket.off('canvas_updated', setCanvasUpdatedEvent);
      socket.disconnect();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      joinedCanvasIdRef.current = null;
    };
  }, [token, user?.id, user?.displayName, currentServerUrl, authLoading]);

  // Presence: idle after a while with no pointer / key / touch input on this page, online again on
  // the next input. `atelier_idle_after_ms` in localStorage shortens the wait (tests).
  useEffect(() => {
    let override = 0;
    try {
      override = Number(localStorage.getItem('atelier_idle_after_ms')) || 0;
    } catch {
      /* storage blocked: keep the default */
    }
    const idleAfter = override > 0 ? override : PRESENCE_IDLE_AFTER_MS;
    let lastInput = Date.now();
    const report = (presence: MemberPresence) => {
      presenceRef.current = presence;
      const socket = socketRef.current;
      const canvasId = activeCanvasIdRef.current;
      // Offline: the room_state of the next join compares and resends it
      if (socket?.connected && canvasId) socket.emit('presence', { canvasId, presence });
    };
    const onInput = () => {
      lastInput = Date.now();
      if (presenceRef.current === 'idle') report('online');
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, onInput, { capture: true, passive: true });
    const timer = setInterval(() => {
      if (presenceRef.current === 'online' && Date.now() - lastInput >= idleAfter) report('idle');
    }, Math.min(15_000, Math.max(250, idleAfter / 4)));
    return () => {
      for (const e of events) window.removeEventListener(e, onInput, { capture: true });
      clearInterval(timer);
    };
  }, []);

  // When activeCanvasId changes, rejoin (or hydrate persisted offline canvas telemetry)
  useEffect(() => {
    if (!activeCanvasId) {
      const previous = joinedCanvasIdRef.current;
      if (previous && socketRef.current) {
        socketRef.current.emit('leave_canvas', { canvasId: previous });
      }
      joinedCanvasIdRef.current = null;
      setRoomAccessError(null);
      return;
    }
    if (OfflineSessionStore.isOfflineCanvas(activeCanvasId)) {
      if (!OfflineSessionStore.isOfflineMode()) {
        const previous = joinedCanvasIdRef.current;
        if (previous && socketRef.current) {
          socketRef.current.emit('leave_canvas', { canvasId: previous });
        }
        joinedCanvasIdRef.current = null;
        return;
      }
      void OfflineSessionStore.ensureInitialized().then(() => {
        if (activeCanvasIdRef.current !== activeCanvasId) return;
        const tel = OfflineSessionStore.getCanvasTelemetry(activeCanvasId);
        const lvl = calculatePainterLevel(tel.strokeCount);
        const nextMembers = new Map(telemetryRef.current.memberStats);
        nextMembers.set(LOCAL_ARTIST_ID, {
          strokeCount: tel.strokeCount,
          level: lvl.level,
          drawTimeMs: tel.drawTimeMs,
        });
        telemetryRef.current = {
          ...telemetryRef.current,
          totalCanvasStrokes: tel.strokeCount,
          personalStrokes: tel.strokeCount,
          painterLevel: lvl,
          memberStats: nextMembers,
        };
        telemetryListenersRef.current.forEach((l) => l());
        setMembers((prev) =>
          prev.map((m) =>
            m.userId === LOCAL_ARTIST_ID
              ? { ...m, strokeCount: tel.strokeCount, level: lvl.level, drawTimeMs: tel.drawTimeMs }
              : m
          )
        );
      });
      return;
    }
    if (!socketRef.current) return;

    // Leave the previous room first: otherwise this socket stays listed there as a ghost member
    // and keeps downloading every tile painted on a canvas it no longer shows
    const previous = joinedCanvasIdRef.current;
    if (previous === activeCanvasId) return;
    if (previous && previous !== activeCanvasId) {
      socketRef.current.emit('leave_canvas', { canvasId: previous });
    }
    joinedCanvasIdRef.current = activeCanvasId;
    opQueueRef.current = [];
    latestSeqRef.current = 0;

    setRoomAccessError(null);
    socketRef.current.emit('join_canvas', joinPayload(activeCanvasId));
    setRemoteCursors(new Map());
    addLog('MEMBER', `正在切換並同步畫布 #${activeCanvasId.slice(0, 8)}...`, '#6366F1');
  }, [activeCanvasId]);

  const joinCanvas = (canvasId: string) => {
    setActiveCanvasId(canvasId);
    activeCanvasIdRef.current = canvasId;
    if (typeof window !== 'undefined') {
      localStorage.setItem('atelier_active_canvas_id', canvasId);
    }
  };

  const getActiveCanvasId = () => activeCanvasIdRef.current;

  const clearActiveCanvas = () => {
    setActiveCanvasId(null);
    activeCanvasIdRef.current = null;
  };

  const emitCursor = (x: number, y: number, isDrawing: boolean = false, brushSize: number = 8) => {
    const canvasId = activeCanvasIdRef.current;
    if (!socketRef.current || !canvasId) return;
    socketRef.current.volatile.emit('cursor', {
      canvasId,
      x,
      y,
      pressure: 0.5,
      isDrawing: isGuestRef.current ? false : isDrawing,
      brushSize,
    });
  };

  const emitPreviewDab = (
    layerId: string,
    dabs: Array<{ x: number; y: number; pressure: number }>,
    color: string,
    brushSize: number,
    opacity: number = 1.0,
    isEraser: boolean = false,
    quickShapePreviewId?: number
  ) => {
    const canvasId = activeCanvasIdRef.current;
    if (!socketRef.current || !canvasId || isGuestRef.current) return;
    // Reliable, not volatile: dropped previews showed up as gaps in other painters' live strokes
    socketRef.current.emit('preview_dab', {
      canvasId,
      layerId,
      color,
      brushSize,
      opacity,
      isEraser,
      quickShapePreviewId,
      sentAt: Date.now() + clockOffsetRef.current, // on the server clock
      // 0.1 px / 0.01 pressure is plenty for a preview and keeps packets small
      dabs: dabs.map((d) => ({ x: Math.round(d.x * 10) / 10, y: Math.round(d.y * 10) / 10, pressure: Math.round(d.pressure * 100) / 100 })),
    });
  };

  const commitOp = (layerId: string, opType: string, payload: unknown) => {
    const canvasId = activeCanvasIdRef.current;
    if (!canvasId) return;
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      const clientOpId =
        payload && typeof payload === 'object' && typeof (payload as any).clientOpId === 'string'
          ? (payload as any).clientOpId
          : `cop_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const seq = OfflineSessionStore.commitLocalOp(canvasId, layerId, opType, payload);
      const tel = OfflineSessionStore.recordLocalStroke(canvasId, true);
      const lvl = calculatePainterLevel(tel.strokeCount).level;
      latestSeqRef.current = seq;
      ownOpSeqListenersRef.current.forEach((cb) => cb(clientOpId, seq, layerId));
      uiBatchRef.current.personalStrokes = tel.strokeCount;
      uiBatchRef.current.totalCanvasStrokes = tel.strokeCount;
      uiBatchRef.current.memberUpdates.set(LOCAL_ARTIST_ID, {
        strokeCount: tel.strokeCount,
        level: lvl,
        drawTimeMs: tel.drawTimeMs,
      });
      scheduleUiFlush();
      return;
    }
    if (!socketRef.current) return;
    if (isGuestRef.current) {
      addLog('ERROR', '訪客僅能即時查看畫布，無法進行繪圖！請先登入帳號。', '#EF4444');
      return;
    }

    const enrichedPayload =
      payload && typeof payload === 'object'
        ? {
            ...(payload as Record<string, unknown>),
            baseSeq: typeof (payload as any).baseSeq === 'number' ? (payload as any).baseSeq : latestSeqRef.current,
            clientOpId:
              typeof (payload as any).clientOpId === 'string'
                ? (payload as any).clientOpId
                : `cop_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          }
        : payload;

    // P2P swarm tile distribution offload
    if (Array.isArray((enrichedPayload as any)?.tiles) && !Array.isArray((enrichedPayload as any)?.inkTiles)) {
      const samplePoints = Array.isArray((enrichedPayload as any).samplePoints)
        ? ((enrichedPayload as any).samplePoints as Array<{ x: number; y: number; pressure?: number }>)
        : undefined;
      const size = typeof (enrichedPayload as any).size === 'number' ? ((enrichedPayload as any).size as number) : undefined;
      p2pManagerRef.current.broadcastTiles(
        layerId,
        (enrichedPayload as any).tiles,
        opType,
        (enrichedPayload as any).clientOpId,
        (enrichedPayload as any).baseSeq,
        samplePoints && size ? { samplePoints, size } : undefined
      );
    }

    if (userRef.current?.id) ApiService.setLastDrawnLayerId(canvasId, userRef.current.id, layerId);
    const opId = (enrichedPayload as { clientOpId?: string } | null)?.clientOpId;
    if (opId) pendingCanvasWrites.current.set(canvasId, { socket: socketRef.current, opId });
    socketRef.current.emit('op_commit', {
      canvasId,
      layerId,
      opType,
      payload: enrichedPayload,
    });
  };

  const commitTilePatch = (
    layerId: string,
    tiles: TileData[],
    isUndo: boolean = false,
    actionDesc?: string,
    meta?: TilePatchMeta
  ) => {
    const canvasId = activeCanvasIdRef.current;
    if (!canvasId) return;
    if (OfflineSessionStore.isOfflineCanvas(canvasId)) {
      const clientOpId =
        typeof meta?.clientOpId === 'string'
          ? meta.clientOpId
          : `cop_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const seq = OfflineSessionStore.commitLocalTilePatch(
        canvasId,
        layerId,
        tiles,
        actionDesc,
        isUndo,
        meta?.layerType
      );
      latestSeqRef.current = seq;
      ownOpSeqListenersRef.current.forEach((cb) => cb(clientOpId, seq, layerId));
      if (!isUndo) {
        const tel = OfflineSessionStore.recordLocalStroke(canvasId, true);
        const lvl = calculatePainterLevel(tel.strokeCount).level;
        uiBatchRef.current.personalStrokes = tel.strokeCount;
        uiBatchRef.current.totalCanvasStrokes = tel.strokeCount;
        uiBatchRef.current.memberUpdates.set(LOCAL_ARTIST_ID, {
          strokeCount: tel.strokeCount,
          level: lvl,
          drawTimeMs: tel.drawTimeMs,
        });
        scheduleUiFlush();
      }
      return;
    }
    if (!socketRef.current) return;
    if (isGuestRef.current) {
      addLog('ERROR', '訪客無法進行修補操作', '#EF4444');
      return;
    }

    const baseSeq = typeof meta?.baseSeq === 'number' ? meta.baseSeq : latestSeqRef.current;
    const clientOpId =
      typeof meta?.clientOpId === 'string'
        ? meta.clientOpId
        : `cop_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    if (!isUndo && userRef.current?.id) ApiService.setLastDrawnLayerId(canvasId, userRef.current.id, layerId);
    // Direct peer-to-peer distribution over WebRTC DataChannel swarm
    if (!meta?.targetOpSeq) {
      p2pManagerRef.current.broadcastTiles(layerId, tiles, actionDesc, clientOpId, baseSeq);
    }

    const packet: TilePatchPacket & { baseSeq?: number; clientOpId?: string; layerType?: LayerModel['layerType'] } = {
      type: 'TILE_PATCH',
      canvasId,
      layerId,
      tiles,
      isUndo,
      actionDesc,
      baseSeq,
      clientOpId,
      ...(meta?.layerType ? { layerType: meta.layerType } : {}),
      targetOpSeq: meta?.targetOpSeq,
      historyTiles: meta?.historyTiles,
    };
    pendingCanvasWrites.current.set(canvasId, { socket: socketRef.current, opId: clientOpId });
    socketRef.current.emit('tile_patch', packet);
  };

  const flushCanvasWrites = async () => {
    const pending = [...pendingCanvasWrites.current];
    if (!pending.length) return;
    const socket = socketRef.current;
    if (!socket || pending.some(([, write]) => write.socket !== socket)) {
      throw new Error('最後的多人畫布修改尚未同步到伺服器。');
    }
    // Socket.IO preserves send order and the server stores drawing ops before
    // returning to its next event. This acknowledgement follows the queued edits.
    await socket.timeout(5000).emitWithAck('time_sync', null).catch(() => {
      throw new Error('最後的多人畫布修改尚未同步到伺服器。');
    });
    for (const [canvasId, write] of pending) {
      if (pendingCanvasWrites.current.get(canvasId) === write) pendingCanvasWrites.current.delete(canvasId);
    }
  };

  const releaseLayer = (layerId: string) => {
    if (!socketRef.current || !activeCanvasId) return;
    socketRef.current.emit('release_layer', {
      canvasId: activeCanvasId,
      layerId,
    });
  };

  const claimLayer = (layerId: string, force: boolean = false) => {
    if (!socketRef.current || !activeCanvasId) return;
    socketRef.current.emit('claim_layer', {
      canvasId: activeCanvasId,
      layerId,
      force,
    });
  };

  const transferLayer = (layerId: string, targetUserId: string) => {
    if (!socketRef.current || !activeCanvasId) return;
    socketRef.current.emit('transfer_layer', {
      canvasId: activeCanvasId,
      layerId,
      targetUserId,
    });
  };

  const reorderLayer = (layerId: string, newSortOrder: number) => {
    if (!socketRef.current || !activeCanvasId) return;
    socketRef.current.emit('reorder_layer', {
      canvasId: activeCanvasId,
      layerId,
      newSortOrder,
    });
  };

  const reorderLayersList = (layerIds: string[]) => {
    if (!socketRef.current || !activeCanvasId) return;
    socketRef.current.emit('reorder_layers', {
      canvasId: activeCanvasId,
      layerIds,
    });
  };

  // Sticker actions
  const addSticker = (sticker: Omit<CanvasSticker, 'id' | 'createdAt'>) => {
    const fullSticker: CanvasSticker = {
      ...sticker,
      id: `stk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      canvasId: activeCanvasId || '',
      createdAt: Date.now(),
    };
    setStickers((prev) => [...prev, fullSticker]);

    if (sticker.isShared && socketRef.current && activeCanvasId) {
      socketRef.current.emit('sticker_add', {
        canvasId: activeCanvasId,
        sticker: fullSticker,
      });
    }
  };

  const updateSticker = (stickerId: string, updates: Partial<CanvasSticker>) => {
    setStickers((prev) =>
      prev.map((s) => (s.id === stickerId ? { ...s, ...updates } : s))
    );

    const st = stickers.find((s) => s.id === stickerId);
    if (st && st.isShared && socketRef.current && activeCanvasId) {
      socketRef.current.emit('sticker_update', {
        canvasId: activeCanvasId,
        stickerId,
        updates,
      });
    }
  };

  const removeSticker = (stickerId: string) => {
    const st = stickers.find((s) => s.id === stickerId);
    setStickers((prev) => prev.filter((s) => s.id !== stickerId));

    if (st && st.isShared && socketRef.current && activeCanvasId) {
      socketRef.current.emit('sticker_remove', {
        canvasId: activeCanvasId,
        stickerId,
      });
    }
  };

  // Voice actions
  const joinVoice = async () => {
    try {
      await voiceManagerRef.current.joinVoice(userRef.current?.id);
    } catch (err: any) {
      alert(err.message || '無法加入語音通話，請至瀏覽器網址列左側允許麥克風權限');
    }
  };

  const leaveVoice = () => {
    voiceManagerRef.current.leaveVoice();
  };

  const toggleVoiceMute = () => {
    return voiceManagerRef.current.toggleMute();
  };

  const adminForceMuteVoice = (targetSocketId: string, targetUserId?: string) => {
    if (!socketRef.current || !activeCanvasId) return;
    socketRef.current.emit('admin_voice_force_mute', {
      canvasId: activeCanvasId,
      targetSocketId,
      targetUserId,
    });
    addLog('MEMBER', `管理員已對成員執行強制閉麥`, '#F59E0B');
  };

  const adminKickVoice = (targetSocketId: string, targetUserId?: string) => {
    if (!socketRef.current || !activeCanvasId) return;
    socketRef.current.emit('admin_voice_kick', {
      canvasId: activeCanvasId,
      targetSocketId,
      targetUserId,
    });
    addLog('MEMBER', `管理員已將成員移出語音通話`, '#EF4444');
  };

  const unlockRoom = (canvasId: string, password: string) => {
    ApiService.setRoomPassword(canvasId, password);
    setRoomAccessError(null);
    socketRef.current?.emit('join_canvas', joinPayload(canvasId));
  };

  return (
    <SocketTelemetryContext.Provider value={telemetryContextValue}>
      <SocketContext.Provider
        value={{
          socket: socketRef.current,
          isConnected,
          activeCanvasId,
          members,
          offlineMembers,
          ...liveStreams,
          takeBroadcastOps,
          layerUpdateEvent,
          stickers,
          voiceState,
          p2pTileManager: p2pManagerRef.current,
          joinCanvas,
          getActiveCanvasId,
          clearActiveCanvas,
          emitCursor,
          emitPreviewDab,
          commitOp,
          flushCanvasWrites,
          commitTilePatch,
          releaseLayer,
          claimLayer,
          transferLayer,
          reorderLayer,
          reorderLayersList,
          layersSyncEvent,
          canvasResizedEvent,
          canvasUpdatedEvent,
          addSticker,
          updateSticker,
          removeSticker,
          joinVoice,
          setVoiceInputDevice: (id) => voiceManagerRef.current.setInputDevice(id),
          setVoiceOutputDevice: (id) => voiceManagerRef.current.setOutputDevice(id),
          leaveVoice,
          toggleVoiceMute,
          adminForceMuteVoice,
          adminKickVoice,
          chatMessages,
          sendChatMessage,
          serverUrl: currentServerUrl,
          reconnectServer,
          roomAccessError,
          unlockRoom,
        }}
      >
        {children}
      </SocketContext.Provider>
    </SocketTelemetryContext.Provider>
  );
};

export const useSocket = () => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
};

export const useSocketTelemetry = () => {
  const ctx = useContext(SocketTelemetryContext);
  if (!ctx) {
    throw new Error('useSocketTelemetry must be used within a SocketProvider');
  }
  const snapshot = useSyncExternalStore(ctx.subscribe, ctx.getSnapshot, ctx.getSnapshot);
  return { ...snapshot, clearLogs: ctx.clearLogs };
};
