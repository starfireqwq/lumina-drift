import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { PluginAction, PluginManifestModern } from '../plugins/pluginApi';
import type { PluginV2Result } from '../plugins/pluginRpc';
import {
  PluginCanvasTransaction,
  type PluginBrushPatch,
  type PluginBrushState,
  type PluginCanvasHostAdapter,
  type PluginTimelineBridge,
} from '../plugins/pluginCanvasBridge';
import { createSelectionEngineBridge } from '../plugins/pluginSelectionBridge';
import { getPluginLabels } from '../plugins/pluginLabels';
import { getPlugins, subscribePlugins } from '../plugins/pluginStore';
import {
  createPluginV3RpcHandler,
  executeMcpCanvasTool,
  getDesktopPluginV3,
  killAllPluginV3Bridges,
} from '../plugins/pluginV3Client';
import {
  buildInitialToolOptions,
  collectEnabledPluginTools,
  makePluginToolKey,
  PluginToolPointerController,
  type RawPointerSample,
  type RegisteredPluginTool,
} from '../plugins/pluginTools';
import { startPluginToolSessionInWorker } from '../plugins/runPlugin';
import { Application, Container, type Filter, Graphics, MaskFilter, Rectangle, RenderTexture, Sprite, Texture } from 'pixi.js';

function getTargetDisplayResolution(): number {
  if (typeof window === 'undefined') return 1;
  const dpr = window.devicePixelRatio;
  return Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 2) : 1;
}

function parseWorkspaceBgColor(cssColor: string, fallback = 0x0d0e12): number {
  const s = cssColor.trim();
  if (!s) return fallback;
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex.slice(0, 6);
    const parsed = Number.parseInt(full, 16);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  const nums = s.match(/[\d.]+/g);
  if (nums && nums.length >= 3) {
    const [r, g, b] = nums.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(Number(v)))));
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return (r << 16) | (g << 8) | b;
  }
  return fallback;
}
import { getShowBrushCrosshair, subscribeShowBrushCrosshair } from '../engine/inputPreferences';
import {
  AtelierBrushPreset,
  MIN_BRUSH_SPACING,
  CanvasModel,
  DEFAULT_TILE_SIZE,
  computeSmartEncloseFillMask,
  evaluateTransformKeyframes,
  type EvaluatedTransform,
  expandSelectionMask,
  floodFillMagicWand,
  hexToRgb,
  getTileBounds,
  hitTestVectorStroke,
  LayerMeta,
  LayerModel,
  LayerTextMeta,
  tileToRgba,
  type TransformKeyframe,
  rasterizeLassoMask,
  OpBroadcastPacket,
  PreviewDabPacket,
  ScopedUndoOp,
  TileCoord,
  TileData,
  TilePatchPacket,
  ToolType,
  CanvasUnit,
  CelMark,
  TimelineLabel,
  clampDpi,
  computeGroupedAscendingNonMaskIds,
  filterTopLevelSelectedLayers,
  findTopAnchorForParent,
  orderLayersForReparenting,
  tidyLayerModels,
} from '@atelier/shared';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useI18n } from '../context/I18nContext';
import { CanvasViewport, ViewportState } from '../engine/Viewport';
import { LayerManager, type TileConcurrencyContext } from '../engine/LayerManager';
import { compressTiles, decodeTiles, warmUpCommitWorkers } from '../engine/commitWorkers';
import { commitInOrder, diffTilesAsync, tilesAsync, whenToolCommitsDone } from './workspace/tools/asyncTiles';
import { BrushProperties, BrushRenderer } from '../engine/BrushRenderer';
import { StrokePipeline } from '../engine/StrokePipeline';
import { normalizeTileBytes, TileEngine } from '../engine/TileEngine';
import { OFFLINE_UNDO_LIMIT, ONLINE_UNDO_LIMIT, ScopedUndoManager } from '../engine/ScopedUndoManager';
import { OfflineSessionStore } from '../services/offlineStore';
import { SelectionEngine } from '../engine/SelectionEngine';
import { WebGLFilterEngine } from '../engine/WebGLFilterEngine';
import { ShortcutManager } from '../engine/ShortcutManager';
import { FloatingStudioPanel } from './FloatingStudioPanel';
import type { FolderAccess } from './workspace/useFolderAccess';
import { roomMemberCards } from '../utils/roomMembers';
import { BRUSH_TOOL_DEFAULTS, isBrushTool, loadBrushTool, saveBrushTool } from '../engine/brushToolSettings';
import {
  boxFromAnchor,
  type AnchorKey,
  type ResizeBox,
} from '../utils/canvasResize';
import { ViewportToolbar } from './ViewportToolbar';
import { OverlayPresence } from './OverlayPresence';
import { CanvasStickersOverlay } from './CanvasStickersOverlay';
import { ColorWheelStudio } from './ColorWheelStudio';
import { UserListPanel } from './UserListPanel';
import { ToolRail } from './workspace/ToolRail';
import { BrushSideSliders, MobileBrushSliders } from './workspace/BrushSideSliders';
import { BezierMode, SelectionMode, ToolOptionsBar } from './workspace/ToolOptionsBar';
import { DockColumn, DockRow, FloatingPanels, MobilePanelSheet, type MobilePanelDef, PanelDef, ToolDockSlot } from './workspace/DockSystem';
import { dockActions, PanelId, PANEL_TITLES, useDockLayout, useFloatsAllowed, usePhoneLayout, useTouchTabletLayout } from './workspace/dockStore';
import { TouchSideIsland, TouchToolIsland } from './workspace/TouchCanvasChrome';
import { ALL_TOOLS, TOOL_CATEGORIES, findSubTool, getLocalizedCategoryLabel, MAX_BRUSH_SIZE, nextSizeStep } from './workspace/toolCatalog';
import type { SubToolDef, SubToolId, SubToolParams, ToolCategoryId } from './workspace/toolCatalog';
import { subToolStore, useSubToolStore } from './workspace/subToolStore';
import { SubToolPanel } from './workspace/SubToolPanel';
import { RemoteCursorsLayer } from './workspace/RemoteCursorsLayer';
import { OpLogPanel } from './workspace/OpLogPanel';
import { QuickKeysPanel } from './workspace/QuickActions';
import { playWorkspaceEntrance } from './workspace/workspaceEntrance';
import type { ToolContext } from './workspace/tools/toolContext';
import { LIQUIFY_TOOLS, useLiquifyTool } from './workspace/tools/useLiquifyTool';
import { SHAPE_TOOLS, useShapeTools } from './workspace/tools/useShapeTools';
import { useSelectionTools } from './workspace/tools/useSelectionTools';
import { useFillTools } from './workspace/tools/useFillTools';
import { useVectorTools } from './workspace/tools/useVectorTools';
import { useBrushTool } from './workspace/tools/useBrushTool';
import { useTransformTool } from './workspace/tools/useTransformTool';
import { readContent, useLayerAlign } from './workspace/tools/useLayerAlign';
import {
  alignTargetsBlocker, resolveAlignTargets, selectionFrame, summarizeGuides,
  type AlignBasis, type AlignX, type AlignY, type DistributeMode,
} from '../utils/layerAlign';
import type { AlignUiOptions } from './LayerAlignWindow';
import { useCanvasPointer } from './workspace/tools/useCanvasPointer';
import { findContentBounds } from '../utils/pixelBounds';
import { VectorEditResult } from '../engine/VectorEngine';
import {
  buildPenStroke,
  deleteAnchor,
  hitTestNodes,
  moveAnchor,
  moveHandle,
  PenPoint,
  toggleCorner,
  VectorHit,
} from '../engine/vectorEditing';
import type { TransformBox } from './TransformOverlay';
import { RulerManager } from '../engine/RulerManager';
import { RulerOverlay } from './RulerOverlay';
import { FilterPointOverlay } from './FilterPointOverlay';
import { TouchRadialMenu } from './TouchRadialMenu';
import { TouchClipboardMenu } from './TouchClipboardMenu';
import { TouchEyedropperLoupe, type TouchEyedropperState } from './TouchEyedropperLoupe';
import {
  getCanvasFullscreen,
  getTouchGestureSettings,
  setCanvasFullscreen,
  subscribeCanvasFullscreen,
  subscribeTouchGestureSettings,
  toggleCanvasFullscreen,
} from '../engine/touchGestures';
import type { DistortMode } from '../utils/distortModes';
import { LiquifyEngine } from '../engine/LiquifyEngine';
import { BlurSmudgeEngine } from '../engine/BlurSmudgeEngine';
import { ApiService } from '../services/api';
import type { LayerCanvasItem } from '../engine/layerComposite';
import { LayerPanel } from './LayerPanel';
import { getUserColor } from '../utils/userColors';
import {
  AnimationEngine, AnimationTrack, animationDisplay, BLANK_CEL_NAME, celEntriesOf, celInsertAt, celLayerOf, celOfLayer, entryIndexAt, entryStart, exportSegments, findAdjacentKeyframe, isAnimationFolder, MAX_HOLD, MAX_TIMELINE_FRAMES, movedByKeyframes,
  normalizeTimelineLabels, placeEntries, planRepeatCels, planSequentialCelRenames, trackLength, upsertTransformKeyframe,
  type LightTableDisplayItem,
} from '../engine/AnimationEngine';
import {
  buildKeyframeFromEval,
  resolveParentWorldAffine,
  sampleKeyframeMotionPath,
  type KeyframeBaseRect,
} from '../utils/keyframeTransform';
import {
  externalRefsFor,
  getLightTableTransform,
  lightIdsFor,
  lightTableTransformToAffine,
  loadLightTable,
  saveLightTable,
  type LightTableState,
} from '../engine/lightTable';
import { renderCameraFrameCanvas } from '../engine/animationExport';
import {
  AudioTrackPlayer,
  loadAudioAssetSummaries,
  subscribeAudioAssets,
  type AudioAssetSummary,
} from '../engine/AudioTrackEngine';
import { DEFAULT_TEXT, renderText, textBounds } from '../engine/textLayer';
import { nextGroupName } from '../utils/canvasName';
import type {
  AnimationCelExportItem,
  AnimationCelExportPlan,
  AnimationExportPlan,
  AnimationExportPlanRequest,
} from './AnimationTimelineBar';
import {
  type AudioTrackMeta,
  BlendMode,
  type CameraFrameMeta,
  ColorCurvesOptions,
  computeCameraCanvasToOutputMatrix,
  computeCameraPreviewViewport,
  evaluateCameraFrame,
  type FilterValues,
  findCameraLayer,
  getCanvasRoleCapabilities,
  GradientPresetName,
  GradientStop,
  isAudioLayer,
  LayerType,
  normalizeAudioTrackMeta,
  normalizeCameraMeta,
  RemovedLayer,
  VectorEraserMode,
  VectorStroke,
  VectorWidthMode,
} from '@atelier/shared';
import { VectorOverlay } from './VectorOverlay';
import { VectorEngine } from '../engine/VectorEngine';
import { filterDraftFactor, filterFitsLayer, filterLabel, filterPointParam, getFilter, type FilterJob } from '../utils/filterRegistry';
import { filterPoint } from '../utils/filterPoint';
import { FilterWorkerClient } from '../engine/filterWorkerClient';
import { PluginFilterWorkerClient } from '../plugins/pluginFilterClient';
import { assessFilterCompositeMemory, filterNewLayerPlacement, filterNonEmptyTileCoords } from '../utils/filterMemoryGuard';
import type { FilterTargetOptions } from './FilterTargetBar';
import { AtelierModal, modalButton } from './AtelierModal';
import { AlertCircle, AlignCenter, Eye, Grid2x2, ImagePlus, Keyboard, Layers, Minimize2, Paintbrush, Palette, Sliders, Terminal, Users } from 'lucide-react';
import { type DroppedImages, type ImageDropTarget, ImageImportError, imageEntries, isImageDrag, loadImageEntry, readDroppedImages } from '../utils/imageImport';

/** Where a key types text (a text field), unlike a focused button, slider, checkbox or the page */
const isTypingTarget = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  if (!el?.closest) return false;
  if (el.closest('textarea, select, [contenteditable]:not([contenteditable="false"])')) return true;
  const input = el.closest('input');
  return Boolean(input && !['range', 'checkbox', 'radio', 'button', 'color', 'submit', 'reset', 'file'].includes(input.type));
};

function ViewportConsumer<T = ViewportState>({
  subscribe,
  getSnapshot,
  children,
}: {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => T;
  children: (vp: T) => React.ReactNode;
}) {
  const vp = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return <>{children(vp)}</>;
}

const noopViewportSubscribe = () => () => {};

function ConditionalViewportConsumer({
  active,
  subscribe,
  getSnapshot,
  children,
}: {
  active: boolean;
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => ViewportState;
  children: (vp: ViewportState) => React.ReactNode;
}) {
  const vp = useSyncExternalStore(active ? subscribe : noopViewportSubscribe, getSnapshot, getSnapshot);
  return <>{children(vp)}</>;
}

// Opened rarely and heavy (WebGL filter editors, brush packs, timeline, modals): loaded on first use
const BrushSettingsModal = lazy(() => import('./BrushSettingsModal').then((m) => ({ default: m.BrushSettingsModal })));
const ResizeCanvasModal = lazy(() => import('./ResizeCanvasModal').then((m) => ({ default: m.ResizeCanvasModal })));
const CanvasResizeOverlay = lazy(() => import('./CanvasResizeOverlay').then((m) => ({ default: m.CanvasResizeOverlay })));
const RulerControlsModal = lazy(() => import('./RulerControlsModal').then((m) => ({ default: m.RulerControlsModal })));
const ReferenceViewportHUD = lazy(() => import('./ReferenceViewportHUD').then((m) => ({ default: m.ReferenceViewportHUD })));
const TransformOverlay = lazy(() => import('./TransformOverlay').then((m) => ({ default: m.TransformOverlay })));
const KeyframeTransformOverlay = lazy(() => import('./KeyframeTransformOverlay').then((m) => ({ default: m.KeyframeTransformOverlay })));
const KeyframeMotionPathOverlay = lazy(() => import('./KeyframeMotionPathOverlay').then((m) => ({ default: m.KeyframeMotionPathOverlay })));
const MeshWarpOverlay = lazy(() => import('./MeshWarpOverlay').then((m) => ({ default: m.MeshWarpOverlay })));
const TextCanvasEditor = lazy(() => import('./TextCanvasEditor').then((m) => ({ default: m.TextCanvasEditor })));
const ComicStudioOverlay = lazy(() => import('./ComicStudioOverlay').then((m) => ({ default: m.ComicStudioOverlay })));
const AnimationTimelineBar = lazy(() => import('./AnimationTimelineBar').then((m) => ({ default: m.AnimationTimelineBar })));
const CameraFrameOverlay = lazy(() => import('./CameraFrameOverlay').then((m) => ({ default: m.CameraFrameOverlay })));
const CameraToolWindow = lazy(() => import('./CameraToolWindow').then((m) => ({ default: m.CameraToolWindow })));
const LightTableWindow = lazy(() => import('./LightTableWindow').then((m) => ({ default: m.LightTableWindow })));
const LightTableOverlay = lazy(() => import('./LightTableOverlay').then((m) => ({ default: m.LightTableOverlay })));
const AudioTrackWindow = lazy(() => import('./AudioTrackWindow').then((m) => ({ default: m.AudioTrackWindow })));
const LayerFilterDialog = lazy(() => import('./LayerFilterDialog').then((m) => ({ default: m.LayerFilterDialog })));
const LayerAlignWindow = lazy(() => import('./LayerAlignWindow'));
const ColorCurvesModal = lazy(() => import('./ColorCurvesModal').then((m) => ({ default: m.ColorCurvesModal })));
const GradientMapModal = lazy(() => import('./GradientMapModal').then((m) => ({ default: m.GradientMapModal })));

/** A copied layer (複製圖層) with everything needed to paste it, here or on another canvas */
interface CopiedLayer {
  model: LayerModel;
  tiles: TileData[];
  mask?: { model: LayerModel; tiles: TileData[] };
  strokes?: VectorStroke[];
  children: CopiedLayer[];
}
type LayerClipboard = { items: CopiedLayer[]; width: number; height: number };
type DeletedLayers = { deleted: string[]; lifted: string[] };
// This tab's memory; with 「重新整理後保留」 also localStorage (tile bytes as base64)
let layerClipboard: LayerClipboard | null = null;
/** While an animation plays, the cels of this many upcoming frames are decoded ahead (in workers) */
const ANIM_PREFETCH_FRAMES = 6;
/** A filter preview still working after this long shows the filter window's light sweep */
const FILTER_REFINING_DELAY_MS = 200;
/** After a draft preview shows, the full one starts if the settings stay put this long */
const FILTER_DRAFT_SETTLE_MS = 100;
/** Touch screens (phones, tablets) are slower: their draft previews start on smaller layers */
const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/**
 * Tools that draw, erase, fill, warp or pick on the active layer where the pointer is. With one of
 * them on a layer moved by keyframes, that layer is shown where it is drawn (keyframes paused).
 */
const ORIGINAL_POSITION_TOOLS: ReadonlySet<ToolType> = new Set<ToolType>([
  'brush', 'pencil', 'eraser', 'bucket', 'smart_fill', 'paint_unfilled', 'gradient', 'blur', 'smudge', 'liquify', 'mesh_warp', 'transform',
  'shape', 'shape_rect', 'shape_ellipse', 'shape_line', 'shape_arrow', 'magic_wand', 'lasso', 'select_rect', 'select_ellipse', 'select_polygon', 'select_brush', 'select_eraser',
  'text', 'vector_pen', 'vector_eraser', 'vector_reshape', 'vector_width', 'vector_bezier', 'vector_edit',
]);
const KEEP_CLIPBOARD_KEY = 'atelier_keep_layer_clipboard';
const CLIPBOARD_KEY = 'atelier_layer_clipboard';
const keepsLayerClipboard = () => {
  try {
    return localStorage.getItem(KEEP_CLIPBOARD_KEY) === '1';
  } catch {
    return false;
  }
};
/** Saves the clipboard; false when it does not fit (localStorage holds about 5 MB) */
const saveLayerClipboard = (clip: LayerClipboard | null): boolean => {
  try {
    if (!clip) {
      localStorage.removeItem(CLIPBOARD_KEY);
      return true;
    }
    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(clip, (_k, v) => (v instanceof Uint8Array ? { b64: bytesToBase64(v) } : v)));
    return true;
  } catch {
    try { localStorage.removeItem(CLIPBOARD_KEY); } catch { /* storage unavailable */ }
    return false;
  }
};
const loadLayerClipboard = (): LayerClipboard | null => {
  try {
    const text = keepsLayerClipboard() ? localStorage.getItem(CLIPBOARD_KEY) : null;
    return text ? JSON.parse(text, (_k, v) => (v && typeof v.b64 === 'string' ? Uint8Array.from(atob(v.b64), (c) => c.charCodeAt(0)) : v)) : null;
  } catch {
    return null;
  }
};
const bytesToBase64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export interface CanvasProjectAccess {
  canvasId: string;
  ready: boolean;
  readLayers: () => Promise<LayerCanvasItem[]>;
  flushEdits: () => Promise<void>;
}

export interface CanvasPluginAccess {
  canvasId: string;
  apply(action: Exclude<PluginAction, { kind: 'message' }>): Promise<boolean>;
  runV2Command(
    plugin: PluginManifestModern,
    commandId: string,
    options?: { onSlowStart?: () => void; signal?: AbortSignal },
  ): Promise<PluginV2Result>;
  runV2PanelAction(
    plugin: PluginManifestModern,
    panelId: string,
    actionId: string,
    values: Record<string, unknown>,
    options?: { onSlowStart?: () => void; signal?: AbortSignal },
  ): Promise<PluginV2Result>;
  selectPluginTool(pluginId: string, toolId: string): void;
  clearPluginTool(): void;
}

interface CanvasWorkspaceProps {
  canvas: CanvasModel | null;
  activeLayer: LayerModel | null;
  layers: LayerModel[];
  layersLoaded: boolean;
  onCanvasResized?: (width: number, height: number, dpi?: number, unit?: CanvasUnit) => void;
  /** Small composite preview of the canvas, for the canvas switcher */
  onCanvasThumbnail?: (canvasId: string, dataUrl: string) => void;
  /** Bumped by the parent to request "open the canvas resize dialog" (menu item) */
  resizeRequest?: number;
  /** 檔案 → 匯入圖片: files picked there, each becomes a new layer (a new id = a new request) */
  importImagesRequest?: { files: File[]; id: number } | null;
  onRequestCreateMyLayer?: () => void;
  onSelectLayer?: (layerId: string) => void;
  onCreateLayer?: (
    name: string,
    blendMode?: BlendMode,
    layerType?: LayerType,
    aboveLayerId?: string | null,
    parentId?: string | null,
    extra?: { meta?: LayerMeta | null; select?: boolean; belowLayerId?: string }
  ) => Promise<LayerModel | null> | void;
  onToggleLock?: (layer: LayerModel) => void;
  onToggleVisibility?: (layer: LayerModel) => void;
  /** A group goes with its content: returns what was deleted and what (others' layers) moved up out of it */
  onDeleteLayer?: (layerId: string, opts?: { keepContents?: boolean }) => void | boolean | DeletedLayers | Promise<void | boolean | DeletedLayers>;
  onReleaseLayer?: (layerId: string) => void;
  onClaimLayer?: (layerId: string, force?: boolean) => void;
  onTransferLayer?: (layerId: string, targetUserId: string) => void;
  roomMembers?: Array<{ userId: string; displayName: string; canvasRole?: string; role?: string }>;
  folderAccess: FolderAccess;
  onReorderLayer?: (layerId: string, newSortOrder: number, ascendingIds?: string[]) => void | Promise<void>;
  onUpdateLayerProps?: (layerId: string, props: Partial<LayerModel>) => void | Promise<void>;
  onRegisterGetLayerCanvases?: (access: CanvasProjectAccess | null) => void;
  onRegisterPluginAccess?: (access: CanvasPluginAccess | null) => void;
  onActivePluginToolChange?: (toolKey: string | null) => void;
  onRegisterBakeScreentone?: (fn: (layerId: string, params: { density: number; angleRad: number; dotScale: number }) => void) => void;
  onRegisterRecordLayerCreation?: (fn: ((created: LayerModel) => void) | null) => void;
  onQuickEnterCanvas?: () => void;
  onQuickCreateCanvas?: () => void;
  onOpenChat?: () => void;
  onOpenAuth?: () => void;
  onThumbnailsChange?: (thumbnails: Record<string, string>) => void;
}

export const CanvasWorkspace: React.FC<CanvasWorkspaceProps> = ({
  canvas,
  activeLayer,
  layers,
  layersLoaded,
  onCanvasResized,
  onCanvasThumbnail,
  resizeRequest = 0,
  importImagesRequest = null,
  onRegisterPluginAccess,
  onActivePluginToolChange,
  onRequestCreateMyLayer,
  onSelectLayer,
  onCreateLayer,
  onToggleLock,
  onToggleVisibility,
  onDeleteLayer,
  onReleaseLayer,
  onClaimLayer,
  onTransferLayer,
  roomMembers = [],
  folderAccess,
  onReorderLayer,
  onUpdateLayerProps,
  onRegisterGetLayerCanvases,
  onRegisterBakeScreentone,
  onRegisterRecordLayerCreation,
  onQuickEnterCanvas,
  onQuickCreateCanvas,
  onOpenChat,
  onOpenAuth,
  onThumbnailsChange,
}) => {
  const { isGuest, user } = useAuth();

  const {
    members,
    emitCursor,
    emitPreviewDab,
    commitOp: emitOp,
    commitTilePatch: emitTilePatch,
    takeBroadcastOps,
    subscribeOps,
    subscribePreviewDabs,
    getLatestSeq,
    subscribeOwnOpSeq,
    canvasResizedEvent,
    stickers,
    addSticker,
    updateSticker,
    removeSticker,
    toggleVoiceMute,
  } = useSocket();

  const resolveCurrentCanvasRole = (): 'owner' | 'admin' | 'editor' | 'viewer' | undefined => {
    const uid = user?.id;
    if (!uid) return undefined;
    const raw =
      members.find((m) => m.userId === uid) ??
      (roomMembers && roomMembers.length > 0 ? roomMembers.find((m) => m.userId === uid) : undefined);
    const roleRaw = raw
      ? ('canvasRole' in raw && raw.canvasRole ? raw.canvasRole : 'role' in raw ? raw.role : undefined)
      : undefined;
    if (roleRaw === 'owner' || roleRaw === 'admin' || roleRaw === 'editor' || roleRaw === 'viewer') {
      return roleRaw;
    }
    if (canvas && canvas.ownerId === uid) return 'owner';
    return undefined;
  };
  const currentCanvasRole = resolveCurrentCanvasRole();
  const isCanvasViewer = !isGuest && user?.serverRole !== 'admin' && currentCanvasRole === 'viewer';
  const isAdmin =
    user?.serverRole === 'admin' ||
    currentCanvasRole === 'owner' ||
    currentCanvasRole === 'admin' ||
    Boolean(canvas && user?.id && canvas.ownerId === user.id);
  // A phone keeps this layout when turned sideways; 桌面模式 switches it to the desktop layout.
  const isPhone = usePhoneLayout();
  const isTouchTablet = useTouchTabletLayout();
  const isTouchCanvasMode = isPhone || isTouchTablet;
  const { t, language } = useI18n();
  const dockLayout = useDockLayout();
  const floatsAllowed = useFloatsAllowed();
  const [toolDockHosts] = useState(() => {
    const align = document.createElement('div');
    const filters = document.createElement('div');
    align.className = 'contents';
    filters.className = 'contents';
    return { align, filters };
  });
  const railRight = !isTouchCanvasMode && dockLayout.railSide === 'right';
  const [mobileSheet, setMobileSheet] = useState<MobilePanelDef['id'] | null>(null);
  const openMobileSheet = (id: MobilePanelDef['id']) => {
    if (dockLayout.panels.members.visible) dockActions.hide('members');
    if (dockLayout.panels.oplog.visible) dockActions.hide('oplog');
    setMobileSheet(id);
  };
  const openBrushToolset = () => {
    if (isTouchCanvasMode) openMobileSheet('brushToolset');
    else dockActions.activate('brushToolset');
  };
  const membersPanelVisible = dockLayout.panels.members.visible;
  const oplogPanelVisible = dockLayout.panels.oplog.visible;
  useEffect(() => {
    if (!isTouchCanvasMode) return;
    if (membersPanelVisible) setMobileSheet('members');
    else setMobileSheet((curr) => (curr === 'members' ? null : curr));
  }, [isTouchCanvasMode, membersPanelVisible]);
  useEffect(() => {
    if (!isTouchCanvasMode) return;
    if (oplogPanelVisible) setMobileSheet('oplog');
    else setMobileSheet((curr) => (curr === 'oplog' ? null : curr));
  }, [isTouchCanvasMode, oplogPanelVisible]);

  const workspaceRef = useRef<HTMLDivElement>(null);
  const hasCanvas = Boolean(canvas);
  useLayoutEffect(() => {
    if (hasCanvas && workspaceRef.current) return playWorkspaceEntrance(workspaceRef.current);
  }, [hasCanvas]);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasMountRef = useRef<HTMLDivElement>(null);
  const pixiAppRef = useRef<Application | null>(null);
  const viewportRef = useRef<CanvasViewport | null>(null);
  const layerManagerRef = useRef<LayerManager | null>(null);
  const brushRendererRef = useRef<BrushRenderer | null>(null);
  const strokePipelineRef = useRef<StrokePipeline | null>(null);
  const tileEngineRef = useRef<TileEngine | null>(null);
  const undoByCanvasRef = useRef(new Map<string, ScopedUndoManager>());
  const selectionEngineRef = useRef<SelectionEngine | null>(null);
  const webglFilterEngineRef = useRef<WebGLFilterEngine | null>(null);
  const vectorEngineRef = useRef<VectorEngine | null>(null);
  const lastReplayedCanvasIdRef = useRef<string | null>(null);
  const [isEngineReady, setIsEngineReady] = useState<boolean>(false);
  const [isCanvasPresented, setIsCanvasPresented] = useState(false);
  const requestRenderRef = useRef<() => void>(() => pixiAppRef.current?.render());
  const setPlaybackResolutionRef = useRef<(reduced: boolean) => void>(() => {});
  const presentCanvas = useCallback(() => {
    pixiAppRef.current?.render();
    setIsCanvasPresented(true);
  }, []);
  const [engineError, setEngineError] = useState(false);
  const [engineAttempt, setEngineAttempt] = useState(0);

  // References to keep callbacks fresh and avoid stale closures
  const activeLayerRef = useRef(activeLayer);
  activeLayerRef.current = activeLayer;
  const userRef = useRef(user);
  userRef.current = user;
  const brushPropsRef = useRef<BrushProperties | null>(null);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const [selectedLayerIds, setSelectedLayerIds] = useState<Set<string>>(new Set());
  const selectedLayerIdsRef = useRef(selectedLayerIds);
  selectedLayerIdsRef.current = selectedLayerIds;
  useEffect(() => {
    setSelectedLayerIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, [canvas?.id]);
  useEffect(() => {
    setSelectedLayerIds((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(layers.map((l) => l.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [layers]);

  // Personal eye: this viewer's own show/hide overrides, kept on this device per canvas, never synced
  const localVisKey = canvas ? `atelier_local_vis_${canvas.id}` : '';
  const [localVisibility, setLocalVisibility] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      setLocalVisibility(localVisKey ? JSON.parse(localStorage.getItem(localVisKey) || '{}') : {});
    } catch {
      setLocalVisibility({});
    }
  }, [localVisKey]);
  const toggleLocalVisibility = (layerId: string) => {
    setLocalVisibility((prev) => {
      const next = { ...prev };
      if (layerId in next) delete next[layerId];
      else next[layerId] = !(layersRef.current.find((l) => l.id === layerId)?.isVisible ?? true);
      try {
        if (localVisKey) localStorage.setItem(localVisKey, JSON.stringify(next));
      } catch {
        // storage blocked: the override still applies for this session
      }
      return next;
    });
  };
  const localVisibilityRef = useRef(localVisibility);
  localVisibilityRef.current = localVisibility;
  // The animation folder the timeline plays and its player (set in the animation section below)
  const animFolderIdRef = useRef<string | null>(null);
  const animEngineRef = useRef<AnimationEngine | null>(null);
  // Onion skin is drawn only while this viewer has the timeline open: painters who merely see an
  // animation folder (or never opened the timeline) get no tinted neighbours on their screen
  const animTimelineOpenRef = useRef(false);
  // Light table (透光桌): reference cels this viewer picked, per canvas (like onion skin, never in the file)
  const [lightTable, setLightTable] = useState<LightTableState>(() => loadLightTable(canvas?.id));
  const lightTableRef = useRef(lightTable);
  lightTableRef.current = lightTable;
  useEffect(() => setLightTable(loadLightTable(canvas?.id)), [canvas?.id]);
  const updateLightTable = (fn: (s: LightTableState) => LightTableState) => {
    const next = fn(lightTableRef.current);
    lightTableRef.current = next;
    saveLightTable(canvas?.id, next);
    setLightTable(next);
  };
  /** The light table under the cel on screen in the edited track (Phase E2 per-reference transforms & tint) */
  const lightViewFor = (ls: LayerModel[], time: number) => {
    const state = lightTableRef.current;
    const folderId = animFolderIdRef.current;
    if (!state.enabled || !folderId) return null;
    const entries = celEntriesOf(ls, folderId);
    const ids = lightIdsFor(state, folderId, celLayerOf(entries[entryIndexAt(entries, time)]));
    if (!ids.size) return null;
    const cw = canvas?.width ?? 0;
    const ch = canvas?.height ?? 0;
    const items = new Map<string, LightTableDisplayItem>();
    for (const id of ids) {
      const tr = getLightTableTransform(state, id);
      const affine = lightTableTransformToAffine(tr, cw, ch);
      const tintNum =
        tr.tintMode !== 'original' && tr.tint
          ? parseInt(tr.tint.replace('#', ''), 16) || undefined
          : undefined;
      items.set(id, {
        opacity: tr.opacity,
        ...(affine.isIdentity ? {} : { transform: affine }),
        ...(tintNum !== undefined ? { tint: tintNum } : {}),
        ...(tr.tintMode === 'shade' ? { tintMode: 'shade' as const } : {}),
      });
    }
    return { opacity: state.opacity, ids, items };
  };
  // Phase E1/E2/E3 state: 2D Camera, Light Table v2 ToolWindow, and Local Audio Tracks
  const [cameraWindowOpen, setCameraWindowOpen] = useState(false);
  const [cameraPreviewActive, setCameraPreviewActive] = useState(false);
  const cameraPreviewActiveRef = useRef(false);
  cameraPreviewActiveRef.current = cameraPreviewActive;
  const [cameraPreviewRect, setCameraPreviewRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const savedViewportBeforeCamRef = useRef<ViewportState | null>(null);
  const [lightWindowOpen, setLightWindowOpen] = useState(false);
  const [selectedLightRefId, setSelectedLightRefId] = useState<string | null>(null);
  const [lightCanvasDragMode, setLightCanvasDragMode] = useState(false);
  const [audioWindowOpen, setAudioWindowOpen] = useState(false);
  const [audioScrubEnabled, setAudioScrubEnabled] = useState(true);
  const audioScrubEnabledRef = useRef(true);
  audioScrubEnabledRef.current = audioScrubEnabled;
  const [audioAssetSummaries, setAudioAssetSummaries] = useState<Record<string, AudioAssetSummary>>({});
  const audioPlayerRef = useRef<AudioTrackPlayer | null>(null);
  if (!audioPlayerRef.current) audioPlayerRef.current = new AudioTrackPlayer();
  useEffect(() => () => { audioPlayerRef.current?.destroy(); }, []);

  const cameraLayer = useMemo(() => findCameraLayer(layers), [layers]);
  const cameraLayerRef = useRef<LayerModel | null>(cameraLayer);
  cameraLayerRef.current = cameraLayer;
  const audioLayers = useMemo(() => layers.filter(isAudioLayer), [layers]);
  const audioLayersRef = useRef<LayerModel[]>(audioLayers);
  audioLayersRef.current = audioLayers;

  const canvasMetaRef = useRef(canvas);
  canvasMetaRef.current = canvas;
  const syncCameraPreviewViewport = useCallback((frame: number) => {
    const cam = cameraLayerRef.current;
    const vp = viewportRef.current;
    const c = canvasMetaRef.current;
    if (!cameraPreviewActiveRef.current || !cam || !cam.isVisible || !cam.meta?.camera || !vp || !c) return;
    const screen = pixiAppRef.current?.screen;
    const viewW = screen?.width || window.innerWidth;
    const viewH = screen?.height || window.innerHeight;
    const ev = evaluateCameraFrame(cam.meta.camera, cam.meta.keyframes, frame, c.width, c.height);
    const pv = computeCameraPreviewViewport(ev, c.width, c.height, viewW, viewH);
    const current = vp.getState();
    if (current.zoom !== pv.zoom || current.panX !== pv.panX || current.panY !== pv.panY ||
        current.rotation !== pv.rotation || current.mirrorX) {
      vp.setState({ zoom: pv.zoom, panX: pv.panX, panY: pv.panY, rotation: pv.rotation, mirrorX: false });
    }
    setCameraPreviewRect((rect) => {
      const next = pv.frameRect;
      return rect && rect.x === next.x && rect.y === next.y && rect.width === next.width && rect.height === next.height ? rect : next;
    });
  }, []);
  const syncCameraPreviewViewportRef = useRef(syncCameraPreviewViewport);
  syncCameraPreviewViewportRef.current = syncCameraPreviewViewport;

  const setCameraPreviewMode = useCallback((next: boolean) => {
    const vp = viewportRef.current;
    if (next) {
      const cam = cameraLayerRef.current;
      if (!cam || !cam.isVisible || !cam.meta?.camera || !vp) return;
      if (!cameraPreviewActiveRef.current) {
        savedViewportBeforeCamRef.current = vp.getState();
      }
      cameraPreviewActiveRef.current = true;
      setCameraPreviewActive(true);
      syncCameraPreviewViewportRef.current(animEngineRef.current?.getTime() ?? 0);
    } else {
      cameraPreviewActiveRef.current = false;
      setCameraPreviewActive(false);
      setCameraPreviewRect(null);
      if (savedViewportBeforeCamRef.current && vp) {
        vp.setState(savedViewportBeforeCamRef.current);
        savedViewportBeforeCamRef.current = null;
      }
    }
  }, []);

  // Refresh local IndexedDB waveform summaries whenever audio layers or local audio storage change
  const audioAssetIdKey = audioLayers.map((l) => l.meta?.audio?.localAssetId ?? '').join('|');
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      const ids = audioLayersRef.current.map((l) => l.meta?.audio?.localAssetId ?? '').filter(Boolean);
      if (ids.length === 0) {
        if (!cancelled) setAudioAssetSummaries({});
        return;
      }
      void loadAudioAssetSummaries(ids).then((map) => {
        if (!cancelled) setAudioAssetSummaries(map);
      });
    };
    refresh();
    const unsub = subscribeAudioAssets(refresh);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [audioAssetIdKey]);

  // Keep camera preview aligned when camera layer/keyframes change or exit preview if camera is removed/hidden
  useEffect(() => {
    if (!cameraPreviewActive) return;
    if (!cameraLayer || !cameraLayer.isVisible || !cameraLayer.meta?.camera) {
      setCameraPreviewMode(false);
      return;
    }
    syncCameraPreviewViewport(animEngineRef.current?.getTime() ?? 0);
  }, [cameraPreviewActive, cameraLayer, syncCameraPreviewViewport, setCameraPreviewMode]);

  // Keep camera preview aligned on window resize
  useEffect(() => {
    if (!cameraPreviewActive) return;
    const onResize = () => syncCameraPreviewViewportRef.current(animEngineRef.current?.getTime() ?? 0);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [cameraPreviewActive]);
  /**
   * What this viewer's screen shows: the personal eyes, and in every animation folder the cel at
   * the current frame (the edited folder plus onion skin). `time` renders one frame for export;
   * `only` keeps just those animation folders (solo / team export).
   */
  // The keyframed layer being drawn on (set below once the tool and the timeline are known)
  const originalEditRef = useRef<string | null>(null);
  const liveKeyframePreviewRef = useRef<{ layerId: string; frame: number; evaluated: EvaluatedTransform } | null>(null);
  const displayLayersFor = (ls: LayerModel[], opts: { personal?: boolean; time?: number; only?: Set<string> | null } = {}) => {
    const vis = localVisibilityRef.current;
    let local = opts.personal === false ? ls : ls.map((l) => (l.id in vis ? { ...l, isVisible: vis[l.id] } : l));
    const engine = animEngineRef.current;
    const exporting = opts.time !== undefined;
    const preview = !exporting ? liveKeyframePreviewRef.current : null;
    if (preview) {
      local = local.map((l) => {
        if (l.id !== preview.layerId) return l;
        const kfs = l.meta?.keyframes ?? [];
        const merged = buildKeyframeFromEval(kfs, preview.frame, preview.evaluated);
        return { ...l, meta: { ...(l.meta ?? {}), keyframes: upsertTransformKeyframe(kfs, merged) } };
      });
    }
    const aids = !exporting && engine && !engine.getIsPlaying() && animTimelineOpenRef.current; // onion skin, light table
    return animationDisplay(
      local,
      {
        time: exporting ? opts.time! : engine?.getTime() ?? 0,
        activeFolderId: animFolderIdRef.current,
        onion: aids ? engine.getOnionSkinConfig() : null,
        only: opts.only ?? null,
        light: aids ? lightViewFor(local, engine.getTime()) : null,
        // Drawing on a keyframed layer: shown where it is drawn (never in playback or in files)
        original: !exporting && !engine?.getIsPlaying() ? originalEditRef.current : null,
      },
      canvas?.width ?? 0,
      canvas?.height ?? 0
    );
  };
  const displayLayersRef = useRef(layers);
  displayLayersRef.current = displayLayersFor(layers);

  // External thumbnail store: updating a layer thumbnail only re-renders its <img> cell, never CanvasWorkspace
  const thumbnailsRef = useRef<Record<string, string>>({});
  const thumbListenersRef = useRef(new Set<() => void>());
  const onThumbnailsChangeRef = useRef(onThumbnailsChange);
  onThumbnailsChangeRef.current = onThumbnailsChange;
  const notifyThumbnails = useCallback(() => {
    for (const cb of thumbListenersRef.current) cb();
    onThumbnailsChangeRef.current?.(thumbnailsRef.current);
  }, []);
  const publishThumbnail = useCallback((layerId: string, url: string) => {
    if (thumbnailsRef.current[layerId] === url) return;
    thumbnailsRef.current = { ...thumbnailsRef.current, [layerId]: url };
    notifyThumbnails();
  }, [notifyThumbnails]);
  const resetThumbnails = useCallback(() => {
    if (!Object.keys(thumbnailsRef.current).length) return;
    thumbnailsRef.current = {};
    notifyThumbnails();
  }, [notifyThumbnails]);
  const subscribeThumbnails = useCallback((cb: () => void) => {
    thumbListenersRef.current.add(cb);
    return () => { thumbListenersRef.current.delete(cb); };
  }, []);
  const getThumbnailsSnapshot = useCallback(() => thumbnailsRef.current, []);

  const canvasThumbTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCanvasThumbnailRef = useRef(onCanvasThumbnail);
  onCanvasThumbnailRef.current = onCanvasThumbnail;
  // Whole-canvas preview for the canvas switcher, debounced and deferred while actively drawing
  const scheduleCanvasThumbnail = () => {
    const lm = layerManagerRef.current;
    const canvasId = canvas?.id;
    if (!lm || !canvasId) return;
    if (canvasThumbTimerRef.current) clearTimeout(canvasThumbTimerRef.current);
    canvasThumbTimerRef.current = setTimeout(() => {
      if (layerManagerRef.current !== lm) return; // canvas switched or engine rebuilt
      if (lm.isActivelyDrawing() || strokePipelineRef.current?.getIsDrawing()) {
        scheduleCanvasThumbnail();
        return;
      }
      void lm.getCanvasThumbnailAsync().then((url) => {
        if (url && layerManagerRef.current === lm) onCanvasThumbnailRef.current?.(canvasId, url);
      });
    }, 1200);
  };

  const remoteThumbAtRef = useRef(new Map<string, number>());
  const refreshLayerThumbnail = (layerId: string, fromRemote = false) => {
    if (!layerManagerRef.current) return;
    if (fromRemote) {
      const now = performance.now();
      if (now - (remoteThumbAtRef.current.get(layerId) ?? 0) < 4000) return;
      remoteThumbAtRef.current.set(layerId, now);
    }
    const thumb = layerManagerRef.current.getLayerThumbnail(layerId, 48, 48, fromRemote);
    if (thumb) publishThumbnail(layerId, thumb);
    if (!fromRemote) scheduleCanvasThumbnail();
  };

  type LocalTileCommit = {
    clientOpId: string;
    layerId: string;
    seq: number | null;
    baseSeq: number;
    beforeTiles: Map<string, TileData>;
    afterTiles: Map<string, TileData>;
    createdAt: number;
    historyOp?: ScopedUndoOp;
  };
  const recentLocalCommitsRef = useRef<LocalTileCommit[]>([]);
  const localClientOpsRef = useRef<Set<string>>(new Set());
  const appliedClientOpsRef = useRef<Set<string>>(new Set());
  const appliedVectorOpsRef = useRef<Set<string>>(new Set());
  const appliedFootprintOpsRef = useRef<Set<string>>(new Set());
  const speculativeConcurrencyOpsRef = useRef<Set<string>>(new Set());
  const rememberOpId = (set: Set<string>, id: string) => {
    set.add(id);
    if (set.size > 500) {
      const first = set.values().next().value;
      if (first !== undefined) set.delete(first);
    }
  };
  useEffect(() => {
    recentLocalCommitsRef.current = [];
    localClientOpsRef.current.clear();
    appliedClientOpsRef.current.clear();
    appliedVectorOpsRef.current.clear();
    appliedFootprintOpsRef.current.clear();
    speculativeConcurrencyOpsRef.current.clear();
  }, [canvas?.id]);
  useEffect(() => {
    return subscribeOwnOpSeq((clientOpId, seq) => {
      const rec = recentLocalCommitsRef.current.find((r) => r.clientOpId === clientOpId);
      if (rec) {
        rec.seq = seq;
        if (rec.historyOp) {
          rec.historyOp.seq = seq;
          rec.historyOp = undefined;
        }
      }
    });
  }, [subscribeOwnOpSeq]);

  const trackLocalCommit = (
    layerId: string,
    clientOpId: string,
    baseSeq: number,
    beforeTiles: TileData[],
    afterTiles: TileData[],
    historyOp?: ScopedUndoOp
  ) => {
    if (OfflineSessionStore.isOfflineCanvas(canvas?.id)) return;
    const beforeMap = new Map<string, TileData>();
    for (const t of beforeTiles) if (t) beforeMap.set(`${t.col}_${t.row}`, t);
    const afterMap = new Map<string, TileData>();
    for (const t of afterTiles) if (t) afterMap.set(`${t.col}_${t.row}`, t);
    recentLocalCommitsRef.current.push({
      clientOpId,
      layerId,
      seq: null,
      baseSeq,
      beforeTiles: beforeMap,
      afterTiles: afterMap,
      createdAt: Date.now(),
      historyOp,
    });
    if (recentLocalCommitsRef.current.length > 60) recentLocalCommitsRef.current.shift();
  };

  // Every committed edit is the layer's new baseline. Tools that skipped this left the ping-pong
  // buffer (the "before" state of the next stroke) stale, so the next undo or two-finger gesture
  // wiped what they had just done; the layer thumbnail went stale the same way.
  const commitOp = (layerId: string, opType: string, payload: unknown, alreadySynced = false) => {
    // A brush commit finished off the main thread synced when it read its tiles; syncing now would
    // copy the stroke that may have started since into the next stroke's before-state
    if (!alreadySynced) layerManagerRef.current?.syncPingPong(layerId);
    refreshLayerThumbnail(layerId);
    const pObj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
    const clientOpId = typeof pObj?.clientOpId === 'string'
      ? pObj.clientOpId
      : `cop_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    if (!OfflineSessionStore.isOfflineCanvas(canvas?.id)) rememberOpId(localClientOpsRef.current, clientOpId);
    const baseSeq = typeof pObj?.baseSeq === 'number' ? pObj.baseSeq : getLatestSeq();
    const tiles = Array.isArray(pObj?.tiles) ? (pObj!.tiles as TileData[]) : null;
    if (tiles?.length) {
      const latestUndo = scopedUndoRef.current.peekLatestForLayer(layerId);
      if (latestUndo?.beforeTiles?.length) {
        const historyOp = (opType === 'STROKE' || opType === 'ERASE') && latestUndo.opType === opType
          ? latestUndo
          : undefined;
        if (historyOp) historyOp.baseSeq = baseSeq;
        trackLocalCommit(layerId, clientOpId, baseSeq, latestUndo.beforeTiles, tiles, historyOp);
      }
    }
    const targetLayer = layersRef.current.find((l) => l.id === layerId);
    const layerMeta = targetLayer?.layerType === 'mask' ? { layerType: 'mask' as const } : {};
    emitOp(layerId, opType, pObj ? { ...pObj, ...layerMeta, baseSeq, clientOpId } : payload);
  };
  const commitTilePatch = (
    layerId: string,
    tiles: TileData[],
    isUndo: boolean = false,
    actionDesc?: string,
    alreadySynced = false,
    explicitBeforeTiles?: TileData[],
    history?: Pick<TilePatchPacket, 'targetOpSeq' | 'historyTiles'>
  ) => {
    // (an edit committed off the main thread synced when it queued its reads, like the brush)
    if (!alreadySynced) layerManagerRef.current?.syncPingPong(layerId);
    refreshLayerThumbnail(layerId);
    const clientOpId = `cop_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    if (!OfflineSessionStore.isOfflineCanvas(canvas?.id)) rememberOpId(localClientOpsRef.current, clientOpId);
    const baseSeq = getLatestSeq();
    if (tiles?.length) {
      const latestUndo = !isUndo && actionDesc !== 'REDO' ? scopedUndoRef.current.peekLatestForLayer(layerId) : undefined;
      const before = explicitBeforeTiles ?? latestUndo?.beforeTiles;
      if (before?.length) {
        const historyOp = before === latestUndo?.beforeTiles && tiles === latestUndo.afterTiles ? latestUndo : undefined;
        if (historyOp) historyOp.baseSeq = baseSeq;
        trackLocalCommit(layerId, clientOpId, baseSeq, before, tiles, historyOp);
      }
    }
    const targetLayer = layersRef.current.find((l) => l.id === layerId);
    emitTilePatch(layerId, tiles, isUndo, actionDesc, {
      baseSeq,
      clientOpId,
      ...(targetLayer?.layerType === 'mask' ? { layerType: 'mask' as const } : {}),
      ...history,
    });
  };

  // Initial snapshot/op replay bookkeeping for the live op queue (see applyRemoteOp)
  const isReplayingRef = useRef<boolean>(false);
  const replayedSeqRef = useRef<number>(0);

  // Phase 10: Vector Engine & Color Curves / Gradient Map Modals
  const [isColorCurvesOpen, setIsColorCurvesOpen] = useState<boolean>(false);
  const [isGradientMapOpen, setIsGradientMapOpen] = useState<boolean>(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const filterMenuOpenRef = useRef(false);
  filterMenuOpenRef.current = filterMenuOpen;
  // The filter window keeps showing its last filter while it fades out, so the id outlives filterMenuOpen
  const [layerFilterId, setLayerFilterId] = useState<string | null>(null);
  const shownFilterId = filterMenuOpen ? layerFilterId : null;
  const filterModalOpenRef = useRef(false);
  filterModalOpenRef.current = Boolean(shownFilterId || isColorCurvesOpen || isGradientMapOpen);
  const filterIdRef = useRef(shownFilterId);
  filterIdRef.current = shownFilterId;
  /** One resident filter worker for this canvas (created on first use, idles out on its own) */
  const filterWorkerRef = useRef<FilterWorkerClient | null>(null);
  /** Dedicated QuickJS filter worker for Plugin API v2 filters (strictly isolated from layer-filter.worker.ts) */
  const pluginFilterWorkerRef = useRef<PluginFilterWorkerClient | null>(null);
  const filterRequestRef = useRef(0);
  const [filterBusy, setFilterBusy] = useState(false);
  /** A preview is still being worked out (a draft is shown, or it is slow): the filter window shows a light sweep */
  const [filterRefining, setFilterRefining] = useState(false);
  const filterRefineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The layer's tone counts for the levels window (counted by the filter worker on the first preview) */
  const [filterHistogram, setFilterHistogram] = useState<Uint32Array | null>(null);
  const filterHistogramRef = useRef<Uint32Array | null>(null);
  /** Apply filter onto a new composited raster layer directly above the active layer */
  const [filterApplyNewLayer, setFilterApplyNewLayer] = useState(false);
  const filterApplyNewLayerRef = useRef(false);
  filterApplyNewLayerRef.current = filterApplyNewLayer;
  const [filterIncludeBg, setFilterIncludeBg] = useState(false);
  const filterIncludeBgRef = useRef(false);
  filterIncludeBgRef.current = filterIncludeBg;
  const [filterMemoryConfirm, setFilterMemoryConfirm] = useState<{ openTo?: 'menu' | 'curves' | 'gradient' } | null>(null);
  const filterMemoryConfirmedRef = useRef<string | null>(null);
  const filterPreviewRef = useRef<
    | { kind: 'layer'; item: NonNullable<ReturnType<LayerManager['getLayerItem']>>; texture: RenderTexture }
    | { kind: 'overlay'; texture: RenderTexture }
    | null
  >(null);
  /**
   * The layer's (or visible composite's) pixels as read for the last preview, kept while its
   * version shows nothing has changed since: the next preview skips reading back from the GPU.
   */
  const filterSourceRef = useRef<
    | { kind: 'layer'; item: NonNullable<ReturnType<LayerManager['getLayerItem']>>; version: number; width: number; height: number; pixels: Uint8Array }
    | { kind: 'composite'; version: string; includeBg: boolean; width: number; height: number; pixels: Uint8Array }
    | null
  >(null);

  // Tools & Properties State
  const [currentTool, setCurrentTool] = useState<ToolType>('brush');
  const subToolState = useSubToolStore();
  const applyingSubToolRef = useRef(false);
  const restoredSubToolRef = useRef(false);
  const [appliedFillSubToolId, setAppliedFillSubToolId] = useState<SubToolId | null>(null);
  const [appliedSelectionSubToolId, setAppliedSelectionSubToolId] = useState<SubToolId | null>(null);
  const currentToolRef = useRef(currentTool);
  currentToolRef.current = currentTool;

  // Plugin API v2.5: enabled custom tools, active tool selection, per-tool options, and pointer stroke controller
  const installedPlugins = useSyncExternalStore(subscribePlugins, getPlugins, getPlugins);
  const pluginTools = useMemo(() => collectEnabledPluginTools(installedPlugins), [installedPlugins]);
  const [activePluginToolKey, setActivePluginToolKey] = useState<string | null>(null);
  const activePluginTool = useMemo<RegisteredPluginTool | null>(
    () => (activePluginToolKey ? pluginTools.find((item) => item.key === activePluginToolKey) ?? null : null),
    [pluginTools, activePluginToolKey],
  );
  const activePluginToolRef = useRef<RegisteredPluginTool | null>(null);
  activePluginToolRef.current = activePluginTool;
  const [pluginToolOptionsByKey, setPluginToolOptionsByKey] = useState<
    Record<string, Record<string, string | number | boolean>>
  >({});
  const pluginToolOptionsRef = useRef(pluginToolOptionsByKey);
  pluginToolOptionsRef.current = pluginToolOptionsByKey;
  const pluginToolControllerRef = useRef<PluginToolPointerController>(new PluginToolPointerController());

  const clearPluginTool = useCallback(() => {
    pluginToolControllerRef.current.cancelStroke();
    setActivePluginToolKey(null);
  }, []);

  const selectPluginTool = useCallback(
    (pluginId: string, toolId: string) => {
      const key = makePluginToolKey(pluginId, toolId);
      const found = pluginTools.find((item) => item.key === key);
      if (!found) return;
      pluginToolControllerRef.current.cancelStroke();
      if (transformLayerIdRef.current) cancelTransform();
      setActivePluginToolKey((prev) => (prev === key ? null : key));
      setPluginToolOptionsByKey((prev) =>
        prev[key] ? prev : { ...prev, [key]: buildInitialToolOptions(found.tool) },
      );
    },
    [pluginTools],
  );

  // If the active plugin tool is disabled/removed, cleanly return to built-in tool
  useEffect(() => {
    if (activePluginToolKey && !pluginTools.some((item) => item.key === activePluginToolKey)) {
      pluginToolControllerRef.current.cancelStroke();
      setActivePluginToolKey(null);
    }
  }, [activePluginToolKey, pluginTools]);

  // Notify App/TopNavbar when the active custom plugin tool changes
  useEffect(() => {
    onActivePluginToolChange?.(activePluginTool?.key ?? null);
  }, [activePluginTool?.key, onActivePluginToolChange]);

  // Cancel any in-flight custom plugin stroke when canvas switches or unmounts
  useEffect(() => {
    return () => {
      pluginToolControllerRef.current.cancelStroke();
    };
  }, [canvas?.id]);

  const [isResizeModalOpen, setIsResizeModalOpen] = useState<boolean>(false);
  const resizeModalOpenRef = useRef<boolean>(false);
  resizeModalOpenRef.current = isResizeModalOpen;
  const lastSameSizeReloadAtRef = useRef<number>(0);
  const [resizeAnchor, setResizeAnchor] = useState<AnchorKey | null>('c');
  const [resizeLockAspect, setResizeLockAspect] = useState<boolean>(false);
  const [resizeModifiers, setResizeModifiers] = useState<{ shift: boolean; alt: boolean }>({ shift: false, alt: false });
  const [resizeBox, setResizeBox] = useState<ResizeBox>({
    x: 0,
    y: 0,
    width: canvas?.width || 2048,
    height: canvas?.height || 2048,
  });

  useEffect(() => {
    if (!canvas || !isResizeModalOpen) return;
    setResizeBox({ x: 0, y: 0, width: canvas.width, height: canvas.height });
    setResizeAnchor('c');
    setResizeModifiers({ shift: false, alt: false });
  }, [isResizeModalOpen, canvas?.id, canvas?.width, canvas?.height]);

  useEffect(() => {
    if (
      canvas &&
      canvasResizedEvent &&
      canvasResizedEvent.canvasId === canvas.id &&
      canvasResizedEvent.shifted &&
      canvasResizedEvent.width === canvas.width &&
      canvasResizedEvent.height === canvas.height &&
      Date.now() - lastSameSizeReloadAtRef.current > 2000
    ) {
      setEngineAttempt((attempt) => attempt + 1);
    }
  }, [canvasResizedEvent, canvas?.id, canvas?.width, canvas?.height]);
  const [selectedBrushId, setSelectedBrushId] = useState<string | null>(null);
  const [isColorStudioOpen, setIsColorStudioOpen] = useState<boolean>(false);

  // Shape / gradient / vector-pen preview graphic (above the layers)
  const shapeGraphicRef = useRef<Graphics | null>(null);

  // Hand-drawn animation state
  const [isAnimationTimelineOpen, setIsAnimationTimelineOpen] = useState<boolean>(false);
  animTimelineOpenRef.current = isAnimationTimelineOpen;
  // 原位作畫: with a drawing tool on a layer moved by keyframes, that layer (and the groups around
  // it) shows where it is drawn, so a stroke lands under the pen; playback and the keyframe panel
  // show the motion again
  const [keyframePanelOpen, setKeyframePanelOpen] = useState(false);
  const [showKeyframeHandles, setShowKeyframeHandles] = useState(true);
  const [showMotionPath, setShowMotionPath] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('atelier_keyframe_motion_path');
      return saved === null ? true : saved === '1';
    } catch {
      return true;
    }
  });
  const toggleMotionPath = useCallback(() => {
    setShowMotionPath((prev) => {
      const next = !prev;
      try { localStorage.setItem('atelier_keyframe_motion_path', next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);
  const [animFrame, setAnimFrame] = useState(0);
  const [liveKeyframePreview, setLiveKeyframePreview] = useState<{ layerId: string; frame: number; evaluated: EvaluatedTransform } | null>(null);
  const [animPlaying, setAnimPlaying] = useState(false);
  const activeMovedByKeyframes = useMemo(() => movedByKeyframes(layers, activeLayer?.id), [layers, activeLayer?.id]);
  const originalEditId = activeLayer && activeMovedByKeyframes && ORIGINAL_POSITION_TOOLS.has(currentTool) && !(isAnimationTimelineOpen && keyframePanelOpen)
    ? activeLayer.id
    : null;
  originalEditRef.current = originalEditId;
  const animationByCanvasRef = useRef(new Map<string, AnimationEngine>());
  const [timelineState, setTimelineState] = useState<{ canvasId: string; engine: AnimationEngine } | null>(null);
  const animationEngine = timelineState?.canvasId === canvas?.id ? timelineState?.engine : undefined;
  animEngineRef.current = animationEngine ?? null;
  // Every animation folder is a track (top of the layer list first). The edited one holds the
  // active layer, else it is the last one edited, else the first.
  const lastAnimFolderRef = useRef<string | null>(null);
  const animFolders = layers.filter((layer) =>
    isAnimationFolder(layer) && (folderAccess.canAdd(layer) || layer.ownerId === user?.id || layer.meta?.animation?.shared === true)
  ).sort((a, b) => b.sortOrder - a.sortOrder);
  const activeAnimFolderId = activeLayer?.meta?.animation ? activeLayer.id : (activeLayer && celOfLayer(layers, activeLayer.id)?.folderId) ?? null;
  const animFolder = animFolders.find((f) => f.id === (activeAnimFolderId ?? lastAnimFolderRef.current)) ?? animFolders[0] ?? null;
  lastAnimFolderRef.current = animFolder?.id ?? null;
  animFolderIdRef.current = animFolder?.id ?? null;
  const animTracks: AnimationTrack[] = animFolders.map((f) => ({
    folderId: f.id,
    name: f.name,
    ownerId: f.ownerId,
    shared: Boolean(f.meta?.animation?.shared),
    entries: celEntriesOf(layers, f.id),
    labels: normalizeTimelineLabels(f.meta?.animation?.labels),
  }));
  const animEntries = animTracks.find((t) => t.folderId === animFolder?.id)?.entries ?? [];
  const animEntriesRef = useRef(animEntries);
  animEntriesRef.current = animEntries;
  // Timeline length: set on the edited folder (or another track), else up to the end of the longest track
  const animAutoLength = Math.max(1, ...animTracks.map((t) => trackLength(t.entries)));
  const animSetLength = Number(animFolder?.meta?.animation?.length ?? animFolders.find((f) => f.meta?.animation?.length)?.meta?.animation?.length) || 0;
  const animTimelineLength = animSetLength > 0 ? Math.max(1, Math.min(MAX_TIMELINE_FRAMES, Math.round(animSetLength))) : animAutoLength;
  const animTrackKey = animTracks.map((t) => `${t.folderId}:${t.shared}:${t.entries.map((e) => `${e.id}/${e.hold}/${e.ref ?? ''}`).join(',')}`).join('|');


  // Ruler & Guidelines Modal
  const [isRulerModalOpen, setIsRulerModalOpen] = useState<boolean>(false);

  // Reference Image HUD Viewport
  const [isReferenceHUDOpen, setIsReferenceHUDOpen] = useState<boolean>(false);

  // Gesture Radial Pie Menu
  const [isRadialMenuOpen, setIsRadialMenuOpen] = useState<boolean>(false);
  const radialMenuOpenRef = useRef(isRadialMenuOpen);
  radialMenuOpenRef.current = isRadialMenuOpen;
  const [radialMenuPos, setRadialMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const contextPointerRef = useRef({ type: '', rightButton: false });

  // Procraft-inspired Touch Clipboard Menu, Live Eyedropper Loupe & 4-Finger Fullscreen
  const [isClipboardMenuOpen, setIsClipboardMenuOpen] = useState<boolean>(false);
  const clipboardMenuOpenRef = useRef(isClipboardMenuOpen);
  clipboardMenuOpenRef.current = isClipboardMenuOpen;
  const [touchEyedropper, setTouchEyedropper] = useState<TouchEyedropperState | null>(null);
  const canvasFullscreen = useSyncExternalStore(subscribeCanvasFullscreen, getCanvasFullscreen, getCanvasFullscreen);
  const touchGestureSettings = useSyncExternalStore(subscribeTouchGestureSettings, getTouchGestureSettings, getTouchGestureSettings);

  // Undo / Redo availability
  const [canUndoState, setCanUndoState] = useState<boolean>(false);
  const [canRedoState, setCanRedoState] = useState<boolean>(false);

  const viewportStateRef = useRef<ViewportState>({
    zoom: 1.0,
    panX: 0,
    panY: 0,
    rotation: 0,
    mirrorX: false,
  });
  const viewportZoomStateRef = useRef<ViewportState>({
    zoom: 1.0,
    panX: 0,
    panY: 0,
    rotation: 0,
    mirrorX: false,
  });
  const lastZoomDisplayScaleRef = useRef<number>(1);
  const viewportSubsRef = useRef(new Set<() => void>());
  const viewportZoomSubsRef = useRef(new Set<() => void>());
  const subscribeViewport = useCallback((cb: () => void) => {
    viewportSubsRef.current.add(cb);
    return () => { viewportSubsRef.current.delete(cb); };
  }, []);
  const subscribeViewportZoom = useCallback((cb: () => void) => {
    viewportZoomSubsRef.current.add(cb);
    return () => { viewportZoomSubsRef.current.delete(cb); };
  }, []);
  const getViewportSnapshot = useCallback(() => viewportStateRef.current, []);
  const getViewportZoomSnapshot = useCallback(() => viewportZoomStateRef.current, []);
  const notifyViewportSubs = useCallback((next: ViewportState) => {
    viewportStateRef.current = next;
    viewportSubsRef.current.forEach((cb) => cb());
    const prevZ = viewportZoomStateRef.current;
    const curDisplayScale = viewportRef.current?.getDisplayScale() ?? getTargetDisplayResolution();
    if (
      Math.abs(prevZ.zoom - next.zoom) > 1e-6 ||
      Math.abs(prevZ.rotation - next.rotation) > 1e-6 ||
      prevZ.mirrorX !== next.mirrorX ||
      Math.abs(lastZoomDisplayScaleRef.current - curDisplayScale) > 1e-6
    ) {
      lastZoomDisplayScaleRef.current = curDisplayScale;
      viewportZoomStateRef.current = { ...next };
      viewportZoomSubsRef.current.forEach((cb) => cb());
    }
  }, []);
  const shortcutActionsRef = useRef({
    createLayer: onCreateLayer,
    deleteLayer: async (_layerId: string) => {},
    selectTool: (_tool: ToolType) => {},
    activateCategoryShortcut: (_categoryId: ToolCategoryId) => {},
    undo: () => {},
    redo: () => {},
    transform: (_mode?: DistortMode) => {},
    stepSize: (_direction: 1 | -1) => {},
    stepOpacity: (_direction: 1 | -1) => {},
    vectorKey: (_ev: KeyboardEvent): boolean => false,
    selectionKey: (_ev: KeyboardEvent): boolean => false,
    mergeDown: (_layerId: string) => {},
    groupLayers: async (_ids: string[]) => {},
    copyLayers: (_ids: string[]) => {},
    pasteLayers: async () => {},
    animAddCel: async () => {},
    animAddBlank: async () => {},
    animJumpKeyframe: (_dir: -1 | 1) => {},
    selection: { has: (): boolean => false, canPaste: (): boolean => false, invert: () => {}, copy: () => {}, cut: () => {}, clear: () => {}, paste: () => {} },
  });
  const brushCursorRef = useRef<HTMLDivElement>(null);
  const brushPointerRef = useRef<{ x: number; y: number; inside: boolean } | null>(null);
  const [showBrushSize, setShowBrushSize] = useState(false);
  // The side size slider is being dragged: the canvas centre shows the brush at its real on-screen size
  const [sizeDragging, setSizeDragging] = useState(false);
  useEffect(() => setSizeDragging(false), [isPhone, mobileSheet]);
  const brushSizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Each brush tool (筆刷／鉛筆／橡皮擦) remembers its own settings on this device
  const [brushProps, setBrushProps] = useState<BrushProperties>(() => ({ ...loadBrushTool('brush'), color: '#3B82F6' } as BrushProperties));
  const [isBrushSettingsOpen, setIsBrushSettingsOpen] = useState(false);
  brushPropsRef.current = brushProps;

  const [permissionWarning, setPermissionWarning] = useState<string | null>(null);
  const warn = (message: string, ms = 3000) => {
    setPermissionWarning(message);
    setTimeout(() => setPermissionWarning(null), ms);
  };

  const scopedUndoRef = useRef(new ScopedUndoManager());

  const updateUndoRedoState = () => {
    const effectiveUserId = userRef.current?.id || user?.id || 'guest';
    setCanUndoState(scopedUndoRef.current.canUndo(effectiveUserId));
    setCanRedoState(scopedUndoRef.current.canRedo(effectiveUserId));
  };

  const canEditPixels = (raw: LayerModel) => {
    const layer = (raw.layerType === 'mask' && layersRef.current.find((l) => l.id === raw.parentId)) || raw;
    // A group's mask is painted by whoever may edit the group (the group itself has no pixels)
    return canEditOwnPixels(layer !== raw && layer.layerType === 'group' ? { ...layer, layerType: 'raster' } : layer);
  };
  const canEditOwnPixels = (layer: LayerModel) => !isGuest && !isCanvasViewer && !layer.isLocked && layer.layerType !== 'group' && Boolean(
    layer.ownerId === user?.id || (!layer.isPublic && layer.ownerId && layer.aclMode === 'shared_all')
  );

  // Canvas tools (components/workspace/tools) share the engines and the commit plumbing through this
  const toolCtx: ToolContext = {
    canvas,
    layers,
    activeLayer,
    user,
    isAdmin,
    isCanvasViewer,
    viewerReadOnlyWarn: t.collab.viewerReadOnlyWarn,
    currentTool,
    brushProps,
    setBrushProps,
    pixiAppRef,
    viewportRef,
    layerManagerRef,
    tileEngineRef,
    brushRendererRef,
    selectionEngineRef,
    vectorEngineRef,
    strokePipelineRef,
    shapeGraphicRef,
    activeLayerRef,
    brushPropsRef,
    userRef,
    currentToolRef,
    scopedUndoRef,
    updateUndoRedoState,
    commitOp,
    commitTilePatch,
    refreshLayerThumbnail,
    canEditPixels,
    warn,
    selectTool: (tool) => handleSelectTool(tool),
    requestRender: () => requestRenderRef.current(),
  };
  const liquify = useLiquifyTool(toolCtx);
  const shapes = useShapeTools(toolCtx);
  const { shapeSubtype, setShapeSubtype, shapeFillMode, setShapeFillMode, shapeLineWidth, setShapeLineWidth, shapeCornerRadius, setShapeCornerRadius, gradientMode, setGradientMode, gradientType, setGradientType } = shapes;
  const selection = useSelectionTools(toolCtx);
  const { wandTolerance, setWandTolerance, wandContiguous, setWandContiguous, hasSelectionState, setHasSelectionState, selectionMode, setSelectionMode, handleClearSelection, growSelection } = selection;
  const { selectionAntialias, setSelectionAntialias, selectionFeather, setSelectionFeather } = selection;
  useEffect(() => {
    if (!activePluginToolKey) return;
    selection.cancelPolygonLasso();
    selection.cancelMarquee();
  }, [activePluginToolKey]);
  const fill = useFillTools(toolCtx);
  const { bucketReference, setBucketReference, bucketRefLayerId, setBucketRefLayerId, bucketTolerance, setBucketTolerance, bucketExpand, setBucketExpand, bucketMode, setBucketMode, referenceLayerId, setReferenceLayerId, gapClosingRadius, setGapClosingRadius, expandRadius, setExpandRadius } = fill;
  const { lassoFillErase, setLassoFillErase } = fill;
  const vector = useVectorTools(toolCtx);
  const {
    vectorEraserMode, setVectorEraserMode, vectorWidthMode, setVectorWidthMode, vectorStrokesList, setVectorStrokesList,
    bezierMode, setBezierMode, penPoints, vectorSel, selectedStrokeIds, selectedStrokeIdsRef, setSelectedStrokeIds, vectorPreview, penPreview, selectedAnchorExists,
    applyVectorPayload, finishPenPath, toggleSelectedAnchorCorner, deleteSelectedAnchor, handleVectorKey,
  } = vector;
  const brush = useBrushTool(toolCtx);
  const [lassoOutlineEnabled, setLassoOutlineEnabled] = useState(false);
  const isLassoFillSubTool = currentTool === 'bucket' && subToolState.activeSubToolId === 'fill_lasso';
  const outlineBrush = isLassoFillSubTool ? { ...brush.outlineBrush, enabled: lassoOutlineEnabled } : brush.outlineBrush;
  const updateOutlineBrush = ({ enabled, ...style }: Partial<typeof outlineBrush>) => {
    if (isLassoFillSubTool && enabled !== undefined) {
      setLassoOutlineEnabled(enabled);
      if (Object.keys(style).length > 0) brush.updateOutlineBrush(style);
    } else {
      brush.updateOutlineBrush({ ...style, ...(enabled !== undefined && { enabled }) });
    }
  };
  // The stroke pipeline is built once per canvas: it reaches the latest commit handler through this
  const brushCommitRef = useRef(brush.commitStroke);
  brushCommitRef.current = brush.commitStroke;
  const transform = useTransformTool(toolCtx);
  const {
    isTransformActive, transformPreviewUrl, transformBox, setTransformBox, distortMode, setDistortMode, isMeshWarpActive,
    transformLayerIdRef, transformSourceCanvasRef, meshWarpInitialBoundsRef, startTransformMode, startFloatingPaste, applyTransform, cancelTransform, applyMeshWarp,
  } = transform;
  // 對齊・均分: layers/groups, vector strokes, text bounds, and canvas guides
  const { alignTargets, distributeTargets } = useLayerAlign(toolCtx, {
    layersRef,
    applyVectorPayload,
    updateLayerMeta: (layerId, meta) => { void onUpdateLayerProps?.(layerId, { meta }); },
    onVectorStrokesChanged: (layerId) => {
      if (activeLayerRef.current?.id === layerId) {
        setVectorStrokesList(vectorEngineRef.current?.getStrokes(layerId) ?? []);
      }
    },
  });
  const [alignOpen, setAlignOpen] = useState(false);
  const [alignGuidesVersion, setAlignGuidesVersion] = useState(0);
  useEffect(() => {
    if (!alignOpen) return;
    setAlignGuidesVersion((v) => v + 1);
    return RulerManager.getInstance().subscribe(() => setAlignGuidesVersion((v) => v + 1));
  }, [alignOpen]);
  const {
    liquifyEngineRef,
    blurSmudgeEngineRef,
    liquifyMode,
    setLiquifyMode,
    liquifyRadius,
    setLiquifyRadius,
    liquifyStrength,
    setLiquifyStrength,
    liquifyHardness,
    setLiquifyHardness,
    liquifyRefAreaOnly,
    setLiquifyRefAreaOnly,
    smudgeMode,
    setSmudgeMode,
  } = liquify;

  const [eraserHover, setEraserHoverState] = useState(false);
  const eraserHoverRef = useRef(false);
  const setEraserHover = (active: boolean) => {
    if (eraserHoverRef.current === active) return;
    eraserHoverRef.current = active;
    setEraserHoverState(active);
  };
  const vectorCursorClass = currentTool === 'vector_eraser' ? 'border-dashed border-rose-500/80 bg-rose-500/10'
    : currentTool === 'vector_reshape' ? 'border-dashed border-sky-400/80 bg-sky-400/10'
    : currentTool === 'vector_width' ? 'border-dashed border-pink-500/80 bg-pink-500/10' : '';
  const brushDiameter = eraserHover && currentTool !== 'eraser' ? loadBrushTool('eraser').size ?? 40
    : currentTool === 'liquify' ? liquifyRadius * 2
    : currentTool === 'blur' || currentTool === 'smudge' || vectorCursorClass ? brushProps.size * 2
    : brushProps.size;
  const showBrushCrosshair = useSyncExternalStore(subscribeShowBrushCrosshair, getShowBrushCrosshair, getShowBrushCrosshair);
  const showBrushCursor = !activePluginTool && (eraserHover || Boolean(vectorCursorClass) || ['brush', 'pencil', 'eraser', 'liquify', 'blur', 'smudge', 'select_brush', 'select_eraser', 'paint_unfilled'].includes(currentTool));
  const defaultCanvasCursorClass = !activePluginTool && currentTool === 'hand'
    ? 'cursor-grab'
    : showBrushCursor && !showBrushCrosshair
      ? 'cursor-none'
      : 'cursor-crosshair';

  // The number the options bar / [ ] keys edit: liquify keeps its own radius, the rest the brush size
  const sizeValue = currentTool === 'liquify' ? liquifyRadius : brushProps.size;
  const setSizeValue = (value: number) => {
    const n = Math.max(1, Math.min(MAX_BRUSH_SIZE, Math.round(value)));
    if (currentToolRef.current === 'liquify') {
      setLiquifyRadius(n);
      return;
    }
    setBrushProps((prev) => {
      brushRendererRef.current?.setProperties({ size: n });
      return { ...prev, size: n };
    });
  };
  const containerRectRef = useRef<{ left: number; top: number } | null>(null);
  const brushCursorFrameRef = useRef(0);
  const updateBrushCursor = (x: number, y: number) => {
    let rect = containerRectRef.current;
    if (!rect) {
      const r = containerRef.current?.getBoundingClientRect();
      if (!r) return;
      rect = { left: r.left, top: r.top };
      if (r.width > 0 || r.height > 0) containerRectRef.current = rect;
    }
    const lx = x - rect.left;
    const ly = y - rect.top;
    const previous = brushPointerRef.current;
    if (previous?.inside && previous.x === lx && previous.y === ly) return;
    brushPointerRef.current = { x: lx, y: ly, inside: true };
    if (!brushCursorRef.current || brushCursorFrameRef.current) return;
    brushCursorFrameRef.current = requestAnimationFrame(() => {
      brushCursorFrameRef.current = 0;
      const cursor = brushCursorRef.current;
      const pointer = brushPointerRef.current;
      if (!cursor || !pointer?.inside) return;
      cursor.style.transform = `translate3d(${pointer.x}px, ${pointer.y}px, 0) translate(-50%, -50%)`;
      cursor.style.visibility = 'visible';
    });
  };
  const hideBrushCursor = () => {
    if (brushPointerRef.current) brushPointerRef.current.inside = false;
    if (brushCursorRef.current) brushCursorRef.current.style.visibility = 'hidden';
  };

  // High-frequency raw pointer cursor updates so cursor stays locked at full hardware polling rate (up to 1000Hz)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !showBrushCursor) return;
    const onRawUpdate = (ev: Event) => {
      const pe = ev as PointerEvent;
      if (pe.clientX || pe.clientY) updateBrushCursor(pe.clientX, pe.clientY);
    };
    el.addEventListener('pointerrawupdate', onRawUpdate, { passive: true });
    return () => {
      el.removeEventListener('pointerrawupdate', onRawUpdate);
      cancelAnimationFrame(brushCursorFrameRef.current);
      brushCursorFrameRef.current = 0;
    };
  }, [showBrushCursor, canvas?.id]);

  useLayoutEffect(() => {
    const cursor = brushCursorRef.current;
    const container = containerRef.current;
    if (!cursor || !container) return;
    const last = brushPointerRef.current;
    const lx = last?.inside ? last.x : container.clientWidth / 2;
    const ly = last?.inside ? last.y : container.clientHeight / 2;
    cursor.style.transform = `translate3d(${lx}px, ${ly}px, 0) translate(-50%, -50%)`;
    cursor.style.visibility = last?.inside || showBrushSize ? 'visible' : 'hidden';
  }, [showBrushCursor, showBrushSize, brushDiameter, canvas?.id]);

  useEffect(() => {
    setShowBrushSize(true);
    brushSizeTimerRef.current = setTimeout(() => setShowBrushSize(false), 900);
    return () => { if (brushSizeTimerRef.current) clearTimeout(brushSizeTimerRef.current); };
  }, [brushProps.size, liquifyRadius]);

  // Load Checkpoint Snapshot & Replay Ops
  const loadCheckpointAndReplay = async (
    canvasId: string,
    layerManager: LayerManager,
    tileEngine: TileEngine
  ) => {
    const isCurrent = () => layerManagerRef.current === layerManager;
    isReplayingRef.current = true;
    replayedSeqRef.current = 0;
    try {
      const snapRes = await ApiService.getSnapshot(canvasId);
      if (!isCurrent()) return;
      let sinceSeq = 0;

      if (snapRes?.bundle?.layers) {
        sinceSeq = snapRes.bundle.seq || 0;
        for (const layerSnap of snapRes.bundle.layers) {
          // Parked layers keep the compressed tiles as they came: hidden frames never touch the GPU
          if (layerSnap.tiles?.length) layerManager.applyTiles(layerSnap.layerId, layerSnap.tiles);
          // The checkpoint replaces the ops that carried these, so restore them from it
          for (const vectorStroke of layerSnap.vectorStrokes || []) {
            vectorEngineRef.current?.addStroke(layerSnap.layerId, vectorStroke);
          }
        }
      }
      replayedSeqRef.current = sinceSeq;

      // Replay incremental operations after snapshot seq
      const opsRes = await ApiService.getOpsSince(canvasId, sinceSeq);
      if (!isCurrent()) return;
      if (opsRes?.ops && opsRes.ops.length > 0) {
        for (const op of opsRes.ops) {
          replayedSeqRef.current = Math.max(replayedSeqRef.current, op.seq || 0);
          if (!op.layerId) continue;
          const layerItem = layerManager.getLayerItem(op.layerId);
          if (!layerItem) continue;

          // Prefer direct authoritative pixel-perfect tile restoration whenever tiles are present
          if (op.payload?.tiles && Array.isArray(op.payload.tiles) && op.payload.tiles.length > 0) {
            layerManager.applyTiles(op.layerId, op.payload.tiles);
          } else if (
            (op.opType === 'STROKE' || op.opType === 'ERASE') &&
            op.payload?.samplePoints &&
            brushRendererRef.current
          ) {
            const pts = op.payload.samplePoints;
            const flat = new Float32Array(pts.length * 7);
            for (let i = 0; i < pts.length; i++) {
              const off = i * 7;
              flat[off] = pts[i].x;
              flat[off + 1] = pts[i].y;
              flat[off + 2] = (op.payload.size || 16) * (pts[i].pressure || 0.5);
              flat[off + 3] = pts[i].pressure || 0.5;
              flat[off + 4] = (op.payload.flow || 1.0) * (op.payload.opacity || 1.0);
              flat[off + 5] = 0;
              flat[off + 6] = 0;
            }
            brushRendererRef.current.stampDabs(
              layerManager.drawTarget(op.layerId) ?? layerItem.renderTexture,
              flat,
              pts.length,
              op.payload.color,
              op.payload.isEraser
            );
          }

          // Replay the vector stroke list changes too (erased strokes must stay erased)
          applyVectorPayload(op.layerId, op.payload);
        }
      }

      // Refresh thumbnails for all layers (ping-pong buffers are made when a layer is drawn on)
      for (const l of layersRef.current) {
        layerManager.refreshPingPong(l.id);
        refreshLayerThumbnail(l.id);
      }

      if (vectorEngineRef.current && activeLayerRef.current) {
        setVectorStrokesList(vectorEngineRef.current.getStrokes(activeLayerRef.current.id));
      }
    } catch (err) {
      if (isCurrent()) console.warn('[CanvasWorkspace] Checkpoint / Op Replay failed:', err);
    } finally {
      // Live ops that arrived meanwhile were held back; draw the ones the replay did not cover
      if (isCurrent()) {
        isReplayingRef.current = false;
        for (const op of takeBroadcastOps()) applyRemoteOp(op);
        presentCanvas();
      }
    }
  };

  const fitViewport = (fit = true) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect?.width && rect.height) viewportRef.current?.centerInView(rect.width, rect.height, fit);
  };

  const getViewCenter = () => {
    const rect = containerRef.current?.getBoundingClientRect();
    return rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };

  const zoomAtViewCenter = (factor: number) => {
    const center = getViewCenter();
    if (center) viewportRef.current?.zoomAt(center.x, center.y, factor);
  };

  // 1. Initialize Pixi.js v8 Application and Tile Engine
  useLayoutEffect(() => {
    const container = containerRef.current;
    const mount = canvasMountRef.current;
    if (!container || !mount || !canvas) return;
    setEngineError(false);
    setIsCanvasPresented(false);

    const undoLimit = OfflineSessionStore.isOfflineCanvas(canvas.id) ? OFFLINE_UNDO_LIMIT : ONLINE_UNDO_LIMIT;
    const undoManager = undoByCanvasRef.current.get(canvas.id) ?? new ScopedUndoManager(undoLimit);
    undoManager.setMaxStackSize(undoLimit);
    undoByCanvasRef.current.set(canvas.id, undoManager);
    scopedUndoRef.current = undoManager;
    updateUndoRedoState();

    const timeline = animationByCanvasRef.current.get(canvas.id) ?? new AnimationEngine();
    animationByCanvasRef.current.set(canvas.id, timeline);
    setTimelineState({ canvasId: canvas.id, engine: timeline });

    let destroyed = false;
    let resizeObserver: ResizeObserver | null = null;
    let syncDisplayResolution: ((nextWidth?: number, nextHeight?: number) => void) | null = null;
    let unbindDprWatcher: (() => void) | null = null;
    let themeObserver: MutationObserver | null = null;
    let renderRaf = 0;
    let handleKeyDown: ((ev: KeyboardEvent) => void) | null = null;
    let handleKeyUp: ((ev: KeyboardEvent) => void) | null = null;
    let handleWindowBlur: (() => void) | null = null;
    let activeFlipKeyCode: string | null = null;
    let vpSyncRaf = 0;
    const invalidateContainerRect = () => { containerRectRef.current = null; };
    const handleWindowResize = () => {
      invalidateContainerRect();
      syncDisplayResolution?.();
    };
    window.addEventListener('resize', handleWindowResize, { passive: true });
    window.addEventListener('scroll', invalidateContainerRect, { capture: true, passive: true });
    let app = new Application();

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!event.deltaY) return;
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      viewportRef.current?.zoomAt(event.clientX, event.clientY, factor);
    };
    container.addEventListener('wheel', handleWheel, { passive: false });

    const initEngine = async () => {
      const rect = container.getBoundingClientRect();
      let viewWidth = Math.max(1, rect.width);
      let viewHeight = Math.max(1, rect.height);
      const initialBgColor = parseWorkspaceBgColor(getComputedStyle(container).getPropertyValue('--workspace-bg'));

      try {
        await app.init({
          width: viewWidth,
          height: viewHeight,
          preference: 'webgl',
          backgroundColor: initialBgColor,
          backgroundAlpha: 1,
          // 覆蓋／柔光／加亮… are blend filters, and on WebGL they silently fall back to normal without
          // the back buffer (Pixi turns screen MSAA off with it; layers are render textures anyway)
          useBackBuffer: true,
          antialias: false,
          resolution: getTargetDisplayResolution(),
          autoDensity: true,
          eventMode: 'none',
          eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
        });
      } catch (err) {
        if (destroyed) return;
        console.warn('Pixi WebGL init with antialias failed, retrying basic WebGL:', err);
        app = new Application();
        await app.init({
          width: viewWidth,
          height: viewHeight,
          preference: 'webgl',
          backgroundColor: initialBgColor,
          backgroundAlpha: 1,
          useBackBuffer: true,
          resolution: getTargetDisplayResolution(),
          autoDensity: true,
          eventMode: 'none',
          eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
        });
      }

      if (destroyed) {
        app.destroy({ removeView: true }, { children: true });
        return;
      }

      // Render WebGL on demand so idle time, menus, and window dragging use 0% GPU/CPU.
      app.ticker.autoStart = false;
      app.ticker.stop();

      let pipelineForRender: StrokePipeline | null = null;
      let syncViewportPending: (() => void) | null = null;
      let prepareLayerView: (() => void) | null = null;
      const scheduleRender = () => {
        if (destroyed || renderRaf) return;
        renderRaf = requestAnimationFrame(() => {
          renderRaf = 0;
          if (destroyed) return;
          syncViewportPending?.();
          pipelineForRender?.renderFrame();
          prepareLayerView?.();
          app.render();
          if (pipelineForRender?.hasPendingWork()) scheduleRender();
        });
      };
      requestRenderRef.current = scheduleRender;

      const currentRect = container.getBoundingClientRect();
      viewWidth = Math.max(1, currentRect.width);
      viewHeight = Math.max(1, currentRect.height);
      app.renderer.resize(viewWidth, viewHeight, getTargetDisplayResolution());
      let editingResolution = app.renderer.resolution;
      let playbackReduced = false;
      setPlaybackResolutionRef.current = (reduced) => {
        playbackReduced = reduced;
        const resolution = reduced ? Math.max(0.75, editingResolution * 0.75) : editingResolution;
        if (destroyed || Math.abs(resolution - app.renderer.resolution) <= 1e-4) return;
        app.renderer.resize(viewWidth, viewHeight, resolution);
        scheduleRender();
      };
      mount.replaceChildren(app.canvas);
      app.canvas.style.touchAction = 'none';
      app.canvas.style.width = '100%';
      app.canvas.style.height = '100%';
      app.canvas.style.display = 'block';
      app.canvas.style.pointerEvents = 'none';

      pixiAppRef.current = app;

      let currentBgColor = initialBgColor;
      const syncWorkspaceBackground = () => {
        if (destroyed) return;
        const nextBg = parseWorkspaceBgColor(getComputedStyle(container).getPropertyValue('--workspace-bg'));
        if (currentBgColor !== nextBg) {
          currentBgColor = nextBg;
          app.renderer.background.color = nextBg;
          scheduleRender();
        }
      };
      themeObserver = new MutationObserver(syncWorkspaceBackground);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

      // 1. Viewport
      const viewport = new CanvasViewport(canvas.width, canvas.height);
      viewport.setDisplayScale(editingResolution);
      viewport.setDomElement(app.canvas);
      viewportRef.current = viewport;
      app.stage.eventMode = 'none';
      app.stage.interactiveChildren = false;
      app.renderer.events?.setTargetElement?.(null as unknown as HTMLElement);
      app.stage.addChild(viewport.rootContainer);
      viewport.centerInView(viewWidth, viewHeight, true);

      // 2. Layer Manager
      const layerManager = new LayerManager(
        app.renderer,
        canvas.width,
        canvas.height,
        canvas.bgColor,
        OfflineSessionStore.isOfflineCanvas(canvas.id)
      );
      layerManagerRef.current = layerManager;
      prepareLayerView = () => {
        const deviceScale = viewport.getState().zoom * app.renderer.resolution;
        layerManager.setPixelated(deviceScale >= 1 - 1e-6);
        layerManager.prepareView(deviceScale);
      };
      const syncViewportBounds = () => {
        if (destroyed) return;
        const w = app.screen.width || viewWidth;
        const h = app.screen.height || viewHeight;
        layerManager.setViewportBounds(computeViewportBounds(viewport, w, h));
      };
      let pendingVpState: ViewportState | null = null;
      let vpBoundsDirty = false;
      let lastDispatchedZoom = -1;
      let lastDispatchedDisplayScale = -1;
      const flushViewportBoundsAndZoom = () => {
        if (destroyed || !vpBoundsDirty) return;
        vpBoundsDirty = false;
        syncViewportBounds();
        const st = pendingVpState ?? viewport.getState();
        const curDisplayScale = viewport.getDisplayScale();
        if (
          Math.abs(st.zoom - lastDispatchedZoom) > 1e-6 ||
          Math.abs(curDisplayScale - lastDispatchedDisplayScale) > 1e-6
        ) {
          lastDispatchedZoom = st.zoom;
          lastDispatchedDisplayScale = curDisplayScale;
          selectionEngineRef.current?.setViewScale(st.zoom);
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('atelier:zoom', { detail: st.zoom * curDisplayScale }));
          }
        }
      };
      syncViewportPending = flushViewportBoundsAndZoom;
      const flushViewportSync = () => {
        vpSyncRaf = 0;
        if (destroyed || !pendingVpState) return;
        const st = pendingVpState;
        pendingVpState = null;
        flushViewportBoundsAndZoom();
        notifyViewportSubs(st);
      };
      viewport.setOnChange((st) => {
        layerManager.markInteractive();
        pendingVpState = st;
        vpBoundsDirty = true;
        scheduleRender();
        if (!vpSyncRaf) vpSyncRaf = requestAnimationFrame(flushViewportSync);
      });
      const initialVp = viewport.getState();
      notifyViewportSubs(initialVp);
      vpBoundsDirty = true;
      flushViewportBoundsAndZoom();
      layerManager.onStageChange = scheduleRender;
      layerManager.setActiveLayer(activeLayerRef.current?.id ?? null);
      // Thumbnails of parked layers are decoded when the page is idle
      layerManager.onThumbnail = (layerId, url) => {
        if (layerManagerRef.current === layerManager) publishThumbnail(layerId, url);
      };
      viewport.canvasContainer.addChild(layerManager.rootContainer);
      (window as any).__debugPixi = { app, viewport, layerManager };

      // 3. Selection Engine Overlay
      const selectionEngine = new SelectionEngine(canvas.width, canvas.height);
      selectionEngine.setOnStageChange(scheduleRender);
      selectionEngineRef.current = selectionEngine;
      viewport.canvasContainer.addChild(selectionEngine.rootContainer);

      // 3.5. Shape & Vector Preview Overlay
      const shapeGraphic = new Graphics();
      shapeGraphicRef.current = shapeGraphic;
      viewport.canvasContainer.addChild(shapeGraphic);

      // 4. Tile Engine
      const tileEngine = new TileEngine(app.renderer, canvas.width, canvas.height, 256);
      tileEngineRef.current = tileEngine;
      // Sparse layers are read tile by tile from their atlas pages, with the same non-blocking read-back
      layerManager.setReader(
        (texture, rects) => tileEngine.readRegionsAsync(texture, rects),
        () => tileEngine.flushReads()
      );
      warmUpCommitWorkers();
      (window as any).__debugPixi = { app, viewport, layerManager, tileEngine };

      // 5. Brush Renderer
      const brushRenderer = new BrushRenderer(app.renderer);
      brushRenderer.setCanvasDimensions(canvas.width, canvas.height);
      brushRendererRef.current = brushRenderer;
      const currentBrush = brushPropsRef.current || brushProps;
      brushRenderer.setProperties(currentBrush);
      if (currentBrush.customBrushUrl) {
        void brushRenderer.setCustomBrushImage(currentBrush.customBrushUrl).catch((err) => {
          if (!destroyed) console.warn('[CanvasWorkspace] Failed to load the brush tip:', err);
        });
      }

      // 6. WebGL Filter Engine & Liquify Engine
      const filterEngine = new WebGLFilterEngine(app.renderer, tileEngine, canvas.width, canvas.height);
      webglFilterEngineRef.current = filterEngine;

      const liquifyEngine = new LiquifyEngine(app.renderer, tileEngine, canvas.width, canvas.height);
      liquifyEngineRef.current = liquifyEngine;

      const blurSmudgeEngine = new BlurSmudgeEngine(app.renderer, tileEngine, canvas.width, canvas.height);
      blurSmudgeEngineRef.current = blurSmudgeEngine;

      const vectorEngine = new VectorEngine(tileEngine, canvas.width, canvas.height);
      vectorEngineRef.current = vectorEngine;
      // Test hooks: the undo history (ops carry their foreign-pixel masks) lets browser checks explain an undo
      (window as any).__debugPixi = {
        app, viewport, layerManager, tileEngine, selectionEngine, vectorEngine, animationEngine: timeline,
        rulerManager: RulerManager.getInstance(),
        undo: scopedUndoRef.current, tileToRgba,
        get filterWorker() { return filterWorkerRef.current; },
        get pluginFilterWorker() { return pluginFilterWorkerRef.current; },
      };

      // 6.1 Initialize Rulers
      RulerManager.getInstance().initDimensions(canvas.width, canvas.height);

      // 6. Stroke Pipeline with Tile Dirty Detection & Zero-Latency Ping-Pong
      const pipeline = new StrokePipeline(brushRenderer, layerManager, viewport, {
        coalesceTouch: OfflineSessionStore.isOfflineCanvas(canvas.id),
        onEmitPreviewDabs: OfflineSessionStore.isOfflineCanvas(canvas.id) ? undefined : (dabs, isEraser) => {
          const currentLayer = activeLayerRef.current;
          const currentProps = brushPropsRef.current || brushProps;
          if (currentLayer && canvas) {
            emitPreviewDab(
              currentLayer.id,
              dabs,
              currentProps.color,
              currentProps.size,
              currentProps.opacity * currentProps.flow,
              isEraser
            );
          }
        },
        onCommitStroke: (strokeData, inkTiles) => brushCommitRef.current(strokeData, inkTiles),
      });
      strokePipelineRef.current = pipeline;
      pipelineForRender = pipeline;
      pipeline.setOnNeedsRender(scheduleRender);
      pipeline.setActiveLayer(activeLayerRef.current?.id || null);
      scheduleRender();

      syncDisplayResolution = (nextWidth = viewWidth, nextHeight = viewHeight) => {
        if (destroyed) return;
        const w = Math.max(1, nextWidth);
        const h = Math.max(1, nextHeight);
        const nextEditingRes = getTargetDisplayResolution();
        const resChanged = Math.abs(nextEditingRes - editingResolution) > 1e-4;
        const sizeChanged = Math.abs(w - viewWidth) > 1e-4 || Math.abs(h - viewHeight) > 1e-4;
        if (!resChanged && !sizeChanged) return;

        // Evaluate fit state before mutating displayScale or view dimensions
        const wasFit = viewWidth <= 1 || viewHeight <= 1 || viewport.isFitTo(viewWidth, viewHeight);
        const prevWidth = viewWidth;
        const prevHeight = viewHeight;
        editingResolution = nextEditingRes;
        viewWidth = w;
        viewHeight = h;

        const targetRendererRes = playbackReduced ? Math.max(0.75, editingResolution * 0.75) : editingResolution;
        app.renderer.resize(viewWidth, viewHeight, targetRendererRes);
        if (resChanged) {
          viewport.setDisplayScale(editingResolution);
        }
        if (wasFit) {
          viewport.centerInView(viewWidth, viewHeight, true);
        } else if (sizeChanged) {
          viewport.panBy((viewWidth - prevWidth) / 2, (viewHeight - prevHeight) / 2);
        }
        vpBoundsDirty = true;
        flushViewportBoundsAndZoom();
        notifyViewportSubs(viewport.getState());
        // Resizing the WebGL backbuffer clears it immediately; re-render synchronously before paint to eliminate flicker
        prepareLayerView?.();
        app.render();
      };

      const bindDprWatcher = () => {
        unbindDprWatcher?.();
        unbindDprWatcher = null;
        if (destroyed || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const dpr = window.devicePixelRatio || 1;
        const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
        const onDprChange = () => {
          bindDprWatcher();
          invalidateContainerRect();
          viewport.invalidateRect();
          const r = container.getBoundingClientRect();
          syncDisplayResolution?.(r.width > 0 ? r.width : viewWidth, r.height > 0 ? r.height : viewHeight);
        };
        if (typeof mq.addEventListener === 'function') {
          mq.addEventListener('change', onDprChange, { once: true });
          unbindDprWatcher = () => mq.removeEventListener('change', onDprChange);
        } else {
          const legacyMq = mq as MediaQueryList & {
            addListener?: (cb: () => void) => void;
            removeListener?: (cb: () => void) => void;
          };
          legacyMq.addListener?.(onDprChange);
          unbindDprWatcher = () => legacyMq.removeListener?.(onDprChange);
        }
      };
      bindDprWatcher();

      // Keep the point at the center in place when a dock changes the workspace size, or when DPR changes across monitors.
      resizeObserver = new ResizeObserver(([entry]) => {
        if (destroyed || !entry) return;
        containerRectRef.current = null;
        viewport.invalidateRect();
        const { width, height } = entry.contentRect;
        if (width <= 0 || height <= 0) return;
        syncDisplayResolution?.(width, height);
      });
      resizeObserver.observe(container);

      // Keyboard listeners for shortcuts
      handleKeyDown = (ev: KeyboardEvent) => {
        // An open dialog owns the keyboard: B, Ctrl+Z, Space... must not edit the canvas behind it
        if (document.querySelector('[aria-modal="true"]')) return;
        // Space pans wherever the focus is, except while typing or inside a dialog / menu: the
        // button clicked last kept the focus and was pressed again instead of the canvas panning
        if (ev.code === 'Space' && !filterModalOpenRef.current && !radialMenuOpenRef.current && !isTypingTarget(ev.target)
          && !(ev.target as HTMLElement | null)?.closest?.('[role="dialog"], [role="menu"]')) {
          ev.preventDefault();
          if (!ev.repeat) {
            (document.activeElement as HTMLElement | null)?.blur?.();
            pointer.isSpacePressedRef.current = true;
            if (containerRef.current) containerRef.current.style.cursor = 'grab';
          }
          return;
        }
        const textEditingTarget = (ev.target as HTMLElement | null)?.closest?.(
          'textarea, [contenteditable], input:not([type]), input[type="text"], input[type="search"], input[type="number"], input[type="email"], input[type="password"], input[type="url"]'
        );
        if (filterModalOpenRef.current || radialMenuOpenRef.current || textEditingTarget) return;
        if (resizeModalOpenRef.current) {
          if (ev.key === 'Escape') {
            ev.preventDefault();
            setIsResizeModalOpen(false);
          }
          return;
        }
        const shortcutMgr = ShortcutManager.getInstance();
        const categoryHit = TOOL_CATEGORIES.find((category) => category.shortcutId && shortcutMgr.matchesEvent(shortcutMgr.getComboForAction(category.shortcutId), ev));
        if (transformLayerIdRef.current) {
          if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
            ev.preventDefault();
            cancelTransform();
          } else if (currentToolRef.current === 'transform' && categoryHit?.id === 'transform') {
            ev.preventDefault();
            if (!ev.repeat) shortcutActionsRef.current.activateCategoryShortcut(categoryHit.id);
          }
          return;
        }
        // Pen path in progress / selected vector node: Enter, Esc, Backspace, Delete belong to them
        if (shortcutActionsRef.current.selectionKey(ev) || shortcutActionsRef.current.vectorKey(ev)) {
          ev.preventDefault();
          return;
        }

        // Check undo (Ctrl+Z / Cmd+Z)
        if (
          shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_undo'), ev) ||
          ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !ev.shiftKey)
        ) {
          ev.preventDefault();
          shortcutActionsRef.current.undo();
          return;
        }

        // Check redo (Ctrl+Shift+Z / Cmd+Shift+Z / Ctrl+Y)
        if (
          shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_redo'), ev) ||
          ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === 'y' || (ev.key.toLowerCase() === 'z' && ev.shiftKey)))
        ) {
          ev.preventDefault();
          shortcutActionsRef.current.redo();
          return;
        }

        // Check clear selection
        if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_clear_selection'), ev)) {
          ev.preventDefault();
          handleClearSelection();
          return;
        }

        // Selection commands; copy / cut / clear only with a selection (else the keys keep their usual meaning)
        const sel = shortcutActionsRef.current.selection;
        const hit = (id: string) => shortcutMgr.matchesEvent(shortcutMgr.getComboForAction(id), ev);
        const selectionCommand =
          hit('action_selection_invert') ? sel.invert
          : sel.has() && hit('action_selection_copy') ? sel.copy
          : sel.has() && hit('action_selection_cut') ? sel.cut
          : sel.has() && hit('action_selection_delete') ? sel.clear
          : sel.canPaste() && hit('action_selection_paste') ? sel.paste
          : null;
        if (selectionCommand) {
          ev.preventDefault();
          selectionCommand();
          return;
        }

        // Tool, Layer, Filter & Navigation hotkeys (when not in an input)
        const targetTag = (ev.target as HTMLElement)?.tagName?.toLowerCase();
        if (targetTag !== 'input' && targetTag !== 'textarea') {
          // --- 1. Layer & Group Management Hotkeys ---
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_layer_rename'), ev) || ev.code === 'F2') {
            ev.preventDefault();
            window.dispatchEvent(new CustomEvent('atelier:rename-layer', { detail: { layerId: activeLayerRef.current?.id } }));
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_layer_new_raster'), ev)) {
            ev.preventDefault();
            const currentLayers = layersRef.current || [];
            const count = currentLayers.filter((l) => l.layerType !== 'vector' && l.layerType !== 'group').length + 1;
            shortcutActionsRef.current.createLayer?.(`圖層 ${count}`, 'normal', 'raster', activeLayerRef.current?.id);
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_layer_new_vector'), ev)) {
            ev.preventDefault();
            const currentLayers = layersRef.current || [];
            const count = currentLayers.filter((l) => l.layerType === 'vector').length + 1;
            shortcutActionsRef.current.createLayer?.(`向量線稿 ${count}`, 'normal', 'vector', activeLayerRef.current?.id);
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_layer_new_group'), ev)) {
            ev.preventDefault();
            // The layer panel groups its multi-selection; without the panel on screen, the active layer
            const handled = !window.dispatchEvent(new CustomEvent('atelier:group-layers', { cancelable: true }));
            if (!handled && activeLayerRef.current) void shortcutActionsRef.current.groupLayers([activeLayerRef.current.id]);
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_layer_copy'), ev)) {
            ev.preventDefault();
            if (activeLayerRef.current) shortcutActionsRef.current.copyLayers([activeLayerRef.current.id]);
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_layer_paste'), ev)) {
            ev.preventDefault();
            void shortcutActionsRef.current.pasteLayers();
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_layer_duplicate'), ev)) {
            ev.preventDefault();
            if (activeLayerRef.current) {
              shortcutActionsRef.current.copyLayers([activeLayerRef.current.id]);
              void shortcutActionsRef.current.pasteLayers();
            }
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_layer_merge_down'), ev)) {
            ev.preventDefault();
            if (activeLayerRef.current) shortcutActionsRef.current.mergeDown(activeLayerRef.current.id);
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_layer_toggle_clip'), ev)) {
            ev.preventDefault();
            if (activeLayerRef.current) {
              onUpdateLayerProps?.(activeLayerRef.current.id, { clipToBelow: !activeLayerRef.current.clipToBelow });
            }
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_layer_toggle_alpha'), ev)) {
            ev.preventDefault();
            if (activeLayerRef.current) {
              onUpdateLayerProps?.(activeLayerRef.current.id, { alphaLocked: !activeLayerRef.current.alphaLocked });
            }
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_layer_toggle_vis'), ev)) {
            ev.preventDefault();
            if (activeLayerRef.current) {
              onToggleVisibility?.(activeLayerRef.current);
            }
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_layer_toggle_lock'), ev)) {
            ev.preventDefault();
            if (activeLayerRef.current) {
              onToggleLock?.(activeLayerRef.current);
            }
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_layer_delete'), ev)) {
            ev.preventDefault();
            const cur = activeLayerRef.current;
            if (cur && (cur.layerType === 'mask' || layersRef.current.filter((l) => l.layerType !== 'mask').length > 1)) {
              void shortcutActionsRef.current.deleteLayer(cur.id);
            }
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_layer_select_above'), ev)) {
            ev.preventDefault();
            const currentLayers = layersRef.current || [];
            const sorted = [...currentLayers].sort((a, b) => b.sortOrder - a.sortOrder);
            const idx = sorted.findIndex((l) => l.id === activeLayerRef.current?.id);
            if (idx > 0) {
              onSelectLayer?.(sorted[idx - 1].id);
            }
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_layer_select_below'), ev)) {
            ev.preventDefault();
            const currentLayers = layersRef.current || [];
            const sorted = [...currentLayers].sort((a, b) => b.sortOrder - a.sortOrder);
            const idx = sorted.findIndex((l) => l.id === activeLayerRef.current?.id);
            if (idx !== -1 && idx < sorted.length - 1) {
              onSelectLayer?.(sorted[idx + 1].id);
            }
            return;
          }

          // --- 2. Advanced Filters & Tone Hotkeys ---
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_filter_curves'), ev)) {
            ev.preventDefault();
            openFilterFromShortcut('curves');
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_filter_gradient_map'), ev)) {
            ev.preventDefault();
            openFilterFromShortcut('gradient');
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_filter_mesh_warp'), ev)) {
            ev.preventDefault();
            shortcutActionsRef.current.transform('mesh');
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_filter_screentone'), ev)) {
            ev.preventDefault();
            if (activeLayerRef.current) {
              onUpdateLayerProps?.(activeLayerRef.current.id, {
                screentoneEnabled: !activeLayerRef.current.screentoneEnabled,
              });
            }
            return;
          }

          // --- 3. Studio & Auxiliary Views ---
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_studio_ruler'), ev)) {
            ev.preventDefault();
            setIsRulerModalOpen((prev) => !prev);
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_studio_timeline'), ev)) {
            ev.preventDefault();
            setIsAnimationTimelineOpen((prev) => !prev);
            return;
          }
          if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_studio_color_wheel'), ev)) {
            ev.preventDefault();
            setIsColorStudioOpen((prev) => !prev);
            return;
          }

          // --- 4. Toolbox Tools: the same bindings the tool rail shows ---
          if (categoryHit) {
            ev.preventDefault();
            if (!ev.repeat) shortcutActionsRef.current.activateCategoryShortcut(categoryHit.id);
            return;
          }
          const toolHit = ALL_TOOLS.find((tool) => tool.shortcutId && shortcutMgr.matchesEvent(shortcutMgr.getComboForAction(tool.shortcutId), ev));
          if (toolHit) {
            ev.preventDefault();
            shortcutActionsRef.current.selectTool(toolHit.id);
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('tool_resize'), ev)) {
            setIsResizeModalOpen(true);
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_brush_larger'), ev)) {
            ev.preventDefault();
            shortcutActionsRef.current.stepSize(1);
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_brush_smaller'), ev)) {
            ev.preventDefault();
            shortcutActionsRef.current.stepSize(-1);
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_brush_opacity_up'), ev)) {
            ev.preventDefault();
            shortcutActionsRef.current.stepOpacity(1);
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_brush_opacity_down'), ev)) {
            ev.preventDefault();
            shortcutActionsRef.current.stepOpacity(-1);
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_view_rotate_left'), ev)) {
            ev.preventDefault();
            viewportRef.current?.rotateBy(-Math.PI / 12);
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_view_rotate_right'), ev)) {
            ev.preventDefault();
            viewportRef.current?.rotateBy(Math.PI / 12);
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_view_flip'), ev)) {
            ev.preventDefault();
            viewportRef.current?.toggleMirrorX();
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_anim_prev_frame'), ev)) {
            ev.preventDefault();
            animEngineRef.current?.goToPrevFrame();
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_anim_next_frame'), ev)) {
            ev.preventDefault();
            animEngineRef.current?.goToNextFrame();
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_anim_play'), ev)) {
            ev.preventDefault();
            animEngineRef.current?.togglePlay();
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_anim_onion'), ev)) {
            ev.preventDefault();
            const engine = animEngineRef.current;
            if (engine) {
              const on = !engine.getOnionSkinConfig().enabled;
              engine.setOnionSkinConfig({ enabled: on });
              warn(on ? '洋蔥皮：開' : '洋蔥皮：關', 1200);
            }
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_anim_add_cel'), ev)) {
            ev.preventDefault();
            if (!ev.repeat) void shortcutActionsRef.current.animAddCel();
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_anim_add_blank'), ev)) {
            ev.preventDefault();
            if (!ev.repeat) void shortcutActionsRef.current.animAddBlank();
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_anim_first_frame'), ev)) {
            ev.preventDefault();
            animEngineRef.current?.goToStart();
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_anim_last_frame'), ev)) {
            ev.preventDefault();
            animEngineRef.current?.goToEnd();
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_anim_prev_keyframe'), ev)) {
            ev.preventDefault();
            shortcutActionsRef.current.animJumpKeyframe(-1);
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_anim_next_keyframe'), ev)) {
            ev.preventDefault();
            shortcutActionsRef.current.animJumpKeyframe(1);
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_anim_flip'), ev)) {
            ev.preventDefault();
            if (!ev.repeat && animEngineRef.current) {
              activeFlipKeyCode = ev.code;
              animEngineRef.current.startFlipLoop();
            }
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_reset_view'), ev)) {
            fitViewport(false);
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_zoom_in'), ev)) {
            ev.preventDefault();
            zoomAtViewCenter(1.2);
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_zoom_out'), ev)) {
            ev.preventDefault();
            zoomAtViewCenter(1 / 1.2);
          } else if (shortcutMgr.matchesEvent(shortcutMgr.getComboForAction('action_toggle_mic'), ev)) {
            toggleVoiceMute();
          } else if (!ev.repeat) {
            const pluginHit = shortcutMgr.findPluginActionForEvent(ev);
            if (pluginHit) {
              ev.preventDefault();
              window.dispatchEvent(new CustomEvent('atelier:plugin-shortcut', { detail: pluginHit }));
            }
          }
        }
      };

      handleKeyUp = (ev: KeyboardEvent) => {
        if (ev.code === 'Space') {
          // Some browsers press a focused button on the key's release
          if (pointer.isSpacePressedRef.current) ev.preventDefault();
          pointer.isSpacePressedRef.current = false;
          if (containerRef.current) containerRef.current.style.cursor = activePluginToolRef.current?.tool.cursor ?? '';
        }
        if (activeFlipKeyCode && ev.code === activeFlipKeyCode) {
          activeFlipKeyCode = null;
          animEngineRef.current?.endFlip();
        }
      };

      handleWindowBlur = () => {
        if (activeFlipKeyCode || animEngineRef.current?.isFlipping()) {
          activeFlipKeyCode = null;
          animEngineRef.current?.endFlip();
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);
      window.addEventListener('blur', handleWindowBlur);

      // Synchronize layers and replay operations if layers are already loaded
      const currentLayers = layersRef.current;
      if (currentLayers && currentLayers.length > 0) {
        const shownDisplay = displayLayersRef.current;
        layerManager.syncLayers(shownDisplay);
        const shownIds = new Set(shownDisplay.filter((l) => l.isVisible).map((l) => l.id));
        for (const l of currentLayers) {
          if (shownIds.has(l.id) || !l.meta?.cel) refreshLayerThumbnail(l.id);
        }
        if (canvas && tileEngine && lastReplayedCanvasIdRef.current !== canvas.id) {
          lastReplayedCanvasIdRef.current = canvas.id;
          loadCheckpointAndReplay(canvas.id, layerManager, tileEngine);
        }
      }

      setIsEngineReady(true);
    };

    void initEngine().catch((err) => {
      if (destroyed) return;
      console.error('[CanvasWorkspace] Failed to initialize the canvas:', err);
      setEngineError(true);
    });

    return () => {
      destroyed = true;
      timeline.pause();
      cancelFilterWork();
      showFilterRefining(false);
      clearFilterPreview();
      setIsEngineReady(false);
      lastReplayedCanvasIdRef.current = null;
      isReplayingRef.current = false;
      replayedSeqRef.current = 0;
      if (vpSyncRaf) cancelAnimationFrame(vpSyncRaf);
      if (renderRaf) cancelAnimationFrame(renderRaf);
      renderRaf = 0;
      if (themeObserver) themeObserver.disconnect();
      requestRenderRef.current = () => pixiAppRef.current?.render();
      setPlaybackResolutionRef.current = () => {};
      syncDisplayResolution = null;
      unbindDprWatcher?.();
      unbindDprWatcher = null;
      if (resizeObserver) resizeObserver.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('scroll', invalidateContainerRect, true);
      container.removeEventListener('wheel', handleWheel);
      if (handleKeyDown) window.removeEventListener('keydown', handleKeyDown);
      if (handleKeyUp) window.removeEventListener('keyup', handleKeyUp);
      if (handleWindowBlur) window.removeEventListener('blur', handleWindowBlur);
      activeFlipKeyCode = null;
      animEngineRef.current?.endFlip();
      pointer.reset();
      brush.reset();
      container.style.cursor = '';
      if (pixiAppRef.current !== app) return;
      const pipeline = strokePipelineRef.current;
      const selection = selectionEngineRef.current;
      const layerManager = layerManagerRef.current;
      const viewport = viewportRef.current;
      const tileEngine = tileEngineRef.current;
      pixiAppRef.current = null;
      viewportRef.current = null;
      strokePipelineRef.current = null;
      selectionEngineRef.current = null;
      layerManagerRef.current = null;
      brushRendererRef.current = null;
      tileEngineRef.current = null;
      webglFilterEngineRef.current = null;
      vectorEngineRef.current = null;
      liquifyEngineRef.current = null;
      blurSmudgeEngineRef.current = null;
      shapeGraphicRef.current = null;
      if ((window as any).__debugPixi?.app === app) delete (window as any).__debugPixi;
      pipeline?.destroy();
      selection?.destroy();
      tileEngine?.destroy();
      layerManager?.destroy();
      viewport?.destroy();
      // The retired renderer owns its view, while Pixi assets can be in use by the next one.
      app.destroy({ removeView: true }, { children: true });
    };
    // Every engine (layers, tiles, selection, filters) is sized at init: a resize, ours or a
    // remote painter's (canvas_resized), rebuilds them and reloads the canvas like opening it
  }, [canvas?.id, canvas?.width, canvas?.height, engineAttempt]);

  useEffect(() => {
    transform.reset();
    setHasSelectionState(false);
    vector.resetForCanvas();
    setPermissionWarning(null);
    setIsRadialMenuOpen(false);
    resetThumbnails();
    shapes.cancel();
    liquify.cancel();
  }, [canvas?.id, canvas?.width, canvas?.height, engineAttempt]);

  // Sync Layers whenever layers list changes or engine becomes ready & Trigger Op Replay
  useEffect(() => {
    if (isEngineReady && layerManagerRef.current) {
      layerManagerRef.current.syncLayers(displayLayersRef.current);
      for (const l of layers) {
        refreshLayerThumbnail(l.id);
      }

      // Trigger Op Replay only after layers are fully initialized in layerManager
      if (canvas && layers.length > 0 && tileEngineRef.current && lastReplayedCanvasIdRef.current !== canvas.id) {
        lastReplayedCanvasIdRef.current = canvas.id;
        loadCheckpointAndReplay(canvas.id, layerManagerRef.current, tileEngineRef.current);
      }
    }
  }, [isEngineReady, layers, canvas?.id]);

  useEffect(() => {
    if (isEngineReady && layersLoaded && layers.length === 0 && !isReplayingRef.current) presentCanvas();
  }, [isEngineReady, layersLoaded, layers.length, presentCanvas]);

  // A personal-eye click (or opening / closing the timeline: onion skin) only changes what this viewer renders
  useEffect(() => {
    // Computed now: this render's displayLayersRef was made before animTimelineOpenRef caught up
    if (isEngineReady) layerManagerRef.current?.syncLayers(displayLayersFor(layersRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localVisibility, isEngineReady, isAnimationTimelineOpen]);

  /** A layer just created through onCreateLayer gets its textures on the next layer sync */
  const waitForLayerItem = async (layerId: string) => {
    for (let i = 0; i < 80; i++) {
      const item = layerManagerRef.current?.getLayerItem(layerId);
      if (item) return item;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  };

  // The active workspace supplies both the layer snapshot and its pending edits.
  useEffect(() => {
    if (onRegisterGetLayerCanvases && canvas) {
      const getLayerCanvases = async (): Promise<LayerCanvasItem[]> => {
        const results: LayerCanvasItem[] = [];
        // Parked layers come straight from their tiles: exporting never makes every layer resident at once
        const extract = (layerId: string) => {
          try {
            return layerManagerRef.current?.layerToCanvas(layerId) ?? undefined;
          } catch {
            return undefined;
          }
        };
        // An animation folder exports the frame on screen (personal eyes do not change exports)
        const shown = new Map(displayLayersFor(layers, { personal: false, time: animEngineRef.current?.getTime() ?? 0 }).map((l) => [l.id, l.isVisible]));
        for (const layer of layers) {
          if (layer.layerType === 'mask') continue;
          const maskLayer = layers.find((m) => m.layerType === 'mask' && m.parentId === layer.id);
          const maskCanvas = maskLayer ? extract(maskLayer.id) : undefined;
          const mask = maskLayer && maskCanvas ? { id: maskLayer.id, canvas: maskCanvas, enabled: maskLayer.isVisible, inverted: Boolean(maskLayer.meta?.maskInverted) } : undefined;
          let extractedCanvas: HTMLCanvasElement | null = extract(layer.id) ?? null;
          if (!extractedCanvas) {
            extractedCanvas = document.createElement('canvas');
            if (layer.layerType !== 'group') {
              extractedCanvas.width = canvas.width;
              extractedCanvas.height = canvas.height;
            }
          }
          const vectorStrokes = layer.layerType === 'vector' ? vectorEngineRef.current?.getStrokes(layer.id) : undefined;
          results.push({ layer: { ...layer, isVisible: shown.get(layer.id) ?? layer.isVisible }, canvas: extractedCanvas, mask, vectorStrokes });
        }
        return results;
      };

      onRegisterGetLayerCanvases({
        canvasId: canvas.id,
        ready: isCanvasPresented && isEngineReady,
        readLayers: getLayerCanvases,
        flushEdits: async () => {
          strokePipelineRef.current?.finishPendingRelease();
          await undoQueueRef.current;
          await brush.withHistory(() => new Promise<void>(whenToolCommitsDone));
        },
      });
      return () => onRegisterGetLayerCanvases(null);
    }
  }, [layers, canvas?.id, canvas?.width, canvas?.height, isCanvasPresented, isEngineReady, onRegisterGetLayerCanvases]);

  useEffect(() => {
    if (onRegisterBakeScreentone) {
      onRegisterBakeScreentone(handleBakeScreentone);
    }
  }, [onRegisterBakeScreentone]);

  // Sync Active Layer in pipeline; its before-state buffer must exist before any tool edits it
  useEffect(() => {
    strokePipelineRef.current?.setActiveLayer(activeLayer?.id || null);
    layerManagerRef.current?.setActiveLayer(activeLayer?.id ?? null); // stays resident while selected
    if (activeLayer) layerManagerRef.current?.ensurePingPong(activeLayer.id);
  }, [activeLayer?.id, isEngineReady]);

  // Handle Tool Selection
  const applyBrushProps = (next: BrushProperties) => {
    brushPropsRef.current = next;
    setBrushProps(next);
    const renderer = brushRendererRef.current;
    if (!renderer) return;
    renderer.setProperties(next);
    if (next.customBrushUrl) void renderer.setCustomBrushImage(next.customBrushUrl).catch(() => {});
    else renderer.clearCustomBrush();
  };

  const handleSelectTool = (tool: ToolType, preset?: BrushProperties) => {
    if (!applyingSubToolRef.current) {
      const sub = subToolStore.syncFromToolType(tool, { bucketMode, bucketReference });
      if (sub?.categoryId === 'fill' || sub?.categoryId === 'select') {
        applySubTool(sub, preset);
        return;
      }
    }
    if (activePluginToolRef.current) {
      pluginToolControllerRef.current.cancelStroke();
      setActivePluginToolKey(null);
    }
    const previousTool = currentToolRef.current;
    if (tool !== previousTool) {
      selection.cancelPolygonLasso();
      selection.cancelMarquee();
    }
    if (isBrushTool(previousTool)) saveBrushTool(previousTool, brushProps);
    if (transformLayerIdRef.current) cancelTransform();
    vector.onToolChange(tool);
    setCurrentTool(tool);
    currentToolRef.current = tool;
    if (tool !== previousTool) setSelectedBrushId(null);
    if (preset) {
      applyBrushProps(preset);
      return;
    }
    // Only the eraser erases: a stale flag made the vector pen erase on vector layers
    const currentBrushProps = brushPropsRef.current ?? brushProps;
    if (tool !== 'eraser' && currentBrushProps.isEraser && tool !== 'pencil' && tool !== 'brush') {
      const next = { ...currentBrushProps, isEraser: false };
      brushPropsRef.current = next;
      setBrushProps(next);
      brushRendererRef.current?.setProperties(next);
    }

    if (tool === 'transform') {
      // Like Ctrl+T: the handles appear at once instead of waiting for a click on the canvas
      startTransformMode('transform');
    } else if (isBrushTool(tool) && tool !== previousTool) {
      // The tool's own remembered settings (CSP sub-tools); preserve Transparent Color state across brush/pencil unless coming from eraser
      const keepTransparent = tool !== 'eraser' && previousTool !== 'eraser' && Boolean(brushProps.isEraser);
      applyBrushProps({ ...brushProps, ...loadBrushTool(tool), color: brushProps.color, ...(keepTransparent ? { isEraser: true } : {}) } as BrushProperties);
    } else if (tool === 'animation') {
      setIsAnimationTimelineOpen(true);
    }
  };

  // Brush Property changes
  const handleBrushPropsChange = (props: Partial<BrushProperties>) => {
    const next = { ...(brushPropsRef.current ?? brushProps), ...props };
    brushPropsRef.current = next;
    setBrushProps(next);
    brushRendererRef.current?.setProperties(next);
  };

  function applySubTool(sub: SubToolDef, preset?: BrushProperties) {
    const params = subToolStore.getSubToolParams(sub.id);
    applyingSubToolRef.current = true;
    try {
      if (params.bucketMode !== undefined) setBucketMode(params.bucketMode);
      if (params.bucketReference !== undefined) setBucketReference(params.bucketReference);
      if (params.bucketRefLayerId !== undefined || sub.id === 'fill_refer_other' || sub.id === 'fill_refer_edit') {
        setBucketRefLayerId(params.bucketRefLayerId ?? null);
      }
      if (params.bucketTolerance !== undefined) setBucketTolerance(params.bucketTolerance);
      if (params.bucketExpand !== undefined) setBucketExpand(params.bucketExpand);
      if (params.referenceLayerId !== undefined || sub.id === 'fill_enclose') setReferenceLayerId(params.referenceLayerId ?? null);
      if (params.gapClosingRadius !== undefined) setGapClosingRadius(params.gapClosingRadius);
      if (params.expandRadius !== undefined) setExpandRadius(params.expandRadius);
      if (sub.id === 'fill_lasso') {
        if (params.antialias !== undefined) handleBrushPropsChange({ antiAlias: params.antialias });
        if (params.outlineEnabled !== undefined) setLassoOutlineEnabled(params.outlineEnabled);
        setLassoFillErase(params.lassoErase ?? false);
      }
      if (sub.id === 'fill_paint_unfilled' && typeof params.brushSize === 'number' && Number.isFinite(params.brushSize)) {
        handleBrushPropsChange({ size: params.brushSize });
      }
      if (sub.categoryId === 'fill') setAppliedFillSubToolId(sub.id);
      if (sub.categoryId === 'select') {
        setSelectionMode(params.selectionMode ?? 'replace');
        setSelectionAntialias(params.selectionAntialias ?? true);
        setSelectionFeather(params.selectionFeather ?? 0);
        setWandTolerance(params.wandTolerance ?? 32);
        setWandContiguous(params.wandContiguous ?? true);
        if (typeof params.brushSize === 'number' && Number.isFinite(params.brushSize)) {
          handleBrushPropsChange({ size: params.brushSize });
        }
        setAppliedSelectionSubToolId(sub.id);
      }
      handleSelectTool(sub.tool, preset);
    } finally {
      applyingSubToolRef.current = false;
    }
  }

  const handleSelectCategory = (categoryId: ToolCategoryId) => applySubTool(subToolStore.selectCategory(categoryId));
  const handleSelectSubTool = (subToolId: SubToolId) => applySubTool(subToolStore.selectSubTool(subToolId));
  const handleCategoryShortcut = (categoryId: ToolCategoryId) => {
    if (activePluginToolRef.current) handleSelectCategory(categoryId);
    else applySubTool(subToolStore.activateCategoryShortcut(categoryId));
  };
  const handleResetSubTool = (subToolId: SubToolId) => {
    const sub = findSubTool(subToolId);
    if (!sub) return;
    subToolStore.resetSubToolParams(subToolId);
    applySubTool(sub);
  };

  const handleBucketReferenceChange = (reference: typeof bucketReference) => {
    if (currentTool !== 'bucket' || bucketMode !== 'click') {
      setBucketReference(reference);
      return;
    }
    const sub = subToolStore.syncFromToolType('bucket', { bucketMode, bucketReference: reference });
    if (!sub) return;
    subToolStore.updateSubToolParams(sub.id, { bucketReference: reference });
    applySubTool(sub);
  };

  useEffect(() => {
    if (!canvas?.id || !isEngineReady || restoredSubToolRef.current) return;
    restoredSubToolRef.current = true;
    const sub = findSubTool(subToolStore.getState().activeSubToolId);
    if (sub && sub.tool !== currentToolRef.current) applySubTool(sub);
  }, [canvas?.id, isEngineReady]);

  useEffect(() => {
    const id = subToolState.activeSubToolId;
    // The store can render its new selection before React commits the matching fill settings.
    if (applyingSubToolRef.current || id !== appliedFillSubToolId || id !== subToolStore.getState().activeSubToolId || findSubTool(id)?.tool !== currentTool) return;
    let params: SubToolParams;
    switch (id) {
      case 'fill_refer_other':
      case 'fill_refer_edit':
        if (bucketMode !== 'click') return;
        params = { bucketMode, bucketReference, bucketRefLayerId, bucketTolerance, bucketExpand };
        break;
      case 'fill_enclose':
        params = { referenceLayerId, gapClosingRadius, expandRadius };
        break;
      case 'fill_lasso':
        if (bucketMode !== 'lasso') return;
        params = { bucketMode, antialias: brushProps.antiAlias ?? 'medium', outlineEnabled: lassoOutlineEnabled, lassoErase: lassoFillErase };
        break;
      case 'fill_paint_unfilled':
        params = { brushSize: brushProps.size, bucketReference, bucketRefLayerId, bucketTolerance, gapClosingRadius, expandRadius };
        break;
      default:
        return;
    }
    const saved = subToolStore.getSubToolParams(id);
    if (Object.entries(params).some(([key, value]) => !Object.is(value, saved[key] ?? null))) {
      subToolStore.updateSubToolParams(id, params);
    }
  }, [subToolState.activeSubToolId, appliedFillSubToolId, currentTool, bucketMode, bucketReference, bucketRefLayerId, bucketTolerance, bucketExpand,
    referenceLayerId, gapClosingRadius, expandRadius, brushProps.antiAlias, lassoOutlineEnabled, lassoFillErase, brushProps.size]);

  useEffect(() => {
    const id = subToolState.activeSubToolId;
    if (id !== appliedSelectionSubToolId || id !== subToolStore.getState().activeSubToolId || currentTool !== id) return;
    const params: SubToolParams = { selectionMode, selectionAntialias, selectionFeather };
    if (id === 'magic_wand' || id === 'lasso') Object.assign(params, { wandTolerance, wandContiguous });
    if (id === 'select_brush' || id === 'select_eraser') params.brushSize = brushProps.size;
    const saved = subToolStore.getSubToolParams(id);
    if (Object.entries(params).some(([key, value]) => !Object.is(value, saved[key]))) {
      subToolStore.updateSubToolParams(id, params);
    }
  }, [subToolState.activeSubToolId, appliedSelectionSubToolId, currentTool, selectionMode, selectionAntialias, selectionFeather,
    wandTolerance, wandContiguous, brushProps.size]);

  const handleUploadCustomBrush = async (file: File) => {
    const renderer = brushRendererRef.current;
    if (!renderer) return;
    // A data URL (not a blob: URL) so the tip is remembered with the brush after a reload
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    await renderer.setCustomBrushImage(dataUrl);
    if (brushRendererRef.current === renderer) setBrushProps((prev) => ({ ...prev, customBrushUrl: dataUrl }));
  };
  // Remember the active brush tool's settings as they change
  useEffect(() => {
    if (isBrushTool(currentTool)) saveBrushTool(currentTool, brushProps);
  }, [brushProps, currentTool]);
  const resetBrushTool = () => {
    if (!isBrushTool(currentTool)) return;
    applyBrushProps({ ...brushProps, ...BRUSH_TOOL_DEFAULTS[currentTool], color: brushProps.color } as BrushProperties);
  };

  const handleClearCustomBrush = () => {
    if (brushRendererRef.current) {
      brushRendererRef.current.clearCustomBrush();
      setBrushProps(brushRendererRef.current.getProperties());
    }
  };

  const handleApplyPreset = (preset: AtelierBrushPreset) => {
    const tool = preset.properties.isEraser ? 'eraser' : preset.properties.brushType === 'pencil' ? 'pencil' : 'brush';
    handleSelectTool(tool, {
      ...BRUSH_TOOL_DEFAULTS[tool],
      ...preset.properties,
      spacing: preset.properties.spacing ?? MIN_BRUSH_SPACING,
      color: brushProps.color,
      secondaryColor: brushProps.secondaryColor,
      brushType: (preset.properties.brushType as BrushProperties['brushType']) || 'brush',
      pressureCurve: (preset.properties.pressureCurve as BrushProperties['pressureCurve']) || 'linear',
      paintAmount: preset.properties.paintAmount ?? 0.8,
      customBrushUrl: preset.tipDataUrl || null,
      customTextureUrl: preset.textureDataUrl ?? preset.properties.customTextureUrl ?? null,
      dualTipUrl: preset.dualTipDataUrl ?? preset.properties.dualTipUrl ?? null,
    });
    setSelectedBrushId(preset.id);
  };

  // Screentone Permanent Baking
  const handleBakeScreentone = (
    layerId: string,
    params: { density: number; angleRad: number; dotScale: number }
  ) => {
    if (!layerManagerRef.current || !webglFilterEngineRef.current || !activeLayer || !tileEngineRef.current) return;
    const item = layerManagerRef.current.getLayerItem(layerId);
    if (!item) return;

    const lm = layerManagerRef.current;
    const occupied = lm.occupiedTiles(layerId) ?? tileEngineRef.current.getAllTileCoords();
    const beforePromise = tilesAsync(lm, layerId, occupied);

    const result = webglFilterEngineRef.current.applyHalftone(
      item.renderTexture,
      params.density,
      params.angleRad,
      params.dotScale,
      selectionEngineRef.current?.getMaskArray()
    );
    lm.syncPingPong(layerId);

    commitInOrder(beforePromise, (beforeTiles) => {
      const opId = `op_screentone_bake_${Date.now()}`;
      scopedUndoRef.current.push({
        opId,
        userId: userRef.current?.id || user?.id || 'guest',
        layerId,
        opType: 'FILTER',
        beforeTiles,
        afterTiles: result.dirtyTiles,
        timestamp: Date.now(),
        desc: '烘焙漫畫網點 (Bake Screentone)',
      });
      updateUndoRedoState();
      commitTilePatch(layerId, result.dirtyTiles, false, '漫畫網點烘焙', true, beforeTiles);
    });
  };

  // Comic Panels & Speech Balloons Stamping onto Layer
  const handleBakeComicToLayer = (comicCanvas: HTMLCanvasElement) => {
    if (!activeLayer || !canEditPixels(activeLayer) || !layerManagerRef.current || !tileEngineRef.current || !pixiAppRef.current) {
      setPermissionWarning('請選取可編輯的圖層，再套用分鏡或對話氣泡。');
      setTimeout(() => setPermissionWarning(null), 3000);
      return false;
    }
    const item = layerManagerRef.current.getLayerItem(activeLayer.id);
    if (!item) return false;

    const texture = Texture.from(comicCanvas);
    const sprite = new Sprite(texture);

    const lm = layerManagerRef.current;
    const targetLayerId = activeLayer.id;
    const renderer = pixiAppRef.current.renderer;
    const dirtyCoords = tileEngineRef.current.getDirtyTilesForBounds(0, 0, comicCanvas.width, comicCanvas.height);
    const diff = diffTilesAsync(lm, targetLayerId, dirtyCoords, () => {
      renderer.render({
        container: sprite,
        target: item.renderTexture,
        clear: false,
      });
      sprite.destroy();
      texture.destroy(true);
      requestRenderRef.current();
    });
    lm.syncPingPong(targetLayerId);

    commitInOrder(diff, ({ beforeTiles, afterTiles }) => {
      if (afterTiles.length > 0) {
        const opId = `op_comic_${Date.now()}`;
        scopedUndoRef.current.push({
          opId,
          userId: userRef.current?.id || user?.id || 'guest',
          layerId: targetLayerId,
          opType: 'STROKE',
          beforeTiles,
          afterTiles,
          timestamp: Date.now(),
          desc: '漫畫分格 / 對話氣泡落實',
        });
        updateUndoRedoState();
      }
      commitTilePatch(targetLayerId, afterTiles, false, '漫畫分格 / 對話氣泡', true, beforeTiles);
    });
    handleSelectTool('brush');
    setPermissionWarning('✅ 漫畫分格與對話氣泡已成功落實至圖層！');
    setTimeout(() => setPermissionWarning(null), 2500);
    return true;
  };

  const clearFilterPreview = () => {
    filterSourceRef.current = null;
    const preview = filterPreviewRef.current;
    if (!preview) return;
    if (preview.kind === 'layer') {
      if (!preview.item.sprite.destroyed) preview.item.sprite.texture = preview.item.renderTexture;
    } else {
      layerManagerRef.current?.setFilterOverlay(null);
    }
    preview.texture.destroy(true);
    filterPreviewRef.current = null;
    requestRenderRef.current();
  };

  const cancelFilterWork = () => {
    filterRequestRef.current++;
    filterWorkerRef.current?.cancel();
    pluginFilterWorkerRef.current?.cancel();
  };

  /**
   * Turns the filter window's light sweep on (after a short wait, so a quick preview never flashes
   * it; already on, it stays on into the next preview) or off.
   */
  const showFilterRefining = (on: boolean) => {
    if (filterRefineTimerRef.current) clearTimeout(filterRefineTimerRef.current);
    filterRefineTimerRef.current = null;
    if (!on) {
      setFilterRefining(false);
      return;
    }
    filterRefineTimerRef.current = setTimeout(() => {
      filterRefineTimerRef.current = null;
      setFilterRefining(true);
    }, FILTER_REFINING_DELAY_MS);
  };

  const forgetFilterHistogram = () => {
    filterHistogramRef.current = null;
    setFilterHistogram(null);
  };

  const closeFilters = () => {
    cancelFilterWork();
    showFilterRefining(false);
    setFilterBusy(false);
    clearFilterPreview();
    filterPoint.clear();
    forgetFilterHistogram();
    setFilterMenuOpen(false);
    setIsColorCurvesOpen(false);
    setIsGradientMapOpen(false);
  };

  const chooseFilter = (id: string | null) => {
    const def = getFilter(id);
    if (def?.tool) {
      // Liquify and mesh warp are tools of their own: the menu only opens them
      closeFilters();
      if (def.tool === 'liquify') shortcutActionsRef.current.selectTool('liquify');
      else shortcutActionsRef.current.transform('mesh');
      return;
    }
    const layer = activeLayerRef.current;
    if (def && !filterApplyNewLayerRef.current && !filterFitsLayer(def, layer?.layerType)) {
      setPermissionWarning(t.filters.lineartNotOnMask);
      setTimeout(() => setPermissionWarning(null), 3000);
      return;
    }
    cancelFilterWork();
    showFilterRefining(false);
    setFilterBusy(false);
    clearFilterPreview();
    forgetFilterHistogram();
    if (filterPointParam(def)) startFilterPoint(filterApplyNewLayerRef.current ? null : (layer?.id ?? null));
    else filterPoint.clear();
    setLayerFilterId(def && !def.dialog ? def.id : null);
    setFilterMenuOpen(!def?.dialog);
    setIsColorCurvesOpen(def?.dialog === 'curves');
    setIsGradientMapOpen(def?.dialog === 'gradient');
  };

  /** Text and vector layers are redrawn from their text or strokes, which would wipe a filter out */
  const isRedrawnLayer = (layer: LayerModel | null | undefined) => layer?.layerType === 'text' || layer?.layerType === 'vector';

  const getFilterLayer = () => {
    const layer = activeLayerRef.current;
    if (!layer || isRedrawnLayer(layer) || !canEditPixels(layer) || !canvas || !isEngineReady || transformLayerIdRef.current) return null;
    return layerManagerRef.current?.getLayerItem(layer.id) ?? null;
  };

  /**
   * A filter's centre starts on the selection's middle, else on the middle of what the layer has
   * painted (read in the background; the canvas middle until it arrives, unless moved by then).
   */
  const startFilterPoint = (layerId: string | null) => {
    if (!canvas) return;
    const { width, height } = canvas;
    const sel = selectionEngineRef.current;
    const picked = sel?.hasSelection() ? (sel.getMaskData()?.bounds ?? sel.getSelection()?.bounds) : null;
    const frame = picked ? selectionFrame(picked) : null;
    const middle = (rect: { x: number; y: number; w: number; h: number }) => ({ x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) });
    const session = filterPoint.start(middle(frame ?? { x: 0, y: 0, w: width, h: height }), { width, height });
    const lm = layerManagerRef.current;
    const te = tileEngineRef.current;
    if (frame || !layerId || !lm || !te) return;
    readContent(lm, layerId, width, height, te.tileSize)
      .then((content) => { if (content) filterPoint.rehome(session, middle(content.rect)); })
      .catch(() => { /* the canvas middle stays */ });
  };

  const canCreateFilterLayer = Boolean(onCreateLayer && !isGuest && !isCanvasViewer && canvas && isEngineReady && !transformLayerIdRef.current);
  const filterCanvasSizeKey = canvas ? `${canvas.id}:${canvas.width}x${canvas.height}` : '';
  const filterMemoryPlan = useMemo(
    () => canvas
      ? assessFilterCompositeMemory(canvas.width, canvas.height, coarsePointer())
      : assessFilterCompositeMemory(0, 0, false),
    [canvas?.width, canvas?.height],
  );

  const openFilterUI = (id?: 'curves' | 'gradient') => {
    if (id) chooseFilter(id);
    else if (!filterMenuOpen) {
      setLayerFilterId(null);
      setFilterMenuOpen(true);
    }
  };

  const openFilterRef = useRef<(id?: 'curves' | 'gradient') => void>(() => {});
  openFilterRef.current = (id) => {
    if (getFilterLayer()) {
      setFilterApplyNewLayer(false);
      openFilterUI(id);
      return;
    }
    if (canCreateFilterLayer) {
      if (filterMemoryPlan.tier === 'block') {
        setPermissionWarning(t.filters.newLayerBlocked);
        setTimeout(() => setPermissionWarning(null), 3500);
        return;
      }
      if (filterMemoryPlan.tier === 'confirm' && filterMemoryConfirmedRef.current !== filterCanvasSizeKey) {
        setFilterMemoryConfirm({ openTo: id ?? 'menu' });
        return;
      }
      setFilterApplyNewLayer(true);
      openFilterUI(id);
      return;
    }
    setPermissionWarning(isRedrawnLayer(activeLayerRef.current) ? t.filters.needRaster : t.filters.needEditableLayer);
    setTimeout(() => setPermissionWarning(null), 3000);
  };
  function openFilterFromShortcut(id: 'curves' | 'gradient') { openFilterRef.current(id); }

  const handleToggleFilterNewLayer = (next: boolean) => {
    if (!next) {
      clearFilterPreview();
      forgetFilterHistogram();
      setFilterApplyNewLayer(false);
      return;
    }
    if (!canCreateFilterLayer || filterMemoryPlan.tier === 'block') {
      setPermissionWarning(t.filters.newLayerBlocked);
      setTimeout(() => setPermissionWarning(null), 3500);
      return;
    }
    if (filterMemoryPlan.tier === 'confirm' && filterMemoryConfirmedRef.current !== filterCanvasSizeKey) {
      setFilterMemoryConfirm({});
      return;
    }
    clearFilterPreview();
    forgetFilterHistogram();
    setFilterApplyNewLayer(true);
  };

  const handleToggleFilterIncludeBg = (next: boolean) => {
    clearFilterPreview();
    forgetFilterHistogram();
    setFilterIncludeBg(next);
  };

  const filterTargetOptions: FilterTargetOptions = {
    applyToNewLayer: filterApplyNewLayer,
    canApplyCurrent: Boolean(getFilterLayer()),
    canCreateNewLayer: canCreateFilterLayer,
    includeBackground: filterIncludeBg,
    memoryPlan: filterMemoryPlan,
    onToggleNewLayer: handleToggleFilterNewLayer,
    onToggleBackground: handleToggleFilterIncludeBg,
  };

  const runLayerFilter = async (filter: FilterJob | null, previewOnly: boolean): Promise<boolean> => {
    cancelFilterWork();
    if (!filter) { clearFilterPreview(); showFilterRefining(false); return true; }
    const request = filterRequestRef.current;
    const toNewLayer = filterApplyNewLayerRef.current;
    const includeBg = filterIncludeBgRef.current;
    const item = toNewLayer ? null : getFilterLayer();
    const engine = tileEngineRef.current;
    if ((!toNewLayer && !item) || !engine || !canvas) return false;
    if (toNewLayer && (!onCreateLayer || isGuest || isCanvasViewer || !isEngineReady || transformLayerIdRef.current)) return false;
    const { width, height } = canvas;
    const memoryPlan = toNewLayer ? assessFilterCompositeMemory(width, height, coarsePointer()) : null;
    if (toNewLayer && memoryPlan?.tier === 'block') return false;
    if (!previewOnly) {
      setFilterBusy(true);
      showFilterRefining(false);
    } else {
      showFilterRefining(true);
    }

    try {
      const lm = layerManagerRef.current;
      if (!lm) return false;
      const mask = selectionEngineRef.current?.getMaskArray();
      const cached = filterSourceRef.current;
      let sourceVersion: number | null = item ? item.version : null;
      let compVersion = '';
      let source: Uint8Array;
      if (toNewLayer) {
        compVersion = lm.getVisibleCompositeVersion();
        source = previewOnly && cached?.kind === 'composite' && cached.version === compVersion &&
          cached.includeBg === includeBg && cached.width === width && cached.height === height
          ? cached.pixels
          : await lm.readVisibleCompositeAsync(includeBg, Boolean(memoryPlan?.releaseCompositeAfterRead));
      } else {
        // Read without stalling the page (and without making a sparse layer one big texture). A preview
        // reuses the last preview's read while the layer's version shows nothing has changed it.
        source = previewOnly && cached?.kind === 'layer' && cached.item === item && cached.version === item!.version &&
          cached.width === width && cached.height === height
          ? cached.pixels
          : (await lm.readAsync(item!.model.id, [{ x: 0, y: 0, w: width, h: height }]))[0];
      }
      if (request !== filterRequestRef.current) return false;
      const def = getFilter(filter.id);
      const isPluginFilter = def?.source === 'plugin';
      let wantHistogram = !isPluginFilter && previewOnly && Boolean(def?.histogram) && !filterHistogramRef.current;
      // Line colour and gap filling can use the colour being painted with
      const values = { ...filter.values, currentColor: brushProps.color };
      const stale = () => request !== filterRequestRef.current || tileEngineRef.current !== engine ||
        filterApplyNewLayerRef.current !== toNewLayer ||
        (toNewLayer ? filterIncludeBgRef.current !== includeBg : (activeLayerRef.current?.id !== item!.model.id || getFilterLayer() !== item));
      const compute = async (draft: number) => {
        if (isPluginFilter && def) {
          const pluginClient = pluginFilterWorkerRef.current ??= new PluginFilterWorkerClient();
          const result = await pluginClient.run(def, new Uint8Array(source), width, height, values, mask, {
            draft,
            previewOnly,
            isTouch: coarsePointer(),
          });
          return result?.output ?? null;
        }
        const client = filterWorkerRef.current ??= new FilterWorkerClient();
        const result = await client.run(filter.id, new Uint8Array(source), width, height, values, mask, { histogram: wantHistogram, draft });
        if (result?.histogram && request === filterRequestRef.current) {
          wantHistogram = false;
          filterHistogramRef.current = result.histogram;
          setFilterHistogram(result.histogram);
        }
        return result?.output ?? null;
      };
      const showPreview = (filtered: Uint8Array) => {
        if (toNewLayer) {
          if (filterPreviewRef.current?.kind !== 'overlay') clearFilterPreview();
          const texture = filterPreviewRef.current?.texture ?? RenderTexture.create({ width, height, resolution: 1 });
          filterPreviewRef.current = { kind: 'overlay', texture };
          engine.writeRegion(texture, 0, 0, width, height, filtered);
          const placement = filterNewLayerPlacement(activeLayerRef.current, layersRef.current);
          lm.setFilterOverlay(texture, placement.overlayZIndex);
          filterSourceRef.current = { kind: 'composite', version: compVersion, includeBg, width, height, pixels: source };
          requestRenderRef.current();
          return;
        }
        if (filterPreviewRef.current?.kind !== 'layer' || filterPreviewRef.current.item !== item) clearFilterPreview();
        const texture = filterPreviewRef.current?.texture ?? RenderTexture.create({ width, height, resolution: 1 });
        filterPreviewRef.current = { kind: 'layer', item: item!, texture };
        engine.writeRegion(texture, 0, 0, width, height, filtered);
        // Unchanged since the read: the read stays good for the next preview (taking the texture
        // below counts as a possible change, so the version after it is the one kept)
        const unchanged = sourceVersion !== null && item!.version === sourceVersion;
        void item!.renderTexture; // resident while previewing: its one sprite shows the preview texture
        item!.sprite.texture = texture;
        // Once something else changed the layer, the read is never kept again
        sourceVersion = unchanged ? item!.version : null;
        filterSourceRef.current = unchanged ? { kind: 'layer', item: item!, version: item!.version, width, height, pixels: source } : null;
        requestRenderRef.current();
      };

      // A slow filter on a big layer: a draft from a shrunk copy first, then (unless the settings
      // change again meanwhile) the full preview, which also is what Apply computes
      let draft = previewOnly ? filterDraftFactor(def, width, height, coarsePointer()) : 0;
      if (previewOnly && toNewLayer && memoryPlan?.forceDraft && !draft && def?.draft) {
        draft = Math.max(2, Math.ceil(Math.sqrt((width * height) / 1_500_000)));
      }
      if (draft) {
        const quick = await compute(draft);
        if (!quick || stale()) return false;
        showPreview(quick);
        await new Promise((resolve) => setTimeout(resolve, FILTER_DRAFT_SETTLE_MS));
        if (stale()) return false;
      }
      const pixels = await compute(0);
      if (!pixels || stale()) return false;
      if (previewOnly) {
        showPreview(pixels);
        return true;
      }

      clearFilterPreview();
      if (mask !== selectionEngineRef.current?.getMaskArray()) return false;
      const bounds = selectionEngineRef.current?.getSelection()?.bounds;
      const coords = bounds && selectionEngineRef.current?.hasSelection()
        ? engine.getDirtyTilesForBounds(bounds.minX, bounds.minY, bounds.maxX + 1, bounds.maxY + 1)
        : engine.getAllTileCoords();
      const label = def ? filterLabel(def, t, language) : filter.id;

      if (toNewLayer) {
        const nonEmptyCoords = filterNonEmptyTileCoords(pixels, width, height, engine.tileSize, coords);
        const afterTiles = nonEmptyCoords.length
          ? await compressTiles(engine.extractMultipleTilesFromBuffer(pixels, nonEmptyCoords, 'raw'))
          : [];
        if (request !== filterRequestRef.current || layerManagerRef.current !== lm ||
          mask !== selectionEngineRef.current?.getMaskArray()) return false;
        const placement = filterNewLayerPlacement(activeLayerRef.current, layersRef.current);
        const baseName = activeLayerRef.current?.name;
        const newName = baseName ? `${baseName} · ${label}` : label;
        const created = await onCreateLayer!(newName, 'normal', 'raster', placement.afterLayerId, placement.parentId);
        if (!created || !(await waitForLayerItem(created.id))) return false;
        if (nonEmptyCoords.length) lm.writeRegion(created.id, 0, 0, width, height, pixels);
        recordLayerCreation(created, afterTiles, { desc: `${label} (${t.filters.newLayerBadge})` });
        if (afterTiles.length) commitTilePatch(created.id, afterTiles, false, label);
        return true;
      }

      const version = item!.version;
      const [latest] = await lm.readAsync(item!.model.id, [{ x: 0, y: 0, w: width, h: height }]);
      if (latest.some((value, index) => value !== source[index])) {
        setPermissionWarning(t.filters.layerChanged);
        setTimeout(() => setPermissionWarning(null), 3500);
        return false;
      }
      if (mask !== selectionEngineRef.current?.getMaskArray()) return false;
      if (!coords.length || !source.some((value, index) => value !== pixels[index])) return true;
      // Tiles cut from the buffers here, LZ4 in the workers (a whole 10000×8000 layer took seconds on this thread)
      const [beforeTiles, afterTiles] = await Promise.all([
        compressTiles(engine.extractMultipleTilesFromBuffer(source, coords, 'raw')),
        compressTiles(engine.extractMultipleTilesFromBuffer(pixels, coords, 'raw')),
      ]);
      if (request !== filterRequestRef.current || layerManagerRef.current !== lm || getFilterLayer() !== item ||
        mask !== selectionEngineRef.current?.getMaskArray()) return false;
      if (item!.version !== version) {
        setPermissionWarning(t.filters.layerChanged);
        setTimeout(() => setPermissionWarning(null), 3500);
        return false;
      }
      lm.writeRegion(item!.model.id, 0, 0, width, height, pixels);
      scopedUndoRef.current.push({
        opId: `op_filter_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        userId: userRef.current?.id || user?.id || 'guest',
        layerId: item!.model.id,
        opType: 'FILTER',
        beforeTiles,
        afterTiles,
        timestamp: Date.now(),
        desc: label,
      });
      updateUndoRedoState();
      commitTilePatch(item!.model.id, afterTiles, false, label);
      return true;
    } catch (error) {
      if (request !== filterRequestRef.current) return false;
      clearFilterPreview();
      console.error('[CanvasWorkspace] Layer filter failed:', error);
      setPermissionWarning(t.filters.failed);
      return false;
    } finally {
      if (request === filterRequestRef.current) {
        if (previewOnly) showFilterRefining(false);
        else setFilterBusy(false);
      }
    }
  };

  useEffect(() => () => {
    filterWorkerRef.current?.dispose();
    pluginFilterWorkerRef.current?.dispose();
  }, []);

  const filterRunnerRef = useRef(runLayerFilter);
  filterRunnerRef.current = runLayerFilter;
  const startFilterPointRef = useRef(startFilterPoint);
  startFilterPointRef.current = startFilterPoint;
  const [filterCallbacks] = useState(() => ({
    curves: (options: ColorCurvesOptions | null) => filterRunnerRef.current(options ? { id: 'curves', values: { options } } : null, true),
    gradient: (stops: GradientStop[] | null, opacity: number) =>
      filterRunnerRef.current(stops ? { id: 'gradient', values: { stops, opacity } } : null, true),
    parameters: (values: FilterValues | null) => {
      // A preview timer that fires while the window fades out must not start a new preview
      const id = filterIdRef.current;
      if (id) filterRunnerRef.current(values ? { id, values } : null, true);
    },
    libraryPreview: (job: FilterJob | null) => {
      if (!filterMenuOpenRef.current && job) return;
      void filterRunnerRef.current(job, true);
    },
    readThumbnail: () => {
      const lm = layerManagerRef.current;
      if (!lm) return Promise.resolve(null);
      const layerId = filterApplyNewLayerRef.current ? null : (activeLayerRef.current?.id ?? null);
      return lm.readFilterThumbnailPixels(layerId, filterApplyNewLayerRef.current ? filterIncludeBgRef.current : false, 96);
    },
    startPoint: (id: string | null) => {
      if (!id) { filterPoint.clear(); return; }
      startFilterPointRef.current(filterApplyNewLayerRef.current ? null : (activeLayerRef.current?.id ?? null));
    },
  }));

  useEffect(() => {
    closeFilters();
    if (transformLayerIdRef.current && transformLayerIdRef.current !== activeLayer?.id) cancelTransform();
  }, [activeLayer?.id, canvas?.id]);

  // Pixels other painters touched after my ops: changed bytes, plus their brush footprint (paint in
  // exactly my colour changes no bytes but is still theirs). Marked on the ops that were in my
  // history when their edit arrived, never on later ones: one mask per tile for the whole history
  // also blocked the undo of my newer ops there (an 8K gradient's undo left the gradient inside a
  // stroke the other painter had drawn minutes before).
  const foreignReadsRef = useRef(new Set<Promise<void>>());
  /** ORs one tile's mark (1 = theirs) into each op's foreign mask */
  const addForeign = (ops: ScopedUndoOp[], key: string, mark: Uint8Array) => {
    for (const op of ops) {
      const foreign = op.foreign ?? (op.foreign = new Map());
      const mask = foreign.get(key);
      if (!mask || mask.length !== mark.length) {
        foreign.set(key, mark.slice());
        continue;
      }
      for (let i = 0; i < mark.length; i++) if (mark[i]) mask[i] = 1;
    }
  };
  const markForeignFootprint = (layerId: string, payload: any) => {
    const te = tileEngineRef.current;
    const pts = (Array.isArray(payload?.allPoints) && payload.allPoints.length > 0
      ? payload.allPoints
      : payload?.samplePoints) as Array<{ x: number; y: number; pressure?: number }> | undefined;
    if (!te || !pts?.length || !payload?.size) return;
    const ink = typeof payload.color === 'string' ? hexToRgb(payload.color) : null;
    const tiles = Array.isArray(payload.tiles) ? payload.tiles as TileData[] : undefined;
    const coords = tiles ?? te.getDirtyTilesForPoints(pts, payload.size / 2 + 2);
    const tracked = coords
      .filter(Boolean)
      .map((t) => ({ t, ops: scopedUndoRef.current.opsTouchingTile(layerId, t.col, t.row) }))
      .filter((x) => x.ops.length > 0);
    if (!tracked.length) return;
    const rMax = payload.size / 2 + 1;
    for (const { t, ops } of tracked) {
      const b = getTileBounds(t.col, t.row, te.tileSize, te.canvasWidth, te.canvasHeight);
      const tile = 'data' in t ? t as TileData : undefined;
      const pixels = tile && tileToRgba({ ...tile, data: te.normalizeTileData(tile.data) });
      const mask = new Uint8Array(b.width * b.height);
      if (tiles && pixels?.length !== mask.length * 4) continue;
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k];
        const z = pts[k + 1] ?? a;
        if (
          Math.max(a.x, z.x) + rMax < b.x ||
          Math.min(a.x, z.x) - rMax > b.x + b.width ||
          Math.max(a.y, z.y) + rMax < b.y ||
          Math.min(a.y, z.y) - rMax > b.y + b.height
        ) continue;
        const steps = Math.max(1, Math.ceil(Math.hypot(z.x - a.x, z.y - a.y) / 2));
        for (let s = 0; s <= steps; s++) {
          const cx = a.x + ((z.x - a.x) * s) / steps - b.x;
          const cy = a.y + ((z.y - a.y) * s) / steps - b.y;
          const r = (payload.size * Math.max(0.3, a.pressure ?? 1)) / 2 + 1;
          for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(b.height - 1, Math.ceil(cy + r)); y++) {
            for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(b.width - 1, Math.ceil(cx + r)); x++) {
            if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
            const index = y * b.width + x;
            if (mask[index]) continue;
            if (pixels) {
              const i = index * 4;
              const alpha = pixels[i + 3];
              // Tile diffs track changed pixels. The footprint only needs to protect identical ink.
              if (payload.isEraser ? alpha !== 0 : !ink || alpha === 0 ||
                Math.abs(pixels[i] - ink.r * alpha / 255) > 1 ||
                Math.abs(pixels[i + 1] - ink.g * alpha / 255) > 1 ||
                Math.abs(pixels[i + 2] - ink.b * alpha / 255) > 1) continue;
            }
            mask[index] = 1;
            }
          }
        }
      }
      addForeign(ops, `${t.col}_${t.row}`, mask);
    }
  };
  const markForeignPixels = (
    layerId: string, payload: any, edit: ReturnType<ScopedUndoManager['foreignEdit']>,
    baseTiles: Map<string, TileData>, predecoded?: WeakMap<TileData, Uint8Array | null>,
  ) => {
    const te = tileEngineRef.current;
    const lm = layerManagerRef.current;
    if (!te || !lm || !Array.isArray(payload?.tiles)) return;
    // The ops are taken now (the edit arrived now), the marks land when the baseline read does
    const history = scopedUndoRef.current;
    const opsByTile = new Map<string, ScopedUndoOp[]>();
    const tracked = (payload.tiles as TileData[]).filter((t) => {
      if (!t) return false;
      const ops = history.opsTouchingTile(layerId, t.col, t.row).filter(op =>
        (!edit.seq || op.baseSeq === undefined || op.baseSeq < edit.seq) &&
        (op.seq === undefined || !edit.seq || op.seq < edit.seq));
      if (ops.length) opsByTile.set(`${t.col}_${t.row}`, ops);
      return ops.length > 0;
    });
    if (!tracked.length) return;
    // Where a tile already had local commits unseen by the remote sender, compare against the
    // common baseline (`baseTiles`) instead of `current`, so our own concurrent strokes are never
    // flagged as foreign pixels (which used to block our Ctrl+Z).
    const needRead = tracked.filter((t) => !baseTiles.has(`${t.col}_${t.row}`));
    const inkTiles = new Map<string, TileData>();
    if (Array.isArray(payload.inkTiles)) {
      for (const t of payload.inkTiles as TileData[]) {
        if (t) inkTiles.set(`${t.col}_${t.row}`, t);
      }
    }
    const pending = (needRead.length ? lm.readTilesAsync(layerId, needRead) : Promise.resolve([] as TileData[])).then(async (prior) => {
      if (layerManagerRef.current !== lm) return;
      let readIdx = 0;
      const normalize = (tile: TileData) => ({ ...tile, data: te.normalizeTileData(tile.data) });
      await Promise.all(tracked.map(async (t) => {
        const tileKey = `${t.col}_${t.row}`;
        const baselineTile = baseTiles.get(tileKey) ?? prior[readIdx++];
        if (!baselineTile) return;
        const b = getTileBounds(t.col, t.row, te.tileSize, te.canvasWidth, te.canvasHeight);
        if (t.width !== b.width || t.height !== b.height) return;
        const mask = new Uint8Array(b.width * b.height);
        const current = tileToRgba(baselineTile);
        const after = normalize(t);
        const incoming = predecoded?.get(t) ?? tileToRgba(after);
        if (incoming.length !== mask.length * 4 || current.length !== incoming.length) return;
        let any = false;
        for (let i = 0, j = 0; j < mask.length; i += 4, j++) {
          if (current[i] !== incoming[i] || current[i + 1] !== incoming[i + 1] || current[i + 2] !== incoming[i + 2] || current[i + 3] !== incoming[i + 3]) {
            mask[j] = 1;
            any = true;
          }
        }
        const source = inkTiles.get(tileKey);
        const ink = source && source.width === b.width && source.height === b.height &&
          (source.compression === 'raw' || source.compression === 'lz4') ? normalize(source) : undefined;
        const ops = opsByTile.get(tileKey) ?? [];
        if (ink && tileToRgba(ink).length === incoming.length) {
          const before = baselineTile.compression === 'raw'
            ? (await compressTiles([baselineTile]))[0]
            : baselineTile;
          history.recordForeignTile(ops, tileKey, { edit, changed: mask, ink: { source: ink, before, after } });
        } else if (any) {
          history.recordForeignTile(ops, tileKey, { edit, changed: mask });
        }
      }));
    }).catch((error) => console.warn('[undo] Failed to read remote tile baseline:', error));
    foreignReadsRef.current.add(pending);
    void pending.finally(() => foreignReadsRef.current.delete(pending));
  };

  /**
   * Undo / redo on a shared layer: only pixels still as this op left them go back; pixels another
   * painter changed since are kept. Returns the tiles to apply and send.
   */
  const mergeForUndo = async (
    op: ScopedUndoOp,
    target: TileData[],
    mine: TileData[],
    apply: (tiles: TileData[], conflicts: number, before: TileData[], historyTiles: NonNullable<TilePatchPacket['historyTiles']>, decoded?: WeakMap<TileData, Uint8Array | null>) => void,
  ) => {
    const { layerId } = op;
    const lm = layerManagerRef.current;
    const item = lm?.getLayerItem(layerId);
    if (!lm || !item) return;
    if (OfflineSessionStore.isOfflineCanvas(canvas?.id)) {
      const compressed = target.filter((tile) => tile.compression === 'lz4');
      let decoded: WeakMap<TileData, Uint8Array | null> | undefined;
      if (compressed.length >= 16) {
        const pixels = await decodeTiles(compressed.map((tile) => ({
          data: tile.data as Uint8Array, compression: 'lz4', w: tile.width, h: tile.height,
        })));
        if (layerManagerRef.current !== lm || lm.getLayerItem(layerId) !== item) return;
        decoded = new WeakMap(compressed.map((tile, i) => [tile, pixels[i]]));
      }
      apply(target, 0, [], [], decoded);
      return;
    }
    while (layerManagerRef.current === lm && lm.getLayerItem(layerId) === item) {
      const mineByTile = new Map(mine.map((t) => [`${t.col}_${t.row}`, t]));
      const valid = target.filter((t) => {
        if (!t || t.width <= 0 || t.height <= 0) return false;
        const own = mineByTile.get(`${t.col}_${t.row}`);
        return own?.width === t.width && own.height === t.height;
      });
      const version = item.version;
      await Promise.all(foreignReadsRef.current);
      if (item.version !== version) continue;
      const untouched: TileData[] = [];
      const untouchedBefore: TileData[] = [];
      const needRead = valid.filter((tile) => {
        if (op.opType !== 'FILL') return true;
        const key = `${tile.col}_${tile.row}`;
        const own = mineByTile.get(key)!;
        if (op.foreign?.has(key) || scopedUndoRef.current.hasForeignTile(op, key) || !lm.matchesCachedTile(layerId, own)) return true;
        untouched.push(tile);
        untouchedBefore.push(own);
        return false;
      });
      const current = needRead.length ? await lm.readTilesAsync(layerId, needRead) : [];
      await Promise.all(foreignReadsRef.current);
      if (layerManagerRef.current !== lm || lm.getLayerItem(layerId) !== item) return;
      if (item.version !== version) continue;
      let conflicts = 0;
      const raw: TileData[] = [];
      const historyTiles: NonNullable<TilePatchPacket['historyTiles']> = [];
      needRead.forEach((t, index) => {
        const key = `${t.col}_${t.row}`;
        const own = mineByTile.get(key)!;
        const history = scopedUndoRef.current;
        const merged = history.mergeForeignTile(op, key, tileToRgba(t), tileToRgba(own), tileToRgba(current[index]));
        conflicts += merged.conflicts;
        if (merged.conflicts > 0 || history.hasForeignTile(op, key)) historyTiles.push({ from: own, to: t });
        raw.push({ ...t, compression: 'raw', data: merged.pixels, byteLength: merged.pixels.byteLength });
      });
      const tiles = raw.length ? await compressTiles(raw) : [];
      if (layerManagerRef.current !== lm || lm.getLayerItem(layerId) !== item) return;
      if (item.version !== version) continue;
      apply(untouched.concat(tiles), conflicts, untouchedBefore.concat(current), historyTiles);
      return;
    }
  };
  const warnUndoConflicts = (conflicts: number) => {
    if (conflicts > 0) warn(`其他畫師之後也畫到同一處：保留了他們的 ${conflicts} 個像素，只復原你自己的部分。`, 4000);
  };
  /** Undo on an animation frame shows that frame, so the change is not invisible */
  const showFrameOf = (layerId: string) => {
    const engine = animEngineRef.current;
    const cel = engine ? celOfLayer(layersRef.current, layerId) : null;
    if (!engine || !cel) return;
    const entries = celEntriesOf(layersRef.current, cel.folderId);
    if (celLayerOf(entries[entryIndexAt(entries, engine.getTime())]) === cel.celId) return;
    const i = entries.findIndex((e) => e.id === cel.celId);
    if (i >= 0) engine.goTo(entryStart(entries, i));
  };

  const usedTilesOnly = (tiles: TileData[]) => tiles.filter((t) => t.width > 0 && ((t.data as Uint8Array).byteLength > 2048 || tileToRgba(t).some((b) => b !== 0)));
  const snapshotLayerContent = async (l: LayerModel) => {
    const ls = layersRef.current;
    const lm = layerManagerRef.current!;
    const te = tileEngineRef.current!;
    const coords = te.getAllTileCoords();
    const item = lm.getLayerItem(l.id);
    const mask = ls.find((m) => m.layerType === 'mask' && m.parentId === l.id);
    const maskItem = mask && lm.getLayerItem(mask.id);
    const tiles = item ? tilesAsync(lm, l.id, lm.occupiedTiles(l.id) ?? coords) : Promise.resolve([]);
    const maskTiles = mask && maskItem ? tilesAsync(lm, mask.id, lm.occupiedTiles(mask.id) ?? coords) : null;
    const strokes = l.layerType === 'vector' ? vectorEngineRef.current?.getStrokes(l.id).map((s) => ({ ...s })) : undefined;
    return {
      model: l,
      tiles: usedTilesOnly(await tiles),
      mask: mask && maskTiles ? { model: mask, tiles: usedTilesOnly(await maskTiles) } : undefined,
      strokes,
    };
  };

  // Layers that undo took away (a new text layer) can be redone although they no longer exist
  const undoneLayerIdsRef = useRef(new Set<string>());
  /**
   * Puts a layer back as it was (props, pixels, mask, vectors); its undo history follows the new id.
   * Placed right above `aboveId`, or with `place.under` right below that layer, else where its old
   * sort order says; `place.parentId` overrides the group it goes into.
   */
  const recreateLayer = async (
    model: LayerModel,
    tiles: TileData[],
    mask?: { model: LayerModel; tiles: TileData[] },
    aboveId?: string,
    strokes?: VectorStroke[],
    place?: { under?: string; parentId?: string | null }
  ) => {
    const te = tileEngineRef.current;
    const lm = layerManagerRef.current;
    const belowId = place?.under ? null : aboveId !== undefined ? aboveId : model.layerType === 'mask' ? model.parentId : findLayerBelow(model);
    const aboveSibling =
      aboveId === undefined && !place?.under && model.layerType !== 'mask' && !belowId
        ? [...layersRef.current].filter((l) => l.sortOrder > model.sortOrder && l.layerType !== 'mask').sort((a, b) => a.sortOrder - b.sortOrder)[0]
        : undefined;
    const parentId = place && place.parentId !== undefined ? place.parentId : model.parentId;
    const created = await onCreateLayer?.(model.name, model.blendMode, model.layerType, belowId, parentId, {
      meta: model.meta ?? null,
      select: false,
      ...(place?.under ? { belowLayerId: place.under } : {}),
    });
    if (!created || !te) return null;
    const item = await waitForLayerItem(created.id);
    if (aboveSibling && layersRef.current.some((l) => l.id === aboveSibling.id)) {
      const asc = [...layersRef.current].sort((a, b) => a.sortOrder - b.sortOrder).map((l) => l.id).filter((id) => id !== created.id);
      const idx = asc.indexOf(aboveSibling.id);
      if (idx >= 0) {
        asc.splice(idx, 0, created.id);
        await onReorderLayer?.(created.id, 0, asc);
      }
    }
    if (item) {
      if (strokes?.length) {
        const mapped = strokes.map((s) => ({ ...s, layerId: created.id }));
        const payload = { tiles, vectorRemovedIds: [], vectorAdded: mapped };
        if (tiles.length) lm?.applyTiles(created.id, tiles);
        applyVectorPayload(created.id, payload);
        commitOp(created.id, 'VECTOR_EDIT', payload);
      } else if (tiles.length) {
        lm?.applyTiles(created.id, tiles);
        commitTilePatch(created.id, tiles, false, model.layerType === 'mask' ? '復原：蒙版回來了' : '復原：圖層回來了');
      }
      if (!tiles.length) refreshLayerThumbnail(created.id);
      lm?.syncPingPong(created.id);
    }
    const props: Partial<LayerModel> = {};
    for (const k of ['opacity', 'isVisible', 'clipToBelow', 'alphaLocked', 'isLocked', 'isPublic', 'aclMode', 'screentoneEnabled', 'screentoneLpi', 'screentoneAngle', 'screentoneDotScale'] as const) {
      if (created[k] !== model[k]) (props as any)[k] = model[k];
    }
    if (Object.keys(props).length) await onUpdateLayerProps?.(created.id, props);
    if (mask) {
      const m = await onCreateLayer?.(mask.model.name, 'normal', 'mask', created.id, created.id, { meta: mask.model.meta ?? null, select: false });
      const mItem = m && (await waitForLayerItem(m.id));
      if (m && mItem) {
        if (mask.tiles.length) {
          lm?.applyTiles(m.id, mask.tiles);
          commitTilePatch(m.id, mask.tiles, false, '復原：蒙版回來了');
        } else {
          refreshLayerThumbnail(m.id);
        }
        lm?.syncPingPong(m.id);
        if (!mask.model.isVisible) await onUpdateLayerProps?.(m.id, { isVisible: false });
        scopedUndoRef.current.remapLayer(mask.model.id, m.id);
      }
    }
    scopedUndoRef.current.remapLayer(model.id, created.id);
    return created;
  };
  /**
   * Undo of a deletion: the layer comes back between the layers that were below / above it; a group
   * comes back with everything that was inside it, in its order. Repeated animation cels that
   * pointed at a layer that came back point at it again.
   */
  const restoreRemovedLayer = async (removed: RemovedLayer & { below?: string | null; above?: string | null }) => {
    const idMap = new Map<string, string>();
    const repeats: Array<{ id: string; meta: any }> = [];
    const exists = (id?: string | null): id is string => Boolean(id && layersRef.current.some((l) => l.id === id));
    const restore = async (r: RemovedLayer, onTopOf: string | undefined, under: string | undefined, parentId: string | null | undefined): Promise<LayerModel | null> => {
      // recreateLayer moves the history (this snapshot too) to the new id: keep the old one
      const oldId = r.model.id;
      const meta = r.model.meta;
      const created = await recreateLayer(r.model, r.tiles, r.mask, onTopOf, r.strokes, { under, parentId });
      if (!created) return null;
      idMap.set(oldId, created.id);
      if (meta?.cel?.ref) repeats.push({ id: created.id, meta });
      // The bottom child goes right under the group, every next one right above the one before
      let prev: string | null = null;
      for (const child of r.children ?? []) {
        const c = await restore(child, prev ?? undefined, prev ? undefined : created.id, created.id);
        if (c) prev = c.id;
      }
      return created;
    };
    const created = exists(removed.below)
      ? await restore(removed, removed.below, undefined, undefined)
      : await restore(removed, undefined, exists(removed.above) ? removed.above : undefined, undefined);
    // Repeats that came back with it (their meta is known here, the layer list may not have caught up)
    const relinked = new Set<string>();
    for (const { id, meta } of repeats) {
      const to = idMap.get(meta.cel.ref);
      relinked.add(id);
      if (to && to !== meta.cel.ref) await onUpdateLayerProps?.(id, { meta: { ...meta, cel: { ...meta.cel, ref: to } } });
    }
    // Repeats elsewhere (a single cel deleted and brought back)
    for (const l of layersRef.current) {
      const ref = l.meta?.cel?.ref;
      if (ref && idMap.has(ref) && !relinked.has(l.id) && canManageLayer(l)) await onUpdateLayerProps?.(l.id, { meta: { ...l.meta, cel: { ...l.meta?.cel, ref: idMap.get(ref) } } });
    }
    return created;
  };
  /** A layer as undo needs it; a group with everything inside it (bottom first) */
  const snapshotLayerTree = async (l: LayerModel, depth = 0): Promise<RemovedLayer> => {
    const base = await snapshotLayerContent(l);
    if (l.layerType !== 'group' || depth > 16) return base;
    const inside = layersRef.current.filter((c) => c.parentId === l.id && c.layerType !== 'mask').sort((a, b) => a.sortOrder - b.sortOrder);
    return { ...base, children: await Promise.all(inside.map((c) => snapshotLayerTree(c, depth + 1))) };
  };
  /** The layer that sat right below this one (it goes back above that one) */
  const findLayerBelow = (model: LayerModel) =>
    [...layersRef.current].filter((l) => l.sortOrder < model.sortOrder && l.layerType !== 'mask').sort((a, b) => b.sortOrder - a.sortOrder)[0]?.id ?? null;

  // Personal Scoped Undo. A stroke whose tiles are still compressing is not in the history yet:
  // undo / redo wait for it (otherwise they would undo the stroke before it)
  // Brush strokes and the other tools' edits commit off the main thread: undo waits for both
  const undoQueueRef = useRef(Promise.resolve());
  const queueHistoryAction = (action: () => Promise<void>) => {
    const lm = layerManagerRef.current;
    undoQueueRef.current = undoQueueRef.current.then(() => brush.withHistory(async () => {
      await new Promise<void>(whenToolCommitsDone);
      if (layerManagerRef.current === lm) await action();
    })).catch((error) => console.warn('[undo] Could not apply history action:', error));
  };
  const handleScopedUndo = () => queueHistoryAction(undoNow);
  const handleScopedRedo = () => queueHistoryAction(redoNow);
  const deleteLayerWithUndo = (layerId: string) =>
    new Promise<void>((resolve) => {
      queueHistoryAction(async () => {
        try {
          const target = layersRef.current.find((l) => l.id === layerId);
          if (!target) return;
          const isOwner = user?.id === target.ownerId;
          /** Layers inside a deleted group that were not this painter's to delete stay, moved up out of it */
          const tellLifted = (result: unknown) => {
            const lifted = (result as DeletedLayers | undefined)?.lifted?.length ?? 0;
            if (lifted) warn(`圖層組裡有 ${lifted} 個別人的（或鎖定的）圖層沒有刪除，已移到圖層組外面。`, 4000);
          };
          if (isGuest || (!isOwner && !isAdmin) || !layerManagerRef.current || !tileEngineRef.current) {
            tellLifted(await onDeleteLayer?.(layerId));
            return;
          }
          // Where it sat, and (a group) everything inside it: undo puts all of it back
          const flat = layersRef.current.filter((l) => l.layerType !== 'mask').sort((a, b) => a.sortOrder - b.sortOrder);
          const removed = await snapshotLayerTree(target);
          if (!layersRef.current.some((l) => l.id === layerId)) return;
          const result = await onDeleteLayer?.(layerId);
          if (result === false) return;
          tellLifted(result);
          const gone = new Set(result && typeof result === 'object' ? result.deleted : [layerId]);
          const onlyGone = (r: RemovedLayer): RemovedLayer => ({ ...r, children: r.children?.filter((c) => gone.has(c.model.id)).map(onlyGone) });
          const at = flat.flatMap((l, i) => (gone.has(l.id) ? [i] : []));
          const inside = gone.size - 1;
          scopedUndoRef.current.push({
            opId: `op_del_layer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            userId: userRef.current?.id || user?.id || 'guest',
            layerId: target.id,
            opType: 'LAYER_DELETE',
            beforeTiles: [],
            afterTiles: [],
            timestamp: Date.now(),
            desc: inside > 0 ? `刪除圖層組「${target.name}」（含 ${inside} 個圖層）` : `刪除圖層「${target.name}」`,
            layerRemoved: {
              ...onlyGone(removed),
              below: at.length ? flat[at[0] - 1]?.id ?? null : null,
              above: at.length ? flat[at[at.length - 1] + 1]?.id ?? null : null,
            },
          });
          updateUndoRedoState();
        } finally {
          resolve();
        }
      });
    });
  const undoNow = async () => {
    const effectiveUserId = userRef.current?.id || user?.id || 'guest';
    const ops = scopedUndoRef.current.undoGroup(effectiveUserId, (layerId, candidate) => {
      if (
        candidate?.selectionBefore !== undefined &&
        !candidate.beforeTiles.length &&
        !candidate.afterTiles.length &&
        !candidate.layerCreated &&
        !candidate.layerRemoved
      ) {
        return true;
      }
      const target = layersRef.current.find((l) => l.id === layerId) ?? candidate?.layerRemoved?.model ?? candidate?.layerCreated?.model;
      return Boolean(target && (target.ownerId === effectiveUserId || (candidate?.layerCreated && isAdmin) || canEditPixels(target)));
    });

    let totalConflicts = 0;
    const undoSingleOp = async (op: ScopedUndoOp) => {
      if (op.selectionBefore !== undefined) {
        selectionEngineRef.current?.restoreSnapshot(op.selectionBefore);
        selection.refreshSelection();
      }

      // Undo of a new layer (text / pasted / mask too): the layer goes away (redo makes it again).
      // A new group that layers were put into since: only the group goes, its layers stay
      if (op.layerCreated) {
        const live = layersRef.current.find((layer) => layer.id === op.layerId);
        const deleted = await onDeleteLayer?.(op.layerId, { keepContents: true });
        if (deleted === false) scopedUndoRef.current.rollbackGroup([op], true);
        else {
          if (live) op.layerCreated.model = live;
          undoneLayerIdsRef.current.add(op.layerId);
        }
        return;
      }

      // Undo of a deleted layer: bring it back with its pixels, properties, mask and vector strokes
      // (a group with everything that was inside it)
      if (op.opType === 'LAYER_DELETE' && op.layerRemoved) {
        const created = await restoreRemovedLayer(op.layerRemoved);
        if (created) onSelectLayer?.(created.id);
        return;
      }

      if (
        op.metaBefore !== undefined &&
        op.beforeTiles.length === 0 &&
        op.afterTiles.length === 0 &&
        !op.layerRemoved &&
        !op.vectorStroke &&
        !op.vectorRemovedStrokes &&
        !op.vectorAddedStrokes
      ) {
        onUpdateLayerProps?.(op.layerId, { meta: op.metaBefore });
        return;
      }

      const hasPixelOrMeta = Boolean(
        op.beforeTiles.length > 0 ||
        op.afterTiles.length > 0 ||
        op.layerRemoved ||
        op.vectorStroke ||
        op.vectorRemovedStrokes ||
        op.vectorAddedStrokes ||
        op.metaBefore !== undefined
      );

      if (hasPixelOrMeta && layerManagerRef.current && tileEngineRef.current) {
        // Undo of a merge down: the merged layer comes back on top of the one it went into
        if (op.layerRemoved) {
          const removed = op.layerRemoved;
          await recreateLayer(removed.model, removed.tiles, removed.mask, op.layerId, removed.strokes);
        }
        const layerItem = layerManagerRef.current.getLayerItem(op.layerId);
        if (layerItem) {
          showFrameOf(op.layerId);
          const lm = layerManagerRef.current;
          await mergeForUndo(op, op.beforeTiles, op.afterTiles, (undoTiles, conflicts, before, historyTiles, decoded) => {
            totalConflicts += conflicts;
            if (op.metaBefore !== undefined) onUpdateLayerProps?.(op.layerId, { meta: op.metaBefore });
            // Restore reverse diff tiles locally
            lm.applyTiles(op.layerId, undoTiles, undefined, decoded);

            // Vector ops also carry their stroke-list change, reversed here and sent along, so other
            // painters and the next reload agree on which strokes exist
            const vectorOp = op.vectorStroke || op.vectorRemovedStrokes || op.vectorAddedStrokes;
            if (vectorOp) {
              const payload = {
                tiles: undoTiles,
                isUndo: true,
                actionDesc: 'UNDO',
                vectorRemovedIds: [...(op.vectorAddedStrokes || []), ...(op.vectorStroke ? [op.vectorStroke] : [])].map((s: VectorStroke) => s.id),
                vectorAdded: op.vectorRemovedStrokes || [],
              };
              applyVectorPayload(op.layerId, payload);
              commitOp(op.layerId, 'VECTOR_EDIT', payload);
            } else {
              // Broadcast compensation Op to room
              commitTilePatch(op.layerId, undoTiles, true, 'UNDO', false, before,
                op.seq ? { targetOpSeq: op.seq, historyTiles } : undefined);
            }
          });
        }
      }
    };

    for (const op of ops) {
      await undoSingleOp(op);
    }
    warnUndoConflicts(totalConflicts);
    updateUndoRedoState();
  };

  // Personal Scoped Redo
  const redoNow = async () => {
    const effectiveUserId = userRef.current?.id || user?.id || 'guest';
    const ops = scopedUndoRef.current.redoGroup(effectiveUserId, (layerId, candidate) => {
      if (undoneLayerIdsRef.current.has(layerId)) return true; // a layer undo took away
      if (
        candidate?.selectionAfter !== undefined &&
        !candidate.beforeTiles.length &&
        !candidate.afterTiles.length &&
        !candidate.layerCreated &&
        !candidate.layerRemoved
      ) {
        return true;
      }
      const target = layersRef.current.find((l) => l.id === layerId) ?? candidate?.layerRemoved?.model ?? candidate?.layerCreated?.model;
      return Boolean(target && (target.ownerId === effectiveUserId || (candidate?.layerCreated && isAdmin) || canEditPixels(target)));
    });

    let totalConflicts = 0;
    const redoSingleOp = async (op: ScopedUndoOp) => {
      if (op.selectionAfter !== undefined) {
        selectionEngineRef.current?.restoreSnapshot(op.selectionAfter);
        selection.refreshSelection();
      }

      // Redo of a new text / pasted / mask layer: it is made again with its text and pixels
      if (op.layerCreated) {
        const oldId = op.layerId;
        const created = await recreateLayer(op.layerCreated.model, op.afterTiles);
        if (created) {
          undoneLayerIdsRef.current.delete(oldId);
          onSelectLayer?.(created.id);
        } else scopedUndoRef.current.rollbackGroup([op], false);
        return;
      }
      // Redo of a deleted layer: delete the restored layer again
      if (op.opType === 'LAYER_DELETE' && op.layerRemoved) {
        await onDeleteLayer?.(op.layerRemoved.model.id);
        return;
      }
      // Redo of a merge down: the merged layer goes away again
      if (op.layerRemoved) await onDeleteLayer?.(op.layerRemoved.model.id);

      if (
        op.metaAfter !== undefined &&
        op.beforeTiles.length === 0 &&
        op.afterTiles.length === 0 &&
        !op.layerRemoved &&
        !op.vectorStroke &&
        !op.vectorRemovedStrokes &&
        !op.vectorAddedStrokes
      ) {
        onUpdateLayerProps?.(op.layerId, { meta: op.metaAfter });
        return;
      }

      const hasPixelOrMeta = Boolean(
        op.beforeTiles.length > 0 ||
        op.afterTiles.length > 0 ||
        op.vectorStroke ||
        op.vectorRemovedStrokes ||
        op.vectorAddedStrokes ||
        op.metaAfter !== undefined
      );

      if (hasPixelOrMeta && layerManagerRef.current && tileEngineRef.current) {
        const layerItem = layerManagerRef.current.getLayerItem(op.layerId);
        if (layerItem) {
          showFrameOf(op.layerId);
          const lm = layerManagerRef.current;
          await mergeForUndo(op, op.afterTiles, op.beforeTiles, (redoTiles, conflicts, before, historyTiles, decoded) => {
            totalConflicts += conflicts;
            if (op.metaAfter !== undefined) onUpdateLayerProps?.(op.layerId, { meta: op.metaAfter });
            lm.applyTiles(op.layerId, redoTiles, undefined, decoded);

            const vectorOp = op.vectorStroke || op.vectorRemovedStrokes || op.vectorAddedStrokes;
            if (vectorOp) {
              const payload = {
                tiles: redoTiles,
                actionDesc: 'REDO',
                vectorRemovedIds: (op.vectorRemovedStrokes || []).map((s: VectorStroke) => s.id),
                vectorAdded: [...(op.vectorAddedStrokes || []), ...(op.vectorStroke ? [op.vectorStroke] : [])],
              };
              applyVectorPayload(op.layerId, payload);
              commitOp(op.layerId, 'VECTOR_EDIT', payload);
            } else {
              commitTilePatch(op.layerId, redoTiles, false, 'REDO', false, before,
                op.seq ? { targetOpSeq: op.seq, historyTiles } : undefined);
            }
          });
        }
      }
    };

    for (const op of ops) {
      await redoSingleOp(op);
    }
    warnUndoConflicts(totalConflicts);
    updateUndoRedoState();
  };

  // 貼上: the pixels float in the transform box (Enter pastes), on the active layer or a new one
  const pasteImage = async (source: HTMLCanvasElement, x: number, y: number) => {
    if (!selection.pasteToNewLayer) {
      startFloatingPaste(source, x, y);
      return;
    }
    const created = await onCreateLayer?.('貼上的圖層', 'normal', 'raster', activeLayerRef.current?.id ?? null);
    if (!created || !(await waitForLayerItem(created.id))) return;
    startFloatingPaste(source, x, y, created);
  };
  const pasteClipboard = () => {
    const clip = selection.clipboardRef.current;
    if (clip) void pasteImage(clip.source, clip.x, clip.y);
  };
  const pasteImageRef = useRef(pasteImage);
  pasteImageRef.current = pasteImage;
  // Ctrl+V of an image copied in another app (or in this one: same size = ours, keep its place)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector('[aria-modal="true"]')) return;
      const file = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'))?.getAsFile();
      if (!file || !canvas) return;
      e.preventDefault();
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const ours = selection.clipboardRef.current;
        if (ours && ours.source.width === img.naturalWidth && ours.source.height === img.naturalHeight) {
          void pasteImageRef.current(ours.source, ours.x, ours.y);
          return;
        }
        const scale = Math.min(1, canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
        const source = document.createElement('canvas');
        source.width = Math.max(1, Math.round(img.naturalWidth * scale));
        source.height = Math.max(1, Math.round(img.naturalHeight * scale));
        source.getContext('2d')!.drawImage(img, 0, 0, source.width, source.height);
        const center = getViewCenter();
        const c = center && viewportRef.current ? viewportRef.current.screenToCanvas(center.x, center.y) : { x: canvas.width / 2, y: canvas.height / 2 };
        void pasteImageRef.current(source, Math.round(c.x - source.width / 2), Math.round(c.y - source.height / 2));
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [canvas?.id, canvas?.width, canvas?.height]);

  /** 新增圖層／圖層組 (buttons, shortcuts, 群組): Ctrl+Z takes it away again, redo brings it back */
  const recordLayerCreation = (created: LayerModel, afterTiles: TileData[] = [], opts?: { groupId?: string; desc?: string }) => {
    scopedUndoRef.current.push({
      opId: `op_new_layer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      userId: userRef.current?.id || user?.id || 'guest',
      layerId: created.id,
      opType: 'LAYER_CREATE',
      ...(opts?.groupId ? { groupId: opts.groupId } : null),
      beforeTiles: [],
      afterTiles,
      timestamp: Date.now(),
      desc: opts?.desc ?? `新增${created.layerType === 'group' ? '圖層組' : '圖層'}「${created.name}」`,
      layerCreated: { model: created },
    });
    updateUndoRedoState();
  };

  const createLayerWithUndo = async (...args: Parameters<NonNullable<typeof onCreateLayer>>): Promise<LayerModel | null> => {
    const created = await onCreateLayer?.(...args);
    if (!created) return null;
    recordLayerCreation(created);
    return created;
  };

  const recordLayerCreationRef = useRef(recordLayerCreation);
  recordLayerCreationRef.current = recordLayerCreation;
  useEffect(() => {
    if (!onRegisterRecordLayerCreation) return;
    onRegisterRecordLayerCreation((created) => recordLayerCreationRef.current(created));
    return () => onRegisterRecordLayerCreation(null);
  }, [onRegisterRecordLayerCreation]);

  shortcutActionsRef.current = {
    ...shortcutActionsRef.current,
    createLayer: createLayerWithUndo,
    deleteLayer: deleteLayerWithUndo,
    selectTool: handleSelectTool,
    activateCategoryShortcut: handleCategoryShortcut,
    undo: handleScopedUndo,
    redo: handleScopedRedo,
    transform: startTransformMode,
    stepSize: (direction) => setSizeValue(nextSizeStep(sizeValue, direction)),
    stepOpacity: (direction) => {
      const cur = brushPropsRef.current?.opacity ?? 1;
      handleBrushPropsChange({ opacity: Math.max(0.01, Math.min(1, Math.round((cur + direction * 0.05) * 100) / 100)) });
    },
    vectorKey: handleVectorKey,
    selectionKey: selection.handleSelectionKey,
    selection: {
      has: () => Boolean(selectionEngineRef.current?.hasSelection()),
      canPaste: () => Boolean(selection.clipboardRef.current),
      invert: selection.invertSelection,
      copy: () => { selection.copySelection(); },
      cut: selection.cutSelection,
      clear: () => selection.deleteSelection(),
      paste: pasteClipboard,
    },
  };

  /** Recent frame time (ms) as seen by the preview flush: drives dab thinning on busy/slow devices */
  const previewFrameMsRef = useRef(16);
  const computeViewportBounds = (vp: CanvasViewport, w: number, h: number) => {
    if (!w || !h) return null;
    const corners = [vp.localToCanvas(0, 0), vp.localToCanvas(w, 0), vp.localToCanvas(0, h), vp.localToCanvas(w, h)];
    const pad = 64;
    return {
      x0: Math.min(...corners.map((c) => c.x)) - pad,
      y0: Math.min(...corners.map((c) => c.y)) - pad,
      x1: Math.max(...corners.map((c) => c.x)) + pad,
      y1: Math.max(...corners.map((c) => c.y)) + pad,
    };
  };
  /** The part of the canvas on screen (canvas coordinates, padded), without DOM layout reflow */
  const visibleCanvasBox = () => {
    const vp = viewportRef.current;
    const app = pixiAppRef.current;
    if (!vp || !app?.screen) return null;
    return computeViewportBounds(vp, app.screen.width, app.screen.height);
  };
  /** Drops one painter's preview sprites when their stroke commits, in O(1) without re-stamping others */
  const dropRemotePreview = (key: string) => {
    layerManagerRef.current?.dropPreviewPainter(key);
  };
  useEffect(() => {
    if (!isEngineReady || !canvas) return;
    let raf = 0;
    const pending: PreviewDabPacket[] = [];
    // Drawn once per frame however many packets arrive, never through React state
    let lastFlush = 0;
    const flush = (now: number) => {
      raf = 0;
      const gap = now - lastFlush;
      lastFlush = now;
      if (gap > 0 && gap < 250) previewFrameMsRef.current += (gap - previewFrameMsRef.current) * 0.2;
      else previewFrameMsRef.current = 16;
      const packets = pending.splice(0);
      const lm = layerManagerRef.current;
      const br = brushRendererRef.current;
      if (!lm || !br || !packets.length) return;
      const view = visibleCanvasBox();
      const ft = previewFrameMsRef.current;
      const spacing = ft <= 20 ? 0 : Math.min(0.25, (ft - 20) / 80);
      const cap = 4000;
      const tipTex = br.getPreviewTipTexture(0.8);
      let total = 0;
      const byPainter = new Map<string, Array<{ x: number; y: number; size: number; alpha: number; color: string }>>();
      for (const packet of packets) {
        if (packet.isEraser || !packet.dabs?.length) continue;
        const key = packet.socketId || packet.userId;
        let list = byPainter.get(key);
        if (!list) byPainter.set(key, (list = []));
        const alpha = (packet.opacity || 0.8) * 0.7;
        let lx = NaN;
        let ly = NaN;
        for (let i = 0; i < packet.dabs.length; i++) {
          const d = packet.dabs[i];
          const size = packet.brushSize * (d.pressure || 0.5);
          if (view && (d.x + size < view.x0 || d.x - size > view.x1 || d.y + size < view.y0 || d.y - size > view.y1)) continue;
          const last = i === packet.dabs.length - 1;
          if (spacing && !last && Math.hypot(d.x - lx, d.y - ly) < size * spacing) continue;
          if (total >= cap && !last) continue;
          lx = d.x;
          ly = d.y;
          total++;
          list.push({ x: d.x, y: d.y, size, alpha, color: packet.color });
        }
      }
      for (const [key, dabs] of byPainter) {
        if (dabs.length) lm.addPreviewDabs(key, dabs, tipTex);
      }
    };
    const unsubscribe = subscribePreviewDabs((packet) => {
      if (packet.canvasId !== canvas.id) return;
      pending.push(packet);
      if (!raf) raf = requestAnimationFrame(flush);
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(raf);
      layerManagerRef.current?.clearPreview();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas?.id, isEngineReady, subscribePreviewDabs]);

  // Remote Broadcast Ops & Incremental Tile Diff Patching.
  // Ops come from another socket (our own echo is dropped in SocketContext), which may well be
  // this same account on a second device.
  const applyRemoteOp = (latestBroadcastOp: OpBroadcastPacket, predecoded?: WeakMap<TileData, Uint8Array | null>) => {
    if (latestBroadcastOp.canvasId !== canvas?.id || !layerManagerRef.current || !brushRendererRef.current) return;
    // Their stroke is final now: the live preview of it goes
    dropRemotePreview(latestBroadcastOp.socketId || latestBroadcastOp.userId);
    if (latestBroadcastOp.seq > 0 && latestBroadcastOp.seq <= replayedSeqRef.current) return; // drawn by the initial replay

    if (latestBroadcastOp.layerId) {
      const layerItem = layerManagerRef.current.getLayerItem(latestBroadcastOp.layerId);
      if (!layerItem) {
        // A layer created a moment ago that our layer list does not have yet: keep its ops until it
        // arrives (dropping them left this viewer without those pixels until a reload)
        const waiting = opsForUnknownLayersRef.current;
        const list = waiting.get(latestBroadcastOp.layerId) ?? [];
        if (list.length < 200) list.push(latestBroadcastOp);
        waiting.set(latestBroadcastOp.layerId, list);
        return;
      }
      if (transformLayerIdRef.current === latestBroadcastOp.layerId) {
        // Restore the lifted pixels before applying a patch based on the committed layer.
        cancelTransform();
        setPermissionWarning('其他裝置更新了此圖層，已取消變形。');
        setTimeout(() => setPermissionWarning(null), 3000);
      }

      const payload = latestBroadcastOp.payload as any;
      const clientOpId = typeof payload?.clientOpId === 'string' ? payload.clientOpId : null;
      const incomingSeq = latestBroadcastOp.seq || 0;
      if (clientOpId && localClientOpsRef.current.has(clientOpId)) {
        // An op we already committed on this tab (e.g. replayed via getOpsSince after a socket reconnect):
        // backfill its server seq if missing, and never mark our own pixels as foreign.
        if (incomingSeq > 0) {
          const rec = recentLocalCommitsRef.current.find((r) => r.clientOpId === clientOpId && r.seq === null);
          if (rec) {
            rec.seq = incomingSeq;
            if (rec.historyOp) {
              rec.historyOp.seq = incomingSeq;
              rec.historyOp = undefined;
            }
          }
        }
        return;
      }
      const hasVectorDelta = Boolean(
        payload && (Array.isArray(payload.vectorAdded) || Array.isArray(payload.vectorRemovedIds) || payload.vectorStroke)
      );
      if (hasVectorDelta && (!clientOpId || !appliedVectorOpsRef.current.has(clientOpId))) {
        if (clientOpId) rememberOpId(appliedVectorOpsRef.current, clientOpId);
        // Sync vector delta even if pixels arrived first via pixel-only P2P TILE_PATCH with the same clientOpId
        applyVectorPayload(latestBroadcastOp.layerId, payload);
      }
      const hasFootprint = Boolean(
        payload &&
        !Array.isArray(payload.inkTiles) &&
        payload.size &&
        (!Array.isArray(payload.tiles) || typeof payload.color === 'string' || payload.isEraser) &&
        ((Array.isArray(payload.allPoints) && payload.allPoints.length > 0) ||
          (Array.isArray(payload.samplePoints) && payload.samplePoints.length > 0))
      );
      if (hasFootprint && (!clientOpId || !appliedFootprintOpsRef.current.has(clientOpId))) {
        if (clientOpId) rememberOpId(appliedFootprintOpsRef.current, clientOpId);
        // Sync brush footprint even if P2P TILE_PATCH and Socket STROKE arrive in different order
        markForeignFootprint(latestBroadcastOp.layerId, payload);
      }
      const foreignEdit = scopedUndoRef.current.foreignEdit(clientOpId ?? `seq:${incomingSeq}`, incomingSeq);
      const isAuthoritativeResync = Boolean(
        clientOpId &&
        incomingSeq > 0 &&
        speculativeConcurrencyOpsRef.current.has(clientOpId)
      );
      if (clientOpId) {
        if (appliedClientOpsRef.current.has(clientOpId) && !isAuthoritativeResync) return;
        rememberOpId(appliedClientOpsRef.current, clientOpId);
        if (isAuthoritativeResync) speculativeConcurrencyOpsRef.current.delete(clientOpId);
      }

      // Build 3-way concurrency context from local commits on this layer not yet reflected in sender's baseSeq
      const baseSeq = typeof payload?.baseSeq === 'number'
        ? payload.baseSeq
        : (incomingSeq > 0 ? incomingSeq - 1 : undefined);
      const baseTiles = new Map<string, TileData>();
      const latestLocalSeqByTile = new Map<string, number>();
      const nowMs = Date.now();
      recentLocalCommitsRef.current = recentLocalCommitsRef.current.filter(
        (rec) => !(rec.seq !== null && baseSeq !== undefined && rec.seq <= baseSeq && nowMs - rec.createdAt > 60_000)
      );
      for (const rec of recentLocalCommitsRef.current) {
        if (rec.layerId !== latestBroadcastOp.layerId) continue;
        if (rec.seq !== null && baseSeq !== undefined && rec.seq <= baseSeq) continue;
        for (const [k, bt] of rec.beforeTiles) {
          if (!baseTiles.has(k)) baseTiles.set(k, bt);
          const seqVal = rec.seq ?? Number.MAX_SAFE_INTEGER;
          latestLocalSeqByTile.set(k, Math.max(latestLocalSeqByTile.get(k) ?? 0, seqVal));
        }
      }
      const concurrency: TileConcurrencyContext | undefined = baseTiles.size > 0
        ? {
            baseTiles,
            remoteIsNewer: (col, row) => {
              const localSeq = latestLocalSeqByTile.get(`${col}_${row}`);
              if (localSeq === undefined) return true;
              return incomingSeq > 0 && localSeq < Number.MAX_SAFE_INTEGER ? incomingSeq > localSeq : false;
            },
          }
        : undefined;
      if (clientOpId && incomingSeq === 0 && concurrency && !isAuthoritativeResync) {
        rememberOpId(speculativeConcurrencyOpsRef.current, clientOpId);
      }

      if (!isAuthoritativeResync) {
        if (latestBroadcastOp.opType === 'TILE_PATCH' && incomingSeq > 0 && Number.isInteger(payload?.targetOpSeq) &&
          payload.targetOpSeq > 0 && payload.targetOpSeq < incomingSeq && Array.isArray(payload.historyTiles)) {
          scopedUndoRef.current.setForeignEditActive(latestBroadcastOp.layerId, payload.targetOpSeq, !payload.isUndo);
          for (const change of payload.historyTiles as NonNullable<TilePatchPacket['historyTiles']>) {
            if (!change?.from || !change.to) continue;
            const from = change.from;
            const to = change.to;
            const te = tileEngineRef.current;
            if (!te || !Number.isInteger(from.col) || !Number.isInteger(from.row) || from.col < 0 || from.row < 0) continue;
            const bounds = getTileBounds(from.col, from.row, te.tileSize, te.canvasWidth, te.canvasHeight);
            if (bounds.width <= 0 || bounds.height <= 0 || from.width !== bounds.width || from.height !== bounds.height) continue;
            scopedUndoRef.current.rebaseBeforeTiles(latestBroadcastOp.layerId, payload.targetOpSeq, incomingSeq,
              { ...from, data: te.normalizeTileData(from.data) }, { ...to, data: te.normalizeTileData(to.data) });
          }
        } else {
          markForeignPixels(latestBroadcastOp.layerId, payload, foreignEdit, baseTiles, predecoded);
        }
      }

      // Handle Tile Patch (Incremental Tile Sync / Scoped Undo)
      if (
        (latestBroadcastOp.opType === 'TILE_PATCH' || payload?.tiles) &&
        tileEngineRef.current &&
        payload?.tiles?.length > 0
      ) {
        layerManagerRef.current.applyTiles(latestBroadcastOp.layerId, payload.tiles, concurrency, predecoded);
      } else if (
        (latestBroadcastOp.opType === 'STROKE' || latestBroadcastOp.opType === 'ERASE') &&
        payload?.samplePoints &&
        payload.samplePoints.length > 0
      ) {
        // Handle standard Stroke / Erase fallback
        const pts = payload.samplePoints;
        const flat = new Float32Array(pts.length * 7);
        for (let i = 0; i < pts.length; i++) {
          const off = i * 7;
          flat[off] = pts[i].x;
          flat[off + 1] = pts[i].y;
          flat[off + 2] = (payload.size || 16) * (pts[i].pressure || 0.5);
          flat[off + 3] = pts[i].pressure || 0.5;
          flat[off + 4] = (payload.flow || 1.0) * (payload.opacity || 1.0);
          flat[off + 5] = 0;
          flat[off + 6] = 0;
        }
        brushRendererRef.current.stampDabs(
          layerManagerRef.current.drawTarget(latestBroadcastOp.layerId) ?? layerItem.renderTexture,
          flat,
          pts.length,
          payload.color,
          payload.isEraser
        );
      }

      // Crucial: keep pingPongTexture and thumbnail strictly in sync after remote op is applied!
      layerManagerRef.current.refreshPingPong(latestBroadcastOp.layerId);
      refreshLayerThumbnail(latestBroadcastOp.layerId, true);
      requestRenderRef.current();
    }
  };

  // Remote ops are applied the moment they arrive (no React render in between)
  const opsForUnknownLayersRef = useRef(new Map<string, OpBroadcastPacket[]>());
  useEffect(() => { opsForUnknownLayersRef.current.clear(); }, [canvas?.id]);
  // Layers that arrived: their waiting ops go on now, in order; ones for layers that never came are dropped
  useEffect(() => {
    const waiting = opsForUnknownLayersRef.current;
    if (!waiting.size || !isEngineReady) return;
    for (const [layerId, ops] of [...waiting]) {
      if (layerManagerRef.current?.getLayerItem(layerId)) {
        waiting.delete(layerId);
        ops.forEach((op) => applyRemoteOp(op));
      } else if (!layers.some((l) => l.id === layerId) && Date.now() - (ops[0].timestamp ?? Date.now()) > 15000) {
        waiting.delete(layerId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, isEngineReady]);
  const applyRemoteOpRef = useRef(applyRemoteOp);
  applyRemoteOpRef.current = applyRemoteOp;
  /** Runs fn once every local stroke / tool edit so far is in the history and tracked for merging */
  const whenLocalCommitsTrackedRef = useRef((fn: () => void) => brush.whenCommitted(() => whenToolCommitsDone(fn)));
  whenLocalCommitsTrackedRef.current = (fn: () => void) => brush.whenCommitted(() => whenToolCommitsDone(fn));
  useEffect(() => {
    let cancelled = false;
    let rafId: number | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const queuedOps: OpBroadcastPacket[] = [];
    let processing = false;

    const pump = async () => {
      if (processing) return;
      processing = true;
      try {
        while (queuedOps.length > 0 && !cancelled) {
          if (!layerManagerRef.current || !brushRendererRef.current) break;
          if (isReplayingRef.current || lastReplayedCanvasIdRef.current !== canvas?.id) break;
          const batch = queuedOps.splice(0, queuedOps.length);
          const tilesToDecode: TileData[] = [];
          const decodeReqs: Array<{ data: Uint8Array; compression: 'lz4' | 'raw'; w: number; h: number }> = [];
          for (const op of batch) {
            if (op.canvasId !== canvas?.id || (op.seq > 0 && op.seq <= replayedSeqRef.current)) continue;
            const payload = op.payload as { tiles?: TileData[] } | undefined;
            if ((op.opType === 'TILE_PATCH' || payload?.tiles) && Array.isArray(payload?.tiles)) {
              for (const t of payload.tiles) {
                if (t && t.compression === 'lz4' && t.width > 0 && t.height > 0) {
                  tilesToDecode.push(t);
                  decodeReqs.push({
                    data: normalizeTileBytes(t.data),
                    compression: 'lz4',
                    w: t.width,
                    h: t.height,
                  });
                }
              }
            }
          }
          let predecoded: WeakMap<TileData, Uint8Array | null> | undefined;
          if (decodeReqs.length > 0) {
            const decoded = await decodeTiles(decodeReqs);
            if (cancelled || !layerManagerRef.current || !brushRendererRef.current) break;
            if (isReplayingRef.current || lastReplayedCanvasIdRef.current !== canvas?.id) break;
            predecoded = new WeakMap();
            for (let i = 0; i < tilesToDecode.length; i++) {
              predecoded.set(tilesToDecode[i], decoded[i] ?? null);
            }
          }
          // A local edit whose tiles are read and whose baseline is synced (a sparse layer drops its
          // backups) but whose commit is still compressing in a worker has neither backups nor a
          // concurrency record yet: a remote tile applied in that window replaced our stroke's
          // pixels wholesale. Wait the few ms until those commits are tracked, then merge 3-way.
          await new Promise<void>((resolve) => whenLocalCommitsTrackedRef.current(resolve));
          if (cancelled || !layerManagerRef.current || !brushRendererRef.current) break;
          for (const op of batch) applyRemoteOpRef.current(op, predecoded);
        }
      } finally {
        processing = false;
      }
    };

    const drain = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (!layerManagerRef.current || !brushRendererRef.current) return;
      // During the initial snapshot/op replay ops stay queued: drawn now, the replay's older
      // tiles would land on top of them afterwards. loadCheckpointAndReplay drains the queue.
      if (isReplayingRef.current || lastReplayedCanvasIdRef.current !== canvas?.id) return;
      const incoming = takeBroadcastOps();
      if (!incoming.length) return;
      queuedOps.push(...incoming);
      void pump();
    };
    const scheduleDrain = () => {
      if (rafId !== null || fallbackTimer !== null) return;
      if (document.hidden) {
        fallbackTimer = setTimeout(drain, 0);
      } else {
        rafId = requestAnimationFrame(drain);
        fallbackTimer = setTimeout(drain, 50);
      }
    };
    drain();
    const unsubscribe = subscribeOps(scheduleDrain);
    return () => {
      cancelled = true;
      unsubscribe();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas?.id, isEngineReady, subscribeOps]);

  // Animation (CSP style): every animation folder is a track, every child layer a cel, so cels,
  // their pixels and their timing (meta.cel) sync, save and undo like any layer. This viewer's
  // frame, playback, playback range and onion skin stay local.
  useEffect(() => {
    if (!animationEngine) return;
    animationEngine.setFps(animFolder?.meta?.animation?.fps ?? 12);
    animationEngine.setLength(animTimelineLength);
  }, [animationEngine, animFolder?.meta?.animation?.fps, animTimelineLength]);

  // Timeline clicks pick their own layer, so the frame change must not pick one too
  const skipSelectShownRef = useRef(false);
  useEffect(() => {
    const engine = animationEngine;
    if (!engine || !isEngineReady) return;
    const solo = OfflineSessionStore.isOfflineCanvas(canvas?.id);
    const adaptiveResolution = solo && Boolean(canvas && canvas.width * canvas.height >= 2048 * 2048);
    const playbackFrames = new Map<number, ReturnType<typeof displayLayersFor>>();
    let frameLayers = layersRef.current;
    let frameVisibility = localVisibilityRef.current;
    let frameFolder = animFolderIdRef.current;
    const playbackDisplay = (time: number) => {
      if (!solo) return displayLayersFor(layersRef.current, { time });
      if (frameLayers !== layersRef.current || frameVisibility !== localVisibilityRef.current || frameFolder !== animFolderIdRef.current) {
        playbackFrames.clear();
        frameLayers = layersRef.current;
        frameVisibility = localVisibilityRef.current;
        frameFolder = animFolderIdRef.current;
      }
      const cached = playbackFrames.get(time);
      if (cached) return cached;
      const displayed = displayLayersFor(frameLayers, { time });
      if (playbackFrames.size >= 16) playbackFrames.delete(playbackFrames.keys().next().value!);
      playbackFrames.set(time, displayed);
      return displayed;
    };
    let lastSyncSig = '';
    let lastPrefetchSig = '';
    const buildDisplaySig = (list: ReturnType<typeof displayLayersFor>) => {
      let s = '';
      for (let i = 0; i < list.length; i++) {
        const l = list[i] as LayerModel & { onionTint?: number; renderTransform?: { isIdentity: boolean; a: number; b: number; c: number; d: number; tx: number; ty: number } };
        if (!l.isVisible) continue;
        s += `${l.id}:${l.opacity.toFixed(3)}:${l.onionTint ?? ''}`;
        if (l.renderTransform && !l.renderTransform.isIdentity) {
          const { a, b, c, d, tx, ty } = l.renderTransform;
          s += `@${a.toFixed(3)},${b.toFixed(3)},${c.toFixed(3)},${d.toFixed(3)},${tx.toFixed(1)},${ty.toFixed(1)}`;
        }
        s += '|';
      }
      return s;
    };
    const show = () => {
      const lm = layerManagerRef.current;
      if (!lm) return;
      const playing = engine.getIsPlaying();
      const displayed = solo && playing && !liveKeyframePreviewRef.current
        ? playbackDisplay(engine.getTime()) : displayLayersFor(layersRef.current);
      const sig = buildDisplaySig(displayed);
      if (!playing || sig !== lastSyncSig) {
        lastSyncSig = sig;
        lm.syncLayers(displayed);
      }
      if (!playing) {
        lastPrefetchSig = '';
        playbackFrames.clear();
        return;
      }
      // The next frames' cels: their compressed tiles are decoded in the workers now, so they are
      // on the GPU when their turn comes (decoding on the spot made a phone drop frames)
      const t = engine.getTime();
      const range = engine.getRange();
      const start = range?.start ?? 0;
      const end = range?.end ?? engine.getLength() - 1;
      const ids = new Set<string>();
      for (let k = 1; k <= ANIM_PREFETCH_FRAMES; k++) {
        if (!engine.getLoop() && t + k > end) break;
        const next = start + (t + k - start) % Math.max(1, end - start + 1);
        for (const l of playbackDisplay(next)) if (l.isVisible) ids.add(l.id);
      }
      const pfSig = [...ids].sort().join(',');
      if (pfSig !== lastPrefetchSig) {
        lastPrefetchSig = pfSig;
        lm.prefetch([...ids]);
      }
    };
    // The cel on screen in the edited track is the layer you draw on (picked on the timeline, or where playback stopped)
    const selectShown = () => {
      if (skipSelectShownRef.current) return;
      const entries = animEntriesRef.current;
      const shown = celLayerOf(entries[entryIndexAt(entries, engine.getTime())]);
      const active = activeLayerRef.current;
      if (!shown || !active) return;
      if (active.id === shown || celOfLayer(layersRef.current, active.id)?.celId === shown) return; // already on it (or inside its cel folder)
      onSelectLayer?.(shown);
    };
    let prevPlayFrame = engine.getTime();
    let lastPlaybackAt = 0;
    let slowFrames = 0;
    let reducedPreview = false;
    const playableAudioItems = () =>
      audioLayersRef.current
        .filter((l) => l.isVisible && l.meta?.audio)
        .map((l) => ({ layerId: l.id, meta: normalizeAudioTrackMeta(l.meta!.audio) }));
    const unsubFrame = engine.onFrameChange((t, byUser) => {
      show();
      if (cameraPreviewActiveRef.current) syncCameraPreviewViewportRef.current(t);
      if (engine.getIsPlaying()) {
        if (adaptiveResolution && !reducedPreview) {
          const now = performance.now();
          const slow = lastPlaybackAt && !byUser && now - lastPlaybackAt > 1600 / engine.getFps();
          slowFrames = slow ? slowFrames + 1 : Math.max(0, slowFrames - 1);
          lastPlaybackAt = now;
          if (slowFrames >= 3) {
            reducedPreview = true;
            setPlaybackResolutionRef.current(true);
          }
        }
        // Re-sync local audio on loop wrap or user seek during playback
        if (t < prevPlayFrame || byUser) {
          void audioPlayerRef.current?.startPlayback(playableAudioItems(), t, engine.getFps(), engine.getRange()?.end);
        }
        prevPlayFrame = t;
      } else {
        setAnimFrame(t);
        if (byUser) {
          selectShown();
          if (audioScrubEnabledRef.current) {
            void audioPlayerRef.current?.scrubFrame(playableAudioItems(), t, engine.getFps());
          }
        }
      }
    });
    const unsubPlay = engine.onPlaybackStateChange((playing) => {
      layerManagerRef.current?.setThumbnailsPaused(playing);
      prevPlayFrame = engine.getTime();
      if (playing) {
        void audioPlayerRef.current?.startPlayback(
          playableAudioItems(),
          engine.getTime(),
          engine.getFps(),
          engine.getRange()?.end
        );
      } else {
        audioPlayerRef.current?.stopPlayback();
        if (reducedPreview) setPlaybackResolutionRef.current(false);
        lastPlaybackAt = 0;
        slowFrames = 0;
        reducedPreview = false;
        lastSyncSig = '';
        setAnimFrame(engine.getTime());
      }
      show();
      if (cameraPreviewActiveRef.current) syncCameraPreviewViewportRef.current(engine.getTime());
      if (!playing) selectShown();
    });
    return () => {
      unsubFrame();
      unsubPlay();
      if (reducedPreview) setPlaybackResolutionRef.current(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animationEngine, isEngineReady]);

  // Picking a cel in the layer panel (or adding one) moves the timeline to it
  useEffect(() => {
    const engine = animationEngine;
    if (!engine || !activeLayer || engine.getIsPlaying()) return;
    const cel = celOfLayer(layers, activeLayer.id);
    if (!cel) return;
    const entries = celEntriesOf(layers, cel.folderId);
    if (celLayerOf(entries[entryIndexAt(entries, engine.getTime())]) === cel.celId) return;
    const i = entries.findIndex((e) => e.id === cel.celId);
    if (i < 0) return;
    skipSelectShownRef.current = true;
    engine.goTo(entryStart(entries, i));
    skipSelectShownRef.current = false;
  }, [activeLayer?.id, animationEngine, animTrackKey]);

  /** The entry of the edited track at the frame on screen */
  const currentAnimEntry = () => {
    const i = entryIndexAt(animEntries, animationEngine?.getTime() ?? 0);
    return { index: i, entry: animEntries[i] as (typeof animEntries)[number] | undefined };
  };
  /** CSP numbers cels 1, 2, 3…: the next number not used yet */
  const nextCelName = () => {
    const used = new Set(animEntries.map((e) => e.label));
    let n = animEntries.filter((e) => e.ref === undefined).length + 1;
    while (used.has(String(n))) n++;
    return String(n);
  };
  const canAddCel = (folder: LayerModel | null) => Boolean(folder && !isGuest && !isCanvasViewer && folderAccess.canAdd(folder));
  const createAnimationFolder = async () => {
    if (!onCreateLayer) return;
    const fps = animationEngine?.getFps() ?? 12; // a new track plays at the same speed as the others
    const folder = await onCreateLayer(`動畫 ${animFolders.length + 1}`, 'normal', 'group', null, null, { meta: { animation: { fps } }, select: false });
    if (folder) await onCreateLayer('1', 'normal', 'raster', folder.id, folder.id);
  };
  // 順移 (ripple): on, a new / deleted cel moves everything after it; off (the default, as in CSP),
  // its neighbours give or take the frames so later cels keep their timing. A viewer's own setting.
  const [animRipple, setAnimRipple] = useState(() => {
    try {
      return localStorage.getItem('atelier_anim_ripple') === '1';
    } catch {
      return false;
    }
  });
  // Cels copied on the timeline (Ctrl+C), with where they sat relative to the first one
  const animClipboardRef = useRef<{
    folderId: string;
    cels: Array<{ id: string; ref?: string; blank?: boolean; isGroup: boolean; offset: number; hold: number }>;
  } | null>(null);
  const toggleAnimRipple = () => {
    setAnimRipple((on) => {
      try { localStorage.setItem('atelier_anim_ripple', on ? '0' : '1'); } catch { /* not remembered */ }
      return !on;
    });
  };
  /**
   * Without ripple a new cel (right after the current one) takes its frames from its neighbours,
   * as in CSP: it starts on the playhead and runs up to the next cel (on a cel's first frame, one
   * frame later), else it takes one frame of the next cel. Returns the new cel's hold, or null when
   * there is no room (it then ripples after all).
   */
  const roomWithoutRipple = (): number | null => {
    const { index, entry } = currentAnimEntry();
    if (!entry || !animationEngine) return null;
    const split = celInsertAt(animEntries, animationEngine.getTime());
    const cur = entryLayer(entry.id);
    if (split && cur && canManageLayer(cur)) {
      setEntryHold(entry.id, split.keep);
      return split.hold;
    }
    const next = animEntries[index + 1];
    const nextLayer = entryLayer(next?.id);
    if (next && next.hold > 1 && nextLayer && canManageLayer(nextLayer)) {
      setEntryHold(next.id, next.hold - 1);
      return 1;
    }
    warn('前後沒有可以借的格數（或是別人的格），後面的格往後移。', 3000);
    return null;
  };
  /** The meta of a cel inserted after the current one, holding `hold` frames (default 1) */
  const insertedCelMeta = (hold: number | null) => (hold && hold > 1 ? { cel: { hold } } : null);
  /**
   * CSP 動畫膠片: a cel folder with the same folders and layers as `template` (empty), so a cel made
   * of line art / colour / shadow layers stays one cel on one track. Drawing goes on in the copy of
   * the layer that was active.
   */
  const createCelLike = async (template: LayerModel, name: string, after: string, folderId: string, meta: LayerMeta | null) => {
    const all = layersRef.current;
    const root = await createLayerWithUndo(name, template.blendMode, 'group', after, folderId, { meta, select: false });
    if (!root) return null;
    const copies = new Map<string, string>([[template.id, root.id]]);
    let last = root.id;
    let drawable: string | null = null;
    const copyInto = async (fromId: string, toId: string, depth: number): Promise<void> => {
      if (depth > 8) return;
      const kids = all.filter((l) => l.parentId === fromId).sort((a, b) => a.sortOrder - b.sortOrder);
      for (const k of kids) {
        const group = k.layerType === 'group' || k.layerType === 'folder';
        const type: LayerType | null = group ? 'group' : k.layerType === 'raster' || k.layerType === 'vector' ? k.layerType : null;
        if (!type) continue; // masks, text and adjustment layers are not part of the drawing structure
        const made = await createLayerWithUndo(k.name, k.blendMode, type, last, toId, { select: false });
        if (!made) return;
        copies.set(k.id, made.id);
        last = made.id;
        if (!group) drawable = made.id;
        if (k.opacity !== made.opacity || k.isVisible !== made.isVisible) await onUpdateLayerProps?.(made.id, { opacity: k.opacity, isVisible: k.isVisible });
        if (group) await copyInto(k.id, made.id, depth + 1);
      }
    };
    await copyInto(template.id, root.id, 0);
    onSelectLayer?.(copies.get(activeLayerRef.current?.id ?? '') ?? drawable ?? root.id);
    return root;
  };
  const addAnimationFrame = async () => {
    if (!onCreateLayer || !animFolder) return;
    if (!canAddCel(animFolder)) return warn('這個動畫資料夾沒有共用，只有建立者能加格。');
    const time = animationEngine?.getTime() ?? 0;
    const folderId = animFolder.id;
    // A folder cel (the one on screen, else the last one) is copied as a whole structure
    const here = currentAnimEntry().entry;
    const templateId = celLayerOf(here ?? animEntries[animEntries.length - 1]);
    const template = templateId ? layersRef.current.find((l) => l.id === templateId && l.layerType === 'group' && l.meta?.cel?.ref === undefined) : undefined;
    const make = (after: string, meta: LayerMeta | null) => (template
      ? createCelLike(template, nextCelName(), after, folderId, meta)
      : createLayerWithUndo(nextCelName(), 'normal', 'raster', after, folderId, { meta }));
    if (animEntries.length > 0 && time >= trackLength(animEntries)) {
      // Past the end of the track: the new cel goes on that frame and the last drawing holds until it
      const created = await make(animEntries[animEntries.length - 1].id, null);
      if (!created) return;
      await waitForLayerModels([created.id]);
      const others = celEntriesOf(layersRef.current, folderId).filter((e) => e.id !== created.id);
      commitAnimationPlacement(folderId, placeEntries(others, new Map([[created.id, time]]), [{ id: created.id, hold: 1 }]));
      return;
    }
    const after = here?.id ?? animEntries[animEntries.length - 1]?.id ?? folderId;
    const hold = animRipple ? null : roomWithoutRipple();
    await make(after, insertedCelMeta(hold));
  };
  const duplicateAnimationFrame = async () => {
    const src = currentAnimEntry().entry;
    const srcLayer = src && layersRef.current.find((l) => l.id === src.id);
    const srcItem = srcLayer && layerManagerRef.current?.getLayerItem(srcLayer.id);
    const te = tileEngineRef.current;
    const lm = layerManagerRef.current;
    if (!onCreateLayer || !animFolder || !canAddCel(animFolder)) return;
    if (!src || src.ref !== undefined || src.isGroup || !srcLayer || !srcItem || !te || !lm) return warn('只能複製一般的格（重複格用「重複使用」；影格資料夾請複製裡面的圖層）。');
    const copyCoords = lm.occupiedTiles(srcLayer.id) ?? te.getAllTileCoords();
    const tiles = copyCoords.length ? await tilesAsync(lm, srcLayer.id, copyCoords) : [];
    const hold = animRipple ? src.hold : roomWithoutRipple();
    const created = await onCreateLayer(nextCelName(), srcLayer.blendMode, 'raster', src.id, animFolder.id, { meta: insertedCelMeta(hold) });
    const item = created && (await waitForLayerItem(created.id));
    if (!created || !item) return;
    if (tiles.length) lm.applyTiles(created.id, tiles);
    recordLayerCreation(created, tiles);
    commitTilePatch(created.id, tiles, false, '動畫：複製影格');
  };
  /** Shows a cel again without copying it (an empty group pointing at it: editing the cel changes every repeat) */
  const reuseAnimationCel = async (celId: string) => {
    const target = layersRef.current.find((l) => l.id === celId);
    if (!onCreateLayer || !animFolder || !target || !canAddCel(animFolder)) return;
    const after = currentAnimEntry().entry?.id ?? animEntries[animEntries.length - 1]?.id ?? animFolder.id;
    const hold = animRipple ? null : roomWithoutRipple();
    await createLayerWithUndo(`↻ ${target.name}`, 'normal', 'group', after, animFolder.id, { meta: { cel: { ref: celId, ...(hold && hold > 1 ? { hold } : {}) } } });
  };
  /**
   * A blank frame: an empty group with ref '' (no textures), so this track shows nothing there, in
   * playback and in exported files alike. Placed like a new cel (at the playhead, or past the end).
   */
  const addBlankAnimationFrame = async () => {
    if (!onCreateLayer || !animFolder) return;
    if (!canAddCel(animFolder)) return warn('這個動畫資料夾沒有共用，只有建立者能加格。');
    const folderId = animFolder.id;
    const time = animationEngine?.getTime() ?? 0;
    const blankMeta = (hold: number | null): LayerMeta => ({ cel: { ref: '', ...(hold && hold > 1 ? { hold } : {}) } });
    if (animEntries.length > 0 && time >= trackLength(animEntries)) {
      const created = await createLayerWithUndo(BLANK_CEL_NAME, 'normal', 'group', animEntries[animEntries.length - 1].id, folderId, { meta: blankMeta(null) });
      if (!created) return;
      await waitForLayerModels([created.id]);
      const others = celEntriesOf(layersRef.current, folderId).filter((e) => e.id !== created.id);
      commitAnimationPlacement(folderId, placeEntries(others, new Map([[created.id, time]]), [{ id: created.id, hold: 1 }]));
      return;
    }
    const after = currentAnimEntry().entry?.id ?? animEntries[animEntries.length - 1]?.id ?? folderId;
    const hold = animRipple ? null : roomWithoutRipple();
    await createLayerWithUndo(BLANK_CEL_NAME, 'normal', 'group', after, folderId, { meta: blankMeta(hold) });
  };
  const entryLayer = (id: string | undefined) => (id ? layersRef.current.find((l) => l.id === id) : undefined);
  const setEntryHold = (entryId: string | undefined, hold: number) => {
    const layer = entryLayer(entryId);
    if (!layer) return;
    if (!canManageLayer(layer)) return warn('這一格是其他畫師的，只有他能改停留格數。');
    onUpdateLayerProps?.(layer.id, { meta: { ...layer.meta, cel: { ...layer.meta?.cel, hold } } });
  };
  const setAnimationHold = (hold: number) => setEntryHold(currentAnimEntry().entry?.id, hold);
  const holdOfLayer = (l: LayerModel) => Math.max(1, Math.min(MAX_HOLD, Math.round(Number(l.meta?.cel?.hold) || 1)));
  /** Layers just created through onCreateLayer reach layersRef a render later */
  const waitForLayerModels = async (ids: string[]) => {
    for (let i = 0; i < 80 && !ids.every((id) => layersRef.current.some((l) => l.id === id)); i++) await new Promise((r) => setTimeout(r, 50));
  };
  /**
   * Sends a Krita-style placement (placeEntries) of a track: the order of its cels and the holds
   * that put them on their frames. `joining` cels come from another track and join the folder
   * first; `alsoHolds` are hold changes elsewhere (the track they left). Returns false, changing
   * nothing, when another painter's cel would have to change.
   */
  const commitAnimationPlacement = (
    folderId: string,
    placed: Array<{ id: string; hold: number }>,
    joining: LayerModel[] = [],
    alsoHolds: Array<{ id: string; hold: number }> = []
  ): boolean => {
    const ls = layersRef.current;
    const before = celEntriesOf(ls, folderId);
    const changes = [...placed, ...alsoHolds].filter((p) => {
      const l = entryLayer(p.id);
      return !l || holdOfLayer(l) !== p.hold;
    });
    if (changes.some((p) => !entryLayer(p.id) || !canManageLayer(entryLayer(p.id)!))) {
      warn('這樣放會改到其他畫師的格的停留格數，請換個位置。', 3000);
      return false;
    }
    const holdMeta = (l: LayerModel, hold: number) => ({ ...l.meta, cel: { ...l.meta?.cel, hold } });
    const changed = new Map(changes.map((c) => [c.id, c.hold]));
    const joiningIds = new Set(joining.map((l) => l.id));
    // The server keeps a folder's content right below it: cels join the folder before the new order is sent
    const joined = Promise.all(joining.map((l) => onUpdateLayerProps?.(l.id, {
      parentId: folderId,
      ...(changed.has(l.id) ? { meta: holdMeta(l, changed.get(l.id)!) } : {}),
    })));
    const order = placed.map((p) => p.id);
    if (joining.length || order.join() !== before.map((e) => e.id).join()) {
      const ascending = [...ls].sort((a, b) => a.sortOrder - b.sortOrder).map((l) => l.id);
      const placing = new Set(order);
      const rest = ascending.filter((id) => !placing.has(id));
      // Where the track's cels sit now (an empty folder: right below the folder)
      const lowest = Math.min(...before.map((e) => ascending.indexOf(e.id)).filter((i) => i >= 0));
      const pos = Math.max(0, Number.isFinite(lowest) ? ascending.slice(0, lowest).filter((id) => !placing.has(id)).length : rest.indexOf(folderId));
      rest.splice(pos, 0, ...order);
      void joined.then(() => onReorderLayer?.(order[0], (pos + 1) * 10, rest));
    }
    for (const c of changes) {
      if (joiningIds.has(c.id)) continue;
      const l = entryLayer(c.id)!;
      onUpdateLayerProps?.(l.id, { meta: holdMeta(l, c.hold) });
    }
    return true;
  };
  /** Drag and drop on the timeline: the cels move `delta` frames (into another track too); every other cel keeps its frames */
  const placeAnimationEntries = (entryIds: string[], folderId: string, delta: number) => {
    const ls = layersRef.current;
    const moving = entryIds.map((id) => entryLayer(id)).filter((l): l is LayerModel => Boolean(l?.parentId));
    const target = ls.find((l) => l.id === folderId);
    if (!moving.length || !target) return;
    if (moving.some((l) => !canManageLayer(l))) return warn('選取的格裡有其他畫師的，不能移動。');
    const fromId = moving[0].parentId!;
    if (moving.some((l) => l.parentId !== fromId)) return;
    const crossing = fromId !== folderId;
    if (crossing) {
      if (!canAddCel(target)) return warn('那個動畫資料夾沒有共用，不能把格移過去。');
      for (const l of moving) {
        // A reuse only points inside its own folder
        if (l.meta?.cel?.ref && !entryIds.includes(l.meta.cel.ref)) return warn('重複格只能在同一軌裡移動（或和它重複的那張一起移）。');
        if (celEntriesOf(ls, fromId).some((e) => e.ref === l.id && !entryIds.includes(e.id))) return warn('有一張在原本那一軌被重複使用中，請先刪掉那些重複格（或一起選取）再移到別軌。');
      }
    }
    const from = celEntriesOf(ls, fromId);
    const startOf = new Map(from.map((e, i) => [e.id, entryStart(from, i)]));
    const ids = new Set(moving.map((l) => l.id));
    const starts = new Map(moving.map((l) => [l.id, Math.max(0, (startOf.get(l.id) ?? 0) + delta)]));
    let ok: boolean;
    if (!crossing) {
      ok = commitAnimationPlacement(folderId, placeEntries(from, starts));
    } else {
      // The track they leave keeps its other cels on their frames (the drawing before a gap holds on)
      const left = from.filter((e) => !ids.has(e.id));
      const leftPlaced = placeEntries(left, new Map(left.map((e) => [e.id, startOf.get(e.id)!])));
      const added = from.filter((e) => ids.has(e.id)).map((e) => ({ id: e.id, hold: e.hold }));
      ok = commitAnimationPlacement(folderId, placeEntries(celEntriesOf(ls, folderId), starts, added), moving, leftPlaced);
    }
    if (!ok) return;
    const first = moving[0];
    onSelectLayer?.(celLayerOf(from.find((e) => e.id === first.id)) ?? first.id);
  };
  /** Ctrl+C on the timeline: the cels, and where they sat relative to the first one */
  const copyAnimationEntries = (folderId: string, entryIds: string[]) => {
    const entries = celEntriesOf(layersRef.current, folderId);
    const picked = entries.map((e, i) => ({ e, start: entryStart(entries, i) })).filter(({ e }) => entryIds.includes(e.id));
    if (!picked.length) return;
    animClipboardRef.current = {
      folderId,
      cels: picked.map(({ e, start }) => ({ id: e.id, ref: e.ref, blank: e.blank, isGroup: e.isGroup, offset: start - picked[0].start, hold: e.hold })),
    };
    warn(`已複製 ${picked.length} 格`, 1500);
  };
  /** Ctrl+V on the timeline: new copies of the copied cels, the first on `frame` (a repeat stays a repeat of the same drawing) */
  const pasteAnimationEntries = async (folderId: string, frame: number) => {
    const clip = animClipboardRef.current;
    const folder = layersRef.current.find((l) => l.id === folderId);
    const lm = layerManagerRef.current;
    const te = tileEngineRef.current;
    if (!clip) return warn('先在時間軸選格子按 Ctrl+C', 2000);
    if (!onCreateLayer || !folder || !lm || !te) return;
    if (!canAddCel(folder)) return warn('這個動畫資料夾沒有共用，只有建立者能加格。');
    const existing = celEntriesOf(layersRef.current, folderId);
    const usedNames = new Set(existing.map((e) => e.label));
    let n = existing.filter((e) => e.ref === undefined).length + 1;
    const nextName = () => {
      while (usedNames.has(String(n))) n++;
      usedNames.add(String(n));
      return String(n);
    };
    const made: Array<{ id: string; start: number; hold: number }> = [];
    let skipped = 0;
    for (const c of clip.cels) {
      const after = celEntriesOf(layersRef.current, folderId).at(-1)?.id ?? folderId; // the placement below sorts them out
      if (c.blank) {
        // A blank frame pastes as a blank frame, into any track
        const layer = await createLayerWithUndo(BLANK_CEL_NAME, 'normal', 'group', after, folderId, { meta: { cel: { ref: '', hold: c.hold } }, select: false });
        if (layer) made.push({ id: layer.id, start: frame + c.offset, hold: c.hold });
        continue;
      }
      if (c.ref !== undefined) {
        const target = c.ref ? layersRef.current.find((l) => l.id === c.ref) : undefined;
        if (clip.folderId !== folderId || !target) {
          skipped++;
          continue;
        }
        const layer = await createLayerWithUndo(`↻ ${target.name}`, 'normal', 'group', after, folderId, { meta: { cel: { ref: c.ref, hold: c.hold } }, select: false });
        if (layer) made.push({ id: layer.id, start: frame + c.offset, hold: c.hold });
        continue;
      }
      const src = layersRef.current.find((l) => l.id === c.id);
      if (!src || c.isGroup) {
        skipped++;
        continue;
      }
      const coords = lm.occupiedTiles(src.id) ?? te.getAllTileCoords();
      const tiles = coords.length ? await tilesAsync(lm, src.id, coords) : [];
      const layer = await onCreateLayer(nextName(), src.blendMode, 'raster', after, folderId, { meta: { cel: { hold: c.hold } }, select: false });
      const item = layer && (await waitForLayerItem(layer.id));
      if (!layer || !item) continue;
      if (tiles.length) lm.applyTiles(layer.id, tiles);
      recordLayerCreation(layer, tiles);
      commitTilePatch(layer.id, tiles, false, '動畫：貼上影格');
      made.push({ id: layer.id, start: frame + c.offset, hold: c.hold });
    }
    if (skipped) warn(`影格資料夾，以及貼到別軌的重複格不能貼上：略過 ${skipped} 格`, 3000);
    if (!made.length) return;
    await waitForLayerModels(made.map((m) => m.id));
    const madeIds = new Set(made.map((m) => m.id));
    const others = celEntriesOf(layersRef.current, folderId).filter((e) => !madeIds.has(e.id));
    commitAnimationPlacement(folderId, placeEntries(others, new Map(made.map((m) => [m.id, m.start])), made));
    onSelectLayer?.(made[0].id);
  };
  const deleteAnimationFrame = () => {
    const { index, entry } = currentAnimEntry();
    const layer = entryLayer(entry?.id);
    if (!entry || !layer || animEntries.length <= 1) return;
    if (!canManageLayer(layer)) return warn('這一格是其他畫師的，不能刪除。');
    const repeats = animEntries.filter((e) => e.ref === entry.id).length;
    const note = repeats ? `\n有 ${repeats} 個重複格用到這張，刪掉後它們會變空白。` : '';
    if (!confirm(`刪除第 ${index + 1} 張「${entry.label}」？房間裡所有人都會少這一張。${note}`)) return;
    if (!animRipple) {
      // Its frames go to the cel before (or after) it, so the cels after it keep their timing
      const heir = [animEntries[index - 1], animEntries[index + 1]].find((e) => e && canManageLayer(entryLayer(e.id) ?? layer) && entryLayer(e.id));
      if (heir) setEntryHold(heir.id, Math.min(MAX_HOLD, heir.hold + entry.hold));
      else warn('前後的格是別人的，沒辦法接手格數：後面的格往前移。', 3000);
    }
    void deleteLayerWithUndo(entry.id);
  };
  const moveAnimationFrame = (direction: -1 | 1) => {
    const { index, entry } = currentAnimEntry();
    const other = animEntries[index + direction];
    const layer = entryLayer(entry?.id);
    if (!entry || !other || !layer) return;
    if (!canManageLayer(layer)) return warn('這一格是其他畫師的，不能移動。');
    const ascending = [...layersRef.current].sort((a, b) => a.sortOrder - b.sortOrder).map((l) => l.id);
    const i = ascending.indexOf(entry.id);
    const j = ascending.indexOf(other.id);
    [ascending[i], ascending[j]] = [ascending[j], ascending[i]];
    onReorderLayer?.(entry.id, (j + 1) * 10, ascending);
  };
  const toggleAnimationShared = () => {
    if (!animFolder || !canManageLayer(animFolder)) return;
    const animation = { fps: 12, ...animFolder.meta?.animation };
    onUpdateLayerProps?.(animFolder.id, { meta: { ...animFolder.meta, animation: { ...animation, shared: !animation.shared } } });
  };
  const setAnimationFps = (fps: number) => {
    if (animFolder && canManageLayer(animFolder)) onUpdateLayerProps?.(animFolder.id, { meta: { ...animFolder.meta, animation: { ...animFolder.meta?.animation, fps } } });
  };
  /** Update key/inbetween mark (○/●) or memo note on a single cel */
  const updateAnimationCelMeta = (entryId: string, patch: { mark?: CelMark | null; note?: string | null }) => {
    const layer = layersRef.current.find((l) => l.id === entryId);
    if (!layer) return;
    if (!canManageLayer(layer)) return warn('這一格是其他畫師的，只有他能編輯記號或備註。');
    const cel: NonNullable<LayerMeta['cel']> = { ...layer.meta?.cel };
    if (patch.mark !== undefined) {
      if (patch.mark === 'key' || patch.mark === 'inbetween') cel.mark = patch.mark;
      else delete cel.mark;
    }
    if (patch.note !== undefined) {
      const cleaned = typeof patch.note === 'string' ? patch.note.trim().slice(0, 120) : '';
      if (cleaned) cel.note = cleaned;
      else delete cel.note;
    }
    const nextMeta: LayerMeta = { ...layer.meta };
    if (Object.keys(cel).length > 0) nextMeta.cel = cel;
    else delete nextMeta.cel;
    onUpdateLayerProps?.(layer.id, { meta: nextMeta });
  };
  /** Save timeline frame labels on the active animation folder */
  const setAnimationLabels = (labels: TimelineLabel[]) => {
    if (!animFolder || !canManageLayer(animFolder)) return;
    const cleaned = normalizeTimelineLabels(labels);
    const animation: NonNullable<LayerMeta['animation']> = { fps: 12, ...animFolder.meta?.animation };
    if (cleaned.length > 0) animation.labels = cleaned;
    else delete animation.labels;
    onUpdateLayerProps?.(animFolder.id, { meta: { ...animFolder.meta, animation } });
  };
  /**
   * Repeat a selected run of cels using ref entries (single grouped undo step).
   * Rejects the entire batch without creating anything if it would touch or shift another painter's cel.
   */
  const repeatAnimationEntries = async (
    folderId: string,
    entryIds: string[],
    opts: { mode: 'count' | 'toEnd'; count: number },
  ): Promise<boolean> => {
    const folder = layersRef.current.find((l) => l.id === folderId);
    if (!onCreateLayer || !folder) return false;
    if (!canAddCel(folder)) {
      warn('這個動畫資料夾沒有共用，只有建立者能加格。');
      return false;
    }
    const entries = celEntriesOf(layersRef.current, folderId);
    const pickedSet = new Set(entryIds);
    const pickedIndices: number[] = [];
    entries.forEach((e, i) => { if (pickedSet.has(e.id)) pickedIndices.push(i); });
    if (pickedIndices.length === 0) return false;

    const lastPickedIdx = pickedIndices[pickedIndices.length - 1];
    const touchedIds = new Set<string>([
      ...pickedIndices.map((i) => entries[i].id),
      ...entries.slice(lastPickedIdx + 1).map((e) => e.id),
    ]);
    for (const id of touchedIds) {
      const l = entryLayer(id);
      if (!l || !canManageLayer(l)) {
        warn('重複指定會動到其他畫師的格，已取消整批操作。', 3200);
        return false;
      }
    }

    const plan = planRepeatCels(entries, pickedIndices.map((i) => entries[i].id), {
      mode: opts.mode,
      count: opts.count,
      targetEndFrame: animTimelineLength,
    });
    if (plan.items.length === 0) return false;

    const groupId = `anim_repeat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    let afterId = entries[lastPickedIdx].id;
    const createdIds: string[] = [];
    for (const item of plan.items) {
      const celMeta: NonNullable<LayerMeta['cel']> = {
        ref: item.ref,
        ...(item.hold > 1 ? { hold: item.hold } : {}),
      };
      const created = await onCreateLayer(item.name, 'normal', 'group', afterId, folderId, {
        meta: { cel: celMeta },
        select: false,
      });
      if (!created) break;
      afterId = created.id;
      createdIds.push(created.id);
      recordLayerCreation(created, [], { groupId, desc: '動畫：重複指定' });
    }
    if (createdIds.length > 0) await waitForLayerModels(createdIds);
    return createdIds.length > 0;
  };
  /** Rename cels (1, 2, 3...) in timeline appearance order; skips other painters' cels with a notice */
  const renameAnimationCelsInOrder = (folderId: string) => {
    const entries = celEntriesOf(layersRef.current, folderId);
    const plan = planSequentialCelRenames(entries, (id) => {
      const l = entryLayer(id);
      return Boolean(l && canManageLayer(l));
    });
    for (const r of plan.renames) {
      onUpdateLayerProps?.(r.id, { name: r.name });
    }
    if (plan.skippedOthers > 0) {
      warn(`已依序重新命名（略過 ${plan.skippedOthers} 張其他畫師的膠片）。`, 3200);
    }
  };
  /** Jump to previous (-1) or next (+1) transform keyframe */
  const jumpAdjacentKeyframe = (direction: -1 | 1) => {
    const engine = animEngineRef.current;
    if (!engine) return;
    const target = findAdjacentKeyframe(layersRef.current, activeLayerRef.current?.id ?? null, engine.getTime(), direction);
    if (target !== null) engine.goTo(target);
  };
  /** Timeline length in frames, kept on the edited folder; null = up to the end of the longest track */
  const setAnimationLength = (frames: number | null) => {
    if (!animFolder || !canManageLayer(animFolder)) return;
    const withLength = (f: LayerModel, length: number | null) => {
      const animation: NonNullable<LayerMeta['animation']> = { fps: 12, ...f.meta?.animation };
      if (length) animation.length = Math.max(1, Math.min(MAX_TIMELINE_FRAMES, Math.round(length)));
      else delete animation.length;
      onUpdateLayerProps?.(f.id, { meta: { ...f.meta, animation } });
    };
    if (frames) return withLength(animFolder, frames);
    // Back to automatic: every length this painter may change goes
    for (const f of animFolders) if (f.meta?.animation?.length && canManageLayer(f)) withLength(f, null);
  };
  // The light table changed: show (or hide) its cels now
  useEffect(() => {
    const lm = layerManagerRef.current;
    if (lm && animationEngine) lm.syncLayers(displayLayersFor(layersRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightTable, animationEngine]);
  // 原位作畫 started or ended (tool, layer or keyframe panel changed): the layer moves there now
  useEffect(() => {
    const lm = layerManagerRef.current;
    if (lm && isEngineReady) lm.syncLayers(displayLayersFor(layersRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalEditId, isEngineReady]);
  // Playback shows the motion: the 原位作畫 chip hides meanwhile
  useEffect(() => {
    if (!animationEngine) return;
    setAnimPlaying(animationEngine.getIsPlaying());
    return animationEngine.onPlaybackStateChange(setAnimPlaying);
  }, [animationEngine]);
  /** A click on a track: its cel at that frame becomes the active layer (that folder becomes the edited one) */
  const selectAnimationCell = (folderId: string, time: number) => {
    const engine = animationEngine;
    const track = animTracks.find((t) => t.folderId === folderId);
    if (!engine || !track) return;
    const entry = track.entries[entryIndexAt(track.entries, time)];
    skipSelectShownRef.current = true;
    engine.goTo(time);
    skipSelectShownRef.current = false;
    // A reused cel selects the drawing it shows; past the end of the track, the folder itself
    onSelectLayer?.(celLayerOf(entry) ?? folderId);
  };
  /** GIF / video / sequence frames: one segment per distinct picture (held cels become one longer frame, keyframed moves get every step) */
  const planAnimationExport = ({ scope, useRange, range: explicitRange, transparent, useCamera }: AnimationExportPlanRequest): AnimationExportPlan | null => {
    const lm = layerManagerRef.current;
    const engine = animationEngine;
    if (!lm || !engine || !canvas || !animFolder) return null;
    const range = explicitRange ?? (useRange ? engine.getRange() : null);
    const maxFrame = Math.max(0, animTimelineLength - 1);
    const start = Math.max(0, Math.min(maxFrame, range?.start ?? 0));
    const end = Math.max(start, Math.min(maxFrame, range?.end ?? maxFrame));
    const only = scope === 'folder' ? new Set([animFolder.id]) : scope === 'folders' ? new Set(animFolders.map((f) => f.id)) : null;
    const activeCam = useCamera ? findCameraLayer(layersRef.current, { visibleOnly: true }) : null;
    const camMeta = activeCam?.meta?.camera
      ? normalizeCameraMeta(activeCam.meta.camera, canvas.width, canvas.height)
      : null;
    const segments = exportSegments(layersRef.current, start, end, only, canvas.width, canvas.height);
    const bgColor = canvas.bgColor || '#FFFFFF';
    return {
      width: camMeta ? camMeta.width : canvas.width,
      height: camMeta ? camMeta.height : canvas.height,
      bgColor,
      segments,
      render: (time) => {
        // Personal eyes and onion skin never go into a file
        lm.syncLayers(displayLayersFor(layersRef.current, { personal: false, time, only }));
        const fullCanvas = lm.renderCompositeCanvas({ transparent: Boolean(transparent) });
        if (!camMeta || !activeCam) return fullCanvas;
        const evCam = evaluateCameraFrame(
          camMeta,
          activeCam.meta?.keyframes,
          time,
          canvas.width,
          canvas.height
        );
        const camMatrix = computeCameraCanvasToOutputMatrix(
          evCam,
          canvas.width,
          canvas.height,
          camMeta.width,
          camMeta.height
        );
        const framed = renderCameraFrameCanvas(
          fullCanvas,
          camMatrix,
          camMeta.width,
          camMeta.height,
          transparent ? null : bgColor
        );
        fullCanvas.width = 0;
        fullCanvas.height = 0;
        return framed;
      },
      done: () => {
        lm.syncLayers(displayLayersFor(layersRef.current));
        requestRenderRef.current();
      },
    };
  };

  // Phase E1/E3 CRUD helpers (reuse existing layer sync, scoped undo, and room ACL)
  const createCameraLayer = async (meta: CameraFrameMeta) => {
    if (!canvas || isGuest || isCanvasViewer) return;
    const norm = normalizeCameraMeta(meta, canvas.width, canvas.height);
    await createLayerWithUndo(t.animation.camera, 'normal', 'group', null, null, {
      meta: { camera: norm },
      select: false,
    });
  };
  const updateCameraMeta = (meta: CameraFrameMeta) => {
    if (!canvas || !cameraLayer || !canManageLayer(cameraLayer)) return;
    const norm = normalizeCameraMeta(meta, canvas.width, canvas.height);
    onUpdateLayerProps?.(cameraLayer.id, {
      meta: { ...(cameraLayer.meta ?? {}), camera: norm },
    });
  };
  const deleteCameraLayer = async () => {
    if (!cameraLayer || !canManageLayer(cameraLayer)) return;
    if (cameraPreviewActive) setCameraPreviewMode(false);
    await deleteLayerWithUndo(cameraLayer.id);
  };
  const createAudioTrack = async (name: string, meta: AudioTrackMeta) => {
    if (isGuest || isCanvasViewer) return;
    const norm = normalizeAudioTrackMeta(meta);
    await createLayerWithUndo(name || t.animation.audioTrack, 'normal', 'group', null, null, {
      meta: { audio: norm },
      select: false,
    });
  };
  const updateAudioTrack = (layerId: string, patch: { name?: string; meta: AudioTrackMeta }) => {
    const target = layersRef.current.find((l) => l.id === layerId);
    if (!target || !canManageLayer(target)) return;
    onUpdateLayerProps?.(layerId, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      meta: { ...(target.meta ?? {}), audio: normalizeAudioTrackMeta(patch.meta) },
    });
  };
  const toggleAudioTrackMute = (layerId: string) => {
    const target = layersRef.current.find((l) => l.id === layerId);
    if (!target || !target.meta?.audio || !canManageLayer(target)) return;
    const norm = normalizeAudioTrackMeta(target.meta.audio);
    onUpdateLayerProps?.(layerId, {
      meta: { ...(target.meta ?? {}), audio: { ...norm, muted: !norm.muted } },
    });
  };
  const deleteAudioTrack = async (layerId: string) => {
    const target = layersRef.current.find((l) => l.id === layerId);
    if (!target || !canManageLayer(target)) return;
    await deleteLayerWithUndo(layerId);
  };

  /** D4 per-cel export: lists each unique drawn cel (excluding blanks and timeline repeats) and renders it isolated in drawn coordinates */
  const planCelExport = ({ folderIds }: { folderIds: string[] }): AnimationCelExportPlan | null => {
    const lm = layerManagerRef.current;
    if (!lm || !canvas) return null;
    const selectedFolders = new Set(folderIds);
    const allLayers = layersRef.current;
    const folders = animFolders.filter((f) => selectedFolders.has(f.id));
    const items: AnimationCelExportItem[] = [];
    for (const folder of folders) {
      const cels = allLayers
        .filter((l) => l.parentId === folder.id && l.layerType !== 'mask' && l.meta?.cel?.ref === undefined)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      for (const cel of cels) {
        items.push({
          folderId: folder.id,
          folderName: folder.name,
          celId: cel.id,
          celName: cel.name,
        });
      }
    }
    if (items.length === 0) return null;

    const celFolderMap = new Map(items.map((it) => [it.celId, it.folderId]));
    return {
      width: canvas.width,
      height: canvas.height,
      items,
      renderCel: (celId) => {
        const folderId = celFolderMap.get(celId);
        const keepIds = new Set<string>([celId]);
        if (folderId) keepIds.add(folderId);
        let grew = true;
        while (grew) {
          grew = false;
          for (const l of allLayers) {
            if (keepIds.has(l.id)) continue;
            if (l.parentId && keepIds.has(l.parentId)) {
              // Inside the animation folder, only keep the target cel (and any mask directly on the folder)
              if (l.parentId === folderId && l.id !== celId && l.layerType !== 'mask') continue;
              keepIds.add(l.id);
              grew = true;
            }
          }
        }
        const isolated = allLayers.map((l) => {
          if (l.id === folderId) return { ...l, isVisible: true, opacity: 1 };
          if (l.id === celId) return { ...l, isVisible: true };
          if (keepIds.has(l.id)) return { ...l };
          return { ...l, isVisible: false };
        });
        lm.syncLayers(isolated);
        return lm.renderCompositeCanvas({ transparent: true });
      },
      done: () => {
        lm.syncLayers(displayLayersFor(layersRef.current));
        requestRenderRef.current();
      },
    };
  };

  // ---------- Layer structure: merge down, group ----------
  const canManageLayer = (l: LayerModel) => !isGuest && !isCanvasViewer && l.ownerId === user?.id;

  const updateLayerKeyframes = (layerId: string, keyframes: TransformKeyframe[]) => {
    const target = layersRef.current.find((l) => l.id === layerId);
    if (!target || !canManageLayer(target)) return;
    const metaBefore: LayerMeta | null = target.meta ?? null;
    const metaAfter: LayerMeta = { ...(target.meta ?? {}), keyframes };
    scopedUndoRef.current.push({
      opId: `op_kf_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      userId: userRef.current?.id || user?.id || 'guest',
      layerId,
      opType: 'TRANSFORM',
      beforeTiles: [],
      afterTiles: [],
      metaBefore,
      metaAfter,
      timestamp: Date.now(),
      desc: '關鍵影格變換',
    });
    updateUndoRedoState();
    onUpdateLayerProps?.(layerId, { meta: metaAfter });
  };

  const handleKeyframePreviewChange = (next: EvaluatedTransform | null) => {
    const layer = activeLayerRef.current;
    const preview = next && layer ? { layerId: layer.id, frame: animFrame, evaluated: next } : null;
    liveKeyframePreviewRef.current = preview;
    setLiveKeyframePreview(preview);
    const lm = layerManagerRef.current;
    if (lm) {
      lm.syncLayers(displayLayersFor(layersRef.current));
      requestRenderRef.current();
    }
  };

  useEffect(() => {
    if (!liveKeyframePreviewRef.current) return;
    liveKeyframePreviewRef.current = null;
    setLiveKeyframePreview(null);
  }, [activeLayer?.id, animFrame, keyframePanelOpen, isAnimationTimelineOpen, animPlaying]);
  /** 向下合併: the layer (with its opacity, blend mode and mask) is drawn into the one below, then removed */
  const mergeDown = (layerId: string) => {
    const ls = layersRef.current;
    const top = ls.find((l) => l.id === layerId);
    const lm = layerManagerRef.current;
    const te = tileEngineRef.current;
    const renderer = pixiAppRef.current?.renderer;
    if (!top || !lm || !te || !renderer) return;
    const siblings = ls.filter((l) => l.layerType !== 'mask' && (l.parentId ?? null) === (top.parentId ?? null)).sort((a, b) => a.sortOrder - b.sortOrder);
    const below = siblings[siblings.indexOf(top) - 1];
    if (top.layerType === 'group' || top.layerType === 'mask') return warn('請選一般圖層再向下合併。');
    if (!below || below.layerType === 'group') return warn('下面沒有可以合併的圖層。');
    if (below.layerType === 'text' || below.layerType === 'vector') return warn('下面是文字／向量圖層，請先點陣化再合併。');
    if (!canManageLayer(top) || !canManageLayer(below)) return warn('不能合併別人的圖層。');
    const topItem = lm.getLayerItem(top.id);
    const belowItem = lm.getLayerItem(below.id);
    if (!topItem || !belowItem) return;
    // The layer below changes only where the merged layer has tiles (all of them if that is unknown)
    const coords = lm.occupiedTiles(top.id) ?? te.getAllTileCoords();
    // Everything needed to bring the merged layer back on undo
    const topMask = ls.find((m) => m.layerType === 'mask' && m.parentId === top.id);
    const topMaskItem = topMask && lm.getLayerItem(topMask.id);
    const removed = {
      model: top,
      tiles: tilesAsync(lm, top.id, coords),
      mask: topMask && topMaskItem ? { model: topMask, tiles: tilesAsync(lm, topMask.id, te.getAllTileCoords()) } : undefined,
    };
    // Reads of everything involved are queued around the merge (none stalls the page); the undo entry and the
    // patch go out in order once they are compressed
    const diff = diffTilesAsync(lm, below.id, coords, () => {
    if (top.isVisible) {
      lm.syncPingPong(below.id); // clipping samples this copy, never the texture being drawn into
      const holder = new Container();
      const sprite = new Sprite(topItem.renderTexture);
      sprite.alpha = Math.max(0, Math.min(1, top.opacity));
      const mode = lm.mapPixiBlendMode(top.blendMode);
      sprite.blendMode = mode;
      const filters: Filter[] = [];
      const helper = (texture: Texture) => {
        const s = new Sprite(texture);
        s.renderable = false;
        holder.addChild(s);
        return s;
      };
      // As drawn on screen: its mask (inverted or not), and clipped to the layer it merges into
      if (topMask?.isVisible && topMaskItem) filters.push(new MaskFilter({ sprite: helper(topMaskItem.renderTexture), inverse: Boolean(topMask.meta?.maskInverted) }));
      if (top.clipToBelow) filters.push(new MaskFilter({ sprite: helper(belowItem.pingPongTexture), channel: 'alpha' }));
      // With filters the blend must act on their output (else multiply + mask merged as black)
      if (filters.length && mode !== 'normal') {
        filters.push(lm.createBlendFilter(mode));
        sprite.blendMode = 'normal';
      }
      if (filters.length) sprite.filters = filters;
      holder.addChild(sprite);
      renderer.render({ container: holder, target: belowItem.renderTexture, clear: false });
      filters.forEach((f) => f.destroy());
      holder.destroy({ children: true });
      requestRenderRef.current();
    }
    });
    lm.syncPingPong(below.id); // queued after the reads: the next edit's baseline
    commitInOrder(Promise.all([diff, removed.tiles, removed.mask?.tiles ?? Promise.resolve(null)]), ([{ beforeTiles, afterTiles }, removedTiles, removedMask]) => {
      scopedUndoRef.current.push({
        opId: `op_merge_${Date.now()}`,
        userId: userRef.current?.id || 'guest',
        layerId: below.id,
        opType: 'STROKE',
        beforeTiles,
        afterTiles,
        timestamp: Date.now(),
        desc: '向下合併',
        layerRemoved: { model: removed.model, tiles: removedTiles, mask: removed.mask && removedMask ? { model: removed.mask.model, tiles: removedMask } : undefined },
      });
      updateUndoRedoState();
      commitTilePatch(below.id, afterTiles, false, '向下合併', true);
    });
    onDeleteLayer?.(top.id);
    onSelectLayer?.(below.id);
  };
  /** 群組: a new group (inside the layers' common group, so groups nest) holding these layers */
  const groupLayers = async (ids: string[]) => {
    const current = tidyLayerModels(layersRef.current).layers;
    const ls = filterTopLevelSelectedLayers(current, ids);
    if (!ls.length || !onCreateLayer) return;
    const blocked = ls.filter((l) => !canManageLayer(l));
    if (blocked.length) return warn(`不能群組別人的圖層：${blocked.map((b) => b.name).join('、')}`);
    const parents = new Set(ls.map((l) => l.parentId ?? null));
    const parent = parents.size === 1 ? [...parents][0] : null;
    const top = ls[ls.length - 1];
    const anchor = findTopAnchorForParent(current, top, parent);
    // Ctrl+Z ungroups (the group goes, the layers stay)
    const group = await createLayerWithUndo(nextGroupName(current), 'normal', 'group', anchor.id, parent, { select: false });
    if (!group) return;
    const selectedRootIds = new Set(ls.map((l) => l.id));
    const ascendingIds = computeGroupedAscendingNonMaskIds(current, group, anchor.id, parent, selectedRootIds);
    const preLoopWithGroup = [...current, { ...group, parentId: parent, sortOrder: anchor.sortOrder + 5 }];
    for (const l of orderLayersForReparenting(preLoopWithGroup, ls, group.id)) {
      await Promise.resolve(onUpdateLayerProps?.(l.id, { parentId: group.id }));
    }
    await Promise.resolve(onReorderLayer?.(group.id, 0, ascendingIds));
    onSelectLayer?.(group.id);
  };

  // ---------- Layer copy / paste (kept for this browser tab, so it also pastes into another canvas) ----------
  /** 複製圖層: pixels, properties, mask, text / vector source, and a group's whole content */
  const copyLayers = (ids: string[]) => {
    const ls = layersRef.current;
    const lm = layerManagerRef.current;
    const te = tileEngineRef.current;
    if (!lm || !te || !canvas) return;
    // Every layer's tiles are read without stalling (queued now: they hold the pixels as of this moment)
    const snap = async (l: LayerModel): Promise<CopiedLayer> => {
      const ls = layersRef.current;
      const base = await snapshotLayerContent(l);
      const children = l.layerType === 'group' ? await Promise.all(ls.filter((c) => c.parentId === l.id && c.layerType !== 'mask').sort((a, b) => a.sortOrder - b.sortOrder).map(snap)) : [];
      return { ...base, children };
    };
    const picked = ls.filter((l) => ids.includes(l.id) && l.layerType !== 'mask');
    // A picked group brings its children: do not copy them twice
    const roots = picked.filter((l) => !picked.some((p) => p.id === l.parentId)).sort((a, b) => a.sortOrder - b.sortOrder);
    if (!roots.length) return;
    const size = { width: canvas.width, height: canvas.height };
    // 製作圖層副本 pastes right after copying: paste waits for this
    pendingCopyRef.current = Promise.all(roots.map(snap)).then((items) => {
    layerClipboard = { items, ...size };
    const kept = keepsLayerClipboard() && saveLayerClipboard(layerClipboard);
    warn(
      keepsLayerClipboard() && !kept
        ? `已複製 ${roots.length} 個圖層；內容太大，存不進瀏覽器（約 5MB 上限），重新整理後就沒了`
        : `已複製 ${roots.length} 個圖層（Ctrl+Alt+V 貼上，可以貼到其他畫布${kept ? '，重新整理後也還在' : ''}）`,
      kept || !keepsLayerClipboard() ? 2500 : 4500
    );
    }).catch((err) => warn(`複製圖層失敗：${String(err)}`)).finally(() => { pendingCopyRef.current = null; });
  };
  const pendingCopyRef = useRef<Promise<void> | null>(null);
  const [keepLayerClipboard, setKeepLayerClipboard] = useState(keepsLayerClipboard);
  const toggleKeepLayerClipboard = () => {
    const next = !keepLayerClipboard;
    try {
      localStorage.setItem(KEEP_CLIPBOARD_KEY, next ? '1' : '0');
    } catch {
      return warn('這個瀏覽器不能保存資料（私密模式？）。');
    }
    setKeepLayerClipboard(next);
    if (!next) saveLayerClipboard(null);
    else if (layerClipboard && !saveLayerClipboard(layerClipboard)) warn('目前複製的圖層太大，存不進瀏覽器（約 5MB 上限）。', 4000);
  };
  /** 貼上圖層: new layers of this painter, right above the active layer, in its group */
  const pasteLayers = async () => {
    // The paste ends by selecting what it made, unless the painter picked another layer meanwhile
    const selectedAtStart = activeLayerRef.current?.id ?? null;
    if (pendingCopyRef.current) await pendingCopyRef.current;
    const clip = layerClipboard ?? (layerClipboard = loadLayerClipboard());
    const te = tileEngineRef.current;
    if (!clip || !onCreateLayer || !te || !canvas) return warn('還沒有複製任何圖層。');
    if (isGuest) return warn('訪客不能貼上圖層，請先登入。');
    if (isCanvasViewer) return warn(t.collab.viewerReadOnlyWarn);
    let anchor = activeLayerRef.current;
    let insertionAbove: string | undefined;
    if (anchor?.layerType === 'mask') anchor = layersRef.current.find((l) => l.id === anchor!.parentId) ?? null;
    while (anchor) {
      const cel = celOfLayer(layersRef.current, anchor.id);
      if (!cel) break;
      anchor = layersRef.current.find((l) => l.id === cel.folderId) ?? null;
    }
    if (anchor && isAnimationFolder(anchor)) {
      const byId = new Map(layersRef.current.map((l) => [l.id, l]));
      const folder = anchor;
      const lastInFolder = layersRef.current.reduce((last, layer) => {
        if (layer.sortOrder <= last.sortOrder) return last;
        for (let parentId = layer.parentId; parentId; parentId = byId.get(parentId)?.parentId ?? null) {
          if (parentId === folder.id) return layer;
        }
        return last;
      }, folder);
      // The folder and its descendants share one global sort order.
      insertionAbove = lastInFolder.id;
    }
    const resized = clip.width !== canvas.width || clip.height !== canvas.height;
    const fits = (tiles: TileData[]) => (resized ? tiles.filter((t) => t.col * 256 < canvas.width && t.row * 256 < canvas.height) : tiles);
    const paste = async (c: CopiedLayer, above: string | null, parentId: string | null): Promise<string | null> => {
      const m = c.model;
      const created = await onCreateLayer(m.layerType === 'group' ? m.name : `${m.name} 複製`, m.blendMode, m.layerType, above, parentId, { meta: m.meta ?? null, select: false });
      if (!created) return null;
      const props: Partial<LayerModel> = {};
      for (const k of ['opacity', 'isVisible', 'clipToBelow', 'alphaLocked'] as const) if (created[k] !== m[k]) (props as any)[k] = m[k];
      if (Object.keys(props).length) onUpdateLayerProps?.(created.id, props);
      if (m.layerType === 'group') {
        let prev: string | null = null;
        for (const child of c.children) prev = (await paste(child, prev ?? created.id, created.id)) ?? prev;
        // The group sits above its children, as everywhere else
        if (prev) {
          const asc = [...layersRef.current].sort((a, b) => a.sortOrder - b.sortOrder).map((l) => l.id).filter((id) => id !== created.id);
          asc.splice(asc.indexOf(prev) + 1, 0, created.id);
          onReorderLayer?.(created.id, 0, asc);
        }
      } else {
        const item = await waitForLayerItem(created.id);
        const tiles = fits(c.tiles);
        if (item && tiles.length) {
          te.applyTileBatch(item.renderTexture, tiles);
          if (c.strokes?.length) {
            const payload = { tiles, vectorRemovedIds: [], vectorAdded: c.strokes.map((s) => ({ ...s, id: crypto.randomUUID(), layerId: created.id })) };
            applyVectorPayload(created.id, payload);
            commitOp(created.id, 'VECTOR_EDIT', payload);
          } else {
            commitTilePatch(created.id, tiles, false, '貼上圖層');
          }
        }
        scopedUndoRef.current.push({
          opId: `op_paste_layer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          userId: userRef.current?.id || user?.id || 'guest',
          layerId: created.id,
          opType: 'STROKE',
          beforeTiles: [],
          afterTiles: tiles,
          timestamp: Date.now(),
          desc: '貼上圖層',
          layerCreated: { model: created },
        });
        updateUndoRedoState();
      }
      if (c.mask) {
        const mk = await onCreateLayer(c.mask.model.name, 'normal', 'mask', created.id, created.id, { meta: c.mask.model.meta ?? null, select: false });
        const mItem = mk && (await waitForLayerItem(mk.id));
        if (mk && mItem) {
          te.applyTileBatch(mItem.renderTexture, fits(c.mask.tiles));
          commitTilePatch(mk.id, fits(c.mask.tiles), false, '貼上圖層蒙版');
          if (!c.mask.model.isVisible) onUpdateLayerProps?.(mk.id, { isVisible: false });
        }
      }
      return created.id;
    };
    let above = insertionAbove ?? anchor?.id ?? null;
    let last: string | null = null;
    for (const c of clip.items) {
      last = (await paste(c, above, anchor?.parentId ?? null)) ?? last;
      above = last ?? above;
    }
    if (last && (activeLayerRef.current?.id ?? null) === selectedAtStart) onSelectLayer?.(last);
    if (resized) warn('畫布尺寸不同：超出這張畫布的部分沒有貼上。', 3000);
  };

  shortcutActionsRef.current.mergeDown = mergeDown;
  shortcutActionsRef.current.groupLayers = groupLayers;
  shortcutActionsRef.current.copyLayers = copyLayers;
  shortcutActionsRef.current.pasteLayers = pasteLayers;
  shortcutActionsRef.current.animAddCel = addAnimationFrame;
  shortcutActionsRef.current.animAddBlank = addBlankAnimationFrame;
  shortcutActionsRef.current.animJumpKeyframe = jumpAdjacentKeyframe;

  // ---------- 匯入圖片 (drop on the canvas or the layer list, 檔案 → 匯入圖片) ----------
  /** aboveId / parentId for onCreateLayer; an undefined parent lets App pick it from the active layer, as 新增圖層 does */
  const importPlacement = (target?: ImageDropTarget): { aboveId: string | null; parentId: string | null | undefined; toBottom: boolean } => {
    const ls = layersRef.current;
    const byId = new Map(ls.map((l) => [l.id, l]));
    if (!target) {
      let anchor = activeLayerRef.current;
      if (anchor?.layerType === 'mask') anchor = (anchor.parentId && byId.get(anchor.parentId)) || null;
      return { aboveId: anchor?.id ?? null, parentId: undefined, toBottom: false };
    }
    const t = target.layerId ? byId.get(target.layerId) : undefined;
    if (!t) return { aboveId: null, parentId: null, toBottom: true }; // under every row
    const isInside = (l: LayerModel, ancestorId: string) => {
      for (let p = l.parentId; p; p = byId.get(p)?.parentId ?? null) if (p === ancestorId) return true;
      return false;
    };
    const top = (list: LayerModel[]) => [...list].sort((a, b) => b.sortOrder - a.sortOrder)[0];
    const highestBelow = (sortOrder: number) => top(ls.filter((l) => l.sortOrder < sortOrder)) ?? null;
    let aboveId: string | null;
    let parentId: string | null;
    if (target.pos === 'inside' && t.layerType === 'group') {
      // Top of the group: right under it (its children sit below it)
      parentId = t.id;
      aboveId = highestBelow(t.sortOrder)?.id ?? null;
    } else if (target.pos === 'below') {
      parentId = t.parentId ?? null;
      const lowest = Math.min(t.sortOrder, ...ls.filter((l) => isInside(l, t.id)).map((l) => l.sortOrder));
      aboveId = highestBelow(lowest)?.id ?? null;
    } else {
      parentId = t.parentId ?? null;
      aboveId = top([t, ...ls.filter((l) => l.parentId === t.id && l.layerType === 'mask')]).id; // above the row and its mask
    }
    // The server refuses children in other painters' groups (shared animation folders excepted): step out to one we may use
    const mayAddInto = folderAccess.canAdd;
    let leftGroup: LayerModel | undefined;
    for (let g = parentId ? byId.get(parentId) : undefined; g && !mayAddInto(g); g = g.parentId ? byId.get(g.parentId) : undefined) leftGroup = g;
    if (leftGroup) {
      const left = leftGroup;
      return { aboveId: top([left, ...ls.filter((l) => isInside(l, left.id))]).id, parentId: left.parentId ?? null, toBottom: false };
    }
    return { aboveId, parentId, toBottom: aboveId === null };
  };

  /** Draws the picture into its new layer; the undo step takes the whole layer away (redo brings it back with the picture) */
  const stampImportedImage = (layer: LayerModel, item: NonNullable<Awaited<ReturnType<typeof waitForLayerItem>>>, source: HTMLCanvasElement, x: number, y: number) => {
    const te = tileEngineRef.current!;
    const lm = layerManagerRef.current!;
    const coords = te.getDirtyTilesForBounds(x, y, x + source.width, y + source.height);
    const diff = diffTilesAsync(lm, layer.id, coords, () => te.stampCanvas(item.renderTexture, source, x, y));
    lm.syncPingPong(layer.id);
    const userId = userRef.current?.id || user?.id || 'guest';
    commitInOrder(diff, ({ beforeTiles, afterTiles }) => {
      scopedUndoRef.current.push({
        opId: `op_import_image_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        userId,
        layerId: layer.id,
        opType: 'STROKE',
        beforeTiles,
        afterTiles,
        timestamp: Date.now(),
        desc: '匯入圖片',
        layerCreated: { model: layer },
      });
      updateUndoRedoState();
      commitTilePatch(layer.id, afterTiles, false, '匯入圖片', true, beforeTiles);
    });
    return diff;
  };

  const importingRef = useRef(false);
  /**
   * Each image becomes a new layer of this painter, centred on `at` (a screen point) or on the view,
   * scaled down to fit the canvas. A single image then sits in the transform box (Enter / Esc both keep it).
   */
  const importImages = async (dropped: DroppedImages, opts: { at?: { x: number; y: number }; target?: ImageDropTarget } = {}) => {
    const lm = layerManagerRef.current;
    if (!canvas || !onCreateLayer || !lm || !tileEngineRef.current) return;
    if (isGuest) return warn('訪客不能匯入圖片，請先登入。');
    if (isCanvasViewer) return warn(t.collab.viewerReadOnlyWarn);
    const { entries, skipped, tooMany } = imageEntries(dropped);
    if (!entries.length) return warn(skipped ? '只能匯入圖片檔（PNG、JPG、WebP、GIF、SVG…）。' : '沒有可匯入的圖片。');
    if (transformLayerIdRef.current) return warn('請先按 Enter 確定或 Esc 取消目前的變形，再匯入圖片。', 3500);
    if (textEdit) return warn('請先完成文字輸入，再匯入圖片。');
    if (importingRef.current) return warn('上一批圖片還在匯入中。');
    importingRef.current = true;
    try {
      const screen = opts.at ?? getViewCenter();
      const c = screen && viewportRef.current ? viewportRef.current.screenToCanvas(screen.x, screen.y) : { x: canvas.width / 2, y: canvas.height / 2 };
      let { aboveId, parentId, toBottom } = importPlacement(opts.target);
      let failed = 0;
      let fromWeb = false;
      let last: { layer: LayerModel; stamped: Promise<unknown> } | null = null;
      for (const entry of entries) {
        let source: HTMLCanvasElement;
        try {
          source = await loadImageEntry(entry, canvas.width, canvas.height);
        } catch (err) {
          failed++;
          if (err instanceof ImageImportError && err.fromWeb) fromWeb = true;
          continue;
        }
        if (layerManagerRef.current !== lm) return; // switched canvas meanwhile
        const created = (await onCreateLayer(entry.name, 'normal', 'raster', aboveId, parentId)) || null;
        const item = created && (await waitForLayerItem(created.id));
        if (!created || !item || layerManagerRef.current !== lm) break;
        let undoModel = created;
        if (toBottom) {
          const others = layersRef.current.filter((l) => l.id !== created.id);
          const asc = [...others].sort((a, b) => a.sortOrder - b.sortOrder).map((l) => l.id);
          await onReorderLayer?.(created.id, 0, [created.id, ...asc]);
          // Redo puts the layer back by its sortOrder: remember it under every layer, not on top where it was made
          if (others.length) undoModel = { ...created, sortOrder: Math.min(...others.map((l) => l.sortOrder)) - 1 };
          toBottom = false;
        }
        const x = Math.max(0, Math.min(canvas.width - source.width, Math.round(c.x - source.width / 2)));
        const y = Math.max(0, Math.min(canvas.height - source.height, Math.round(c.y - source.height / 2)));
        last = { layer: created, stamped: stampImportedImage(undoModel, item, source, x, y) };
        // The next picture goes right on top of this one, in the same group
        aboveId = created.id;
        parentId = created.parentId ?? null;
      }
      if (last && entries.length === 1) {
        await last.stamped.catch(() => {});
        const fresh = layersRef.current.find((l) => l.id === last!.layer.id);
        if (fresh && activeLayerRef.current?.id === fresh.id && !transformLayerIdRef.current) void startTransformMode('transform', fresh);
      }
      const notes = [
        failed ? (fromWeb ? '網頁圖片讀不到（對方網站不允許），請先存到電腦再拖進來。' : `${failed} 張圖片無法讀取。`) : '',
        skipped ? `略過 ${skipped} 個非圖片檔。` : '',
        tooMany ? `一次最多 ${entries.length} 張，其餘沒有匯入。` : '',
      ].filter(Boolean);
      if (notes.length) warn(notes.join(' '), 4500);
    } finally {
      importingRef.current = false;
    }
  };
  const importImagesRef = useRef(importImages);
  importImagesRef.current = importImages;
  useEffect(() => {
    if (importImagesRequest?.files.length) void importImagesRef.current({ files: importImagesRequest.files, url: null });
  }, [importImagesRequest?.id]);

  const applyPluginAction: CanvasPluginAccess['apply'] = async (action) => {
    const manager = layerManagerRef.current;
    if (!canvas || !manager || transformLayerIdRef.current || textEdit || importingRef.current) return false;
    if (action.kind === 'brush') {
      if (currentTool !== 'brush' && currentTool !== 'pencil' && currentTool !== 'eraser') return false;
      handleBrushPropsChange({
        ...(action.color === undefined ? {} : { color: action.color }),
        ...(action.size === undefined ? {} : { size: action.size }),
      });
      return true;
    }
    if (isGuest || isCanvasViewer || !onCreateLayer) return false;
    if (action.kind === 'layer') return Boolean(await onCreateLayer(action.name, 'normal', 'raster'));

    const source = document.createElement('canvas');
    source.width = action.width;
    source.height = action.height;
    const ctx = source.getContext('2d');
    if (!ctx || source.width > canvas.width || source.height > canvas.height) return false;
    for (const shape of action.shapes) {
      ctx.fillStyle = shape.color;
      if (shape.kind === 'rect') {
        ctx.fillRect(shape.x, shape.y, shape.width, shape.height);
      } else {
        ctx.beginPath();
        ctx.ellipse(shape.x + shape.width / 2, shape.y + shape.height / 2, shape.width / 2, shape.height / 2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const layer = await onCreateLayer(action.name, 'normal', 'raster');
    const item = layer && await waitForLayerItem(layer.id);
    if (!layer || !item || layerManagerRef.current !== manager) return false;
    await stampImportedImage(layer, item, source, Math.floor((canvas.width - source.width) / 2), Math.floor((canvas.height - source.height) / 2));
    return true;
  };
  const pluginActionRef = useRef(applyPluginAction);
  pluginActionRef.current = applyPluginAction;

  const createPluginHostAdapter = (): { adapter: PluginCanvasHostAdapter; manager: LayerManager } => {
    const manager = layerManagerRef.current;
    const tileEngine = tileEngineRef.current;
    if (!canvas || !manager || !tileEngine || transformLayerIdRef.current || textEdit || importingRef.current) {
      throw new Error('Canvas is busy or unavailable.');
    }

    // Snapshot-augmented layer view so multi-step create/update/reorder/delete within a single run
    // sees immediate changes even before React commits state updates.
    const liveOverlay = new Map<string, LayerModel>();
    const deletedOverlay = new Set<string>();
    const getOverlayLayers = (): LayerModel[] => {
      const merged = new Map<string, LayerModel>();
      for (const l of layersRef.current) {
        if (!deletedOverlay.has(l.id)) merged.set(l.id, l);
      }
      for (const [id, l] of liveOverlay.entries()) {
        if (!deletedOverlay.has(id)) merged.set(id, l);
      }
      return [...merged.values()];
    };

    const validRole = resolveCurrentCanvasRole();
    const caps = validRole ? getCanvasRoleCapabilities(validRole) : null;
    const canvasMember = validRole && caps && userRef.current
      ? {
          canvasId: canvas.id,
          userId: userRef.current.id,
          role: validRole,
          ...caps,
          joinedAt: 0,
        }
      : null;

    const timelineBridge: PluginTimelineBridge = {
      getFps: () => animEngineRef.current?.getFps() ?? animFolder?.meta?.animation?.fps ?? 12,
      getLength: () => animEngineRef.current?.getLength() ?? animTimelineLength,
      getCurrentFrame: () => animEngineRef.current?.getTime() ?? animFrame,
      getIsPlaying: () => animEngineRef.current?.getIsPlaying() ?? animPlaying,
      getLoop: () => animEngineRef.current?.getLoop() ?? true,
      getRange: () => animEngineRef.current?.getRange() ?? null,
      setCurrentFrame: (frame) => {
        const engine = animEngineRef.current;
        if (engine) {
          engine.goTo(frame);
        } else {
          setAnimFrame(frame);
        }
      },
      setLoop: (loop) => {
        animEngineRef.current?.setLoop(loop);
      },
      setRange: (range) => {
        animEngineRef.current?.setRange(range);
      },
    };

    const readBrushState = (): PluginBrushState => {
      const b = brushPropsRef.current ?? brushProps;
      return {
        color: b.color,
        ...(b.secondaryColor !== undefined ? { secondaryColor: b.secondaryColor } : {}),
        size: b.size,
        minSize: b.minSize,
        opacity: b.opacity,
        flow: b.flow,
        hardness: b.hardness,
        spacing: b.spacing,
        scatter: b.scatter,
        ...(b.roundness !== undefined ? { roundness: b.roundness } : {}),
        ...(b.tipAngle !== undefined ? { tipAngle: b.tipAngle } : {}),
        ...(b.angleMode !== undefined ? { angleMode: b.angleMode } : {}),
        ...(b.tiltSize !== undefined ? { tiltSize: b.tiltSize } : {}),
        isEraser: b.isEraser,
        ...(b.mixMode !== undefined ? { mixMode: b.mixMode } : {}),
        ...(b.colorMixing !== undefined ? { colorMixing: b.colorMixing } : {}),
        ...(b.paintAmount !== undefined ? { paintAmount: b.paintAmount } : {}),
        ...(b.colorStretch !== undefined ? { colorStretch: b.colorStretch } : {}),
        ...(b.fgBgMix !== undefined ? { fgBgMix: b.fgBgMix } : {}),
        ...(b.wetEdges !== undefined ? { wetEdges: b.wetEdges } : {}),
        ...(b.hueJitter !== undefined ? { hueJitter: b.hueJitter } : {}),
        ...(b.satJitter !== undefined ? { satJitter: b.satJitter } : {}),
        ...(b.valJitter !== undefined ? { valJitter: b.valJitter } : {}),
        ...(b.textureDensity !== undefined ? { textureDensity: b.textureDensity } : {}),
        ...(b.textureScale !== undefined ? { textureScale: b.textureScale } : {}),
        ...(b.textureInvert !== undefined ? { textureInvert: b.textureInvert } : {}),
        ...(b.textureBlendMode !== undefined ? { textureBlendMode: b.textureBlendMode } : {}),
        ...(b.dualBrush !== undefined ? { dualBrush: b.dualBrush } : {}),
        ...(b.dualSize !== undefined ? { dualSize: b.dualSize } : {}),
        ...(b.dualScatter !== undefined ? { dualScatter: b.dualScatter } : {}),
        ...(b.dualBlendMode !== undefined ? { dualBlendMode: b.dualBlendMode } : {}),
        ...(b.dynamics !== undefined ? { dynamics: structuredClone(b.dynamics) } : {}),
      };
    };

    const applyBrushPatch = (patch: PluginBrushPatch) => {
      const safePatch: Partial<BrushProperties> = { ...patch };
      delete (safePatch as Partial<BrushProperties>).stabilizerLevel;
      handleBrushPropsChange(safePatch);
    };

    const adapter: PluginCanvasHostAdapter = {
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      tileSize: DEFAULT_TILE_SIZE,
      acl: {
        user: userRef.current ?? user ?? null,
        isGuest,
        canvasMember,
      },
      getLayers: getOverlayLayers,
      getActiveLayerId: () => activeLayerRef.current?.id ?? null,
      setActiveLayer: (layerId) => {
        onSelectLayer?.(layerId);
      },
      getBrush: readBrushState,
      setBrush: applyBrushPatch,
      createLayer: async (opts) => {
        if (!onCreateLayer) return null;
        const created = await onCreateLayer(
          opts.name,
          opts.blendMode,
          opts.layerType,
          opts.aboveLayerId,
          opts.parentId,
          { select: opts.select },
        );
        if (!created) return null;
        const withProps: LayerModel = { ...created, opacity: opts.opacity };
        if (opts.opacity !== 1) {
          await onUpdateLayerProps?.(created.id, { opacity: opts.opacity });
        }
        liveOverlay.set(created.id, withProps);
        deletedOverlay.delete(created.id);
        await waitForLayerItem(created.id);
        return withProps;
      },
      updateLayerProps: async (layerId, patch) => {
        await onUpdateLayerProps?.(layerId, patch);
        const existing = getOverlayLayers().find((l) => l.id === layerId);
        if (existing) liveOverlay.set(layerId, { ...existing, ...patch });
      },
      reorderLayers: async (layerId, ascendingIds, parentIdPatch) => {
        if (parentIdPatch !== undefined) {
          await onUpdateLayerProps?.(layerId, { parentId: parentIdPatch });
          const existing = getOverlayLayers().find((l) => l.id === layerId);
          if (existing) liveOverlay.set(layerId, { ...existing, parentId: parentIdPatch });
        }
        await onReorderLayer?.(layerId, 0, ascendingIds);
        ascendingIds.forEach((id, idx) => {
          const existing = getOverlayLayers().find((l) => l.id === id);
          if (existing) liveOverlay.set(id, { ...existing, sortOrder: (idx + 1) * 10 });
        });
      },
      deleteLayer: async (layerId, opts) => {
        const res = await onDeleteLayer?.(layerId, opts);
        if (res === false) return false;
        deletedOverlay.add(layerId);
        liveOverlay.delete(layerId);
        return true;
      },
      restoreDeletedLayer: async (model, tiles, belowId) => {
        const restored = await recreateLayer(model, tiles, undefined, belowId ?? undefined);
        if (restored) {
          deletedOverlay.delete(restored.id);
          liveOverlay.set(restored.id, restored);
        }
        return restored;
      },
      getOccupiedTiles: (layerId) => manager.occupiedTiles(layerId),
      readLayerTile: async (layerId, col, row) => {
        const tx = col * DEFAULT_TILE_SIZE;
        const ty = row * DEFAULT_TILE_SIZE;
        const w = Math.min(DEFAULT_TILE_SIZE, canvas.width - tx);
        const h = Math.min(DEFAULT_TILE_SIZE, canvas.height - ty);
        const [buf] = await manager.readAsync(layerId, [{ x: tx, y: ty, w, h }], 'after');
        return buf ?? new Uint8Array(w * h * 4);
      },
      readLayerRect: async (layerId, rect) => {
        const [buf] = await manager.readAsync(layerId, [{ x: rect.x, y: rect.y, w: rect.width, h: rect.height }], 'after');
        return buf ?? new Uint8Array(rect.width * rect.height * 4);
      },
      readCompositeRect: async (rect, includeBackground) => {
        const tex = manager.getCompositeTexture(includeBackground);
        const [buf] = await tileEngine.readRegionsAsync(tex, [{ x: rect.x, y: rect.y, w: rect.width, h: rect.height }]);
        return buf ?? new Uint8Array(rect.width * rect.height * 4);
      },
      applyLayerTiles: (layerId, tiles) => {
        manager.applyTiles(layerId, tiles);
        requestRenderRef.current();
      },
      commitTilePatch: (layerId, tiles, desc, beforeTiles) => {
        commitTilePatch(layerId, tiles, false, desc, false, beforeTiles);
      },
      pushUndoOp: (op) => {
        scopedUndoRef.current.push(op);
      },
      onTransactionCommitted: () => {
        updateUndoRedoState();
        requestRenderRef.current();
      },
      selection: selectionEngineRef.current
        ? createSelectionEngineBridge(selectionEngineRef.current, () => selection.refreshSelection())
        : undefined,
      timeline: timelineBridge,
    };

    return { adapter, manager };
  };

  const runPluginV2 = async (
    plugin: PluginManifestModern,
    invocation:
      | { kind: 'command'; commandId: string }
      | { kind: 'panel'; panelId: string; actionId: string; values: Record<string, unknown> },
    options?: { onSlowStart?: () => void; signal?: AbortSignal },
  ): Promise<PluginV2Result> => {
    const { adapter, manager } = createPluginHostAdapter();

    const tx = new PluginCanvasTransaction(adapter, { pluginId: plugin.id });
    const { startPluginCommandV2, startPluginPanelActionV2 } = await import('../plugins/runPlugin');
    const ctx = {
      width: canvas!.width,
      height: canvas!.height,
      dpi: clampDpi(canvas!.dpi ?? 300),
      tileSize: DEFAULT_TILE_SIZE,
    };

    const isCollaborativeRoom = !OfflineSessionStore.isOfflineCanvas(canvas?.id);
    const v3Handler = createPluginV3RpcHandler({
      manifest: plugin,
      isCollaborativeRoom,
      signal: options?.signal,
    });
    const rpcHandler = tx.createRpcHandler(v3Handler);

    const handle = invocation.kind === 'command'
      ? startPluginCommandV2(plugin, invocation.commandId, ctx, rpcHandler, options)
      : startPluginPanelActionV2(plugin, invocation.panelId, invocation.actionId, invocation.values, ctx, rpcHandler, options);

    try {
      const result = await handle.promise;
      if (layerManagerRef.current !== manager) {
        await tx.rollback();
        throw new Error('Canvas changed during plugin execution.');
      }
      tx.commit(`Plugin: ${plugin.name}`);
      return result;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  };
  const runPluginV2Ref = useRef(runPluginV2);
  runPluginV2Ref.current = runPluginV2;
  const createPluginHostAdapterRef = useRef(createPluginHostAdapter);
  createPluginHostAdapterRef.current = createPluginHostAdapter;
  const selectPluginToolRef = useRef(selectPluginTool);
  selectPluginToolRef.current = selectPluginTool;
  const clearPluginToolRef = useRef(clearPluginTool);
  clearPluginToolRef.current = clearPluginTool;

  // Plugin API v3.0: auto-stop any active bridge/MCP when entering a collaborative room,
  // and handle authorized local MCP Server canvas tool calls through PluginCanvasTransaction.
  useEffect(() => {
    const isCollaborativeRoom = !OfflineSessionStore.isOfflineCanvas(canvas?.id);
    if (canvas?.id && isCollaborativeRoom) {
      void killAllPluginV3Bridges();
    }
    const desktopV3 = getDesktopPluginV3();
    if (!desktopV3) return;
    return desktopV3.mcpServer.onCanvasRequest((req) => {
      void (async () => {
        if (!canvas?.id || !isEngineReady || !layerManagerRef.current) {
          desktopV3.mcpServer.sendCanvasResponse({
            requestId: req.requestId,
            ok: false,
            error: 'No active local canvas.',
          });
          return;
        }
        const collabNow = !OfflineSessionStore.isOfflineCanvas(canvas.id);
        if (collabNow) {
          desktopV3.mcpServer.sendCanvasResponse({
            requestId: req.requestId,
            ok: false,
            error: 'Local MCP is disabled in collaborative rooms.',
          });
          return;
        }
        const { adapter, manager } = createPluginHostAdapterRef.current();
        const tx = new PluginCanvasTransaction(adapter, { pluginId: 'local-mcp-server' });
        try {
          const { result, mutated } = await executeMcpCanvasTool({
            tx,
            canvasInfo: {
              width: canvas.width,
              height: canvas.height,
              dpi: clampDpi(canvas.dpi ?? 300),
              tileSize: DEFAULT_TILE_SIZE,
            },
            toolName: req.toolName,
            args: req.args,
            allowWrite: req.allowWrite,
            isCollaborativeRoom: collabNow,
          });
          if (layerManagerRef.current !== manager) {
            await tx.rollback();
            throw new Error('Canvas changed during MCP execution.');
          }
          if (mutated) {
            tx.commit(`MCP: ${req.toolName}`);
          } else {
            await tx.rollback();
          }
          desktopV3.mcpServer.sendCanvasResponse({
            requestId: req.requestId,
            ok: true,
            result,
          });
        } catch (err) {
          await tx.rollback();
          desktopV3.mcpServer.sendCanvasResponse({
            requestId: req.requestId,
            ok: false,
            error: err instanceof Error ? err.message : 'MCP canvas tool failed.',
          });
        }
      })();
    });
  }, [canvas?.id, canvas?.width, canvas?.height, canvas?.dpi, isEngineReady]);

  useLayoutEffect(() => {
    if (!canvas?.id || !isCanvasPresented || !isEngineReady || !onRegisterPluginAccess) return;
    onRegisterPluginAccess({
      canvasId: canvas.id,
      apply: (action) => pluginActionRef.current(action),
      runV2Command: (plugin, commandId, options) =>
        runPluginV2Ref.current(plugin, { kind: 'command', commandId }, options),
      runV2PanelAction: (plugin, panelId, actionId, values, options) =>
        runPluginV2Ref.current(plugin, { kind: 'panel', panelId, actionId, values }, options),
      selectPluginTool: (pluginId, toolId) => selectPluginToolRef.current(pluginId, toolId),
      clearPluginTool: () => clearPluginToolRef.current(),
    });
    return () => onRegisterPluginAccess(null);
  }, [canvas?.id, isCanvasPresented, isEngineReady, onRegisterPluginAccess]);

  // Canvas drop target; a file dropped anywhere else must not make the browser open it (and leave the canvas)
  const [imageDragOver, setImageDragOver] = useState(false);
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (e.defaultPrevented || !Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
      if ((e.target as Element | null)?.closest?.('input[type="file"]')) return;
      e.preventDefault();
    };
    const hide = () => setImageDragOver(false);
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    window.addEventListener('drop', hide, true);
    window.addEventListener('dragend', hide);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
      window.removeEventListener('drop', hide, true);
      window.removeEventListener('dragend', hide);
    };
  }, []);

  // ---------- Layer masks ----------
  /** A real layer mask (a 'mask' layer, synced and saved): from the selection if there is one, else showing everything */
  const addLayerMask = async (layerId: string) => {
    const target = layersRef.current.find((l) => l.id === layerId);
    if (!target || !onCreateLayer || !canvas) return;
    if (target.layerType === 'mask' || target.meta?.cel?.ref !== undefined) {
      warn('這裡不能加蒙版，請選圖層或圖層組。');
      return;
    }
    if (layersRef.current.some((l) => l.layerType === 'mask' && l.parentId === layerId)) {
      warn('這個圖層已經有蒙版了。');
      return;
    }
    // A group has no pixels of its own: its owner (or an admin) may mask it
    if (target.layerType === 'group' ? !canManageLayer(target) : !canEditPixels(target)) {
      warn('只能替自己可編輯的圖層加蒙版。');
      return;
    }
    const sel = selectionEngineRef.current?.hasSelection() ? selectionEngineRef.current.getMaskArray() : null;
    const mask = await onCreateLayer(`${target.name} 的蒙版`, 'normal', 'mask', layerId, layerId, { select: false });
    const item = mask && (await waitForLayerItem(mask.id));
    const te = tileEngineRef.current;
    const lm = layerManagerRef.current;
    if (!mask || !item || !te || !lm) return;
    // White shows, black (or erased) hides; compress in 128-tile chunks so 8000×8000 masks stay light on RAM
    const allCoords = te.getAllTileCoords();
    const tiles: TileData[] = [];
    for (let start = 0; start < allCoords.length; start += 128) {
      const raw = allCoords.slice(start, start + 128).map(({ col, row }): TileData => {
        const { x, y, width, height } = getTileBounds(col, row, te.tileSize, canvas.width, canvas.height);
        const data = new Uint8Array(width * height * 4);
        if (!sel) data.fill(255);
        else for (let dy = 0; dy < height; dy++) {
          for (let dx = 0; dx < width; dx++) {
            const i = (dy * width + dx) * 4;
            data[i] = data[i + 1] = data[i + 2] = sel[(y + dy) * canvas.width + x + dx];
            data[i + 3] = 255;
          }
        }
        return { col, row, width, height, compression: 'raw', data };
      });
      tiles.push(...(await compressTiles(raw)));
    }
    if (layerManagerRef.current !== lm || lm.getLayerItem(mask.id) !== item) return;
    lm.applyTiles(mask.id, tiles);
    scopedUndoRef.current.push({
      opId: `op_mask_${Date.now()}`,
      userId: userRef.current?.id || user?.id || 'guest',
      layerId: mask.id,
      opType: 'STROKE',
      beforeTiles: [],
      afterTiles: tiles,
      timestamp: Date.now(),
      desc: '加圖層蒙版',
      layerCreated: { model: mask },
    });
    updateUndoRedoState();
    commitTilePatch(mask.id, tiles, false, '加圖層蒙版');
    if (sel) handleClearSelection();
    onSelectLayer?.(mask.id);
    warn('已加圖層蒙版：現在畫在蒙版上（黑色或橡皮擦隱藏、白色顯示）。點圖層縮圖回到圖層。', 4000);
  };

  // ---------- Text layers ----------
  const [textEdit, setTextEdit] = useState<{ layerId: string | null; meta: LayerTextMeta } | null>(null);
  const textHitAt = (local: { x: number; y: number }) =>
    [...layersRef.current].sort((a, b) => b.sortOrder - a.sortOrder).find((l) => {
      if (l.layerType !== 'text' || !l.meta?.text || !l.isVisible) return false;
      const b = textBounds(l.meta.text);
      return local.x >= b.x && local.y >= b.y && local.x <= b.x + b.width && local.y <= b.y + b.height;
    });
  const editTextLayer = (layer: LayerModel) => {
    if (!canEditPixels(layer)) {
      warn('這是其他畫友的文字圖層，不能編輯。');
      return;
    }
    onSelectLayer?.(layer.id);
    const item = layerManagerRef.current?.getLayerItem(layer.id);
    if (item) item.sprite.visible = false; // the live preview stands in for it while editing
    setTextEdit({ layerId: layer.id, meta: layer.meta!.text! });
  };
  /** Text tool click: edit the text layer under it, or start a new text there */
  const handleTextTool = (local: { x: number; y: number }) => {
    if (isGuest) {
      warn('訪客不能新增文字，請先登入。');
      return;
    }
    if (isCanvasViewer) {
      warn(t.collab.viewerReadOnlyWarn);
      return;
    }
    const hit = textHitAt(local);
    if (hit) editTextLayer(hit);
    else setTextEdit({ layerId: null, meta: { ...DEFAULT_TEXT, color: brushProps.color, x: Math.round(local.x), y: Math.round(local.y) } });
  };
  const previewText = (meta: LayerTextMeta) => {
    const lm = layerManagerRef.current;
    const te = tileEngineRef.current;
    if (!lm || !te) return;
    lm.clearPreview();
    if (!meta.content.trim()) return;
    const r = renderText(meta);
    lm.drawPreviewCanvas(r.canvas, r.x, r.y);
  };
  // The canvas shows the text as it will be while it is typed (this screen only)
  useEffect(() => {
    if (textEdit) previewText(textEdit.meta);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textEdit?.meta]);
  const endTextEdit = () => {
    setTextEdit(null);
    layerManagerRef.current?.clearPreview();
    layerManagerRef.current?.syncLayers(displayLayersRef.current); // shows the edited layer again
  };

  // Live role-change feedback: when changed online, immediately enter/exit read-only state
  const currentCanvasId = canvas?.id ?? null;
  const prevCanvasRoleRef = useRef<{ canvasId: string | null; role: typeof currentCanvasRole }>({
    canvasId: currentCanvasId,
    role: currentCanvasRole,
  });
  useEffect(() => {
    const prev = prevCanvasRoleRef.current;
    if (prev.canvasId !== currentCanvasId) {
      prevCanvasRoleRef.current = { canvasId: currentCanvasId, role: currentCanvasRole };
      return;
    }
    if (prev.role !== currentCanvasRole) {
      const hadPrev = prev.role !== undefined;
      prevCanvasRoleRef.current = { canvasId: currentCanvasId, role: currentCanvasRole };
      if (!isGuest && user?.serverRole !== 'admin') {
        if (currentCanvasRole === 'viewer') {
          if (textEdit) endTextEdit();
          if (transformLayerIdRef.current) cancelTransform();
          warn(t.collab.roleChangedToViewer, 3500);
        } else if (hadPrev && currentCanvasRole === 'editor') {
          warn(t.collab.roleChangedToEditor, 2800);
        } else if (hadPrev && currentCanvasRole === 'admin') {
          warn(t.collab.roleChangedToAdmin, 2800);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCanvasId, currentCanvasRole, isGuest, user?.serverRole]);
  /** The text is drawn into its layer and sent as tiles (every screen shows the same pixels); meta keeps it editable */
  const commitText = async (meta: LayerTextMeta) => {
    const editing = textEdit;
    endTextEdit();
    if (!editing || !canvas) return;
    let layer = editing.layerId ? layersRef.current.find((l) => l.id === editing.layerId) ?? null : null;
    const metaBefore: LayerMeta | null = layer ? layer.meta ?? null : null;
    const metaAfter: LayerMeta = { ...(layer?.meta ?? {}), text: meta };
    if (layer) {
      onUpdateLayerProps?.(layer.id, { meta: metaAfter });
    } else {
      const name = meta.content.split('\n')[0].trim().slice(0, 16) || '文字';
      layer = (await onCreateLayer?.(name, 'normal', 'text', activeLayerRef.current?.id ?? null, undefined, { meta: metaAfter })) ?? null;
    }
    const item = layer && (await waitForLayerItem(layer.id));
    const te = tileEngineRef.current;
    if (!layer || !item || !te) return;
    const next = renderText(meta);
    const old = metaBefore?.text ? renderText(metaBefore.text) : null;
    const rects = [next, ...(old ? [old] : [])].map((r) => ({ x: r.x, y: r.y, w: r.canvas.width, h: r.canvas.height }));
    const coordKeys = new Map<string, { col: number; row: number }>();
    for (const r of rects) {
      for (const c of te.getDirtyTilesForBounds(Math.max(0, r.x), Math.max(0, r.y), Math.min(canvas.width, r.x + r.w), Math.min(canvas.height, r.y + r.h))) {
        coordKeys.set(`${c.col}_${c.row}`, c);
      }
    }
    const lm = layerManagerRef.current!;
    const coords = Array.from(coordKeys.values());
    const diff = diffTilesAsync(lm, layer.id, coords, () => {
      // A text layer holds only its text: clear the old block, draw the new one
      for (const r of rects.slice(1)) {
        const x0 = Math.max(0, r.x);
        const y0 = Math.max(0, r.y);
        const x1 = Math.min(canvas.width, r.x + r.w);
        const y1 = Math.min(canvas.height, r.y + r.h);
        if (x1 > x0 && y1 > y0) te.clearRegion(item.renderTexture, x0, y0, x1 - x0, y1 - y0);
      }
      te.stampCanvas(item.renderTexture, next.canvas, next.x, next.y);
    });
    lm.syncPingPong(layer.id);
    const createdFlag = editing.layerId ? undefined : { model: layer };
    const textLayerId = layer.id;
    commitInOrder(diff, ({ beforeTiles, afterTiles }) => {
      scopedUndoRef.current.push({
        opId: `op_text_${Date.now()}`,
        userId: userRef.current?.id || 'guest',
        layerId: textLayerId,
        opType: 'STROKE',
        beforeTiles,
        afterTiles,
        timestamp: Date.now(),
        desc: '文字',
        metaBefore,
        metaAfter,
        // Undoing a brand-new text removes its layer instead of leaving it empty
        layerCreated: createdFlag,
      });
      updateUndoRedoState();
      commitTilePatch(textLayerId, afterTiles, false, '文字', true, beforeTiles);
    });
  };

  // ---------- Align & Distribute (對齊・均分) ----------
  const alignTargetsList = useMemo(
    () => resolveAlignTargets(layers, activeLayer?.id ?? null, selectedLayerIds),
    [layers, activeLayer?.id, selectedLayerIds],
  );
  // Mid-transform, while typing text or with a filter previewing, the layer's pixels are not settled
  const alignBusy = Boolean(isTransformActive || textEdit || filterModalOpenRef.current);

  const keyframeHandlesActive = Boolean(
    isAnimationTimelineOpen &&
    keyframePanelOpen &&
    showKeyframeHandles &&
    !animPlaying &&
    !isTransformActive &&
    !textEdit &&
    !isResizeModalOpen &&
    !filterModalOpenRef.current &&
    activeLayer &&
    activeLayer.layerType !== 'mask' &&
    canManageLayer(activeLayer) &&
    canvas
  );

  const activeKeyframeBaseRect: KeyframeBaseRect = useMemo(() => {
    if (!canvas) return { x: 0, y: 0, width: 100, height: 100 };
    const fallback: KeyframeBaseRect = {
      x: Math.round(canvas.width * 0.2),
      y: Math.round(canvas.height * 0.2),
      width: Math.max(80, Math.round(canvas.width * 0.6)),
      height: Math.max(80, Math.round(canvas.height * 0.6)),
    };
    if (!keyframeHandlesActive || !activeLayer) return fallback;
    const lm = layerManagerRef.current;
    const ts = tileEngineRef.current?.tileSize ?? DEFAULT_TILE_SIZE;
    if (!lm) return fallback;

    const collectIds = (rootId: string): string[] => {
      const out = [rootId];
      const stack = [rootId];
      while (stack.length) {
        const pid = stack.pop()!;
        for (const l of layers) {
          if (l.parentId === pid && l.layerType !== 'mask') {
            out.push(l.id);
            if (l.layerType === 'group') stack.push(l.id);
          }
        }
      }
      return out;
    };

    const ids = activeLayer.layerType === 'group' ? collectIds(activeLayer.id) : [activeLayer.id];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of ids) {
      const tiles = lm.occupiedTiles(id);
      if (!tiles || tiles.length === 0) continue;
      for (const tc of tiles) {
        const x0 = Math.max(0, tc.col * ts);
        const y0 = Math.max(0, tc.row * ts);
        const x1 = Math.min(canvas.width, (tc.col + 1) * ts);
        const y1 = Math.min(canvas.height, (tc.row + 1) * ts);
        if (x0 < minX) minX = x0;
        if (y0 < minY) minY = y0;
        if (x1 > maxX) maxX = x1;
        if (y1 > maxY) maxY = y1;
      }
    }
    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return fallback;
    const w = Math.max(80, maxX - minX);
    const h = Math.max(80, maxY - minY);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return {
      x: Math.max(0, Math.min(canvas.width - w, cx - w / 2)),
      y: Math.max(0, Math.min(canvas.height - h, cy - h / 2)),
      width: Math.min(canvas.width, w),
      height: Math.min(canvas.height, h),
    };
  }, [keyframeHandlesActive, activeLayer, layers, canvas]);

  const activeMotionPath = useMemo(() => {
    if (
      !isAnimationTimelineOpen ||
      !showMotionPath ||
      animPlaying ||
      isTransformActive ||
      textEdit ||
      isResizeModalOpen ||
      filterModalOpenRef.current ||
      !activeLayer ||
      !canvas
    ) {
      return null;
    }
    const override =
      liveKeyframePreview && liveKeyframePreview.layerId === activeLayer.id
        ? { frame: liveKeyframePreview.frame, evaluated: liveKeyframePreview.evaluated }
        : null;
    return sampleKeyframeMotionPath(layers, activeLayer.id, canvas.width, canvas.height, override);
  }, [
    isAnimationTimelineOpen,
    showMotionPath,
    animPlaying,
    isTransformActive,
    textEdit,
    isResizeModalOpen,
    activeLayer,
    canvas,
    layers,
    liveKeyframePreview,
  ]);
  const alignBlockReason = alignOpen
    ? alignTargetsBlocker(alignTargetsList, {
      busy: alignBusy,
      canEdit: canEditPixels,
      movedByKeyframes: (id) => movedByKeyframes(layers, id),
    })
    : null;
  const liveAlignTargets = () => {
    const list = layersRef.current;
    const targets = resolveAlignTargets(list, activeLayerRef.current?.id ?? null, selectedLayerIdsRef.current);
    // The window may be a render behind: re-check against live layers and busy refs
    const blocked = alignTargetsBlocker(targets, {
      busy: Boolean(transformLayerIdRef.current || filterModalOpenRef.current),
      canEdit: canEditPixels,
      movedByKeyframes: (id) => movedByKeyframes(list, id),
    });
    return blocked ? null : targets;
  };
  const liveGuideSummary = () => {
    const mgr = RulerManager.getInstance();
    return summarizeGuides(mgr.getActiveGuides(), mgr.state.guides.selectedIds);
  };
  const alignGuideSummary = useMemo(
    () => {
      void alignGuidesVersion;
      return liveGuideSummary();
    },
    [alignGuidesVersion],
  );
  const alignHasVectorTarget = useMemo(
    () => alignTargetsList.some((u) => u.members.some((m) => m.layerType === 'vector')),
    [alignTargetsList],
  );
  const alignHasTextTarget = useMemo(
    () => alignTargetsList.some((u) => u.members.some((m) => m.layerType === 'text')),
    [alignTargetsList],
  );
  const alignSingleVectorRoot =
    alignTargetsList.length === 1 && !alignTargetsList[0].isGroup && alignTargetsList[0].root.layerType === 'vector'
      ? alignTargetsList[0].root
      : null;
  const alignSingleVectorStrokes = alignSingleVectorRoot
    ? (vectorEngineRef.current?.getStrokes(alignSingleVectorRoot.id) ?? (activeLayer?.id === alignSingleVectorRoot.id ? vectorStrokesList : []))
    : [];
  const alignVectorStrokeCount = alignSingleVectorStrokes.length;
  const alignSelectedVectorStrokeCount = alignSingleVectorRoot && activeLayer?.id === alignSingleVectorRoot.id
    ? selectedStrokeIds.filter((id) => alignSingleVectorStrokes.some((s) => s.id === id)).length
    : 0;
  const alignCanTargetVectorStrokes = Boolean(alignSingleVectorRoot && alignVectorStrokeCount > 0);
  const runAlign = (x: AlignX | null, y: AlignY | null, basis: AlignBasis, allowCrop?: boolean, options?: AlignUiOptions) => {
    const targets = liveAlignTargets();
    if (!targets) return Promise.resolve('failed' as const);
    return alignTargets(targets, x, y, basis, allowCrop, {
      ...options,
      guideSummary: liveGuideSummary(),
      selectedStrokeIds: selectedStrokeIdsRef.current,
    });
  };
  const runDistribute = (mode: DistributeMode, basis: AlignBasis, allowCrop?: boolean, options?: AlignUiOptions) => {
    const targets = liveAlignTargets();
    if (!targets) return Promise.resolve('failed' as const);
    return distributeTargets(targets, mode, basis, allowCrop, {
      ...options,
      guideSummary: liveGuideSummary(),
      selectedStrokeIds: selectedStrokeIdsRef.current,
    });
  };
  const openAlign = (layerId?: string) => {
    if (layerId && !selectedLayerIdsRef.current.has(layerId)) {
      setSelectedLayerIds(new Set());
      if (layerId !== activeLayerRef.current?.id) onSelectLayer?.(layerId);
    }
    setAlignOpen(true);
  };
  const alignTargetLabel = alignTargetsList.length > 1
    ? t.align.targetCount.replace('{count}', String(alignTargetsList.length))
    : (alignTargetsList[0]?.root.name ?? null);

  const toRawPointerSample = (e: PointerEvent, local: { x: number; y: number }): RawPointerSample => ({
    x: local.x,
    y: local.y,
    pressure: e.pointerType === 'pen' || e.pointerType === 'touch' ? Math.max(0, Math.min(1, e.pressure || 0.5)) : (e.buttons & 1 ? 1 : 0),
    tiltX: Number.isFinite(e.tiltX) ? e.tiltX : 0,
    tiltY: Number.isFinite(e.tiltY) ? e.tiltY : 0,
    pointerType: e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse',
    buttons: e.buttons,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
  });

  const clearActiveLayerWithUndo = () => {
    if (selectionEngineRef.current?.hasSelection()) {
      selection.deleteSelection('清除選取內容');
      return;
    }
    const layer = activeLayerRef.current;
    const lm = layerManagerRef.current;
    const te = tileEngineRef.current;
    if (!layer || !lm || !te || !canvas) return;
    if (layer.layerType === 'group' || !canEditPixels(layer)) {
      warn('請先選取自己可編輯、未鎖定的圖層。', 2500);
      return;
    }
    const coords = te.getDirtyTilesForBounds(0, 0, canvas.width, canvas.height);
    const layerId = layer.id;
    commitInOrder(() => {
      const diff = diffTilesAsync(lm, layerId, coords, () => {
        lm.clearLayer(layerId);
      }, 'before');
      lm.syncPingPong(layerId);
      return diff;
    }, (res) => {
      if (!res || (!res.beforeTiles.length && !res.afterTiles.length)) return;
      scopedUndoRef.current.push({
        opId: `op_clear_layer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        userId: userRef.current?.id || user?.id || 'guest',
        layerId,
        opType: 'STROKE',
        beforeTiles: res.beforeTiles,
        afterTiles: res.afterTiles,
        timestamp: Date.now(),
        desc: `清除圖層「${layer.name}」`,
      });
      updateUndoRedoState();
      commitTilePatch(layerId, res.afterTiles, false, '清除圖層');
      warn('🧹 已清除圖層內容', 1600);
    });
  };

  const handleTouchCut = () => {
    if (selectionEngineRef.current?.hasSelection()) {
      selection.cutSelection();
      return;
    }
    const layer = activeLayerRef.current;
    if (!layer) return;
    copyLayers([layer.id]);
    const wait = pendingCopyRef.current ?? Promise.resolve();
    void wait.then(() => clearActiveLayerWithUndo());
  };

  const handleTouchCopy = () => {
    if (selectionEngineRef.current?.hasSelection()) {
      void selection.copySelection().then((ok) => {
        if (ok) warn('📋 已複製選取內容', 1600);
      });
      return;
    }
    if (activeLayerRef.current) copyLayers([activeLayerRef.current.id]);
  };

  const handleTouchCopyAll = () => {
    void selection.copyMerged();
  };

  const handleTouchDuplicate = () => {
    if (selectionEngineRef.current?.hasSelection()) {
      void selection.copySelection().then((ok) => {
        if (ok) pasteClipboard();
      });
      return;
    }
    if (!activeLayerRef.current) return;
    copyLayers([activeLayerRef.current.id]);
    void pasteLayers();
  };

  const handleTouchPaste = () => {
    if (selection.clipboardRef.current) {
      pasteClipboard();
      return;
    }
    void pasteLayers();
  };

  // Pointer & touch input: layer checks, tool routing and navigation gestures (workspace/tools/useCanvasPointer)
  const pointer = useCanvasPointer(toolCtx, { brush, liquify, shapes, selection, fill, vector, transform }, {
    lassoOutline: outlineBrush,
    setEraserHover,
    containerRef,
    filterModalOpenRef,
    radialMenuOpenRef,
    clipboardMenuOpenRef,
    resizeModalOpenRef,
    updateBrushCursor,
    hideBrushCursor,
    openRadialMenu: (pos) => {
      setRadialMenuPos(pos);
      setIsRadialMenuOpen(true);
    },
    onOpenClipboardMenu: () => {
      setIsClipboardMenuOpen(true);
    },
    onQuickFitCanvas: () => {
      fitViewport(true);
    },
    onToggleFullscreen: () => {
      const next = toggleCanvasFullscreen();
      warn(next ? t.touchGestures.fullscreenEntered : t.touchGestures.fullscreenExited, 1800);
    },
    onTouchEyedropperChange: (state) => {
      setTouchEyedropper(state);
    },
    onTouchEyedropperCommit: (hex) => {
      setBrushProps((prev) => ({ ...prev, color: hex, isEraser: false }));
      warn(`💧 已吸取顏色 ${hex}`, 1400);
    },
    emitCursor,
    undo: () => handleScopedUndo(),
    redo: () => handleScopedRedo(),
    // Every tool change goes through handleSelectTool: it swaps in the brush tools' own settings
    setCurrentTool: (tool) => handleSelectTool(tool),
    onSelectLayer,
    onRequestCreateMyLayer,
    onTextTool: (local) => handleTextTool(local),
    pluginTool: {
      isActive: () => Boolean(activePluginToolRef.current),
      onDown: (e, local) => {
        const reg = activePluginToolRef.current;
        if (!reg || !canvas) return false;
        const labels = getPluginLabels(language);
        if (!reg.hasInputPermission) {
          warn(labels.toolNeedsInputPerm, 3000);
          return true;
        }
        const ctx = {
          width: canvas.width,
          height: canvas.height,
          dpi: clampDpi(canvas.dpi ?? 300),
          tileSize: DEFAULT_TILE_SIZE,
        };
        const opts = pluginToolOptionsRef.current[reg.key] ?? buildInitialToolOptions(reg.tool);
        return pluginToolControllerRef.current.startStroke(
          e.pointerId,
          toRawPointerSample(e, local),
          reg,
          opts,
          {
            createTransaction: (plugin, groupId) => {
              const { adapter } = createPluginHostAdapter();
              return new PluginCanvasTransaction(adapter, { pluginId: plugin.id, groupId });
            },
            createSession: (plugin, toolId, tx) =>
              startPluginToolSessionInWorker(plugin, toolId, ctx, tx.createRpcHandler()),
            onNotice: (text) => warn(text, 2400),
            onError: (msg) => {
              warn(/timed out|time limit/i.test(msg) ? labels.toolTimedOut : msg, 3200);
            },
          },
        );
      },
      onMove: (e, local) => pluginToolControllerRef.current.moveStroke(e.pointerId, toRawPointerSample(e, local)),
      onUp: (e, local, cancelled) =>
        pluginToolControllerRef.current.endStroke(
          e.pointerId,
          local ? toRawPointerSample(e, local) : null,
          cancelled,
        ),
      onCancel: () => pluginToolControllerRef.current.cancelStroke(),
    },
  });
  const { handlePointerDown, handlePointerMove, handlePointerUp } = pointer;

  // Errors propagate to ResizeCanvasModal, which shows them in the dialog
  const handleResizeCanvas = async (
    width: number,
    height: number,
    offsetX: number = 0,
    offsetY: number = 0,
    dpi?: number,
    unit?: CanvasUnit
  ) => {
    if (!canvas) return;
    const sameSize = width === canvas.width && height === canvas.height;
    await ApiService.resizeCanvas(canvas.id, width, height, offsetX, offsetY, dpi, unit);
    // The new size reaches the engine through the canvas prop (see the engine init effect)
    onCanvasResized?.(width, height, dpi, unit);
    if (sameSize && (offsetX !== 0 || offsetY !== 0)) {
      lastSameSizeReloadAtRef.current = Date.now();
      setEngineAttempt((attempt) => attempt + 1);
    }
  };

  const handleSelectResizeAnchor = (anchor: AnchorKey) => {
    setResizeAnchor(anchor);
    if (!canvas) return;
    setResizeBox((prev) => boxFromAnchor(prev.width, prev.height, canvas.width, canvas.height, anchor));
  };

  const handleResetResizeBox = () => {
    if (!canvas) return;
    setResizeBox({ x: 0, y: 0, width: canvas.width, height: canvas.height });
    setResizeAnchor('c');
  };

  useEffect(() => {
    if (resizeRequest > 0) setIsResizeModalOpen(true);
  }, [resizeRequest]);

  if (!canvas) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-neutral-950 p-6 text-center select-none animate-in fade-in zoom-in-95 duration-200">
        <img
          src={`${(import.meta as any).env?.BASE_URL || './'}logo.svg`}
          alt=""
          aria-hidden="true"
          className="w-16 h-16 shrink-0 rounded-2xl shadow-2xl shadow-indigo-500/30 mb-4"
        />
        <h2 className="text-lg sm:text-xl font-black text-white tracking-wide">
          歡迎來到 Lumina Drift 流光
        </h2>
        <p className="text-xs text-neutral-400 max-w-sm mt-1.5 leading-relaxed">
          和朋友一起即時畫畫。
        </p>

        <div className="flex flex-col sm:flex-row items-center gap-3 mt-6 w-full max-w-xs">
          {onQuickEnterCanvas && (
            <button
              type="button"
              onClick={onQuickEnterCanvas}
              className="w-full px-5 py-3 rounded-2xl bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 text-white font-bold text-xs shadow-xl shadow-indigo-600/30 transition flex items-center justify-center gap-2 transform active:scale-95"
            >
              <span>🚀 快速進入合繪室</span>
            </button>
          )}

          {onQuickCreateCanvas && (
            <button
              type="button"
              onClick={onQuickCreateCanvas}
              className="w-full px-5 py-3 rounded-2xl bg-neutral-800 hover:bg-neutral-700 text-neutral-200 font-bold text-xs border border-neutral-700 transition flex items-center justify-center gap-2 transform active:scale-95"
            >
              <span>＋ 新建一張畫布</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  const createLayerFromDock = (type: 'raster' | 'vector' | 'group') => {
    if (!onCreateLayer) return;
    if (type === 'group') {
      // In an animation folder a new folder stays there (CSP): a folder cel, or a folder inside a cel
      const inAnimation = Boolean(activeLayer && (isAnimationFolder(activeLayer) || celOfLayer(layers, activeLayer.id)));
      void createLayerWithUndo(nextGroupName(layers), 'normal', 'group', activeLayer?.id || null, inAnimation ? undefined : null);
    } else if (type === 'vector') {
      const n = layers.filter((l) => l.layerType === 'vector').length + 1;
      void createLayerWithUndo(`向量線稿 ${n}`, 'normal', 'vector', activeLayer?.id || null);
    } else {
      const n = layers.filter((l) => l.layerType !== 'vector' && l.layerType !== 'group').length + 1;
      void createLayerWithUndo(`圖層 ${n}`, 'normal', 'raster', activeLayer?.id || null);
    }
  };

  const alignDocked = !isTouchCanvasMode && (!floatsAllowed || dockLayout.panels.align.place !== 'float');
  const filterDocked = !isTouchCanvasMode && (!floatsAllowed || dockLayout.panels.filters.place !== 'float');
  const closeAlign = () => setAlignOpen(false);
  const panelDefs: PanelDef[] = [
    {
      id: 'color',
      title: PANEL_TITLES.color,
      icon: <Palette />,
      badge: (
        <span
          className="ml-1 h-3 w-3 shrink-0 rounded-sm border border-white/40"
          style={
            brushProps.isEraser
              ? {
                  backgroundImage:
                    'linear-gradient(45deg, #9ca3af 25%, transparent 25%), linear-gradient(-45deg, #9ca3af 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #9ca3af 75%), linear-gradient(-45deg, transparent 75%, #9ca3af 75%)',
                  backgroundSize: '6px 6px',
                  backgroundPosition: '0 0, 0 3px, 3px -3px, -3px 0px',
                  backgroundColor: '#ffffff',
                }
              : { backgroundColor: brushProps.color }
          }
        />
      ),
      render: () => (
        <div className="p-2">
          <ColorWheelStudio isOpen onClose={() => {}} brushProps={brushProps} onUpdateBrushProps={handleBrushPropsChange}
            onActivateCanvasEyedropper={() => handleSelectTool('eyedropper')} embedded />
        </div>
      ),
    },
    {
      id: 'brushToolset',
      title: subToolState.activeCategoryId === 'paint' || subToolState.activeCategoryId === 'eraser'
        ? t.brushPreset.toolset
        : `${t.tools.subToolTitle} · ${getLocalizedCategoryLabel(subToolState.activeCategoryId, t)}`,
      icon: <Paintbrush />,
      render: () => (
        <SubToolPanel activeCategoryId={subToolState.activeCategoryId} activeSubToolId={subToolState.activeSubToolId}
          onSelectSubTool={handleSelectSubTool} onResetSubTool={handleResetSubTool}
          currentBrushProps={brushProps} selectedBrushId={selectedBrushId} onApplyPreset={handleApplyPreset} />
      ),
    },
    {
      id: 'toolProps',
      title: isTouchCanvasMode ? t.toolOptions.title : PANEL_TITLES.toolProps,
      icon: <Sliders />,
      render: () => (
        <div className="min-w-0 p-2">
          {isTouchCanvasMode && (
            <>
              <MobileBrushSliders size={sizeValue} onSize={setSizeValue} opacity={brushProps.opacity}
                onOpacity={(opacity) => handleBrushPropsChange({ opacity })} onSizeDrag={setSizeDragging} />
              {renderToolOptions(true)}
            </>
          )}
          <FloatingStudioPanel
            currentTool={currentTool}
            compact={isTouchCanvasMode}
            brushProps={brushProps}
            onChangeBrushProps={handleBrushPropsChange}
            wandTolerance={wandTolerance}
            onChangeWandTolerance={(t) => setWandTolerance(t)}
            wandContiguous={wandContiguous}
            onToggleWandContiguous={() => setWandContiguous(!wandContiguous)}
            onExpandSelection={() => growSelection(3)}
            onContractSelection={() => growSelection(-3)}
            onClearSelection={handleClearSelection}
            hasSelection={hasSelectionState}
            onUploadCustomBrush={handleUploadCustomBrush}
            onClearCustomBrush={handleClearCustomBrush}
            onOpenPresetModal={openBrushToolset}
            onOpenColorWheel={() => setIsColorStudioOpen(true)}
            onActivateCanvasEyedropper={() => handleSelectTool('eyedropper')}
            gradientMode={gradientMode}
            onChangeGradientMode={setGradientMode}
            gradientType={gradientType}
            onChangeGradientType={setGradientType}
            bucketMode={bucketMode}
            bucketReference={bucketReference}
            onChangeBucketReference={handleBucketReferenceChange}
            bucketTolerance={bucketTolerance}
            onChangeBucketTolerance={setBucketTolerance}
            bucketExpand={bucketExpand}
            onChangeBucketExpand={setBucketExpand}
            bucketRefLayerId={bucketRefLayerId}
            onChangeBucketRefLayerId={setBucketRefLayerId}
            layers={layers}
            referenceLayerId={referenceLayerId}
            onChangeReferenceLayerId={(id) => setReferenceLayerId(id)}
            gapClosingRadius={gapClosingRadius}
            onChangeGapClosingRadius={(r) => setGapClosingRadius(r)}
            expandRadius={expandRadius}
            onChangeExpandRadius={(r) => setExpandRadius(r)}
            liquifyMode={liquifyMode}
            onChangeLiquifyMode={setLiquifyMode}
            liquifyRadius={liquifyRadius}
            onChangeLiquifyRadius={setLiquifyRadius}
            liquifyStrength={liquifyStrength}
            onChangeLiquifyStrength={setLiquifyStrength}
            liquifyHardness={liquifyHardness}
            onChangeLiquifyHardness={setLiquifyHardness}
            liquifyRefAreaOnly={liquifyRefAreaOnly}
            onChangeLiquifyRefAreaOnly={setLiquifyRefAreaOnly}
            smudgeMode={smudgeMode}
            onChangeSmudgeMode={setSmudgeMode}
            shapeSubtype={shapeSubtype}
            onChangeShapeSubtype={setShapeSubtype}
            shapeFillMode={shapeFillMode}
            onChangeShapeFillMode={setShapeFillMode}
            shapeLineWidth={shapeLineWidth}
            onChangeShapeLineWidth={setShapeLineWidth}
            shapeCornerRadius={shapeCornerRadius}
            onChangeShapeCornerRadius={setShapeCornerRadius}
            vectorEraserMode={vectorEraserMode}
            onChangeVectorEraserMode={setVectorEraserMode}
            vectorWidthMode={vectorWidthMode}
            onChangeVectorWidthMode={setVectorWidthMode}
          />
          {!isPhone && isBrushTool(currentTool) && (
            <button type="button" onClick={() => setIsBrushSettingsOpen(true)}
              className="mt-2 w-full rounded-lg border border-indigo-500/50 bg-indigo-600/20 px-2 py-1.5 text-xs font-semibold text-indigo-100 hover:bg-indigo-600/30">
              筆刷詳細設定
            </button>
          )}
        </div>
      ),
    },
    {
      id: 'layers',
      title: PANEL_TITLES.layers,
      icon: <Layers />,
      badge: activeLayer ? <span className="ml-1 truncate text-[10px] font-normal text-neutral-400">{activeLayer.name}</span> : undefined,
      render: () => (
        <LayerPanel
          layers={layers}
          activeLayerId={activeLayer?.id || null}
          subscribeThumbnails={subscribeThumbnails}
          getThumbnailsSnapshot={getThumbnailsSnapshot}
          onRequestThumbnail={refreshLayerThumbnail}
          onSelectLayer={onSelectLayer || (() => {})}
          onCreateLayer={onCreateLayer ? createLayerWithUndo : (() => {})}
          onCreateRaster={() => createLayerFromDock('raster')}
          onCreateVector={() => createLayerFromDock('vector')}
          onCreateGroup={() => createLayerFromDock('group')}
          onRequestCreateMyLayer={onRequestCreateMyLayer}
          onToggleLock={onToggleLock || (() => {})}
          onToggleVisibility={onToggleVisibility || (() => {})}
          onDeleteLayer={(id) => void deleteLayerWithUndo(id)}
          onReleaseLayer={onReleaseLayer || (() => {})}
          roomMembers={roomMembers && roomMembers.length > 0 ? roomMembers : members}
          onTransferLayer={onTransferLayer}
          onClaimLayer={onClaimLayer || (() => {})}
          onReorderLayer={onReorderLayer || (() => {})}
          onUpdateLayerProps={onUpdateLayerProps || (() => {})}
          onBakeScreentone={(layerId, params) => handleBakeScreentone(layerId, params)}
          localVisibility={localVisibility}
          onToggleLocalVisibility={toggleLocalVisibility}
          onAddMask={(id) => void addLayerMask(id)}
          onMergeDown={mergeDown}
          onOpenAlign={openAlign}
          selectedLayerIds={selectedLayerIds}
          onSelectedLayerIdsChange={setSelectedLayerIds}
          onGroupLayers={(ids) => void groupLayers(ids)}
          onCopyLayers={copyLayers}
          onPasteLayers={() => void pasteLayers()}
          onImportImages={(dropped, target) => void importImages(dropped, { target })}
          keepLayerClipboard={keepLayerClipboard}
          onToggleKeepLayerClipboard={toggleKeepLayerClipboard}
          canManage={canManageLayer}
          folderAccess={folderAccess}
          isRoomAdmin={isAdmin}
          isReadOnly={isCanvasViewer}
          isOfflineCanvas={OfflineSessionStore.isOfflineCanvas(canvas?.id)}
          onOpenAuth={onOpenAuth}
          onLoadLayerSelection={(id) => {
            const layer = layersRef.current.find((l) => l.id === id);
            if (layer) selection.loadLayerSelection(layer);
          }}
        />
      ),
    },
    {
      id: 'members',
      title: PANEL_TITLES.members,
      icon: <Users />,
      badge: <span className="ml-1 rounded-full bg-emerald-500/20 px-1.5 text-[10px] font-bold text-emerald-300">{roomMemberCards(members).length}</span>,
      render: () => <UserListPanel members={members} canvasId={canvas.id} canvasOwnerId={canvas.ownerId} />,
    },
    { id: 'oplog', title: PANEL_TITLES.oplog, icon: <Terminal />, render: () => <OpLogPanel /> },
    { id: 'quickKeys', title: PANEL_TITLES.quickKeys, icon: <Keyboard />, render: () => <QuickKeysPanel /> },
  ];
  if (alignDocked && alignOpen) panelDefs.push({
    id: 'align', title: t.align.title, icon: <AlignCenter />, onClose: closeAlign,
    render: () => <ToolDockSlot host={toolDockHosts.align} />,
  });
  if (filterDocked && filterMenuOpen) panelDefs.push({
    id: 'filters', title: t.filters.title, icon: <Sliders />, onClose: closeFilters,
    render: () => <ToolDockSlot host={toolDockHosts.filters} />,
  });
  const mobilePanel: MobilePanelDef | null = mobileSheet === 'toolPicker' ? {
    id: mobileSheet,
    title: t.navbar.tools,
    icon: <Grid2x2 />,
    render: () => <ToolRail orientation="grid" currentTool={currentTool}
      railMode={subToolState.railMode} onChangeRailMode={subToolStore.setRailMode}
      activeCategoryId={subToolState.activeCategoryId} activeSubToolId={subToolState.activeSubToolId}
      lastSubToolByCategory={subToolState.lastSubToolByCategory} onSelectCategory={handleSelectCategory}
      onSelectSubTool={(id) => { handleSelectSubTool(id); setMobileSheet(null); }}
      onSelectTool={(tool) => { handleSelectTool(tool); setMobileSheet(null); }}
      pluginTools={pluginTools} activePluginToolKey={activePluginTool?.key ?? null}
      onSelectPluginTool={(tool, key) => { setMobileSheet(null); selectPluginTool(tool, key); }} />,
  } : panelDefs.find((p) => p.id === mobileSheet) ?? null;

  const renderToolOptions = (inPanel = false) => (
      <ToolOptionsBar
        currentTool={currentTool}
        activeSubToolId={subToolState.activeSubToolId}
        compact={isTouchCanvasMode}
        inPanel={inPanel}
        onOpenOptions={isTouchCanvasMode && !inPanel ? () => openMobileSheet('toolProps') : undefined}
        brushProps={brushProps}
        onBrushProps={handleBrushPropsChange}
        canUndo={canUndoState}
        canRedo={canRedoState}
        onUndo={handleScopedUndo}
        onRedo={handleScopedRedo}
        hasSelection={hasSelectionState}
        selectionMode={selectionMode}
        onSelectionMode={setSelectionMode}
        selectionAntialias={selectionAntialias}
        onSelectionAntialias={setSelectionAntialias}
        selectionFeather={selectionFeather}
        onSelectionFeather={setSelectionFeather}
        polygonPointCount={selection.polygonPointCount}
        onPolygonFinish={selection.finishPolygonLasso}
        onPolygonCancel={selection.cancelPolygonLasso}
        onSelectionTransform={() => startTransformMode()}
        onSelectionMask={() => { if (activeLayer) void addLayerMask(activeLayer.layerType === 'mask' && activeLayer.parentId ? activeLayer.parentId : activeLayer.id); }}
        onFeatherActiveSelection={selection.featherSelection}
        onColorRange={() => selection.selectColorRange()}
        lassoErase={selection.lassoErase}
        onLassoErase={selection.setLassoErase}
        eraserMode={brushProps.eraserMode === 'soft' ? 'soft' : 'hard'}
        onEraserMode={(eraserMode) => handleBrushPropsChange({ eraserMode })}
        pasteToNewLayer={selection.pasteToNewLayer}
        onPasteToNewLayer={selection.setPasteToNewLayer}
        onSelectionGrow={growSelection}
        onClearSelection={handleClearSelection}
        onSelectionInvert={selection.invertSelection}
        onSelectionCopy={() => { selection.copySelection(); }}
        onSelectionCut={selection.cutSelection}
        onSelectionDelete={() => selection.deleteSelection()}
        canPaste={selection.hasClipboard}
        onPaste={pasteClipboard}
        wandTolerance={wandTolerance}
        onWandTolerance={setWandTolerance}
        wandContiguous={wandContiguous}
        onWandContiguous={setWandContiguous}
        bucketTolerance={bucketTolerance}
        onBucketTolerance={setBucketTolerance}
        bucketReference={bucketReference}
        onBucketReference={handleBucketReferenceChange}
        bucketMode={bucketMode}
        lassoFillErase={lassoFillErase}
        onLassoFillErase={setLassoFillErase}
        gapClosingRadius={gapClosingRadius}
        onGapClosingRadius={setGapClosingRadius}
        expandRadius={expandRadius}
        onExpandRadius={setExpandRadius}
        confirmSoloFullFill={fill.confirmSoloFullFill}
        onConfirmSoloFullFill={OfflineSessionStore.isOfflineCanvas(canvas?.id) ? fill.updateConfirmSoloFullFill : undefined}
        outline={outlineBrush}
        onOutline={updateOutlineBrush}
        onPickOutlineColor={() => brush.armOutlinePick(currentTool, handleSelectTool)}
        gradientType={gradientType}
        onGradientType={setGradientType}
        liquifyMode={liquifyMode}
        onLiquifyMode={setLiquifyMode}
        liquifyStrength={liquifyStrength}
        onLiquifyStrength={setLiquifyStrength}
        liquifyHardness={liquifyHardness}
        onLiquifyHardness={setLiquifyHardness}
        liquifyRefAreaOnly={liquifyRefAreaOnly}
        onLiquifyRefAreaOnly={setLiquifyRefAreaOnly}
        smudgeMode={smudgeMode}
        onSmudgeMode={setSmudgeMode}
        shapeSubtype={shapeSubtype}
        onShapeSubtype={setShapeSubtype}
        shapeFillMode={shapeFillMode}
        onShapeFillMode={setShapeFillMode}
        shapeLineWidth={shapeLineWidth}
        onShapeLineWidth={setShapeLineWidth}
        shapeCornerRadius={shapeCornerRadius}
        onShapeCornerRadius={setShapeCornerRadius}
        vectorEraserMode={vectorEraserMode}
        onVectorEraserMode={setVectorEraserMode}
        vectorWidthMode={vectorWidthMode}
        onVectorWidthMode={setVectorWidthMode}
        bezierMode={bezierMode}
        onBezierMode={setBezierMode}
        bezierPointCount={penPoints.length}
        onBezierFinish={() => finishPenPath(false)}
        onBezierCancel={vector.cancelPenPath}
        vectorAnchorSelected={selectedAnchorExists}
        onVectorToggleCorner={toggleSelectedAnchorCorner}
        onVectorDeleteAnchor={deleteSelectedAnchor}
        onStartTransform={() => startTransformMode()}
        isTransformActive={isTransformActive}
        onOpenBrushSettings={() => setIsBrushSettingsOpen(true)}
        activePluginTool={activePluginTool}
        pluginToolOptions={activePluginTool ? (pluginToolOptionsByKey[activePluginTool.key] ?? buildInitialToolOptions(activePluginTool.tool)) : undefined}
        onPluginToolOptionChange={(key, value) => {
          const cur = activePluginToolRef.current;
          if (!cur) return;
          setPluginToolOptionsByKey((prev) => ({
            ...prev,
            [cur.key]: {
              ...(prev[cur.key] ?? buildInitialToolOptions(cur.tool)),
              [key]: value,
            },
          }));
        }}
        onExitPluginTool={clearPluginTool}
      />
  );

  return (
    <div ref={workspaceRef} className="atelier-workspace relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden select-none">
      {permissionWarning && (
        <div role="status" className="pointer-events-none fixed left-1/2 top-24 z-[80] flex -translate-x-1/2 items-center gap-2 rounded-xl border border-amber-500/70 bg-amber-950/95 px-4 py-2 text-xs text-amber-100 shadow-2xl">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-400" />
          <span className="font-medium">{permissionWarning}</span>
        </div>
      )}
      {!canvasFullscreen && renderToolOptions()}
      <div className="flex min-h-0 min-w-0 flex-1" data-dock-root="">
        {/* The size / opacity strip and the tool rail sit on the left, or on the right for left-handed painters */}
        {!canvasFullscreen && !isTouchCanvasMode && (
        <div data-workspace-entry={railRight ? 'right-tools' : 'left-tools'}
          className={`flex min-h-0 shrink-0 ${railRight ? 'order-last flex-row-reverse [&>[role=group]]:border-l [&>[role=group]]:border-r-0' : ''}`}>
          <BrushSideSliders size={sizeValue} onSize={setSizeValue} opacity={brushProps.opacity} onOpacity={(opacity) => handleBrushPropsChange({ opacity })}
            color={brushProps.color} onSizeDrag={setSizeDragging} width={dockLayout.slidersWidth} side={railRight ? 'right' : 'left'} onResizeWidth={dockActions.setSlidersWidth} />
            <ToolRail
              orientation="vertical"
              side={railRight ? 'right' : 'left'}
              width={dockLayout.toolRailWidth}
              onResizeWidth={dockActions.setToolRailWidth}
              currentTool={currentTool}
              onSelectTool={handleSelectTool}
              railMode={subToolState.railMode}
              onChangeRailMode={subToolStore.setRailMode}
              activeCategoryId={subToolState.activeCategoryId}
              activeSubToolId={subToolState.activeSubToolId}
              lastSubToolByCategory={subToolState.lastSubToolByCategory}
              onSelectCategory={handleSelectCategory}
              onSelectSubTool={handleSelectSubTool}
              pluginTools={pluginTools}
              activePluginToolKey={activePluginTool?.key ?? null}
              onSelectPluginTool={selectPluginTool}
            />
        </div>
        )}
        {!canvasFullscreen && !isTouchCanvasMode && <DockColumn side="left" panels={panelDefs} />}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-dock-center="">
          {/* isolate: overlays inside the canvas (transform preview, rulers, mesh) can never stack above the docks */}
          <div className="relative isolate flex min-h-0 min-w-0 flex-1 overflow-hidden"
            onDragOver={(e) => {
              if (!isImageDrag(e.dataTransfer)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              if (!imageDragOver) setImageDragOver(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setImageDragOver(false);
            }}
            onDrop={(e) => {
              if (!isImageDrag(e.dataTransfer)) return;
              e.preventDefault();
              setImageDragOver(false);
              void importImages(readDroppedImages(e.dataTransfer), { at: { x: e.clientX, y: e.clientY } });
            }}
          >
            {imageDragOver && (
              <div aria-hidden className="pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-indigo-400/80 bg-indigo-500/10">
                <span className="atelier-popover flex items-center gap-1.5 px-3 py-1.5 text-xs text-neutral-100"><ImagePlus className="h-4 w-4 text-indigo-400" />放開以新增圖層</span>
              </div>
            )}
            <div
              ref={containerRef}
              onPointerDown={(event) => {
                contextPointerRef.current = { type: event.pointerType, rightButton: event.button === 2 || (event.buttons & 2) !== 0 };
                if (!isCanvasPresented) return;
                // Typing a text: a click elsewhere on the canvas applies it (and starts nothing else)
                if (textEdit) {
                  if (textEdit.meta.content.trim()) void commitText(textEdit.meta);
                  else endTextEdit();
                  return;
                }
                handlePointerDown(event);
              }}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={(event) => {
                hideBrushCursor();
                setEraserHover(false);
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) handlePointerUp(event);
              }}
              onPointerCancel={handlePointerUp}
              onLostPointerCapture={pointer.handleLostPointerCapture}
              onDoubleClick={(event) => {
                const local = viewportRef.current?.screenToCanvas(event.clientX, event.clientY);
                const hit = local && textHitAt(local);
                if (hit && !textEdit) editTextLayer(hit);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                if (isTransformActive || resizeModalOpenRef.current || filterModalOpenRef.current || radialMenuOpenRef.current) return;
                if (event.nativeEvent instanceof PointerEvent && event.nativeEvent.pointerType === 'touch') return;
                // Windows synthesizes a right-click on pen dwell, even during a primary-tip stroke.
                if (contextPointerRef.current.type === 'pen' && !contextPointerRef.current.rightButton) return;
                if (currentTool === 'vector_bezier' && penPoints.length > 0) {
                  finishPenPath(false);
                  return;
                }
                setRadialMenuPos({ x: event.clientX, y: event.clientY });
                setIsRadialMenuOpen(true);
              }}
              data-brush-crosshair={showBrushCrosshair ? 'true' : 'false'}
              style={{
                touchAction: 'none',
                ...(activePluginTool?.tool.cursor ? { cursor: activePluginTool.tool.cursor } : {}),
              }}
              className={`atelier-canvas-viewport relative min-h-0 min-w-0 flex-1 overflow-hidden ${defaultCanvasCursorClass}`}
            >
              {/* Dedicated Pixi Canvas Host Layer (isolated from React DOM reconciler) */}
              <div ref={canvasMountRef} data-canvas-presented={isCanvasPresented}
                className="atelier-canvas-surface pointer-events-none absolute inset-0 z-0 select-none" />
              <OverlayPresence open={Boolean(originalEditId) && !animPlaying} kind="popover">
                <div role="status" data-original-edit
                  className="atelier-popover atelier-original-chip pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 overflow-hidden whitespace-nowrap px-3 py-1.5 text-[11px]">
                  <span aria-hidden className="text-amber-300">◆</span>
                  <b className="font-semibold text-white">{t.animation.originalEdit}</b>
                  <span className="text-neutral-400">{t.animation.originalEditHint}</span>
                </div>
              </OverlayPresence>
              <OverlayPresence open={isCanvasViewer} kind="popover">
                <div
                  role="status"
                  data-viewer-readonly
                  className={`atelier-popover pointer-events-none absolute left-1/2 z-20 flex max-w-[calc(100%-16px)] -translate-x-1/2 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border border-sky-500/50 bg-sky-950/90 px-3 py-1 text-[11px] font-medium text-sky-100 shadow-lg ${
                    Boolean(originalEditId) && !animPlaying ? 'top-12' : 'top-3'
                  }`}
                >
                  <Eye className="h-3.5 w-3.5 shrink-0 text-sky-300" />
                  <span className="truncate">{t.collab.viewerReadOnlyBadge}</span>
                </div>
              </OverlayPresence>
              <ViewportConsumer subscribe={subscribeViewportZoom} getSnapshot={getViewportZoomSnapshot}>
                {(viewportState) => (
                  <>
                    {showBrushCursor && (
                      <div ref={brushCursorRef} aria-hidden="true" className={`pointer-events-none absolute left-0 top-0 z-20 rounded-full border ${vectorCursorClass || 'border-white shadow-[0_0_0_1px_#111]'}`}
                        style={{ width: Math.max(2, brushDiameter * viewportState.zoom), height: Math.max(2, brushDiameter * viewportState.zoom) }}>
                        {showBrushSize && <span style={{ color: '#fff' }} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-xs">{brushDiameter} px</span>}
                      </div>
                    )}

                    {sizeDragging && (
                      <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_#111]"
                        style={{ width: Math.max(2, brushDiameter * viewportState.zoom), height: Math.max(2, brushDiameter * viewportState.zoom) }}>
                        <span style={{ color: '#fff' }} className="absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-xs">{brushDiameter} px</span>
                      </div>
                    )}
                  </>
                )}
              </ViewportConsumer>

              <RemoteCursorsLayer
                viewport={viewportRef.current}
                subscribeViewport={subscribeViewport}
                getViewportSnapshot={getViewportSnapshot}
                selfId={user?.id}
              />

              <ConditionalViewportConsumer
                active={Boolean(
                  textEdit ||
                  (isTransformActive && distortMode === 'transform') ||
                  isResizeModalOpen ||
                  keyframeHandlesActive ||
                  activeMotionPath ||
                  (isAnimationTimelineOpen && cameraLayer?.isVisible && cameraLayer.meta?.camera) ||
                  (isAnimationTimelineOpen && !animPlaying && lightTable.enabled && (lightCanvasDragMode || lightTable.externalRefs.length > 0))
                )}
                subscribe={subscribeViewport}
                getSnapshot={getViewportSnapshot}
              >
                {(viewportState) => (
                  <>
                    {textEdit && (
                      <Suspense fallback={null}>
                        <TextCanvasEditor meta={textEdit.meta} isNew={!textEdit.layerId} viewport={viewportRef.current} viewportState={viewportState}
                          onChange={(meta) => setTextEdit((t) => (t ? { ...t, meta } : t))}
                          onCommit={() => (textEdit.meta.content.trim() ? void commitText(textEdit.meta) : endTextEdit())}
                          onCancel={endTextEdit} />
                      </Suspense>
                    )}

                    {isTransformActive && distortMode === 'transform' && (
                      <Suspense fallback={null}>
                        <TransformOverlay
                          isActive
                          box={transformBox}
                          onChangeBox={setTransformBox}
                          // The selection moves with the pixels (a marquee left behind would clip brushes to an empty spot)
                          onApply={() => { applyTransform(); selection.refreshSelection(); }}
                          onCancel={cancelTransform}
                          onChangeMode={setDistortMode}
                          canvasToScreen={(cx, cy) => (viewportRef.current ? viewportRef.current.canvasToScreen(cx, cy) : { x: cx, y: cy })}
                          screenToCanvas={(sx, sy) => (viewportRef.current ? viewportRef.current.screenToCanvas(sx, sy) : { x: sx, y: sy })}
                          viewportZoom={viewportState.zoom}
                          previewUrl={transformPreviewUrl}
                        />
                      </Suspense>
                    )}

                    {isResizeModalOpen && (
                      <Suspense fallback={null}>
                        <CanvasResizeOverlay
                          isActive
                          oldWidth={canvas.width}
                          oldHeight={canvas.height}
                          box={resizeBox}
                          lockAspect={resizeLockAspect}
                          onChangeBox={(next, hint) => {
                            setResizeBox(next);
                            setResizeAnchor(hint);
                          }}
                          onModifiersChange={setResizeModifiers}
                          canvasToScreen={(cx, cy) => (viewportRef.current ? viewportRef.current.canvasToScreen(cx, cy) : { x: cx, y: cy })}
                          screenToCanvas={(sx, sy) => (viewportRef.current ? viewportRef.current.screenToCanvas(sx, sy) : { x: sx, y: sy })}
                        />
                      </Suspense>
                    )}

                    {activeMotionPath && (
                      <Suspense fallback={null}>
                        <KeyframeMotionPathOverlay
                          path={activeMotionPath}
                          currentFrame={animFrame}
                          canvasToScreen={(cx, cy) => (viewportRef.current ? viewportRef.current.canvasToScreen(cx, cy) : { x: cx, y: cy })}
                          onSelectFrame={(frame) => {
                            skipSelectShownRef.current = true;
                            animationEngine?.goTo(frame);
                            skipSelectShownRef.current = false;
                          }}
                        />
                      </Suspense>
                    )}

                    {keyframeHandlesActive && activeLayer && (
                      <Suspense fallback={null}>
                        <KeyframeTransformOverlay
                          isActive
                          baseRect={activeKeyframeBaseRect}
                          evaluated={
                            liveKeyframePreview && liveKeyframePreview.layerId === activeLayer.id && liveKeyframePreview.frame === animFrame
                              ? liveKeyframePreview.evaluated
                              : evaluateTransformKeyframes(activeLayer.meta?.keyframes, animFrame, canvas.width / 2, canvas.height / 2)
                          }
                          parentWorld={resolveParentWorldAffine(layers, activeLayer.id, animFrame, canvas.width, canvas.height)}
                          frame={animFrame}
                          canvasToScreen={(cx, cy) => (viewportRef.current ? viewportRef.current.canvasToScreen(cx, cy) : { x: cx, y: cy })}
                          screenToCanvas={(sx, sy) => (viewportRef.current ? viewportRef.current.screenToCanvas(sx, sy) : { x: sx, y: sy })}
                          onPreviewChange={handleKeyframePreviewChange}
                          onCommit={(nextEval) => {
                            const kfs = activeLayer.meta?.keyframes ?? [];
                            const nextKf = buildKeyframeFromEval(kfs, animFrame, nextEval);
                            updateLayerKeyframes(activeLayer.id, upsertTransformKeyframe(kfs, nextKf));
                          }}
                        />
                      </Suspense>
                    )}

                    {/* Phase E2: Light Table local external reference images & interactive reference drag */}
                    {isAnimationTimelineOpen && !animPlaying && lightTable.enabled && (
                      lightCanvasDragMode ||
                      externalRefsFor(
                        lightTable,
                        animFolder?.id ?? null,
                        celLayerOf(animEntries[entryIndexAt(animEntries, animFrame)]),
                        { visibleOnly: true }
                      ).length > 0
                    ) && (
                      <Suspense fallback={null}>
                        <LightTableOverlay
                          lightTable={lightTable}
                          activeFolderId={animFolder?.id ?? null}
                          currentCelId={celLayerOf(animEntries[entryIndexAt(animEntries, animFrame)])}
                          canvasWidth={canvas.width}
                          canvasHeight={canvas.height}
                          dragMode={lightCanvasDragMode}
                          selectedRefId={selectedLightRefId}
                          canvasToScreen={(cx, cy) => (viewportRef.current ? viewportRef.current.canvasToScreen(cx, cy) : { x: cx, y: cy })}
                          screenToCanvas={(sx, sy) => (viewportRef.current ? viewportRef.current.screenToCanvas(sx, sy) : { x: sx, y: sy })}
                          onUpdateLightTable={updateLightTable}
                        />
                      </Suspense>
                    )}

                    {/* Phase E1: 2D Camera framing box overlay & Look Through Camera preview matte */}
                    {isAnimationTimelineOpen && cameraLayer && cameraLayer.isVisible && cameraLayer.meta?.camera && (
                      <Suspense fallback={null}>
                        <CameraFrameOverlay
                          cameraMeta={cameraLayer.meta.camera}
                          keyframes={cameraLayer.meta.keyframes}
                          currentFrame={animFrame}
                          canvasWidth={canvas.width}
                          canvasHeight={canvas.height}
                          interactive={Boolean((cameraWindowOpen || activeLayer?.id === cameraLayer.id) && canManageLayer(cameraLayer) && !animPlaying)}
                          previewActive={cameraPreviewActive}
                          previewFrameRect={cameraPreviewRect}
                          canvasToScreen={(cx, cy) => (viewportRef.current ? viewportRef.current.canvasToScreen(cx, cy) : { x: cx, y: cy })}
                          screenToCanvas={(sx, sy) => (viewportRef.current ? viewportRef.current.screenToCanvas(sx, sy) : { x: sx, y: sy })}
                          onExitPreview={() => setCameraPreviewMode(false)}
                          onSelectFrame={(frame) => {
                            skipSelectShownRef.current = true;
                            animationEngine?.goTo(frame);
                            skipSelectShownRef.current = false;
                          }}
                          onCommitKeyframes={
                            canManageLayer(cameraLayer)
                              ? (nextKfs) => updateLayerKeyframes(cameraLayer.id, nextKfs)
                              : undefined
                          }
                        />
                      </Suspense>
                    )}
                  </>
                )}
              </ConditionalViewportConsumer>

              {!canvasFullscreen && (
                <ConditionalViewportConsumer active={stickers.length > 0} subscribe={subscribeViewport} getSnapshot={getViewportSnapshot}>
                  {(viewportState) => (
                    <CanvasStickersOverlay
                      stickers={stickers}
                      currentUserId={user?.id}
                      readOnly={isGuest || isCanvasViewer}
                      avoidBottomDock={isTouchCanvasMode && !isTouchTablet}
                      zoom={viewportState.zoom}
                      pan={{ x: viewportState.panX, y: viewportState.panY }}
                      onAddSticker={addSticker}
                      onUpdateSticker={updateSticker}
                      onRemoveSticker={removeSticker}
                    />
                  )}
                </ConditionalViewportConsumer>
              )}

              <RulerOverlay
                canvasWidth={canvas.width}
                canvasHeight={canvas.height}
                canvasToScreen={(cx, cy) => (viewportRef.current ? viewportRef.current.canvasToScreen(cx, cy) : { x: cx, y: cy })}
                screenToCanvas={(sx, sy) => (viewportRef.current ? viewportRef.current.screenToCanvas(sx, sy) : { x: sx, y: sy })}
                subscribeViewport={subscribeViewport}
                getViewportSnapshot={getViewportSnapshot}
              />

              <FilterPointOverlay
                canvasToScreen={(cx, cy) => viewportRef.current?.canvasToScreen(cx, cy) ?? { x: cx, y: cy }}
                screenToCanvas={(sx, sy) => viewportRef.current?.screenToCanvas(sx, sy) ?? { x: sx, y: sy }}
                subscribeViewport={subscribeViewport}
                getViewportSnapshot={getViewportSnapshot}
              />

              {isMeshWarpActive && (
                <Suspense fallback={null}>
                  <MeshWarpOverlay
                    isActive
                    mode={distortMode === 'transform' ? 'mesh' : distortMode}
                    onChangeMode={setDistortMode}
                    sourceCanvas={transformSourceCanvasRef.current}
                    canvasWidth={canvas.width}
                    canvasHeight={canvas.height}
                    initialBounds={meshWarpInitialBoundsRef.current}
                    onApply={(warped, bounds) => { applyMeshWarp(warped, bounds); selection.refreshSelection(); }}
                    onCancel={cancelTransform}
                    canvasToScreen={(cx, cy) => (viewportRef.current ? viewportRef.current.canvasToScreen(cx, cy) : { x: cx, y: cy })}
                    screenToCanvas={(sx, sy) => (viewportRef.current ? viewportRef.current.screenToCanvas(sx, sy) : { x: sx, y: sy })}
                  />
                </Suspense>
              )}
            </div>

            <ConditionalViewportConsumer
              active={currentTool === 'comic_panel' || currentTool === 'comic_balloon'}
              subscribe={subscribeViewport}
              getSnapshot={getViewportSnapshot}
            >
              {(viewportState) => (
                <Suspense fallback={null}>
                  <ComicStudioOverlay
                    key={canvas.id}
                    currentTool={currentTool}
                    canvasWidth={canvas.width}
                    canvasHeight={canvas.height}
                    canvasToScreen={(cx, cy) => viewportRef.current?.canvasToScreen(cx, cy) ?? { x: cx, y: cy }}
                    getCanvasViewCenter={() => {
                      const center = getViewCenter();
                      return center && viewportRef.current
                        ? viewportRef.current.screenToCanvas(center.x, center.y)
                        : { x: canvas.width / 2, y: canvas.height / 2 };
                    }}
                    viewportZoom={viewportState.zoom}
                    onBakeToLayer={handleBakeComicToLayer}
                    onClose={() => handleSelectTool('brush')}
                  />
                </Suspense>
              )}
            </ConditionalViewportConsumer>

            <ConditionalViewportConsumer
              active={Boolean(activeLayer?.layerType === 'vector' || currentTool.startsWith('vector'))}
              subscribe={subscribeViewport}
              getSnapshot={getViewportSnapshot}
            >
              {(viewportState) => (
                <VectorOverlay
                  viewport={viewportRef.current}
                  viewportState={viewportState}
                  strokes={activeLayer ? (vectorEngineRef.current?.getStrokes(activeLayer.id) || vectorStrokesList) : []}
                  currentTool={currentTool}
                  isVectorLayer={activeLayer?.layerType === 'vector' || currentTool.startsWith('vector')}
                  selectedStrokeId={vectorSel?.strokeId ?? null}
                  selectedStrokeIds={selectedStrokeIds}
                  selectedAnchorIndex={vectorSel?.index ?? -1}
                  previewStroke={vectorPreview ?? penPreview}
                  penPoints={currentTool === 'vector_bezier' ? penPoints : []}
                />
              )}
            </ConditionalViewportConsumer>
            {engineError && (
              <div role="alert" className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-neutral-950 text-sm text-neutral-200">
                <p>無法載入畫布。</p>
                <button type="button" className="rounded bg-indigo-600 px-3 py-1.5 text-white hover:bg-indigo-500" onClick={() => setEngineAttempt((attempt) => attempt + 1)}>
                  重新載入畫布
                </button>
              </div>
            )}
            {canvasFullscreen && (
              <button
                type="button"
                data-canvas-fullscreen-exit=""
                onClick={() => setCanvasFullscreen(false)}
                aria-label={t.touchGestures.exitFullscreen}
                title={t.touchGestures.exitFullscreen}
                onPointerDown={(e) => e.stopPropagation()}
                className="atelier-popover pointer-events-auto absolute right-3 top-3 z-40 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-neutral-100 opacity-80 transition hover:opacity-100"
              >
                <Minimize2 className="h-3.5 w-3.5" />
                <span>{t.touchGestures.exitFullscreen}</span>
              </button>
            )}
            {!canvasFullscreen && isTouchCanvasMode && (
              <>
                <TouchSideIsland
                  side={dockLayout.railSide === 'right' ? 'right' : 'left'}
                  size={sizeValue}
                  opacity={brushProps.opacity}
                  color={brushProps.color}
                  currentTool={currentTool}
                  canUndo={canUndoState}
                  canRedo={canRedoState}
                  stylusOnlyActive={touchGestureSettings.singleFingerMode !== 'draw'}
                  onSize={setSizeValue}
                  onOpacity={(opacity) => handleBrushPropsChange({ opacity })}
                  onSizeDrag={setSizeDragging}
                  onToggleEyedropper={() => handleSelectTool(currentTool === 'eyedropper' ? 'brush' : 'eyedropper')}
                  onUndo={handleScopedUndo}
                  onRedo={handleScopedRedo}
                />
                <TouchToolIsland
                  isTablet={isTouchTablet}
                  currentTool={currentTool}
                  color={brushProps.color}
                  activeSheet={mobileSheet}
                  showMembers={!OfflineSessionStore.isOfflineCanvas(canvas.id)}
                  onSelectTool={handleSelectTool}
                  activeCategoryId={subToolState.activeCategoryId}
                  activeSubToolId={subToolState.activeSubToolId}
                  onSelectCategory={handleSelectCategory}
                  onSelectSubTool={handleSelectSubTool}
                  onOpenSheet={openMobileSheet}
                  onOpenBrushToolset={openBrushToolset}
                  onToggleMembers={() => dockActions.toggle('members')}
                />
              </>
            )}
          </div>

          {/* Timeline sits in the layout (not over the canvas or the canvas switcher) */}
          {!canvasFullscreen && animationEngine && (
            <Suspense fallback={null}>
              <AnimationTimelineBar
                key={canvas.id}
                engine={animationEngine}
                isOpen={isAnimationTimelineOpen}
                onClose={() => {
                  if (cameraPreviewActive) setCameraPreviewMode(false);
                  setCameraWindowOpen(false);
                  setLightWindowOpen(false);
                  setAudioWindowOpen(false);
                  setLightCanvasDragMode(false);
                  setIsAnimationTimelineOpen(false);
                }}
                tracks={animTracks}
                activeFolderId={animFolder?.id ?? null}
                subscribeThumbnails={subscribeThumbnails}
                getThumbnailsSnapshot={getThumbnailsSnapshot}
                activeLayer={activeLayer}
                canvasWidth={canvas.width}
                canvasHeight={canvas.height}
                onUpdateLayerKeyframes={activeLayer && canManageLayer(activeLayer) ? updateLayerKeyframes : undefined}
                liveKeyframeEval={liveKeyframePreview && activeLayer && liveKeyframePreview.layerId === activeLayer.id ? liveKeyframePreview.evaluated : null}
                showKeyframeHandles={showKeyframeHandles}
                onToggleKeyframeHandles={() => setShowKeyframeHandles((v) => !v)}
                showMotionPath={showMotionPath}
                onToggleMotionPath={toggleMotionPath}
                ownerNames={Object.fromEntries([
                  ...layers.filter((l) => l.ownerId).map((l) => [l.ownerId as string, l.ownerDisplayName || '畫師']),
                  ...(user ? [[user.id, `${user.displayName || user.username}（你）`]] : []),
                ])}
                can={{
                  createFolder: !isGuest && !isCanvasViewer && Boolean(onCreateLayer),
                  editFolder: Boolean(animFolder && canManageLayer(animFolder)),
                  addCel: canAddCel(animFolder),
                  editableEntryIds: new Set(animTracks.flatMap((t) => t.entries).filter((e) => { const l = layers.find((x) => x.id === e.id); return Boolean(l && canManageLayer(l)); }).map((e) => e.id)),
                  addableFolderIds: new Set(animFolders.filter((f) => canAddCel(f)).map((f) => f.id)),
                }}
                onPlaceEntries={placeAnimationEntries}
                onCopyEntries={copyAnimationEntries}
                onPasteEntries={(folderId, frame) => void pasteAnimationEntries(folderId, frame)}
                ripple={animRipple}
                onToggleRipple={toggleAnimRipple}
                timelineLength={animTimelineLength}
                lengthIsSet={animSetLength > 0}
                onSetLength={setAnimationLength}
                lightTable={lightTable}
                onUpdateLightTable={updateLightTable}
                onSetEntryHold={setEntryHold}
                onCreateFolder={() => void createAnimationFolder()}
                onAddFrame={() => void addAnimationFrame()}
                onDuplicateFrame={() => void duplicateAnimationFrame()}
                onReuseCel={(id) => void reuseAnimationCel(id)}
                onAddBlank={() => void addBlankAnimationFrame()}
                onKeyframePanelChange={setKeyframePanelOpen}
                onDeleteFrame={deleteAnimationFrame}
                onMoveFrame={moveAnimationFrame}
                onSetHold={setAnimationHold}
                onUpdateCelMeta={updateAnimationCelMeta}
                onUpdateLabels={setAnimationLabels}
                onRepeatEntries={repeatAnimationEntries}
                onRenameInOrder={renameAnimationCelsInOrder}
                onJumpKeyframe={jumpAdjacentKeyframe}
                onToggleShared={toggleAnimationShared}
                onFpsChange={setAnimationFps}
                onSelectCell={selectAnimationCell}
                planExport={planAnimationExport}
                planCelExport={planCelExport}
                cameraLayer={cameraLayer}
                cameraWindowOpen={cameraWindowOpen}
                onToggleCameraWindow={() => setCameraWindowOpen((v) => !v)}
                cameraPreviewActive={cameraPreviewActive}
                onToggleCameraPreview={() => setCameraPreviewMode(!cameraPreviewActive)}
                lightWindowOpen={lightWindowOpen}
                onToggleLightWindow={() => setLightWindowOpen((v) => !v)}
                audioLayers={audioLayers}
                audioAssetSummaries={audioAssetSummaries}
                audioWindowOpen={audioWindowOpen}
                onToggleAudioWindow={() => setAudioWindowOpen((v) => !v)}
                audioScrubEnabled={audioScrubEnabled}
                onToggleAudioScrub={() => setAudioScrubEnabled((v) => !v)}
                onToggleAudioMute={toggleAudioTrackMute}
              />
            </Suspense>
          )}
          {isAnimationTimelineOpen && cameraWindowOpen && (
            <Suspense fallback={null}>
              <CameraToolWindow
                open={cameraWindowOpen}
                onClose={() => setCameraWindowOpen(false)}
                cameraLayer={cameraLayer}
                canEdit={Boolean(!isGuest && !isCanvasViewer && (!cameraLayer || canManageLayer(cameraLayer)))}
                currentFrame={animFrame}
                canvasWidth={canvas.width}
                canvasHeight={canvas.height}
                previewActive={cameraPreviewActive}
                onTogglePreview={() => setCameraPreviewMode(!cameraPreviewActive)}
                onCreateCamera={(meta) => void createCameraLayer(meta)}
                onUpdateCameraMeta={updateCameraMeta}
                onUpdateCameraKeyframes={(kfs) => {
                  if (cameraLayer) updateLayerKeyframes(cameraLayer.id, kfs);
                }}
                onDeleteCamera={() => void deleteCameraLayer()}
                onGoToFrame={(f) => animationEngine?.goTo(f)}
              />
            </Suspense>
          )}
          {isAnimationTimelineOpen && lightWindowOpen && (
            <Suspense fallback={null}>
              <LightTableWindow
                open={lightWindowOpen}
                onClose={() => {
                  setLightWindowOpen(false);
                  setLightCanvasDragMode(false);
                }}
                lightTable={lightTable}
                activeFolderId={animFolder?.id ?? null}
                currentCelId={celLayerOf(animEntries[entryIndexAt(animEntries, animFrame)])}
                celOptions={animTracks.flatMap((tr) =>
                  tr.entries
                    .filter((e) => e.ref === undefined)
                    .map((e) => ({ id: e.id, label: e.label, folderId: tr.folderId, folderName: tr.name }))
                )}
                selectedRefId={selectedLightRefId}
                onSelectRefId={setSelectedLightRefId}
                canvasDragMode={lightCanvasDragMode}
                onToggleCanvasDragMode={() => setLightCanvasDragMode((v) => !v)}
                onUpdateLightTable={updateLightTable}
              />
            </Suspense>
          )}
          {isAnimationTimelineOpen && audioWindowOpen && (
            <Suspense fallback={null}>
              <AudioTrackWindow
                open={audioWindowOpen}
                onClose={() => setAudioWindowOpen(false)}
                audioLayers={audioLayers}
                assetSummaries={audioAssetSummaries}
                fps={animationEngine?.getFps() ?? 12}
                currentFrame={animFrame}
                canCreate={!isGuest && !isCanvasViewer && Boolean(onCreateLayer)}
                canEditLayer={canManageLayer}
                scrubEnabled={audioScrubEnabled}
                onToggleScrub={() => setAudioScrubEnabled((v) => !v)}
                onCreateAudioTrack={(name, meta) => void createAudioTrack(name, meta)}
                onUpdateAudioTrack={updateAudioTrack}
                onDeleteAudioTrack={(id) => void deleteAudioTrack(id)}
              />
            </Suspense>
          )}
          {isBrushSettingsOpen && isBrushTool(currentTool) && (
            <Suspense fallback={null}>
              <BrushSettingsModal
                tool={currentTool}
                brushProps={brushProps}
                onChange={handleBrushPropsChange}
                onReset={resetBrushTool}
                onUploadTip={(file) => void handleUploadCustomBrush(file)}
                onClearTip={handleClearCustomBrush}
                onImportBrushes={() => { setIsBrushSettingsOpen(false); openBrushToolset(); }}
                renderPreview={() => brushRendererRef.current?.renderPreview() ?? null}
                onClose={() => setIsBrushSettingsOpen(false)}
              />
            </Suspense>
          )}

          {!canvasFullscreen && (
            <ViewportConsumer subscribe={subscribeViewportZoom} getSnapshot={getViewportZoomSnapshot}>
              {(viewportState) => (
                <ViewportToolbar
                  viewportState={viewportState}
                  displayScale={viewportRef.current?.getDisplayScale() ?? getTargetDisplayResolution()}
                  width={canvas.width}
                  height={canvas.height}
                  onZoomIn={() => zoomAtViewCenter(1.25)}
                  onZoomOut={() => zoomAtViewCenter(1 / 1.25)}
                  onResetZoom={() => {
                    const vp = viewportRef.current;
                    if (vp) zoomAtViewCenter(vp.getActualSizeZoom() / vp.getState().zoom);
                  }}
                  onFitView={() => fitViewport()}
                  onRotate={(rad) => viewportRef.current?.rotateBy(rad)}
                  onResetRotation={() => viewportRef.current?.resetRotation()}
                  onToggleMirror={() => viewportRef.current?.toggleMirrorX()}
                  onOpenRuler={() => setIsRulerModalOpen(true)}
                  onOpenReference={() => setIsReferenceHUDOpen(true)}
                  onOpenFilters={() => openFilterRef.current()}
                  onOpenAlign={() => openAlign()}
                  onOpenResize={() => setIsResizeModalOpen(true)}
                  onOpenRadial={() => {
                    if (transformLayerIdRef.current || filterModalOpenRef.current) return;
                    setRadialMenuPos(getViewCenter() ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 });
                    setIsRadialMenuOpen(true);
                  }}
                />
              )}
            </ViewportConsumer>
          )}
          {!canvasFullscreen && !isTouchCanvasMode && <DockRow panels={panelDefs} />}
        </div>

        {!canvasFullscreen && !isTouchCanvasMode && <DockColumn side="right" panels={panelDefs} />}
      </div>

      {/* Floating windows: phones & non-desktop touch tablets use frosted slide-out drawers; desktops float */}
      <FloatingPanels panels={canvasFullscreen || isTouchCanvasMode ? [] : panelDefs} />
      <MobilePanelSheet
        def={!canvasFullscreen && isTouchCanvasMode ? mobilePanel : null}
        placement={isTouchTablet ? 'right' : 'bottom'}
        quickTabs={[
          { id: 'toolPicker', label: t.navbar.tools, icon: <Grid2x2 /> },
          { id: 'color', label: PANEL_TITLES.color, icon: <Palette /> },
          { id: 'brushToolset', label: t.brushPreset.toolset, icon: <Paintbrush /> },
          { id: 'layers', label: PANEL_TITLES.layers, icon: <Layers /> },
          { id: 'toolProps', label: t.toolOptions.title, icon: <Sliders /> },
        ]}
        onSelectTab={openMobileSheet}
        onClose={() => {
          if (mobileSheet === 'members' || mobileSheet === 'oplog') dockActions.hide(mobileSheet);
          setMobileSheet(null);
        }}
      />

      {isResizeModalOpen && (
        <Suspense fallback={null}>
          <ResizeCanvasModal
            key={canvas.id}
            isOpen
            onClose={() => setIsResizeModalOpen(false)}
            currentWidth={canvas.width}
            currentHeight={canvas.height}
            currentDpi={clampDpi(canvas.dpi ?? 300)}
            currentUnit={canvas.unit || 'px'}
            box={resizeBox}
            anchor={resizeAnchor}
            lockAspect={resizeLockAspect}
            modifierState={resizeModifiers}
            onChangeBox={(next, hint) => {
              setResizeBox(next);
              setResizeAnchor(hint);
            }}
            onSelectAnchor={handleSelectResizeAnchor}
            onToggleLockAspect={() => setResizeLockAspect((prev) => !prev)}
            onReset={handleResetResizeBox}
            onResize={handleResizeCanvas}
          />
        </Suspense>
      )}

      <ColorWheelStudio
        isOpen={isColorStudioOpen}
        onClose={() => setIsColorStudioOpen(false)}
        brushProps={brushProps}
        onUpdateBrushProps={handleBrushPropsChange}
        onActivateCanvasEyedropper={() => handleSelectTool('eyedropper')}
      />

      {isRulerModalOpen && (
        <Suspense fallback={null}>
          <RulerControlsModal
            isOpen
            onClose={() => setIsRulerModalOpen(false)}
            canvasWidth={canvas.width}
            canvasHeight={canvas.height}
          />
        </Suspense>
      )}

      {isReferenceHUDOpen && (
        <Suspense fallback={null}>
          <ReferenceViewportHUD
            isOpen
            onClose={() => setIsReferenceHUDOpen(false)}
            onPickColor={(hex) => {
              setBrushProps((prev) => ({ ...prev, color: hex, isEraser: false }));
            }}
          />
        </Suspense>
      )}

      {touchEyedropper && <TouchEyedropperLoupe state={touchEyedropper} />}

      {isClipboardMenuOpen && (
        <TouchClipboardMenu
          isOpen
          canEdit={Boolean(activeLayer && canEditPixels(activeLayer) && !isCanvasViewer)}
          canPaste={Boolean(selection.hasClipboard || layerClipboard || loadLayerClipboard())}
          hasSelection={hasSelectionState}
          onClose={() => setIsClipboardMenuOpen(false)}
          onCut={handleTouchCut}
          onCopy={handleTouchCopy}
          onCopyAll={handleTouchCopyAll}
          onDuplicate={handleTouchDuplicate}
          onPaste={handleTouchPaste}
          onClearLayer={clearActiveLayerWithUndo}
        />
      )}

      {isRadialMenuOpen && (
        <TouchRadialMenu
          isOpen
          position={radialMenuPos}
          onClose={() => setIsRadialMenuOpen(false)}
          canUndo={canUndoState}
          canRedo={canRedoState}
          isEraser={brushProps.isEraser}
          currentColor={brushProps.color}
          onUndo={handleScopedUndo}
          onRedo={handleScopedRedo}
          onSelectEyedropper={() => handleSelectTool('eyedropper')}
          onToggleEraser={() => handleSelectTool(brushProps.isEraser ? 'brush' : 'eraser')}
          onFlipCanvas={() => viewportRef.current?.toggleMirrorX()}
          onToggleRuler={() => setIsRulerModalOpen(true)}
          onToggleReference={() => setIsReferenceHUDOpen(true)}
          onClearSelection={handleClearSelection}
        />
      )}

      {!alignDocked && <ToolDockSlot host={toolDockHosts.align} />}
      {!filterDocked && <ToolDockSlot host={toolDockHosts.filters} />}
      {createPortal(<OverlayPresence open={alignOpen && Boolean(canvas)} kind="popover">
        <Suspense fallback={null}><LayerAlignWindow embedded={alignDocked} targetLabel={alignTargetLabel} targetCount={alignTargetsList.length}
          blocker={alignBlockReason} hasSelection={hasSelectionState}
          guideSummary={alignGuideSummary}
          hasVectorTarget={alignHasVectorTarget}
          canTargetVectorStrokes={alignCanTargetVectorStrokes}
          vectorStrokeCount={alignVectorStrokeCount}
          selectedVectorStrokeCount={alignSelectedVectorStrokeCount}
          hasTextTarget={alignHasTextTarget}
          onOpenGuides={() => setIsRulerModalOpen(true)}
          onAlign={runAlign} onDistribute={runDistribute} onClose={closeAlign} /></Suspense>
      </OverlayPresence>, toolDockHosts.align)}
      {createPortal(<OverlayPresence open={filterMenuOpen} kind="popover">
        <Suspense fallback={null}><LayerFilterDialog embedded={filterDocked} key={layerFilterId ?? 'list'} filterId={layerFilterId} busy={filterBusy} refining={filterRefining}
          layerName={activeLayer?.name ?? ''} layerType={activeLayer?.layerType} histogram={filterHistogram} target={filterTargetOptions}
          onReadThumbnail={filterCallbacks.readThumbnail} onStartPoint={filterCallbacks.startPoint}
          onChoose={chooseFilter} onBack={() => chooseFilter(null)} onClose={closeFilters}
          onPreview={filterCallbacks.parameters} onPreviewJob={filterCallbacks.libraryPreview}
          onApply={(values) => layerFilterId ? runLayerFilter({ id: layerFilterId, values }, false) : Promise.resolve(false)}
          onApplyJob={(job) => runLayerFilter(job, false)} /></Suspense>
      </OverlayPresence>, toolDockHosts.filters)}
      {isColorCurvesOpen && <Suspense fallback={null}><ColorCurvesModal
        isOpen={isColorCurvesOpen}
        busy={filterBusy}
        target={filterTargetOptions}
        onClose={closeFilters}
        onPreview={filterCallbacks.curves}
        onApply={(options) => runLayerFilter({ id: 'curves', values: { options } }, false)}
      /></Suspense>}

      {isGradientMapOpen && <Suspense fallback={null}><GradientMapModal
        isOpen={isGradientMapOpen}
        busy={filterBusy}
        target={filterTargetOptions}
        onClose={closeFilters}
        onPreview={filterCallbacks.gradient}
        onApply={(stops, opacity) => runLayerFilter({ id: 'gradient', values: { stops, opacity } }, false)}
      /></Suspense>}

      <OverlayPresence open={fill.fullFillLayer !== null} kind="dialog">
        <AtelierModal title={t.toolOptions.fullFillTitle} icon={<AlertCircle />} width="sm"
          onClose={() => fill.finishFullFill(false)}
          footer={<>
            <button type="button" className={modalButton.secondary} onClick={() => fill.finishFullFill(false)}>{t.common.cancel}</button>
            <button type="button" className={modalButton.primary} onClick={() => fill.finishFullFill(true)}>{t.toolOptions.applyFill}</button>
          </>}>
          <p className="break-words text-sm text-neutral-300">{t.toolOptions.fullFillMessage.replace('{layer}', () => fill.fullFillLayer ?? '')}</p>
        </AtelierModal>
      </OverlayPresence>
      <OverlayPresence open={Boolean(filterMemoryConfirm)} kind="dialog">
        <AtelierModal
          title={t.filters.newLayerConfirmTitle}
          icon={<AlertCircle />}
          width="sm"
          onClose={() => setFilterMemoryConfirm(null)}
          footer={(
            <>
              <button type="button" className={modalButton.secondary} onClick={() => setFilterMemoryConfirm(null)}>
                {filterTargetOptions.canApplyCurrent ? t.filters.stayCurrentLayer : t.common.cancel}
              </button>
              <button type="button" className={modalButton.primary} onClick={() => {
                const pending = filterMemoryConfirm;
                filterMemoryConfirmedRef.current = filterCanvasSizeKey;
                setFilterMemoryConfirm(null);
                clearFilterPreview();
                forgetFilterHistogram();
                setFilterApplyNewLayer(true);
                if (pending?.openTo === 'curves') openFilterUI('curves');
                else if (pending?.openTo === 'gradient') openFilterUI('gradient');
                else if (pending?.openTo === 'menu') openFilterUI();
              }}>
                {t.filters.continueNewLayer}
              </button>
            </>
          )}
        >
          <p className="leading-relaxed text-neutral-300">
            {t.filters.newLayerConfirmBody
              .replace('{w}', String(canvas?.width ?? 0))
              .replace('{h}', String(canvas?.height ?? 0))
              .replace('{mb}', String(filterMemoryPlan.estimatedMB))}
          </p>
        </AtelierModal>
      </OverlayPresence>
    </div>
  );
};
