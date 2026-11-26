import { createElement, type ReactNode } from 'react';
import {
  AlignCenter, Image, Keyboard, Layers, ListVideo, Paintbrush, Palette,
  SlidersHorizontal, Sparkles, Terminal, Users, type LucideIcon,
} from 'lucide-react';
import type { Translations as Translation } from '../../locales/types';
import type { PanelId } from './dockStore';

export const PANEL_ICON_COMPONENTS: Record<PanelId, LucideIcon> = {
  color: Palette,
  subView: Image,
  autoActions: ListVideo,
  brushToolset: Paintbrush,
  toolProps: SlidersHorizontal,
  layers: Layers,
  members: Users,
  oplog: Terminal,
  quickKeys: Keyboard,
  filters: Sparkles,
  align: AlignCenter,
};

export function renderPanelIcon(id: PanelId, className?: string): ReactNode {
  return createElement(PANEL_ICON_COMPONENTS[id], { className, 'aria-hidden': true, focusable: false });
}

export function getPanelDisplayTitle(id: PanelId, t: Translation): string {
  return t.dock.panelNames[id];
}
