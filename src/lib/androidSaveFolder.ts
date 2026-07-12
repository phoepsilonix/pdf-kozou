// src/lib/androidSaveFolder.ts
// Android: SAF (ACTION_OPEN_DOCUMENT_TREE) で選んだ保存先フォルダの永続化。
//
// takePersistableUriPermission 自体はOS側で権限を維持するが、「どの
// フォルダを選んだか」はアプリ側で覚えておく必要がある。これが無いと、
// 単一ファイル保存・バッチ保存のたびに毎回フォルダ選択ダイアログが出て
// しまい、デスクトップ版のような操作感にならない。
//
// usePdfStore (zustand + persist, localStorage) に最後に選んだ
// {treeUri, folderName} を保存し、次回以降はまず永続化された値を
// listFolderNames() で検証してから再利用する。ユーザーがOS側で権限を
// 取り消した/フォルダを削除した等で無効になっていれば、その場で
// クリアしてフォールバック(通常のピッカー呼び出し)に任せる。

import { usePdfStore } from "../store/usePdfStore";
import { listFolderNames, type PickedFolder } from "./tauri";

/**
 * 永続化されたフォルダがあれば、実際にまだ使えるか検証した上で返す。
 * 無効(権限失効・フォルダ削除等)なら永続化をクリアして null を返す。
 * 何も永続化されていない場合も null。
 */
export async function getValidPersistedAndroidFolder(): Promise<PickedFolder | null> {
  const stored = usePdfStore.getState().androidSaveFolder;
  if (!stored) return null;
  try {
    await listFolderNames(stored.treeUri);
    return stored;
  } catch {
    usePdfStore.getState().setAndroidSaveFolder(null);
    return null;
  }
}

export function persistAndroidSaveFolder(folder: PickedFolder | null): void {
  usePdfStore.getState().setAndroidSaveFolder(folder);
}
