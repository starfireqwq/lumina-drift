/**
 * UI colour themes. Every Tailwind neutral / indigo class reads a CSS variable
 * (see tailwind.config.js), so a theme is just a set of variable values.
 */
export type ThemeBase = 'dark' | 'gray' | 'light';
export type ThemeId = 'dark' | 'gray' | 'light' | 'sakura' | 'matcha' | 'midnight' | 'custom';
export type SurfaceStyle = 'solid' | 'liquid-glass' | 'chromatic-glass' | 'frosted-matte' | 'lumina-glow' | 'soft-paper';

export interface SurfaceStylePreset {
  id: SurfaceStyle;
  fallbackLabel: string;
}

export const DEFAULT_SURFACE_STYLE: SurfaceStyle = 'solid';

export const SURFACE_STYLES: SurfaceStylePreset[] = [
  { id: 'solid', fallbackLabel: '經典純淨' },
  { id: 'liquid-glass', fallbackLabel: '液態玻璃' },
  { id: 'chromatic-glass', fallbackLabel: '炫彩玻璃' },
  { id: 'frosted-matte', fallbackLabel: '柔霧磨砂' },
  { id: 'lumina-glow', fallbackLabel: '流光霓虹' },
  { id: 'soft-paper', fallbackLabel: '紙感軟擬態' },
];

export const SURFACE_STYLE_KEY = 'atelier_surface_style';

export const isSurfaceStyle = (value: unknown): value is SurfaceStyle =>
  typeof value === 'string' && SURFACE_STYLES.some((s) => s.id === value);

export interface CustomThemeSettings {
  base: ThemeBase;
  tint: string;
  tintStrength: number; // 0..0.4
  accent: string;
}

export interface ThemePreset {
  id: Exclude<ThemeId, 'custom'>;
  label: string;
  base: ThemeBase;
  tint: string;
  tintStrength: number;
  accent: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: 'dark', label: '墨夜深色', base: 'dark', tint: '#6470a0', tintStrength: 0.06, accent: '#6366f1' },
  { id: 'gray', label: '工作室灰', base: 'gray', tint: '#808080', tintStrength: 0, accent: '#3b8cf6' },
  { id: 'light', label: '日光淺色', base: 'light', tint: '#7080a8', tintStrength: 0.05, accent: '#4f46e5' },
  { id: 'sakura', label: '櫻花粉', base: 'light', tint: '#f472b6', tintStrength: 0.16, accent: '#db2777' },
  { id: 'matcha', label: '抹茶綠', base: 'light', tint: '#84a46c', tintStrength: 0.2, accent: '#4d7c0f' },
  { id: 'midnight', label: '午夜藍', base: 'dark', tint: '#3b82f6', tintStrength: 0.16, accent: '#38bdf8' },
];

export const DEFAULT_CUSTOM_THEME: CustomThemeSettings = {
  base: 'dark',
  tint: '#a855f7',
  tintStrength: 0.12,
  accent: '#a855f7',
};

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

// 950 = deepest surface (inputs, app shell), 900 = panels, 800 = buttons, 700 = borders, 50-300 = text.
const BASE_SCALES: Record<ThemeBase, string[]> = {
  dark: ['#f7f7f9', '#eceef2', '#d9dce4', '#b9bdc9', '#8e93a3', '#686d7d', '#4b4f5c', '#353844', '#262832', '#1a1b23', '#111217'],
  gray: ['#fafafa', '#f0f0f1', '#e2e2e4', '#cfcfd2', '#b4b4b8', '#96969b', '#7a7a80', '#5f5f64', '#4b4b4f', '#3c3c3f', '#2e2e31'],
  light: ['#15161b', '#22242b', '#33363f', '#4b4f5c', '#5f6472', '#80869a', '#aeb3c0', '#d3d6de', '#e7e9ee', '#f5f6f8', '#ffffff'],
};

const WORKSPACE_BG: Record<ThemeBase, string> = { dark: '#0d0e12', gray: '#545458', light: '#d4d7df' };

const hexToRgb = (hex: string): [number, number, number] => {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, '0');
  const n = parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
  [0, 1, 2].map((i) => Math.round(a[i] * (1 - t) + b[i] * t)) as [number, number, number];

const channels = (rgb: [number, number, number]) => rgb.join(' ');

const luminance = ([r, g, b]: [number, number, number]) => {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

export const contrastRatio = (a: string, b: string) => {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** Accent 50..950 from one colour: lighter shades mix toward white, darker toward black. */
const accentScale = (accent: string) => {
  const base = hexToRgb(accent);
  const white: [number, number, number] = [255, 255, 255];
  const black: [number, number, number] = [8, 8, 14];
  const steps: Record<number, [number, number, number]> = {
    50: mix(base, white, 0.92), 100: mix(base, white, 0.82), 200: mix(base, white, 0.64),
    300: mix(base, white, 0.44), 400: mix(base, white, 0.22), 500: base,
    600: mix(base, black, 0.14), 700: mix(base, black, 0.3), 800: mix(base, black, 0.48),
    900: mix(base, black, 0.62), 950: mix(base, black, 0.78),
  };
  return steps;
};

const LIGHT_MAP: Record<number, number> = { 50: 950, 100: 900, 200: 800, 300: 700, 400: 600, 500: 500, 600: 600, 700: 700, 800: 200, 900: 100, 950: 50 };

export interface ResolvedTheme {
  base: ThemeBase;
  vars: Record<string, string>;
}

export const resolveTheme = (id: ThemeId, custom: CustomThemeSettings): ResolvedTheme => {
  const preset = THEME_PRESETS.find((p) => p.id === id);
  const settings = preset ?? custom;
  const base = settings.base;
  const isLight = base === 'light';
  const tint = hexToRgb(settings.tint);
  const strength = Math.max(0, Math.min(0.4, settings.tintStrength));
  const vars: Record<string, string> = {};

  BASE_SCALES[base].forEach((hex, i) => {
    // Text shades (50-400) take only a little tint so they keep their contrast.
    const weight = i <= 4 ? 0.35 : i === 5 ? 0.7 : 1;
    vars[`--n-${SHADES[i]}`] = channels(mix(hexToRgb(hex), tint, strength * weight));
  });

  const accent = accentScale(settings.accent);
  for (const s of SHADES) vars[`--a-${s}`] = channels(accent[isLight ? LIGHT_MAP[s] : s]);
  // Unflipped light shades, used for text inside saturated buttons (see tailwind.config.js)
  for (const s of [50, 100, 200, 300]) vars[`--a-raw-${s}`] = channels(accent[s]);

  vars['--text-strong'] = isLight ? vars['--n-50'] : '255 255 255';
  const workspace = mix(hexToRgb(WORKSPACE_BG[base]), tint, strength * 0.8);
  vars['--workspace-bg'] = `rgb(${channels(workspace)})`;
  return { base, vars };
};

const channelsToHex = (channelsStr: string) => {
  const parts = channelsStr.trim().split(/\s+/).map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))));
  if (parts.length < 3 || parts.some((v) => !Number.isFinite(v))) return '#0d0e12';
  return `#${parts.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

let titleBarTimer: ReturnType<typeof setTimeout> | undefined;

export const applySurfaceStyle = (surface: SurfaceStyle) => {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const next: SurfaceStyle = isSurfaceStyle(surface) ? surface : DEFAULT_SURFACE_STYLE;
  document.documentElement.dataset.surface = next;
};

export const applyTheme = (id: ThemeId, custom: CustomThemeSettings, surface?: SurfaceStyle) => {
  if (typeof document === 'undefined') return;
  const { base, vars } = resolveTheme(id, custom);
  const root = document.documentElement;
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
  root.classList.toggle('light', base === 'light');
  root.classList.toggle('dark', base !== 'light');
  root.dataset.theme = id;
  root.style.colorScheme = base === 'light' ? 'light' : 'dark';
  if (surface !== undefined) applySurfaceStyle(surface);
  const desktop = typeof window !== 'undefined' ? (window as any).atelierDesktop : undefined;
  if (desktop?.setTitleBarTheme) {
    const color = channelsToHex(vars['--n-950'] || '13 14 18');
    const symbolColor = channelsToHex(vars['--n-100'] || '236 238 242');
    clearTimeout(titleBarTimer);
    titleBarTimer = setTimeout(() => {
      void desktop.setTitleBarTheme({ color, symbolColor, backgroundColor: color });
    }, 150);
  }
};

export const loadSurfaceStyle = (): SurfaceStyle => {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_SURFACE_STYLE;
    const saved = localStorage.getItem(SURFACE_STYLE_KEY);
    if (isSurfaceStyle(saved)) return saved;
  } catch {
    // Storage blocked: fall back to default solid surface
  }
  return DEFAULT_SURFACE_STYLE;
};

export const saveSurfaceStyle = (surface: SurfaceStyle) => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SURFACE_STYLE_KEY, isSurfaceStyle(surface) ? surface : DEFAULT_SURFACE_STYLE);
  } catch {
    // ignore
  }
};

const THEME_KEY = 'atelier_theme';
const CUSTOM_KEY = 'atelier_custom_theme';

export const loadThemeSettings = (): { id: ThemeId; custom: CustomThemeSettings } => {
  let id: ThemeId = 'dark';
  let custom = DEFAULT_CUSTOM_THEME;
  try {
    const saved = localStorage.getItem(THEME_KEY) as ThemeId | null;
    if (saved && (saved === 'custom' || THEME_PRESETS.some((p) => p.id === saved))) id = saved;
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (raw) custom = { ...DEFAULT_CUSTOM_THEME, ...JSON.parse(raw) };
  } catch {
    // Storage blocked: fall back to the default theme
  }
  return { id, custom };
};

export const saveThemeSettings = (id: ThemeId, custom: CustomThemeSettings) => {
  try {
    localStorage.setItem(THEME_KEY, id);
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
  } catch {
    // ignore
  }
};
