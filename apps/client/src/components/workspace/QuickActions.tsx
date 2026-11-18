import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Pencil } from 'lucide-react';
import { ShortcutItem, ShortcutManager } from '../../engine/ShortcutManager';
import { useAnchoredPopover } from '../../utils/popoverPosition';

/**
 * CSP-style customisable command bar (指令列) and shortcut panel (快捷鍵面板, like CSP's edge
 * keyboard). A button runs its action by sending the action's current key combo to the same
 * keyboard handler the keyboard uses, so every shortcut action works here and follows any
 * re-binding. Which actions appear is this viewer's choice (localStorage).
 */
const KEY_CHARS: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/', Equal: '=', Minus: '-', Backquote: '`', Semicolon: ';', Quote: "'", Backslash: '\\', Space: ' ',
};

export function runShortcutAction(id: string) {
  const combo = ShortcutManager.getInstance().getComboForAction(id);
  if (!combo) return;
  const parts = combo.split('+');
  const code = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const key = code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : KEY_CHARS[code] ?? code;
  const init = { bubbles: true, cancelable: true, code, key: mods.has('Shift') && key.length === 1 ? key.toUpperCase() : key, ctrlKey: mods.has('Control'), shiftKey: mods.has('Shift'), altKey: mods.has('Alt'), metaKey: mods.has('Meta') };
  // From the page body, as a key press would be (the handlers ignore keys typed into fields)
  (document.activeElement as HTMLElement | null)?.blur?.();
  document.body.dispatchEvent(new KeyboardEvent('keydown', init));
  document.body.dispatchEvent(new KeyboardEvent('keyup', init));
}

/** The short name ("復原" of "復原 (Undo)") */
export const actionLabel = (s: ShortcutItem) => s.name.split(/\s*[（(]/)[0];

function useActionList(storageKey: string, defaults: string[]) {
  const [ids, setIds] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      return Array.isArray(saved) ? saved.filter((x) => typeof x === 'string') : defaults;
    } catch {
      return defaults;
    }
  });
  const save = (next: string[]) => {
    setIds(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // kept for this session
    }
  };
  return [ids, save] as const;
}

const CATEGORY_LABELS: Record<string, string> = { toolbox: '工具', layers: '圖層', filters: '濾鏡', studio: '工作室', actions: '動作', navigation: '視角', voice: '語音' };

/** Pick which actions show (a checklist of every shortcut action, by category) */
const ActionPicker: React.FC<{ ids: string[]; onChange: (ids: string[]) => void; exclude?: Set<string> }> = ({ ids, onChange, exclude }) => {
  const all = ShortcutManager.getInstance().getShortcuts().filter((s) => !exclude?.has(s.id));
  const cats = [...new Set(all.map((s) => s.category))];
  return (
    <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
      {cats.map((c) => (
        <div key={c}>
          <div className="mb-1 text-[10px] font-bold text-neutral-500">{CATEGORY_LABELS[c] ?? c}</div>
          <div className="flex flex-wrap gap-1">
            {all.filter((s) => s.category === c).map((s) => {
              const on = ids.includes(s.id);
              return (
                <button key={s.id} type="button" aria-pressed={on} onClick={() => onChange(on ? ids.filter((x) => x !== s.id) : [...ids, s.id])}
                  title={s.description}
                  className={`rounded-md border px-1.5 py-0.5 text-[11px] ${on ? 'border-indigo-400 bg-indigo-600/30 text-white' : 'border-neutral-700 text-neutral-400 hover:bg-neutral-800'}`}>
                  {actionLabel(s)}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

const byId = () => new Map(ShortcutManager.getInstance().getShortcuts().map((s) => [s.id, s]));

export const COMMAND_BAR_DEFAULTS = ['action_layer_new_raster', 'action_layer_merge_down', 'action_view_flip', 'action_reset_view'];
/** Always at the left of the options bar, so never repeated in the command bar (old saved bars included) */
const FIXED_IN_OPTIONS_BAR = new Set(['action_undo', 'action_redo']);
export const QUICK_KEY_DEFAULTS = [
  'tool_brush', 'tool_eraser', 'tool_eyedropper', 'tool_lasso', 'action_undo', 'action_redo', 'action_selection_invert', 'action_clear_selection',
  'action_brush_smaller', 'action_brush_larger', 'action_view_rotate_left', 'action_view_rotate_right', 'action_anim_prev_frame', 'action_anim_next_frame',
];

/** 指令列: a slim row of the chosen actions (top of the workspace) */
export const CommandBar: React.FC<{ wrap?: boolean }> = ({ wrap = false }) => {
  const [ids, setIds] = useActionList('atelier_command_bar', COMMAND_BAR_DEFAULTS);
  const [editing, setEditing] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPopover(editing, btnRef, popRef, { align: 'right', gap: 6, margin: 8, fallbackWidth: 288 });
  const items = byId();
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setEditing(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditing(false); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [editing]);
  return (
    <div className={`relative flex items-center gap-0.5 ${wrap ? 'flex-wrap' : 'shrink-0'}`} role="toolbar" aria-label="指令列">
      {ids.filter((id) => !FIXED_IN_OPTIONS_BAR.has(id)).map((id) => items.get(id)).filter((s): s is ShortcutItem => Boolean(s)).map((s) => (
        <button key={s.id} type="button" onClick={() => runShortcutAction(s.id)} title={`${s.name}（${ShortcutManager.getInstance().getDisplayLabel(s.currentCombo) || '未設定'}）`}
          className="h-7 shrink-0 rounded px-1.5 text-[11px] text-neutral-300 hover:bg-neutral-800 hover:text-white">
          {actionLabel(s)}
        </button>
      ))}
      <button ref={btnRef} type="button" onClick={() => setEditing(!editing)} aria-pressed={editing} aria-label="自訂指令列" title="自訂指令列：選要放哪些按鈕"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-white">
        {editing ? <Check className="h-3.5 w-3.5" /> : <Pencil className="h-3 w-3" />}
      </button>
      {editing && typeof document !== 'undefined' && createPortal(
        <div ref={pos.setPopoverEl} style={{ top: pos.top, left: pos.left, maxHeight: pos.maxHeight }}
          className="atelier-popover atelier-menu-in fixed z-[95] w-72 max-w-[calc(100vw-16px)] overflow-y-auto p-3" role="dialog" aria-label="自訂指令列">
          <div className="mb-2 flex items-center justify-between text-xs font-bold text-white">
            <span>指令列要放的按鈕</span>
            <button type="button" onClick={() => setIds(COMMAND_BAR_DEFAULTS)} className="text-[10px] font-normal text-neutral-400 hover:text-white">恢復預設</button>
          </div>
          <ActionPicker ids={ids} onChange={setIds} exclude={FIXED_IN_OPTIONS_BAR} />
          <button type="button" onClick={() => setEditing(false)} className="mt-2 w-full rounded-lg bg-indigo-600 py-1.5 text-xs font-bold text-white hover:bg-indigo-500">完成</button>
        </div>,
        document.body
      )}
    </div>
  );
};

/** 快捷鍵面板: big buttons for touch screens and one-handed use (a dock panel) */
export const QuickKeysPanel: React.FC = () => {
  const [ids, setIds] = useActionList('atelier_quick_keys', QUICK_KEY_DEFAULTS);
  const [editing, setEditing] = useState(false);
  const items = byId();
  const mgr = ShortcutManager.getInstance();
  return (
    <div className="flex h-full flex-col gap-2 p-2 text-xs">
      {editing ? (
        <>
          <ActionPicker ids={ids} onChange={setIds} />
          <div className="flex gap-1">
            <button type="button" onClick={() => setIds(QUICK_KEY_DEFAULTS)} className="flex-1 rounded-lg border border-neutral-700 py-1.5 text-neutral-300 hover:bg-neutral-800">恢復預設</button>
            <button type="button" onClick={() => setEditing(false)} className="flex-1 rounded-lg bg-indigo-600 py-1.5 font-bold text-white hover:bg-indigo-500">完成</button>
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-1.5">
            {ids.map((id) => items.get(id)).filter((s): s is ShortcutItem => Boolean(s)).map((s) => (
              <button key={s.id} type="button" onClick={() => runShortcutAction(s.id)} title={s.description}
                className="flex min-h-12 flex-col items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800/70 px-1 py-1.5 text-center text-[11px] leading-tight text-neutral-100 hover:bg-neutral-700 active:bg-indigo-600">
                <span>{actionLabel(s)}</span>
                <span className="mt-0.5 font-mono text-[9px] text-neutral-500">{mgr.getDisplayLabel(s.currentCombo)}</span>
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setEditing(true)} className="flex items-center justify-center gap-1 rounded-lg border border-dashed border-neutral-700 py-1.5 text-neutral-400 hover:text-white">
            <Pencil className="h-3 w-3" />自訂按鈕
          </button>
        </>
      )}
    </div>
  );
};
