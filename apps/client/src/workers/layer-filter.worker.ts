import { PIXEL_FILTER_RUNNERS, runDraftFilter, runPixelFilter, toneHistogram, type FilterValues } from '@atelier/shared';

/**
 * The resident filter worker (engine/filterWorkerClient.ts keeps one alive). A job does not start
 * the moment it arrives: jobs that queued up meanwhile are read first and only the newest runs, so
 * dragging a slider over a big layer computes the last position instead of every one in between.
 */
type Job = {
  request: number;
  id: string;
  pixels: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  values: FilterValues;
  mask?: Uint8Array | null;
  /** Also count the layer's tones (before filtering), for the levels window */
  histogram?: boolean;
  /** Work out a quick draft on a copy shrunk this many times (2 or more; filters that allow it) */
  draft?: number;
};

let queued: Job | null = null;
let scheduled = false;

const drop = (job: Job) => self.postMessage({ request: job.request, cancelled: true });

function runQueued() {
  scheduled = false;
  const job = queued;
  queued = null;
  if (!job) return;
  try {
    const runner = PIXEL_FILTER_RUNNERS[job.id];
    if (!runner) throw new Error(`Unknown filter: ${job.id}`);
    const histogram = job.histogram ? toneHistogram(job.pixels, job.width, job.height, job.mask) : undefined;
    const output = job.draft
      ? runDraftFilter(runner, job.pixels, job.width, job.height, job.values, job.mask, job.draft)
      : runPixelFilter(runner, job.pixels, job.width, job.height, job.values, job.mask);
    self.postMessage({ request: job.request, output, histogram }, { transfer: histogram ? [output.buffer, histogram.buffer] : [output.buffer] });
  } catch (error) {
    self.postMessage({ request: job.request, error: String(error) });
  }
}

self.onmessage = ({ data }: MessageEvent<Job | { cancel: number }>) => {
  if ('cancel' in data) {
    if (queued && queued.request <= data.cancel) {
      drop(queued);
      queued = null;
    }
    return;
  }
  if (queued) drop(queued);
  queued = data;
  if (!scheduled) {
    scheduled = true;
    setTimeout(runQueued, 0);
  }
};
