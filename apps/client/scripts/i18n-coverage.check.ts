import assert from 'node:assert/strict';
import { translations, SUPPORTED_LANGUAGES, type Language, type Translations } from '../src/locales';
import { ALL_SUB_TOOLS, getLocalizedCategoryLabel, getLocalizedSubTool, getLocalizedToolGroups, TOOL_CATEGORIES } from '../src/components/workspace/toolCatalog';
import { getLocalizedBlendModeGroups } from '../src/components/LayerPanel';
import { BUILTIN_FILTERS, FILTER_GROUPS, filterGroupLabel, filterLabel, filterParamLabel } from '../src/utils/filterRegistry';
import { PLUGIN_PERMISSIONS_V1, PLUGIN_PERMISSIONS_V2 } from '../src/plugins/pluginApi';
import { getPluginLabels, getPluginPermissionLabel } from '../src/plugins/pluginLabels';

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

  const categorySizes = { fill: 5, select: 7, vector: 6, blend: 3, comic: 5 };
  for (const [categoryId, size] of Object.entries(categorySizes)) {
    const category = TOOL_CATEGORIES.find(({ id }) => id === categoryId);
    assert.ok(category, `Missing ${categoryId} category in ${lang}`);
    assert.equal(category.subTools.length, size, `Expected ${size} ${categoryId} sub-tools in ${lang}`);
    const labels = category.subTools.map(({ id }) => {
      const label = getLocalizedSubTool(id, t).label.trim();
      assert.ok(label, `Sub-tool ${id} label must be translated in ${lang}`);
      return label;
    });
    assert.equal(new Set(labels).size, size, `${categoryId} sub-tools must have distinct labels in ${lang}`);
  }
  for (const { id } of TOOL_CATEGORIES) {
    assert.ok(getLocalizedCategoryLabel(id, t).trim(), `Category ${id} must be translated in ${lang}`);
  }
  for (const { id } of ALL_SUB_TOOLS) {
    const { label, hint } = getLocalizedSubTool(id, t);
    assert.ok(label.trim(), `Sub-tool ${id} label must be translated in ${lang}`);
    assert.ok(hint.trim(), `Sub-tool ${id} hint must be translated in ${lang}`);
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
console.log('✓ Tool groups, categories, sub-tools and blend mode groups localized helpers verified');

// 5c. Specialized Modules Verification, including the Phase 5 drawing tools.
const quickShapeSettingKeys = [
  'quickShapeTitle', 'quickShapeEnabled', 'quickShapeEnabledDesc', 'quickShapeDelayLabel', 'quickShapeDelayDesc',
] as const;
const quickShapeKinds = ['line', 'arc', 'circle', 'ellipse', 'rectangle', 'quadrilateral', 'triangle'] as const;
const puppetWarpKeys = [
  'title', 'mode', 'perspective', 'parallel', 'free', 'density', 'coarse', 'normal', 'dense',
  'showMesh', 'pin', 'rotation', 'weight', 'deletePin', 'shortcutDesc', 'renderFailed',
] as const;
const unresolvedToken = /\{[^{}]+\}|%[sd]|\b(?:TODO|TBD|FIXME|PLACEHOLDER|TRANSLATE)\b/i;
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

  const checkPhase5Label = (path: string, value: string) => {
    assert.ok(typeof value === 'string' && value.trim(), `[${lang}] Missing Phase 5 label '${path}'`);
    assert.doesNotMatch(value, unresolvedToken, `[${lang}] Unresolved placeholder in '${path}'`);
    assert.notEqual(value.trim(), path, `[${lang}] Translation key displayed as the label for '${path}'`);
  };
  for (const key of quickShapeSettingKeys) checkPhase5Label(`settings.${key}`, t.settings[key]);
  checkPhase5Label('canvas.quickShapeHint', t.canvas.quickShapeHint);
  for (const kind of quickShapeKinds) checkPhase5Label(`canvas.quickShapeKinds.${kind}`, t.canvas.quickShapeKinds[kind]);
  assert.equal(new Set(quickShapeKinds.map((kind) => t.canvas.quickShapeKinds[kind].trim())).size,
    quickShapeKinds.length, `[${lang}] QuickShape names must be distinct`);
  for (const key of puppetWarpKeys) checkPhase5Label(`puppetWarp.${key}`, t.puppetWarp[key]);
  for (const key of ['wrapAround', 'wrapAroundHint'] as const) checkPhase5Label(`canvas.${key}`, t.canvas[key]);
  for (const key of ['shortcutWrapAroundName', 'shortcutWrapAroundDesc'] as const) {
    checkPhase5Label(`settings.${key}`, t.settings[key]);
  }
}
console.log('✓ Specialized modules localized strings verified across all 4 locales');

// 5d. Filter registry: every group, filter and parameter name resolves in every locale
for (const lang of REQUIRED_LOCALES) {
  const t = translations[lang];
  for (const group of FILTER_GROUPS) assert.ok(filterGroupLabel(group, t)?.trim(), `Filter group '${group}' needs a name in ${lang}`);
  for (const def of BUILTIN_FILTERS) {
    assert.ok(filterLabel(def, t)?.trim(), `Filter '${def.id}' needs a name in ${lang}`);
    for (const param of def.params) {
      assert.ok(filterParamLabel(param, t)?.trim(), `Parameter '${def.id}.${param.key}' needs a name in ${lang}`);
      if (param.kind === 'select') for (const option of param.options) assert.ok(filterParamLabel(option, t)?.trim(), `Option '${def.id}.${option.value}' needs a name in ${lang}`);
    }
    if (def.hint) assert.ok(t.filters[def.hint].trim(), `Filter '${def.id}' hint needs text in ${lang}`);
  }
}
console.log('✓ Filter groups, names and parameters localized across all 4 locales');

// 5e. Plugin API v1/v2 labels and permission descriptions across all 4 locales
const pluginBaselineKeys = Object.keys(getPluginLabels('en-US')).sort();
for (const lang of REQUIRED_LOCALES) {
  const pl = getPluginLabels(lang);
  assert.deepEqual(Object.keys(pl).sort(), pluginBaselineKeys, `Plugin labels keys mismatch in ${lang}`);
  for (const [k, v] of Object.entries(pl)) {
    assert.ok(typeof v === 'string' && v.trim().length > 0, `Plugin label '${k}' must not be empty in ${lang}`);
  }
  for (const perm of [...PLUGIN_PERMISSIONS_V1, ...PLUGIN_PERMISSIONS_V2]) {
    assert.ok(getPluginPermissionLabel(lang, perm).trim().length > 0, `Permission '${perm}' needs label in ${lang}`);
  }
}
console.log('✓ Plugin v1/v2 labels and permissions verified across all 4 locales');

// 8. Phase 3 shortcut headings and tool option labels.
const phase3ToolOptionKeys = ['vectorPartial', 'selectionAntialias', 'selectionFeatherRadius', 'polygonFinish', 'polygonCancel'] as const;
for (const lang of REQUIRED_LOCALES) {
  const { settings, toolOptions } = translations[lang];
  const categoryLabel = settings.shortcutCatToolCategories.trim();
  const subToolLabel = settings.shortcutCatSubTools.trim();
  assert.ok(categoryLabel, `settings.shortcutCatToolCategories must be translated in ${lang}`);
  assert.ok(subToolLabel, `settings.shortcutCatSubTools must be translated in ${lang}`);
  assert.notEqual(categoryLabel, subToolLabel, `Shortcut headings must be distinct in ${lang}`);
  for (const key of phase3ToolOptionKeys) {
    assert.ok(toolOptions[key].trim(), `toolOptions.${key} must be translated in ${lang}`);
  }
}

// Phase 4 shortcut labels and the pop-up palette's shortcut placeholder.
const phase4Labels = (t: Translations) => [
  t.subView.title, t.studio.popupPaletteTitle, t.settings.shortcutSubViewDesc, t.settings.shortcutPopupPaletteDesc,
];
const englishPhase4Labels = phase4Labels(translations['en-US']);
for (const lang of REQUIRED_LOCALES) {
  const t = translations[lang];
  assert.match(t.settings.popupPaletteShortcutHint, /\{shortcut\}/, `Missing pop-up shortcut placeholder in ${lang}`);
  if (lang !== 'en-US') {
    phase4Labels(t).forEach((label, index) => {
      assert.notEqual(label, englishPhase4Labels[index], `Untranslated Phase 4 shortcut text in ${lang}`);
    });
  }
}

console.log('--- ALL i18n VERIFICATION CHECKS PASSED SUCCESSFULLY! ---');
