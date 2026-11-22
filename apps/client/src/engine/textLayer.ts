import type { LayerTextMeta } from '@atelier/shared';

export const TEXT_FONTS: Array<{ id: string; label: string }> = [
  { id: '"Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif', label: '黑體' },
  { id: '"Noto Serif TC", "PMingLiU", "Songti TC", serif', label: '明體' },
  { id: '"DFKai-SB", "BiauKai", "Kaiti TC", cursive', label: '楷體' },
  { id: '"Comic Sans MS", "Comic Neue", cursive', label: '手寫' },
  { id: 'monospace', label: '等寬' },
];

export const DEFAULT_TEXT: Omit<LayerTextMeta, 'x' | 'y'> = {
  content: '',
  vertical: false,
  fontFamily: TEXT_FONTS[0].id,
  fontSize: 48,
  color: '#000000',
  strokeColor: '#ffffff',
  strokeWidth: 0,
  lineHeight: 1.3,
};

// Vertical writing uses the vertical forms of brackets, dashes and punctuation (CJK presentation
// forms: the comma and full stop sit in the top-right of their cell, as in printed manga)
const VERTICAL_FORMS: Record<string, string> = {
  '「': '﹁', '」': '﹂', '『': '﹃', '』': '﹄', '（': '︵', '）': '︶', '(': '︵', ')': '︶',
  '【': '︻', '】': '︼', '《': '︽', '》': '︾', '〈': '︿', '〉': '﹀', '［': '﹇', '］': '﹈',
  '｛': '︷', '｝': '︸', '〔': '︹', '〕': '︺', 'ー': '丨', '—': '︱', '…': '︙', '‥': '︰',
  '～': '≀', '~': '≀', '，': '︐', '、': '︑', '。': '︒', '：': '︓', '；': '︔', '！': '︕', '？': '︖',
};

/**
 * One column of vertical text: CJK upright; a run of Latin letters / words lies on its side
 * (turned 90° clockwise, as CSS text-orientation: mixed); a 1–2 digit number stands upright in
 * one cell side by side (縱中橫, tate-chu-yoko).
 */
export type VerticalRun = { kind: 'glyph'; text: string } | { kind: 'sideways'; text: string } | { kind: 'tcy'; text: string };
export function verticalRuns(line: string): VerticalRun[] {
  const out: VerticalRun[] = [];
  const chars = Array.from(line);
  for (let i = 0; i < chars.length; ) {
    // printable ASCII (letters, digits, Latin punctuation, spaces between them) groups into one run
    if (/[!-~]/.test(chars[i]) && !(chars[i] in VERTICAL_FORMS)) {
      let j = i;
      while (j < chars.length && (/[!-~]/.test(chars[j]) || (chars[j] === ' ' && /[!-~]/.test(chars[j + 1] ?? ''))) && !(chars[j] in VERTICAL_FORMS)) j++;
      const text = chars.slice(i, j).join('');
      out.push(/^\d{1,2}$/.test(text) ? { kind: 'tcy', text } : { kind: 'sideways', text });
      i = j;
    } else {
      out.push({ kind: 'glyph', text: VERTICAL_FORMS[chars[i]] ?? chars[i] });
      i++;
    }
  }
  return out;
}

export interface RenderedText {
  canvas: HTMLCanvasElement;
  /** Where the canvas goes on the picture (it includes room for the outline) */
  x: number;
  y: number;
}

/**
 * Draws a text layer's text. meta.x / y is the top-left of the text block; vertical text runs in
 * columns from right to left, each line one column, as in manga.
 */
export function renderText(meta: LayerTextMeta): RenderedText {
  const size = Math.max(4, meta.fontSize);
  const font = `${size}px ${meta.fontFamily}`;
  const lines = (meta.content || ' ').split('\n');
  const advance = size * Math.max(0.5, meta.lineHeight);
  const pad = Math.ceil(meta.strokeWidth + 2);

  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const longest = (fn: (line: string) => number) => Math.max(1, ...lines.map(fn));
  // Vertical: how far each run reaches down its column (a sideways word is as long as it is wide)
  const runLength = (r: VerticalRun) => (r.kind === 'sideways' ? Math.max(size * 0.5, measure.measureText(r.text).width) : size);
  const columns = meta.vertical ? lines.map((l) => verticalRuns(l)) : [];
  const w = meta.vertical ? lines.length * advance : longest((l) => measure.measureText(l).width);
  const h = meta.vertical ? Math.max(1, ...columns.map((runs) => runs.reduce((n, r) => n + runLength(r), 0))) : lines.length * advance;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w + pad * 2);
  canvas.height = Math.ceil(h + pad * 2);
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.fillStyle = meta.color;
  ctx.strokeStyle = meta.strokeColor;
  ctx.lineWidth = meta.strokeWidth * 2; // half of a stroke falls inside the glyph and is covered

  if (meta.vertical) {
    ctx.textAlign = 'center';
    // Outline first for every glyph, then fill, so neighbouring outlines never cover a glyph
    for (const pass of meta.strokeWidth > 0 ? ['stroke', 'fill'] : ['fill']) {
      const draw = (text: string, x: number, y: number) => (pass === 'stroke' ? ctx.strokeText(text, x, y) : ctx.fillText(text, x, y));
      columns.forEach((runs, col) => {
        const cx = pad + w - (col + 0.5) * advance;
        let y = pad;
        for (const r of runs) {
          if (r.kind === 'glyph') {
            draw(r.text, cx, y);
          } else if (r.kind === 'tcy') {
            // Two digits side by side in one cell, squeezed to fit its width
            const tw = measure.measureText(r.text).width;
            ctx.save();
            ctx.translate(cx, y);
            ctx.scale(Math.min(1, (size * 0.95) / Math.max(1, tw)), 1);
            draw(r.text, 0, 0);
            ctx.restore();
          } else {
            // Turned 90° clockwise: the word runs down the column, centred on it
            ctx.save();
            ctx.translate(cx, y);
            ctx.rotate(Math.PI / 2);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            draw(r.text, 0, 0);
            ctx.restore();
          }
          y += runLength(r);
        }
      });
    }
  } else {
    ctx.textAlign = 'left';
    if (meta.strokeWidth > 0) lines.forEach((line, i) => ctx.strokeText(line, pad, pad + i * advance));
    lines.forEach((line, i) => ctx.fillText(line, pad, pad + i * advance));
  }
  return { canvas, x: Math.round(meta.x - pad), y: Math.round(meta.y - pad) };
}

/**
 * Where the caret goes after `index` characters of meta.content, in canvas pixels relative to
 * (meta.x, meta.y), laid out exactly as renderText draws (縱中橫 digits take one cell, a lone space
 * one cell, sideways words their width). The textarea's own caret follows the browser's layout,
 * which drifts from the drawing after every number or space in vertical text.
 */
export function caretRect(meta: LayerTextMeta, index: number): { x: number; y: number; w: number; h: number } {
  const size = Math.max(4, meta.fontSize);
  const advance = size * Math.max(0.5, meta.lineHeight);
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `${size}px ${meta.fontFamily}`;
  const before = (meta.content || '').slice(0, Math.max(0, index)); // index: the textarea's selectionStart (UTF-16)
  const lines = (meta.content || ' ').split('\n');
  const line = before.split('\n').length - 1;
  const inLine = before.slice(before.lastIndexOf('\n') + 1);
  if (!meta.vertical) return { x: measure.measureText(inLine).width, y: line * advance, w: Math.max(1.5, size / 24), h: advance };
  const w = lines.length * advance;
  const cx = w - (line + 0.5) * advance;
  // Walk the column's runs up to the caret
  let y = 0;
  let left = Array.from(inLine).length;
  for (const r of verticalRuns(lines[line] ?? '')) {
    if (left <= 0) break;
    const n = Array.from(r.text).length;
    const full = r.kind === 'sideways' ? Math.max(size * 0.5, measure.measureText(r.text).width) : size * (r.kind === 'tcy' ? 1 : n);
    if (left >= n) {
      y += full;
      left -= n;
      continue;
    }
    // Inside a run: a sideways word by the width of its first characters, a 縱中橫 cell by share
    y += r.kind === 'sideways' ? measure.measureText(Array.from(r.text).slice(0, left).join('')).width : (full * left) / n;
    left = 0;
  }
  return { x: cx - size / 2, y, w: size, h: Math.max(1.5, size / 24) };
}

/** The text block's box on the picture, for hit-testing a click */
export function textBounds(meta: LayerTextMeta) {
  const r = renderText(meta);
  return { x: r.x, y: r.y, width: r.canvas.width, height: r.canvas.height };
}

/**
 * The editable text box frame in canvas coordinates (matching the frame shown by TextCanvasEditor,
 * without outline padding): top-left at (meta.x, meta.y), sized by line metrics / column advance.
 */
export function textBoxRect(meta: LayerTextMeta): { x: number; y: number; w: number; h: number } {
  const size = Math.max(4, meta.fontSize);
  const font = `${size}px ${meta.fontFamily}`;
  const lines = (meta.content || ' ').split('\n');
  const advance = size * Math.max(0.5, meta.lineHeight);
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const longest = (fn: (line: string) => number) => Math.max(1, ...lines.map(fn));
  const runLength = (r: VerticalRun) => (r.kind === 'sideways' ? Math.max(size * 0.5, measure.measureText(r.text).width) : size);
  const columns = meta.vertical ? lines.map((l) => verticalRuns(l)) : [];
  const w = meta.vertical ? lines.length * advance : longest((l) => measure.measureText(l).width);
  const h = meta.vertical ? Math.max(1, ...columns.map((runs) => runs.reduce((n, r) => n + runLength(r), 0))) : lines.length * advance;
  return {
    x: Math.round(meta.x),
    y: Math.round(meta.y),
    w: Math.max(1, Math.ceil(w)),
    h: Math.max(1, Math.ceil(h)),
  };
}
