import { useSyncExternalStore } from 'react';

/**
 * 介面縮放: the whole interface (text, buttons, panels) at 50–200 %, in place of the browser's
 * Ctrl + / −. The build turns every CSS px into rem (postcss.config.js), so the root font size
 * scales all of it at once, while the canvas and pointer coordinates stay in real pixels. Panel
 * sizes are kept in pixels and follow by the same factor (onUiRescale).
 */
export const UI_SCALE_MIN = 0.5;
export const UI_SCALE_MAX = 2;
const STORAGE_KEY = 'atelier_ui_scale';

const clampScale = (v: number) => Math.round(Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, v)) * 100) / 100;

let scale = (() => {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(v) && v > 0 ? clampScale(v) : 1;
  } catch {
    return 1;
  }
})();
const listeners = new Set<() => void>();
const rescaleHooks = new Set<(factor: number) => void>();

/** Sets the root font size (call once before the first paint, then on every change) */
export const applyUiScale = () => {
  document.documentElement.style.fontSize = `${16 * scale}px`;
  document.documentElement.style.setProperty('--ui-scale', String(scale));
};

export const getUiScale = () => scale;

export const setUiScale = (next: number) => {
  const v = clampScale(next);
  if (v === scale) return;
  const factor = v / scale;
  scale = v;
  try {
    localStorage.setItem(STORAGE_KEY, String(v));
  } catch {
    // storage blocked: the scale holds for this visit only
  }
  applyUiScale();
  rescaleHooks.forEach((hook) => hook(factor));
  listeners.forEach((l) => l());
};

/** Pixel sizes kept elsewhere (dock widths, floating windows) grow / shrink with the interface */
export const onUiRescale = (hook: (factor: number) => void) => {
  rescaleHooks.add(hook);
  return () => rescaleHooks.delete(hook);
};

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export const useUiScale = () => useSyncExternalStore(subscribe, getUiScale, getUiScale);
