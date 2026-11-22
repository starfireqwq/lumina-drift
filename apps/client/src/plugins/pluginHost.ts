import {
  PLUGIN_LIMITS,
  type PluginContext,
  type PluginManifestModern,
  type PluginPointerEvent,
  type PluginPointerPhase,
} from './pluginApi';
import {
  assertPluginRpcAllowed,
  parsePluginV2Result,
  PluginQuotaTracker,
  type PluginQuotaConfig,
  type PluginRpcHandler,
  type PluginRpcRequest,
  type PluginRpcResponse,
  type PluginV2Result,
} from './pluginRpc';
import { startPluginToolV2Session, startPluginV2Session, type RunV2Entry } from './pluginSandboxCore';

export interface PluginExecutionHandle<T> {
  promise: Promise<T>;
  abort: (reason?: string) => void;
}

export interface PluginHostRunOptions {
  wallLimitMs?: number;
  cpuLimitMs?: number;
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  quota?: PluginQuotaConfig;
  slowThresholdMs?: number;
  onSlowStart?: () => void;
  signal?: AbortSignal;
}

export function detectPluginMemoryLimitBytes(): number {
  if (typeof window !== 'undefined') {
    const isCoarsePointer =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    const isSmallScreen = window.innerWidth <= 900;
    if (isCoarsePointer || isSmallScreen) {
      return PLUGIN_LIMITS.memoryLimitMobileBytes;
    }
  }
  return PLUGIN_LIMITS.memoryLimitDesktopBytes;
}

/**
 * Shared RPC dispatcher enforcing host-side permission checks and resource quotas
 * before delegating to the canvas/selection/layer bridge.
 */
export function createGuardedRpcDispatcher(
  manifest: PluginManifestModern,
  handler: PluginRpcHandler,
  quotaConfig?: PluginQuotaConfig,
) {
  const quota = new PluginQuotaTracker(quotaConfig);

  const dispatch = async (req: PluginRpcRequest): Promise<PluginRpcResponse> => {
    try {
      assertPluginRpcAllowed(manifest, req.method, req.params);
      quota.consumeRpc();

      if (req.method === 'layers.create') {
        quota.consumeLayerCreation();
      }
      if ((req.method === 'pixels.write' || req.method === 'selection.writeMask') && req.buffer) {
        quota.consumePixelBytes(req.buffer.byteLength);
      }

      const { result, buffer } = await handler(req.method, req.params, req.buffer);

      if ((req.method === 'pixels.read' || req.method === 'pixels.readComposite' || req.method === 'selection.readMask') && buffer) {
        quota.consumePixelBytes(buffer.byteLength);
      }

      return {
        id: req.id,
        ok: true,
        result,
        ...(buffer ? { buffer } : {}),
      };
    } catch (error) {
      return {
        id: req.id,
        ok: false,
        error: error instanceof Error ? error.message : 'RPC failed.',
      };
    }
  };

  return { dispatch, quota };
}

/**
 * Runs a v2 plugin in-process via QuickJS WASM (used for deterministic unit tests and headless execution).
 * Browser runtime uses `startPluginV2InWorker` in `runPlugin.ts` for hard `worker.terminate()` isolation.
 */
export function startPluginV2Direct(
  manifest: PluginManifestModern,
  entry: RunV2Entry,
  context: PluginContext,
  handler: PluginRpcHandler,
  options?: PluginHostRunOptions,
): PluginExecutionHandle<PluginV2Result> {
  const wallLimitMs = options?.wallLimitMs ?? PLUGIN_LIMITS.commandWallLimitMs;
  const cpuLimitMs = options?.cpuLimitMs ?? PLUGIN_LIMITS.commandCpuLimitMs;
  const memoryLimitBytes = options?.memoryLimitBytes ?? detectPluginMemoryLimitBytes();
  const maxStackSizeBytes = options?.maxStackSizeBytes ?? PLUGIN_LIMITS.maxStackSizeBytes;
  const slowThresholdMs = options?.slowThresholdMs ?? 300;

  const { dispatch } = createGuardedRpcDispatcher(manifest, handler, options?.quota);
  let finished = false;
  let sessionRef: ReturnType<typeof startPluginV2Session> | null = null;

  let resolveOuter!: (res: PluginV2Result) => void;
  let rejectOuter!: (err: Error) => void;
  const promise = new Promise<PluginV2Result>((resolve, reject) => {
    resolveOuter = resolve;
    rejectOuter = reject;
  });

  const slowTimer = options?.onSlowStart
    ? setTimeout(() => {
        if (!finished) options.onSlowStart?.();
      }, slowThresholdMs)
    : null;

  const cleanup = () => {
    clearTimeout(wallTimer);
    if (slowTimer) clearTimeout(slowTimer);
    if (options?.signal) options.signal.removeEventListener('abort', onExternalAbort);
  };

  const abort = (reason = 'Plugin execution aborted.') => {
    if (finished) return;
    finished = true;
    cleanup();
    sessionRef?.abort(reason);
    rejectOuter(new Error(reason));
  };

  const onExternalAbort = () => abort('Plugin execution aborted.');
  if (options?.signal) {
    if (options.signal.aborted) {
      queueMicrotask(() => abort('Plugin execution aborted.'));
      return { promise, abort };
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const wallTimer = setTimeout(() => {
    abort('Plugin execution timed out.');
  }, wallLimitMs);

  const session = startPluginV2Session({
    script: manifest.script,
    entry,
    context: { ...context, tileSize: context.tileSize ?? 256 },
    memoryLimitBytes,
    maxStackSizeBytes,
    cpuLimitMs,
    sendRpc: (req) => {
      if (finished) return;
      void dispatch(req).then((res) => {
        if (!finished) session.deliverRpcResponse(res);
      });
    },
  });
  sessionRef = session;

  session.promise.then(
    ({ value }) => {
      if (finished) return;
      finished = true;
      cleanup();
      try {
        resolveOuter(parsePluginV2Result(value));
      } catch (err) {
        rejectOuter(err instanceof Error ? err : new Error('Invalid plugin result.'));
      }
    },
    (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      rejectOuter(err instanceof Error ? err : new Error('Plugin failed.'));
    },
  );

  return { promise, abort };
}

export interface PluginToolSessionOptions {
  eventWallLimitMs?: number;
  eventCpuLimitMs?: number;
  strokeWallLimitMs?: number;
  strokeCpuLimitMs?: number;
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  quota?: PluginQuotaConfig;
}

export interface PluginToolSessionHandle {
  dispatchEvent: (phase: PluginPointerPhase, event: PluginPointerEvent) => Promise<PluginV2Result>;
  abort: (reason?: string) => void;
  dispose: () => void;
}

export function assertPluginToolAllowed(manifest: PluginManifestModern, toolId: string): void {
  if (!manifest.permissions.includes('tools')) {
    throw new Error('Missing permission: tools');
  }
  if (!manifest.permissions.includes('input')) {
    throw new Error('Missing permission: input');
  }
  if (!(manifest.tools ?? []).some((t) => t.id === toolId)) {
    throw new Error(`Unknown plugin tool: ${toolId}`);
  }
}

/**
 * In-process custom-tool pointer session via QuickJS WASM (used for deterministic unit tests).
 * Browser runtime uses `startPluginToolSessionInWorker` in `runPlugin.ts` for hard `worker.terminate()`.
 */
export function startPluginToolDirect(
  manifest: PluginManifestModern,
  toolId: string,
  context: PluginContext,
  handler: PluginRpcHandler,
  options?: PluginToolSessionOptions,
): PluginToolSessionHandle {
  assertPluginToolAllowed(manifest, toolId);

  const eventWallLimitMs = options?.eventWallLimitMs ?? PLUGIN_LIMITS.toolEventWallLimitMs;
  const eventCpuLimitMs = options?.eventCpuLimitMs ?? PLUGIN_LIMITS.toolEventCpuLimitMs;
  const strokeWallLimitMs = options?.strokeWallLimitMs ?? PLUGIN_LIMITS.toolStrokeWallLimitMs;
  const strokeCpuLimitMs = options?.strokeCpuLimitMs ?? PLUGIN_LIMITS.toolStrokeCpuLimitMs;
  const memoryLimitBytes = options?.memoryLimitBytes ?? detectPluginMemoryLimitBytes();
  const maxStackSizeBytes = options?.maxStackSizeBytes ?? PLUGIN_LIMITS.maxStackSizeBytes;

  const { dispatch } = createGuardedRpcDispatcher(manifest, handler, options?.quota);
  let closed = false;

  const session = startPluginToolV2Session({
    script: manifest.script,
    toolId,
    context: { ...context, tileSize: context.tileSize ?? 256 },
    memoryLimitBytes,
    maxStackSizeBytes,
    eventCpuLimitMs,
    strokeCpuLimitMs,
    sendRpc: (req) => {
      if (closed) return;
      void dispatch(req).then((res) => {
        if (!closed) session.deliverRpcResponse(res);
      });
    },
  });

  const strokeTimer = setTimeout(() => {
    abort('Plugin tool stroke timed out.');
  }, strokeWallLimitMs);

  const cleanup = () => {
    clearTimeout(strokeTimer);
  };

  const abort = (reason = 'Plugin tool aborted.') => {
    if (closed) return;
    closed = true;
    cleanup();
    session.abort(reason);
  };

  const dispose = () => {
    if (closed) return;
    closed = true;
    cleanup();
    session.dispose();
  };

  const dispatchEvent = async (
    phase: PluginPointerPhase,
    event: PluginPointerEvent,
  ): Promise<PluginV2Result> => {
    if (closed) throw new Error('Plugin tool session is closed.');
    let eventTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await new Promise<{ value: unknown; cpuUsedMs: number }>((resolve, reject) => {
        eventTimer = setTimeout(() => {
          const reason = 'Plugin tool event timed out.';
          abort(reason);
          reject(new Error(reason));
        }, eventWallLimitMs);
        session.dispatchEvent(phase, event).then(resolve, reject);
      });
      return parsePluginV2Result(result.value);
    } finally {
      if (eventTimer) clearTimeout(eventTimer);
    }
  };

  return { dispatchEvent, abort, dispose };
}
