import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTextStyleToRange, DEFAULT_LAYER_TEXT, normalizeTextMeta, resolveTextStyleAt, type LayerTextMeta } from '@atelier/shared';
import { getToolbarTextStyle, initialTextBox, resizeTextBox, updateTextContent } from '../src/components/textEditorState';

export async function runPhase7TextEditorChecks(): Promise<void> {
  const legacy: LayerTextMeta = { ...DEFAULT_LAYER_TEXT, content: 'abcd', x: 10, y: 20, fontSize: 24 };
  assert.deepEqual(normalizeTextMeta(legacy), legacy);
  const styled = applyTextStyleToRange(legacy, 1, 3, { color: '#ff0000', fontSize: 40, bold: true, italic: true });
  const mixed = getToolbarTextStyle(styled, 0, 3);
  assert.deepEqual(mixed.mixed, { color: true, fontSize: true, bold: true, italic: true });
  const uniform = getToolbarTextStyle(styled, 1, 3);
  assert.deepEqual(uniform.style, { color: '#ff0000', fontSize: 40, bold: true, italic: true });
  assert.ok(Object.values(uniform.mixed).every((value) => !value));
  assert.equal(getToolbarTextStyle(styled, 2, 2).style.color, '#ff0000');
  assert.equal(getToolbarTextStyle(styled, 3, 3).style.color, legacy.color);
  assert.equal(getToolbarTextStyle(styled, 4, 4).style.fontSize, 24);
  const whole = applyTextStyleToRange(styled, 2, 2, { color: '#ffffff', bold: false });
  assert.equal(getToolbarTextStyle(whole, 0, 4).mixed.bold, false);
  assert.equal(resolveTextStyleAt(whole, 2).fontSize, 40);

  const duplicated = applyTextStyleToRange({ ...legacy, content: 'ab' }, 1, 2, { bold: true });
  const provisional = updateTextContent(duplicated, 'abb');
  assert.equal(resolveTextStyleAt(provisional, 2).bold, true);
  const composed = updateTextContent(provisional, 'a字b', duplicated);
  assert.equal(resolveTextStyleAt(composed, 1).bold, false);
  assert.equal(resolveTextStyleAt(composed, 2).bold, true);
  assert.deepEqual(updateTextContent(composed, 'ab', duplicated), duplicated);
  assert.ok(!('runs' in updateTextContent(styled, '')));
  assert.ok(!('runs' in updateTextContent(legacy, 'plain')));

  assert.deepEqual(initialTextBox(legacy, { w: 40, h: 35 }), { width: 96, height: 35 });
  assert.deepEqual(initialTextBox({ ...legacy, vertical: true }, { w: 32, h: 30 }), { width: 32, height: 96 });
  const box = { width: 100, height: 80 };
  assert.deepEqual(resizeTextBox(box, 10, false, 29.7, -5.6), { x: 10, box: { width: 130, height: 74 } });
  const vertical = resizeTextBox(box, 10, true, -30, 20);
  assert.deepEqual(vertical, { x: -20, box: { width: 130, height: 100 } });
  assert.equal(vertical.x + vertical.box.width, 110);
  assert.deepEqual(resizeTextBox(box, 10, true, 150, -160), { x: 109, box: { width: 1, height: 1 } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhase7TextEditorChecks().then(() => console.log('ok'), (error) => { console.error(error); process.exitCode = 1; });
}
