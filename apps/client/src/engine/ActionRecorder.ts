import {
  ADJUSTMENT_BLEND_MODE_IDS,
  createDefaultAdjustment,
  normalizeAdjustment,
  type LayerAdjustment,
} from '@atelier/shared';
import type { StorageLike } from '../components/workspace/subToolStore';
import { getFilter, normalizeFilterValues } from '../utils/filterRegistry';

export const AUTO_ACTION_STEP_KINDS = [
  'layer.new', 'layer.duplicate', 'layer.merge_down', 'layer.delete',
  'layer.set_blend', 'layer.set_opacity', 'layer.set_clip',
  'filter.apply', 'adjustment.create',
  'selection.grow', 'selection.invert', 'selection.clear',
] as const;
export type AutoActionStepKind = typeof AUTO_ACTION_STEP_KINDS[number];

export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
type EmptyParams = Record<string, never>;
type AutoActionParams = {
  'layer.new': {
    name?: string;
    nameKey?: 'shadow' | 'light' | 'glow' | 'outline';
    blendMode?: string;
    opacity?: number;
    clipToBelow?: boolean;
  };
  'layer.duplicate': EmptyParams;
  'layer.merge_down': EmptyParams;
  'layer.delete': EmptyParams;
  'layer.set_blend': { blendMode: string };
  'layer.set_opacity': { opacity: number };
  'layer.set_clip': { clipToBelow: boolean };
  'filter.apply': { filterId: string; values: Record<string, JsonValue> };
  'adjustment.create': { adjustment: LayerAdjustment };
  'selection.grow': { px: number };
  'selection.invert': EmptyParams;
  'selection.clear': EmptyParams;
};

export type AutoActionStep = {
  [Kind in AutoActionStepKind]: { id: string; kind: Kind; params: AutoActionParams[Kind]; enabled: boolean };
}[AutoActionStepKind];

export interface AutoAction {
  id: string;
  name: string;
  steps: AutoActionStep[];
  builtinKey?: string;
  createdAt: number;
  updatedAt: number;
}

export const AUTO_ACTION_FILE_EXTENSION = '.lumina-action';
export const AUTO_ACTION_MIME = 'application/json';
const MAX_STEPS = 200;
const MAX_FILE_ACTIONS = 50;
const MAX_USER_ACTIONS = 100;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILTER_BYTES = 8 * 1024;
const STEP_KINDS = new Set<string>(AUTO_ACTION_STEP_KINDS);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

let idSequence = 0;
function newId(prefix: string): string {
  const random = Math.random().toString(36).slice(2);
  return `${prefix}_${Date.now()}_${random}${(++idSequence).toString(36)}`;
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : undefined;
}

function own(raw: object | undefined, key: string | number): unknown {
  if (!raw || (typeof key === 'string' && RESERVED_KEYS.has(key))) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(raw, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function limitCharacters(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let end = 0;
  for (const character of value) {
    end += character.length;
    if (--limit === 0) break;
  }
  return value.slice(0, end);
}

const normalizeName = (name: string): string =>
  limitCharacters(name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim(), 60);

function utf8Bytes(value: string, limit: number): number {
  if (value.length > limit) return limit + 1;
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > limit) break;
  }
  return bytes;
}

const FILTER_TOO_LARGE = Symbol();
interface JsonCopy {
  remainingBytes?: number;
  ancestors: Set<object>;
}

function spendJsonBytes(copy: JsonCopy, value: string): void {
  if (copy.remainingBytes === undefined) return;
  if (copy.remainingBytes < 0) throw FILTER_TOO_LARGE;
  copy.remainingBytes -= utf8Bytes(value, copy.remainingBytes);
  if (copy.remainingBytes < 0) throw FILTER_TOO_LARGE;
}

function copyJsonValue(raw: unknown, copy: JsonCopy, depth: number, arrayDepth = 0): JsonValue | undefined {
  if (typeof raw === 'string') {
    if (copy.remainingBytes !== undefined) {
      if (raw.length > copy.remainingBytes) throw FILTER_TOO_LARGE;
      spendJsonBytes(copy, JSON.stringify(raw));
    }
    return limitCharacters(raw, 200);
  }
  if (raw === null || typeof raw === 'boolean' || (typeof raw === 'number' && Number.isFinite(raw))) {
    spendJsonBytes(copy, JSON.stringify(raw));
    return raw;
  }
  if (typeof raw !== 'object' || depth === 0 || copy.ancestors.has(raw)) return undefined;

  const array = Array.isArray(raw);
  if (array && arrayDepth >= 3) return undefined;
  const result: Record<string, JsonValue> = Object.create(null);
  const items: JsonValue[] = [];
  let hasEntry = false;
  spendJsonBytes(copy, array ? '[]' : '{}');
  copy.ancestors.add(raw);
  for (const key of Object.keys(raw)) {
    if (array && !/^(0|[1-9][0-9]*)$/.test(key)) continue;
    if (array && Number(key) >= raw.length) continue;
    const value = own(raw, key);
    if (value === undefined) continue;
    const remaining = copy.remainingBytes;
    if (remaining !== undefined) {
      const keyBytes = array ? 0
        : key.length > remaining ? remaining + 1 : utf8Bytes(JSON.stringify(key), remaining) + 1;
      copy.remainingBytes = remaining - keyBytes - Number(hasEntry);
    }
    const entry = copyJsonValue(value, copy, depth - 1, arrayDepth + Number(array));
    if (entry === undefined) {
      copy.remainingBytes = remaining;
      continue;
    }
    if (array) items.push(entry);
    else result[key] = entry;
    hasEntry = true;
  }
  copy.ancestors.delete(raw);
  return array ? items : result;
}

const isBlendMode = (raw: unknown): raw is string =>
  typeof raw === 'string' && Object.hasOwn(ADJUSTMENT_BLEND_MODE_IDS, raw);
const isFiniteNumber = (raw: unknown): raw is number => typeof raw === 'number' && Number.isFinite(raw);
const clampOpacity = (value: number): number => Math.max(0, Math.min(1, value));

function normalizeNewLayer(params: Record<string, unknown>): AutoActionParams['layer.new'] | null {
  const result: AutoActionParams['layer.new'] = {};
  const name = own(params, 'name');
  const nameKey = own(params, 'nameKey');
  const blendMode = own(params, 'blendMode');
  const opacity = own(params, 'opacity');
  const clipToBelow = own(params, 'clipToBelow');
  if (name !== undefined) {
    if (typeof name !== 'string') return null;
    result.name = normalizeName(name);
  }
  if (nameKey !== undefined) {
    if (nameKey !== 'shadow' && nameKey !== 'light' && nameKey !== 'glow' && nameKey !== 'outline') return null;
    result.nameKey = nameKey;
  }
  if (blendMode !== undefined) {
    if (!isBlendMode(blendMode)) return null;
    result.blendMode = blendMode;
  }
  if (opacity !== undefined) {
    if (!isFiniteNumber(opacity)) return null;
    result.opacity = clampOpacity(opacity);
  }
  if (clipToBelow !== undefined) {
    if (typeof clipToBelow !== 'boolean') return null;
    result.clipToBelow = clipToBelow;
  }
  return result;
}

function normalizeFilter(params: Record<string, unknown>): AutoActionParams['filter.apply'] | null {
  const filterId = own(params, 'filterId');
  const raw = own(params, 'values');
  if (typeof filterId !== 'string' || !asRecord(raw)) return null;
  const def = getFilter(filterId);
  if (def?.tool || (!def && !filterId.startsWith('plugin:'))) return null;

  let values: Record<string, JsonValue>;
  try {
    // The byte budget also bounds the nesting of untrusted objects.
    values = copyJsonValue(raw, { remainingBytes: MAX_FILTER_BYTES, ancestors: new Set() }, Infinity) as Record<string, JsonValue>;
  } catch (error) {
    if (error === FILTER_TOO_LARGE) return null;
    throw error;
  }
  if (def?.source === 'builtin') {
    values = {
      ...(def.dialog ? values : Object.fromEntries(def.params
        .filter((param) => param.kind === 'point' && Object.hasOwn(values, param.key))
        .map((param) => [param.key, values[param.key]]))),
      ...normalizeFilterValues(def, values),
    } as Record<string, JsonValue>;
  }
  const json = JSON.stringify(values);
  if (utf8Bytes(json, MAX_FILTER_BYTES) > MAX_FILTER_BYTES) return null;
  return { filterId, values: JSON.parse(json) as Record<string, JsonValue> };
}

export function normalizeAutoActionStep(raw: unknown): AutoActionStep | null {
  const source = asRecord(raw);
  const kind = own(source, 'kind');
  const enabled = own(source, 'enabled');
  const id = own(source, 'id');
  const rawParams = own(source, 'params');
  const params = rawParams === undefined ? {} : asRecord(rawParams);
  if (!params || (enabled !== undefined && typeof enabled !== 'boolean')) return null;
  const step = { id: typeof id === 'string' && id ? id : newId('step'), enabled: enabled ?? true };

  switch (kind) {
    case 'layer.new': {
      const normalized = normalizeNewLayer(params);
      return normalized && { ...step, kind, params: normalized };
    }
    case 'layer.duplicate':
    case 'layer.merge_down':
    case 'layer.delete':
    case 'selection.invert':
    case 'selection.clear':
      return { ...step, kind, params: {} };
    case 'layer.set_blend': {
      const blendMode = own(params, 'blendMode');
      return isBlendMode(blendMode) ? { ...step, kind, params: { blendMode } } : null;
    }
    case 'layer.set_opacity': {
      const opacity = own(params, 'opacity');
      return isFiniteNumber(opacity) ? { ...step, kind, params: { opacity: clampOpacity(opacity) } } : null;
    }
    case 'layer.set_clip': {
      const clipToBelow = own(params, 'clipToBelow');
      return typeof clipToBelow === 'boolean' ? { ...step, kind, params: { clipToBelow } } : null;
    }
    case 'filter.apply': {
      const normalized = normalizeFilter(params);
      return normalized && { ...step, kind, params: normalized };
    }
    case 'adjustment.create': {
      const clean = copyJsonValue(own(params, 'adjustment'), { ancestors: new Set() }, 4);
      const adjustment = normalizeAdjustment(clean);
      return adjustment && { ...step, kind, params: { adjustment } };
    }
    case 'selection.grow': {
      const value = own(params, 'px');
      if (!isFiniteNumber(value)) return null;
      const px = Math.max(-500, Math.min(500, Math.round(value)));
      return px ? { ...step, kind, params: { px } } : null;
    }
    default:
      return null;
  }
}

export type RecorderState = 'idle' | 'recording' | 'paused';
export interface RecorderSnapshot {
  state: RecorderState;
  steps: readonly AutoActionStep[];
  full: boolean;
}

export class ActionRecorder {
  private snapshot: RecorderSnapshot = { state: 'idle', steps: [], full: false };
  private readonly listeners = new Set<() => void>();
  private lastCoalesceKey?: string;
  private suppressDepth = 0;

  getSnapshot = (): RecorderSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(snapshot: RecorderSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  start(): void {
    if (this.snapshot.state !== 'idle') return;
    this.lastCoalesceKey = undefined;
    this.publish({ state: 'recording', steps: [], full: false });
  }

  pause(): void {
    if (this.snapshot.state === 'recording') this.publish({ ...this.snapshot, state: 'paused' });
  }

  resume(): void {
    if (this.snapshot.state === 'paused') this.publish({ ...this.snapshot, state: 'recording' });
  }

  stop(): AutoActionStep[] {
    const steps = [...this.snapshot.steps];
    this.cancel();
    return steps;
  }

  cancel(): void {
    if (this.snapshot.state === 'idle') return;
    this.lastCoalesceKey = undefined;
    this.publish({ state: 'idle', steps: [], full: false });
  }

  record(input: { kind: AutoActionStepKind; params?: unknown }, opts?: { coalesceKey?: string }): boolean {
    if (!this.isCapturing()) return false;
    const { steps, full } = this.snapshot;
    const rawKey = own(opts, 'coalesceKey');
    const key = typeof rawKey === 'string' ? rawKey : undefined;
    const previous = steps.at(-1);
    const canReplace = previous && key !== undefined && key === this.lastCoalesceKey;
    const step = normalizeAutoActionStep({ kind: own(input, 'kind'), params: own(input, 'params'), id: canReplace ? previous.id : undefined });
    if (!step) return false;
    if (!canReplace && steps.length >= MAX_STEPS) {
      if (!full) this.publish({ ...this.snapshot, full: true });
      return false;
    }
    this.lastCoalesceKey = key;
    const next = canReplace ? [...steps.slice(0, -1), step] : [...steps, step];
    this.publish({ ...this.snapshot, steps: next });
    return true;
  }

  isCapturing(): boolean {
    return this.snapshot.state === 'recording' && this.suppressDepth === 0;
  }

  async runSuppressed<T>(fn: () => Promise<T> | T): Promise<T> {
    this.suppressDepth++;
    try {
      return await fn();
    } finally {
      this.suppressDepth--;
    }
  }
}

export const autoActionRecorder = new ActionRecorder();

function normalizeSteps(steps: readonly unknown[], freshIds = false): AutoActionStep[] {
  const result: AutoActionStep[] = [];
  for (let index = 0; index < Math.min(steps.length, MAX_STEPS); index++) {
    const step = normalizeAutoActionStep(own(steps, index));
    if (step) result.push(freshIds ? { ...step, id: newId('step') } : step);
  }
  return result;
}

function newAction(name: string, steps: AutoActionStep[]): AutoAction {
  const now = Date.now();
  return { id: newId('action'), name: normalizeName(name), steps, createdAt: now, updatedAt: now };
}

export function createAutoAction(name: string, steps: readonly AutoActionStep[]): AutoAction {
  return newAction(name, normalizeSteps(steps));
}

function editAction(action: AutoAction, patch: Partial<Pick<AutoAction, 'name' | 'steps'>>): AutoAction {
  return { ...action, ...patch, updatedAt: Math.max(Date.now(), action.updatedAt + 1) };
}

export function renameAutoAction(action: AutoAction, name: string): AutoAction {
  const normalized = normalizeName(name);
  return action.name === normalized ? action : editAction(action, { name: normalized });
}

export function moveAutoActionStep(action: AutoAction, from: number, to: number): AutoAction {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to
    || from < 0 || to < 0 || from >= action.steps.length || to >= action.steps.length) return action;
  const steps = [...action.steps];
  const [step] = steps.splice(from, 1);
  steps.splice(to, 0, step);
  return editAction(action, { steps });
}

function replaceStep(action: AutoAction, index: number, step: AutoActionStep): AutoAction {
  const steps = [...action.steps];
  steps[index] = step;
  return editAction(action, { steps });
}

export function setAutoActionStepEnabled(action: AutoAction, stepId: string, enabled: boolean): AutoAction {
  const index = action.steps.findIndex((step) => step.id === stepId);
  if (index < 0 || action.steps[index].enabled === enabled) return action;
  return replaceStep(action, index, { ...action.steps[index], enabled });
}

export function removeAutoActionStep(action: AutoAction, stepId: string): AutoAction {
  const steps = action.steps.filter((step) => step.id !== stepId);
  return steps.length === action.steps.length ? action : editAction(action, { steps });
}

export function updateAutoActionStepParams(action: AutoAction, stepId: string, params: unknown): AutoAction {
  const index = action.steps.findIndex((step) => step.id === stepId);
  if (index < 0) return action;
  const step = normalizeAutoActionStep({ ...action.steps[index], params });
  return step ? replaceStep(action, index, step) : action;
}

export function duplicateAutoAction(action: AutoAction, name: string): AutoAction {
  return newAction(name, normalizeSteps(action.steps, true));
}

export interface AutoActionFileWarning {
  code: 'unknown_kind' | 'invalid_params' | 'truncated';
  action: number;
  step?: number;
}

export class AutoActionFileError extends Error {
  constructor(public code: 'too_large' | 'not_json' | 'wrong_format' | 'unsupported_version' | 'empty') {
    super(code);
    this.name = 'AutoActionFileError';
  }
}

export function serializeAutoActionFile(actions: AutoAction[]): string {
  return JSON.stringify({
    format: 'lumina-action',
    version: 1,
    exportedAt: Date.now(),
    actions: actions.map(({ name, steps }) => ({
      name,
      steps: steps.map(({ kind, params, enabled }) => ({ kind, params, enabled })),
    })),
  }, null, 2);
}

export function parseAutoActionFile(text: string): { actions: AutoAction[]; warnings: AutoActionFileWarning[] } {
  if (utf8Bytes(text, MAX_FILE_BYTES) > MAX_FILE_BYTES) throw new AutoActionFileError('too_large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AutoActionFileError('not_json');
  }
  const file = asRecord(raw);
  if (own(file, 'format') !== 'lumina-action') throw new AutoActionFileError('wrong_format');
  if (own(file, 'version') !== 1) throw new AutoActionFileError('unsupported_version');

  const items = own(file, 'actions');
  const candidates = items === undefined
    ? (own(file, 'name') !== undefined || own(file, 'steps') !== undefined ? [file] : [])
    : items;
  if (!Array.isArray(candidates)) throw new AutoActionFileError('wrong_format');
  const actions: AutoAction[] = [];
  const warnings: AutoActionFileWarning[] = [];
  for (let action = 0; action < Math.min(candidates.length, MAX_FILE_ACTIONS); action++) {
    const candidate = asRecord(own(candidates, action));
    const name = own(candidate, 'name');
    const rawSteps = own(candidate, 'steps');
    if (typeof name !== 'string' || !Array.isArray(rawSteps)) {
      warnings.push({ code: 'invalid_params', action });
      continue;
    }
    const steps: AutoActionStep[] = [];
    for (let step = 0; step < Math.min(rawSteps.length, MAX_STEPS); step++) {
      const rawStep = asRecord(own(rawSteps, step));
      const kind = own(rawStep, 'kind');
      if (typeof kind !== 'string' || !STEP_KINDS.has(kind)) {
        warnings.push({ code: 'unknown_kind', action, step });
        continue;
      }
      const normalized = normalizeAutoActionStep({ kind, params: own(rawStep, 'params'), enabled: own(rawStep, 'enabled') });
      if (normalized) steps.push(normalized);
      else warnings.push({ code: 'invalid_params', action, step });
    }
    if (rawSteps.length > MAX_STEPS) warnings.push({ code: 'truncated', action, step: MAX_STEPS });
    actions.push(newAction(name, steps));
  }
  if (candidates.length > MAX_FILE_ACTIONS) warnings.push({ code: 'truncated', action: MAX_FILE_ACTIONS });
  if (actions.length === 0) throw new AutoActionFileError('empty');
  return { actions, warnings };
}

export const BUILTIN_AUTO_ACTION_KEYS = [
  'softGlow', 'lineGlow', 'shadowClip', 'lightClip', 'stickerOutline', 'chromaticPost', 'warmTone',
] as const;

type BuiltinKey = typeof BUILTIN_AUTO_ACTION_KEYS[number];
function builtin(builtinKey: BuiltinKey, name: string, inputs: ReadonlyArray<{ kind: AutoActionStepKind; params?: unknown }>): AutoAction {
  const id = `builtin:${builtinKey}`;
  const steps = inputs.map((input, index) => {
    const step = normalizeAutoActionStep({ ...input, id: `${id}:${index}` });
    if (!step) throw new Error(input.kind);
    return step;
  });
  return { id, builtinKey, name, steps, createdAt: 0, updatedAt: 0 };
}

const warmAdjustment = createDefaultAdjustment('color_balance');
if (warmAdjustment.kind === 'color_balance') {
  Object.assign(warmAdjustment.params.midtones, { cyanRed: 12, yellowBlue: -14 });
  Object.assign(warmAdjustment.params.highlights, { cyanRed: 8, yellowBlue: -10 });
}

export const BUILTIN_AUTO_ACTIONS: readonly AutoAction[] = [
  builtin('softGlow', '柔焦光暈', [
    { kind: 'layer.duplicate' },
    { kind: 'filter.apply', params: { filterId: 'gaussian', values: { radius: 12 } } },
    { kind: 'layer.set_blend', params: { blendMode: 'screen' } },
    { kind: 'layer.set_opacity', params: { opacity: 0.4 } },
  ]),
  builtin('lineGlow', '線稿自動發光氛圍', [
    { kind: 'layer.duplicate' },
    { kind: 'filter.apply', params: { filterId: 'gaussian', values: { radius: 6 } } },
    { kind: 'layer.set_blend', params: { blendMode: 'add' } },
    { kind: 'layer.set_opacity', params: { opacity: 0.8 } },
  ]),
  builtin('shadowClip', '一鍵建立陰影剪裁層', [
    { kind: 'layer.new', params: { nameKey: 'shadow', blendMode: 'multiply', opacity: 0.6, clipToBelow: true } },
  ]),
  builtin('lightClip', '一鍵建立亮部剪裁層', [
    { kind: 'layer.new', params: { nameKey: 'light', blendMode: 'screen', opacity: 0.5, clipToBelow: true } },
  ]),
  builtin('stickerOutline', '角色貼紙白邊外框', [
    { kind: 'layer.duplicate' },
    { kind: 'filter.apply', params: { filterId: 'outline', values: { size: 12, color: '#ffffff', position: 'outside' } } },
  ]),
  builtin('chromaticPost', '色差濾鏡後製', [
    { kind: 'layer.duplicate' },
    { kind: 'filter.apply', params: { filterId: 'chromatic', values: {} } },
    { kind: 'layer.set_opacity', params: { opacity: 0.85 } },
  ]),
  builtin('warmTone', '暖色調氛圍', [
    { kind: 'adjustment.create', params: { adjustment: warmAdjustment } },
  ]),
];

const BUILTIN_IDS = new Set(BUILTIN_AUTO_ACTIONS.map((action) => action.id));

function normalizeUserAction(raw: unknown): AutoAction | null {
  const record = asRecord(raw);
  const id = own(record, 'id');
  const name = own(record, 'name');
  const steps = own(record, 'steps');
  if (typeof id !== 'string' || !id || BUILTIN_IDS.has(id)
    || own(record, 'builtinKey') !== undefined || typeof name !== 'string' || !Array.isArray(steps)) return null;
  const createdAt = own(record, 'createdAt');
  const updatedAt = own(record, 'updatedAt');
  const created = isFiniteNumber(createdAt) ? createdAt : Date.now();
  return {
    id, name: normalizeName(name), steps: normalizeSteps(steps),
    createdAt: created, updatedAt: isFiniteNumber(updatedAt) ? updatedAt : created,
  };
}

function loadUserActions(storage: StorageLike, key: string): AutoAction[] {
  try {
    const raw: unknown = JSON.parse(storage.getItem(key) ?? '[]');
    if (!Array.isArray(raw)) return [];
    const actions = new Map<string, AutoAction>();
    for (let index = 0; index < Math.min(raw.length, MAX_USER_ACTIONS); index++) {
      const action = normalizeUserAction(own(raw, index));
      if (action) actions.set(action.id, action);
    }
    return [...actions.values()];
  } catch {
    return [];
  }
}

export function createAutoActionStore(storage: StorageLike, key = 'atelier_auto_actions_v1') {
  let userActions = loadUserActions(storage, key);
  let snapshot = [...BUILTIN_AUTO_ACTIONS, ...userActions];
  const listeners = new Set<() => void>();

  function commit(next: AutoAction[]): boolean {
    try {
      storage.setItem(key, JSON.stringify(next));
    } catch {
      return false;
    }
    userActions = next;
    snapshot = [...BUILTIN_AUTO_ACTIONS, ...userActions];
    for (const listener of listeners) listener();
    return true;
  }

  return {
    list: (): AutoAction[] => [...snapshot],
    listUser: (): AutoAction[] => [...userActions],
    save(action: AutoAction): boolean {
      const normalized = normalizeUserAction(action);
      if (!normalized) return false;
      const index = userActions.findIndex((existing) => existing.id === normalized.id);
      if (index === -1 && userActions.length >= MAX_USER_ACTIONS) return false;
      const next = [...userActions];
      if (index === -1) next.push(normalized);
      else next[index] = normalized;
      return commit(next);
    },
    remove(id: string): boolean {
      const next = userActions.filter((action) => action.id !== id);
      return next.length !== userActions.length && commit(next);
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: (): AutoAction[] => snapshot,
  };
}

export type AutoActionErrorCode = 'no_layer' | 'not_editable' | 'no_layer_below' | 'merge_blocked' | 'filter_unavailable'
  | 'filter_failed' | 'adjustment_blocked' | 'selection_unavailable' | 'read_only' | 'cancelled' | 'busy' | 'unknown';

export class AutoActionStepError extends Error {
  constructor(public code: AutoActionErrorCode, message?: string) {
    super(message);
    this.name = 'AutoActionStepError';
  }
}

export interface AutoActionHost {
  beginUndoGroup(groupId: string): void;
  endUndoGroup(): void;
  /** Undo every op pushed under groupId so far. */
  rollbackUndoGroup(groupId: string): Promise<void>;
  /** The index refers to the step's position in the action. */
  execute(step: AutoActionStep, ctx: { index: number; signal?: AbortSignal }): Promise<void>;
}

type AutoActionPlayFailure = { ok: false; groupId: string | null; failedIndex: number; code: AutoActionErrorCode; message?: string };
export type AutoActionPlayResult = { ok: true; groupId: string | null; executed: number } | AutoActionPlayFailure;

let playing = false;
export function isAutoActionPlaying(): boolean {
  return playing;
}

function playbackFailure(groupId: string | null, failedIndex: number, error: unknown): AutoActionPlayFailure {
  const code = error instanceof AutoActionStepError ? error.code : 'unknown';
  return {
    ok: false, groupId, failedIndex, code,
    ...(error instanceof Error && error.message ? { message: error.message } : {}),
  };
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AutoActionStepError('cancelled');
}

export async function playAutoAction(action: AutoAction, host: AutoActionHost, opts?: {
  signal?: AbortSignal;
  recorder?: ActionRecorder;
  /** Reports the zero-based position among enabled steps before execution. */
  onProgress?: (index: number, total: number, step: AutoActionStep) => void;
}): Promise<AutoActionPlayResult> {
  if (playing) return { ok: false, groupId: null, failedIndex: -1, code: 'busy' };
  const enabled = action.steps.flatMap((step, index) => step.enabled ? [{ step, index }] : []);
  if (enabled.length === 0) return { ok: true, groupId: null, executed: 0 };

  const groupId = newId('auto_action');
  const recorder = opts?.recorder ?? autoActionRecorder;
  const signal = opts?.signal;
  playing = true;
  try {
    // The whole transaction can emit operations, including its rollback.
    return await recorder.runSuppressed(async () => {
      try {
        host.beginUndoGroup(groupId);
      } catch (error) {
        return playbackFailure(null, -1, error);
      }

      let failedIndex = -1;
      let executed = 0;
      let failure: AutoActionPlayFailure | undefined;
      try {
        for (const { step, index } of enabled) {
          failedIndex = index;
          checkAborted(signal);
          opts?.onProgress?.(executed, enabled.length, step);
          checkAborted(signal);
          await host.execute(step, { index, signal });
          checkAborted(signal);
          executed++;
        }
      } catch (error) {
        failure = playbackFailure(groupId, failedIndex, signal?.aborted ? new AutoActionStepError('cancelled') : error);
      } finally {
        try {
          host.endUndoGroup();
        } catch (error) {
          failure ??= playbackFailure(groupId, failedIndex, error);
        }
      }
      if (!failure) return { ok: true, groupId, executed };

      try {
        await host.rollbackUndoGroup(groupId);
      } catch (error) {
        if (error instanceof Error && error.message) {
          failure.message = failure.message ? `${failure.message}\n${error.message}` : error.message;
        }
      }
      return failure;
    });
  } finally {
    playing = false;
  }
}
