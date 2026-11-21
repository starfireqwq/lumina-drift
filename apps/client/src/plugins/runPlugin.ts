import PluginWorker from './plugin.worker?worker&inline';
import type { PluginWorkerInbound, PluginWorkerOutbound } from './plugin.worker';
import {
  PLUGIN_LIMITS,
  parsePluginAction,
  type PluginAction,
  type PluginContext,
  type PluginManifest,
  type PluginManifestV2,
} from './pluginApi';
import {
  createGuardedRpcDispatcher,
  detectPluginMemoryLimitBytes,
  type PluginExecutionHandle,
  type PluginHostRunOptions,
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
  manifest: PluginManifestV2,
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
  manifest: PluginManifestV2,
  commandId: string,
  context: PluginContext,
  handler: PluginRpcHandler,
  options?: PluginHostRunOptions,
): PluginExecutionHandle<PluginV2Result> {
  return startPluginV2Worker(manifest, { kind: 'command', commandId }, context, handler, options);
}

export function startPluginPanelActionV2(
  manifest: PluginManifestV2,
  panelId: string,
  actionId: string,
  values: Record<string, unknown>,
  context: PluginContext,
  handler: PluginRpcHandler,
  options?: PluginHostRunOptions,
): PluginExecutionHandle<PluginV2Result> {
  return startPluginV2Worker(manifest, { kind: 'panel', panelId, actionId, values }, context, handler, options);
}
