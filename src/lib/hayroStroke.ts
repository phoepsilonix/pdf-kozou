// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/hayroStroke.ts — hayro の細線・文字の太らせ補正の選択の永続化とコアへの反映
//
//   on     : 推奨値 (既定)。極細線が黒く太く見えるのを抑える
//   off    : hayro 本来の挙動 (PDF 仕様どおり 1 画素まで太らせる)
//   custom : 画素幅を数値で指定 (0 なら太らせない)
//
// 文字の輪郭線は hayro 側で min(0.25, 設定値) になるため、0.25 未満を指定したときだけ変わる。
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
  custom: number;
  /** 「オン」の画素幅 (表示用) */
  recommended: number;
}

let state: State = { mode: "on", custom: 0.2, recommended: 0.3 };
const listeners = new Set<() => void>();

function emit(next: State) {
  state = next;
  for (const l of listeners) l();
}

function clampCustom(n: number): number {
  if (!Number.isFinite(n)) return state.custom;
  return Math.min(CUSTOM_MAX, Math.max(CUSTOM_MIN, Math.round(n * 100) / 100));
}

function toSpec(mode: HayroStrokeMode, custom: number): string {
  return mode === "custom" ? String(custom) : mode;
}

interface Saved {
  mode: HayroStrokeMode;
  custom: number;
}

function loadSaved(): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Saved>;
    const mode = v.mode === "on" || v.mode === "off" || v.mode === "custom" ? v.mode : null;
    if (!mode) return null;
    const custom = typeof v.custom === "number" ? v.custom : 0.2;
    return { mode, custom: Math.min(CUSTOM_MAX, Math.max(CUSTOM_MIN, custom)) };
  } catch {
    return null;
  }
}

function save(mode: HayroStrokeMode, custom: number) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, custom }));
  } catch {}
}

/**
 * 起動時に一度呼ぶ。保存済みの選択をコアへ反映する。
 * 保存値が無ければコアの既定 (環境変数 PDF_KOZOU_HAYRO_MIN_STROKE を含む) に従う。
 */
export async function initHayroStroke(): Promise<void> {
  try {
    const info = await getHayroStrokeInfo();
    const saved = loadSaved();
    if (saved) {
      await setHayroStrokeCore(toSpec(saved.mode, saved.custom));
      emit({ mode: saved.mode, custom: saved.custom, recommended: info.recommended });
      return;
    }
    const mode: HayroStrokeMode =
      info.mode === "off" || info.mode === "custom" ? info.mode : "on";
    emit({
      mode,
      custom: mode === "custom" ? info.value : state.custom,
      recommended: info.recommended,
    });
  } catch {
    // ブラウザ単体 (vite dev) など Tauri 外: 既定のまま
  }
}

export async function changeHayroStroke(mode: HayroStrokeMode, custom?: number): Promise<void> {
  const c = clampCustom(custom ?? state.custom);
  if (mode === state.mode && c === state.custom) return;
  await setHayroStrokeCore(toSpec(mode, c));
  save(mode, c);
  emit({ ...state, mode, custom: c });
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
