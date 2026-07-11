// src/store/useSaveConflictStore.ts
// モバイル単一ファイル保存で、保存先フォルダ内に同名ファイルが既にある場合の
// 確認を、useSaveDialog (フック) から SaveConflictModal (コンポーネント) へ
// 橋渡しするための最小限のストア。フックは ask() の Promise が解決するまで
// 待ち、モーダルはボタン押下時に resolve() を呼ぶ。

import { create } from "zustand";

export type SaveConflictChoice =
  | { action: "overwrite" }
  | { action: "rename"; fileName: string }
  | { action: "auto" }
  | { action: "cancel" };

interface SaveConflictRequest {
  fileName: string;
  folderName: string;
}

interface SaveConflictState {
  request: SaveConflictRequest | null;
  resolver: ((choice: SaveConflictChoice) => void) | null;
  ask: (fileName: string, folderName: string) => Promise<SaveConflictChoice>;
  resolve: (choice: SaveConflictChoice) => void;
}

export const useSaveConflictStore = create<SaveConflictState>((set, get) => ({
  request: null,
  resolver: null,
  ask: (fileName, folderName) => {
    return new Promise<SaveConflictChoice>((resolvePromise) => {
      set({ request: { fileName, folderName }, resolver: resolvePromise });
    });
  },
  resolve: (choice) => {
    const resolver = get().resolver;
    set({ request: null, resolver: null });
    resolver?.(choice);
  },
}));
