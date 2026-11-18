import type { FolderAccessRequest, LayerModel } from '@atelier/shared';
import { sqlite } from '../db/index';

export function canAddToFolder(folder: LayerModel, userId: string) {
  if (folder.isLocked) return false;
  return folder.ownerId === userId || Boolean(sqlite.prepare(`
    SELECT 1 FROM folder_access WHERE folder_id = ? AND requester_id = ? AND owner_id = ? AND status = 'approved'
  `).get(folder.id, userId, folder.ownerId));
}

export function listFolderAccess(canvasId: string, userId: string): FolderAccessRequest[] {
  return sqlite.prepare(`
    SELECT a.folder_id AS folderId, a.requester_id AS requesterId, u.display_name AS requesterName,
      a.owner_id AS ownerId, a.status
    FROM folder_access a
    JOIN layers l ON l.id = a.folder_id AND l.owner_id = a.owner_id
    JOIN users u ON u.id = a.requester_id
    WHERE l.canvas_id = ? AND (a.owner_id = ? OR a.requester_id = ?)
    ORDER BY l.sort_order, u.display_name
  `).all(canvasId, userId, userId) as FolderAccessRequest[];
}

export function requestFolderAccess(folderId: string, requesterId: string, ownerId: string) {
  sqlite.prepare(`
    INSERT INTO folder_access (folder_id, requester_id, owner_id, status) VALUES (?, ?, ?, 'pending')
    ON CONFLICT(folder_id, requester_id) DO UPDATE SET owner_id = excluded.owner_id, status = 'pending'
    WHERE folder_access.owner_id <> excluded.owner_id
  `).run(folderId, requesterId, ownerId);
}

export function resolveFolderAccess(folderId: string, requesterId: string, ownerId: string, approved: boolean) {
  return sqlite.prepare(approved
    ? "UPDATE folder_access SET status = 'approved' WHERE folder_id = ? AND requester_id = ? AND owner_id = ? AND status = 'pending'"
    : 'DELETE FROM folder_access WHERE folder_id = ? AND requester_id = ? AND owner_id = ?'
  ).run(folderId, requesterId, ownerId).changes > 0;
}
