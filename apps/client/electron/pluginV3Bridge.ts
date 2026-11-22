import { app, dialog, type BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

/**
 * Electron Main-Process security boundary for Plugin API v3.0:
 * - Trusted Local Tool Profiles (bound via native file dialog + SHA-256 verification)
 * - Shell-free child execution (shell: false) inside disposable temp sandbox dirs
 * - Hard size/time limits & immediate kill-switch across all active runs
 * - Loopback-only local MCP Client (127.0.0.1 / localhost HTTP JSON-RPC 2.0)
 */

export interface TrustedBridgeToolProfile {
  id: string;
  label: string;
  executablePath: string;
  sha256: string;
  argTemplate: string[];
  expectsOutputFile: boolean;
  timeoutMs: number;
  createdAt: number;
}

export interface TrustedMcpClientProfile {
  id: string;
  label: string;
  endpointUrl: string;
  bearerToken?: string;
  createdAt: number;
}

interface PluginV3StoreData {
  tools: TrustedBridgeToolProfile[];
  mcpClients: TrustedMcpClientProfile[];
}

export interface BridgeInvokeRequest {
  runId?: string;
  toolId: string;
  args?: Record<string, unknown>;
  stdinText?: string;
  inputFileName?: string;
  inputBytes?: Uint8Array;
  outputFileName?: string;
  timeoutMs?: number;
}

export interface BridgeInvokeResult {
  ok: boolean;
  runId: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  outputBytes?: Uint8Array;
  durationMs: number;
  error?: string;
}

const STORE_FILE = 'plugin-v3-profiles.json';
const MAX_PROFILES = 32;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 60000;
const MAX_MCP_RESPONSE_BYTES = 4 * 1024 * 1024;

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SHELL_META_RE = /[\u0000-\u001f\u007f;&|`$<>()[\]{}*?!~^"'\\]/;
const WINDOWS_RESERVED_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const PLACEHOLDER_RE = /^\{\{(inputFile|outputFile|arg:([a-zA-Z0-9._-]+))\}\}$/;
const INLINE_PLACEHOLDER_RE = /\{\{(inputFile|outputFile|arg:([a-zA-Z0-9._-]+))\}\}/g;

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

function assertSafeExecutablePath(exePath: string): string {
  if (typeof exePath !== 'string' || !exePath.trim()) {
    throw new Error('Executable path is required.');
  }
  if (/[\u0000-\u001f\u007f]/.test(exePath)) {
    throw new Error('Executable path contains illegal control characters.');
  }
  const resolved = path.resolve(exePath.trim());
  const base = path.basename(resolved).toLowerCase();
  if (!base || BLOCKED_SHELL_EXECUTABLES.has(base)) {
    throw new Error(`Shell or script host executable "${base}" is not permitted.`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error('Selected executable path must be a regular file.');
  }
  return fs.realpathSync(resolved);
}

function computeFileSha256(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function validateFlatFileName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('File name must be a string.');
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 120) throw new Error('File name must be 1..120 characters.');
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('..')) {
    throw new Error('Path traversal is not allowed.');
  }
  if (/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error('Illegal characters in file name.');
  }
  if (WINDOWS_RESERVED_DEVICE_RE.test(trimmed)) {
    throw new Error('Reserved OS device name is not allowed.');
  }
  return trimmed;
}

function isInsideRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sanitizeArgValue(key: string, raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  const str =
    typeof raw === 'string'
      ? raw
      : typeof raw === 'number' && Number.isFinite(raw)
        ? String(raw)
        : typeof raw === 'boolean'
          ? (raw ? 'true' : 'false')
          : null;
  if (str === null) throw new Error(`Bridge argument "${key}" must be a primitive scalar.`);
  if (str.length > 256) throw new Error(`Bridge argument "${key}" exceeds max length.`);
  if (SHELL_META_RE.test(str)) {
    throw new Error(`Bridge argument "${key}" contains disallowed shell/control characters.`);
  }
  if (str.includes('..') || str.includes('/')) {
    throw new Error(`Bridge argument "${key}" cannot contain path separators or traversal.`);
  }
  if (str.startsWith('-')) {
    throw new Error(`Bridge argument "${key}" cannot start with "-" (argument injection guard).`);
  }
  return str;
}

function expandArgTemplate(
  template: readonly string[],
  ctx: { inputFile?: string; outputFile?: string; args: Record<string, unknown> },
): string[] {
  if (!Array.isArray(template) || template.length > 32) {
    throw new Error('Invalid profile argTemplate.');
  }
  const out: string[] = [];
  for (const token of template) {
    if (typeof token !== 'string' || token.length > 256 || /[\u0000-\u001f\u007f]/.test(token)) {
      throw new Error('Invalid token in profile argTemplate.');
    }
    const exact = PLACEHOLDER_RE.exec(token);
    if (exact) {
      const kind = exact[1];
      const argKey = exact[2];
      if (kind === 'inputFile') {
        if (!ctx.inputFile) throw new Error('Input file required by profile.');
        out.push(ctx.inputFile);
      } else if (kind === 'outputFile') {
        if (!ctx.outputFile) throw new Error('Output file required by profile.');
        out.push(ctx.outputFile);
      } else if (argKey) {
        out.push(sanitizeArgValue(argKey, ctx.args[argKey]));
      }
      continue;
    }
    if (token.includes('{{')) {
      const expanded = token.replace(INLINE_PLACEHOLDER_RE, (_m, kind: string, argKey?: string) => {
        if (kind === 'inputFile') {
          if (!ctx.inputFile) throw new Error('Input file required by profile.');
          return ctx.inputFile;
        }
        if (kind === 'outputFile') {
          if (!ctx.outputFile) throw new Error('Output file required by profile.');
          return ctx.outputFile;
        }
        if (argKey) return sanitizeArgValue(argKey, ctx.args[argKey]);
        throw new Error(`Invalid placeholder in argTemplate: ${token}`);
      });
      if (expanded.includes('{{') || expanded.includes('}}')) {
        throw new Error(`Unknown placeholder in argTemplate: ${token}`);
      }
      out.push(expanded);
      continue;
    }
    out.push(token);
  }
  return out;
}

function sanitizeEnv(sandboxDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && SAFE_ENV_KEYS.has(k)) {
      out[k] = v;
    }
  }
  out.TEMP = sandboxDir;
  out.TMP = sandboxDir;
  out.TMPDIR = sandboxDir;
  return out;
}

function validateLoopbackUrl(rawUrl: string): URL {
  if (typeof rawUrl !== 'string' || !rawUrl.trim() || rawUrl.length > 512) {
    throw new Error('MCP endpoint URL is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid MCP endpoint URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('MCP endpoint must use http:// or https://.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('MCP endpoint URL cannot include embedded credentials.');
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
    throw new Error('MCP client endpoints are restricted to local loopback (127.0.0.1 / localhost).');
  }
  return parsed;
}

function terminateChildTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      proc.kill('SIGKILL');
    }
  } catch {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }
}

export class PluginV3BridgeManager {
  private activeRuns = new Map<string, { abort: (reason?: string) => void }>();

  private getStorePath(): string {
    return path.join(app.getPath('userData'), STORE_FILE);
  }

  private readStore(): PluginV3StoreData {
    try {
      const storePath = this.getStorePath();
      if (!fs.existsSync(storePath)) return { tools: [], mcpClients: [] };
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Partial<PluginV3StoreData>;
      const tools = Array.isArray(parsed.tools) ? parsed.tools.slice(0, MAX_PROFILES) : [];
      const mcpClients = Array.isArray(parsed.mcpClients) ? parsed.mcpClients.slice(0, MAX_PROFILES) : [];
      return { tools, mcpClients };
    } catch {
      return { tools: [], mcpClients: [] };
    }
  }

  private writeStore(data: PluginV3StoreData): void {
    const storePath = this.getStorePath();
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  listProfiles(): {
    tools: TrustedBridgeToolProfile[];
    mcpClients: Array<Omit<TrustedMcpClientProfile, 'bearerToken'> & { hasToken: boolean }>;
  } {
    const store = this.readStore();
    return {
      tools: store.tools,
      mcpClients: store.mcpClients.map((c) => ({
        id: c.id,
        label: c.label,
        endpointUrl: c.endpointUrl,
        hasToken: Boolean(c.bearerToken),
        createdAt: c.createdAt,
      })),
    };
  }

  async pickExecutable(mainWindow: BrowserWindow): Promise<{
    canceled: boolean;
    executablePath?: string;
    sha256?: string;
    error?: string;
  }> {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Trusted Local Executable',
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    try {
      const safePath = assertSafeExecutablePath(result.filePaths[0]);
      const sha256 = computeFileSha256(safePath);
      return { canceled: false, executablePath: safePath, sha256 };
    } catch (err) {
      return {
        canceled: true,
        error: err instanceof Error ? err.message : 'Invalid executable.',
      };
    }
  }

  saveToolProfile(input: {
    id: string;
    label: string;
    executablePath: string;
    argTemplate?: string[];
    expectsOutputFile?: boolean;
    timeoutMs?: number;
  }): TrustedBridgeToolProfile {
    if (typeof input.id !== 'string' || !ID_RE.test(input.id.trim())) {
      throw new Error('Tool profile ID must match [a-zA-Z0-9._-].');
    }
    const id = input.id.trim();
    const labelText = typeof input.label === 'string' && input.label.trim()
      ? input.label.trim().slice(0, 60)
      : id;
    const safeExe = assertSafeExecutablePath(input.executablePath);
    const sha256 = computeFileSha256(safeExe);

    const rawTemplate = Array.isArray(input.argTemplate) ? input.argTemplate : [];
    if (rawTemplate.length > 32) throw new Error('argTemplate exceeds 32 tokens.');
    const argTemplate = rawTemplate.map((t) => {
      if (typeof t !== 'string' || t.length > 256 || /[\u0000-\u001f\u007f]/.test(t)) {
        throw new Error('Invalid token in argTemplate.');
      }
      return t;
    });

    const timeoutMs =
      typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
        ? Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.round(input.timeoutMs)))
        : DEFAULT_TIMEOUT_MS;

    const store = this.readStore();
    const filtered = store.tools.filter((t) => t.id !== id);
    if (filtered.length >= MAX_PROFILES) {
      throw new Error(`At most ${MAX_PROFILES} local tool profiles can be saved.`);
    }
    const profile: TrustedBridgeToolProfile = {
      id,
      label: labelText,
      executablePath: safeExe,
      sha256,
      argTemplate,
      expectsOutputFile: Boolean(input.expectsOutputFile),
      timeoutMs,
      createdAt: Date.now(),
    };
    store.tools = [...filtered, profile];
    this.writeStore(store);
    return profile;
  }

  removeToolProfile(id: string): boolean {
    const store = this.readStore();
    const before = store.tools.length;
    store.tools = store.tools.filter((t) => t.id !== id);
    if (store.tools.length !== before) {
      this.writeStore(store);
      return true;
    }
    return false;
  }

  saveMcpClientProfile(input: {
    id: string;
    label: string;
    endpointUrl: string;
    bearerToken?: string;
  }): { id: string; label: string; endpointUrl: string; hasToken: boolean; createdAt: number } {
    if (typeof input.id !== 'string' || !ID_RE.test(input.id.trim())) {
      throw new Error('MCP server ID must match [a-zA-Z0-9._-].');
    }
    const id = input.id.trim();
    const labelText = typeof input.label === 'string' && input.label.trim()
      ? input.label.trim().slice(0, 60)
      : id;
    const parsedUrl = validateLoopbackUrl(input.endpointUrl);
    const bearerToken =
      typeof input.bearerToken === 'string' && input.bearerToken.trim()
        ? input.bearerToken.trim().slice(0, 512)
        : undefined;

    const store = this.readStore();
    const filtered = store.mcpClients.filter((c) => c.id !== id);
    if (filtered.length >= MAX_PROFILES) {
      throw new Error(`At most ${MAX_PROFILES} MCP client profiles can be saved.`);
    }
    const profile: TrustedMcpClientProfile = {
      id,
      label: labelText,
      endpointUrl: parsedUrl.toString(),
      ...(bearerToken ? { bearerToken } : {}),
      createdAt: Date.now(),
    };
    store.mcpClients = [...filtered, profile];
    this.writeStore(store);
    return {
      id: profile.id,
      label: profile.label,
      endpointUrl: profile.endpointUrl,
      hasToken: Boolean(profile.bearerToken),
      createdAt: profile.createdAt,
    };
  }

  removeMcpClientProfile(id: string): boolean {
    const store = this.readStore();
    const before = store.mcpClients.length;
    store.mcpClients = store.mcpClients.filter((c) => c.id !== id);
    if (store.mcpClients.length !== before) {
      this.writeStore(store);
      return true;
    }
    return false;
  }

  getActiveRunCount(): number {
    return this.activeRuns.size;
  }

  abortRun(runId: string, reason = 'Aborted by user.'): boolean {
    const entry = this.activeRuns.get(runId);
    if (!entry) return false;
    entry.abort(reason);
    return true;
  }

  killAll(reason = 'Stopped by emergency kill switch.'): number {
    const count = this.activeRuns.size;
    for (const entry of this.activeRuns.values()) {
      entry.abort(reason);
    }
    this.activeRuns.clear();
    return count;
  }

  async invokeLocalTool(req: BridgeInvokeRequest): Promise<BridgeInvokeResult> {
    const startMs = Date.now();
    const runId = typeof req.runId === 'string' && req.runId.trim()
      ? req.runId.trim().slice(0, 64)
      : crypto.randomUUID();

    const store = this.readStore();
    const profile = store.tools.find((t) => t.id === req.toolId);
    if (!profile) {
      return {
        ok: false,
        runId,
        durationMs: Date.now() - startMs,
        error: `Trusted local tool profile "${req.toolId}" is not bound in Desktop Bridge settings.`,
      };
    }

    let safeExe: string;
    try {
      safeExe = assertSafeExecutablePath(profile.executablePath);
      const currentHash = computeFileSha256(safeExe);
      if (currentHash !== profile.sha256) {
        return {
          ok: false,
          runId,
          durationMs: Date.now() - startMs,
          error: 'Executable SHA-256 changed since binding. Re-bind this tool in Desktop Bridge settings.',
        };
      }
    } catch (err) {
      return {
        ok: false,
        runId,
        durationMs: Date.now() - startMs,
        error: err instanceof Error ? err.message : 'Executable validation failed.',
      };
    }

    if (req.inputBytes && req.inputBytes.byteLength > MAX_INPUT_BYTES) {
      return {
        ok: false,
        runId,
        durationMs: Date.now() - startMs,
        error: `Input payload exceeds ${Math.round(MAX_INPUT_BYTES / (1024 * 1024))} MiB limit.`,
      };
    }
    if (typeof req.stdinText === 'string' && Buffer.byteLength(req.stdinText, 'utf8') > MAX_INPUT_BYTES) {
      return {
        ok: false,
        runId,
        durationMs: Date.now() - startMs,
        error: 'stdinText exceeds maximum allowed size.',
      };
    }

    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-v3-bridge-'));
    const realSandboxRoot = fs.realpathSync(sandboxRoot);

    const cleanupSandbox = () => {
      try {
        fs.rmSync(realSandboxRoot, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    };

    try {
      let inputFilePath: string | undefined;
      if (req.inputBytes && req.inputBytes.byteLength > 0) {
        const safeInName = validateFlatFileName(req.inputFileName ?? 'input.bin');
        const targetIn = path.resolve(realSandboxRoot, safeInName);
        if (!isInsideRoot(targetIn, realSandboxRoot)) {
          throw new Error('Input path escaped sandbox root.');
        }
        fs.writeFileSync(
          targetIn,
          Buffer.from(req.inputBytes.buffer, req.inputBytes.byteOffset, req.inputBytes.byteLength),
        );
        inputFilePath = targetIn;
      }

      let outputFilePath: string | undefined;
      if (profile.expectsOutputFile || req.outputFileName) {
        const safeOutName = validateFlatFileName(req.outputFileName ?? 'output.bin');
        const targetOut = path.resolve(realSandboxRoot, safeOutName);
        if (!isInsideRoot(targetOut, realSandboxRoot)) {
          throw new Error('Output path escaped sandbox root.');
        }
        outputFilePath = targetOut;
      }

      const argv = expandArgTemplate(profile.argTemplate, {
        inputFile: inputFilePath,
        outputFile: outputFilePath,
        args: (req.args && typeof req.args === 'object' ? req.args : {}) as Record<string, unknown>,
      });

      const timeoutMs = Math.max(
        1000,
        Math.min(
          MAX_TIMEOUT_MS,
          typeof req.timeoutMs === 'number' && Number.isFinite(req.timeoutMs)
            ? Math.round(req.timeoutMs)
            : profile.timeoutMs,
        ),
      );

      return await new Promise<BridgeInvokeResult>((resolve) => {
        let settled = false;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        const proc = spawn(safeExe, argv, {
          shell: false,
          cwd: realSandboxRoot,
          env: sanitizeEnv(realSandboxRoot),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const finish = (result: BridgeInvokeResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.activeRuns.delete(runId);
          cleanupSandbox();
          resolve(result);
        };

        const abort = (reason = 'Aborted by user.') => {
          if (settled) return;
          terminateChildTree(proc);
          finish({
            ok: false,
            runId,
            durationMs: Date.now() - startMs,
            error: reason,
          });
        };

        this.activeRuns.set(runId, { abort });

        const timer = setTimeout(() => {
          abort(`Local tool timed out after ${timeoutMs} ms.`);
        }, timeoutMs);

        proc.stdout?.on('data', (chunk: Buffer) => {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > MAX_STDOUT_BYTES) {
            abort('Local tool stdout exceeded 2 MiB limit.');
            return;
          }
          stdoutChunks.push(chunk);
        });

        proc.stderr?.on('data', (chunk: Buffer) => {
          stderrBytes += chunk.byteLength;
          if (stderrBytes <= MAX_STDERR_BYTES) {
            stderrChunks.push(chunk);
          }
        });

        proc.on('error', (err) => {
          finish({
            ok: false,
            runId,
            durationMs: Date.now() - startMs,
            error: err.message,
          });
        });

        proc.on('close', (code) => {
          if (settled) return;
          const stdout = Buffer.concat(stdoutChunks).toString('utf8');
          const stderr = Buffer.concat(stderrChunks).toString('utf8');
          let outputBytes: Uint8Array | undefined;

          if (outputFilePath && fs.existsSync(outputFilePath)) {
            try {
              const realOut = fs.realpathSync(outputFilePath);
              if (!isInsideRoot(realOut, realSandboxRoot)) {
                finish({
                  ok: false,
                  runId,
                  exitCode: code,
                  durationMs: Date.now() - startMs,
                  error: 'Output file symlink escape blocked.',
                });
                return;
              }
              const stat = fs.statSync(realOut);
              if (!stat.isFile() || stat.size > MAX_OUTPUT_BYTES) {
                finish({
                  ok: false,
                  runId,
                  exitCode: code,
                  durationMs: Date.now() - startMs,
                  error: `Output file invalid or exceeds ${Math.round(MAX_OUTPUT_BYTES / (1024 * 1024))} MiB limit.`,
                });
                return;
              }
              const buf = fs.readFileSync(realOut);
              outputBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice();
            } catch (err) {
              finish({
                ok: false,
                runId,
                exitCode: code,
                durationMs: Date.now() - startMs,
                error: err instanceof Error ? err.message : 'Failed to read output file.',
              });
              return;
            }
          }

          finish({
            ok: code === 0,
            runId,
            exitCode: code,
            stdout,
            stderr,
            ...(outputBytes ? { outputBytes } : {}),
            durationMs: Date.now() - startMs,
            ...(code !== 0 ? { error: stderr.trim() || `Process exited with code ${String(code)}.` } : {}),
          });
        });

        if (proc.stdin) {
          if (typeof req.stdinText === 'string') {
            proc.stdin.write(req.stdinText, 'utf8');
          }
          proc.stdin.end();
        }
      });
    } catch (err) {
      cleanupSandbox();
      return {
        ok: false,
        runId,
        durationMs: Date.now() - startMs,
        error: err instanceof Error ? err.message : 'Bridge invocation failed.',
      };
    }
  }

  async callLocalMcpJsonRpc(
    serverId: string,
    rpcMethod: string,
    rpcParams?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const store = this.readStore();
    const profile = store.mcpClients.find((c) => c.id === serverId);
    if (!profile) {
      return { ok: false, error: `Local MCP server "${serverId}" is not registered.` };
    }
    let parsedUrl: URL;
    try {
      parsedUrl = validateLoopbackUrl(profile.endpointUrl);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Invalid MCP endpoint.' };
    }

    const runId = `mcp-${crypto.randomUUID()}`;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: rpcMethod,
      params: rpcParams ?? {},
    });

    const clampedTimeout = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.round(timeoutMs)));
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (res: { ok: boolean; result?: unknown; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeRuns.delete(runId);
        resolve(res);
      };

      const req = transport.request(
        {
          protocol: parsedUrl.protocol,
          hostname: parsedUrl.hostname,
          port: parsedUrl.port ? Number(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body, 'utf8'),
            ...(profile.bearerToken ? { Authorization: `Bearer ${profile.bearerToken}` } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > MAX_MCP_RESPONSE_BYTES) {
              req.destroy();
              finish({ ok: false, error: 'MCP response exceeded 4 MiB limit.' });
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
              finish({ ok: false, error: `MCP HTTP ${res.statusCode}: ${raw.slice(0, 240)}` });
              return;
            }
            try {
              const parsed = JSON.parse(raw) as { result?: unknown; error?: { message?: string } };
              if (parsed.error) {
                finish({ ok: false, error: parsed.error.message || 'MCP server returned an error.' });
                return;
              }
              finish({ ok: true, result: parsed.result });
            } catch {
              finish({ ok: false, error: 'Invalid JSON response from MCP server.' });
            }
          });
        },
      );

      this.activeRuns.set(runId, {
        abort: (reason) => {
          req.destroy();
          finish({ ok: false, error: reason || 'MCP call aborted.' });
        },
      });

      const timer = setTimeout(() => {
        req.destroy();
        finish({ ok: false, error: `MCP call timed out after ${clampedTimeout} ms.` });
      }, clampedTimeout);

      req.on('error', (err) => {
        finish({ ok: false, error: err.message });
      });

      req.write(body, 'utf8');
      req.end();
    });
  }
}
