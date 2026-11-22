import PluginWorker from './plugin.worker?worker&inline';
import type { PluginWorkerInbound, PluginWorkerOutbound } from './plugin.worker';
import {
  PLUGIN_LIMITS,
  parsePluginAction,
  type PluginAction,
  type PluginContext,
  type PluginManifest,
  type PluginManifestModern,
  type PluginPointerEvent,
  type PluginPointerPhase,
} from './pluginApi';
import {
  assertPluginToolAllowed,
  createGuardedRpcDispatcher,
  detectPluginMemoryLimitBytes,
  type PluginExecutionHandle,
  type PluginHostRunOptions,
  type PluginToolSessionHandle,
  type PluginToolSessionOptions,
} from './pluginHost';
import { parsePluginV2Result, type PluginRpcHandler, type PluginRpcMethod, type PluginV2Result } from './pluginRpc';
import type { RunV2Entry } from './pluginSandboxCore';

/**
 * Legacy v1 synchronous runner (100% backward compatible).
 */
export function runPlugin(plugin: PluginManifest, command: string, context: PluginContext): Promise<PluginAction> {
  return new Promise((resolve, reject) => {
    const worker = new PluginWorker();
    const finish = () => {
      clearTimeout(timeout);
      worker.terminate();
    };
    const timeout = setTimeout(() => {
      finish();
      reject(new Error('Plugin execution timed out.'));
    }, 4000);
    worker.onmessage = (event: MessageEvent<PluginWorkerOutbound>) => {
      finish();
      try {
        const data = event.data;
        if (!data || data.type !== 'result-v1' || data.ok !== true) {
          throw new Error((data && 'error' in data && data.error) || 'Plugin failed.');
        }
        resolve(parsePluginAction(data.value, plugin));
      } catch (error) {
        reject(error);
      }
    };
    worker.onerror = () => {
      finish();
      reject(new Error('Plugin runtime could not start.'));
    };
    worker.postMessage({ type: 'run-v1', script: plugin.script, command, context } satisfies PluginWorkerInbound);
  });
}

function startPluginV2Worker(
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
  const worker = new PluginWorker();
  let finished = false;

  let resolveOuter!: (value: PluginV2Result) => void;
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
    worker.terminate();
  };

  const abort = (reason = 'Plugin execution aborted.') => {
    if (finished) return;
    finished = true;
    try {
      worker.postMessage({ type: 'abort', reason } satisfies PluginWorkerInbound);
    } catch {
      // ignore if worker already dead
    }
    cleanup();
    rejectOuter(new Error(reason));
  };

  const onExternalAbort = () => abort('Plugin execution aborted.');
  if (options?.signal) {
    if (options.signal.aborted) {
      abort('Plugin execution aborted.');
      return { promise, abort };
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const wallTimer = setTimeout(() => {
    abort('Plugin execution timed out.');
  }, wallLimitMs);

  worker.onmessage = (event: MessageEvent<PluginWorkerOutbound>) => {
    if (finished) return;
    const data = event.data;
    if (!data) return;

    if (data.type === 'rpc-req') {
      void dispatch({
        id: data.id,
        method: data.method as PluginRpcMethod,
        params: data.params,
        ...(data.buffer ? { buffer: data.buffer } : {}),
      }).then((response) => {
        if (finished) return;
        const transfer: Transferable[] = response.ok && response.buffer ? [response.buffer] : [];
        worker.postMessage({ type: 'rpc-res', response } satisfies PluginWorkerInbound, transfer);
      });
      return;
    }

    if (data.type === 'result-v2') {
      finished = true;
      cleanup();
      if (!data.ok) {
        rejectOuter(new Error(data.error || 'Plugin failed.'));
        return;
      }
      try {
        resolveOuter(parsePluginV2Result(data.value));
      } catch (err) {
        rejectOuter(err instanceof Error ? err : new Error('Invalid plugin result.'));
      }
    }
  };

  worker.onerror = () => {
    if (finished) return;
    finished = true;
    cleanup();
    rejectOuter(new Error('Plugin runtime could not start.'));
  };

  worker.postMessage({
    type: 'run-v2',
    script: manifest.script,
    entry,
    context: { ...context, tileSize: context.tileSize ?? 256 },
    memoryLimitBytes,
    maxStackSizeBytes,
    cpuLimitMs,
  } satisfies PluginWorkerInbound);

  return { promise, abort };
}

export function startPluginCommandV2(
  manifest: PluginManifestModern,
  commandId: string,
  context: PluginContext,
  handler: PluginRpcHandler,
  options?: PluginHostRunOptions,
): PluginExecutionHandle<PluginV2Result> {
  return startPluginV2Worker(manifest, { kind: 'command', commandId }, context, handler, options);
}

export function startPluginPanelActionV2(
  manifest: PluginManifestModern,
  panelId: string,
  actionId: string,
  values: Record<string, unknown>,
  context: PluginContext,
  handler: PluginRpcHandler,
  options?: PluginHostRunOptions,
): PluginExecutionHandle<PluginV2Result> {
  return startPluginV2Worker(manifest, { kind: 'panel', panelId, actionId, values }, context, handler, options);
}

/**
 * Starts a dedicated Web Worker custom-tool pointer session with per-event and stroke-wide
 * timeouts and hard `worker.terminate()` isolation.
 */
export function startPluginToolSessionInWorker(
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
  const worker = new PluginWorker();
  let closed = false;
  let nextEventId = 1;

  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const pendingEvents = new Map<
    number,
    {
      resolve: (val: PluginV2Result) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const rejectAllPending = (reason: string) => {
    const err = new Error(reason);
    rejectReady(err);
    for (const entry of pendingEvents.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pendingEvents.clear();
  };

  const cleanup = () => {
    clearTimeout(strokeTimer);
    clearTimeout(readyTimer);
    worker.terminate();
  };

  const abort = (reason = 'Plugin tool aborted.') => {
    if (closed) return;
    closed = true;
    try {
      worker.postMessage({ type: 'abort', reason } satisfies PluginWorkerInbound);
    } catch {
      // ignore if worker already terminated
    }
    cleanup();
    rejectAllPending(reason);
  };

  const dispose = () => {
    if (closed) return;
    closed = true;
    try {
      worker.postMessage({ type: 'tool-end' } satisfies PluginWorkerInbound);
    } catch {
      // ignore
    }
    cleanup();
    rejectAllPending('Plugin tool session disposed.');
  };

  const readyTimer = setTimeout(() => {
    abort('Plugin tool initialization timed out.');
  }, eventWallLimitMs);

  const strokeTimer = setTimeout(() => {
    abort('Plugin tool stroke timed out.');
  }, strokeWallLimitMs);

  worker.onmessage = (event: MessageEvent<PluginWorkerOutbound>) => {
    if (closed) return;
    const data = event.data;
    if (!data) return;

    if (data.type === 'rpc-req') {
      void dispatch({
        id: data.id,
        method: data.method as PluginRpcMethod,
        params: data.params,
        ...(data.buffer ? { buffer: data.buffer } : {}),
      }).then((response) => {
        if (closed) return;
        const transfer: Transferable[] = response.ok && response.buffer ? [response.buffer] : [];
        worker.postMessage({ type: 'rpc-res', response } satisfies PluginWorkerInbound, transfer);
      });
      return;
    }

    if (data.type === 'tool-ready') {
      clearTimeout(readyTimer);
      if (data.ok) resolveReady();
      else abort(data.error || 'Plugin tool failed to initialize.');
      return;
    }

    if (data.type === 'tool-event-res') {
      const pending = pendingEvents.get(data.eventId);
      if (!pending) return;
      pendingEvents.delete(data.eventId);
      clearTimeout(pending.timer);
      if (!data.ok) {
        pending.reject(new Error(data.error || 'Plugin tool event failed.'));
        return;
      }
      try {
        pending.resolve(parsePluginV2Result(data.value));
      } catch (err) {
        pending.reject(err instanceof Error ? err : new Error('Invalid plugin tool result.'));
      }
    }
  };

  worker.onerror = () => {
    abort('Plugin tool worker crashed.');
  };

  worker.postMessage({
    type: 'tool-start',
    script: manifest.script,
    toolId,
    context: { ...context, tileSize: context.tileSize ?? 256 },
    memoryLimitBytes,
    maxStackSizeBytes,
    eventCpuLimitMs,
    strokeCpuLimitMs,
  } satisfies PluginWorkerInbound);

  const dispatchEvent = async (
    phase: PluginPointerPhase,
    pointerEvent: PluginPointerEvent,
  ): Promise<PluginV2Result> => {
    await readyPromise;
    if (closed) throw new Error('Plugin tool session is closed.');
    const eventId = nextEventId++;
    return new Promise<PluginV2Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingEvents.delete(eventId);
        const reason = 'Plugin tool event timed out.';
        abort(reason);
        reject(new Error(reason));
      }, eventWallLimitMs);
      pendingEvents.set(eventId, { resolve, reject, timer });
      worker.postMessage({
        type: 'tool-event',
        eventId,
        phase,
        event: pointerEvent,
      } satisfies PluginWorkerInbound);
    });
  };

  return { dispatchEvent, abort, dispose };
}
