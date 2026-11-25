// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/gidFix.ts — GID 補正のオン・オフの永続化とコアへの反映
//
// 文字コードが GID の CID キー付き CFF フォント (Canva の PDF の ◀ ★ など) の charset を、CID = GID の
// 恒等表に直す。字形は変わらず、charset で CID を引くビューワ (MuPDF・Firefox・モバイルのブラウザなど)
// でも文字が表示されるようになる。
//
//   on  : 読み込み時に補正する (既定)。ビューワーの描画・画像化・各機能の出力に反映される
//   off : 補正しない (元のフォントのまま)
//
// PDF 操作エンジン (lib/pdfBackend.ts)・描画エンジン (lib/renderEngine.ts) のどのモードでも、同じ設定で動く。

import { useSyncExternalStore } from "react";
import { getGidFixInfo, setGidFixCore } from "./tauri";

export type GidFixMode = "on" | "off";

const STORAGE_KEY = "pdf-kozou-gid-fix";
const ALL: GidFixMode[] = ["on", "off"];

function isMode(v: unknown): v is GidFixMode {
  return typeof v === "string" && (ALL as string[]).includes(v);
}

interface State {
  mode: GidFixMode;
}

let state: State = { mode: "on" };
const listeners = new Set<() => void>();

function emit(next: State) {
  state = next;
  for (const l of listeners) l();
}

function loadSaved(): GidFixMode | null {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (isMode(s)) return s;
  } catch {}
  return null;
}

/** 起動時に一度呼ぶ。保存済みの選択をコアへ反映する (保存値が無ければコアの既定 = オンに従う) */
export async function initGidFix(): Promise<void> {
  try {
    const info = await getGidFixInfo();
    let mode: GidFixMode = isMode(info.current) ? info.current : "on";
    const saved = loadSaved();
    if (saved && saved !== mode) {
      mode = saved;
      await setGidFixCore(saved);
    }
    emit({ mode });
  } catch {
    // ブラウザ単体 (vite dev) など Tauri 外: 既定のまま
    emit({ mode: "on" });
  }
}

export async function changeGidFix(mode: GidFixMode): Promise<void> {
  if (mode === state.mode) return;
  await setGidFixCore(mode);
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {}
  emit({ mode });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useGidFix(): State {
  return useSyncExternalStore(subscribe, () => state);
}
