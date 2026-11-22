import { PNG } from 'pngjs';
import {
  blendComponent, DEFAULT_TILE_SIZE, decompressTileBuffer,
  evaluateTransformKeyframes, IDENTITY_AFFINE, multiplyAffine, transformToAffineMatrix,
  type Affine2D, type CanvasModel, type LayerModel, type LayerTileSnapshot, type TileData,
} from '@atelier/shared';
import { sampleVectors } from './share-preview-vector';

const WIDTH = 1200;
const HEIGHT = 630;
const SINGLE_SAMPLE = [0.5];
const REDUCED_SAMPLES = [0.25, 0.75];

export interface SharePreviewSource {
  canvas: CanvasModel;
  layers: LayerModel[];
  brandPath: string;
}

export const hasPreviewPixels = (layers: LayerTileSnapshot[]) =>
  layers.some((layer) => layer.tiles.length || layer.vectorStrokes?.length);

function readTile(tile: TileData) {
  const length = tile.width * tile.height * 4;
  if (tile.width < 1 || tile.width > DEFAULT_TILE_SIZE || tile.height < 1 || tile.height > DEFAULT_TILE_SIZE) return null;
  const bytes = typeof tile.data === 'string'
    ? Buffer.from(tile.data.replace(/^data:image\/[^;]+;base64,/, ''), 'base64')
    : Buffer.isBuffer(tile.data) ? tile.data : Buffer.from(tile.data);
  if (tile.compression === 'png') {
    if (bytes.length < 24 || bytes.readUInt32BE(16) !== tile.width || bytes.readUInt32BE(20) !== tile.height) return null;
    try {
      const decoded = PNG.sync.read(bytes).data;
      for (let i = 0; i < decoded.length; i += 4) {
        const alpha = decoded[i + 3] / 255;
        for (let ch = 0; ch < 3; ch++) decoded[i + ch] = Math.round(decoded[i + ch] * alpha);
      }
      return decoded;
    } catch {
      return null;
    }
  }
  if (tile.compression !== 'raw' && tile.compression !== 'lz4') return null;
  const raw = decompressTileBuffer(bytes, tile.compression, length);
  return raw.length === length ? raw : null;
}

/** Projects premultiplied tiles onto the preview grid, keeping the working buffers preview-sized. */
function sampleLayer(tiles: TileData[], width: number, height: number, scale: number, matrix: Affine2D) {
  const out = new Uint8ClampedArray(width * height * 4);
  const cols = new Map<number, Map<number, TileData>>();
  const decoded = new Map<TileData, Uint8Array | null>();
  for (const tile of tiles) {
    let rows = cols.get(tile.col);
    if (!rows) cols.set(tile.col, (rows = new Map()));
    rows.set(tile.row, tile);
  }
  const { a, b, c, d, tx, ty } = matrix;
  const det = a * d - b * c;
  if (!det || !tiles.length) return out;

  const samples = scale < 1 ? REDUCED_SAMPLES : SINGLE_SAMPLE;
  const count = samples.length ** 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      for (const sy of samples) {
        for (const sx of samples) {
          const dx = (x + sx) / scale - tx;
          const dy = (y + sy) / scale - ty;
          const px = Math.floor((d * dx - c * dy) / det);
          const py = Math.floor((a * dy - b * dx) / det);
          const col = Math.floor(px / DEFAULT_TILE_SIZE);
          const row = Math.floor(py / DEFAULT_TILE_SIZE);
          const tile = cols.get(col)?.get(row);
          if (!tile) continue;
          const lx = px - col * DEFAULT_TILE_SIZE;
          const ly = py - row * DEFAULT_TILE_SIZE;
          if (lx >= tile.width || ly >= tile.height) continue;
          let raw = decoded.get(tile);
          if (raw === undefined) {
            raw = readTile(tile);
            // A full-size canvas may contain thousands of compressed tiles.
            if (decoded.size >= 128) decoded.delete(decoded.keys().next().value!);
            decoded.set(tile, raw);
          }
          if (!raw) continue;
          const src = (ly * tile.width + lx) * 4;
          r += raw[src];
          g += raw[src + 1];
          b += raw[src + 2];
          alpha += raw[src + 3];
        }
      }
      out[index] = r / count;
      out[index + 1] = g / count;
      out[index + 2] = b / count;
      out[index + 3] = alpha / count;
    }
  }
  return out;
}

export function renderSharePreview(source: SharePreviewSource, snapshots: LayerTileSnapshot[], brand: Buffer): Buffer | null {
  const { canvas, layers } = source;
  // Center-fill (cover) the entire 1200x630 OG preview card with the artwork.
  const scale = Math.max(WIDTH / canvas.width, HEIGHT / canvas.height);
  const width = WIDTH;
  const height = HEIGHT;
  const offsetX = (WIDTH / scale - canvas.width) / 2;
  const offsetY = (HEIGHT / scale - canvas.height) / 2;
  const content = new Map(snapshots.map((layer) => [layer.layerId, layer]));
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const drawable = layers.filter((layer) => layer.layerType !== 'group');
  const masks = new Map(drawable.filter((l) => l.layerType === 'mask' && l.isVisible).map((l) => [l.parentId, l]));
  const firstCels = new Map<string, string | null>();
  for (const layer of layers) {
    if (!layer.parentId || layer.layerType === 'mask' || firstCels.has(layer.parentId) || !byId.get(layer.parentId)?.meta?.animation) continue;
    const ref = layer.meta?.cel?.ref;
    const target = ref === undefined ? layer : byId.get(ref);
    const valid = target && target.parentId === layer.parentId && target.meta?.cel?.ref === undefined;
    firstCels.set(layer.parentId, valid ? target.id : null);
  }
  const world = new Map<string, Affine2D>();
  const matrixFor = (layer: LayerModel, depth = 0): Affine2D => {
    if (depth > 16) return IDENTITY_AFFINE;
    const cached = world.get(layer.id);
    if (cached) return cached;
    const local = transformToAffineMatrix(evaluateTransformKeyframes(layer.meta?.keyframes, 0, canvas.width / 2, canvas.height / 2));
    const parent = byId.get(layer.parentId ?? '');
    const matrix = parent ? multiplyAffine(matrixFor(parent, depth + 1), local) : local;
    world.set(layer.id, matrix);
    return matrix;
  };
  const coverMatrix = (layer: LayerModel): Affine2D => {
    const m = matrixFor(layer);
    return { ...m, tx: m.tx + offsetX, ty: m.ty + offsetY };
  };

  const sampledMasks = new Map<string, Uint8ClampedArray>();
  const pixels = new Uint8ClampedArray(width * height * 4);
  const background = /^#[\da-f]{6}$/i.test(canvas.bgColor) ? parseInt(canvas.bgColor.slice(1), 16) : 0xffffff;
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = background >> 16;
    pixels[i + 1] = (background >> 8) & 255;
    pixels[i + 2] = background & 255;
    pixels[i + 3] = 255;
  }
  let hasArtwork = false;
  let clipBase: Uint8ClampedArray | null = null;
  for (const layer of drawable) {
    if (layer.layerType === 'mask') continue;
    let opacity = 1;
    const layerMasks: Array<{ data: Uint8ClampedArray; inverted: boolean }> = [];
    for (let current: LayerModel | undefined = layer, depth = 0; current && depth < 17; depth++) {
      if (!current.isVisible || (current.parentId && firstCels.has(current.parentId) && (
        !byId.get(current.parentId ?? '')?.meta?.animation?.shared || firstCels.get(current.parentId ?? '') !== current.id
      )) || (current.meta?.animation && !current.meta.animation.shared)) {
        opacity = 0;
        break;
      }
      opacity *= Math.max(0, Math.min(1, current.opacity));
      if (current.meta?.keyframes?.length) {
        opacity *= evaluateTransformKeyframes(current.meta.keyframes, 0, canvas.width / 2, canvas.height / 2).opacity;
      }
      const mask = masks.get(current.id);
      if (mask) {
        let data = sampledMasks.get(mask.id);
        if (!data) {
          data = sampleLayer(content.get(mask.id)?.tiles ?? [], width, height, scale, coverMatrix(mask));
          sampledMasks.set(mask.id, data);
        }
        layerMasks.push({ data, inverted: Boolean(mask.meta?.maskInverted) });
      }
      current = byId.get(current.parentId ?? '');
    }
    const snapshot = content.get(layer.id);
    let paint: Uint8ClampedArray | null = null;
    if (opacity > 0 && layer.layerType === 'vector' && snapshot?.vectorStrokes?.length) {
      paint = sampleVectors(snapshot.vectorStrokes, width, height, scale, coverMatrix(layer));
    } else if (opacity > 0 && snapshot?.tiles.length) {
      paint = sampleLayer(snapshot.tiles, width, height, scale, coverMatrix(layer));
    }
    if (!layer.clipToBelow) clipBase = paint;
    if (!paint) continue;
    const angle = ((layer.screentoneAngle ?? 45) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const cell = Math.max(2 * scale, width / Math.max(1, layer.screentoneLpi ?? 40));
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = paint[i + 3];
      let coverage = (alpha / 255) * opacity;
      if (!coverage) continue;
      for (const mask of layerMasks) {
        const value = mask.data[i] / 255;
        coverage *= mask.inverted ? 1 - value : value;
      }
      if (layer.clipToBelow) coverage *= (clipBase?.[i + 3] ?? 0) / 255;
      if (layer.screentoneEnabled) {
        const x = (i / 4) % width;
        const y = Math.floor(i / (4 * width));
        const u = (cos * x + sin * y) / cell;
        const v = (-sin * x + cos * y) / cell;
        const light = (0.299 * paint[i] + 0.587 * paint[i + 1] + 0.114 * paint[i + 2]) / 255;
        const radius = 0.5 * Math.min(1.8, Math.max(0.5, layer.screentoneDotScale ?? 1)) * Math.sqrt(1 - light);
        const distance = Math.hypot(u - Math.floor(u) - 0.5, v - Math.floor(v) - 0.5);
        coverage *= Math.max(0, Math.min(1, 0.5 + (radius - distance) * cell));
      }
      if (!coverage) continue;
      hasArtwork = true;
      for (let ch = 0; ch < 3; ch++) {
        const dst = pixels[i + ch];
        const src = paint[i + ch] / alpha;
        const blended = layer.blendMode === 'normal' ? src : blendComponent(src, dst / 255, layer.blendMode);
        pixels[i + ch] = dst * (1 - coverage) + blended * 255 * coverage;
      }
    }
  }
  if (!hasArtwork) return null;

  const card = new PNG({ width: WIDTH, height: HEIGHT });
  Buffer.from(pixels.buffer).copy(card.data);

  // Place the Lumina Drift mark & wordmark inside a subtle bottom-left badge so it stays crisp on any artwork.
  const original = PNG.sync.read(brand);
  if (original.width === WIDTH && original.height === HEIGHT) {
    const bx = 14, by = 541, bw = 320, bh = 80, br = 14;
    for (let y = by; y < by + bh; y++) {
      for (let x = bx; x < bx + bw; x++) {
        const dx = Math.max(0, bx + br - x, x - (bx + bw - 1 - br));
        const dy = Math.max(0, by + br - y, y - (by + bh - 1 - br));
        if (dx * dx + dy * dy > br * br) continue;
        const i = (y * WIDTH + x) * 4;
        const a = 0.88;
        card.data[i] = Math.round(card.data[i] * (1 - a) + 14 * a);
        card.data[i + 1] = Math.round(card.data[i + 1] * (1 - a) + 16 * a);
        card.data[i + 2] = Math.round(card.data[i + 2] * (1 - a) + 37 * a);
        card.data[i + 3] = 255;
      }
    }
    const copy = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, size: number) => {
      const h = Math.round((size * sh) / sw);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < size; x++) {
          const from = ((sy + Math.floor((y * sh) / h)) * WIDTH + sx + Math.floor((x * sw) / size)) * 4;
          const r = original.data[from], g = original.data[from + 1], b = original.data[from + 2];
          // Alpha-fade the dark backdrop around the mark/wordmark into the badge.
          const delta = Math.max(0, r - 14, g - 16, b - 37);
          const alpha = Math.min(1, delta / 40);
          if (!alpha) continue;
          const to = ((dy + y) * WIDTH + dx + x) * 4;
          card.data[to] = Math.round(card.data[to] * (1 - alpha) + r * alpha);
          card.data[to + 1] = Math.round(card.data[to + 1] * (1 - alpha) + g * alpha);
          card.data[to + 2] = Math.round(card.data[to + 2] * (1 - alpha) + b * alpha);
        }
      }
    };
    copy(726, 101, 394, 394, 24, 551, 64);
    copy(87, 237, 538, 76, 98, 567, 218);
  }
  return PNG.sync.write(card);
}
