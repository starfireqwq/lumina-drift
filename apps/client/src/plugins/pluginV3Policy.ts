import type { PluginBridgeArgSpec } from './pluginApi';

/**
 * Pure, dependency-free security policy & validation engine for Plugin API v3.0.
 * Shared across Renderer, Electron Main Process, and unit tests so every
 * security invariant (anti-shell-injection, anti-path-traversal, DNS rebinding,
 * loopback-only MCP, collab-room block, and stabilizer immutability) is enforced
 * consistently at every boundary.
 */

export type V3BlockReason =
  | 'UNSUPPORTED_WEB'
  | 'UNSUPPORTED_MOBILE'
  | 'BLOCKED_COLLAB_ROOM'
  | 'NO_ACTIVE_CANVAS';

export interface V3RuntimeEnvironment {
  isElectron: boolean;
  isMobile?: boolean;
  isCollaborativeRoom: boolean;
  hasActiveCanvas?: boolean;
}

export interface V3RuntimePolicyDecision {
  allowed: boolean;
  reason?: V3BlockReason;
  message?: string;
}

export function evaluateV3RuntimePolicy(env: V3RuntimeEnvironment): V3RuntimePolicyDecision {
  if (!env.isElectron) {
    if (env.isMobile) {
      return {
        allowed: false,
        reason: 'UNSUPPORTED_MOBILE',
        message: 'Plugin API v3.0 desktop bridges and local MCP are unavailable on mobile devices.',
      };
    }
    return {
      allowed: false,
      reason: 'UNSUPPORTED_WEB',
      message: 'Plugin API v3.0 desktop bridges and local MCP require the Electron desktop app.',
    };
  }
  if (env.isCollaborativeRoom) {
    return {
      allowed: false,
      reason: 'BLOCKED_COLLAB_ROOM',
      message: 'Plugin API v3.0 desktop bridges and local MCP are disabled in collaborative rooms.',
    };
  }
  if (env.hasActiveCanvas === false) {
    return {
      allowed: false,
      reason: 'NO_ACTIVE_CANVAS',
      message: 'Open a local canvas before running v3.0 bridges or MCP.',
    };
  }
  return { allowed: true };
}

/**
 * Shell metacharacters and control characters prohibited in any plugin-supplied
 * argument value even though spawn/execFile always uses shell: false.
 * Defense-in-depth against downstream wrappers or batch/script interpreters.
 */
const SHELL_META_RE = /[\u0000-\u001f\u007f;&|`$<>()[\]{}*?!~^"'\\]/;
const WINDOWS_RESERVED_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Known interactive/shell executable basenames forbidden from being registered as
 * trusted direct bridge executables to prevent arbitrary command execution via flags.
 */
const BLOCKED_SHELL_EXECUTABLES = new Set([
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'wscript.exe',
  'cscript.exe',
  'mshta.exe',
  'rundll32.exe',
  'regsvr32.exe',
]);

export function assertSafeExecutablePath(exePath: string): void {
  if (typeof exePath !== 'string' || !exePath.trim()) {
    throw new Error('Executable path is required.');
  }
  if (/[\u0000-\u001f\u007f]/.test(exePath)) {
    throw new Error('Executable path contains illegal control characters.');
  }
  const normalized = exePath.replace(/\\/g, '/').trim();
  const base = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  if (!base || BLOCKED_SHELL_EXECUTABLES.has(base)) {
    throw new Error(`Shell or script host executable "${base || exePath}" is not permitted as a bridge target.`);
  }
}

export function validateBridgeFlatFileName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('File name must be a string.');
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 120) {
    throw new Error('File name must be 1..120 characters.');
  }
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('..')) {
    throw new Error('Path traversal sequences are not allowed in file names.');
  }
  if (/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error('File name contains illegal path or control characters.');
  }
  if (WINDOWS_RESERVED_DEVICE_RE.test(trimmed)) {
    throw new Error('Reserved OS device names are not allowed.');
  }
  return trimmed;
}

/**
 * Pure normalized path containment check (works on both Windows and POSIX style paths).
 * Main process should pass realpath-resolved strings to also defeat symlink escapes.
 */
export function isPathInsideRoot(candidateResolvedPath: string, rootResolvedPath: string): boolean {
  if (!candidateResolvedPath || !rootResolvedPath) return false;
  if (/[\u0000-\u001f\u007f]/.test(candidateResolvedPath) || /[\u0000-\u001f\u007f]/.test(rootResolvedPath)) {
    return false;
  }
  const norm = (p: string) => {
    const unified = p.replace(/\\/g, '/').replace(/\/+$/, '');
    // Case-insensitive drive letter comparison on Windows paths
    return /^[A-Za-z]:\//.test(unified) ? unified.toLowerCase() : unified;
  };
  const root = norm(rootResolvedPath);
  const candidate = norm(candidateResolvedPath);
  if (!root || !candidate) return false;
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function validateBridgeArgValue(
  key: string,
  raw: unknown,
  spec?: PluginBridgeArgSpec,
): string {
  if (raw === undefined || raw === null) {
    if (spec?.required) {
      throw new Error(`Missing required bridge argument "${key}".`);
    }
    return '';
  }

  if (spec?.kind === 'boolean') {
    if (typeof raw !== 'boolean') {
      throw new Error(`Bridge argument "${key}" must be a boolean.`);
    }
    return raw ? 'true' : 'false';
  }

  if (spec?.kind === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new Error(`Bridge argument "${key}" must be a finite number.`);
    }
    if (spec.min !== undefined && raw < spec.min) {
      throw new Error(`Bridge argument "${key}" must be >= ${spec.min}.`);
    }
    if (spec.max !== undefined && raw > spec.max) {
      throw new Error(`Bridge argument "${key}" must be <= ${spec.max}.`);
    }
    return String(raw);
  }

  if (spec?.kind === 'enum') {
    if (typeof raw !== 'string' || !spec.options?.includes(raw)) {
      throw new Error(`Bridge argument "${key}" must be one of the declared options.`);
    }
    if (SHELL_META_RE.test(raw)) {
      throw new Error(`Bridge argument "${key}" contains disallowed characters.`);
    }
    return raw;
  }

  // String or generic scalar value
  const str = typeof raw === 'number' && Number.isFinite(raw)
    ? String(raw)
    : typeof raw === 'boolean'
      ? (raw ? 'true' : 'false')
      : typeof raw === 'string'
        ? raw
        : null;

  if (str === null) {
    throw new Error(`Bridge argument "${key}" must be a string, number, or boolean.`);
  }
  const maxLen = spec?.maxLength ?? 120;
  if (str.length > maxLen) {
    throw new Error(`Bridge argument "${key}" exceeds max length (${maxLen}).`);
  }
  if (SHELL_META_RE.test(str)) {
    throw new Error(`Bridge argument "${key}" contains disallowed shell or control characters.`);
  }
  if (str.includes('..') || str.includes('/')) {
    throw new Error(`Bridge argument "${key}" cannot contain path separators or traversal sequences.`);
  }
  // Prevent argument injection (passing unexpected CLI flags like "--eval" or "-e")
  if (str.startsWith('-')) {
    throw new Error(`Bridge argument "${key}" cannot start with "-" (argument injection guard).`);
  }
  return str;
}

export interface BridgeArgTemplateContext {
  inputFile?: string;
  outputFile?: string;
  args: Record<string, unknown>;
  argSpecs?: readonly PluginBridgeArgSpec[];
}

const PLACEHOLDER_RE = /^\{\{(inputFile|outputFile|arg:([a-zA-Z0-9._-]+))\}\}$/;
const INLINE_PLACEHOLDER_RE = /\{\{(inputFile|outputFile|arg:([a-zA-Z0-9._-]+))\}\}/g;

/**
 * Expands a user-configured trusted profile arg template array into a safe argv array.
 * Each template item can be:
 * - A static flag/token authored by the user in Electron settings (no NUL/newlines).
 * - An exact placeholder `{{inputFile}}`, `{{outputFile}}`, or `{{arg:key}}`.
 * - A flag=value form like `--strength={{arg:strength}}`.
 */
export function buildSafeBridgeArgv(
  argTemplate: readonly string[],
  ctx: BridgeArgTemplateContext,
): string[] {
  if (!Array.isArray(argTemplate) || argTemplate.length > 32) {
    throw new Error('Bridge profile argTemplate must contain at most 32 tokens.');
  }
  const specMap = new Map<string, PluginBridgeArgSpec>();
  for (const s of ctx.argSpecs ?? []) specMap.set(s.key, s);

  // Reject undeclared argument keys when argSpecs is provided
  if (ctx.argSpecs && ctx.argSpecs.length > 0) {
    for (const key of Object.keys(ctx.args)) {
      if (!specMap.has(key)) {
        throw new Error(`Undeclared bridge argument "${key}".`);
      }
    }
  }

  const resolved: string[] = [];
  for (const token of argTemplate) {
    if (typeof token !== 'string' || token.length > 256 || /[\u0000-\u001f\u007f]/.test(token)) {
      throw new Error('Bridge profile argTemplate contains an invalid token.');
    }

    const exact = PLACEHOLDER_RE.exec(token);
    if (exact) {
      const kind = exact[1];
      const argKey = exact[2];
      if (kind === 'inputFile') {
        if (!ctx.inputFile) throw new Error('Bridge profile expects an input file.');
        resolved.push(ctx.inputFile);
      } else if (kind === 'outputFile') {
        if (!ctx.outputFile) throw new Error('Bridge profile expects an output file.');
        resolved.push(ctx.outputFile);
      } else if (argKey) {
        const val = validateBridgeArgValue(argKey, ctx.args[argKey], specMap.get(argKey));
        resolved.push(val);
      }
      continue;
    }

    if (token.includes('{{')) {
      const expanded = token.replace(INLINE_PLACEHOLDER_RE, (_m, kind: string, argKey?: string) => {
        if (kind === 'inputFile') {
          if (!ctx.inputFile) throw new Error('Bridge profile expects an input file.');
          return ctx.inputFile;
        }
        if (kind === 'outputFile') {
          if (!ctx.outputFile) throw new Error('Bridge profile expects an output file.');
          return ctx.outputFile;
        }
        if (argKey) {
          return validateBridgeArgValue(argKey, ctx.args[argKey], specMap.get(argKey));
        }
        throw new Error(`Invalid placeholder in bridge argTemplate: ${token}`);
      });
      if (expanded.includes('{{') || expanded.includes('}}')) {
        throw new Error(`Unknown placeholder in bridge argTemplate: ${token}`);
      }
      resolved.push(expanded);
      continue;
    }

    resolved.push(token);
  }

  return resolved;
}

const SAFE_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
]);

export function sanitizeChildProcessEnv(
  sourceEnv: Record<string, string | undefined>,
  sandboxTempDir?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sourceEnv)) {
    if (typeof v !== 'string') continue;
    if (SAFE_ENV_KEYS.has(k)) {
      out[k] = v;
    }
  }
  if (sandboxTempDir) {
    out.TEMP = sandboxTempDir;
    out.TMP = sandboxTempDir;
    out.TMPDIR = sandboxTempDir;
  }
  return out;
}

export interface McpHttpHeaderCheckResult {
  ok: boolean;
  statusCode?: 401 | 403;
  error?: string;
}

/**
 * Guards the local 127.0.0.1 MCP HTTP endpoint against:
 * 1. DNS Rebinding (Host header must strictly match 127.0.0.1:<port> or localhost:<port>)
 * 2. Cross-origin browser CSRF (any non-empty Origin header is rejected)
 * 3. Missing Bearer token (exact timing-safe comparison is performed by caller)
 */
export function validateMcpHttpHeaders(
  headers: Record<string, string | string[] | undefined>,
  expectedPort: number,
): { ok: true; bearerToken: string } | { ok: false; statusCode: 401 | 403; error: string } {
  const rawHost = Array.isArray(headers.host) ? headers.host[0] : headers.host;
  const allowedHosts = new Set([
    `127.0.0.1:${expectedPort}`,
    `localhost:${expectedPort}`,
    `[::1]:${expectedPort}`,
  ]);
  if (!rawHost || !allowedHosts.has(rawHost.trim().toLowerCase())) {
    return {
      ok: false,
      statusCode: 403,
      error: 'Forbidden: invalid Host header (DNS rebinding guard).',
    };
  }

  const rawOrigin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
  if (rawOrigin && rawOrigin.trim().length > 0) {
    return {
      ok: false,
      statusCode: 403,
      error: 'Forbidden: cross-origin browser requests are blocked.',
    };
  }

  const rawAuth = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  if (!rawAuth || !rawAuth.startsWith('Bearer ')) {
    return {
      ok: false,
      statusCode: 401,
      error: 'Unauthorized: Bearer token is required.',
    };
  }

  const token = rawAuth.slice('Bearer '.length).trim();
  if (!token || token.length < 16 || token.length > 256 || /[\s\u0000-\u001f\u007f]/.test(token)) {
    return {
      ok: false,
      statusCode: 401,
      error: 'Unauthorized: malformed Bearer token.',
    };
  }

  return { ok: true, bearerToken: token };
}

/**
 * Validates that an MCP client HTTP endpoint strictly targets loopback (127.0.0.1 / localhost).
 * Blocks external internet URLs, LAN IPs, credentials-in-URL, and non-HTTP schemes.
 */
export function validateLoopbackMcpUrl(rawUrl: string): URL {
  if (typeof rawUrl !== 'string' || !rawUrl.trim() || rawUrl.length > 512) {
    throw new Error('MCP endpoint URL is required and must be <= 512 characters.');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid MCP endpoint URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('MCP endpoint URL must use http:// or https://.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('MCP endpoint URL cannot contain embedded credentials.');
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
    throw new Error('MCP client endpoints are restricted to local loopback (127.0.0.1 / localhost) only.');
  }
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid MCP endpoint port.');
  }
  return parsed;
}

export const MCP_CANVAS_READ_TOOLS = [
  'canvas.get_info',
  'layers.list',
  'pixels.get_bounds',
  'pixels.read_region',
  'timeline.get_state',
  'keyframes.list',
] as const;

export const MCP_CANVAS_WRITE_TOOLS = [
  'layers.create',
  'layers.update',
  'pixels.fill_rect',
  'timeline.set_frame',
  'keyframes.set',
] as const;

export type McpCanvasReadTool = (typeof MCP_CANVAS_READ_TOOLS)[number];
export type McpCanvasWriteTool = (typeof MCP_CANVAS_WRITE_TOOLS)[number];
export type McpCanvasToolName = McpCanvasReadTool | McpCanvasWriteTool;

export function isMcpCanvasWriteTool(name: string): name is McpCanvasWriteTool {
  return (MCP_CANVAS_WRITE_TOOLS as readonly string[]).includes(name);
}

export function assertMcpToolAllowed(toolName: string, allowWrite: boolean): void {
  const isRead = (MCP_CANVAS_READ_TOOLS as readonly string[]).includes(toolName);
  const isWrite = isMcpCanvasWriteTool(toolName);
  if (!isRead && !isWrite) {
    throw new Error(`Unknown MCP canvas tool: ${toolName}`);
  }
  if (isWrite && !allowWrite) {
    throw new Error(`MCP server is in read-only mode; write tool "${toolName}" is blocked.`);
  }
}

/**
 * Guard verifying that no MCP or plugin patch can ever touch brush stabilizer settings.
 */
export function assertNoStabilizerMutation(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const obj = payload as Record<string, unknown>;
  if ('stabilizerLevel' in obj || 'stabilizer' in obj || 'stabilizerMode' in obj) {
    throw new Error('Stabilizer algorithm and settings are immutable and cannot be modified by plugins or MCP.');
  }
}
