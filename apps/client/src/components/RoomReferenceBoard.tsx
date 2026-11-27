import React, { useRef, useState } from 'react';
import {
  canEditRoomCollab,
  canManageRoomCollab,
  RoomReferenceItem,
} from '@atelier/shared';
import { ImagePlus, Lock, Move, Pipette, Trash2, Unlock, ZoomIn, ZoomOut } from 'lucide-react';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../context/I18nContext';
import { OfflineSessionStore } from '../services/offlineStore';
import { encodeReferenceFileToDataUrl } from '../utils/collabLocalStore';

interface RoomReferenceBoardProps {
  onPickColor: (hex: string) => void;
  canvasOwnerId?: string;
}

function sampleImageColorAtClick(imgEl: HTMLImageElement, clientX: number, clientY: number): string | null {
  const rect = imgEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || imgEl.naturalWidth <= 0 || imgEl.naturalHeight <= 0) return null;
  const rx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const ry = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  const px = Math.min(imgEl.naturalWidth - 1, Math.floor(rx * imgEl.naturalWidth));
  const py = Math.min(imgEl.naturalHeight - 1, Math.floor(ry * imgEl.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(imgEl, px, py, 1, 1, 0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    if (a === 0) return null;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  } catch {
    return null;
  }
}

export const RoomReferenceBoard: React.FC<RoomReferenceBoardProps> = ({ onPickColor, canvasOwnerId }) => {
  const { t } = useI18n();
  const { user, isGuest } = useAuth();
  const {
    activeCanvasId,
    members,
    roomReferenceBoard,
    addRoomRefItem,
    updateRoomRefItem,
    removeRoomRefItem,
    setRoomRefBoardLocked,
  } = useSocket();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pickedHex, setPickedHex] = useState<string | null>(null);
  const [draggingPos, setDraggingPos] = useState<{ id: string; x: number; y: number } | null>(null);

  const isOffline = !activeCanvasId || OfflineSessionStore.isOfflineCanvas(activeCanvasId);
  const selfMember = user ? members.find((m) => m.userId === user.id) : undefined;
  const actorRole = isOffline
    ? { isCanvasOwner: true, canvasRole: 'owner', isGuest: false }
    : {
        serverRole: user?.serverRole,
        canvasRole: selfMember?.canvasRole ?? (canvasOwnerId && user?.id === canvasOwnerId ? 'owner' : undefined),
        isCanvasOwner: Boolean(canvasOwnerId && user?.id === canvasOwnerId),
        isGuest,
      };
  const canManage = canManageRoomCollab(actorRole);
  const canEditBase = canEditRoomCollab(actorRole);
  const canEditBoard = canEditBase && (!roomReferenceBoard.lockedByAdmin || canManage);

  const handleUploadFiles = async (files: FileList | null) => {
    if (!files || !files.length || !canEditBoard) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const encoded = await encodeReferenceFileToDataUrl(file);
        const fitRatio = Math.min(1, 200 / Math.max(encoded.width, encoded.height));
        addRoomRefItem({
          title: file.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'Reference',
          imageDataUrl: encoded.dataUrl,
          width: Math.max(80, Math.round(encoded.width * fitRatio)),
          height: Math.max(80, Math.round(encoded.height * fitRatio)),
          scale: 1,
        });
      } catch {
        // Ignore unreadable image files
      }
    }
  };

  const startDragItem = (e: React.PointerEvent, item: RoomReferenceItem) => {
    if (!canEditBoard || (item.locked && !canManage)) return;
    e.preventDefault();
    e.stopPropagation();
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const origX = item.x;
    const origY = item.y;
    let lastEmitAt = 0;

    const onMove = (ev: PointerEvent) => {
      const nextX = Math.round(origX + (ev.clientX - startClientX));
      const nextY = Math.round(origY + (ev.clientY - startClientY));
      setDraggingPos({ id: item.id, x: nextX, y: nextY });
      const now = Date.now();
      if (now - lastEmitAt >= 90) {
        lastEmitAt = now;
        updateRoomRefItem(item.id, { x: nextX, y: nextY });
      }
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const finalX = Math.round(origX + (ev.clientX - startClientX));
      const finalY = Math.round(origY + (ev.clientY - startClientY));
      setDraggingPos(null);
      updateRoomRefItem(item.id, { x: finalX, y: finalY });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const nudgeScale = (item: RoomReferenceItem, factor: number) => {
    if (!canEditBoard || (item.locked && !canManage)) return;
    const nextScale = Number(Math.max(0.25, Math.min(4, item.scale * factor)).toFixed(2));
    updateRoomRefItem(item.id, { scale: nextScale });
  };

  return (
    <div data-testid="room-ref-board" className="flex min-h-0 flex-1 flex-col gap-1.5">
      {/* Toolbar */}
      <div className="flex min-w-0 shrink-0 items-center gap-1">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          data-testid="room-ref-file-input"
          hidden
          onChange={(e) => {
            void handleUploadFiles(e.currentTarget.files);
            e.currentTarget.value = '';
          }}
        />
        <button
          type="button"
          data-testid="room-ref-add-btn"
          disabled={!canEditBoard}
          onClick={() => fileInputRef.current?.click()}
          title={t.collab.refBoardAdd}
          className="atelier-icon-btn h-7 gap-1 px-2 text-[11px] disabled:opacity-40"
        >
          <ImagePlus className="h-3.5 w-3.5" />
          <span className="truncate">{t.collab.refBoardAdd}</span>
        </button>

        {canManage && !isOffline && (
          <button
            type="button"
            data-testid="room-ref-lock-toggle"
            aria-pressed={roomReferenceBoard.lockedByAdmin}
            onClick={() => setRoomRefBoardLocked(!roomReferenceBoard.lockedByAdmin)}
            title={roomReferenceBoard.lockedByAdmin ? t.collab.refBoardUnlock : t.collab.refBoardLock}
            className={`atelier-icon-btn ml-auto h-7 w-7 ${
              roomReferenceBoard.lockedByAdmin ? 'border-amber-600/80 bg-amber-950/70 text-amber-300' : ''
            }`}
          >
            {roomReferenceBoard.lockedByAdmin ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {roomReferenceBoard.lockedByAdmin && (
        <div
          data-testid="room-ref-locked-badge"
          className="flex items-center gap-1 rounded border border-amber-700/60 bg-amber-950/50 px-2 py-0.5 text-[10px] text-amber-200"
        >
          <Lock className="h-3 w-3 shrink-0" />
          <span className="truncate">{t.collab.refBoardLockedBadge}</span>
        </div>
      )}

      {/* Board Surface */}
      <div
        className="relative min-h-36 min-w-0 flex-1 overflow-auto rounded-md border border-neutral-800 bg-neutral-950/90"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px)',
          backgroundSize: '16px 16px',
        }}
      >
        {roomReferenceBoard.items.length === 0 ? (
          <div className="pointer-events-none flex h-full min-h-32 flex-col items-center justify-center gap-1 p-3 text-center">
            <p className="text-xs font-medium text-neutral-300">{t.collab.refBoardEmpty}</p>
            <p className="text-[11px] text-neutral-400">{t.collab.refBoardEmptyHint}</p>
          </div>
        ) : (
          <div className="relative min-h-[260px] min-w-[260px]">
            {roomReferenceBoard.items.map((item) => {
              const posX = draggingPos?.id === item.id ? draggingPos.x : item.x;
              const posY = draggingPos?.id === item.id ? draggingPos.y : item.y;
              const displayW = Math.round(item.width * item.scale);
              const displayH = Math.round(item.height * item.scale);
              const canDelete = canEditBoard && (item.addedBy === user?.id || canManage || isOffline);
              const canMove = canEditBoard && (!item.locked || canManage);

              return (
                <div
                  key={item.id}
                  data-testid={`room-ref-item-${item.id}`}
                  data-ref-title={item.title}
                  data-ref-x={posX}
                  data-ref-y={posY}
                  data-ref-scale={item.scale}
                  style={{
                    transform: `translate3d(${posX}px, ${posY}px, 0)`,
                    width: displayW,
                    zIndex: item.zIndex + 1,
                  }}
                  className="absolute left-0 top-0 overflow-hidden rounded-md border border-neutral-700/80 bg-neutral-900 shadow-lg"
                >
                  <div
                    onPointerDown={(e) => startDragItem(e, item)}
                    className={`flex items-center gap-1 border-b border-neutral-800 bg-neutral-900/95 px-1.5 py-0.5 text-[10px] text-neutral-300 ${
                      canMove ? 'cursor-grab active:cursor-grabbing' : ''
                    }`}
                  >
                    <Move className="h-2.5 w-2.5 shrink-0 opacity-60" />
                    <span className="min-w-0 flex-1 truncate" title={`${item.title} · ${item.addedByName}`}>
                      {item.title}
                    </span>
                    <span className="shrink-0 font-mono text-[9px] text-neutral-400">
                      {Math.round(item.scale * 100)}%
                    </span>
                    {canMove && (
                      <>
                        <button
                          type="button"
                          data-testid={`room-ref-scale-down-${item.id}`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => nudgeScale(item, 0.8)}
                          title={`${t.collab.refBoardScale} -`}
                          className="rounded p-0.5 hover:bg-neutral-800"
                        >
                          <ZoomOut className="h-2.5 w-2.5" />
                        </button>
                        <button
                          type="button"
                          data-testid={`room-ref-scale-up-${item.id}`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => nudgeScale(item, 1.25)}
                          title={`${t.collab.refBoardScale} +`}
                          className="rounded p-0.5 hover:bg-neutral-800"
                        >
                          <ZoomIn className="h-2.5 w-2.5" />
                        </button>
                      </>
                    )}
                    {canDelete && (
                      <button
                        type="button"
                        data-testid={`room-ref-delete-${item.id}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => removeRoomRefItem(item.id)}
                        title={t.collab.refBoardDelete}
                        className="rounded p-0.5 text-rose-300 hover:bg-rose-950/70"
                      >
                        <Trash2 className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </div>
                  <img
                    src={item.imageDataUrl}
                    alt={item.title}
                    draggable={false}
                    style={{ width: displayW, height: displayH, opacity: item.opacity }}
                    className="block cursor-crosshair object-contain bg-neutral-950"
                    onClick={(e) => {
                      const hex = sampleImageColorAtClick(e.currentTarget, e.clientX, e.clientY);
                      if (hex) {
                        onPickColor(hex);
                        setPickedHex(hex);
                        window.setTimeout(() => setPickedHex((curr) => (curr === hex ? null : curr)), 1800);
                      }
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}

        {pickedHex && (
          <div
            role="status"
            className="pointer-events-none sticky bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-full bg-indigo-600 px-2 py-0.5 font-mono text-[10px] font-medium text-white shadow"
          >
            <Pipette className="h-3 w-3" />
            <span>{pickedHex}</span>
          </div>
        )}
      </div>

      <p className="truncate text-[10px] text-neutral-500">
        {canEditBoard ? t.collab.refBoardPickHint : t.collab.refBoardReadOnly}
      </p>
    </div>
  );
};
