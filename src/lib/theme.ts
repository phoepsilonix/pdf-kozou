// src/lib/theme.ts — アプリ共通デザイントークン（明るめモスグリーン）

export const F = "'JetBrains Mono','Noto Sans JP',monospace";

export const C = {
  // 背景系 — 少し明るいモスグリーン系ダーク
  bg:       "#19221c",   // メイン背景
  bgCard:   "#222e26",   // カード・パネル
  bgHover:  "#283624",   // ホバー
  // ボーダー
  border:   "#33483a",
  borderHi: "#45634e",
  // テキスト
  text:     "#e4f2e8",   // メイン
  textSub:  "#94c4a4",   // サブ
  textDim:  "#5e8a6e",   // 控えめ
  // アクセント
  accent:   "#5dd68a",
  accentBg: "#18321f",
  accentBd: "#3d9055",
  // セマンティック
  green:    "#4fe090",
  warn:     "#d4b84a",
  warnBg:   "#2c2808",
  warnBd:   "#5a4a14",
  err:      "#e06060",
  errBg:    "#2a1212",
  errBd:    "#602020",
  // ナビ
  navBg:    "#1f2c22",
  navBd:    "#33483a",
};

// フォントサイズ定数
export const FS = {
  xs:   11,
  sm:   13,
  md:   15,
  lg:   18,
  xl:   22,
  // 数値入力用（大きめ）
  num:  28,
  numLg: 36,
};
