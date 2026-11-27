import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  ADJUSTMENT_KINDS,
  BlendMode,
  LayerModel,
  LayerType,
  computeTidiedAscendingNonMaskIds,
  filterTopLevelSelectedLayers,
  hasActiveLayerEffects,
  isLayerRulerEffectiveForLayer,
  orderLayersForReparenting,
  resolveEffectiveLayerColor,
  resolveEffectivePaletteColor,
  selectLayerRange,
  tidyLayerModels,
} from '@atelier/shared';
import type { AdjustmentKind, LayerColorMeta, LayerEffectsMeta, LayerRulerMeta, PaletteColorDisplayMode } from '@atelier/shared';
import { RulerManager } from '../engine/RulerManager';
import { FolderAccessPanel } from './FolderAccessPanel';
import type { FolderAccess } from './workspace/useFolderAccess';
import { type DroppedImages, type ImageDropTarget, isImageDrag, readDroppedImages } from '../utils/imageImport';
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Crown,
  Edit2,
  Eye,
  EyeOff,
  Folder,
  FolderPlus,
  GripVertical,
  HandMetal,
  Layers,
  Lock,
  Plus,
  Scissors,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Grip,
  Spline,
  Square,
  Trash2,
  Unlock,
  UserCheck,
  UserPlus,
  X,
  Film,
  Camera,
  Music,
  Repeat,
  Type as TypeIcon,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../context/I18nContext';
import type { Translations } from '../locales';
import {
  LOCAL_ARTIST_USER_ID,
  getLayerDrawGuidanceState,
  hasAnyDrawableLayerForUser,
  isBlockedOnlineGuestName,
  isLayerDrawableForUser,
  resolveLayerOwnerDisplay,
} from '../utils/roomJoinGuard';
import { AdminConfirmModal } from './AdminConfirmModal';
import { getUserColor } from '../utils/userColors';
import { nextGroupName } from '../utils/canvasName';
import { useAnchoredPopover } from '../utils/popoverPosition';
import { useWheelStep } from '../hooks/useWheelStep';
import { ADJUSTMENT_KIND_ICONS, mergeIncludesAdjustment } from './adjustmentLayerMenu';
import { LayerPaletteColorControl, LayerPaperRow, LayerTintControls, LayerTintSwatch, type ColorScope } from './LayerColorControls';
import { LayerEffectsPopover } from './LayerEffectsPopover';
import { getPaletteContrastColor } from '../utils/layerColorDisplay';

/** Public / ownerless layers: neutral, so they never look like one painter's (every user colour is saturated) */
const PUBLIC_COLOR = '#9CA3AF';
const ownerColor = (ownerId: LayerModel['ownerId'], isPublic: boolean) => isPublic || !ownerId ? PUBLIC_COLOR : getUserColor(ownerId).hex;

const LayerOpacityRange: React.FC<{
  disabled: boolean;
  opacity: number;
  onChange: (nextOpacity: number) => void;
  ariaLabel?: string;
}> = ({ disabled, opacity, onChange, ariaLabel }) => {
  const pct = Math.max(0, Math.min(100, Math.round(opacity * 100)));
  const trackRef = useRef<HTMLDivElement>(null);
  useWheelStep(
    trackRef,
    disabled
      ? undefined
      : (steps, e) => {
          const mult = e.shiftKey ? 10 : 2;
          const next = Math.max(0, Math.min(100, pct + steps * mult));
          if (next !== pct) onChange(next / 100);
        }
  );
  const fromClientX = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return;
    const next = Math.max(0, Math.min(100, Math.round(((clientX - r.left) / r.width) * 100)));
    if (next !== pct) onChange(next / 100);
  };
  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel || 'Layer opacity'}
      aria-disabled={disabled}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${pct}%`}
      title={`${ariaLabel || 'Opacity'}: ${pct}%`}
      style={{
        touchAction: 'none',
        backgroundImage: 'repeating-conic-gradient(rgb(var(--n-700) / .55) 0% 25%, rgb(var(--n-800) / .75) 0% 50%)',
        backgroundSize: '8px 8px',
      }}
      onPointerDown={(e) => {
        if (disabled) return;
        e.stopPropagation();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
        fromClientX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (disabled) return;
        if ((e.buttons & 1) || e.currentTarget.hasPointerCapture?.(e.pointerId)) fromClientX(e.clientX);
      }}
      onPointerUp={(e) => {
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      }}
      onKeyDown={(e) => {
        if (disabled) return;
        const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 2
          : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -2
          : e.key === 'PageUp' ? 10 : e.key === 'PageDown' ? -10 : 0;
        if (step) {
          e.preventDefault();
          onChange(Math.max(0, Math.min(100, pct + step)) / 100);
        } else if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          onChange(e.key === 'End' ? 1 : 0);
        }
      }}
      className={`relative h-5 min-w-[64px] flex-1 max-w-[104px] overflow-hidden rounded border border-neutral-700 outline-none ${
        disabled ? 'cursor-not-allowed opacity-40' : 'cursor-ew-resize'
      }`}
    >
      <div
        className="pointer-events-none absolute inset-y-0 left-0"
        style={{
          width: `${pct}%`,
          background: 'linear-gradient(to right, rgb(var(--a-500) / 0.35), rgb(var(--a-500) / 0.9))',
        }}
      />
      <div
        className="pointer-events-none absolute inset-y-0 w-1 -translate-x-1/2 bg-neutral-100 shadow"
        style={{ left: `${pct}%` }}
      />
    </div>
  );
};

interface LayerPanelProps {
  layers: LayerModel[];
  activeLayerId: string | null;
  thumbnails?: Record<string, string>;
  subscribeThumbnails?: (cb: () => void) => () => void;
  getThumbnailsSnapshot?: () => Record<string, string>;
  onRequestThumbnail?: (layerId: string) => void;
  roomMembers?: Array<{ userId: string; displayName: string; role?: string }>;
  onSelectLayer: (layerId: string) => void;
  onCreateLayer: (
    name: string,
    blendMode?: BlendMode,
    layerType?: LayerType,
    aboveLayerId?: string | null,
    parentId?: string | null
  ) => void;
  onCreateRaster?: () => void;
  onCreateVector?: () => void;
  onCreateGroup?: () => void;
  onCreateAdjustmentLayer?: (kind: AdjustmentKind) => void;
  onEditAdjustmentLayer?: (layerId: string) => void;
  onRequestCreateMyLayer?: () => void;
  onToggleLock: (layer: LayerModel) => void;
  onToggleVisibility: (layer: LayerModel) => void;
  onDeleteLayer: (layerId: string) => void;
  onReleaseLayer: (layerId: string) => void;
  onClaimLayer: (layerId: string, force?: boolean) => void;
  onTransferLayer?: (layerId: string, targetUserId: string) => void;
  onReorderLayer: (layerId: string, newSortOrder: number, ascendingIds?: string[]) => void | Promise<void>;
  onUpdateLayerProps?: (layerId: string, props: Partial<LayerModel>) => void | Promise<void>;
  onPreviewLayerEffects?: (layerId: string, effects: LayerEffectsMeta | null) => void;
  onBakeScreentone?: (layerId: string, params: { density: number; angleRad: number; dotScale: number }) => void;
  /** Per-viewer visibility overrides (not synced): layerId -> shown for me */
  localVisibility?: Record<string, boolean>;
  onToggleLocalVisibility?: (layerId: string) => void;
  /** Adds a layer mask that shows everything (white) */
  onAddMask?: (layerId: string) => void;
  /** Ctrl+click on a thumbnail: the layer's opaque pixels become the selection */
  onLoadLayerSelection?: (layerId: string) => void;
  onMergeDown?: (layerId: string) => void;
  /** Selects the layer and opens the align window (對齊) */
  onOpenAlign?: (layerId?: string) => void;
  selectedLayerIds?: Set<string>;
  onSelectedLayerIdsChange?: (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  /** Puts these layers into a new group (inside their common group) */
  onGroupLayers?: (layerIds: string[]) => void;
  /** 複製圖層 / 貼上圖層 (the copy works across canvases in this tab) */
  onCopyLayers?: (layerIds: string[]) => void;
  onPasteLayers?: () => void;
  onDuplicateLayers?: (layerIds: string[]) => void;
  /** Image files dropped on the list: each becomes a new layer at that spot */
  onImportImages?: (dropped: DroppedImages, target: ImageDropTarget) => void;
  /** 「重新整理後保留圖層剪貼簿」: the copy is also kept in localStorage */
  keepLayerClipboard?: boolean;
  onToggleKeepLayerClipboard?: () => void;
  /** Whether this viewer may restructure the layer (merge / group): their own, or an admin / room owner */
  canManage?: (layer: LayerModel) => boolean;
  folderAccess?: FolderAccess;
  /** True when the current user is the creator/owner/admin of this room */
  isRoomAdmin?: boolean;
  /** True when the current user has a read-only room role (e.g. viewer) */
  isReadOnly?: boolean;
  /** True when viewing a local offline solo canvas */
  isOfflineCanvas?: boolean;
  canvasBgColor: string;
  paperVisible: boolean;
  onTogglePaperVisible: () => void;
  localPaperColor: string | null;
  onChangePaperColor: (color: string | null, scope: ColorScope) => void;
  paletteColorMode: PaletteColorDisplayMode;
  onChangePaletteColorMode: (mode: PaletteColorDisplayMode) => void;
  localPaletteColors: Record<string, string | null>;
  onChangeLocalPaletteColor: (ids: string[], color: string | null | undefined) => void;
  localLayerColors: Record<string, LayerColorMeta | null>;
  onChangeLocalLayerColor: (id: string, config: LayerColorMeta | null | undefined) => void;
  /** Opens sign-in modal when guest clicks login CTA in layer guidance */
  onOpenAuth?: () => void;
  /** Opens the ruler controls modal from a layer ruler badge or context menu */
  onOpenRulerModal?: () => void;
}

export interface BlendModeGroup {
  category: string;
  icon: string;
  items: Array<{ value: BlendMode; label: string; en: string }>;
}

export const getLocalizedBlendModeGroups = (t: Translations): BlendModeGroup[] => [
  {
    category: t.blendModes.groupNormal,
    icon: '⚪',
    items: [{ value: 'normal', label: t.blendModes.normal, en: 'Normal' }],
  },
  {
    category: t.blendModes.groupDarken,
    icon: '🌑',
    items: [
      { value: 'multiply', label: t.blendModes.multiply, en: 'Multiply' },
      { value: 'darken', label: t.blendModes.darken, en: 'Darken' },
      { value: 'color_burn', label: t.blendModes.colorBurn, en: 'Color Burn' },
      { value: 'linear_burn', label: t.blendModes.linearBurn, en: 'Linear Burn' },
      { value: 'darker_color', label: t.blendModes.darkerColor, en: 'Darker Color' },
    ],
  },
  {
    category: t.blendModes.groupLighten,
    icon: '☀️',
    items: [
      { value: 'screen', label: t.blendModes.screen, en: 'Screen' },
      { value: 'lighten', label: t.blendModes.lighten, en: 'Lighten' },
      { value: 'color_dodge', label: t.blendModes.colorDodge, en: 'Color Dodge' },
      { value: 'add', label: t.blendModes.add, en: 'Add / Linear Dodge' },
      { value: 'glow', label: t.blendModes.glow, en: 'Glow' },
      { value: 'lighter_color', label: t.blendModes.lighterColor, en: 'Lighter Color' },
    ],
  },
  {
    category: t.blendModes.groupContrast,
    icon: '🌓',
    items: [
      { value: 'overlay', label: t.blendModes.overlay, en: 'Overlay' },
      { value: 'soft_light', label: t.blendModes.softLight, en: 'Soft Light' },
      { value: 'hard_light', label: t.blendModes.hardLight, en: 'Hard Light' },
      { value: 'vivid_light', label: t.blendModes.vividLight, en: 'Vivid Light' },
      { value: 'linear_light', label: t.blendModes.linearLight, en: 'Linear Light' },
      { value: 'pin_light', label: t.blendModes.pinLight, en: 'Pin Light' },
      { value: 'hard_mix', label: t.blendModes.hardMix, en: 'Hard Mix' },
    ],
  },
  {
    category: t.blendModes.groupDifference,
    icon: '🔄',
    items: [
      { value: 'difference', label: t.blendModes.difference, en: 'Difference' },
      { value: 'exclusion', label: t.blendModes.exclusion, en: 'Exclusion' },
      { value: 'subtract', label: t.blendModes.subtract, en: 'Subtract' },
      { value: 'divide', label: t.blendModes.divide, en: 'Divide' },
    ],
  },
  {
    category: t.blendModes.groupComponent,
    icon: '🎨',
    items: [
      { value: 'hue', label: t.blendModes.hue, en: 'Hue' },
      { value: 'saturation', label: t.blendModes.saturation, en: 'Saturation' },
      { value: 'color', label: t.blendModes.color, en: 'Color' },
      { value: 'luminosity', label: t.blendModes.luminosity, en: 'Luminosity' },
    ],
  },
];

const BlendModeDropdown: React.FC<{
  value: BlendMode;
  onChange: (mode: BlendMode) => void;
  disabled?: boolean;
}> = ({ value, onChange, disabled }) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPopover(isOpen, containerRef, popRef, { align: 'left', gap: 4, margin: 8, fallbackWidth: 240, fallbackHeight: 288 });
  const groups = getLocalizedBlendModeGroups(t);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  let currentLabel = 'Normal';
  for (const grp of groups) {
    const found = grp.items.find((item) => item.value === value);
    if (found) {
      currentLabel = found.label;
      break;
    }
  }

  return (
    <div ref={containerRef} className="relative inline-block text-left" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        className="px-2 py-0.5 rounded bg-neutral-900 border border-neutral-700/80 hover:border-indigo-500 text-[10px] font-medium text-neutral-200 flex items-center gap-1 transition shadow-sm disabled:opacity-40"
      >
        <span className="truncate max-w-[110px] sm:max-w-[130px]">{currentLabel}</span>
        <ChevronDown className="w-2.5 h-2.5 text-neutral-400 shrink-0" />
      </button>

      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={pos.setPopoverEl}
          onClick={(e) => e.stopPropagation()}
          style={{ top: pos.top, left: pos.left, maxHeight: Math.min(288, pos.maxHeight) }}
          className="fixed w-60 max-w-[calc(100vw-16px)] overflow-y-auto bg-neutral-900/95 backdrop-blur-xl border border-neutral-700 rounded-xl shadow-2xl p-1 z-[95] animate-in fade-in zoom-in-95"
        >
          {groups.map((grp) => (
            <div key={grp.category} className="mb-1.5 last:mb-0">
              <div className="px-2 py-0.5 text-[9px] font-bold text-neutral-500 uppercase tracking-wider flex items-center gap-1 border-b border-neutral-800">
                <span>{grp.icon}</span>
                <span>{grp.category}</span>
              </div>
              <div className="mt-0.5 space-y-0.5">
                {grp.items.map((item) => {
                  const isSelected = item.value === value;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => {
                        onChange(item.value);
                        setIsOpen(false);
                      }}
                      className={`w-full px-2 py-1 rounded-lg text-left text-[10px] flex items-center justify-between transition ${
                        isSelected
                          ? 'bg-indigo-600 text-white font-bold shadow-sm'
                          : 'text-neutral-300 hover:bg-neutral-800/90 hover:text-white'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 truncate">
                        <span>{item.label}</span>
                        <span className={`text-[9px] truncate ${isSelected ? 'text-indigo-200' : 'text-neutral-500'}`}>
                          ({item.en})
                        </span>
                      </div>
                      {isSelected && <Check className="w-3 h-3 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
};

const EMPTY_THUMBS: Record<string, string> = {};
const noopSubscribe = () => () => {};
const LayerThumbImg: React.FC<{
  layerId: string;
  thumbnails: Record<string, string>;
  subscribeThumbnails?: (cb: () => void) => () => void;
  getThumbnailsSnapshot?: () => Record<string, string>;
  onRequestThumbnail?: (layerId: string) => void;
  className: string;
}> = ({ layerId, thumbnails, subscribeThumbnails, getThumbnailsSnapshot, onRequestThumbnail, className }) => {
  const url = useSyncExternalStore(
    subscribeThumbnails ?? noopSubscribe,
    () => (getThumbnailsSnapshot ? getThumbnailsSnapshot()[layerId] : thumbnails[layerId]),
  );
  React.useEffect(() => {
    if (!url) onRequestThumbnail?.(layerId);
  }, [layerId, url, onRequestThumbnail]);
  return url ? <img src={url} alt="" className={className} /> : null;
};

export const LayerPanel: React.FC<LayerPanelProps> = ({
  layers: allLayers,
  activeLayerId,
  thumbnails = EMPTY_THUMBS,
  subscribeThumbnails,
  getThumbnailsSnapshot,
  onRequestThumbnail,
  roomMembers = [],
  onSelectLayer,
  onCreateLayer,
  onCreateRaster,
  onCreateVector,
  onCreateGroup,
  onCreateAdjustmentLayer,
  onEditAdjustmentLayer,
  onRequestCreateMyLayer,
  onToggleLock,
  onToggleVisibility,
  onDeleteLayer,
  onReleaseLayer,
  onClaimLayer,
  onTransferLayer,
  onReorderLayer,
  onUpdateLayerProps,
  onPreviewLayerEffects,
  onBakeScreentone,
  localVisibility = {},
  onToggleLocalVisibility,
  onAddMask,
  onLoadLayerSelection,
  onMergeDown,
  onOpenAlign,
  selectedLayerIds: controlledSelectedLayerIds,
  onSelectedLayerIdsChange,
  onGroupLayers,
  onCopyLayers,
  onPasteLayers,
  onDuplicateLayers,
  onImportImages,
  keepLayerClipboard,
  onToggleKeepLayerClipboard,
  canManage: canManageProp,
  folderAccess,
  isRoomAdmin,
  isReadOnly,
  isOfflineCanvas = false,
  canvasBgColor,
  paperVisible,
  onTogglePaperVisible,
  localPaperColor,
  onChangePaperColor,
  paletteColorMode,
  onChangePaletteColorMode,
  localPaletteColors,
  onChangeLocalPaletteColor,
  localLayerColors,
  onChangeLocalLayerColor,
  onOpenAuth,
  onOpenRulerModal,
}) => {
  const { t } = useI18n();
  const { isGuest, user } = useAuth();
  const readOnly = (!isOfflineCanvas && isGuest) || Boolean(isReadOnly);
  // Masks are not rows: each shows as a second thumbnail on the layer it belongs to
  const layers = allLayers.filter((l) => l.layerType !== 'mask');
  const maskOf = new Map(allLayers.filter((l) => l.layerType === 'mask' && l.parentId).map((m) => [m.parentId as string, m]));
  const activeMask = allLayers.find((l) => l.id === activeLayerId && l.layerType === 'mask') || null;
  const [effectsOpenSignal, setEffectsOpenSignal] = useState(0);
  const canManage = (l: LayerModel) => isOfflineCanvas ? !readOnly : (canManageProp ? canManageProp(l) : Boolean(user && l.ownerId === user.id));
  const canAddToFolder = (folder: LayerModel) => isOfflineCanvas
    ? !readOnly && !folder.isLocked
    : (folderAccess?.canAdd(folder) ?? canManage(folder));
  // Groups nest: a row's depth and whether a collapsed group above hides it
  const byId = new Map(layers.map((l) => [l.id, l]));
  const displayMode = isOfflineCanvas ? 'shared' : paletteColorMode;
  const paletteColorOf = (id: string, mode = displayMode) => resolveEffectivePaletteColor(id, byId, {
    displayMode: mode,
    localOverrides: isOfflineCanvas ? undefined : localPaletteColors,
    ownerColorOf: (layer) => ownerColor(layer.ownerId, Boolean(byId.get(layer.id)?.isPublic)),
  }).color;
  const tintOf = (id: string) => resolveEffectiveLayerColor(id, byId, isOfflineCanvas ? undefined : localLayerColors);
  const ancestorsOf = (l: LayerModel) => {
    const out: LayerModel[] = [];
    for (let p = l.parentId ? byId.get(l.parentId) : undefined; p && out.length < 16; p = p.parentId ? byId.get(p.parentId) : undefined) out.push(p);
    return out;
  };
  /** The layer merge-down would merge into: the next one down in the same group */
  const belowOf = (l: LayerModel) => {
    const siblings = layers.filter((x) => (x.parentId ?? null) === (l.parentId ?? null)).sort((a, b) => a.sortOrder - b.sortOrder);
    return siblings[siblings.indexOf(l) - 1] ?? null;
  };
  const mergeBlocker = (l: LayerModel) => {
    const below = belowOf(l);
    if (mergeIncludesAdjustment(l.layerType, below?.layerType)) return t.layers.mergeBlockAdjustment;
    if (l.layerType === 'group') return t.layers.mergeBlockGroup;
    if (!below) return t.layers.mergeBlockNoBelow;
    if (below.layerType === 'group') return t.layers.mergeBlockBelowGroup;
    if (below.layerType === 'text' || below.layerType === 'vector') return t.layers.mergeBlockTextVector;
    if (!canManage(l) || !canManage(below)) return t.layers.mergeBlockOtherOwner;
    return null;
  };
  const [menu, setMenu] = useState<{ x: number; y: number; layerId: string } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && (e.target as HTMLElement)?.closest?.('[data-layer-menu]')) return;
      setMenu(null);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [menu]);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAdmin = Boolean(isRoomAdmin || user?.serverRole === 'admin');

  // Group folding state
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Transfer Ownership popover state: layerId -> boolean
  const [transferLayerId, setTransferLayerId] = useState<string | null>(null);
  const transferBtnRef = useRef<HTMLButtonElement>(null);
  const transferPopRef = useRef<HTMLDivElement>(null);
  const transferPos = useAnchoredPopover(Boolean(transferLayerId), transferBtnRef, transferPopRef, { align: 'right', gap: 4, margin: 8, fallbackWidth: 208 });
  const batchGroupBtnRef = useRef<HTMLButtonElement>(null);
  const batchGroupPopRef = useRef<HTMLDivElement>(null);
  const [adjustmentMenuOpen, setAdjustmentMenuOpen] = useState(false);
  const adjustmentBtnRef = useRef<HTMLButtonElement>(null);
  const adjustmentPopRef = useRef<HTMLDivElement>(null);
  const canCreateLayer = Boolean(!readOnly && (onCreateRaster || onCreateLayer || (!isOfflineCanvas && onRequestCreateMyLayer)));
  const showAdjustmentMenu = Boolean(canCreateLayer && onCreateAdjustmentLayer && adjustmentMenuOpen);
  const adjustmentPos = useAnchoredPopover(showAdjustmentMenu, adjustmentBtnRef, adjustmentPopRef, { gap: 4, margin: 8, fallbackWidth: 208 });

  useEffect(() => {
    if (!canCreateLayer || !onCreateAdjustmentLayer) setAdjustmentMenuOpen(false);
  }, [canCreateLayer, onCreateAdjustmentLayer]);

  // Group selector popover state
  const [groupSelectLayerId, setGroupSelectLayerId] = useState<string | null>(null);

  // Inline Layer / Group Rename state
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>('');
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const lastTapRef = useRef<{ id: string; time: number }>({ id: '', time: 0 });
  const lastAdjustmentTapRef = useRef<{ id: string; time: number }>({ id: '', time: 0 });

  // Mobile Batch Selection state
  const [isBatchMode, setIsBatchMode] = useState<boolean>(false);
  const [internalSelectedLayerIds, setInternalSelectedLayerIds] = useState<Set<string>>(new Set());
  const selectedLayerIds = controlledSelectedLayerIds ?? internalSelectedLayerIds;
  const setSelectedLayerIds = onSelectedLayerIdsChange ?? setInternalSelectedLayerIds;
  const [batchGroupMenuOpen, setBatchGroupMenuOpen] = useState<boolean>(false);
  const batchGroupPos = useAnchoredPopover(batchGroupMenuOpen, batchGroupBtnRef, batchGroupPopRef, { align: 'right', gap: 4, margin: 8, fallbackWidth: 176 });

  useEffect(() => {
    if (!transferLayerId && !batchGroupMenuOpen && !showAdjustmentMenu) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!transferBtnRef.current?.contains(target) && !transferPopRef.current?.contains(target)) setTransferLayerId(null);
      if (!batchGroupBtnRef.current?.contains(target) && !batchGroupPopRef.current?.contains(target)) setBatchGroupMenuOpen(false);
      if (!adjustmentBtnRef.current?.contains(target) && !adjustmentPopRef.current?.contains(target)) setAdjustmentMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTransferLayerId(null);
        setBatchGroupMenuOpen(false);
        setAdjustmentMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [transferLayerId, batchGroupMenuOpen, showAdjustmentMenu]);

  // Drag and Drop state
  const [draggedLayerId, setDraggedLayerId] = useState<string | null>(null);
  const [dragOverLayerId, setDragOverLayerId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<'above' | 'below' | 'inside' | null>(null);
  // An image file dragged over the empty space under the rows (goes to the very bottom)
  const [fileDropAtEnd, setFileDropAtEnd] = useState(false);
  const isFileDrag = (e: React.DragEvent) => !draggedLayerId && Boolean(onImportImages) && !readOnly && isImageDrag(e.dataTransfer);

  // Touch Drag Refs
  const isTouchDraggingRef = useRef<boolean>(false);
  const activeDraggedIdRef = useRef<string | null>(null);
  const activeOverIdRef = useRef<string | null>(null);
  const activeDropPosRef = useRef<'above' | 'below' | 'inside' | null>(null);
  // Shift + left-mouse drag multi-select state
  const selectionAnchorIdRef = useRef<string | null>(null);
  const isShiftDragSelectingRef = useRef<boolean>(false);
  const suppressNextRowClickRef = useRef<boolean>(false);
  const visibleDescendingIdsRef = useRef<string[]>([]);
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const [listScroll, setListScroll] = useState({ top: 0, height: 600 });
  React.useEffect(() => {
    const el = listContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setListScroll((prev) => (prev.height === el.clientHeight ? prev : { top: el.scrollTop, height: el.clientHeight || 600 }));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Admin Force Claim modal state
  const [forceClaimTarget, setForceClaimTarget] = useState<LayerModel | null>(null);

  // Listen for F2 / Custom Rename Layer Event
  useEffect(() => {
    const onGroup = (ev: Event) => {
      ev.preventDefault(); // handled here: the panel knows the multi-selection
      const ids = selectedLayerIds.size > 0 ? Array.from(selectedLayerIds) : activeLayerId ? [activeLayerId] : [];
      if (ids.length) onGroupLayers?.(ids);
      setSelectedLayerIds(new Set());
    };
    window.addEventListener('atelier:group-layers', onGroup);
    return () => window.removeEventListener('atelier:group-layers', onGroup);
  });

  useEffect(() => {
    const handleRenameEvent = (ev: any) => {
      const targetId = ev.detail?.layerId || activeLayerId;
      if (targetId) {
        const target = layers.find((l) => l.id === targetId);
        if (target) {
          setEditingLayerId(target.id);
          setEditingName(target.name);
        }
      }
    };
    window.addEventListener('atelier:rename-layer', handleRenameEvent);
    return () => window.removeEventListener('atelier:rename-layer', handleRenameEvent);
  }, [activeLayerId, layers]);

  // Auto focus and select input text when entering rename mode
  useEffect(() => {
    if (editingLayerId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingLayerId]);

  const handleStartRename = (layer: LayerModel, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setEditingLayerId(layer.id);
    setEditingName(layer.name);
  };

  const handleSaveRename = (layerId: string) => {
    const trimmed = editingName.trim();
    if (trimmed && onUpdateLayerProps) {
      onUpdateLayerProps(layerId, { name: trimmed });
    }
    setEditingLayerId(null);
  };

  const handleCancelRename = () => {
    setEditingLayerId(null);
  };

  // Direct 1-click creation helpers (creates right above currently active layer)
  const handleDirectAddRaster = () => {
    if (onCreateRaster) {
      onCreateRaster();
      return;
    }
    const rasterCount = layers.filter((l) => l.layerType !== 'vector' && l.layerType !== 'group').length + 1;
    onCreateLayer(`圖層 ${rasterCount}`, 'normal', 'raster', activeLayerId);
  };

  const handleDirectAddVector = () => {
    if (onCreateVector) {
      onCreateVector();
      return;
    }
    const vectorCount = layers.filter((l) => l.layerType === 'vector').length + 1;
    onCreateLayer(`向量線稿 ${vectorCount}`, 'normal', 'vector', activeLayerId);
  };

  const handleDirectAddGroup = () => {
    if (onCreateGroup) {
      onCreateGroup();
      return;
    }
    onCreateLayer(nextGroupName(allLayers), 'normal', 'group', activeLayerId);
  };

  // Stable tree-coherent descending sort (display: top-to-bottom, each group sits directly above its children)
  const getSortedDescending = () => [...tidyLayerModels(layers).layers].reverse();

  // Find clipping base layers (layers that have another layer immediately above them with clipToBelow=true)
  const baseClippingIds = new Set<string>();
  const descLayers = getSortedDescending();
  for (let i = 0; i < descLayers.length - 1; i++) {
    if (descLayers[i].clipToBelow) {
      baseClippingIds.add(descLayers[i + 1].id);
    }
  }

  /** The layer itself or anything inside it (a group's content, nested groups too) */
  const isWithin = (l: LayerModel, rootId: string) => l.id === rootId || ancestorsOf(l).some((a) => a.id === rootId);

  // Unified reorder logic for both Mouse Drop and Touch Drag. A group moves with its content. The
  // new parent is set before the order is sent: the server keeps every group's content right below it.
  const executeReorder = (fromId: string, toId: string, pos: 'above' | 'below' | 'inside', enterOpenGroup = true) => {
    const moving = byId.get(fromId);
    const target = byId.get(toId);
    // A group cannot go inside itself
    if (!moving || !target || isWithin(target, fromId)) return;
    // Just below an open group's row is its top layer's place: dropped there, the layer goes in
    const into = pos === 'inside' || (enterOpenGroup && pos === 'below' && target.layerType === 'group'
      && !collapsedGroups.has(target.id) && layers.some((l) => l.parentId === target.id));
    const parentId = into ? target.id : target.parentId && byId.has(target.parentId) ? target.parentId : null;
    const parent = parentId ? byId.get(parentId) : undefined;
    if ((moving.parentId ?? null) !== parentId && (!canManage(moving) || (parent && !canAddToFolder(parent)))) return;

    const list = getSortedDescending();
    const block = list.filter((l) => isWithin(l, fromId));
    const rest = list.filter((l) => !isWithin(l, fromId));
    let at = rest.findIndex((l) => l.id === toId);
    if (into || pos === 'below') {
      at += 1;
      // Below a closed group: past everything inside it
      if (!into) while (at < rest.length && isWithin(rest[at], toId)) at++;
    }
    rest.splice(at, 0, ...block);
    const ascendingIds = [...rest].reverse().map((l) => l.id);
    const send = () => onReorderLayer(fromId, (rest.length - rest.indexOf(moving)) * 10, ascendingIds);
    if ((moving.parentId && byId.has(moving.parentId) ? moving.parentId : null) === parentId) return send();
    void Promise.resolve(onUpdateLayerProps?.(fromId, { parentId })).then(send);
  };

  /** The layers sharing this one's group (or the top level), top first */
  const siblingsOf = (layer: LayerModel) => {
    const parentOf = (l: LayerModel) => (l.parentId && byId.has(l.parentId) ? l.parentId : null);
    return getSortedDescending().filter((l) => parentOf(l) === parentOf(layer));
  };
  // Up / Down buttons: past the next layer in the same group (a group: past its whole content), as in CSP
  const handleMoveOrder = (layer: LayerModel, direction: 'up' | 'down') => {
    const siblings = siblingsOf(layer);
    const i = siblings.findIndex((l) => l.id === layer.id);
    const other = siblings[direction === 'up' ? i - 1 : i + 1];
    if (i < 0 || !other) return;
    executeReorder(layer.id, other.id, direction === 'up' ? 'above' : 'below', false);
  };

  // Desktop HTML5 Drag & Drop handlers
  const handleDragStart = (e: React.DragEvent, layerId: string) => {
    if (e.shiftKey || isShiftDragSelectingRef.current) {
      e.preventDefault();
      return;
    }
    setDraggedLayerId(layerId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', layerId);
  };

  /** Where on a row the pointer is: above / below it, or inside a group (the middle of its row) */
  const rowDropPos = (e: React.DragEvent, targetId: string): 'above' | 'below' | 'inside' => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relY = e.clientY - rect.top;
    const isGroup = layers.find((l) => l.id === targetId)?.layerType === 'group';
    if (isGroup && relY >= rect.height * 0.22 && relY <= rect.height * 0.78) return 'inside';
    return relY < rect.height / 2 ? 'above' : 'below';
  };

  const handleDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const fileDrag = isFileDrag(e);
    if (fileDrag) {
      e.stopPropagation(); // not the canvas, not the "under every row" spot
      e.dataTransfer.dropEffect = 'copy';
      setFileDropAtEnd(false);
    } else if (!draggedLayerId || draggedLayerId === targetId) return;

    setDragOverLayerId(targetId);
    setDropPosition(rowDropPos(e, targetId));
  };

  const handleDragLeave = () => {
    setDragOverLayerId(null);
    setDropPosition(null);
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (isFileDrag(e)) {
      e.stopPropagation();
      // From the drop itself: the last dragover's state may not have rendered yet
      onImportImages!(readDroppedImages(e.dataTransfer), { layerId: targetId, pos: rowDropPos(e, targetId) });
    } else if (draggedLayerId && draggedLayerId !== targetId && dropPosition) {
      executeReorder(draggedLayerId, targetId, dropPosition);
    }
    setDraggedLayerId(null);
    setDragOverLayerId(null);
    setDropPosition(null);
  };

  const handleDragEnd = () => {
    setDraggedLayerId(null);
    setDragOverLayerId(null);
    setDropPosition(null);
  };

  // Mobile Touch / Pointer Drag Reorder Handler
  const startTouchDrag = (e: React.PointerEvent | PointerEvent, layerId: string) => {
    isTouchDraggingRef.current = true;
    activeDraggedIdRef.current = layerId;
    activeOverIdRef.current = null;
    activeDropPosRef.current = null;

    setDraggedLayerId(layerId);
    setDragOverLayerId(null);
    setDropPosition(null);

    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate(35);
      } catch {}
    }

    const onPointerMove = (ev: PointerEvent) => {
      if (!isTouchDraggingRef.current || !activeDraggedIdRef.current) return;

      if (listContainerRef.current) {
        const containerRect = listContainerRef.current.getBoundingClientRect();
        const topDist = ev.clientY - containerRect.top;
        const bottomDist = containerRect.bottom - ev.clientY;
        if (topDist < 45 && topDist > -20) {
          listContainerRef.current.scrollTop -= 8;
        } else if (bottomDist < 45 && bottomDist > -20) {
          listContainerRef.current.scrollTop += 8;
        }
      }

      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const targetCard = el?.closest('[data-layer-id]') as HTMLElement | null;

      if (targetCard) {
        const targetId = targetCard.getAttribute('data-layer-id');
        if (targetId && targetId !== activeDraggedIdRef.current) {
          const rect = targetCard.getBoundingClientRect();
          const relY = ev.clientY - rect.top;
          const isGroup = targetCard.getAttribute('data-is-group') === 'true';

          let pos: 'above' | 'below' | 'inside';
          if (isGroup && relY >= rect.height * 0.22 && relY <= rect.height * 0.78) {
            pos = 'inside';
          } else {
            pos = relY < rect.height / 2 ? 'above' : 'below';
          }

          if (activeOverIdRef.current !== targetId || activeDropPosRef.current !== pos) {
            activeOverIdRef.current = targetId;
            activeDropPosRef.current = pos;
            setDragOverLayerId(targetId);
            setDropPosition(pos);
          }
          return;
        }
      }

      if (activeOverIdRef.current) {
        activeOverIdRef.current = null;
        activeDropPosRef.current = null;
        setDragOverLayerId(null);
        setDropPosition(null);
      }
    };

    const onPointerUp = () => {
      if (
        isTouchDraggingRef.current &&
        activeDraggedIdRef.current &&
        activeOverIdRef.current &&
        activeDropPosRef.current
      ) {
        executeReorder(activeDraggedIdRef.current, activeOverIdRef.current, activeDropPosRef.current);
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          try {
            navigator.vibrate(25);
          } catch {}
        }
      }

      isTouchDraggingRef.current = false;
      activeDraggedIdRef.current = null;
      activeOverIdRef.current = null;
      activeDropPosRef.current = null;

      setDraggedLayerId(null);
      setDragOverLayerId(null);
      setDropPosition(null);

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  // Filter out child layers of collapsed groups for display list
  const allGroups = layers.filter((l) => l.layerType === 'group' && canAddToFolder(l));
  const availableTransferMembers = roomMembers.filter(
    (m) => m.userId !== user?.id && (isOfflineCanvas || m.userId !== LOCAL_ARTIST_USER_ID)
  );

  // Batch Selection helpers
  const handleToggleBatchSelect = (layerId: string) => {
    setSelectedLayerIds((prev) => {
      const next = new Set(prev);
      if (next.has(layerId)) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedLayerIds.size === layers.length) {
      setSelectedLayerIds(new Set());
    } else {
      setSelectedLayerIds(new Set(layers.map((l) => l.id)));
    }
  };

  const handleBatchGroupSelected = () => {
    if (selectedLayerIds.size === 0) return;
    onGroupLayers?.(Array.from(selectedLayerIds));
    setSelectedLayerIds(new Set());
    setIsBatchMode(false);
  };

  const moveLayersToGroup = async (ids: Iterable<string>, targetGroupId: string | null) => {
    if (!onUpdateLayerProps) return;
    const targetGroup = targetGroupId ? byId.get(targetGroupId) : undefined;
    const roots = filterTopLevelSelectedLayers(layers, ids).filter(
      (l) => !targetGroup || !isWithin(targetGroup, l.id)
    );
    if (!roots.length) return;
    const movedIds = new Set(roots.map((l) => l.id));
    const patched = allLayers.map((l) => (movedIds.has(l.id) ? { ...l, parentId: targetGroupId } : l));
    const ascendingIds = computeTidiedAscendingNonMaskIds(patched);
    for (const l of orderLayersForReparenting(allLayers, roots, targetGroupId)) {
      await Promise.resolve(onUpdateLayerProps(l.id, { parentId: targetGroupId }));
    }
    await Promise.resolve(onReorderLayer(roots[0].id, 0, ascendingIds));
  };

  const handleBatchMoveToGroup = (targetGroupId: string | null) => {
    if (selectedLayerIds.size === 0 || !onUpdateLayerProps) return;
    const ids = Array.from(selectedLayerIds);
    void moveLayersToGroup(ids, targetGroupId);
    setSelectedLayerIds(new Set());
    setIsBatchMode(false);
    setBatchGroupMenuOpen(false);
  };

  /** Shift + left-mouse drag sweeps across rows to multi-select contiguous layers */
  const startShiftDragSelect = (e: React.PointerEvent, startLayerId: string) => {
    const additive = e.ctrlKey || e.metaKey || isBatchMode;
    const baseSelection = additive ? new Set(selectedLayerIds) : new Set<string>();
    const startY = e.clientY;
    let didDrag = false;
    let lastHoverId = startLayerId;
    isShiftDragSelectingRef.current = true;

    const findRowLayerId = (clientX: number, clientY: number): string | null => {
      const direct = document.elementFromPoint(clientX, clientY)?.closest('[data-layer-id]') as HTMLElement | null;
      if (direct) return direct.getAttribute('data-layer-id');
      const container = listContainerRef.current;
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const clampedX = Math.max(rect.left + 8, Math.min(rect.right - 8, clientX));
      const clampedY = Math.max(rect.top + 4, Math.min(rect.bottom - 4, clientY));
      const fallback = document.elementFromPoint(clampedX, clampedY)?.closest('[data-layer-id]') as HTMLElement | null;
      return fallback?.getAttribute('data-layer-id') ?? null;
    };

    const onPointerMove = (ev: PointerEvent) => {
      if (!isShiftDragSelectingRef.current) return;
      const container = listContainerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const topDist = ev.clientY - rect.top;
        const bottomDist = rect.bottom - ev.clientY;
        if (topDist < 36 && topDist > -40) container.scrollTop -= 10;
        else if (bottomDist < 36 && bottomDist > -40) container.scrollTop += 10;
      }

      const hoverId = findRowLayerId(ev.clientX, ev.clientY);
      if (!hoverId) return;
      if (!didDrag && hoverId === startLayerId && Math.abs(ev.clientY - startY) <= 4) return;
      if (!didDrag || hoverId !== lastHoverId) {
        didDrag = true;
        lastHoverId = hoverId;
        setSelectedLayerIds(
          selectLayerRange(visibleDescendingIdsRef.current, startLayerId, hoverId, additive, baseSelection)
        );
      }
    };

    const finish = () => {
      isShiftDragSelectingRef.current = false;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (didDrag) {
        selectionAnchorIdRef.current = startLayerId;
        suppressNextRowClickRef.current = true;
        window.setTimeout(() => {
          suppressNextRowClickRef.current = false;
        }, 0);
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  // ---- Shared properties bar (CSP style): every setting acts on the selected layer ----
  // Editing a mask keeps its layer's properties in the bar
  const active = layers.find((l) => l.id === (activeMask?.parentId ?? activeLayerId)) || null;
  const activeLayerMask = active ? maskOf.get(active.id) : undefined;
  const activeIsOwner = Boolean(active && user?.id === active.ownerId);
  const canEditActive = Boolean(!readOnly && active && (isOfflineCanvas || activeIsOwner));
  const paletteTargets = selectedLayerIds.size > 1
    ? Array.from(selectedLayerIds).map((id) => byId.get(id)).filter((layer): layer is LayerModel => Boolean(layer))
    : active ? [active] : [];
  const canSyncPalette = Boolean(onUpdateLayerProps && !readOnly && paletteTargets.length
    && (isOfflineCanvas || paletteTargets.every((layer) => user?.id === layer.ownerId)));
  const changePaletteColor = (color: string | null | undefined, scope: ColorScope) => {
    if (scope === 'local') {
      onChangeLocalPaletteColor(paletteTargets.map((layer) => layer.id), color);
    } else if (canSyncPalette && color !== undefined) {
      for (const layer of paletteTargets) void onUpdateLayerProps?.(layer.id, { meta: { ...layer.meta, paletteColor: color } });
    }
  };
  const activeIsGroup = active?.layerType === 'group';
  const activeIsAdjustment = active?.layerType === 'adjustment';
  const descending = getSortedDescending();
  // Up / down move within the layer's own group
  const activeSiblings = active ? siblingsOf(active) : [];
  const activeIndex = active ? activeSiblings.findIndex((l) => l.id === active.id) : -1;
  const canMoveActive = Boolean(!readOnly && active && (isOfflineCanvas || activeIsOwner || isAdmin || active.isPublic || !active.ownerId));
  // A group goes with its content: something has to be left
  const canDeleteActive = Boolean(!readOnly && active && (activeIsOwner || isAdmin) && layers.some((l) => !isWithin(l, active.id)));
  const blendGroups = getLocalizedBlendModeGroups(t);
  const blendLabel = (mode: BlendMode) => {
    for (const grp of blendGroups) {
      const found = grp.items.find((item) => item.value === mode);
      if (found) return found.label;
    }
    return mode;
  };
  const iconBtn = (on: boolean, extra = '') =>
    `atelier-icon-btn h-6 w-6 shrink-0 border ${
      on ? 'border-transparent' : 'border-neutral-700/70'
    } ${extra}`;
  const drawCtx = { user, isGuest, isCanvasViewer: Boolean(isReadOnly) };
  const hasDrawableLayer = !isOfflineCanvas && hasAnyDrawableLayerForUser(allLayers, drawCtx);
  const guidance = isOfflineCanvas ? null : getLayerDrawGuidanceState({
    layers: allLayers,
    activeLayerId,
    user,
    isGuest,
    isCanvasViewer: Boolean(isReadOnly),
    canCreateLayer,
  });
  const guidanceMessage = (() => {
    switch (guidance?.kind) {
      case 'guest_login_required':
        return t.layers.guidanceGuest;
      case 'viewer_readonly':
        return t.layers.guidanceViewer;
      case 'claim_public_layer':
        return t.layers.guidanceClaimPublic;
      case 'switch_to_drawable':
        if (guidance.reason === 'locked') return t.layers.guidanceLocked;
        if (guidance.reason === 'group') return t.layers.guidanceGroup;
        if (guidance.reason === 'other_owner') return t.layers.guidanceOtherOwner;
        return t.layers.guidanceNotDrawable;
      case 'create_my_layer':
        return t.layers.guidanceNoDrawable;
      default:
        return '';
    }
  })();

  return (
    <div className="relative flex h-full w-full min-w-0 select-none flex-col bg-atelier-panel text-xs">
      {/* 1. CSP-style compact layer properties & action bars */}
      {!isOfflineCanvas && folderAccess && <FolderAccessPanel access={folderAccess} layers={layers} active={active} userId={user?.id} />}
      <div className="shrink-0 space-y-1 border-b border-atelier-border px-2 py-1.5" aria-label={t.layers.title}>
        {/* Row 1: Blend mode + CSP checkered opacity bar + % */}
        <div className="flex items-center gap-1.5">
          <LayerPaletteColorControl
            key={active?.id}
            labels={t.layers.colors}
            color={active ? paletteColorOf(active.id) : null}
            personalColor={active && !isOfflineCanvas ? paletteColorOf(active.id, 'personal') : null}
            sharedColor={active ? paletteColorOf(active.id, 'shared') : null}
            disabled={!paletteTargets.length || (isOfflineCanvas && !canSyncPalette)}
            isOffline={isOfflineCanvas}
            mode={displayMode}
            canSync={canSyncPalette}
            onChangeMode={onChangePaletteColorMode}
            onChangeColor={changePaletteColor}
          />
          <label className="sr-only" htmlFor="layer-blend">{t.layers.blendMode}</label>
          <select
            id="layer-blend"
            value={active?.blendMode ?? 'normal'}
            disabled={!canEditActive}
            onChange={(e) => active && onUpdateLayerProps?.(active.id, { blendMode: e.target.value as BlendMode })}
            title={t.layers.blendMode}
            className="atelier-field h-6 min-w-0 flex-1 px-1.5 text-[11px] disabled:opacity-50"
          >
            {blendGroups.map((grp) => (
              <optgroup key={grp.category} label={grp.category}>
                {grp.items.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <LayerOpacityRange
            disabled={!canEditActive}
            opacity={active?.opacity ?? 1}
            ariaLabel={t.layers.opacityAria}
            onChange={(next) => active && onUpdateLayerProps?.(active.id, { opacity: next })}
          />
          <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-neutral-200">{Math.round((active?.opacity ?? 1) * 100)}%</span>
        </div>

        {/* Row 2: Compact icon-only layer attribute, mask & ownership toggles */}
        <div className="flex flex-wrap items-center gap-0.5">
          <LayerTintControls
            key={activeLayerId}
            labels={t.layers.colors}
            layer={activeMask ? null : active}
            isOffline={isOfflineCanvas}
            canSync={canEditActive && Boolean(onUpdateLayerProps)}
            localConfig={active ? localLayerColors[active.id] : undefined}
            effective={tintOf(active?.id ?? '')}
            onChangeLocal={onChangeLocalLayerColor}
            onChangeShared={(id, props) => onUpdateLayerProps?.(id, props)}
          />
          <LayerEffectsPopover
            labels={t.layers.effects}
            layer={activeMask ? null : active}
            disabled={!canEditActive || !onUpdateLayerProps}
            openSignal={effectsOpenSignal}
            onPreview={onPreviewLayerEffects}
            onCommit={(id, effects) => {
              const target = allLayers.find((l) => l.id === id);
              if (!target) return;
              void onUpdateLayerProps?.(id, { meta: { ...(target.meta ?? {}), effects } });
            }}
          />
          <button type="button" disabled={!canEditActive} aria-pressed={Boolean(active?.clipToBelow)}
            onClick={() => active && onUpdateLayerProps?.(active.id, { clipToBelow: !active.clipToBelow })}
            title={t.layers.clippingMaskTooltip} aria-label={t.layers.clippingMask} className={iconBtn(Boolean(active?.clipToBelow))}>
            <CornerDownRight className="h-3.5 w-3.5" />
          </button>
          <button type="button" disabled={!canEditActive || activeIsGroup || activeIsAdjustment} aria-pressed={!activeIsAdjustment && Boolean(active?.alphaLocked)}
            onClick={() => active && !activeIsAdjustment && onUpdateLayerProps?.(active.id, { alphaLocked: !active.alphaLocked })}
            title={t.layers.lockAlphaTooltip} aria-label={t.layers.lockAlpha} className={iconBtn(!activeIsAdjustment && Boolean(active?.alphaLocked))}>
            <AlphaLockIcon />
          </button>
          <button type="button" disabled={readOnly || !active || !(isOfflineCanvas || activeIsOwner || isAdmin)} aria-pressed={Boolean(active?.isLocked)}
            onClick={() => active && onToggleLock(active)} title={t.layers.lockLayerTooltip} aria-label={t.layers.lockLayerTooltip} className={iconBtn(Boolean(active?.isLocked))}>
            <Lock className="h-3.5 w-3.5" />
          </button>
          <button type="button" disabled={!canEditActive || activeIsGroup || activeIsAdjustment} aria-pressed={!activeIsAdjustment && Boolean(active?.screentoneEnabled)}
            onClick={() => active && !activeIsAdjustment && onUpdateLayerProps?.(active.id, { screentoneEnabled: !active.screentoneEnabled })}
            title={t.layers.screentoneTooltip} aria-label={t.layers.screentone} className={iconBtn(!activeIsAdjustment && Boolean(active?.screentoneEnabled))}>
            <Grip className="h-3.5 w-3.5" />
          </button>
          {!activeIsGroup && allGroups.length > 0 && canEditActive && active && (
            <div className="relative">
              <button type="button" aria-pressed={Boolean(active.parentId)}
                onClick={() => setGroupSelectLayerId(groupSelectLayerId === active.id ? null : active.id)}
                title={active.parentId ? t.layers.manageGroupTooltip : t.layers.addToGroup}
                aria-label={active.parentId ? t.layers.manageGroupTooltip : t.layers.addToGroup}
                className={iconBtn(Boolean(active.parentId))}>
                <Folder className="h-3.5 w-3.5" />
              </button>
              {groupSelectLayerId === active.id && (
                <div className="absolute left-0 top-7 z-50 w-44 atelier-popover atelier-menu-in p-1.5">
                  {active.parentId && (
                    <button type="button" onClick={() => { void moveLayersToGroup([active.id], null); setGroupSelectLayerId(null); }}
                      className="w-full rounded px-2 py-1 text-left text-[11px] text-rose-300 hover:bg-neutral-800">{t.layers.removeFromGroup}</button>
                  )}
                  {allGroups.map((g) => (
                    <button key={g.id} type="button" onClick={() => { void moveLayersToGroup([active.id], g.id); setGroupSelectLayerId(null); }}
                      className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11px] ${active.parentId === g.id ? 'bg-indigo-600 text-white' : 'text-neutral-200 hover:bg-neutral-800'}`}>
                      <span className="truncate">{g.name}</span>{active.parentId === g.id && <Check className="h-3 w-3" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {active && canEditActive && active.layerType !== 'text' && active.meta?.cel?.ref === undefined && (activeLayerMask ? (
            <>
              <span aria-hidden className="mx-0.5 h-3.5 w-px bg-neutral-700/70" />
              <button type="button" aria-pressed={activeLayerMask.isVisible}
                onClick={() => onUpdateLayerProps?.(activeLayerMask.id, { isVisible: !activeLayerMask.isVisible })}
                title={activeLayerMask.isVisible ? t.layers.maskDisableTooltip : t.layers.maskEnableTooltip}
                aria-label={activeLayerMask.isVisible ? t.layers.mask : t.layers.maskDisabled}
                className={iconBtn(activeLayerMask.isVisible)}>
                <MaskIcon />
              </button>
              <button type="button" aria-pressed={Boolean(activeLayerMask.meta?.maskInverted)}
                onClick={() => onUpdateLayerProps?.(activeLayerMask.id, { meta: { ...activeLayerMask.meta, maskInverted: !activeLayerMask.meta?.maskInverted } })}
                title={activeLayerMask.meta?.maskInverted ? t.layers.maskInvertActiveTooltip : t.layers.maskInvertInactiveTooltip}
                aria-label={t.layers.maskInvert}
                className={iconBtn(Boolean(activeLayerMask.meta?.maskInverted))}>
                <MaskInvertIcon />
              </button>
              <button type="button" aria-pressed={Boolean(activeMask)}
                onClick={() => onSelectLayer(activeMask ? active.id : activeLayerMask.id)}
                title={activeMask ? t.layers.maskEditLayerTooltip : t.layers.maskEditMaskTooltip}
                aria-label={activeMask ? t.layers.maskEditing : t.layers.maskEdit}
                className={iconBtn(Boolean(activeMask))}>
                <Edit2 className="h-3 w-3" />
              </button>
              <button type="button" onClick={() => { if (confirm(t.layers.maskDeleteConfirm)) { onSelectLayer(active.id); onDeleteLayer(activeLayerMask.id); } }}
                title={t.layers.maskDelete} aria-label={t.layers.maskDelete} className={iconBtn(false, 'hover:!text-rose-400')}>
                <X className="h-3 w-3" />
              </button>
            </>
          ) : onAddMask && (
            <button type="button" onClick={() => onAddMask(active.id)}
              title={t.layers.maskAddTooltip} aria-label={t.layers.maskAdd} className={iconBtn(false)}>
              <MaskIcon />
            </button>
          ))}

          {/* Ownership icons: compact CSP style instead of full-width banners */}
          <div className="ml-auto flex items-center gap-0.5">
            {!isOfflineCanvas && active && !activeIsOwner && (active.isPublic || !active.ownerId) && !readOnly && (
              <button type="button" onClick={() => onClaimLayer(active.id, false)} title={t.layers.claimTooltip} aria-label={t.layers.claim}
                className={iconBtn(false, '!border-emerald-500/40 !text-emerald-400 hover:!bg-emerald-500/15')}>
                <HandMetal className="h-3.5 w-3.5" />
              </button>
            )}
            {!isOfflineCanvas && active && !activeIsOwner && !active.isPublic && active.ownerId && isAdmin && !readOnly && (
              <button type="button" onClick={() => setForceClaimTarget(active)} title={t.layers.adminForceClaim} aria-label={t.layers.adminForceClaim}
                className={iconBtn(false, '!border-amber-500/45 !text-amber-400 hover:!bg-amber-500/15')}>
                <ShieldAlert className="h-3.5 w-3.5" />
              </button>
            )}
            {!isOfflineCanvas && active && activeIsOwner && !readOnly && (
              <button type="button" onClick={() => { if (confirm(t.layers.releaseConfirm.replace('{name}', active.name))) onReleaseLayer(active.id); }}
                title={t.layers.releaseTooltip} aria-label={t.layers.release} className={iconBtn(false)}>
                <Unlock className="h-3.5 w-3.5" />
              </button>
            )}
            {!isOfflineCanvas && active && (activeIsOwner || isAdmin) && !readOnly && onTransferLayer && (
              <div className="relative">
                <button ref={transferBtnRef} type="button" onClick={() => setTransferLayerId(transferLayerId === active.id ? null : active.id)}
                  title={t.layers.transferTooltip} aria-label={t.layers.transfer} className={iconBtn(transferLayerId === active.id)}>
                  <UserCheck className="h-3.5 w-3.5" />
                </button>
                {transferLayerId === active.id && typeof document !== 'undefined' && createPortal(
                  <div ref={transferPos.setPopoverEl} style={{ top: transferPos.top, left: transferPos.left, maxHeight: transferPos.maxHeight }}
                    className="fixed z-[95] w-52 max-w-[calc(100vw-16px)] overflow-y-auto atelier-popover atelier-menu-in p-1.5">
                    {availableTransferMembers.length === 0 ? (
                      <div className="py-2 text-center text-[11px] text-neutral-500">{t.layers.noOtherMembers}</div>
                    ) : availableTransferMembers.map((m) => (
                      <button key={m.userId} type="button"
                        onClick={() => { if (confirm(t.layers.transferConfirm.replace('{name}', active.name).replace('{target}', m.displayName))) { onTransferLayer(active.id, m.userId); setTransferLayerId(null); } }}
                        className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[11px] text-neutral-200 hover:bg-neutral-800">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: getUserColor(m.userId).hex }} />
                        <span className="truncate">{m.displayName}</span>
                      </button>
                    ))}
                  </div>,
                  document.body
                )}
              </div>
            )}
          </div>
        </div>

        {/* Row 3: Layer creation and stack commands */}
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-0.5 border-t border-neutral-800/60 pt-1">
            <button type="button" onClick={handleDirectAddRaster} title={t.layers.addRaster} aria-label={t.layers.addRaster}
              className="atelier-icon-btn h-6 w-6"><Plus className="h-3.5 w-3.5" /></button>
            <button type="button" onClick={handleDirectAddVector} title={t.layers.addVector} aria-label={t.layers.addVector}
              className="atelier-icon-btn h-6 w-6"><Spline className="h-3.5 w-3.5" /></button>
            <button type="button" onClick={handleDirectAddGroup} title={t.layers.addGroup} aria-label={t.layers.addGroup}
              className="atelier-icon-btn h-6 w-6"><FolderPlus className="h-3.5 w-3.5" /></button>
            {canCreateLayer && onCreateAdjustmentLayer && (
              <>
                <button ref={adjustmentBtnRef} type="button" onClick={() => setAdjustmentMenuOpen((open) => !open)}
                  data-testid="layer-add-adjustment" aria-haspopup="menu" aria-expanded={showAdjustmentMenu}
                  title={t.layers.adjustment.add} aria-label={t.layers.adjustment.add}
                  className="atelier-icon-btn h-6 w-6">
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </button>
                {showAdjustmentMenu && typeof document !== 'undefined' && createPortal(
                  <div ref={adjustmentPos.setPopoverEl} role="menu" aria-label={t.layers.adjustment.add}
                    style={{ top: adjustmentPos.top, left: adjustmentPos.left, maxHeight: adjustmentPos.maxHeight }}
                    className="fixed z-[95] w-52 max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain atelier-popover atelier-menu-in p-1">
                    {ADJUSTMENT_KINDS.map((kind) => {
                      const Icon = ADJUSTMENT_KIND_ICONS[kind];
                      return <MenuItem key={kind} testId={`adjustment-kind-${kind}`} label={t.layers.adjustment.kinds[kind]}
                        icon={<Icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-neutral-400" />}
                        onClick={() => { setAdjustmentMenuOpen(false); onCreateAdjustmentLayer(kind); }} />;
                    })}
                  </div>,
                  document.body
                )}
              </>
            )}
            {!isOfflineCanvas && onRequestCreateMyLayer && (
              <button type="button" onClick={onRequestCreateMyLayer} title={t.layers.myLayer} aria-label={t.layers.myLayer}
                className={`atelier-icon-btn h-6 w-6 ${!hasDrawableLayer ? 'ring-1 ring-indigo-400 text-indigo-300' : ''}`}>
                <UserPlus className="h-3.5 w-3.5" />
              </button>
            )}
            {onMergeDown && (
              <button type="button" disabled={!active || Boolean(mergeBlocker(active))}
                onClick={() => active && onMergeDown(active.id)}
                title={(active && mergeBlocker(active)) || t.layers.mergeDown}
                aria-label={t.layers.mergeDown}
                className="atelier-icon-btn h-6 w-6">
                <MergeDownIcon />
              </button>
            )}
            <button type="button" onClick={() => { setIsBatchMode(!isBatchMode); if (isBatchMode) setSelectedLayerIds(new Set()); }}
              aria-pressed={isBatchMode} title={t.layers.batchModeTooltip} aria-label={t.layers.batchMode} className="atelier-icon-btn h-6 w-6">
              <CheckSquare className="h-3.5 w-3.5" />
            </button>
            <div className="ml-auto flex items-center gap-0.5">
              <button type="button" disabled={!canMoveActive || activeIndex <= 0} onClick={() => active && handleMoveOrder(active, 'up')}
                title={t.layers.moveUp} aria-label={t.layers.moveUp} className="atelier-icon-btn h-6 w-6"><ArrowUp className="h-3.5 w-3.5" /></button>
              <button type="button" disabled={!canMoveActive || activeIndex < 0 || activeIndex >= activeSiblings.length - 1} onClick={() => active && handleMoveOrder(active, 'down')}
                title={t.layers.moveDown} aria-label={t.layers.moveDown} className="atelier-icon-btn h-6 w-6"><ArrowDown className="h-3.5 w-3.5" /></button>
              <button type="button" disabled={!canDeleteActive}
                onClick={() => { if (active && confirm(t.layers.deleteConfirm)) onDeleteLayer(active.id); }}
                title={t.layers.deleteLayer} aria-label={t.layers.deleteLayer} className="atelier-icon-btn h-6 w-6 hover:!text-rose-400">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {!activeIsAdjustment && active?.screentoneEnabled && canEditActive && (
          <div className="grid grid-cols-3 gap-2 rounded-md border border-neutral-700 bg-neutral-950/50 p-1.5 text-[10px] text-neutral-400">
            <label className="flex flex-col gap-0.5">{t.layers.screentoneDensity} {active.screentoneLpi ?? 40}
              <input type="range" min={15} max={100} value={active.screentoneLpi ?? 40} onChange={(e) => onUpdateLayerProps?.(active.id, { screentoneLpi: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-0.5">{t.layers.screentoneAngle} {active.screentoneAngle ?? 45}°
              <input type="range" min={0} max={90} value={active.screentoneAngle ?? 45} onChange={(e) => onUpdateLayerProps?.(active.id, { screentoneAngle: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-0.5">{t.layers.screentoneDotScale} {(active.screentoneDotScale ?? 1).toFixed(1)}x
              <input type="range" min={0.5} max={1.5} step={0.1} value={active.screentoneDotScale ?? 1} onChange={(e) => onUpdateLayerProps?.(active.id, { screentoneDotScale: Number(e.target.value) })} />
            </label>
            {onBakeScreentone && (
              <button type="button" className="col-span-3 rounded bg-neutral-800 py-1 text-[11px] text-neutral-200 hover:bg-neutral-700"
                onClick={() => {
                  if (confirm(t.layers.bakeScreentoneConfirm.replace('{name}', active.name))) {
                    onBakeScreentone(active.id, { density: active.screentoneLpi ?? 40, angleRad: ((active.screentoneAngle ?? 45) * Math.PI) / 180, dotScale: active.screentoneDotScale ?? 1 });
                  }
                }}>{t.layers.bakeScreentone}</button>
            )}
          </div>
        )}
      </div>

      {/* Drawability guidance banner: one-click switch / safe claim / create layer / sign-in */}
      {guidance && guidance.kind !== 'none' && guidance.kind !== 'drawable' && (
        <div
          role="status"
          data-layer-draw-guidance={guidance.kind}
          data-layer-guidance-reason={guidance.reason ?? ''}
          className="flex shrink-0 flex-col gap-1.5 border-b border-atelier-border bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-100"
        >
          <span className="leading-snug text-amber-100/95">{guidanceMessage}</span>
          <div className="flex flex-wrap items-center gap-1">
            {guidance.kind === 'guest_login_required' && onOpenAuth && (
              <button
                type="button"
                data-layer-guidance-action="login"
                onClick={onOpenAuth}
                className="rounded border border-indigo-400/50 bg-indigo-500/20 px-2 py-0.5 text-[11px] font-medium text-indigo-100 hover:bg-indigo-500/35"
              >
                {t.layers.guidanceLoginBtn}
              </button>
            )}
            {guidance.kind === 'claim_public_layer' && guidance.claimTargetLayerId && (
              <button
                type="button"
                data-layer-guidance-action="claim"
                onClick={() => onClaimLayer(guidance.claimTargetLayerId!, false)}
                className="rounded border border-emerald-400/50 bg-emerald-500/20 px-2 py-0.5 text-[11px] font-medium text-emerald-100 hover:bg-emerald-500/35"
              >
                {t.layers.guidanceClaimBtn}
              </button>
            )}
            {guidance.switchTargetLayerId && (
              <button
                type="button"
                data-layer-guidance-action="switch"
                onClick={() => onSelectLayer(guidance.switchTargetLayerId!)}
                className="rounded border border-cyan-400/50 bg-cyan-500/20 px-2 py-0.5 text-[11px] font-medium text-cyan-100 hover:bg-cyan-500/35"
              >
                {t.layers.guidanceSwitchBtn.replace('{name}', guidance.switchTargetLayerName || '')}
              </button>
            )}
            {guidance.kind === 'create_my_layer' && guidance.canCreateLayer && (
              <button
                type="button"
                data-layer-guidance-action="create"
                onClick={() => (onRequestCreateMyLayer ? onRequestCreateMyLayer() : handleDirectAddRaster())}
                className="rounded border border-indigo-400/50 bg-indigo-500/20 px-2 py-0.5 text-[11px] font-medium text-indigo-100 hover:bg-indigo-500/35"
              >
                {t.layers.guidanceCreateMyLayerBtn}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Batch mode bar */}
      {(isBatchMode || selectedLayerIds.size > 0) && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-atelier-border bg-amber-950/30 px-2 py-1">
          <button type="button" onClick={handleSelectAll} className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-neutral-800">
            {selectedLayerIds.size === layers.length ? t.layers.deselectAll : t.layers.selectAll}
          </button>
          <span className="text-[11px] font-semibold text-amber-300">{t.layers.selectedCount.replace('{count}', String(selectedLayerIds.size))}</span>
          <div className="relative ml-auto flex flex-wrap items-center gap-1">
            {onOpenAlign && (
              <button type="button" disabled={selectedLayerIds.size === 0} onClick={() => onOpenAlign()}
                className="rounded border border-indigo-500/60 bg-indigo-500/20 px-2 py-0.5 text-[11px] font-medium text-indigo-200 disabled:opacity-40">
                {t.align.title}
              </button>
            )}
            <button type="button" disabled={selectedLayerIds.size === 0} onClick={handleBatchGroupSelected}
              className="rounded bg-amber-600 px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-40">{t.layers.batchGroup}</button>
            {allGroups.length > 0 && (
              <button ref={batchGroupBtnRef} type="button" disabled={selectedLayerIds.size === 0} onClick={() => setBatchGroupMenuOpen(!batchGroupMenuOpen)}
                className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-200 disabled:opacity-40">{t.layers.batchAddToGroup} ▾</button>
            )}
            <button type="button" disabled={selectedLayerIds.size === 0} onClick={() => handleBatchMoveToGroup(null)}
              className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-rose-300 disabled:opacity-40">{t.layers.batchRemoveFromGroup}</button>
            {batchGroupMenuOpen && typeof document !== 'undefined' && createPortal(
              <div ref={batchGroupPos.setPopoverEl} style={{ top: batchGroupPos.top, left: batchGroupPos.left, maxHeight: batchGroupPos.maxHeight }}
                className="fixed z-[95] w-44 max-w-[calc(100vw-16px)] overflow-y-auto atelier-popover atelier-menu-in p-1">
                {allGroups.map((g) => (
                  <button key={g.id} type="button" onClick={() => handleBatchMoveToGroup(g.id)}
                    className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[11px] text-neutral-200 hover:bg-neutral-800">
                    <Folder className="h-3 w-3 text-amber-400" /><span className="truncate">{g.name}</span>
                  </button>
                ))}
              </div>,
              document.body
            )}
          </div>
        </div>
      )}

      {/* Slim hint only when no public/owned layer exists yet in collaborative session */}
      {!isOfflineCanvas && layers.length > 0 && !hasDrawableLayer && !readOnly && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-atelier-border bg-indigo-950/30 px-2 py-1 text-[10px] text-indigo-300">
          <Sparkles className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t.layers.empty}</span>
          <button type="button" onClick={handleDirectAddRaster}
            className="rounded bg-indigo-600 px-1.5 py-0.5 font-semibold text-white hover:bg-indigo-500">{t.layers.addLayer}</button>
        </div>
      )}

      {/* 2. Compact CSP-style layer rows */}
      <div ref={listContainerRef} role="listbox" aria-label={t.layers.title} className="min-h-0 min-w-0 flex-1 overflow-y-auto py-0.5"
        onScroll={(e) => {
          const st = Math.floor(e.currentTarget.scrollTop / 36) * 36;
          const height = e.currentTarget.clientHeight;
          setListScroll((prev) => (Math.abs(prev.top - st) >= 72 ? { top: st, height: height || prev.height } : prev));
        }}
        onDragOver={(e) => {
          // Rows stop their own file drags: this is the empty space under them
          if (!isFileDrag(e)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
          setDragOverLayerId(null);
          setDropPosition(null);
          setFileDropAtEnd(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileDropAtEnd(false);
        }}
        onDrop={(e) => {
          if (!isFileDrag(e)) return;
          e.preventDefault();
          e.stopPropagation();
          setFileDropAtEnd(false);
          onImportImages!(readDroppedImages(e.dataTransfer), { layerId: null, pos: 'below' });
        }}>
        {layers.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 py-6 text-center text-neutral-500">
            <span>{t.layers.empty}</span>
            {!readOnly && (
              <button type="button" onClick={handleDirectAddRaster}
                className="rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-500">
                {t.layers.addLayer}
              </button>
            )}
          </div>
        ) : (() => {
          const visibleDescending = descending.filter((layer) => !ancestorsOf(layer).some((a) => collapsedGroups.has(a.id)));
          const visibleDescendingIds = visibleDescending.map((l) => l.id);
          visibleDescendingIdsRef.current = visibleDescendingIds;
          const ROW_H = 36;
          const virtualize = visibleDescending.length > 48;
          const startIdx = virtualize ? Math.max(0, Math.floor(listScroll.top / ROW_H) - 8) : 0;
          const endIdx = virtualize ? Math.min(visibleDescending.length, Math.ceil((listScroll.top + listScroll.height) / ROW_H) + 8) : visibleDescending.length;
          const sliced = virtualize ? visibleDescending.slice(startIdx, endIdx) : visibleDescending;
          return (
            <>
              {virtualize && startIdx > 0 && <div style={{ height: startIdx * ROW_H }} aria-hidden />}
              {sliced.map((layer) => {
            const ancestors = ancestorsOf(layer);
            const isActive = layer.id === activeLayerId;
            const isOwner = user?.id === layer.ownerId;
            const canEditRow = isOfflineCanvas ? !readOnly : isOwner;
            const canMove = isOfflineCanvas ? canEditRow : (isOwner || isAdmin || layer.isPublic || !layer.ownerId);
            const isGroup = layer.layerType === 'group';
            const isAdjustment = layer.layerType === 'adjustment';
            const adjustmentKind = isAdjustment ? layer.meta?.adjustment?.kind : undefined;
            const adjustmentLabel = adjustmentKind ? t.layers.adjustment.kinds[adjustmentKind] : t.layers.adjustment.title;
            const AdjustmentIcon = adjustmentKind ? ADJUSTMENT_KIND_ICONS[adjustmentKind] : SlidersHorizontal;
            const isCollapsed = collapsedGroups.has(layer.id);
            const isChild = Boolean(layer.parentId);
            const isClipped = Boolean(layer.clipToBelow);
            const isClippingBase = baseClippingIds.has(layer.id);
            const isBatchSelected = selectedLayerIds.has(layer.id);
            const ownerDisplay = isOfflineCanvas ? null : resolveLayerOwnerDisplay(layer, {
              currentUserId: user?.id ?? null,
              roomMembers,
              labels: {
                myLayer: t.layers.myLayer,
                publicLayer: t.layers.public,
                painterPrefix: t.layers.painterPrefix,
              },
            });
            const ownerHex = ownerDisplay ? ownerColor(layer.ownerId, ownerDisplay.isPublicUnclaimed) : null;
            const paletteColor = paletteColorOf(layer.id);
            const gutterStyle = paletteColor ? { backgroundColor: paletteColor, color: getPaletteContrastColor(paletteColor) } : undefined;
            const tint = tintOf(layer.id);
            const tintLabel = tint.source === 'local' ? t.layers.colors.localTint : t.layers.colors.sharedTint;
            const safeOriginalAuthor =
              layer.meta?.originalAuthor && !isBlockedOnlineGuestName(layer.meta.originalAuthor)
                ? layer.meta.originalAuthor
                : null;
            const showReadOnlyBadge = ownerDisplay && !ownerDisplay.isPublicUnclaimed && !isGroup && !layer.isLocked
              && (isAdjustment ? readOnly || !canManage(layer) : !isLayerDrawableForUser(layer, drawCtx, allLayers));
            const isOver = dragOverLayerId === layer.id;
            const localOverride = localVisibility[layer.id];
            const seenByMe = localOverride ?? layer.isVisible;
            const layerMask = maskOf.get(layer.id);
            const pctText = `${Math.round((layer.opacity ?? 1) * 100)}%`;
            const extraEffects = [
              !isAdjustment && layer.screentoneEnabled ? t.layers.screentone : null,
              ...(!isOfflineCanvas ? [
                layer.layerType === 'vector' ? t.layers.vectorLayer : null,
                layer.layerType === 'text' ? t.layers.textLayer : null,
                isAdjustment ? t.layers.adjustment.title : null,
                layer.meta?.animation ? `${t.animation.timeline} ${layer.meta.animation.fps}fps` : null,
                layer.meta?.camera ? `${t.animation.camera} ${layer.meta.camera.width}×${layer.meta.camera.height}` : null,
                layer.meta?.audio ? t.animation.audioTrack : null,
              ] : []),
            ].filter(Boolean);

            return (
              <React.Fragment key={layer.id}>
                {isOver && dropPosition === 'above' && <div className="mx-2 h-0.5 rounded bg-indigo-400" />}
                <div
                  role="option"
                  aria-selected={isActive}
                  data-layer-id={layer.id}
                  data-is-group={isGroup ? 'true' : 'false'}
                  draggable={canMove && !isBatchMode && editingLayerId !== layer.id}
                  onDragStart={(e) => handleDragStart(e, layer.id)}
                  onDragOver={(e) => handleDragOver(e, layer.id)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, layer.id)}
                  onDragEnd={handleDragEnd}
                  onMouseDown={(e) => {
                    // Prevent native HTML5 drag-and-drop & text selection when Shift+dragging to multi-select
                    if (e.button === 0 && e.shiftKey && editingLayerId !== layer.id) {
                      const targetEl = e.target as HTMLElement | null;
                      if (!targetEl?.closest('button, input, textarea, select')) {
                        e.preventDefault();
                      }
                    }
                  }}
                  onClick={(e) => {
                    if (suppressNextRowClickRef.current) {
                      suppressNextRowClickRef.current = false;
                      return;
                    }
                    // Shift + click selects contiguous range from anchor to clicked layer
                    if (e.shiftKey) {
                      const storedAnchor = selectionAnchorIdRef.current;
                      const anchorId =
                        storedAnchor && visibleDescendingIds.includes(storedAnchor)
                          ? storedAnchor
                          : activeLayerId && visibleDescendingIds.includes(activeLayerId)
                            ? activeLayerId
                            : layer.id;
                      const additive = e.ctrlKey || e.metaKey || isBatchMode;
                      setSelectedLayerIds(selectLayerRange(visibleDescendingIds, anchorId, layer.id, additive, selectedLayerIds));
                      return;
                    }
                    // Ctrl / batch mode toggles individual layers (for 群組); a plain click selects one
                    if (isBatchMode || e.ctrlKey || e.metaKey) {
                      selectionAnchorIdRef.current = layer.id;
                      if (!isBatchMode && selectedLayerIds.size === 0 && activeLayerId && activeLayerId !== layer.id) {
                        setSelectedLayerIds(new Set([activeLayerId, layer.id]));
                      } else {
                        handleToggleBatchSelect(layer.id);
                      }
                      return;
                    }
                    selectionAnchorIdRef.current = layer.id;
                    if (selectedLayerIds.size) setSelectedLayerIds(new Set());
                    onSelectLayer(layer.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!selectedLayerIds.has(layer.id)) {
                      setSelectedLayerIds(new Set());
                      onSelectLayer(layer.id);
                    }
                    setMenu({ x: e.clientX, y: e.clientY, layerId: layer.id });
                  }}
                  onPointerDown={(e) => {
                    if (e.pointerType !== 'touch' && e.button === 0 && e.shiftKey && editingLayerId !== layer.id) {
                      const targetEl = e.target as HTMLElement | null;
                      if (!targetEl?.closest('button, input, textarea, select')) {
                        startShiftDragSelect(e, layer.id);
                        return;
                      }
                    }
                    // Touch: a long press opens the same menu (phones have no right click)
                    if (e.pointerType !== 'touch') return;
                    const { clientX, clientY } = e;
                    if (longPressRef.current) clearTimeout(longPressRef.current);
                    longPressRef.current = setTimeout(() => {
                      onSelectLayer(layer.id);
                      setMenu({ x: clientX, y: clientY, layerId: layer.id });
                    }, 550);
                  }}
                  onPointerUp={() => { if (longPressRef.current) clearTimeout(longPressRef.current); }}
                  onPointerMove={(e) => { if (e.pointerType === 'touch' && longPressRef.current && Math.abs(e.movementY) > 4) clearTimeout(longPressRef.current); }}
                  onDoubleClick={(e) => { if (canEditRow) handleStartRename(layer, e); }}
                  onTouchEnd={() => {
                    const now = Date.now();
                    if (now - lastTapRef.current.time < 320 && lastTapRef.current.id === layer.id && canEditRow) handleStartRename(layer);
                    lastTapRef.current = { id: layer.id, time: now };
                  }}
                  className={`group relative flex h-9 cursor-pointer items-stretch border-b border-neutral-800/60 ${
                    isActive || activeMask?.parentId === layer.id ? 'bg-indigo-600/20' : 'hover:bg-neutral-800/50'
                  } ${isBatchSelected ? 'ring-1 ring-inset ring-amber-400 bg-amber-900/20' : ''} ${isOver && dropPosition === 'inside' && isGroup ? 'ring-1 ring-inset ring-amber-400 bg-amber-950/30' : ''} ${draggedLayerId === layer.id ? 'opacity-50' : ''}`}
                  // Someone else's layer keeps a subtle tint from the left; mine stays clean
                  style={!ownerHex || isOwner || layer.isPublic || !layer.ownerId ? undefined : { backgroundImage: `linear-gradient(90deg, ${ownerHex}22, ${ownerHex}08 50%, transparent)` }}
                >
                  {/* Owner stripe */}
                  {ownerHex && !paletteColor && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 z-10 w-[3px]"
                    style={{ backgroundColor: ownerHex }} />}
                  {/* Dual eye gutter: synced eye + personal eye side-by-side in CSP density */}
                  <div className={`flex w-9 shrink-0 items-center justify-center gap-0.5 pl-1 ${paletteColor ? '' : 'border-r border-neutral-800/60'}`}
                    style={gutterStyle} onClick={(e) => e.stopPropagation()}>
                    <button type="button" disabled={!canEditRow} onClick={() => onToggleVisibility(layer)}
                      aria-label={layer.isVisible ? t.layers.hide : t.layers.show}
                      title={layer.isVisible ? t.layers.hide : t.layers.show}
                      className={`flex h-6 w-4 items-center justify-center rounded ${paletteColor ? 'enabled:hover:bg-current/10' : 'text-neutral-300 enabled:hover:bg-neutral-700/60 disabled:opacity-40'}`}>
                      {layer.isVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className={`h-3.5 w-3.5 ${paletteColor ? '' : 'text-neutral-600'}`} />}
                    </button>
                    <button type="button" onClick={() => onToggleLocalVisibility?.(layer.id)}
                      aria-label={seenByMe ? t.layers.localHidden : t.layers.localVisible}
                      title={seenByMe ? t.layers.localHidden : t.layers.localVisible}
                      className={`flex h-6 w-3.5 items-center justify-center rounded ${paletteColor
                        ? `hover:bg-current/10 ${localOverride !== undefined ? 'ring-1 ring-inset ring-current/50' : ''}`
                        : `hover:bg-neutral-700/60 ${localOverride !== undefined ? 'text-amber-400' : 'text-neutral-500 opacity-65 hover:opacity-100'}`}`}>
                      {seenByMe ? <PersonalEye on /> : <PersonalEye on={false} />}
                    </button>
                  </div>

                  {isBatchMode && (
                    <div className={`flex w-5 shrink-0 items-center justify-center ${paletteColor ? '' : 'text-amber-400'}`} style={gutterStyle}>
                      {isBatchSelected ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className={`h-3.5 w-3.5 ${paletteColor ? '' : 'text-neutral-500'}`} />}
                    </div>
                  )}

                  {/* Indent + Thumbnail */}
                  <div className="flex items-center" style={{ paddingLeft: `${(4 + (isChild ? ancestors.length * 10 : 0) + (isClipped ? 8 : 0)) / 16}rem` }}>
                    {isClipped && <span className="mr-1 h-5 w-0.5 rounded bg-pink-500" title={t.layers.clippingMaskTooltip} />}
                    {isGroup ? (
                      <button type="button" onClick={(e) => {
                        e.stopPropagation();
                        const next = new Set(collapsedGroups);
                        if (next.has(layer.id)) next.delete(layer.id); else next.add(layer.id);
                        setCollapsedGroups(next);
                      }} aria-label={t.layers.groupLayer}
                        className="flex h-7 w-9 items-center justify-center gap-0.5 rounded border border-amber-700/50 bg-amber-950/40 text-amber-400">
                        {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        {layer.meta?.animation ? <Film className="h-3.5 w-3.5" /> : layer.meta?.camera ? <Camera className="h-3.5 w-3.5 text-sky-400" /> : layer.meta?.audio ? <Music className="h-3.5 w-3.5 text-emerald-400" /> : layer.meta?.cel?.ref === '' ? <span aria-hidden className="text-sm leading-none">×</span> : layer.meta?.cel?.ref !== undefined ? <Repeat className="h-3.5 w-3.5" /> : <Folder className="h-3.5 w-3.5" />}
                      </button>
                    ) : isAdjustment ? (
                      <button type="button" data-testid={`adjustment-icon-${layer.id}`}
                        aria-label={adjustmentLabel} title={adjustmentLabel}
                        onClick={(e) => {
                          if (e.detail === 0 && onEditAdjustmentLayer) {
                            e.stopPropagation();
                            onSelectLayer(layer.id);
                            onEditAdjustmentLayer(layer.id);
                          }
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          const tap = lastAdjustmentTapRef.current;
                          if (tap.id !== layer.id || Date.now() - tap.time >= 320) onEditAdjustmentLayer?.(layer.id);
                        }}
                        onTouchEnd={(e) => {
                          e.stopPropagation();
                          const now = Date.now();
                          const tap = lastAdjustmentTapRef.current;
                          if (tap.id === layer.id && now - tap.time < 320) onEditAdjustmentLayer?.(layer.id);
                          lastAdjustmentTapRef.current = { id: layer.id, time: now };
                          lastTapRef.current = { id: '', time: 0 };
                        }}
                        className={`flex h-7 w-9 shrink-0 items-center justify-center rounded border bg-indigo-950/40 text-indigo-300 ${isActive ? 'border-indigo-400 ring-1 ring-indigo-400/60' : 'border-neutral-700'}`}>
                        <AdjustmentIcon aria-hidden className="h-4 w-4" />
                      </button>
                    ) : (
                      <button type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if ((e.ctrlKey || e.metaKey) && onLoadLayerSelection) onLoadLayerSelection(layer.id);
                          else onSelectLayer(layer.id);
                        }}
                        aria-label={`${layer.name} (${t.layers.loadSelection})`}
                        title={t.layers.loadSelection}
                        className={`relative h-7 w-9 overflow-hidden rounded border ${isActive ? 'border-indigo-400 ring-1 ring-indigo-400/60' : 'border-neutral-700'}`}
                        style={{ backgroundImage: 'repeating-conic-gradient(#3a3a3a 0% 25%, #4a4a4a 0% 50%)', backgroundSize: '6px 6px' }}>
                        <LayerThumbImg layerId={layer.id} thumbnails={thumbnails} subscribeThumbnails={subscribeThumbnails} getThumbnailsSnapshot={getThumbnailsSnapshot} onRequestThumbnail={onRequestThumbnail} className="pointer-events-none h-full w-full object-contain" />
                        {layer.layerType === 'text' && <TypeIcon className="absolute bottom-0 right-0 h-3 w-3 rounded-sm bg-black/60 text-white" />}
                      </button>
                    )}
                    {layerMask && (
                      <button type="button"
                        onClick={(e) => { e.stopPropagation(); onSelectLayer(activeLayerId === layerMask.id ? layer.id : layerMask.id); }}
                        aria-label={`${layer.name} ${t.layers.mask}`}
                        title={activeLayerId === layerMask.id ? t.layers.maskEditLayerTooltip : t.layers.maskEditMaskTooltip}
                        className={`relative ml-0.5 h-7 w-6 overflow-hidden rounded border bg-black ${activeLayerId === layerMask.id ? 'border-indigo-400 ring-1 ring-indigo-400' : 'border-neutral-700'}`}>
                        <LayerThumbImg layerId={layerMask.id} thumbnails={thumbnails} subscribeThumbnails={subscribeThumbnails} getThumbnailsSnapshot={getThumbnailsSnapshot} onRequestThumbnail={onRequestThumbnail} className={`pointer-events-none h-full w-full object-contain ${layerMask.meta?.maskInverted ? 'invert' : ''}`} />
                        {!layerMask.isVisible && <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs font-bold text-rose-400">X</span>}
                      </button>
                    )}
                    {layer.meta?.ruler && (() => {
                      const layerRuler = layer.meta.ruler;
                      const isEffective = isLayerRulerEffectiveForLayer(layer, activeLayerId, byId);
                      const scopeText = layerRuler.scope === 'all_layers'
                        ? t.rulers.scopeAllLayers
                        : layerRuler.scope === 'same_folder'
                          ? t.rulers.scopeSameFolder
                          : t.rulers.scopeTargetLayer;
                      const editableRuler = !readOnly && canManage(layer);
                      return (
                        <button
                          type="button"
                          data-testid={`layer-ruler-badge-${layer.id}`}
                          data-ruler-enabled={layerRuler.enabled ? 'true' : 'false'}
                          data-ruler-effective={isEffective ? 'true' : 'false'}
                          data-ruler-scope={layerRuler.scope}
                          aria-label={`${layer.name} ${t.rulers.layerRulerMenu}`}
                          title={`${t.rulers.layerRulerMenu} (${scopeText})`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (e.shiftKey || !editableRuler) {
                              onSelectLayer(layer.id);
                              onOpenRulerModal?.();
                              return;
                            }
                            const nextRuler: LayerRulerMeta = { ...layerRuler, enabled: !layerRuler.enabled };
                            void onUpdateLayerProps?.(layer.id, { meta: { ...layer.meta, ruler: nextRuler } });
                          }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            onSelectLayer(layer.id);
                            onOpenRulerModal?.();
                          }}
                          className={`relative ml-0.5 flex h-7 w-6 shrink-0 items-center justify-center rounded border transition ${
                            !layerRuler.enabled
                              ? 'border-neutral-700 bg-neutral-900/70 text-neutral-500'
                              : isEffective
                                ? 'border-purple-400 bg-purple-600/35 text-purple-200 ring-1 ring-purple-400/60'
                                : 'border-purple-700/60 bg-purple-950/40 text-purple-300/75 hover:border-purple-400/80'
                          }`}
                        >
                          <LayerRulerIcon />
                          {!layerRuler.enabled && (
                            <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs font-bold text-rose-400">
                              ×
                            </span>
                          )}
                        </button>
                      );
                    })()}
                  </div>

                  {/* Compact CSP metadata line + clear layer name */}
                  <div className="flex min-w-0 flex-1 flex-col justify-center px-1.5 leading-tight">
                    <span className="flex min-w-0 items-center gap-1 truncate text-[10px] text-neutral-400">
                      <span className="shrink-0 tabular-nums">{pctText}</span>
                      <span className="shrink-0">{blendLabel(layer.blendMode)}</span>
                      {tint.config && <LayerTintSwatch config={tint.config} label={tint.inherited ? t.layers.colors.inheritedTint.replace('{source}', tintLabel) : tintLabel} />}
                      {ownerDisplay && ownerHex && (
                        <>
                          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: ownerHex }} />
                          <span className="truncate" title={safeOriginalAuthor ? t.layers.originalAuthor.replace('{author}', safeOriginalAuthor) : ownerDisplay.label}>
                            {ownerDisplay.label}
                          </span>
                        </>
                      )}
                      {extraEffects.length > 0 && <span className="truncate text-indigo-400">· {extraEffects.join(' · ')}</span>}
                    </span>
                    {editingLayerId === layer.id ? (
                      <input ref={editInputRef} type="text" value={editingName} aria-label={t.layers.renameLayer}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); handleSaveRename(layer.id); }
                          else if (e.key === 'Escape') { e.preventDefault(); handleCancelRename(); }
                        }}
                        onBlur={() => handleSaveRename(layer.id)}
                        className="atelier-field h-5 w-full px-1 text-[11px]" />
                    ) : (
                      <span className={`truncate text-xs ${isActive ? 'font-semibold text-neutral-100' : 'text-neutral-200'}`} title={`${layer.name} ${t.layers.renameHint}`}>
                        {layer.name}
                      </span>
                    )}
                  </div>

                  {/* Compact status & drag handle */}
                  <div className="flex shrink-0 items-center gap-1 pr-1 text-neutral-400">
                    {isClipped && <span title={t.layers.clippingMaskTooltip}><CornerDownRight className="h-3 w-3 text-pink-400" /></span>}
                    {isClippingBase && <span className="h-2 w-0.5 rounded bg-pink-400/70" title={t.layers.clippingBaseTooltip} />}
                    {!isAdjustment && hasActiveLayerEffects(layer.meta?.effects) && (
                      <button
                        type="button"
                        data-testid={`layer-fx-badge-${layer.id}`}
                        title={t.layers.effects.tooltip}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectLayer(layer.id);
                          setEffectsOpenSignal((n) => n + 1);
                        }}
                        className="rounded border border-indigo-400/60 bg-indigo-500/25 px-1 py-0 text-[9px] font-bold leading-4 text-indigo-200 hover:bg-indigo-500/40"
                      >
                        fx
                      </button>
                    )}
                    {!isAdjustment && layer.alphaLocked && <span title={t.layers.lockedAlphaTooltip} className="text-amber-400"><AlphaLockIcon /></span>}
                    {layer.isLocked && <span title={t.layers.layerLocked}><Lock className="h-3 w-3 text-amber-400" /></span>}
                    {showReadOnlyBadge && (
                      <span title={t.layers.readOnlyTooltip} className="text-[10px] text-neutral-500"><Lock className="h-2.5 w-2.5 opacity-60" /></span>
                    )}
                    {canMove && !isBatchMode && (
                      <span title={t.layers.dragReorderTooltip} style={{ touchAction: 'none' }}
                        className="cursor-grab rounded p-0.5 opacity-35 hover:bg-neutral-700 group-hover:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* no capture */ }
                          startTouchDrag(e, layer.id);
                        }}>
                        <GripVertical className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </div>
                </div>
                {isOver && dropPosition === 'below' && <div className="mx-2 h-0.5 rounded bg-indigo-400" />}
              </React.Fragment>
            );
          })}
              {virtualize && endIdx < visibleDescending.length && <div style={{ height: (visibleDescending.length - endIdx) * ROW_H }} aria-hidden />}
            </>
          );
        })()}
        {fileDropAtEnd && <div className="mx-2 h-0.5 rounded bg-indigo-400" />}
      </div>

      <LayerPaperRow
        labels={t.layers.colors}
        canvasColor={canvasBgColor}
        localColor={localPaperColor}
        visible={paperVisible}
        isOffline={isOfflineCanvas}
        canSync={isAdmin && !readOnly}
        onToggleVisible={onTogglePaperVisible}
        onChangeColor={onChangePaperColor}
      />

      {menu && (() => {
        const layer = layers.find((l) => l.id === menu.layerId);
        if (!layer) return null;
        const ids = selectedLayerIds.size > 1 && selectedLayerIds.has(layer.id) ? Array.from(selectedLayerIds) : [layer.id];
        const groupBlocked = ids.map((id) => byId.get(id)).some((l) => !l || !canManage(l)) ? t.layers.groupBlocked : null;
        const parent = layer.parentId ? byId.get(layer.parentId) : undefined;
        const close = (fn: () => void) => () => { setMenu(null); fn(); };
        const menuWidth = Math.min(224, window.innerWidth - 16);
        const x = Math.max(8, Math.min(menu.x, window.innerWidth - menuWidth - 8));
        const y = Math.max(8, Math.min(menu.y, window.innerHeight - 8));
        const above = y - 8;
        const below = window.innerHeight - y - 8;
        const place: React.CSSProperties = below >= Math.min(420, above)
          ? { top: y, maxHeight: below }
          : { bottom: window.innerHeight - y, maxHeight: above };
        return createPortal(
          <div data-layer-menu role="menu" aria-label={t.layers.menuAria.replace('{name}', layer.name)} style={{ left: x, width: menuWidth, ...place }}
            className="fixed z-[90] overflow-y-auto overscroll-contain atelier-popover atelier-menu-in p-1">
            <div className="truncate px-2 py-1 text-[10px] text-neutral-500">{ids.length > 1 ? t.layers.selectedCountLayers.replace('{count}', String(ids.length)) : layer.name}</div>
            {layer.layerType === 'adjustment' && onEditAdjustmentLayer && (
              <MenuItem testId="layer-menu-edit-adjustment" label={t.layers.adjustment.edit} onClick={close(() => onEditAdjustmentLayer(layer.id))} />
            )}
            <MenuItem label={ids.length > 1 ? `${t.layers.groupSelected} (${ids.length})` : t.layers.addGroup} hint="Ctrl+G" disabledReason={groupBlocked}
              onClick={close(() => { onGroupLayers?.(ids); setSelectedLayerIds(new Set()); })} />
            {onCopyLayers && <MenuItem label={ids.length > 1 ? `${t.layers.copyLayers} (${ids.length})` : t.layers.copyLayers} hint="Ctrl+Alt+C" onClick={close(() => onCopyLayers(ids))} />}
            {onPasteLayers && <MenuItem label={t.layers.pasteLayers} hint="Ctrl+Alt+V" disabledReason={readOnly ? (isGuest ? t.layers.guestCannotPaste : t.collab.viewerReadOnlyWarn) : null} onClick={close(() => onPasteLayers())} />}
            {(onDuplicateLayers || (onCopyLayers && onPasteLayers)) && <MenuItem label={t.layers.duplicate} hint="Ctrl+J" disabledReason={readOnly ? (isGuest ? t.layers.guestCannotPaste : t.collab.viewerReadOnlyWarn) : null} onClick={close(() => {
              if (onDuplicateLayers) onDuplicateLayers(ids);
              else { onCopyLayers?.(ids); onPasteLayers?.(); }
            })} />}
            {onToggleKeepLayerClipboard && <MenuItem label={`${keepLayerClipboard ? '✓ ' : ''}${t.layers.keepClipboard}`} hint="~5MB" onClick={close(onToggleKeepLayerClipboard)} />}
            <div className="my-1 h-px bg-neutral-700/70" />
            <MenuItem label={t.layers.mergeDown} hint="Ctrl+E" disabledReason={ids.length > 1 ? t.layers.mergeOneAtATime : mergeBlocker(layer)} onClick={close(() => onMergeDown?.(layer.id))} />
            {parent && <MenuItem label={t.layers.removeFromGroup} disabledReason={canManage(layer) ? null : t.layers.cannotMoveOthers} onClick={close(() => void moveLayersToGroup([layer.id], parent.parentId ?? null))} />}
            {layer.layerType !== 'text' && layer.meta?.cel?.ref === undefined && !maskOf.get(layer.id) && onAddMask && (
              <MenuItem label={layer.layerType === 'group' ? t.layers.maskAddGroup : t.layers.addMask} disabledReason={canManage(layer) ? null : t.layers.cannotMaskOthers} onClick={close(() => onAddMask(layer.id))} />
            )}
            {maskOf.get(layer.id) && (
              <MenuItem label={maskOf.get(layer.id)!.meta?.maskInverted ? t.layers.maskInvertedCancel : t.layers.maskInvert} hint={t.layers.maskInvertHint}
                disabledReason={canManage(layer) ? null : t.layers.notYourLayer}
                onClick={close(() => { const m = maskOf.get(layer.id)!; onUpdateLayerProps?.(m.id, { meta: { ...m.meta, maskInverted: !m.meta?.maskInverted } }); })} />
            )}
            {layer.layerType === 'text' && (
              <MenuItem label={t.layers.rasterizeText} hint={t.layers.rasterizeTextHint} disabledReason={canManage(layer) ? null : t.layers.notYourLayer}
                onClick={close(() => { if (confirm(t.layers.rasterizeTextConfirm)) onUpdateLayerProps?.(layer.id, { layerType: 'raster' }); })} />
            )}
            {onOpenAlign && layer.layerType !== 'mask' && layer.layerType !== 'adjustment' && (
              <MenuItem label={t.align.menuItem} onClick={close(() => onOpenAlign(layer.id))} />
            )}
            {layer.layerType !== 'mask' && layer.layerType !== 'adjustment' && (
              layer.meta?.ruler ? (
                <>
                  <MenuItem
                    label={t.rulers.layerRulerToggleEnable}
                    disabledReason={!readOnly && canManage(layer) ? null : t.layers.notYourLayer}
                    onClick={close(() => {
                      const currentRuler = layer.meta?.ruler;
                      if (!currentRuler) return;
                      void onUpdateLayerProps?.(layer.id, {
                        meta: { ...layer.meta, ruler: { ...currentRuler, enabled: !currentRuler.enabled } },
                      });
                    })}
                  />
                  {onOpenRulerModal && (
                    <MenuItem
                      label={t.rulers.layerRulerOpenSettings}
                      onClick={close(() => {
                        onSelectLayer(layer.id);
                        onOpenRulerModal();
                      })}
                    />
                  )}
                  <MenuItem
                    label={t.rulers.layerRulerRemove}
                    danger
                    disabledReason={!readOnly && canManage(layer) ? null : t.layers.notYourLayer}
                    onClick={close(() => {
                      void onUpdateLayerProps?.(layer.id, { meta: { ...layer.meta, ruler: null } });
                    })}
                  />
                </>
              ) : (
                RulerManager.getInstance().state.mode !== 'off' && (
                  <MenuItem
                    label={t.rulers.layerRulerBindHere}
                    disabledReason={!readOnly && canManage(layer) ? null : t.layers.notYourLayer}
                    onClick={close(() => {
                      const exported = RulerManager.getInstance().exportCurrentAsLayerRuler(
                        layer.layerType === 'group' ? 'same_folder' : 'target_layer',
                        true,
                      );
                      if (!exported) return;
                      RulerManager.getInstance().clearDetachedMode();
                      void onUpdateLayerProps?.(layer.id, { meta: { ...layer.meta, ruler: exported } });
                    })}
                  />
                )
              )
            )}
            <MenuItem label={t.layers.renameLayer} hint="F2" disabledReason={canManage(layer) ? null : t.layers.notYourLayer} onClick={close(() => handleStartRename(layer))} />
            <div className="my-1 h-px bg-neutral-700/70" />
            <MenuItem label={t.layers.deleteLayer} danger disabledReason={canManage(layer) && layers.length > 1 ? null : t.layers.cannotDelete}
              onClick={close(() => { if (confirm(t.layers.deleteConfirm)) onDeleteLayer(layer.id); })} />
          </div>,
          document.body
        );
      })()}

      <AdminConfirmModal
        isOpen={!isOfflineCanvas && Boolean(forceClaimTarget)}
        layerName={forceClaimTarget?.name || ''}
        onConfirm={() => {
          if (forceClaimTarget) {
            onClaimLayer(forceClaimTarget.id, true);
            setForceClaimTarget(null);
          }
        }}
        onCancel={() => setForceClaimTarget(null)}
      />
    </div>
  );
};

const MenuItem: React.FC<{ label: string; onClick: () => void; disabledReason?: string | null; danger?: boolean; hint?: string; icon?: React.ReactNode; testId?: string }> = ({ label, onClick, disabledReason, danger, hint, icon, testId }) => (
  <button type="button" role="menuitem" data-testid={testId} disabled={Boolean(disabledReason)} onClick={onClick} title={disabledReason || hint}
    className={`flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-xs disabled:cursor-not-allowed disabled:opacity-40 ${danger ? 'text-rose-300 hover:bg-rose-950/50' : 'text-neutral-100 hover:bg-neutral-800'}`}>
    <span className="flex min-w-0 items-center gap-2">{icon}<span>{label}</span></span>
    {(disabledReason || hint) && <span className="text-[10px] text-neutral-500">{disabledReason || hint}</span>}
  </button>
);

const MaskIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="8" cy="8" r="3.2" fill="currentColor" />
  </svg>
);

const MaskInvertIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
    <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" />
  </svg>
);

const MergeDownIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="2.5" width="12" height="4" rx="1" />
    <rect x="2" y="10.5" width="12" height="3" rx="1" />
    <path d="M8 6.5v3.5m0 0L6.2 8.4M8 10l1.8-1.6" />
  </svg>
);

const AlphaLockIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
    <rect x="2" y="7" width="12" height="8" rx="1.5" />
    <path d="M5 7V5a3 3 0 0 1 6 0v2" />
    <text x="8" y="13.4" textAnchor="middle" fontSize="6.5" fill="currentColor" stroke="none" fontWeight="700">α</text>
  </svg>
);

/** Small eye with a person dot: the personal (not synced) visibility toggle. */
const PersonalEye: React.FC<{ on: boolean }> = ({ on }) => (
  <svg viewBox="0 0 16 12" className="h-3 w-4" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
    <path d="M1 6s2.5-4.5 7-4.5S15 6 15 6s-2.5 4.5-7 4.5S1 6 1 6Z" />
    {on ? <circle cx="8" cy="6" r="1.8" fill="currentColor" /> : <path d="M2 11 14 1" />}
  </svg>
);

/** CSP-style set-square icon shown on layers or folders that carry a bound ruler. */
const LayerRulerIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" aria-hidden>
    <path d="M2.5 13.5V2.5L13.5 13.5H2.5Z" />
    <path d="M5 11V7.5L8.5 11H5Z" />
  </svg>
);
