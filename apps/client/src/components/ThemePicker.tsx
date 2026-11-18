import React, { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { applyTheme, contrastRatio, CustomThemeSettings, resolveTheme, THEME_PRESETS, ThemeBase, ThemeId } from '../theme/themes';
import { loadThemeAnim, runThemeTransition, saveThemeAnim, ThemeAnim, THEME_ANIMS } from '../theme/themeTransition';

const swatchFor = (id: ThemeId, custom: CustomThemeSettings) => {
  const { vars } = resolveTheme(id, custom);
  const rgb = (v: string) => `rgb(${v})`;
  return { bg: rgb(vars['--n-900']), panel: rgb(vars['--n-800']), text: rgb(vars['--n-200']), accent: rgb(vars['--a-500']) };
};

const toHex = (channels: string) => `#${channels.split(' ').map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;

/** Accent colours one tap away (the colour input stays for anything else) */
const ACCENTS = ['#6366f1', '#3b8cf6', '#0ea5e9', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7'];

const centerOf = (e: React.MouseEvent) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

/** Theme presets plus a custom theme (base, tint, accent). `compact` is the top-bar dropdown. */
export const ThemePicker: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const { themeId, setThemeId, customTheme, setCustomTheme } = useI18n();
  const ids: ThemeId[] = [...THEME_PRESETS.map((p) => p.id), 'custom'];
  const labels: Record<ThemeId, string> = Object.fromEntries([...THEME_PRESETS.map((p) => [p.id, p.label]), ['custom', '自訂色調']]) as Record<ThemeId, string>;
  const [anim, setAnim] = useState<ThemeAnim>(loadThemeAnim);
  const [bounce, setBounce] = useState<ThemeId | null>(null);

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
  const switchTo = (apply: () => void, e: React.MouseEvent, id?: ThemeId) => {
    if (id) {
      setBounce(null);
      requestAnimationFrame(() => setBounce(id));
    }
    runThemeTransition(apply, centerOf(e), anim);
  };

  const { vars } = resolveTheme('custom', draft);
  const textContrast = contrastRatio(toHex(vars['--n-200']), toHex(vars['--n-900']));
  const accentContrast = contrastRatio(toHex(vars['--a-300']), toHex(vars['--n-900']));
  const readable = textContrast >= 4.5 && accentContrast >= 3;

  return (
    <div className="flex flex-col gap-3">
      <div className={`grid gap-2 ${compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'}`} role="radiogroup" aria-label="介面主題">
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
                <span>{labels[id]}</span>
                {active && <Check className="h-3.5 w-3.5 text-indigo-400" />}
              </div>
            </button>
          );
        })}
      </div>

      {themeId === 'custom' && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-neutral-700 bg-neutral-950/50 p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-neutral-300">明暗</span>
            <div className="flex shrink-0 rounded-md border border-neutral-700 p-0.5">
              {(['dark', 'gray', 'light'] as ThemeBase[]).map((b) => (
                <button key={b} type="button" aria-pressed={draft.base === b}
                  onClick={(e) => { if (draft.base !== b) switchTo(() => { const next = { ...draftRef.current, base: b }; draftRef.current = next; setDraft(next); setCustomTheme(next); }, e); }}
                  className={`rounded px-2 py-0.5 text-[11px] ${draft.base === b ? 'bg-indigo-600 text-white' : 'text-neutral-300 hover:bg-neutral-800'}`}>
                  {b === 'dark' ? '深' : b === 'gray' ? '灰' : '淺'}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center justify-between gap-2">
            <span className="text-neutral-300">色調</span>
            <span className="flex items-center gap-2">
              <input type="range" min={0} max={40} value={Math.round(draft.tintStrength * 100)} aria-label="色調濃度"
                onChange={(e) => update({ tintStrength: Number(e.target.value) / 100 })} className="w-24" />
              <input type="color" value={draft.tint} aria-label="色調顏色" onChange={(e) => update({ tint: e.target.value })}
                className="h-7 w-9 cursor-pointer rounded border border-neutral-700 bg-transparent" />
            </span>
          </label>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-neutral-300">強調色</span>
              <input type="color" value={draft.accent} aria-label="強調色" onChange={(e) => update({ accent: e.target.value })}
                className="h-7 w-9 cursor-pointer rounded border border-neutral-700 bg-transparent" />
            </div>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="常用強調色">
              {ACCENTS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={draft.accent.toLowerCase() === c} aria-label={c}
                  onClick={(e) => switchTo(() => { const next = { ...draftRef.current, accent: c }; draftRef.current = next; setDraft(next); setCustomTheme(next); }, e)}
                  className={`h-5 w-5 rounded-full border-2 transition hover:scale-110 ${draft.accent.toLowerCase() === c ? 'border-white' : 'border-transparent'}`}
                  style={{ background: c }} />
              ))}
            </div>
          </div>
          {!readable && <p className="text-[11px] text-amber-300">對比偏低，建議調淡色調或換強調色</p>}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-neutral-400">切換動畫</span>
        <div className="flex shrink-0 rounded-md border border-neutral-700 p-0.5" role="radiogroup" aria-label="切換動畫">
          {THEME_ANIMS.map((a) => (
            <button key={a.id} type="button" role="radio" aria-checked={anim === a.id}
              onClick={() => { setAnim(a.id); saveThemeAnim(a.id); }}
              className={`rounded px-2 py-0.5 text-[11px] ${anim === a.id ? 'bg-indigo-600 text-white' : 'text-neutral-300 hover:bg-neutral-800'}`}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
