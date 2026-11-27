import {
  DEFAULT_LAYER_TEXT, KINSOKU_NOT_AT_LINE_END, KINSOKU_NOT_AT_LINE_START, normalizeTextMeta, resolveTextStyleAt,
  type LayerTextMeta,
} from '@atelier/shared';

type TextFontPreset = {
  id: string;
  label: string;
  category?: 'sans' | 'rounded' | 'serif' | 'kai' | 'handwriting' | 'display' | 'comic' | 'mono';
  sample?: string;
};

const fontPresets = {
  system: { id: DEFAULT_LAYER_TEXT.fontFamily, label: '系統黑體', category: 'sans' },
  traditionalSans: { id: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Heiti TC", sans-serif', label: '繁中黑體', category: 'sans' },
  rounded: { id: '"HunInn", "jf-openhuninn-2.0", "Kosugi Maru", "Hiragino Maru Gothic ProN", "YouYuan", "Arial Rounded MT Bold", sans-serif', label: '圓體', category: 'rounded' },
  traditionalSerif: { id: '"Noto Serif TC", "Songti TC", "PMingLiU", "MingLiU", serif', label: '繁中明體', category: 'serif' },
  kai: { id: '"DFKai-SB", "BiauKai", "Kaiti TC", "STKaiti", cursive, serif', label: '楷體', category: 'kai' },
  display: { id: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei UI", "Hiragino Kaku Gothic Std", "Impact", "Arial Black", sans-serif', label: '標題粗黑', category: 'display' },
  comic: { id: '"GenJyuuGothic", "M PLUS Rounded 1c", "PingFang TC", "Microsoft JhengHei", "Comic Sans MS", sans-serif', label: '漫畫字型', category: 'comic' },
  handwriting: { id: '"Segoe Print", "Bradley Hand", "Comic Sans MS", "Comic Neue", "Klee One", cursive', label: '手寫字型', category: 'handwriting' },
  japaneseSans: { id: '"Noto Sans JP", "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif', label: '日系黑體', category: 'sans', sample: '漫画の文字 Aa' },
  japaneseSerif: { id: '"Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", "MS PMincho", serif', label: '日系明體', category: 'serif', sample: '漫画の文字 Aa' },
  simplifiedSans: { id: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif', label: '簡體黑體', category: 'sans', sample: '漫画新篇章 Aa' },
  simplifiedSerif: { id: '"Noto Serif SC", "Songti SC", "SimSun", "STSong", serif', label: '簡體宋體', category: 'serif', sample: '漫画新篇章 Aa' },
  englishSerif: { id: '"Georgia", "Times New Roman", "Palatino Linotype", serif', label: '英文襯線', category: 'serif', sample: 'The next chapter' },
  mono: { id: '"JetBrains Mono", "Cascadia Mono", "SF Mono", "Consolas", "Noto Sans Mono CJK TC", monospace', label: '等寬字型', category: 'mono', sample: 'Aa 0123456789' },
} satisfies Record<string, TextFontPreset>;

export type TextFontPresetKey = keyof typeof fontPresets;
export const TEXT_FONTS: TextFontPreset[] = Object.values(fontPresets);
const presetKeysByFamily = new Map(Object.entries(fontPresets).map(([key, { id }]) => [id, key as TextFontPresetKey]));

export function getTextFontPresetKey(fontFamily: string): TextFontPresetKey | undefined {
  return presetKeysByFamily.get(fontFamily);
}

export function getFontLabel(fontFamily: string): string {
  const key = getTextFontPresetKey(fontFamily);
  if (key) return fontPresets[key].label;
  const family = fontFamily.trim();
  const quoted = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/.exec(family);
  return quoted
    ? (quoted[1] ?? quoted[2]).replace(/\\(.)/g, '$1')
    : family.split(',', 1)[0].trim();
}
export const DEFAULT_TEXT: Omit<LayerTextMeta, 'x' | 'y'> = { ...DEFAULT_LAYER_TEXT };

const VERTICAL_FORMS: Record<string, string> = {
  '「': '﹁', '」': '﹂', '『': '﹃', '』': '﹄', '（': '︵', '）': '︶', '(': '︵', ')': '︶',
  '【': '︻', '】': '︼', '《': '︽', '》': '︾', '〈': '︿', '〉': '﹀', '［': '﹇', '］': '﹈',
  '｛': '︷', '｝': '︸', '〔': '︹', '〕': '︺', '…': '︙', '‥': '︰',
  '，': '︐', '、': '︑', '。': '︒', '．': '︒', '：': '︓', '；': '︔', '！': '︕', '？': '︖',
};
const ROTATED = new Set('〘〙〚〛｟｠‹›«»ー～〜~‐‑‒–—―－');
const SMALL_KANA = new Set('ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ');
const PRINTABLE_ASCII = /^[!-~]$/;
const WORD_CHAR = /^[a-z0-9]$/i;
const SPACE = /^[\t ]$/;

export interface TextFontSpec { size: number; family: string; bold: boolean; italic: boolean }
export interface TextMeasurer { measure(text: string, font: TextFontSpec): number }
export interface PositionedGlyph {
  index: number; length: number; text: string; x: number; y: number; w: number; h: number;
  font: TextFontSpec; color: string; mode: 'upright' | 'sideways' | 'tcy' | 'rotated'; scaleX?: number; line: number;
}
type Rect = { x: number; y: number; w: number; h: number };
type TextLine = Rect & { start: number; end: number };
export interface TextLayout { width: number; height: number; glyphs: PositionedGlyph[]; lines: TextLine[] }
export interface RenderedText { canvas: HTMLCanvasElement; x: number; y: number }
export type VerticalRun = { kind: 'glyph'; text: string } | { kind: 'sideways'; text: string } | { kind: 'tcy'; text: string };

function fontString({ size, family, bold, italic }: TextFontSpec): string {
  return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${family}`;
}

export function createCanvasMeasurer(): TextMeasurer {
  const contexts = new Map<string, CanvasRenderingContext2D>();
  return {
    measure(text, font) {
      const css = fontString(font);
      let ctx = contexts.get(css);
      if (!ctx) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        ctx = canvas.getContext('2d')!;
        ctx.font = css;
        contexts.set(css, ctx);
      }
      return ctx.measureText(text).width;
    },
  };
}

type Mode = PositionedGlyph['mode'];
type VerticalSpan = { start: number; end: number; mode: Mode; text: string };

function isSidewaysAscii(char: string): boolean {
  return PRINTABLE_ASCII.test(char) && !VERTICAL_FORMS[char] && !ROTATED.has(char);
}

function* verticalSpans(chars: string[]): Generator<VerticalSpan> {
  for (let start = 0; start < chars.length;) {
    const char = chars[start];
    let end = start + 1;
    if (isSidewaysAscii(char)) {
      while (end < chars.length && (isSidewaysAscii(chars[end]) || (chars[end] === ' ' && PRINTABLE_ASCII.test(chars[end + 1] ?? '')))) end++;
      const text = chars.slice(start, end).join('');
      yield { start, end, text, mode: /^\d{1,2}$/.test(text) ? 'tcy' : 'sideways' };
    } else {
      yield { start, end, text: VERTICAL_FORMS[char] ?? char, mode: ROTATED.has(char) ? 'rotated' : 'upright' };
    }
    start = end;
  }
}

export function verticalRuns(line: string): VerticalRun[] {
  return [...verticalSpans(Array.from(line))].map(({ mode, text }) => ({
    kind: mode === 'sideways' || mode === 'tcy' ? mode : 'glyph', text,
  }));
}

type GlyphStyle = { font: TextFontSpec; color: string };
type Character = GlyphStyle & { index: number; text: string };
type Unit = GlyphStyle & {
  chars: Character[];
  text: string;
  mode: Mode;
  extent: number;
  scaleX?: number;
  tcyParts?: { char: Character; width: number }[];
};
type LinePlan = {
  start: number; end: number; size: number; flow: number; stops: number[];
  flowBeforeHanging?: number;
  offset(index: number): number;
  units?: { unit: Unit; offset: number; extent: number }[];
  whole?: { text: string; style: GlyphStyle };
};
type LayoutDetails = { meta: LayerTextMeta; plans: LinePlan[] };
const detailsByLayout = new WeakMap<TextLayout, LayoutDetails>();

function stylePicker(meta: LayerTextMeta): (index: number) => GlyphStyle {
  const runs = meta.runs ?? [];
  let runIndex = 0;
  let lastRun: (NonNullable<LayerTextMeta['runs']>[number]) | undefined;
  const convert = (index: number) => {
    const style = resolveTextStyleAt(meta, index);
    return { font: { size: style.fontSize, family: meta.fontFamily, bold: style.bold, italic: style.italic }, color: style.color };
  };
  let current = convert(-1);
  return (index) => {
    while (runIndex < runs.length && runs[runIndex].end <= index) runIndex++;
    const run = runs[runIndex]?.start <= index ? runs[runIndex] : undefined;
    if (run !== lastRun) {
      current = convert(index);
      lastRun = run;
    }
    return current;
  };
}

function characters(text: string, start: number, pickStyle: (index: number) => GlyphStyle): Character[] {
  const result: Character[] = [];
  let index = start;
  for (const char of text) {
    result.push({ index, text: char, ...pickStyle(index) });
    index += char.length;
  }
  return result;
}

function wholeHorizontalLine(text: string, start: number, end: number, style: GlyphStyle, blank: boolean, measurer: TextMeasurer): LinePlan {
  const stops = [start];
  let index = start;
  for (const char of text) {
    index += char.length;
    stops.push(index);
  }
  const flow = measurer.measure(blank ? ' ' : text, style.font);
  const cache = new Map<number, number>([[start, 0]]);
  if (end > start) cache.set(end, flow);
  return {
    start, end, size: style.font.size, flow, stops, whole: { text, style },
    offset(index) {
      // Measure prefixes on demand so whole-line shaping keeps the old caret without quadratic layout work.
      let x = cache.get(index);
      if (x === undefined) {
        x = measurer.measure(text.slice(0, index - start), style.font);
        cache.set(index, x);
      }
      return x;
    },
  };
}

function unitFor(chars: Character[], text: string, mode: Mode, vertical: boolean, measurer: TextMeasurer): Unit {
  const { font, color } = chars[0];
  if (mode === 'tcy') {
    const mixed = chars.some((char) => char.font !== font || char.color !== color);
    const tcyParts = mixed ? chars.map((char) => ({ char, width: measurer.measure(char.text, char.font) })) : undefined;
    const largest = chars.reduce((a, b) => a.font.size >= b.font.size ? a : b);
    const width = tcyParts?.reduce((sum, part) => sum + part.width, 0) ?? measurer.measure(text, font);
    return { chars, text, mode, color, font: largest.font, extent: largest.font.size,
      scaleX: Math.min(1, largest.font.size * 0.95 / Math.max(1, width)), tcyParts };
  }
  const extent = mode === 'sideways' ? Math.max(font.size * 0.5, measurer.measure(text, font))
    : vertical ? font.size : measurer.measure(text, font);
  return { chars, text, mode, color, font, extent };
}

function verticalUnits(chars: Character[], meta: LayerTextMeta, measurer: TextMeasurer): Unit[] {
  const units: Unit[] = [];
  for (const { start, end, mode, text } of verticalSpans(chars.map((char) => char.text))) {
    if (mode !== 'sideways') {
      units.push(unitFor(chars.slice(start, end), text, mode, true, measurer));
      continue;
    }
    for (let a = start; a < end;) {
      let b = a + 1;
      while (b < end && !meta.letterSpacing && chars[a].font === chars[b].font && chars[a].color === chars[b].color) b++;
      const group = chars.slice(a, b);
      const unit = unitFor(group, group.map((char) => char.text).join(''), mode, true, measurer);
      if (meta.box && unit.extent > meta.box.height && group.length > 1) {
        for (const char of group) units.push(unitFor([char], char.text, mode, true, measurer));
      } else units.push(unit);
      a = b;
    }
  }
  return units;
}

const firstChar = (unit: Unit) => unit.chars[0].text;
const lastChar = (unit: Unit) => unit.chars[unit.chars.length - 1].text;
const step = (unit: Unit, spacing: number) => Math.max(0, unit.extent + unit.font.size * spacing);

function breakAfter(units: Unit[], start: number, fit: number, flow: number, limit: number, spacing: number, kinsoku: boolean): number {
  const legal = (end: number) => end === units.length || !kinsoku || (
    !KINSOKU_NOT_AT_LINE_END.has(lastChar(units[end - 1])) && !KINSOKU_NOT_AT_LINE_START.has(firstChar(units[end]))
  );
  if (kinsoku && KINSOKU_NOT_AT_LINE_START.has(firstChar(units[fit])) && legal(fit + 1)) {
    const hanging = flow - units[fit - 1].extent + step(units[fit - 1], spacing) + units[fit].extent;
    if (flow <= limit && hanging <= limit + units[fit].font.size) return fit + 1;
  }
  let emergency: number | undefined;
  for (let end = fit; end > start; end--) {
    if (!legal(end)) continue;
    emergency ??= end;
    if (!WORD_CHAR.test(lastChar(units[end - 1])) || !WORD_CHAR.test(firstChar(units[end]))) return end;
  }
  return emergency ?? fit;
}

function unitEnd(unit: Unit): number {
  const last = unit.chars[unit.chars.length - 1];
  return last.index + last.text.length;
}

function planUnits(units: Unit[], start: number, end: number, size: number, spacing: number, measurer: TextMeasurer, trimAt = Infinity, limit = Infinity): LinePlan {
  const stops: number[] = [];
  const offsets = new Map<number, number>();
  let distance = 0;
  let flow = 0;
  const positions = units.map((unit, i) => {
    const offset = i >= trimAt ? Math.min(limit, distance) : distance;
    const extent = i >= trimAt ? Math.min(unit.extent, limit - offset) : unit.extent;
    unit.chars.forEach((char, j) => {
      stops.push(char.index);
      if (j === 0) offsets.set(char.index, offset);
      else if (unit.mode === 'tcy') offsets.set(char.index, offset + extent * j / unit.chars.length);
    });
    distance += step(unit, spacing);
    flow = offset + extent;
    return { unit, offset, extent };
  });
  stops.push(end);
  offsets.set(end, flow);
  return {
    start, end, stops, flow, units: positions,
    size: units.length ? units.reduce((largest, unit) => Math.max(largest, unit.font.size), 0) : size,
    offset(index) {
      const stop = stops[lastAtMost(stops, index)];
      const cached = offsets.get(stop);
      if (cached !== undefined) return cached;
      const { unit, offset } = positions[lastAtMost(positions, stop, (position) => position.unit.chars[0].index)];
      const x = offset + measurer.measure(unit.text.slice(0, stop - unit.chars[0].index), unit.font);
      offsets.set(stop, x);
      return x;
    },
  };
}

function paragraphPlans(units: Unit[], start: number, end: number, meta: LayerTextMeta, measurer: TextMeasurer): LinePlan[] {
  const spacing = (meta.letterSpacing ?? 0) / 1000;
  if (!meta.box || !units.length) return [planUnits(units, start, end, meta.fontSize, spacing, measurer)];
  const limit = meta.vertical ? meta.box.height : meta.box.width;
  const lines: LinePlan[] = [];
  for (let a = 0; a < units.length;) {
    let fit = a;
    let offset = 0;
    let flow = 0;
    for (; fit < units.length; fit++) {
      const next = offset + units[fit].extent;
      if (fit > a && next > limit) break;
      flow = next;
      offset += step(units[fit], spacing);
    }
    let b = fit;
    let trimAt = Infinity;
    if (fit < units.length) {
      const endsWithOpener = meta.kinsoku !== false && KINSOKU_NOT_AT_LINE_END.has(lastChar(units[fit - 1]));
      if (!meta.vertical && !endsWithOpener && !SPACE.test(lastChar(units[a])) && SPACE.test(firstChar(units[fit]))) {
        trimAt = fit - a;
        while (b < units.length && SPACE.test(firstChar(units[b]))) b++;
      } else b = breakAfter(units, a, fit, flow, limit, spacing, meta.kinsoku !== false);
    }
    const line = planUnits(units.slice(a, b), units[a].chars[0].index, unitEnd(units[b - 1]), meta.fontSize, spacing, measurer, trimAt, limit);
    if (b > fit && trimAt === Infinity) line.flowBeforeHanging = flow;
    lines.push(line);
    a = b;
  }
  return lines;
}

function alignedOffset(space: number, align: LayerTextMeta['align']): number {
  return align === 'center' ? space / 2 : align === 'end' ? space : 0;
}

function appendGlyphs(glyphs: PositionedGlyph[], plan: LinePlan, line: TextLine, n: number, vertical: boolean, center: number): void {
  if (plan.whole) {
    const { text, style } = plan.whole;
    for (let i = 0; i + 1 < plan.stops.length; i++) {
      const index = plan.stops[i];
      const end = plan.stops[i + 1];
      glyphs.push({ ...style, index, length: end - index, text: text.slice(index - line.start, end - line.start),
        get x() { return line.x + plan.offset(index); }, y: line.y,
        get w() { return plan.offset(end) - plan.offset(index); }, h: plan.size, mode: 'upright', line: n });
    }
    return;
  }
  for (const { unit, offset, extent } of plan.units ?? []) {
    const { font, color, text, mode, scaleX } = unit;
    const index = unit.chars[0].index;
    if (!vertical) {
      // Approximate a common baseline when multiple font sizes share a line.
      glyphs.push({ index, length: unitEnd(unit) - index, text, font, color, mode, line: n,
        x: line.x + offset, y: line.y + (plan.size - font.size) * 0.8, w: extent, h: font.size });
      continue;
    }
    const top = line.y + offset;
    if (unit.tcyParts) {
      const scale = scaleX ?? 1;
      let x = center - unit.tcyParts.reduce((sum, part) => sum + part.width, 0) * scale / 2;
      for (const { char, width } of unit.tcyParts) {
        const w = width * scale;
        glyphs.push({ ...char, length: char.text.length, mode, scaleX, line: n,
          x, y: top + (font.size - char.font.size) * 0.8, w, h: char.font.size });
        x += w;
      }
    } else {
      const kanaShift = SMALL_KANA.has(text) ? font.size * 0.1 : 0;
      glyphs.push({ index, length: unitEnd(unit) - index, text, font, color, mode, scaleX, line: n,
        x: center - font.size / 2 + kanaShift, y: top - kanaShift, w: font.size, h: extent });
    }
  }
}

function isLegacy(meta: LayerTextMeta): boolean {
  return meta.runs === undefined && meta.bold === undefined && meta.italic === undefined && meta.letterSpacing === undefined &&
    meta.align === undefined && meta.box === undefined && meta.paintOrder === undefined && meta.shadow === undefined && meta.kinsoku === undefined;
}

export function layoutText(meta: LayerTextMeta, measurer: TextMeasurer): TextLayout {
  const legacy = isLegacy(meta);
  const source = legacy ? { ...meta, content: meta.content || '', fontSize: Math.max(4, meta.fontSize), lineHeight: Math.max(0.5, meta.lineHeight) }
    : normalizeTextMeta(meta)!;
  const pickStyle = stylePicker(source);
  const whole = !source.vertical && !source.box && !source.letterSpacing && !source.runs?.length;
  const plans: LinePlan[] = [];
  let start = 0;
  for (const text of source.content.split('\n')) {
    const end = start + text.length;
    if (whole) plans.push(wholeHorizontalLine(text, start, end, pickStyle(start), !source.content, measurer));
    else {
      const chars = characters(text, start, pickStyle);
      const units = source.vertical ? verticalUnits(chars, source, measurer)
        : chars.map((char) => unitFor([char], char.text, 'upright', false, measurer));
      plans.push(...paragraphPlans(units, start, end, source, measurer));
    }
    start = end + 1;
  }
  const longest = plans.reduce((max, plan) => Math.max(max, plan.flow), source.vertical && !source.content ? source.fontSize : 1);
  const advances = plans.map((plan) => plan.size * source.lineHeight);
  const crossSize = legacy ? advances.length * advances[0] : advances.reduce((total, advance) => total + advance, 0);
  const width = source.box?.width ?? (source.vertical ? crossSize : longest);
  const height = source.box?.height ?? (source.vertical ? longest : crossSize);
  const glyphs: PositionedGlyph[] = [];
  let cross = 0;
  const lines = plans.map((plan, i) => {
    const advance = advances[i];
    const flow = alignedOffset((source.vertical ? height : width) - (plan.flowBeforeHanging ?? plan.flow), source.align);
    const line: TextLine = source.vertical
      ? { start: plan.start, end: plan.end, x: width - cross - advance, y: flow, w: advance, h: plan.flow }
      : { start: plan.start, end: plan.end, x: flow, y: cross, w: plan.flow, h: advance };
    const center = legacy ? width - (i + 0.5) * advance : line.x + line.w / 2;
    appendGlyphs(glyphs, plan, line, i, source.vertical, center);
    cross = legacy ? (i + 1) * advance : cross + advance;
    return line;
  });
  const layout = { width, height, glyphs, lines };
  detailsByLayout.set(layout, { meta: source, plans });
  return layout;
}

function lastAtMost<T>(items: readonly T[], value: number, key: (item: T) => number = (item) => Number(item)): number {
  let a = 0;
  let b = items.length;
  while (a < b) {
    const mid = (a + b) >>> 1;
    if (key(items[mid]) <= value) a = mid + 1;
    else b = mid;
  }
  return Math.max(0, a - 1);
}

export function caretRectFromLayout(layout: TextLayout, meta: LayerTextMeta, index: number): Rect {
  const { plans, meta: source } = detailsByLayout.get(layout)!;
  const at = Math.max(0, Math.min(source.content.length, Math.trunc(index) || 0));
  const n = lastAtMost(layout.lines, at, (line) => line.start);
  const line = layout.lines[n];
  const plan = plans[n];
  const thickness = Math.max(1.5, plan.size / 24);
  const legacyVertical = meta.vertical && isLegacy(meta);
  let position = at;
  if (legacyVertical) {
    // The old vertical caret counted a partial surrogate pair as one character.
    const stop = lastAtMost(plan.stops, at);
    if (plan.stops[stop] !== at) position = plan.stops[stop + 1];
  }
  const along = plan.offset(position);
  const center = legacyVertical ? layout.width - (n + 0.5) * line.w : line.x + line.w / 2;
  return meta.vertical
    ? { x: center - plan.size / 2, y: line.y + along, w: plan.size, h: thickness }
    : { x: line.x + along, y: line.y, w: thickness, h: line.h };
}

export function selectionRectsFromLayout(layout: TextLayout, start: number, end: number): Rect[] {
  const { meta, plans } = detailsByLayout.get(layout)!;
  const lower = Math.min(start, end);
  const upper = Math.max(start, end);
  const rects: Rect[] = [];
  layout.lines.forEach((line, i) => {
    const a = Math.max(lower, line.start);
    const b = Math.min(upper, line.end);
    if (a >= b) return;
    const from = plans[i].offset(a);
    const to = plans[i].offset(b);
    if (meta.vertical) rects.push({ x: line.x, y: line.y + from, w: line.w, h: to - from });
    else rects.push({ x: line.x + from, y: line.y, w: to - from, h: line.h });
  });
  return rects;
}

export function indexAtPoint(layout: TextLayout, meta: LayerTextMeta, x: number, y: number): number {
  const { plans } = detailsByLayout.get(layout)!;
  const cross = meta.vertical ? x : y;
  let n = 0;
  let distance = Infinity;
  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i];
    const start = meta.vertical ? line.x : line.y;
    const size = meta.vertical ? line.w : line.h;
    const gap = Math.max(start - cross, 0, cross - start - size);
    if (gap < distance || (gap === distance && cross >= start && cross < start + size)) {
      distance = gap;
      n = i;
    }
  }
  const line = layout.lines[n];
  const plan = plans[n];
  const along = meta.vertical ? y - line.y : x - line.x;
  const i = lastAtMost(plan.stops, along, (at) => plan.offset(at));
  const left = plan.stops[i];
  const right = plan.stops[i + 1];
  return right !== undefined && along - plan.offset(left) > plan.offset(right) - along ? right : left;
}

function drawGlyph(ctx: CanvasRenderingContext2D, glyph: PositionedGlyph, vertical: boolean, stroke: boolean): void {
  const { text, x, y, w, h, mode } = glyph;
  const draw = (left: number, top: number) => stroke ? ctx.strokeText(text, left, top) : ctx.fillText(text, left, top);
  ctx.font = fontString(glyph.font);
  if (!stroke) ctx.fillStyle = glyph.color;
  ctx.textAlign = vertical ? 'center' : 'left';
  ctx.textBaseline = 'top';
  if (mode === 'sideways' || mode === 'rotated') {
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(Math.PI / 2);
    ctx.textBaseline = 'middle';
    if (mode === 'sideways') ctx.textAlign = 'left';
    draw(mode === 'sideways' ? -h / 2 : 0, 0);
    ctx.restore();
  } else if (mode === 'tcy') {
    ctx.save();
    ctx.translate(x + w / 2, y);
    ctx.scale(glyph.scaleX ?? 1, 1);
    draw(0, 0);
    ctx.restore();
  } else draw(vertical ? x + w / 2 : x, y);
}

function shadowColor(shadow: NonNullable<LayerTextMeta['shadow']>): string {
  let hex = shadow.color.slice(1);
  if (hex.length === 3) hex = Array.from(hex, (digit) => digit + digit).join('');
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return `rgba(${rgb.join(', ')}, ${alpha * shadow.opacity})`;
}

export function renderText(meta: LayerTextMeta): RenderedText {
  const layout = layoutText(meta, createCanvasMeasurer());
  const { meta: source, plans } = detailsByLayout.get(layout)!;
  const pad = Math.ceil(source.strokeWidth + 2);
  let left = 0;
  let top = 0;
  let right = layout.width;
  let bottom = layout.height;
  if (source.box) {
    for (const line of layout.lines) {
      left = Math.min(left, line.x);
      top = Math.min(top, line.y);
      right = Math.max(right, line.x + line.w);
      bottom = Math.max(bottom, line.y + line.h);
    }
  }
  if (source.vertical || !plans[0].whole) {
    const legacy = isLegacy(meta);
    for (const glyph of layout.glyphs) {
      if (legacy && !SMALL_KANA.has(glyph.text)) continue;
      left = Math.min(left, glyph.x);
      top = Math.min(top, glyph.y);
      right = Math.max(right, glyph.x + glyph.w);
      bottom = Math.max(bottom, glyph.y + glyph.h);
    }
  }
  const originX = Math.floor(left) - pad;
  const originY = Math.floor(top) - pad;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(right + (pad - originX));
  canvas.height = Math.ceil(bottom + (pad - originY));
  const ctx = canvas.getContext('2d')!;
  ctx.translate(-originX, -originY);
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.strokeStyle = source.strokeColor;
  const front = source.paintOrder === 'stroke-front';
  if (source.strokeWidth > 0) ctx.lineWidth = source.strokeWidth * (front ? 1 : 2);
  const passes = source.strokeWidth === 0 ? [false] : front ? [false, true] : [true, false];
  for (const stroke of passes) {
    if (plans[0].whole) {
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      plans.forEach(({ whole }, i) => {
        const line = layout.lines[i];
        const { text, style } = whole!;
        ctx.font = fontString(style.font);
        if (stroke) ctx.strokeText(text, line.x, line.y);
        else {
          ctx.fillStyle = style.color;
          ctx.fillText(text, line.x, line.y);
        }
      });
    } else for (const glyph of layout.glyphs) drawGlyph(ctx, glyph, source.vertical, stroke);
  }

  const { shadow } = source;
  if (!shadow || shadow.opacity === 0) return { canvas, x: Math.round(source.x + originX), y: Math.round(source.y + originY) };
  const blurMargin = 2 * shadow.blur;
  const margin = (offset: number) => Math.max(0, Math.ceil(blurMargin + offset));
  const padLeft = margin(-shadow.offsetX);
  const padTop = margin(-shadow.offsetY);
  const output = document.createElement('canvas');
  output.width = canvas.width + padLeft + margin(shadow.offsetX);
  output.height = canvas.height + padTop + margin(shadow.offsetY);
  const composite = output.getContext('2d')!;
  composite.shadowColor = shadowColor(shadow);
  composite.shadowBlur = shadow.blur;
  composite.shadowOffsetX = shadow.offsetX;
  composite.shadowOffsetY = shadow.offsetY;
  composite.drawImage(canvas, padLeft, padTop);
  return { canvas: output, x: Math.round(source.x + originX - padLeft), y: Math.round(source.y + originY - padTop) };
}

export function caretRect(meta: LayerTextMeta, index: number): Rect {
  return caretRectFromLayout(layoutText(meta, createCanvasMeasurer()), meta, index);
}

export function textBounds(meta: LayerTextMeta) {
  const r = renderText(meta);
  return { x: r.x, y: r.y, width: r.canvas.width, height: r.canvas.height };
}

export function textBoxRect(meta: LayerTextMeta): Rect {
  const layout = layoutText(meta, createCanvasMeasurer());
  const { meta: source } = detailsByLayout.get(layout)!;
  // Both orientations anchor at the box's top-left. Vertical flow starts at its right edge.
  if (source.box) return { x: source.x, y: source.y, w: source.box.width, h: source.box.height };
  return { x: Math.round(source.x), y: Math.round(source.y), w: Math.max(1, Math.ceil(layout.width)), h: Math.max(1, Math.ceil(layout.height)) };
}
