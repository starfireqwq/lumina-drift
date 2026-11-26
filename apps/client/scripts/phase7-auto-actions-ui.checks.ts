import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultAdjustment } from '@atelier/shared';
import { describeAutoActionError, describeAutoActionImportError, describeAutoActionStep } from '../src/components/autoActionLabels';
import { getAutoActionsHelpTopic, getHelpTopics, queryTerms, scoreTopic } from '../src/components/help/helpContent';
import { dockActions, getDockLayout, loadDockLayout, PANEL_IDS } from '../src/components/workspace/dockStore';
import {
  AUTO_ACTION_STEP_KINDS, BUILTIN_AUTO_ACTION_KEYS, BUILTIN_AUTO_ACTIONS, normalizeAutoActionStep,
  type AutoActionErrorCode, type AutoActionFileError, type AutoActionStepKind,
} from '../src/engine/ActionRecorder';
import { translations } from '../src/locales';

const params = {
  'layer.new': { nameKey: 'shadow', blendMode: 'multiply', opacity: 0.6, clipToBelow: true },
  'layer.duplicate': {},
  'layer.merge_down': {},
  'layer.delete': {},
  'layer.set_blend': { blendMode: 'screen' },
  'layer.set_opacity': { opacity: 0.4 },
  'layer.set_clip': { clipToBelow: false },
  'filter.apply': { filterId: 'gaussian', values: { radius: 12 } },
  'adjustment.create': { adjustment: createDefaultAdjustment('color_balance') },
  'selection.grow': { px: 3 },
  'selection.invert': {},
  'selection.clear': {},
} satisfies Record<AutoActionStepKind, unknown>;

const playbackErrors = {
  no_layer: true, not_editable: true, no_layer_below: true, merge_blocked: true, filter_unavailable: true,
  filter_failed: true, adjustment_blocked: true, selection_unavailable: true, read_only: true,
  cancelled: true, busy: true, unknown: true,
} satisfies Record<AutoActionErrorCode, true>;

const importErrors = {
  too_large: true, not_json: true, wrong_format: true, unsupported_version: true, empty: true,
} satisfies Record<AutoActionFileError['code'], true>;

function assertLabel(text: string, context: string) {
  assert.ok(text?.trim(), context);
  assert.doesNotMatch(text, /\{/, context);
}

export async function runPhase7AutoActionUiChecks(): Promise<void> {
  const examples = AUTO_ACTION_STEP_KINDS.map((kind) => {
    const step = normalizeAutoActionStep({ kind, params: params[kind] });
    assert.ok(step, kind);
    return step;
  });
  const builtinSteps = BUILTIN_AUTO_ACTIONS.flatMap((action) => action.steps);
  for (const [language, t] of Object.entries(translations)) {
    for (const step of [...examples, ...builtinSteps]) {
      assertLabel(describeAutoActionStep(step, t), `${language} ${step.kind}`);
    }
    for (const code of Object.keys(playbackErrors) as AutoActionErrorCode[]) {
      assertLabel(describeAutoActionError(code, t), `${language} ${code}`);
    }
    for (const code of Object.keys(importErrors) as AutoActionFileError['code'][]) {
      assertLabel(describeAutoActionImportError(code, t), `${language} ${code}`);
    }
    for (const key of BUILTIN_AUTO_ACTION_KEYS) {
      assertLabel(t.autoActions.presets[key].name, `${language} ${key} name`);
      assertLabel(t.autoActions.presets[key].desc, `${language} ${key} description`);
    }
    const help = getAutoActionsHelpTopic(t);
    assert.deepEqual(getHelpTopics(t).find(({ id }) => id === help.id), help);
    assert.ok(help.steps?.some((step) => step.includes('Ctrl+Z')));
    assert.ok(help.steps?.some((step) => step.includes('.lumina-action')));
  }

  assert.ok(PANEL_IDS.includes('autoActions'));
  const defaults = loadDockLayout({ getItem: () => null });
  assert.equal(defaults.panels.autoActions.visible, false);
  assert.ok(defaults.order.includes('autoActions'));
  const { autoActions, ...legacyPanels } = defaults.panels;
  const legacy = {
    ...defaults,
    panels: { ...legacyPanels, subView: { ...legacyPanels.subView, visible: true } },
    order: defaults.order.filter((id) => id !== 'autoActions'),
  };
  const migrated = loadDockLayout({ getItem: () => JSON.stringify(legacy) });
  assert.deepEqual(migrated.panels.autoActions, autoActions);
  assert.deepEqual(migrated.panels.subView, legacy.panels.subView);
  assert.deepEqual(migrated.order, [...legacy.order, 'autoActions']);

  const beforeToggle = getDockLayout().panels.autoActions;
  dockActions.toggle('autoActions');
  assert.equal(getDockLayout().panels.autoActions.visible, !beforeToggle.visible);
  dockActions.toggle('autoActions');
  if (beforeToggle.collapsed) dockActions.setCollapsed('autoActions', true);
  assert.deepEqual(getDockLayout().panels.autoActions, beforeToggle);

  for (const [language, query] of [['zh-TW', '動作'], ['en-US', 'action']] as const) {
    const t = translations[language];
    const terms = queryTerms(query);
    const found = getHelpTopics(t).filter((topic) => scoreTopic(topic, terms, '') > 0);
    assert.ok(found.some(({ id }) => id === 'auto-actions'), `${language} ${query}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhase7AutoActionUiChecks().then(
    () => console.log('Phase 7 auto actions UI checks passed'),
    (error) => { console.error(error); process.exitCode = 1; },
  );
}
