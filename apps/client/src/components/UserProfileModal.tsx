import React, { useRef, useState } from 'react';
import { Camera, Check, Crop, Palette, Sparkles, User, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getUserColor } from '../utils/userColors';
import { AvatarCropModal } from './AvatarCropModal';
import { useI18n } from '../context/I18nContext';

interface UserProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const PRESET_AVATARS = [
  'https://api.dicebear.com/7.x/bottts/svg?seed=atelier1',
  'https://api.dicebear.com/7.x/bottts/svg?seed=atelier2',
  'https://api.dicebear.com/7.x/bottts/svg?seed=atelier3',
  'https://api.dicebear.com/7.x/notionists/svg?seed=painter1',
  'https://api.dicebear.com/7.x/notionists/svg?seed=painter2',
  'https://api.dicebear.com/7.x/notionists/svg?seed=painter3',
];

export const UserProfileModal: React.FC<UserProfileModalProps> = ({ isOpen, onClose }) => {
  const { user, updateProfile } = useAuth();
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user?.avatarUrl || null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  // Avatar Cropper Modal State
  const [cropModalOpen, setCropModalOpen] = useState(false);
  const [rawImageForCrop, setRawImageForCrop] = useState<string | null>(null);

  if (!isOpen || !user) return null;

  const userTheme = getUserColor(user.id);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset file input value so selecting the same file again triggers change
    e.target.value = '';

    const reader = new FileReader();
    reader.onload = (event) => {
      const src = event.target?.result as string;
      if (src) {
        setRawImageForCrop(src);
        setCropModalOpen(true);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleOpenCropForCurrent = () => {
    if (avatarUrl) {
      setRawImageForCrop(avatarUrl);
      setCropModalOpen(true);
    }
  };

  const handleCropConfirmed = (croppedDataUrl: string) => {
    setAvatarUrl(croppedDataUrl);
    setCropModalOpen(false);
    setRawImageForCrop(null);
  };

  const handleSave = async () => {
    if (!displayName.trim()) return;
    setIsSubmitting(true);
    try {
      await updateProfile(displayName.trim(), avatarUrl);
      setSavedSuccess(true);
      setTimeout(() => {
        setSavedSuccess(false);
        onClose();
      }, 700);
    } catch (err: any) {
      alert(err.message || '更新失敗');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <div role="dialog" aria-modal="true" className="atelier-modal-backdrop fixed inset-0 z-[70] flex items-center justify-center p-2 sm:p-4 animate-in fade-in duration-150">
        <div className="atelier-modal max-h-[calc(100dvh-1rem)] max-w-md w-full overflow-hidden flex flex-col">
          {/* Header */}
          <div className="px-5 py-4 border-b border-neutral-800/80 bg-neutral-900/40 flex shrink-0 items-center justify-between">
            <div className="flex items-center gap-2.5 text-white font-bold text-sm">
              <div
                className="p-1.5 rounded-xl border flex items-center justify-center"
                style={{
                  backgroundColor: `${userTheme.hex}22`,
                  borderColor: `${userTheme.hex}55`,
                  color: userTheme.hex,
                }}
              >
                <User className="w-4 h-4" />
              </div>
              <span>{t.auth.profileTitle}</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t.common.close}
              className="text-neutral-400 hover:text-white transition p-1 rounded-lg"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 flex flex-col gap-4">
            {/* Avatar Upload / Selector */}
            <div className="flex flex-col items-center gap-2.5 py-2">
              <div className="relative group">
                <div
                  className="w-20 h-20 rounded-full border-2 overflow-hidden flex items-center justify-center bg-neutral-900 shadow-xl"
                  style={{
                    borderColor: userTheme.hex,
                    boxShadow: `0 0 20px ${userTheme.hex}33`,
                  }}
                >
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt={displayName}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <span
                      className="text-2xl font-black"
                      style={{ color: userTheme.hex }}
                    >
                      {(displayName || user.username)[0].toUpperCase()}
                    </span>
                  )}
                </div>

                {/* Upload Overlay Button */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="absolute inset-0 rounded-full bg-black/60 flex flex-col items-center justify-center opacity-0 group-hover:opacity-100 transition duration-150 text-white cursor-pointer"
                  title={t.auth.changeAvatar}
                >
                  <Camera className="w-5 h-5 text-neutral-200" />
                  <span className="text-[10px] font-bold mt-0.5">{t.auth.changeAvatar}</span>
                </button>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </div>

              {/* Action Buttons for Avatar */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-2.5 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs rounded-lg transition font-medium flex items-center gap-1 border border-neutral-700 active:scale-95"
                >
                  <Camera className="w-3.5 h-3.5 text-indigo-400" />
                  <span>{t.auth.uploadImage}</span>
                </button>

                {avatarUrl && (
                  <button
                    type="button"
                    onClick={handleOpenCropForCurrent}
                    className="px-2.5 py-1 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 text-xs rounded-lg transition font-medium flex items-center gap-1 border border-indigo-500/40 active:scale-95"
                    title={t.auth.cropScale}
                  >
                    <Crop className="w-3.5 h-3.5" />
                    <span>{t.auth.cropScale}</span>
                  </button>
                )}

                {avatarUrl && (
                  <button
                    type="button"
                    onClick={() => setAvatarUrl(null)}
                    className="px-2 py-1 text-neutral-400 hover:text-rose-400 text-xs transition"
                  >
                    {t.auth.removeAvatar}
                  </button>
                )}
              </div>

              {/* Quick Preset Avatars */}
              <div className="flex items-center gap-1.5 pt-1">
                <span className="text-[10px] text-neutral-500">{t.auth.presetAvatars}:</span>
                {PRESET_AVATARS.map((url, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setAvatarUrl(url)}
                    className="w-6 h-6 rounded-full overflow-hidden border border-neutral-700 hover:scale-110 transition bg-neutral-800"
                  >
                    <img src={url} alt={`preset ${i}`} className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            </div>

            {/* Display Name Input */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-neutral-300">
                {t.auth.displayName}
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t.auth.displayNamePlaceholder}
                className="px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-xl text-white text-sm outline-none focus:border-indigo-500 transition"
                maxLength={24}
              />
            </div>

            {/* Assigned User Color Card */}
            <div className="p-3 bg-neutral-900/60 border border-neutral-800 rounded-xl flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Palette className="w-4 h-4 text-neutral-400" />
                <div className="flex flex-col">
                  <span className="text-xs font-bold text-neutral-200">專屬畫師色票</span>
                  <span className="text-[10px] text-neutral-500">{userTheme.name}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="w-4 h-4 rounded-full border border-white/20 shadow"
                  style={{ backgroundColor: userTheme.hex }}
                />
                <span
                  className="text-xs font-mono font-bold px-2 py-0.5 rounded-md"
                  style={{
                    backgroundColor: `${userTheme.hex}22`,
                    color: userTheme.hex,
                  }}
                >
                  {userTheme.hex}
                </span>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-5 py-3.5 border-t border-neutral-800/80 bg-neutral-900/40 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-semibold rounded-xl transition"
            >
              {t.common.cancel}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSubmitting || !displayName.trim()}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl transition flex items-center gap-1.5 shadow-lg shadow-indigo-600/30 active:scale-95"
            >
              {savedSuccess ? (
                <>
                  <Check className="w-4 h-4 text-emerald-300" />
                  <span>{t.auth.updateSuccess}</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>{t.common.save}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Avatar Crop & Zoom Sub-Modal */}
      <AvatarCropModal
        isOpen={cropModalOpen}
        imageSrc={rawImageForCrop}
        userThemeColor={userTheme.hex}
        onClose={() => {
          setCropModalOpen(false);
          setRawImageForCrop(null);
        }}
        onConfirm={handleCropConfirmed}
      />
    </>
  );
};
