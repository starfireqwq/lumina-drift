import type { PluginContext } from './pluginApi';
import type { PluginRpcResponse } from './pluginRpc';
import {
  executePluginV1,
  startPluginV2Session,
  type RunV2Entry,
  type RunningV2Session,
} from './pluginSandboxCore';

export type PluginWorkerInbound =
  | {
      type?: 'run-v1';
      script: string;
      command: string;
      context: PluginContext;
    }
  | {
      type: 'run-v2';
      script: string;
      entry: RunV2Entry;
      context: PluginContext;
      memoryLimitBytes: number;
      maxStackSizeBytes: number;
      cpuLimitMs: number;
    }
  | {
      type: 'rpc-res';
      response: PluginRpcResponse;
    }
  | {
      type: 'abort';
      reason?: string;
    };

export type PluginWorkerOutbound =
  | { type: 'result-v1'; ok: true; value: unknown }
  | { type: 'result-v1'; ok: false; error: string }
  | { type: 'rpc-req'; id: number; method: string; params: unknown; buffer?: ArrayBuffer }
  | { type: 'result-v2'; ok: true; value: unknown; cpuUsedMs: number }
  | { type: 'result-v2'; ok: false; error: string };

let activeV2Session: RunningV2Session | null = null;

self.onmessage = async (event: MessageEvent<PluginWorkerInbound>) => {
  const msg = event.data;

  if (msg.type === 'rpc-res') {
    activeV2Session?.deliverRpcResponse(msg.response);
    return;
  }

  if (msg.type === 'abort') {
    activeV2Session?.abort(msg.reason);
    return;
  }

  if (msg.type === 'run-v2') {
    if (activeV2Session) {
      activeV2Session.abort('Superseded by a new session.');
      activeV2Session = null;
    }
    const session = startPluginV2Session({
      script: msg.script,
      entry: msg.entry,
      context: msg.context,
      memoryLimitBytes: msg.memoryLimitBytes,
      maxStackSizeBytes: msg.maxStackSizeBytes,
      cpuLimitMs: msg.cpuLimitMs,
      sendRpc: (req) => {
        const transfer: Transferable[] = req.buffer ? [req.buffer] : [];
        (self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void }).postMessage(
          {
            type: 'rpc-req',
            id: req.id,
            method: req.method,
            params: req.params,
            ...(req.buffer ? { buffer: req.buffer } : {}),
          } satisfies PluginWorkerOutbound,
          transfer,
        );
      },
    });
    activeV2Session = session;
    try {
      const { value, cpuUsedMs } = await session.promise;
      self.postMessage({ type: 'result-v2', ok: true, value, cpuUsedMs } satisfies PluginWorkerOutbound);
    } catch (error) {
      self.postMessage({
        type: 'result-v2',
        ok: false,
        error: error instanceof Error ? error.message : 'Plugin failed.',
      } satisfies PluginWorkerOutbound);
    } finally {
      if (activeV2Session === session) activeV2Session = null;
    }
    return;
  }

  // Default / legacy v1 synchronous execution path (100% backward compatible)
  try {
    const value = await executePluginV1({
      script: msg.script,
      command: msg.command,
      context: msg.context,
    });
    self.postMessage({ type: 'result-v1', ok: true, value } satisfies PluginWorkerOutbound);
  } catch (error) {
    self.postMessage({
      type: 'result-v1',
      ok: false,
      error: error instanceof Error ? error.message : 'Plugin failed.',
    } satisfies PluginWorkerOutbound);
  }
};
