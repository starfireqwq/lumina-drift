import type { SoftProofWorkerRequest, SoftProofWorkerResult } from '../../workers/soft-proof.worker';
import type { BuiltinProofProfileId } from './cmykPrintModel';
import { parseIccProfile } from './iccProfile';
import { buildSoftProofLut, softProofCacheKey, type ProofOptions, type ProofSource, type SoftProofLut } from './softProof';
import { getSoftProofStore, type SoftProofSettings, type SoftProofSnapshot, type SoftProofStatus, type SoftProofStore } from './softProofStore';

export interface SoftProofControllerOptions {
  target: { filters: unknown };
  requestRender: () => void;
  store?: SoftProofStore;
  createFilter?: () => SoftProofFilterLike;
  createWorker?: () => Worker | null;
  lutSize?: number;
}

export interface SoftProofFilterLike {
  setLut(lut: { size: number; data: Uint8Array }): void;
  setState(state: { proof: boolean; gamutWarning: boolean; warningColor: [number, number, number] }): void;
  destroy?(): void;
}

type SoftProofErrorCode = Extract<SoftProofStatus, { state: 'error' }>['code'];

export class SoftProofController {
  private readonly store: SoftProofStore;
  private readonly unsubscribe: () => void;
  private readonly size: number;
  private readonly cache = new Map<string, SoftProofLut>();
  private snapshot?: SoftProofSnapshot;
  private filter?: SoftProofFilterLike;
  private displayedLut?: SoftProofLut;
  private pending?: Promise<void>;
  private abort?: AbortController;
  private generation = 0;
  private builds = 0;
  private disposed = false;

  constructor(private readonly options: SoftProofControllerOptions) {
    this.store = options.store ?? getSoftProofStore();
    this.size = options.lutSize ?? 33;
    this.unsubscribe = this.store.subscribe(this.onStoreChange);
    this.onStoreChange();
  }

  async whenIdle(): Promise<void> {
    while (this.pending) await this.pending;
  }

  getDebugState(): {
    active: boolean; proof: boolean; gamutWarning: boolean; profileId: string; lutSize: number;
    buildMs: number; filterAttached: boolean; cacheSize: number; builds: number;
  } {
    const { enabled: proof, gamutWarning, profileId } = this.snapshot!.settings;
    const lut = this.filterAttached() ? this.displayedLut : undefined;
    return {
      active: !this.disposed && (proof || gamutWarning), proof, gamutWarning, profileId,
      lutSize: lut?.size ?? 0, buildMs: lut?.buildMs ?? 0, filterAttached: !!lut,
      cacheSize: this.cache.size, builds: this.builds,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.cancelBuild();
    this.detachFilter();
    this.filter?.destroy?.();
    this.filter = undefined;
    this.displayedLut = undefined;
    this.cache.clear();
  }

  private onStoreChange = (): void => {
    const snapshot = this.store.getSnapshot();
    const previous = this.snapshot;
    this.snapshot = snapshot;
    if (snapshot.settings === previous?.settings && snapshot.profiles === previous.profiles) return;

    const { settings } = snapshot;
    const before = previous?.settings;
    const wasActive = before?.enabled || before?.gamutWarning;
    if (!settings.enabled && !settings.gamutWarning) {
      if (!previous || wasActive) {
        this.cancelBuild();
        this.detachFilter();
        this.store.setStatus({ state: 'off' });
        this.options.requestRender();
      }
      return;
    }

    if (this.filterAttached() && (settings.enabled !== before?.enabled || settings.gamutWarning !== before.gamutWarning
      || settings.warningColor !== before.warningColor)) {
      this.setFilterState(settings);
      this.options.requestRender();
    }

    const selectedProfileChanged = previous?.profiles !== snapshot.profiles
      && previous?.profiles.find(profile => profile.id === settings.profileId) !== snapshot.profiles.find(profile => profile.id === settings.profileId);
    if (!wasActive || selectedProfileChanged || settings.profileId !== before.profileId || settings.intent !== before.intent
      || settings.blackPointCompensation !== before.blackPointCompensation) {
      this.startBuild(settings);
    }
  };

  private cancelBuild(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = undefined;
    this.pending = undefined;
  }

  private startBuild(settings: SoftProofSettings): void {
    this.cancelBuild();
    const generation = this.generation;
    const abort = new AbortController();
    this.abort = abort;
    const cancelled = new Promise<void>(resolve => abort.signal.addEventListener('abort', () => resolve(), { once: true }));
    const build = Promise.resolve().then(() => this.build(settings, generation, abort.signal));
    this.pending = Promise.race([build, cancelled]).finally(() => {
      if (this.generation === generation) {
        this.abort = undefined;
        this.pending = undefined;
      }
    });
  }

  private async build(settings: SoftProofSettings, generation: number, signal: AbortSignal): Promise<void> {
    const isCurrent = () => generation === this.generation;
    if (!isCurrent()) return;
    try {
      const { profileId, intent, blackPointCompensation } = settings;
      let source: ProofSource;
      if (profileId.startsWith('builtin:')) {
        source = { kind: 'builtin', id: profileId.slice(8) as BuiltinProofProfileId };
      } else {
        await this.store.ready();
        if (!isCurrent()) return;
        const profile = this.store.getSnapshot().profiles.find(option => option.id === profileId);
        const bytes = this.store.getIccBytes(profileId);
        if (!profile || !bytes) return this.fail('missing_profile');
        if (!profile.proofable) return this.fail('unsupported_profile');
        source = { kind: 'icc', profile: parseIccProfile(bytes) };
      }

      const options = { intent, blackPointCompensation };
      const key = softProofCacheKey(source, options, this.size);
      let lut = this.cache.get(key);
      if (!lut) {
        this.builds++;
        this.store.setStatus({ state: 'building', progress: 0 });
        if (!isCurrent()) return;
        const result = await this.buildInWorker(source, options, generation, signal);
        if (!isCurrent()) return;
        if (result?.ok) {
          lut = { size: result.size, data: new Uint8Array(result.data), buildMs: result.buildMs, label: result.label };
        } else if (result?.code === 'unsupported_profile') {
          return this.fail(result.code);
        } else {
          lut = await buildSoftProofLut(source, options, { size: this.size, signal });
          if (!isCurrent()) return;
        }
      }
      this.cache.delete(key);
      this.cache.set(key, lut);
      const oldest = this.cache.keys().next().value;
      if (this.cache.size > 4 && oldest !== undefined) this.cache.delete(oldest);

      if (!this.filter) {
        if (this.options.createFilter) {
          this.filter = this.options.createFilter();
        } else {
          const { SoftProofFilter } = await import('./softProofFilter');
          if (!isCurrent()) return;
          this.filter = new SoftProofFilter();
        }
      }
      if (this.displayedLut !== lut) {
        this.filter.setLut(lut);
        this.displayedLut = lut;
      }
      this.setFilterState(this.store.getSnapshot().settings);
      if (!this.filterAttached()) this.options.target.filters = [...this.targetFilters(), this.filter];
      this.store.setStatus({ state: 'ready', buildMs: lut.buildMs, lutSize: lut.size });
      this.options.requestRender();
    } catch (error) {
      if (!isCurrent()) return;
      const code = error instanceof Error && error.message === 'unsupported_profile' ? 'unsupported_profile' : 'build_failed';
      this.fail(code);
    }
  }

  private buildInWorker(source: ProofSource, options: ProofOptions, id: number, signal: AbortSignal): Promise<SoftProofWorkerResult | null> {
    let worker: Worker | null;
    try {
      worker = this.options.createWorker ? this.options.createWorker()
        : new Worker(new URL('../../workers/soft-proof.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return Promise.resolve(null);
    }
    if (!worker) return Promise.resolve(null);
    const activeWorker = worker;
    return new Promise(resolve => {
      let finished = false;
      const finish = (result: SoftProofWorkerResult | null) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        activeWorker.onmessage = activeWorker.onerror = activeWorker.onmessageerror = null;
        activeWorker.terminate();
        resolve(result);
      };
      const onAbort = () => finish(null);
      signal.addEventListener('abort', onAbort, { once: true });
      activeWorker.onmessage = ({ data }: MessageEvent<SoftProofWorkerResult>) => {
        if (data.id === id) finish(data);
      };
      activeWorker.onerror = error => {
        error.preventDefault();
        finish(null);
      };
      activeWorker.onmessageerror = () => finish(null);
      try {
        const input = source.kind === 'builtin' ? source : { kind: 'icc' as const, bytes: Uint8Array.from(source.profile.bytes).buffer };
        const request: SoftProofWorkerRequest = { id, source: input, options, size: this.size };
        activeWorker.postMessage(request, input.kind === 'icc' ? [input.bytes] : []);
      } catch {
        finish(null);
      }
    });
  }

  private fail(code: SoftProofErrorCode): void {
    this.detachFilter();
    this.store.setStatus({ state: 'error', code });
    this.options.requestRender();
  }

  private setFilterState(settings: SoftProofSettings): void {
    const color = Number.parseInt(settings.warningColor.slice(1), 16);
    this.filter?.setState({
      proof: settings.enabled,
      gamutWarning: settings.gamutWarning,
      warningColor: [(color >> 16) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255],
    });
  }

  private targetFilters(): readonly unknown[] {
    const { filters } = this.options.target;
    return Array.isArray(filters) ? filters : filters == null ? [] : [filters];
  }

  private filterAttached(): boolean {
    return !!this.filter && this.targetFilters().includes(this.filter);
  }

  private detachFilter(): void {
    if (!this.filterAttached()) return;
    const remaining = this.targetFilters().filter(filter => filter !== this.filter);
    this.options.target.filters = remaining.length ? remaining : null;
  }
}
