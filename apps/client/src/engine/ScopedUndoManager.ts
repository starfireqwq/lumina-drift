import { compressTileBuffer, mergeUndoPixels, RemovedLayer, ScopedUndoOp, TileData, tileToRgba } from '@atelier/shared';

export const ONLINE_UNDO_LIMIT = 30;
export const OFFLINE_UNDO_LIMIT = 100;

interface ForeignEdit {
  seq: number;
  active: boolean;
}

interface ForeignTileEdit {
  edit: ForeignEdit;
  changed: Uint8Array;
  ink?: { source: TileData; before: TileData; after: TileData };
}

/** Premultiplied source-over. The saved pair preserves the GPU's per-dab rounding on its original base. */
function paintOver(source: DataView, offset: number, base: number) {
  const ink = source.getUint32(offset);
  if (!base || (ink & 255) === 255) return ink;
  const invAlpha = (255 - (ink & 255)) / 255;
  let pixel = 0;
  for (const shift of [24, 16, 8, 0]) {
    const value = (ink >>> shift & 255) + Math.round((base >>> shift & 255) * invAlpha);
    pixel |= Math.min(255, value) << shift;
  }
  return pixel >>> 0;
}

const viewOf = (pixels: Uint8Array) => new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength);
const viewOfTile = (tile: TileData) => viewOf(tileToRgba(tile));

export class ScopedUndoManager {
  private undoStack: ScopedUndoOp[] = [];
  private redoStack: ScopedUndoOp[] = [];
  private foreignEdits = new Map<string, ForeignEdit>();
  private foreignTiles = new WeakMap<ScopedUndoOp, Map<string, ForeignTileEdit[]>>();
  private originalTiles = new WeakMap<ScopedUndoOp, Map<string, { before: TileData; after: TileData }>>();
  private maxStackSize: number;
  private activeGroup: { id: string; depth: number } | null = null;

  constructor(maxStackSize: number = ONLINE_UNDO_LIMIT) {
    this.maxStackSize = maxStackSize;
  }

  public setMaxStackSize(size: number) {
    this.maxStackSize = Math.max(5, Math.min(100, size));
    this.trimStacks();
  }

  public beginGroup(groupId: string): void {
    if (this.activeGroup) {
      this.activeGroup.depth++;
    } else {
      this.activeGroup = { id: groupId, depth: 1 };
    }
  }

  public endGroup(): void {
    if (this.activeGroup && --this.activeGroup.depth === 0) this.activeGroup = null;
  }

  public getActiveGroup(): string | null {
    return this.activeGroup?.id ?? null;
  }

  /** Counts applied ops available to undo. */
  public countGroupOps(groupId: string): number {
    return this.undoStack.reduce((count, op) => count + Number(op.groupId === groupId), 0);
  }

  public getLatestUndoGroup(userId?: string): string | undefined {
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      const op = this.undoStack[i];
      if (userId === undefined || op.userId === userId) return op.groupId;
    }
    return undefined;
  }

  public discardRedoGroup(groupId: string): void {
    this.redoStack = this.redoStack.filter((op) => op.groupId !== groupId);
  }

  public push(op: ScopedUndoOp) {
    if (this.activeGroup) op.groupId = this.activeGroup.id;
    this.undoStack.push(op);
    this.trimStacks();
    // Any new action clears the redo stack
    this.redoStack = [];
  }

  private countLogicalSteps(stack: ScopedUndoOp[], userId?: string): number {
    let count = 0;
    let i = 0;
    while (i < stack.length) {
      const op = stack[i];
      if (userId !== undefined && op.userId !== userId) {
        i++;
        continue;
      }
      count++;
      const gid = op.groupId || undefined;
      i++;
      if (gid) {
        while (i < stack.length && stack[i].groupId === gid && (userId === undefined || stack[i].userId === userId)) {
          i++;
        }
      }
    }
    return count;
  }

  private trimStack(stack: ScopedUndoOp[]) {
    let steps = this.countLogicalSteps(stack);
    while (steps > this.maxStackSize && stack.length > 0) {
      const gid = stack[0].groupId || undefined;
      do {
        const dropped = stack.shift();
        if (dropped) {
          dropped.beforeTiles = [];
          dropped.afterTiles = [];
          dropped.foreign = undefined;
        }
      } while (gid && stack.length > 0 && stack[0].groupId === gid);
      steps--;
    }
  }

  private trimStacks() {
    this.trimStack(this.undoStack);
    this.trimStack(this.redoStack);
  }

  /** A layer came back under a new id (undo of a merge / of a deletion): its history follows it */
  public remapLayer(oldId: string, newId: string) {
    const remapStrokes = (list?: any[]) => list?.map((s) => (s?.layerId === oldId ? { ...s, layerId: newId } : s));
    for (const op of [...this.undoStack, ...this.redoStack]) {
      if (op.layerId === oldId) op.layerId = newId;
      if (op.vectorStroke?.layerId === oldId) op.vectorStroke = { ...op.vectorStroke, layerId: newId };
      if (op.vectorAddedStrokes) op.vectorAddedStrokes = remapStrokes(op.vectorAddedStrokes);
      if (op.vectorRemovedStrokes) op.vectorRemovedStrokes = remapStrokes(op.vectorRemovedStrokes);
      if (op.layerRemoved) {
        // A deleted group holds what was inside it; where it goes back is told by its neighbours' ids
        const walk = (r: RemovedLayer) => {
          if (r.model.id === oldId) r.model = { ...r.model, id: newId };
          if (r.model.parentId === oldId) r.model = { ...r.model, parentId: newId };
          // A repeated animation cel points at the cel it shows
          if (r.model.meta?.cel?.ref === oldId) r.model = { ...r.model, meta: { ...r.model.meta, cel: { ...r.model.meta.cel, ref: newId } } };
          if (r.mask?.model.id === oldId) r.mask.model = { ...r.mask.model, id: newId };
          r.children?.forEach(walk);
        };
        walk(op.layerRemoved);
        if (op.layerRemoved.below === oldId) op.layerRemoved.below = newId;
        if (op.layerRemoved.above === oldId) op.layerRemoved.above = newId;
      }
      if (op.layerCreated) {
        const model = op.layerCreated.model;
        if (model.id === oldId) op.layerCreated.model = { ...model, id: newId };
        if (model.parentId === oldId) op.layerCreated.model = { ...op.layerCreated.model, parentId: newId };
        if (model.meta?.cel?.ref === oldId) {
          op.layerCreated.model = { ...op.layerCreated.model, meta: { ...model.meta, cel: { ...model.meta.cel, ref: newId } } };
        }
      }
    }
  }

  public canUndo(userId?: string): boolean {
    return this.undoStack.some((op) => userId === undefined || op.userId === userId);
  }

  public canRedo(userId?: string): boolean {
    return this.redoStack.some((op) => userId === undefined || op.userId === userId);
  }

  /** Returns the most recently pushed undo op on `layerId`, for tracking concurrent tile baselines */
  public peekLatestForLayer(layerId: string): ScopedUndoOp | undefined {
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      if (this.undoStack[i].layerId === layerId) return this.undoStack[i];
    }
    return undefined;
  }

  /**
   * Scoped undo: finds the latest action performed by the current user
   * on a layer they have permission to modify
   */
  public undo(
    userId?: string,
    checkPermission?: (layerId: string, op?: ScopedUndoOp) => boolean
  ): ScopedUndoOp | null {
    if (this.undoStack.length === 0) return null;

    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      const op = this.undoStack[i];
      const matchUser = userId === undefined || op.userId === userId;

      if (matchUser) {
        if (op.opType !== 'SELECTION' && checkPermission && !checkPermission(op.layerId, op)) {
          console.warn(`[ScopedUndo] User does not have permission on layer ${op.layerId}`);
          continue;
        }

        // Pop from undo stack and push to redo stack
        this.undoStack.splice(i, 1);
        this.redoStack.push(op);
        this.trimStacks();
        return op;
      }
    }

    return null;
  }

  /**
   * Scoped redo: finds the latest undone action by current user to re-apply
   */
  public redo(
    userId?: string,
    checkPermission?: (layerId: string, op?: ScopedUndoOp) => boolean
  ): ScopedUndoOp | null {
    if (this.redoStack.length === 0) return null;

    for (let i = this.redoStack.length - 1; i >= 0; i--) {
      const op = this.redoStack[i];
      const matchUser = userId === undefined || op.userId === userId;

      if (matchUser) {
        if (op.opType !== 'SELECTION' && checkPermission && !checkPermission(op.layerId, op)) {
          console.warn(`[ScopedRedo] User does not have permission on layer ${op.layerId}`);
          continue;
        }

        // Pop from redo stack and push to undo stack
        this.redoStack.splice(i, 1);
        this.undoStack.push(op);
        this.trimStacks();
        return op;
      }
    }

    return null;
  }

  public rollbackStep(op: ScopedUndoOp, wasUndo: boolean) {
    const movedTo = wasUndo ? this.redoStack : this.undoStack;
    const from = wasUndo ? this.undoStack : this.redoStack;
    const index = movedTo.indexOf(op);
    if (index < 0) return;
    movedTo.splice(index, 1);
    from.push(op);
  }

  private popGroup(
    from: ScopedUndoOp[],
    to: ScopedUndoOp[],
    label: 'ScopedUndo' | 'ScopedRedo',
    userId?: string,
    checkPermission?: (layerId: string, op: ScopedUndoOp, group: readonly ScopedUndoOp[]) => boolean,
    requiredGroupId?: string,
  ): ScopedUndoOp[] {
    for (let i = from.length - 1; i >= 0; i--) {
      const op = from[i];
      const gid = op.groupId || undefined;
      if (userId !== undefined && op.userId !== userId) {
        if (gid) {
          while (i > 0 && from[i - 1].groupId === gid && from[i - 1].userId !== userId) {
            i--;
          }
        }
        continue;
      }
      if (requiredGroupId !== undefined && gid !== requiredGroupId) return [];

      let start = i;
      if (gid) {
        while (start > 0 && from[start - 1].groupId === gid && (userId === undefined || from[start - 1].userId === userId)) {
          start--;
        }
      }

      let denied: ScopedUndoOp | undefined;
      if (checkPermission) {
        const group = from.slice(start, i + 1);
        for (const item of group) {
          if (item.opType !== 'SELECTION' && !checkPermission(item.layerId, item, group)) {
            denied = item;
            break;
          }
        }
      }
      if (denied) {
        console.warn(`[${label}] User does not have permission on layer ${denied.layerId}`);
        if (requiredGroupId !== undefined) return [];
        i = start;
        continue;
      }

      const moved = from.splice(start, i - start + 1).reverse();
      to.push(...moved);
      this.trimStacks();
      return moved;
    }
    return [];
  }

  /**
   * Scoped group undo: pops the latest undoable op (or contiguous `groupId` run) for `userId`
   * where every non-SELECTION item passes `checkPermission`, returning `[C, B, A]` in undo replay order.
   */
  public undoGroup(
    userId?: string,
    checkPermission?: (layerId: string, op: ScopedUndoOp, group: readonly ScopedUndoOp[]) => boolean,
    requiredGroupId?: string,
  ): ScopedUndoOp[] {
    return this.popGroup(this.undoStack, this.redoStack, 'ScopedUndo', userId, checkPermission, requiredGroupId);
  }

  /**
   * Scoped group redo: mirrors `undoGroup` from `redoStack` back onto `undoStack`,
   * returning `[A, B, C]` in original execution order.
   */
  public redoGroup(
    userId?: string,
    checkPermission?: (layerId: string, op?: ScopedUndoOp) => boolean
  ): ScopedUndoOp[] {
    return this.popGroup(this.redoStack, this.undoStack, 'ScopedRedo', userId, checkPermission);
  }

  /**
   * Rolls back a previously popped group step (`undoGroup`/`redoGroup`) when commit fails,
   * removing its ops from the destination stack and restoring them to the source stack.
   */
  public rollbackGroup(ops: ScopedUndoOp[], wasUndo: boolean): void {
    if (ops.length === 0) return;
    const movedTo = wasUndo ? this.redoStack : this.undoStack;
    const from = wasUndo ? this.undoStack : this.redoStack;
    const targets = new Set(ops);
    let removed = false;
    for (let i = movedTo.length - 1; i >= 0; i--) {
      if (targets.has(movedTo[i])) {
        movedTo.splice(i, 1);
        removed = true;
      }
    }
    if (!removed) return;
    from.push(...[...ops].reverse());
  }

  /** My undo / redo steps that restore this tile: another painter's edit arriving now is marked on them */
  public opsTouchingTile(layerId: string, col: number, row: number): ScopedUndoOp[] {
    return [...this.undoStack, ...this.redoStack].filter(
      (op) => op.layerId === layerId && op.beforeTiles.some((t) => t.col === col && t.row === row)
    );
  }

  /** P2P can deliver a tile before the server assigns its sequence. Both deliveries name the edit. */
  public foreignEdit(id: string, seq: number): ForeignEdit {
    let edit = this.foreignEdits.get(id);
    if (!edit) {
      edit = { seq, active: true };
      this.foreignEdits.set(id, edit);
      if (this.foreignEdits.size > 500) this.foreignEdits.delete(this.foreignEdits.keys().next().value!);
    } else if (seq > 0) {
      edit.seq = seq;
    }
    return edit;
  }

  public recordForeignTile(ops: ScopedUndoOp[], key: string, tile: ForeignTileEdit) {
    for (const op of ops) {
      const tiles = this.foreignTiles.get(op) ?? new Map<string, ForeignTileEdit[]>();
      if (!this.foreignTiles.has(op)) this.foreignTiles.set(op, tiles);
      const entries = tiles.get(key) ?? [];
      entries.push(tile);
      tiles.set(key, entries);
    }
  }

  public setForeignEditActive(layerId: string, sourceSeq: number, active: boolean) {
    for (const edit of this.foreignEdits.values()) if (edit.seq === sourceSeq) edit.active = active;
    for (const op of [...this.undoStack, ...this.redoStack]) {
      if (op.layerId !== layerId) continue;
      for (const edits of this.foreignTiles.get(op)?.values() ?? []) {
        for (const tile of edits) if (tile.edit.seq === sourceSeq) tile.edit.active = active;
      }
    }
  }

  /** A peer can redo a stroke that is currently undone, so its history still needs the base change. */
  public hasForeignTile(op: ScopedUndoOp, key: string) {
    return this.foreignTiles.get(op)?.has(key) ?? false;
  }

  public mergeForeignTile(op: ScopedUndoOp, key: string, target: Uint8Array, mine: Uint8Array, current: Uint8Array) {
    const legacy = op.foreign?.get(key);
    const entries = this.foreignTiles.get(op)?.get(key)?.filter(tile => tile.edit.active) ?? [];
    if (!entries.length) return mergeUndoPixels(target, mine, current, legacy);
    const pixels = current.slice();
    const out = viewOf(pixels);
    const from = viewOf(mine);
    const to = viewOf(target);
    const newer = entries.sort((a, b) => (a.edit.seq || Infinity) - (b.edit.seq || Infinity)).map(({ changed, ink }) => ({
      changed,
      source: ink && viewOfTile(ink.source),
      before: ink && viewOfTile(ink.before),
      after: ink && viewOfTile(ink.after),
    }));
    let conflicts = 0;
    for (let i = 0; i < out.byteLength; i += 4) {
      const owned = from.getUint32(i);
      const restored = to.getUint32(i);
      if (owned === restored) continue;
      let value = restored;
      let protectedByInk = false;
      let blocked = Boolean(legacy?.[i >> 2]);
      for (const { changed, source, before, after } of newer) {
        if (source?.getUint8(i + 3)) {
          value = value === before!.getUint32(i) ? after!.getUint32(i) : paintOver(source, i, value);
          protectedByInk = true;
        } else if (changed[i >> 2]) {
          blocked = true;
        }
      }
      if (!blocked && (protectedByInk || out.getUint32(i) === owned)) out.setUint32(i, value);
      if (blocked || protectedByInk || out.getUint32(i) !== restored) conflicts++;
    }
    return { pixels, conflicts };
  }

  /** A peer undid pixels underneath a newer local edit. Restore the revised pixels when mine is undone. */
  public rebaseBeforeTiles(layerId: string, sourceSeq: number, changeSeq: number, from: TileData, to: TileData) {
    const ops = this.opsTouchingTile(layerId, from.col, from.row).filter(
      op => op.baseSeq !== undefined && op.baseSeq >= sourceSeq && op.baseSeq < changeSeq,
    );
    if (!ops.length) return;
    if (from.width !== to.width || from.height !== to.height || from.col !== to.col || from.row !== to.row) return;
    const length = from.width * from.height * 4;
    const oldBase = viewOfTile(from);
    const newBase = viewOfTile(to);
    if (oldBase.byteLength !== length || newBase.byteLength !== length) return;

    for (const op of ops) {
      const index = op.beforeTiles.findIndex(t => t.col === from.col && t.row === from.row);
      const tile = op.beforeTiles[index];
      const afterIndex = op.afterTiles.findIndex(t => t.col === from.col && t.row === from.row);
      const after = op.afterTiles[afterIndex];
      if (!after || tile.width !== from.width || tile.height !== from.height ||
        after.width !== from.width || after.height !== from.height) continue;
      const before = tileToRgba(tile).slice();
      const painted = tileToRgba(after);
      if (before.length !== length || painted.length !== length) continue;
      const key = `${from.col}_${from.row}`;
      const inkTile = op.inkTiles?.find(t => t.col === from.col && t.row === from.row);
      const ink = inkTile && viewOfTile(inkTile);
      const original = this.originalTiles.get(op)?.get(key) ?? { before: tile, after };
      const beforeView = viewOf(before);
      const afterView = viewOf(op.inkTiles ? painted.slice() : painted);
      const originalBase = ink && viewOfTile(original.before);
      const originalPaint = ink && viewOfTile(original.after);
      let changed = false;
      let paintedChanged = false;
      for (let i = 0; i < length; i += 4) {
        const was = oldBase.getUint32(i);
        const replace = newBase.getUint32(i);
        if (was === replace || beforeView.getUint32(i) !== was) continue;
        const priorPaint = afterView.getUint32(i);
        if (!op.inkTiles && priorPaint === was) continue;
        beforeView.setUint32(i, replace);
        let nextPaint = priorPaint;
        if (ink?.getUint8(i + 3)) {
          nextPaint = replace === originalBase!.getUint32(i) ? originalPaint!.getUint32(i) : paintOver(ink, i, replace);
        } else if (priorPaint === was) {
          nextPaint = replace;
        }
        if (nextPaint !== priorPaint) {
          afterView.setUint32(i, nextPaint);
          paintedChanged = true;
        }
        changed = true;
      }
      if (changed) {
        if (ink) {
          const originals = this.originalTiles.get(op) ?? new Map<string, { before: TileData; after: TileData }>();
          originals.set(key, original);
          this.originalTiles.set(op, originals);
        }
        const { compression, data } = compressTileBuffer(before, 'lz4');
        op.beforeTiles[index] = { ...tile, compression, data, byteLength: data.byteLength };
      }
      if (paintedChanged) {
        const { compression, data } = compressTileBuffer(new Uint8Array(afterView.buffer, afterView.byteOffset, length), 'lz4');
        op.afterTiles[afterIndex] = { ...after, compression, data, byteLength: data.byteLength };
      }
    }
  }

  public clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.foreignEdits.clear();
  }

  /** Test hook: the stacks as they are (oldest first) */
  public inspect() {
    return { undo: [...this.undoStack], redo: [...this.redoStack] };
  }

  public getUndoCount(userId?: string): number {
    return this.countLogicalSteps(this.undoStack, userId);
  }

  public getRedoCount(userId?: string): number {
    return this.countLogicalSteps(this.redoStack, userId);
  }
}
