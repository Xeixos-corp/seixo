// Palette inspired by the Claude.ai web app: warm off-white/cream in light mode,
// dark charcoal in dark mode, terracotta as the single accent color.

export const lightPalette = {
  background: '#F5F1EC',
  surface: '#FFFFFF',
  surfaceAlt: '#EDE8E0',
  border: '#DDD6CB',
  textPrimary: '#2B2A27',
  textSecondary: '#6B6558',
  accent: '#CC785C',
  accentPressed: '#B8674D',
  onAccent: '#FFFFFF',
  danger: '#C0392B',
  success: '#4E7A51',
} as const;

export const darkPalette = {
  background: '#262624',
  surface: '#30302E',
  surfaceAlt: '#3A3A37',
  border: '#47463F',
  textPrimary: '#F2EFE9',
  textSecondary: '#B3ADA0',
  accent: '#DA9179',
  accentPressed: '#E8A48D',
  onAccent: '#262624',
  danger: '#E57373',
  success: '#81C784',
} as const;

export type Palette = Record<keyof typeof lightPalette, string>;
