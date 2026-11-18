import React, { useState } from 'react';
import { BlendMode, LayerType } from '@atelier/shared';
import { Layers, Spline, UserPlus } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../context/I18nContext';
import { getUserColor } from '../utils/userColors';
import { AtelierModal, modalButton } from './AtelierModal';

interface CreateMyLayerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateLayer: (name: string, blendMode?: BlendMode, layerType?: LayerType) => Promise<unknown> | void;
}

const BLEND_MODES: Array<[BlendMode, string]> = [
  ['normal', '正常'],
  ['multiply', '色彩增值'],
  ['screen', '濾色'],
  ['overlay', '覆蓋'],
  ['add', '發光（線性加亮）'],
];

/** A painter's own layer: only its owner (and admins) draw on it, marked with the owner's colour. */
export const CreateMyLayerModal: React.FC<CreateMyLayerModalProps> = ({ isOpen, onClose, onCreateLayer }) => {
  const { t } = useI18n();
  const { user } = useAuth();
  const userTheme = getUserColor(user?.id);
  const [name, setName] = useState(`${user?.displayName || user?.username || 'Artist'} Layer`);
  const [layerType, setLayerType] = useState<LayerType>('raster');
  const [blendMode, setBlendMode] = useState<BlendMode>('normal');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blendModesList: Array<[BlendMode, string]> = [
    ['normal', t.blendModes.normal],
    ['multiply', t.blendModes.multiply],
    ['screen', t.blendModes.screen],
    ['overlay', t.blendModes.overlay],
    ['add', t.blendModes.add],
  ];

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await onCreateLayer(name.trim(), blendMode, layerType);
      onClose();
    } catch (err: any) {
      setError(err.message || t.alerts.operationFailed);
    } finally {
      setIsSubmitting(false);
    }
  };

  const typeOption = (type: LayerType, icon: React.ReactNode, label: string, hint: string) => (
    <button type="button" role="radio" aria-checked={layerType === type} onClick={() => setLayerType(type)}
      className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition ${layerType === type ? 'border-indigo-500 bg-indigo-600/15 text-white' : 'border-neutral-800 text-neutral-400 hover:border-neutral-700'}`}>
      <span className="flex items-center gap-1.5 text-xs font-semibold">{icon}{label}</span>
      <span className="text-[11px] leading-snug text-neutral-500">{hint}</span>
    </button>
  );

  return (
    <AtelierModal
      title={t.layers.myLayer}
      icon={<UserPlus />}
      subtitle="多人合繪時每位畫師畫在自己的圖層上，彼此不會蓋掉。"
      onClose={onClose}
      onSubmit={handleSubmit}
      footer={
        <>
          <button type="button" onClick={onClose} className={modalButton.secondary}>{t.common.cancel}</button>
          <button type="submit" disabled={isSubmitting || !name.trim()} className={modalButton.primary}>
            {isSubmitting ? t.common.applying : t.layers.addLayer}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-neutral-400">
          <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: userTheme.hex }} />
          <span>圖層會標上你的代表色 <span className="font-semibold" style={{ color: userTheme.hex }}>{userTheme.name}</span></span>
        </p>

        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-neutral-300">{t.layers.renameLayer}</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required autoFocus
            onFocus={(e) => e.currentTarget.select()} placeholder="Layer name" className="atelier-field h-10 w-full px-3 text-sm" />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="font-medium text-neutral-300">{t.layers.title}</span>
          <div role="radiogroup" aria-label="圖層類型" className="grid grid-cols-2 gap-2">
            {typeOption('raster', <Layers className="h-3.5 w-3.5 text-indigo-400" />, t.layers.rasterLayer, '上色、混色、素描筆觸')}
            {typeOption('vector', <Spline className="h-3.5 w-3.5 text-sky-400" />, t.layers.vectorLayer, '線稿：可修線、交點消除')}
          </div>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-neutral-300">{t.layers.blendMode}</span>
          <select value={blendMode} onChange={(e) => setBlendMode(e.target.value as BlendMode)} className="atelier-field h-10 w-full px-3 text-xs">
            {blendModesList.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>

        {error && <p role="alert" className="rounded-md border border-rose-700 bg-rose-950/60 px-2.5 py-2 text-rose-200">{error}</p>}
      </div>
    </AtelierModal>
  );
};
