// src/store/useGidFixNoticeStore.ts
// GID 補正がオフのとき、補正が必要なファイルを開いた (情報を読んだ) ことを溜め、GidFixNotice が
// 画面に通知する。ファイルごとには出さず、件数にまとめる。

import { create } from "zustand";

interface GidFixNoticeState {
  /** 補正が必要なファイル (パス → フォントの数) */
  entries: Record<string, number>;
  /** ✕ で閉じた (新しいファイルが加わると、また出す) */
  dismissed: boolean;
  note: (path: string, count: number) => void;
  dismiss: () => void;
  clear: () => void;
}

export const useGidFixNoticeStore = create<GidFixNoticeState>((set, get) => ({
  entries: {},
  dismissed: false,
  note: (path, count) => {
    const cur = get().entries;
    if (cur[path] === count) return;
    set({
      entries: { ...cur, [path]: count },
      dismissed: cur[path] === undefined ? false : get().dismissed,
    });
  },
  dismiss: () => set({ dismissed: true }),
  clear: () => set({ entries: {}, dismissed: false }),
}));
