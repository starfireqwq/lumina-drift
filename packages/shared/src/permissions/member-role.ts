import { AssignableCanvasRole } from '../types/canvas';
import { CanvasRole, ServerRole } from '../types/models';

export const ASSIGNABLE_CANVAS_ROLES: readonly AssignableCanvasRole[] = ['admin', 'editor', 'viewer'] as const;

export interface RoleActorContext {
  userId: string;
  serverRole?: ServerRole | 'guest' | null;
  canvasRole?: CanvasRole | null;
  isCanvasOwner?: boolean;
}

export interface RoleTargetContext {
  userId: string;
  serverRole?: ServerRole | 'guest' | null;
  canvasRole?: CanvasRole | null;
  isCanvasOwner?: boolean;
  isGuest?: boolean;
}

export type MemberRoleManageDenialReason =
  | 'cannot_modify_self'
  | 'cannot_modify_guest'
  | 'cannot_modify_owner'
  | 'cannot_modify_server_admin'
  | 'cannot_modify_canvas_admin'
  | 'insufficient_permission'
  | 'invalid_target_role';

export interface ManageCanvasMemberRoleResult {
  allowed: boolean;
  allowedRoles: AssignableCanvasRole[];
  reason?: MemberRoleManageDenialReason;
}

export interface CanvasRoleCapabilities {
  canCreateLayer: boolean;
  canDeleteOtherLayer: boolean;
  canExport: boolean;
  canManageMembers: boolean;
}

export function isAssignableCanvasRole(value: unknown): value is AssignableCanvasRole {
  return value === 'admin' || value === 'editor' || value === 'viewer';
}

export function getCanvasRoleCapabilities(role: CanvasRole): CanvasRoleCapabilities {
  switch (role) {
    case 'owner':
    case 'admin':
      return {
        canCreateLayer: true,
        canDeleteOtherLayer: true,
        canExport: true,
        canManageMembers: true,
      };
    case 'viewer':
      return {
        canCreateLayer: false,
        canDeleteOtherLayer: false,
        canExport: true,
        canManageMembers: false,
      };
    case 'editor':
    default:
      return {
        canCreateLayer: true,
        canDeleteOtherLayer: false,
        canExport: true,
        canManageMembers: false,
      };
  }
}

/**
 * Shared pure authorization rule for managing a canvas member's role.
 *
 * Rules:
 * - Nobody can change their own role.
 * - Guests, canvas owners, and server admins cannot have their canvas role modified.
 * - Server admins and the canvas owner can assign admin / editor / viewer to eligible members.
 * - Canvas admins can assign editor / viewer to regular members (non-owner, non-canvas-admin, non-server-admin).
 * - Editors, viewers, and guests cannot manage member roles.
 * - When nextRole is omitted, returns whether the actor can manage this target at all and which roles are selectable.
 */
export function canManageCanvasMemberRole(
  actor: RoleActorContext,
  target: RoleTargetContext,
  nextRole?: CanvasRole
): ManageCanvasMemberRoleResult {
  if (!actor.userId || !target.userId || actor.userId === target.userId) {
    return { allowed: false, allowedRoles: [], reason: 'cannot_modify_self' };
  }

  if (target.isGuest || target.serverRole === 'guest' || target.userId.startsWith('guest_')) {
    return { allowed: false, allowedRoles: [], reason: 'cannot_modify_guest' };
  }

  if (target.isCanvasOwner || target.canvasRole === 'owner') {
    return { allowed: false, allowedRoles: [], reason: 'cannot_modify_owner' };
  }

  if (target.serverRole === 'admin') {
    return { allowed: false, allowedRoles: [], reason: 'cannot_modify_server_admin' };
  }

  if (actor.serverRole === 'guest' || actor.userId.startsWith('guest_')) {
    return { allowed: false, allowedRoles: [], reason: 'insufficient_permission' };
  }

  const actorIsServerAdmin = actor.serverRole === 'admin';
  const actorIsOwner = Boolean(actor.isCanvasOwner || actor.canvasRole === 'owner');
  const actorIsCanvasAdmin = actor.canvasRole === 'admin';

  let allowedRoles: AssignableCanvasRole[] = [];
  if (actorIsServerAdmin || actorIsOwner) {
    allowedRoles = ['admin', 'editor', 'viewer'];
  } else if (actorIsCanvasAdmin) {
    if (target.canvasRole === 'admin') {
      return { allowed: false, allowedRoles: [], reason: 'cannot_modify_canvas_admin' };
    }
    allowedRoles = ['editor', 'viewer'];
  } else {
    return { allowed: false, allowedRoles: [], reason: 'insufficient_permission' };
  }

  if (nextRole !== undefined) {
    if (!isAssignableCanvasRole(nextRole)) {
      return { allowed: false, allowedRoles, reason: 'invalid_target_role' };
    }
    if (!allowedRoles.includes(nextRole)) {
      return { allowed: false, allowedRoles, reason: 'insufficient_permission' };
    }
  }

  return { allowed: true, allowedRoles };
}
