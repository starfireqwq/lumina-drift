import {
  PLUGIN_LIMITS,
  type PluginManifestModern,
  type PluginPermissionV3,
} from './pluginApi';

export type PluginRpcMethod =
  | 'brush.get'
  | 'brush.set'
  | 'layers.list'
  | 'layers.get'
  | 'layers.getActive'
  | 'layers.create'
  | 'layers.update'
  | 'layers.reorder'
  | 'layers.delete'
  | 'layers.setActive'
  | 'pixels.getNonEmptyBounds'
  | 'pixels.read'
  | 'pixels.readComposite'
  | 'pixels.write'
  | 'selection.getInfo'
  | 'selection.readMask'
  | 'selection.writeMask'
  | 'selection.selectRect'
  | 'selection.selectEllipse'
  | 'selection.selectPolygon'
  | 'selection.clear'
  | 'selection.invert'
  | 'selection.expand'
  | 'selection.contract'
  | 'selection.feather'
  | 'timeline.getState'
  | 'timeline.setFrame'
  | 'timeline.setFps'
  | 'timeline.setLength'
  | 'timeline.setRange'
  | 'timeline.setLoop'
  | 'timeline.listLabels'
  | 'timeline.setLabel'
  | 'timeline.removeLabel'
  | 'timeline.updateCel'
  | 'keyframes.list'
  | 'keyframes.evaluate'
  | 'keyframes.set'
  | 'keyframes.setBatch'
  | 'keyframes.remove'
  | 'keyframes.clear'
  | 'easing.listPresets'
  | 'easing.register'
  | 'easing.unregister'
  | 'easing.evaluate'
  | 'bridge.listTools'
  | 'bridge.invoke'
  | 'mcp.serverStatus'
  | 'mcp.listServers'
  | 'mcp.listTools'
  | 'mcp.callTool';

export const PLUGIN_RPC_PERMISSION_MAP: Record<PluginRpcMethod, PluginPermissionV3> = {
  'brush.get': 'brush',
  'brush.set': 'brush',
  'layers.list': 'layers:read',
  'layers.get': 'layers:read',
  'layers.getActive': 'layers:read',
  'layers.create': 'layers:write',
  'layers.update': 'layers:write',
  'layers.reorder': 'layers:write',
  'layers.delete': 'layers:write',
  'layers.setActive': 'layers:write',
  'pixels.getNonEmptyBounds': 'pixels:read',
  'pixels.read': 'pixels:read',
  'pixels.readComposite': 'pixels:read',
  'pixels.write': 'pixels:write',
  'selection.getInfo': 'selection',
  'selection.readMask': 'selection',
  'selection.writeMask': 'selection',
  'selection.selectRect': 'selection',
  'selection.selectEllipse': 'selection',
  'selection.selectPolygon': 'selection',
  'selection.clear': 'selection',
  'selection.invert': 'selection',
  'selection.expand': 'selection',
  'selection.contract': 'selection',
  'selection.feather': 'selection',
  'timeline.getState': 'timeline:read',
  'timeline.setFrame': 'timeline:write',
  'timeline.setFps': 'timeline:write',
  'timeline.setLength': 'timeline:write',
  'timeline.setRange': 'timeline:write',
  'timeline.setLoop': 'timeline:write',
  'timeline.listLabels': 'timeline:read',
  'timeline.setLabel': 'timeline:write',
  'timeline.removeLabel': 'timeline:write',
  'timeline.updateCel': 'timeline:write',
  'keyframes.list': 'timeline:read',
  'keyframes.evaluate': 'timeline:read',
  'keyframes.set': 'timeline:write',
  'keyframes.setBatch': 'timeline:write',
  'keyframes.remove': 'timeline:write',
  'keyframes.clear': 'timeline:write',
  'easing.listPresets': 'timeline:read',
  'easing.register': 'timeline:write',
  'easing.unregister': 'timeline:write',
  'easing.evaluate': 'timeline:read',
  'bridge.listTools': 'bridge:local',
  'bridge.invoke': 'bridge:local',
  'mcp.serverStatus': 'mcp:server',
  'mcp.listServers': 'mcp:client',
  'mcp.listTools': 'mcp:client',
  'mcp.callTool': 'mcp:client',
};

export const PLUGIN_V3_RPC_METHODS: ReadonlySet<PluginRpcMethod> = new Set([
  'bridge.listTools',
  'bridge.invoke',
  'mcp.serverStatus',
  'mcp.listServers',
  'mcp.listTools',
  'mcp.callTool',
]);

export interface PluginRpcRequest {
  id: number;
  method: PluginRpcMethod;
  params: unknown;
  buffer?: ArrayBuffer;
}

export interface PluginRpcSuccess {
  id: number;
  ok: true;
  result: unknown;
  buffer?: ArrayBuffer;
}

export interface PluginRpcFailure {
  id: number;
  ok: false;
  error: string;
}

export type PluginRpcResponse = PluginRpcSuccess | PluginRpcFailure;

export interface PluginV2Result {
  notice?: string;
  statusText?: string;
  patchValues?: Record<string, string | number | boolean>;
}

export type PluginRpcHandler = (
  method: PluginRpcMethod,
  params: unknown,
  buffer?: ArrayBuffer,
) => Promise<{ result: unknown; buffer?: ArrayBuffer }>;

export interface PluginQuotaConfig {
  maxRpcCalls?: number;
  maxPixelBytes?: number;
  maxCreatedLayers?: number;
}

export class PluginQuotaTracker {
  private rpcCalls = 0;
  private pixelBytes = 0;
  private createdLayers = 0;
  readonly maxRpcCalls: number;
  readonly maxPixelBytes: number;
  readonly maxCreatedLayers: number;

  constructor(config?: PluginQuotaConfig) {
    this.maxRpcCalls = config?.maxRpcCalls ?? PLUGIN_LIMITS.maxRpcCallsPerRun;
    this.maxPixelBytes = config?.maxPixelBytes ?? PLUGIN_LIMITS.maxPixelBytesPerRun;
    this.maxCreatedLayers = config?.maxCreatedLayers ?? PLUGIN_LIMITS.maxCreatedLayersPerRun;
  }

  consumeRpc(): void {
    this.rpcCalls += 1;
    if (this.rpcCalls > this.maxRpcCalls) {
      throw new Error(`RPC quota exceeded (limit: ${this.maxRpcCalls} calls per run).`);
    }
  }

  consumePixelBytes(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    this.pixelBytes += bytes;
    if (this.pixelBytes > this.maxPixelBytes) {
      throw new Error(`Pixel I/O quota exceeded (limit: ${Math.round(this.maxPixelBytes / (1024 * 1024))} MiB per run).`);
    }
  }

  consumeLayerCreation(): void {
    this.createdLayers += 1;
    if (this.createdLayers > this.maxCreatedLayers) {
      throw new Error(`Layer creation quota exceeded (limit: ${this.maxCreatedLayers} layers per run).`);
    }
  }

  getStats() {
    return {
      rpcCalls: this.rpcCalls,
      pixelBytes: this.pixelBytes,
      createdLayers: this.createdLayers,
    };
  }
}

export function isPluginRpcMethod(method: unknown): method is PluginRpcMethod {
  return typeof method === 'string' && Object.prototype.hasOwnProperty.call(PLUGIN_RPC_PERMISSION_MAP, method);
}

export function assertPluginRpcAllowed(
  manifest: PluginManifestModern,
  method: unknown,
  params: unknown,
): asserts method is PluginRpcMethod {
  if (!isPluginRpcMethod(method)) {
    throw new Error(`Unknown RPC method: ${String(method)}`);
  }
  if (PLUGIN_V3_RPC_METHODS.has(method) && manifest.apiVersion < 3) {
    throw new Error(`RPC method "${method}" requires Plugin API v3.`);
  }
  const required = PLUGIN_RPC_PERMISSION_MAP[method];
  if (!(manifest.permissions as readonly string[]).includes(required)) {
    throw new Error(`Missing permission: ${required}`);
  }
  // Decision 4: pixels.write defaults respectSelection = true;
  // setting respectSelection = false explicitly requires the "selection" permission.
  if (method === 'pixels.write' && params && typeof params === 'object') {
    const patch = (params as { patch?: { respectSelection?: unknown } }).patch;
    if (patch && patch.respectSelection === false && !(manifest.permissions as readonly string[]).includes('selection')) {
      throw new Error('Setting respectSelection: false requires the "selection" permission.');
    }
  }
}

export function parsePluginV2Result(value: unknown): PluginV2Result {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Plugin v2 handler must return an object or undefined.');
  }
  const obj = value as Record<string, unknown>;
  const out: PluginV2Result = {};

  if (obj.notice !== undefined) {
    if (typeof obj.notice !== 'string' || obj.notice.length > 240 || /[\u0000-\u001f\u007f]/.test(obj.notice)) {
      throw new Error('Invalid notice text.');
    }
    const trimmed = obj.notice.trim();
    if (trimmed) out.notice = trimmed;
  }

  if (obj.statusText !== undefined) {
    if (typeof obj.statusText !== 'string' || obj.statusText.length > 240 || /[\u0000-\u001f\u007f]/.test(obj.statusText)) {
      throw new Error('Invalid statusText.');
    }
    out.statusText = obj.statusText.trim();
  }

  if (obj.patchValues !== undefined) {
    if (!obj.patchValues || typeof obj.patchValues !== 'object' || Array.isArray(obj.patchValues)) {
      throw new Error('patchValues must be a plain object.');
    }
    const entries = Object.entries(obj.patchValues as Record<string, unknown>);
    if (entries.length > PLUGIN_LIMITS.maxPanelFieldsPerPanel) {
      throw new Error('Too many keys in patchValues.');
    }
    const patch: Record<string, string | number | boolean> = {};
    for (const [k, v] of entries) {
      if (k.length > 60 || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(k)) {
        throw new Error(`Invalid patchValues key: ${k}`);
      }
      if (typeof v === 'boolean') {
        patch[k] = v;
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        patch[k] = v;
      } else if (typeof v === 'string' && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v)) {
        patch[k] = v;
      } else {
        throw new Error(`Invalid patchValues value for key: ${k}`);
      }
    }
    out.patchValues = patch;
  }

  return out;
}
