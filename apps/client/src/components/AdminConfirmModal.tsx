import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { useI18n } from '../context/I18nContext';

interface AdminConfirmModalProps {
  isOpen: boolean;
  layerName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const AdminConfirmModal: React.FC<AdminConfirmModalProps> = ({
  isOpen,
  layerName,
  onConfirm,
  onCancel,
}) => {
  const { t } = useI18n();
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-neutral-900 border border-amber-600/60 rounded-xl max-w-md w-full p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-amber-500/20 text-amber-400 rounded-lg shrink-0 border border-amber-500/30">
            <ShieldAlert className="w-6 h-6" />
          </div>
          <div className="space-y-2">
            <h3 className="text-base font-semibold text-white">{t.layers.forceClaim}</h3>
            <p className="text-sm text-neutral-300 leading-relaxed">
              「<span className="text-amber-400 font-medium">{layerName}</span>」{t.layers.transferOwnership}
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-neutral-800">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs font-medium transition"
          >
            {t.common.cancel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold shadow-md transition"
          >
            {t.common.confirm}
          </button>
        </div>
      </div>
    </div>
  );
};
