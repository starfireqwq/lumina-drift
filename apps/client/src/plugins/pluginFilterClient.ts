import type { FilterValues } from '@atelier/shared';
import type { FilterResult } from '../engine/filterWorkerClient';
import { PLUGIN_LIMITS } from './pluginApi';
import { getPlugins } from './pluginStore';
import type { FilterDef } from '../utils/filterRegistry';

type WorkerReply = {
  request: number;
  output?: Uint8Array;
  cpuUsedMs?: number;
  tilesProcessed?: number;
  error?: string;
  cancelled?: boolean;
};

type PendingJob = {
  resolve: (result: FilterResult | null) => void;
  reject: (error: Error) => void;
  postedAt: number;
};

/** A cancelled plugin filter job still running after this long is cut short by terminating the worker */
const RESTART_AFTER_MS = 250;
/** Resident plugin filter worker is released automatically after 60 seconds idle */
export const PLUGIN_FILTER_IDLE_MS = 60_000;

export interface PluginFilterRunOptions {
  draft?: number;
  previewOnly?: boolean;
  isTouch?: boolean;
}

/**
 * Resident QuickJS filter worker client, strictly isolated from FilterWorkerClient (layer-filter.worker.ts).
 * Reused across interactive previews and automatically terminated after 60 seconds of inactivity.
 */
export class PluginFilterWorkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, PendingJob>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Number of worker instances started so far (useful for diagnostics/tests) */
  started = 0;

  run(
    def: FilterDef,
    pixels: Uint8Array<ArrayBuffer>,
    width: number,
    height: number,
    values: FilterValues,
    mask?: Uint8Array | null,
    options?: PluginFilterRunOptions,
  ): Promise<FilterResult | null> {
    if (def.source !== 'plugin' || !def.pluginId || !def.pluginFilterId) {
      return Promise.reject(new Error(`Not a plugin filter: ${def.id}`));
    }
    const installed = getPlugins().find((item) => item.manifest.id === def.pluginId);
    if (!installed || !installed.enabled || installed.manifest.apiVersion !== 2) {
      return Promise.reject(new Error(`Plugin "${def.pluginId}" is disabled or unavailable.`));
    }
    if (!installed.manifest.permissions.includes('filters')) {
      return Promise.reject(new Error(`Plugin "${def.pluginId}" does not hold the "filters" permission.`));
    }

    this.clearIdle();
    const worker = this.ensure();
    const request = ++this.seq;
    const isTouch = options?.isTouch ?? false;
    const memoryLimitBytes = isTouch ? PLUGIN_LIMITS.memoryLimitMobileBytes : PLUGIN_LIMITS.memoryLimitDesktopBytes;

    return new Promise<FilterResult | null>((resolve, reject) => {
      this.pending.set(request, { resolve, reject, postedAt: performance.now() });
      worker.postMessage(
        {
          request,
          script: installed.manifest.script,
          filterId: def.pluginFilterId,
          pixels,
          width,
          height,
          values,
          mask: mask ?? null,
          tilePadding: def.tilePadding ?? 0,
          draft: options?.draft,
          previewOnly: options?.previewOnly ?? false,
          memoryLimitBytes,
          maxStackSizeBytes: PLUGIN_LIMITS.maxStackSizeBytes,
        },
        [pixels.buffer],
      );
    });
  }

  /** Drops every unfinished job; terminates and restarts the worker if a heavy tile job is still running */
  cancel() {
    if (!this.pending.size) return;
    let oldest = Infinity;
    for (const job of this.pending.values()) {
      oldest = Math.min(oldest, job.postedAt);
      job.resolve(null);
    }
    this.pending.clear();
    if (performance.now() - oldest > RESTART_AFTER_MS) {
      this.stop();
    } else {
      this.worker?.postMessage({ cancel: this.seq });
    }
    this.scheduleIdle();
  }

  dispose() {
    this.clearIdle();
    for (const job of this.pending.values()) job.resolve(null);
    this.pending.clear();
    this.stop();
  }

  get alive(): boolean {
    return this.worker !== null;
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('../workers/plugin-filter.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      const job = this.pending.get(data.request);
      if (!job) return;
      this.pending.delete(data.request);
      if (data.output) job.resolve({ output: data.output });
      else if (data.cancelled) job.resolve(null);
      else job.reject(new Error(data.error ?? 'Plugin filter worker returned no result'));
      this.scheduleIdle();
    };
    worker.onerror = (event) => {
      event.preventDefault();
      const error = new Error(event.message || 'Plugin filter worker failed');
      for (const job of this.pending.values()) job.reject(error);
      this.pending.clear();
      this.stop();
    };
    this.worker = worker;
    this.started++;
    return worker;
  }

  private stop() {
    this.worker?.terminate();
    this.worker = null;
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdle() {
    if (this.pending.size || !this.worker) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.pending.size) this.stop();
    }, PLUGIN_FILTER_IDLE_MS);
  }
}
