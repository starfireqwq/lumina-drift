import {
  CanvasMemberModel,
  CanvasRole,
  LayerModel,
  LayerPermissionModel,
  ServerRole,
  UserModel,
} from '../types/models';
import { UserPayload } from '../types/auth';

export type LayerAction =
  | 'draw'
  | 'erase'
  | 'filter'
  | 'modify_props'
  | 'lock'
  | 'delete'
  | 'reorder'
  | 'claim'
  | 'release';

export interface UserPermissionContext {
  user: UserPayload | UserModel | null; // null represents unauthenticated guest
  canvasMember?: CanvasMemberModel | null;
  layer: LayerModel;
  layerPermission?: LayerPermissionModel | null;
  forceClaim?: boolean;
}

/**
 * Checks whether a user can perform an action on a specific layer in a canvas.
 * Moderators can manage ownership and structure. Pixel and property changes follow the layer ACL.
 */
export function canUserPerformLayerAction(
  context: UserPermissionContext,
  action: LayerAction
): { allowed: boolean; reason?: string } {
  const { user, canvasMember, layer, layerPermission, forceClaim } = context;

  if (layer.layerType === 'group' && (action === 'draw' || action === 'erase' || action === 'filter')) {
    return { allowed: false, reason: '圖層組是資料夾，請對組內的圖層進行繪製或套用濾鏡。' };
  }

  const isRoomAdmin =
    user?.serverRole === 'admin' ||
    Boolean(canvasMember && (canvasMember.role === 'owner' || canvasMember.role === 'admin'));

  const isOwner = Boolean(user && user.id === layer.ownerId);
  if (action === 'lock') return { allowed: isOwner || isRoomAdmin };

  if (layer.isLocked) {
    if (action === 'modify_props' && isOwner) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: '此圖層目前已被鎖定，無法繪製或編輯。',
    };
  }

  if (isRoomAdmin && (action === 'claim' || action === 'release' || action === 'reorder' || action === 'delete')) {
    return { allowed: true };
  }

  // 4. Canvas-level Viewer role check (only if explicitly set to viewer)
  if (canvasMember && canvasMember.role === 'viewer') {
    return {
      allowed: false,
      reason: '你在本畫布中的角色為「瀏覽者 (Viewer)」，無法動筆或編輯圖層。',
    };
  }

  // 5. Layer Creator / Owner has full control over their own layer
  if (user && layer.ownerId === user.id) {
    return { allowed: true };
  }

  // 6. Public / Unclaimed Layer: Must claim first before drawing!
  if (layer.isPublic || !layer.ownerId) {
    if (action === 'claim') {
      return { allowed: true };
    }
    if (action === 'draw' || action === 'erase' || action === 'filter') {
      return {
        allowed: false,
        reason: '此圖層為公開圖層，請先點擊「接管此圖層」後方可作畫。',
      };
    }
    if (action === 'modify_props') return { allowed: false, reason: '請先接管圖層，再修改圖層屬性。' };
  }

  // 7. Collaborative Drawing Mode:
  // If layer is explicitly set to shared_all, allow authorized basic drawing and erasing
  if (action === 'draw' || action === 'erase' || action === 'filter') {
    if (layer.aclMode === 'shared_all') {
      return { allowed: true };
    }
  }

  // Handle Layer Claim
  if (action === 'claim') {
    if (forceClaim) {
      return {
        allowed: false,
        reason: '只有伺服器管理員可進行強制接管。',
      };
    }
    return { allowed: true };
  }

  // Handle Layer Release
  if (action === 'release') {
    if (user && layer.ownerId === user.id) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: '只有圖層擁有者可以釋放此圖層。',
    };
  }

  // Handle Reordering / Moving Layer
  if (action === 'reorder') {
    if (user && (layer.ownerId === user.id || layer.isPublic)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: '非圖層擁有者無法移動該圖層。',
    };
  }

  // Handle Delete Layer
  if (action === 'delete') {
    if (user && (layer.ownerId === user.id || canvasMember?.canDeleteOtherLayer)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: '你沒有權限刪除其他成員建立的圖層。',
    };
  }

  // 8. ACL Mode evaluations
  switch (layer.aclMode) {
    case 'owner_only':
      if (user && layer.ownerId === user.id) return { allowed: true };
      return {
        allowed: false,
        reason: '非圖層擁有者無法在該圖層上作畫、擦除或編輯。',
      };

    case 'shared_all':
      if (action === 'modify_props') {
        if (user && layer.ownerId === user.id) return { allowed: true };
        return {
          allowed: false,
          reason: '圖層僅允許原作者或管理員修改圖層屬性（如更名、混合模式）。',
        };
      }
      return { allowed: true };

    case 'custom':
      if (!layerPermission) {
        return {
          allowed: false,
          reason: '此圖層為自訂授權模式，但你尚未獲得該圖層的授權。',
        };
      }
      if (action === 'draw' && layerPermission.canDraw) return { allowed: true };
      if (action === 'erase' && layerPermission.canErase) return { allowed: true };
      if (action === 'filter' && layerPermission.canFilter) return { allowed: true };
      if (action === 'modify_props' && layerPermission.canModifyProps) return { allowed: true };
      return {
        allowed: false,
        reason: `你沒有在此圖層執行「${action}」的授權。`,
      };

    default:
      return { allowed: true };
  }
}

/**
 * Check if a user can create new layers in a canvas
 */
export function canUserCreateLayer(
  user: UserPayload | UserModel | null,
  canvasMember?: CanvasMemberModel | null
): boolean {
  if (user?.serverRole === 'admin') return true;
  if (canvasMember && (canvasMember.role === 'owner' || canvasMember.role === 'admin')) return true;
  if (canvasMember && canvasMember.role === 'viewer') return false;
  // In collaborative drawing tea room, all users (including guests) can create their own layers!
  return true;
}
