// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/hayroJpeg.ts — hayro 描画結果の JPEG エンコード設定の永続化とコアへの反映
//
//   subsampling : 色差サブサンプリング。444 (既定。色付きの細線の色にじみを避ける) / 420 (小さい)
//   trellis     : トレリス量子化 (既定はオン。遅くなるが、サイズ・画質のバランスが良くなる)
//
// 画像変換 (画像書き出し・画像化 PDF・面付け・テキスト保持版) に反映される。
// ビューワーの描画には、トレリスだけは使わない (ページ送りを遅くしないため)。
// 描画エンジン (lib/renderEngine.ts) が hayro / auto のときだけ意味を持つ。

import { useSyncExternalStore } from "react";
import { getHayroJpegInfo, setHayroJpegCore } from "./tauri";

export type JpegSubsampling = 444 | 420;

const STORAGE_KEY = "pdf-kozou-hayro-jpeg";

interface State {
  subsampling: JpegSubsampling;
  trellis: boolean;
}

let state: State = { subsampling: 444, trellis: true };
const listeners = new Set<() => void>();

function emit(next: State) {
  state = next;
  for (const l of listeners) l();
}

function toSpec(s: State): string {
  return s.trellis ? `${s.subsampling},trellis` : String(s.subsampling);
}

function loadSaved(): State | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<State>;
    if (v.subsampling !== 444 && v.subsampling !== 420) return null;
    return { subsampling: v.subsampling, trellis: v.trellis === true };
  } catch {
    return null;
  }
}

function save(s: State) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

/**
 * 起動時に一度呼ぶ。保存済みの選択をコアへ反映する。
 * 保存値が無ければコアの既定 (環境変数 PDF_KOZOU_JPEG_SUBSAMPLING / PDF_KOZOU_JPEG_TRELLIS を含む) に従う。
 */
export async function initHayroJpeg(): Promise<void> {
  try {
    const saved = loadSaved();
    if (saved) {
      await setHayroJpegCore(toSpec(saved));
      emit(saved);
      return;
    }
    const info = await getHayroJpegInfo();
    emit({
      subsampling: info.subsampling === 420 ? 420 : 444,
      trellis: info.trellis,
    });
  } catch {
    // ブラウザ単体 (vite dev) など Tauri 外: 既定のまま
  }
}

/** 設定を変更する。省略した項目は直前の値を使う */
export async function changeHayroJpeg(change: Partial<State>): Promise<void> {
  const next: State = {
    subsampling: change.subsampling ?? state.subsampling,
    trellis: change.trellis ?? state.trellis,
  };
  if (next.subsampling === state.subsampling && next.trellis === state.trellis) return;
  await setHayroJpegCore(toSpec(next));
  save(next);
  emit(next);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useHayroJpeg(): State {
  return useSyncExternalStore(subscribe, () => state);
}
