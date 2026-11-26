import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSrgbIccProfile } from '../src/engine/color/iccProfile';
import { SoftProofController, type SoftProofFilterLike } from '../src/engine/color/SoftProofController';
import { buildSoftProofLut, sampleSoftProofLut } from '../src/engine/color/softProof';
import { packSoftProofAtlas, sampleSoftProofAtlas, SOFT_PROOF_FRAGMENT } from '../src/engine/color/softProofAtlas';
import {
  createLocalStorageSettingsStorage, createMemoryIccRepository, DEFAULT_SOFT_PROOF_SETTINGS, MAX_ICC_PROFILE_BYTES,
  normalizeSoftProofSettings, SoftProofStore,
} from '../src/engine/color/softProofStore';
import type { SoftProofWorkerRequest, SoftProofWorkerResult } from '../src/workers/soft-proof.worker';

function createTestStore() {
  return new SoftProofStore({ settings: { load: () => null, save() {} }, repository: createMemoryIccRepository() });
}

function iccWithoutDescription(colorSpace: 'CMYK' | 'GRAY' | 'RGB '): Uint8Array {
  const srgb = createSrgbIccProfile();
  const gray = colorSpace === 'GRAY';
  const bytes = new Uint8Array(gray ? 156 : 132);
  bytes.set(srgb.subarray(0, 128));
  bytes.set(new TextEncoder().encode(colorSpace), 16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length);
  if (gray) {
    view.setUint32(128, 1);
    bytes.set(new TextEncoder().encode('kTRC'), 132);
    view.setUint32(136, 144);
    view.setUint32(140, 12);
    bytes.set(new TextEncoder().encode('curv'), 144);
  }
  return bytes;
}

async function checkStore(): Promise<void> {
  assert.deepEqual(normalizeSoftProofSettings({
    enabled: true, gamutWarning: true, profileId: 'builtin:missing', intent: 'absolute',
    blackPointCompensation: 'false', warningColor: '#12345Z',
  }), DEFAULT_SOFT_PROOF_SETTINGS);
  assert.equal(normalizeSoftProofSettings({ warningColor: '#abc' }).warningColor, DEFAULT_SOFT_PROOF_SETTINGS.warningColor);
  assert.deepEqual(normalizeSoftProofSettings({
    enabled: true, gamutWarning: true, profileId: 'icc:1234', intent: 'perceptual',
    blackPointCompensation: false, warningColor: '#aBcDeF',
  }), {
    enabled: false, gamutWarning: false, profileId: 'icc:1234', intent: 'perceptual',
    blackPointCompensation: false, warningColor: '#aBcDeF',
  });

  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const localStorage = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: { getItem: (key: string) => localStorage.get(key) ?? null, setItem: localStorage.set.bind(localStorage) } },
  });
  try {
    const key = 'test-soft-proof';
    const settings = createLocalStorageSettingsStorage(key);
    const repository = createMemoryIccRepository();
    const store = new SoftProofStore({ settings, repository });
    await store.ready();

    const before = store.getSnapshot();
    assert.strictEqual(store.getSnapshot(), before);
    assert.deepEqual(before.profiles.map(profile => profile.id), [
      'builtin:japan-color-2001-coated', 'builtin:fogra39', 'builtin:us-web-coated-swop',
    ]);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications++; });
    store.update({ enabled: true, gamutWarning: true, intent: 'perceptual' });
    assert.equal(notifications, 1);
    assert.notStrictEqual(store.getSnapshot(), before);
    assert.deepEqual(JSON.parse(localStorage.get(key)!), {
      profileId: DEFAULT_SOFT_PROOF_SETTINGS.profileId, intent: 'perceptual',
      blackPointCompensation: true, warningColor: '#FF2BD6',
    });
    store.update({ intent: 'perceptual' });
    assert.equal(notifications, 1);
    unsubscribe();

    assert.deepEqual(await store.importProfile('large.icc', new Uint8Array(MAX_ICC_PROFILE_BYTES + 1)), { ok: false, code: 'too_large' });
    assert.deepEqual(await store.importProfile('bad.icc', new Uint8Array(16)), { ok: false, code: 'parse_failed' });
    assert.deepEqual(await store.importProfile('cmyk.icc', iccWithoutDescription('CMYK')), { ok: false, code: 'unsupported_profile' });

    const srgb = createSrgbIccProfile();
    const [first, duplicate] = await Promise.all([store.importProfile('rgb.icc', srgb), store.importProfile('duplicate.icm', srgb)]);
    assert.ok(first.ok && duplicate.ok);
    assert.strictEqual(first.profile, duplicate.profile);
    let hash = 0xcbf29ce484222325n;
    for (const byte of srgb) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    assert.equal(first.profile.id, `icc:${hash.toString(16).padStart(16, '0')}`);
    assert.equal((await repository.list())[0]?.id, first.profile.id);
    assert.equal(first.profile.label, 'sRGB IEC61966-2.1 (Lumina)');
    assert.equal(first.profile.proofable, true);
    assert.equal(store.getSnapshot().settings.profileId, first.profile.id);
    assert.deepEqual(store.getIccBytes(first.profile.id), srgb);

    const gray = await store.importProfile('Gray proof.icc', iccWithoutDescription('GRAY'));
    assert.ok(gray.ok && gray.profile.proofable);
    assert.equal(gray.profile.label, 'Gray proof');
    const embedOnly = await store.importProfile('Embed only.icm', iccWithoutDescription('RGB '));
    assert.ok(embedOnly.ok);
    assert.equal(embedOnly.profile.proofable, false);
    assert.equal(store.getSnapshot().settings.profileId, gray.profile.id);
    assert.deepEqual(store.listRgbEmbedProfiles().map(profile => profile.id), [first.profile.id, embedOnly.profile.id]);

    const reopened = new SoftProofStore({ settings, repository });
    await reopened.ready();
    assert.equal(reopened.getSnapshot().settings.enabled, false);
    assert.equal(reopened.getSnapshot().settings.gamutWarning, false);
    assert.equal(reopened.getSnapshot().settings.profileId, gray.profile.id);
    assert.deepEqual(reopened.getSnapshot().profiles, store.getSnapshot().profiles);
    await reopened.removeProfile(gray.profile.id);
    assert.equal(reopened.getSnapshot().settings.profileId, DEFAULT_SOFT_PROOF_SETTINGS.profileId);
    assert.equal(reopened.getIccBytes(gray.profile.id), null);
    assert.equal((await repository.list()).length, 2);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

async function checkAtlas(): Promise<void> {
  const lut = await buildSoftProofLut({ kind: 'builtin', id: 'japan-color-2001-coated' }, DEFAULT_SOFT_PROOF_SETTINGS, { size: 17 });
  const atlas = packSoftProofAtlas(lut);
  assert.equal(atlas.length, 17 ** 3 * 4);
  let seed = 0x7f29bdaa;
  const color = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 0x100000000 * 255;
  };
  const compare = (r: number, g: number, b: number) => {
    const reference = sampleSoftProofLut(lut, r, g, b);
    const sampled = sampleSoftProofAtlas(atlas, lut.size, r, g, b);
    sampled.rgb.forEach((channel, i) => assert.ok(Math.abs(channel - reference.rgb[i]) <= 1));
    assert.ok(Math.abs(sampled.gamut - reference.gamut) <= 1 / 255);
  };
  compare(0, 0, 0);
  compare(255, 255, 255);
  compare(255, 65, 123);
  for (let i = 0; i < 300; i++) compare(color(), color(), color());
  for (const uniform of ['uLut', 'uLutSize', 'uProof', 'uGamut', 'uWarnColor']) {
    assert.match(SOFT_PROOF_FRAGMENT, new RegExp(`\\b${uniform}\\b`));
  }
}

function createFakeFilter() {
  const luts: Parameters<SoftProofFilterLike['setLut']>[0][] = [];
  const states: Parameters<SoftProofFilterLike['setState']>[0][] = [];
  let destroyed = 0;
  const filter: SoftProofFilterLike = {
    setLut: lut => { luts.push(lut); },
    setState: state => { states.push(state); },
    destroy: () => { destroyed++; },
  };
  return { filter, luts, states, get destroyed() { return destroyed; } };
}

async function checkController(): Promise<void> {
  const store = createTestStore();
  const original = { name: 'existing filter' };
  const target: { filters: unknown } = { filters: [original] };
  const fake = createFakeFilter();
  let renders = 0;
  const controller = new SoftProofController({
    target, store, requestRender: () => { renders++; }, createFilter: () => fake.filter, createWorker: () => null, lutSize: 9,
  });
  try {
    store.toggleEnabled();
    await controller.whenIdle();
    assert.equal(controller.getDebugState().builds, 1);
    assert.equal(store.getSnapshot().status.state, 'ready');
    assert.equal(fake.luts[0]?.size, 9);
    assert.equal(fake.states.at(-1)?.proof, true);
    assert.deepEqual(target.filters, [original, fake.filter]);

    store.update({ warningColor: '#010203' });
    store.toggleGamutWarning();
    store.toggleEnabled();
    await controller.whenIdle();
    assert.equal(controller.getDebugState().builds, 1);
    assert.deepEqual(fake.states.at(-1), { proof: false, gamutWarning: true, warningColor: [1 / 255, 2 / 255, 3 / 255] });

    store.update({ intent: 'perceptual' });
    await controller.whenIdle();
    assert.equal(controller.getDebugState().builds, 2);
    store.update({ profileId: 'builtin:fogra39' });
    await controller.whenIdle();
    assert.equal(controller.getDebugState().builds, 3);
    assert.equal(fake.luts.length, 3);

    store.toggleGamutWarning();
    assert.deepEqual(store.getSnapshot().status, { state: 'off' });
    assert.deepEqual(target.filters, [original]);
    store.toggleEnabled();
    await controller.whenIdle();
    assert.equal(controller.getDebugState().builds, 3);
    assert.deepEqual(target.filters, [original, fake.filter]);

    store.update({ profileId: 'icc:missing' });
    await controller.whenIdle();
    assert.deepEqual(store.getSnapshot().status, { state: 'error', code: 'missing_profile' });
    assert.deepEqual(target.filters, [original]);
    const embedOnly = await store.importProfile('embed.icc', iccWithoutDescription('RGB '));
    assert.ok(embedOnly.ok);
    store.update({ profileId: embedOnly.profile.id });
    await controller.whenIdle();
    assert.deepEqual(store.getSnapshot().status, { state: 'error', code: 'unsupported_profile' });
    assert.deepEqual(target.filters, [original]);

    store.update({ profileId: 'builtin:fogra39' });
    await controller.whenIdle();
    controller.dispose();
    const before = controller.getDebugState();
    const rendersBefore = renders;
    store.update({ enabled: false, gamutWarning: true, warningColor: '#FFE500' });
    await controller.whenIdle();
    assert.deepEqual(controller.getDebugState(), before);
    assert.deepEqual(target.filters, [original]);
    assert.equal(fake.destroyed, 1);
    assert.equal(renders, rendersBefore);
  } finally {
    controller.dispose();
  }
}

async function checkWorkerSwitches(): Promise<void> {
  const store = createTestStore();
  const target: { filters: unknown } = { filters: null };
  const fake = createFakeFilter();
  const jobs: Array<{ request: SoftProofWorkerRequest; finish: (result: SoftProofWorkerResult) => void; terminated: boolean }> = [];
  const controller = new SoftProofController({
    target, store, requestRender() {}, createFilter: () => fake.filter, lutSize: 9,
    createWorker() {
      const worker = {
        onmessage: null as ((event: Pick<MessageEvent<SoftProofWorkerResult>, 'data'>) => void) | null,
        postMessage(request: SoftProofWorkerRequest) {
          const receive = this.onmessage!;
          jobs.push({ request, finish: data => receive({ data }), terminated: false });
        },
        terminate() { jobs.at(-1)!.terminated = true; },
      };
      return worker as unknown as Worker;
    },
  });
  const finish = (job: typeof jobs[number], color: number) => {
    const data = new Uint8Array(job.request.size ** 3 * 4).fill(color);
    job.finish({ id: job.request.id, ok: true, size: job.request.size, data: data.buffer, buildMs: 1, label: 'test' });
  };
  try {
    store.toggleEnabled();
    const idle = controller.whenIdle();
    await Promise.resolve();
    const first = jobs[0];
    assert.deepEqual(store.getSnapshot().status, { state: 'building', progress: 0 });
    store.update({ profileId: 'builtin:fogra39' });
    assert.equal(first.terminated, true);
    await Promise.resolve();
    const current = jobs[1];
    assert.notEqual(first.request.id, current.request.id);
    finish(first, 1);
    finish(current, 2);
    await idle;
    assert.deepEqual(fake.luts.map(lut => lut.data[0]), [2]);
    assert.equal(controller.getDebugState().cacheSize, 1);

    store.update({ intent: 'perceptual' });
    await Promise.resolve();
    assert.deepEqual(target.filters, [fake.filter]);
    assert.deepEqual(fake.luts.map(lut => lut.data[0]), [2]);
    const fallback = jobs[2];
    fallback.finish({ id: fallback.request.id, ok: false, code: 'build_failed' });
    await controller.whenIdle();
    assert.equal(store.getSnapshot().status.state, 'ready');
    assert.equal(fake.luts.length, 2);
    assert.equal(controller.getDebugState().builds, 3);

    store.update({ intent: 'relative' });
    await controller.whenIdle();
    assert.equal(jobs.length, 3);
    for (const [profileId, intent] of [
      ['builtin:us-web-coated-swop', 'relative'],
      ['builtin:japan-color-2001-coated', 'perceptual'],
      ['builtin:us-web-coated-swop', 'perceptual'],
    ] as const) {
      store.update({ profileId, intent });
      await Promise.resolve();
      finish(jobs.at(-1)!, 3);
      await controller.whenIdle();
    }
    assert.equal(controller.getDebugState().cacheSize, 4);
    assert.equal(jobs.length, 6);
    store.update({ profileId: 'builtin:fogra39', intent: 'relative' });
    await controller.whenIdle();
    assert.equal(jobs.length, 6);
    store.update({ intent: 'perceptual' });
    await Promise.resolve();
    assert.equal(jobs.length, 7);
    controller.dispose();
    assert.equal(jobs[6].terminated, true);
    await controller.whenIdle();
    assert.equal(target.filters, null);
  } finally {
    controller.dispose();
  }
}

export async function runPhase8SoftProofRuntimeChecks(): Promise<void> {
  await checkStore();
  await checkAtlas();
  await checkController();
  await checkWorkerSwitches();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhase8SoftProofRuntimeChecks().then(() => console.log('ok'), (error) => { console.error(error); process.exit(1); });
}
