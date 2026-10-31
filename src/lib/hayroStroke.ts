// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/hayroStroke.ts — hayro の細線・文字の太らせ補正の選択の永続化とコアへの反映
//
// 1 画素に満たない線を太らせる補正を、パス (path) と文字の輪郭線 (text) で別々に持つ。
//   on     : 推奨値 (既定)。パス 0.3px / 文字 0.25px
//   off    : 太らせない (両方 0)
//   custom : パス・文字それぞれの最小線幅を数値で指定 (0 なら太らせない)
//
// 描画エンジン (lib/renderEngine.ts) が hayro / auto のときだけ意味を持つ。

import { useSyncExternalStore } from "react";
import { getHayroStrokeInfo, setHayroStrokeCore } from "./tauri";

export type HayroStrokeMode = "on" | "off" | "custom";

const STORAGE_KEY = "pdf-kozou-hayro-stroke";
export const CUSTOM_MIN = 0;
export const CUSTOM_MAX = 4;

interface State {
  mode: HayroStrokeMode;
  /** custom のときの画素幅 (他のモードでも、直前のカスタム値を保持する) */
  customPath: number;
  customText: number;
  /** 「オン」の画素幅 (表示用) */
  recommendedPath: number;
  recommendedText: number;
}

let state: State = {
  mode: "on",
  customPath: 0.2,
  customText: 0.2,
  recommendedPath: 0.3,
  recommendedText: 0.25,
};
const listeners = new Set<() => void>();

function emit(next: State) {
  state = next;
  for (const l of listeners) l();
}

function clampWidth(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(CUSTOM_MAX, Math.max(CUSTOM_MIN, Math.round(n * 100) / 100));
}

function toSpec(mode: HayroStrokeMode, path: number, text: number): string {
  return mode === "custom" ? `${path},${text}` : mode;
}

interface Saved {
  mode: HayroStrokeMode;
  customPath: number;
  customText: number;
}

function loadSaved(): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Saved>;
    const mode = v.mode === "on" || v.mode === "off" || v.mode === "custom" ? v.mode : null;
    if (!mode) return null;
    return {
      mode,
      customPath: clampWidth(Number(v.customPath), 0.2),
      customText: clampWidth(Number(v.customText), 0.2),
    };
  } catch {
    return null;
  }
}

function save(s: Saved) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

/**
 * 起動時に一度呼ぶ。保存済みの選択をコアへ反映する。
 * 保存値が無ければコアの既定 (環境変数 PDF_KOZOU_HAYRO_MIN_STROKE を含む) に従う。
 */
export async function initHayroStroke(): Promise<void> {
  try {
    const info = await getHayroStrokeInfo();
    const recommendedPath = info.recommended_path;
    const recommendedText = info.recommended_text;
    const saved = loadSaved();
    if (saved) {
      await setHayroStrokeCore(toSpec(saved.mode, saved.customPath, saved.customText));
      emit({ ...saved, recommendedPath, recommendedText });
      return;
    }
    const mode: HayroStrokeMode = info.mode === "off" || info.mode === "custom" ? info.mode : "on";
    emit({
      mode,
      customPath: mode === "custom" ? info.path : state.customPath,
      customText: mode === "custom" ? info.text : state.customText,
      recommendedPath,
      recommendedText,
    });
  } catch {
    // ブラウザ単体 (vite dev) など Tauri 外: 既定のまま
  }
}

/** モード (と、カスタムのときはパス/文字の値) を変更する。値を省略した側は直前の値を使う */
export async function changeHayroStroke(
  mode: HayroStrokeMode,
  custom?: { path?: number; text?: number },
): Promise<void> {
  const customPath = clampWidth(custom?.path ?? state.customPath, state.customPath);
  const customText = clampWidth(custom?.text ?? state.customText, state.customText);
  if (mode === state.mode && customPath === state.customPath && customText === state.customText) {
    return;
  }
  await setHayroStrokeCore(toSpec(mode, customPath, customText));
  save({ mode, customPath, customText });
  emit({ ...state, mode, customPath, customText });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useHayroStroke(): State {
  return useSyncExternalStore(subscribe, () => state);
}
