import type { PluginContext, PluginPointerEvent, PluginPointerPhase } from './pluginApi';
import type { PluginRpcResponse } from './pluginRpc';
import {
  executePluginV1,
  startPluginToolV2Session,
  startPluginV2Session,
  type RunV2Entry,
  type RunningToolV2Session,
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
      type: 'tool-start';
      script: string;
      toolId: string;
      context: PluginContext;
      memoryLimitBytes: number;
      maxStackSizeBytes: number;
      eventCpuLimitMs: number;
      strokeCpuLimitMs: number;
    }
  | {
      type: 'tool-event';
      eventId: number;
      phase: PluginPointerPhase;
      event: PluginPointerEvent;
    }
  | {
      type: 'tool-end';
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
  | { type: 'result-v2'; ok: false; error: string }
  | { type: 'tool-ready'; ok: true }
  | { type: 'tool-ready'; ok: false; error: string }
  | { type: 'tool-event-res'; eventId: number; ok: true; value: unknown; cpuUsedMs: number }
  | { type: 'tool-event-res'; eventId: number; ok: false; error: string };

let activeV2Session: RunningV2Session | null = null;
let activeToolSession: RunningToolV2Session | null = null;

self.onmessage = async (event: MessageEvent<PluginWorkerInbound>) => {
  const msg = event.data;

  if (msg.type === 'rpc-res') {
    activeV2Session?.deliverRpcResponse(msg.response);
    activeToolSession?.deliverRpcResponse(msg.response);
    return;
  }

  if (msg.type === 'abort') {
    activeV2Session?.abort(msg.reason);
    activeToolSession?.abort(msg.reason);
    return;
  }

  if (msg.type === 'tool-end') {
    activeToolSession?.dispose();
    activeToolSession = null;
    return;
  }

  if (msg.type === 'tool-start') {
    if (activeToolSession) {
      activeToolSession.dispose();
      activeToolSession = null;
    }
    const session = startPluginToolV2Session({
      script: msg.script,
      toolId: msg.toolId,
      context: msg.context,
      memoryLimitBytes: msg.memoryLimitBytes,
      maxStackSizeBytes: msg.maxStackSizeBytes,
      eventCpuLimitMs: msg.eventCpuLimitMs,
      strokeCpuLimitMs: msg.strokeCpuLimitMs,
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
    activeToolSession = session;
    try {
      await session.ready;
      self.postMessage({ type: 'tool-ready', ok: true } satisfies PluginWorkerOutbound);
    } catch (error) {
      if (activeToolSession === session) activeToolSession = null;
      self.postMessage({
        type: 'tool-ready',
        ok: false,
        error: error instanceof Error ? error.message : 'Plugin tool initialization failed.',
      } satisfies PluginWorkerOutbound);
    }
    return;
  }

  if (msg.type === 'tool-event') {
    const session = activeToolSession;
    if (!session) {
      self.postMessage({
        type: 'tool-event-res',
        eventId: msg.eventId,
        ok: false,
        error: 'Plugin tool session is not active.',
      } satisfies PluginWorkerOutbound);
      return;
    }
    try {
      const { value, cpuUsedMs } = await session.dispatchEvent(msg.phase, msg.event);
      self.postMessage({
        type: 'tool-event-res',
        eventId: msg.eventId,
        ok: true,
        value,
        cpuUsedMs,
      } satisfies PluginWorkerOutbound);
    } catch (error) {
      self.postMessage({
        type: 'tool-event-res',
        eventId: msg.eventId,
        ok: false,
        error: error instanceof Error ? error.message : 'Plugin tool event failed.',
      } satisfies PluginWorkerOutbound);
    }
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
