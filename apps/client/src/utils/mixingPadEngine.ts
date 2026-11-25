import { normalizeHexColor } from './colorPaletteIO.ts';
import { hexToRgb, rgbToHex } from './colorWheelMath.ts';

export type MixingPadMode = 'paint' | 'smudge';

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, value)) || 0;
}

function toByte(value: number): number {
  return Math.round(clamp(value, 255));
}

export function hexToRgba(hex: string, alpha = 255): RgbaColor {
  const [r, g, b] = hexToRgb(normalizeHexColor(hex) ?? '#000000');
  return { r, g, b, a: toByte(alpha) };
}

export function rgbaToHex(r: number, g: number, b: number): string {
  return rgbToHex(toByte(r), toByte(g), toByte(b));
}

export function blendPigmentRgba(dst: RgbaColor, src: RgbaColor, strength: number): RgbaColor {
  const srcAlpha = clamp(src.a, 255) / 255 * clamp(strength, 1);
  if (srcAlpha === 0) return { r: toByte(dst.r), g: toByte(dst.g), b: toByte(dst.b), a: toByte(dst.a) };

  const dstWeight = clamp(dst.a, 255) / 255 * (1 - srcAlpha);
  const alpha = srcAlpha + dstWeight;
  return {
    r: toByte((clamp(src.r, 255) * srcAlpha + clamp(dst.r, 255) * dstWeight) / alpha),
    g: toByte((clamp(src.g, 255) * srcAlpha + clamp(dst.g, 255) * dstWeight) / alpha),
    b: toByte((clamp(src.b, 255) * srcAlpha + clamp(dst.b, 255) * dstWeight) / alpha),
    a: toByte(alpha * 255),
  };
}

function hasPixels(buffer: Uint8ClampedArray, width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width * height * 4 <= buffer.length;
}

export function sampleMixingBuffer(
  buffer: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  sampleRadius = 1,
): RgbaColor | null {
  if (!hasPixels(buffer, width, height) || !(x >= 0 && x < width && y >= 0 && y < height)) return null;

  const cx = Math.min(width - 1, Math.round(x));
  const cy = Math.min(height - 1, Math.round(y));
  const radius = clamp(sampleRadius, Math.hypot(width, height));
  const radiusSquared = radius * radius;
  const maxX = Math.min(width - 1, Math.floor(cx + radius));
  const maxY = Math.min(height - 1, Math.floor(cy + radius));
  let r = 0;
  let g = 0;
  let b = 0;
  let alpha = 0;
  let count = 0;

  for (let py = Math.max(0, Math.ceil(cy - radius)); py <= maxY; py += 1) {
    const dySquared = (py - cy) ** 2;
    for (let px = Math.max(0, Math.ceil(cx - radius)); px <= maxX; px += 1) {
      if ((px - cx) ** 2 + dySquared > radiusSquared) continue;
      const offset = (py * width + px) * 4;
      const a = buffer[offset + 3];
      r += buffer[offset] * a;
      g += buffer[offset + 1] * a;
      b += buffer[offset + 2] * a;
      alpha += a;
      count += 1;
    }
  }

  if (alpha === 0) return null;
  return { r: toByte(r / alpha), g: toByte(g / alpha), b: toByte(b / alpha), a: toByte(alpha / count) };
}

export function paintMixingDab(
  buffer: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  color: RgbaColor,
  hardness: number,
  strength: number,
): void {
  if (!hasPixels(buffer, width, height) || !Number.isFinite(cx) || !Number.isFinite(cy) ||
      !Number.isFinite(radius) || radius <= 0) return;
  const opacity = clamp(strength, 1);
  if (opacity === 0 || !(color.a > 0)) return;

  const minX = Math.max(0, Math.ceil(cx - radius));
  const maxX = Math.min(width - 1, Math.floor(cx + radius));
  const minY = Math.max(0, Math.ceil(cy - radius));
  const maxY = Math.min(height - 1, Math.floor(cy + radius));
  const inner = radius * clamp(hardness, 1);
  const radiusSquared = radius * radius;
  const dst = { r: 0, g: 0, b: 0, a: 0 };

  for (let py = minY; py <= maxY; py += 1) {
    const dySquared = (py - cy) ** 2;
    for (let px = minX; px <= maxX; px += 1) {
      const distanceSquared = (px - cx) ** 2 + dySquared;
      if (distanceSquared > radiusSquared) continue;

      const distance = Math.sqrt(distanceSquared);
      const fade = distance <= inner ? 1 : (radius - distance) / (radius - inner);
      const coverage = fade * fade * (3 - 2 * fade);
      if (coverage === 0) continue;

      const offset = (py * width + px) * 4;
      dst.r = buffer[offset];
      dst.g = buffer[offset + 1];
      dst.b = buffer[offset + 2];
      dst.a = buffer[offset + 3];
      const mixed = blendPigmentRgba(dst, color, opacity * coverage);
      buffer[offset] = mixed.r;
      buffer[offset + 1] = mixed.g;
      buffer[offset + 2] = mixed.b;
      buffer[offset + 3] = mixed.a;
    }
  }
}

export function strokeMixingSegment(
  buffer: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  options: {
    mode: MixingPadMode;
    color: RgbaColor;
    radius: number;
    strength: number;
    hardness?: number;
    carryColor?: RgbaColor | null;
  },
): RgbaColor | null {
  const { mode, color, radius, strength, hardness = 0.5, carryColor = null } = options;
  const smudging = mode === 'smudge';
  const dx = x1 - x0;
  const dy = y1 - y0;
  const distance = Math.hypot(dx, dy);
  if (!hasPixels(buffer, width, height) || !Number.isFinite(distance) || !Number.isFinite(radius) || radius <= 0) {
    return smudging ? carryColor : null;
  }

  const spacing = Math.max(0.25, radius * 0.35);
  const steps = Math.ceil(distance / spacing);
  if (!Number.isSafeInteger(steps)) return smudging ? carryColor : null;

  const pickupRadius = Math.max(1, radius * 0.35);
  const opacity = clamp(strength, 1);
  let carry = carryColor;
  let lastMixed: RgbaColor | null = null;
  // A continuing smudge has already processed the first point of this segment.
  const firstStep = smudging && carry && steps > 0 ? 1 : 0;
  for (let step = firstStep; step <= steps; step += 1) {
    const position = steps === 0 ? 0 : step / steps;
    const x = step === steps ? x1 : x0 + dx * position;
    const y = step === steps ? y1 : y0 + dy * position;

    if (smudging) {
      const pigment = sampleMixingBuffer(buffer, width, height, x, y, pickupRadius);
      carry ??= pigment;
      if (!carry) continue;
      paintMixingDab(buffer, width, height, x, y, radius, carry, hardness, opacity);
      if (pigment) carry = blendPigmentRgba(carry, pigment, opacity * 0.35);
    } else {
      paintMixingDab(buffer, width, height, x, y, radius, color, hardness, opacity);
      lastMixed = sampleMixingBuffer(buffer, width, height, x, y, 0) ?? lastMixed;
    }
  }

  return smudging ? carry : lastMixed;
}

export function seedDefaultMixingPad(buffer: Uint8ClampedArray, width: number, height: number): void {
  if (!hasPixels(buffer, width, height)) return;

  const surface = hexToRgba('#37363D');
  for (let offset = 0; offset < width * height * 4; offset += 4) {
    buffer[offset] = surface.r;
    buffer[offset + 1] = surface.g;
    buffer[offset + 2] = surface.b;
    buffer[offset + 3] = surface.a;
  }

  const pigments = [
    [0.22, 0.32, '#EF4444'],
    [0.50, 0.32, '#FBBF24'],
    [0.78, 0.32, '#3B82F6'],
    [0.36, 0.70, '#F7F6F4'],
    [0.64, 0.70, '#141316'],
  ] as const;
  const radius = Math.max(0.75, Math.min(width, height) * 0.105);
  for (const [x, y, hex] of pigments) {
    paintMixingDab(buffer, width, height, x * (width - 1), y * (height - 1), radius, hexToRgba(hex), 0.6, 1);
  }
}
