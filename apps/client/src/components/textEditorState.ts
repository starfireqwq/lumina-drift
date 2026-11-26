import { remapTextRuns, resolveTextStyleAt, type LayerTextMeta } from '@atelier/shared';

type TextStyle = ReturnType<typeof resolveTextStyleAt>;

export function getToolbarTextStyle(meta: LayerTextMeta, start: number, end: number) {
  const first = resolveTextStyleAt(meta, Math.min(start, Math.max(0, meta.content.length - 1)));
  const mixed = { color: false, fontSize: false, bold: false, italic: false };
  const keys = Object.keys(mixed) as (keyof TextStyle)[];
  const compare = (style: TextStyle) => {
    mixed.color ||= style.color.toLowerCase() !== first.color.toLowerCase();
    for (const key of keys) if (key !== 'color') mixed[key] ||= style[key] !== first[key];
  };
  if (start < end) {
    // Normalized runs are sorted and disjoint. Include any gaps with the base style.
    const base = resolveTextStyleAt(meta, meta.content.length);
    let cursor = start;
    for (const run of meta.runs ?? []) {
      if (run.end <= start) continue;
      if (run.start >= end) break;
      if (cursor < run.start) compare(base);
      compare({ ...base, ...run });
      cursor = run.end;
    }
    if (cursor < end) compare(base);
  }
  return { style: first, mixed };
}

export function updateTextContent(meta: LayerTextMeta, content: string, before = meta): LayerTextMeta {
  const runs = before.content === content ? before.runs : remapTextRuns(before.runs, before.content, content);
  const next = { ...meta, content };
  if (runs?.length) next.runs = runs;
  else delete next.runs;
  return next;
}

type TextBox = NonNullable<LayerTextMeta['box']>;
const boxDimension = (value: number) => Math.max(1, Math.min(20_000, Math.round(value)));

export function initialTextBox(meta: LayerTextMeta, rect: { w: number; h: number }): TextBox {
  const minFlow = Math.ceil(meta.fontSize * 4);
  return {
    width: boxDimension(Math.max(rect.w, meta.vertical ? 1 : minFlow)),
    height: boxDimension(Math.max(rect.h, meta.vertical ? minFlow : 1)),
  };
}

export function resizeTextBox(box: TextBox, x: number, vertical: boolean, dx: number, dy: number) {
  const width = boxDimension(box.width + (vertical ? -dx : dx));
  const height = boxDimension(box.height + dy);
  return { x: vertical ? x + box.width - width : x, box: { width, height } };
}
