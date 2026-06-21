// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/typography.ts — 役割ベースの共有タイプスケール（フォントサイズの単一情報源）
//
// 画面間でフォントサイズの統一感を出すため、各画面はこのトークンを参照する。
// 後から 1 か所の数値を変えるだけで全画面へ反映できる（＝微調整しやすい仕組み）。
//
// 将来、テーマやロケール(JP/EN)で最適サイズが異なる場合は LOCALE_SCALE /
// fontSize() 経由で倍率調整できるようにしてある（現状は等倍）。
//
// 注: アプリ全体の「表示サイズ」設定（uiScale）は #root の zoom で別途かかるため、
//     ここでは“等倍時の基準px”だけを定義する。両者は独立して合成される。

export type TypeRole =
  | "caption" // 補助・注釈（最小可読サイズの床）
  | "small" // 小ラベル・メタ情報
  | "body" // 本文・標準ラベル
  | "label" // 強調ラベル・小見出し
  | "subtitle" // セクション見出し・カード見出し（中位の見出し）
  | "title" // 各画面の先頭タイトル（ページ見出し）
  | "heading" // セクション大見出し
  | "display"; // ブランド等の特大表示

// 基準スケール(px)。実使用のクラスタに合わせて定義。
// title=18 はホーム画面の見出し（空状態タイトル）と一致させ、画面間の統一感を出す。
export const TYPE_SCALE: Record<TypeRole, number> = {
  caption: 11,
  small: 12,
  body: 13,
  label: 14,
  subtitle: 16,
  title: 18,
  heading: 20,
  display: 52,
};

// ロケール別の微調整倍率（将来 JP/EN で最適サイズが異なる場合に使用）。既定は等倍。
//
// 【JP/EN の特性メモ（横幅が主な論点。縦はほぼ影響なし）】
//   - 日本語: 字数は少なめだが全角で 1 文字が広い
//   - 英語  : 字数は多めだが 1 文字は狭い
//   → 同じ要素でも JP と EN で必要な横幅が大きく変わる。とくに「日本語で
//     文字数が多いラベル」が横にあふれやすく要注意。
//   font-size を下げると縦も一緒に縮むため、横幅対策の第一手はフォントサイズ
//   ではなく、レイアウト側（min-width:0 / ellipsis / 折り返し / 余白）で吸収する。
//   LOCALE_SCALE はあくまで最終手段の微調整として残す。
export const LOCALE_SCALE: Record<string, number> = { ja: 1, en: 1 };

/** ロケールを考慮したフォントサイズ(px)。現状は等倍。 */
export function fontSize(role: TypeRole, locale?: string): number {
  const m = (locale && LOCALE_SCALE[locale]) || 1;
  return Math.round(TYPE_SCALE[role] * m);
}

/** 静的参照用（ロケール非依存）。インラインスタイルで `FS.title` のように使う。 */
export const FS: Record<TypeRole, number> = TYPE_SCALE;
