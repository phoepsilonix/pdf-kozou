// src/store/useSaveNamePromptStore.ts
// Android の単一ファイル保存(SAFフォルダへの直接保存)は、デスクトップの
// ネイティブ「名前を付けて保存」ダイアログと違い、保存先フォルダも
// ファイル名もアプリが決め打ちで計算して渡すだけになっていた。フォルダ
// 選択の永続化と合わせ、これでは保存が完全に無人で走ってしまい、
// ユーザーが保存先(フォルダ・ファイル名)を確認・変更する機会が無い。
//
// このストアは、実際に保存する直前に一度だけ「この場所にこの名前で
// 保存しますか」を確認し、その場でファイル名の編集・保存先フォルダの
// 変更(システムのフォルダピッカー呼び出し。サブフォルダの新規作成にも
// 対応)ができるプロンプトを表示するためのもの。

import { create } from "zustand";
import type { PickedFolder } from "../lib/tauri";

interface SaveNamePromptRequest {
  suggestedName: string;
  folder: PickedFolder;
}

export interface SaveNamePromptResult {
  name: string;
  folder: PickedFolder;
}

interface SaveNamePromptState {
  request: SaveNamePromptRequest | null;
  resolver: ((result: SaveNamePromptResult | null) => void) | null;
  ask: (suggestedName: string, folder: PickedFolder) => Promise<SaveNamePromptResult | null>;
  resolve: (result: SaveNamePromptResult | null) => void;
}

export const useSaveNamePromptStore = create<SaveNamePromptState>((set, get) => ({
  request: null,
  resolver: null,
  ask: (suggestedName, folder) => {
    return new Promise<SaveNamePromptResult | null>((resolvePromise) => {
      set({ request: { suggestedName, folder }, resolver: resolvePromise });
    });
  },
  resolve: (result) => {
    const resolver = get().resolver;
    set({ request: null, resolver: null });
    resolver?.(result);
  },
}));
