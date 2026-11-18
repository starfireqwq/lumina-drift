import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { CanvasModel } from '@atelier/shared';
import { AtelierModal, modalButton } from './AtelierModal';
import { useI18n } from '../context/I18nContext';

interface DeleteCanvasConfirmModalProps {
  isOpen: boolean;
  canvas: CanvasModel | null;
  onClose: () => void;
  onConfirm: (canvasId: string) => Promise<void> | void;
}

/** Second confirmation before a canvas and everything on it is deleted for good. */
export const DeleteCanvasConfirmModal: React.FC<DeleteCanvasConfirmModalProps> = ({ isOpen, canvas, onClose, onConfirm }) => {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  if (!isOpen || !canvas) return null;

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm(canvas.id);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AtelierModal
      tone="danger"
      title={t.canvas.deleteCanvasTitle}
      icon={<Trash2 />}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={modalButton.secondary}>{t.canvas.keepCanvas}</button>
          {/* Not the default action: Enter / a stray tap must not delete */}
          <button type="button" onClick={confirm} disabled={busy} className={modalButton.danger}>
            <Trash2 className="h-4 w-4" /> {busy ? t.canvas.deleteBusy : t.canvas.permanentlyDelete}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2.5 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2.5">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white">{canvas.title}</span>
          <span className="shrink-0 font-mono text-[10px] text-neutral-500">{canvas.width}×{canvas.height}</span>
        </div>
        <p className="leading-relaxed text-neutral-300">
          {t.canvas.deleteCanvasWarning}
        </p>
      </div>
    </AtelierModal>
  );
};
