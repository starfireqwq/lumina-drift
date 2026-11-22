import type { Statement } from 'better-sqlite3';
import { CanvasRole, DRAW_OP_TYPES, OfflineMemberInfo, ServerRole } from '@atelier/shared';
import { sqlite } from '../db';

// Prepared on first use: this module loads before initDatabase() adds the columns
const statements = new Map<string, Statement>();
const stmt = (sql: string) => {
  let s = statements.get(sql);
  if (!s) statements.set(sql, (s = sqlite.prepare(sql)));
  return s;
};

export function loadStrokeTotals(): Array<{ canvasId: string; userId: string; count: number }> {
  const types = DRAW_OP_TYPES.map(() => '?').join(', ');
  return stmt(`SELECT canvas_id AS canvasId, user_id AS userId, COUNT(*) AS count
               FROM canvas_ops WHERE UPPER(op_type) IN (${types})
               GROUP BY canvas_id, user_id`).all(...DRAW_OP_TYPES) as ReturnType<typeof loadStrokeTotals>;
}

/** Stored drawing time, including visits in rooms that do not require membership */
export function getMemberDrawTime(canvasId: string, userId: string): number | null {
  const row = stmt(`SELECT MAX(ms) AS ms FROM (
    SELECT draw_time_ms AS ms FROM canvas_members WHERE canvas_id = @canvasId AND user_id = @userId
    UNION ALL
    SELECT draw_time_ms AS ms FROM canvas_visits WHERE canvas_id = @canvasId AND user_id = @userId
  )`).get({ canvasId, userId }) as { ms: number | null };
  return row.ms;
}

export function addMemberDrawTime(canvasId: string, userId: string, ms: number): void {
  sqlite.transaction(() => {
    stmt('UPDATE canvas_members SET draw_time_ms = draw_time_ms + ? WHERE canvas_id = ? AND user_id = ?')
      .run(Math.round(ms), canvasId, userId);
    stmt('UPDATE canvas_visits SET draw_time_ms = draw_time_ms + ? WHERE canvas_id = ? AND user_id = ?')
      .run(Math.round(ms), canvasId, userId);
  })();
}

export function touchMembersLastSeen(canvasId: string, userIds: Iterable<string>, at = Date.now()): void {
  const member = stmt('UPDATE canvas_members SET last_seen_at = ? WHERE canvas_id = ? AND user_id = ?');
  const visit = stmt(`INSERT INTO canvas_visits (last_seen_at, canvas_id, user_id, draw_time_ms)
    VALUES (@at, @canvasId, @userId, COALESCE(
      (SELECT draw_time_ms FROM canvas_members WHERE canvas_id = @canvasId AND user_id = @userId), 0))
    ON CONFLICT (canvas_id, user_id) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`);
  sqlite.transaction(() => {
    for (const userId of userIds) {
      member.run(at, canvasId, userId);
      visit.run({ at, canvasId, userId });
    }
  })();
}

/** Explicit members, plus registered visitors where anyone can join */
export function listCanvasRoster(canvasId: string, includeVisitors: boolean): OfflineMemberInfo[] {
  const rows = stmt(
    `WITH roster AS (
       SELECT user_id FROM canvas_members WHERE canvas_id = @canvasId
       UNION
       SELECT user_id FROM canvas_visits WHERE canvas_id = @canvasId AND @includeVisitors
     )
     SELECT r.user_id AS userId, u.display_name AS displayName, u.server_role AS serverRole, m.role AS role,
            NULLIF(MAX(COALESCE(m.last_seen_at, 0), COALESCE(v.last_seen_at, 0)), 0) AS lastSeenAt,
            MAX(COALESCE(m.draw_time_ms, 0), COALESCE(v.draw_time_ms, 0)) AS drawTimeMs
     FROM roster r JOIN users u ON u.id = r.user_id
     LEFT JOIN canvas_members m ON m.canvas_id = @canvasId AND m.user_id = r.user_id
     LEFT JOIN canvas_visits v ON v.canvas_id = @canvasId AND v.user_id = r.user_id
     WHERE u.is_active = 1 AND u.server_role <> 'guest'
     ORDER BY lastSeenAt IS NULL, lastSeenAt DESC`
  ).all({ canvasId, includeVisitors: Number(includeVisitors) }) as Array<{ userId: string; displayName: string; serverRole: ServerRole; role: CanvasRole | null; lastSeenAt: number | null; drawTimeMs: number }>;
  return rows.map((r) => ({
    userId: r.userId,
    displayName: r.displayName,
    serverRole: r.serverRole,
    canvasRole: r.role ?? undefined,
    lastSeenAt: r.lastSeenAt,
    drawTimeMs: r.drawTimeMs,
  }));
}
