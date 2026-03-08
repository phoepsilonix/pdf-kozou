// src/lib/theme.ts — アプリ共通デザイントークン
// モスグリーン系：落ち着いた緑みがかった暗背景、さわやかなアクセント

export const F = "'JetBrains Mono','Noto Sans JP',monospace";

export const C = {
  // 背景系 — 深い緑みがかったダーク
  bg:       "#0b0f0d",   // ほぼ黒・緑みあり
  bgCard:   "#111a15",   // カード・パネル
  bgHover:  "#172019",   // ホバー
  // ボーダー
  border:   "#1e2e24",
  borderHi: "#2c4035",
  // テキスト
  text:     "#d6e8dc",   // メイン: やや緑みがかった白
  textSub:  "#7aaa8a",   // サブ: モスグリーン明るめ
  textDim:  "#4a6655",   // 控えめ
  // アクセント — さわやかな黄緑〜エメラルド
  accent:   "#5dd68a",   // メインアクセント（さわやかグリーン）
  accentBg: "#0d2318",
  accentBd: "#2d7a50",
  // セマンティック
  green:    "#4fe090",
  warn:     "#d4b84a",
  warnBg:   "#1e1a08",
  warnBd:   "#4a4010",
  err:      "#e05555",
  errBg:    "#1a0b0b",
  errBd:    "#4a1c1c",
  // ナビ専用（少し明るめの緑みダーク）
  navBg:    "#0e1810",
  navBd:    "#1a2e20",
};

export const SZ = {
  headerH: 50,
  textXS:  11,
  textSM:  13,
  textMD:  15,
  textLG:  18,
  textXL:  22,
};
