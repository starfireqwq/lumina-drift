import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  AnimationEngine, AnimationTrack, MAX_FLIP_SPAN, MAX_HOLD, MAX_ONION, MAX_TIMELINE_FRAMES, ONION_MODES, OnionSkinConfig, TIMELINE_SLACK, celLayerOf, entryIndexAt, entryStart,
  formatTimecode, parseTimecode, planRepeatCels, removeTimelineLabel, trackLength, upsertTimelineLabel, upsertTransformKeyframe, removeTransformKeyframe, type OnionMode, type TimecodeMode,
} from '../engine/AnimationEngine';
import {
  clearLightTable,
  externalRefsFor,
  lightIdsFor,
  lightTableHas,
  toggleLightCel,
  type LightTableScope,
  type LightTableState,
} from '../engine/lightTable';
import type { AudioAssetSummary } from '../engine/AudioTrackEngine';
import {
  BEZIER_PRESETS,
  evaluateTransformKeyframes,
  matchBezierPreset,
  normalizeAudioTrackMeta,
  resolveAudioClipFrameRange,
  type CelMark,
  type EvaluatedTransform,
  type KeyframeBezierPresetId,
  type KeyframeEasing,
  type LayerModel,
  type TimelineLabel,
  type TransformKeyframe,
} from '@atelier/shared';
import {
  Camera, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Download, Eye, EyeOff, Film, Folder, Headphones, Lamp, ListOrdered, Loader2, MessageSquare, Minus, Music, Pause, Play, Plus,
  Repeat, Repeat2, SkipBack, SkipForward, SlidersHorizontal, Tag, Trash2, Users, Volume2, VolumeX, X,
} from 'lucide-react';
import { AtelierModal, modalButton } from './AtelierModal';
import { AnimationExportModal } from './AnimationExportModal';
import { OverlayPresence } from './OverlayPresence';
import { usePhoneLayout } from './workspace/dockStore';
import { getUserColor } from '../utils/userColors';
import { useI18n } from '../context/I18nContext';

/** What to put in a GIF / video / sequence: one folder (solo), every animation folder (team), or the whole picture */
export type AnimationExportScope = 'folder' | 'folders' | 'all';

export interface AnimationExportPlanRequest {
  scope: AnimationExportScope;
  useRange: boolean;
  /** Explicit 0-based inclusive frame range; overrides useRange when supplied */
  range?: { start: number; end: number } | null;
  /** Leave background transparent instead of filling canvas paper color */
  transparent?: boolean;
  /** Apply active 2D camera frame crop/transform per frame (Phase E1) */
  useCamera?: boolean;
}

/** Frames to encode: each segment is one distinct picture shown for `hold` frames */
export interface AnimationExportPlan {
  width: number;
  height: number;
  bgColor: string;
  segments: Array<{ time: number; hold: number }>;
  render: (time: number) => HTMLCanvasElement;
  /** Puts the screen back */
  done: () => void;
}

export interface AnimationCelExportItem {
  folderId: string;
  folderName: string;
  celId: string;
  celName: string;
}

export interface AnimationCelExportPlan {
  width: number;
  height: number;
  items: AnimationCelExportItem[];
  renderCel: (celId: string) => HTMLCanvasElement;
  done: () => void;
}

interface AnimationTimelineBarProps {
  engine: AnimationEngine;
  isOpen: boolean;
  onClose: () => void;
  /** Every animation folder, top of the layer list first; all play on the same clock */
  tracks: AnimationTrack[];
  /** The folder being edited (its cels get onion skin and the edit buttons) */
  activeFolderId: string | null;
  thumbnails?: Record<string, string>;
  subscribeThumbnails?: (cb: () => void) => () => void;
  getThumbnailsSnapshot?: () => Record<string, string>;
  ownerNames: Record<string, string>;
  can: {
    createFolder: boolean;
    /** Folder settings: FPS, shared */
    editFolder: boolean;
    addCel: boolean;
    /** Entries this viewer may time, move or delete */
    editableEntryIds: Set<string>;
    /** Tracks this viewer may put cels into (own folders and shared ones) */
    addableFolderIds: Set<string>;
  };
  /**
   * Drag and drop: the entries (one, or a multi-selection) go to that track, each `delta` frames
   * later (earlier if negative). Other cels keep their frames; a gap shows the drawing before it.
   */
  onPlaceEntries: (entryIds: string[], folderId: string, delta: number) => void;
  /** Ctrl+C on the timeline: these entries of that track */
  onCopyEntries: (folderId: string, entryIds: string[]) => void;
  /** Ctrl+V on the timeline: the copied entries, the first one on `frame` of that track */
  onPasteEntries: (folderId: string, frame: number) => void;
  /** 順移: adding / deleting a cel moves the ones after it (off: neighbours give / take frames, later timing stays) */
  ripple: boolean;
  onToggleRipple: () => void;
  /** Timeline length in frames (the player gets it after this render, so it is passed in) */
  timelineLength: number;
  /** The timeline length was set by hand (else it runs to the end of the longest track) */
  lengthIsSet: boolean;
  /** Frames, or null for automatic */
  onSetLength: (frames: number | null) => void;
  /** Light table (透光桌): reference cels this viewer picked */
  lightTable: LightTableState;
  onUpdateLightTable: (fn: (state: LightTableState) => LightTableState) => void;
  /** Drag of an entry's right edge */
  onSetEntryHold: (entryId: string, hold: number) => void;
  onCreateFolder: () => void;
  onAddFrame: () => void;
  onDuplicateFrame: () => void;
  onReuseCel: (celId: string) => void;
  /** A blank frame at the playhead: this track shows nothing there */
  onAddBlank: () => void;
  /** The keyframe panel opened or closed (while it is open the canvas shows the motion, also when drawing) */
  onKeyframePanelChange?: (open: boolean) => void;
  onDeleteFrame: () => void;
  onMoveFrame: (direction: -1 | 1) => void;
  onSetHold: (hold: number) => void;
  /** Update ○/● mark or short memo on a cel */
  onUpdateCelMeta: (entryId: string, patch: { mark?: CelMark | null; note?: string | null }) => void;
  /** Save timeline frame labels on the edited folder */
  onUpdateLabels: (labels: TimelineLabel[]) => void;
  /** Repeat selected cels using ref entries (returns true if created) */
  onRepeatEntries: (folderId: string, entryIds: string[], opts: { mode: 'count' | 'toEnd'; count: number }) => Promise<boolean>;
  /** Rename cels in timeline appearance order (1, 2, 3...) */
  onRenameInOrder: (folderId: string) => void;
  /** Jump to previous (-1) or next (+1) transform keyframe */
  onJumpKeyframe?: (direction: -1 | 1) => void;
  onToggleShared: () => void;
  onFpsChange: (fps: number) => void;
  /** A click on a track: that folder becomes the edited one, at that frame */
  onSelectCell: (folderId: string, time: number) => void;
  planExport: (opts: AnimationExportPlanRequest) => AnimationExportPlan | null;
  planCelExport?: (opts: { folderIds: string[] }) => AnimationCelExportPlan | null;
  activeLayer?: LayerModel | null;
  canvasWidth?: number;
  canvasHeight?: number;
  onUpdateLayerKeyframes?: (layerId: string, keyframes: TransformKeyframe[]) => void;
  /** Live transform preview during direct canvas handle drag (before pointerup commit) */
  liveKeyframeEval?: EvaluatedTransform | null;
  showKeyframeHandles?: boolean;
  onToggleKeyframeHandles?: () => void;
  showMotionPath?: boolean;
  onToggleMotionPath?: () => void;
  /** Phase E1: 2D Camera layer & preview controls */
  cameraLayer?: LayerModel | null;
  cameraWindowOpen?: boolean;
  onToggleCameraWindow?: () => void;
  cameraPreviewActive?: boolean;
  onToggleCameraPreview?: () => void;
  /** Phase E2: Light Table floating ToolWindow toggle */
  lightWindowOpen?: boolean;
  onToggleLightWindow?: () => void;
  /** Phase E3: Local Audio Tracks & metadata */
  audioLayers?: LayerModel[];
  audioAssetSummaries?: Record<string, AudioAssetSummary>;
  audioWindowOpen?: boolean;
  onToggleAudioWindow?: () => void;
  audioScrubEnabled?: boolean;
  onToggleAudioScrub?: () => void;
  onToggleAudioMute?: (layerId: string) => void;
}

const TRACK_LABEL_WIDTH = 96;
const CELL = 36; // px per timeline frame
const RULER_HEIGHT = 20;
const ROW = 50;
const PANEL_LEAVE_MS = 110;
const TIMELINE_LEAVE_MS = 200;
/** The chip beside each onion skin look, in the "before" colour: flat, shaded light to dark, or the drawing's own greys */
const onionSwatch = (mode: OnionMode, color: string) =>
  mode === 'tint'
    ? color
    : mode === 'shade'
      ? `linear-gradient(135deg, color-mix(in srgb, ${color} 30%, black), ${color} 50%, color-mix(in srgb, ${color} 25%, white))`
      : 'linear-gradient(135deg, #262626, #a3a3a3 55%, #f5f5f5)';
const prefersReducedMotion = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * CSP-style timeline: one row per animation folder, one column per frame. A cel spans as many
 * frames as it is held; a reused cel (↻) shows another cel's drawing again. Cels and their timing
 * are layers, so every change is synced and saved; the frame on screen, playback range and onion
 * skin are this viewer's own.
 */
const EMPTY_THUMBS: Record<string, string> = {};
const noopSubscribe = () => () => {};
const AnimThumbImg: React.FC<{
  layerId: string;
  thumbnails: Record<string, string>;
  subscribeThumbnails?: (cb: () => void) => () => void;
  getThumbnailsSnapshot?: () => Record<string, string>;
  className: string;
}> = ({ layerId, thumbnails, subscribeThumbnails, getThumbnailsSnapshot, className }) => {
  const url = useSyncExternalStore(
    subscribeThumbnails ?? noopSubscribe,
    () => (getThumbnailsSnapshot ? getThumbnailsSnapshot()[layerId] : thumbnails[layerId]),
  );
  return url ? <img src={url} alt="" className={className} /> : null;
};

export const AnimationTimelineBar: React.FC<AnimationTimelineBarProps> = ({
  engine, isOpen, onClose, tracks, activeFolderId, thumbnails = EMPTY_THUMBS, subscribeThumbnails, getThumbnailsSnapshot, ownerNames, can,
  onCreateFolder, onAddFrame, onDuplicateFrame, onReuseCel, onAddBlank, onKeyframePanelChange, onDeleteFrame, onMoveFrame, onSetHold, onUpdateCelMeta, onUpdateLabels, onRepeatEntries, onRenameInOrder, onJumpKeyframe, onToggleShared, onFpsChange,
  onSelectCell, planExport, planCelExport, onPlaceEntries, onCopyEntries, onPasteEntries, onSetEntryHold, ripple, onToggleRipple,
  timelineLength, lengthIsSet, onSetLength, lightTable, onUpdateLightTable,
  activeLayer, canvasWidth = 1920, canvasHeight = 1080, onUpdateLayerKeyframes,
  liveKeyframeEval, showKeyframeHandles, onToggleKeyframeHandles, showMotionPath, onToggleMotionPath,
  cameraLayer = null, cameraWindowOpen = false, onToggleCameraWindow, cameraPreviewActive = false, onToggleCameraPreview,
  lightWindowOpen = false, onToggleLightWindow,
  audioLayers = [], audioAssetSummaries = {}, audioWindowOpen = false, onToggleAudioWindow, audioScrubEnabled = false, onToggleAudioScrub, onToggleAudioMute,
}) => {
  const { t } = useI18n();
  const isPhone = usePhoneLayout();
  const trackLabelWidth = isPhone ? 72 : TRACK_LABEL_WIDTH;
  const [phoneDrawerOpen, setPhoneDrawerOpen] = useState(false);
  // Drag a cel (or the selected cels) to other frames or another track, or its right edge to change how long it stays
  const [drag, setDrag] = useState<null | {
    entryId: string; ids: string[]; fromFolderId: string; mode: 'move' | 'hold'; startX: number; startY: number; started: boolean;
    /** Frame under the pointer when the drag began; the cels move by (frame under the pointer − this) */
    downFrame: number; folderId: string; delta: number; hold: number; origHold: number; origStart: number;
  }>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Multi-selection (one track): Ctrl / ⌘ / Shift + click, or the 多選 toggle on touch screens
  const [selection, setSelection] = useState<{ folderId: string; ids: Set<string> } | null>(null);
  const [multiMode, setMultiMode] = useState(false);
  const lastPickRef = useRef<string | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const suppressClickRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(engine.getIsPlaying());
  const [time, setTime] = useState(engine.getTime());
  const [range, setRange] = useState(engine.getRange());
  const [onionSkin, setOnionSkin] = useState<OnionSkinConfig>(engine.getOnionSkinConfig());
  const [isCollapsed, setIsCollapsed] = useState(false);
  type Panel = null | 'onion' | 'range' | 'reuse' | 'keyframes' | 'light';
  const [panel, setPanelNow] = useState<Panel>(null);
  // Settings rows glide out before the next one glides in (the row is swapped, not stacked)
  const [panelLeaving, setPanelLeaving] = useState(false);
  const panelTimerRef = useRef(0);
  const setPanel = (next: Panel) => {
    if (next === panel) return;
    window.clearTimeout(panelTimerRef.current);
    if (prefersReducedMotion()) {
      setPanelNow(next);
      return;
    }
    setPanelLeaving(true);
    panelTimerRef.current = window.setTimeout(() => {
      setPanelLeaving(false);
      setPanelNow(next);
    }, PANEL_LEAVE_MS);
  };
  useEffect(() => () => window.clearTimeout(panelTimerRef.current), []);
  useEffect(() => {
    onKeyframePanelChange?.(panel === 'keyframes');
  }, [panel, onKeyframePanelChange]);
  // Opening slides the timeline up from the bottom edge; closing slides it back down before it goes
  const [retained, setRetained] = useState(isOpen);
  useEffect(() => {
    if (isOpen) {
      setRetained(true);
      return;
    }
    if (prefersReducedMotion()) {
      setRetained(false);
      return;
    }
    const id = window.setTimeout(() => setRetained(false), TIMELINE_LEAVE_MS);
    return () => window.clearTimeout(id);
  }, [isOpen]);
  const [loop, setLoop] = useState(engine.getLoop());
  // Seconds + frames (CSP "1+5") or frame numbers: this viewer's own
  const [timecode, setTimecode] = useState<TimecodeMode>(() => {
    try {
      return localStorage.getItem('atelier_anim_timecode') === 'frames' ? 'frames' : 'sf';
    } catch {
      return 'sf';
    }
  });
  const toggleTimecode = () => {
    const next: TimecodeMode = timecode === 'sf' ? 'frames' : 'sf';
    setTimecode(next);
    try { localStorage.setItem('atelier_anim_timecode', next); } catch { /* kept for this session */ }
  };
  const [lengthDraft, setLengthDraft] = useState<string | null>(null);
  const [jumpDraft, setJumpDraft] = useState<string | null>(null);
  const [flipSpan, setFlipSpan] = useState(() => engine.getFlipSpan());
  const [flipping, setFlipping] = useState(false);
  const [lightKind, setLightKind] = useState<LightTableScope['kind']>('cel');
  const [bezierDragIdx, setBezierDragIdx] = useState<null | 1 | 2>(null);
  const [gridViewport, setGridViewport] = useState({ left: 0, width: 960 });
  const [showExportModal, setShowExportModal] = useState(false);
  const [celMenu, setCelMenu] = useState<{ entryId: string; x: number; y: number } | null>(null);
  const [noteModal, setNoteModal] = useState<{ entryId: string; label: string; text: string } | null>(null);
  const [labelModal, setLabelModal] = useState<{ frame: number; text: string; existing: boolean } | null>(null);
  const [repeatModal, setRepeatModal] = useState<{ folderId: string; entryIds: string[]; mode: 'count' | 'toEnd'; count: number; busy: boolean } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const fps = engine.getFps();

  useEffect(() => {
    if (!isOpen) return;
    setTime(engine.getTime());
    setIsPlaying(engine.getIsPlaying());
    const unsubFrame = engine.onFrameChange((t) => {
      setTime(t);
      setFlipSpan(engine.getFlipSpan());
      setFlipping(engine.isFlipping());
      const nextRange = engine.getRange();
      setRange((prev) => (prev?.start === nextRange?.start && prev?.end === nextRange?.end ? prev : nextRange));
      const nextOnion = engine.getOnionSkinConfig();
      setOnionSkin((prev) =>
        prev.enabled === nextOnion.enabled &&
        prev.prevFramesCount === nextOnion.prevFramesCount &&
        prev.nextFramesCount === nextOnion.nextFramesCount &&
        prev.opacity === nextOnion.opacity &&
        prev.prevColor === nextOnion.prevColor &&
        prev.nextColor === nextOnion.nextColor &&
        prev.mode === nextOnion.mode
          ? prev
          : nextOnion
      );
    });
    const unsubPlay = engine.onPlaybackStateChange((playing) => {
      setIsPlaying(playing);
      setLoop(engine.getLoop());
    });
    return () => {
      unsubFrame();
      unsubPlay();
    };
  }, [engine, isOpen]);

  useEffect(() => {
    const el = gridRef.current;
    if (!el || !isOpen || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const bucketLeft = Math.floor(el.scrollLeft / (CELL * 4)) * (CELL * 4);
      const w = el.clientWidth || 960;
      setGridViewport((prev) => (prev.left === bucketLeft && prev.width === w ? prev : { left: bucketLeft, width: w }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpen]);

  // Keep the playhead in view (playback, keyboard stepping)
  useEffect(() => {
    if (!isOpen) return;
    const el = gridRef.current;
    if (!el) return;
    const x = trackLabelWidth + time * CELL;
    if (x < el.scrollLeft + trackLabelWidth || x + CELL > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.max(0, x - trackLabelWidth - CELL * 2);
  }, [time, isOpen, trackLabelWidth]);

  // While dragging: follow the pointer over the tracks; drop moves the cel or sets its hold
  const activeLabels = tracks.find((tr) => tr.folderId === activeFolderId)?.labels ?? [];
  const showLabelRow = activeLabels.length > 0;
  const activeKfs = activeLayer?.meta?.keyframes ?? [];
  const showKfRow = Boolean(activeLayer && (panel === 'keyframes' || activeKfs.length > 0));
  const dragging = Boolean(drag);
  useEffect(() => {
    if (!dragging) return;
    const at = (e: PointerEvent) => {
      const el = gridRef.current!;
      const r = el.getBoundingClientRect();
      const trackTop = RULER_HEIGHT * (1 + (showLabelRow ? 1 : 0) + (showKfRow ? 1 : 0));
      return { t: (e.clientX - r.left + el.scrollLeft - trackLabelWidth) / CELL, row: Math.floor((e.clientY - r.top + el.scrollTop - trackTop) / ROW) };
    };
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.started && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
      const { t, row } = at(e);
      if (d.mode === 'hold') {
        // Long holds: the grid scrolls on when the edge is dragged near its sides
        const el = gridRef.current!;
        const r = el.getBoundingClientRect();
        if (e.clientX > r.right - 28) el.scrollLeft += CELL;
        else if (e.clientX < r.left + trackLabelWidth + 28) el.scrollLeft = Math.max(0, el.scrollLeft - CELL);
        setDrag({ ...d, started: true, hold: Math.max(1, Math.min(MAX_HOLD, Math.round(t - d.origStart))) });
        return;
      }
      const track = tracks[Math.max(0, Math.min(tracks.length - 1, row))];
      const folderId = track && (track.folderId === d.fromFolderId || can.addableFolderIds.has(track.folderId)) ? track.folderId : d.folderId;
      // By whole frames, wherever the pointer is (a gap is fine); none of the cels before frame 1
      const from = tracks.find((tr) => tr.folderId === d.fromFolderId)?.entries ?? [];
      const earliest = Math.min(...d.ids.map((id) => {
        const i = from.findIndex((x) => x.id === id);
        return i < 0 ? 0 : entryStart(from, i);
      }));
      const delta = Math.max(-earliest, Math.floor(t) - d.downFrame);
      setDrag({ ...d, started: true, folderId, delta });
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d?.started) return;
      // The click that follows the drop is not a frame pick. Released over another element there
      // is no click at all, so the flag must not wait for one (it used to eat the next real click)
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 0);
      if (d.mode === 'hold') {
        if (d.hold !== d.origHold) onSetEntryHold(d.entryId, d.hold);
        return;
      }
      if (d.folderId !== d.fromFolderId || d.delta !== 0) onPlaceEntries(d.ids, d.folderId, d.delta);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, tracks, can.addableFolderIds, onPlaceEntries, onSetEntryHold, showLabelRow, showKfRow, trackLabelWidth]);

  // Dismiss cel context menu on outside click or Escape
  useEffect(() => {
    if (!celMenu) return;
    const onDown = (ev: PointerEvent) => {
      if ((ev.target as HTMLElement | null)?.closest('[data-cel-menu]')) return;
      setCelMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setCelMenu(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [celMenu]);

  // A selection whose cels are gone (deleted, moved by someone) shrinks with them
  useEffect(() => {
    if (!selection) return;
    const live = new Set((tracks.find((t) => t.folderId === selection.folderId)?.entries ?? []).map((e) => e.id));
    const kept = [...selection.ids].filter((id) => live.has(id));
    if (kept.length !== selection.ids.size) setSelection(kept.length ? { folderId: selection.folderId, ids: new Set(kept) } : null);
  }, [tracks, selection]);

  const startDrag = (e: React.PointerEvent, track: AnimationTrack, index: number) => {
    const entry = track.entries[index];
    const handle = (e.target as HTMLElement).closest('[data-drag-handle], [data-hold-handle]');
    // Touch drags only from the handles, so swiping elsewhere still scrolls the timeline
    if (!can.editableEntryIds.has(entry.id) || e.button > 0 || (e.pointerType === 'touch' && !handle)) return;
    e.stopPropagation();
    const mode = handle?.hasAttribute('data-hold-handle') ? 'hold' : 'move';
    // Dragging one of the selected cels takes all of them along, in track order
    const group = mode === 'move' && selection?.folderId === track.folderId && selection.ids.has(entry.id) && selection.ids.size > 1
      ? track.entries.filter((x) => selection.ids.has(x.id)).map((x) => x.id)
      : [entry.id];
    const grid = gridRef.current;
    const downFrame = grid ? Math.floor((e.clientX - grid.getBoundingClientRect().left + grid.scrollLeft - trackLabelWidth) / CELL) : entryStart(track.entries, index);
    setDrag({
      entryId: entry.id, ids: group, fromFolderId: track.folderId, folderId: track.folderId, delta: 0, downFrame,
      mode, startX: e.clientX, startY: e.clientY, started: false,
      hold: entry.hold, origHold: entry.hold, origStart: entryStart(track.entries, index),
    });
  };

  /**
   * Like a file list (and Krita's timeline): a click selects that cel alone, Ctrl / ⌘ (or 多選)
   * adds or removes one, Shift selects the run from the last clicked cel (Ctrl+Shift adds it).
   * Returns true when the click only changed the selection (the playhead stays).
   */
  const pickForSelection = (e: React.MouseEvent, track: AnimationTrack, entryId: string) => {
    const same = selection?.folderId === track.folderId;
    const toggle = e.ctrlKey || e.metaKey || multiMode;
    if (e.shiftKey) {
      let a = track.entries.findIndex((x) => x.id === lastPickRef.current);
      if (a < 0) a = entryIndexAt(track.entries, time); // no anchor yet: the cel at the playhead
      const b = track.entries.findIndex((x) => x.id === entryId);
      const ids = new Set(toggle && same ? selection!.ids : []);
      const [lo, hi] = a >= 0 ? [Math.min(a, b), Math.max(a, b)] : [b, b];
      for (let i = lo; i <= hi; i++) if (can.editableEntryIds.has(track.entries[i].id)) ids.add(track.entries[i].id);
      setSelection(ids.size ? { folderId: track.folderId, ids } : null);
      return true;
    }
    lastPickRef.current = entryId;
    if (toggle) {
      const ids = new Set(same ? selection!.ids : []);
      if (ids.has(entryId)) ids.delete(entryId);
      else if (can.editableEntryIds.has(entryId)) ids.add(entryId);
      setSelection(ids.size ? { folderId: track.folderId, ids } : null);
      return true;
    }
    setSelection(can.editableEntryIds.has(entryId) ? { folderId: track.folderId, ids: new Set([entryId]) } : null);
    return false;
  };

  /** Ctrl+C copies the selected cels (else the one at the playhead); Ctrl+V pastes them at the playhead */
  const onTimelineKey = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    const key = e.key.toLowerCase();
    if (key === 'c') {
      const folderId = selection?.folderId ?? activeFolderId;
      const playheadCel = entries[entryIndexAt(entries, time)];
      const ids = selection ? [...selection.ids] : playheadCel ? [playheadCel.id] : [];
      if (!folderId || ids.length === 0) return;
      onCopyEntries(folderId, ids);
    } else if (key === 'v') {
      if (!activeFolderId) return;
      onPasteEntries(activeFolderId, time);
    } else return;
    // The canvas's own Ctrl+C / Ctrl+V (pixels) must not run as well
    e.preventDefault();
    e.stopPropagation();
  };

  const updateOnion = (patch: Partial<OnionSkinConfig>) => {
    engine.setOnionSkinConfig(patch);
    setOnionSkin(engine.getOnionSkinConfig());
  };

  const active = tracks.find((t) => t.folderId === activeFolderId) ?? null;
  const entries = active?.entries ?? [];
  const currentIdx = entryIndexAt(entries, time);
  const current = entries[currentIdx];
  const length = Math.max(1, timelineLength);
  const canEditEntry = Boolean(current && can.editableEntryIds.has(current.id));
  const realCels = entries.filter((e) => e.ref === undefined);

  // Onion neighbours of the edited folder, for marking them on the timeline
  const onionMarks = new Map<string, 'prev' | 'next'>();
  if (onionSkin.enabled && currentIdx >= 0) {
    const shown = celLayerOf(current);
    const mark = (step: -1 | 1, count: number, kind: 'prev' | 'next') => {
      const seen = new Set<string>(shown ? [shown] : []);
      for (let i = currentIdx + step; i >= 0 && i < entries.length && seen.size - (shown ? 1 : 0) < count; i += step) {
        const id = celLayerOf(entries[i]);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        onionMarks.set(entries[i].id, kind);
      }
    };
    mark(-1, onionSkin.prevFramesCount, 'prev');
    mark(1, onionSkin.nextFramesCount, 'next');
  }

  // Frames shown: the timeline plus room after it to put cels on (Krita shows empty frames too);
  // a cel's edge dragged past the end makes room as it goes
  const dragEnd = drag?.started && drag.mode === 'hold' ? drag.origStart + drag.hold : 0;
  const shownLength = Math.min(MAX_TIMELINE_FRAMES, Math.max(length, dragEnd)) + TIMELINE_SLACK;
  const timeAt = (e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(shownLength - 1, Math.floor((e.clientX - rect.left) / CELL)));
  };

  if (!isOpen && !retained) return null;
  const iconBtn = 'flex h-7 min-w-7 shrink-0 whitespace-nowrap items-center justify-center gap-0.5 rounded px-1 text-neutral-300 hover:bg-neutral-800 hover:text-white disabled:opacity-35 disabled:hover:bg-transparent';
  const chip = (on: boolean) => `flex h-7 shrink-0 whitespace-nowrap items-center gap-1 rounded-lg border px-2 text-[11px] font-bold disabled:opacity-40 ${on ? 'border-amber-500/60 bg-amber-500/15 text-amber-300' : 'border-neutral-700/70 text-neutral-300 hover:bg-neutral-800'}`;
  const stepper = (label: string, value: number, set: (n: number) => void, min: number, max: number) => (
    <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-neutral-400">
      {label}
      <button type="button" onClick={() => set(value - 1)} disabled={value <= min} aria-label={`${label} -1`} className={iconBtn}><Minus className="h-3 w-3" /></button>
      <span className="w-5 text-center font-mono text-xs font-bold text-white">{value}</span>
      <button type="button" onClick={() => set(value + 1)} disabled={value >= max} aria-label={`${label} +1`} className={iconBtn}><Plus className="h-3 w-3" /></button>
    </span>
  );
  const onionModeLabel = (m: OnionMode) => (m === 'tint' ? t.animation.onionModeTint : m === 'shade' ? t.animation.onionModeShade : t.animation.onionModeOriginal);
  /** A hold you can also type: the + / − buttons step by one, the box takes any number up to `max` */
  const holdStepper = (label: string, value: number, set: (n: number) => void, editable: boolean) => (
    <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-neutral-400">
      {label}
      <button type="button" onClick={() => set(value - 1)} disabled={!editable || value <= 1} aria-label={`${label} -1`} className={iconBtn}><Minus className="h-3 w-3" /></button>
      <input key={value} defaultValue={value} disabled={!editable} inputMode="numeric" aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          e.stopPropagation(); // typing digits must not step frames
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') { e.currentTarget.value = String(value); e.currentTarget.blur(); }
        }}
        onBlur={(e) => {
          const n = Math.round(Number(e.currentTarget.value));
          if (Number.isFinite(n) && n >= 1 && n !== value) set(Math.min(MAX_HOLD, n));
          else e.currentTarget.value = String(value);
        }}
        className="atelier-field h-6 w-11 px-1 text-center font-mono text-xs font-bold text-white disabled:opacity-60" />
      <button type="button" onClick={() => set(value + 1)} disabled={!editable || value >= MAX_HOLD} aria-label={`${label} +1`} className={iconBtn}><Plus className="h-3 w-3" /></button>
    </span>
  );
  const tc = (frame: number) => formatTimecode(frame, fps, timecode);
  const rangeText = range ? `${tc(range.start)}–${tc(range.end)}` : t.animation.rangeAll;
  // Light table of the cel on screen, or of the whole edited track (including E2 external refs)
  const currentCel = celLayerOf(current);
  const lightScope: LightTableScope | null = lightKind === 'track' ? (activeFolderId ? { kind: 'track', id: activeFolderId } : null) : currentCel ? { kind: 'cel', id: currentCel } : null;
  const lightNow = lightIdsFor(lightTable, activeFolderId, currentCel);
  const lightExternalNow = externalRefsFor(lightTable, activeFolderId, currentCel, { visibleOnly: true });
  const hasTimelineContent = tracks.length > 0 || Boolean(cameraLayer) || audioLayers.length > 0;
  const lightCount = lightNow.size + lightExternalNow.length;
  const commitLength = () => {
    if (lengthDraft === null) return;
    const frame = parseTimecode(lengthDraft, fps);
    setLengthDraft(null);
    if (frame !== null) onSetLength(Math.min(MAX_TIMELINE_FRAMES, frame + 1));
  };
  const commitJump = () => {
    if (jumpDraft === null) return;
    const target = parseTimecode(jumpDraft, fps);
    setJumpDraft(null);
    if (target !== null) engine.goTo(target);
  };
  const startHoldFlip = () => {
    engine.startFlipLoop();
    setFlipping(engine.isFlipping());
  };
  const stopHoldFlip = () => {
    engine.endFlip();
    setFlipping(false);
  };

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onTimelineKey} data-anim-timeline data-phone={isPhone ? '1' : undefined} data-phase={isOpen ? 'open' : 'closing'} style={{ touchAction: 'none' }}
      className={`atelier-timeline relative z-10 flex shrink-0 flex-col overflow-hidden border-t border-neutral-800 bg-neutral-950/95 outline-none transition-all duration-200 ${
        isCollapsed ? 'h-10' : isPhone ? 'h-40 max-h-[44vh]' : 'h-52 sm:h-56'
      } ${isOpen ? '' : 'pointer-events-none'}`}>
      {/* Transport */}
      <div style={{ touchAction: 'pan-x' }} role="toolbar" aria-label={t.animation.timeline}
        className="no-scrollbar flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-800/80 bg-neutral-900/90 px-2 text-xs text-neutral-300">
        {!isPhone && (
          <div className="flex shrink-0 items-center gap-1.5 border-r border-neutral-800 pr-2 font-bold text-white">
            <Film className="h-4 w-4 text-rose-400" />
            <span className="max-w-[8rem] truncate" title={active?.name}>{active?.name ?? t.animation.timeline}</span>
            {active?.shared && <span title={t.animation.sharedFolderTooltip} className="rounded bg-sky-500/20 px-1 text-[9px] text-sky-300">{t.animation.trackShared}</span>}
          </div>
        )}
        {hasTimelineContent && isPhone && (
          <>
            <button type="button" onClick={() => engine.goToPrevFrame()} title={t.animation.prevCel} aria-label={t.animation.prevCel} className={`${iconBtn} h-8 min-w-8`}><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" onClick={() => engine.togglePlay()} disabled={(range ? range.end - range.start + 1 : length) < 2}
              title={isPlaying ? t.animation.pause : t.animation.play} aria-label={isPlaying ? t.animation.pause : t.animation.play}
              className={`flex h-8 shrink-0 items-center justify-center rounded-lg px-2.5 text-xs font-bold text-white shadow disabled:opacity-40 ${isPlaying ? 'bg-amber-600' : 'bg-rose-600'}`}>
              {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </button>
            <button type="button" onClick={() => engine.goToNextFrame()} title={t.animation.nextCel} aria-label={t.animation.nextCel} className={`${iconBtn} h-8 min-w-8`}><ChevronRight className="h-4 w-4" /></button>
            <span className="flex shrink-0 items-center font-mono text-[11px] text-neutral-400">
              {jumpDraft !== null ? (
                <input
                  autoFocus
                  data-jump-input
                  aria-label={t.animation.jumpToFrame}
                  placeholder={t.animation.jumpToFramePlaceholder}
                  value={jumpDraft}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setJumpDraft(e.target.value)}
                  onBlur={commitJump}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') {
                      setJumpDraft(null);
                      e.currentTarget.blur();
                    }
                  }}
                  className="atelier-field h-7 w-14 px-1 text-center font-mono text-[11px] text-white"
                />
              ) : (
                <button
                  type="button"
                  data-jump-trigger
                  onClick={() => setJumpDraft(formatTimecode(time, fps, timecode))}
                  title={t.animation.jumpToFrame}
                  aria-label={t.animation.jumpToFrame}
                  className="rounded px-1 font-mono text-[11px] text-neutral-200 hover:bg-neutral-800"
                >
                  {formatTimecode(time, fps, timecode)}
                </button>
              )}
            </span>
            <button type="button" data-phone-add-cel onClick={onAddFrame} disabled={!can.addCel} title={t.animation.addCel} aria-label={t.animation.addCel}
              className="flex h-8 shrink-0 items-center gap-0.5 rounded-lg border border-indigo-500/50 bg-indigo-500/20 px-2 text-[11px] font-bold text-indigo-200 disabled:opacity-40">
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button type="button" data-phone-onion-toggle onClick={() => updateOnion({ enabled: !onionSkin.enabled })} aria-pressed={onionSkin.enabled}
              title={t.animation.onionSkin} aria-label={t.animation.onionSkin} className={`${chip(onionSkin.enabled)} h-8 px-2`}>
              <Eye className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              data-flip-btn
              disabled={length < 2}
              aria-pressed={flipping}
              title={t.animation.flipbookTooltip}
              onPointerDown={(e) => {
                if (e.button > 0) return;
                e.preventDefault();
                startHoldFlip();
              }}
              onPointerUp={stopHoldFlip}
              onPointerLeave={stopHoldFlip}
              onPointerCancel={stopHoldFlip}
              className={`${chip(flipping)} h-8 px-2`}
            >
              {t.animation.flipbook}
            </button>
            <button type="button" data-phone-more onClick={() => setPhoneDrawerOpen(true)} title={t.animation.moreOptions} aria-label={t.animation.moreOptions}
              className={`${iconBtn} ml-auto h-8 px-2 border border-neutral-700/70 rounded-lg text-[11px]`}>
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </button>
          </>
        )}
        {hasTimelineContent && !isPhone && (
          <>
            <button type="button" onClick={() => engine.goToStart()} title={t.animation.firstCel} aria-label={t.animation.firstCel} className={iconBtn}><SkipBack className="h-3.5 w-3.5" /></button>
            <button type="button" onClick={() => engine.goToPrevFrame()} title={t.animation.prevCel} aria-label={t.animation.prevCel} className={iconBtn}><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" onClick={() => engine.togglePlay()} disabled={(range ? range.end - range.start + 1 : length) < 2}
              title={isPlaying ? t.animation.pause : t.animation.play}
              className={`flex shrink-0 whitespace-nowrap items-center gap-1 rounded-lg px-3 py-1 text-xs font-bold text-white shadow disabled:opacity-40 ${isPlaying ? 'bg-amber-600 hover:bg-amber-500' : 'bg-rose-600 hover:bg-rose-500'}`}>
              {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              <span>{isPlaying ? t.animation.pause : t.animation.play}</span>
            </button>
            <button type="button" onClick={() => engine.goToNextFrame()} title={t.animation.nextCel} aria-label={t.animation.nextCel} className={iconBtn}><ChevronRight className="h-4 w-4" /></button>
            <button type="button" onClick={() => engine.goToEnd()} title={t.animation.lastCel} aria-label={t.animation.lastCel} className={iconBtn}><SkipForward className="h-3.5 w-3.5" /></button>
            <button type="button" onClick={() => engine.setLoop(!loop)} aria-pressed={loop} title={t.animation.loop} aria-label={t.animation.loop}
              className={`${iconBtn} ${loop ? 'bg-amber-500/15 !text-amber-300' : ''}`}><Repeat2 className="h-3.5 w-3.5" /></button>
            <span className="flex shrink-0 items-center font-mono text-[11px] text-neutral-400">
              {jumpDraft !== null ? (
                <input
                  autoFocus
                  data-jump-input
                  aria-label={t.animation.jumpToFrame}
                  placeholder={t.animation.jumpToFramePlaceholder}
                  value={jumpDraft}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setJumpDraft(e.target.value)}
                  onBlur={commitJump}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') {
                      setJumpDraft(null);
                      e.currentTarget.blur();
                    }
                  }}
                  className="atelier-field h-6 w-16 px-1 text-center font-mono text-[11px] text-white"
                />
              ) : (
                <button
                  type="button"
                  data-jump-trigger
                  onClick={() => setJumpDraft(formatTimecode(time, fps, timecode))}
                  title={t.animation.jumpToFrame}
                  aria-label={t.animation.jumpToFrame}
                  className="rounded px-1 font-mono text-[11px] text-neutral-200 hover:bg-neutral-800 hover:text-white"
                >
                  {formatTimecode(time, fps, timecode)}
                </button>
              )}
              <button
                type="button"
                onClick={toggleTimecode}
                title={t.animation.timecodeToggle}
                aria-label={t.animation.timecodeToggle}
                className="rounded px-0.5 font-mono text-[11px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
              >
                /{formatTimecode(length - 1, fps, timecode)}
              </button>
            </span>
            <button
              type="button"
              data-flip-btn
              disabled={length < 2}
              aria-pressed={flipping}
              title={t.animation.flipbookTooltip}
              onPointerDown={(e) => {
                if (e.button > 0) return;
                e.preventDefault();
                startHoldFlip();
              }}
              onPointerUp={stopHoldFlip}
              onPointerLeave={stopHoldFlip}
              onPointerCancel={stopHoldFlip}
              className={chip(flipping)}
            >
              {t.animation.flipbook} ±{flipSpan}
            </button>
            <label className="ml-1 flex shrink-0 items-center gap-1 border-l border-neutral-800 pl-2" title={t.animation.fpsTooltip}>
              <span className="text-[10px] font-bold text-neutral-500">FPS</span>
              <select value={fps} disabled={!can.editFolder} onChange={(e) => onFpsChange(Number(e.target.value))} aria-label={t.animation.fpsAria}
                className="atelier-field h-6 px-1 text-[11px]">
                {[6, 8, 12, 15, 24, 30].map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => setPanel(panel === 'onion' ? null : 'onion')} aria-pressed={panel === 'onion'}
              title={t.animation.onionSkinTooltip} className={chip(onionSkin.enabled)}>
              <Eye className="h-3.5 w-3.5" />{t.animation.onionSkin}
              {onionSkin.enabled && <span className="font-mono text-[10px]">-{onionSkin.prevFramesCount}/+{onionSkin.nextFramesCount}</span>}
            </button>
            <button
              type="button"
              data-testid="timeline-light-table-btn"
              onClick={() => (onToggleLightWindow ? onToggleLightWindow() : setPanel(panel === 'light' ? null : 'light'))}
              aria-pressed={onToggleLightWindow ? lightWindowOpen : panel === 'light'}
              title={t.animation.lightTableTooltip}
              className={chip(lightWindowOpen || (lightTable.enabled && lightCount > 0))}
            >
              <Lamp className="h-3.5 w-3.5" />{t.animation.lightTable}
              {lightTable.enabled && lightCount > 0 && <span className="font-mono text-[10px]">{lightCount}</span>}
            </button>
            {onToggleCameraWindow && (
              <button
                type="button"
                data-testid="timeline-camera-btn"
                onClick={onToggleCameraWindow}
                aria-pressed={cameraWindowOpen}
                title={t.animation.cameraTooltip}
                className={chip(cameraWindowOpen || Boolean(cameraLayer))}
              >
                <Camera className="h-3.5 w-3.5" />{t.animation.camera}
              </button>
            )}
            {cameraLayer && onToggleCameraPreview && (
              <button
                type="button"
                data-testid="timeline-camera-preview-btn"
                onClick={onToggleCameraPreview}
                aria-pressed={cameraPreviewActive}
                title={t.animation.cameraPreview}
                className={chip(cameraPreviewActive)}
              >
                {cameraPreviewActive ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                <span className="hidden lg:inline">{t.animation.cameraPreview}</span>
              </button>
            )}
            {onToggleAudioWindow && (
              <button
                type="button"
                data-testid="timeline-audio-btn"
                onClick={onToggleAudioWindow}
                aria-pressed={audioWindowOpen}
                title={t.animation.audioTooltip}
                className={chip(audioWindowOpen || audioLayers.length > 0)}
              >
                <Music className="h-3.5 w-3.5" />{t.animation.audioTrack}
                {audioLayers.length > 0 && <span className="font-mono text-[10px]">{audioLayers.length}</span>}
              </button>
            )}
            <button type="button" onClick={() => setPanel(panel === 'range' ? null : 'range')} aria-pressed={panel === 'range'}
              title={t.animation.rangeTooltip} className={chip(Boolean(range))}>
              <Repeat className="h-3.5 w-3.5" />{t.animation.range} <span className="font-mono text-[10px]">{rangeText}</span>
            </button>
            <button type="button" onClick={() => setPanel(panel === 'keyframes' ? null : 'keyframes')} aria-pressed={panel === 'keyframes'}
              disabled={!activeLayer || !onUpdateLayerKeyframes}
              title={t.animation.keyframeSection}
                    className={chip(panel === 'keyframes' || Boolean(activeLayer?.meta?.keyframes?.length))}>
              <span className="text-[11px] leading-none">◆</span>{t.animation.keyframeSection}
              {Boolean(activeLayer?.meta?.keyframes?.length) && (
                <span className="font-mono text-[10px]">{activeLayer!.meta!.keyframes!.length}</span>
              )}
            </button>
            <button type="button" data-testid="timeline-export-btn" onClick={() => setShowExportModal(true)} title={t.animation.exportModalTitle}
              className="ml-auto flex h-7 shrink-0 whitespace-nowrap items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-600/20 px-2 text-[11px] font-bold text-emerald-300 hover:bg-emerald-600/30">
              <Download className="h-3 w-3" /><span className="hidden sm:inline">{t.common.export}</span>
            </button>
          </>
        )}
        <div className={`flex shrink-0 items-center ${hasTimelineContent ? '' : 'ml-auto'}`}>
          <button type="button" onClick={() => setIsCollapsed(!isCollapsed)} aria-label={isCollapsed ? t.animation.expandTimeline : t.animation.collapseTimeline} className={iconBtn}>
            {isCollapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          <button type="button" onClick={onClose} aria-label={t.animation.closeTimeline} className={iconBtn}><X className="h-3.5 w-3.5" /></button>
        </div>
      </div>

      {!isCollapsed && !hasTimelineContent && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-3 text-center text-[11px] text-neutral-400">
          <span>{t.animation.createFolderDesc}</span>
          <button type="button" onClick={onCreateFolder} disabled={!can.createFolder}
            className="atelier-btn atelier-btn--primary">
            <Plus className="h-3.5 w-3.5" />{t.animation.createFolder}
          </button>
        </div>
      )}

      {!isCollapsed && hasTimelineContent && (
        <>
          {/* Edit row, or the settings panel that is open (hidden on phone unless a sub-panel is active) */}
          {(!isPhone || panel !== null) && (
          <div key={panel ?? 'edit'} style={{ touchAction: 'pan-x' }}
            className={`atelier-tl-row no-scrollbar relative flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-800/60 px-2 text-[11px] text-neutral-300 ${panelLeaving ? 'is-leaving' : ''}`}>
            {panel === 'onion' && (
              <>
                <button type="button" onClick={() => updateOnion({ enabled: !onionSkin.enabled })} aria-pressed={onionSkin.enabled} className={chip(onionSkin.enabled)}>
                  {onionSkin.enabled ? t.animation.onionSkinOn : t.animation.onionSkinOff}
                </button>
                {stepper(t.animation.onionPrev, onionSkin.prevFramesCount, (n) => updateOnion({ prevFramesCount: n }), 0, MAX_ONION)}
                {stepper(t.animation.onionNext, onionSkin.nextFramesCount, (n) => updateOnion({ nextFramesCount: n }), 0, MAX_ONION)}
                <span role="radiogroup" aria-label={t.animation.onionMode} className="flex shrink-0 overflow-hidden rounded-lg border border-neutral-700/70">
                  {ONION_MODES.map((m) => {
                    const on = (onionSkin.mode ?? 'tint') === m;
                    return (
                      <button key={m} type="button" role="radio" aria-checked={on} onClick={() => updateOnion({ mode: m })}
                        className={`flex h-7 items-center gap-1 px-2 text-[11px] font-bold transition-colors ${on ? 'bg-amber-500/15 text-amber-300' : 'text-neutral-300 hover:bg-neutral-800'}`}>
                        <span aria-hidden className="atelier-onion-swatch h-3 w-3 shrink-0 rounded-[3px]" style={{ background: onionSwatch(m, onionSkin.prevColor) }} />
                        {onionModeLabel(m)}
                      </button>
                    );
                  })}
                </span>
                <label className="flex shrink-0 items-center gap-1 text-neutral-400">{t.animation.onionSkinOpacity}
                  <input type="range" min="0.05" max="0.9" step="0.05" value={onionSkin.opacity} aria-label={t.animation.onionSkinOpacity}
                    onChange={(e) => updateOnion({ opacity: parseFloat(e.target.value) })} className="h-1 w-16 cursor-pointer accent-amber-500" />
                </label>
                <label className="flex shrink-0 items-center gap-1 text-neutral-400">{t.animation.onionSkinPrev}
                  <input type="color" value={onionSkin.prevColor} onChange={(e) => updateOnion({ prevColor: e.target.value })} aria-label={t.animation.onionSkinPrev} className="h-5 w-5 cursor-pointer rounded" />
                </label>
                <label className="flex shrink-0 items-center gap-1 text-neutral-400">{t.animation.onionSkinNext}
                  <input type="color" value={onionSkin.nextColor} onChange={(e) => updateOnion({ nextColor: e.target.value })} aria-label={t.animation.onionSkinNext} className="h-5 w-5 cursor-pointer rounded" />
                </label>
                <span className="mx-1 h-4 w-px shrink-0 bg-neutral-800" />
                {stepper(t.animation.flipbookSpan, flipSpan, (n) => {
                  engine.setFlipSpan(n);
                  setFlipSpan(engine.getFlipSpan());
                }, 1, MAX_FLIP_SPAN)}
                <button type="button" onClick={() => setPanel(null)} className={`${iconBtn} ml-auto`}>{t.common.done}</button>
              </>
            )}
            {panel === 'range' && (
              <>
                <span className="shrink-0 text-neutral-400">{t.animation.range} <b className="font-mono text-white">{rangeText}</b></span>
                <button type="button" className={chip(false)} onClick={() => engine.setRange({ start: time, end: range?.end ?? length - 1 })}>[{tc(time)}</button>
                <button type="button" className={chip(false)} onClick={() => engine.setRange({ start: range?.start ?? 0, end: time })}>{tc(time)}]</button>
                <button type="button" className={chip(false)} disabled={!range} onClick={() => engine.setRange(null)}>{t.common.clear}</button>
                <label className="ml-2 flex shrink-0 items-center gap-1 border-l border-neutral-800 pl-2 text-neutral-400" title={t.animation.lengthTooltip}>
                  {t.animation.length}
                  <input value={lengthDraft ?? tc(length - 1)} disabled={!can.editFolder} aria-label={t.animation.lengthTooltip} inputMode="numeric"
                    onChange={(e) => setLengthDraft(e.target.value)} onBlur={commitLength}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setLengthDraft(null); e.currentTarget.blur(); } }}
                    className="atelier-field h-6 w-16 px-1 font-mono text-[11px]" />
                </label>
                <button type="button" className={chip(!lengthIsSet)} disabled={!can.editFolder || !lengthIsSet} onClick={() => onSetLength(null)}>{t.animation.lengthAuto}</button>
                <button type="button" onClick={() => setPanel(null)} className={`${iconBtn} ml-auto`}>{t.common.done}</button>
              </>
            )}
            {panel === 'light' && (
              <>
                <button type="button" onClick={() => onUpdateLightTable((s) => ({ ...s, enabled: !s.enabled }))} aria-pressed={lightTable.enabled} className={chip(lightTable.enabled)}>
                  {lightTable.enabled ? t.animation.lightTableOn : t.animation.lightTableOff}
                </button>
                <span className="flex shrink-0 overflow-hidden rounded-lg border border-neutral-700/70" role="group" aria-label={t.animation.lightTable}>
                  {(['cel', 'track'] as const).map((k) => (
                    <button key={k} type="button" onClick={() => setLightKind(k)} aria-pressed={lightKind === k}
                      className={`h-7 px-2 text-[11px] font-bold ${lightKind === k ? 'bg-amber-500/15 text-amber-300' : 'text-neutral-300 hover:bg-neutral-800'}`}>
                      {k === 'cel' ? t.animation.lightThisCel : t.animation.lightWholeTrack}
                    </button>
                  ))}
                </span>
                {realCels.map((e) => {
                  const on = Boolean(lightScope && lightTableHas(lightTable, lightScope, e.id));
                  return (
                    <button key={e.id} type="button" disabled={!lightScope || (lightKind === 'cel' && e.id === currentCel)} aria-pressed={on}
                      onClick={() => lightScope && onUpdateLightTable((s) => toggleLightCel(s, lightScope, e.id))} className={chip(on)}>
                      <AnimThumbImg layerId={e.id} thumbnails={thumbnails} subscribeThumbnails={subscribeThumbnails} getThumbnailsSnapshot={getThumbnailsSnapshot} className="h-5 w-5 rounded bg-white object-contain" />{e.label}
                    </button>
                  );
                })}
                <label className="flex shrink-0 items-center gap-1 text-neutral-400">{t.animation.lightOpacity}
                  <input type="range" min="0.05" max="1" step="0.05" value={lightTable.opacity} aria-label={t.animation.lightOpacity}
                    onChange={(e) => { const opacity = parseFloat(e.target.value); onUpdateLightTable((s) => ({ ...s, opacity })); }} className="h-1 w-16 cursor-pointer accent-amber-500" />
                </label>
                <button type="button" className={chip(false)} disabled={!lightScope || !lightCount}
                  onClick={() => lightScope && onUpdateLightTable((s) => clearLightTable(s, lightScope))}>{t.animation.lightClear}</button>
                <button type="button" onClick={() => setPanel(null)} className={`${iconBtn} ml-auto`}>{t.common.done}</button>
              </>
            )}
            {panel === 'reuse' && (
              <>
                <span className="shrink-0 text-neutral-400">{t.animation.cel}:</span>
                {realCels.map((e) => (
                  <button key={e.id} type="button" className={chip(false)} onClick={() => { onReuseCel(e.id); setPanel(null); }}>
                    <AnimThumbImg layerId={e.id} thumbnails={thumbnails} subscribeThumbnails={subscribeThumbnails} getThumbnailsSnapshot={getThumbnailsSnapshot} className="h-5 w-5 rounded bg-white object-contain" />{e.label}
                  </button>
                ))}
                <button type="button" onClick={() => setPanel(null)} className={`${iconBtn} ml-auto`}>{t.common.cancel}</button>
              </>
            )}
            {panel === 'keyframes' && activeLayer && onUpdateLayerKeyframes && (() => {
              const kfs = activeLayer.meta?.keyframes ?? [];
              const defPx = Math.round(canvasWidth / 2);
              const defPy = Math.round(canvasHeight / 2);
              const curEval = liveKeyframeEval ?? evaluateTransformKeyframes(kfs, time, defPx, defPy);
              const exactKf = kfs.find((k) => Math.round(k.frame) === time);
              const curEasing: KeyframeEasing = exactKf?.easing ?? 'easeInOut';
              const curBezier: [number, number, number, number] = exactKf?.bezier ?? [0.42, 0, 0.58, 1];
              const activePreset: KeyframeBezierPresetId | '' = curEasing === 'cubicBezier' ? (matchBezierPreset(curBezier) ?? '') : '';
              const presetLabel = (id: KeyframeBezierPresetId): string => {
                switch (id) {
                  case 'softEase': return t.animation.presetSoftEase;
                  case 'strongEase': return t.animation.presetStrongEase;
                  case 'decelerate': return t.animation.presetDecelerate;
                  case 'accelerate': return t.animation.presetAccelerate;
                  case 'softOvershoot': return t.animation.presetSoftOvershoot;
                  case 'strongOvershoot': return t.animation.presetStrongOvershoot;
                }
              };
              const commitKf = (patch: Partial<TransformKeyframe>) => {
                const nextKf: TransformKeyframe = {
                  frame: time,
                  x: exactKf?.x ?? Math.round(curEval.x),
                  y: exactKf?.y ?? Math.round(curEval.y),
                  scaleX: exactKf?.scaleX ?? curEval.scaleX,
                  scaleY: exactKf?.scaleY ?? curEval.scaleY,
                  rotation: exactKf?.rotation ?? curEval.rotation,
                  pivotX: exactKf?.pivotX ?? Math.round(curEval.pivotX),
                  pivotY: exactKf?.pivotY ?? Math.round(curEval.pivotY),
                  opacity: exactKf?.opacity ?? curEval.opacity,
                  easing: exactKf?.easing ?? curEasing,
                  bezier: exactKf?.bezier ?? curBezier,
                  ...patch,
                };
                onUpdateLayerKeyframes(activeLayer.id, upsertTransformKeyframe(kfs, nextKf));
              };
              const numBox = (
                label: string,
                val: number,
                step: number,
                onSet: (n: number) => void,
                opts?: { w?: string; min?: number; max?: number; testId?: string }
              ) => (
                <label className="flex shrink-0 items-center gap-0.5 text-[10px] text-neutral-400">
                  <span className="whitespace-nowrap">{label}</span>
                  <input
                    type="number"
                    step={step}
                    min={opts?.min}
                    max={opts?.max}
                    data-testid={opts?.testId}
                    value={Number.isFinite(val) ? Number(val.toFixed(1)) : 0}
                    onChange={(e) => {
                      const n = parseFloat(e.target.value);
                      if (Number.isFinite(n)) onSet(n);
                    }}
                    className={`h-6 ${opts?.w ?? 'w-12'} rounded border border-neutral-700 bg-neutral-900 px-1 font-mono text-[10px] text-white outline-none`}
                  />
                </label>
              );
              // Expanded Y range [-0.6, 1.6] so overshoot presets render completely without clipping
              const BEZ_Y_MIN = -0.6;
              const BEZ_Y_MAX = 1.6;
              const BEZ_Y_SPAN = BEZ_Y_MAX - BEZ_Y_MIN;
              const updateBezierPoint = (svg: SVGSVGElement, clientX: number, clientY: number, idx: 1 | 2) => {
                const rect = svg.getBoundingClientRect();
                const nx = Math.max(0, Math.min(1, Number((((clientX - rect.left - 4) / Math.max(1, rect.width - 8))).toFixed(2))));
                const ny = Math.max(BEZ_Y_MIN, Math.min(BEZ_Y_MAX, Number((BEZ_Y_MAX - ((clientY - rect.top - 4) / Math.max(1, rect.height - 8)) * BEZ_Y_SPAN).toFixed(2))));
                const b: [number, number, number, number] = [...curBezier];
                if (idx === 1) { b[0] = nx; b[1] = ny; } else { b[2] = nx; b[3] = ny; }
                commitKf({ easing: 'cubicBezier', bezier: b });
              };
              const mapX = (u: number) => 4 + u * 48;
              const mapY = (v: number) => 4 + ((BEZ_Y_MAX - Math.max(BEZ_Y_MIN, Math.min(BEZ_Y_MAX, v))) / BEZ_Y_SPAN) * 48;
              return (
                <>
                  <span className="shrink-0 truncate max-w-[84px] text-[10px] font-semibold text-indigo-300">{activeLayer.name}</span>
                  {onJumpKeyframe && (
                    <>
                      <button type="button" onClick={() => onJumpKeyframe(-1)} title={t.animation.prevKeyframe} aria-label={t.animation.prevKeyframe} className={iconBtn}>◀◆</button>
                      <button type="button" onClick={() => onJumpKeyframe(1)} title={t.animation.nextKeyframe} aria-label={t.animation.nextKeyframe} className={iconBtn}>◆▶</button>
                    </>
                  )}
                  <button type="button" onClick={() => commitKf({})} className={chip(Boolean(exactKf))}>
                    ◆ {t.animation.keyframeAdd}
                  </button>
                  <button
                    type="button"
                    disabled={!exactKf}
                    onClick={() => onUpdateLayerKeyframes(activeLayer.id, removeTransformKeyframe(kfs, time))}
                    className={iconBtn}
                  >
                    <Trash2 className="h-3 w-3" />{t.animation.keyframeRemove}
                  </button>
                  <button
                    type="button"
                    onClick={() => commitKf({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: defPx, pivotY: defPy, opacity: 1 })}
                    className={iconBtn}
                  >
                    {t.animation.keyframeReset}
                  </button>
                  {onToggleKeyframeHandles && (
                    <button
                      type="button"
                      onClick={onToggleKeyframeHandles}
                      aria-pressed={Boolean(showKeyframeHandles)}
                      title={t.animation.keyframeHandlesTooltip}
                      data-testid="keyframe-handles-toggle"
                      className={chip(Boolean(showKeyframeHandles))}
                    >
                      {t.animation.keyframeHandles}
                    </button>
                  )}
                  {onToggleMotionPath && (
                    <button
                      type="button"
                      onClick={onToggleMotionPath}
                      aria-pressed={Boolean(showMotionPath)}
                      title={t.animation.motionPathTooltip}
                      data-testid="keyframe-motion-path-toggle"
                      className={chip(Boolean(showMotionPath))}
                    >
                      {t.animation.motionPath}
                    </button>
                  )}
                  {numBox(t.animation.keyframeX, curEval.x, 2, (v) => commitKf({ x: v }), { testId: 'keyframe-x-input' })}
                  {numBox(t.animation.keyframeY, curEval.y, 2, (v) => commitKf({ y: v }), { testId: 'keyframe-y-input' })}
                  {numBox(t.animation.keyframeScale, curEval.scaleX * 100, 5, (v) => { const s = Math.max(0.05, v / 100); commitKf({ scaleX: s, scaleY: s }); }, { testId: 'keyframe-scale-input' })}
                  {numBox(t.animation.keyframeRotation, (curEval.rotation * 180) / Math.PI, 5, (deg) => commitKf({ rotation: (deg * Math.PI) / 180 }), { testId: 'keyframe-rot-input' })}
                  {numBox(t.animation.keyframeOpacity, curEval.opacity * 100, 5, (pct) => commitKf({ opacity: Math.max(0, Math.min(1, pct / 100)) }), { min: 0, max: 100, testId: 'keyframe-opacity-input' })}
                  {numBox(t.animation.keyframePivotX, curEval.pivotX, 4, (v) => commitKf({ pivotX: v }), { testId: 'keyframe-pivot-x-input' })}
                  {numBox(t.animation.keyframePivotY, curEval.pivotY, 4, (v) => commitKf({ pivotY: v }), { testId: 'keyframe-pivot-y-input' })}
                  <label className="flex shrink-0 items-center gap-1 text-[10px] text-neutral-400">
                    <span className="whitespace-nowrap">{t.animation.keyframeEasing}</span>
                    <select
                      value={curEasing}
                      data-testid="keyframe-easing-select"
                      onChange={(e) => commitKf({ easing: e.target.value as KeyframeEasing })}
                      className="h-6 rounded border border-neutral-700 bg-neutral-900 px-1 text-[10px] text-white outline-none"
                    >
                      <option value="linear">{t.animation.easingLinear}</option>
                      <option value="easeIn">{t.animation.easingEaseIn}</option>
                      <option value="easeOut">{t.animation.easingEaseOut}</option>
                      <option value="easeInOut">{t.animation.easingEaseInOut}</option>
                      <option value="step">{t.animation.easingStep}</option>
                      <option value="cubicBezier">{t.animation.easingBezier}</option>
                    </select>
                  </label>
                  <label className="flex shrink-0 items-center gap-1 text-[10px] text-neutral-400">
                    <span className="whitespace-nowrap">{t.animation.keyframePreset}</span>
                    <select
                      value={activePreset}
                      data-testid="keyframe-preset-select"
                      onChange={(e) => {
                        const preset = BEZIER_PRESETS.find((p) => p.id === e.target.value);
                        if (preset) commitKf({ easing: 'cubicBezier', bezier: [...preset.bezier] });
                      }}
                      className="h-6 rounded border border-neutral-700 bg-neutral-900 px-1 text-[10px] text-white outline-none"
                    >
                      <option value="">{t.animation.presetCustom}</option>
                      {BEZIER_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>{presetLabel(p.id)}</option>
                      ))}
                    </select>
                  </label>
                  {curEasing === 'cubicBezier' && (
                    <div className="relative flex shrink-0 items-center gap-1 rounded border border-neutral-700 bg-neutral-900/90 px-1.5 py-0.5" title={t.animation.keyframeBezierHint}>
                      <svg
                        width={56}
                        height={56}
                        viewBox="0 0 56 56"
                        data-testid="keyframe-bezier-svg"
                        className="h-7 w-7 cursor-crosshair touch-none overflow-visible"
                        onPointerMove={(e) => { if (bezierDragIdx) updateBezierPoint(e.currentTarget, e.clientX, e.clientY, bezierDragIdx); }}
                        onPointerUp={() => setBezierDragIdx(null)}
                        onPointerCancel={() => setBezierDragIdx(null)}
                      >
                        <rect
                          x={mapX(0)}
                          y={mapY(1)}
                          width={mapX(1) - mapX(0)}
                          height={mapY(0) - mapY(1)}
                          fill="none"
                          stroke="#374151"
                          strokeWidth="0.75"
                          strokeDasharray="2 2"
                        />
                        <line x1={mapX(0)} y1={mapY(0)} x2={mapX(1)} y2={mapY(1)} stroke="#4b5563" strokeWidth="1" strokeDasharray="2 2" />
                        <line x1={mapX(0)} y1={mapY(0)} x2={mapX(curBezier[0])} y2={mapY(curBezier[1])} stroke="#818cf8" strokeWidth="1" />
                        <line x1={mapX(1)} y1={mapY(1)} x2={mapX(curBezier[2])} y2={mapY(curBezier[3])} stroke="#34d399" strokeWidth="1" />
                        <path
                          d={`M ${mapX(0)} ${mapY(0)} C ${mapX(curBezier[0])} ${mapY(curBezier[1])}, ${mapX(curBezier[2])} ${mapY(curBezier[3])}, ${mapX(1)} ${mapY(1)}`}
                          fill="none"
                          stroke="#f59e0b"
                          strokeWidth="2"
                        />
                        <circle cx={mapX(curBezier[0])} cy={mapY(curBezier[1])} r={4.5} fill="#818cf8" stroke="#fff" strokeWidth="1"
                          onPointerDown={(e) => { e.stopPropagation(); setBezierDragIdx(1); try { (e.currentTarget.ownerSVGElement as SVGSVGElement)?.setPointerCapture(e.pointerId); } catch {} }} />
                        <circle cx={mapX(curBezier[2])} cy={mapY(curBezier[3])} r={4.5} fill="#34d399" stroke="#fff" strokeWidth="1"
                          onPointerDown={(e) => { e.stopPropagation(); setBezierDragIdx(2); try { (e.currentTarget.ownerSVGElement as SVGSVGElement)?.setPointerCapture(e.pointerId); } catch {} }} />
                      </svg>
                      <span className="font-mono text-[9px] text-neutral-300">{curBezier.map((v) => v.toFixed(2)).join(',')}</span>
                    </div>
                  )}
                  <button type="button" onClick={() => setPanel(null)} className={`${iconBtn} ml-auto`}>{t.common.done}</button>
                </>
              );
            })()}
            {panel === null && (
              <>
                <button type="button" onClick={onAddFrame} disabled={!can.addCel} title={t.animation.addCel} className={iconBtn}><Plus className="h-3.5 w-3.5" />{t.animation.addCel}</button>
                <button type="button" onClick={onDuplicateFrame} disabled={!can.addCel || !current || current.ref !== undefined || current.isGroup} title={t.animation.duplicateCel} className={iconBtn}><Copy className="h-3.5 w-3.5" />{t.animation.duplicateCel}</button>
                <button type="button" onClick={() => setPanel('reuse')} disabled={!can.addCel || realCels.length === 0} title={t.animation.cel} className={iconBtn}><Repeat className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={onAddBlank} disabled={!can.addCel} title={t.animation.blankFrame} className={iconBtn}>
                  <span aria-hidden className="text-sm leading-none text-neutral-400">×</span>{t.animation.blankFrame}
                </button>
                <button
                  type="button"
                  disabled={!can.addCel || (!selection && !current)}
                  title={t.animation.repeatModalTitle}
                  onClick={() => {
                    const folderId = selection?.folderId ?? activeFolderId;
                    const ids = selection && selection.ids.size > 0
                      ? (tracks.find((tr) => tr.folderId === selection.folderId)?.entries.filter((x) => selection.ids.has(x.id)).map((x) => x.id) ?? [])
                      : current ? [current.id] : [];
                    if (!folderId || ids.length === 0) return;
                    setRepeatModal({ folderId, entryIds: ids, mode: 'count', count: 2, busy: false });
                  }}
                  className={iconBtn}
                >
                  <Repeat2 className="h-3.5 w-3.5" />{t.animation.repeatCels}
                </button>
                <button
                  type="button"
                  disabled={!activeFolderId || realCels.length === 0}
                  title={t.animation.renameInOrderTooltip}
                  onClick={() => activeFolderId && onRenameInOrder(activeFolderId)}
                  className={iconBtn}
                >
                  <ListOrdered className="h-3.5 w-3.5" />{t.animation.renameInOrder}
                </button>
                <span className="mx-1 h-4 w-px shrink-0 bg-neutral-800" />
                {current
                  ? holdStepper(t.animation.celHoldFrames, current.hold, (n) => onSetHold(Math.max(1, Math.min(MAX_HOLD, n))), canEditEntry)
                  : <span className="shrink-0 text-neutral-500">—</span>}
                <button type="button" onClick={() => onMoveFrame(-1)} disabled={!canEditEntry || currentIdx <= 0} title={t.animation.prevCel} aria-label={t.animation.prevCel} className={iconBtn}>◀</button>
                <button type="button" onClick={() => onMoveFrame(1)} disabled={!canEditEntry || currentIdx < 0 || currentIdx >= entries.length - 1} title={t.animation.nextCel} aria-label={t.animation.nextCel} className={iconBtn}>▶</button>
                <button type="button" onClick={onDeleteFrame} disabled={!canEditEntry || entries.length <= 1} title={t.animation.deleteCel} aria-label={t.animation.deleteCel} className={`${iconBtn} hover:!text-rose-400`}><Trash2 className="h-3.5 w-3.5" /></button>
                <span className="mx-1 h-4 w-px shrink-0 bg-neutral-800" />
                <button type="button"
                  disabled={!canEditEntry || !current}
                  aria-pressed={current?.mark === 'key'}
                  title={t.animation.celMarkKey}
                  onClick={() => current && onUpdateCelMeta(current.id, { mark: current.mark === 'key' ? null : 'key' })}
                  className={chip(current?.mark === 'key')}>○</button>
                <button type="button"
                  disabled={!canEditEntry || !current}
                  aria-pressed={current?.mark === 'inbetween'}
                  title={t.animation.celMarkInbetween}
                  onClick={() => current && onUpdateCelMeta(current.id, { mark: current.mark === 'inbetween' ? null : 'inbetween' })}
                  className={chip(current?.mark === 'inbetween')}>●</button>
                <button type="button"
                  disabled={!canEditEntry || !current}
                  aria-pressed={Boolean(current?.note)}
                  title={current?.note ? `${t.animation.celNote}: ${current.note}` : t.animation.celNote}
                  onClick={() => current && setNoteModal({ entryId: current.id, label: current.blank ? t.animation.blankFrame : current.label, text: current.note ?? '' })}
                  className={chip(Boolean(current?.note))}><MessageSquare className="h-3.5 w-3.5" /></button>
                <button type="button"
                  disabled={!can.editFolder}
                  aria-pressed={activeLabels.some((l) => l.frame === time)}
                  title={t.animation.timelineLabelAdd}
                  onClick={() => {
                    const existing = activeLabels.find((l) => l.frame === time);
                    setLabelModal({ frame: time, text: existing?.text ?? '', existing: Boolean(existing) });
                  }}
                  className={chip(activeLabels.some((l) => l.frame === time))}><Tag className="h-3.5 w-3.5" />{t.animation.timelineLabel}</button>
                {can.editFolder && (
                  <button type="button" onClick={onToggleShared} aria-pressed={Boolean(active?.shared)}
                    title={t.animation.sharedFolderTooltip}
                    className={`${chip(Boolean(active?.shared))} ml-1`}><Users className="h-3.5 w-3.5" />{t.animation.trackShared}</button>
                )}
                <button type="button" onClick={onCreateFolder} disabled={!can.createFolder} title={t.animation.createFolder} className={`${iconBtn} ml-auto`}>
                  <Folder className="h-3.5 w-3.5" />{t.animation.newTrack}
                </button>
              </>
            )}
          </div>
          )}

          {/* Tracks (horizontally virtualized so 10,000+ frames stay <100 DOM nodes) */}
          {(() => {
            const visFrameStart = Math.max(0, Math.floor((gridViewport.left - trackLabelWidth) / CELL) - 4);
            const visFrameEnd = Math.min(shownLength - 1, Math.ceil((gridViewport.left - trackLabelWidth + gridViewport.width) / CELL) + 4);
            const visFrames: number[] = [];
            for (let f = visFrameStart; f <= visFrameEnd; f++) visFrames.push(f);
            return (
          <div ref={gridRef} className="relative min-h-0 flex-1 select-none overflow-auto" style={{ touchAction: 'pan-x pan-y' }}
            onScroll={(e) => {
              const el = e.currentTarget;
              const bucketLeft = Math.floor(el.scrollLeft / (CELL * 4)) * (CELL * 4);
              const w = el.clientWidth || gridViewport.width;
              setGridViewport((prev) => (prev.left === bucketLeft && prev.width === w ? prev : { left: bucketLeft, width: w }));
            }}
            onPointerDown={() => rootRef.current?.focus({ preventScroll: true })}>
            <div className="relative" style={{ width: trackLabelWidth + shownLength * CELL, minWidth: '100%' }}>
              {/* Ruler */}
              <div className="sticky top-0 z-20 flex border-b border-neutral-800 bg-neutral-900" style={{ height: RULER_HEIGHT }}>
                <div style={{ width: trackLabelWidth }} className="sticky left-0 z-10 shrink-0 border-r border-neutral-800 bg-neutral-900 px-1 text-[10px] leading-5 text-neutral-500">{t.animation.framesHeader}</div>
                <div role="slider" aria-label={t.animation.timeAria} aria-valuemin={1} aria-valuemax={shownLength} aria-valuenow={time + 1} tabIndex={0}
                  onClick={(e) => engine.goTo(timeAt(e))}
                  onDoubleClick={(e) => {
                    if (!can.editFolder) return;
                    const f = timeAt(e);
                    const existing = activeLabels.find((l) => l.frame === f);
                    setLabelModal({ frame: f, text: existing?.text ?? '', existing: Boolean(existing) });
                  }}
                  onContextMenu={(e) => {
                    if (!can.editFolder) return;
                    e.preventDefault();
                    const f = timeAt(e);
                    const existing = activeLabels.find((l) => l.frame === f);
                    setLabelModal({ frame: f, text: existing?.text ?? '', existing: Boolean(existing) });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowRight') engine.goToNextFrame();
                    if (e.key === 'ArrowLeft') engine.goToPrevFrame();
                    if (e.key === 'Home') engine.goToStart();
                    if (e.key === 'End') engine.goToEnd();
                  }}
                  className="relative cursor-pointer" style={{ width: shownLength * CELL }}>
                  {range && <div className="absolute inset-y-0 bg-amber-500/20" style={{ left: range.start * CELL, width: (range.end - range.start + 1) * CELL }} />}
                  {visFrames.map((f) => {
                    // Seconds + frames: each second starts with a bright "s+1", the frames after it count up
                    const second = timecode === 'sf' ? f % fps === 0 : f % 6 === 0;
                    return (
                      <span key={f} className={`absolute top-0 h-5 border-l text-[9px] leading-5 ${second ? 'border-neutral-500 font-bold text-neutral-200' : 'border-neutral-800 text-neutral-600'} ${f >= length ? 'opacity-40' : ''}`}
                        style={{ left: f * CELL, width: CELL, paddingLeft: 2 }}>{timecode === 'sf' && !second ? (f % fps) + 1 : tc(f)}</span>
                    );
                  })}
                  {/* End of the timeline */}
                  <div aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 bg-sky-500" style={{ left: length * CELL - 1 }} />
                </div>
              </div>
              {/* Timeline Labels Lane */}
              {showLabelRow && (
                <div data-timeline-labels className="sticky z-20 flex border-b border-neutral-800/80 bg-neutral-950/90" style={{ top: RULER_HEIGHT, height: RULER_HEIGHT }}>
                  <div style={{ width: trackLabelWidth }} className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-neutral-800 bg-neutral-900 px-1.5 text-[9px] font-semibold text-sky-300 truncate">
                    <Tag className="h-2.5 w-2.5 shrink-0" /><span className="truncate">{t.animation.timelineLabel}</span>
                  </div>
                  <div className="relative" style={{ width: shownLength * CELL }}>
                    {activeLabels
                      .filter((lbl) => lbl.frame >= visFrameStart - 6 && lbl.frame <= visFrameEnd + 2)
                      .map((lbl) => (
                        <button
                          key={lbl.frame}
                          type="button"
                          data-timeline-label={lbl.frame}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            engine.goTo(lbl.frame);
                          }}
                          onContextMenu={(ev) => {
                            if (!can.editFolder) return;
                            ev.preventDefault();
                            ev.stopPropagation();
                            setLabelModal({ frame: lbl.frame, text: lbl.text, existing: true });
                          }}
                          onDoubleClick={(ev) => {
                            if (!can.editFolder) return;
                            ev.stopPropagation();
                            setLabelModal({ frame: lbl.frame, text: lbl.text, existing: true });
                          }}
                          title={`${t.animation.timelineLabelFrame.replace('{frame}', String(lbl.frame + 1))}: ${lbl.text}`}
                          style={{ left: lbl.frame * CELL + 1 }}
                          className={`absolute top-0.5 z-10 flex h-4 max-w-[132px] items-center gap-0.5 truncate rounded px-1.5 text-[9px] font-semibold leading-none transition-colors ${
                            lbl.frame === time
                              ? 'border border-sky-400/80 bg-sky-500/30 text-sky-100'
                              : 'border border-sky-500/40 bg-sky-950/80 text-sky-300 hover:bg-sky-900/80 hover:text-white'
                          }`}
                        >
                          <span className="truncate">{lbl.text}</span>
                        </button>
                      ))}
                  </div>
                </div>
              )}
              {/* Active Layer Transform Keyframes Lane */}
              {showKfRow && (
                <div className="flex border-b border-neutral-800/80 bg-neutral-950/80" style={{ height: RULER_HEIGHT }}>
                  <button
                    type="button"
                    onClick={() => setPanel(panel === 'keyframes' ? null : 'keyframes')}
                    className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-neutral-800 bg-neutral-900 px-1.5 text-[9px] font-semibold text-amber-300 truncate"
                    title={t.animation.keyframeSection}
                    style={{ width: trackLabelWidth }}
                  >
                    <span>◆</span><span className="truncate">{activeLayer!.name}</span>
                  </button>
                  <div className="relative cursor-pointer" style={{ width: shownLength * CELL }}
                    onClick={(e) => {
                      const f = timeAt(e);
                      engine.goTo(f);
                      setPanel('keyframes');
                    }}
                  >
                    {activeKfs
                      .filter((k) => k.frame >= visFrameStart && k.frame <= visFrameEnd)
                      .map((k) => (
                        <button
                          key={k.frame}
                          type="button"
                          onClick={(e) => { e.stopPropagation(); engine.goTo(k.frame); setPanel('keyframes'); }}
                          title={`#${k.frame + 1} (${k.easing})`}
                          style={{ left: k.frame * CELL + CELL / 2 }}
                          className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 text-[11px] leading-none transition-transform hover:scale-125 ${
                            Math.round(k.frame) === time ? 'text-amber-300 scale-125' : 'text-indigo-400'
                          }`}
                        >
                          ◆
                        </button>
                      ))}
                  </div>
                </div>
              )}
              {tracks.map((track) => {
                const isActive = track.folderId === activeFolderId;
                const owner = ownerNames[track.ownerId ?? ''] ?? '';
                const color = getUserColor(track.ownerId).hex;
                return (
                  <div key={track.folderId} className={`flex border-b border-neutral-800/70 ${isActive ? 'bg-rose-950/20' : ''}`} style={{ height: ROW }}>
                    <button type="button" onClick={() => onSelectCell(track.folderId, time)} aria-pressed={isActive}
                      aria-label={`${track.name} (${owner}${track.shared ? ` · ${t.animation.trackShared}` : ''})`}
                      className={`sticky left-0 z-10 flex shrink-0 flex-col justify-center border-r border-l-2 border-neutral-800 bg-neutral-950 px-1.5 text-left ${isActive ? 'text-white' : 'text-neutral-400'}`}
                      style={{ width: trackLabelWidth, borderLeftColor: color }}>
                      <span className="truncate text-[11px] font-bold">{track.name}</span>
                      <span className="truncate text-[9px] text-neutral-500">{owner}{track.shared ? `・${t.animation.trackShared}` : ''}・{trackLength(track.entries)}</span>
                    </button>
                    <div className="relative" style={{ width: shownLength * CELL }}
                      onClick={(e) => {
                        if (suppressClickRef.current) {
                          suppressClickRef.current = false;
                          return;
                        }
                        // An empty frame (not a cel) clears the selection
                        if (!(e.target as HTMLElement).closest('[data-entry]')) setSelection(null);
                        onSelectCell(track.folderId, timeAt(e));
                      }}>
                      {/* Where the dragged cels will land */}
                      {drag?.started && drag.mode === 'move' && drag.folderId === track.folderId && (() => {
                        const from = tracks.find((tr) => tr.folderId === drag.fromFolderId)?.entries ?? [];
                        return from.map((x, i) => (drag.ids.includes(x.id) ? (
                          <div key={`drop-${x.id}`} aria-hidden className="pointer-events-none absolute top-1 bottom-1 z-20 rounded-md border-2 border-dashed border-amber-400 bg-amber-400/15"
                            style={{ left: (entryStart(from, i) + drag.delta) * CELL + 1, width: x.hold * CELL - 2 }} />
                        ) : null));
                      })()}
                      {track.entries.map((e, i) => {
                        const start = entryStart(track.entries, i);
                        const isDragged = drag?.started && drag.ids.includes(e.id);
                        const hold = isDragged && drag.mode === 'hold' ? drag.hold : e.hold;
                        if (!isDragged && (start + hold - 1 < visFrameStart || start > visFrameEnd)) return null;
                        const shownId = celLayerOf(e);
                        const isCurrent = isActive && i === currentIdx;
                        const onion = isActive ? onionMarks.get(e.id) : undefined;
                        const editable = can.editableEntryIds.has(e.id);
                        const isSelected = selection?.folderId === track.folderId && selection.ids.has(e.id);
                        // A reuse whose drawing was deleted shows nothing too, but by accident: it is flagged
                        const broken = e.ref === '' && !e.blank;
                        const tooltipParts: string[] = [];
                        if (e.mark === 'key') tooltipParts.push(t.animation.celMarkKey);
                        else if (e.mark === 'inbetween') tooltipParts.push(t.animation.celMarkInbetween);
                        if (e.note) tooltipParts.push(e.note);
                        if (broken) tooltipParts.push(t.animation.missingCel);
                        const celTooltip = tooltipParts.length > 0 ? tooltipParts.join(' · ') : undefined;
                        return (
                          <div key={e.id} data-entry data-entry-id={e.id} data-blank={e.blank ? '' : undefined} data-mark={e.mark ?? undefined} onPointerDown={(ev) => startDrag(ev, track, i)}
                            onClick={(ev) => { if (!suppressClickRef.current && pickForSelection(ev, track, e.id)) ev.stopPropagation(); }}
                            onContextMenu={(ev) => {
                              ev.preventDefault();
                              ev.stopPropagation();
                              onSelectCell(track.folderId, start);
                              setCelMenu({ entryId: e.id, x: ev.clientX, y: ev.clientY });
                            }}
                            aria-selected={isSelected}
                            aria-label={`${track.name} #${start + 1}: ${e.blank ? t.animation.blankFrame : broken ? t.animation.missingCel : e.label} (${e.hold})${e.mark === 'key' ? ` ${t.animation.celMarkKey}` : e.mark === 'inbetween' ? ` ${t.animation.celMarkInbetween}` : ''}${e.note ? ` · ${e.note}` : ''}`}
                            title={celTooltip}
                            className={`absolute top-1 bottom-1 flex flex-col overflow-hidden rounded-md border ${
                              isSelected ? 'border-sky-400 ring-2 ring-sky-400/70' : isCurrent ? 'border-rose-400 ring-2 ring-rose-500/70' : broken ? 'border-amber-500/80' : onion === 'prev' ? 'border-red-500/70' : onion === 'next' ? 'border-emerald-500/70' : 'border-neutral-700'
                            } ${e.blank ? 'atelier-blank-cel border-dashed' : e.ref !== undefined ? 'border-dashed bg-neutral-800/60' : 'bg-neutral-900'} ${editable ? 'cursor-grab' : ''} ${isDragged && drag.mode === 'move' ? 'opacity-40' : ''}`}
                            style={{ left: start * CELL + 1, width: hold * CELL - 2 }}>
                            {editable && (
                              <span data-hold-handle title={t.animation.celHoldFrames} aria-hidden style={{ touchAction: 'none' }}
                                className={`absolute inset-y-0 right-0 z-10 cursor-ew-resize hover:bg-amber-400/40 ${
                                  isPhone ? 'w-3.5 bg-white/10 border-l border-white/15' : 'w-2 bg-white/0'
                                }`} />
                            )}
                            {isDragged && drag.mode === 'hold' && (
                              <span className="absolute right-2 top-3.5 z-10 rounded bg-amber-500 px-1 font-mono text-[9px] font-bold text-black">{hold}</span>
                            )}
                            <span data-drag-handle style={editable ? { touchAction: 'none' } : undefined}
                              className="flex h-3.5 shrink-0 items-center gap-0.5 truncate px-0.5 text-[9px] font-bold text-neutral-300">
                              {e.ref !== undefined && !e.blank && <Repeat className={`h-2.5 w-2.5 shrink-0 ${broken ? 'text-amber-400' : 'text-sky-300'}`} />}
                              {e.isGroup && e.ref === undefined && <Folder className="h-2.5 w-2.5 shrink-0" />}
                              {isActive && lightTable.enabled && shownId && lightNow.has(shownId) && <Lamp aria-label={t.animation.lightTable} className="h-2.5 w-2.5 shrink-0 text-amber-300" />}
                              <span className="truncate">{e.blank ? '' : e.ref !== undefined ? (track.entries.find((x) => x.id === e.ref)?.label ?? '—') : e.label}</span>
                              {e.mark && (
                                <span
                                  aria-hidden
                                  className={`ml-auto shrink-0 pr-0.5 text-[10px] leading-none ${e.mark === 'key' ? 'text-amber-300' : 'text-sky-300'}`}
                                >
                                  {e.mark === 'key' ? '○' : '●'}
                                </span>
                              )}
                            </span>
                            {e.note && (
                              <span aria-hidden className="pointer-events-none absolute bottom-1.5 right-1.5 z-10 h-1.5 w-1.5 rounded-full bg-amber-400 ring-1 ring-neutral-950" />
                            )}
                            {e.blank ? (
                              <span aria-hidden className="atelier-blank-mark mx-0.5 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-sm text-lg font-light leading-none">×</span>
                            ) : (
                              <span className="mx-0.5 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-sm bg-white/90">
                                {shownId && <AnimThumbImg layerId={shownId} thumbnails={thumbnails} subscribeThumbnails={subscribeThumbnails} getThumbnailsSnapshot={getThumbnailsSnapshot} className="pointer-events-none h-full w-full object-contain" />}
                              </span>
                            )}
                            <span className="h-1 shrink-0" style={{ backgroundColor: onion === 'prev' ? onionSkin.prevColor : onion === 'next' ? onionSkin.nextColor : getUserColor(e.ownerId).hex, opacity: onion ? 1 : 0.7 }} />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {/* Phase E1: 2D Camera keyframe track row */}
              {cameraLayer && cameraLayer.meta?.camera && (
                <div className="flex border-b border-neutral-800/80 bg-sky-950/20" style={{ height: 30 }} data-testid="timeline-camera-row">
                  <div
                    className="sticky left-0 z-20 flex shrink-0 items-center justify-between gap-1 border-r border-neutral-800 bg-neutral-950/95 px-2 text-[10px] font-medium text-sky-300"
                    style={{ width: trackLabelWidth }}
                  >
                    <button
                      type="button"
                      onClick={() => onToggleCameraWindow?.()}
                      className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-sky-200"
                      title={t.animation.cameraTooltip}
                    >
                      <Camera className="h-3 w-3 shrink-0" />
                      <span className="truncate">{t.animation.cameraTrack}</span>
                    </button>
                    {onToggleCameraPreview && (
                      <button
                        type="button"
                        onClick={onToggleCameraPreview}
                        aria-pressed={cameraPreviewActive}
                        title={t.animation.cameraPreview}
                        className={`shrink-0 rounded p-0.5 ${cameraPreviewActive ? 'bg-sky-500/30 text-sky-100' : 'text-neutral-400 hover:text-sky-200'}`}
                      >
                        {cameraPreviewActive ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      </button>
                    )}
                  </div>
                  <div
                    className="relative flex-1 cursor-pointer"
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const f = Math.max(0, Math.min(length - 1, Math.floor((e.clientX - rect.left) / CELL)));
                      engine.goTo(f);
                    }}
                  >
                    {(cameraLayer.meta.keyframes ?? []).map((kf) => (
                      <button
                        key={`cam-kf-${kf.frame}`}
                        type="button"
                        title={`#${kf.frame + 1}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          engine.goTo(kf.frame);
                          onToggleCameraWindow?.();
                        }}
                        className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-white bg-sky-400 shadow transition hover:scale-125"
                        style={{ left: kf.frame * CELL + CELL / 2 }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Phase E3: Compact Audio waveform tracks */}
              {audioLayers.map((audLayer) => {
                const meta = normalizeAudioTrackMeta(audLayer.meta?.audio);
                const clipRange = resolveAudioClipFrameRange(meta, fps);
                const summary = audioAssetSummaries[meta.localAssetId];
                const linked = Boolean(summary?.linked);
                const peaks = summary?.peaks ?? [];
                const leftPx = clipRange.startFrame * CELL + 1;
                const widthPx = Math.max(CELL - 2, clipRange.frameCount * CELL - 2);
                const barCount = Math.max(8, Math.min(peaks.length || 24, Math.floor(widthPx / 3)));

                return (
                  <div
                    key={audLayer.id}
                    className="flex border-b border-neutral-800/80 bg-emerald-950/15"
                    style={{ height: 34 }}
                    data-testid={`timeline-audio-row-${audLayer.id}`}
                  >
                    <div
                      className="sticky left-0 z-20 flex shrink-0 items-center justify-between gap-1 border-r border-neutral-800 bg-neutral-950/95 px-2 text-[10px] font-medium text-emerald-300"
                      style={{ width: trackLabelWidth }}
                    >
                      <button
                        type="button"
                        onClick={() => onToggleAudioWindow?.()}
                        className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-emerald-200"
                        title={audLayer.name}
                      >
                        <Music className="h-3 w-3 shrink-0" />
                        <span className="truncate">{audLayer.name}</span>
                      </button>
                      {onToggleAudioMute && (
                        <button
                          type="button"
                          onClick={() => onToggleAudioMute(audLayer.id)}
                          aria-pressed={meta.muted}
                          title={meta.muted ? t.animation.audioUnmute : t.animation.audioMute}
                          className={`shrink-0 rounded p-0.5 ${meta.muted ? 'text-red-400' : 'text-emerald-300 hover:text-emerald-100'}`}
                        >
                          {meta.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
                        </button>
                      )}
                    </div>
                    <div
                      className="relative flex-1 cursor-pointer"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const f = Math.max(0, Math.min(length - 1, Math.floor((e.clientX - rect.left) / CELL)));
                        engine.goTo(f);
                      }}
                    >
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleAudioWindow?.();
                        }}
                        data-testid={`timeline-audio-clip-${audLayer.id}`}
                        className={`absolute top-1 bottom-1 flex items-center overflow-hidden rounded border px-1 transition ${
                          meta.muted
                            ? 'border-neutral-700 bg-neutral-900/70 opacity-50'
                            : linked
                              ? 'border-emerald-500/60 bg-emerald-950/60'
                              : 'border-dashed border-amber-500/60 bg-amber-950/30'
                        }`}
                        style={{ left: leftPx, width: widthPx }}
                      >
                        {linked && peaks.length > 0 ? (
                          <svg
                            viewBox={`0 0 ${barCount * 3} 24`}
                            preserveAspectRatio="none"
                            className="h-full w-full"
                            data-testid={`timeline-audio-waveform-${audLayer.id}`}
                          >
                            {Array.from({ length: barCount }, (_, i) => {
                              const peakIdx = Math.min(
                                peaks.length - 1,
                                Math.floor((i * peaks.length) / barCount)
                              );
                              const amp = Math.max(0.08, peaks[peakIdx] ?? 0);
                              const h = Math.max(2, amp * 20);
                              const y = (24 - h) / 2;
                              return (
                                <rect
                                  key={i}
                                  x={i * 3}
                                  y={y}
                                  width={2}
                                  height={h}
                                  rx={0.75}
                                  fill={meta.muted ? '#737373' : '#34d399'}
                                  opacity={0.85}
                                />
                              );
                            })}
                          </svg>
                        ) : (
                          <span className="truncate text-[9px] text-amber-200/90">
                            {t.animation.audioUnlinked} · {meta.fileName}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Playhead */}
              <div data-playhead className="pointer-events-none absolute top-0 bottom-0 z-10 border-x border-rose-500/80 bg-rose-500/10" style={{ left: trackLabelWidth + time * CELL, width: CELL }} />
            </div>
          </div>
            );
          })()}
        </>
      )}

      <OverlayPresence open={Boolean(celMenu)}>
        {(() => {
          if (!celMenu) return null;
          const menuEntry = tracks.flatMap((tr) => tr.entries).find((x) => x.id === celMenu.entryId);
          if (!menuEntry) return null;
          const menuEditable = can.editableEntryIds.has(menuEntry.id);
          const left = typeof window !== 'undefined' ? Math.min(window.innerWidth - 184, Math.max(8, celMenu.x)) : celMenu.x;
          const top = typeof window !== 'undefined' ? Math.min(window.innerHeight - 196, Math.max(8, celMenu.y)) : celMenu.y;
          const itemCls = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent';
          return (
            <div
              data-cel-menu
              role="menu"
              style={{ left, top }}
              className="atelier-tl-row fixed z-50 w-44 rounded-xl border border-neutral-700/90 bg-neutral-900/95 p-1 shadow-2xl backdrop-blur"
            >
              <button type="button" role="menuitem" disabled={!menuEditable} className={itemCls}
                onClick={() => {
                  onUpdateCelMeta(menuEntry.id, { mark: menuEntry.mark === 'key' ? null : 'key' });
                  setCelMenu(null);
                }}>
                <span className="w-4 text-center text-amber-300">○</span>
                <span className="flex-1 truncate">{t.animation.celMarkKey}</span>
                {menuEntry.mark === 'key' && <span className="text-[10px] text-amber-300">✓</span>}
              </button>
              <button type="button" role="menuitem" disabled={!menuEditable} className={itemCls}
                onClick={() => {
                  onUpdateCelMeta(menuEntry.id, { mark: menuEntry.mark === 'inbetween' ? null : 'inbetween' });
                  setCelMenu(null);
                }}>
                <span className="w-4 text-center text-sky-300">●</span>
                <span className="flex-1 truncate">{t.animation.celMarkInbetween}</span>
                {menuEntry.mark === 'inbetween' && <span className="text-[10px] text-sky-300">✓</span>}
              </button>
              {menuEntry.mark && (
                <button type="button" role="menuitem" disabled={!menuEditable} className={itemCls}
                  onClick={() => {
                    onUpdateCelMeta(menuEntry.id, { mark: null });
                    setCelMenu(null);
                  }}>
                  <span className="w-4 text-center text-neutral-500">×</span>
                  <span className="flex-1 truncate">{t.animation.celMarkClear}</span>
                </button>
              )}
              <div className="my-1 h-px bg-neutral-800" />
              <button type="button" role="menuitem" disabled={!menuEditable} className={itemCls}
                onClick={() => {
                  setNoteModal({ entryId: menuEntry.id, label: menuEntry.blank ? t.animation.blankFrame : menuEntry.label, text: menuEntry.note ?? '' });
                  setCelMenu(null);
                }}>
                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                <span className="flex-1 truncate">{t.animation.celNote}</span>
              </button>
              <button type="button" role="menuitem" disabled={!can.addCel || !menuEditable} className={itemCls}
                onClick={() => {
                  const menuTrack = tracks.find((tr) => tr.entries.some((x) => x.id === menuEntry.id));
                  if (menuTrack) {
                    const useSelection = selection?.folderId === menuTrack.folderId && selection.ids.has(menuEntry.id) && selection.ids.size > 0;
                    const ids = useSelection
                      ? menuTrack.entries.filter((x) => selection!.ids.has(x.id)).map((x) => x.id)
                      : [menuEntry.id];
                    setRepeatModal({ folderId: menuTrack.folderId, entryIds: ids, mode: 'count', count: 2, busy: false });
                  }
                  setCelMenu(null);
                }}>
                <Repeat2 className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                <span className="flex-1 truncate">{t.animation.repeatCels}</span>
              </button>
            </div>
          );
        })()}
      </OverlayPresence>

      <OverlayPresence open={Boolean(noteModal)}>
        {noteModal && (
          <AtelierModal
            title={`${t.animation.celNote} · ${noteModal.label}`}
            icon={<MessageSquare />}
            width="sm"
            onClose={() => setNoteModal(null)}
            footer={
              <>
                {noteModal.text.trim() && (
                  <button
                    type="button"
                    className={`${modalButton.secondary} mr-auto`}
                    onClick={() => {
                      onUpdateCelMeta(noteModal.entryId, { note: null });
                      setNoteModal(null);
                    }}
                  >
                    {t.animation.celNoteClear}
                  </button>
                )}
                <button type="button" className={modalButton.secondary} onClick={() => setNoteModal(null)}>{t.common.cancel}</button>
                <button
                  type="button"
                  className={modalButton.primary}
                  onClick={() => {
                    onUpdateCelMeta(noteModal.entryId, { note: noteModal.text.trim() || null });
                    setNoteModal(null);
                  }}
                >
                  {t.common.confirm}
                </button>
              </>
            }
          >
            <input
              autoFocus
              maxLength={120}
              value={noteModal.text}
              placeholder={t.animation.celNotePlaceholder}
              onChange={(e) => setNoteModal({ ...noteModal, text: e.target.value })}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  onUpdateCelMeta(noteModal.entryId, { note: noteModal.text.trim() || null });
                  setNoteModal(null);
                }
              }}
              className="atelier-field w-full px-3 py-2 text-xs text-white"
            />
          </AtelierModal>
        )}
      </OverlayPresence>

      <OverlayPresence open={Boolean(labelModal)}>
        {labelModal && (
          <AtelierModal
            title={`${t.animation.timelineLabel} · ${t.animation.timelineLabelFrame.replace('{frame}', String(labelModal.frame + 1))}`}
            icon={<Tag />}
            width="sm"
            onClose={() => setLabelModal(null)}
            footer={
              <>
                {labelModal.existing && (
                  <button
                    type="button"
                    className={`${modalButton.danger} mr-auto`}
                    onClick={() => {
                      onUpdateLabels(removeTimelineLabel(activeLabels, labelModal.frame));
                      setLabelModal(null);
                    }}
                  >
                    {t.animation.timelineLabelDelete}
                  </button>
                )}
                <button type="button" className={modalButton.secondary} onClick={() => setLabelModal(null)}>{t.common.cancel}</button>
                <button
                  type="button"
                  className={modalButton.primary}
                  onClick={() => {
                    onUpdateLabels(upsertTimelineLabel(activeLabels, labelModal.frame, labelModal.text));
                    setLabelModal(null);
                  }}
                >
                  {t.common.confirm}
                </button>
              </>
            }
          >
            <input
              autoFocus
              maxLength={40}
              value={labelModal.text}
              placeholder={t.animation.timelineLabelPlaceholder}
              onChange={(e) => setLabelModal({ ...labelModal, text: e.target.value })}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  onUpdateLabels(upsertTimelineLabel(activeLabels, labelModal.frame, labelModal.text));
                  setLabelModal(null);
                }
              }}
              className="atelier-field w-full px-3 py-2 text-xs text-white"
            />
          </AtelierModal>
        )}
      </OverlayPresence>

      <OverlayPresence open={Boolean(repeatModal)}>
        {repeatModal && (() => {
          const targetTrack = tracks.find((tr) => tr.folderId === repeatModal.folderId);
          const preview = targetTrack
            ? planRepeatCels(targetTrack.entries, repeatModal.entryIds, {
                mode: repeatModal.mode,
                count: repeatModal.count,
                targetEndFrame: length,
              })
            : { items: [], totalFrames: 0, addedFrames: 0, capped: false };
          const canApply = !repeatModal.busy && preview.items.length > 0;
          const submitRepeat = async () => {
            if (!canApply) return;
            setRepeatModal((prev) => (prev ? { ...prev, busy: true } : null));
            const ok = await onRepeatEntries(repeatModal.folderId, repeatModal.entryIds, {
              mode: repeatModal.mode,
              count: repeatModal.count,
            });
            setRepeatModal((prev) => (ok ? null : prev ? { ...prev, busy: false } : null));
          };
          return (
            <AtelierModal
              title={t.animation.repeatModalTitle}
              icon={<Repeat2 />}
              width="sm"
              onClose={() => !repeatModal.busy && setRepeatModal(null)}
              footer={
                <>
                  <button type="button" className={modalButton.secondary} disabled={repeatModal.busy} onClick={() => setRepeatModal(null)}>{t.common.cancel}</button>
                  <button type="button" className={modalButton.primary} disabled={!canApply} onClick={() => void submitRepeat()}>
                    {repeatModal.busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {t.common.confirm}
                  </button>
                </>
              }
            >
              <div className="space-y-3">
                <div role="radiogroup" className="grid grid-cols-2 gap-2">
                  {([
                    ['count', t.animation.repeatModeCount],
                    ['toEnd', t.animation.repeatModeToEnd],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={repeatModal.mode === mode}
                      onClick={() => setRepeatModal({ ...repeatModal, mode })}
                      className={`atelier-tl-row rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                        repeatModal.mode === mode
                          ? 'border-indigo-400 bg-indigo-500/20 text-white'
                          : 'border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:bg-neutral-800'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {repeatModal.mode === 'count' && (
                  <label className="flex items-center justify-between gap-2 text-xs text-neutral-300">
                    <span>{t.animation.repeatCountLabel}</span>
                    <input
                      type="number"
                      min={2}
                      max={100}
                      value={repeatModal.count}
                      onChange={(e) => {
                        const n = Math.max(2, Math.min(100, Math.round(Number(e.target.value) || 2)));
                        setRepeatModal({ ...repeatModal, count: n });
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') void submitRepeat();
                      }}
                      className="atelier-field h-8 w-20 px-2 text-center font-mono text-xs font-bold text-white"
                    />
                  </label>
                )}
                <p className="text-[11px] text-neutral-400">
                  {preview.items.length > 0
                    ? t.animation.repeatSummary
                        .replace('{total}', String(preview.totalFrames))
                        .replace('{added}', String(preview.items.length))
                    : t.animation.repeatNoRoom}
                </p>
              </div>
            </AtelierModal>
          );
        })()}
      </OverlayPresence>

      {typeof document !== 'undefined' && createPortal(
        <OverlayPresence open={phoneDrawerOpen}>
          <AtelierModal
            title={active?.name ?? t.animation.timeline}
            icon={<SlidersHorizontal />}
            width="md"
            onClose={() => setPhoneDrawerOpen(false)}
            footer={
              <button type="button" className={modalButton.primary} onClick={() => setPhoneDrawerOpen(false)}>{t.common.done}</button>
            }
          >
          <div data-phone-drawer className="space-y-4 text-xs text-neutral-200">
            {/* Cel actions */}
            <section className="space-y-2">
              <div className="text-[11px] font-bold text-neutral-400">{t.animation.celActions}</div>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" onClick={() => { onAddFrame(); setPhoneDrawerOpen(false); }} disabled={!can.addCel} className={chip(false)}>
                  <Plus className="h-3.5 w-3.5" />{t.animation.addCel}
                </button>
                <button type="button" onClick={() => { onDuplicateFrame(); setPhoneDrawerOpen(false); }} disabled={!can.addCel || !current || current.ref !== undefined || current.isGroup} className={chip(false)}>
                  <Copy className="h-3.5 w-3.5" />{t.animation.duplicateCel}
                </button>
                <button type="button" onClick={() => { onAddBlank(); setPhoneDrawerOpen(false); }} disabled={!can.addCel} className={chip(false)}>
                  <span>×</span>{t.animation.blankFrame}
                </button>
                <button type="button" onClick={() => { setPhoneDrawerOpen(false); setPanel('reuse'); }} disabled={!can.addCel || realCels.length === 0} className={chip(false)}>
                  <Repeat className="h-3.5 w-3.5" />{t.animation.cel}
                </button>
                <button
                  type="button"
                  disabled={!can.addCel || (!selection && !current)}
                  onClick={() => {
                    const folderId = selection?.folderId ?? activeFolderId;
                    const ids = selection && selection.ids.size > 0
                      ? (tracks.find((tr) => tr.folderId === selection.folderId)?.entries.filter((x) => selection.ids.has(x.id)).map((x) => x.id) ?? [])
                      : current ? [current.id] : [];
                    if (!folderId || ids.length === 0) return;
                    setPhoneDrawerOpen(false);
                    setRepeatModal({ folderId, entryIds: ids, mode: 'count', count: 2, busy: false });
                  }}
                  className={chip(false)}
                >
                  <Repeat2 className="h-3.5 w-3.5" />{t.animation.repeatCels}
                </button>
                <button type="button" onClick={() => { if (activeFolderId) onRenameInOrder(activeFolderId); setPhoneDrawerOpen(false); }} disabled={!activeFolderId || realCels.length === 0} className={chip(false)}>
                  <ListOrdered className="h-3.5 w-3.5" />{t.animation.renameInOrder}
                </button>
                <button type="button" onClick={() => { onMoveFrame(-1); }} disabled={!canEditEntry || currentIdx <= 0} className={chip(false)}>◀ {t.animation.prevCel}</button>
                <button type="button" onClick={() => { onMoveFrame(1); }} disabled={!canEditEntry || currentIdx < 0 || currentIdx >= entries.length - 1} className={chip(false)}>{t.animation.nextCel} ▶</button>
                <button type="button" onClick={() => { onDeleteFrame(); setPhoneDrawerOpen(false); }} disabled={!canEditEntry || entries.length <= 1} className={`${chip(false)} !text-rose-300 border-rose-500/40`}>
                  <Trash2 className="h-3.5 w-3.5" />{t.animation.deleteCel}
                </button>
                <button type="button" onClick={() => setMultiMode((v) => !v)} aria-pressed={multiMode} className={chip(multiMode)}>
                  {t.animation.multiSelect}
                </button>
                <button type="button" onClick={() => { onCreateFolder(); setPhoneDrawerOpen(false); }} disabled={!can.createFolder} className={chip(false)}>
                  <Folder className="h-3.5 w-3.5" />{t.animation.newTrack}
                </button>
              </div>
              {current && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {holdStepper(t.animation.celHoldFrames, current.hold, (n) => onSetHold(Math.max(1, Math.min(MAX_HOLD, n))), canEditEntry)}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5 pt-1">
                <button type="button" disabled={!canEditEntry || !current} aria-pressed={current?.mark === 'key'}
                  onClick={() => current && onUpdateCelMeta(current.id, { mark: current.mark === 'key' ? null : 'key' })}
                  className={chip(current?.mark === 'key')}>{t.animation.celMarkKey}</button>
                <button type="button" disabled={!canEditEntry || !current} aria-pressed={current?.mark === 'inbetween'}
                  onClick={() => current && onUpdateCelMeta(current.id, { mark: current.mark === 'inbetween' ? null : 'inbetween' })}
                  className={chip(current?.mark === 'inbetween')}>{t.animation.celMarkInbetween}</button>
                <button type="button" disabled={!canEditEntry || !current} aria-pressed={Boolean(current?.note)}
                  onClick={() => {
                    if (!current) return;
                    setPhoneDrawerOpen(false);
                    setNoteModal({ entryId: current.id, label: current.blank ? t.animation.blankFrame : current.label, text: current.note ?? '' });
                  }}
                  className={chip(Boolean(current?.note))}><MessageSquare className="h-3.5 w-3.5" />{t.animation.celNote}</button>
                <button type="button" disabled={!can.editFolder} aria-pressed={activeLabels.some((l) => l.frame === time)}
                  onClick={() => {
                    const existing = activeLabels.find((l) => l.frame === time);
                    setPhoneDrawerOpen(false);
                    setLabelModal({ frame: time, text: existing?.text ?? '', existing: Boolean(existing) });
                  }}
                  className={chip(activeLabels.some((l) => l.frame === time))}><Tag className="h-3.5 w-3.5" />{t.animation.timelineLabel}</button>
              </div>
            </section>

            {/* Onion skin & flipbook */}
            <section className="space-y-2 border-t border-neutral-800 pt-3">
              <div className="text-[11px] font-bold text-neutral-400">{t.animation.onionSkin} · {t.animation.flipbook}</div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => updateOnion({ enabled: !onionSkin.enabled })} aria-pressed={onionSkin.enabled} className={chip(onionSkin.enabled)}>
                  <Eye className="h-3.5 w-3.5" />{onionSkin.enabled ? t.animation.onionSkinOn : t.animation.onionSkinOff}
                </button>
                {stepper(t.animation.onionPrev, onionSkin.prevFramesCount, (n) => updateOnion({ prevFramesCount: n }), 0, MAX_ONION)}
                {stepper(t.animation.onionNext, onionSkin.nextFramesCount, (n) => updateOnion({ nextFramesCount: n }), 0, MAX_ONION)}
                {stepper(t.animation.flipbookSpan, flipSpan, (n) => { engine.setFlipSpan(n); setFlipSpan(engine.getFlipSpan()); }, 1, MAX_FLIP_SPAN)}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span role="radiogroup" aria-label={t.animation.onionMode} className="flex overflow-hidden rounded-lg border border-neutral-700/70">
                  {ONION_MODES.map((m) => {
                    const on = (onionSkin.mode ?? 'tint') === m;
                    return (
                      <button key={m} type="button" role="radio" aria-checked={on} onClick={() => updateOnion({ mode: m })}
                        className={`flex h-7 items-center gap-1 px-2 text-[11px] font-bold ${on ? 'bg-amber-500/15 text-amber-300' : 'text-neutral-300 hover:bg-neutral-800'}`}>
                        <span aria-hidden className="atelier-onion-swatch h-3 w-3 shrink-0 rounded-[3px]" style={{ background: onionSwatch(m, onionSkin.prevColor) }} />
                        {onionModeLabel(m)}
                      </button>
                    );
                  })}
                </span>
                <label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
                  {t.animation.onionSkinOpacity}
                  <input type="range" min="0.05" max="0.9" step="0.05" value={onionSkin.opacity}
                    onChange={(e) => updateOnion({ opacity: parseFloat(e.target.value) })} className="h-1 w-20 accent-amber-500" />
                </label>
              </div>
            </section>

            {/* Playback & tools */}
            <section className="space-y-2 border-t border-neutral-800 pt-3">
              <div className="text-[11px] font-bold text-neutral-400">{t.animation.playbackAndExport}</div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" onClick={() => engine.goToStart()} className={chip(false)}><SkipBack className="h-3.5 w-3.5" />{t.animation.firstCel}</button>
                <button type="button" onClick={() => engine.goToEnd()} className={chip(false)}><SkipForward className="h-3.5 w-3.5" />{t.animation.lastCel}</button>
                <button type="button" onClick={() => engine.setLoop(!loop)} aria-pressed={loop} className={chip(loop)}><Repeat2 className="h-3.5 w-3.5" />{t.animation.loop}</button>
                <button type="button" onClick={toggleTimecode} className={chip(false)}>{formatTimecode(time, fps, timecode)}/{formatTimecode(length - 1, fps, timecode)}</button>
                <label className="flex items-center gap-1 text-[11px] text-neutral-400">
                  <span>FPS</span>
                  <select value={fps} disabled={!can.editFolder} onChange={(e) => onFpsChange(Number(e.target.value))} aria-label={t.animation.fpsAria}
                    className="atelier-field h-7 px-1.5 text-xs">
                    {[6, 8, 12, 15, 24, 30].map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </label>
                <button type="button" onClick={() => { setPhoneDrawerOpen(false); setPanel('range'); }} className={chip(Boolean(range))}>
                  <Repeat className="h-3.5 w-3.5" />{t.animation.range}
                </button>
                <button type="button" data-testid="phone-drawer-light-btn" onClick={() => { setPhoneDrawerOpen(false); if (onToggleLightWindow) onToggleLightWindow(); else setPanel('light'); }} className={chip(lightWindowOpen || (lightTable.enabled && lightCount > 0))}>
                  <Lamp className="h-3.5 w-3.5" />{t.animation.lightTable}
                </button>
                {onToggleCameraWindow && (
                  <button type="button" data-testid="phone-drawer-camera-btn" onClick={() => { setPhoneDrawerOpen(false); onToggleCameraWindow(); }} className={chip(cameraWindowOpen || Boolean(cameraLayer))}>
                    <Camera className="h-3.5 w-3.5" />{t.animation.camera}
                  </button>
                )}
                {cameraLayer && onToggleCameraPreview && (
                  <button type="button" data-testid="phone-drawer-camera-preview-btn" onClick={() => { setPhoneDrawerOpen(false); onToggleCameraPreview(); }} className={chip(cameraPreviewActive)}>
                    {cameraPreviewActive ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}{t.animation.cameraPreview}
                  </button>
                )}
                {onToggleAudioWindow && (
                  <button type="button" data-testid="phone-drawer-audio-btn" onClick={() => { setPhoneDrawerOpen(false); onToggleAudioWindow(); }} className={chip(audioWindowOpen || audioLayers.length > 0)}>
                    <Music className="h-3.5 w-3.5" />{t.animation.audioTrack}
                  </button>
                )}
                {onToggleAudioScrub && (
                  <button type="button" data-testid="phone-drawer-audio-scrub-btn" onClick={() => onToggleAudioScrub()} aria-pressed={audioScrubEnabled} className={chip(audioScrubEnabled)}>
                    <Headphones className="h-3.5 w-3.5" />{t.animation.audioScrub}
                  </button>
                )}
                <button type="button" disabled={!activeLayer || !onUpdateLayerKeyframes} onClick={() => { setPhoneDrawerOpen(false); setPanel('keyframes'); }} className={chip(Boolean(activeLayer?.meta?.keyframes?.length))}>
                  ◆ {t.animation.keyframeSection}
                </button>
                {can.editFolder && (
                  <button type="button" onClick={onToggleShared} aria-pressed={Boolean(active?.shared)} className={chip(Boolean(active?.shared))}>
                    <Users className="h-3.5 w-3.5" />{t.animation.trackShared}
                  </button>
                )}
                <button type="button" data-testid="phone-drawer-export-btn" onClick={() => { setPhoneDrawerOpen(false); setShowExportModal(true); }}
                  className="flex h-7 items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-600/20 px-2.5 text-[11px] font-bold text-emerald-300">
                  <Download className="h-3.5 w-3.5" />{t.common.export}
                </button>
              </div>
            </section>
          </div>
          </AtelierModal>
        </OverlayPresence>,
        document.body
      )}

      <AnimationExportModal
        open={showExportModal}
        onClose={() => setShowExportModal(false)}
        tracks={tracks}
        activeFolderId={activeFolderId}
        fps={fps}
        timelineLength={length}
        playbackRange={range}
        timecodeMode={timecode}
        canvasWidth={canvasWidth}
        canvasHeight={canvasHeight}
        cameraFrameSize={
          cameraLayer && cameraLayer.isVisible && cameraLayer.meta?.camera
            ? { width: cameraLayer.meta.camera.width, height: cameraLayer.meta.camera.height }
            : null
        }
        planExport={planExport}
        planCelExport={planCelExport}
      />
    </div>
  );
};
