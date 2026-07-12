// src/store/useSaveNamePromptStore.ts
// Android の単一ファイル保存(SAFフォルダへの直接保存)は、デスクトップの
// ネイティブ「名前を付けて保存」ダイアログと違い、ファイル名をアプリが
// 決め打ちで計算して渡すだけになっていた。フォルダ選択の永続化と合わせ、
// これでは保存が完全に無人で走ってしまい、ユーザーがファイル名を確認・
// 変更する機会が無い。
//
// このストアは、実際に保存する直前に一度だけ「この名前で保存しますか」を
// 確認し、必要ならその場で編集できるプロンプトを表示するためのもの。

import { create } from "zustand";

interface SaveNamePromptRequest {
  suggestedName: string;
  folderName: string;
}

interface SaveNamePromptState {
  request: SaveNamePromptRequest | null;
  resolver: ((name: string | null) => void) | null;
  ask: (suggestedName: string, folderName: string) => Promise<string | null>;
  resolve: (name: string | null) => void;
}

export const useSaveNamePromptStore = create<SaveNamePromptState>((set, get) => ({
  request: null,
  resolver: null,
  ask: (suggestedName, folderName) => {
    return new Promise<string | null>((resolvePromise) => {
      set({ request: { suggestedName, folderName }, resolver: resolvePromise });
    });
  },
  resolve: (name) => {
    const resolver = get().resolver;
    set({ request: null, resolver: null });
    resolver?.(name);
  },
}));
