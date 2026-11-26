import type { AdjustmentKind, LayerType } from '@atelier/shared';
import {
  Blend, ChartColumn, Droplets, Scale, Spline, SunMoon, type LucideIcon,
} from 'lucide-react';

export const ADJUSTMENT_KIND_ICONS = {
  hsl: Droplets,
  levels: ChartColumn,
  curves: Spline,
  color_balance: Scale,
  gradient_map: Blend,
  brightness_contrast: SunMoon,
} satisfies Record<AdjustmentKind, LucideIcon>;

export function mergeIncludesAdjustment(top: LayerType, below?: LayerType): boolean {
  return top === 'adjustment' || below === 'adjustment';
}
