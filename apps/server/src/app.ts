import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { config } from './config';
import { initDatabase } from './db';
import { seedDatabase } from './db/seed';
import { authRoutes } from './routes/auth.routes';
import { canvasRoutes } from './routes/canvas.routes';
import { layerRoutes } from './routes/layer.routes';
import { adminRoutes } from './routes/admin.routes';
import { RealtimeRoomManager } from './realtime/room-manager';
import { findUserById, toUserPayload } from './services/auth.service';
import { createSharePreviews } from './services/share-preview.service';
import { IDENTITY_CHALLENGE, signIdentityChallenge } from './services/server-identity.service';
import { UserPayload } from '@atelier/shared';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    roomManager: RealtimeRoomManager;
  }
}

const LOOPBACK_HOST_HEADER = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip'];

/**
 * True only for a browser on the host machine that opened the site at localhost / 127.x / [::1].
 * Tunnel clients (cloudflared, frpc) also connect from 127.0.0.1, so the Host header and the
 * forwarding headers they add are checked as well; the raw socket address is used because
 * trustProxy would otherwise let X-Forwarded-For decide request.ip.
 */
function isHostMachineRequest(request: FastifyRequest): boolean {
  const remote = request.raw.socket?.remoteAddress ?? '';
  const loopbackSocket = remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.');
  if (!loopbackSocket) return false;
  if (PROXY_HEADERS.some((name) => request.headers[name] !== undefined)) return false;
  return LOOPBACK_HOST_HEADER.test(String(request.headers.host ?? ''));
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
  });

  // Enable CORS (including Private Network Access preflight for Android WebView -> LAN hosts)
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.headers['access-control-request-private-network'] === 'true') {
      reply.header('Access-Control-Allow-Private-Network', 'true');
    }
    return payload;
  });

  // Register Fastify JWT
  await app.register(jwt, {
    secret: config.jwtSecret,
  });

  // Decorate fastify with authentication preHandler
  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      return reply.code(401).send({ error: '未授權或登入憑證已過期，請重新登入' });
    }
    // Tokens never expire and only carry a snapshot of the account: re-read it so frozen or
    // deleted users are locked out and role changes apply at once.
    const current = findUserById((request.user as UserPayload).id);
    if (!current || !current.isActive) {
      return reply.code(401).send({ error: '帳號不存在或已被停用，請重新登入' });
    }
    request.user = toUserPayload(current);
  });

  // Health check
  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'atelier-sync-server',
      version: '1.2.0',
      connectedClients: app.roomManager ? app.roomManager.getConnectedClientsCount() : 0,
      timestamp: Date.now(),
    };
  });

  // Server Network Interfaces & Info
  // The host's LAN / VPN addresses are only listed for a page opened on the host machine itself.
  // Everyone else (shared links, phones, tunnels) gets an empty list.
  app.get('/api/server/network', async (request) => {
    const addresses: Array<{ name: string; address: string; type: 'lan' | 'tailscale' | 'local' }> = [];
    if (!isHostMachineRequest(request)) {
      return { status: 'ok', port: config.port, host: config.host, addresses, timestamp: Date.now() };
    }
    const interfaces = os.networkInterfaces();
    addresses.push({ name: 'Localhost (本機回環)', address: '127.0.0.1', type: 'local' });

    for (const [name, netList] of Object.entries(interfaces)) {
      if (!netList) continue;
      for (const net of netList) {
        // 169.254.x.x is a self-assigned link-local address nobody else can reach.
        if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
          if (net.address.startsWith('100.')) {
            addresses.push({ name: `${name} (Tailscale 私網)`, address: net.address, type: 'tailscale' });
          } else {
            addresses.push({ name: `${name} (區域網路 LAN/Wi-Fi)`, address: net.address, type: 'lan' });
          }
        }
      }
    }

    return {
      status: 'ok',
      port: config.port,
      host: config.host,
      addresses,
      timestamp: Date.now(),
    };
  });

  // Proof of server identity: the same server reached through another address signs with the same key.
  app.get<{ Querystring: { challenge?: string } }>('/api/server/identity', async (request, reply) => {
    const challenge = request.query?.challenge;
    if (typeof challenge !== 'string' || !IDENTITY_CHALLENGE.test(challenge)) {
      return reply.code(400).send({ error: 'Invalid challenge' });
    }
    reply.header('Cache-Control', 'no-store');
    return signIdentityChallenge(challenge);
  });

  // Initialize DB and Seed data
  initDatabase();
  await seedDatabase();

  // Register REST Routes
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(canvasRoutes, { prefix: '/api/canvases' });
  await app.register(layerRoutes, { prefix: '/api/canvases' });
  await app.register(adminRoutes, { prefix: '/api/admin' });

  // Initialize Socket.io Realtime Room Manager attached to Fastify server
  const roomManager = new RealtimeRoomManager(app);
  app.decorate('roomManager', roomManager);

  // Register static file serving for client React SPA if dist exists
  const envClientDist = process.env.CLIENT_DIST_PATH;
  const clientDistPath = path.resolve(__dirname, '../../client/dist');
  const dockerClientDistPath = path.resolve(__dirname, '../public');
  const staticPath = envClientDist && fs.existsSync(envClientDist)
    ? envClientDist
    : fs.existsSync(clientDistPath)
    ? clientDistPath
    : fs.existsSync(dockerClientDistPath)
    ? dockerClientDistPath
    : null;

  if (staticPath) {
    const indexPath = path.join(staticPath, 'index.html');
    const indexHtml = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : null;
    const previews = createSharePreviews(path.join(staticPath, 'share-preview.png'));
    app.addHook('onClose', () => previews.close());
    app.get<{ Params: { id: string } }>('/api/share-preview/:id', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const preview = await previews.get(req.params.id).catch(() => null);
      if (!preview) return reply.code(404).send({ error: 'Preview unavailable' });
      return reply.type('image/png').send(preview.png);
    });
    const sendClientPage = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!indexHtml) return reply.sendFile('index.html');
      let page = indexHtml;
      try {
        const protocol = req.protocol === 'https' ? 'https' : 'http';
        const url = new URL(`${protocol}://${req.host}/`);
        const room = new URL(req.url, url).searchParams.get('room');
        if (room && /^[\w-]{1,128}$/.test(room)) url.searchParams.set('room', room);
        const preview = room ? await previews.get(room).catch(() => null) : null;
        const image = preview
          ? new URL(`/api/share-preview/${encodeURIComponent(room!)}?v=${preview.revision}`, url)
          : new URL('/share-preview.png', url);
        // URL values are used inside quoted HTML attributes.
        const attr = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
          .replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        page = page
          .replace(/(property="og:url" content=")\/"/, (_, prefix) => `${prefix}${attr(url.href)}"`)
          .replace(/((?:property="og:image"|name="twitter:image") content=")\.?\/share-preview\.png"/g,
            (_, prefix) => `${prefix}${attr(image.href)}"`);
        if (preview) {
          page = page
            .replace(/(property="og:title" content=")[^"]*"/, (_, prefix) => `${prefix}${attr(preview.title)}"`)
            .replace(/(property="og:image:alt" content=")[^"]*"/, (_, prefix) => `${prefix}${attr(`${preview.title}｜Lumina Drift 流光`)}"`);
        }
      } catch {
        // Keep the application available if an upstream proxy sends a malformed host.
      }
      return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(page);
    };
    await app.register(fastifyStatic, {
      root: staticPath,
      prefix: '/',
      index: false,
    });
    app.get('/', sendClientPage);
    app.get('/index.html', sendClientPage);
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith('/api')) {
        return reply.code(404).send({ error: 'API endpoint not found' });
      }
      return sendClientPage(req, reply);
    });
  }

  return app;
}
