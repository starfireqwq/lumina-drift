import React, { useMemo, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  FlipHorizontal2,
  FlipVertical2,
  ImagePlus,
  Lamp,
  Move,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import {
  LIGHT_TABLE_TINT_SWATCHES,
  LightTableScope,
  LightTableState,
  LightTableTintMode,
  addExternalLightRef,
  clearLightTable,
  externalRefsFor,
  getLightTableTransform,
  lightTableHas,
  registeredLightCelIdsFor,
  removeExternalLightRef,
  resetLightTableTransform,
  resolveLightTableTargetCel,
  setPinnedLightTarget,
  toggleLightCel,
  updateLightTableTransform,
} from '../engine/lightTable';
import { deleteLightTableAsset, saveLightTableAsset } from '../engine/lightTableAssets';
import { ToolWindow } from './workspace/ToolWindow';

export interface LightTableCelOption {
  id: string;
  label: string;
  folderId: string;
  folderName: string;
}

export interface LightTableWindowProps {
  open: boolean;
  onClose: () => void;
  lightTable: LightTableState;
  activeFolderId: string | null;
  currentCelId: string | null;
  celOptions: LightTableCelOption[];
  selectedRefId: string | null;
  onSelectRefId: (id: string | null) => void;
  canvasDragMode: boolean;
  onToggleCanvasDragMode: () => void;
  onUpdateLightTable: (fn: (s: LightTableState) => LightTableState) => void;
}

export const LightTableWindow: React.FC<LightTableWindowProps> = ({
  open,
  onClose,
  lightTable,
  activeFolderId,
  currentCelId,
  celOptions,
  selectedRefId,
  onSelectRefId,
  canvasDragMode,
  onToggleCanvasDragMode,
  onUpdateLightTable,
}) => {
  const { t } = useI18n();
  const [scopeKind, setScopeKind] = useState<'cel' | 'track'>('track');
  const [pickCelId, setPickCelId] = useState<string>('');
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const targetCelId = resolveLightTableTargetCel(lightTable, currentCelId);
  const celLabelById = useMemo(() => new Map(celOptions.map((c) => [c.id, c.label])), [celOptions]);

  const effectiveScope: LightTableScope | null = useMemo(() => {
    if (scopeKind === 'cel' && targetCelId) return { kind: 'cel', id: targetCelId };
    if (activeFolderId) return { kind: 'track', id: activeFolderId };
    if (targetCelId) return { kind: 'cel', id: targetCelId };
    return null;
  }, [scopeKind, targetCelId, activeFolderId]);

  const registeredCelIds = useMemo(
    () => registeredLightCelIdsFor(lightTable, activeFolderId, currentCelId),
    [lightTable, activeFolderId, currentCelId]
  );

  const externalRefs = useMemo(
    () => externalRefsFor(lightTable, activeFolderId, currentCelId),
    [lightTable, activeFolderId, currentCelId]
  );

  const refItems = useMemo(() => {
    const list: Array<{ id: string; label: string; isExternal: boolean; scopeKind: 'cel' | 'track'; scopeId: string }> = [];
    for (const id of registeredCelIds) {
      const inCel = Boolean(targetCelId && lightTableHas(lightTable, { kind: 'cel', id: targetCelId }, id));
      list.push({
        id,
        label: celLabelById.get(id) ?? id.slice(0, 8),
        isExternal: false,
        scopeKind: inCel ? 'cel' : 'track',
        scopeId: inCel ? targetCelId! : activeFolderId ?? '',
      });
    }
    for (const ext of externalRefs) {
      list.push({
        id: ext.id,
        label: ext.name,
        isExternal: true,
        scopeKind: ext.scopeKind,
        scopeId: ext.scopeId,
      });
    }
    return list;
  }, [registeredCelIds, externalRefs, targetCelId, lightTable, celLabelById, activeFolderId]);

  const activeRefId = selectedRefId && refItems.some((r) => r.id === selectedRefId)
    ? selectedRefId
    : refItems[0]?.id ?? null;

  const activeTransform = activeRefId ? getLightTableTransform(lightTable, activeRefId) : null;

  if (!open) return null;

  const handleImportImage = async (file: File | undefined) => {
    if (!file || !effectiveScope) return;
    setImportError(null);
    try {
      const asset = await saveLightTableAsset(file);
      onUpdateLightTable((s) =>
        addExternalLightRef(
          { ...s, enabled: true },
          {
            id: asset.id,
            name: asset.name,
            width: asset.width,
            height: asset.height,
            scopeKind: effectiveScope.kind,
            scopeId: effectiveScope.id,
          }
        )
      );
      onSelectRefId(asset.id);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Image import failed');
    }
  };

  const chip = (active: boolean) =>
    `inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition disabled:opacity-40 ${
      active
        ? 'border-amber-400/70 bg-amber-500/20 text-amber-100'
        : 'border-neutral-700/80 bg-neutral-900/70 text-neutral-300 hover:bg-neutral-800 hover:text-white'
    }`;

  const numInputCls =
    'w-full min-w-0 rounded-md border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-right font-mono text-[11px] text-neutral-100 outline-none focus:border-amber-400';

  const pinnedLabel = lightTable.pinnedTargetId
    ? celLabelById.get(lightTable.pinnedTargetId) ?? lightTable.pinnedTargetId.slice(0, 8)
    : null;

  return (
    <ToolWindow
      id="anim_light_table"
      title={t.animation.lightWindowTitle}
      icon={<Lamp className="h-3.5 w-3.5 text-amber-400" />}
      onClose={onClose}
      initial={{ x: -332, y: 76, w: 312, h: 0 }}
      minW={272}
      minH={220}
      bodyClassName="p-3 space-y-2.5 max-h-[75vh] overflow-y-auto"
    >
      <div className="space-y-2.5 text-xs" data-testid="light-table-window">
        {/* Top bar: master switch, pinned target lock, canvas drag adjust */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={lightTable.enabled}
            data-testid="light-table-enable-toggle"
            onClick={() => onUpdateLightTable((s) => ({ ...s, enabled: !s.enabled }))}
            className={chip(lightTable.enabled)}
          >
            <Lamp className="h-3.5 w-3.5" />
            <span>{lightTable.enabled ? t.animation.lightTableOn : t.animation.lightTableOff}</span>
          </button>

          <button
            type="button"
            aria-pressed={Boolean(lightTable.pinnedTargetId)}
            disabled={!lightTable.pinnedTargetId && !currentCelId}
            data-testid="light-table-pin-toggle"
            onClick={() =>
              onUpdateLightTable((s) =>
                setPinnedLightTarget(s, s.pinnedTargetId ? null : currentCelId)
              )
            }
            className={chip(Boolean(lightTable.pinnedTargetId))}
            title={t.animation.lightPinTarget}
          >
            {lightTable.pinnedTargetId ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            <span className="max-w-[92px] truncate">
              {pinnedLabel ? `${t.animation.lightPinned}: ${pinnedLabel}` : t.animation.lightPinTarget}
            </span>
          </button>

          <button
            type="button"
            aria-pressed={canvasDragMode}
            disabled={!activeRefId || !lightTable.enabled}
            data-testid="light-table-canvas-drag-toggle"
            onClick={onToggleCanvasDragMode}
            className={chip(canvasDragMode)}
          >
            <Move className="h-3.5 w-3.5" />
            <span>{t.animation.lightCanvasDrag}</span>
          </button>
        </div>

        {/* Global opacity */}
        <label className="flex items-center gap-2 text-[11px] text-neutral-400">
          <span className="shrink-0">{t.animation.lightOpacity}</span>
          <input
            type="range"
            min={5}
            max={100}
            value={Math.round(lightTable.opacity * 100)}
            data-testid="light-table-global-opacity"
            onChange={(e) => onUpdateLightTable((s) => ({ ...s, opacity: Number(e.target.value) / 100 }))}
            className="min-w-0 flex-1 accent-amber-400"
          />
          <span className="w-9 shrink-0 text-right font-mono text-[10px] text-neutral-200">
            {Math.round(lightTable.opacity * 100)}%
          </span>
        </label>

        {/* Scope & Add reference controls */}
        <div className="space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-900/50 p-2">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex items-center gap-1" role="radiogroup" aria-label={t.animation.lightTable}>
              <button
                type="button"
                role="radio"
                aria-checked={scopeKind === 'cel'}
                disabled={!targetCelId}
                onClick={() => setScopeKind('cel')}
                className={chip(scopeKind === 'cel')}
              >
                {t.animation.lightThisCel}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={scopeKind === 'track'}
                disabled={!activeFolderId}
                onClick={() => setScopeKind('track')}
                className={chip(scopeKind === 'track')}
              >
                {t.animation.lightWholeTrack}
              </button>
            </div>
            {effectiveScope && refItems.length > 0 && (
              <button
                type="button"
                data-testid="light-table-clear-btn"
                onClick={() => {
                  const toDelete = externalRefs
                    .filter((r) => r.scopeKind === effectiveScope.kind && r.scopeId === effectiveScope.id)
                    .map((r) => r.id);
                  for (const id of toDelete) void deleteLightTableAsset(id);
                  onUpdateLightTable((s) => clearLightTable(s, effectiveScope));
                  onSelectRefId(null);
                }}
                className="inline-flex items-center gap-1 rounded-md border border-neutral-700/70 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              >
                <Trash2 className="h-3 w-3" />
                <span>{t.animation.lightClear}</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <select
              value={pickCelId}
              onChange={(e) => setPickCelId(e.target.value)}
              disabled={!effectiveScope || celOptions.length === 0}
              data-testid="light-table-cel-select"
              className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-100 outline-none focus:border-amber-400 disabled:opacity-45"
            >
              <option value="">{t.animation.lightAddCel}…</option>
              {celOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.folderName} / {c.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!effectiveScope || !pickCelId}
              data-testid="light-table-add-cel-btn"
              onClick={() => {
                if (!effectiveScope || !pickCelId) return;
                onUpdateLightTable((s) => toggleLightCel({ ...s, enabled: true }, effectiveScope, pickCelId));
                onSelectRefId(pickCelId);
              }}
              className={chip(false)}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                void handleImportImage(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={!effectiveScope}
              data-testid="light-table-import-image-btn"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-neutral-700 bg-neutral-950/60 px-2.5 py-1.5 text-[11px] text-neutral-300 transition hover:border-amber-400/60 hover:text-amber-200 disabled:opacity-40"
            >
              <ImagePlus className="h-3.5 w-3.5" />
              <span>{t.animation.lightImportImage}</span>
            </button>
            {importError && <div className="mt-1 text-[10px] text-red-400">{importError}</div>}
          </div>
        </div>

        {/* Registered reference list */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] font-medium text-neutral-400">
            <span>{t.animation.lightReferences} ({refItems.length})</span>
          </div>
          {refItems.length === 0 ? (
            <div className="rounded-lg border border-neutral-800/80 bg-neutral-950/40 px-2.5 py-2 text-[11px] text-neutral-500">
              {t.animation.lightNoRefs}
            </div>
          ) : (
            <div className="max-h-32 space-y-1 overflow-y-auto pr-0.5">
              {refItems.map((item) => {
                const tr = getLightTableTransform(lightTable, item.id);
                const selected = item.id === activeRefId;
                return (
                  <div
                    key={item.id}
                    data-testid={`light-ref-item-${item.id}`}
                    className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition ${
                      selected
                        ? 'border-amber-400/70 bg-amber-500/15 text-white'
                        : 'border-neutral-800 bg-neutral-900/50 text-neutral-300 hover:bg-neutral-800/70'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateLightTable((s) =>
                          updateLightTableTransform(s, item.id, { visible: !tr.visible })
                        )
                      }
                      className="shrink-0 text-neutral-400 hover:text-white"
                      aria-label={tr.visible ? 'Hide reference' : 'Show reference'}
                    >
                      {tr.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5 opacity-50" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelectRefId(item.id)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
                      <span className="truncate">{item.label}</span>
                      {item.isExternal && (
                        <span className="shrink-0 rounded bg-sky-500/20 px-1 py-0.5 text-[9px] text-sky-300">
                          {t.animation.lightExternalBadge}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (item.isExternal) {
                          void deleteLightTableAsset(item.id);
                          onUpdateLightTable((s) => removeExternalLightRef(s, item.id));
                        } else if (item.scopeId) {
                          onUpdateLightTable((s) =>
                            toggleLightCel(s, { kind: item.scopeKind, id: item.scopeId }, item.id)
                          );
                        }
                        if (activeRefId === item.id) onSelectRefId(null);
                      }}
                      className="shrink-0 text-neutral-500 hover:text-red-400"
                      aria-label="Remove reference"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Per-reference transform & coloring */}
        {activeRefId && activeTransform && (
          <div className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-900/50 p-2" data-testid="light-table-transform-controls">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-neutral-300">{t.animation.lightTransform}</span>
              <button
                type="button"
                data-testid="light-table-reset-transform"
                onClick={() => onUpdateLightTable((s) => resetLightTableTransform(s, activeRefId))}
                className="inline-flex items-center gap-1 rounded-md border border-neutral-700/80 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-800"
              >
                <RotateCcw className="h-3 w-3" />
                <span>{t.animation.lightResetTransform}</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <label className="flex items-center gap-1 text-[11px] text-neutral-400">
                <span className="shrink-0">X</span>
                <input
                  type="number"
                  step={5}
                  data-testid="light-ref-x-input"
                  value={Math.round(activeTransform.x)}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) {
                      onUpdateLightTable((s) => updateLightTableTransform(s, activeRefId, { x: v }));
                    }
                  }}
                  className={numInputCls}
                />
              </label>
              <label className="flex items-center gap-1 text-[11px] text-neutral-400">
                <span className="shrink-0">Y</span>
                <input
                  type="number"
                  step={5}
                  data-testid="light-ref-y-input"
                  value={Math.round(activeTransform.y)}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) {
                      onUpdateLightTable((s) => updateLightTableTransform(s, activeRefId, { y: v }));
                    }
                  }}
                  className={numInputCls}
                />
              </label>
            </div>

            <label className="flex items-center gap-2 text-[11px] text-neutral-400">
              <span className="w-11 shrink-0 truncate">{t.animation.cameraScale}</span>
              <input
                type="range"
                min={20}
                max={300}
                value={Math.round(activeTransform.scale * 100)}
                data-testid="light-ref-scale-slider"
                onChange={(e) =>
                  onUpdateLightTable((s) =>
                    updateLightTableTransform(s, activeRefId, { scale: Number(e.target.value) / 100 })
                  )
                }
                className="min-w-0 flex-1 accent-amber-400"
              />
              <span className="w-9 shrink-0 text-right font-mono text-[10px] text-neutral-200">
                {Math.round(activeTransform.scale * 100)}%
              </span>
            </label>

            <label className="flex items-center gap-2 text-[11px] text-neutral-400">
              <span className="w-11 shrink-0 truncate">{t.animation.cameraRotation}</span>
              <input
                type="range"
                min={-180}
                max={180}
                value={Math.round(activeTransform.rotation)}
                data-testid="light-ref-rotation-slider"
                onChange={(e) =>
                  onUpdateLightTable((s) =>
                    updateLightTableTransform(s, activeRefId, { rotation: Number(e.target.value) })
                  )
                }
                className="min-w-0 flex-1 accent-amber-400"
              />
              <span className="w-9 shrink-0 text-right font-mono text-[10px] text-neutral-200">
                {Math.round(activeTransform.rotation)}°
              </span>
            </label>

            <label className="flex items-center gap-2 text-[11px] text-neutral-400">
              <span className="w-11 shrink-0 truncate">{t.animation.lightItemOpacity}</span>
              <input
                type="range"
                min={5}
                max={100}
                value={Math.round(activeTransform.opacity * 100)}
                data-testid="light-ref-opacity-slider"
                onChange={(e) =>
                  onUpdateLightTable((s) =>
                    updateLightTableTransform(s, activeRefId, { opacity: Number(e.target.value) / 100 })
                  )
                }
                className="min-w-0 flex-1 accent-amber-400"
              />
              <span className="w-9 shrink-0 text-right font-mono text-[10px] text-neutral-200">
                {Math.round(activeTransform.opacity * 100)}%
              </span>
            </label>

            {/* Flip H / V */}
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                aria-pressed={activeTransform.flipX}
                data-testid="light-ref-flip-x"
                onClick={() =>
                  onUpdateLightTable((s) =>
                    updateLightTableTransform(s, activeRefId, { flipX: !activeTransform.flipX })
                  )
                }
                className={chip(activeTransform.flipX)}
              >
                <FlipHorizontal2 className="h-3.5 w-3.5" />
                <span>{t.animation.lightFlipX}</span>
              </button>
              <button
                type="button"
                aria-pressed={activeTransform.flipY}
                data-testid="light-ref-flip-y"
                onClick={() =>
                  onUpdateLightTable((s) =>
                    updateLightTableTransform(s, activeRefId, { flipY: !activeTransform.flipY })
                  )
                }
                className={chip(activeTransform.flipY)}
              >
                <FlipVertical2 className="h-3.5 w-3.5" />
                <span>{t.animation.lightFlipY}</span>
              </button>
            </div>

            {/* Tint mode & color swatches */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-1">
                <span className="text-[11px] text-neutral-400">{t.animation.lightTint}</span>
                <div className="flex items-center gap-1" role="radiogroup" aria-label={t.animation.lightTint}>
                  {([
                    ['original', t.animation.lightTintOriginal],
                    ['tint', t.animation.lightTintFlat],
                    ['shade', t.animation.lightTintShade],
                  ] as const).map(([m, label]) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={activeTransform.tintMode === m}
                      data-testid={`light-ref-tint-${m}`}
                      onClick={() =>
                        onUpdateLightTable((s) =>
                          updateLightTableTransform(s, activeRefId, { tintMode: m as LightTableTintMode })
                        )
                      }
                      className={`rounded-md border px-1.5 py-0.5 text-[10px] transition ${
                        activeTransform.tintMode === m
                          ? 'border-amber-400/80 bg-amber-500/20 text-amber-100'
                          : 'border-neutral-700/80 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {activeTransform.tintMode !== 'original' && (
                <div className="flex items-center gap-1.5">
                  {LIGHT_TABLE_TINT_SWATCHES.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      onClick={() =>
                        onUpdateLightTable((s) => updateLightTableTransform(s, activeRefId, { tint: hex }))
                      }
                      className={`h-5 w-5 rounded-full border-2 transition ${
                        activeTransform.tint?.toLowerCase() === hex.toLowerCase()
                          ? 'scale-110 border-white'
                          : 'border-neutral-700 hover:border-neutral-400'
                      }`}
                      style={{ backgroundColor: hex }}
                      aria-label={hex}
                    />
                  ))}
                  <input
                    type="color"
                    value={activeTransform.tint ?? '#38bdf8'}
                    onChange={(e) =>
                      onUpdateLightTable((s) => updateLightTableTransform(s, activeRefId, { tint: e.target.value }))
                    }
                    className="h-5 w-7 cursor-pointer rounded border border-neutral-700 bg-transparent p-0"
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </ToolWindow>
  );
};
