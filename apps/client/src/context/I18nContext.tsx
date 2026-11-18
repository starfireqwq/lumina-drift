import React, { createContext, useContext, useLayoutEffect, useState } from 'react';
import { applyTheme, CustomThemeSettings, loadThemeSettings, resolveTheme, saveThemeSettings, ThemeId } from '../theme/themes';
import { translations, type Language, type Translations } from '../locales';

export type { Language, Translations };
export { translations };

interface I18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: Translations;
  /** Light or dark family of the active theme (gray counts as dark). */
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  setTheme: (theme: 'dark' | 'light') => void;
  themeId: ThemeId;
  setThemeId: (id: ThemeId) => void;
  customTheme: CustomThemeSettings;
  setCustomTheme: (custom: CustomThemeSettings) => void;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(() => {
    const saved = localStorage.getItem('atelier_language') as Language;
    if (saved && translations[saved]) return saved;
    // Auto-detect browser language
    const navLang = navigator.language.toLowerCase();
    if (navLang.startsWith('zh-cn') || navLang.startsWith('zh-sg')) return 'zh-CN';
    if (navLang.startsWith('zh')) return 'zh-TW';
    if (navLang.startsWith('ja')) return 'ja-JP';
    return 'en-US';
  });

  const [themeState, setThemeState] = useState(loadThemeSettings);
  const { id: themeId, custom: customTheme } = themeState;
  const theme: 'dark' | 'light' = resolveTheme(themeId, customTheme).base === 'light' ? 'light' : 'dark';

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem('atelier_language', lang);
  };

  const setThemeId = (id: ThemeId) => setThemeState((prev) => ({ ...prev, id }));
  const setCustomTheme = (custom: CustomThemeSettings) => setThemeState({ id: 'custom', custom });
  const setTheme = (newTheme: 'dark' | 'light') => setThemeId(newTheme);
  const toggleTheme = () => setThemeId(theme === 'dark' ? 'light' : 'dark');

  // Layout effect: the theme is on the page in the same commit (the animated switch snapshots right after it)
  useLayoutEffect(() => {
    applyTheme(themeId, customTheme);
    saveThemeSettings(themeId, customTheme);
  }, [themeId, customTheme]);

  const value: I18nContextType = {
    language,
    setLanguage,
    t: translations[language],
    theme,
    toggleTheme,
    setTheme,
    themeId,
    setThemeId,
    customTheme,
    setCustomTheme,
  };

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export const useI18n = (): I18nContextType => {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return ctx;
};
