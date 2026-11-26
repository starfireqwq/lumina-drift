import { useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronRight, Circle, Copy, Download, GripVertical,
  Pause, Pencil, Play, Square, Trash2, Upload, X,
} from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import {
  AUTO_ACTION_FILE_EXTENSION, AUTO_ACTION_MIME, AutoActionFileError, autoActionRecorder,
  createAutoAction, createAutoActionStore, duplicateAutoAction, moveAutoActionStep, parseAutoActionFile,
  removeAutoActionStep, renameAutoAction, serializeAutoActionFile, setAutoActionStepEnabled, updateAutoActionStepParams,
  type AutoAction, type AutoActionPlayResult, type AutoActionStep,
} from '../engine/ActionRecorder';
import { filterParamLabel, getFilter, getFilterRegistryVersion, paramShown, subscribeFilterRegistry } from '../utils/filterRegistry';
import {
  describeAutoActionError, describeAutoActionFilterValue, describeAutoActionImportError, describeAutoActionStep, formatAutoActionLabel,
} from './autoActionLabels';
import { AtelierModal, modalButton } from './AtelierModal';
import { getLocalizedBlendModeGroups } from './LayerPanel';
import { OverlayPresence } from './OverlayPresence';

let actionStore: ReturnType<typeof createAutoActionStore> | undefined;

type Playback =
  | { status: 'idle' }
  | { status: 'playing'; index: number; total: number }
  | { status: 'done' }
  | { status: 'failed'; result: Extract<AutoActionPlayResult, { ok: false }>; step?: AutoActionStep };

let playback: Playback = { status: 'idle' };
const playbackListeners = new Set<() => void>();
const getPlayback = () => playback;
const subscribePlayback = (listener: () => void) => {
  playbackListeners.add(listener);
  return () => { playbackListeners.delete(listener); };
};

function publishPlayback(next: Playback) {
  playback = next;
  playbackListeners.forEach((listener) => listener());
}

function requestPlayback(action: AutoAction) {
  if (playback.status === 'playing') return;
  const requestId = globalThis.crypto?.randomUUID?.() ?? `auto_action_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const total = action.steps.filter((step) => step.enabled).length;
  const onProgress = (event: Event) => {
    const detail = (event as CustomEvent<{ requestId: string; index: number; total: number }>).detail;
    if (detail?.requestId !== requestId) return;
    publishPlayback({ status: 'playing', index: detail.index + 1, total: detail.total });
  };
  const onResult = (event: Event) => {
    const detail = (event as CustomEvent<{ requestId: string; result: AutoActionPlayResult }>).detail;
    if (detail?.requestId !== requestId) return;
    window.removeEventListener('atelier:auto-action-progress', onProgress);
    window.removeEventListener('atelier:auto-action-result', onResult);
    const { result } = detail;
    publishPlayback(result.ok ? { status: 'done' } : { status: 'failed', result, step: action.steps[result.failedIndex] });
  };
  window.addEventListener('atelier:auto-action-progress', onProgress);
  window.addEventListener('atelier:auto-action-result', onResult);
  publishPlayback({ status: 'playing', index: total ? 1 : 0, total });
  window.dispatchEvent(new CustomEvent('atelier:run-auto-action', { detail: { action, requestId } }));
}

function downloadActions(actions: AutoAction[], name: string) {
  const url = URL.createObjectURL(new Blob([serializeAutoActionFile(actions)], { type: AUTO_ACTION_MIME }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() + AUTO_ACTION_FILE_EXTENSION;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function countSkippedSteps(text: string, warnings: ReturnType<typeof parseAutoActionFile>['warnings']) {
  if (!warnings.some(({ code, step }) => code === 'truncated' && step !== undefined)) {
    return warnings.filter(({ step }) => step !== undefined).length;
  }
  const file = JSON.parse(text) as { actions?: { steps?: unknown[] }[]; steps?: unknown[] };
  const actions = file.actions ?? [file];
  return warnings.reduce((count, { action, code, step }) => {
    if (step === undefined) return count;
    return count + (code === 'truncated' ? (actions[action]?.steps?.length ?? step) - step : 1);
  }, 0);
}

const fieldClass = 'min-h-8 w-full min-w-0 rounded border border-neutral-700 bg-neutral-950 px-2 text-neutral-100';

function ActionButton({ label, icon, showLabel, className = '', ...props }:
  ComponentProps<'button'> & { label: string; icon: ReactNode; showLabel?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label}
      className={`atelier-icon-btn flex min-h-8 min-w-8 max-w-full flex-none items-center justify-center gap-1.5 rounded px-1.5 py-1 text-xs disabled:opacity-40 [&>svg]:size-3.5 [&>svg]:shrink-0 ${className}`}
      {...props}>
      {icon}
      {showLabel && <span className="min-w-0 break-words text-left">{label}</span>}
    </button>
  );
}

function NumberField({ value, min, max, step = 1, label, allowZero = true, onChange }: {
  value: number; min: number; max: number; step?: number; label: string; allowZero?: boolean; onChange: (value: number) => void;
}) {
  return (
    <input key={value} type="number" inputMode={min < 0 ? 'text' : 'decimal'} aria-label={label} defaultValue={value}
      min={min} max={max} step={step} className={fieldClass}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          event.currentTarget.value = String(value);
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => {
        const input = event.currentTarget;
        const parsed = input.valueAsNumber;
        const next = input.validity.valid && Number.isFinite(parsed) && (allowZero || parsed !== 0) ? parsed : value;
        input.value = String(next);
        if (next !== value) onChange(next);
      }} />
  );
}

function StepEditor({ step, onChange }: { step: AutoActionStep; onChange: (params: unknown) => void }) {
  const { t, language } = useI18n();
  const labels = t.autoActions;
  const { params } = step;
  const patch = (changes: object) => onChange({ ...params, ...changes });
  const blend = 'blendMode' in params ? params.blendMode : undefined;
  const opacity = 'opacity' in params ? params.opacity : undefined;

  if (blend !== undefined || opacity !== undefined) {
    return (
      <>
        {blend !== undefined && (
          <label className="grid min-w-0 gap-1">
            {labels.steps['layer.set_blend']}
            <select value={blend} className={fieldClass} onChange={(event) => patch({ blendMode: event.currentTarget.value })}>
              {getLocalizedBlendModeGroups(t).map((group) => (
                <optgroup key={group.category} label={group.category}>
                  {group.items.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
        )}
        {opacity !== undefined && (
          <label className="grid min-w-0 gap-1">
            {formatAutoActionLabel(labels.params.opacity, { value: Math.round(opacity * 100) })}
            <input type="range" min={0} max={100} step={1} className="h-8 w-full accent-indigo-400"
              value={Math.round(opacity * 100)} aria-label={labels.steps['layer.set_opacity']}
              onChange={(event) => patch({ opacity: event.currentTarget.valueAsNumber / 100 })} />
          </label>
        )}
      </>
    );
  }
  if (step.kind === 'selection.grow') {
    return (
      <label className="grid min-w-0 gap-1">
        {labels.params.pixels}
        <NumberField value={step.params.px} min={-500} max={500} label={labels.params.pixels} allowZero={false}
          onChange={(px) => patch({ px })} />
      </label>
    );
  }
  if (step.kind !== 'filter.apply') return null;
  const { filterId, values } = step.params;
  const def = getFilter(filterId);
  if (!def) return <p className="break-words">{labels.errors.filter_unavailable}</p>;

  return def.params.filter((param) => param.key in values && paramShown(param, values)).map((param) => {
    const label = filterParamLabel(param, t, language) || param.key;
    const value = values[param.key];
    if (param.kind === 'range' && typeof value === 'number') {
      const caption = param.unit ? `${label} (${param.unit})` : label;
      return (
        <label key={param.key} className="grid min-w-0 gap-1 break-words">
          {caption}
          <NumberField value={value} min={param.min} max={param.max} step={param.step} label={caption}
            onChange={(next) => patch({ values: { ...values, [param.key]: next } })} />
        </label>
      );
    }
    return (
      <div key={param.key} className="flex min-w-0 flex-wrap justify-between gap-x-2 break-all">
        <span>{label}</span>
        <span className="text-neutral-300">{describeAutoActionFilterValue(param, value, t, language)}</span>
      </div>
    );
  });
}

function canEditStep(step: AutoActionStep) {
  return step.kind === 'selection.grow' || step.kind === 'filter.apply' ||
    'blendMode' in step.params || 'opacity' in step.params;
}

type Dialog =
  | { kind: 'name'; steps: AutoActionStep[] }
  | { kind: 'rename' | 'delete'; action: AutoAction }
  | { kind: 'import'; message: string; partial?: boolean };

export function AutoActionsPanel({ readOnly = false }: { readOnly?: boolean }) {
  const { t, language } = useI18n();
  const labels = t.autoActions;
  const store = actionStore ??= createAutoActionStore(window.localStorage);
  const actions = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const recording = useSyncExternalStore(autoActionRecorder.subscribe, autoActionRecorder.getSnapshot);
  const status = useSyncExternalStore(subscribePlayback, getPlayback);
  useSyncExternalStore(subscribeFilterRegistry, getFilterRegistryVersion);
  const [expanded, setExpanded] = useState<string>();
  const [edited, setEdited] = useState<string>();
  const [dragTarget, setDragTarget] = useState<string>();
  const drag = useRef<{ pointerId: number; actionId: string; stepId: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [saveError, setSaveError] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const userActions = actions.filter((action) => !action.builtinKey);
  const isRecording = recording.state !== 'idle';
  const busy = status.status === 'playing';
  const recordingStatus = isRecording
    ? formatAutoActionLabel(recording.state === 'paused' ? labels.paused : labels.recordingStatus, { count: recording.steps.length })
    : '';

  const describeStep = (step: AutoActionStep) => describeAutoActionStep(step, t, language);
  const showDialog = (next: Dialog, name = '') => {
    setSaveError(false);
    setDraftName(name);
    setDialog(next);
    setDialogOpen(true);
  };
  const closeDialog = () => {
    setDialogOpen(false);
    setSaveError(false);
  };
  const save = (action: AutoAction) => {
    const saved = store.save(action);
    setSaveError(!saved);
    return saved;
  };
  const duplicate = (action: AutoAction, name: string) => {
    const copy = duplicateAutoAction(action, formatAutoActionLabel(labels.duplicateName, { name }));
    if (save(copy)) {
      setEdited(undefined);
      setExpanded(copy.id);
    }
  };
  const stopRecording = () => {
    const names = new Set(userActions.map((action) => action.name));
    let n = userActions.length + 1;
    let name = formatAutoActionLabel(labels.defaultName, { n });
    while (names.has(name)) name = formatAutoActionLabel(labels.defaultName, { n: ++n });
    showDialog({ kind: 'name', steps: autoActionRecorder.stop() }, name);
  };
  const importActions = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const { actions: imported, warnings } = parseAutoActionFile(text);
      const count = imported.filter((action) => store.save(action)).length;
      const skipped = countSkippedSteps(text, warnings);
      showDialog({
        kind: 'import',
        message: formatAutoActionLabel(labels.importResult, { count, skipped }),
        partial: count !== imported.length || warnings.some(({ step }) => step === undefined),
      });
    } catch (error) {
      showDialog({
        kind: 'import',
        message: error instanceof AutoActionFileError ? describeAutoActionImportError(error.code, t) : labels.importReadError,
      });
    } finally {
      setImporting(false);
    }
  };

  const playbackMessage = () => {
    if (status.status === 'playing') return formatAutoActionLabel(labels.playing, { index: status.index, total: status.total });
    if (status.status === 'done') return labels.done;
    if (status.status === 'failed') {
      const error = describeAutoActionError(status.result.code, t);
      return status.step ? formatAutoActionLabel(labels.failed, {
        error, step: status.result.failedIndex + 1, name: describeStep(status.step),
      }) : error;
    }
    return '';
  };

  const renderReadOnlySteps = (steps: readonly AutoActionStep[], isLive = false) => (
    <ol role="list" data-testid={isLive ? 'auto-actions-recording-steps' : undefined} className="grid min-w-0 gap-1">
      {steps.map((step) => {
        const description = describeStep(step);
        return (
          <li key={step.id} role="listitem" data-testid="auto-action-step" data-step-kind={step.kind} data-step-enabled={step.enabled}
            title={description} className={`min-w-0 truncate rounded bg-neutral-950/70 px-2 py-1.5 ${step.enabled ? '' : 'text-neutral-500'}`}>
            {description}
          </li>
        );
      })}
      {!steps.length && <li role="listitem" className="px-2 py-1.5 text-neutral-400">{labels.emptySteps}</li>}
    </ol>
  );

  function renderEditableSteps(action: AutoAction) {
    const targetAt = (x: number, y: number) => {
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-step-id]');
      return row?.closest('[data-action-id]')?.getAttribute('data-action-id') === action.id ? row?.dataset.stepId : undefined;
    };
    const clearDrag = () => {
      drag.current = null;
      setDragTarget(undefined);
    };
    return (
      <ol role="list" className="grid min-w-0 gap-1">
        {action.steps.map((step, index) => {
          const description = describeStep(step);
          const editing = edited === step.id;
          return (
            <li key={step.id} role="listitem" data-testid="auto-action-step" data-step-id={step.id}
              data-step-kind={step.kind} data-step-enabled={step.enabled}
              className={`min-w-0 rounded border p-1 ${dragTarget === step.id ? 'border-indigo-400 bg-indigo-950/40' : 'border-neutral-800 bg-neutral-950/60'}`}>
              <div className="flex min-w-0 items-center gap-1">
                <label title={labels.enableStep} className="grid size-8 shrink-0 cursor-pointer place-items-center">
                  <input type="checkbox" checked={step.enabled} aria-label={labels.enableStep} className="size-4 accent-indigo-500"
                    onChange={(event) => save(setAutoActionStepEnabled(action, step.id, event.currentTarget.checked))} />
                </label>
                <span title={description} className={`min-w-0 flex-1 truncate ${step.enabled ? 'text-neutral-100' : 'text-neutral-400'}`}>{description}</span>
                <ActionButton label={labels.dragHandle} icon={<GripVertical />} tabIndex={-1} disabled={action.steps.length < 2}
                  className="touch-none cursor-grab active:cursor-grabbing"
                  onPointerDown={(event) => {
                    if (event.button !== 0 || drag.current) return;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    drag.current = { pointerId: event.pointerId, actionId: action.id, stepId: step.id };
                    setDragTarget(step.id);
                  }}
                  onPointerMove={(event) => {
                    if (drag.current?.pointerId === event.pointerId) setDragTarget(targetAt(event.clientX, event.clientY));
                  }}
                  onPointerUp={(event) => {
                    const current = drag.current;
                    if (current?.pointerId !== event.pointerId || current.actionId !== action.id) return;
                    const target = targetAt(event.clientX, event.clientY);
                    const to = action.steps.findIndex((item) => item.id === target);
                    const from = action.steps.findIndex((item) => item.id === current.stepId);
                    clearDrag();
                    if (from >= 0 && to >= 0 && from !== to) save(moveAutoActionStep(action, from, to));
                  }}
                  onPointerCancel={clearDrag} onLostPointerCapture={clearDrag} />
              </div>
              <div className="flex flex-wrap justify-end">
                <ActionButton label={labels.moveUp} icon={<ArrowUp />} disabled={index === 0}
                  onClick={() => save(moveAutoActionStep(action, index, index - 1))} />
                <ActionButton label={labels.moveDown} icon={<ArrowDown />} disabled={index === action.steps.length - 1}
                  onClick={() => save(moveAutoActionStep(action, index, index + 1))} />
                {canEditStep(step) && (
                  <ActionButton label={labels.editStep} icon={<Pencil />} aria-expanded={editing} aria-pressed={editing}
                    onClick={() => setEdited(editing ? undefined : step.id)} />
                )}
                <ActionButton label={labels.removeStep} icon={<Trash2 />} onClick={() => save(removeAutoActionStep(action, step.id))} />
              </div>
              {editing && (
                <div className="grid min-w-0 gap-2 border-t border-neutral-800 p-2 text-neutral-300">
                  <StepEditor step={step} onChange={(params) => save(updateAutoActionStepParams(action, step.id, params))} />
                </div>
              )}
            </li>
          );
        })}
        {!action.steps.length && <li role="listitem" className="px-2 py-1.5 text-neutral-400">{labels.emptySteps}</li>}
      </ol>
    );
  }

  return (
    <section data-testid="auto-actions-panel" aria-label={labels.title}
      className="flex min-h-full min-w-0 flex-col gap-2 bg-neutral-900 p-2 text-xs text-neutral-200">
      <fieldset disabled={busy || importing || dialogOpen} className="flex min-w-0 flex-1 flex-col gap-2">
        <div aria-live="polite" className="sticky top-0 z-10">
          {status.status !== 'idle' && (
            <p data-testid="auto-actions-status" data-status={status.status}
              className={`break-words rounded px-2 py-1.5 ${status.status === 'failed' ? 'bg-rose-950 text-rose-200' : 'bg-indigo-950 text-indigo-200'}`}>
              {playbackMessage()}
            </p>
          )}
        </div>
        <div className="min-w-0 space-y-1 rounded-lg border border-neutral-800 bg-neutral-950/50 p-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <div aria-live="polite" className="flex min-w-0 items-center gap-1.5">
              {isRecording && (
                <>
                  <span aria-hidden className={`size-2 shrink-0 rounded-full bg-red-500 ${recording.state === 'recording' ? 'motion-safe:animate-pulse' : ''}`} />
                  <span className="min-w-0 break-words font-medium text-red-300">{recordingStatus}</span>
                </>
              )}
            </div>
            {isRecording ? (
              <div className="flex flex-wrap items-center">
                {recording.state === 'recording' ? (
                  <ActionButton key="pause" label={labels.pause} icon={<Pause />} showLabel data-testid="auto-actions-pause"
                    onClick={() => autoActionRecorder.pause()} />
                ) : (
                  <ActionButton key="resume" label={labels.resume} icon={<Play />} showLabel data-testid="auto-actions-resume" disabled={readOnly}
                    onClick={() => autoActionRecorder.resume()} />
                )}
                <ActionButton label={labels.stop} icon={<Square />} showLabel data-testid="auto-actions-stop" onClick={stopRecording} />
                <ActionButton label={labels.cancelRecording} icon={<X />} showLabel data-testid="auto-actions-cancel"
                  onClick={() => autoActionRecorder.cancel()} />
              </div>
            ) : (
              <span title={readOnly ? labels.readOnlyReason : undefined} className="min-w-0 max-w-full">
                <ActionButton label={labels.record} icon={<Circle className="fill-current text-red-400" />} showLabel
                  data-testid="auto-actions-record" disabled={readOnly}
                  className="bg-neutral-800 text-neutral-100 disabled:pointer-events-none"
                  onClick={() => { publishPlayback({ status: 'idle' }); autoActionRecorder.start(); }} />
              </span>
            )}
          </div>
          {isRecording && renderReadOnlySteps(recording.steps, true)}
          {isRecording && recording.full && <p className="px-2 text-amber-300">{labels.recordingFull}</p>}
        </div>

        <ul role="list" className="grid min-w-0 gap-1">
          {actions.map((action) => {
            const key = action.builtinKey as keyof typeof labels.presets | undefined;
            const preset = key && labels.presets[key];
            const name = preset ? preset.name : action.name;
            const open = expanded === action.id;
            return (
              <li key={action.id} role="listitem" data-testid="auto-action-row" data-action-id={action.id} data-builtin-key={key} title={preset ? preset.desc : undefined}
                className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-800/35">
                <div className="flex min-w-0 items-center gap-1 px-1">
                  <ActionButton label={open ? labels.collapse : labels.expand} icon={open ? <ChevronDown /> : <ChevronRight />}
                    data-testid="auto-action-expand" aria-expanded={open}
                    onClick={() => { setExpanded(open ? undefined : action.id); setEdited(undefined); }} />
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 py-1">
                    <span title={preset ? `${name} · ${preset.desc}` : name} className="min-w-0 max-w-full truncate font-medium text-neutral-100">{name}</span>
                    {preset && <span className="max-w-full break-words rounded bg-indigo-400/15 px-1.5 py-0.5 text-[10px] text-indigo-200">{labels.builtinBadge}</span>}
                  </div>
                  <span title={readOnly ? labels.readOnlyReason : undefined} className="shrink-0">
                    <ActionButton label={labels.play} icon={<Play className="fill-current" />} data-testid="auto-action-play"
                      disabled={readOnly || isRecording} className="text-indigo-300 disabled:pointer-events-none"
                      onClick={() => requestPlayback(action)} />
                  </span>
                </div>
                {open && (
                  <div className="space-y-1 border-t border-neutral-800 p-1.5">
                    {preset ? renderReadOnlySteps(action.steps) : renderEditableSteps(action)}
                    <div className="flex min-w-0 flex-wrap gap-1">
                      {preset ? (
                        <ActionButton label={labels.duplicateToMine} icon={<Copy />} showLabel onClick={() => duplicate(action, name)} />
                      ) : (
                        <>
                          <ActionButton label={labels.rename} icon={<Pencil />} onClick={() => showDialog({ kind: 'rename', action }, name)} />
                          <ActionButton label={labels.duplicate} icon={<Copy />} onClick={() => duplicate(action, name)} />
                          <ActionButton label={labels.export} icon={<Download />} onClick={() => downloadActions([action], name)} />
                          <ActionButton label={labels.delete} icon={<Trash2 />} onClick={() => showDialog({ kind: 'delete', action })} />
                        </>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {!userActions.length && <p className="px-2 text-neutral-400">{labels.emptyMine}</p>}
        <div className="mt-auto flex min-w-0 flex-wrap gap-1 border-t border-neutral-800 pt-1">
          <input ref={fileInput} type="file" accept=".lumina-action,application/json" data-testid="auto-actions-import-input" hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file && !busy && !importing) void importActions(file);
            }} />
          <ActionButton label={labels.import} icon={<Upload />} showLabel onClick={() => fileInput.current?.click()} />
          <ActionButton label={labels.exportAll} icon={<Download />} showLabel data-testid="auto-actions-export-all"
            disabled={!userActions.length} onClick={() => downloadActions(userActions, 'lumina-actions')} />
        </div>
      </fieldset>
      {saveError && !dialogOpen && <p role="alert" className="break-words text-rose-300">{labels.saveError}</p>}
      {dialog && createPortal(
        <OverlayPresence open={dialogOpen}>
          {dialog.kind === 'import' ? (
            <AtelierModal key="import" title={labels.import} onClose={closeDialog}
              footer={<button type="button" className={modalButton.primary} onClick={closeDialog}>{t.common.close}</button>}>
              <div className="atelier-plugin-sweep space-y-2 break-words">
                <p>{dialog.message}</p>
                {dialog.partial && <p className="text-amber-300">{labels.importPartial}</p>}
              </div>
            </AtelierModal>
          ) : dialog.kind === 'delete' ? (
            <AtelierModal key="delete" title={labels.delete} tone="danger" onClose={closeDialog}
              footer={
                <>
                  <button type="button" className={modalButton.secondary} onClick={closeDialog}>{t.common.cancel}</button>
                  <button type="button" className={modalButton.danger} onClick={() => {
                    if (store.remove(dialog.action.id)) closeDialog();
                    else setSaveError(true);
                  }}>{t.common.delete}</button>
                </>
              }>
              <div className="atelier-plugin-sweep space-y-2 break-words">
                <p>{formatAutoActionLabel(labels.deleteConfirm, { name: dialog.action.name })}</p>
                {saveError && <p role="alert" className="text-rose-300">{labels.saveError}</p>}
              </div>
            </AtelierModal>
          ) : (
            <AtelierModal key={dialog.kind} title={dialog.kind === 'rename' ? labels.rename : labels.nameDialogTitle} onClose={closeDialog}
              onSubmit={(event) => {
                event.preventDefault();
                const name = draftName.trim();
                if (!dialogOpen || !name) return;
                const action = dialog.kind === 'name' ? createAutoAction(name, dialog.steps) : renameAutoAction(dialog.action, name);
                if (!save(action)) return;
                setExpanded(action.id);
                setEdited(undefined);
                closeDialog();
              }}
              footer={
                <>
                  <button type="button" className={modalButton.secondary} onClick={closeDialog}>{t.common.cancel}</button>
                  <button type="submit" className={modalButton.primary} data-testid="auto-actions-name-save"
                    disabled={!draftName.trim()}>{t.common.save}</button>
                </>
              }>
              <div className="atelier-plugin-sweep grid gap-2 pb-1">
                <input type="text" data-testid="auto-actions-name-input" className={fieldClass} autoFocus maxLength={60}
                  value={draftName} onChange={(event) => setDraftName(event.currentTarget.value)}
                  aria-label={labels.namePlaceholder} placeholder={labels.namePlaceholder} />
                {saveError && <p role="alert" className="break-words text-rose-300">{labels.saveError}</p>}
              </div>
            </AtelierModal>
          )}
        </OverlayPresence>, document.body,
      )}
    </section>
  );
}
