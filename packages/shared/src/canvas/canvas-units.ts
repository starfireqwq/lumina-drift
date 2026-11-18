export type CanvasUnit = 'px' | 'cm' | 'mm' | 'in';

export const CANVAS_UNITS: readonly CanvasUnit[] = ['px', 'cm', 'mm', 'in'] as const;

const MM_PER_INCH = 25.4;
const CM_PER_INCH = 2.54;

export function clampDpi(dpi: number | undefined | null): number {
  const n = Number(dpi);
  if (!Number.isFinite(n)) return 300;
  return Math.max(30, Math.min(1200, Math.round(n)));
}

export function pixelsToUnit(px: number, unit: CanvasUnit, dpi: number): number {
  const safeDpi = clampDpi(dpi);
  switch (unit) {
    case 'in':
      return px / safeDpi;
    case 'cm':
      return (px / safeDpi) * CM_PER_INCH;
    case 'mm':
      return (px / safeDpi) * MM_PER_INCH;
    default:
      return px;
  }
}

export function unitToPixels(value: number, unit: CanvasUnit, dpi: number): number {
  const safeDpi = clampDpi(dpi);
  if (!Number.isFinite(value)) return 0;
  switch (unit) {
    case 'in':
      return Math.round(value * safeDpi);
    case 'cm':
      return Math.round((value / CM_PER_INCH) * safeDpi);
    case 'mm':
      return Math.round((value / MM_PER_INCH) * safeDpi);
    default:
      return Math.round(value);
  }
}

export function formatUnitNumber(value: number, unit: CanvasUnit): string {
  if (!Number.isFinite(value)) return '0';
  if (unit === 'px') return String(Math.round(value));
  const rounded = unit === 'mm' ? Math.round(value * 10) / 10 : Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

export function formatCanvasDimensions(widthPx: number, heightPx: number, unit: CanvasUnit = 'px', dpi: number = 300): string {
  const safeDpi = clampDpi(dpi);
  if (unit === 'px') return `${Math.round(widthPx)} x ${Math.round(heightPx)} px`;
  const w = formatUnitNumber(pixelsToUnit(widthPx, unit, safeDpi), unit);
  const h = formatUnitNumber(pixelsToUnit(heightPx, unit, safeDpi), unit);
  return `${w} x ${h} ${unit}`;
}
