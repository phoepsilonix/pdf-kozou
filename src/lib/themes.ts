// src/lib/themes.ts — テーマ定義 + 切り替えシステム

export const F = "'JetBrains Mono','Noto Sans JP',monospace";

export type ThemeId =
  | "moss"
  | "ocean"
  | "slate"
  | "dusk"
  | "ember"
  | "paper"
  | "nordic"
  | "kozou-cup";

export interface Theme {
  id: ThemeId;
  name: string;
  emoji: string;
  bg: string;
  bgCard: string;
  bgHover: string;
  border: string;
  borderHi: string;
  text: string;
  textSub: string;
  textDim: string;
  accent: string;
  accentBg: string;
  accentBd: string;
  accentText: string; // アクセント色の上に載るテキスト色
  green: string;
  warn: string;
  warnBg: string;
  warnBd: string;
  err: string;
  errBg: string;
  errBd: string;
  navBg: string;
  navBd: string;
  // ── 募集テーマ用オプションフィールド（通常テーマでは undefined）──────────
  // 画像パスは Tauri の asset protocol 経由で読み込む
  // 例: "/themes/kozou-cup/icon.png"
  customIcon?: string; // ホームアイコン画像パス
  customIconCredit?: string; // アイコン作者名
  customIconYear?: number; // アイコン応募年度
  customHeader?: string; // ヘッダー画像パス
  customHeaderCredit?: string; // ヘッダー作者名
  customHeaderYear?: number; // ヘッダー応募年度
  customBg?: string; // ホーム背景画像パス
  customBgCredit?: string; // 背景画像作者名
  customBgYear?: number; // 背景画像応募年度
  cupTitle?: string; // 大会名称（例: "PDF小僧杯 2026"）
}

// ── テーマ定義 ────────────────────────────────────────────────────────────────

export const THEMES: Record<ThemeId, Theme> = {
  /** 1. モスグリーン (デフォルト) — 落ち着いた職人の深緑 */
  moss: {
    id: "moss",
    name: "モスグリーン",
    emoji: "🌿",
    bg: "#19221c",
    bgCard: "#222e26",
    bgHover: "#283624",
    border: "#33483a",
    borderHi: "#45634e",
    text: "#e4f2e8",
    textSub: "#94c4a4",
    textDim: "#5e8a6e",
    accent: "#5dd68a",
    accentBg: "#18321f",
    accentBd: "#3d9055",
    accentText: "#fff",
    green: "#4fe090",
    warn: "#d4b84a",
    warnBg: "#2c2808",
    warnBd: "#5a4a14",
    err: "#e06060",
    errBg: "#2a1212",
    errBd: "#602020",
    navBg: "#1f2c22",
    navBd: "#33483a",
  },

  /** 2. オーシャン — 深海ブルー (初期コンセプト) */
  ocean: {
    id: "ocean",
    name: "オーシャン",
    emoji: "🌊",
    bg: "#141c26",
    bgCard: "#1a2536",
    bgHover: "#1f2e42",
    border: "#2a3d56",
    borderHi: "#3a5470",
    text: "#ddeeff",
    textSub: "#7aaacf",
    textDim: "#4a6a8a",
    accent: "#4fa8f0",
    accentBg: "#0d2040",
    accentBd: "#2a60a0",
    accentText: "#fff",
    green: "#4fd090",
    warn: "#d4b84a",
    warnBg: "#282208",
    warnBd: "#585010",
    err: "#e06060",
    errBg: "#281010",
    errBd: "#581818",
    navBg: "#18223a",
    navBd: "#2a3d56",
  },

  /** 3. スレート — モノクロに近いプロ向けグレー */
  slate: {
    id: "slate",
    name: "スレート",
    emoji: "🪨",
    bg: "#18191e",
    bgCard: "#21232a",
    bgHover: "#282a33",
    border: "#353844",
    borderHi: "#484c5e",
    text: "#e8eaf2",
    textSub: "#9095b0",
    textDim: "#565a72",
    accent: "#8b9cf4",
    accentBg: "#181c3c",
    accentBd: "#4050a0",
    accentText: "#fff",
    green: "#64d080",
    warn: "#d4b84a",
    warnBg: "#26200a",
    warnBd: "#504810",
    err: "#e06060",
    errBg: "#261010",
    errBd: "#501818",
    navBg: "#1c1e26",
    navBd: "#353844",
  },

  /** 4. ダスク — 夕暮れパープル */
  dusk: {
    id: "dusk",
    name: "ダスク",
    emoji: "🌆",
    bg: "#1c1824",
    bgCard: "#252030",
    bgHover: "#2c2838",
    border: "#3d3652",
    borderHi: "#534a70",
    text: "#ede8f8",
    textSub: "#a898cc",
    textDim: "#6a5888",
    accent: "#c084f0",
    accentBg: "#26143c",
    accentBd: "#7030a0",
    accentText: "#fff",
    green: "#64d090",
    warn: "#d4b84a",
    warnBg: "#28200c",
    warnBd: "#584818",
    err: "#e06868",
    errBg: "#281016",
    errBd: "#581828",
    navBg: "#211c2e",
    navBd: "#3d3652",
  },

  /** 5. エンバー — 暖かみのある琥珀 */
  ember: {
    id: "ember",
    name: "エンバー",
    emoji: "🔥",
    bg: "#221a12",
    bgCard: "#2e2218",
    bgHover: "#382a1e",
    border: "#4e3824",
    borderHi: "#6a4e32",
    text: "#f4e8d8",
    textSub: "#c4985a",
    textDim: "#806040",
    accent: "#f0a050",
    accentBg: "#3c2010",
    accentBd: "#a05828",
    accentText: "#fff",
    green: "#70d090",
    warn: "#e8c840",
    warnBg: "#2c2408",
    warnBd: "#605010",
    err: "#e06060",
    errBg: "#2a1010",
    errBd: "#601818",
    navBg: "#281e14",
    navBd: "#4e3824",
  },

  /** 6. ペーパー — 明るめ・文書閲覧向けライトテーマ */
  paper: {
    id: "paper",
    name: "ペーパー",
    emoji: "📄",
    bg: "#f5f2ec",
    bgCard: "#ffffff",
    bgHover: "#ede9e0",
    border: "#d8d0c4",
    borderHi: "#b8a898",
    text: "#2c2420",
    textSub: "#6b5e52",
    textDim: "#9e8e82",
    accent: "#2a6e4a",
    accentBg: "#d8ede2",
    accentBd: "#5aad7a",
    accentText: "#000",
    green: "#2a8a50",
    warn: "#9a7a10",
    warnBg: "#fdf3d0",
    warnBd: "#c8a830",
    err: "#c03030",
    errBg: "#fde8e8",
    errBd: "#e07070",
    navBg: "#ede8e0",
    navBd: "#d0c8bc",
  },

  /** 7. ノルディック — 落ち着いたグレーブルーのライトテーマ */
  nordic: {
    id: "nordic",
    name: "ノルディック",
    emoji: "🏔️",
    bg: "#eceff4",
    bgCard: "#ffffff",
    bgHover: "#e4e8f0",
    border: "#d0d8e4",
    borderHi: "#a8b8cc",
    text: "#2e3440",
    textSub: "#4c5a6e",
    textDim: "#88a0b8",
    accent: "#5e81ac",
    accentBg: "#dce6f2",
    accentBd: "#81a1c1",
    accentText: "#000",
    green: "#4c9a6a",
    warn: "#8a6a10",
    warnBg: "#fdf0d0",
    warnBd: "#c8a030",
    err: "#bf4040",
    errBg: "#fce8e8",
    errBd: "#e08888",
    navBg: "#e4e8f2",
    navBd: "#c8d0e0",
  },

  /** 8. PDF小僧杯 — 募集テーマ（年度ごとに画像・クレジットを差し替え） */
  "kozou-cup": {
    id: "kozou-cup",
    name: "PDF小僧杯",
    emoji: "🏆",
    // カラーは moss ベース（画像で個性を出すので色は落ち着かせる）
    bg: "#19221c",
    bgCard: "#222e26",
    bgHover: "#283624",
    border: "#33483a",
    borderHi: "#45634e",
    text: "#e4f2e8",
    textSub: "#94c4a4",
    textDim: "#5e8a6e",
    accent: "#5dd68a",
    accentBg: "#18321f",
    accentBd: "#3d9055",
    accentText: "#fff",
    green: "#4fe090",
    warn: "#d4b84a",
    warnBg: "#2c2808",
    warnBd: "#5a4a14",
    err: "#e06060",
    errBg: "#2a1212",
    errBd: "#602020",
    navBg: "#1f2c22",
    navBd: "#33483a",
    // ── 募集テーマ画像（年度ごとに差し替える） ──
    // 画像ファイルは src/assets/themes/kozou-cup/ に配置
    // ビルド時に dist/themes/kozou-cup/ にコピーされる
    cupTitle: "PDF小僧杯",
    customIcon: "/themes/kozou-cup/icon.png",
    customIconCredit: undefined, // 例: "作者ハンドル名"
    customIconYear: undefined, // 例: 2026
    customHeader: "/themes/kozou-cup/header.png",
    customHeaderCredit: undefined,
    customHeaderYear: undefined,
    customBg: "/themes/kozou-cup/bg.png",
    customBgCredit: undefined,
    customBgYear: undefined,
  },
};

export const DEFAULT_THEME: ThemeId = "nordic";
const STORAGE_KEY = "pdf-kozou-theme";

// ── 永続化 ───────────────────────────────────────────────────────────────────

export function loadThemeId(): ThemeId {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s && s in THEMES) return s as ThemeId;
  } catch {}
  return DEFAULT_THEME;
}

export function saveThemeId(id: ThemeId) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {}
}

// ── グローバルテーマ状態 ─────────────────────────────────────────────────────
// C は Proxy で _current を常に参照する (コンポーネント内で getTheme() も可)

let _current: Theme = THEMES[loadThemeId()];

export function getTheme(): Theme {
  return _current;
}

export function setTheme(id: ThemeId) {
  _current = THEMES[id];
  saveThemeId(id);
  // ブラウザ環境なら CSS 変数も即時更新 (key re-mount の前に確実に反映)
  if (typeof document !== "undefined") applyThemeCssVars(_current);
}

// C: 各コンポーネントが import { C } from "../lib/theme" で使えるProxy
// Proxy は _current を動的に引くため、setTheme() 後に最新値を返す
export const C: Theme = new Proxy({} as Theme, {
  get(_: Theme, key: string) {
    return (_current as any)[key];
  },
});

// ── CSS 変数によるテーマ適用 ─────────────────────────────────────────────────
// スタイルを :root CSS 変数に書き出すことで、
// Proxy C の値が古くなっても CSS 変数は即座に全コンポーネントに反映される

export function applyThemeCssVars(t: Theme) {
  const root = document.documentElement;
  (Object.entries(t) as [string, string][]).forEach(([k, v]) => {
    if (typeof v === "string" && v.startsWith("#")) {
      root.style.setProperty(`--c-${k}`, v);
    }
  });
  root.style.setProperty("--c-bg", t.bg);
  root.style.setProperty("--c-bgCard", t.bgCard);
  root.style.setProperty("--c-bgHover", t.bgHover);
  root.style.setProperty("--c-border", t.border);
  root.style.setProperty("--c-borderHi", t.borderHi);
  root.style.setProperty("--c-text", t.text);
  root.style.setProperty("--c-textSub", t.textSub);
  root.style.setProperty("--c-textDim", t.textDim);
  root.style.setProperty("--c-accent", t.accent);
  root.style.setProperty("--c-accentBg", t.accentBg);
  root.style.setProperty("--c-accentBd", t.accentBd);
  root.style.setProperty("--c-accentText", t.accentText);
  root.style.setProperty("--c-green", t.green);
  root.style.setProperty("--c-warn", t.warn);
  root.style.setProperty("--c-warnBg", t.warnBg);
  root.style.setProperty("--c-warnBd", t.warnBd);
  root.style.setProperty("--c-err", t.err);
  root.style.setProperty("--c-errBg", t.errBg);
  root.style.setProperty("--c-errBd", t.errBd);
  root.style.setProperty("--c-navBg", t.navBg);
  root.style.setProperty("--c-navBd", t.navBd);
}

export function initThemeCssVars() {
  applyThemeCssVars(_current);
}
