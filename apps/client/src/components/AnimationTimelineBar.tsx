import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  AnimationEngine, AnimationTrack, MAX_HOLD, MAX_ONION, MAX_TIMELINE_FRAMES, OnionSkinConfig, TIMELINE_SLACK, celLayerOf, entryIndexAt, entryStart,
  formatTimecode, parseTimecode, trackLength, upsertTransformKeyframe, removeTransformKeyframe, type TimecodeMode,
} from '../engine/AnimationEngine';
import { clearLightTable, lightTableHas, toggleLightCel, type LightTableScope, type LightTableState } from '../engine/lightTable';
import {
  evaluateTransformKeyframes,
  type KeyframeEasing,
  type LayerModel,
  type TransformKeyframe,
} from '@atelier/shared';
import {
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Download, Eye, Film, Folder, Lamp, Loader2, Minus, Pause, Play, Plus,
  Repeat, Repeat2, SkipBack, SkipForward, Trash2, Users, X,
} from 'lucide-react';
import { AtelierModal, modalButton } from './AtelierModal';
import { getUserColor } from '../utils/userColors';
import {
  computeVideoExportDimensionsForResolution,
  getVideoExtensionFromBlob,
  unwrapMediaRecorderError,
  type VideoExportResolution,
} from '../engine/videoExport';
import { useI18n } from '../context/I18nContext';

/** What to put in a GIF / video: one folder (solo), every animation folder (team), or the whole picture */
export type AnimationExportScope = 'folder' | 'folders' | 'all';

/** Frames to encode: each segment is one distinct picture shown for `hold` frames */
export interface AnimationExportPlan {
  width: number;
  height: number;
  segments: Array<{ time: number; hold: number }>;
  render: (time: number) => HTMLCanvasElement;
  /** Puts the screen back */
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
  onDeleteFrame: () => void;
  onMoveFrame: (direction: -1 | 1) => void;
  onSetHold: (hold: number) => void;
  onToggleShared: () => void;
  onFpsChange: (fps: number) => void;
  /** A click on a track: that folder becomes the edited one, at that frame */
  onSelectCell: (folderId: string, time: number) => void;
  planExport: (opts: { scope: AnimationExportScope; useRange: boolean }) => AnimationExportPlan | null;
  activeLayer?: LayerModel | null;
  canvasWidth?: number;
  canvasHeight?: number;
  onUpdateLayerKeyframes?: (layerId: string, keyframes: TransformKeyframe[]) => void;
}

const TRACK_LABEL_WIDTH = 96;
const CELL = 36; // px per timeline frame
const RULER_HEIGHT = 20;
const ROW = 50;

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
  onCreateFolder, onAddFrame, onDuplicateFrame, onReuseCel, onDeleteFrame, onMoveFrame, onSetHold, onToggleShared, onFpsChange,
  onSelectCell, planExport, onPlaceEntries, onCopyEntries, onPasteEntries, onSetEntryHold, ripple, onToggleRipple,
  timelineLength, lengthIsSet, onSetLength, lightTable, onUpdateLightTable,
  activeLayer, canvasWidth = 1920, canvasHeight = 1080, onUpdateLayerKeyframes,
}) => {
  const { t } = useI18n();
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
  const mp4Supported = typeof MediaRecorder !== 'undefined' && (MediaRecorder.isTypeSupported('video/mp4;codecs=avc1') || MediaRecorder.isTypeSupported('video/mp4'));
  const canRecord = typeof MediaRecorder !== 'undefined';
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const suppressClickRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(engine.getIsPlaying());
  const [time, setTime] = useState(engine.getTime());
  const [range, setRange] = useState(engine.getRange());
  const [onionSkin, setOnionSkin] = useState<OnionSkinConfig>(engine.getOnionSkinConfig());
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [panel, setPanel] = useState<null | 'onion' | 'range' | 'reuse' | 'keyframes' | 'light'>(null);
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
  const [lightKind, setLightKind] = useState<LightTableScope['kind']>('cel');
  const [bezierDragIdx, setBezierDragIdx] = useState<null | 1 | 2>(null);
  const [gridViewport, setGridViewport] = useState({ left: 0, width: 960 });
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportFormat, setExportFormat] = useState<'gif' | 'mp4'>('gif');
  const [exportResolution, setExportResolution] = useState<VideoExportResolution>('4k');
  const [exportScope, setExportScope] = useState<AnimationExportScope>('folder');
  const [exportRangeOnly, setExportRangeOnly] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const fps = engine.getFps();

  useEffect(() => {
    if (!isOpen) return;
    setTime(engine.getTime());
    setIsPlaying(engine.getIsPlaying());
    const unsubFrame = engine.onFrameChange((t) => {
      setTime(t);
      const nextRange = engine.getRange();
      setRange((prev) => (prev?.start === nextRange?.start && prev?.end === nextRange?.end ? prev : nextRange));
      const nextOnion = engine.getOnionSkinConfig();
      setOnionSkin((prev) =>
        prev.enabled === nextOnion.enabled &&
        prev.prevFramesCount === nextOnion.prevFramesCount &&
        prev.nextFramesCount === nextOnion.nextFramesCount &&
        prev.opacity === nextOnion.opacity &&
        prev.prevColor === nextOnion.prevColor &&
        prev.nextColor === nextOnion.nextColor
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
    const x = TRACK_LABEL_WIDTH + time * CELL;
    if (x < el.scrollLeft + TRACK_LABEL_WIDTH || x + CELL > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.max(0, x - TRACK_LABEL_WIDTH - CELL * 2);
  }, [time, isOpen]);

  // While dragging: follow the pointer over the tracks; drop moves the cel or sets its hold
  const activeKfs = activeLayer?.meta?.keyframes ?? [];
  const showKfRow = Boolean(activeLayer && (panel === 'keyframes' || activeKfs.length > 0));
  const dragging = Boolean(drag);
  useEffect(() => {
    if (!dragging) return;
    const at = (e: PointerEvent) => {
      const el = gridRef.current!;
      const r = el.getBoundingClientRect();
      const trackTop = RULER_HEIGHT * (showKfRow ? 2 : 1);
      return { t: (e.clientX - r.left + el.scrollLeft - TRACK_LABEL_WIDTH) / CELL, row: Math.floor((e.clientY - r.top + el.scrollTop - trackTop) / ROW) };
    };
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.started && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
      const { t, row } = at(e);
      if (d.mode === 'hold') {
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
  }, [dragging, tracks, can.addableFolderIds, onPlaceEntries, onSetEntryHold, showKfRow]);

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
    const downFrame = grid ? Math.floor((e.clientX - grid.getBoundingClientRect().left + grid.scrollLeft - TRACK_LABEL_WIDTH) / CELL) : entryStart(track.entries, index);
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

  // Frames shown: the timeline plus room after it to put cels on (Krita shows empty frames too)
  const shownLength = length + TIMELINE_SLACK;
  const timeAt = (e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(shownLength - 1, Math.floor((e.clientX - rect.left) / CELL)));
  };

  const handleExportAnimation = async () => {
    const plan = planExport({ scope: exportScope, useRange: exportRangeOnly && Boolean(range) });
    if (!plan || plan.segments.length === 0) {
      alert(t.animation.noFramesToExport);
      return;
    }
    try {
      setExportProgress(t.animation.preparing);
      const { ExportEngine } = await import('../engine/ExportEngine');
      const total = plan.segments.length;
      // Frames are rendered one at a time; the GIF encoder takes each as it comes
      const next = async (i: number) => {
        setExportProgress(t.animation.renderingFrame.replace('{current}', String(i + 1)).replace('{total}', String(total)));
        await new Promise((r) => setTimeout(r, 0)); // let the progress paint
        return { canvas: plan.render(plan.segments[i].time), hold: plan.segments[i].hold };
      };
      let blob: Blob;
      if (exportFormat === 'gif') {
        blob = await ExportEngine.exportGifAnimation(next, total, plan.width, plan.height, fps);
      } else {
        setExportProgress(t.animation.recordingVideo);
        blob = await ExportEngine.exportVideoAnimation(
          next,
          total,
          plan.width,
          plan.height,
          fps,
          'mp4',
          exportResolution
        );
      }
      const ext = exportFormat === 'gif' ? 'gif' : getVideoExtensionFromBlob(blob, 'mp4');
      ExportEngine.downloadBlob(blob, `animation_${Date.now()}.${ext}`);
      setShowExportModal(false);
    } catch (err: unknown) {
      alert(`${t.animation.exportFailed}: ${unwrapMediaRecorderError(err).message}`);
    } finally {
      plan.done();
      setExportProgress(null);
    }
  };

  if (!isOpen) return null;
  const iconBtn = 'flex h-7 min-w-7 shrink-0 items-center justify-center gap-0.5 rounded px-1 text-neutral-300 hover:bg-neutral-800 hover:text-white disabled:opacity-35 disabled:hover:bg-transparent';
  const chip = (on: boolean) => `flex h-7 shrink-0 items-center gap-1 rounded-lg border px-2 text-[11px] font-bold disabled:opacity-40 ${on ? 'border-amber-500/60 bg-amber-500/15 text-amber-300' : 'border-neutral-700/70 text-neutral-300 hover:bg-neutral-800'}`;
  const stepper = (label: string, value: number, set: (n: number) => void, min: number, max: number) => (
    <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-neutral-400">
      {label}
      <button type="button" onClick={() => set(value - 1)} disabled={value <= min} aria-label={`${label} -1`} className={iconBtn}><Minus className="h-3 w-3" /></button>
      <span className="w-5 text-center font-mono text-xs font-bold text-white">{value}</span>
      <button type="button" onClick={() => set(value + 1)} disabled={value >= max} aria-label={`${label} +1`} className={iconBtn}><Plus className="h-3 w-3" /></button>
    </span>
  );
  const tc = (frame: number) => formatTimecode(frame, fps, timecode);
  const rangeText = range ? `${tc(range.start)}–${tc(range.end)}` : t.animation.rangeAll;
  // Light table of the cel on screen, or of the whole edited track
  const currentCel = celLayerOf(current);
  const lightScope: LightTableScope | null = lightKind === 'track' ? (activeFolderId ? { kind: 'track', id: activeFolderId } : null) : currentCel ? { kind: 'cel', id: currentCel } : null;
  const lightNow = new Set([...(activeFolderId ? lightTable.tracks[activeFolderId] ?? [] : []), ...(currentCel ? lightTable.cels[currentCel] ?? [] : [])]);
  if (currentCel) lightNow.delete(currentCel);
  const lightCount = lightNow.size;
  const commitLength = () => {
    if (lengthDraft === null) return;
    const frame = parseTimecode(lengthDraft, fps);
    setLengthDraft(null);
    if (frame !== null) onSetLength(Math.min(MAX_TIMELINE_FRAMES, frame + 1));
  };
  const exportFrames = exportRangeOnly && range ? range.end - range.start + 1 : length;

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onTimelineKey} data-anim-timeline style={{ touchAction: 'none' }}
      className={`relative z-10 flex shrink-0 flex-col overflow-hidden border-t border-neutral-800 bg-neutral-950/95 outline-none transition-all duration-200 ${isCollapsed ? 'h-10' : 'h-52 sm:h-56'}`}>
      {/* Transport */}
      <div style={{ touchAction: 'pan-x' }} role="toolbar" aria-label={t.animation.timeline}
        className="no-scrollbar flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-neutral-800/80 bg-neutral-900/90 px-2 text-xs text-neutral-300">
        <div className="flex shrink-0 items-center gap-1.5 border-r border-neutral-800 pr-2 font-bold text-white">
          <Film className="h-4 w-4 text-rose-400" />
          <span className="max-w-[8rem] truncate" title={active?.name}>{active?.name ?? t.animation.timeline}</span>
          {active?.shared && <span title={t.animation.sharedFolderTooltip} className="rounded bg-sky-500/20 px-1 text-[9px] text-sky-300">{t.animation.trackShared}</span>}
        </div>
        {tracks.length > 0 && (
          <>
            <button type="button" onClick={() => engine.goToStart()} title={t.animation.firstCel} aria-label={t.animation.firstCel} className={iconBtn}><SkipBack className="h-3.5 w-3.5" /></button>
            <button type="button" onClick={() => engine.goToPrevFrame()} title={t.animation.prevCel} aria-label={t.animation.prevCel} className={iconBtn}><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" onClick={() => engine.togglePlay()} disabled={(range ? range.end - range.start + 1 : length) < 2}
              title={isPlaying ? t.animation.pause : t.animation.play}
              className={`flex shrink-0 items-center gap-1 rounded-lg px-3 py-1 text-xs font-bold text-white shadow disabled:opacity-40 ${isPlaying ? 'bg-amber-600 hover:bg-amber-500' : 'bg-rose-600 hover:bg-rose-500'}`}>
              {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              <span>{isPlaying ? t.animation.pause : t.animation.play}</span>
            </button>
            <button type="button" onClick={() => engine.goToNextFrame()} title={t.animation.nextCel} aria-label={t.animation.nextCel} className={iconBtn}><ChevronRight className="h-4 w-4" /></button>
            <button type="button" onClick={() => engine.goToEnd()} title={t.animation.lastCel} aria-label={t.animation.lastCel} className={iconBtn}><SkipForward className="h-3.5 w-3.5" /></button>
            <button type="button" onClick={() => engine.setLoop(!loop)} aria-pressed={loop} title={t.animation.loop} aria-label={t.animation.loop}
              className={`${iconBtn} ${loop ? 'bg-amber-500/15 !text-amber-300' : ''}`}><Repeat2 className="h-3.5 w-3.5" /></button>
            <button type="button" onClick={toggleTimecode} title={t.animation.timecodeToggle} aria-label={t.animation.currentFrame}
              className="shrink-0 rounded px-1 font-mono text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-white">
              {formatTimecode(time, fps, timecode)}/{formatTimecode(length - 1, fps, timecode)}
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
            <button type="button" onClick={() => setPanel(panel === 'light' ? null : 'light')} aria-pressed={panel === 'light'}
              title={t.animation.lightTableTooltip} className={chip(lightTable.enabled && lightCount > 0)}>
              <Lamp className="h-3.5 w-3.5" />{t.animation.lightTable}
              {lightTable.enabled && lightCount > 0 && <span className="font-mono text-[10px]">{lightCount}</span>}
            </button>
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
            <button type="button" onClick={() => setShowExportModal(true)} title={t.animation.exportModalTitle}
              className="ml-auto flex h-7 shrink-0 items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-600/20 px-2 text-[11px] font-bold text-emerald-300 hover:bg-emerald-600/30">
              <Download className="h-3 w-3" /><span className="hidden sm:inline">{t.common.export}</span>
            </button>
          </>
        )}
        <div className={`flex shrink-0 items-center ${tracks.length ? '' : 'ml-auto'}`}>
          <button type="button" onClick={() => setIsCollapsed(!isCollapsed)} aria-label={isCollapsed ? t.animation.expandTimeline : t.animation.collapseTimeline} className={iconBtn}>
            {isCollapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          <button type="button" onClick={onClose} aria-label={t.animation.closeTimeline} className={iconBtn}><X className="h-3.5 w-3.5" /></button>
        </div>
      </div>

      {!isCollapsed && tracks.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-3 text-center text-[11px] text-neutral-400">
          <span>{t.animation.createFolderDesc}</span>
          <button type="button" onClick={onCreateFolder} disabled={!can.createFolder}
            className="atelier-btn atelier-btn--primary">
            <Plus className="h-3.5 w-3.5" />{t.animation.createFolder}
          </button>
        </div>
      )}

      {!isCollapsed && tracks.length > 0 && (
        <>
          {/* Edit row, or the settings panel that is open */}
          <div style={{ touchAction: 'pan-x' }} className="no-scrollbar flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-800/60 px-2 text-[11px] text-neutral-300">
            {panel === 'onion' && (
              <>
                <button type="button" onClick={() => updateOnion({ enabled: !onionSkin.enabled })} aria-pressed={onionSkin.enabled} className={chip(onionSkin.enabled)}>
                  {onionSkin.enabled ? t.animation.onionSkinOn : t.animation.onionSkinOff}
                </button>
                {stepper(t.animation.onionPrev, onionSkin.prevFramesCount, (n) => updateOnion({ prevFramesCount: n }), 0, MAX_ONION)}
                {stepper(t.animation.onionNext, onionSkin.nextFramesCount, (n) => updateOnion({ nextFramesCount: n }), 0, MAX_ONION)}
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
              const curEval = evaluateTransformKeyframes(kfs, time, defPx, defPy);
              const exactKf = kfs.find((k) => Math.round(k.frame) === time);
              const curEasing: KeyframeEasing = exactKf?.easing ?? 'easeInOut';
              const curBezier: [number, number, number, number] = exactKf?.bezier ?? [0.42, 0, 0.58, 1];
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
                  easing: exactKf?.easing ?? curEasing,
                  bezier: exactKf?.bezier ?? curBezier,
                  ...patch,
                };
                onUpdateLayerKeyframes(activeLayer.id, upsertTransformKeyframe(kfs, nextKf));
              };
              const numBox = (label: string, val: number, step: number, onSet: (n: number) => void, w = 'w-12') => (
                <label className="flex shrink-0 items-center gap-0.5 text-[10px] text-neutral-400">
                  <span>{label}</span>
                  <input
                    type="number"
                    step={step}
                    value={Number.isFinite(val) ? Number(val.toFixed(1)) : 0}
                    onChange={(e) => {
                      const n = parseFloat(e.target.value);
                      if (Number.isFinite(n)) onSet(n);
                    }}
                    className={`h-6 ${w} rounded border border-neutral-700 bg-neutral-900 px-1 font-mono text-[10px] text-white outline-none`}
                  />
                </label>
              );
              const updateBezierPoint = (svg: SVGSVGElement, clientX: number, clientY: number, idx: 1 | 2) => {
                const rect = svg.getBoundingClientRect();
                const nx = Math.max(0, Math.min(1, Number((((clientX - rect.left - 4) / Math.max(1, rect.width - 8))).toFixed(2))));
                const ny = Math.max(-0.5, Math.min(1.5, Number((1 - (clientY - rect.top - 4) / Math.max(1, rect.height - 8)).toFixed(2))));
                const b: [number, number, number, number] = [...curBezier];
                if (idx === 1) { b[0] = nx; b[1] = ny; } else { b[2] = nx; b[3] = ny; }
                commitKf({ easing: 'cubicBezier', bezier: b });
              };
              const mapX = (u: number) => 4 + u * 48;
              const mapY = (v: number) => 4 + (1 - Math.max(-0.2, Math.min(1.2, v))) * 48;
              return (
                <>
                  <span className="shrink-0 truncate max-w-[84px] text-[10px] font-semibold text-indigo-300">{activeLayer.name}</span>
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
                    onClick={() => commitKf({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, pivotX: defPx, pivotY: defPy })}
                    className={iconBtn}
                  >
                    {t.animation.keyframeReset}
                  </button>
                  {numBox(t.animation.keyframeX, curEval.x, 2, (v) => commitKf({ x: v }))}
                  {numBox(t.animation.keyframeY, curEval.y, 2, (v) => commitKf({ y: v }))}
                  {numBox(t.animation.keyframeScale, curEval.scaleX * 100, 5, (v) => { const s = Math.max(0.05, v / 100); commitKf({ scaleX: s, scaleY: s }); })}
                  {numBox(t.animation.keyframeRotation, (curEval.rotation * 180) / Math.PI, 5, (deg) => commitKf({ rotation: (deg * Math.PI) / 180 }))}
                  {numBox(t.animation.keyframePivotX, curEval.pivotX, 4, (v) => commitKf({ pivotX: v }))}
                  {numBox(t.animation.keyframePivotY, curEval.pivotY, 4, (v) => commitKf({ pivotY: v }))}
                  <label className="flex shrink-0 items-center gap-1 text-[10px] text-neutral-400">
                    <span>{t.animation.keyframeEasing}</span>
                    <select
                      value={curEasing}
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
                  {curEasing === 'cubicBezier' && (
                    <div className="relative flex shrink-0 items-center gap-1 rounded border border-neutral-700 bg-neutral-900/90 px-1.5 py-0.5" title={t.animation.keyframeBezierHint}>
                      <svg
                        width={56}
                        height={56}
                        className="h-7 w-7 cursor-crosshair touch-none overflow-visible"
                        onPointerMove={(e) => { if (bezierDragIdx) updateBezierPoint(e.currentTarget, e.clientX, e.clientY, bezierDragIdx); }}
                        onPointerUp={() => setBezierDragIdx(null)}
                        onPointerCancel={() => setBezierDragIdx(null)}
                      >
                        <line x1={mapX(0)} y1={mapY(0)} x2={mapX(1)} y2={mapY(1)} stroke="#374151" strokeWidth="1" strokeDasharray="2 2" />
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
                <span className="mx-1 h-4 w-px shrink-0 bg-neutral-800" />
                {current
                  ? stepper(t.animation.celHoldFrames, current.hold, (n) => onSetHold(Math.max(1, Math.min(MAX_HOLD, n))), canEditEntry ? 1 : current.hold, canEditEntry ? MAX_HOLD : current.hold)
                  : <span className="shrink-0 text-neutral-500">—</span>}
                <button type="button" onClick={() => onMoveFrame(-1)} disabled={!canEditEntry || currentIdx <= 0} title={t.animation.prevCel} aria-label={t.animation.prevCel} className={iconBtn}>◀</button>
                <button type="button" onClick={() => onMoveFrame(1)} disabled={!canEditEntry || currentIdx < 0 || currentIdx >= entries.length - 1} title={t.animation.nextCel} aria-label={t.animation.nextCel} className={iconBtn}>▶</button>
                <button type="button" onClick={onDeleteFrame} disabled={!canEditEntry || entries.length <= 1} title={t.animation.deleteCel} aria-label={t.animation.deleteCel} className={`${iconBtn} hover:!text-rose-400`}><Trash2 className="h-3.5 w-3.5" /></button>
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

          {/* Tracks (horizontally virtualized so 10,000+ frames stay <100 DOM nodes) */}
          {(() => {
            const visFrameStart = Math.max(0, Math.floor((gridViewport.left - TRACK_LABEL_WIDTH) / CELL) - 4);
            const visFrameEnd = Math.min(shownLength - 1, Math.ceil((gridViewport.left - TRACK_LABEL_WIDTH + gridViewport.width) / CELL) + 4);
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
            <div className="relative" style={{ width: TRACK_LABEL_WIDTH + shownLength * CELL, minWidth: '100%' }}>
              {/* Ruler */}
              <div className="sticky top-0 z-20 flex border-b border-neutral-800 bg-neutral-900" style={{ height: RULER_HEIGHT }}>
                <div style={{ width: TRACK_LABEL_WIDTH }} className="sticky left-0 z-10 shrink-0 border-r border-neutral-800 bg-neutral-900 px-1 text-[10px] leading-5 text-neutral-500">{t.animation.framesHeader}</div>
                <div role="slider" aria-label={t.animation.timeAria} aria-valuemin={1} aria-valuemax={shownLength} aria-valuenow={time + 1} tabIndex={0}
                  onClick={(e) => engine.goTo(timeAt(e))}
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
              {/* Active Layer Transform Keyframes Lane */}
              {showKfRow && (
                <div className="flex border-b border-neutral-800/80 bg-neutral-950/80" style={{ height: RULER_HEIGHT }}>
                  <button
                    type="button"
                    onClick={() => setPanel(panel === 'keyframes' ? null : 'keyframes')}
                    className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-neutral-800 bg-neutral-900 px-1.5 text-[9px] font-semibold text-amber-300 truncate"
                    title={t.animation.keyframeSection}
                    style={{ width: TRACK_LABEL_WIDTH }}
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
                      style={{ width: TRACK_LABEL_WIDTH, borderLeftColor: color }}>
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
                        return (
                          <div key={e.id} data-entry onPointerDown={(ev) => startDrag(ev, track, i)}
                            onClick={(ev) => { if (!suppressClickRef.current && pickForSelection(ev, track, e.id)) ev.stopPropagation(); }}
                            aria-selected={isSelected}
                            aria-label={`${track.name} #${start + 1}: ${e.label} (${e.hold})`}
                            className={`absolute top-1 bottom-1 flex flex-col overflow-hidden rounded-md border ${
                              isSelected ? 'border-sky-400 ring-2 ring-sky-400/70' : isCurrent ? 'border-rose-400 ring-2 ring-rose-500/70' : onion === 'prev' ? 'border-red-500/70' : onion === 'next' ? 'border-emerald-500/70' : 'border-neutral-700'
                            } ${e.ref !== undefined ? 'border-dashed bg-neutral-800/60' : 'bg-neutral-900'} ${editable ? 'cursor-grab' : ''} ${isDragged && drag.mode === 'move' ? 'opacity-40' : ''}`}
                            style={{ left: start * CELL + 1, width: hold * CELL - 2 }}>
                            {editable && (
                              <span data-hold-handle title={t.animation.celHoldFrames} aria-hidden style={{ touchAction: 'none' }}
                                className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize bg-white/0 hover:bg-amber-400/40" />
                            )}
                            {isDragged && drag.mode === 'hold' && (
                              <span className="absolute right-2 top-3.5 z-10 rounded bg-amber-500 px-1 font-mono text-[9px] font-bold text-black">{hold}</span>
                            )}
                            <span data-drag-handle style={editable ? { touchAction: 'none' } : undefined}
                              className="flex h-3.5 shrink-0 items-center gap-0.5 truncate px-0.5 text-[9px] font-bold text-neutral-300">
                              {e.ref !== undefined && <Repeat className="h-2.5 w-2.5 shrink-0 text-sky-300" />}
                              {e.isGroup && e.ref === undefined && <Folder className="h-2.5 w-2.5 shrink-0" />}
                              {isActive && lightTable.enabled && shownId && lightNow.has(shownId) && <Lamp aria-label={t.animation.lightTable} className="h-2.5 w-2.5 shrink-0 text-amber-300" />}
                              <span className="truncate">{e.ref !== undefined ? (track.entries.find((x) => x.id === e.ref)?.label ?? '—') : e.label}</span>
                            </span>
                            <span className="mx-0.5 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-sm bg-white/90">
                              {shownId && <AnimThumbImg layerId={shownId} thumbnails={thumbnails} subscribeThumbnails={subscribeThumbnails} getThumbnailsSnapshot={getThumbnailsSnapshot} className="pointer-events-none h-full w-full object-contain" />}
                            </span>
                            <span className="h-1 shrink-0" style={{ backgroundColor: onion === 'prev' ? onionSkin.prevColor : onion === 'next' ? onionSkin.nextColor : getUserColor(e.ownerId).hex, opacity: onion ? 1 : 0.7 }} />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {/* Playhead */}
              <div data-playhead className="pointer-events-none absolute top-0 bottom-0 z-10 border-x border-rose-500/80 bg-rose-500/10" style={{ left: TRACK_LABEL_WIDTH + time * CELL, width: CELL }} />
            </div>
          </div>
            );
          })()}
        </>
      )}

      {showExportModal && (
        <AtelierModal title={t.animation.exportModalTitle} icon={<Film />} onClose={() => !exportProgress && setShowExportModal(false)}
          footer={
            <>
              <button type="button" className={modalButton.secondary} disabled={Boolean(exportProgress)} onClick={() => setShowExportModal(false)}>{t.common.cancel}</button>
              <button type="button" className={modalButton.primary} onClick={handleExportAnimation} disabled={Boolean(exportProgress) || (exportFormat === 'mp4' && !canRecord)}>
                {exportProgress ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {exportProgress ?? (exportFormat === 'mp4' && !mp4Supported && canRecord ? t.animation.exportWebm : t.animation.exportDownload)}
              </button>
            </>
          }>
          <div className="space-y-3">
            <div role="radiogroup" aria-label={t.animation.exportFormat} className="grid grid-cols-2 gap-2">
              {([['gif', t.animation.exportGif, 'GIF'], ['mp4', t.animation.exportMp4, 'MP4 / WebM']] as const).map(([id, label, hint]) => (
                <button key={id} type="button" role="radio" aria-checked={exportFormat === id} onClick={() => setExportFormat(id)}
                  className={`flex flex-col gap-0.5 rounded-xl border p-3 text-left ${exportFormat === id ? 'border-emerald-500 bg-emerald-600/20 text-white' : 'border-neutral-800 text-neutral-400 hover:bg-neutral-800'}`}>
                  <span className="text-xs font-bold">{label}</span>
                  <span className="text-[10px] text-neutral-500">{hint}</span>
                </button>
              ))}
            </div>
            {exportFormat === 'mp4' && (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-neutral-800 bg-neutral-900/60 px-3 py-2">
                <span className="text-xs text-neutral-300">{t.replay.resolution}</span>
                <select
                  aria-label={t.replay.resolution}
                  value={exportResolution}
                  onChange={(e) => setExportResolution(e.target.value as VideoExportResolution)}
                  disabled={Boolean(exportProgress)}
                  className="rounded-lg border border-neutral-700 bg-neutral-800 px-2 py-1 font-mono text-xs text-neutral-200 outline-none"
                >
                  {(['1080p', '2k', '4k'] as const).map((tier) => {
                    const dims = computeVideoExportDimensionsForResolution(canvasWidth, canvasHeight, tier);
                    const label = tier === '1080p' ? '1080p' : tier.toUpperCase();
                    return (
                      <option key={tier} value={tier}>
                        {label} ({dims.width}×{dims.height})
                      </option>
                    );
                  })}
                </select>
              </div>
            )}
            <div role="radiogroup" aria-label={t.animation.exportContent} className="space-y-1.5">
              {([
                ['folder', active?.name ?? t.animation.timeline, '1'],
                ['folders', `${t.animation.timeline} (${tracks.length})`, String(tracks.length)],
                ['all', t.animation.rangeAll, 'All'],
              ] as const).map(([id, label, hint]) => (
                <button key={id} type="button" role="radio" aria-checked={exportScope === id} onClick={() => setExportScope(id)}
                  className={`flex w-full flex-col gap-0.5 rounded-xl border px-3 py-2 text-left ${exportScope === id ? 'border-emerald-500 bg-emerald-600/20 text-white' : 'border-neutral-800 text-neutral-400 hover:bg-neutral-800'}`}>
                  <span className="text-xs font-bold">{label}</span>
                  <span className="text-[10px] text-neutral-500">{hint}</span>
                </button>
              ))}
            </div>
            <label className={`flex items-center gap-2 text-xs ${range ? 'text-neutral-300' : 'text-neutral-600'}`}>
              <input type="checkbox" checked={exportRangeOnly && Boolean(range)} disabled={!range} onChange={(e) => setExportRangeOnly(e.target.checked)} />
              {t.animation.rangePresetText.replace('{range}', range ? t.animation.rangeFrameText.replace('{start}', String(range.start + 1)).replace('{end}', String(range.end + 1)) : t.animation.rangeNotSet)}
            </label>
            <p className="text-[11px] text-neutral-400">{exportFrames} · {fps} FPS · {(exportFrames / fps).toFixed(1)} {t.common.seconds}</p>
          </div>
        </AtelierModal>
      )}
    </div>
  );
};
