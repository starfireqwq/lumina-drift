import React, { useState } from 'react';
import {
  Archive,
  CheckCircle2,
  Download,
  FileImage,
  Layers,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { CanvasModel, LayerModel } from '@atelier/shared';
import { ExportEngine, ExportFormat, LayerCanvasItem } from '../engine/ExportEngine';
import { LuminaProjectEngine } from '../engine/LuminaProjectEngine';
import { useI18n } from '../context/I18nContext';
import { AtelierModal, modalButton } from './AtelierModal';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  canvas: CanvasModel | null;
  layers: LayerModel[];
  getLayerCanvases: () => Promise<LayerCanvasItem[]>;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  canvas,
  layers,
  getLayerCanvases,
}) => {
  const { t } = useI18n();
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>('lumina');
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportSuccess, setExportSuccess] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !canvas) return null;

  const formats: Array<{
    id: ExportFormat;
    title: string;
    desc: string;
    icon: React.ReactNode;
    ext: string;
    badge?: string;
  }> = [
    {
      id: 'lumina',
      title: t.export.lumina,
      desc: t.export.luminaDesc,
      icon: <Sparkles className="w-5 h-5 text-cyan-400" />,
      ext: '.lumina',
      badge: 'Lumina Native',
    },
    {
      id: 'psd',
      title: t.export.psd,
      desc: t.export.psdDesc,
      icon: <Layers className="w-5 h-5 text-indigo-400" />,
      ext: '.psd',
      badge: 'PSD',
    },
    {
      id: 'ora',
      title: t.export.ora,
      desc: t.export.oraDesc,
      icon: <Sparkles className="w-5 h-5 text-emerald-400" />,
      ext: '.ora',
      badge: 'OpenRaster',
    },
    {
      id: 'merged_png',
      title: t.export.mergedPng,
      desc: t.export.mergedPngDesc,
      icon: <FileImage className="w-5 h-5 text-amber-400" />,
      ext: '.png',
    },
    {
      id: 'jpeg',
      title: t.export.jpeg,
      desc: t.export.jpegDesc,
      icon: <FileImage className="w-5 h-5 text-rose-400" />,
      ext: '.jpg',
      badge: 'JPEG / JPG',
    },
    {
      id: 'transparent_png',
      title: t.export.transparentPng,
      desc: t.export.transparentPngDesc,
      icon: <FileImage className="w-5 h-5 text-cyan-400" />,
      ext: '.png',
    },
    {
      id: 'layers_zip',
      title: t.export.layersZip,
      desc: t.export.layersZipDesc,
      icon: <Archive className="w-5 h-5 text-violet-400" />,
      ext: '.zip',
    },
  ];

  const handleExport = async () => {
    try {
      setIsExporting(true);
      setExportSuccess(false);
      setError(null);

      const items = await getLayerCanvases();
      if (!items || items.length === 0) {
        throw new Error(t.export.noValidData);
      }

      const safeTitle = (canvas.title || 'atelier_artwork').replace(/[\\/:*?"<>|]/g, '_');
      let blob: Blob;
      let filename: string;

      switch (selectedFormat) {
        case 'lumina': {
          const saved = await LuminaProjectEngine.saveProject(canvas, layers, getLayerCanvases, { saveAs: true });
          if (!saved.saved) {
            setIsExporting(false);
            return;
          }
          setExportSuccess(true);
          setTimeout(() => setExportSuccess(false), 4000);
          return;
        }

        case 'psd':
          blob = await ExportEngine.exportPhotoshopPsd(
            items,
            canvas.width,
            canvas.height,
            canvas.bgColor
          );
          filename = `${safeTitle}.psd`;
          break;

        case 'ora':
          blob = await ExportEngine.exportOpenRasterOra(
            items,
            canvas.width,
            canvas.height,
            canvas.bgColor
          );
          filename = `${safeTitle}.ora`;
          break;

        case 'merged_png':
          blob = await ExportEngine.exportPng(
            items,
            canvas.width,
            canvas.height,
            canvas.bgColor,
            `${safeTitle}.png`
          );
          filename = `${safeTitle}.png`;
          break;

        case 'jpeg':
          blob = await ExportEngine.exportJpeg(
            items,
            canvas.width,
            canvas.height,
            canvas.bgColor || '#FFFFFF',
            0.92
          );
          filename = `${safeTitle}.jpg`;
          break;

        case 'transparent_png':
          blob = await ExportEngine.exportPng(
            items,
            canvas.width,
            canvas.height,
            null, // Transparent
            `${safeTitle}_transparent.png`
          );
          filename = `${safeTitle}_transparent.png`;
          break;

        case 'layers_zip':
          blob = await ExportEngine.exportLayersZip(
            items,
            canvas.width,
            canvas.height,
            canvas.bgColor,
            safeTitle
          );
          filename = `${safeTitle}_layers.zip`;
          break;

        default:
          throw new Error(t.export.unsupportedFormat);
      }

      ExportEngine.downloadBlob(blob, filename);
      setExportSuccess(true);
      setTimeout(() => setExportSuccess(false), 4000);
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <AtelierModal
      title={t.export.title}
      icon={<Download />}
      subtitle={t.export.subtitle}
      width="lg"
      onClose={onClose}
      footer={
        <>
          <span role="status" className="mr-auto text-[11px] text-neutral-400">
            {exportSuccess ? (
              <span className="flex items-center gap-1.5 font-medium text-emerald-400"><CheckCircle2 className="h-4 w-4" /> {t.export.downloadStarted}</span>
            ) : (
              <>{canvas.width} × {canvas.height} px · {layers.length} {t.export.layersCount}</>
            )}
          </span>
          <button type="button" onClick={onClose} disabled={isExporting} className={modalButton.secondary}>{t.common.cancel}</button>
          <button type="button" onClick={handleExport} disabled={isExporting} className={modalButton.primary}>
            {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {isExporting ? t.export.exporting : t.export.download}
          </button>
        </>
      }
    >
      <div role="radiogroup" aria-label={t.export.format} className="flex flex-col gap-2">
        {formats.map((f) => {
          const isSelected = selectedFormat === f.id;
          return (
            <button key={f.id} type="button" role="radio" aria-checked={isSelected} onClick={() => setSelectedFormat(f.id)}
              className={`flex items-start gap-3 rounded-lg border p-3 text-left transition ${isSelected ? 'border-indigo-500 bg-indigo-600/15' : 'border-neutral-800 hover:border-neutral-700 hover:bg-neutral-800/40'}`}>
              <span className="mt-0.5 shrink-0 rounded-md bg-neutral-800 p-1.5">{f.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-xs font-semibold text-white">{f.title}</span>
                  {f.badge && <span className="rounded border border-neutral-700 px-1.5 font-mono text-[10px] text-neutral-400">{f.badge}</span>}
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-neutral-400">{f.desc}</span>
              </span>
              <span className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${isSelected ? 'border-indigo-500 bg-indigo-600' : 'border-neutral-600'}`}>
                {isSelected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
              </span>
            </button>
          );
        })}
        {error && <p role="alert" className="rounded-md border border-rose-700 bg-rose-950/60 px-2.5 py-2 text-rose-200">{t.export.exportFailed}：{error}</p>}
      </div>
    </AtelierModal>
  );
};
