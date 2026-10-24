// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/renderEngine.ts — 描画エンジン (MuPDF / hayro) の選択の永続化とコアへの反映
//
//   mupdf : 従来どおり MuPDF で描画 (既定)
//   auto  : hayro (純 Rust) で描画し、失敗・未対応機能のときだけ MuPDF にフォールバック
//   hayro : hayro のみ (失敗はエラー)。比較・検証用
//
// hayro を含まないビルドでは選択肢が "mupdf" だけになり、UI は表示されない。

import { useSyncExternalStore } from "react";
import { getRenderEngineInfo, setRenderEngineCore } from "./tauri";

export type RenderEngine = "mupdf" | "auto" | "hayro";

const STORAGE_KEY = "pdf-kozou-render-engine";
const ALL: RenderEngine[] = ["mupdf", "auto", "hayro"];

function isEngine(v: unknown): v is RenderEngine {
  return typeof v === "string" && (ALL as string[]).includes(v);
}

interface State {
  engine: RenderEngine;
  available: RenderEngine[];
}

let state: State = { engine: "mupdf", available: ["mupdf"] };
const listeners = new Set<() => void>();

function emit(next: State) {
  state = next;
  for (const l of listeners) l();
}

function loadSaved(): RenderEngine | null {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (isEngine(s)) return s;
  } catch {}
  return null;
}

/**
 * 起動時に一度呼ぶ。コアから選べるエンジンを取得し、保存済みの選択をコアへ反映する。
 * 保存値が無ければコアの既定 (環境変数 PDF_KOZOU_RENDER_ENGINE を含む) に従う。
 */
export async function initRenderEngine(): Promise<void> {
  try {
    const info = await getRenderEngineInfo();
    const available = info.available.filter(isEngine);
    const saved = loadSaved();
    let engine: RenderEngine = isEngine(info.current) ? info.current : "mupdf";
    if (saved && available.includes(saved)) {
      engine = saved;
      await setRenderEngineCore(saved);
    }
    emit({ engine, available: available.length ? available : ["mupdf"] });
  } catch {
    // ブラウザ単体 (vite dev) など Tauri 外: 選択肢なし
    emit({ engine: "mupdf", available: ["mupdf"] });
  }
}

export async function changeRenderEngine(engine: RenderEngine): Promise<void> {
  if (!state.available.includes(engine) || engine === state.engine) return;
  await setRenderEngineCore(engine);
  try {
    localStorage.setItem(STORAGE_KEY, engine);
  } catch {}
  emit({ ...state, engine });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useRenderEngine(): State {
  return useSyncExternalStore(subscribe, () => state);
}
