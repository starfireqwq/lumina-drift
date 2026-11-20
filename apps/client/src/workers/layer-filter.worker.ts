import { PIXEL_FILTER_RUNNERS, runPixelFilter, type FilterValues } from '@atelier/shared';

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
    const output = runPixelFilter(runner, job.pixels, job.width, job.height, job.values, job.mask);
    self.postMessage({ request: job.request, output }, { transfer: [output.buffer] });
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
