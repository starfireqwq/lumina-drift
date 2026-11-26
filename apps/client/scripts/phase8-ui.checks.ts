import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { translations, type Language, type Translations } from '../src/locales';
import { getHelpTopics, getKraExportHelpTopic, getSoftProofHelpTopic } from '../src/components/help/helpContent';
import {
  hasAdjustmentLayers, ICC_EMBED_FORMATS, normalizeIccEmbedValue, resolveIccEmbedChoice,
  softProofErrorText, softProofProfileTestId, softProofStatusText,
} from '../src/components/phase8Ui';
import { createSrgbIccProfile } from '../src/engine/color/iccProfile';

const LANGS: Language[] = ['zh-TW', 'zh-CN', 'en-US', 'ja-JP'];

function leaves(value: unknown, path: string, out: Array<[string, unknown]>): void {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) leaves(child, path ? `${path}.${key}` : key, out);
  } else {
    out.push([path, value]);
  }
}

function checkIccEmbedChoice(): void {
  const rgb = [{ id: 'icc:abc123', label: 'Display P3', bytes: Uint8Array.of(1, 2, 3) }];
  assert.equal(normalizeIccEmbedValue(null, rgb), 'none');
  assert.equal(normalizeIccEmbedValue('srgb', rgb), 'srgb');
  assert.equal(normalizeIccEmbedValue('icc:abc123', rgb), 'icc:abc123');
  assert.equal(normalizeIccEmbedValue('icc:gone', rgb), 'none', 'a removed profile falls back to none');
  assert.equal(normalizeIccEmbedValue(42, rgb), 'none');

  assert.equal(resolveIccEmbedChoice('none', rgb), null);
  const srgb = resolveIccEmbedChoice('srgb', rgb);
  assert.equal(srgb?.name, 'sRGB IEC61966-2.1');
  assert.deepEqual(srgb?.bytes, createSrgbIccProfile());
  assert.deepEqual(resolveIccEmbedChoice('icc:abc123', rgb), { name: 'Display P3', bytes: rgb[0].bytes });
  assert.equal(resolveIccEmbedChoice('icc:gone', rgb), null);

  assert.deepEqual([...ICC_EMBED_FORMATS].sort(), ['jpeg', 'merged_png', 'psd', 'transparent_png']);
  assert.equal(ICC_EMBED_FORMATS.has('kra'), false);
  assert.equal(hasAdjustmentLayers([{ layerType: 'raster' }, { layerType: 'group' }]), false);
  assert.equal(hasAdjustmentLayers([{ layerType: 'raster' }, { layerType: 'adjustment' }]), true);
  assert.equal(softProofProfileTestId('builtin:fogra39'), 'soft-proof-profile-builtin-fogra39');
  assert.equal(softProofProfileTestId('icc:0f1e'), 'soft-proof-profile-icc-0f1e');
}

function checkLocales(): void {
  const reference: Array<[string, unknown]> = [];
  const pick = (t: Translations) => ({ navbarView: t.navbar.view, softProof: t.softProof, export: t.export });
  leaves(pick(translations['zh-TW']), '', reference);
  const keys = reference.map(([key]) => key).filter((key) => /^(navbarView|softProof\.|export\.(kra|icc))/.test(key));
  assert.ok(keys.length >= 45, `expected the Phase 8 keys, got ${keys.length}`);
  for (const lang of LANGS) {
    const t = translations[lang];
    const found = new Map<string, unknown>();
    const list: Array<[string, unknown]> = [];
    leaves(pick(t), '', list);
    for (const [key, value] of list) found.set(key, value);
    for (const key of keys) {
      const value = found.get(key);
      assert.ok(typeof value === 'string' && value.trim().length > 0, `[${lang}] ${key} must be a non-empty string`);
    }
    assert.ok(t.export.iccAssign.includes('{name}'), `[${lang}] iccAssign keeps its {name} placeholder`);
    assert.ok(t.export.iccAssign.replace('{name}', 'Display P3').includes('Display P3'));

    assert.equal(softProofStatusText({ state: 'off' }, t), t.softProof.status.off);
    assert.equal(softProofStatusText({ state: 'ready', buildMs: 10, lutSize: 33 }, t), t.softProof.status.ready);
    assert.ok(softProofStatusText({ state: 'error', code: 'missing_profile' }, t).includes(t.softProof.errors.missing_profile));
    assert.equal(softProofErrorText('too_large', t), t.softProof.errors.too_large);
    assert.equal(softProofErrorText('nonsense', t), t.softProof.errors.parse_failed);

    const ids = getHelpTopics(t).map((topic) => topic.id);
    assert.ok(ids.includes('soft-proof') && ids.includes('kra-export'), `[${lang}] help topics`);
    const proof = getSoftProofHelpTopic(t);
    assert.equal(proof.category, 'files');
    assert.ok(proof.keywords.includes('CMYK') && proof.keywords.includes('FOGRA39'));
    assert.ok((proof.steps ?? []).every((step) => step.trim().length > 0));
    const kra = getKraExportHelpTopic(t);
    assert.ok(kra.keywords.includes('Krita') && (kra.steps ?? []).length === 4);
  }
}

export async function runPhase8UiChecks(): Promise<void> {
  checkIccEmbedChoice();
  checkLocales();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhase8UiChecks().then(() => console.log('ok'), (e) => { console.error(e); process.exit(1); });
}
