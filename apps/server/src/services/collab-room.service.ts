import type { Statement } from 'better-sqlite3';
import {
  CanvasGridConfig,
  createDefaultGridConfig,
  createDefaultReferenceBoard,
  normalizeGridConfig,
  normalizeReferenceBoard,
  normalizeRoomSwatches,
  RoomReferenceBoardState,
  RoomSwatch,
} from '@atelier/shared';
import { sqlite } from '../db';

export interface PersistedCollabState {
  grid: CanvasGridConfig;
  swatches: RoomSwatch[];
  referenceBoard: RoomReferenceBoardState;
}

const statements = new Map<string, Statement>();
const stmt = (sql: string) => {
  let s = statements.get(sql);
  if (!s) {
    s = sqlite.prepare(sql);
    statements.set(sql, s);
  }
  return s;
};

function safeParseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function getCanvasCollabState(canvasId: string): PersistedCollabState {
  const row = stmt(
    'SELECT grid_json AS gridJson, swatches_json AS swatchesJson, ref_board_json AS refBoardJson FROM canvas_collab_state WHERE canvas_id = ?'
  ).get(canvasId) as { gridJson: string | null; swatchesJson: string | null; refBoardJson: string | null } | undefined;

  if (!row) {
    return {
      grid: createDefaultGridConfig(),
      swatches: [],
      referenceBoard: createDefaultReferenceBoard(),
    };
  }

  return {
    grid: normalizeGridConfig(safeParseJson<Partial<CanvasGridConfig>>(row.gridJson)),
    swatches: normalizeRoomSwatches(safeParseJson<unknown>(row.swatchesJson)),
    referenceBoard: normalizeReferenceBoard(safeParseJson<unknown>(row.refBoardJson)),
  };
}

function upsertCollabRow(
  canvasId: string,
  fields: { gridJson?: string; swatchesJson?: string; refBoardJson?: string },
  now = Date.now()
): void {
  const existing = stmt(
    'SELECT grid_json AS gridJson, swatches_json AS swatchesJson, ref_board_json AS refBoardJson FROM canvas_collab_state WHERE canvas_id = ?'
  ).get(canvasId) as { gridJson: string | null; swatchesJson: string | null; refBoardJson: string | null } | undefined;

  const gridJson = fields.gridJson !== undefined ? fields.gridJson : existing?.gridJson ?? null;
  const swatchesJson = fields.swatchesJson !== undefined ? fields.swatchesJson : existing?.swatchesJson ?? null;
  const refBoardJson = fields.refBoardJson !== undefined ? fields.refBoardJson : existing?.refBoardJson ?? null;

  stmt(`
    INSERT INTO canvas_collab_state (canvas_id, grid_json, swatches_json, ref_board_json, updated_at)
    VALUES (@canvasId, @gridJson, @swatchesJson, @refBoardJson, @updatedAt)
    ON CONFLICT (canvas_id) DO UPDATE SET
      grid_json = excluded.grid_json,
      swatches_json = excluded.swatches_json,
      ref_board_json = excluded.ref_board_json,
      updated_at = excluded.updated_at
  `).run({ canvasId, gridJson, swatchesJson, refBoardJson, updatedAt: now });
}

export function saveCanvasGridConfig(canvasId: string, grid: CanvasGridConfig): CanvasGridConfig {
  const normalized = normalizeGridConfig(grid);
  upsertCollabRow(canvasId, { gridJson: JSON.stringify(normalized) }, normalized.updatedAt);
  return normalized;
}

export function saveCanvasRoomSwatches(canvasId: string, swatches: RoomSwatch[]): RoomSwatch[] {
  const normalized = normalizeRoomSwatches(swatches);
  upsertCollabRow(canvasId, { swatchesJson: JSON.stringify(normalized) });
  return normalized;
}

export function saveCanvasReferenceBoard(
  canvasId: string,
  board: RoomReferenceBoardState
): RoomReferenceBoardState {
  const normalized = normalizeReferenceBoard(board);
  upsertCollabRow(canvasId, { refBoardJson: JSON.stringify(normalized) }, normalized.updatedAt);
  return normalized;
}

export function deleteCanvasCollabState(canvasId: string): void {
  stmt('DELETE FROM canvas_collab_state WHERE canvas_id = ?').run(canvasId);
}
