import Database, { Database as DatabaseType } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { DRAW_OP_TYPES, DRAW_TIME_MAX_GAP_MS } from '@atelier/shared';
import * as schema from './schema';
import { config } from '../config';

// Initialize better-sqlite3 database
export const sqlite: DatabaseType = new Database(config.dbPath);

// Enable WAL mode for high concurrency read/write and foreign keys
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('synchronous = NORMAL');

// Drizzle ORM instance
export const db = drizzle(sqlite, { schema });

/**
 * Ensures all tables and indexes are initialized automatically on boot
 */
export function initDatabase() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_url    TEXT,
      server_role   TEXT NOT NULL DEFAULT 'member',
      is_active     INTEGER NOT NULL DEFAULT 1,
      guest_removed_at INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS canvas_groups (
      id             TEXT PRIMARY KEY,
      owner_id       TEXT NOT NULL REFERENCES users(id),
      title          TEXT NOT NULL,
      room_pass_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS canvas_group_members (
      group_id TEXT NOT NULL REFERENCES canvas_groups(id) ON DELETE CASCADE,
      user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS canvases (
      id              TEXT PRIMARY KEY,
      owner_id        TEXT NOT NULL REFERENCES users(id),
      title           TEXT NOT NULL,
      width           INTEGER NOT NULL DEFAULT 2048,
      height          INTEGER NOT NULL DEFAULT 2048,
      dpi             INTEGER NOT NULL DEFAULT 300,
      bg_color        TEXT NOT NULL DEFAULT '#FFFFFF',
      access_mode     TEXT NOT NULL DEFAULT 'invite',
      invite_code     TEXT UNIQUE,
      room_pass_hash  TEXT,
      group_id        TEXT REFERENCES canvas_groups(id),
      latest_seq      INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS canvas_members (
      canvas_id               TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
      user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role                    TEXT NOT NULL DEFAULT 'editor',
      can_create_layer        INTEGER NOT NULL DEFAULT 1,
      can_delete_other_layer  INTEGER NOT NULL DEFAULT 0,
      can_export              INTEGER NOT NULL DEFAULT 1,
      can_manage_members      INTEGER NOT NULL DEFAULT 0,
      joined_at               INTEGER NOT NULL,
      PRIMARY KEY (canvas_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS layers (
      id               TEXT PRIMARY KEY,
      canvas_id        TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
      parent_id        TEXT REFERENCES layers(id) ON DELETE SET NULL,
      owner_id         TEXT REFERENCES users(id),
      name             TEXT NOT NULL,
      layer_type       TEXT NOT NULL DEFAULT 'raster',
      blend_mode       TEXT NOT NULL DEFAULT 'normal',
      opacity          REAL NOT NULL DEFAULT 1.0,
      is_visible       INTEGER NOT NULL DEFAULT 1,
      is_locked        INTEGER NOT NULL DEFAULT 0,
      alpha_locked     INTEGER NOT NULL DEFAULT 0,
      clip_to_below    INTEGER NOT NULL DEFAULT 0,
      sort_order       INTEGER NOT NULL,
      acl_mode         TEXT NOT NULL DEFAULT 'owner_only',
      is_public        INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_layers_canvas_order ON layers(canvas_id, sort_order);

    CREATE TABLE IF NOT EXISTS layer_permissions (
      layer_id          TEXT NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
      user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      can_draw          INTEGER NOT NULL DEFAULT 1,
      can_erase         INTEGER NOT NULL DEFAULT 1,
      can_filter        INTEGER NOT NULL DEFAULT 1,
      can_modify_props  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (layer_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS canvas_snapshots (
      id            TEXT PRIMARY KEY,
      canvas_id     TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
      seq           INTEGER NOT NULL,
      storage_path  TEXT NOT NULL,
      byte_size     INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_canvas_seq ON canvas_snapshots(canvas_id, seq DESC);

    CREATE TABLE IF NOT EXISTS canvas_ops (
      canvas_id     TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
      seq           INTEGER NOT NULL,
      user_id       TEXT NOT NULL REFERENCES users(id),
      layer_id      TEXT,
      op_type       TEXT NOT NULL,
      payload_blob  BLOB NOT NULL,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (canvas_id, seq)
    );
  `);

  const userColumns = sqlite.pragma('table_info(users)') as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === 'guest_removed_at')) {
    sqlite.exec('ALTER TABLE users ADD COLUMN guest_removed_at INTEGER;');
  }

  const canvasColumns = sqlite.pragma('table_info(canvases)') as Array<{ name: string }>;
  if (!canvasColumns.some(({ name }) => name === 'group_id')) {
    sqlite.exec('ALTER TABLE canvases ADD COLUMN group_id TEXT REFERENCES canvas_groups(id);');
  }

  try {
    const tableInfo = sqlite.pragma('table_info(layers)') as Array<{ name: string; notnull?: number }>;
    if (!tableInfo.some((c) => c.name === 'is_public')) {
      sqlite.exec('ALTER TABLE layers ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;');
    }
    if (!tableInfo.some((c) => c.name === 'screentone_enabled')) {
      sqlite.exec('ALTER TABLE layers ADD COLUMN screentone_enabled INTEGER NOT NULL DEFAULT 0;');
    }
    if (!tableInfo.some((c) => c.name === 'screentone_lpi')) {
      sqlite.exec('ALTER TABLE layers ADD COLUMN screentone_lpi INTEGER NOT NULL DEFAULT 40;');
    }
    if (!tableInfo.some((c) => c.name === 'screentone_angle')) {
      sqlite.exec('ALTER TABLE layers ADD COLUMN screentone_angle REAL NOT NULL DEFAULT 45;');
    }
    if (!tableInfo.some((c) => c.name === 'screentone_dot_scale')) {
      sqlite.exec('ALTER TABLE layers ADD COLUMN screentone_dot_scale REAL NOT NULL DEFAULT 1.0;');
    }

    // Ensure owner_id is nullable so released/public layers can set owner_id = null
    const ownerCol = tableInfo.find((c) => c.name === 'owner_id');
    if (ownerCol && ownerCol.notnull === 1) {
      sqlite.pragma('foreign_keys = OFF');
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS layers_migration (
          id                 TEXT PRIMARY KEY,
          canvas_id          TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
          parent_id          TEXT REFERENCES layers(id) ON DELETE SET NULL,
          owner_id           TEXT REFERENCES users(id),
          name               TEXT NOT NULL,
          layer_type         TEXT NOT NULL DEFAULT 'raster',
          blend_mode         TEXT NOT NULL DEFAULT 'normal',
          opacity            REAL NOT NULL DEFAULT 1.0,
          is_visible         INTEGER NOT NULL DEFAULT 1,
          is_locked          INTEGER NOT NULL DEFAULT 0,
          alpha_locked       INTEGER NOT NULL DEFAULT 0,
          clip_to_below      INTEGER NOT NULL DEFAULT 0,
          screentone_enabled INTEGER NOT NULL DEFAULT 0,
          screentone_lpi     INTEGER NOT NULL DEFAULT 40,
          screentone_angle   REAL NOT NULL DEFAULT 45,
          screentone_dot_scale REAL NOT NULL DEFAULT 1.0,
          sort_order         INTEGER NOT NULL,
          acl_mode           TEXT NOT NULL DEFAULT 'owner_only',
          is_public          INTEGER NOT NULL DEFAULT 0,
          created_at         INTEGER NOT NULL,
          updated_at         INTEGER NOT NULL
        );
        INSERT INTO layers_migration SELECT
          id, canvas_id, parent_id, owner_id, name, layer_type, blend_mode, opacity,
          is_visible, is_locked, alpha_locked, clip_to_below,
          COALESCE(screentone_enabled, 0), COALESCE(screentone_lpi, 40), COALESCE(screentone_angle, 45), COALESCE(screentone_dot_scale, 1.0),
          sort_order, acl_mode, COALESCE(is_public, 0), created_at, updated_at
        FROM layers;
        DROP TABLE layers;
        ALTER TABLE layers_migration RENAME TO layers;
        CREATE INDEX IF NOT EXISTS idx_layers_canvas_order ON layers(canvas_id, sort_order);
      `);
      sqlite.pragma('foreign_keys = ON');
    }
  } catch (err) {
    console.error('Migration error checking layers columns:', err);
  }

  // After the owner_id rebuild above, which copies a fixed column list
  try {
    const cols = sqlite.pragma('table_info(layers)') as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'meta')) sqlite.exec('ALTER TABLE layers ADD COLUMN meta TEXT;');
  } catch (err) {
    console.error('Migration error adding layers.meta:', err);
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS folder_access (
      folder_id TEXT NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
      requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved')),
      PRIMARY KEY (folder_id, requester_id)
    )
  `);

  // Member presence: when each member last left a canvas and how long they have drawn on it.
  // An upgraded database starts from its op log, with the same gap rule as live tracking.
  try {
    const cols = sqlite.pragma('table_info(canvas_members)') as Array<{ name: string }>;
    const addLastSeen = !cols.some((c) => c.name === 'last_seen_at');
    const addDrawTime = !cols.some((c) => c.name === 'draw_time_ms');
    if (addLastSeen || addDrawTime) {
      sqlite.transaction(() => {
        if (addLastSeen) {
          sqlite.exec('ALTER TABLE canvas_members ADD COLUMN last_seen_at INTEGER;');
          // At least as recent as their last op (or the day they joined)
          const lastOps = sqlite
            .prepare('SELECT canvas_id AS c, user_id AS u, MAX(created_at) AS at FROM canvas_ops GROUP BY canvas_id, user_id')
            .all() as Array<{ c: string; u: string; at: number }>;
          sqlite.exec('UPDATE canvas_members SET last_seen_at = joined_at;');
          const set = sqlite.prepare('UPDATE canvas_members SET last_seen_at = MAX(joined_at, ?) WHERE canvas_id = ? AND user_id = ?');
          for (const r of lastOps) set.run(r.at, r.c, r.u);
        }
        if (addDrawTime) {
          sqlite.exec('ALTER TABLE canvas_members ADD COLUMN draw_time_ms INTEGER NOT NULL DEFAULT 0;');
          const types = DRAW_OP_TYPES.map(() => '?').join(', ');
          const totals = sqlite
            .prepare(
              `SELECT c, u, SUM(CASE WHEN gap > 0 AND gap <= ? THEN gap ELSE 0 END) AS ms FROM (
                 SELECT canvas_id AS c, user_id AS u,
                        created_at - LAG(created_at) OVER (PARTITION BY canvas_id, user_id ORDER BY seq) AS gap
                 FROM canvas_ops WHERE UPPER(op_type) IN (${types})
               ) GROUP BY c, u`
            )
            .all(DRAW_TIME_MAX_GAP_MS, ...DRAW_OP_TYPES) as Array<{ c: string; u: string; ms: number }>;
          const set = sqlite.prepare('UPDATE canvas_members SET draw_time_ms = ? WHERE canvas_id = ? AND user_id = ?');
          for (const r of totals) if (r.ms > 0) set.run(r.ms, r.c, r.u);
        }
      })();
    }
  } catch (err) {
    console.error('Migration error adding canvas_members presence columns:', err);
  }

  // Room attendance belongs outside the access-control list. Older public rooms
  // can recover registered collaborators from the operation history.
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canvas_visits'").get()) {
    sqlite.transaction(() => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS canvas_visits (
          canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          last_seen_at INTEGER NOT NULL,
          draw_time_ms INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (canvas_id, user_id)
        )
      `);
      const types = DRAW_OP_TYPES.map(() => '?').join(', ');
      sqlite.prepare(`
        WITH gaps AS (
          SELECT canvas_id, user_id,
                 created_at - LAG(created_at) OVER (PARTITION BY canvas_id, user_id ORDER BY seq) AS gap
          FROM canvas_ops WHERE UPPER(op_type) IN (${types})
        ), drawing AS (
          SELECT canvas_id, user_id,
                 SUM(CASE WHEN gap > 0 AND gap <= ? THEN gap ELSE 0 END) AS draw_time_ms
          FROM gaps GROUP BY canvas_id, user_id
        )
        INSERT OR IGNORE INTO canvas_visits (canvas_id, user_id, last_seen_at, draw_time_ms)
        SELECT o.canvas_id, o.user_id, MAX(o.created_at),
               COALESCE(m.draw_time_ms, d.draw_time_ms, 0)
        FROM canvas_ops o JOIN users u ON u.id = o.user_id
        LEFT JOIN canvas_members m ON m.canvas_id = o.canvas_id AND m.user_id = o.user_id
        LEFT JOIN drawing d ON d.canvas_id = o.canvas_id AND d.user_id = o.user_id
        WHERE u.server_role <> 'guest' AND u.is_active = 1
        GROUP BY o.canvas_id, o.user_id
      `).run(...DRAW_OP_TYPES, DRAW_TIME_MAX_GAP_MS);
    })();
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canvas_collab_state (
      canvas_id      TEXT PRIMARY KEY REFERENCES canvases(id) ON DELETE CASCADE,
      grid_json      TEXT,
      swatches_json  TEXT,
      ref_board_json TEXT,
      updated_at     INTEGER NOT NULL
    );
  `);
}
