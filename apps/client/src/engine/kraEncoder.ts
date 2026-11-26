import type { BlendMode } from '@atelier/shared';
import JSZip from 'jszip';
import { linearizeBytes } from './kraDecoder';

export interface KraMaskInput {
  coverage: Uint8Array;
  inverted: boolean;
  enabled: boolean;
  name?: string;
}

interface KraNodeProperties {
  name: string;
  opacity: number;
  visible: boolean;
  locked: boolean;
  blendMode: BlendMode;
  mask?: KraMaskInput;
}

export type KraNodeInput = KraNodeProperties & (
  | { kind: 'paint'; alphaLocked: boolean; clipToBelow: boolean; rgba: Uint8Array | Uint8ClampedArray }
  | { kind: 'group'; children: KraNodeInput[] }
);

export interface KraDocumentInput {
  width: number;
  height: number;
  dpi: number;
  title: string;
  bgColor: string | null;
  roots: KraNodeInput[];
  mergedPng: Uint8Array;
  previewPng: Uint8Array;
  uuid?: () => string;
}

export type KraLayerFilePlan = ReadonlyMap<KraNodeInput, string>;

export const KRA_MIMETYPE = 'application/x-krita';
const IMAGE_NAME = 'Lumina';
const TILE_SIZE = 64;
const TILE_PIXELS = TILE_SIZE * TILE_SIZE;
const utf8 = new TextEncoder();

const blendModes = new Map<string, string>([
  ['normal', 'normal'],
  ['multiply', 'multiply'],
  ['screen', 'screen'],
  ['overlay', 'overlay'],
  ['darken', 'darken'],
  ['lighten', 'lighten'],
  ['color_dodge', 'dodge'],
  ['color_burn', 'burn'],
  ['hard_light', 'hard_light'],
  ['soft_light', 'soft_light'],
  ['difference', 'diff'],
  ['exclusion', 'exclusion'],
  ['hue', 'hue'],
  ['saturation', 'saturation'],
  ['color', 'color'],
  ['luminosity', 'luminize'],
  ['add', 'add'],
  ['glow', 'luminosity_sai'],
  ['linear_burn', 'linear_burn'],
  ['darker_color', 'darker color'],
  ['lighter_color', 'lighter color'],
  ['vivid_light', 'vivid_light'],
  ['linear_light', 'linear light'],
  ['pin_light', 'pin_light'],
  ['hard_mix', 'hard_mix_photoshop'],
  ['subtract', 'subtract'],
  ['divide', 'divide'],
]);

export function mapLuminaBlendModeToKra(mode: BlendMode): string {
  return blendModes.get(mode) ?? 'normal';
}

export function compressLzf(input: Uint8Array): Uint8Array {
  const maxLiteral = 32;
  const maxDistance = 8192;
  const maxMatch = 264;
  const positions = new Uint32Array(8192);
  const output = new Uint8Array(input.length + Math.ceil(input.length / maxLiteral));
  let written = 0;
  let offset = 0;
  let literalStart = 0;

  const hashAt = (i: number) => {
    const key = (input[i] << 16) | (input[i + 1] << 8) | input[i + 2];
    return Math.imul(key, 0x9e3779b1) >>> 19;
  };
  const flushLiterals = () => {
    if (literalStart === offset) return;
    output[written++] = offset - literalStart - 1;
    output.set(input.subarray(literalStart, offset), written);
    written += offset - literalStart;
    literalStart = offset;
  };

  while (offset < input.length) {
    if (offset + 2 < input.length) {
      const hash = hashAt(offset);
      const match = positions[hash] - 1;
      positions[hash] = offset + 1;
      const distance = offset - match;
      if (match >= 0 && distance <= maxDistance &&
          input[match] === input[offset] && input[match + 1] === input[offset + 1] &&
          input[match + 2] === input[offset + 2]) {
        let length = 3;
        const limit = Math.min(maxMatch, input.length - offset);
        while (length < limit && input[match + length] === input[offset + length]) length++;
        flushLiterals();

        const lengthCode = length - 2;
        const distanceCode = distance - 1;
        output[written++] = (Math.min(lengthCode, 7) << 5) | (distanceCode >>> 8);
        if (lengthCode >= 7) output[written++] = lengthCode - 7;
        output[written++] = distanceCode & 0xff;

        offset += length;
        literalStart = offset;
        for (let i = offset - 2; i < offset && i + 2 < input.length; i++) {
          positions[hashAt(i)] = i + 1;
        }
        continue;
      }
    }
    offset++;
    if (offset - literalStart === maxLiteral) flushLiterals();
  }
  flushLiterals();
  return output.slice(0, written);
}

export function rgbaToKritaBgra(rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  const bgra = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    bgra[i] = rgba[i + 2];
    bgra[i + 1] = rgba[i + 1];
    bgra[i + 2] = rgba[i];
    bgra[i + 3] = rgba[i + 3];
  }
  return bgra;
}

export function encodeKraTileStream(opts: {
  width: number;
  height: number;
  pixelSize: 1 | 4;
  data: Uint8Array;
  defaultPixel: Uint8Array;
}): Uint8Array {
  const { width, height, pixelSize, data, defaultPixel } = opts;
  if (data.length !== width * height * pixelSize || defaultPixel.length !== pixelSize) {
    throw new RangeError('KRA tile data does not match its dimensions or pixel size');
  }

  const tile = new Uint8Array(TILE_PIXELS * pixelSize);
  const defaultTile = new Uint8Array(tile.length);
  for (let i = 0; i < defaultTile.length; i += pixelSize) defaultTile.set(defaultPixel, i);
  const chunks: Uint8Array[] = [];
  let count = 0;

  for (let top = 0; top < height; top += TILE_SIZE) {
    const rows = Math.min(TILE_SIZE, height - top);
    for (let left = 0; left < width; left += TILE_SIZE) {
      const cols = Math.min(TILE_SIZE, width - left);
      if (rows < TILE_SIZE || cols < TILE_SIZE) tile.set(defaultTile);
      for (let row = 0; row < rows; row++) {
        const start = ((top + row) * width + left) * pixelSize;
        tile.set(data.subarray(start, start + cols * pixelSize), row * TILE_SIZE * pixelSize);
      }
      if (tile.every((value, i) => value === defaultTile[i])) continue;

      const planar = pixelSize === 1 ? tile : linearizeBytes(tile, TILE_PIXELS, pixelSize);
      const compressed = compressLzf(planar);
      const useCompressed = compressed.length < tile.length;
      const payload = useCompressed ? compressed : tile.slice();
      chunks.push(
        utf8.encode(`${left},${top},LZF,${payload.length + 1}\n`),
        Uint8Array.of(useCompressed ? 1 : 0),
        payload,
      );
      count++;
    }
  }

  const header = utf8.encode(`VERSION 2\nTILEWIDTH ${TILE_SIZE}\nTILEHEIGHT ${TILE_SIZE}\nPIXELSIZE ${pixelSize}\nDATA ${count}\n`);
  const output = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, header.length));
  output.set(header);
  let offset = header.length;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

const xmlEntities: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  '\t': '&#9;', '\n': '&#10;', '\r': '&#13;',
};

function escapeXml(text: string): string {
  return text
    .replace(/[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/[&<>"'\t\n\r]/g, (char) => xmlEntities[char]);
}

function backgroundColorData(bgColor: string | null): string {
  const hex = bgColor?.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (!hex) return btoa('\0\0\0\0');
  const rgb = Number.parseInt(hex.length === 3 ? hex.replace(/./g, '$&$&') : hex, 16);
  return btoa(String.fromCharCode(rgb & 0xff, (rgb >> 8) & 0xff, rgb >> 16, 255));
}

function makeUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const digit = Math.floor(Math.random() * 16);
    return (char === 'x' ? digit : 8 | (digit & 3)).toString(16);
  });
}

export function buildKraMainDoc(doc: KraDocumentInput, plan: KraLayerFilePlan): string {
  const uuid = doc.uuid ?? makeUuid;
  const uuidAttr = () => escapeXml(`{${uuid().replace(/^\{|\}$/g, '')}}`);
  const layersXml = (nodes: KraNodeInput[]): string => [...nodes].reverse().map((node) => {
    const filename = plan.get(node);
    if (!filename) throw new Error('Missing KRA layer filename');
    const compositeOp = mapLuminaBlendModeToKra(node.blendMode);
    const opacity = Math.round(node.opacity * 255);
    const precision = 1_000_000;
    let preciseOpacity = Math.round(node.opacity * precision) / precision;
    const byteDelta = preciseOpacity * 255 - opacity;
    // Keep the six-place decimal consistent even just beside an 8-bit rounding boundary.
    if (Math.abs(byteDelta) > 0.5 + 1e-6) {
      preciseOpacity = (Math.round(preciseOpacity * precision) - Math.sign(byteDelta)) / precision;
    }
    const clipping = node.kind === 'paint' && node.clipToBelow;
    const alphaLocked = node.kind === 'paint' && node.alphaLocked;
    const common = `name="${escapeXml(node.name)}" filename="${escapeXml(filename)}" x="0" y="0" opacity="${opacity}" lumina-opacity="${preciseOpacity}" visible="${Number(node.visible)}" locked="${Number(node.locked)}" collapsed="0" colorlabel="0" compositeop="${compositeOp}" channelflags="${clipping ? '1110' : ''}" channellockflags="${alphaLocked ? '1110' : ''}" inheritalpha="${Number(clipping)}" colorspacename="RGBA" uuid="${uuidAttr()}" selected="false" intimeline="0" onionskin="0"`;

    const mask = node.mask;
    const maskXml = mask
      ? `<mask nodetype="transparencymask" name="${escapeXml(mask.name ?? 'Transparency Mask')}" filename="${escapeXml(filename)}-mask" x="0" y="0" visible="${Number(mask.enabled)}" locked="0" colorlabel="0" compositeop="normal" opacity="255" uuid="${uuidAttr()}" lumina-maskinverted="${Number(mask.inverted)}"/>`
      : '';
    const masks = maskXml ? `<masks>${maskXml}</masks>` : '';
    if (node.kind === 'group') {
      // Krita loads only a layer's first child container, so a group's mask lives beside its layers.
      return `<layer nodetype="grouplayer" ${common} passthrough="${Number(compositeOp === 'normal')}"><layers>${maskXml}${layersXml(node.children)}</layers></layer>`;
    }
    return `<layer nodetype="paintlayer" ${common}>${masks}</layer>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE DOC PUBLIC '-//KDE//DTD krita 2.0//EN' 'http://www.calligra.org/DTD/krita-2.0.dtd'>
<DOC xmlns="http://www.calligra.org/DTD/krita" syntaxVersion="2.0" editor="Krita" kritaVersion="5.2.2">
  <IMAGE name="${IMAGE_NAME}" mime="application/x-kra" width="${doc.width}" height="${doc.height}" x-res="${doc.dpi}" y-res="${doc.dpi}" colorspacename="RGBA" profile="sRGB-elle-V2-srgbtrc.icc" description="">
    <layers>${layersXml(doc.roots)}</layers>
    <ProjectionBackgroundColor ColorData="${backgroundColorData(doc.bgColor)}"/>
    <GlobalAssistantsColor SimpleColorData="176,176,176,255"/>
    <Palettes/><resources/>
    <animation><framerate type="value" value="24"/><range type="timerange" from="0" to="100"/><currentTime type="value" value="0"/></animation>
  </IMAGE>
</DOC>`;
}

function chooseMaskDefault(data: Uint8Array, width: number, height: number): number {
  let score = 0;
  for (let top = 0; top < height; top += TILE_SIZE) {
    for (let left = 0; left < width; left += TILE_SIZE) {
      const first = data[top * width + left];
      if (first !== 0 && first !== 255) continue;
      const right = Math.min(left + TILE_SIZE, width);
      const bottom = Math.min(top + TILE_SIZE, height);
      let uniform = true;
      for (let y = top; y < bottom && uniform; y++) {
        const end = y * width + right;
        for (let i = y * width + left; i < end; i++) {
          if (data[i] !== first) {
            uniform = false;
            break;
          }
        }
      }
      if (uniform) score += first === 255 ? 1 : -1;
    }
  }
  return score > 0 ? 255 : 0;
}

export async function encodeKraDocument(doc: KraDocumentInput): Promise<Uint8Array> {
  const { width, height } = doc;
  const plan = new Map<KraNodeInput, string>();
  const planLayers = (nodes: KraNodeInput[]) => {
    for (const node of nodes) {
      if (plan.has(node)) continue;
      plan.set(node, `layer${plan.size + 1}`);
      if (node.kind === 'group') planLayers(node.children);
    }
  };
  planLayers(doc.roots);

  const zip = new JSZip();
  zip.file('mimetype', KRA_MIMETYPE, { compression: 'STORE' });
  zip.file('maindoc.xml', buildKraMainDoc(doc, plan), { compression: 'DEFLATE' });
  const date = new Date().toISOString();
  zip.file('documentinfo.xml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE document-info PUBLIC '-//KDE//DTD document-info 1.1//EN' 'http://www.calligra.org/DTD/document-info-1.1.dtd'>
<document-info xmlns="http://www.calligra.org/DTD/document-info">
  <about><title>${escapeXml(doc.title)}</title><initial-creator>Lumina Drift</initial-creator><editing-cycles>1</editing-cycles><creation-date>${date}</creation-date><date>${date}</date></about>
  <author/>
</document-info>`, { compression: 'DEFLATE' });
  zip.file('mergedimage.png', doc.mergedPng);
  zip.file('preview.png', doc.previewPng);

  const addTiles = (filename: string, pixelSize: 1 | 4, data: Uint8Array, defaultPixel: Uint8Array) => {
    const path = `${IMAGE_NAME}/layers/${filename}`;
    zip.file(path, encodeKraTileStream({ width, height, pixelSize, data, defaultPixel }), { createFolders: false });
    zip.file(`${path}.defaultpixel`, defaultPixel, { createFolders: false });
  };
  for (const [node, filename] of plan) {
    if (node.kind === 'paint') addTiles(filename, 4, rgbaToKritaBgra(node.rgba), new Uint8Array(4));
    if (node.mask) {
      const { coverage, inverted } = node.mask;
      const data = inverted ? coverage.map((value) => 255 - value) : coverage;
      const defaultPixel = Uint8Array.of(chooseMaskDefault(data, width, height));
      addTiles(`${filename}-mask.pixelselection`, 1, data, defaultPixel);
    }
  }

  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
}
