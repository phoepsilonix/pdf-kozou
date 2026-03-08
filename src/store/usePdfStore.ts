// src/store/usePdfStore.ts
import { create } from "zustand";
import type { PdfInfo, TrimMargins, PageSelection } from "../lib/tauri";

interface PdfStore {
  filePath:  string | null;
  pdfInfo:   PdfInfo | null;
  setFile:   (path: string, info: PdfInfo) => void;
  clearFile: () => void;

  trimMargins:    TrimMargins;
  trimPages:      PageSelection;
  setTrimMargins: (m: TrimMargins) => void;
  setTrimPages:   (p: PageSelection) => void;

  previewPage:    number;
  setPreviewPage: (n: number) => void;

  // 前回の保存先ディレクトリ（セッション内で記憶）
  lastSaveDir:    string | null;
  setLastSaveDir: (dir: string) => void;

  isProcessing:  boolean;
  setProcessing: (v: boolean) => void;
  lastError:     string | null;
  setError:      (e: string | null) => void;
}

export const usePdfStore = create<PdfStore>((set) => ({
  filePath:  null,
  pdfInfo:   null,
  setFile:   (path, info) => set({ filePath: path, pdfInfo: info }),
  clearFile: () => set({ filePath: null, pdfInfo: null }),

  trimMargins: { left: 0, right: 0, top: 0, bottom: 0 },
  trimPages:   { type: "All" },
  setTrimMargins: (m) => set({ trimMargins: m }),
  setTrimPages:   (p) => set({ trimPages: p }),

  previewPage:    0,
  setPreviewPage: (n) => set({ previewPage: n }),

  lastSaveDir:    null,
  setLastSaveDir: (dir) => set({ lastSaveDir: dir }),

  isProcessing:  false,
  setProcessing: (v) => set({ isProcessing: v }),
  lastError:     null,
  setError:      (e) => set({ lastError: e }),
}));
