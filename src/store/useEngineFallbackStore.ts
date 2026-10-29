// src/store/useEngineFallbackStore.ts
// 描画エンジン "auto" で hayro から MuPDF へフォールバックした記録。
// コアが送る `engine-fallback` イベント (lib/engineFallback.ts) を溜め、
// 画面右下の通知 (EngineFallbackToast) とバッチ処理のログ (EngineFallbackLog) が読む。
//
// ビューアは 1 ページごとに描画するため、同じ原因で何十件も通知が来る。
// (ファイル, 処理, 理由) が同じものは 1 件にまとめ、回数とページ番号を持たせる。

import { create } from "zustand";

export interface EngineFallbackPayload {
  /** "render" / "rasterize" / "rasterize_no_text" / "keep-text" / "imposition" / "rasterize_imposition" */
  op: string;
  file: string | null;
  /** 0 始まり */
  page: number | null;
  reason: string;
}

export interface EngineFallbackEntry {
  key: string;
  op: string;
  file: string | null;
  reason: string;
  /** まとめた件数 */
  count: number;
  /** 0 始まりのページ番号 (昇順・重複なし) */
  pages: number[];
  /** 通知バナーを閉じたか (ログには残る) */
  dismissed: boolean;
}

/** ログに残す最大件数。超えたら古いものから捨てる */
const MAX_ENTRIES = 200;

interface EngineFallbackState {
  entries: EngineFallbackEntry[];
  /** バッチ処理中は右下の通知を出さない (ファイルごとの進捗行に出すため) */
  toastSuppressed: boolean;
  add: (p: EngineFallbackPayload) => void;
  dismiss: (key: string) => void;
  clear: () => void;
  /** 溜まっている記録を取り出して空にする。バッチで 1 ファイルの処理が終わるたびに呼ぶ */
  take: () => EngineFallbackEntry[];
  setToastSuppressed: (v: boolean) => void;
}

export const useEngineFallbackStore = create<EngineFallbackState>((set, get) => ({
  entries: [],
  toastSuppressed: false,
  add: (p) =>
    set((s) => {
      const key = `${p.file ?? ""}\u0000${p.op}\u0000${p.reason}`;
      const i = s.entries.findIndex((e) => e.key === key);
      if (i >= 0) {
        const cur = s.entries[i];
        const pages =
          p.page !== null && !cur.pages.includes(p.page)
            ? [...cur.pages, p.page].sort((a, b) => a - b)
            : cur.pages;
        const next = [...s.entries];
        // 同じ原因が再び起きたので、閉じていても通知を出し直す
        next[i] = { ...cur, count: cur.count + 1, pages, dismissed: false };
        return { entries: next };
      }
      const entry: EngineFallbackEntry = {
        key,
        op: p.op,
        file: p.file,
        reason: p.reason,
        count: 1,
        pages: p.page !== null ? [p.page] : [],
        dismissed: false,
      };
      return { entries: [...s.entries, entry].slice(-MAX_ENTRIES) };
    }),
  dismiss: (key) =>
    set((s) => ({
      entries: s.entries.map((e) => (e.key === key ? { ...e, dismissed: true } : e)),
    })),
  clear: () => set({ entries: [] }),
  take: () => {
    const taken = get().entries;
    if (taken.length > 0) set({ entries: [] });
    return taken;
  },
  setToastSuppressed: (v) => set({ toastSuppressed: v }),
}));
