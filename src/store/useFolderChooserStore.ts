// src/store/useFolderChooserStore.ts
// Android のバッチ出力で「参照」を押した時に、システムのフォルダピッカー
// (毎回OSの権限確認が出る)を開く前に、すでに権限を持っているフォルダを
// 一覧から選ばせるための橋渡しストア。
//
// 一覧から選べば OS の確認なしで保存先を切り替えられる。一覧に無い
// フォルダを選びたい場合だけ「他のフォルダを選ぶ」でシステムのピッカーを開く。

import { create } from "zustand";
import type { GrantedFolder, PickedFolder } from "../lib/tauri";

interface FolderChooserRequest {
  /** 現在の保存先(一覧内で印を付ける)。 */
  current: PickedFolder | null;
  folders: GrantedFolder[];
}

/** フォルダ、"picker"(システムのピッカーを開く)、null(キャンセル)。 */
export type FolderChooserResult = GrantedFolder | "picker" | null;

interface FolderChooserState {
  request: FolderChooserRequest | null;
  resolver: ((result: FolderChooserResult) => void) | null;
  ask: (current: PickedFolder | null, folders: GrantedFolder[]) => Promise<FolderChooserResult>;
  resolve: (result: FolderChooserResult) => void;
}

export const useFolderChooserStore = create<FolderChooserState>((set, get) => ({
  request: null,
  resolver: null,
  ask: (current, folders) =>
    new Promise<FolderChooserResult>((resolvePromise) => {
      set({ request: { current, folders }, resolver: resolvePromise });
    }),
  resolve: (result) => {
    const resolver = get().resolver;
    set({ request: null, resolver: null });
    resolver?.(result);
  },
}));
