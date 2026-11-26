// src/store/useGidFixConfirmStore.ts
// GID 補正がオフのまま、補正が必要なファイルを出力しようとしたときの確認を、出力処理 (lib/gidFixGuard.ts)
// から GidFixConfirmModal へ橋渡しする最小限のストア。出力処理は ask() の Promise が解決するまで待ち、
// モーダルはボタン押下時に resolve() を呼ぶ。

import { create } from "zustand";

/** on = 補正をオンにして出力 / continue = 補正せずに出力 / cancel = 出力しない */
export type GidFixChoice = "on" | "continue" | "cancel";

export interface GidFixConfirmRequest {
  /** 補正が必要なファイルの名前 */
  files: string[];
  /** 補正が必要なフォントの数 (全ファイルの合計) */
  count: number;
  /** "pdf" = PDF の出力、"image" = 画像の出力 */
  kind: "pdf" | "image";
}

interface GidFixConfirmState {
  request: GidFixConfirmRequest | null;
  resolver: ((choice: GidFixChoice) => void) | null;
  ask: (request: GidFixConfirmRequest) => Promise<GidFixChoice>;
  resolve: (choice: GidFixChoice) => void;
}

export const useGidFixConfirmStore = create<GidFixConfirmState>((set, get) => ({
  request: null,
  resolver: null,
  ask: (request) =>
    new Promise<GidFixChoice>((resolvePromise) => {
      set({ request, resolver: resolvePromise });
    }),
  resolve: (choice) => {
    const resolver = get().resolver;
    set({ request: null, resolver: null });
    resolver?.(choice);
  },
}));
