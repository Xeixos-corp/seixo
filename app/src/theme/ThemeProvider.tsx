import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { darkPalette, lightPalette, Palette } from './palette';
import { useThemeStore } from '../store/themeStore';

type ThemeContextValue = {
  colorScheme: 'light' | 'dark';
  colors: Palette;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const preference = useThemeStore((state) => state.preference);

  // An explicit choice always wins; 'system' falls back to the phone's own
  // setting. Note that the system value only becomes useful once app.json's
  // userInterfaceStyle is "automatic" -- with "light" iOS reports light no
  // matter what the phone is set to, which is why the dark palette had been
  // written and never seen.
  const colorScheme =
    preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : preference;

  const value = useMemo<ThemeContextValue>(
    () => ({
      colorScheme,
      colors: colorScheme === 'dark' ? darkPalette : lightPalette,
    }),
    [colorScheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useAppTheme must be used within a ThemeProvider');
  }
  return ctx;
}
