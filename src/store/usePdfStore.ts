// src/store/usePdfStore.ts
import { create } from "zustand";
import type { PdfInfo, TrimMargins, PageSelection } from "../lib/tauri";

interface PdfStore {
  // ── 現在開いているファイル ─────────────────────────────────────────────────
  filePath:   string | null;
  pdfInfo:    PdfInfo | null;
  setFile:    (path: string, info: PdfInfo) => void;
  clearFile:  () => void;

  // ── トリミング状態 ─────────────────────────────────────────────────────────
  trimMargins:    TrimMargins;
  trimPages:      PageSelection;
  setTrimMargins: (m: Partial<TrimMargins>) => void;
  setTrimPages:   (p: PageSelection) => void;
  resetTrim:      (pageW: number, pageH: number) => void;

  // ── プレビュー対象ページ ───────────────────────────────────────────────────
  previewPage:    number;  // 0-indexed
  setPreviewPage: (n: number) => void;

  // ── UI 状態 ────────────────────────────────────────────────────────────────
  isProcessing:    boolean;
  setProcessing:   (v: boolean) => void;
  lastError:       string | null;
  setError:        (e: string | null) => void;
}

export const usePdfStore = create<PdfStore>((set) => ({
  filePath:  null,
  pdfInfo:   null,
  setFile:  (path, info) => set({ filePath: path, pdfInfo: info }),
  clearFile: () => set({ filePath: null, pdfInfo: null }),

  trimMargins: { left: 0, right: 595, bottom: 0, top: 842 }, // A4 デフォルト
  trimPages:   { type: "All" },
  setTrimMargins: (m) =>
    set((s) => ({ trimMargins: { ...s.trimMargins, ...m } })),
  setTrimPages: (p) => set({ trimPages: p }),
  resetTrim: (pageW, pageH) =>
    set({ trimMargins: { left: 0, right: pageW, bottom: 0, top: pageH } }),

  previewPage:    0,
  setPreviewPage: (n) => set({ previewPage: n }),

  isProcessing:  false,
  setProcessing: (v) => set({ isProcessing: v }),
  lastError:     null,
  setError:      (e) => set({ lastError: e }),
}));
