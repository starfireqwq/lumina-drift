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
export type LayerType = 'raster' | 'folder' | 'group' | 'adjustment' | 'vector' | 'mask' | 'text';

export interface LayerTextMeta {
  content: string;
  /** Top-left of the text block (top-right for vertical text), canvas pixels */
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
}

/** Free-form per-layer data the server stores as JSON */
import type { TransformKeyframe } from '../animation/keyframes';
import type { CanvasUnit } from '../canvas/canvas-units';

export interface LayerMeta {
  originalAuthor?: string;
  /**
   * On a group: it is a CSP-style animation folder, each child layer one cel (bottom = first).
   * shared: other painters can see the track. Adding cels requires the owner's approval.
   */
  animation?: { fps: number; shared?: boolean };
  /**
   * On a cel (a child of an animation folder): how many timeline frames it stays on screen, and
   * ref = the cel it shows instead of itself (reusing one drawing; such entries are empty groups).
   */
  cel?: { hold?: number; ref?: string };
  /** Non-destructive keyframe transform track (supports interpolation & joint pivot) */
  keyframes?: TransformKeyframe[];
  /** On a mask layer: white hides and black shows */
  maskInverted?: boolean;
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
