import type { FilterValues } from '@atelier/shared';

type Reply = { request: number; output?: Uint8Array; histogram?: Uint32Array; error?: string; cancelled?: boolean };
/** A finished job: the filtered pixels, and the layer's tone counts when they were asked for */
export type FilterResult = { output: Uint8Array; histogram?: Uint32Array };
type Pending = { resolve: (result: FilterResult | null) => void; reject: (error: Error) => void; postedAt: number };

/** A cancelled job still running after this long is cut short by restarting the worker */
const RESTART_AFTER_MS = 250;
/** An unused worker is let go after this long, so phones get the memory back */
const IDLE_MS = 60_000;

/**
 * One filter worker, kept alive and reused between previews (it used to be created for every
 * preview). Each job has a request id; cancel() drops the unfinished ones, whose promises resolve
 * to null. A short stale job is left to finish and ignored; a long one (a big blur on a large
 * canvas) would hold up the next preview, so the worker is restarted instead.
 */
export class FilterWorkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Workers started so far (read by the self-checks through __debugPixi) */
  started = 0;

  /**
   * Runs a registered filter. `pixels` is handed over to the worker (its buffer is transferred).
   * With `histogram`, the reply also counts the layer's tones before filtering (the levels window).
   */
  run(id: string, pixels: Uint8Array<ArrayBuffer>, width: number, height: number, values: FilterValues, mask?: Uint8Array | null,
    options?: { histogram?: boolean }) {
    this.clearIdle();
    const worker = this.ensure();
    const request = ++this.seq;
    return new Promise<FilterResult | null>((resolve, reject) => {
      this.pending.set(request, { resolve, reject, postedAt: performance.now() });
      worker.postMessage({ request, id, pixels, width, height, values, mask, histogram: options?.histogram }, [pixels.buffer]);
    });
  }

  /** Drops every unfinished job */
  cancel() {
    if (!this.pending.size) return;
    let oldest = Infinity;
    for (const job of this.pending.values()) {
      oldest = Math.min(oldest, job.postedAt);
      job.resolve(null);
    }
    this.pending.clear();
    if (performance.now() - oldest > RESTART_AFTER_MS) this.stop();
    else this.worker?.postMessage({ cancel: this.seq });
    this.scheduleIdle();
  }

  dispose() {
    this.clearIdle();
    for (const job of this.pending.values()) job.resolve(null);
    this.pending.clear();
    this.stop();
  }

  /** Whether a worker is alive right now */
  get alive() {
    return this.worker !== null;
  }

  private ensure() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('../workers/layer-filter.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<Reply>) => {
      const job = this.pending.get(data.request);
      if (!job) return;
      this.pending.delete(data.request);
      if (data.output) job.resolve({ output: data.output, histogram: data.histogram });
      else if (data.cancelled) job.resolve(null);
      else job.reject(new Error(data.error ?? 'Filter worker returned no result'));
      this.scheduleIdle();
    };
    worker.onerror = (event) => {
      event.preventDefault();
      const error = new Error(event.message || 'Filter worker failed');
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
    }, IDLE_MS);
  }
}
