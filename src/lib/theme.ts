// src/lib/theme.ts — テーマシステムへの統合ブリッジ
// 既存コードが import { C, F } from "../lib/theme" で使えるように維持する

export { C, F, getTheme, setTheme, loadThemeId, saveThemeId, THEMES, DEFAULT_THEME } from "./themes";
export type { Theme, ThemeId } from "./themes";

// SZ は後方互換性のために残す
export const SZ = {
  xs:    12,
  sm:    14,
  md:    16,
  lg:    19,
  xl:    24,
  num:   28,
  numLg: 36,
};
