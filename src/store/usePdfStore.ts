// src/store/usePdfStore.ts
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PdfInfo, TrimMargins } from "../lib/tauri";

export type ImpositionMode = "1up" | "2up" | "4up" | "booklet" | "booklet-rtl";

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
  /** ユーザーが明示指定した GS 実行ファイルのパス（空文字列 = 未指定） */
  customGsPath: string;
  setCustomGsPath: (path: string) => void;

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

  // --- 変換レイアウト設定（DOCX/EPUB/HTML等リフロー文書用）---
  convertLayoutW: number;
  convertLayoutH: number;
  convertLayoutEm: number;
  setConvertLayout: (w: number, h: number, em: number) => void;

  // --- 標準ページサイズ設定（画像→PDF/画像変換時に適用）---
  // 画像はページサイズ情報を持たないため、この設定で出力ページサイズを決める。
  // PDF入力など既にサイズが確定しているものには適用しない。
  pageSizeId: import("../lib/pageSize").PageSizeId;
  pageOrientation: import("../lib/pageSize").PageOrientation;
  impositionMode: ImpositionMode;
  setPageSize: (
    id: import("../lib/pageSize").PageSizeId,
    orientation: import("../lib/pageSize").PageOrientation,
  ) => void;
  setImpositionMode: (mode: ImpositionMode) => void;
  setOrientation: (orientation: import("../lib/pageSize").PageOrientation) => void;
  /// 特定ファイルのページ数を更新（レイアウト変更後に呼ぶ）
  updatePageCount: (path: string, pageCount: number) => void;

  /// 機能ごとのプレビュー表示フラグ（未設定 = true 扱い）
  previewEnabled: Record<string, boolean>;
  setPreviewEnabled: (page: string, enabled: boolean) => void;
  autoDetectOrientation: (info: PdfInfo | FileEntry[] | null) => "portrait" | "landscape";

  /// レイアウト切り替え（設定/プレビューの横並び・縦積み）を手動で強制するか。
  /// "auto" = 画面幅で自動判定（既定）、"narrow" = 常に縦積み、"wide" = 常に横並び
  layoutModeOverride: "auto" | "narrow" | "wide";
  setLayoutModeOverride: (mode: "auto" | "narrow" | "wide") => void;
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
      useGsPreference: true,
      setUseGsPreference: (v) => set({ useGsPreference: v }),
      activeCompressMode: "mupdf",
      setActiveCompressMode: (mode) => set({ activeCompressMode: mode }),
      initCompressMode: () => {
        const { gsAvailable, useGsPreference } = get();
        set({ activeCompressMode: gsAvailable && useGsPreference ? "gs" : "mupdf" });
      },
      customGsPath: "",
      setCustomGsPath: (path) => set({ customGsPath: path }),

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

      convertLayoutW: 450,
      convertLayoutH: 600,
      convertLayoutEm: 12,
      setConvertLayout: (w, h, em) =>
        set({ convertLayoutW: w, convertLayoutH: h, convertLayoutEm: em }),

      pageSizeId: "A4",
      pageOrientation: "auto",
      impositionMode: "1up",
      setPageSize: (id, orientation) => {
        set((state) => {
          return {
            pageSizeId: id,
            pageOrientation: orientation,
          };
        });
      },
      setImpositionMode: (mode) => set({ impositionMode: mode }),
      setOrientation: (orientation) => set({ pageOrientation: orientation }),

      updatePageCount: (path, pageCount) =>
        set((s) => ({
          fileList: s.fileList.map((f) => (f.path === path ? { ...f, pageCount } : f)),
        })),

      previewEnabled: {},
      setPreviewEnabled: (page, enabled) =>
        set((s) => ({ previewEnabled: { ...s.previewEnabled, [page]: enabled } })),

      layoutModeOverride: "auto",
      setLayoutModeOverride: (mode) => set({ layoutModeOverride: mode }),
      // 自動向き判定
      autoDetectOrientation: (input) => {
        let aspects: number[] = [];
        if (Array.isArray(input)) {
          input.forEach((f) => {
            if (f.pageCount && f.pageCount > 0) aspects.push(1.0); // 簡易
          });
        } else if (input && "pages" in input) {
          (input as PdfInfo).pages.forEach((p) => {
            const w = p.rotate === 90 || p.rotate === 270 ? p.h : p.w;
            const h = p.rotate === 90 || p.rotate === 270 ? p.w : p.h;
            aspects.push(w / h);
          });
        }
        if (aspects.length === 0) return "portrait";
        const median = aspects.sort((a, b) => a - b)[Math.floor(aspects.length / 2)];
        return median > 1.05 ? "landscape" : "portrait";
      },
    }),
    {
      name: "pdf-kozou-storage",
      partialize: (state) => ({
        useGsPreference: state.useGsPreference,
        customGsPath: state.customGsPath,
        lastSaveDir: state.lastSaveDir,
        convertLayoutW: state.convertLayoutW,
        convertLayoutH: state.convertLayoutH,
        convertLayoutEm: state.convertLayoutEm,
        pageSizeId: state.pageSizeId,
        pageOrientation: state.pageOrientation,
        impositionMode: state.impositionMode,
        previewEnabled: state.previewEnabled,
        layoutModeOverride: state.layoutModeOverride,
      }),
    },
  ),
);
