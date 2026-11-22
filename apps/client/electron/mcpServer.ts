import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * Local-only Streamable HTTP JSON-RPC 2.0 MCP Server for Lumina Drift Desktop.
 * Security invariants:
 * 1. Binds strictly to 127.0.0.1 (never 0.0.0.0).
 * 2. Rotatable 256-bit Bearer Token checked via crypto.timingSafeEqual.
 * 3. Strict Host allowlist (127.0.0.1:<port> / localhost:<port>) + reject any non-empty Origin
 *    to prevent DNS Rebinding and cross-origin browser CSRF.
 * 4. Read-only by default; write tools require explicit opt-in and delegate to Renderer
 *    PluginCanvasTransaction (single-step undo + ACL + collab-room block + stabilizer immutability).
 * 5. Hard body-size (4 MiB) and concurrency (4) limits.
 */

export interface McpServerStatus {
  running: boolean;
  port: number | null;
  endpointUrl: string | null;
  token: string | null;
  allowWrite: boolean;
  requestCount: number;
  activeCalls: number;
}

export type McpCanvasToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
  allowWrite: boolean,
) => Promise<unknown>;

interface McpToolDescriptor {
  name: string;
  description: string;
  write: boolean;
  inputSchema: Record<string, unknown>;
}

const MCP_PROTOCOL_VERSION = '2025-03-26';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENT_CALLS = 4;

const MCP_TOOLS: readonly McpToolDescriptor[] = [
  {
    name: 'canvas.get_info',
    description: 'Read active local canvas dimensions, DPI, and tile size.',
    write: false,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'layers.list',
    description: 'List all layers in the active local canvas.',
    write: false,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pixels.get_bounds',
    description: 'Get non-empty pixel bounding box of a layer.',
    write: false,
    inputSchema: {
      type: 'object',
      properties: { layerId: { type: 'string' } },
      required: ['layerId'],
    },
  },
  {
    name: 'pixels.read_region',
    description: 'Read a small RGBA pixel region (max 256x256) as base64.',
    write: false,
    inputSchema: {
      type: 'object',
      properties: {
        layerId: { type: 'string' },
        x: { type: 'integer' },
        y: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
      required: ['layerId', 'x', 'y', 'width', 'height'],
    },
  },
  {
    name: 'timeline.get_state',
    description: 'Read animation timeline FPS, frame length, current frame, and tracks.',
    write: false,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'keyframes.list',
    description: 'List animation keyframes for a layer.',
    write: false,
    inputSchema: {
      type: 'object',
      properties: { layerId: { type: 'string' } },
      required: ['layerId'],
    },
  },
  {
    name: 'layers.create',
    description: 'Create a new raster layer (requires Allow Canvas Writes; single-step undo).',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        opacity: { type: 'number' },
      },
    },
  },
  {
    name: 'layers.update',
    description: 'Update permitted layer name, visibility, or opacity (cannot alter ownership/locks).',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        layerId: { type: 'string' },
        name: { type: 'string' },
        opacity: { type: 'number' },
        isVisible: { type: 'boolean' },
      },
      required: ['layerId'],
    },
  },
  {
    name: 'pixels.fill_rect',
    description: 'Fill a rectangle on an editable layer with RGBA color (single-step undo).',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        layerId: { type: 'string' },
        x: { type: 'integer' },
        y: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        color: { type: 'string' },
      },
      required: ['layerId', 'x', 'y', 'width', 'height', 'color'],
    },
  },
  {
    name: 'timeline.set_frame',
    description: 'Seek active animation timeline frame.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { frame: { type: 'integer' } },
      required: ['frame'],
    },
  },
  {
    name: 'keyframes.set',
    description: 'Set a keyframe on a permitted layer (single-step undo).',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        layerId: { type: 'string' },
        frame: { type: 'integer' },
        x: { type: 'number' },
        y: { type: 'number' },
        opacity: { type: 'number' },
      },
      required: ['layerId', 'frame'],
    },
  },
];

function timingSafeTokenEquals(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

export class LocalMcpServer {
  private server: http.Server | null = null;
  private port: number | null = null;
  private token: string | null = null;
  private allowWrite = false;
  private requestCount = 0;
  private activeCalls = 0;
  private readonly executor: McpCanvasToolExecutor;

  constructor(executor: McpCanvasToolExecutor) {
    this.executor = executor;
  }

  getStatus(): McpServerStatus {
    return {
      running: Boolean(this.server && this.port !== null),
      port: this.port,
      endpointUrl: this.port !== null ? `http://127.0.0.1:${this.port}/mcp` : null,
      token: this.token,
      allowWrite: this.allowWrite,
      requestCount: this.requestCount,
      activeCalls: this.activeCalls,
    };
  }

  setAllowWrite(allowWrite: boolean): McpServerStatus {
    this.allowWrite = Boolean(allowWrite);
    return this.getStatus();
  }

  rotateToken(): McpServerStatus {
    if (this.server) {
      this.token = crypto.randomBytes(32).toString('hex');
    }
    return this.getStatus();
  }

  async start(options?: { port?: number; allowWrite?: boolean }): Promise<McpServerStatus> {
    if (this.server) {
      if (options?.allowWrite !== undefined) this.allowWrite = Boolean(options.allowWrite);
      return this.getStatus();
    }

    const requestedPort =
      typeof options?.port === 'number' && Number.isInteger(options.port) && options.port >= 1024 && options.port <= 65535
        ? options.port
        : 0;

    this.allowWrite = Boolean(options?.allowWrite);
    this.token = crypto.randomBytes(32).toString('hex');
    this.requestCount = 0;
    this.activeCalls = 0;

    const srv = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(requestedPort, '127.0.0.1', () => {
        srv.removeListener('error', reject);
        resolve();
      });
    });

    const address = srv.address();
    if (!address || typeof address === 'string') {
      srv.close();
      throw new Error('Failed to bind local MCP server port.');
    }

    this.server = srv;
    this.port = address.port;
    return this.getStatus();
  }

  async stop(): Promise<McpServerStatus> {
    const srv = this.server;
    this.server = null;
    this.port = null;
    this.token = null;
    this.allowWrite = false;
    this.activeCalls = 0;
    if (srv) {
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
      });
    }
    return this.getStatus();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.port || !this.token) {
      sendJson(res, 503, { error: 'MCP server is stopped.' });
      return;
    }

    // 1. Strict Host header check (DNS Rebinding guard)
    const rawHost = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
    const allowedHosts = new Set([
      `127.0.0.1:${this.port}`,
      `localhost:${this.port}`,
      `[::1]:${this.port}`,
    ]);
    if (!rawHost || !allowedHosts.has(rawHost.trim().toLowerCase())) {
      sendJson(res, 403, { error: 'Forbidden: invalid Host header.' });
      return;
    }

    // 2. Reject any cross-origin browser requests (CSRF guard)
    const rawOrigin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    if (rawOrigin && rawOrigin.trim().length > 0) {
      sendJson(res, 403, { error: 'Forbidden: cross-origin browser requests are not allowed.' });
      return;
    }

    // 3. Path & method check
    if (req.url !== '/mcp' && req.url !== '/mcp/') {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }

    // 4. Timing-safe Bearer Token authentication
    const rawAuth = Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : req.headers.authorization;
    if (!rawAuth || !rawAuth.startsWith('Bearer ')) {
      sendJson(res, 401, { error: 'Unauthorized: missing Bearer token.' });
      return;
    }
    const providedToken = rawAuth.slice('Bearer '.length).trim();
    if (!timingSafeTokenEquals(providedToken, this.token)) {
      sendJson(res, 401, { error: 'Unauthorized: invalid Bearer token.' });
      return;
    }

    // 5. Concurrency cap
    if (this.activeCalls >= MAX_CONCURRENT_CALLS) {
      sendJson(res, 429, { error: 'Too many concurrent MCP calls.' });
      return;
    }

    // 6. Body read with hard size limit
    let rawBody: string;
    try {
      rawBody = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > MAX_BODY_BYTES) {
            reject(new Error('PAYLOAD_TOO_LARGE'));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE') {
        sendJson(res, 413, { error: 'Request payload exceeds 4 MiB limit.' });
        return;
      }
      sendJson(res, 400, { error: 'Failed to read request body.' });
      return;
    }

    let message: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    try {
      message = JSON.parse(rawBody);
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        id: message?.id ?? null,
        error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request.' },
      });
      return;
    }

    this.requestCount += 1;
    this.activeCalls += 1;
    try {
      const result = await this.dispatchJsonRpc(message.method, message.params);
      sendJson(res, 200, { jsonrpc: '2.0', id: message.id ?? null, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'MCP execution failed.';
      const code = msg.includes('read-only') || msg.includes('collaborative') ? -32001 : -32603;
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: { code, message: msg },
      });
    } finally {
      this.activeCalls = Math.max(0, this.activeCalls - 1);
    }
  }

  private async dispatchJsonRpc(method: string, params: unknown): Promise<unknown> {
    if (method === 'initialize') {
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: 'lumina-drift-local-mcp',
          version: '3.0.0',
        },
      };
    }

    if (method === 'ping') {
      return {};
    }

    if (method === 'tools/list') {
      const visible = MCP_TOOLS.filter((t) => this.allowWrite || !t.write).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return { tools: visible };
    }

    if (method === 'tools/call') {
      const obj = (params && typeof params === 'object' ? params : {}) as {
        name?: unknown;
        arguments?: unknown;
      };
      if (typeof obj.name !== 'string' || !obj.name.trim()) {
        throw new Error('tools/call requires a valid tool name.');
      }
      const descriptor = MCP_TOOLS.find((t) => t.name === obj.name);
      if (!descriptor) {
        throw new Error(`Unknown MCP tool: ${obj.name}`);
      }
      if (descriptor.write && !this.allowWrite) {
        throw new Error(`MCP server is in read-only mode; write tool "${descriptor.name}" is blocked.`);
      }
      const args = (obj.arguments && typeof obj.arguments === 'object' && !Array.isArray(obj.arguments)
        ? obj.arguments
        : {}) as Record<string, unknown>;
      if ('stabilizerLevel' in args || 'stabilizer' in args || 'stabilizerMode' in args) {
        throw new Error('Stabilizer settings cannot be modified via MCP.');
      }
      const data = await this.executor(descriptor.name, args, this.allowWrite);
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
      };
    }

    throw new Error(`Unsupported MCP JSON-RPC method: ${method}`);
  }
}
