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
 * #root 要素へ zoom を適用し、position:fixed; inset:0 でビューポートへ直接固定する。
 *
 * `zoom: S` を掛けると要素は描画上 S 倍に拡大される。以前は #root の width/height を
 * JS で `documentElement.clientWidth/Height / S` として計算し px で固定していたが、
 * この方式は「JSで計測した瞬間のビューポート寸法」に依存しており、OSのDPI設定や
 * ウィンドウ装飾、レンダリングエンジンの内部タイミングによって実際のビューポートと
 * 数px ズレることがあり、そのズレがそのままスクロールバーとして露出していた
 * （Linux・Windows 両方で報告された＝JS計測依存に起因する構造的な問題）。
 *
 * `position: fixed; inset: 0` を使うと、JS計測を介さずブラウザのレイアウトエンジンが
 * 直接「ビューポートぴったり」のサイズを算出してくれる。`zoom` は fixed 要素の
 * 位置決定（ビューポート基準）には影響しないため、内側のコンテンツ座標系だけが
 * 1/S に圧縮された状態で fixed の枠内に収まる。これにより JS 側の計測誤差が
 * 原理的に発生しなくなる。
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

  // #root を viewport に直接固定する。
  // 旧実装は documentElement.clientWidth/Height を JS で計測し、
  // それを 1/scale した px 値を width/height に書き込んでいた。
  // これは「計測した瞬間のビューポート寸法」を前提にしており、
  // OSのDPIスケーリング・ウィンドウのpadding・スクロールバー領域の扱いが
  // 環境（WebKitGTK/WebView2/OS設定）によって異なると数px〜のズレが生じ、
  // そのズレがそのままスクロールバー表示として露出していた
  // （Linux/Windows 両方で報告されたのはこのため＝JS計測依存の構造的な問題）。
  //
  // 代わりに `position: fixed; inset: 0` でビューポートそのものに張り付け、
  // 寸法計算をブラウザのレイアウトエンジンに完全に委ねる。
  // zoom は描画スケールのみを変えるため、fixed要素の位置決定（ビューポート基準）
  // には影響しない。これにより JS 側の計測誤差が原理的に発生しなくなる。
  style.position = "fixed";
  style.inset = "0";
  style.width = "";
  style.height = "";
  style.zoom = String(_scale);

  // 縦横ともスクロールバーを出さない。
  // ホーム画面ではコンテンツをビューポートに収める設計とし、
  // ファイル一覧が溢れる場合は listCard 側の max-height で制御する。
  // ツール画面は flex:1+overflow:hidden の内部レイアウトが受け持つ。
  style.overflowY = "hidden";
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
