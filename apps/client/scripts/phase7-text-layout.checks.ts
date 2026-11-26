import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyTextStyleToRange, normalizeTextMeta, remapTextRuns, resolveTextStyleAt,
  type LayerTextMeta, type TextStyleRun,
} from '@atelier/shared';
import {
  caretRect, caretRectFromLayout, createCanvasMeasurer, DEFAULT_TEXT, indexAtPoint, layoutText, renderText,
  selectionRectsFromLayout, textBounds, textBoxRect, type TextLayout, type TextMeasurer,
} from '../src/engine/textLayer';

const measure: TextMeasurer['measure'] = (text, font) => Array.from(text).reduce(
  (width, char) => width + font.size * (/^[\x00-\x7f]$/.test(char) ? 0.5 : 1) * (font.bold ? 1.05 : 1), 0,
);
const measurer = { measure };
const base = (content: string, patch: Partial<LayerTextMeta> = {}): LayerTextMeta => ({
  ...DEFAULT_TEXT, content, fontSize: 20, x: 12.25, y: 30.75, ...patch,
});
const lines = (layout: TextLayout) => layout.lines.map(({ start, end }) => [start, end]);

function checkMetadata(): void {
  const old = Object.freeze(base('legacy'));
  assert.deepEqual(normalizeTextMeta(old), old);
  assert.equal(normalizeTextMeta(null), null);
  assert.equal(normalizeTextMeta([]), null);
  const polluted = JSON.parse('{"__proto__":{"bold":true},"constructor":{"prototype":{"italic":true}},"unused":1}');
  Object.setPrototypeOf(polluted, { fontSize: 999, color: '#123' });
  const clean = normalizeTextMeta(polluted)!;
  assert.deepEqual(clean, { ...DEFAULT_TEXT, x: 0, y: 0 });
  assert.equal(Object.getPrototypeOf(clean), Object.prototype);
  assert.ok(!Object.hasOwn(clean, '__proto__'));
  const clamped = normalizeTextMeta({
    content: 'x'.repeat(20_010), fontSize: 2400, lineHeight: 0, strokeWidth: 140, letterSpacing: -800,
    color: 'red', strokeColor: '#abcd', align: 'justify', box: { width: -1, height: 90_000, extra: true },
    shadow: { color: '#12345678', offsetX: -2000, offsetY: 2000, blur: 500, opacity: 3 },
  })!;
  assert.equal(clamped.content.length, 20_000);
  assert.deepEqual([clamped.fontSize, clamped.lineHeight, clamped.strokeWidth, clamped.letterSpacing], [1000, 0.5, 100, -200]);
  assert.deepEqual([clamped.color, clamped.strokeColor, clamped.align], ['#000000', '#ffffff', undefined]);
  assert.deepEqual(clamped.box, { width: 1, height: 20_000 });
  assert.deepEqual(clamped.shadow, { color: '#12345678', offsetX: -1000, offsetY: 1000, blur: 200, opacity: 1 });

  const runs: TextStyleRun[] = [
    { start: 5, end: 30, bold: true }, { start: 2, end: 4, color: '#123' }, { start: -3, end: 2, color: '#123' },
    { start: 4, end: 5 }, { start: 6, end: 6, italic: true },
    { start: 6, end: 7, bold: false, fontSize: -8, color: 'bad' },
  ];
  assert.deepEqual(normalizeTextMeta(base('abcdefgh', { runs }))!.runs, [
    { start: 0, end: 4, color: '#123' }, { start: 5, end: 6, bold: true },
    { start: 6, end: 7, bold: false, color: '#000000', fontSize: 4 }, { start: 7, end: 8, bold: true },
  ]);
  const manyRuns = Array.from({ length: 520 }, (_, i) => ({ start: i, end: i + 1, bold: i % 2 === 0 }));
  assert.equal(normalizeTextMeta(base('x'.repeat(520), { runs: manyRuns }))!.runs!.length, 500);
  const overlapping = base('abcdef', { runs: [
    { start: 2, end: 4, color: '#fff' }, { start: 0, end: 6, color: '#000', italic: true },
  ] });
  const overlapStyle = { color: '#fff', italic: true, bold: false, fontSize: 20 };
  assert.deepEqual(resolveTextStyleAt(overlapping, 2), overlapStyle);
  assert.deepEqual(resolveTextStyleAt(normalizeTextMeta(overlapping)!, 2), overlapStyle);

  const original = base('abcdef', { runs: [{ start: 1, end: 5, bold: true, color: '#123' }] });
  Object.freeze(original.runs![0]);
  Object.freeze(original.runs);
  Object.freeze(original);
  assert.deepEqual(applyTextStyleToRange(original, 100, 200, { bold: true }), original);
  const changed = applyTextStyleToRange(original, 2, 4, { color: '#f00' });
  assert.deepEqual(changed.runs, [
    { start: 1, end: 2, bold: true, color: '#123' }, { start: 2, end: 4, bold: true, color: '#f00' },
    { start: 4, end: 5, bold: true, color: '#123' },
  ]);
  assert.equal(resolveTextStyleAt(changed, 0).color, original.color);
  assert.equal(resolveTextStyleAt(applyTextStyleToRange(changed, 2, 4, { color: null }), 3).color, original.color);
  const global = applyTextStyleToRange(changed, 2, 2, { color: '#0f0', italic: true, fontSize: 30 });
  assert.deepEqual(global.runs, [{ start: 1, end: 5, bold: true }]);
  assert.deepEqual(resolveTextStyleAt(global, 4), { color: '#0f0', fontSize: 30, italic: true, bold: true });

  const left = { start: 0, end: 2, bold: true };
  const right = { start: 2, end: 4, italic: true };
  assert.deepEqual(remapTextRuns([left, right], 'abcd', 'abXYcd'), [{ ...left, end: 4 }, { ...right, start: 4, end: 6 }]);
  assert.deepEqual(remapTextRuns([left, right], 'abcd', 'Xabcd'), [{ ...left, end: 3 }, { ...right, start: 3, end: 5 }]);
  assert.deepEqual(remapTextRuns([left, right], 'abcd', 'Xcd'), [{ ...right, start: 0, end: 3 }]);
  assert.deepEqual(remapTextRuns([left, right], 'abcd', 'ad'), [{ ...left, end: 1 }, { ...right, start: 1, end: 2 }]);
  assert.deepEqual(remapTextRuns([left, right], 'abcd', 'XY'), []);
  assert.deepEqual(remapTextRuns([left, right], 'abcd', 'abcd'), [left, right]);
}

function checkLayouts(): void {
  const rich = base('ab漢\n小', { runs: [{ start: 1, end: 2, fontSize: 40, bold: true, italic: true, color: '#f00' }], letterSpacing: 100 });
  const styled = layoutText(rich, measurer);
  assert.deepEqual(styled.lines.map(({ y, w, h }) => [y, w, h]), [[0, 57, 52], [52, 20, 26]]);
  assert.deepEqual(styled.glyphs.map(({ x, y, w }) => [x, y, w]), [[0, 16, 10], [12, 0, 21], [37, 16, 20], [0, 52, 20]]);
  assert.deepEqual(styled.glyphs[1].font, { family: rich.fontFamily, size: 40, italic: true, bold: true });
  assert.equal(styled.glyphs[1].color, '#f00');
  assert.equal(layoutText(base('abc', { letterSpacing: -200 }), measurer).width, 22);
  const layoutBox = (text: string, patch: Partial<LayerTextMeta> = {}) => layoutText(base(text, { box: { width: 40, height: 80 }, ...patch }), measurer);
  assert.deepEqual(lines(layoutBox('甲乙丙丁戊')), [[0, 2], [2, 4], [4, 5]]);
  assert.deepEqual(lines(layoutBox('hi day', { box: { width: 45, height: 80 } })), [[0, 3], [3, 6]]);
  assert.deepEqual(lines(layoutBox('word next')), [[0, 5], [5, 9]]);
  assert.equal(layoutBox('word next').lines[0].w, 40);
  assert.deepEqual(lines(layoutBox('甲乙。丁')), [[0, 3], [3, 4]]);
  assert.equal(layoutBox('甲乙。丁').lines[0].w, 60);
  assert.deepEqual(lines(layoutBox('甲「乙」')), [[0, 1], [1, 4]]);
  assert.deepEqual(lines(layoutBox('甲乙。丁', { kinsoku: false })), [[0, 2], [2, 4]]);
  assert.deepEqual(lines(layoutBox('甲乙\n。丁')), [[0, 2], [3, 5]], 'hard breaks are kept');
  assert.deepEqual(layoutBox('甲\n乙丙', { align: 'center' }).lines.map((line) => line.x), [10, 0]);
  assert.deepEqual(layoutText(base('甲\n乙丙', { align: 'end' }), measurer).lines.map((line) => line.x), [20, 0]);

  const vBox = (text: string, patch: Partial<LayerTextMeta> = {}) => layoutText(base(text, { vertical: true, box: { width: 80, height: 40 }, ...patch }), measurer);
  const vertical = vBox('甲乙。丁', { align: 'end' });
  assert.deepEqual(lines(vertical), [[0, 3], [3, 4]]);
  assert.deepEqual(vertical.lines.map(({ x, y }) => [x, y]), [[54, 0], [28, 20]]);
  assert.deepEqual(vBox('甲乙丙', { align: 'center' }).lines.map(({ x, y }) => [x, y]), [[54, 0], [28, 10]]);
  assert.deepEqual(lines(vBox('甲「乙」')), [[0, 1], [1, 4]]);
  assert.deepEqual(lines(vBox('abcdefghi')), [[0, 4], [4, 8], [8, 9]]);
  const verticalForms = layoutText(base('〘ー～〜–—‐〙、。，．ぁャ', { vertical: true }), measurer);
  assert.equal(verticalForms.glyphs.slice(0, 8).map((glyph) => glyph.text).join(''), '〘ー～〜–—‐〙');
  assert.ok(verticalForms.glyphs.slice(0, 8).every((glyph) => glyph.mode === 'rotated'));
  assert.equal(verticalForms.glyphs.slice(8, 12).map((glyph) => glyph.text).join(''), '︑︒︐︒');
  assert.deepEqual(verticalForms.glyphs.slice(12).map(({ x, y }) => [x, y]), [[5, 238], [5, 258]]);
  assert.deepEqual(layoutText(base('甲乙', { vertical: true, letterSpacing: 100 }), measurer).glyphs.map((glyph) => glyph.y), [0, 22]);
  const mixedTcy = layoutText(base('12字', { vertical: true, runs: [{ start: 1, end: 2, color: '#f00' }] }), measurer);
  assert.deepEqual(mixedTcy.glyphs.map(({ mode, color, y }) => [mode, color, y]), [
    ['tcy', '#000000', 0], ['tcy', '#f00', 0], ['upright', '#000000', 20],
  ]);
}

function checkCaretAndSelection(): void {
  const meta = base('AB\n漢C');
  const layout = layoutText(meta, measurer);
  assert.deepEqual(caretRectFromLayout(layout, meta, -1), { x: 0, y: 0, w: 1.5, h: 26 });
  assert.deepEqual(caretRectFromLayout(layout, meta, 2), { x: 20, y: 0, w: 1.5, h: 26 });
  assert.deepEqual(caretRectFromLayout(layout, meta, 3), { x: 0, y: 26, w: 1.5, h: 26 });
  assert.deepEqual(caretRectFromLayout(layout, meta, 999), { x: 30, y: 26, w: 1.5, h: 26 });
  assert.equal(indexAtPoint(layout, meta, -5, 10), 0);
  assert.equal(indexAtPoint(layout, meta, 9, 10), 1);
  assert.equal(indexAtPoint(layout, meta, 20, 10), 2);
  assert.equal(indexAtPoint(layout, meta, 12, 26), 4);
  assert.deepEqual(selectionRectsFromLayout(layout, 4, 1), [{ x: 10, y: 0, w: 10, h: 26 }, { x: 0, y: 26, w: 20, h: 26 }]);

  const vertical = base('甲乙丙丁', { vertical: true, box: { width: 60, height: 40 } });
  const columns = layoutText(vertical, measurer);
  assert.equal(indexAtPoint(columns, vertical, 50, 36), 2);
  assert.equal(indexAtPoint(columns, vertical, 22, 1), 2);
  assert.deepEqual(caretRectFromLayout(columns, vertical, 2), { x: 11, y: 0, w: 20, h: 1.5 });
  assert.deepEqual(selectionRectsFromLayout(columns, 1, 3), [{ x: 34, y: 20, w: 26, h: 20 }, { x: 8, y: 0, w: 26, h: 20 }]);

  for (const vertical of [false, true]) {
    const empty = base('', { vertical });
    const blank = layoutText(empty, measurer);
    assert.equal(indexAtPoint(blank, empty, 100, 100), 0);
    assert.equal(caretRectFromLayout(blank, empty, 10).y, 0);
    assert.deepEqual(selectionRectsFromLayout(blank, 0, 10), []);
  }
  const astral = base('甲😀乙');
  const emoji = layoutText(astral, measurer);
  assert.deepEqual(emoji.glyphs.map(({ index, length }) => [index, length]), [[0, 1], [1, 2], [3, 1]]);
  assert.equal(indexAtPoint(emoji, astral, 39, 1), 3);
}

type Draw = { kind: string; text: string; x: number; y: number; font: string; color: string; thickness: number };
function withCanvasMock(check: (draws: Draw[], composites: Record<string, unknown>[], transforms: number[]) => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const draws: Draw[] = [];
  const composites: Record<string, unknown>[] = [];
  const transforms: number[] = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => {
      const context = {
        font: '10px sans-serif', fillStyle: '', lineWidth: 1, offsetX: 0, offsetY: 0,
        shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
        measureText(text: string) {
          const size = Number(/([\d.]+)px/.exec(this.font)?.[1]);
          return { width: measure(text, { family: '', size, bold: this.font.includes('bold '), italic: this.font.includes('italic ') }) };
        },
        translate(x: number, y: number) { this.offsetX += x; this.offsetY += y; },
        save() { stack.push([this.offsetX, this.offsetY]); },
        restore() { [this.offsetX, this.offsetY] = stack.pop()!; },
        rotate(angle: number) { transforms.push(angle); },
        scale() {},
        fillText(text: string, x: number, y: number) { this.record('fill', text, x, y); },
        strokeText(text: string, x: number, y: number) { this.record('stroke', text, x, y); },
        record(kind: string, text: string, x: number, y: number) {
          draws.push({ kind, text, x: x + this.offsetX, y: y + this.offsetY, font: this.font, color: this.fillStyle, thickness: this.lineWidth });
        },
        drawImage(image: { width: number; height: number }, x: number, y: number) {
          composites.push({ x, y, width: image.width, height: image.height, color: this.shadowColor, blur: this.shadowBlur,
            offsetX: this.shadowOffsetX, offsetY: this.shadowOffsetY });
        },
      };
      const stack: [number, number][] = [];
      return { width: 0, height: 0, getContext: () => context };
    },
  } });
  try { check(draws, composites, transforms); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

function checkLegacyAndRendering(): void {
  withCanvasMock((draws, composites, transforms) => {
    const horizontal = base('A漢B\nCD\n', { lineHeight: 0.55 });
    const font = { family: horizontal.fontFamily, size: horizontal.fontSize, bold: false, italic: false };
    const advance = horizontal.fontSize * horizontal.lineHeight;
    const rows = horizontal.content.split('\n');
    const expectedWidth = Math.max(1, ...rows.map((row) => measure(row, font)));
    const expectedHeight = rows.length * advance;
    const hLayout = layoutText(horizontal, measurer);
    assert.deepEqual([hLayout.width, hLayout.height], [expectedWidth, expectedHeight]);
    const raster = renderText(horizontal);
    assert.deepEqual([raster.canvas.width, raster.canvas.height], [Math.ceil(expectedWidth + 4), Math.ceil(expectedHeight + 4)]);
    assert.deepEqual(draws.splice(0).map(({ text, x, y }) => [text, x, y]), rows.map((row, i) => [row, 2, 2 + i * advance]));
    for (const glyph of hLayout.glyphs) {
      const row = hLayout.lines[glyph.line];
      assert.deepEqual([glyph.x, glyph.y], [measure(horizontal.content.slice(row.start, glyph.index), font), glyph.line * advance]);
    }
    assert.deepEqual(textBoxRect(horizontal), { x: 12, y: 31, w: Math.ceil(expectedWidth), h: Math.ceil(expectedHeight) });
    for (let index = 0; index <= horizontal.content.length; index++) {
      const before = horizontal.content.slice(0, index).split('\n');
      assert.deepEqual(caretRect(horizontal, index), { x: measure(before.at(-1)!, font), y: (before.length - 1) * advance, w: 1.5, h: advance });
    }
    const kerned = layoutText(base('AVA'), { measure: (text, font) => measure(text, font) - (text.includes('AV') ? 2 : 0) });
    assert.equal(kerned.width, 28);
    assert.equal(kerned.glyphs[2].x, 18);

    const vertical = base('第12話ABC\n用CSP畫', { vertical: true });
    const columnAdvance = vertical.fontSize * vertical.lineHeight;
    const oldColumns = [['第', '12', '話', 'ABC'], ['用', 'CSP', '畫']];
    const textAdvance = (text: string) => /^[A-Z]/.test(text) ? Math.max(font.size / 2, measure(text, font)) : font.size;
    const expectedVWidth = oldColumns.length * columnAdvance;
    const expectedVHeight = Math.max(...oldColumns.map((column) => column.reduce((sum, text) => sum + textAdvance(text), 0)));
    const vLayout = layoutText(vertical, measurer);
    assert.deepEqual([vLayout.width, vLayout.height], [expectedVWidth, expectedVHeight]);
    assert.deepEqual(textBoxRect(vertical), { x: 12, y: 31, w: Math.ceil(expectedVWidth), h: Math.ceil(expectedVHeight) });
    let index = 0;
    oldColumns.forEach((column, n) => {
      const x = expectedVWidth - (n + 0.5) * columnAdvance - font.size / 2;
      let y = 0;
      for (const text of column) {
        const glyph = vLayout.glyphs.find((candidate) => candidate.index === index)!;
        assert.deepEqual([glyph.text, glyph.x, glyph.y], [text, x, y]);
        for (let j = 0; j < text.length; j++) {
          const inner = /^[A-Z]/.test(text) ? measure(text.slice(0, j), font) : textAdvance(text) * j / text.length;
          assert.deepEqual(caretRect(vertical, index + j), { x, y: y + inner, w: font.size, h: 1.5 });
        }
        index += text.length;
        y += textAdvance(text);
      }
      assert.deepEqual(caretRect(vertical, index), { x, y, w: font.size, h: 1.5 });
      index++;
    });
    assert.deepEqual(vLayout.glyphs.map(({ mode }) => mode), ['upright', 'tcy', 'upright', 'sideways', 'upright', 'sideways', 'upright']);
    const fixed = base('字', { vertical: true, box: { width: 100, height: 40 } });
    assert.deepEqual(textBoxRect(fixed), { x: 12.25, y: 30.75, w: 100, h: 40 });
    const fixedRendered = renderText(fixed);
    assert.deepEqual([fixedRendered.x, fixedRendered.y, fixedRendered.canvas.width, fixedRendered.canvas.height], [10, 29, 104, 44]);
    assert.equal(draws.at(-1)?.x, 89, 'the first column is anchored to the right edge of the fixed box');
    const hanging = renderText(base('甲乙。丁', { box: { width: 40, height: 60 } }));
    assert.equal(hanging.canvas.width, 64);

    const rich = base('AB', { strokeWidth: 3, runs: [{ start: 1, end: 2, bold: true, italic: true, color: '#f00' }] });
    draws.length = 0;
    const behind = renderText(rich);
    assert.deepEqual(draws.map(({ kind, text, thickness }) => [kind, text, thickness]), [
      ['stroke', 'A', 6], ['stroke', 'B', 6], ['fill', 'A', 6], ['fill', 'B', 6],
    ]);
    assert.equal(draws[3].color, '#f00');
    assert.ok(draws[3].font.startsWith('italic bold 20px '));
    assert.deepEqual([behind.x, behind.y, behind.canvas.width, behind.canvas.height], [7, 26, 31, 36]);
    draws.length = 0;
    const front = renderText({ ...rich, paintOrder: 'stroke-front' });
    assert.deepEqual(draws.map(({ kind, text, thickness }) => [kind, text, thickness]), [
      ['fill', 'A', 3], ['fill', 'B', 3], ['stroke', 'A', 3], ['stroke', 'B', 3],
    ]);
    assert.equal(front.canvas.width, behind.canvas.width);
    const shadowed = { ...rich, shadow: { color: '#11223380', opacity: 0.5, offsetX: -12, offsetY: 7, blur: 3 } };
    assert.deepEqual(textBounds(shadowed), { x: -11, y: 26, width: 49, height: 49 });
    assert.deepEqual(composites, [{ x: 18, y: 0, width: 31, height: 36, color: `rgba(17, 34, 51, ${64 / 255})`, blur: 3, offsetX: -12, offsetY: 7 }]);
    renderText(base('ABCー', { vertical: true }));
    assert.deepEqual(transforms, [Math.PI / 2, Math.PI / 2]);
    assert.equal(createCanvasMeasurer().measure('字', font), 20);
  });
}

export async function runPhase7TextLayoutChecks(): Promise<void> {
  checkMetadata();
  checkLayouts();
  checkCaretAndSelection();
  checkLegacyAndRendering();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhase7TextLayoutChecks().then(() => console.log('ok'), (e) => { console.error(e); process.exit(1); });
}
