import React, { createContext, useContext, useLayoutEffect, useState } from 'react';
import {
  applyLuminaGlowSettings,
  applySurfaceStyle,
  applyTheme,
  CustomThemeSettings,
  loadLuminaGlowSettings,
  loadSurfaceStyle,
  loadThemeSettings,
  LuminaGlowSettings,
  normalizeLuminaGlowSettings,
  resolveTheme,
  saveLuminaGlowSettings,
  saveSurfaceStyle,
  saveThemeSettings,
  SurfaceStyle,
  ThemeId,
} from '../theme/themes';
import { detectLanguage, LANGUAGE_STORAGE_KEY, translations, type Language, type Translations } from '../locales';

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
  surfaceStyle: SurfaceStyle;
  setSurfaceStyle: (surface: SurfaceStyle) => void;
  luminaGlowSettings: LuminaGlowSettings;
  setLuminaGlowSettings: (settings: LuminaGlowSettings) => void;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(detectLanguage);

  const [themeState, setThemeState] = useState(loadThemeSettings);
  const { id: themeId, custom: customTheme } = themeState;
  const theme: 'dark' | 'light' = resolveTheme(themeId, customTheme).base === 'light' ? 'light' : 'dark';
  const [surfaceStyle, setSurfaceStyleState] = useState<SurfaceStyle>(loadSurfaceStyle);
  const [luminaGlowSettings, setLuminaGlowState] = useState<LuminaGlowSettings>(loadLuminaGlowSettings);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  };

  const setThemeId = (id: ThemeId) => setThemeState((prev) => ({ ...prev, id }));
  const setCustomTheme = (custom: CustomThemeSettings) => setThemeState({ id: 'custom', custom });
  const setTheme = (newTheme: 'dark' | 'light') => setThemeId(newTheme);
  const toggleTheme = () => setThemeId(theme === 'dark' ? 'light' : 'dark');
  const setSurfaceStyle = (surface: SurfaceStyle) => setSurfaceStyleState(surface);
  const setLuminaGlowSettings = (settings: LuminaGlowSettings) => setLuminaGlowState(normalizeLuminaGlowSettings(settings));

  // Layout effect: the theme is on the page in the same commit (the animated switch snapshots right after it)
  useLayoutEffect(() => {
    applyTheme(themeId, customTheme);
    saveThemeSettings(themeId, customTheme);
  }, [themeId, customTheme]);

  useLayoutEffect(() => {
    applySurfaceStyle(surfaceStyle);
    saveSurfaceStyle(surfaceStyle);
  }, [surfaceStyle]);

  useLayoutEffect(() => {
    applyLuminaGlowSettings(luminaGlowSettings);
    saveLuminaGlowSettings(luminaGlowSettings);
  }, [luminaGlowSettings]);

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
    surfaceStyle,
    setSurfaceStyle,
    luminaGlowSettings,
    setLuminaGlowSettings,
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
