import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  AuthResponse,
  LoginDto,
  RegisterDto,
  UserPayload,
} from '@atelier/shared';
import {
  findUserById,
  findUserByUsername,
  registerGuestUser,
  registerUser,
  removeGuestIdentity,
  toUserPayload,
  updateUserProfile,
  verifyPassword,
} from '../services/auth.service';

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // avatarUrl is a data URL: inside the token it pushes every request past Node's 16KB header limit.
  // `authenticate` re-reads the account anyway, so the token only needs identity.
  const signToken = (u: UserPayload) =>
    fastify.jwt.sign({ id: u.id, username: u.username, displayName: u.displayName, serverRole: u.serverRole });

  const clearUnusedGuest = async (request: FastifyRequest, userId: string) => {
    if (!request.headers.authorization) return;
    try {
      const previous = await request.jwtVerify<UserPayload>();
      if (previous.id !== userId && removeGuestIdentity(previous.id)) fastify.roomManager.disconnectUser(previous.id);
    } catch (err) {
      request.log.debug({ err }, 'Previous guest could not be removed');
    }
  };

  // POST /api/auth/guest - Instantly create guest identity with valid JWT
  fastify.post<{ Body: { displayName?: string } }>('/guest', async (request, reply) => {
    try {
      const user = await registerGuestUser(request.body?.displayName);
      const token = signToken(user);
      const res: AuthResponse = { token, user };
      return reply.code(201).send(res);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
  // POST /api/auth/register
  fastify.post<{ Body: RegisterDto }>('/register', async (request, reply) => {
    const { username, password, displayName } = request.body || ({} as RegisterDto);

    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return reply.code(400).send({ error: '帳號與密碼為必填項目' });
    }
    if (password.length < 6) {
      return reply.code(400).send({ error: '密碼長度至少需 6 個字元' });
    }

    try {
      // serverRole from the body is ignored: self-registration must never mint admins
      const user = await registerUser({
        username,
        password,
        displayName: typeof displayName === 'string' && displayName.trim() ? displayName : username,
        serverRole: 'member',
      });

      const token = signToken(user);
      await clearUnusedGuest(request, user.id);
      const res: AuthResponse = { token, user };
      return reply.code(201).send(res);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // POST /api/auth/login
  fastify.post<{ Body: LoginDto }>('/login', async (request, reply) => {
    const { username, password } = request.body || ({} as LoginDto);

    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return reply.code(400).send({ error: '請輸入帳號與密碼' });
    }

    const user = findUserByUsername(username);
    if (!user || !user.passwordHash) {
      return reply.code(401).send({ error: '帳號或密碼錯誤' });
    }

    const isMatch = await verifyPassword(password, user.passwordHash);
    if (!isMatch) {
      return reply.code(401).send({ error: '帳號或密碼錯誤' });
    }
    if (!user.isActive) {
      return reply.code(403).send({ error: '此帳號已被管理員停用' });
    }

    const payload = toUserPayload(user);
    const token = signToken(payload);
    await clearUnusedGuest(request, payload.id);
    const res: AuthResponse = { token, user: payload };
    return reply.send(res);
  });

  // GET /api/auth/me
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const user = request.user as UserPayload;
      const current = findUserById(user.id);
      if (!current) {
        return reply.code(404).send({ error: '使用者不存在' });
      }
      return reply.send({ user: toUserPayload(current) });
    },
  });

  // PATCH /api/auth/profile - Update displayName and avatarUrl
  fastify.patch<{ Body: { displayName?: string; avatarUrl?: string | null } }>(
    '/profile',
    {
      preHandler: [fastify.authenticate],
      handler: async (request, reply) => {
        const user = request.user as UserPayload;
        try {
          const updated = updateUserProfile(user.id, request.body || {});
          const token = signToken(updated);
          return reply.send({ token, user: updated });
        } catch (err: any) {
          return reply.code(400).send({ error: err.message });
        }
      },
    }
  );
};
