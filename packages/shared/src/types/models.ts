export type ServerRole = 'admin' | 'member' | 'guest';
export type CanvasRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type AccessMode = 'invite' | 'password' | 'whitelist';

export interface FolderAccessRequest {
  folderId: string;
  requesterId: string;
  requesterName: string;
  ownerId: string;
  status: 'pending' | 'approved';
}
// 'mask': a layer mask, attached to the layer named by its parentId (white shows, black/empty hides)
// 'text': pixels are rendered from meta.text, so the text stays editable
export const LAYER_TYPES = ['raster', 'folder', 'group', 'adjustment', 'vector', 'mask', 'text'] as const;
export type LayerType = typeof LAYER_TYPES[number];

export interface TextStyleRun {
  start: number;
  end: number;
  color?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
}

export interface LayerTextMeta {
  content: string;
  /** Top-left of the text block in canvas pixels */
  x: number;
  y: number;
  vertical: boolean;
  fontFamily: string;
  fontSize: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  /** Multiple of fontSize */
  lineHeight: number;
  /** Style overrides at UTF-16 offsets [start, end). */
  runs?: TextStyleRun[];
  bold?: boolean;
  italic?: boolean;
  /** Thousandths of an em. */
  letterSpacing?: number;
  align?: 'start' | 'center' | 'end';
  box?: { width: number; height: number } | null;
  paintOrder?: 'stroke-behind' | 'stroke-front';
  shadow?: { color: string; offsetX: number; offsetY: number; blur: number; opacity: number } | null;
  kinsoku?: boolean;
}

/** Free-form per-layer data the server stores as JSON */
import type { TransformKeyframe } from '../animation/keyframes';
import type { CameraFrameMeta } from '../animation/camera';
import type { AudioTrackMeta } from '../animation/audio';
import type { CanvasUnit } from '../canvas/canvas-units';
import type { LayerAdjustment } from '../adjustment/adjustment-layer';

export type CelMark = 'key' | 'inbetween';

export interface TimelineLabel {
  /** Zero-based frame index on the timeline */
  frame: number;
  text: string;
}

export interface LayerMeta {
  originalAuthor?: string;
  /**
   * On a group: it is a CSP-style animation folder, each child layer one cel (bottom = first).
   * shared: other painters can see the track. Adding cels requires the owner's approval.
   */
  /** length: timeline length in frames set by the painter (none = up to the end of the longest track) */
  animation?: { fps: number; shared?: boolean; length?: number; labels?: TimelineLabel[] };
  /**
   * On a cel (a child of an animation folder): how many timeline frames it stays on screen, and
   * ref = the cel it shows instead of itself (reusing one drawing; such entries are empty groups).
   * mark = key (○) / inbetween (●) cel badge; note = short per-cel memo shown in tooltips.
   */
  cel?: { hold?: number; ref?: string; mark?: CelMark; note?: string };
  /** Non-destructive keyframe transform track (supports interpolation & joint pivot) */
  keyframes?: TransformKeyframe[];
  /** On a group: 2D camera framing box whose motion is driven by `keyframes` */
  camera?: CameraFrameMeta;
  /** On a group: timeline audio track metadata (binary audio stays local in IndexedDB) */
  audio?: AudioTrackMeta;
  /** On a mask layer: white hides and black shows */
  maskInverted?: boolean;
  /** Non-destructive color adjustment applied at this layer's position. */
  adjustment?: LayerAdjustment;
  text?: LayerTextMeta;
}
export type LayerACLMode = 'owner_only' | 'shared_all' | 'custom';
export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color_dodge'
  | 'color_burn'
  | 'hard_light'
  | 'soft_light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'
  | 'add'
  | string;

export interface UserModel {
  id: string;
  username: string;
  displayName: string;
  passwordHash?: string;
  avatarUrl: string | null;
  serverRole: ServerRole;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CanvasModel {
  id: string;
  ownerId: string;
  title: string;
  width: number;
  height: number;
  dpi: number;
  unit?: CanvasUnit;
  bgColor: string;
  accessMode: AccessMode;
  inviteCode: string | null;
  roomPassHash: string | null; // never sent to clients; they get hasPassword instead
  hasPassword?: boolean;
  group?: { id: string; title: string; ownerId: string };
  latestSeq: number;
  createdAt: number;
  updatedAt: number;
}

export interface CanvasMemberModel {
  canvasId: string;
  userId: string;
  role: CanvasRole;
  canCreateLayer: boolean;
  canDeleteOtherLayer: boolean;
  canExport: boolean;
  canManageMembers: boolean;
  joinedAt: number;
}

export interface LayerModel {
  id: string;
  canvasId: string;
  parentId: string | null;
  ownerId: string | null;
  ownerDisplayName?: string | null;
  name: string;
  layerType: LayerType;
  blendMode: BlendMode;
  opacity: number;
  isVisible: boolean;
  isLocked: boolean;
  alphaLocked: boolean;
  clipToBelow: boolean;
  sortOrder: number;
  aclMode: LayerACLMode;
  isPublic: boolean;
  screentoneEnabled?: boolean;
  screentoneLpi?: number;
  screentoneAngle?: number;
  screentoneDotScale?: number;
  meta?: LayerMeta | null;
  createdAt: number;
  updatedAt: number;
}

export interface LayerPermissionModel {
  layerId: string;
  userId: string;
  canDraw: boolean;
  canErase: boolean;
  canFilter: boolean;
  canModifyProps: boolean;
}

export interface CanvasSnapshotModel {
  id: string;
  canvasId: string;
  seq: number;
  storagePath: string;
  byteSize: number;
  createdAt: number;
}

export interface CanvasOpModel {
  canvasId: string;
  seq: number;
  userId: string;
  layerId: string | null;
  opType: string;
  payloadBlob: Uint8Array;
  createdAt: number;
}
