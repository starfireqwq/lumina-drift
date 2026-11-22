import {
  PLUGIN_LIMITS,
  type PluginBridgeToolDeclaration,
  type PluginManifestModern,
} from './pluginApi';
import type { PluginCanvasTransaction } from './pluginCanvasBridge';
import type { PluginRpcHandler } from './pluginRpc';
import {
  assertMcpToolAllowed,
  assertNoStabilizerMutation,
  evaluateV3RuntimePolicy,
  validateBridgeArgValue,
  validateBridgeFlatFileName,
  type V3RuntimeEnvironment,
  type V3RuntimePolicyDecision,
} from './pluginV3Policy';

export interface TrustedBridgeToolProfileView {
  id: string;
  label: string;
  executablePath: string;
  sha256: string;
  argTemplate: string[];
  expectsOutputFile: boolean;
  timeoutMs: number;
  createdAt: number;
}

export interface TrustedMcpClientProfileView {
  id: string;
  label: string;
  endpointUrl: string;
  hasToken: boolean;
  createdAt: number;
}

export interface McpServerStatusView {
  running: boolean;
  port: number | null;
  endpointUrl: string | null;
  token: string | null;
  allowWrite: boolean;
  requestCount: number;
  activeCalls: number;
}

export interface DesktopPluginV3Api {
  listProfiles(): Promise<{
    tools: TrustedBridgeToolProfileView[];
    mcpClients: TrustedMcpClientProfileView[];
  }>;
  pickExecutable(): Promise<{
    canceled: boolean;
    executablePath?: string;
    sha256?: string;
    error?: string;
  }>;
  saveToolProfile(input: {
    id: string;
    label: string;
    executablePath: string;
    argTemplate?: string[];
    expectsOutputFile?: boolean;
    timeoutMs?: number;
  }): Promise<TrustedBridgeToolProfileView>;
  removeToolProfile(id: string): Promise<boolean>;
  invokeTool(req: {
    runId?: string;
    toolId: string;
    args?: Record<string, unknown>;
    stdinText?: string;
    inputFileName?: string;
    inputBytes?: Uint8Array;
    outputFileName?: string;
    timeoutMs?: number;
  }): Promise<{
    ok: boolean;
    runId: string;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    outputBytes?: Uint8Array;
    durationMs: number;
    error?: string;
  }>;
  abortRun(runId: string): Promise<boolean>;
  killAll(): Promise<{ stoppedRuns: number; mcpStopped: boolean }>;
  mcpServer: {
    getStatus(): Promise<McpServerStatusView | null>;
    start(options?: { port?: number; allowWrite?: boolean }): Promise<McpServerStatusView>;
    stop(): Promise<McpServerStatusView | null>;
    setAllowWrite(allowWrite: boolean): Promise<McpServerStatusView | null>;
    rotateToken(): Promise<McpServerStatusView | null>;
    onCanvasRequest(
      callback: (payload: {
        requestId: string;
        toolName: string;
        args: Record<string, unknown>;
        allowWrite: boolean;
      }) => void,
    ): () => void;
    sendCanvasResponse(payload: { requestId: string; ok: boolean; result?: unknown; error?: string }): void;
  };
  mcpClient: {
    saveProfile(input: {
      id: string;
      label: string;
      endpointUrl: string;
      bearerToken?: string;
    }): Promise<TrustedMcpClientProfileView>;
    removeProfile(id: string): Promise<boolean>;
    call(payload: {
      serverId: string;
      method: string;
      params?: unknown;
      timeoutMs?: number;
    }): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  };
}

export function getDesktopPluginV3(): DesktopPluginV3Api | null {
  if (typeof window === 'undefined') return null;
  const desktop = (window as unknown as { atelierDesktop?: { isElectron?: boolean; pluginV3?: DesktopPluginV3Api } })
    .atelierDesktop;
  if (!desktop?.isElectron || !desktop.pluginV3) return null;
  return desktop.pluginV3;
}

export function detectV3RuntimeEnvironment(
  isCollaborativeRoom: boolean,
  hasActiveCanvas = true,
): V3RuntimeEnvironment {
  const isElectron = Boolean(getDesktopPluginV3());
  let isMobile = false;
  if (typeof window !== 'undefined') {
    const mobileHost = Boolean((window as unknown as { atelierMobile?: { isAndroid?: boolean } }).atelierMobile?.isAndroid);
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    isMobile = mobileHost || (!isElectron && coarse && window.innerWidth <= 900);
  }
  return {
    isElectron,
    isMobile,
    isCollaborativeRoom,
    hasActiveCanvas,
  };
}

export function checkV3RuntimePolicy(
  isCollaborativeRoom: boolean,
  hasActiveCanvas = true,
): V3RuntimePolicyDecision {
  return evaluateV3RuntimePolicy(detectV3RuntimeEnvironment(isCollaborativeRoom, hasActiveCanvas));
}

export type V3ConsentDecision = 'deny' | 'once' | 'session';

export interface V3ConsentRequest {
  id: string;
  kind: 'bridge:local' | 'mcp:client';
  pluginId: string;
  pluginName: string;
  targetId: string;
  targetSummary: string;
  detailLines: string[];
}

type V3ConsentRequester = (req: V3ConsentRequest) => Promise<V3ConsentDecision>;

let consentRequester: V3ConsentRequester | null = null;
const sessionGrants = new Map<string, Set<string>>();
let activeBridgeRuns = 0;
let mcpServerRunning = false;
const activityListeners = new Set<() => void>();

function notifyActivity(): void {
  for (const listener of activityListeners) listener();
}

export function subscribeV3Activity(listener: () => void): () => void {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}

export function getV3ActivitySnapshot(): { activeBridgeRuns: number; mcpServerRunning: boolean } {
  return { activeBridgeRuns, mcpServerRunning };
}

export function setV3McpServerRunningHint(running: boolean): void {
  if (mcpServerRunning !== running) {
    mcpServerRunning = running;
    notifyActivity();
  }
}

export function setV3ConsentRequester(requester: V3ConsentRequester | null): void {
  consentRequester = requester;
}

export function revokePluginV3Consent(pluginId?: string): void {
  if (pluginId) {
    sessionGrants.delete(pluginId);
  } else {
    sessionGrants.clear();
  }
}

export async function killAllPluginV3Bridges(): Promise<{ stoppedRuns: number; mcpStopped: boolean }> {
  revokePluginV3Consent();
  const api = getDesktopPluginV3();
  if (!api) {
    activeBridgeRuns = 0;
    mcpServerRunning = false;
    notifyActivity();
    return { stoppedRuns: 0, mcpStopped: false };
  }
  const result = await api.killAll();
  activeBridgeRuns = 0;
  mcpServerRunning = false;
  notifyActivity();
  return result;
}

async function requestV3Consent(req: Omit<V3ConsentRequest, 'id'>, scopeKey: string): Promise<boolean> {
  const granted = sessionGrants.get(req.pluginId);
  if (granted?.has(scopeKey)) return true;
  if (!consentRequester) {
    // Fail-closed: never run external tools or MCP without explicit user confirmation UI
    return false;
  }
  const decision = await consentRequester({
    ...req,
    id: `consent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  if (decision === 'session') {
    let set = sessionGrants.get(req.pluginId);
    if (!set) {
      set = new Set<string>();
      sessionGrants.set(req.pluginId, set);
    }
    set.add(scopeKey);
    return true;
  }
  return decision === 'once';
}

function summarizePayload(args: Record<string, unknown>, inputByteLength: number, stdinText?: string): string[] {
  const lines: string[] = [];
  const entries = Object.entries(args);
  if (entries.length > 0) {
    const preview = entries
      .slice(0, 6)
      .map(([k, v]) => `${k}=${String(v).slice(0, 48)}`)
      .join(', ');
    lines.push(`Args: ${preview}${entries.length > 6 ? ' …' : ''}`);
  }
  if (stdinText) {
    lines.push(`Stdin: ${stdinText.length} chars`);
  }
  if (inputByteLength > 0) {
    lines.push(`Binary input: ${(inputByteLength / 1024).toFixed(1)} KiB`);
  }
  if (lines.length === 0) lines.push('No extra arguments or payload.');
  return lines;
}

export function createPluginV3RpcHandler(options: {
  manifest: PluginManifestModern;
  isCollaborativeRoom: boolean;
  signal?: AbortSignal;
}): PluginRpcHandler {
  const { manifest, isCollaborativeRoom, signal } = options;

  return async (method, params, buffer) => {
    const policy = checkV3RuntimePolicy(isCollaborativeRoom, true);
    if (!policy.allowed) {
      throw new Error(policy.message || 'Plugin API v3.0 is unavailable in this environment.');
    }
    const desktop = getDesktopPluginV3();
    if (!desktop) {
      throw new Error('Desktop v3 bridge IPC is unavailable.');
    }

    const obj = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;

    if (method === 'bridge.listTools') {
      const profiles = await desktop.listProfiles();
      const declared = manifest.apiVersion === 3 ? (manifest.bridgeTools ?? []) : [];
      const declaredIds = new Set(declared.map((t) => t.id));
      const tools = profiles.tools
        .filter((p) => declaredIds.size === 0 || declaredIds.has(p.id))
        .map((p) => ({
          id: p.id,
          label: p.label,
          expectsOutputFile: p.expectsOutputFile,
          timeoutMs: p.timeoutMs,
        }));
      return { result: tools };
    }

    if (method === 'bridge.invoke') {
      const toolId = typeof obj.toolId === 'string' ? obj.toolId.trim() : '';
      if (!toolId) throw new Error('bridge.invoke requires a toolId.');

      let toolDecl: PluginBridgeToolDeclaration | undefined;
      if (manifest.apiVersion === 3 && manifest.bridgeTools && manifest.bridgeTools.length > 0) {
        toolDecl = manifest.bridgeTools.find((t) => t.id === toolId);
        if (!toolDecl) {
          throw new Error(`Bridge tool "${toolId}" is not declared in this plugin manifest.`);
        }
      }

      const rawArgs = (obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)
        ? obj.args
        : {}) as Record<string, unknown>;

      // Pre-validate every argument in renderer before showing consent or crossing IPC
      if (toolDecl?.args) {
        const specMap = new Map(toolDecl.args.map((s) => [s.key, s]));
        for (const key of Object.keys(rawArgs)) {
          if (!specMap.has(key)) throw new Error(`Undeclared bridge argument "${key}".`);
        }
        for (const spec of toolDecl.args) {
          validateBridgeArgValue(spec.key, rawArgs[spec.key], spec);
        }
      } else {
        for (const [key, val] of Object.entries(rawArgs)) {
          validateBridgeArgValue(key, val);
        }
      }

      const inputFileName = obj.inputFileName !== undefined
        ? validateBridgeFlatFileName(obj.inputFileName)
        : undefined;
      const outputFileName = obj.outputFileName !== undefined
        ? validateBridgeFlatFileName(obj.outputFileName)
        : undefined;
      const stdinText = typeof obj.stdinText === 'string' ? obj.stdinText : undefined;
      const inputBytes = buffer ? new Uint8Array(buffer) : undefined;
      if (inputBytes && inputBytes.byteLength > PLUGIN_LIMITS.maxBridgeInputBytes) {
        throw new Error('Bridge input exceeds maximum size limit.');
      }

      const profiles = await desktop.listProfiles();
      const profile = profiles.tools.find((p) => p.id === toolId);
      if (!profile) {
        throw new Error(`Local tool "${toolId}" is not bound in Desktop Bridge settings.`);
      }

      const approved = await requestV3Consent(
        {
          kind: 'bridge:local',
          pluginId: manifest.id,
          pluginName: manifest.name,
          targetId: profile.id,
          targetSummary: `${profile.label} (${profile.executablePath})`,
          detailLines: [
            `SHA-256: ${profile.sha256.slice(0, 16)}…`,
            ...summarizePayload(rawArgs, inputBytes?.byteLength ?? 0, stdinText),
          ],
        },
        `bridge:${profile.id}:${profile.sha256}`,
      );
      if (!approved) {
        throw new Error('User denied external local tool execution.');
      }

      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const onAbort = () => {
        void desktop.abortRun(runId);
      };
      if (signal?.aborted) {
        throw new Error('Plugin execution aborted.');
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      activeBridgeRuns += 1;
      notifyActivity();
      try {
        const res = await desktop.invokeTool({
          runId,
          toolId: profile.id,
          args: rawArgs,
          ...(stdinText !== undefined ? { stdinText } : {}),
          ...(inputFileName ? { inputFileName } : {}),
          ...(inputBytes ? { inputBytes } : {}),
          ...(outputFileName ? { outputFileName } : {}),
          ...(typeof obj.timeoutMs === 'number' ? { timeoutMs: obj.timeoutMs } : {}),
        });
        if (!res.ok) {
          throw new Error(res.error || 'Local tool execution failed.');
        }
        const outBuf = res.outputBytes
          ? res.outputBytes.slice().buffer
          : undefined;
        return {
          result: {
            exitCode: res.exitCode ?? 0,
            stdout: res.stdout ?? '',
            stderr: res.stderr ?? '',
            durationMs: res.durationMs,
          },
          ...(outBuf ? { buffer: outBuf } : {}),
        };
      } finally {
        signal?.removeEventListener('abort', onAbort);
        activeBridgeRuns = Math.max(0, activeBridgeRuns - 1);
        notifyActivity();
      }
    }

    if (method === 'mcp.serverStatus') {
      const status = await desktop.mcpServer.getStatus();
      // Never leak Bearer token back into QuickJS plugin sandbox
      return {
        result: status
          ? {
              running: status.running,
              port: status.port,
              endpointUrl: status.endpointUrl,
              allowWrite: status.allowWrite,
            }
          : { running: false, port: null, endpointUrl: null, allowWrite: false },
      };
    }

    if (method === 'mcp.listServers') {
      const profiles = await desktop.listProfiles();
      return {
        result: profiles.mcpClients.map((c) => ({
          id: c.id,
          label: c.label,
          endpointUrl: c.endpointUrl,
        })),
      };
    }

    if (method === 'mcp.listTools') {
      const serverId = typeof obj.serverId === 'string' ? obj.serverId.trim() : '';
      if (!serverId) throw new Error('mcp.listTools requires serverId.');
      const res = await desktop.mcpClient.call({ serverId, method: 'tools/list', params: {} });
      if (!res.ok) throw new Error(res.error || 'Failed to list MCP tools.');
      return { result: res.result };
    }

    if (method === 'mcp.callTool') {
      const serverId = typeof obj.serverId === 'string' ? obj.serverId.trim() : '';
      const toolName = typeof obj.name === 'string' ? obj.name.trim() : '';
      if (!serverId || !toolName) {
        throw new Error('mcp.callTool requires serverId and name.');
      }
      const args = (obj.arguments && typeof obj.arguments === 'object' && !Array.isArray(obj.arguments)
        ? obj.arguments
        : {}) as Record<string, unknown>;
      assertNoStabilizerMutation(args);

      const profiles = await desktop.listProfiles();
      const server = profiles.mcpClients.find((c) => c.id === serverId);
      if (!server) {
        throw new Error(`Local MCP server "${serverId}" is not registered.`);
      }

      const approved = await requestV3Consent(
        {
          kind: 'mcp:client',
          pluginId: manifest.id,
          pluginName: manifest.name,
          targetId: `${server.id}:${toolName}`,
          targetSummary: `${server.label} (${server.endpointUrl}) · ${toolName}`,
          detailLines: summarizePayload(args, 0),
        },
        `mcp:${server.id}:${toolName}`,
      );
      if (!approved) {
        throw new Error('User denied local MCP tool call.');
      }

      activeBridgeRuns += 1;
      notifyActivity();
      try {
        const res = await desktop.mcpClient.call({
          serverId: server.id,
          method: 'tools/call',
          params: { name: toolName, arguments: args },
        });
        if (!res.ok) throw new Error(res.error || 'Local MCP tool call failed.');
        return { result: res.result };
      } finally {
        activeBridgeRuns = Math.max(0, activeBridgeRuns - 1);
        notifyActivity();
      }
    }

    throw new Error(`Unsupported v3 RPC method: ${method}`);
  };
}

function parseHexRgba(color: string): [number, number, number, number] {
  const m = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(color.trim());
  if (!m) throw new Error('color must be #RRGGBB or #RRGGBBAA.');
  const hex = m[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;
  return [r, g, b, a];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Executes an incoming Local MCP Server canvas tool request through the exact same
 * PluginCanvasTransaction, ACL, and ScopedUndoManager pipeline used by v2/v2.5 plugins.
 */
export async function executeMcpCanvasTool(options: {
  tx: PluginCanvasTransaction;
  canvasInfo: { width: number; height: number; dpi: number; tileSize: number };
  toolName: string;
  args: Record<string, unknown>;
  allowWrite: boolean;
  isCollaborativeRoom: boolean;
}): Promise<{ result: unknown; mutated: boolean }> {
  const { tx, canvasInfo, toolName, args, allowWrite, isCollaborativeRoom } = options;

  const policy = checkV3RuntimePolicy(isCollaborativeRoom, true);
  if (!policy.allowed) {
    throw new Error(policy.message || 'MCP canvas access is blocked in this mode.');
  }
  assertMcpToolAllowed(toolName, allowWrite);
  assertNoStabilizerMutation(args);

  const rpc = tx.createRpcHandler();

  switch (toolName) {
    case 'canvas.get_info':
      return { result: canvasInfo, mutated: false };

    case 'layers.list': {
      const res = await rpc('layers.list', {});
      return { result: res.result, mutated: false };
    }

    case 'pixels.get_bounds': {
      const res = await rpc('pixels.getNonEmptyBounds', { layerId: args.layerId });
      return { result: res.result, mutated: false };
    }

    case 'pixels.read_region': {
      const w = Math.min(256, Math.max(1, Math.round(Number(args.width) || 0)));
      const h = Math.min(256, Math.max(1, Math.round(Number(args.height) || 0)));
      const x = Math.round(Number(args.x) || 0);
      const y = Math.round(Number(args.y) || 0);
      const res = await rpc('pixels.read', {
        layerId: args.layerId,
        rect: { x, y, width: w, height: h },
      });
      const bytes = res.buffer ? new Uint8Array(res.buffer) : new Uint8Array(0);
      return {
        result: {
          ...(res.result as Record<string, unknown>),
          rgbaBase64: bytesToBase64(bytes),
        },
        mutated: false,
      };
    }

    case 'timeline.get_state': {
      const res = await rpc('timeline.getState', {});
      return { result: res.result, mutated: false };
    }

    case 'keyframes.list': {
      const res = await rpc('keyframes.list', { layerId: args.layerId });
      return { result: res.result, mutated: false };
    }

    case 'layers.create': {
      const res = await rpc('layers.create', {
        name: typeof args.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 60) : 'MCP Layer',
        ...(typeof args.opacity === 'number' ? { opacity: args.opacity } : {}),
      });
      return { result: res.result, mutated: true };
    }

    case 'layers.update': {
      const patch: Record<string, unknown> = {};
      if (typeof args.name === 'string') patch.name = args.name;
      if (typeof args.opacity === 'number') patch.opacity = args.opacity;
      if (typeof args.isVisible === 'boolean') patch.isVisible = args.isVisible;
      const res = await rpc('layers.update', { layerId: args.layerId, patch });
      return { result: res.result, mutated: true };
    }

    case 'pixels.fill_rect': {
      const w = Math.min(512, Math.max(1, Math.round(Number(args.width) || 0)));
      const h = Math.min(512, Math.max(1, Math.round(Number(args.height) || 0)));
      const x = Math.round(Number(args.x) || 0);
      const y = Math.round(Number(args.y) || 0);
      const [r, g, b, a] = parseHexRgba(typeof args.color === 'string' ? args.color : '');
      const buf = new Uint8Array(w * h * 4);
      for (let i = 0; i < buf.length; i += 4) {
        buf[i] = r;
        buf[i + 1] = g;
        buf[i + 2] = b;
        buf[i + 3] = a;
      }
      const res = await rpc(
        'pixels.write',
        { layerId: args.layerId, patch: { x, y, width: w, height: h, respectSelection: true } },
        buf.buffer,
      );
      return { result: res.result, mutated: true };
    }

    case 'timeline.set_frame': {
      const res = await rpc('timeline.setFrame', { frame: Number(args.frame) });
      return { result: res.result, mutated: true };
    }

    case 'keyframes.set': {
      const { layerId, ...kf } = args;
      const res = await rpc('keyframes.set', { layerId, keyframe: kf });
      return { result: res.result, mutated: true };
    }

    default:
      throw new Error(`Unsupported MCP canvas tool: ${toolName}`);
  }
}
