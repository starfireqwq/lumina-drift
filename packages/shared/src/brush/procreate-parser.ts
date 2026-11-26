/**
 * Procreate (.brush / .brushset) Brush Format Parser
 *
 * Parses ZIP containers holding Procreate brush folders:
 * - brushset.plist (XML or binary plist with set name & ordered brush UUIDs)
 * - Brush.archive (Apple binary plist `bplist00` NSKeyedArchiver or XML plist)
 * - Shape.png, numbered shapes, and secondary shapes (brush tip alpha/luminance images)
 * - Grain.png (seamless paper/grain texture image)
 *
 * Works across Browser, Electron, and Node 18+ with zero external dependencies
 * (uses standard Web `DecompressionStream('deflate-raw')` for DEFLATE entries).
 */

import { MIN_BRUSH_SPACING } from './brush-spacing';
import type { ParsedBrushTip } from './abr-parser';
import {
  normalizeColorDynamics,
  type BrushDynamicsConfig,
  type BrushTextureBlendMode,
  type BrushTipPlayMode,
  type DualBrushBlendMode,
  type DualTipShape,
} from './brush-dynamics';
import type { PigmentBlendModel } from '../color/pigment-blend';

export interface ParsedProcreateBrush extends ParsedBrushTip {
  setName?: string;
  stabilizerLevel?: number;
  shapeInverted?: boolean;
  sourceFormat: 'procreate';
}

export interface ProcreateParseResult {
  setName?: string;
  brushes: ParsedProcreateBrush[];
}

export type PlistUid = { UID: number };
export type PlistValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | Date
  | PlistUid
  | PlistValue[]
  | { [key: string]: PlistValue };

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const textDecoderUtf8 = new TextDecoder('utf-8');
const textDecoderLatin1 = new TextDecoder('latin1');

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function bytesToBase64(bytes: Uint8Array): string {
  const globalBuf = (globalThis as { Buffer?: { from(input: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (globalBuf) {
    return globalBuf.from(bytes).toString('base64');
  }
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return (globalThis as { btoa(str: string): string }).btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '');
  const globalBuf = (globalThis as { Buffer?: { from(input: string, enc: string): Uint8Array } }).Buffer;
  if (globalBuf) {
    const buf = globalBuf.from(clean, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = (globalThis as { atob(str: string): string }).atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) {
    throw new Error('Current runtime does not support DecompressionStream("deflate-raw") for Procreate ZIP archives.');
  }
  const stream = new DS('deflate-raw');
  const writer = stream.writable.getWriter();
  const copy = new Uint8Array(compressed.byteLength);
  copy.set(compressed);
  const writePromise = writer.write(copy).then(() => writer.close());

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    await writePromise;
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function normalizeZipPath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

/**
 * Lightweight ZIP archive extractor supporting Stored (0) and Deflate (8).
 */
export async function readZipEntries(input: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const len = input.byteLength;
  if (len < 22) {
    throw new Error('Invalid Procreate archive: file is too small to be a ZIP.');
  }

  // Locate End of Central Directory (EOCD) scanning backwards up to 65557 bytes
  const minEocd = Math.max(0, len - 65557);
  let eocdOffset = -1;
  for (let pos = len - 22; pos >= minEocd; pos--) {
    if (view.getUint32(pos, true) === ZIP_EOCD_SIG) {
      const commentLen = view.getUint16(pos + 20, true);
      if (pos + 22 + commentLen <= len) {
        eocdOffset = pos;
        break;
      }
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Invalid Procreate archive: ZIP central directory not found.');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (cdOffset + cdSize > len) {
    throw new Error('Invalid Procreate archive: central directory exceeds file size.');
  }

  const entries = new Map<string, Uint8Array>();
  let pos = cdOffset;
  const cdEnd = cdOffset + cdSize;

  for (let i = 0; i < totalEntries && pos + 46 <= cdEnd; i++) {
    if (view.getUint32(pos, true) !== ZIP_CENTRAL_HEADER) break;
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    const nameBytes = input.subarray(pos + 46, pos + 46 + nameLen);
    const rawName = (flags & 0x0800) !== 0
      ? textDecoderUtf8.decode(nameBytes)
      : textDecoderUtf8.decode(nameBytes);
    const name = normalizeZipPath(rawName);
    pos += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith('/') || name.startsWith('__MACOSX/') || name.includes('/__MACOSX/')) {
      continue;
    }
    if (localHeaderOffset + 30 > len || view.getUint32(localHeaderOffset, true) !== ZIP_LOCAL_HEADER) {
      continue;
    }

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > len) continue;

    const rawSlice = input.subarray(dataStart, dataEnd);
    if (method === 0) {
      entries.set(name, rawSlice);
    } else if (method === 8) {
      entries.set(name, await inflateRaw(rawSlice));
    }
  }

  return entries;
}

// ============================================================================
// Apple Binary Plist (bplist00) & XML Plist Parser + NSKeyedArchiver Resolver
// ============================================================================

function readUintBE(bytes: Uint8Array, offset: number, size: number): number {
  let val = 0;
  for (let i = 0; i < size; i++) {
    val = val * 256 + bytes[offset + i];
  }
  return val;
}

function readIntBE(bytes: Uint8Array, offset: number, size: number): number {
  if (size === 8) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const hi = view.getInt32(0, false);
    const lo = view.getUint32(4, false);
    return hi * 0x100000000 + lo;
  }
  return readUintBE(bytes, offset, size);
}

/**
 * Parses an Apple Binary Plist (`bplist00`) buffer into JS values.
 */
export function parseBinaryPlist(bytes: Uint8Array): PlistValue {
  if (bytes.byteLength < 40) {
    throw new Error('Binary plist is too short.');
  }
  const magic = textDecoderLatin1.decode(bytes.subarray(0, 8));
  if (!magic.startsWith('bplist0')) {
    throw new Error(`Unsupported binary plist header: ${magic}`);
  }

  const trailerOffset = bytes.byteLength - 32;
  const offsetIntSize = bytes[trailerOffset + 6];
  const objectRefSize = bytes[trailerOffset + 7];
  const numObjects = readUintBE(bytes, trailerOffset + 8, 8);
  const topObject = readUintBE(bytes, trailerOffset + 16, 8);
  const offsetTableOffset = readUintBE(bytes, trailerOffset + 24, 8);

  if (
    offsetIntSize < 1 || offsetIntSize > 8 ||
    objectRefSize < 1 || objectRefSize > 8 ||
    offsetTableOffset + numObjects * offsetIntSize > trailerOffset
  ) {
    throw new Error('Corrupt binary plist trailer.');
  }

  const offsets = new Array<number>(numObjects);
  for (let i = 0; i < numObjects; i++) {
    offsets[i] = readUintBE(bytes, offsetTableOffset + i * offsetIntSize, offsetIntSize);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cache = new Map<number, PlistValue>();
  const visiting = new Set<number>();

  function readLength(pos: number, info: number): { length: number; next: number } {
    if (info !== 0x0f) return { length: info, next: pos };
    const marker = bytes[pos];
    const type = marker >> 4;
    if (type !== 0x01) {
      throw new Error(`Expected extended integer length in binary plist, got 0x${marker.toString(16)}`);
    }
    const size = 1 << (marker & 0x0f);
    return {
      length: readUintBE(bytes, pos + 1, size),
      next: pos + 1 + size,
    };
  }

  function decodeObject(idx: number): PlistValue {
    if (idx < 0 || idx >= numObjects) return null;
    if (cache.has(idx)) return cache.get(idx)!;
    if (visiting.has(idx)) return null;
    visiting.add(idx);

    const pos = offsets[idx];
    const marker = bytes[pos];
    const type = marker >> 4;
    const info = marker & 0x0f;
    let value: PlistValue = null;

    switch (type) {
      case 0x0: {
        if (info === 0x00) value = null;
        else if (info === 0x08) value = false;
        else if (info === 0x09) value = true;
        else value = null;
        break;
      }
      case 0x1: {
        const size = 1 << info;
        value = readIntBE(bytes, pos + 1, size);
        break;
      }
      case 0x2: {
        const size = 1 << info;
        if (size === 4) value = view.getFloat32(pos + 1, false);
        else if (size === 8) value = view.getFloat64(pos + 1, false);
        else value = 0;
        break;
      }
      case 0x3: {
        // Apple Cocoa epoch: 2001-01-01T00:00:00Z
        const secs = view.getFloat64(pos + 1, false);
        value = new Date((secs + 978307200) * 1000);
        break;
      }
      case 0x4: {
        const { length, next } = readLength(pos + 1, info);
        value = bytes.slice(next, next + length);
        break;
      }
      case 0x5: {
        const { length, next } = readLength(pos + 1, info);
        value = textDecoderLatin1.decode(bytes.subarray(next, next + length));
        break;
      }
      case 0x6: {
        const { length, next } = readLength(pos + 1, info);
        const chars: number[] = new Array(length);
        for (let i = 0; i < length; i++) {
          chars[i] = view.getUint16(next + i * 2, false);
        }
        // Chunked conversion to avoid stack overflow on long strings
        let str = '';
        for (let i = 0; i < chars.length; i += 8192) {
          str += String.fromCharCode(...chars.slice(i, i + 8192));
        }
        value = str;
        break;
      }
      case 0x8: {
        const size = info + 1;
        value = { UID: readUintBE(bytes, pos + 1, size) };
        break;
      }
      case 0xa:
      case 0xc: {
        const { length, next } = readLength(pos + 1, info);
        const arr: PlistValue[] = new Array(length);
        for (let i = 0; i < length; i++) {
          const ref = readUintBE(bytes, next + i * objectRefSize, objectRefSize);
          arr[i] = decodeObject(ref);
        }
        value = arr;
        break;
      }
      case 0xd: {
        const { length, next } = readLength(pos + 1, info);
        const dict: { [key: string]: PlistValue } = {};
        const valBase = next + length * objectRefSize;
        for (let i = 0; i < length; i++) {
          const keyRef = readUintBE(bytes, next + i * objectRefSize, objectRefSize);
          const valRef = readUintBE(bytes, valBase + i * objectRefSize, objectRefSize);
          const key = decodeObject(keyRef);
          if (typeof key === 'string') {
            dict[key] = decodeObject(valRef);
          }
        }
        value = dict;
        break;
      }
      default:
        value = null;
    }

    visiting.delete(idx);
    cache.set(idx, value);
    return value;
  }

  return decodeObject(topObject);
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

/**
 * Lightweight recursive-descent XML Plist parser (works in Node & Browser without DOMParser).
 */
export function parseXmlPlist(xml: string): PlistValue {
  // Strip XML declarations, DOCTYPE, and comments
  const cleaned = xml
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const plistStart = cleaned.search(/<plist\b[^>]*>/i);
  let pos = plistStart >= 0 ? cleaned.indexOf('>', plistStart) + 1 : 0;

  function skipWs() {
    while (pos < cleaned.length && /\s/.test(cleaned[pos])) pos++;
  }

  function readTag(): { name: string; closing: boolean; selfClosing: boolean } | null {
    skipWs();
    if (pos >= cleaned.length || cleaned[pos] !== '<') return null;
    const end = cleaned.indexOf('>', pos);
    if (end < 0) return null;
    const inside = cleaned.slice(pos + 1, end).trim();
    pos = end + 1;
    const closing = inside.startsWith('/');
    const selfClosing = !closing && inside.endsWith('/');
    const body = inside.replace(/^\//, '').replace(/\/$/, '').trim();
    const name = body.split(/\s+/)[0].toLowerCase();
    return { name, closing, selfClosing };
  }

  function readTextUntilClose(tagName: string): string {
    const closePattern = `</${tagName}>`;
    const lower = cleaned.toLowerCase();
    const closeIdx = lower.indexOf(closePattern, pos);
    if (closeIdx < 0) {
      const rest = cleaned.slice(pos);
      pos = cleaned.length;
      return unescapeXml(rest);
    }
    const content = cleaned.slice(pos, closeIdx);
    pos = closeIdx + closePattern.length;
    return unescapeXml(content);
  }

  function parseValue(): PlistValue {
    const tag = readTag();
    if (!tag || tag.closing) return null;
    switch (tag.name) {
      case 'dict': {
        const dict: { [key: string]: PlistValue } = {};
        if (tag.selfClosing) return dict;
        while (pos < cleaned.length) {
          const keyTag = readTag();
          if (!keyTag || (keyTag.closing && keyTag.name === 'dict')) break;
          if (keyTag.name === 'key') {
            const key = keyTag.selfClosing ? '' : readTextUntilClose('key');
            dict[key] = parseValue();
          }
        }
        return dict;
      }
      case 'array': {
        const arr: PlistValue[] = [];
        if (tag.selfClosing) return arr;
        while (pos < cleaned.length) {
          skipWs();
          if (cleaned.slice(pos, pos + 8).toLowerCase() === '</array>') {
            pos += 8;
            break;
          }
          const prevPos = pos;
          const item = parseValue();
          if (pos === prevPos) break;
          arr.push(item);
        }
        return arr;
      }
      case 'string':
        return tag.selfClosing ? '' : readTextUntilClose('string');
      case 'integer':
        return tag.selfClosing ? 0 : Number.parseInt(readTextUntilClose('integer').trim(), 10);
      case 'real':
        return tag.selfClosing ? 0 : Number.parseFloat(readTextUntilClose('real').trim());
      case 'true':
        return true;
      case 'false':
        return false;
      case 'date':
        return tag.selfClosing ? new Date(0) : new Date(readTextUntilClose('date').trim());
      case 'data':
        return tag.selfClosing ? new Uint8Array(0) : base64ToBytes(readTextUntilClose('data'));
      default:
        return null;
    }
  }

  return parseValue();
}

export function parsePlist(bytes: Uint8Array): PlistValue {
  if (bytes.byteLength >= 8 && textDecoderLatin1.decode(bytes.subarray(0, 7)) === 'bplist0') {
    return parseBinaryPlist(bytes);
  }
  return parseXmlPlist(textDecoderUtf8.decode(bytes));
}

function isUid(value: unknown): value is PlistUid {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date) &&
    typeof (value as PlistUid).UID === 'number' &&
    Object.keys(value).length === 1
  );
}

/**
 * Resolves an Apple `NSKeyedArchiver` plist object graph into plain JS objects.
 */
export function unarchiveNSKeyed(plist: PlistValue): unknown {
  if (!plist || typeof plist !== 'object' || Array.isArray(plist) || plist instanceof Uint8Array || plist instanceof Date) {
    return plist;
  }
  const rootDict = plist as { [key: string]: PlistValue };
  if (rootDict.$archiver !== 'NSKeyedArchiver' || !Array.isArray(rootDict.$objects)) {
    return plist;
  }

  const objects = rootDict.$objects;
  const resolved = new Map<number, unknown>();
  const visiting = new Set<number>();

  function resolveValue(val: unknown): unknown {
    if (isUid(val)) return resolveObject(val.UID);
    if (Array.isArray(val)) return val.map(resolveValue);
    if (val && typeof val === 'object' && !(val instanceof Uint8Array) && !(val instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (k === '$class') continue;
        out[k] = resolveValue(v);
      }
      return out;
    }
    return val;
  }

  function resolveObject(uid: number): unknown {
    if (uid < 0 || uid >= objects.length) return null;
    const raw = objects[uid];
    if (raw === '$null') return null;
    if (resolved.has(uid)) return resolved.get(uid);
    if (visiting.has(uid)) return null;
    visiting.add(uid);

    let result: unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && !(raw instanceof Uint8Array) && !(raw instanceof Date)) {
      const rec = raw as Record<string, unknown>;
      if (typeof rec['NS.string'] === 'string') {
        result = rec['NS.string'];
      } else if (rec['NS.data'] instanceof Uint8Array) {
        result = rec['NS.data'];
      } else if (Array.isArray(rec['NS.keys']) && Array.isArray(rec['NS.objects'])) {
        const dict: Record<string, unknown> = {};
        const keys = rec['NS.keys'];
        const vals = rec['NS.objects'];
        for (let i = 0; i < Math.min(keys.length, vals.length); i++) {
          const k = resolveValue(keys[i]);
          if (typeof k === 'string') dict[k] = resolveValue(vals[i]);
        }
        result = dict;
      } else if (Array.isArray(rec['NS.objects']) && Object.keys(rec).every((k) => k === 'NS.objects' || k === '$class')) {
        result = rec['NS.objects'].map(resolveValue);
      } else {
        const obj: Record<string, unknown> = {};
        resolved.set(uid, obj);
        for (const [k, v] of Object.entries(rec)) {
          if (k === '$class') continue;
          obj[k] = resolveValue(v);
        }
        result = obj;
      }
    } else {
      result = resolveValue(raw);
    }

    visiting.delete(uid);
    resolved.set(uid, result);
    return result;
  }

  const top = rootDict.$top as { [key: string]: PlistValue } | undefined;
  if (!top) return null;
  const rootRef = top.root ?? Object.values(top)[0];
  return resolveValue(rootRef);
}

// ============================================================================
// PNG Utilities (Dimensions + Procreate Luminance->Alpha Shape Conversion)
// ============================================================================

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 24) return { width: 256, height: 256 };
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return { width: 256, height: 256 };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width > 0 && height > 0 && width <= 8192 && height <= 8192) {
    return { width, height };
  }
  return { width: 256, height: 256 };
}

function pngBytesToDataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

/**
 * Procreate `Shape.png` stores opacity in grayscale luminance (white = opaque, black = transparent,
 * flipped when `shapeInverted` is true). Lumina Drift's Pixi brush engine tints white RGB with alpha.
 * Converts luminance -> RGBA(255,255,255,alpha) in Browser/Electron, with raw PNG fallback in Node.
 */
async function convertProcreateShapeToTipDataUrl(
  pngBytes: Uint8Array,
  shapeInverted: boolean,
): Promise<string> {
  const rawUrl = pngBytesToDataUrl(pngBytes);
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return rawUrl;
  }
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to decode Shape.png'));
      el.src = rawUrl;
    });
    const w = Math.max(1, Math.min(1024, img.naturalWidth || 256));
    const h = Math.max(1, Math.min(1024, img.naturalHeight || 256));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return rawUrl;
    ctx.drawImage(img, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    let hasAlphaVariation = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 245) {
        hasAlphaVariation = true;
        break;
      }
    }

    for (let i = 0; i < data.length; i += 4) {
      const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      const baseAlpha = hasAlphaVariation ? Math.round((lum * data[i + 3]) / 255) : lum;
      const alpha = shapeInverted ? 255 - baseAlpha : baseAlpha;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = alpha;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return rawUrl;
  }
}

// ============================================================================
// SilicaBrush Mapping & ProcreateParser
// ============================================================================

function num(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function bool(obj: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
  }
  return undefined;
}

function str(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

interface BrushFolderFiles {
  archive?: Uint8Array;
  shape?: Uint8Array;
  grain?: Uint8Array;
  dualShape?: Uint8Array;
  extraShapes: Array<{ order: number; bytes: Uint8Array }>;
}

const dualShapeNames = new Set(['dualshape.png', 'secondaryshape.png', 'shape2.png']);
const dualBlendModes: readonly DualBrushBlendMode[] = ['multiply', 'subtract', 'darken', 'screen', 'overlay'];
const dualTipShapes: readonly DualTipShape[] = ['same', 'round', 'soft', 'speckle', 'bristle', 'square', 'custom'];
const textureBlendModes: readonly BrushTextureBlendMode[] = ['multiply', 'subtract', 'overlay'];
const pigmentBlendModes: readonly PigmentBlendModel[] = ['rgb', 'oklab', 'subtractive'];
const shapePlayModes: readonly BrushTipPlayMode[] = ['single', 'sequential', 'random', 'randomNoRepeat'];

function getEnumSetting<T extends string>(obj: Record<string, unknown>, values: readonly T[], ...keys: string[]): T | undefined {
  for (const key of keys) {
    const value = obj[key];
    const label = typeof value === 'string' ? value.trim().toLowerCase() : undefined;
    const match = typeof value === 'number' ? values[value] : values.find((option) => option.toLowerCase() === label);
    if (match) return match;
  }
  return undefined;
}

function getShapePlayMode(obj: Record<string, unknown>): BrushTipPlayMode {
  const mode = getEnumSetting(obj, shapePlayModes, 'shapePlayMode');
  if (mode) return mode;
  const random = bool(obj, 'shapeRandom');
  if (random !== undefined) return random ? 'random' : 'sequential';
  if (Array.isArray(obj.shapeOrder) || obj.shapeOrder === 0) return 'sequential';
  return getEnumSetting(obj, shapePlayModes, 'shapeOrder') ?? 'random';
}

function boundedNumber(obj: Record<string, unknown>, min: number, max: number, ...keys: string[]): number | undefined {
  const value = num(obj, ...keys);
  return value === undefined ? undefined : clamp(value, min, max);
}

async function mapSilicaBrushToParsed(
  id: string,
  fallbackName: string,
  files: BrushFolderFiles,
  setName?: string,
): Promise<ParsedProcreateBrush> {
  const { archive, grain, dualShape } = files;
  const extraShapes = [...files.extraShapes].sort((a, b) => a.order - b.order).map(({ bytes }) => bytes);
  const shapeBytes = files.shape ?? extraShapes.shift();
  let rawObj: Record<string, unknown> = {};
  if (archive) {
    const plist = parsePlist(archive);
    const unarchived = unarchiveNSKeyed(plist);
    if (unarchived && typeof unarchived === 'object' && !Array.isArray(unarchived)) {
      rawObj = unarchived as Record<string, unknown>;
    }
  }

  const name = str(rawObj, 'name', 'brushName') || fallbackName || 'Procreate Brush';

  // Size & minSize
  const paintSize = num(rawObj, 'paintSize') ?? 0.25;
  const maxSizeFactor = num(rawObj, 'maxSize') ?? 1.0;
  const minSizeRatio = clamp(num(rawObj, 'minSize') ?? 0.05, 0, 1);
  const size = clamp(Math.round(Math.max(0.03, paintSize) * clamp(maxSizeFactor, 0.3, 6) * 120), 4, 240);
  const minSize = Math.round(size * minSizeRatio * 10) / 10;

  // Spacing & scatter
  const plotSpacing = num(rawObj, 'plotSpacing', 'spacing');
  const spacing = plotSpacing !== undefined ? clamp(plotSpacing, MIN_BRUSH_SPACING, 1.5) : 0.1;
  const plotJitter = num(rawObj, 'plotJitter', 'scatter', 'shapeScatter') ?? 0;
  const scatter = clamp(plotJitter, 0, 1);

  // Opacity & flow
  const paintOpacity = num(rawObj, 'paintOpacity', 'maxOpacity', 'opacity') ?? 1;
  const opacity = clamp(paintOpacity, 0.05, 1);
  const minOpacity = clamp(num(rawObj, 'minOpacity') ?? 0, 0, 1);
  const load = num(rawObj, 'dynamicsLoad', 'charge', 'flow');
  const flow = load !== undefined ? clamp(load, 0.05, 1) : 1;

  // Shape attributes
  const shapeInverted = bool(rawObj, 'shapeInverted', 'inverted') ?? false;
  const rawHardness = num(rawObj, 'shapeHardness', 'hardness');
  const hardness = rawHardness !== undefined ? clamp(rawHardness, 0.05, 1) : (shapeBytes ? 0.9 : 0.85);
  const rawRoundness = num(rawObj, 'shapeRoundness', 'roundness');
  const roundness = rawRoundness !== undefined ? clamp(rawRoundness, 0.05, 1) : 1;

  const shapeAzimuth = bool(rawObj, 'shapeAzimuth', 'oriented') ?? false;
  const shapeRotation = num(rawObj, 'shapeRotation', 'rotation') ?? 0;
  // Procreate stores shapeRotation either in radians (-pi..pi) or normalized (-1..1)
  const angle = Math.abs(shapeRotation) <= 1.001
    ? Math.round(shapeRotation * 180)
    : Math.round((shapeRotation * 180) / Math.PI);
  const angleMode: 'direction' | 'pen' | 'fixed' = shapeAzimuth ? 'direction' : 'fixed';

  // Color mixing / wet edges
  const colorMixing = clamp(num(rawObj, 'wetMix', 'dynamicsMix', 'smudge') ?? 0, 0, 1);
  const paintAmount = clamp(num(rawObj, 'dynamicsLoad', 'charge') ?? 0.75, 0.05, 1);
  const wetEdges = bool(rawObj, 'wetEdges', 'dynamicsWetEdges', 'burntEdges') ?? false;
  const wetEdgeStrength = boundedNumber(rawObj, 0, 1, 'wetEdgesStrength', 'wetMixDilution');
  const wetEdgeWidth = boundedNumber(rawObj, 0.05, 0.5, 'wetEdgesWidth', 'burntEdges');
  const wetEdgeDarkness = boundedNumber(rawObj, 0, 1, 'wetEdgesDarkness');
  const pigmentBlendMode = colorMixing > 0
    ? getEnumSetting(rawObj, pigmentBlendModes, 'pigmentBlendMode') ?? 'subtractive' : undefined;
  const pigmentStrength = colorMixing > 0 ? boundedNumber(rawObj, 0, 1, 'pigmentStrength') ?? 0.85 : undefined;
  const colorStretch = colorMixing > 0 ? boundedNumber(rawObj, 0, 1, 'dynamicsPull', 'colorStretch') : undefined;
  const chargeDepletion = colorMixing > 0 ? boundedNumber(rawObj, 0, 1, 'dynamicsDepletion', 'chargeDepletion') : undefined;

  // Dynamics
  const pressureSizeAmt = num(rawObj, 'dynamicsPressureSize', 'pressureSize');
  const pressureOpacityAmt = num(rawObj, 'dynamicsPressureOpacity', 'pressureOpacity');
  const pressureFlowAmt = num(rawObj, 'dynamicsPressureBleed', 'dynamicsPressureFlow');
  const jitterSize = clamp(num(rawObj, 'dynamicsJitterSize', 'sizeJitter') ?? 0, 0, 1);
  const jitterOpacity = clamp(num(rawObj, 'dynamicsJitterOpacity', 'opacityJitter') ?? 0, 0, 1);
  const tiltSize = clamp(Math.abs(num(rawObj, 'dynamicsTiltSize', 'tiltSize') ?? 0), 0, 1);

  const dynamics: BrushDynamicsConfig = {
    size: {
      pressure: pressureSizeAmt !== undefined ? Math.abs(pressureSizeAmt) > 0.01 : true,
      min: minSizeRatio,
      random: jitterSize,
    },
    opacity: {
      pressure: pressureOpacityAmt !== undefined ? Math.abs(pressureOpacityAmt) > 0.01 : false,
      min: minOpacity,
      random: jitterOpacity,
    },
    flow: {
      pressure: pressureFlowAmt !== undefined ? Math.abs(pressureFlowAmt) > 0.01 : false,
      min: 0.15,
    },
    scatter: {
      pressure: false,
      random: scatter,
    },
  };

  const jitter = (...keys: string[]): number | undefined => {
    const value = num(rawObj, ...keys);
    return value === undefined ? undefined : clamp(Math.abs(value), 0, 1);
  };
  const stampHue = jitter('dynamicsJitterHue', 'hueJitter');
  const stampSaturation = jitter('dynamicsJitterSaturation', 'saturationJitter');
  const stampLightness = jitter('dynamicsJitterLightness', 'dynamicsJitterDarkness', 'lightnessJitter');
  const strokeHue = jitter('dynamicsStrokeJitterHue', 'colorDynamicsStrokeHue');
  const strokeSaturation = jitter('dynamicsStrokeJitterSaturation', 'colorDynamicsStrokeSaturation');
  const strokeLightness = jitter('dynamicsStrokeJitterLightness', 'colorDynamicsStrokeBrightness');
  const perStroke = !!(strokeHue || strokeSaturation || strokeLightness) && !(stampHue || stampSaturation || stampLightness);
  const fgBgMix = boundedNumber(rawObj, 0, 1, 'dynamicsJitterSecondaryColor', 'colorDynamicsSecondaryColor');
  const colorDynamics = normalizeColorDynamics({
    hueJitter: perStroke ? strokeHue : stampHue,
    saturationJitter: perStroke ? strokeSaturation : stampSaturation,
    lightnessJitter: perStroke ? strokeLightness : stampLightness,
    huePressure: num(rawObj, 'colorDynamicsPressureHue', 'dynamicsPressureHue'),
    saturationPressure: num(rawObj, 'colorDynamicsPressureSaturation', 'dynamicsPressureSaturation'),
    lightnessPressure: num(rawObj, 'colorDynamicsPressureBrightness', 'dynamicsPressureLightness'),
    hueGradient: num(rawObj, 'colorDynamicsGradientHue'),
    saturationGradient: num(rawObj, 'colorDynamicsGradientSaturation'),
    lightnessGradient: num(rawObj, 'colorDynamicsGradientLightness'),
    fgBgMix,
  });
  if (colorDynamics) colorDynamics.scope = perStroke ? 'perStroke' : 'perDab';

  const dualBrushKeys = ['bundledBrush', 'secondaryBrush', 'dualBrush'];
  const dualBrush = !!dualShape || dualBrushKeys.some((key) => {
    const value = rawObj[key];
    return bool(rawObj, key) === true || (value !== null && typeof value === 'object' && !Array.isArray(value));
  });
  const dualBlendMode = dualBrush
    ? getEnumSetting(rawObj, dualBlendModes, 'bundledBrushCombineMode', 'combineMode', 'dualBlendMode') ?? 'multiply'
    : undefined;
  const dualTipShape = dualShape
    ? 'custom'
    : getEnumSetting(rawObj, dualTipShapes, 'dualTipShape') ?? (dualBrush ? 'same' : undefined);
  const dualTipDataUrl = dualShape
    ? await convertProcreateShapeToTipDataUrl(dualShape, bool(rawObj, 'dualShapeInverted', 'secondaryShapeInverted') ?? shapeInverted)
    : undefined;

  // Grain / paper texture
  let textureDataUrl: string | null = null;
  let textureDensity: number | undefined;
  let textureScale: number | undefined;
  let textureInvert: boolean | undefined;
  if (grain) {
    textureDataUrl = pngBytesToDataUrl(grain);
    const rawDepth = num(rawObj, 'textureDepth', 'grainDepth', 'textureBrightness');
    const density = rawDepth !== undefined ? clamp(Math.abs(rawDepth), 0.1, 1) : 0.45;
    const grainContrast = boundedNumber(rawObj, -1, 1, 'grainContrast') ?? 0;
    const grainBrightness = boundedNumber(rawObj, -1, 1, 'grainBrightness') ?? 0;
    textureDensity = clamp(density + (density - 0.5) * grainContrast + grainBrightness, 0, 1);
    const rawScale = num(rawObj, 'textureScale', 'textureZoom');
    textureScale = rawScale !== undefined ? clamp(rawScale, 0.1, 4) : 1;
    textureInvert = bool(rawObj, 'textureInverted') ?? false;
  }

  // Streamline / stabilization
  const streamline = num(rawObj, 'streamline', 'dynamicsStabilization', 'stabilizationAmount');
  const stabilizerLevel = streamline !== undefined ? Math.round(clamp(streamline, 0, 1) * 10) : 3;

  // Tip image
  let tipDataUrl: string | null = null;
  let width = 256;
  let height = 256;
  if (shapeBytes) {
    const dims = readPngDimensions(shapeBytes);
    width = dims.width;
    height = dims.height;
    tipDataUrl = await convertProcreateShapeToTipDataUrl(shapeBytes, shapeInverted);
  }
  const tipUrls = tipDataUrl && extraShapes.length > 0
    ? [tipDataUrl, ...await Promise.all(extraShapes.map((shape) => convertProcreateShapeToTipDataUrl(shape, shapeInverted)))]
    : undefined;

  return {
    id,
    name,
    width,
    height,
    dataUrl: tipDataUrl,
    size,
    minSize,
    opacity,
    flow,
    spacing,
    hardness,
    roundness,
    angle,
    angleMode,
    scatter,
    colorMixing,
    paintAmount,
    colorStretch,
    pigmentBlendMode,
    pigmentStrength,
    chargeDepletion,
    wetEdges,
    wetEdgeStrength,
    wetEdgeWidth,
    wetEdgeDarkness,
    tiltSize,
    hueJitter: stampHue ?? 0,
    satJitter: stampSaturation ?? 0,
    valJitter: stampLightness ?? 0,
    fgBgMix,
    colorDynamics,
    dualBrush: dualBrush || undefined,
    dualBlendMode,
    dualSize: boundedNumber(rawObj, 0.1, 1, 'dualSize', 'bundledBrushSize', 'secondaryScale'),
    dualSpacing: boundedNumber(rawObj, 0.05, 2, 'dualSpacing', 'bundledBrushSpacing'),
    dualScatter: boundedNumber(rawObj, 0, 2, 'dualScatter', 'bundledBrushScatter'),
    dualTipShape,
    dualTipDataUrl,
    tipUrls,
    tipPlayMode: tipUrls ? getShapePlayMode(rawObj) : undefined,
    textureDataUrl,
    textureDensity,
    textureScale,
    textureInvert,
    textureBlendMode: getEnumSetting(rawObj, textureBlendModes, 'textureBlendMode', 'grainBlendMode'),
    dynamics,
    stabilizerLevel,
    shapeInverted,
    setName,
    sourceFormat: 'procreate',
  };
}

export class ProcreateParser {
  private readonly bytes: Uint8Array;
  private readonly fileName: string;

  constructor(input: ArrayBuffer | ArrayBufferView, fileName = 'Procreate.brush') {
    this.bytes = input instanceof Uint8Array
      ? input
      : ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
    this.fileName = fileName;
  }

  public async parse(): Promise<ProcreateParseResult> {
    const entries = await readZipEntries(this.bytes);
    if (entries.size === 0) {
      throw new Error('Empty Procreate archive.');
    }

    // Group entries by folder prefix ('' for root)
    const folders = new Map<string, BrushFolderFiles>();
    let brushsetPlistBytes: Uint8Array | undefined;

    for (const [path, data] of entries.entries()) {
      const parts = path.split('/');
      const base = parts[parts.length - 1].toLowerCase();
      const dir = parts.slice(0, -1).join('/');

      if (base === 'brushset.plist' && parts.length <= 2) {
        brushsetPlistBytes = data;
        continue;
      }

      const numberedShape = /^shape_(\d+)\.png$/.exec(base);
      const secondaryShape = dualShapeNames.has(base);
      if (base === 'brush.archive' || base === 'shape.png' || base === 'grain.png' || secondaryShape || numberedShape) {
        let folder = folders.get(dir);
        if (!folder) {
          folder = { extraShapes: [] };
          folders.set(dir, folder);
        }
        if (base === 'brush.archive') folder.archive = data;
        else if (base === 'shape.png') folder.shape = data;
        else if (base === 'grain.png') folder.grain = data;
        else if (secondaryShape) folder.dualShape ??= data;
        else if (numberedShape) folder.extraShapes.push({ order: Number(numberedShape[1]), bytes: data });
      }
    }

    const baseFileName = this.fileName.replace(/\.(brushset|brush)$/i, '').trim() || 'Procreate Brush';
    let setName: string | undefined;
    let orderedFolders: string[] = [];
    const brushFolders = [...folders.keys()].filter((key) => {
      const files = folders.get(key)!;
      return !!(files.archive || files.shape || files.extraShapes.length);
    });

    if (brushsetPlistBytes) {
      const plist = parsePlist(brushsetPlistBytes);
      const unarchived = unarchiveNSKeyed(plist);
      const meta = (unarchived && typeof unarchived === 'object' && !Array.isArray(unarchived)
        ? unarchived
        : plist && typeof plist === 'object' && !Array.isArray(plist)
          ? plist
          : {}) as Record<string, unknown>;
      setName = str(meta, 'name') || baseFileName;
      const list = Array.isArray(meta.brushes) ? meta.brushes.filter((x): x is string => typeof x === 'string') : [];
      for (const uuid of list) {
        // Match either `<uuid>` or `<wrapper>/<uuid>`
        if (brushFolders.includes(uuid)) {
          orderedFolders.push(uuid);
        } else {
          const matched = brushFolders.find((k) => k.endsWith(`/${uuid}`));
          if (matched) orderedFolders.push(matched);
        }
      }
      // Include any extra brush folders not referenced in brushset.plist
      for (const key of brushFolders) {
        if (!orderedFolders.includes(key)) {
          orderedFolders.push(key);
        }
      }
    } else {
      if (/\.brushset$/i.test(this.fileName)) {
        setName = baseFileName;
      }
      orderedFolders = brushFolders.sort();
    }

    if (orderedFolders.length === 0) {
      throw new Error(`No Brush.archive or Shape.png found in ${this.fileName}.`);
    }

    const brushes: ParsedProcreateBrush[] = [];
    for (let i = 0; i < orderedFolders.length; i++) {
      const dir = orderedFolders[i];
      const files = folders.get(dir)!;
      const fallbackName = orderedFolders.length === 1
        ? baseFileName
        : `${setName || baseFileName} ${i + 1}`;
      const brush = await mapSilicaBrushToParsed(
        `procreate_${i}_${dir || 'root'}`,
        fallbackName,
        files,
        setName,
      );
      brushes.push(brush);
    }

    return { setName, brushes };
  }
}

export async function parseProcreateArchive(
  input: ArrayBuffer | ArrayBufferView,
  fileName = 'Procreate.brush',
): Promise<ProcreateParseResult> {
  return new ProcreateParser(input, fileName).parse();
}
