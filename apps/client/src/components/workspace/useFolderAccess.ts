import { useEffect, useRef, useState } from 'react';
import type { FolderAccessRequest, LayerModel } from '@atelier/shared';
import { ApiService } from '../../services/api';
import { OfflineSessionStore } from '../../services/offlineStore';

export function useFolderAccess(canvasId: string | null, userId: string | undefined, enabled: boolean) {
  const scope = enabled && canvasId && userId && !OfflineSessionStore.isOfflineCanvas(canvasId)
    ? `${ApiService.getServerOrigin()}|${canvasId}|${userId}` : null;
  const [result, setResult] = useState<{ scope: string; requests: FolderAccessRequest[] }>();
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const sequence = useRef(0);
  const updating = useRef(false);
  useEffect(() => {
    if (!scope || !canvasId) return;
    const refresh = async () => {
      if (updating.current || document.hidden) return;
      const id = ++sequence.current;
      try {
        const data = await ApiService.listFolderAccess(canvasId);
        if (scopeRef.current === scope && id === sequence.current) setResult({ scope, requests: data.requests });
      } catch {
        // The next refresh will retry when the canvas is available.
      }
    };
    void refresh();
    window.addEventListener('focus', refresh);
    const interval = window.setInterval(refresh, 4000);
    return () => {
      sequence.current++;
      window.removeEventListener('focus', refresh);
      window.clearInterval(interval);
    };
  }, [scope, canvasId]);

  const requests = scope && result?.scope === scope ? result.requests : [];
  const canAdd = (folder: LayerModel) => Boolean(userId && !folder.isLocked && (
    folder.ownerId === userId || requests.some((request) => request.folderId === folder.id &&
      request.requesterId === userId && request.ownerId === folder.ownerId && request.status === 'approved')
  ));

  const update = async (folderId: string, decision?: { requesterId: string; approved: boolean }) => {
    if (!scope || !canvasId || updating.current) return;
    updating.current = true;
    sequence.current++;
    try {
      const data = decision
        ? await ApiService.resolveFolderAccess(canvasId, folderId, decision.requesterId, decision.approved)
        : await ApiService.requestFolderAccess(canvasId, folderId);
      if (scopeRef.current === scope) setResult({ scope, requests: data.requests });
    } finally {
      updating.current = false;
    }
  };

  return { requests, canAdd, update, enabled: Boolean(scope) };
}

export type FolderAccess = ReturnType<typeof useFolderAccess>;
