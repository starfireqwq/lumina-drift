import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DEFAULT_LAYER_TEXT } from '@atelier/shared';
import { getFontLabel, getTextFontPresetKey, TEXT_FONTS } from '../src/engine/textLayer';
import {
  deleteImportedFont, detectLocalFonts, filterFontGroups, importFontFile, probeLocalFonts, quoteFontFamily,
  restoreImportedFonts, subscribeFontLibrary, type ImportedFontEntry,
} from '../src/services/fontLibrary';

const sampleFile = (name: string, firstByte = 1) => ({
  name,
  arrayBuffer: async () => Uint8Array.of(firstByte, 0, 0, 0).buffer,
});
const faces = new Set<TestFontFace>();
let loads = 0;

class TestFontFace {
  constructor(readonly family: string, private readonly data: ArrayBuffer) {}

  async load() {
    loads++;
    if (new Uint8Array(this.data)[0] === 0) throw new Error('Could not decode font');
    return this;
  }
}

const baselines = { monospace: 100, 'sans-serif': 80, serif: 90 };
const measureWidth = (font: string) => {
  const base = baselines[font.split(' ').at(-1) as keyof typeof baselines];
  // This font matches one generic family. The other comparisons must still detect it.
  return font.includes('"Arial"') && font.endsWith('serif') && !font.endsWith('sans-serif') ? base + 10 : base;
};
const ctx = { font: '', measureText() { return { width: measureWidth(this.font) }; } };
Object.assign(globalThis, {
  FontFace: TestFontFace,
  document: { fonts: faces, createElement: () => ({ getContext: () => ctx }) },
});

function mockIndexedDB(saved: Map<string, ImportedFontEntry>) {
  let opened = false;
  const request = { result: {
    createObjectStore(name: string, options: { keyPath: string }) {
      assert.equal(name, 'fonts');
      assert.equal(options.keyPath, 'id');
      opened = true;
    },
    transaction(name: string, mode: IDBTransactionMode) {
      assert.ok(opened);
      assert.equal(name, 'fonts');
      const transaction = {
        oncomplete: () => {},
        objectStore(store: string) {
          assert.equal(store, name);
          const complete = <T>(value: T) => {
            queueMicrotask(() => transaction.oncomplete());
            return { result: value };
          };
          return {
            getAll: () => {
              assert.equal(mode, 'readonly');
              return complete(structuredClone([...saved.values()]));
            },
            put: (entry: ImportedFontEntry) => {
              assert.equal(mode, 'readwrite');
              saved.set(entry.id, structuredClone(entry));
              return complete(entry.id);
            },
            delete: (id: string) => {
              assert.equal(mode, 'readwrite');
              saved.delete(id);
              return complete(undefined);
            },
          };
        },
      };
      return transaction;
    },
  }, onupgradeneeded: () => {}, onsuccess: () => {} };
  return {
    open(name: string, version: number) {
      assert.equal(name, 'atelier-font-library');
      assert.equal(version, 1);
      queueMicrotask(() => {
        request.onupgradeneeded();
        request.onsuccess();
      });
      return request;
    },
  };
}

async function checkStorage() {
  const savedEntry: ImportedFontEntry = {
    id: 'saved', name: 'Saved Font', family: 'AtelierImported-saved', fileName: 'Saved Font.woff2',
    format: 'woff2', mimeType: 'font/woff2', data: await sampleFile('Saved Font.woff2').arrayBuffer(), addedAt: 1,
  };
  const saved = new Map([[savedEntry.id, savedEntry]]);
  Object.assign(globalThis, { indexedDB: mockIndexedDB(saved) });
  const restore = restoreImportedFonts();
  assert.equal(restoreImportedFonts(), restore);
  assert.deepEqual(await restore, [savedEntry]);
  assert.deepEqual(await restoreImportedFonts(), [savedEntry]);
  assert.equal(loads, 1);

  let notifications = 0;
  const unsubscribe = subscribeFontLibrary(() => { notifications++; });
  await assert.rejects(importFontFile({ name: 'fake.exe', arrayBuffer: () => assert.fail('Unsupported file was read') }), /unsupportedFormat/);
  await assert.rejects(importFontFile({ name: 'ttf', arrayBuffer: () => assert.fail('Missing extension was accepted') }), /unsupportedFormat/);
  await assert.rejects(importFontFile({ name: 'large.ttf', arrayBuffer: async () => new ArrayBuffer(32 * 1024 * 1024 + 1) }), /invalidSize/);
  await assert.rejects(importFontFile({ name: 'empty.otf', arrayBuffer: async () => new ArrayBuffer(0) }), /invalidSize/);
  await assert.rejects(importFontFile(sampleFile('invalid.ttf', 0)), /Could not decode font/);
  assert.equal(saved.size, 1);
  assert.equal(faces.size, 1);

  for (const format of ['ttf', 'otf', 'woff', 'woff2']) {
    const entry = await importFontFile(sampleFile(`New Font.${format.toUpperCase()}`));
    assert.equal(entry.name, 'New Font');
    assert.equal(entry.format, format);
    assert.equal(entry.mimeType, `font/${format}`);
    assert.deepEqual(saved.get(entry.id), entry);
    assert.ok((await restoreImportedFonts()).includes(entry));
    assert.ok([...faces].some((face) => face.family === entry.family));
    await deleteImportedFont(entry.id);
    assert.ok(!saved.has(entry.id));
    assert.ok(!(await restoreImportedFonts()).includes(entry));
    assert.ok(![...faces].some((face) => face.family === entry.family));
  }
  assert.equal(notifications, 8);
  unsubscribe();
  await deleteImportedFont(savedEntry.id);
  assert.equal(notifications, 8);
  assert.deepEqual(await restoreImportedFonts(), []);
  assert.equal(saved.size, 0);
  assert.equal(faces.size, 0);
}

async function checkLocalFonts() {
  assert.deepEqual(probeLocalFonts(measureWidth, ['Missing', 'Arial', 'Arial']), ['Arial']);
  let desktopScans = 0;
  let forceSeen = false;
  const host = {
    atelierDesktop: { fonts: { listLocal: async (force: boolean) => {
      desktopScans++;
      forceSeen = force;
      return [' Arial ', 'arial', '', 'Yu Gothic'];
    } } },
    queryLocalFonts: async () => assert.fail('Web enumeration took priority over desktop'),
  };
  Object.assign(globalThis, { window: host });
  const scan = detectLocalFonts();
  assert.equal(detectLocalFonts(), scan);
  assert.deepEqual(await scan, { source: 'desktop', families: ['Arial', 'Yu Gothic'] });
  await detectLocalFonts();
  assert.equal(desktopScans, 1);
  await detectLocalFonts({ force: true });
  assert.equal(desktopScans, 2);
  assert.equal(forceSeen, true);

  host.atelierDesktop.fonts.listLocal = async () => [];
  Object.assign(host, { queryLocalFonts: async () => [{ family: 'Noto Sans TC' }, { family: 'Noto Sans TC' }] });
  assert.deepEqual(await detectLocalFonts({ force: true }), { source: 'web', families: ['Noto Sans TC'] });
  Object.assign(host, { queryLocalFonts: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); } });
  assert.deepEqual(await detectLocalFonts({ force: true }), { source: 'canvas', families: ['Arial'] });
}

async function main() {
  if (process.argv.includes('--memory-only')) {
    Object.assign(globalThis, { indexedDB: undefined });
    const entry = await importFontFile(sampleFile('Memory.ttf'));
    assert.deepEqual(await restoreImportedFonts(), [entry]);
    await deleteImportedFont(entry.id);
    assert.deepEqual(await restoreImportedFonts(), []);
    assert.equal(faces.size, 0);
    return;
  }
  assert.equal(TEXT_FONTS.length, 14);
  assert.equal(TEXT_FONTS[0].id, DEFAULT_LAYER_TEXT.fontFamily);
  assert.equal(new Set(TEXT_FONTS.map((font) => font.id)).size, 14);
  for (const category of ['mono', 'handwriting', 'comic', 'rounded', 'kai', 'display']) {
    assert.ok(TEXT_FONTS.some((font) => font.category === category));
  }
  for (const family of ['Noto Sans TC', 'Noto Sans SC', 'Noto Sans JP', 'Georgia']) {
    assert.ok(TEXT_FONTS.some((font) => font.id.includes(family)));
  }
  assert.equal(getTextFontPresetKey(DEFAULT_LAYER_TEXT.fontFamily), 'system');
  assert.equal(getFontLabel(DEFAULT_LAYER_TEXT.fontFamily), '系統黑體');
  assert.equal(getFontLabel('sans-serif'), 'sans-serif');
  assert.equal(getFontLabel(`${quoteFontFamily('One, "Two"')}, serif`), 'One, "Two"');
  const groups = filterFontGroups('  nOtO  ', {
    imported: [{ name: 'Custom', fileName: 'Noto Custom.woff', family: 'custom' }],
    presets: TEXT_FONTS,
    local: ['Arial', 'Noto Sans TC'],
  });
  assert.equal(groups.imported.length, 1);
  assert.ok(groups.presets.length > 0 && groups.presets.every((font) => font.id.includes('Noto')));
  assert.deepEqual(groups.local, ['Noto Sans TC']);
  assert.deepEqual(filterFontGroups('no match', groups), { imported: [], presets: [], local: [] });
  await checkStorage();
  await checkLocalFonts();
  const memory = spawnSync(process.execPath, [...process.execArgv, process.argv[1], '--memory-only'], { encoding: 'utf8' });
  assert.equal(memory.status, 0, memory.stderr || memory.error?.message);
  console.log('Font library checks passed');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
