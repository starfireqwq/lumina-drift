import { hexToRgb, hsvToRgb, rgbToHex } from './colorWheelMath.ts';

export interface PaletteSwatch {
  hex: string;
  name?: string;
}

export interface ParsedPalette {
  name: string;
  colors: PaletteSwatch[];
}

export function normalizeHexColor(input: string): string | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!match) return null;
  const digits = match[1].toUpperCase();
  return `#${digits.length === 3 ? digits.replace(/./g, '$&$&') : digits}`;
}

function normalizeSwatches(colors: ReadonlyArray<PaletteSwatch | string>): PaletteSwatch[] {
  const swatches: PaletteSwatch[] = [];
  for (const color of colors) {
    const hex = normalizeHexColor(typeof color === 'string' ? color : color.hex);
    if (!hex) continue;
    const name = typeof color === 'string' ? undefined : color.name;
    swatches.push(name ? { hex, name } : { hex });
  }
  return swatches;
}

export function parseGplPalette(text: string): ParsedPalette {
  let name = 'Imported Palette';
  const colors: PaletteSwatch[] = [];
  for (const line of text.split(/\r\n?|\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Name:')) {
      name = trimmed.slice('Name:'.length).trim() || name;
      continue;
    }
    if (!trimmed || trimmed.startsWith('#') || trimmed === 'GIMP Palette' || trimmed.startsWith('Columns:')) {
      continue;
    }

    const match = /^(\d+)\s+(\d+)\s+(\d+)(?:\s+(.+))?$/.exec(trimmed);
    if (!match) continue;
    const r = Number(match[1]);
    const g = Number(match[2]);
    const b = Number(match[3]);
    if (r > 255 || g > 255 || b > 255) continue;

    const hex = rgbToHex(r, g, b);
    const swatchName = match[4]?.trim();
    colors.push(swatchName ? { hex, name: swatchName } : { hex });
  }
  return { name, colors };
}

export function serializeGplPalette(
  name: string,
  colors: ReadonlyArray<PaletteSwatch | string>,
  columns = 8,
): string {
  const toSingleLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
  const lines = ['GIMP Palette', `Name: ${toSingleLine(name)}`, `Columns: ${columns}`, '#'];
  for (const swatch of normalizeSwatches(colors)) {
    const rgb = hexToRgb(swatch.hex).map((channel) => String(channel).padStart(3, ' ')).join(' ');
    lines.push(`${rgb}\t${toSingleLine(swatch.name ?? '')}`);
  }
  return `${lines.join('\n')}\n`;
}

const ACO_HEADER_BYTES = 4;
const ACO_COLOR_BYTES = 10;
const ACO_NAME_LENGTH_BYTES = 4;
const ACO_MAX_SWATCHES = 0xffff;

function acoColorToHex(space: number, w: number, x: number, y: number, z: number): string | null {
  switch (space) {
    case 0:
      return rgbToHex(Math.round(w / 257), Math.round(x / 257), Math.round(y / 257));
    case 1:
      return rgbToHex(...hsvToRgb(w / 65535 * 360, x / 65535, y / 65535));
    case 2: {
      // ACO stores the fraction of each channel left without ink.
      const blackScale = 255 * (z / 65535);
      return rgbToHex(
        Math.round(blackScale * (w / 65535)),
        Math.round(blackScale * (x / 65535)),
        Math.round(blackScale * (y / 65535)),
      );
    }
    case 8: {
      const gray = Math.max(0, Math.round((1 - w / 10000) * 255));
      return rgbToHex(gray, gray, gray);
    }
    default:
      return null;
  }
}

function readAcoBlock(view: DataView, offset: number, version: 1 | 2) {
  const count = view.getUint16(offset + 2);
  const colors: PaletteSwatch[] = [];
  const decoder = version === 2 ? new TextDecoder('utf-16be', { ignoreBOM: true }) : undefined;
  offset += ACO_HEADER_BYTES;

  for (let index = 0; index < count; index += 1) {
    if (view.byteLength - offset < ACO_COLOR_BYTES) return { colors, offset, complete: false };
    const hex = acoColorToHex(
      view.getUint16(offset),
      view.getUint16(offset + 2),
      view.getUint16(offset + 4),
      view.getUint16(offset + 6),
      view.getUint16(offset + 8),
    );
    offset += ACO_COLOR_BYTES;

    let name: string | undefined;
    if (decoder) {
      if (view.byteLength - offset < ACO_NAME_LENGTH_BYTES) return { colors, offset, complete: false };
      const nameBytes = view.getUint32(offset) * 2;
      offset += ACO_NAME_LENGTH_BYTES;
      if (nameBytes > view.byteLength - offset) return { colors, offset, complete: false };
      if (hex && nameBytes > 0) {
        const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, nameBytes);
        name = decoder.decode(bytes).replace(/\0+$/, '');
      }
      offset += nameBytes;
    }
    if (hex) colors.push(name ? { hex, name } : { hex });
  }

  return { colors, offset, complete: true };
}

export function parseAcoPalette(data: ArrayBuffer | Uint8Array): PaletteSwatch[] {
  const view = data instanceof Uint8Array
    ? new DataView(data.buffer, data.byteOffset, data.byteLength)
    : new DataView(data);
  if (view.byteLength < ACO_HEADER_BYTES) return [];

  const version = view.getUint16(0);
  if (version === 2) return readAcoBlock(view, 0, 2).colors;
  if (version !== 1) return [];

  const first = readAcoBlock(view, 0, 1);
  if (!first.complete || view.byteLength - first.offset < ACO_HEADER_BYTES || view.getUint16(first.offset) !== 2) {
    return first.colors;
  }

  const second = readAcoBlock(view, first.offset, 2);
  return second.complete || first.colors.length === 0 ? second.colors : first.colors;
}

export function serializeAcoPalette(colors: ReadonlyArray<PaletteSwatch | string>): Uint8Array {
  const swatches = normalizeSwatches(colors);
  if (swatches.length > ACO_MAX_SWATCHES) throw new RangeError('ACO palettes support up to 65535 swatches');

  const namesSize = swatches.reduce((size, swatch) => size + ((swatch.name?.length ?? 0) + 1) * 2, 0);
  const bytes = new Uint8Array(
    ACO_HEADER_BYTES * 2 + (ACO_COLOR_BYTES * 2 + ACO_NAME_LENGTH_BYTES) * swatches.length + namesSize,
  );
  const view = new DataView(bytes.buffer);
  let offset = 0;

  for (const version of [1, 2]) {
    view.setUint16(offset, version);
    view.setUint16(offset + 2, swatches.length);
    offset += ACO_HEADER_BYTES;

    for (const swatch of swatches) {
      const [r, g, b] = hexToRgb(swatch.hex);
      // The zero-filled buffer supplies the RGB color space and unused component.
      view.setUint16(offset + 2, r * 257);
      view.setUint16(offset + 4, g * 257);
      view.setUint16(offset + 6, b * 257);
      offset += ACO_COLOR_BYTES;

      if (version === 2) {
        const name = swatch.name ?? '';
        view.setUint32(offset, name.length + 1);
        offset += ACO_NAME_LENGTH_BYTES;
        for (let index = 0; index < name.length; index += 1) {
          view.setUint16(offset, name.charCodeAt(index));
          offset += 2;
        }
        offset += 2; // Null terminator
      }
    }
  }

  return bytes;
}
