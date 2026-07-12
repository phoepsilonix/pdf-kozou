// src/store/useBatchSaveConflictStore.ts
// モバイルのバッチ出力(複数ファイル書き出し)向け。単一ファイル保存の
// useSaveConflictStore はファイル1件ごとに確認を求めるが、バッチでは
// 出力ファイルが数十件にもなり得るため、衝突があった件数をまとめて
// 提示し、「すべて上書き / 重複分だけ自動連番 / キャンセル」を1回だけ
// 確認する。resolveBatchSaveConflict() (src/lib/batchSaveConflict.ts) から
// BatchSaveConflictModal へ橋渡しするための最小限のストア。

import { create } from "zustand";

export type BatchSaveConflictChoice =
  | { action: "overwrite" }
  | { action: "auto" }
  | { action: "cancel" };

interface BatchSaveConflictRequest {
  conflictCount: number;
  folderName: string;
}

interface BatchSaveConflictState {
  request: BatchSaveConflictRequest | null;
  resolver: ((choice: BatchSaveConflictChoice) => void) | null;
  ask: (conflictCount: number, folderName: string) => Promise<BatchSaveConflictChoice>;
  resolve: (choice: BatchSaveConflictChoice) => void;
}

export const useBatchSaveConflictStore = create<BatchSaveConflictState>((set, get) => ({
  request: null,
  resolver: null,
  ask: (conflictCount, folderName) => {
    return new Promise<BatchSaveConflictChoice>((resolvePromise) => {
      set({ request: { conflictCount, folderName }, resolver: resolvePromise });
    });
  },
  resolve: (choice) => {
    const resolver = get().resolver;
    set({ request: null, resolver: null });
    resolver?.(choice);
  },
}));
