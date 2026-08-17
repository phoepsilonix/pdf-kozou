// src/hooks/useSaveDialog.ts
// 保存ダイアログ。前回の保存先ディレクトリを記憶し、初回はDocuments/Downloadsを初期値にする。
//
// モバイル(Android)の単一ファイル保存は、従来の ACTION_CREATE_DOCUMENT
// (pick_save_file, いわゆるA方式)ではなく、ACTION_OPEN_DOCUMENT_TREE で
// フォルダそのものへのアクセス権を得るB方式を使う。理由:
// A方式は「同名ファイルがある場合にどう振る舞うか」がプロバイダ実装に
// 委ねられており、上書き確認の有無も自動リネームの方式(拡張子の前/後ろ)
// もアプリ側から検知・制御できない。B方式ならフォルダの中身を自前で
// 確認できるため、上書き/自動リネーム/別名保存のいずれもアプリが確実に
// 制御できる。衝突解決ロジックは src/lib/saveConflict.ts に共通化してあり、
// useSaveDialog を経由しない RotatePage の直接呼び出しからも使われている。
//
// フォルダの選択自体はアプリ再起動をまたいで永続化される
// (androidSaveFolder.ts)。これにより保存の大半が無人で走るようになった
// ため、実際の保存直前に一度だけファイル名を確認・編集できるプロンプト
// (useSaveNamePromptStore / SaveNamePromptModal)を挟み、デスクトップの
// 「名前を付けて保存」ダイアログに相当する最後の確認機会を用意している。

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect } from "react";
import { getValidPersistedAndroidFolder, persistAndroidSaveFolder } from "../lib/androidSaveFolder";
import { resolveSaveConflict } from "../lib/saveConflict";
import {
  beginFolderSave,
  commitSavedFile,
  discardPendingSave,
  getDefaultSaveDir,
  isAndroid,
  pickSaveFolder,
} from "../lib/tauri";
import { usePdfStore } from "../store/usePdfStore";
import { useSaveNamePromptStore } from "../store/useSaveNamePromptStore";

export function useSaveDialog() {
  const { lastSaveDir, setLastSaveDir } = usePdfStore();

  // 初回起動時にDocuments/Downloadsを取得(デスクトップのみ意味を持つ)
  useEffect(() => {
    if (!lastSaveDir) {
      getDefaultSaveDir()
        .then((dir) => setLastSaveDir(dir))
        .catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pickSave = useCallback(
    async (defaultName: string): Promise<string | null> => {
      if (await isAndroid()) {
        // ── Android: 前回選んだフォルダが有効ならそれを再利用し、毎回の
        // フォルダ選択ダイアログを省く。無効(権限失効・削除等)や初回は
        // 通常通りピッカーを開く ──
        let folder = await getValidPersistedAndroidFolder();
        if (!folder) {
          folder = await pickSaveFolder();
          if (!folder) return null; // フォルダ選択をキャンセル
          persistAndroidSaveFolder(folder);
        }

        // フォルダ選択の永続化により保存が完全に無人で走るようになったため、
        // デスクトップの「名前を付けて保存」ダイアログに相当する、保存先
        // フォルダとファイル名を確認・変更する最後の機会をここで挟む。
        const confirmed = await useSaveNamePromptStore.getState().ask(defaultName, folder);
        if (!confirmed) return null; // プロンプトでキャンセル

        const resolved = await resolveSaveConflict(
          confirmed.folder.treeUri,
          confirmed.name,
          confirmed.folder.folderName,
        );
        if (!resolved) return null; // 衝突確認モーダルでキャンセル

        return await beginFolderSave(
          confirmed.folder.treeUri,
          resolved.fileName,
          "application/pdf",
          resolved.overwrite,
        );
      }

      // ── デスクトップ・iOS: 従来通りネイティブの保存ダイアログを使う ──
      // (B方式は現状Android専用。iOSは引き続きACTION_CREATE_DOCUMENT相当を使う)
      // pick_save_file_in が使えればinitialDirを渡す、なければ通常版にfallback
      const path = await invoke<string | null>("pick_save_file_in", {
        defaultName,
        initialDir: lastSaveDir ?? null,
      }).catch(() => invoke<string | null>("pick_save_file", { defaultName }));

      if (path) {
        // 保存したディレクトリを記憶
        const dir = path.replace(/[/\\][^/\\]+$/, "");
        if (dir) setLastSaveDir(dir);
      }
      return path;
    },
    [lastSaveDir, setLastSaveDir],
  );

  /**
   * pickSave() で得たパスへの書き込みが終わった直後に必ず呼ぶこと。
   *
   * モバイルでは pickSave() が返すのはアプリ専用の一時パスであり、
   * ユーザーが実際に選んだ保存先へはまだコピーされていない。commitSave()
   * を呼んで初めて、ユーザーから見える場所にファイルが保存される。
   * デスクトップでは no-op。
   */
  const commitSave = useCallback(async (path: string): Promise<void> => {
    await commitSavedFile(path);
  }, []);

  /**
   * 結果画面を離れる/新しい操作を始める際に呼ぶ。commitSave() が維持していた
   * 一時ファイルと保存先の紐付けを破棄する。呼び忘れても次回起動時などに
   * 一時領域が肥大化する程度で実害は無いが、明示的に呼ぶのが望ましい。
   */
  const discardSave = useCallback(async (path: string): Promise<void> => {
    await discardPendingSave(path);
  }, []);

  return { pickSave, commitSave, discardSave };
}
