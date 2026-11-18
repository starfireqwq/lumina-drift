import { FastifyPluginAsync } from 'fastify';
import { UserPayload, ServerRole } from '@atelier/shared';
import { removeGuestIdentity } from '../services/auth.service';
import {
  listAllUsers,
  adminResetUserPassword,
  adminUpdateUserRole,
  adminToggleUserStatus,
} from '../services/admin.service';

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  // Pre-handler hook to strictly enforce admin role
  const requireAdmin = async (request: any, reply: any) => {
    await fastify.authenticate(request, reply);
    if (reply.sent) return; // authenticate already answered 401
    const user = request.user as UserPayload;
    if (user.serverRole !== 'admin') {
      return reply.code(403).send({ error: '權限不足：僅系統管理員 (Admin) 可進入管理後台' });
    }
  };

  // GET /api/admin/users - List all users
  fastify.get('/users', {
    preHandler: [requireAdmin],
    handler: async () => {
      const usersList = listAllUsers();
      return { users: usersList };
    },
  });

  fastify.delete<{ Params: { id: string } }>('/users/:id', {
    preHandler: [requireAdmin],
    handler: async (request, reply) => {
      const { id } = request.params;
      if (id === (request.user as UserPayload).id || !removeGuestIdentity(id, true)) {
        return reply.code(400).send({ error: '只能移除訪客帳號' });
      }
      fastify.roomManager.disconnectUser(id);
      return { success: true };
    },
  });

  // POST /api/admin/users/:id/reset-password - Reset password for user
  fastify.post<{ Params: { id: string }; Body: { newPassword: string } }>('/users/:id/reset-password', {
    preHandler: [requireAdmin],
    handler: async (request, reply) => {
      const { id } = request.params;
      const { newPassword } = request.body || ({} as { newPassword: string });

      if (typeof newPassword !== 'string' || newPassword.trim().length < 6) {
        return reply.code(400).send({ error: '新密碼長度至少需 6 個字元' });
      }

      try {
        const res = await adminResetUserPassword(id, newPassword.trim());
        return reply.send({
          success: true,
          message: `已成功將使用者 '${res.username}' 的密碼重設！`,
          userId: res.id,
        });
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    },
  });

  // PATCH /api/admin/users/:id/role - Update user role (admin / member)
  fastify.patch<{ Params: { id: string }; Body: { serverRole: ServerRole } }>('/users/:id/role', {
    preHandler: [requireAdmin],
    handler: async (request, reply) => {
      const { id } = request.params;
      const { serverRole } = request.body || ({} as { serverRole: ServerRole });

      if (!['admin', 'member', 'guest'].includes(serverRole)) {
        return reply.code(400).send({ error: '無效的使用者角色' });
      }
      if (id === (request.user as UserPayload).id) {
        return reply.code(400).send({ error: '無法變更自己的角色，以免失去管理權限' });
      }

      try {
        adminUpdateUserRole(id, serverRole);
        return reply.send({ success: true, message: `使用者角色已更新為 ${serverRole}` });
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    },
  });

  // PATCH /api/admin/users/:id/status - Toggle user active status
  fastify.patch<{ Params: { id: string }; Body: { isActive: boolean } }>('/users/:id/status', {
    preHandler: [requireAdmin],
    handler: async (request, reply) => {
      const { id } = request.params;
      const { isActive } = request.body || ({} as { isActive: boolean });

      if (typeof isActive !== 'boolean') {
        return reply.code(400).send({ error: 'isActive 必須為布林值' });
      }
      if (id === (request.user as UserPayload).id) {
        return reply.code(400).send({ error: '無法停用自己的帳號' });
      }

      try {
        adminToggleUserStatus(id, isActive);
        return reply.send({ success: true, message: `使用者狀態已更新為 ${isActive ? '正常啟用' : '已凍結'}` });
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    },
  });
};
