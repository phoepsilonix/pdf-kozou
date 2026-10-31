// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/pdfBackend.ts — PDF 操作の実装エンジン (lopdf / MuPDF) の選択の永続化とコアへの反映
//
//   auto  : lopdf を試し、失敗したら MuPDF へフォールバック
//   mupdf : lopdf を使わず、従来の MuPDF 実装だけを使う (既定)
//   lopdf : lopdf だけを使う。失敗はフォールバックせずエラーにする
//           (MuPDF への依存がどの操作に残っているかを調べる検証用)
//
// 描画エンジン (lib/renderEngine.ts) とは独立した設定。

import { useSyncExternalStore } from "react";
import { getBackendInfo, setPdfBackendCore } from "./tauri";

export type PdfBackend = "auto" | "mupdf" | "lopdf";

const STORAGE_KEY = "pdf-kozou-pdf-backend";
const ALL: PdfBackend[] = ["auto", "mupdf", "lopdf"];

function isBackend(v: unknown): v is PdfBackend {
  return typeof v === "string" && (ALL as string[]).includes(v);
}

interface State {
  backend: PdfBackend;
  available: PdfBackend[];
}

let state: State = { backend: "mupdf", available: [] };
const listeners = new Set<() => void>();

function emit(next: State) {
  state = next;
  for (const l of listeners) l();
}

function loadSaved(): PdfBackend | null {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (isBackend(s)) return s;
  } catch {}
  return null;
}

/** 起動時に一度呼ぶ。保存済みの選択をコアへ反映する (保存値が無ければコアの既定に従う) */
export async function initPdfBackend(): Promise<void> {
  try {
    const info = await getBackendInfo();
    const available = info.available.filter(isBackend);
    const saved = loadSaved();
    let backend: PdfBackend = isBackend(info.current) ? info.current : "mupdf";
    if (saved && available.includes(saved)) {
      backend = saved;
      await setPdfBackendCore(saved);
    }
    emit({ backend, available });
  } catch {
    // ブラウザ単体 (vite dev) など Tauri 外: 選択肢なし
    emit({ backend: "mupdf", available: [] });
  }
}

export async function changePdfBackend(backend: PdfBackend): Promise<void> {
  if (!state.available.includes(backend) || backend === state.backend) return;
  await setPdfBackendCore(backend);
  try {
    localStorage.setItem(STORAGE_KEY, backend);
  } catch {}
  emit({ ...state, backend });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function usePdfBackend(): State {
  return useSyncExternalStore(subscribe, () => state);
}
