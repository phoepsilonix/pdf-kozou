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
 * `zoom: S` を掛けると要素は描画上 S 倍に拡大されるため、ビューポートいっぱい
 * のサイズをそのまま使うと画面からはみ出す（縦に溢れて画面下部固定のボタンが
 * 隠れる／横に溢れる）。そこで #root の寸法を 1/S に補正すると、ズーム後に
 * ちょうど「画面1枚分」として描画される。これによりアプリの外枠は常に
 * ビューポートにロックされ、内側の設定リストだけがスクロールし、下部固定の
 * 実行ボタンは全ズーム率で常時表示されたまま、文字・余白のみが拡大される。
 *
 * 補正に CSS の `calc(100vw / S)` を使うと、`vw`/`vh` と `zoom` の解決順序が
 * レンダリングエンジンで異なる（Blink/WebView2 と WebKitGTK で挙動が違い、
 * Linux では右側に隙間が空きスクロールバーが内側にずれる）。そのため
 * `documentElement.clientWidth/clientHeight`（スクロールバーを除く実ピクセル）
 * から px で寸法を算出する。px は zoom がそのまま倍率を掛けるため、両エンジンで
 * 一致する。ウィンドウサイズ変更時は resize で再適用する。
 *
 * `zoom` は WebKit/Blink で実装されており Tauri(WebKitGTK/WKWebView) で動作する。
 * 型定義に zoom が無いため any 経由で設定する。
 */

// 現在 #root に適用されている zoom 倍率（1.0 = 100%）。
// #root に zoom がかかっていると getBoundingClientRect() は視覚（ズーム済み）
// 座標を返す一方、MouseEvent.clientX も視覚座標なので、
// `clientX - rect.left` は「視覚px」になる。これを canvas など内部座標
// （ズーム前 CSS px）へ戻すには、この倍率で割る必要がある。
let _scale = 1;
let _resizeBound = false;

export function applyUiScale(pct: number) {
  if (typeof document === "undefined") return;
  _scale = clampUiScale(pct) / 100;
  applyToRoot();
  bindResize();
}

function applyToRoot() {
  if (typeof document === "undefined") return;
  const root = document.getElementById("root");
  if (!root) return;
  const style = root.style as any;

  // 一時的に overflow を hidden にして scrollbar を消した状態で
  // clientWidth/Height を計測する（scrollbar 幅の影響を排除するため）。
  style.overflowX = "hidden";
  style.overflowY = "hidden";

  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  style.zoom = String(_scale);
  // Math.floor で端数を切り捨て、zoom 後にビューポートを 1px もはみ出さないようにする
  style.width = `${Math.floor(vw / _scale)}px`;
  style.height = `${Math.floor(vh / _scale)}px`;

  // 縦方向のみスクロールを許可し、横スクロールバーは常に非表示にする。
  // overflow:"auto" だと 1px の計算誤差でも横スクロールバーが出て
  // 内側が狭まりさらに縦スクロールバーが出る悪循環が起きる（Linux 特に顕著）。
  style.overflowY = "auto";
  style.overflowX = "hidden";
}

function bindResize() {
  if (_resizeBound || typeof window === "undefined") return;
  _resizeBound = true;
  window.addEventListener("resize", applyToRoot);
}

/** 現在適用中の表示倍率（1.0 = 100%）を返す */
export function getUiScale(): number {
  return _scale;
}

/** 永続化された値を読み込んで即時適用する（起動時に呼ぶ） */
export function initUiScale(): number {
  const pct = loadUiScale();
  applyUiScale(pct);
  return pct;
}
