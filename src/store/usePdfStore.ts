// src/store/usePdfStore.ts
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PdfInfo, TrimMargins } from "../lib/tauri";

export interface FileEntry {
  id: number;
  path: string;
  filename: string;
  pageCount: number;
  sizeBytes: number;
  selected: boolean;
}

let _entryId = 1;
export function makeEntryId() {
  return _entryId++;
}

interface PdfStore {
  fileList: FileEntry[];
  addFiles: (entries: Omit<FileEntry, "id">[]) => void;
  removeFile: (id: number) => void;
  toggleSelect: (id: number) => void;
  selectAll: () => void;
  selectNone: () => void;
  clearList: () => void;
  reorderFiles: (fromId: number, toId: number) => void;

  filePath: string | null;
  pdfInfo: PdfInfo | null;
  setFile: (path: string, info: PdfInfo) => void;
  clearFile: () => void;

  // --- GS管理 ---
  gsAvailable: boolean;
  setGsAvailable: (v: boolean) => void;
  useGsPreference: boolean;
  setUseGsPreference: (v: boolean) => void;
  activeCompressMode: "mupdf" | "gs";
  setActiveCompressMode: (mode: "mupdf" | "gs") => void;
  initCompressMode: () => void;

  trimMargins: TrimMargins;
  setTrimMargins: (m: TrimMargins) => void;
  previewPage: number;
  setPreviewPage: (n: number) => void;
  lastSaveDir: string | null;
  setLastSaveDir: (dir: string) => void;
  isProcessing: boolean;
  setProcessing: (v: boolean) => void;
  lastError: string | null;
  setError: (e: string | null) => void;
  resetTrimState: () => void;
}

export const usePdfStore = create<PdfStore>()(
  persist(
    (set, get) => ({
      fileList: [],
      addFiles: (entries) =>
        set((s) => {
          const existing = new Set(s.fileList.map((f) => f.path));
          const fresh = entries
            .filter((e) => !existing.has(e.path))
            .map((e) => ({ ...e, id: makeEntryId() }));
          return { fileList: [...s.fileList, ...fresh] };
        }),
      removeFile: (id) => set((s) => ({ fileList: s.fileList.filter((f) => f.id !== id) })),
      toggleSelect: (id) =>
        set((s) => ({
          fileList: s.fileList.map((f) => (f.id === id ? { ...f, selected: !f.selected } : f)),
        })),
      selectAll: () =>
        set((s) => ({ fileList: s.fileList.map((f) => ({ ...f, selected: true })) })),
      selectNone: () =>
        set((s) => ({ fileList: s.fileList.map((f) => ({ ...f, selected: false })) })),
      clearList: () => set({ fileList: [] }),
      reorderFiles: (fromId, toId) =>
        set((s) => {
          const arr = [...s.fileList];
          const fi = arr.findIndex((f) => f.id === fromId);
          const ti = arr.findIndex((f) => f.id === toId);
          if (fi < 0 || ti < 0 || fi === ti) return {};
          const [item] = arr.splice(fi, 1);
          arr.splice(ti, 0, item);
          return { fileList: arr };
        }),

      filePath: null,
      pdfInfo: null,
      setFile: (path, info) => set({ filePath: path, pdfInfo: info }),
      clearFile: () => set({ filePath: null, pdfInfo: null }),

      // GS初期化
      gsAvailable: false,
      setGsAvailable: (v) => set({ gsAvailable: v }),
      useGsPreference: false,
      setUseGsPreference: (v) => set({ useGsPreference: v }),
      activeCompressMode: "mupdf",
      setActiveCompressMode: (mode) => set({ activeCompressMode: mode }),
      initCompressMode: () => {
        const { gsAvailable, useGsPreference } = get();
        set({ activeCompressMode: gsAvailable && useGsPreference ? "gs" : "mupdf" });
      },

      trimMargins: { left: 0, right: 0, top: 0, bottom: 0 },
      setTrimMargins: (m) => set({ trimMargins: m }),
      previewPage: 0,
      setPreviewPage: (n) => set({ previewPage: n }),
      lastSaveDir: null,
      setLastSaveDir: (dir) => set({ lastSaveDir: dir }),
      isProcessing: false,
      setProcessing: (v) => set({ isProcessing: v }),
      lastError: null,
      setError: (e) => set({ lastError: e }),
      resetTrimState: () => set({ trimMargins: { left: 0, right: 0, top: 0, bottom: 0 } }),
    }),
    {
      name: "pdf-kozou-storage",
      partialize: (state) => ({
        useGsPreference: state.useGsPreference,
        lastSaveDir: state.lastSaveDir,
      }),
    },
  ),
);
