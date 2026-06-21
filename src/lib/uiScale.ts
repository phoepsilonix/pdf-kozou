// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/uiScale.ts — アプリ全体の表示スケール（フォントサイズ含む）の永続化と適用
//
// 画面サイズに応じて UI 全体を比率で拡大／縮小する。px 固定レイアウトの
// 比率を崩さないよう、CSS の `zoom` を html 要素へ適用する方式を採用。
// これによりフォント・余白・アイコンが同じ倍率で拡大縮小され、
// レイアウトを維持したまま見やすさ・扱いやすさを調整できる。

export const UI_SCALE_MIN = 80; // %
export const UI_SCALE_MAX = 150; // %
export const UI_SCALE_STEP = 5; // %
export const UI_SCALE_DEFAULT = 100; // %

const STORAGE_KEY = "pdf-kozou-ui-scale";

/** 値を 5% 刻みにスナップし、許容範囲へ収める */
export function clampUiScale(pct: number): number {
  if (!Number.isFinite(pct)) return UI_SCALE_DEFAULT;
  const snapped = Math.round(pct / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, snapped));
}

export function loadUiScale(): number {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s != null) {
      const n = parseInt(s, 10);
      if (Number.isFinite(n)) return clampUiScale(n);
    }
  } catch {}
  return UI_SCALE_DEFAULT;
}

export function saveUiScale(pct: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(clampUiScale(pct)));
  } catch {}
}

/**
 * #root 要素へ zoom を適用し、寸法を 1/scale で補正する。
 *
 * `zoom: S` を掛けると要素は描画上 S 倍に拡大されるため、`100vh`/`100vw` を
 * そのまま使うと画面からはみ出してしまう（縦に溢れて画面下部固定のボタンが
 * 隠れる）。そこで #root の寸法を `calc(100vh / S)` 等に補正すると、ズーム後に
 * ちょうど「画面1枚分」として描画される。これによりアプリの外枠は常に
 * ビューポートにロックされ、内側の設定リストだけがスクロールし、下部固定の
 * 実行ボタンは全ズーム率で常時表示されたまま、文字・余白のみが拡大される。
 *
 * `zoom` は WebKit/Blink で実装されており Tauri(WebKitGTK/WKWebView) で動作する。
 * 型定義に zoom が無いため any 経由で設定する。
 */
export function applyUiScale(pct: number) {
  if (typeof document === "undefined") return;
  const scale = clampUiScale(pct) / 100;
  const root = document.getElementById("root");
  if (!root) return;
  const style = root.style as any;
  style.zoom = String(scale);
  style.width = `calc(100vw / ${scale})`;
  style.height = `calc(100vh / ${scale})`;
  // 補正後の高さを超えるコンテンツ（ホーム画面など）は #root 内でスクロールさせる
  style.overflow = "auto";
}

/** 永続化された値を読み込んで即時適用する（起動時に呼ぶ） */
export function initUiScale(): number {
  const pct = loadUiScale();
  applyUiScale(pct);
  return pct;
}
