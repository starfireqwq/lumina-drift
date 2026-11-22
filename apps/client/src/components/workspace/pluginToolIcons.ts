import type React from 'react';
import {
  Crosshair,
  Film,
  Layers,
  Paintbrush,
  PenTool,
  Ruler,
  Shapes,
  Sparkles,
  Stamp,
  Wand2,
} from 'lucide-react';
import type { PluginToolIcon } from '../../plugins/pluginApi';

const ICON_MAP: Record<PluginToolIcon, React.ComponentType<{ className?: string }>> = {
  wand: Wand2,
  brush: Paintbrush,
  pen: PenTool,
  sparkles: Sparkles,
  stamp: Stamp,
  shapes: Shapes,
  ruler: Ruler,
  crosshair: Crosshair,
  layers: Layers,
  film: Film,
};

export function getPluginToolIcon(icon?: PluginToolIcon): React.ComponentType<{ className?: string }> {
  return (icon && ICON_MAP[icon]) || Sparkles;
}
