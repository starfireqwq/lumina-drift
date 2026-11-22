import type { FilterValues } from '@atelier/shared';
import { runPluginFilterTiled } from '../plugins/pluginFilterCore';

/**
 * Dedicated resident QuickJS worker for Plugin API v2 tile-based filters.
 * Completely isolated from layer-filter.worker.ts; managed by PluginFilterWorkerClient
 * with a 60-second idle auto-release timer.
 */
type PluginFilterJob = {
  request: number;
  script: string;
  filterId: string;
  pixels: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  values: FilterValues;
  mask?: Uint8Array | null;
  tilePadding: number;
  draft?: number;
  previewOnly: boolean;
  memoryLimitBytes: number;
  maxStackSizeBytes: number;
};

type CancelMessage = { cancel: number };

let queued: PluginFilterJob | null = null;
let running = false;
let cancelledUpTo = 0;

const drop = (job: PluginFilterJob) => {
  self.postMessage({ request: job.request, cancelled: true });
};

async function drainQueue() {
  if (running) return;
  running = true;
  try {
    while (queued) {
      const job = queued;
      queued = null;
      if (job.request <= cancelledUpTo) {
        drop(job);
        continue;
      }
      try {
        const result = await runPluginFilterTiled({
          script: job.script,
          filterId: job.filterId,
          pixels: job.pixels,
          width: job.width,
          height: job.height,
          params: job.values,
          mask: job.mask,
          tilePadding: job.tilePadding,
          draft: job.draft,
          previewOnly: job.previewOnly,
          memoryLimitBytes: job.memoryLimitBytes,
          maxStackSizeBytes: job.maxStackSizeBytes,
          isCancelled: () => job.request <= cancelledUpTo || queued !== null,
        });
        if (result.cancelled || !result.output || job.request <= cancelledUpTo) {
          drop(job);
        } else {
          self.postMessage(
            {
              request: job.request,
              output: result.output,
              cpuUsedMs: result.cpuUsedMs,
              tilesProcessed: result.tilesProcessed,
            },
            { transfer: [result.output.buffer] },
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        self.postMessage({ request: job.request, error: message });
      }
    }
  } finally {
    running = false;
  }
}

self.onmessage = ({ data }: MessageEvent<PluginFilterJob | CancelMessage>) => {
  if ('cancel' in data) {
    cancelledUpTo = Math.max(cancelledUpTo, data.cancel);
    if (queued && queued.request <= cancelledUpTo) {
      drop(queued);
      queued = null;
    }
    return;
  }
  if (queued) drop(queued);
  queued = data;
  setTimeout(() => {
    void drainQueue();
  }, 0);
};
