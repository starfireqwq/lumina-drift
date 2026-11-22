import React from 'react';
import {
  CAMERA_MAX_SCALE,
  CAMERA_MIN_SCALE,
  CameraFrameMeta,
  LayerModel,
  MAX_CAMERA_DIM,
  MIN_CAMERA_DIM,
  TransformKeyframe,
  evaluateCameraFrame,
} from '@atelier/shared';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Diamond,
  Eye,
  EyeOff,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import {
  adjacentKeyframeFrame,
  removeTransformKeyframe,
  upsertTransformKeyframe,
} from '../engine/AnimationEngine';
import { ToolWindow } from './workspace/ToolWindow';

export interface CameraToolWindowProps {
  open: boolean;
  onClose: () => void;
  cameraLayer: LayerModel | null;
  canEdit: boolean;
  currentFrame: number;
  canvasWidth: number;
  canvasHeight: number;
  previewActive: boolean;
  onTogglePreview: () => void;
  onCreateCamera: (meta: CameraFrameMeta) => void;
  onUpdateCameraMeta: (meta: CameraFrameMeta) => void;
  onUpdateCameraKeyframes: (keyframes: TransformKeyframe[]) => void;
  onDeleteCamera: () => void;
  onGoToFrame: (frame: number) => void;
}

const degToRad = (deg: number) => (deg * Math.PI) / 180;
const radToDeg = (rad: number) => Math.round(((rad * 180) / Math.PI) * 10) / 10;

export const CameraToolWindow: React.FC<CameraToolWindowProps> = ({
  open,
  onClose,
  cameraLayer,
  canEdit,
  currentFrame,
  canvasWidth,
  canvasHeight,
  previewActive,
  onTogglePreview,
  onCreateCamera,
  onUpdateCameraMeta,
  onUpdateCameraKeyframes,
  onDeleteCamera,
  onGoToFrame,
}) => {
  const { t } = useI18n();
  if (!open) return null;

  const meta = cameraLayer?.meta?.camera ?? null;
  const keyframes = cameraLayer?.meta?.keyframes ?? [];
  const evaluated = meta
    ? evaluateCameraFrame(meta, keyframes, currentFrame, canvasWidth, canvasHeight)
    : null;
  const hasKeyAtCurrent = keyframes.some((k) => Math.round(k.frame) === Math.round(currentFrame));
  const prevKf = adjacentKeyframeFrame(keyframes, currentFrame, -1);
  const nextKf = adjacentKeyframeFrame(keyframes, currentFrame, 1);

  const commitTransform = (patch: Partial<{ x: number; y: number; scale: number; rotationDeg: number }>) => {
    if (!evaluated || !canEdit) return;
    const prev = keyframes.find((k) => Math.round(k.frame) === Math.round(currentFrame));
    const scale =
      patch.scale !== undefined
        ? Math.max(CAMERA_MIN_SCALE, Math.min(CAMERA_MAX_SCALE, patch.scale))
        : evaluated.scaleX;
    const kf: TransformKeyframe = {
      frame: Math.round(currentFrame),
      x: patch.x !== undefined ? patch.x : evaluated.transform.x,
      y: patch.y !== undefined ? patch.y : evaluated.transform.y,
      scaleX: Math.round(scale * 1000) / 1000,
      scaleY: Math.round(scale * 1000) / 1000,
      rotation: patch.rotationDeg !== undefined ? degToRad(patch.rotationDeg) : evaluated.rotation,
      pivotX: canvasWidth / 2,
      pivotY: canvasHeight / 2,
      opacity: 1,
      easing: prev?.easing ?? 'easeInOut',
      ...(prev?.bezier ? { bezier: prev.bezier } : {}),
    };
    onUpdateCameraKeyframes(upsertTransformKeyframe(keyframes, kf));
  };

  const applyPresetSize = (aspectW: number, aspectH: number) => {
    const baseW = Math.round(canvasWidth * 0.85);
    const baseH = Math.round(canvasHeight * 0.85);
    let w = baseW;
    let h = Math.round((w * aspectH) / aspectW);
    if (h > baseH) {
      h = baseH;
      w = Math.round((h * aspectW) / aspectH);
    }
    const nextMeta: CameraFrameMeta = {
      width: Math.max(MIN_CAMERA_DIM, Math.min(MAX_CAMERA_DIM, w)),
      height: Math.max(MIN_CAMERA_DIM, Math.min(MAX_CAMERA_DIM, h)),
      showSafeArea: meta?.showSafeArea !== false,
    };
    if (meta) onUpdateCameraMeta(nextMeta);
    else onCreateCamera(nextMeta);
  };

  const chip = (active: boolean) =>
    `inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition disabled:opacity-40 ${
      active
        ? 'border-sky-400/70 bg-sky-500/20 text-sky-100'
        : 'border-neutral-700/80 bg-neutral-900/70 text-neutral-300 hover:bg-neutral-800 hover:text-white'
    }`;

  const numInputCls =
    'w-full min-w-0 rounded-md border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-right font-mono text-[11px] text-neutral-100 outline-none focus:border-sky-400 disabled:opacity-45';

  return (
    <ToolWindow
      id="anim_camera"
      title={t.animation.camera}
      icon={<Camera className="h-3.5 w-3.5 text-sky-400" />}
      onClose={onClose}
      initial={{ x: -20, y: 76, w: 300, h: 0 }}
      minW={264}
      minH={180}
      bodyClassName="p-3 space-y-2.5"
    >
      <div className="space-y-2.5 text-xs" data-testid="camera-tool-window">
        {!cameraLayer || !meta || !evaluated ? (
          <div className="space-y-2.5">
            <p className="text-[11px] leading-relaxed text-neutral-400">{t.animation.cameraTooltip}</p>
            <div className="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                disabled={!canEdit}
                data-testid="camera-preset-16-9"
                onClick={() => applyPresetSize(16, 9)}
                className={chip(false)}
              >
                16:9
              </button>
              <button
                type="button"
                disabled={!canEdit}
                onClick={() => applyPresetSize(1, 1)}
                className={chip(false)}
              >
                1:1
              </button>
              <button
                type="button"
                disabled={!canEdit}
                onClick={() => applyPresetSize(9, 16)}
                className={chip(false)}
              >
                9:16
              </button>
            </div>
            <button
              type="button"
              disabled={!canEdit}
              data-testid="camera-add-btn"
              onClick={() =>
                onCreateCamera({
                  width: Math.max(MIN_CAMERA_DIM, Math.round(canvasWidth * 0.85)),
                  height: Math.max(MIN_CAMERA_DIM, Math.round(canvasHeight * 0.85)),
                  showSafeArea: true,
                })
              }
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-sky-400/60 bg-sky-500/20 px-3 py-1.5 text-xs font-medium text-sky-100 transition hover:bg-sky-500/30 disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{t.animation.cameraAdd}</span>
            </button>
          </div>
        ) : (
          <>
            {/* Preview & Safe Area quick toggles */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                data-testid="camera-preview-toggle"
                aria-pressed={previewActive}
                onClick={onTogglePreview}
                className={`flex-1 ${chip(previewActive)}`}
              >
                {previewActive ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                <span className="truncate">{t.animation.cameraPreview}</span>
              </button>
              <button
                type="button"
                disabled={!canEdit}
                aria-pressed={meta.showSafeArea !== false}
                data-testid="camera-safe-area-toggle"
                onClick={() => onUpdateCameraMeta({ ...meta, showSafeArea: meta.showSafeArea === false })}
                className={chip(meta.showSafeArea !== false)}
              >
                <span>{t.animation.cameraSafeArea}</span>
              </button>
            </div>

            {!canEdit && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                {t.animation.cameraReadOnly}
              </div>
            )}

            {/* Frame size W x H */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-neutral-400">
                <span>{t.animation.cameraSize}</span>
                <div className="flex gap-1">
                  <button type="button" disabled={!canEdit} onClick={() => applyPresetSize(16, 9)} className="rounded border border-neutral-700/70 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40">16:9</button>
                  <button type="button" disabled={!canEdit} onClick={() => applyPresetSize(1, 1)} className="rounded border border-neutral-700/70 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40">1:1</button>
                  <button type="button" disabled={!canEdit} onClick={() => applyPresetSize(9, 16)} className="rounded border border-neutral-700/70 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40">9:16</button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <label className="flex items-center gap-1 text-[11px] text-neutral-400">
                  <span className="shrink-0">{t.animation.cameraWidth}</span>
                  <input
                    type="number"
                    min={MIN_CAMERA_DIM}
                    max={MAX_CAMERA_DIM}
                    step={8}
                    disabled={!canEdit}
                    data-testid="camera-width-input"
                    value={meta.width}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) {
                        onUpdateCameraMeta({ ...meta, width: Math.max(MIN_CAMERA_DIM, Math.min(MAX_CAMERA_DIM, Math.round(v))) });
                      }
                    }}
                    className={numInputCls}
                  />
                </label>
                <label className="flex items-center gap-1 text-[11px] text-neutral-400">
                  <span className="shrink-0">{t.animation.cameraHeight}</span>
                  <input
                    type="number"
                    min={MIN_CAMERA_DIM}
                    max={MAX_CAMERA_DIM}
                    step={8}
                    disabled={!canEdit}
                    data-testid="camera-height-input"
                    value={meta.height}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) {
                        onUpdateCameraMeta({ ...meta, height: Math.max(MIN_CAMERA_DIM, Math.min(MAX_CAMERA_DIM, Math.round(v))) });
                      }
                    }}
                    className={numInputCls}
                  />
                </label>
              </div>
            </div>

            {/* Position / Scale / Rotation keyframe values */}
            <div className="space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-900/50 p-2">
              <div className="grid grid-cols-2 gap-1.5">
                <label className="flex items-center gap-1 text-[11px] text-neutral-400">
                  <span className="shrink-0">X</span>
                  <input
                    type="number"
                    step={5}
                    disabled={!canEdit}
                    data-testid="camera-x-input"
                    value={Math.round(evaluated.transform.x)}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) commitTransform({ x: v });
                    }}
                    className={numInputCls}
                  />
                </label>
                <label className="flex items-center gap-1 text-[11px] text-neutral-400">
                  <span className="shrink-0">Y</span>
                  <input
                    type="number"
                    step={5}
                    disabled={!canEdit}
                    data-testid="camera-y-input"
                    value={Math.round(evaluated.transform.y)}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) commitTransform({ y: v });
                    }}
                    className={numInputCls}
                  />
                </label>
              </div>

              <label className="flex items-center gap-2 text-[11px] text-neutral-400">
                <span className="w-12 shrink-0 truncate">{t.animation.cameraScale}</span>
                <input
                  type="range"
                  min={15}
                  max={250}
                  step={1}
                  disabled={!canEdit}
                  data-testid="camera-scale-slider"
                  value={Math.round(evaluated.scaleX * 100)}
                  onChange={(e) => commitTransform({ scale: Number(e.target.value) / 100 })}
                  className="min-w-0 flex-1 accent-sky-400"
                />
                <span className="w-10 shrink-0 text-right font-mono text-[10px] text-neutral-200">
                  {Math.round(evaluated.scaleX * 100)}%
                </span>
              </label>

              <label className="flex items-center gap-2 text-[11px] text-neutral-400">
                <span className="w-12 shrink-0 truncate">{t.animation.cameraRotation}</span>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  step={1}
                  disabled={!canEdit}
                  data-testid="camera-rotation-slider"
                  value={Math.round(radToDeg(evaluated.rotation))}
                  onChange={(e) => commitTransform({ rotationDeg: Number(e.target.value) })}
                  className="min-w-0 flex-1 accent-sky-400"
                />
                <span className="w-10 shrink-0 text-right font-mono text-[10px] text-neutral-200">
                  {Math.round(radToDeg(evaluated.rotation))}°
                </span>
              </label>
            </div>

            {/* Keyframe actions & navigation */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={prevKf === null}
                onClick={() => prevKf !== null && onGoToFrame(prevKf)}
                title={t.animation.prevKeyframe}
                className={chip(false)}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={!canEdit}
                data-testid="camera-keyframe-btn"
                onClick={() => {
                  if (hasKeyAtCurrent) {
                    onUpdateCameraKeyframes(removeTransformKeyframe(keyframes, currentFrame));
                  } else {
                    commitTransform({});
                  }
                }}
                className={`flex-1 ${chip(hasKeyAtCurrent)}`}
              >
                <Diamond className="h-3 w-3" />
                <span className="truncate">
                  {hasKeyAtCurrent ? t.animation.cameraRemoveKey : t.animation.cameraAddKey}
                </span>
              </button>
              <button
                type="button"
                disabled={nextKf === null}
                onClick={() => nextKf !== null && onGoToFrame(nextKf)}
                title={t.animation.nextKeyframe}
                className={chip(false)}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="flex items-center justify-between gap-1.5 pt-0.5">
              <button
                type="button"
                disabled={!canEdit}
                data-testid="camera-reset-btn"
                onClick={() => commitTransform({ x: 0, y: 0, scale: 1, rotationDeg: 0 })}
                className={chip(false)}
              >
                <RotateCcw className="h-3 w-3" />
                <span>{t.animation.cameraReset}</span>
              </button>
              <button
                type="button"
                disabled={!canEdit}
                data-testid="camera-remove-btn"
                onClick={onDeleteCamera}
                className="inline-flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-300 transition hover:bg-red-500/20 disabled:opacity-40"
              >
                <Trash2 className="h-3 w-3" />
                <span>{t.animation.cameraRemove}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </ToolWindow>
  );
};
