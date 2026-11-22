import {
  PLUGIN_LIMITS,
  type PluginFilterParam,
  type PluginManifestV2,
  type PluginPointerEvent,
  type PluginPointerPhase,
  type PluginToolDeclaration,
} from './pluginApi';
import type { PluginToolSessionHandle } from './pluginHost';
import type { PluginCanvasTransaction } from './pluginCanvasBridge';
import type { InstalledPlugin } from './pluginStore';
import type { PluginV2Result } from './pluginRpc';

export interface RegisteredPluginTool {
  key: string;
  plugin: PluginManifestV2;
  tool: PluginToolDeclaration;
  hasInputPermission: boolean;
}

export function makePluginToolKey(pluginId: string, toolId: string): string {
  return `${pluginId}:${toolId}`;
}

export function collectEnabledPluginTools(plugins: readonly InstalledPlugin[]): RegisteredPluginTool[] {
  const out: RegisteredPluginTool[] = [];
  for (const entry of plugins) {
    if (!entry.enabled || entry.manifest.apiVersion !== 2) continue;
    if (!entry.manifest.permissions.includes('tools')) continue;
    const tools = entry.manifest.tools ?? [];
    if (tools.length === 0) continue;
    const hasInput = entry.manifest.permissions.includes('input');
    for (const tool of tools) {
      out.push({
        key: makePluginToolKey(entry.manifest.id, tool.id),
        plugin: entry.manifest,
        tool,
        hasInputPermission: hasInput,
      });
    }
  }
  return out;
}

export function buildInitialToolOptions(
  tool: PluginToolDeclaration,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const param of tool.options ?? []) {
    out[param.key] = param.initial;
  }
  return out;
}

export function isPluginToolOptionVisible(
  param: PluginFilterParam,
  values: Record<string, string | number | boolean>,
): boolean {
  if (!param.when) return true;
  const current = values[param.when.key];
  return param.when.is.some((expected) => expected === current);
}

export interface RawPointerSample {
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  pointerType: 'mouse' | 'pen' | 'touch';
  buttons: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface PluginToolStrokeHooks {
  createSession: (
    plugin: PluginManifestV2,
    toolId: string,
    tx: PluginCanvasTransaction,
  ) => PluginToolSessionHandle;
  createTransaction: (plugin: PluginManifestV2, groupId: string) => PluginCanvasTransaction;
  onNotice?: (text: string) => void;
  onError?: (message: string) => void;
}

/**
 * Coordinates a single custom-tool drag stroke from pointerdown through throttled pointermove
 * to pointerup or cancel:
 * - Shares one PluginCanvasTransaction (and one undo groupId) across the entire drag.
 * - Throttles & coalesces pointermove events so slow scripts never build an unbounded queue.
 * - Flushes live pixel previews after down/move and rolls back cleanly on cancel/error/timeout.
 */
export class PluginToolPointerController {
  private active: {
    pointerId: number;
    plugin: PluginManifestV2;
    tool: PluginToolDeclaration;
    options: Record<string, string | number | boolean>;
    tx: PluginCanvasTransaction;
    session: PluginToolSessionHandle;
    hooks: PluginToolStrokeHooks;
    startTime: number;
    startX: number;
    startY: number;
    lastDispatchedX: number;
    lastDispatchedY: number;
    lastMoveSentAt: number;
    throttleMs: number;
    inFlight: boolean;
    pendingMove: RawPointerSample | null;
    throttleTimer: ReturnType<typeof setTimeout> | null;
    finishing: boolean;
    failed: boolean;
    chain: Promise<void>;
  } | null = null;

  isStrokeActive(): boolean {
    return this.active !== null;
  }

  private buildEvent(
    state: NonNullable<PluginToolPointerController['active']>,
    phase: PluginPointerPhase,
    sample: RawPointerSample,
  ): PluginPointerEvent {
    const deltaX = phase === 'down' ? 0 : sample.x - state.lastDispatchedX;
    const deltaY = phase === 'down' ? 0 : sample.y - state.lastDispatchedY;
    state.lastDispatchedX = sample.x;
    state.lastDispatchedY = sample.y;
    return {
      phase,
      x: sample.x,
      y: sample.y,
      startX: state.startX,
      startY: state.startY,
      deltaX,
      deltaY,
      pressure: sample.pressure,
      tiltX: sample.tiltX,
      tiltY: sample.tiltY,
      pointerType: sample.pointerType,
      buttons: sample.buttons,
      shiftKey: sample.shiftKey,
      ctrlKey: sample.ctrlKey,
      altKey: sample.altKey,
      metaKey: sample.metaKey,
      timestamp: Math.max(0, Math.round(performance.now() - state.startTime)),
      options: { ...state.options },
    };
  }

  startStroke(
    pointerId: number,
    sample: RawPointerSample,
    registered: RegisteredPluginTool,
    options: Record<string, string | number | boolean>,
    hooks: PluginToolStrokeHooks,
  ): boolean {
    if (this.active) {
      this.cancelStroke();
    }
    const groupId = `plugin_tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tx = hooks.createTransaction(registered.plugin, groupId);
    let session: PluginToolSessionHandle;
    try {
      session = hooks.createSession(registered.plugin, registered.tool.id, tx);
    } catch (err) {
      void tx.rollback();
      hooks.onError?.(err instanceof Error ? err.message : 'Failed to start plugin tool.');
      return false;
    }

    const throttleMs = Math.max(
      PLUGIN_LIMITS.toolMinThrottleMs,
      Math.min(
        PLUGIN_LIMITS.toolMaxThrottleMs,
        registered.tool.throttleMs ?? PLUGIN_LIMITS.toolDefaultThrottleMs,
      ),
    );

    const state: NonNullable<PluginToolPointerController['active']> = {
      pointerId,
      plugin: registered.plugin,
      tool: registered.tool,
      options: { ...options },
      tx,
      session,
      hooks,
      startTime: performance.now(),
      startX: sample.x,
      startY: sample.y,
      lastDispatchedX: sample.x,
      lastDispatchedY: sample.y,
      lastMoveSentAt: 0,
      throttleMs,
      inFlight: true,
      pendingMove: null,
      throttleTimer: null,
      finishing: false,
      failed: false,
      chain: Promise.resolve(),
    };
    this.active = state;

    const downEv = this.buildEvent(state, 'down', sample);
    state.chain = this.runSingleEvent(state, 'down', downEv);
    return true;
  }

  private runSingleEvent(
    state: NonNullable<PluginToolPointerController['active']>,
    phase: PluginPointerPhase,
    ev: PluginPointerEvent,
  ): Promise<void> {
    state.inFlight = true;
    return state.session
      .dispatchEvent(phase, ev)
      .then((res: PluginV2Result) => {
        if (this.active !== state || state.failed) return;
        if (phase === 'down' || phase === 'move') {
          state.tx.flushPreview();
        }
        if (res.notice) {
          state.hooks.onNotice?.(res.notice);
        }
      })
      .catch(async (err: unknown) => {
        if (state.failed) return;
        state.failed = true;
        if (state.throttleTimer) {
          clearTimeout(state.throttleTimer);
          state.throttleTimer = null;
        }
        state.pendingMove = null;
        state.session.dispose();
        await state.tx.rollback();
        if (this.active === state) this.active = null;
        state.hooks.onError?.(err instanceof Error ? err.message : 'Plugin tool failed.');
      })
      .finally(() => {
        state.inFlight = false;
        if (this.active === state && !state.failed && !state.finishing) {
          this.drainPendingMove(state);
        }
      });
  }

  private drainPendingMove(state: NonNullable<PluginToolPointerController['active']>) {
    if (state.inFlight || state.finishing || state.failed || !state.pendingMove) return;
    const now = performance.now();
    const elapsed = now - state.lastMoveSentAt;
    if (elapsed < state.throttleMs) {
      if (!state.throttleTimer) {
        state.throttleTimer = setTimeout(() => {
          state.throttleTimer = null;
          if (this.active === state) this.drainPendingMove(state);
        }, state.throttleMs - elapsed);
      }
      return;
    }
    const nextSample = state.pendingMove;
    state.pendingMove = null;
    state.lastMoveSentAt = now;
    const moveEv = this.buildEvent(state, 'move', nextSample);
    state.chain = state.chain.then(() => {
      if (this.active !== state || state.failed || state.finishing) return;
      return this.runSingleEvent(state, 'move', moveEv);
    });
  }

  moveStroke(pointerId: number, sample: RawPointerSample): boolean {
    const state = this.active;
    if (!state || state.pointerId !== pointerId || state.finishing || state.failed) return false;
    state.pendingMove = sample;
    this.drainPendingMove(state);
    return true;
  }

  endStroke(pointerId: number, sample: RawPointerSample | null, cancelled: boolean): boolean {
    const state = this.active;
    if (!state || state.pointerId !== pointerId) return false;
    if (cancelled) {
      this.cancelStroke(sample);
      return true;
    }
    if (state.finishing) return true;
    state.finishing = true;
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }
    state.pendingMove = null;

    const finalSample: RawPointerSample = sample ?? {
      x: state.lastDispatchedX,
      y: state.lastDispatchedY,
      pressure: 0,
      tiltX: 0,
      tiltY: 0,
      pointerType: 'mouse',
      buttons: 0,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    };

    const prevChain = state.chain;
    state.chain = prevChain.then(async () => {
      if (state.failed) return;
      try {
        const upEv = this.buildEvent(state, 'up', finalSample);
        const res = await state.session.dispatchEvent('up', upEv);
        state.session.dispose();
        state.tx.commit(`Plugin Tool: ${state.tool.label}`);
        if (res.notice) state.hooks.onNotice?.(res.notice);
      } catch (err) {
        state.failed = true;
        state.session.dispose();
        await state.tx.rollback();
        state.hooks.onError?.(err instanceof Error ? err.message : 'Plugin tool failed.');
      } finally {
        if (this.active === state) this.active = null;
      }
    });
    return true;
  }

  cancelStroke(sample?: RawPointerSample | null): void {
    const state = this.active;
    if (!state) return;
    this.active = null;
    state.finishing = true;
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }
    state.pendingMove = null;

    if (state.failed) return;
    state.failed = true;

    const cancelSample: RawPointerSample = sample ?? {
      x: state.lastDispatchedX,
      y: state.lastDispatchedY,
      pressure: 0,
      tiltX: 0,
      tiltY: 0,
      pointerType: 'mouse',
      buttons: 0,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    };

    const cancelEv = this.buildEvent(state, 'cancel', cancelSample);
    // Give onCancel a brief best-effort grace window if not mid-event, then always dispose & rollback.
    void (async () => {
      try {
        if (!state.inFlight) {
          await Promise.race([
            state.session.dispatchEvent('cancel', cancelEv).catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, 250)),
          ]);
        }
      } finally {
        state.session.dispose();
        await state.tx.rollback();
      }
    })();
  }
}
