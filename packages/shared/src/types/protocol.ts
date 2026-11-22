import { CanvasRole, ServerRole } from './models';
import { UserPayload } from './auth';
import { TilePatchPacket } from './tiles';

export type PacketType =
  | 'AUTH'
  | 'AUTH_ACK'
  | 'JOIN_CANVAS'
  | 'LEAVE_CANVAS'
  | 'ROOM_STATE'
  | 'CURSOR'
  | 'PREVIEW_DAB'
  | 'OP_COMMIT'
  | 'OP_BROADCAST'
  | 'OP_REJECTED'
  | 'ERROR'
  | 'TILE_PATCH'
  | 'VOICE_SIGNAL'
  | 'VOICE_STATE'
  | 'P2P_SIGNAL'
  | 'STICKER_SYNC'
  | 'STICKER_ADD'
  | 'STICKER_UPDATE'
  | 'STICKER_REMOVE';

export interface RoomMemberInfo {
  socketId: string;
  userId: string;
  displayName: string;
  avatarUrl?: string | null;
  serverRole: ServerRole | 'guest';
  canvasRole?: CanvasRole;
  isGuest: boolean;
  color: string;
  joinedAt: number;
  strokeCount?: number;
  level?: number;
  /** 'idle': the page is open but nobody has touched it for a while (absent = online) */
  presence?: MemberPresence;
  /** This user's total drawing time on this canvas (ms) */
  drawTimeMs?: number;
}

/** A connected member's activity; disconnected members are listed in RoomStatePacket.offlineMembers */
export type MemberPresence = 'online' | 'idle';

/** No pointer / key / touch input for this long turns a member idle */
export const PRESENCE_IDLE_AFTER_MS = 5 * 60_000;
/** Two drawing ops at most this far apart count as continuous drawing time */
export const DRAW_TIME_MAX_GAP_MS = 60_000;
/** Op types that count as painting (stroke stats and drawing time) */
export const DRAW_OP_TYPES: readonly string[] = ['STROKE', 'ERASE', 'SMART_FILL', 'LASSO', 'TILE_PATCH', 'FILTER'];

/** A canvas member who is not connected right now */
export interface OfflineMemberInfo {
  userId: string;
  displayName: string;
  serverRole?: ServerRole;
  canvasRole?: CanvasRole;
  /** When their last tab left this canvas (null: never seen since tracking began) */
  lastSeenAt: number | null;
  drawTimeMs: number;
}

/** Server → room: one socket went idle or came back */
export interface PresenceUpdatePacket {
  canvasId: string;
  socketId: string;
  userId: string;
  presence: MemberPresence;
}

export interface P2PSignalPacket {
  type: 'P2P_SIGNAL';
  canvasId: string;
  senderSocketId: string;
  targetSocketId?: string;
  signal: any;
}

export interface AuthPacket {
  type: 'AUTH';
  token?: string;
  displayName?: string; // Optional nickname for guest users
}

export interface AuthAckPacket {
  type: 'AUTH_ACK';
  user: UserPayload;
  isGuest: boolean;
}

export interface JoinCanvasPacket {
  type: 'JOIN_CANVAS';
  canvasId: string;
  roomPassword?: string;
}

export interface LeaveCanvasPacket {
  type: 'LEAVE_CANVAS';
  canvasId: string;
}

export interface RoomStatePacket {
  type: 'ROOM_STATE';
  canvasId: string;
  latestSeq: number;
  members: RoomMemberInfo[];
  /** Canvas members with no connected tab, most recently seen first */
  offlineMembers?: OfflineMemberInfo[];
}

export interface CursorPacket {
  type: 'CURSOR';
  canvasId: string;
  userId: string;
  displayName: string;
  avatarUrl?: string | null;
  x: number;
  y: number;
  pressure?: number;
  color?: string;
  brushSize?: number;
  isDrawing?: boolean;
}

export interface DabPoint {
  x: number;
  y: number;
  pressure: number;
  size?: number;
  alpha?: number;
  angle?: number;
}

export interface BrushConfig {
  size: number;
  minSize?: number;
  color: string;
  opacity: number;
  hardness: number;
  flow: number;
  spacing: number;
  isEraser: boolean;
  stabilizerLevel: number;
  scatter: number;
  customBrushUrl?: string | null;
}

export interface PreviewDabPacket {
  type: 'PREVIEW_DAB';
  canvasId: string;
  userId: string;
  /** Sender's socket (one account on two devices draws two strokes) */
  socketId?: string;
  /** Sender's clock when sent (ms); lets clients and the load test measure latency */
  sentAt?: number;
  layerId: string;
  color: string;
  brushSize: number;
  opacity?: number;
  isEraser?: boolean;
  dabs: DabPoint[];
}

export interface LayerActionPacket {
  type: 'LAYER_UPDATE' | 'LAYER_CLAIM' | 'LAYER_RELEASE' | 'LAYER_REORDER';
  canvasId: string;
  layerId: string;
  userId: string;
  force?: boolean;
  newSortOrder?: number;
}

export interface OpCommitPacket {
  type: 'OP_COMMIT';
  canvasId: string;
  layerId: string;
  opType: string; // 'STROKE' | 'FILL' | 'FILTER' | 'LAYER_OP' | 'TILE_PATCH'
  payload: unknown;
  clientSeq?: number;
}

export interface OpBroadcastPacket {
  type: 'OP_BROADCAST';
  canvasId: string;
  seq: number;
  userId: string;
  // Sender's socket: clients skip their own echo by socket, never by user,
  // so the same account on a second device still receives the op
  socketId?: string;
  displayName: string;
  layerId: string | null;
  opType: string;
  payload: unknown;
  timestamp: number;
}

export interface OpRejectedPacket {
  type: 'OP_REJECTED';
  canvasId: string;
  clientSeq?: number;
  reason: string;
}

export interface ErrorPacket {
  type: 'ERROR';
  code: string;
  message: string;
}

// ============================================================================
// Phase 6: Voice Chat (WebRTC Signaling) & Floating Stickers / Reference Pins
// ============================================================================

export type VoiceSignalType = 'join' | 'leave' | 'offer' | 'answer' | 'candidate' | 'state';

export interface VoiceSignalPacket {
  type: 'VOICE_SIGNAL';
  canvasId: string;
  fromUserId: string;
  targetUserId?: string; // target user socket/id, or undefined for broadcast
  signalType: VoiceSignalType;
  signalData?: any;
}

export interface VoiceStatePacket {
  type: 'VOICE_STATE';
  canvasId: string;
  userId: string;
  displayName: string;
  isMuted: boolean;
  isSpeaking: boolean;
  inVoice: boolean;
}

export interface CanvasSticker {
  id: string;
  canvasId: string;
  ownerId: string;
  ownerName: string;
  title?: string;
  imageUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
  isPinnedToScreen?: boolean; // false = world canvas coordinates, true = viewport screen fixed
  isLocked?: boolean;
  isFlippedH?: boolean;
  isGrayscale?: boolean;
  isShared: boolean; // true = broadcast to everyone on canvas, false = local reference pin only
  createdAt: number;
}

export interface StickerPacket {
  type: 'STICKER_SYNC' | 'STICKER_ADD' | 'STICKER_UPDATE' | 'STICKER_REMOVE';
  canvasId: string;
  sticker?: CanvasSticker;
  stickerId?: string;
  stickers?: CanvasSticker[];
  updates?: Partial<CanvasSticker>;
}

export type AtelierPacket =
  | AuthPacket
  | AuthAckPacket
  | JoinCanvasPacket
  | LeaveCanvasPacket
  | RoomStatePacket
  | CursorPacket
  | PreviewDabPacket
  | OpCommitPacket
  | OpBroadcastPacket
  | OpRejectedPacket
  | ErrorPacket
  | TilePatchPacket
  | VoiceSignalPacket
  | VoiceStatePacket
  | StickerPacket;
