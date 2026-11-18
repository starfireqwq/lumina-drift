import React, { useState } from 'react';
import type { LayerModel } from '@atelier/shared';
import { useI18n } from '../context/I18nContext';
import type { FolderAccess } from './workspace/useFolderAccess';

export const FolderAccessPanel: React.FC<{
  access: FolderAccess;
  layers: LayerModel[];
  active: LayerModel | null;
  userId?: string;
}> = ({ access, layers, active, userId }) => {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!access.enabled || !userId) return null;
  const foreign = active?.layerType === 'group' && active.ownerId && active.ownerId !== userId ? active : null;
  const outgoing = access.requests.find((request) => request.folderId === foreign?.id && request.requesterId === userId);
  const incoming = access.requests.filter((request) => request.ownerId === userId);
  if (!foreign && !incoming.length) return null;
  const update = async (...args: Parameters<FolderAccess['update']>) => {
    setFailed(false);
    setBusy(true);
    try { await access.update(...args); } catch { setFailed(true); } finally { setBusy(false); }
  };
  return (
    <div className="shrink-0 grid gap-1 border-b border-atelier-border px-2 py-1.5 text-[11px]">
      {foreign && (outgoing
        ? <span role="status" className="text-neutral-400">{outgoing.status === 'approved' ? t.layers.folderAccessGranted : t.layers.folderRequestPending}</span>
        : <button className="atelier-btn justify-self-start" type="button" disabled={busy} onClick={() => void update(foreign.id)}>{t.layers.requestFolderAccess}</button>)}
      {incoming.length > 0 && (
        <details open={incoming.some((request) => request.status === 'pending')}>
          <summary className="cursor-pointer">{t.layers.folderAccessRequests} ({incoming.filter((request) => request.status === 'pending').length})</summary>
          {incoming.map((request) => (
            <div key={`${request.folderId}:${request.requesterId}`} className="flex flex-wrap items-center gap-1 py-0.5">
              <span className="min-w-0 flex-1 truncate">{layers.find((layer) => layer.id === request.folderId)?.name} · {request.requesterName}</span>
              {request.status === 'pending' && <button type="button" className="atelier-btn" disabled={busy}
                onClick={() => void update(request.folderId, { requesterId: request.requesterId, approved: true })}>{t.layers.approveFolderAccess}</button>}
              <button type="button" className="atelier-btn" disabled={busy}
                onClick={() => void update(request.folderId, { requesterId: request.requesterId, approved: false })}>
                {request.status === 'pending' ? t.layers.declineFolderAccess : t.layers.revokeFolderAccess}
              </button>
            </div>
          ))}
        </details>
      )}
      {failed && <span role="alert" className="text-rose-300">{t.layers.folderAccessFailed}</span>}
    </div>
  );
};
