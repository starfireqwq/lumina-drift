import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Check, Pencil, Sparkles, Star, Trash2, X } from 'lucide-react';
import { PIXEL_FILTER_RUNNERS, runPixelFilter, type FilterValues } from '@atelier/shared';
import {
  BUILTIN_LIBRARY_CARDS, scaleFilterValuesForThumbnail, type FavoriteFilterCard,
} from '../utils/filterLibrary';
import { filterFitsLayer, filterLabel, getFilter } from '../utils/filterRegistry';
import { useI18n } from '../context/I18nContext';

export interface FilterThumbSource {
  pixels: Uint8Array;
  width: number;
  height: number;
  origWidth: number;
  origHeight: number;
}

interface CardEntry {
  key: string;
  label: string;
  sublabel?: string;
  filterId: string;
  values: FilterValues;
  favorite?: FavoriteFilterCard;
}

/** Converts premultiplied RGBA pixels into a PNG data URL composited over a subtle checkerboard */
function pixelsToThumbUrl(pixels: Uint8Array, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(width, height);
  const dst = img.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = pixels[i + 3];
      const bg = (((x >> 3) + (y >> 3)) & 1) === 0 ? 44 : 58;
      if (!a) {
        dst[i] = bg;
        dst[i + 1] = bg;
        dst[i + 2] = bg;
        dst[i + 3] = 255;
      } else {
        const inv = 1 - a / 255;
        dst[i] = Math.min(255, Math.round(pixels[i] + bg * inv));
        dst[i + 1] = Math.min(255, Math.round(pixels[i + 1] + bg * inv));
        dst[i + 2] = Math.min(255, Math.round(pixels[i + 2] + bg * inv));
        dst[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL('image/png');
  canvas.width = 0;
  canvas.height = 0;
  return url;
}

interface Props {
  phone: boolean;
  busy: boolean;
  layerType?: string;
  applyToNewLayer: boolean;
  source: FilterThumbSource | null;
  favorites: readonly FavoriteFilterCard[];
  selectedKey: string | null;
  onSelectCard: (key: string, filterId: string, values: FilterValues) => void;
  onRenameFavorite: (id: string, name: string) => void;
  onRemoveFavorite: (id: string) => void;
}

export function FilterLibraryView({
  phone, busy, layerType, applyToNewLayer, source, favorites, selectedKey,
  onSelectCard, onRenameFavorite, onRemoveFavorite,
}: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'featured' | 'favorites'>('featured');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const cacheRef = useRef<{ source: FilterThumbSource | null; map: Record<string, string> }>({ source: null, map: {} });

  const entries = useMemo<CardEntry[]>(() => {
    if (tab === 'featured') {
      return BUILTIN_LIBRARY_CARDS.map((card) => ({
        key: `builtin:${card.id}`,
        label: t.filters.libraryCards[card.id],
        filterId: card.filterId,
        values: card.values,
      }));
    }
    return favorites.map((fav) => {
      const def = getFilter(fav.filterId);
      return {
        key: `fav:${fav.id}`,
        label: fav.name,
        sublabel: def ? filterLabel(def, t) : fav.filterId,
        filterId: fav.filterId,
        values: fav.values,
        favorite: fav,
      };
    });
  }, [tab, favorites, t]);

  // Generate small thumbnails asynchronously in chunks of 2 so the UI stays 60fps
  useEffect(() => {
    if (!source) return;
    if (cacheRef.current.source !== source) {
      cacheRef.current = { source, map: {} };
      setThumbs({});
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const queue = entries.filter((entry) => !cacheRef.current.map[entry.key]);
    let index = 0;

    const step = () => {
      if (cancelled) return;
      const batch: Record<string, string> = {};
      let produced = 0;
      while (index < queue.length && produced < 2) {
        const entry = queue[index++];
        const def = getFilter(entry.filterId);
        const runner = PIXEL_FILTER_RUNNERS[entry.filterId];
        if (!def || !runner) continue;
        const scaled = scaleFilterValuesForThumbnail(def, entry.values, source.origWidth, source.origHeight, source.width, source.height);
        const out = runPixelFilter(runner, source.pixels, source.width, source.height, scaled);
        const url = pixelsToThumbUrl(out, source.width, source.height);
        cacheRef.current.map[entry.key] = url;
        batch[entry.key] = url;
        produced++;
      }
      if (produced > 0) setThumbs((prev) => ({ ...prev, ...batch }));
      if (index < queue.length) timer = setTimeout(step, 0);
    };
    if (queue.length > 0) timer = setTimeout(step, 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [source, entries]);

  const commitRename = () => {
    if (editingId && draftName.trim()) onRenameFavorite(editingId, draftName.trim());
    setEditingId(null);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-950/70 p-0.5" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'featured'}
          onClick={() => setTab('featured')}
          className={`flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
            tab === 'featured' ? 'bg-neutral-800 font-semibold text-white' : 'text-neutral-400 hover:text-neutral-200'
          }`}
        >
          <Sparkles className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{t.filters.libraryFeatured}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'favorites'}
          onClick={() => setTab('favorites')}
          className={`flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
            tab === 'favorites' ? 'bg-neutral-800 font-semibold text-white' : 'text-neutral-400 hover:text-neutral-200'
          }`}
        >
          <Star className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{t.filters.libraryFavorites}</span>
          {favorites.length > 0 && <span className="font-mono text-[10px] text-indigo-300">{favorites.length}</span>}
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-800 px-3 py-5 text-center text-[11px] text-neutral-400">
          {t.filters.libraryEmptyFavs}
        </p>
      ) : (
        <div className={`grid gap-1.5 ${phone ? 'grid-cols-2' : 'grid-cols-2'} ${selectedKey ? 'max-h-48 overflow-y-auto overscroll-contain pr-0.5' : ''}`}>
          {entries.map((entry, idx) => {
            const def = getFilter(entry.filterId);
            const fits = !def || applyToNewLayer || filterFitsLayer(def, layerType);
            const active = selectedKey === entry.key;
            const thumb = thumbs[entry.key];
            const isEditing = Boolean(entry.favorite && editingId === entry.favorite.id);
            return (
              <div
                key={entry.key}
                style={{ '--i': idx } as CSSProperties}
                className={`atelier-filter-card atelier-filter-item group relative flex flex-col overflow-hidden rounded-lg border transition-colors ${
                  active
                    ? 'border-indigo-400/80 bg-indigo-500/15'
                    : 'border-neutral-800 bg-neutral-900/70 hover:border-neutral-700 hover:bg-neutral-800/70'
                }`}
                aria-pressed={active}
              >
                <button
                  type="button"
                  disabled={busy || !fits}
                  title={entry.sublabel ? `${entry.label} (${entry.sublabel})` : entry.label}
                  onClick={() => onSelectCard(entry.key, entry.filterId, entry.values)}
                  className="flex w-full flex-col text-left disabled:opacity-45"
                >
                  <div className="relative h-14 w-full overflow-hidden bg-neutral-950">
                    {thumb ? (
                      <img src={thumb} alt="" className="h-full w-full object-cover" draggable={false} />
                    ) : (
                      <div className="h-full w-full animate-pulse bg-neutral-800/50" />
                    )}
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-1 px-2 py-1">
                    <span className={`min-w-0 flex-1 truncate text-[11px] ${active ? 'font-semibold text-white' : 'text-neutral-200'}`}>
                      {entry.label}
                    </span>
                  </div>
                </button>

                {entry.favorite && !isEditing && (
                  <div className={`absolute right-1 top-1 flex gap-0.5 rounded bg-neutral-950/80 p-0.5 ${phone ? 'opacity-100' : 'opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100'}`}>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={t.filters.renameFavorite}
                      title={t.filters.renameFavorite}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(entry.favorite!.id);
                        setDraftName(entry.favorite!.name);
                      }}
                      className="atelier-icon-btn h-5 w-5 text-neutral-300 hover:text-white"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={t.common.delete}
                      title={t.common.delete}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveFavorite(entry.favorite!.id);
                      }}
                      className="atelier-icon-btn h-5 w-5 text-neutral-300 hover:!text-rose-400"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                )}

                {isEditing && (
                  <div className="flex items-center gap-1 border-t border-neutral-800 bg-neutral-950 px-1.5 py-1">
                    <input
                      type="text"
                      autoFocus
                      maxLength={40}
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                        if (e.key === 'Escape') { e.preventDefault(); setEditingId(null); }
                      }}
                      className="atelier-field h-6 min-w-0 flex-1 px-1.5 text-[11px]"
                    />
                    <button type="button" onClick={commitRename} aria-label={t.common.confirm} className="atelier-icon-btn h-6 w-6 text-indigo-300">
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" onClick={() => setEditingId(null)} aria-label={t.common.cancel} className="atelier-icon-btn h-6 w-6 text-neutral-400">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
