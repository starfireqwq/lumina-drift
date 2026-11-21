import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import { PLUGIN_LIMITS, type PluginContext } from './pluginApi';
import type { PluginRpcMethod, PluginRpcRequest, PluginRpcResponse } from './pluginRpc';

let cachedEnginePromise: Promise<QuickJSWASMModule> | null = null;

function getEngine(): Promise<QuickJSWASMModule> {
  if (!cachedEnginePromise) {
    cachedEnginePromise = newQuickJSWASMModuleFromVariant(variant);
  }
  return cachedEnginePromise;
}

export interface RunV1Options {
  script: string;
  command: string;
  context: PluginContext;
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  cpuLimitMs?: number;
}

export async function executePluginV1(options: RunV1Options): Promise<unknown> {
  const {
    script,
    command,
    context,
    memoryLimitBytes = 16 * 1024 * 1024,
    maxStackSizeBytes = 256 * 1024,
    cpuLimitMs = 500,
  } = options;

  const engine = await getEngine();
  const runtime = engine.newRuntime();
  try {
    runtime.setMemoryLimit(memoryLimitBytes);
    runtime.setMaxStackSize(maxStackSizeBytes);
    const deadline = performance.now() + cpuLimitMs;
    runtime.setInterruptHandler(() => performance.now() > deadline);
    const vm = runtime.newContext();
    try {
      const code = `(function () {
        "use strict";
        const serialize = JSON.stringify;
        const execute = function () {
          ${script}
          return run(${JSON.stringify(command)}, Object.freeze(${JSON.stringify(context)}));
        };
        return serialize(execute());
      })()`;
      const result = vm.evalCode(code, 'plugin.js', { type: 'global' });
      if (result.error) {
        result.error.dispose();
        throw new Error('Script failed or exceeded its execution limit.');
      }
      try {
        if (vm.typeof(result.value) !== 'string') throw new Error('A command must return one action.');
        const json = vm.getString(result.value);
        if (json.length > 192 * 1024) throw new Error('Plugin output is too large.');
        return JSON.parse(json);
      } finally {
        result.value.dispose();
      }
    } finally {
      vm.dispose();
    }
  } finally {
    runtime.dispose();
  }
}

export type RunV2Entry =
  | { kind: 'command'; commandId: string }
  | { kind: 'panel'; panelId: string; actionId: string; values: Record<string, unknown> };

export interface RunV2Options {
  script: string;
  entry: RunV2Entry;
  context: PluginContext;
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  cpuLimitMs?: number;
  sendRpc: (req: PluginRpcRequest) => void;
}

export interface RunningV2Session {
  promise: Promise<{ value: unknown; cpuUsedMs: number }>;
  deliverRpcResponse: (res: PluginRpcResponse) => void;
  abort: (reason?: string) => void;
}

const V2_API_BOOTSTRAP = `
const __toArrayBuffer = (bytes) => {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected Uint8Array for pixel/mask data.');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};
const __callRpc = (method, params, binary) =>
  __luminaRpc(method, JSON.stringify(params ?? null), binary).then((res) => {
    const parsed = res && typeof res.json === 'string' && res.json.length ? JSON.parse(res.json) : undefined;
    if (res && res.buffer instanceof ArrayBuffer) {
      if (parsed && typeof parsed === 'object') {
        parsed.data = new Uint8Array(res.buffer);
        return parsed;
      }
      return new Uint8Array(res.buffer);
    }
    return parsed;
  });

const __buildApi = (canvasCtx) => {
  const canvas = Object.freeze({
    width: canvasCtx.width,
    height: canvasCtx.height,
    dpi: canvasCtx.dpi,
    tileSize: canvasCtx.tileSize ?? 256,
  });
  const brush = Object.freeze({
    get: () => __callRpc('brush.get'),
    set: (opts) => __callRpc('brush.set', opts ?? {}),
  });
  const layers = Object.freeze({
    list: () => __callRpc('layers.list'),
    get: (layerId) => __callRpc('layers.get', { layerId }),
    getActive: () => __callRpc('layers.getActive'),
    create: (opts) => __callRpc('layers.create', opts ?? {}),
    update: (layerId, patch) => __callRpc('layers.update', { layerId, patch: patch ?? {} }),
    reorder: (layerId, opts) => __callRpc('layers.reorder', { layerId, ...(opts ?? {}) }),
    delete: (layerId) => __callRpc('layers.delete', { layerId }),
    setActive: (layerId) => __callRpc('layers.setActive', { layerId }),
  });
  const pixels = Object.freeze({
    getNonEmptyBounds: (layerId) => __callRpc('pixels.getNonEmptyBounds', { layerId }),
    read: (layerId, rect) => __callRpc('pixels.read', { layerId, rect }),
    readComposite: (rect, opts) => __callRpc('pixels.readComposite', { rect, opts: opts ?? {} }),
    write: (layerId, patch) => {
      if (!patch || typeof patch !== 'object') return Promise.reject(new TypeError('Expected patch object.'));
      const buf = __toArrayBuffer(patch.data);
      const { data: _ignored, ...rest } = patch;
      return __callRpc('pixels.write', { layerId, patch: rest }, buf);
    },
  });
  const selection = Object.freeze({
    getInfo: () => __callRpc('selection.getInfo'),
    readMask: (rect) => __callRpc('selection.readMask', { rect }),
    writeMask: (patch, mode) => {
      if (!patch || typeof patch !== 'object') return Promise.reject(new TypeError('Expected mask patch object.'));
      const buf = __toArrayBuffer(patch.data);
      const { data: _ignored, ...rest } = patch;
      return __callRpc('selection.writeMask', { patch: rest, mode }, buf);
    },
    selectRect: (rect, mode) => __callRpc('selection.selectRect', { rect, mode }),
    selectEllipse: (rect, mode) => __callRpc('selection.selectEllipse', { rect, mode }),
    selectPolygon: (points, mode) => __callRpc('selection.selectPolygon', { points, mode }),
    clear: () => __callRpc('selection.clear'),
    invert: () => __callRpc('selection.invert'),
    expand: (radius) => __callRpc('selection.expand', { radius }),
    contract: (radius) => __callRpc('selection.contract', { radius }),
    feather: (radius) => __callRpc('selection.feather', { radius }),
  });
  return Object.freeze({ canvas, brush, layers, pixels, selection });
};
`;

function formatVmError(vm: { dump: (handle: QuickJSHandle) => unknown }, errHandle: QuickJSHandle): string {
  try {
    const dumped = vm.dump(errHandle);
    if (typeof dumped === 'string') return dumped;
    if (dumped && typeof dumped === 'object') {
      const obj = dumped as { message?: unknown; name?: unknown };
      if (typeof obj.message === 'string' && obj.message.trim()) return obj.message;
      if (typeof obj.name === 'string' && obj.name.trim()) return obj.name;
    }
  } catch {
    // Fall back to generic message if error cannot be dumped
  }
  return 'Script failed or exceeded its execution limit.';
}

export function startPluginV2Session(options: RunV2Options): RunningV2Session {
  const {
    script,
    entry,
    context,
    memoryLimitBytes = PLUGIN_LIMITS.memoryLimitDesktopBytes,
    maxStackSizeBytes = PLUGIN_LIMITS.maxStackSizeBytes,
    cpuLimitMs = PLUGIN_LIMITS.commandCpuLimitMs,
    sendRpc,
  } = options;

  let settled = false;
  let aborted = false;
  let abortReason = 'Plugin execution aborted.';
  let cpuUsedMs = 0;
  let sliceStartMs: number | null = null;
  let nextRpcId = 1;
  let pendingOutcome: { ok: true; value: unknown } | { ok: false; error: Error } | null = null;

  let resolveSession!: (val: { value: unknown; cpuUsedMs: number }) => void;
  let rejectSession!: (err: Error) => void;
  const promise = new Promise<{ value: unknown; cpuUsedMs: number }>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });

  const pendingPromises = new Map<number, QuickJSDeferredPromise>();
  let cleanupRuntime: (() => void) | null = null;
  let vmRef: ReturnType<ReturnType<QuickJSWASMModule['newRuntime']>['newContext']> | null = null;
  let runtimeRef: ReturnType<QuickJSWASMModule['newRuntime']> | null = null;

  const beginCpuSlice = () => {
    sliceStartMs = performance.now();
  };

  const endCpuSlice = () => {
    if (sliceStartMs !== null) {
      cpuUsedMs += Math.max(0, performance.now() - sliceStartMs);
      sliceStartMs = null;
    }
  };

  const finishSuccess = (value: unknown) => {
    if (settled) return;
    settled = true;
    const used = cpuUsedMs;
    cleanupRuntime?.();
    resolveSession({ value, cpuUsedMs: used });
  };

  const finishError = (err: Error) => {
    if (settled) return;
    settled = true;
    cleanupRuntime?.();
    rejectSession(err);
  };

  const drainJobs = () => {
    if (settled || !runtimeRef || !vmRef) return;
    beginCpuSlice();
    try {
      while (!settled && !aborted && !pendingOutcome) {
        const jobResult = runtimeRef.executePendingJobs(16);
        if (jobResult.error) {
          const msg = formatVmError(vmRef, jobResult.error);
          jobResult.error.dispose();
          endCpuSlice();
          finishError(new Error(aborted ? abortReason : cpuUsedMs >= cpuLimitMs ? 'Plugin CPU time limit exceeded.' : msg));
          return;
        }
        const executed = jobResult.value;
        if (executed === 0) break;
      }
    } finally {
      endCpuSlice();
    }
    if (!settled && pendingOutcome) {
      const outcome = pendingOutcome;
      pendingOutcome = null;
      if (outcome.ok) finishSuccess(outcome.value);
      else finishError(outcome.error);
      return;
    }
    if (!settled && aborted) {
      finishError(new Error(abortReason));
      return;
    }
    if (!settled && pendingPromises.size === 0) {
      finishError(new Error('Plugin promise never settled.'));
    }
  };

  const deliverRpcResponse = (res: PluginRpcResponse) => {
    if (settled || !vmRef) return;
    const deferred = pendingPromises.get(res.id);
    if (!deferred) return;
    pendingPromises.delete(res.id);

    try {
      if (res.ok) {
        const obj = vmRef.newObject();
        const jsonStr = vmRef.newString(res.result === undefined ? '' : JSON.stringify(res.result));
        vmRef.setProp(obj, 'json', jsonStr);
        jsonStr.dispose();
        if (res.buffer) {
          const abHandle = vmRef.newArrayBuffer(res.buffer);
          vmRef.setProp(obj, 'buffer', abHandle);
          abHandle.dispose();
        }
        deferred.resolve(obj);
        obj.dispose();
      } else {
        const errHandle = vmRef.newError(res.error || 'RPC call failed.');
        deferred.reject(errHandle);
        errHandle.dispose();
      }
      deferred.dispose();
    } catch (err) {
      try {
        deferred.dispose();
      } catch {
        // ignore secondary dispose failure
      }
      finishError(err instanceof Error ? err : new Error('Failed to deliver RPC response.'));
      return;
    }

    drainJobs();
  };

  const abort = (reason?: string) => {
    if (settled) return;
    aborted = true;
    if (reason) abortReason = reason;
    // If we are idle waiting on RPC, terminate immediately; otherwise the interrupt handler triggers.
    if (sliceStartMs === null) {
      finishError(new Error(abortReason));
    }
  };

  void (async () => {
    try {
      const engine = await getEngine();
      if (settled || aborted) {
        finishError(new Error(abortReason));
        return;
      }

      const runtime = engine.newRuntime();
      runtimeRef = runtime;
      runtime.setMemoryLimit(memoryLimitBytes);
      runtime.setMaxStackSize(maxStackSizeBytes);
      runtime.setInterruptHandler(() => {
        if (aborted) return true;
        if (sliceStartMs !== null && cpuUsedMs + (performance.now() - sliceStartMs) > cpuLimitMs) {
          return true;
        }
        return false;
      });

      const vm = runtime.newContext();
      vmRef = vm;

      let cleaned = false;
      cleanupRuntime = () => {
        if (cleaned) return;
        cleaned = true;
        for (const deferred of pendingPromises.values()) {
          try {
            deferred.dispose();
          } catch {
            // ignore
          }
        }
        pendingPromises.clear();
        vmRef = null;
        runtimeRef = null;
        try {
          vm.dispose();
        } finally {
          runtime.dispose();
        }
      };

      const rpcFn = vm.newFunction('__luminaRpc', (methodH, paramsJsonH, binaryH) => {
        const method = vm.getString(methodH) as PluginRpcMethod;
        const paramsJson = vm.typeof(paramsJsonH) === 'string' ? vm.getString(paramsJsonH) : 'null';
        let parsedParams: unknown = null;
        try {
          parsedParams = paramsJson ? JSON.parse(paramsJson) : null;
        } catch {
          parsedParams = null;
        }

        let buffer: ArrayBuffer | undefined;
        if (binaryH && vm.typeof(binaryH) !== 'undefined') {
          const abLifetime = vm.getArrayBuffer(binaryH);
          try {
            const view = abLifetime.value;
            const copied = new Uint8Array(view.byteLength);
            copied.set(view);
            buffer = copied.buffer;
          } finally {
            abLifetime.dispose();
          }
        }

        const id = nextRpcId++;
        const deferred = vm.newPromise();
        pendingPromises.set(id, deferred);

        const req: PluginRpcRequest = {
          id,
          method,
          params: parsedParams,
          ...(buffer ? { buffer } : {}),
        };
        sendRpc(req);
        return deferred.handle;
      });

      const finishFn = vm.newFunction('__luminaFinish', (okH, payloadH) => {
        if (pendingOutcome) return;
        const ok = vm.dump(okH) === true;
        const payloadStr = vm.typeof(payloadH) === 'string' ? vm.getString(payloadH) : '';
        if (ok) {
          if (payloadStr.length > 256 * 1024) {
            pendingOutcome = { ok: false, error: new Error('Plugin return value is too large.') };
          } else {
            try {
              const parsed = payloadStr ? JSON.parse(payloadStr) : undefined;
              pendingOutcome = { ok: true, value: parsed };
            } catch {
              pendingOutcome = { ok: false, error: new Error('Plugin returned non-serializable value.') };
            }
          }
        } else {
          pendingOutcome = { ok: false, error: new Error(payloadStr || 'Plugin failed.') };
        }
      });

      vm.setProp(vm.global, '__luminaRpc', rpcFn);
      vm.setProp(vm.global, '__luminaFinish', finishFn);
      rpcFn.dispose();
      finishFn.dispose();

      const invokeExpr =
        entry.kind === 'command'
          ? `if (typeof onCommand !== 'function') throw new Error('Plugin v2 script must define onCommand(commandId, api).');
             return onCommand(${JSON.stringify(entry.commandId)}, api);`
          : `if (typeof onPanelAction !== 'function') throw new Error('Plugin v2 script must define onPanelAction(panelId, actionId, values, api).');
             return onPanelAction(${JSON.stringify(entry.panelId)}, ${JSON.stringify(entry.actionId)}, ${JSON.stringify(entry.values)}, api);`;

      const wrappedCode = `(function () {
        "use strict";
        ${V2_API_BOOTSTRAP}
        const api = __buildApi(${JSON.stringify(context)});
        const __runUser = () => {
          ${script}
          ${invokeExpr}
        };
        Promise.resolve().then(__runUser).then(
          (val) => {
            const json = val === undefined ? '' : JSON.stringify(val);
            __luminaFinish(true, json);
          },
          (err) => {
            const msg = err && typeof err === 'object' && typeof err.message === 'string'
              ? err.message
              : String(err ?? 'Plugin failed.');
            __luminaFinish(false, msg);
          }
        );
      })()`;

      beginCpuSlice();
      const evalRes = vm.evalCode(wrappedCode, 'plugin-v2.js', { type: 'global' });
      endCpuSlice();

      if (evalRes.error) {
        const msg = formatVmError(vm, evalRes.error);
        evalRes.error.dispose();
        const finalMsg = aborted
          ? abortReason
          : cpuUsedMs >= cpuLimitMs
            ? 'Plugin CPU time limit exceeded.'
            : msg;
        finishError(new Error(finalMsg));
        return;
      }
      evalRes.value.dispose();

      drainJobs();
    } catch (err) {
      finishError(err instanceof Error ? err : new Error('Plugin runtime failed.'));
    }
  })();

  return { promise, deliverRpcResponse, abort };
}
