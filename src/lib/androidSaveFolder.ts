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

import { useFolderChooserStore } from "../store/useFolderChooserStore";
import { usePdfStore } from "../store/usePdfStore";
import { listFolderNames, listGrantedFolders, type PickedFolder, pickSaveFolder } from "./tauri";

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

/**
 * システムのフォルダピッカーを開き、選ばれたフォルダを永続化して返す
 * (キャンセル時は null)。
 *
 * ACTION_OPEN_DOCUMENT_TREE は、既に権限を持っているフォルダでも毎回
 * 「アクセスを許可」の確認を出す(アプリ側からは抑止できない)。そこで
 * 前回のフォルダを初期位置に指定して操作を減らす。許可済みフォルダを
 * 確認なしで選び直せる導線は SaveNamePromptModal の一覧を参照。
 */
export async function pickAndPersistSaveFolder(): Promise<PickedFolder | null> {
  const initial = usePdfStore.getState().androidSaveFolder?.treeUri ?? null;
  const picked = await pickSaveFolder(initial);
  if (picked) persistAndroidSaveFolder(picked);
  return picked;
}

/**
 * バッチ出力の「参照」ボタン用。許可済みフォルダがあれば、まず一覧から
 * 選ばせる(選べばOSの権限確認なしで切り替わる)。一覧に無いフォルダを
 * 選びたい時、または許可済みフォルダが無い時だけシステムのピッカーを開く。
 * キャンセル時は null。Android 以外では一覧が空なので従来通りピッカーを開く。
 */
export async function chooseAndPersistSaveFolder(): Promise<PickedFolder | null> {
  let granted: Awaited<ReturnType<typeof listGrantedFolders>> = [];
  try {
    granted = await listGrantedFolders();
  } catch {
    // 取得に失敗しても、従来通りピッカーを開けば良い。
  }
  if (granted.length === 0) return await pickAndPersistSaveFolder();

  const current = usePdfStore.getState().androidSaveFolder;
  const choice = await useFolderChooserStore.getState().ask(current, granted);
  if (choice === null) return null;
  if (choice === "picker") return await pickAndPersistSaveFolder();

  const picked: PickedFolder = { treeUri: choice.treeUri, folderName: choice.folderName };
  persistAndroidSaveFolder(picked);
  return picked;
}
