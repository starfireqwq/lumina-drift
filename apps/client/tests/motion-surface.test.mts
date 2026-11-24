import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  applyMotionMode,
  DEFAULT_MOTION_MODE,
  getEffectiveMotion,
  getMotionMode,
  isReducedMotion,
  MOTION_MODE_STORAGE_KEY,
  normalizeMotionMode,
  resolveEffectiveMotion,
  setMotionMode,
  subscribeMotionChange,
  syncMotionFromEnvironment,
  type MotionMode,
} from '../src/theme/motion.ts';
import {
  applySurfaceStyle,
  applyTheme,
  contrastRatio,
  DEFAULT_CUSTOM_THEME,
  DEFAULT_SURFACE_STYLE,
  isSurfaceStyle,
  loadSurfaceStyle,
  resolveTheme,
  saveSurfaceStyle,
  SURFACE_STYLE_KEY,
  SURFACE_STYLES,
  THEME_PRESETS,
  type SurfaceStyle,
  type ThemeId,
} from '../src/theme/themes.ts';

function installDomMock(initialStorage: Record<string, string> = {}, initialReduced = false) {
  const prevWindow = (globalThis as any).window;
  const prevDocument = (globalThis as any).document;
  const prevStorage = (globalThis as any).localStorage;

  const store = new Map<string, string>(Object.entries(initialStorage));
  const localStorageMock = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };

  const classes = new Set<string>();
  const styleProps = new Map<string, string>();
  const rootEl = {
    dataset: {} as Record<string, string>,
    style: {
      colorScheme: '',
      setProperty: (k: string, v: string) => { styleProps.set(k, v); },
      getPropertyValue: (k: string) => styleProps.get(k) ?? '',
    },
    classList: {
      toggle: (name: string, force?: boolean) => {
        const next = force ?? !classes.has(name);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
      contains: (name: string) => classes.has(name),
    },
  };

  let reduced = initialReduced;
  const changeListeners = new Set<(event: { matches: boolean }) => void>();
  const mql = {
    get matches() { return reduced; },
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_type: string, fn: (event: { matches: boolean }) => void) => { changeListeners.add(fn); },
    removeEventListener: (_type: string, fn: (event: { matches: boolean }) => void) => { changeListeners.delete(fn); },
    addListener: (fn: (event: { matches: boolean }) => void) => { changeListeners.add(fn); },
    removeListener: (fn: (event: { matches: boolean }) => void) => { changeListeners.delete(fn); },
  };

  (globalThis as any).localStorage = localStorageMock;
  (globalThis as any).document = { documentElement: rootEl };
  (globalThis as any).window = {
    matchMedia: (query: string) => {
      assert.equal(query, '(prefers-reduced-motion: reduce)');
      return mql;
    },
  };

  return {
    rootEl,
    store,
    styleProps,
    classes,
    setSystemReduced: (next: boolean) => {
      reduced = next;
      for (const fn of changeListeners) fn({ matches: next });
    },
    restore: () => {
      if (prevWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
      if (prevDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = prevDocument;
      if (prevStorage === undefined) delete (globalThis as any).localStorage;
      else (globalThis as any).localStorage = prevStorage;
      syncMotionFromEnvironment();
    },
  };
}

test('resolveEffectiveMotion resolves all 6 mode × OS reduced-motion combinations', () => {
  const cases: Array<[MotionMode, boolean, 'on' | 'off']> = [
    ['on', false, 'on'],
    ['on', true, 'on'],
    ['auto', false, 'on'],
    ['auto', true, 'off'],
    ['off', false, 'off'],
    ['off', true, 'off'],
  ];
  for (const [mode, sysReduced, expected] of cases) {
    assert.equal(resolveEffectiveMotion(mode, sysReduced), expected);
  }
  assert.equal(normalizeMotionMode('invalid-value'), DEFAULT_MOTION_MODE);
  assert.equal(normalizeMotionMode(null), 'on');
});

test('motion.ts defaults to "on" even when OS prefers reduced motion and ignores corrupted storage', () => {
  const mock = installDomMock({ [MOTION_MODE_STORAGE_KEY]: 'corrupted-mode' }, true);
  try {
    const effective = syncMotionFromEnvironment();
    assert.equal(getMotionMode(), 'on');
    assert.equal(effective, 'on');
    assert.equal(getEffectiveMotion(), 'on');
    assert.equal(isReducedMotion(), false);
    assert.equal(mock.rootEl.dataset.motion, 'on');
    assert.equal(mock.rootEl.dataset.motionMode, 'on');
  } finally {
    mock.restore();
  }
});

test('motion.ts persists mode changes, reacts to matchMedia in auto mode only, and notifies subscribers', () => {
  const mock = installDomMock({}, false);
  try {
    syncMotionFromEnvironment();
    let notifications = 0;
    const unsubscribe = subscribeMotionChange(() => { notifications += 1; });

    setMotionMode('auto');
    assert.equal(mock.store.get(MOTION_MODE_STORAGE_KEY), 'auto');
    assert.equal(mock.rootEl.dataset.motionMode, 'auto');
    assert.equal(mock.rootEl.dataset.motion, 'on');
    assert.equal(notifications, 1);

    mock.setSystemReduced(true);
    assert.equal(mock.rootEl.dataset.motion, 'off');
    assert.equal(isReducedMotion(), true);
    assert.equal(notifications, 2);

    mock.setSystemReduced(false);
    assert.equal(mock.rootEl.dataset.motion, 'on');
    assert.equal(isReducedMotion(), false);
    assert.equal(notifications, 3);

    setMotionMode('off');
    assert.equal(mock.store.get(MOTION_MODE_STORAGE_KEY), 'off');
    assert.equal(mock.rootEl.dataset.motion, 'off');
    mock.setSystemReduced(false);
    assert.equal(mock.rootEl.dataset.motion, 'off');

    setMotionMode('on');
    assert.equal(mock.store.get(MOTION_MODE_STORAGE_KEY), 'on');
    assert.equal(mock.rootEl.dataset.motion, 'on');
    mock.setSystemReduced(true);
    assert.equal(mock.rootEl.dataset.motion, 'on');
    assert.equal(applyMotionMode('on'), 'on');

    unsubscribe();
  } finally {
    mock.restore();
  }
});

test('themes.ts defines exactly 6 surface styles and safely handles storage/SSR edge cases', () => {
  const expected: SurfaceStyle[] = ['solid', 'liquid-glass', 'chromatic-glass', 'frosted-matte', 'lumina-glow', 'soft-paper'];
  assert.deepEqual(SURFACE_STYLES.map((s) => s.id), expected);
  assert.equal(DEFAULT_SURFACE_STYLE, 'solid');
  assert.equal(isSurfaceStyle('liquid-glass'), true);
  assert.equal(isSurfaceStyle('chromatic-glass'), true);
  assert.equal(isSurfaceStyle('glassmorphism-unknown'), false);

  // Safe no-op without document/localStorage
  applySurfaceStyle('lumina-glow');
  assert.equal(loadSurfaceStyle(), 'solid');

  const mock = installDomMock({ [SURFACE_STYLE_KEY]: 'invalid-surface' }, false);
  try {
    assert.equal(loadSurfaceStyle(), 'solid');

    for (const style of expected) {
      saveSurfaceStyle(style);
      assert.equal(mock.store.get(SURFACE_STYLE_KEY), style);
      assert.equal(loadSurfaceStyle(), style);
    }

    // Throwing storage falls back to 'solid'
    (globalThis as any).localStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    assert.equal(loadSurfaceStyle(), 'solid');
    assert.doesNotThrow(() => saveSurfaceStyle('soft-paper'));
  } finally {
    mock.restore();
  }
});

test('applyTheme and applySurfaceStyle support all 7 themes x 6 surface styles without overwriting each other', () => {
  const mock = installDomMock({}, false);
  try {
    const themeIds: ThemeId[] = [...THEME_PRESETS.map((p) => p.id), 'custom'];
    const surfaceIds: SurfaceStyle[] = SURFACE_STYLES.map((s) => s.id);
    assert.equal(themeIds.length * surfaceIds.length, 42);

    for (const surfaceId of surfaceIds) {
      for (const themeId of themeIds) {
        applyTheme(themeId, DEFAULT_CUSTOM_THEME, surfaceId);
        assert.equal(mock.rootEl.dataset.theme, themeId);
        assert.equal(mock.rootEl.dataset.surface, surfaceId);

        const resolved = resolveTheme(themeId, DEFAULT_CUSTOM_THEME);
        const expectLight = resolved.base === 'light';
        assert.equal(mock.rootEl.classList.contains('light'), expectLight);
        assert.equal(mock.rootEl.classList.contains('dark'), !expectLight);
        assert.ok(mock.styleProps.get('--workspace-bg')?.startsWith('rgb('));
        assert.ok((mock.styleProps.get('--n-900') ?? '').split(' ').length === 3);
        assert.ok((mock.styleProps.get('--a-500') ?? '').split(' ').length === 3);
      }

      // Calling applyTheme without surface preserves current dataset.surface (custom color drag behavior)
      applyTheme('custom', { ...DEFAULT_CUSTOM_THEME, accent: '#ec4899' });
      assert.equal(mock.rootEl.dataset.surface, surfaceId);
    }
  } finally {
    mock.restore();
  }
});

test('index.css enforces motion decoupling and strictly isolates canvas containers from surface effects', () => {
  const cssPath = path.resolve(import.meta.dirname, '..', 'src', 'index.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  assert.equal(/@media\s*\(\s*prefers-reduced-motion/i.test(css), false,
    'index.css must not bind animations directly to @media (prefers-reduced-motion)');
  assert.ok(css.includes('html[data-motion="on"]'), 'index.css must define html[data-motion="on"] rules');
  assert.ok(css.includes('html[data-motion="off"]'), 'index.css must define html[data-motion="off"] rules');
  assert.ok(css.includes('@keyframes atelierVoiceWave'), 'index.css must define @keyframes atelierVoiceWave');

  // Verify no [data-surface] selector targets canvas workspace/viewport/surface
  const surfaceLines = css
    .split(/\r?\n/)
    .filter((line) => line.includes('[data-surface'));
  assert.ok(surfaceLines.length >= 5, 'Expected [data-surface] rules in index.css');
  for (const line of surfaceLines) {
    assert.equal(/\.atelier-(workspace|canvas-viewport|canvas-surface)/.test(line), false,
      `Canvas container must never appear in [data-surface] selector: ${line}`);
  }

  // Verify canvas rules themselves do not introduce backdrop-filter / box-shadow / filter
  const canvasRuleMatches = css.match(/\.atelier-(workspace|canvas-viewport|canvas-surface)[^{]*\{[^}]*\}/g) ?? [];
  assert.ok(canvasRuleMatches.length > 0, 'Expected canvas rules in index.css');
  for (const rule of canvasRuleMatches) {
    assert.equal(/backdrop-filter|box-shadow|(?<!-)filter\s*:/i.test(rule), false,
      `Canvas rule must remain free of backdrop-filter/box-shadow/filter: ${rule}`);
  }
});

test('index.css defines paired dark/light rules for all 6 surface styles, chromatic RGB flow, and keeps lumina-glow light header readable', () => {
  const cssPath = path.resolve(import.meta.dirname, '..', 'src', 'index.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  assert.ok(css.includes('@property --atelier-rgb-angle'), 'index.css must register --atelier-rgb-angle @property');
  assert.ok(css.includes('@keyframes atelierChromaticFlow'), 'index.css must define @keyframes atelierChromaticFlow');
  assert.ok(css.includes('html[data-surface="chromatic-glass"][data-motion="on"]'),
    'chromatic-glass RGB animation must be gated by html[data-motion="on"]');

  for (const surface of SURFACE_STYLES) {
    const darkRe = new RegExp(`html\\[data-surface="${surface.id}"\\]\\s*\\{([\\s\\S]*?)\\}`);
    const lightRe = new RegExp(`html\\.light\\[data-surface="${surface.id}"\\]\\s*\\{([\\s\\S]*?)\\}`);
    assert.ok(darkRe.test(css), `index.css must define html[data-surface="${surface.id}"]`);
    assert.ok(lightRe.test(css), `index.css must define html.light[data-surface="${surface.id}"]`);
  }

  const luminaLightMatch = css.match(/html\.light\[data-surface="lumina-glow"\]\s*\{([\s\S]*?)\}/);
  assert.ok(luminaLightMatch, 'Expected html.light[data-surface="lumina-glow"] block');
  const luminaHeaderDecl = luminaLightMatch[1].match(/--surface-header-bg\s*:\s*([^;]+);/);
  assert.ok(luminaHeaderDecl, 'Expected --surface-header-bg in html.light[data-surface="lumina-glow"]');
  assert.equal(/--a-50\b/.test(luminaHeaderDecl[1]), false,
    `html.light[data-surface="lumina-glow"] must not use flipped dark --a-50 for --surface-header-bg: ${luminaHeaderDecl[1]}`);
  assert.ok(/--a-950\b/.test(luminaHeaderDecl[1]),
    `html.light[data-surface="lumina-glow"] should use light --a-950 for --surface-header-bg: ${luminaHeaderDecl[1]}`);

  // Verify computed WCAG contrast >= 4.5:1 across all light presets when composited over --n-900
  const parseChannels = (s: string) => s.trim().split(/\s+/).map(Number) as [number, number, number];
  const toHex = (rgb: [number, number, number]) =>
    `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

  for (const preset of THEME_PRESETS.filter((p) => p.base === 'light')) {
    const { vars } = resolveTheme(preset.id, DEFAULT_CUSTOM_THEME);
    const a950 = parseChannels(vars['--a-950']);
    const n900 = parseChannels(vars['--n-900']);
    const alphaMatch = luminaHeaderDecl[1].match(/\/\s*(\.?\d+(?:\.\d+)?)/);
    const alpha = alphaMatch ? Number(alphaMatch[1]) : 1;
    const headerBg: [number, number, number] = [
      a950[0] * alpha + n900[0] * (1 - alpha),
      a950[1] * alpha + n900[1] * (1 - alpha),
      a950[2] * alpha + n900[2] * (1 - alpha),
    ];
    const headerHex = toHex(headerBg);
    for (const fgVar of ['--n-200', '--n-300'] as const) {
      const fgHex = toHex(parseChannels(vars[fgVar]));
      const ratio = contrastRatio(fgHex, headerHex);
      assert.ok(ratio >= 4.5, `Expected ${preset.id} lumina-glow header contrast (${fgVar}) >= 4.5, got ${ratio.toFixed(2)}`);
    }
  }
});
