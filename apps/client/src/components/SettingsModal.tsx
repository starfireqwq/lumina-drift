import React, { useCallback, useRef, useState, useEffect, useSyncExternalStore } from 'react';
import {
  AlertCircle,
  Check,
  Crosshair,
  Globe,
  Hand,
  Keyboard,
  Minus,
  Moon,
  PenTool,
  Plus,
  Puzzle,
  RotateCcw,
  Search,
  Server,
  Sliders,
  Sparkles,
  Sun,
  X,
  ZoomIn,
} from 'lucide-react';
import { setUiScale, UI_SCALE_MAX, UI_SCALE_MIN, useUiScale } from '../theme/uiScale';
import { setMotionMode, useMotionMode, type MotionMode } from '../theme/motion';
import { useI18n, Language } from '../context/I18nContext';
import { ShortcutItem, ShortcutManager } from '../engine/ShortcutManager';
import { ThemePicker } from './ThemePicker';
import { evaluatePressureCurve, type PressureCurveConfig } from '@atelier/shared';
import { DEFAULT_PRESSURE_CURVE, readStylusPressureCurve, saveStylusPressureCurve } from '../engine/stylusPressure';
import {
  getShowBrushCrosshair,
  getTouchSimulatedPressure,
  setShowBrushCrosshair,
  setTouchSimulatedPressure,
  subscribeShowBrushCrosshair,
  subscribeTouchSimulatedPressure,
} from '../engine/inputPreferences';
import {
  getTouchGestureSettings,
  MAX_LONG_PRESS_DELAY_MS,
  MIN_LONG_PRESS_DELAY_MS,
  resetTouchGestureSettings,
  subscribeTouchGestureSettings,
  updateTouchGestureSettings,
  type TouchLongPressAction,
  type TouchSingleFingerMode,
} from '../engine/touchGestures';
import {
  getTabletSnapshot, hasNativeTabletModes, setTabletPreference, startTabletStroke, subscribeTablet, type TabletMotion, type TabletPoint, type TabletStroke,
} from '../engine/tabletInput';
import type { TabletPreference } from '../../electron/tabletProtocol';
import { PressureCurveEditor } from './PressureCurveEditor';
import { ApiService } from '../services/api';
import { AtelierModal, modalButton } from './AtelierModal';
import { dockActions, PANEL_IDS, PANEL_TITLES, useDockLayout } from './workspace/dockStore';

type SettingsTab = 'shortcuts' | 'general' | 'pressure' | 'server';

/**
 * 介面縮放 50–200 %. The slider applies when let go (the interface would otherwise resize under the
 * pointer while dragging); − / ＋ step 5 %, the box takes any whole percent.
 */
const UiScaleControl: React.FC = () => {
  const { t } = useI18n();
  const scale = useUiScale();
  const percent = Math.round(scale * 100);
  const [draft, setDraft] = useState<number | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const commit = (p: number) => {
    setDraft(null);
    if (Number.isFinite(p)) setUiScale(p / 100);
  };
  const shown = draft ?? percent;
  const min = Math.round(UI_SCALE_MIN * 100);
  const max = Math.round(UI_SCALE_MAX * 100);
  return (
    <div className="flex flex-col gap-2.5">
      <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-neutral-300">
        <ZoomIn className="h-3.5 w-3.5 text-indigo-400" />
        {t.settings.uiScale}
      </span>
      <div className="flex items-center gap-2">
        <button type="button" className="atelier-icon-btn h-8 w-8 shrink-0" aria-label={t.settings.scaleDown} title={t.settings.scaleDown}
          disabled={percent <= min} onClick={() => commit(Math.max(min, Math.ceil(percent / 5) * 5 - 5))}>
          <Minus className="h-4 w-4" />
        </button>
        <input type="range" min={min} max={max} step={1} value={shown} aria-label={t.settings.uiScale} className="min-w-0 flex-1"
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onBlur={() => draft !== null && commit(draft)} />
        <button type="button" className="atelier-icon-btn h-8 w-8 shrink-0" aria-label={t.settings.scaleUp} title={t.settings.scaleUp}
          disabled={percent >= max} onClick={() => commit(Math.min(max, Math.floor(percent / 5) * 5 + 5))}>
          <Plus className="h-4 w-4" />
        </button>
        <label className="flex shrink-0 items-center gap-0.5 rounded-md border border-neutral-700 bg-neutral-900 px-1.5 text-xs text-neutral-200">
          <input type="number" min={min} max={max} step={1} inputMode="numeric" aria-label={t.settings.scalePercent}
            className="w-11 bg-transparent py-1 text-right tabular-nums outline-none"
            value={typed ?? String(shown)}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onBlur={() => { if (typed !== null) commit(Math.round(Number(typed))); setTyped(null); }} />
          %
        </label>
        <button type="button" className="atelier-btn shrink-0" disabled={percent === 100} onClick={() => commit(100)}>100%</button>
      </div>
    </div>
  );
};

/** Controls html[data-motion] independently of the OS reduced-motion flag (defaults to 'on'). */
const MotionModeControl: React.FC = () => {
  const { t } = useI18n();
  const motionMode = useMotionMode();
  const options: Array<{ id: MotionMode; label: string }> = [
    { id: 'on', label: t.settings.motionOn },
    { id: 'auto', label: t.settings.motionAuto },
    { id: 'off', label: t.settings.motionOff },
  ];

  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-xs font-bold text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
        <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
        {t.settings.motionTitle}
      </span>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t.settings.motionTitle}>
        {options.map((opt) => {
          const active = motionMode === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={active}
              data-setting="motion-mode"
              data-motion-mode={opt.id}
              onClick={() => setMotionMode(opt.id)}
              className={`flex items-center justify-between gap-1.5 px-3 py-2 rounded-xl border text-xs font-medium transition ${
                active
                  ? 'bg-indigo-600/20 border-indigo-500 text-white'
                  : 'bg-neutral-900/60 border-neutral-800 text-neutral-400 hover:text-white hover:border-neutral-700'
              }`}
            >
              <span className="truncate">{opt.label}</span>
              {active && <Check className="w-3.5 h-3.5 shrink-0 text-indigo-400" />}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-neutral-400">{t.settings.motionDesc}</p>
    </div>
  );
};

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Tab to show when the dialog opens (e.g. 'general' from the theme menu) */
  initialTab?: string;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  initialTab,
}) => {
  const { t, language, setLanguage, theme } = useI18n();
  const dockLayout = useDockLayout();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  useEffect(() => {
    if (isOpen) setActiveTab(initialTab && initialTab !== 'guide' ? (initialTab as SettingsTab) : 'general');
  }, [isOpen, initialTab]);

  // Shortcut Manager State
  const shortcutMgr = ShortcutManager.getInstance();
  const [shortcuts, setShortcuts] = useState<ShortcutItem[]>(() => shortcutMgr.getShortcuts());
  const [shortcutSearch, setShortcutSearch] = useState('');
  const [recordingActionId, setRecordingActionId] = useState<string | null>(null);
  // Keep the candidate visible after release until Enter confirms it.
  const [recordPreview, setRecordPreview] = useState<string>(() => t.settings.pressAnyKey);

  // Stylus Test Area State
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const testStroke = useRef<TabletStroke | null>(null);
  const lastTestPoint = useRef<{ x: number; y: number; radius: number } | null>(null);
  const testMotionFrame = useRef(0);
  const testReleaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [pressureReading, setPressureReading] = useState({ raw: 0, mapped: 0, pointerType: '—' });
  const [pressureCurve, setPressureCurve] = useState(() => readStylusPressureCurve() ?? DEFAULT_PRESSURE_CURVE);
  const updatePressureCurve = useCallback((curve: PressureCurveConfig) => {
    setPressureCurve(curve);
    saveStylusPressureCurve(curve);
  }, []);
  const tablet = useSyncExternalStore(subscribeTablet, getTabletSnapshot);
  const showBrushCrosshair = useSyncExternalStore(subscribeShowBrushCrosshair, getShowBrushCrosshair, getShowBrushCrosshair);
  const touchSimulatedPressure = useSyncExternalStore(subscribeTouchSimulatedPressure, getTouchSimulatedPressure, getTouchSimulatedPressure);
  const touchGestures = useSyncExternalStore(subscribeTouchGestureSettings, getTouchGestureSettings, getTouchGestureSettings);
  const settings = t.settings;
  const modeLabel = { browser: settings.tabletBrowser, ink: settings.tabletInk, wintab: 'WinTab' };
  const driverMessage = {
    disabled: '',
    'bridge-unavailable': settings.tabletBridgeUnavailable,
    'driver-missing': settings.tabletDriverMissing,
    'driver-unavailable': settings.tabletDriverUnavailable,
    'no-pressure-axis': settings.tabletNoAxis,
    'context-failed': settings.tabletContextFailed,
    ready: tablet.mode === 'wintab' ? '' : settings.tabletWaiting,
  }[tablet.driver];

  // Server URL
  const [customServerUrl, setCustomServerUrl] = useState<string>(() => {
    return localStorage.getItem('atelier_server_url') || '';
  });
  const [isUrlSaved, setIsUrlSaved] = useState<boolean>(false);

  useEffect(() => {
    const unsub = shortcutMgr.subscribe(() => {
      setShortcuts(shortcutMgr.getShortcuts());
    });
    return unsub;
  }, []);

  // Key recording listener
  useEffect(() => {
    if (!isOpen || activeTab !== 'shortcuts') {
      setRecordingActionId(null);
      return;
    }
    if (!recordingActionId) return;
    setRecordPreview(t.settings.pressAnyKey);
    let candidate = '';

    const handleRecordKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;

      // Escape cancels recording
      if (e.key === 'Escape') {
        setRecordingActionId(null);
        return;
      }

      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        if (!candidate) return;
        shortcutMgr.setShortcut(recordingActionId, candidate);
        setRecordingActionId(null);
        return;
      }

      const combo = ShortcutManager.eventToCombo(e);
      if (!combo) return;
      if (ShortcutManager.isBrowserReserved(combo)) {
        candidate = '';
        setRecordPreview(`${shortcutMgr.getDisplayLabel(combo)} ${t.settings.shortcutBrowserReservedHint}`);
        return;
      }
      candidate = combo;
      setRecordPreview(shortcutMgr.getDisplayLabel(combo));
    };
    const handleRecordKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };

    window.addEventListener('keydown', handleRecordKey, { capture: true });
    window.addEventListener('keyup', handleRecordKeyUp, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleRecordKey, { capture: true });
      window.removeEventListener('keyup', handleRecordKeyUp, { capture: true });
    };
  }, [recordingActionId, isOpen, activeTab, t.settings.pressAnyKey, t.settings.shortcutBrowserReservedHint]);

  // Setup test canvas
  useEffect(() => {
    if (!isOpen || activeTab !== 'pressure' || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = canvas.parentElement?.clientWidth || 400;
    canvas.height = 160;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = theme === 'dark' ? '#181920' : '#f8fafc';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }, [isOpen, activeTab, theme]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (testReleaseTimer.current !== undefined && testStroke.current) finishTestStroke(testStroke.current.pointerId);
    if (e.button !== 0 || testStroke.current) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* Capture requires a live pointer. */ }
    lastTestPoint.current = null;
    const stroke = startTabletStroke(e.nativeEvent);
    testStroke.current = stroke;
    if (!stroke.awaitingNativeStart) drawTestPressure([stroke.initialPoint], stroke);
    stroke.onMotionAvailable = () => {
      if (testMotionFrame.current) return;
      testMotionFrame.current = requestAnimationFrame(() => {
        testMotionFrame.current = 0;
        if (testStroke.current !== stroke) return;
        const motion = stroke.consumeMotion();
        if (motion) drawTestMotion(motion, stroke);
      });
    };
    if (stroke.hasNativeMotion) stroke.onMotionAvailable();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = testStroke.current;
    if (!stroke || stroke.pointerId !== e.pointerId || testReleaseTimer.current !== undefined) return;
    drawTestMotion(stroke.contactPoints(e.nativeEvent), stroke);
  };

  const drawTestMotion = ({ runs, lifted }: TabletMotion, stroke: TabletStroke) => {
    if (!lastTestPoint.current && !stroke.hasNativeMotion && (lifted || runs.some(points => points.length))) {
      drawTestPressure([stroke.initialPoint], stroke);
    }
    runs.forEach((points, index) => {
      if (index > 0) lastTestPoint.current = null;
      drawTestPressure(points, stroke);
    });
    if (lifted) finishTestStroke(stroke.pointerId);
  };

  const drawTestPressure = (points: TabletPoint[], stroke: TabletStroke) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || points.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    let reading = { raw: 0, mapped: 0, pointerType: '—' };
    ctx.save();
    ctx.fillStyle = theme === 'dark' ? '#818cf8' : '#4f46e5';
    for (const point of points) {
      const { raw, normalized } = stroke.pressure(point);
      const mapped = evaluatePressureCurve(normalized, stroke.curve ?? pressureCurve);
      reading = { raw, mapped, pointerType: stroke.isPen ? 'pen' : point.pointerType || 'mouse' };
      const x = (point.clientX - rect.left) * canvas.width / rect.width;
      const y = (point.clientY - rect.top) * canvas.height / rect.height;
      const radius = Math.max(0.5, mapped * 18);
      const previous = lastTestPoint.current;
      if (previous) {
        const dx = x - previous.x;
        const dy = y - previous.y;
        const distance = Math.hypot(dx, dy);
        if (distance > 0) {
          const nx = -dy / distance;
          const ny = dx / distance;
          ctx.beginPath();
          ctx.moveTo(previous.x + nx * previous.radius, previous.y + ny * previous.radius);
          ctx.lineTo(x + nx * radius, y + ny * radius);
          ctx.lineTo(x - nx * radius, y - ny * radius);
          ctx.lineTo(previous.x - nx * previous.radius, previous.y - ny * previous.radius);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      lastTestPoint.current = { x, y, radius };
    }
    ctx.restore();
    setPressureReading(reading);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = testStroke.current;
    if (stroke?.pointerId !== e.pointerId || testReleaseTimer.current !== undefined) return;
    if (e.type === 'pointerup') {
      const waitForNative = stroke.hasNativeMotion || stroke.awaitingNativeStart;
      const motion = stroke.contactPoints(e.nativeEvent, waitForNative);
      if (waitForNative && (!motion.lifted || !stroke.hasNativeMotion)) {
        drawTestMotion({ ...motion, lifted: false }, stroke);
        testReleaseTimer.current = setTimeout(() => {
          if (testStroke.current !== stroke) return;
          drawTestMotion(stroke.contactPoints(e.nativeEvent), stroke);
        }, 32);
        return;
      }
      drawTestMotion(motion, stroke);
    }
    finishTestStroke(e.pointerId);
  };

  const finishTestStroke = (pointerId: number) => {
    if (testStroke.current?.pointerId !== pointerId) return;
    clearTimeout(testReleaseTimer.current);
    testReleaseTimer.current = undefined;
    cancelAnimationFrame(testMotionFrame.current);
    testMotionFrame.current = 0;
    testStroke.current.finish();
    testStroke.current = null;
    lastTestPoint.current = null;
    setPressureReading((reading) => ({ ...reading, raw: 0, mapped: 0 }));
  };

  useEffect(() => () => {
    clearTimeout(testReleaseTimer.current);
    testReleaseTimer.current = undefined;
    cancelAnimationFrame(testMotionFrame.current);
    testMotionFrame.current = 0;
    testStroke.current?.finish();
    testStroke.current = null;
  }, [isOpen, activeTab]);

  const handleClearTestArea = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = theme === 'dark' ? '#181920' : '#f8fafc';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setPressureReading((reading) => ({ ...reading, raw: 0, mapped: 0 }));
  };

  const handleSaveServerUrl = () => {
    ApiService.setServerUrl(customServerUrl);
    setIsUrlSaved(true);
    setTimeout(() => setIsUrlSaved(false), 2000);
  };

  if (!isOpen) return null;

  const languages: Array<{ code: Language; name: string; flag: string }> = [
    { code: 'zh-TW', name: '繁體中文 (Traditional Chinese)', flag: '🇹🇼' },
    { code: 'zh-CN', name: '简体中文 (Simplified Chinese)', flag: '🇨🇳' },
    { code: 'en-US', name: 'English (US)', flag: '🇺🇸' },
    { code: 'ja-JP', name: '日本語 (Japanese)', flag: '🇯🇵' },
  ];

  // Conflict detection
  const comboCounts = new Map<string, number>();
  for (const s of shortcuts) {
    if (s.currentCombo) {
      comboCounts.set(s.currentCombo, (comboCounts.get(s.currentCombo) || 0) + 1);
    }
  }

  const normalizeShortcut = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s*\+\s*/g, '+');
  const query = normalizeShortcut(shortcutSearch.trim()).split(/\s+/).filter(Boolean);
  const categoryLabels = {
    toolbox: t.settings.shortcutCatTools,
    layers: t.settings.shortcutCatLayers,
    filters: t.settings.shortcutCatFilterTransform,
    studio: t.settings.shortcutCatAssistStudio,
    actions: t.settings.shortcutCatEdit,
    navigation: t.settings.shortcutCatViewVoice,
    voice: t.settings.shortcutCatViewVoice,
    plugins: t.settings.shortcutCatPlugins,
  };
  const matchingShortcuts = query.length ? shortcuts.filter((shortcut) => {
    const haystack = normalizeShortcut([
      shortcut.name, shortcut.description, shortcut.id.replace(/_/g, ' '), categoryLabels[shortcut.category],
      shortcut.currentCombo, shortcutMgr.getDisplayLabel(shortcut.currentCombo),
    ].join(' '));
    return query.every((term) => haystack.includes(term));
  }) : shortcuts;
  const toolboxShortcuts = matchingShortcuts.filter((s) => s.category === 'toolbox');
  const layerShortcuts = matchingShortcuts.filter((s) => s.category === 'layers');
  const filterShortcuts = matchingShortcuts.filter((s) => s.category === 'filters');
  const studioShortcuts = matchingShortcuts.filter((s) => s.category === 'studio');
  const actionShortcuts = matchingShortcuts.filter((s) => s.category === 'actions');
  const navShortcuts = matchingShortcuts.filter((s) => s.category === 'navigation');
  const voiceShortcuts = matchingShortcuts.filter((s) => s.category === 'voice');
  const pluginShortcuts = matchingShortcuts.filter((s) => s.category === 'plugins');

  const tabs: Array<{ id: SettingsTab; icon: React.ReactNode; label: string }> = [
    { id: 'general', icon: <Sun className="h-4 w-4" />, label: t.settings.tabAppearance },
    { id: 'shortcuts', icon: <Keyboard className="h-4 w-4" />, label: t.settings.tabShortcuts },
    { id: 'pressure', icon: <PenTool className="h-4 w-4" />, label: t.settings.tabStylus },
    { id: 'server', icon: <Server className="h-4 w-4" />, label: t.settings.tabServer },
  ];

  return (
    <AtelierModal
      title={t.settings.title}
      icon={<Sliders />}
      
      width="xl"
      onClose={onClose}
      footer={<button type="button" onClick={onClose} className={modalButton.secondary}>{t.common.close}</button>}
      toolbar={
        <div role="tablist" aria-label={t.settings.tablistAria} className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-neutral-800 px-3 pt-2 text-xs">
          {tabs.map((tab) => (
            <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id)}
              className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 pb-2 pt-1 font-medium transition ${activeTab === tab.id ? 'border-indigo-500 text-white' : 'border-transparent text-neutral-400 hover:text-neutral-200'}`}>
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      }
    >
          {/* TAB 1: SHORTCUTS & KEYBINDINGS */}
          {activeTab === 'shortcuts' && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between pb-2 border-b border-neutral-800">
                <div>
                  <h4 className="text-xs font-bold text-white">{t.settings.shortcutCustomTitle}</h4>
                  <p className="text-[11px] text-neutral-400">
                    {t.settings.shortcutCustomDesc}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => { if (confirm(t.settings.resetShortcutsConfirm)) shortcutMgr.resetToDefaults(); }}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-[11px] text-neutral-300 hover:text-white border border-neutral-700 transition"
                  title={t.settings.resetShortcutsTitle}
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>{t.settings.resetShortcuts}</span>
                </button>
              </div>

              <label className="relative">
                <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
                <input type="search" value={shortcutSearch} onChange={(event) => setShortcutSearch(event.target.value)}
                  onFocus={() => setRecordingActionId(null)} aria-label={t.settings.shortcutSearch}
                  placeholder={t.settings.shortcutSearch} className="atelier-field h-9 w-full pl-9 pr-3 text-sm" />
              </label>
              {matchingShortcuts.length === 0 && <p role="status" className="text-xs text-neutral-400">{t.settings.shortcutSearchEmpty}</p>}

              {/* TourBox: its console maps every control to a key; this is the layout, with the keys in use now */}
              {query.length === 0 && (() => {
                const rows: Array<[string, string, string]> = [
                  ['旋鈕 Knob ↺ / ↻', '筆刷大小 − / +', 'action_brush_smaller|action_brush_larger'],
                  ['滾輪 Scroll ↑ / ↓', '放大 / 縮小', 'action_zoom_in|action_zoom_out'],
                  ['轉盤 Dial ↺ / ↻', '畫布左轉 / 右轉 15°', 'action_view_rotate_left|action_view_rotate_right'],
                  ['旋鈕按下', '重設視角（符合視窗）', 'action_reset_view'],
                  ['滾輪按下', '左右翻轉畫面', 'action_view_flip'],
                  ['十字鍵 ↑ / ↓', '筆刷不透明度 + / −', 'action_brush_opacity_up|action_brush_opacity_down'],
                  ['十字鍵 ← / →', '動畫上一格 / 下一格', 'action_anim_prev_frame|action_anim_next_frame'],
                  ['Tour 鍵', '動畫播放／暫停', 'action_anim_play'],
                  ['C1 / C2', '復原 / 重做', 'action_undo|action_redo'],
                  ['短鍵 Short', '筆刷', 'tool_brush'],
                  ['頂鍵 Top', '橡皮擦', 'tool_eraser'],
                  ['側鍵 Side', '滴管', 'tool_eyedropper'],
                  ['高鍵 Tall（按住）', '平移畫布', ''],
                ];
                const keyOf = (ids: string) => (ids ? ids.split('|').map((id) => shortcutMgr.getDisplayLabel(shortcutMgr.getComboForAction(id)) || t.settings.shortcutNotSet).join(' / ') : '空白鍵（按住）');
                const text = ['Lumina Drift × TourBox 設定（在 TourBox Console 為瀏覽器／Lumina Drift 建一個預設，每個控制項設成下面的按鍵）', ...rows.map(([c, a, ids]) => `${c}：${a} → ${keyOf(ids)}`)].join('\n');
                return (
                  <details className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-3" open>
                    <summary className="cursor-pointer text-xs font-bold text-white">{t.settings.tourboxTitle}</summary>
                    <p className="mt-1 text-[11px] text-neutral-400">
                      {t.settings.tourboxDesc}
                    </p>
                    <table className="mt-2 w-full text-[11px]">
                      <tbody>
                        {rows.map(([control, action, ids]) => (
                          <tr key={control} className="border-t border-neutral-800/70">
                            <td className="py-1 pr-2 text-neutral-300">{control}</td>
                            <td className="py-1 pr-2 text-neutral-400">{action}</td>
                            <td className="py-1 text-right font-mono text-indigo-300">{keyOf(ids)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button type="button" onClick={() => { void navigator.clipboard?.writeText(text).catch(() => undefined); }}
                      className="mt-2 rounded-lg border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-[11px] text-neutral-200 hover:bg-neutral-700">
                      複製對照表
                    </button>
                  </details>
                );
              })()}

              {/* Category 1: Toolbox Tools */}
              <div className={toolboxShortcuts.length ? 'flex flex-col gap-2' : 'hidden'}>
                <span className="text-[11px] font-bold text-indigo-400 uppercase tracking-wider">
                  {t.settings.shortcutCatTools}
                </span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {toolboxShortcuts.map((s) => {
                    const isRecording = recordingActionId === s.id;
                    const hasConflict = (comboCounts.get(s.currentCombo) || 0) > 1 || ShortcutManager.isBrowserReserved(s.currentCombo);

                    return (
                      <div
                        key={s.id}
                        className="flex items-center justify-between p-2.5 rounded-xl bg-neutral-900/80 border border-neutral-800/80 hover:border-neutral-700 text-xs"
                      >
                        <div className="min-w-0 pr-2">
                          <span className="font-semibold text-white block truncate">{s.name}</span>
                          <span className="text-[10px] text-neutral-500 block truncate">{s.description}</span>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {hasConflict && (
                            <span title={ShortcutManager.isBrowserReserved(s.currentCombo) ? t.settings.shortcutBrowserReserved : t.settings.shortcutConflict} className="text-amber-400">
                              <AlertCircle className="w-3.5 h-3.5" />
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => setRecordingActionId(isRecording ? null : s.id)}
                            className={`px-3 py-1 rounded-lg font-mono text-xs font-bold transition shadow-sm ${
                              isRecording
                                ? 'bg-indigo-600 text-white animate-pulse ring-2 ring-indigo-400'
                                : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700'
                            }`}
                          >
                            {isRecording ? recordPreview : shortcutMgr.getDisplayLabel(s.currentCombo) || t.settings.shortcutNotSet}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Category 2: Layer & Group Management */}
              {layerShortcuts.length > 0 && (
                <div className="flex flex-col gap-2 pt-2">
                  <span className="text-[11px] font-bold text-indigo-400 uppercase tracking-wider">
                    {t.settings.shortcutCatLayers}
                  </span>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {layerShortcuts.map((s) => {
                      const isRecording = recordingActionId === s.id;
                      const hasConflict = (comboCounts.get(s.currentCombo) || 0) > 1 || ShortcutManager.isBrowserReserved(s.currentCombo);

                      return (
                        <div
                          key={s.id}
                          className="flex items-center justify-between p-2.5 rounded-xl bg-neutral-900/80 border border-neutral-800/80 hover:border-neutral-700 text-xs"
                        >
                          <div className="min-w-0 pr-2">
                            <span className="font-semibold text-white block truncate">{s.name}</span>
                            <span className="text-[10px] text-neutral-500 block truncate">{s.description}</span>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {hasConflict && (
                              <span title={ShortcutManager.isBrowserReserved(s.currentCombo) ? t.settings.shortcutBrowserReserved : t.settings.shortcutConflict} className="text-amber-400">
                                <AlertCircle className="w-3.5 h-3.5" />
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => setRecordingActionId(isRecording ? null : s.id)}
                              className={`px-3 py-1 rounded-lg font-mono text-xs font-bold transition shadow-sm ${
                                isRecording
                                  ? 'bg-indigo-600 text-white animate-pulse ring-2 ring-indigo-400'
                                  : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700'
                              }`}
                            >
                              {isRecording ? recordPreview : shortcutMgr.getDisplayLabel(s.currentCombo) || t.settings.shortcutNotSet}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Category 3: Color & Advanced Filters */}
              {filterShortcuts.length > 0 && (
                <div className="flex flex-col gap-2 pt-2">
                  <span className="text-[11px] font-bold text-indigo-400 uppercase tracking-wider">
                    {t.settings.shortcutCatFilterTransform}
                  </span>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {filterShortcuts.map((s) => {
                      const isRecording = recordingActionId === s.id;
                      const hasConflict = (comboCounts.get(s.currentCombo) || 0) > 1 || ShortcutManager.isBrowserReserved(s.currentCombo);

                      return (
                        <div
                          key={s.id}
                          className="flex items-center justify-between p-2.5 rounded-xl bg-neutral-900/80 border border-neutral-800/80 hover:border-neutral-700 text-xs"
                        >
                          <div className="min-w-0 pr-2">
                            <span className="font-semibold text-white block truncate">{s.name}</span>
                            <span className="text-[10px] text-neutral-500 block truncate">{s.description}</span>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {hasConflict && (
                              <span title={ShortcutManager.isBrowserReserved(s.currentCombo) ? t.settings.shortcutBrowserReserved : t.settings.shortcutConflict} className="text-amber-400">
                                <AlertCircle className="w-3.5 h-3.5" />
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => setRecordingActionId(isRecording ? null : s.id)}
                              className={`px-3 py-1 rounded-lg font-mono text-xs font-bold transition shadow-sm ${
                                isRecording
                                  ? 'bg-indigo-600 text-white animate-pulse ring-2 ring-indigo-400'
                                  : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700'
                              }`}
                            >
                              {isRecording ? recordPreview : shortcutMgr.getDisplayLabel(s.currentCombo) || t.settings.shortcutNotSet}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Category 4: Creative Studio & Rulers */}
              {studioShortcuts.length > 0 && (
                <div className="flex flex-col gap-2 pt-2">
                  <span className="text-[11px] font-bold text-indigo-400 uppercase tracking-wider">
                    {t.settings.shortcutCatAssistStudio}
                  </span>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {studioShortcuts.map((s) => {
                      const isRecording = recordingActionId === s.id;
                      const hasConflict = (comboCounts.get(s.currentCombo) || 0) > 1 || ShortcutManager.isBrowserReserved(s.currentCombo);

                      return (
                        <div
                          key={s.id}
                          className="flex items-center justify-between p-2.5 rounded-xl bg-neutral-900/80 border border-neutral-800/80 hover:border-neutral-700 text-xs"
                        >
                          <div className="min-w-0 pr-2">
                            <span className="font-semibold text-white block truncate">{s.name}</span>
                            <span className="text-[10px] text-neutral-500 block truncate">{s.description}</span>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {hasConflict && (
                              <span title={ShortcutManager.isBrowserReserved(s.currentCombo) ? t.settings.shortcutBrowserReserved : t.settings.shortcutConflict} className="text-amber-400">
                                <AlertCircle className="w-3.5 h-3.5" />
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => setRecordingActionId(isRecording ? null : s.id)}
                              className={`px-3 py-1 rounded-lg font-mono text-xs font-bold transition shadow-sm ${
                                isRecording
                                  ? 'bg-indigo-600 text-white animate-pulse ring-2 ring-indigo-400'
                                  : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700'
                              }`}
                            >
                              {isRecording ? recordPreview : shortcutMgr.getDisplayLabel(s.currentCombo) || t.settings.shortcutNotSet}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Category 5: Actions & History */}
              <div className={actionShortcuts.length ? 'flex flex-col gap-2 pt-2' : 'hidden'}>
                <span className="text-[11px] font-bold text-indigo-400 uppercase tracking-wider">
                  {t.settings.shortcutCatEdit}
                </span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {actionShortcuts.map((s) => {
                    const isRecording = recordingActionId === s.id;
                    const hasConflict = (comboCounts.get(s.currentCombo) || 0) > 1 || ShortcutManager.isBrowserReserved(s.currentCombo);

                    return (
                      <div
                        key={s.id}
                        className="flex items-center justify-between p-2.5 rounded-xl bg-neutral-900/80 border border-neutral-800/80 hover:border-neutral-700 text-xs"
                      >
                        <div className="min-w-0 pr-2">
                          <span className="font-semibold text-white block truncate">{s.name}</span>
                          <span className="text-[10px] text-neutral-500 block truncate">{s.description}</span>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {hasConflict && (
                            <span title={ShortcutManager.isBrowserReserved(s.currentCombo) ? t.settings.shortcutBrowserReserved : t.settings.shortcutConflict} className="text-amber-400">
                              <AlertCircle className="w-3.5 h-3.5" />
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => setRecordingActionId(isRecording ? null : s.id)}
                            className={`px-3 py-1 rounded-lg font-mono text-xs font-bold transition shadow-sm ${
                              isRecording
                                ? 'bg-indigo-600 text-white animate-pulse ring-2 ring-indigo-400'
                                : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700'
                            }`}
                          >
                            {isRecording ? recordPreview : shortcutMgr.getDisplayLabel(s.currentCombo) || t.settings.shortcutNotSet}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Category 6: Panels & Navigation & Voice */}
              <div className={navShortcuts.length + voiceShortcuts.length ? 'flex flex-col gap-2 pt-2' : 'hidden'}>
                <span className="text-[11px] font-bold text-indigo-400 uppercase tracking-wider">
                  {t.settings.shortcutCatViewVoice}
                </span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {[...navShortcuts, ...voiceShortcuts].map((s) => {
                    const isRecording = recordingActionId === s.id;
                    const hasConflict = (comboCounts.get(s.currentCombo) || 0) > 1 || ShortcutManager.isBrowserReserved(s.currentCombo);

                    return (
                      <div
                        key={s.id}
                        className="flex items-center justify-between p-2.5 rounded-xl bg-neutral-900/80 border border-neutral-800/80 hover:border-neutral-700 text-xs"
                      >
                        <div className="min-w-0 pr-2">
                          <span className="font-semibold text-white block truncate">{s.name}</span>
                          <span className="text-[10px] text-neutral-500 block truncate">{s.description}</span>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {hasConflict && (
                            <span title={ShortcutManager.isBrowserReserved(s.currentCombo) ? t.settings.shortcutBrowserReserved : t.settings.shortcutConflict} className="text-amber-400">
                              <AlertCircle className="w-3.5 h-3.5" />
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => setRecordingActionId(isRecording ? null : s.id)}
                            className={`px-3 py-1 rounded-lg font-mono text-xs font-bold transition shadow-sm ${
                              isRecording
                                ? 'bg-indigo-600 text-white animate-pulse ring-2 ring-indigo-400'
                                : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700'
                            }`}
                          >
                            {isRecording ? recordPreview : shortcutMgr.getDisplayLabel(s.currentCombo) || t.settings.shortcutNotSet}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Category 7: Plugin Commands & Panels */}
              <div className={pluginShortcuts.length ? 'flex flex-col gap-2 pt-2' : 'hidden'} data-shortcut-category="plugins">
                <span className="flex items-center gap-1.5 text-[11px] font-bold text-cyan-300 uppercase tracking-wider">
                  <Puzzle className="h-3.5 w-3.5" aria-hidden />
                  {t.settings.shortcutCatPlugins}
                </span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {pluginShortcuts.map((s) => {
                    const isRecording = recordingActionId === s.id;
                    const hasConflict = Boolean(s.currentCombo) && ((comboCounts.get(s.currentCombo) || 0) > 1 || ShortcutManager.isBrowserReserved(s.currentCombo));

                    return (
                      <div
                        key={s.id}
                        data-shortcut-id={s.id}
                        className="flex items-center justify-between p-2.5 rounded-xl bg-neutral-900/80 border border-neutral-800/80 hover:border-neutral-700 text-xs"
                      >
                        <div className="min-w-0 pr-2">
                          <span className="font-semibold text-white block truncate">{s.name}</span>
                          <span className="text-[10px] text-neutral-500 block truncate">{s.description}</span>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {hasConflict && (
                            <span title={ShortcutManager.isBrowserReserved(s.currentCombo) ? t.settings.shortcutBrowserReserved : t.settings.shortcutConflict} className="text-amber-400">
                              <AlertCircle className="w-3.5 h-3.5" />
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => setRecordingActionId(isRecording ? null : s.id)}
                            className={`px-3 py-1 rounded-lg font-mono text-xs font-bold transition shadow-sm ${
                              isRecording
                                ? 'bg-indigo-600 text-white animate-pulse ring-2 ring-indigo-400'
                                : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700'
                            }`}
                          >
                            {isRecording ? recordPreview : shortcutMgr.getDisplayLabel(s.currentCombo) || t.settings.shortcutNotSet}
                          </button>
                          {s.currentCombo && !isRecording && (
                            <button
                              type="button"
                              onClick={() => shortcutMgr.setShortcut(s.id, '')}
                              title={t.settings.shortcutClear}
                              aria-label={t.settings.shortcutClear}
                              className="atelier-icon-btn h-6 w-6"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: APPEARANCE & LANGUAGE */}
          {activeTab === 'general' && (
            <div className="flex flex-col gap-5">
              <UiScaleControl />

              {/* Theme */}
              <div className="flex flex-col gap-2.5">
                <span className="text-xs font-bold text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
                  <Moon className="w-3.5 h-3.5 text-indigo-400" />
                  {t.settings.themeColor}
                </span>
                <ThemePicker />
              </div>

              <MotionModeControl />

              {/* Canvas Cursor */}
              <div className="flex flex-col gap-2.5">
                <span className="text-xs font-bold text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
                  <Crosshair className="w-3.5 h-3.5 text-indigo-400" />
                  {t.settings.canvasCursorTitle}
                </span>
                <label className="flex items-start justify-between gap-3 rounded-xl border border-neutral-800 bg-neutral-900/60 px-3 py-2.5 text-xs text-neutral-200 cursor-pointer">
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium text-white">{t.settings.showBrushCrosshair}</span>
                    <span className="text-[11px] text-neutral-400">{t.settings.showBrushCrosshairDesc}</span>
                  </span>
                  <input
                    type="checkbox"
                    data-setting="show-brush-crosshair"
                    checked={showBrushCrosshair}
                    onChange={(e) => setShowBrushCrosshair(e.target.checked)}
                    className="mt-0.5 shrink-0"
                  />
                </label>
              </div>

              {/* Panels (same switches as the 視窗 menu) */}
              <div className="flex flex-col gap-2.5">
                <span className="text-xs font-bold text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-indigo-400" />
                  {t.settings.panelsTitle}
                </span>
                <div className="grid grid-cols-2 gap-2">
                  {PANEL_IDS.map((id) => (
                    <label key={id} className="flex items-center justify-between gap-2 rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-200">
                      <span>{PANEL_TITLES[id]}</span>
                      <input type="checkbox" checked={dockLayout.panels[id].visible} onChange={() => dockActions.toggle(id)} />
                    </label>
                  ))}
                </div>
                <button type="button" onClick={() => dockActions.reset()} className="self-start rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800">
                  {t.settings.resetLayout}
                </button>
              </div>

              {/* Language */}
              <div className="flex flex-col gap-2.5">
                <span className="text-xs font-bold text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5 text-indigo-400" />
                  {t.settings.language}
                </span>

                <div className="grid grid-cols-2 gap-2">
                  {languages.map((l) => (
                    <button
                      key={l.code}
                      type="button"
                      onClick={() => setLanguage(l.code)}
                      className={`flex items-center justify-between p-3 rounded-xl border text-xs font-medium transition ${
                        language === l.code
                          ? 'bg-indigo-600/20 border-indigo-500 text-white'
                          : 'bg-neutral-900/60 border-neutral-800 text-neutral-400 hover:text-white hover:border-neutral-700'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span>{l.flag}</span>
                        <span>{l.name}</span>
                      </span>
                      {language === l.code && <Check className="w-4 h-4 text-indigo-400" />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: STYLUS PRESSURE */}
          {activeTab === 'pressure' && (
            <div className="flex flex-col gap-3">
              <section className="rounded-xl border border-neutral-800 p-3 text-xs" aria-label={settings.tabletInput}>
                <h4 className="mb-2 font-bold text-white">{settings.tabletInput}</h4>
                {hasNativeTabletModes && (
                  <label className="mb-2 flex items-center justify-between gap-3">
                    <span>{settings.tabletSelected}</span>
                    <select
                      value={tablet.preference}
                      onChange={(e) => setTabletPreference(e.target.value as TabletPreference)}
                      className="rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-white"
                    >
                      <option value="auto">{settings.tabletAuto}</option>
                      <option value="ink">{settings.tabletInk}</option>
                      <option value="wintab">{modeLabel.wintab}</option>
                    </select>
                  </label>
                )}
                <div className="flex items-center justify-between gap-3">
                  <span>{settings.tabletActive}</span>
                  <output data-tablet-mode={tablet.mode} data-tablet-native-source={tablet.nativeSource ?? 'none'}>{modeLabel[tablet.mode]}</output>
                </div>
                {tablet.preference === 'ink' && tablet.mode === 'wintab' && (
                  <p className="mt-2 text-neutral-400">{settings.tabletPending}</p>
                )}
                {hasNativeTabletModes && tablet.preference !== 'ink' && driverMessage &&
                  (tablet.driver !== 'ready' || tablet.preference === 'wintab') && (
                  <p className="mt-2 text-neutral-400" role="status">{driverMessage}</p>
                )}
              </section>
              <section className="rounded-xl border border-neutral-800 p-3 text-xs" aria-label={t.settings.touchSimulatedPressure}>
                <label className="flex items-start justify-between gap-3 cursor-pointer">
                  <span className="flex flex-col gap-0.5">
                    <span className="font-bold text-white flex items-center gap-1.5">
                      <Hand className="w-3.5 h-3.5 text-indigo-400" />
                      {t.settings.touchSimulatedPressure}
                    </span>
                    <span className="text-[11px] text-neutral-400">{t.settings.touchSimulatedPressureDesc}</span>
                  </span>
                  <input
                    type="checkbox"
                    data-setting="touch-simulated-pressure"
                    checked={touchSimulatedPressure}
                    onChange={(e) => setTouchSimulatedPressure(e.target.checked)}
                    className="mt-0.5 shrink-0"
                  />
                </label>
              </section>

              <section className="rounded-xl border border-neutral-800 p-3 text-xs flex flex-col gap-2.5" aria-label={t.touchGestures.sectionTitle}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h4 className="font-bold text-white flex items-center gap-1.5">
                      <Hand className="w-3.5 h-3.5 text-indigo-400" />
                      {t.touchGestures.sectionTitle}
                    </h4>
                    <p className="text-[11px] text-neutral-400 mt-0.5">{t.touchGestures.sectionDesc}</p>
                  </div>
                  <button
                    type="button"
                    data-setting="touch-gestures-reset"
                    onClick={() => resetTouchGestureSettings()}
                    className="text-[11px] text-neutral-400 hover:text-white flex items-center gap-1 px-2 py-1 bg-neutral-800 rounded-lg shrink-0"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>{t.touchGestures.resetDefaults}</span>
                  </button>
                </div>

                <label className="flex items-start justify-between gap-3 cursor-pointer">
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium text-neutral-100">{t.touchGestures.quickPinchToFit}</span>
                    <span className="text-[11px] text-neutral-400">{t.touchGestures.quickPinchToFitDesc}</span>
                  </span>
                  <input
                    type="checkbox"
                    data-setting="touch-quick-pinch-fit"
                    checked={touchGestures.quickPinchToFit}
                    onChange={(e) => updateTouchGestureSettings({ quickPinchToFit: e.target.checked })}
                    className="mt-0.5 shrink-0"
                  />
                </label>

                <label className="flex items-start justify-between gap-3 cursor-pointer">
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium text-neutral-100">{t.touchGestures.fourFingerFullscreen}</span>
                    <span className="text-[11px] text-neutral-400">{t.touchGestures.fourFingerFullscreenDesc}</span>
                  </span>
                  <input
                    type="checkbox"
                    data-setting="touch-four-finger-fullscreen"
                    checked={touchGestures.fourFingerTapFullscreen}
                    onChange={(e) => updateTouchGestureSettings({ fourFingerTapFullscreen: e.target.checked })}
                    className="mt-0.5 shrink-0"
                  />
                </label>

                <label className="flex items-start justify-between gap-3 cursor-pointer">
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium text-neutral-100">{t.touchGestures.rapidUndoRedoHold}</span>
                    <span className="text-[11px] text-neutral-400">{t.touchGestures.rapidUndoRedoHoldDesc}</span>
                  </span>
                  <input
                    type="checkbox"
                    data-setting="touch-rapid-undo-redo"
                    checked={touchGestures.rapidUndoRedoHold}
                    onChange={(e) => updateTouchGestureSettings({ rapidUndoRedoHold: e.target.checked })}
                    className="mt-0.5 shrink-0"
                  />
                </label>

                <label className="flex items-start justify-between gap-3 cursor-pointer">
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium text-neutral-100">{t.touchGestures.threeFingerCopyPaste}</span>
                    <span className="text-[11px] text-neutral-400">{t.touchGestures.threeFingerCopyPasteDesc}</span>
                  </span>
                  <input
                    type="checkbox"
                    data-setting="touch-three-finger-clipboard"
                    checked={touchGestures.threeFingerSwipeCopyPaste}
                    onChange={(e) => updateTouchGestureSettings({ threeFingerSwipeCopyPaste: e.target.checked })}
                    className="mt-0.5 shrink-0"
                  />
                </label>

                <div className="border-t border-neutral-800 pt-2.5 flex flex-col gap-2">
                  <label className="flex items-center justify-between gap-3">
                    <span className="font-medium text-neutral-100">{t.touchGestures.longPressAction}</span>
                    <select
                      data-setting="touch-long-press-action"
                      value={touchGestures.longPressAction}
                      onChange={(e) => updateTouchGestureSettings({ longPressAction: e.target.value as TouchLongPressAction })}
                      className="rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-1 text-white"
                    >
                      <option value="radial">{t.touchGestures.longPressRadial}</option>
                      <option value="eyedropper">{t.touchGestures.longPressEyedropper}</option>
                    </select>
                  </label>

                  <label className="flex items-center justify-between gap-3">
                    <span className="font-medium text-neutral-100">{t.touchGestures.longPressDelay}</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        data-setting="touch-long-press-delay"
                        min={MIN_LONG_PRESS_DELAY_MS}
                        max={MAX_LONG_PRESS_DELAY_MS}
                        step={50}
                        value={touchGestures.longPressDelayMs}
                        onChange={(e) => updateTouchGestureSettings({ longPressDelayMs: Number(e.target.value) })}
                        className="w-28 accent-indigo-500"
                      />
                      <span className="w-12 text-right font-mono tabular-nums text-neutral-300">
                        {touchGestures.longPressDelayMs}ms
                      </span>
                    </div>
                  </label>

                  <label className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-neutral-100">{t.touchGestures.singleFingerMode}</span>
                      <select
                        data-setting="touch-single-finger-mode"
                        value={touchGestures.singleFingerMode}
                        onChange={(e) => updateTouchGestureSettings({ singleFingerMode: e.target.value as TouchSingleFingerMode })}
                        className="rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-1 text-white"
                      >
                        <option value="draw">{t.touchGestures.singleFingerDraw}</option>
                        <option value="pan">{t.touchGestures.singleFingerPan}</option>
                        <option value="ignore">{t.touchGestures.singleFingerIgnore}</option>
                      </select>
                    </div>
                    <span className="text-[11px] text-neutral-400">{t.touchGestures.singleFingerModeDesc}</span>
                  </label>
                </div>
              </section>
              <PressureCurveEditor curve={pressureCurve} onChange={updatePressureCurve} />
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                    <PenTool className="w-3.5 h-3.5 text-indigo-400" />
                    {t.settings.stylusPressure}
                  </h4>
                  <p className="text-[11px] text-neutral-400">
                    {t.settings.stylusTestPrompt}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleClearTestArea}
                  className="text-[11px] text-neutral-400 hover:text-white flex items-center gap-1 px-2 py-1 bg-neutral-800 rounded-lg"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>{t.settings.clearTestArea}</span>
                </button>
              </div>

              {/* Test Canvas Box */}
              <div className="relative rounded-xl border border-neutral-800 overflow-hidden shadow-inner">
                <canvas
                  ref={canvasRef}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onLostPointerCapture={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  className="w-full h-44 touch-none cursor-crosshair block"
                />

                {/* Real-time Pressure Meter Overlay */}
                <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-lg border border-neutral-800 text-[11px] text-neutral-300 font-mono">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
                    <span>{t.settings.deviceType.replace('{type}', pressureReading.pointerType)}</span>
                  </span>

                  <div className="flex items-center gap-2">
                    <span data-pressure-raw={pressureReading.raw}>{t.settings.rawPressure} {pressureReading.raw.toFixed(2)}</span>
                    <div className="w-24 h-2 bg-neutral-800 rounded-full overflow-hidden border border-neutral-700">
                      <div
                        className="h-full origin-left bg-gradient-to-r from-indigo-500 to-emerald-400"
                        style={{ transform: `scaleX(${pressureReading.mapped})` }}
                      />
                    </div>
                    <span data-pressure-mapped={pressureReading.mapped} className="text-right font-bold text-indigo-400">
                      {t.settings.mappedPressure} {pressureReading.mapped.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: SERVER CONNECTION */}
          {activeTab === 'server' && (
            <div className="flex flex-col gap-3">
              <div>
                <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                  <Server className="w-3.5 h-3.5 text-indigo-400" />
                  {t.settings.serverConfig}
                </h4>
                <p className="text-[11px] text-neutral-400">
                  {t.settings.serverRemoteDesc}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder={t.settings.serverPlaceholder}
                  value={customServerUrl}
                  onChange={(e) => setCustomServerUrl(e.target.value)}
                  className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-indigo-500 font-mono"
                />
                <button
                  type="button"
                  onClick={handleSaveServerUrl}
                  className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition shrink-0"
                >
                  {isUrlSaved ? <Check className="w-4 h-4" /> : t.settings.save}
                </button>
              </div>
            </div>
          )}
    </AtelierModal>
  );
};
