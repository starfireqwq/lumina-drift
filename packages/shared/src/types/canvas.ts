import {
  AccessMode,
  BlendMode,
  CanvasMemberModel,
  CanvasModel,
  CanvasRole,
  LayerACLMode,
  LayerMeta,
  LayerModel,
  LayerPermissionModel,
  LayerType,
  ServerRole,
} from './models';
import type { CanvasUnit } from '../canvas/canvas-units';

export interface CreateCanvasDto {
  title: string;
  width?: number;
  height?: number;
  dpi?: number;
  unit?: CanvasUnit;
  bgColor?: string;
  accessMode?: AccessMode;
  roomPassword?: string;
  groupId?: string;
  newGroupTitle?: string;
}

export interface UpdateCanvasDto {
  title?: string;
  bgColor?: string;
  accessMode?: AccessMode;
  roomPassword?: string;
}

export interface JoinCanvasDto {
  canvasId?: string;
  inviteCode?: string;
  roomPassword?: string;
}

export interface CanvasDetailResponse {
  canvas: CanvasModel;
  myMembership?: CanvasMemberModel | null;
  hasGroupAccess?: boolean;
  layers: LayerModel[];
}

export interface CreateLayerDto {
  name: string;
  parentId?: string | null;
  aboveLayerId?: string | null;
  /** Directly below this layer instead (used when nothing is below the spot) */
  belowLayerId?: string | null;
  layerType?: LayerType;
  blendMode?: BlendMode;
  opacity?: number;
  sortOrder?: number;
  aclMode?: LayerACLMode;
  isPublic?: boolean;
  screentoneEnabled?: boolean;
  screentoneLpi?: number;
  screentoneAngle?: number;
  screentoneDotScale?: number;
  meta?: LayerMeta | null;
}

export interface UpdateLayerDto {
  name?: string;
  blendMode?: BlendMode;
  opacity?: number;
  isVisible?: boolean;
  isLocked?: boolean;
  alphaLocked?: boolean;
  clipToBelow?: boolean;
  sortOrder?: number;
  parentId?: string | null;
  aclMode?: LayerACLMode;
  isPublic?: boolean;
  screentoneEnabled?: boolean;
  screentoneLpi?: number;
  screentoneAngle?: number;
  screentoneDotScale?: number;
  meta?: LayerMeta | null;
  /** Only 'raster' on a text layer (rasterize: the text stops being editable) */
  layerType?: LayerType;
}

export interface SetLayerPermissionDto {
  userId: string;
  canDraw?: boolean;
  canErase?: boolean;
  canFilter?: boolean;
  canModifyProps?: boolean;
}

export interface LayerWithPermissions extends LayerModel {
  permissions?: LayerPermissionModel[];
}

export type AssignableCanvasRole = Exclude<CanvasRole, 'owner'>;

export interface UpdateCanvasMemberRoleDto {
  role: AssignableCanvasRole;
}

export interface CanvasMemberInfo extends CanvasMemberModel {
  username: string;
  displayName: string;
  avatarUrl: string | null;
  serverRole: ServerRole;
  isOnline?: boolean;
  lastSeenAt?: number | null;
  drawTimeMs?: number;
}

export interface CanvasMembersResponse {
  canvasId: string;
  ownerId: string;
  members: CanvasMemberInfo[];
}

export interface UpdateCanvasMemberRoleResponse {
  member: CanvasMemberModel;
}
