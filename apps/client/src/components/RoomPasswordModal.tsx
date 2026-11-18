import React, { useState } from 'react';
import { Eye, EyeOff, KeyRound, LayoutGrid, LogIn } from 'lucide-react';
import { useI18n } from '../context/I18nContext';

interface RoomPasswordModalProps {
  canvasTitle: string;
  /** Message from the server after a wrong password */
  error: string | null;
  isGuest: boolean;
  onSubmit: (password: string) => Promise<void>;
  onChooseAnother: () => void;
  onLogin: () => void;
}

/** Shown over a locked canvas until the right room password is entered. */
export const RoomPasswordModal: React.FC<RoomPasswordModalProps> = ({ canvasTitle, error, isGuest, onSubmit, onChooseAnother, onLogin }) => {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim() || busy) return;
    setBusy(true);
    setLocalError(null);
    try {
      await onSubmit(password.trim());
    } catch (err: any) {
      setLocalError(err?.message || '密碼錯誤，請再試一次');
    } finally {
      setBusy(false);
    }
  };

  const message = localError || error;

  return (
    <div className="atelier-modal-backdrop fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="room-password-title">
      <form onSubmit={submit} className="atelier-modal w-full max-w-sm overflow-hidden">
        <div className="flex flex-col items-center gap-2 px-6 pb-2 pt-6 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600/20 text-indigo-300">
            <KeyRound className="h-6 w-6" />
          </span>
          <h2 id="room-password-title" className="text-base font-bold text-white">{t.canvas.roomPasswordRequired}</h2>
          <p className="text-xs text-neutral-400">「{canvasTitle}」{t.canvas.roomPasswordDesc}</p>
        </div>
        <div className="flex flex-col gap-2 px-6 py-3">
          <label htmlFor="room-password" className="text-xs font-medium text-neutral-300">{t.canvas.roomPasswordLabel}</label>
          <div className="relative">
            <input id="room-password" autoFocus type={show ? 'text' : 'password'} value={password} autoComplete="off"
              onChange={(e) => setPassword(e.target.value)} aria-invalid={Boolean(message)} aria-describedby={message ? 'room-password-error' : undefined}
              className="atelier-field h-10 w-full px-3 pr-10 text-sm" placeholder={t.gateway.passwordPlaceholder} />
            <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? '隱藏密碼' : '顯示密碼'}
              className="atelier-icon-btn absolute right-1 top-1 h-8 w-8">
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {message && <p id="room-password-error" role="alert" className="text-xs text-rose-300">{message}</p>}
        </div>
        <div className="flex flex-col gap-2 border-t border-neutral-800 bg-neutral-950/40 px-6 py-4">
          <button type="submit" disabled={!password.trim() || busy}
            className="h-10 rounded-lg bg-indigo-600 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50">
            {busy ? t.canvas.verifying : t.canvas.enterCanvas}
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onChooseAnother} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-neutral-700 py-2 text-xs text-neutral-300 hover:bg-neutral-800">
              <LayoutGrid className="h-3.5 w-3.5" /> {t.canvas.chooseAnotherCanvas}
            </button>
            {isGuest && (
              <button type="button" onClick={onLogin} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-neutral-700 py-2 text-xs text-neutral-300 hover:bg-neutral-800">
                <LogIn className="h-3.5 w-3.5" /> {t.canvas.loginAccount}
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
};
