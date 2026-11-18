import assert from 'node:assert/strict';
import { translations, SUPPORTED_LANGUAGES, type Language, type Translations } from '../src/locales';
import { getLocalizedToolGroups, ALL_TOOLS } from '../src/components/workspace/toolCatalog';
import { getLocalizedBlendModeGroups } from '../src/components/LayerPanel';

console.log('--- Running i18n Verification & Quality Checks ---');

// 1. Verify all 4 required locales are registered and present
const REQUIRED_LOCALES: Language[] = ['zh-TW', 'zh-CN', 'en-US', 'ja-JP'];
assert.equal(SUPPORTED_LANGUAGES.length, 4, 'Should support exactly 4 languages');

for (const lang of REQUIRED_LOCALES) {
  assert.ok(translations[lang], `Locale ${lang} must exist in translations map`);
  assert.ok(SUPPORTED_LANGUAGES.some((item) => item.code === lang), `Locale ${lang} must be in SUPPORTED_LANGUAGES`);
}

// 2. Structural recursion check: verify all sections and keys are non-empty strings
function checkLeafValues(obj: Record<string, any>, path: string, lang: string): number {
  let count = 0;
  for (const [key, val] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    if (typeof val === 'object' && val !== null) {
      count += checkLeafValues(val, currentPath, lang);
    } else if (typeof val === 'string') {
      assert.ok(val.trim().length > 0, `[${lang}] String at '${currentPath}' must not be empty or whitespace`);
      count++;
    } else {
      assert.fail(`[${lang}] Value at '${currentPath}' must be a string or nested object, got: ${typeof val}`);
    }
  }
  return count;
}

const keyCounts: Record<Language, number> = {} as any;
for (const lang of REQUIRED_LOCALES) {
  const dict = translations[lang];
  keyCounts[lang] = checkLeafValues(dict, '', lang);
  console.log(`✓ ${lang} has ${keyCounts[lang]} verified translation keys`);
}

// 3. Parity check: all locales must have the exact same number of keys
const baselineCount = keyCounts['zh-TW'];
for (const lang of REQUIRED_LOCALES) {
  assert.equal(
    keyCounts[lang],
    baselineCount,
    `Key count mismatch: ${lang} has ${keyCounts[lang]} keys, expected ${baselineCount}`
  );
}

// 4. Parity check: all keys in zh-TW must exist in zh-CN, en-US, ja-JP and vice versa
function collectKeyPaths(obj: Record<string, any>, prefix = ''): string[] {
  let paths: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null) {
      paths = paths.concat(collectKeyPaths(v, p));
    } else {
      paths.push(p);
    }
  }
  return paths;
}

const baselinePaths = collectKeyPaths(translations['zh-TW']).sort();
for (const lang of REQUIRED_LOCALES) {
  const paths = collectKeyPaths(translations[lang]).sort();
  assert.deepEqual(paths, baselinePaths, `Key structure in ${lang} does not match zh-TW baseline`);
}
console.log(`✓ Exact key parity verified across all 4 locales (${baselinePaths.length} keys per locale)`);

// 5. Professional Art Terminology Checks
// 5a. 27 Blend Modes Verification
const BLEND_MODES = [
  'normal', 'darken', 'multiply', 'colorBurn', 'linearBurn', 'darkerColor',
  'lighten', 'screen', 'colorDodge', 'add', 'glow', 'lighterColor',
  'overlay', 'softLight', 'hardLight', 'vividLight', 'linearLight', 'pinLight', 'hardMix',
  'difference', 'exclusion', 'subtract', 'divide',
  'hue', 'saturation', 'color', 'luminosity'
] as const;

for (const lang of REQUIRED_LOCALES) {
  const dict = translations[lang];
  for (const mode of BLEND_MODES) {
    assert.ok(
      (dict.blendModes as any)[mode],
      `Blend mode '${mode}' must be defined in ${lang}`
    );
  }
}

// Check authentic terminology:
// zh-TW: 色彩增值, 覆蓋, 濾色, 變亮, 線性加深, 實光
assert.equal(translations['zh-TW'].blendModes.multiply, '色彩增值');
assert.equal(translations['zh-TW'].blendModes.screen, '濾色');
assert.equal(translations['zh-TW'].blendModes.overlay, '覆蓋');
assert.equal(translations['zh-TW'].blendModes.colorDodge, '顏色減淡');
assert.equal(translations['zh-TW'].blendModes.linearBurn, '線性加深');

// ja-JP: 乗算, スクリーン, オーバーレイ, 覆い焼きカラー, 焼き込みカラー (Clip Studio Paint native)
assert.equal(translations['ja-JP'].blendModes.multiply, '乗算');
assert.equal(translations['ja-JP'].blendModes.screen, 'スクリーン');
assert.equal(translations['ja-JP'].blendModes.overlay, 'オーバーレイ');
assert.equal(translations['ja-JP'].blendModes.colorDodge, '覆い焼きカラー');
assert.equal(translations['ja-JP'].blendModes.colorBurn, '焼き込みカラー');

// en-US: Multiply, Screen, Overlay, Color Dodge, Linear Burn
assert.equal(translations['en-US'].blendModes.multiply, 'Multiply');
assert.equal(translations['en-US'].blendModes.screen, 'Screen');
assert.equal(translations['en-US'].blendModes.overlay, 'Overlay');
assert.equal(translations['en-US'].blendModes.colorDodge, 'Color Dodge');

// zh-CN: 正片叠底, 滤色, 叠加, 颜色减淡, 线性加深
assert.equal(translations['zh-CN'].blendModes.multiply, '正片叠底');
assert.equal(translations['zh-CN'].blendModes.screen, '滤色');
assert.equal(translations['zh-CN'].blendModes.overlay, '叠加');
assert.equal(translations['zh-CN'].blendModes.colorDodge, '颜色减淡');
console.log('✓ Blend modes industry terminology verified (Photoshop / CSP / Krita)');

// 5b. Tool Catalog Localization Helper Verification
for (const lang of REQUIRED_LOCALES) {
  const t = translations[lang];
  const groups = getLocalizedToolGroups(t);
  assert.equal(groups.length, 5, `Should have 5 tool groups in ${lang}`);
  for (const group of groups) {
    assert.ok(group.label.length > 0, `Tool group label must be translated in ${lang}`);
    for (const tool of group.tools) {
      assert.ok(tool.label.length > 0, `Tool label for ${tool.id} must be translated in ${lang}`);
      assert.ok(tool.hint.length > 0, `Tool hint for ${tool.id} must be translated in ${lang}`);
    }
  }

  const blendGroups = getLocalizedBlendModeGroups(t);
  assert.equal(blendGroups.length, 6, `Should have 6 blend mode groups in ${lang}`);
  let totalModesInGroups = 0;
  for (const bg of blendGroups) {
    assert.ok(bg.category.length > 0, `Blend mode group category must not be empty in ${lang}`);
    totalModesInGroups += bg.items.length;
    for (const m of bg.items) {
      assert.ok(m.label.length > 0, `Blend mode label for ${m.value} must not be empty in ${lang}`);
    }
  }
  assert.equal(totalModesInGroups, 27, `Should group all 27 blend modes in ${lang}`);
}
console.log('✓ Tool groups and blend mode groups localized helpers verified');

// 5c. Specialized Modules Verification (Canvas resize, Comic, Animation, Rulers, Capsule, Admin, Auth)
for (const lang of REQUIRED_LOCALES) {
  const t = translations[lang];
  assert.ok(t.canvas.resizeTitle.length > 0);
  assert.ok(t.comic.studioTitle.length > 0);
  assert.ok(t.animation.timeline.length > 0);
  assert.ok(t.rulers.title.length > 0);
  assert.ok(t.capsule.title.length > 0);
  assert.ok(t.admin.title.length > 0);
  assert.ok(t.auth.titleLogin.length > 0);
  assert.ok(t.textEditor.editorAria.length > 0);
}
console.log('✓ Specialized modules localized strings verified across all 4 locales');

console.log('--- ALL i18n VERIFICATION CHECKS PASSED SUCCESSFULLY! ---');
