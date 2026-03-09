// src/lib/theme.ts — テーマシステムへの統合ブリッジ
export { C, F, getTheme, setTheme, loadThemeId, saveThemeId, THEMES, DEFAULT_THEME,
         applyThemeCssVars, initThemeCssVars } from "./themes";
export type { Theme, ThemeId } from "./themes";
export const SZ = { xs:12, sm:14, md:16, lg:19, xl:24, num:28, numLg:36 };
