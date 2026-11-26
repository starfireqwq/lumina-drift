import type { LayerTextMeta, TextStyleRun } from '../types/models';

export const DEFAULT_LAYER_TEXT: Readonly<Omit<LayerTextMeta, 'x' | 'y'>> = Object.freeze({
  content: '',
  vertical: false,
  fontFamily: '"Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif',
  fontSize: 48,
  color: '#000000',
  strokeColor: '#ffffff',
  strokeWidth: 0,
  lineHeight: 1.3,
});

export const KINSOKU_NOT_AT_LINE_START: ReadonlySet<string> = new Set(
  '、。，．・：；？！ー…‥」』）】〉》〕｝］〙〛｠›»ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ,.!?:;)]}',
);
export const KINSOKU_NOT_AT_LINE_END: ReadonlySet<string> = new Set('「『（【〈《〔｛［〘〚｟‹«([{');

type TextStyle = Required<Omit<TextStyleRun, 'start' | 'end'>>;
type TextStylePatch = { [K in keyof TextStyle]?: TextStyle[K] | null };
const STYLE_KEYS = ['color', 'fontSize', 'bold', 'italic'] as const;
const MAX_CONTENT = 20_000;
const MAX_RUNS = 500;
const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i;

function record(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: object, key: PropertyKey): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function number(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function offset(value: unknown, length: number): number {
  return Math.trunc(number(value, 0, 0, length));
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback;
}

function sameStyle(a: Partial<TextStyle>, b: Partial<TextStyle>): boolean {
  return STYLE_KEYS.every((key) => a[key] === b[key]);
}

function appendRun(runs: TextStyleRun[], start: number, end: number, style: Partial<TextStyle>): void {
  if (start >= end || !STYLE_KEYS.some((key) => style[key] !== undefined)) return;
  const last = runs.at(-1);
  if (last?.end === start && sameStyle(last, style)) last.end = end;
  else if (runs.length < MAX_RUNS) runs.push({ ...style, start, end });
}

function normalizeRuns(raw: unknown, length: number, defaultColor: string, defaultSize: number): TextStyleRun[] {
  if (!Array.isArray(raw) || length === 0) return [];
  const spans: TextStyleRun[] = [];
  for (const key of Object.keys(raw)) {
    if (!/^(?:0|[1-9]\d*)$/.test(key) || +key >= raw.length) continue;
    const candidate = own(raw, key);
    if (!record(candidate)) continue;
    const start = offset(own(candidate, 'start'), length);
    const end = offset(own(candidate, 'end'), length);
    if (start >= end) continue;
    const span: TextStyleRun = { start, end };
    const runColor = own(candidate, 'color');
    const fontSize = own(candidate, 'fontSize');
    const bold = own(candidate, 'bold');
    const italic = own(candidate, 'italic');
    if (runColor !== undefined && runColor !== null) span.color = color(runColor, defaultColor);
    if (typeof fontSize === 'number') span.fontSize = number(fontSize, defaultSize, 4, 1000);
    if (typeof bold === 'boolean') span.bold = bold;
    if (typeof italic === 'boolean') span.italic = italic;
    if (STYLE_KEYS.some((key) => span[key] !== undefined)) spans.push(span);
  }

  // Later starts win per property. Equal starts keep the input order.
  spans.sort((a, b) => a.start - b.start);
  const boundaries = [...new Set(spans.flatMap(({ start, end }) => [start, end]))].sort((a, b) => a - b);
  const active: Record<keyof TextStyle, TextStyleRun[]> = { color: [], fontSize: [], bold: [], italic: [] };
  const result: TextStyleRun[] = [];
  let next = 0;
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const start = boundaries[i];
    while (next < spans.length && spans[next].start === start) {
      const span = spans[next++];
      for (const key of STYLE_KEYS) if (span[key] !== undefined) active[key].push(span);
    }
    const style: Partial<TextStyle> = {};
    const readActive = <K extends keyof TextStyle>(key: K) => {
      const stack = active[key];
      while (stack.length && stack[stack.length - 1].end <= start) stack.pop();
      const value = stack.at(-1)?.[key];
      if (value !== undefined) style[key] = value;
    };
    for (const key of STYLE_KEYS) readActive(key);
    appendRun(result, start, boundaries[i + 1], style);
  }
  return result;
}

export function normalizeTextMeta(raw: unknown): LayerTextMeta | null {
  if (!record(raw)) return null;
  const content = own(raw, 'content');
  const fontFamily = own(raw, 'fontFamily');
  const meta: LayerTextMeta = {
    content: typeof content === 'string' ? content.slice(0, MAX_CONTENT) : DEFAULT_LAYER_TEXT.content,
    x: number(own(raw, 'x'), 0),
    y: number(own(raw, 'y'), 0),
    vertical: own(raw, 'vertical') === true,
    fontFamily: typeof fontFamily === 'string' && fontFamily.trim() ? fontFamily : DEFAULT_LAYER_TEXT.fontFamily,
    fontSize: number(own(raw, 'fontSize'), DEFAULT_LAYER_TEXT.fontSize, 4, 1000),
    color: color(own(raw, 'color'), DEFAULT_LAYER_TEXT.color),
    strokeColor: color(own(raw, 'strokeColor'), DEFAULT_LAYER_TEXT.strokeColor),
    strokeWidth: number(own(raw, 'strokeWidth'), DEFAULT_LAYER_TEXT.strokeWidth, 0, 100),
    lineHeight: number(own(raw, 'lineHeight'), DEFAULT_LAYER_TEXT.lineHeight, 0.5, 5),
  };
  for (const key of ['bold', 'italic', 'kinsoku'] as const) {
    const value = own(raw, key);
    if (typeof value === 'boolean') meta[key] = value;
  }
  const letterSpacing = own(raw, 'letterSpacing');
  if (typeof letterSpacing === 'number') meta.letterSpacing = number(letterSpacing, 0, -200, 1000);
  const align = own(raw, 'align');
  if (align === 'start' || align === 'center' || align === 'end') meta.align = align;
  const paintOrder = own(raw, 'paintOrder');
  if (paintOrder === 'stroke-behind' || paintOrder === 'stroke-front') meta.paintOrder = paintOrder;
  const box = own(raw, 'box');
  if (box === null) meta.box = null;
  else if (record(box)) {
    meta.box = { width: number(own(box, 'width'), 1, 1, 20_000), height: number(own(box, 'height'), 1, 1, 20_000) };
  }
  const shadow = own(raw, 'shadow');
  if (shadow === null) meta.shadow = null;
  else if (record(shadow)) {
    meta.shadow = {
      color: color(own(shadow, 'color'), DEFAULT_LAYER_TEXT.color),
      offsetX: number(own(shadow, 'offsetX'), 0, -1000, 1000),
      offsetY: number(own(shadow, 'offsetY'), 0, -1000, 1000),
      blur: number(own(shadow, 'blur'), 0, 0, 200),
      opacity: number(own(shadow, 'opacity'), 1, 0, 1),
    };
  }
  const runs = normalizeRuns(own(raw, 'runs'), meta.content.length, meta.color, meta.fontSize);
  if (runs.length) meta.runs = runs;
  return meta;
}

export function resolveTextStyleAt(meta: LayerTextMeta, index: number): TextStyle {
  const style: TextStyle = { color: meta.color, fontSize: meta.fontSize, bold: meta.bold ?? false, italic: meta.italic ?? false };
  const latest = { color: -Infinity, fontSize: -Infinity, bold: -Infinity, italic: -Infinity };
  for (const run of meta.runs ?? []) {
    if (index < run.start || index >= run.end) continue;
    for (const key of STYLE_KEYS) {
      const value = run[key];
      if (value === undefined || run.start < latest[key]) continue;
      latest[key] = run.start;
      Object.assign(style, { [key]: value });
    }
  }
  return style;
}

export function applyTextStyleToRange(meta: LayerTextMeta, start: number, end: number, patch: TextStylePatch): LayerTextMeta {
  const next = normalizeTextMeta(meta)!;
  const a = offset(Math.min(start, end), next.content.length);
  const b = offset(Math.max(start, end), next.content.length);
  const changed = STYLE_KEYS.filter((key) => own(patch, key) !== undefined);
  if (!changed.length) return next;
  const apply = (style: object, whole: boolean) => {
    for (const key of changed) {
      const value = own(patch, key);
      if (whole || value !== null) Object.assign(style, { [key]: value });
      else Reflect.deleteProperty(style, key);
    }
  };
  if (start === end) {
    apply(next, true);
    for (const run of next.runs ?? []) for (const key of changed) delete run[key];
  } else if (a < b) {
    const runs = next.runs ?? [];
    const boundaries = [...new Set([a, b, ...runs.flatMap((run) => [run.start, run.end])])].sort((x, y) => x - y);
    next.runs = [];
    let ri = 0;
    for (let i = 0; i + 1 < boundaries.length; i++) {
      const start = boundaries[i];
      const end = boundaries[i + 1];
      while (ri < runs.length && runs[ri].end <= start) ri++;
      const run = runs[ri];
      const span = run && run.start <= start ? { ...run, start, end } : { start, end };
      if (start >= a && start < b) apply(span, false);
      next.runs.push(span);
    }
  }
  return normalizeTextMeta(next)!;
}

export function remapTextRuns(runs: readonly TextStyleRun[] = [], oldContent: string, newContent: string): TextStyleRun[] {
  const oldLength = Math.min(oldContent.length, MAX_CONTENT);
  const newLength = Math.min(newContent.length, MAX_CONTENT);
  const current = normalizeRuns(runs, oldLength, DEFAULT_LAYER_TEXT.color, DEFAULT_LAYER_TEXT.fontSize);
  let start = 0;
  while (start < Math.min(oldLength, newLength) && oldContent[start] === newContent[start]) start++;
  let oldEnd = oldLength;
  let newEnd = newLength;
  while (oldEnd > start && newEnd > start && oldContent[oldEnd - 1] === newContent[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const result: TextStyleRun[] = [];
  for (const run of current) appendRun(result, run.start, Math.min(run.end, start), run);
  const inheritedAt = start > 0 ? start - 1 : oldEnd;
  const inherited = current.find((run) => run.start <= inheritedAt && inheritedAt < run.end);
  if (inherited) appendRun(result, start, newEnd, inherited);
  const delta = newEnd - oldEnd;
  for (const run of current) appendRun(result, Math.max(run.start, oldEnd) + delta, run.end + delta, run);
  return result;
}
