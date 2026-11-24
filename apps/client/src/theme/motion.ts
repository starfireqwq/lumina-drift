import { useSyncExternalStore } from 'react';

export type MotionMode = 'on' | 'auto' | 'off';
export type EffectiveMotion = 'on' | 'off';

export const MOTION_MODE_STORAGE_KEY = 'atelier_motion_mode';
export const DEFAULT_MOTION_MODE: MotionMode = 'on';

export function normalizeMotionMode(raw: unknown): MotionMode {
  return raw === 'on' || raw === 'auto' || raw === 'off' ? raw : DEFAULT_MOTION_MODE;
}

export function resolveEffectiveMotion(
  mode: MotionMode,
  systemPrefersReduced: boolean,
): EffectiveMotion {
  if (mode === 'on') return 'on';
  if (mode === 'off') return 'off';
  return systemPrefersReduced ? 'off' : 'on';
}

export function getSystemPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return Boolean(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

function readMotionMode(): MotionMode {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_MOTION_MODE;
    return normalizeMotionMode(localStorage.getItem(MOTION_MODE_STORAGE_KEY));
  } catch {
    return DEFAULT_MOTION_MODE;
  }
}

function writeMotionMode(mode: MotionMode): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MOTION_MODE_STORAGE_KEY, mode);
    }
  } catch {
    // Storage may be unavailable in restricted or headless contexts.
  }
}

let motionMode: MotionMode = readMotionMode();
const listeners = new Set<() => void>();
let boundMediaList: MediaQueryList | null = null;
let boundMediaListener: (() => void) | null = null;

function notifyMotionListeners(): void {
  listeners.forEach((listener) => listener());
}

function ensureSystemMotionListener(): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  try {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (boundMediaList === mql) return;
    if (boundMediaList && boundMediaListener) {
      if (typeof boundMediaList.removeEventListener === 'function') {
        boundMediaList.removeEventListener('change', boundMediaListener);
      } else if (typeof boundMediaList.removeListener === 'function') {
        boundMediaList.removeListener(boundMediaListener);
      }
    }
    const onChange = () => {
      if (motionMode !== 'auto') return;
      applyMotionMode(motionMode);
      notifyMotionListeners();
    };
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      boundMediaList = mql;
      boundMediaListener = onChange;
    } else if (typeof mql.addListener === 'function') {
      mql.addListener(onChange);
      boundMediaList = mql;
      boundMediaListener = onChange;
    }
  } catch {
    // Ignore restricted matchMedia implementations.
  }
}

export function applyMotionMode(mode: MotionMode = motionMode): EffectiveMotion {
  const normalized = normalizeMotionMode(mode);
  const effective = resolveEffectiveMotion(normalized, getSystemPrefersReducedMotion());
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset.motion = effective;
    document.documentElement.dataset.motionMode = normalized;
  }
  ensureSystemMotionListener();
  return effective;
}

export function syncMotionFromEnvironment(): EffectiveMotion {
  motionMode = readMotionMode();
  return applyMotionMode(motionMode);
}

export const getMotionMode = (): MotionMode => motionMode;

export const getEffectiveMotion = (): EffectiveMotion =>
  resolveEffectiveMotion(motionMode, getSystemPrefersReducedMotion());

export const isReducedMotion = (): boolean => getEffectiveMotion() === 'off';

export function setMotionMode(next: MotionMode): void {
  const normalized = normalizeMotionMode(next);
  if (normalized === motionMode) {
    applyMotionMode(normalized);
    return;
  }
  motionMode = normalized;
  writeMotionMode(normalized);
  applyMotionMode(normalized);
  notifyMotionListeners();
}

export const subscribeMotionChange = (listener: () => void): (() => void) => {
  ensureSystemMotionListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useMotionMode = (): MotionMode =>
  useSyncExternalStore(subscribeMotionChange, getMotionMode, getMotionMode);
