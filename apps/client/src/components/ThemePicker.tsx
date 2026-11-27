import React, { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { useI18n, type Translations } from '../context/I18nContext';
import {
  applyLuminaGlowSettings,
  applyTheme,
  contrastRatio,
  CustomThemeSettings,
  LuminaGlowMode,
  LuminaGlowSettings,
  resolveTheme,
  SURFACE_STYLES,
  SurfaceStyle,
  THEME_PRESETS,
  ThemeBase,
  ThemeId,
} from '../theme/themes';
import { loadThemeAnim, runThemeTransition, saveThemeAnim, ThemeAnim, THEME_ANIMS } from '../theme/themeTransition';

const swatchFor = (id: ThemeId, custom: CustomThemeSettings) => {
  const { base, vars } = resolveTheme(id, custom);
  const rgb = (v: string, alpha?: number) => (alpha === undefined ? `rgb(${v})` : `rgb(${v} / ${alpha})`);
  return {
    isLight: base === 'light',
    bg: rgb(vars['--n-900']),
    bgDeep: rgb(vars['--n-950']),
    panel: rgb(vars['--n-800']),
    border: rgb(vars['--n-700']),
    text: rgb(vars['--n-200']),
    accent: rgb(vars['--a-500']),
    accentGlow: rgb(vars['--a-400'], 0.55),
    glassPanel: rgb(vars['--n-900'], base === 'light' ? 0.78 : 0.62),
    mattePanel: rgb(vars['--n-900'], base === 'light' ? 0.9 : 0.82),
  };
};

const THEME_LABEL_KEYS: Record<ThemeId, keyof Translations['settings']> = {
  dark: 'themePresetDark',
  gray: 'themePresetGray',
  light: 'themePresetLight',
  sakura: 'themePresetSakura',
  matcha: 'themePresetMatcha',
  midnight: 'themePresetMidnight',
  custom: 'themeCustom',
};

const SURFACE_LABEL_KEYS: Record<SurfaceStyle, keyof Translations['settings']> = {
  solid: 'surfaceSolid',
  'liquid-glass': 'surfaceLiquidGlass',
  'chromatic-glass': 'surfaceChromaticGlass',
  'frosted-matte': 'surfaceFrostedMatte',
  'lumina-glow': 'surfaceLuminaGlow',
  'soft-paper': 'surfaceSoftPaper',
};

const THEME_ANIM_KEYS: Record<ThemeAnim, keyof Translations['settings']> = {
  ripple: 'themeAnimRipple',
  jelly: 'themeAnimJelly',
  fade: 'themeAnimFade',
  none: 'themeAnimNone',
};

const surfacePreviewStyle = (surface: SurfaceStyle, themeColors: ReturnType<typeof swatchFor>): React.CSSProperties => {
  switch (surface) {
    case 'liquid-glass':
      return {
        background: themeColors.isLight
          ? 'radial-gradient(120% 90% at 15% 0%, rgba(255,255,255,0.92), transparent 55%), linear-gradient(145deg, rgba(255,255,255,0.68), rgba(226,238,255,0.34) 55%, rgba(255,255,255,0.52))'
          : 'radial-gradient(120% 90% at 15% 0%, rgba(255,255,255,0.44), transparent 55%), linear-gradient(145deg, rgba(255,255,255,0.22), rgba(24,28,42,0.38) 55%, rgba(190,230,255,0.16))',
        border: `1px solid ${themeColors.isLight ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.45)'}`,
        boxShadow: themeColors.isLight
          ? 'inset 0 1.5px 0 rgba(255,255,255,0.96), inset 0 -1px 0 rgba(125,211,252,0.45), 0 4px 12px -4px rgba(15,23,42,0.22)'
          : 'inset 0 1.5px 0 rgba(255,255,255,0.58), inset 0 -1px 0 rgba(186,230,253,0.3), 0 6px 14px -4px rgba(0,0,0,0.6)',
      };
    case 'chromatic-glass':
      return {
        background: `${themeColors.isLight
          ? 'linear-gradient(145deg, rgba(255,255,255,0.78), rgba(240,246,255,0.52))'
          : 'linear-gradient(145deg, rgba(255,255,255,0.22), rgba(20,24,38,0.52))'} padding-box, linear-gradient(125deg, #ff5ea8, #ffb84d, #5eead4, #60a5fa, #a78bfa, #ff5ea8) border-box`,
        border: '1.5px solid transparent',
        boxShadow: themeColors.isLight
          ? 'inset 0 1.5px 0 rgba(255,255,255,0.92), 0 4px 12px -3px rgba(129,140,248,0.32)'
          : 'inset 0 1.5px 0 rgba(255,255,255,0.5), 0 4px 14px -3px rgba(96,165,250,0.38)',
      };
    case 'frosted-matte':
      return {
        background: themeColors.isLight
          ? `repeating-radial-gradient(circle at 0 0, rgba(15,23,42,0.03) 0 1px, transparent 1px 3px), ${themeColors.mattePanel}`
          : `repeating-radial-gradient(circle at 0 0, rgba(255,255,255,0.045) 0 1px, transparent 1px 3px), ${themeColors.mattePanel}`,
        border: `1px solid ${themeColors.isLight ? 'rgba(148,163,184,0.65)' : 'rgba(226,232,240,0.22)'}`,
        boxShadow: themeColors.isLight
          ? 'inset 0 1px 2px rgba(255,255,255,0.8), 0 4px 10px -4px rgba(15,23,42,0.16)'
          : 'inset 0 1px 2px rgba(255,255,255,0.12), inset 0 -1px 2px rgba(0,0,0,0.45), 0 4px 10px -4px rgba(0,0,0,0.5)',
      };
    case 'lumina-glow':
      return {
        background: `${themeColors.bg} padding-box, linear-gradient(90deg, rgb(var(--glow-c1, 56 189 248)), rgb(var(--glow-c3, 192 132 252)), rgb(var(--glow-c4, 244 114 182)), rgb(var(--glow-c6, 52 211 153))) border-box`,
        border: '1.5px solid transparent',
        boxShadow: '0 0 12px -2px rgb(var(--glow-c2, 99 102 241) / var(--glow-halo-alpha, 0.44)), inset 0 0 8px -4px rgb(var(--glow-c1, 56 189 248) / var(--glow-halo-alpha, 0.44))',
      };
    case 'soft-paper':
      return {
        background: themeColors.isLight
          ? `linear-gradient(145deg, #fffdf8, #ebe4d5)`
          : `linear-gradient(145deg, #2d2a26, #1f1d1a)`,
        border: `1px solid ${themeColors.isLight ? 'rgba(180,164,136,0.55)' : 'rgba(214,199,174,0.22)'}`,
        boxShadow: themeColors.isLight
          ? '-2px -2px 5px rgba(255,255,255,0.92), 2px 3px 6px rgba(120,104,80,0.28)'
          : '-2px -2px 5px rgba(255,244,226,0.08), 3px 3px 7px rgba(0,0,0,0.65)',
      };
    case 'solid':
    default:
      return {
        background: themeColors.bg,
        border: `1px solid ${themeColors.border}`,
      };
  }
};

const toHex = (channels: string) => `#${channels.split(' ').map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;

/** Accent colours one tap away (the colour input stays for anything else) */
const ACCENTS = ['#6366f1', '#3b8cf6', '#0ea5e9', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7'];

const centerOf = (e: React.MouseEvent) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

/** Theme presets plus a custom theme (base, tint, accent) and surface style. `compact` is the top-bar dropdown. */
export const ThemePicker: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const {
    t, themeId, setThemeId, customTheme, setCustomTheme,
    surfaceStyle, setSurfaceStyle, luminaGlowSettings, setLuminaGlowSettings,
  } = useI18n();
  const ids: ThemeId[] = [...THEME_PRESETS.map((p) => p.id), 'custom'];
  const [anim, setAnim] = useState<ThemeAnim>(loadThemeAnim);
  const [bounce, setBounce] = useState<ThemeId | null>(null);
  const [surfaceBounce, setSurfaceBounce] = useState<SurfaceStyle | null>(null);
  const [glowDraft, setGlowDraft] = useState<LuminaGlowSettings>(luminaGlowSettings);
  const glowDraftRef = useRef(glowDraft);
  const glowFrame = useRef(0);
  const glowCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!glowCommitTimer.current) {
      glowDraftRef.current = luminaGlowSettings;
      setGlowDraft(luminaGlowSettings);
    }
  }, [luminaGlowSettings]);
  useEffect(() => () => {
    cancelAnimationFrame(glowFrame.current);
    if (glowCommitTimer.current) {
      clearTimeout(glowCommitTimer.current);
      setLuminaGlowSettings(glowDraftRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateGlow = (patch: Partial<LuminaGlowSettings>, immediate = false) => {
    const next = { ...glowDraftRef.current, ...patch };
    glowDraftRef.current = next;
    setGlowDraft(next);
    if (immediate) {
      if (glowCommitTimer.current) {
        clearTimeout(glowCommitTimer.current);
        glowCommitTimer.current = null;
      }
      applyLuminaGlowSettings(next);
      setLuminaGlowSettings(next);
      return;
    }
    cancelAnimationFrame(glowFrame.current);
    glowFrame.current = requestAnimationFrame(() => applyLuminaGlowSettings(glowDraftRef.current));
    if (glowCommitTimer.current) clearTimeout(glowCommitTimer.current);
    glowCommitTimer.current = setTimeout(() => {
      glowCommitTimer.current = null;
      setLuminaGlowSettings(glowDraftRef.current);
    }, 140);
  };

  // The custom colours being dragged: shown at once through the CSS variables (one rAF per frame),
  // written to the app state (and storage) only once the drag pauses, so the app does not re-render
  // on every pointer move of the colour picker
  const [draft, setDraft] = useState<CustomThemeSettings>(customTheme);
  const draftRef = useRef(draft);
  const frame = useRef(0);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!commitTimer.current) setDraft(customTheme);
  }, [customTheme]);
  useEffect(() => () => {
    cancelAnimationFrame(frame.current);
    if (commitTimer.current) {
      clearTimeout(commitTimer.current);
      setCustomTheme(draftRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (patch: Partial<CustomThemeSettings>) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => applyTheme('custom', draftRef.current));
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      commitTimer.current = null;
      setCustomTheme(draftRef.current);
    }, 200);
  };

  /** Switch with the chosen animation (and a little jelly on the card that was tapped) */
  const switchTo = (apply: () => void, e: React.MouseEvent, id?: ThemeId, surface?: SurfaceStyle) => {
    if (id) {
      setBounce(null);
      requestAnimationFrame(() => setBounce(id));
    }
    if (surface) {
      setSurfaceBounce(null);
      requestAnimationFrame(() => setSurfaceBounce(surface));
    }
    runThemeTransition(apply, centerOf(e), anim);
  };

  const activeColors = swatchFor(themeId, draft);
  const { vars } = resolveTheme('custom', draft);
  const textContrast = contrastRatio(toHex(vars['--n-200']), toHex(vars['--n-900']));
  const accentContrast = contrastRatio(toHex(vars['--a-300']), toHex(vars['--n-900']));
  const readable = textContrast >= 4.5 && accentContrast >= 3;

  return (
    <div className="flex flex-col gap-3">
      <div className={`grid gap-2 ${compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'}`} role="radiogroup" aria-label={t.settings.themeAria}>
        {ids.map((id) => {
          const s = swatchFor(id, draft);
          const active = themeId === id;
          return (
            <button key={id} type="button" role="radio" aria-checked={active}
              onClick={(e) => { if (!active) switchTo(() => (id === 'custom' ? setCustomTheme(draftRef.current) : setThemeId(id)), e, id); }}
              onAnimationEnd={() => setBounce(null)}
              className={`group flex flex-col items-stretch overflow-hidden rounded-lg border text-left transition ${bounce === id ? 'animate-jelly' : ''} ${active ? 'border-indigo-500 ring-2 ring-indigo-500/40' : 'border-neutral-700 hover:border-neutral-500'}`}>
              <div className="flex h-10 w-full items-stretch" style={{ background: s.bg }}>
                <div className="w-1/3" style={{ background: s.panel }} />
                <div className="flex flex-1 flex-col justify-center gap-1 px-2">
                  <div className="h-1.5 w-3/4 rounded" style={{ background: s.text }} />
                  <div className="h-1.5 w-1/2 rounded" style={{ background: s.accent }} />
                </div>
              </div>
              <div className="flex w-full items-center justify-between bg-neutral-900 px-2 py-1 text-[11px] font-medium text-neutral-200">
                <span>{String(t.settings[THEME_LABEL_KEYS[id]])}</span>
                {active && <Check className="h-3.5 w-3.5 text-indigo-400" />}
              </div>
            </button>
          );
        })}
      </div>

      {themeId === 'custom' && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-neutral-700 bg-neutral-950/50 p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-neutral-300">{t.settings.themeBaseLabel}</span>
            <div className="flex shrink-0 rounded-md border border-neutral-700 p-0.5">
              {(['dark', 'gray', 'light'] as ThemeBase[]).map((b) => (
                <button key={b} type="button" aria-pressed={draft.base === b}
                  onClick={(e) => { if (draft.base !== b) switchTo(() => { const next = { ...draftRef.current, base: b }; draftRef.current = next; setDraft(next); setCustomTheme(next); }, e); }}
                  className={`rounded px-2 py-0.5 text-[11px] ${draft.base === b ? 'bg-indigo-600 text-white' : 'text-neutral-300 hover:bg-neutral-800'}`}>
                  {b === 'dark' ? t.settings.themeBaseDark : b === 'gray' ? t.settings.themeBaseGray : t.settings.themeBaseLight}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center justify-between gap-2">
            <span className="text-neutral-300">{t.settings.themeTintLabel}</span>
            <span className="flex items-center gap-2">
              <input type="range" min={0} max={40} value={Math.round(draft.tintStrength * 100)} aria-label={t.settings.themeTintStrengthAria}
                onChange={(e) => update({ tintStrength: Number(e.target.value) / 100 })} className="w-24" />
              <input type="color" value={draft.tint} aria-label={t.settings.themeTintColorAria} onChange={(e) => update({ tint: e.target.value })}
                className="h-7 w-9 cursor-pointer rounded border border-neutral-700 bg-transparent" />
            </span>
          </label>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-neutral-300">{t.settings.themeAccentLabel}</span>
              <input type="color" value={draft.accent} aria-label={t.settings.themeAccentLabel} onChange={(e) => update({ accent: e.target.value })}
                className="h-7 w-9 cursor-pointer rounded border border-neutral-700 bg-transparent" />
            </div>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t.settings.themeAccentPresetsAria}>
              {ACCENTS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={draft.accent.toLowerCase() === c} aria-label={c}
                  onClick={(e) => switchTo(() => { const next = { ...draftRef.current, accent: c }; draftRef.current = next; setDraft(next); setCustomTheme(next); }, e)}
                  className={`h-5 w-5 rounded-full border-2 transition hover:scale-110 ${draft.accent.toLowerCase() === c ? 'border-white' : 'border-transparent'}`}
                  style={{ background: c }} />
              ))}
            </div>
          </div>
          {!readable && <p className="text-[11px] text-amber-300">{t.settings.themeLowContrastWarn}</p>}
        </div>
      )}

      {/* Surface style branch (6 UI material presets that pair with any theme) */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-neutral-300">{t.settings.surfaceStyle}</span>
        </div>
        <div className={`grid ${compact ? 'grid-cols-2 gap-1.5' : 'grid-cols-2 gap-2 sm:grid-cols-3'}`} role="radiogroup" aria-label={t.settings.surfaceStyle}>
          {SURFACE_STYLES.map((s) => {
            const active = surfaceStyle === s.id;
            const label = String(t.settings[SURFACE_LABEL_KEYS[s.id]] || s.fallbackLabel);
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={active}
                data-surface-option={s.id}
                onClick={(e) => { if (!active) switchTo(() => setSurfaceStyle(s.id), e, undefined, s.id); }}
                onAnimationEnd={() => setSurfaceBounce(null)}
                className={`group flex flex-col items-stretch overflow-hidden rounded-lg border text-left transition ${surfaceBounce === s.id ? 'animate-jelly' : ''} ${
                  active ? 'border-indigo-500 ring-2 ring-indigo-500/40' : 'border-neutral-700 hover:border-neutral-500'
                }`}
              >
                <div
                  className="relative flex h-8 w-full items-center justify-center overflow-hidden px-1.5"
                  style={{
                    background: s.id === 'chromatic-glass'
                      ? `radial-gradient(circle at 20% 25%, rgba(255,94,168,0.45), transparent 52%), radial-gradient(circle at 82% 75%, rgba(94,234,212,0.45), transparent 55%), ${activeColors.bgDeep}`
                      : s.id === 'liquid-glass' || s.id === 'frosted-matte'
                      ? `radial-gradient(circle at 20% 30%, ${activeColors.accentGlow}, transparent 60%), ${activeColors.bgDeep}`
                      : activeColors.bgDeep,
                  }}
                >
                  <div
                    className="flex h-5 w-full items-center justify-between rounded px-1.5"
                    style={surfacePreviewStyle(s.id, activeColors)}
                  >
                    <span className="h-1 w-5 rounded-full" style={{ background: activeColors.text }} />
                    <span className="h-1.5 w-2 rounded-full" style={{ background: activeColors.accent }} />
                  </div>
                </div>
                <div className="flex w-full items-center justify-between gap-1 bg-neutral-900/90 px-2 py-1 text-[11px] font-medium text-neutral-200">
                  <span className="truncate">{label}</span>
                  {active && <Check className="h-3.5 w-3.5 shrink-0 text-indigo-400" />}
                </div>
              </button>
            );
          })}
        </div>
        {surfaceStyle === 'lumina-glow' && (
          <div className="mt-1 flex flex-col gap-2 rounded-lg border border-neutral-700 bg-neutral-950/50 p-2.5 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-neutral-300">{t.settings.luminaGlowModeLabel}</span>
              <div className="flex shrink-0 rounded-md border border-neutral-700 p-0.5" role="radiogroup" aria-label={t.settings.luminaGlowModeLabel}>
                {([
                  ['rainbow', t.settings.luminaGlowModeRainbow],
                  ['mono', t.settings.luminaGlowModeMono],
                  ['dual', t.settings.luminaGlowModeDual],
                ] as Array<[LuminaGlowMode, string]>).map(([mode, modeLabel]) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={glowDraft.mode === mode}
                    data-glow-mode-option={mode}
                    onClick={() => updateGlow({ mode }, true)}
                    className={`rounded px-2 py-0.5 text-[11px] transition ${
                      glowDraft.mode === mode ? 'bg-indigo-600 text-white' : 'text-neutral-300 hover:bg-neutral-800'
                    }`}
                  >
                    {modeLabel}
                  </button>
                ))}
              </div>
            </div>
            {(glowDraft.mode === 'mono' || glowDraft.mode === 'dual') && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-[11px] text-neutral-300">
                  <span>{glowDraft.mode === 'dual' ? t.settings.luminaGlowPrimaryColor : t.settings.luminaGlowSingleColor}</span>
                  <input
                    type="color"
                    value={glowDraft.primaryColor}
                    aria-label={t.settings.luminaGlowPrimaryColor}
                    onChange={(e) => updateGlow({ primaryColor: e.target.value })}
                    className="h-6 w-8 cursor-pointer rounded border border-neutral-700 bg-transparent"
                  />
                </label>
                {glowDraft.mode === 'dual' && (
                  <label className="flex items-center gap-2 text-[11px] text-neutral-300">
                    <span>{t.settings.luminaGlowSecondaryColor}</span>
                    <input
                      type="color"
                      value={glowDraft.secondaryColor}
                      aria-label={t.settings.luminaGlowSecondaryColor}
                      onChange={(e) => updateGlow({ secondaryColor: e.target.value })}
                      className="h-6 w-8 cursor-pointer rounded border border-neutral-700 bg-transparent"
                    />
                  </label>
                )}
              </div>
            )}
            <label className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-neutral-300">{t.settings.luminaGlowSaturation}</span>
              <span className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={glowDraft.saturation}
                  aria-label={t.settings.luminaGlowSaturation}
                  onChange={(e) => updateGlow({ saturation: Number(e.target.value) })}
                  className="w-28"
                />
                <span className="w-8 text-right font-mono tabular-nums text-neutral-200">{glowDraft.saturation}%</span>
              </span>
            </label>
          </div>
        )}
        {!compact && <p className="text-[11px] text-neutral-400">{t.settings.surfaceStyleDesc}</p>}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-neutral-400">{t.settings.themeTransitionLabel}</span>
        <div className="flex shrink-0 rounded-md border border-neutral-700 p-0.5" role="radiogroup" aria-label={t.settings.themeTransitionLabel}>
          {THEME_ANIMS.map((a) => (
            <button key={a.id} type="button" role="radio" aria-checked={anim === a.id}
              onClick={() => { setAnim(a.id); saveThemeAnim(a.id); }}
              className={`rounded px-2 py-0.5 text-[11px] ${anim === a.id ? 'bg-indigo-600 text-white' : 'text-neutral-300 hover:bg-neutral-800'}`}>
              {String(t.settings[THEME_ANIM_KEYS[a.id]])}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
