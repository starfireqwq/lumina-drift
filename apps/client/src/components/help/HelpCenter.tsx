import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen, Brush, Film, FolderDown, Hand, Keyboard, Layers, LayoutPanelLeft, Move, PaintBucket, PenTool, Search, Sparkles, Type, Users, X,
} from 'lucide-react';
import { ShortcutCategory, ShortcutManager } from '../../engine/ShortcutManager';
import { useI18n } from '../../context/I18nContext';
import { HelpArt } from './HelpArt';
import { getHelpTopics, HELP_CATEGORIES, HelpCategoryId, HelpKey, HelpTopic, normalize, queryTerms, scoreTopic, SUGGESTIONS } from './helpContent';

const CAT_ICON: Record<HelpCategoryId, React.ReactNode> = {
  start: <Sparkles />, draw: <Brush />, fill: <PaintBucket />, select: <Move />, layers: <Layers />, vector: <PenTool />,
  text: <Type />, anim: <Film />, collab: <Users />, touch: <Hand />, ui: <LayoutPanelLeft />, files: <FolderDown />, keys: <Keyboard />,
};

const SHORTCUT_GROUPS: Array<{ id: ShortcutCategory; label: string }> = [
  { id: 'toolbox', label: '工具' },
  { id: 'actions', label: '編輯' },
  { id: 'layers', label: '圖層' },
  { id: 'filters', label: '濾鏡與變形' },
  { id: 'studio', label: '輔助與工作室' },
  { id: 'navigation', label: '畫面' },
  { id: 'voice', label: '語音' },
];

/** Shortcut names carry an English gloss in parentheses; the help centre shows only the Chinese part */
const shortName = (name: string) => name.replace(/\s*[（(][^()（）]*[)）]\s*$/, '').trim() || name;

const CAT_KEY = 'atelier_help_cat';
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.5.0';

/** Wraps every match of the search terms in <mark> */
const Highlight: React.FC<{ text: string; terms: string[] }> = ({ text, terms }) => {
  if (!terms.length) return <>{text}</>;
  const lower = text.normalize('NFKC').toLowerCase();
  const marks: Array<[number, number]> = [];
  for (const t of terms) {
    if (!t) continue;
    let i = lower.indexOf(t);
    while (i >= 0) {
      marks.push([i, i + t.length]);
      i = lower.indexOf(t, i + t.length);
    }
  }
  if (!marks.length) return <>{text}</>;
  marks.sort((a, b) => a[0] - b[0]);
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const [s, e] of marks) {
    if (s < at) continue;
    if (s > at) out.push(text.slice(at, s));
    out.push(<mark key={s} className="atelier-help-mark">{text.slice(s, e)}</mark>);
    at = e;
  }
  out.push(text.slice(at));
  return <>{out}</>;
};

const useShortcutVersion = () => {
  const mgr = ShortcutManager.getInstance();
  const [, setV] = useState(0);
  useEffect(() => mgr.subscribe(() => setV((v) => v + 1)), [mgr]);
  return mgr;
};

const KeyChip: React.FC<{ k: HelpKey; terms: string[] }> = ({ k, terms }) => {
  const mgr = ShortcutManager.getInstance();
  const key = k.fixed ?? (k.action ? mgr.getDisplayLabel(mgr.getComboForAction(k.action)) : '');
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-950/50 py-0.5 pl-0.5 pr-2 text-[11px] text-neutral-300">
      <kbd className="atelier-kbd !text-[11px] !text-neutral-100">{key || '未設定'}</kbd>
      <Highlight text={k.label} terms={terms} />
    </span>
  );
};

const TopicCard: React.FC<{ topic: HelpTopic; terms: string[]; categoryLabel?: string }> = ({ topic, terms, categoryLabel }) => (
  <article id={`help-${topic.id}`} className="flex gap-4 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 transition hover:border-neutral-700">
    <div className="min-w-0 flex-1 space-y-2">
      {categoryLabel && (
        <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
          {categoryLabel}
        </div>
      )}
      <h4 className="text-[13px] font-semibold text-neutral-50"><Highlight text={topic.title} terms={terms} /></h4>
      <p className="text-xs leading-relaxed text-neutral-300"><Highlight text={topic.summary} terms={terms} /></p>
      {topic.steps && (
        <ul className="space-y-1 text-[11px] leading-relaxed text-neutral-400">
          {topic.steps.map((s) => (
            <li key={s} className="flex gap-2"><span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-indigo-400" /><span><Highlight text={s} terms={terms} /></span></li>
          ))}
        </ul>
      )}
      {topic.keys && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {topic.keys.map((k) => <KeyChip key={k.label} k={k} terms={terms} />)}
        </div>
      )}
    </div>
    {topic.art && <HelpArt id={topic.art} className="hidden h-[104px] w-[160px] shrink-0 self-center sm:block" />}
  </article>
);

/**
 * 說明 (help centre): categories on the left, short topics on the right, and one search box that
 * looks through topics, keywords (synonyms, English) and every keyboard shortcut at once.
 */
export const HelpCenter: React.FC<{ onClose: () => void; onOpenShortcutSettings?: () => void; initialQuery?: string }> = ({ onClose, onOpenShortcutSettings, initialQuery = '' }) => {
  const { t } = useI18n();
  const helpTopics = useMemo(() => getHelpTopics(t), [t]);
  const categories = HELP_CATEGORIES;
  const mgr = useShortcutVersion();
  const [query, setQuery] = useState(initialQuery);
  const [cat, setCat] = useState<HelpCategoryId>(() => {
    try {
      const saved = localStorage.getItem(CAT_KEY) as HelpCategoryId | null;
      if (saved && HELP_CATEGORIES.some((c) => c.id === saved)) return saved;
    } catch { /* ignore */ }
    return 'start';
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const pickCategory = (id: HelpCategoryId) => {
    setCat(id);
    setQuery('');
    try { localStorage.setItem(CAT_KEY, id); } catch { /* ignore */ }
    bodyRef.current?.scrollTo({ top: 0 });
  };

  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)').matches) inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (inputRef.current && inputRef.current.value) setQuery('');
        else onCloseRef.current();
      } else if (e.key === '/' && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shortcuts = mgr.getShortcuts();
  const keyText = (t: HelpTopic) => (t.keys ?? []).map((k) => `${k.label} ${k.fixed ?? (k.action ? mgr.getDisplayLabel(mgr.getComboForAction(k.action)) : '')}`).join(' ');
  const terms = queryTerms(query);

  const results = useMemo(() => {
    if (!terms.length) return null;
    const topics = helpTopics
      .map((t) => ({ t, score: scoreTopic(t, terms, keyText(t)) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.t);
    const keys = shortcuts.filter((s) => {
      const hay = normalize(`${s.name} ${s.description} ${mgr.getDisplayLabel(s.currentCombo)}`);
      return terms.every((t) => hay.includes(normalize(t)));
    });
    return { topics, keys };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, shortcuts, helpTopics]);

  const countIn = (id: HelpCategoryId) => (results
    ? (id === 'keys' ? results.keys.length : results.topics.filter((t) => t.category === id).length)
    : (id === 'keys' ? shortcuts.length : helpTopics.filter((t) => t.category === id).length));

  const shortcutTable = (list: typeof shortcuts, grouped: boolean) => (
    <div className="space-y-4">
      {(grouped ? SHORTCUT_GROUPS : [{ id: 'all' as const, label: '' }]).map((g) => {
        const rows = grouped ? list.filter((s) => s.category === g.id) : list;
        if (!rows.length) return null;
        return (
          <section key={g.id}>
            {g.label && <h5 className="mb-1.5 text-[11px] font-semibold text-neutral-400">{g.label}</h5>}
            <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
              {rows.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-3 border-b border-neutral-800/70 py-1.5 text-xs">
                  <span className="min-w-0 truncate text-neutral-200" title={s.description}><Highlight text={shortName(s.name)} terms={terms} /></span>
                  <kbd className="atelier-kbd shrink-0 !text-[11px] !text-neutral-100">{mgr.getDisplayLabel(s.currentCombo) || '未設定'}</kbd>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );

  const catLabel = categories.find((c) => c.id === cat)?.label;

  return (
    <div className="atelier-modal-backdrop fixed inset-0 z-[70] flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="說明"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="atelier-modal atelier-menu-in flex h-[calc(100dvh-0.5rem)] w-full flex-col overflow-hidden rounded-b-none sm:h-[min(720px,calc(100dvh-2rem))] sm:max-w-[980px] sm:rounded-b-[14px]">
        {/* Header: title + the one search box */}
        <div className="flex shrink-0 items-center gap-3 border-b border-neutral-800 px-4 py-3">
          <div className="flex shrink-0 items-center gap-2 text-sm font-semibold text-white">
            <BookOpen className="h-4 w-4 text-indigo-400" />
            <span className="hidden sm:inline">{t.help.centerTitle}</span>
            <span
              data-testid="app-version-badge"
              title={`${t.help.about} · ${t.help.version} v${APP_VERSION}`}
              className="rounded-md border border-neutral-800 bg-neutral-900/80 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-neutral-400"
            >
              v{APP_VERSION}
            </span>
          </div>
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input ref={inputRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="搜尋功能、手勢或快捷鍵，例如「復原」「透視」「Ctrl+Z」"
              aria-label="搜尋說明"
              className="atelier-field h-9 w-full pl-9 pr-10 text-[13px] placeholder:text-neutral-500" />
            {!query && <kbd className="atelier-kbd pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 sm:inline">/</kbd>}
          </label>
          <button type="button" onClick={onClose} aria-label="關閉" className="atelier-icon-btn h-8 w-8 shrink-0"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {/* Categories: a column on desktop, a scrolling strip on phones */}
          <nav aria-label="分類" className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-neutral-800 p-2 sm:w-52 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r">
            {categories.map((c) => {
              const n = countIn(c.id);
              const current = !results && cat === c.id;
              return (
                <button key={c.id} type="button" onClick={() => pickCategory(c.id)} aria-current={current ? 'page' : undefined}
                  disabled={!!results && n === 0}
                  className={`flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs transition disabled:opacity-35 ${current ? 'bg-indigo-600/15 text-white' : 'text-neutral-300 hover:bg-neutral-800 hover:text-white'}`}>
                  <span className={`[&>svg]:h-3.5 [&>svg]:w-3.5 ${current ? 'text-indigo-300' : 'text-neutral-500'}`}>{CAT_ICON[c.id]}</span>
                  <span className="flex-1 whitespace-nowrap">{c.label}</span>
                  <span className={`hidden text-[10px] tabular-nums sm:inline ${results && n ? 'text-indigo-300' : 'text-neutral-600'}`}>{n}</span>
                </button>
              );
            })}
            <div className="mt-auto hidden space-y-1 px-2.5 pt-3 text-[10px] text-neutral-500 sm:block">
              <div>{t.help.version} <span className="font-mono text-neutral-300">v{APP_VERSION}</span></div>
              <div className="text-neutral-600">隨時按 <kbd className="atelier-kbd">F1</kbd> 開啟</div>
            </div>
          </nav>

          <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-5">
            {results ? (
              results.topics.length + results.keys.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-16 text-center">
                  <Search className="h-8 w-8 text-neutral-600" />
                  <p className="text-sm text-neutral-300">找不到「{query.trim()}」</p>
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {SUGGESTIONS.map((s) => (
                      <button key={s} type="button" onClick={() => setQuery(s)} className="atelier-btn !h-7 text-xs">{s}</button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  {results.topics.length > 0 && (
                    <section className="space-y-3">
                      <h3 className="text-[11px] font-semibold text-neutral-400">說明 · {results.topics.length}</h3>
                      {results.topics.map((t) => <TopicCard key={t.id} topic={t} terms={terms}
                        categoryLabel={categories.find((c) => c.id === t.category)?.label} />)}
                    </section>
                  )}
                  {results.keys.length > 0 && (
                    <section className="space-y-2">
                      <h3 className="text-[11px] font-semibold text-neutral-400">快捷鍵 · {results.keys.length}</h3>
                      {shortcutTable(results.keys, false)}
                    </section>
                  )}
                </div>
              )
            ) : cat === 'keys' ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-white">全部快捷鍵</h3>
                  {onOpenShortcutSettings && (
                    <button type="button" onClick={onOpenShortcutSettings} className="atelier-btn !h-7 text-xs"><Keyboard />自訂</button>
                  )}
                </div>
                {shortcutTable(shortcuts, true)}
              </div>
            ) : (
              <div className="space-y-3">
                <h3 className="pb-1 text-base font-semibold text-white">{catLabel}</h3>
                {helpTopics.filter((t) => t.category === cat).map((t) => <TopicCard key={t.id} topic={t} terms={[]} />)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
