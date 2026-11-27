import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidElement } from 'react';
import {
  dockActions,
  getDockLayout,
  getFloatGroupState,
  loadDockLayout,
  type PanelId,
} from '../src/components/workspace/dockStore';
import { getPanelDisplayTitle, PANEL_ICON_COMPONENTS, renderPanelIcon } from '../src/components/workspace/panelIcons';
import { translations, type Language } from '../src/locales';

const allPanelIds: readonly PanelId[] = [
  'navigator', 'color', 'subView', 'autoActions', 'brushToolset', 'toolProps', 'layers',
  'members', 'oplog', 'quickKeys', 'filters', 'align',
];

const dockLabels = [
  'dockRight', 'dockLeft', 'dockBottom', 'floatWindow', 'panelPosition', 'dockOrFloat', 'mergeAsTab',
  'detachWindow', 'hidePanel', 'hideTab', 'hidePanelHint', 'dragPanelHint', 'dragFloatHeaderHint',
  'dragTabDetachHint', 'windowTabsAria', 'minimizeToPill', 'switchToVertical', 'switchToHorizontal',
  'dragPillHint', 'dropCancel', 'dropDockLeft', 'dropDockRight', 'dropDockBottom', 'dropMergeTab',
  'dropFloat', 'dropRailLeft', 'dropRailRight', 'dropMergePill', 'dropDetachPill', 'dropGroupMergeTab',
  'dropGroupMergePill', 'dropGroupDockLeft', 'dropGroupDockRight', 'dropGroupDockBottom',
] as const;

const dockTemplates = {
  expandPanel: '{title}',
  collapsePanel: '{title}',
  expandFromPill: '{title}',
  dragPillIconHint: '{title}',
  pillGroupAria: '{titles}',
} as const;

function checkLayoutStorage() {
  const { floatGroups, ...base } = loadDockLayout({ getItem: () => null });
  assert.deepEqual(floatGroups, {});

  const version4 = {
    ...base,
    version: 4,
    panels: {
      ...base.panels,
      layers: {
        ...base.panels.layers,
        place: 'float', collapsed: true, weight: 1.7, group: 'painting',
        float: { x: 123, y: 87, w: 360, h: 490 },
      },
      color: {
        ...base.panels.color,
        place: 'float', visible: false, weight: 1.6, group: 'painting',
        float: { x: 213, y: 143, w: 321, h: 850 },
      },
    },
    order: ['layers', ...base.order.filter((id) => id !== 'layers')],
    dockSize: { left: 314, right: 357, bottom: 224 },
    activeTab: { painting: 'layers' },
    desktopMode: true,
    railSide: 'right',
    slidersWidth: 80,
    toolRailWidth: 110,
  };

  const migrated = loadDockLayout({ getItem: () => JSON.stringify(version4) });
  assert.deepEqual(migrated, { ...version4, version: 5, floatGroups: {} });

  const { navigator, ...legacyPanels } = version4.panels;
  for (const version of [4, 5]) {
    const legacyOrder = version4.order.filter((id) => id !== 'navigator');
    const legacy = { ...version4, version, panels: legacyPanels, order: legacyOrder };
    const withNavigator = loadDockLayout({ getItem: () => JSON.stringify(legacy) });
    assert.deepEqual(withNavigator.panels.navigator, navigator);
    assert.equal(withNavigator.order.find((id) => withNavigator.panels[id].place === 'left'), 'navigator');
    assert.deepEqual(withNavigator.order.slice(1), legacyOrder);
  }

  const malformed = JSON.stringify({
    ...migrated,
    floatGroups: {
      '': { minimized: true },
      '   ': { minimized: true },
      missingObject: null,
      stringEntry: 'invalid',
      arrayEntry: [],
      painting: { minimized: 1, orientation: 'vertical', pillPos: { x: 19.6, y: -9.4 } },
      members: { minimized: 0, orientation: 'diagonal', pillPos: { x: 'nonfinite', y: 22 } },
    },
  }).replace('"nonfinite"', '1e999');
  const normalized = loadDockLayout({ getItem: () => malformed });
  assert.deepEqual(normalized.floatGroups, {
    painting: { minimized: true, orientation: 'vertical', pillPos: { x: 20, y: -9 } },
    members: { minimized: false, orientation: 'horizontal', pillPos: null },
  });
  assert.deepEqual(getFloatGroupState(normalized, 'missing'), {
    minimized: false, orientation: 'horizontal', pillPos: null,
  });
}

function floatingTabs(group: string) {
  const { order, panels } = getDockLayout();
  return order.filter((id) => panels[id].place === 'float' && panels[id].group === group);
}

function checkMinimizeAndDetach() {
  const windowRect = { x: 180, y: 110, w: 360, h: 480 };
  dockActions.floatAt('layers', windowRect);
  dockActions.minimizeFloatGroup('layers', { x: 51, y: 66 });
  assert.deepEqual(getFloatGroupState(getDockLayout(), 'layers'), {
    minimized: true, orientation: 'horizontal', pillPos: { x: 51, y: 66 },
  });
  assert.deepEqual(getDockLayout().panels.layers.float, windowRect);
  assert.deepEqual(floatingTabs('layers'), ['layers']);

  dockActions.setFloatGroupPillPos('layers', { x: 83.6, y: 121.2 });
  dockActions.setFloatGroupOrientation('layers', 'vertical');
  dockActions.expandFloatGroup('layers', 'layers');
  assert.equal(getDockLayout().activeTab.layers, 'layers');
  assert.deepEqual(getFloatGroupState(getDockLayout(), 'layers'), {
    minimized: false, orientation: 'vertical', pillPos: { x: 84, y: 121 },
  });
  assert.deepEqual(getDockLayout().panels.layers.float, windowRect);

  dockActions.mergeInto('color', 'layers');
  dockActions.mergeInto('subView', 'layers');
  dockActions.hide('color');
  dockActions.minimizeFloatGroup('layers');
  dockActions.expandFloatGroup('layers', 'color');
  const expanded = getDockLayout();
  assert.equal(expanded.activeTab.layers, 'color');
  assert.equal(expanded.panels.color.visible, true);
  assert.deepEqual(getFloatGroupState(expanded, 'layers'), {
    minimized: false, orientation: 'vertical', pillPos: { x: 84, y: 121 },
  });

  dockActions.setActiveTab('layers', 'subView');
  dockActions.minimizeFloatGroup('layers');
  dockActions.toggleFloatGroupOrientation('layers');
  assert.equal(getFloatGroupState(getDockLayout(), 'layers').orientation, 'horizontal');
  dockActions.setFloatGroupOrientation('layers', 'vertical');
  const groupState = getFloatGroupState(getDockLayout(), 'layers');
  assert.deepEqual(groupState, { minimized: true, orientation: 'vertical', pillPos: { x: 84, y: 121 } });
  assert.equal(getDockLayout().activeTab.layers, 'subView');
  assert.deepEqual(floatingTabs('layers'), ['layers', 'color', 'subView']);

  const beforeDetach = getDockLayout();
  dockActions.detachToPill('subView', { x: 152, y: 194 }, 'horizontal');
  const detached = getDockLayout();
  assert.deepEqual(detached.panels.subView.float, { ...windowRect, x: windowRect.x + 32, y: windowRect.y + 32 });
  assert.deepEqual(getFloatGroupState(detached, 'subView'), {
    minimized: true, orientation: 'horizontal', pillPos: { x: 152, y: 194 },
  });
  assert.deepEqual(floatingTabs('subView'), ['subView']);
  assert.deepEqual(floatingTabs('layers'), ['layers', 'color']);
  assert.equal(detached.activeTab.layers, 'layers');
  assert.deepEqual(getFloatGroupState(detached, 'layers'), groupState);
  for (const id of allPanelIds.filter((id) => id !== 'subView')) {
    assert.deepEqual(detached.panels[id], beforeDetach.panels[id], `${id} is unchanged after detaching subView`);
  }
}

function checkMergeAndDock() {
  dockActions.mergeInto('oplog', 'subView');
  dockActions.minimizeFloatGroup('subView');
  assert.deepEqual(floatingTabs('subView'), ['subView', 'oplog']);
  assert.equal(getDockLayout().activeTab.subView, 'oplog');
  assert.equal(getFloatGroupState(getDockLayout(), 'subView').minimized, true);

  const beforeMerge = getDockLayout();
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const persistedLayouts: unknown[] = [];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { setItem: (_key: string, raw: string) => persistedLayouts.push(JSON.parse(raw)) },
  });
  try {
    dockActions.mergePanelsInto(['subView', 'oplog', 'subView', 'color'], 'layers', {
      keepTargetMinimized: true,
      activeId: 'oplog',
    });
  } finally {
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }

  const merged = getDockLayout();
  assert.deepEqual(persistedLayouts, [merged], 'Merging both pills persists the complete layout once');
  assert.deepEqual(floatingTabs('layers'), ['layers', 'color', 'subView', 'oplog']);
  assert.deepEqual([...merged.order].sort(), [...allPanelIds].sort());
  assert.deepEqual(merged.panels.layers, beforeMerge.panels.layers);
  assert.deepEqual(getFloatGroupState(merged, 'layers'), getFloatGroupState(beforeMerge, 'layers'));
  assert.equal(merged.activeTab.layers, 'oplog');
  assert.equal(Object.hasOwn(merged.activeTab, 'subView'), false);
  assert.equal(Object.hasOwn(merged.floatGroups, 'subView'), false);

  dockActions.dockAt(['color', 'subView', 'oplog', 'layers'], 'left', 0);
  const docked = getDockLayout();
  assert.equal(Object.hasOwn(docked.floatGroups, 'layers'), false);
  assert.equal(Object.hasOwn(docked.activeTab, 'layers'), false);
  assert.deepEqual(docked.order.filter((id) => docked.panels[id].visible && docked.panels[id].place === 'left'), [
    'color', 'subView', 'oplog', 'layers', 'navigator',
  ]);
}

function checkReopenAndHide() {
  dockActions.floatAt('layers', { x: 170, y: 100, w: 320, h: 450 });
  dockActions.mergeInto('color', 'layers');
  const pillPos = { x: 67, y: 143 };
  dockActions.setFloatGroupOrientation('layers', 'vertical');

  const assertExpanded = (id: PanelId) => {
    const layout = getDockLayout();
    assert.equal(layout.panels[id].visible, true);
    assert.equal(layout.panels[id].collapsed, false);
    assert.equal(layout.activeTab.layers, id);
    assert.deepEqual(getFloatGroupState(layout, 'layers'), { minimized: false, orientation: 'vertical', pillPos });
  };

  dockActions.minimizeFloatGroup('layers', pillPos);
  dockActions.activate('layers');
  assertExpanded('layers');
  dockActions.minimizeFloatGroup('layers');
  dockActions.show('color');
  assertExpanded('color');
  dockActions.minimizeFloatGroup('layers');
  dockActions.toggle('layers');
  assert.equal(getDockLayout().panels.layers.visible, false);
  assert.equal(getFloatGroupState(getDockLayout(), 'layers').minimized, true);
  dockActions.toggle('layers');
  assertExpanded('layers');

  dockActions.minimizeFloatGroup('layers');
  const minimized = getFloatGroupState(getDockLayout(), 'layers');
  dockActions.hide('color');
  assert.equal(getDockLayout().panels.color.visible, false);
  assert.deepEqual(getFloatGroupState(getDockLayout(), 'layers'), minimized);
  dockActions.hide('layers');
  assert.equal(getDockLayout().panels.layers.visible, false);
  assert.deepEqual(getFloatGroupState(getDockLayout(), 'layers'), minimized);

  dockActions.dockAt(['color'], 'right', 0);
  assert.deepEqual(getFloatGroupState(getDockLayout(), 'layers'), minimized);
  dockActions.dockAt(['layers'], 'right', 0);
  assert.equal(Object.hasOwn(getDockLayout().floatGroups, 'layers'), false);
}

function checkDetachGroupOwner() {
  dockActions.reset();
  const windowRect = { x: 192, y: 115, w: 351, h: 463 };
  const originalPillPos = { x: 72, y: 147 };
  const detachedPillPos = { x: 203, y: 269 };
  dockActions.floatAt('layers', windowRect);
  dockActions.mergeInto('color', 'layers');
  dockActions.mergeInto('subView', 'layers');
  dockActions.setActiveTab('layers', 'color');
  dockActions.setFloatGroupOrientation('layers', 'vertical');
  dockActions.minimizeFloatGroup('layers', originalPillPos);

  dockActions.detachToPill('layers', detachedPillPos);
  const layout = getDockLayout();
  const retainedGroup = layout.panels.color.group;
  const detachedGroup = layout.panels.layers.group;
  assert.notEqual(retainedGroup, detachedGroup);
  assert.deepEqual(floatingTabs(retainedGroup), ['color', 'subView']);
  assert.deepEqual(floatingTabs(detachedGroup), ['layers']);
  assert.deepEqual(layout.panels.color.float, windowRect);
  assert.deepEqual(layout.panels.layers.float, { ...windowRect, x: windowRect.x + 32, y: windowRect.y + 32 });
  assert.equal(layout.activeTab[retainedGroup], 'color');
  assert.deepEqual(getFloatGroupState(layout, retainedGroup), {
    minimized: true, orientation: 'vertical', pillPos: originalPillPos,
  });
  assert.deepEqual(getFloatGroupState(layout, detachedGroup), {
    minimized: true, orientation: 'horizontal', pillPos: detachedPillPos,
  });
}

function checkLabel(value: string, context: string, placeholders: string[] = []) {
  assert.ok(typeof value === 'string' && value.trim().length > 0, `${context} is a nonempty string`);
  assert.doesNotMatch(value, /[\u0000-\u001f\u007f-\u009f\uE000-\uF8FF\uFFFD]/u, context);
  assert.deepEqual(value.match(/\{[^{}]*\}/gu) ?? [], placeholders, `${context} placeholders`);
  assert.doesNotMatch(value.replace(/\{[^{}]*\}/gu, ''), /[{}]/u, `${context} has an unmatched brace`);
}

function checkLocalesAndIcons() {
  assert.deepEqual(Object.keys(PANEL_ICON_COMPONENTS).sort(), [...allPanelIds].sort());
  const icons = allPanelIds.map((id) => PANEL_ICON_COMPONENTS[id]);
  assert.ok(icons.every(Boolean));
  assert.equal(new Set(icons).size, allPanelIds.length);
  for (const id of allPanelIds) {
    const icon = renderPanelIcon(id);
    assert.ok(isValidElement(icon));
    assert.equal(icon.type, PANEL_ICON_COMPONENTS[id]);
  }

  const locales: readonly Language[] = ['zh-TW', 'zh-CN', 'en-US', 'ja-JP'];
  const dockKeys = [...dockLabels, ...Object.keys(dockTemplates), 'panelNames'].sort();
  for (const language of locales) {
    const t = translations[language];
    assert.deepEqual(Object.keys(t.dock).sort(), dockKeys, `${language} dock labels`);
    assert.deepEqual(Object.keys(t.dock.panelNames).sort(), [...allPanelIds].sort(), `${language} panel names`);
    for (const key of dockLabels) checkLabel(t.dock[key], `${language}.dock.${key}`);
    for (const key of Object.keys(dockTemplates) as Array<keyof typeof dockTemplates>) {
      checkLabel(t.dock[key], `${language}.dock.${key}`, [dockTemplates[key]]);
    }
    for (const id of allPanelIds) {
      const name = t.dock.panelNames[id];
      checkLabel(name, `${language}.dock.panelNames.${id}`);
      assert.equal(getPanelDisplayTitle(id, t), name);
    }
  }
}

export function runDockPillChecks() {
  try {
    dockActions.reset();
    checkLayoutStorage();
    checkMinimizeAndDetach();
    checkMergeAndDock();
    checkReopenAndHide();
    checkDetachGroupOwner();
    checkLocalesAndIcons();
  } finally {
    dockActions.reset();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDockPillChecks();
  console.log('Dock floating pill checks passed');
}
