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
import { UserPayload } from '@atelier/shared';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    roomManager: RealtimeRoomManager;
  }
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
      version: '1.1.1',
      connectedClients: app.roomManager ? app.roomManager.getConnectedClientsCount() : 0,
      timestamp: Date.now(),
    };
  });

  // Server Network Interfaces & Info
  app.get('/api/server/network', async () => {
    const interfaces = os.networkInterfaces();
    const addresses: Array<{ name: string; address: string; type: 'lan' | 'tailscale' | 'local' }> = [];
    addresses.push({ name: 'Localhost (本機回環)', address: '127.0.0.1', type: 'local' });

    for (const [name, netList] of Object.entries(interfaces)) {
      if (!netList) continue;
      for (const net of netList) {
        if (net.family === 'IPv4' && !net.internal) {
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
