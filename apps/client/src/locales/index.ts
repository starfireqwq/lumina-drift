import type { Language, Translations } from './types';
import { zhTW } from './zh-TW';
import { zhCN } from './zh-CN';
import { enUS } from './en-US';
import { jaJP } from './ja-JP';

export * from './types';
export { zhTW } from './zh-TW';
export { zhCN } from './zh-CN';
export { enUS } from './en-US';
export { jaJP } from './ja-JP';

export const translations: Record<Language, Translations> = {
  'zh-TW': zhTW,
  'zh-CN': zhCN,
  'en-US': enUS,
  'ja-JP': jaJP,
};

export const LANGUAGE_STORAGE_KEY = 'atelier_language';

/** The language the user picked, else the browser's. */
export function detectLanguage(): Language {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY) as Language | null;
    if (saved && translations[saved]) return saved;
  } catch {
    // no storage (private mode, Node): fall back to the browser language
  }
  const navLang = (typeof navigator !== 'undefined' ? navigator.language || '' : '').toLowerCase();
  if (navLang.startsWith('zh-cn') || navLang.startsWith('zh-sg')) return 'zh-CN';
  if (navLang.startsWith('zh')) return 'zh-TW';
  if (navLang.startsWith('ja')) return 'ja-JP';
  return 'en-US';
}

/** Strings for code outside React (services). Follows the interface language, which is saved on every switch. */
export function currentTranslations(): Translations {
  return translations[detectLanguage()];
}

export interface LanguageOption {
  code: Language;
  label: string;
  nativeLabel: string;
}

export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { code: 'zh-TW', label: '繁體中文', nativeLabel: '繁體中文' },
  { code: 'zh-CN', label: '简体中文', nativeLabel: '简体中文' },
  { code: 'en-US', label: 'English (US)', nativeLabel: 'English (US)' },
  { code: 'ja-JP', label: '日本語', nativeLabel: '日本語' },
];
