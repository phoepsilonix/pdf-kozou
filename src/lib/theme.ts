// src/lib/theme.ts — テーマシステムへの統合ブリッジ

export type { Theme, ThemeId } from "./themes";
export {
  applyThemeCssVars,
  C,
  DEFAULT_THEME,
  F,
  getTheme,
  initThemeCssVars,
  loadThemeId,
  saveThemeId,
  setTheme,
  THEMES,
} from "./themes";
export const SZ = { xs: 12, sm: 14, md: 16, lg: 19, xl: 24, num: 28, numLg: 36 };
