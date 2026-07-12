// src/hooks/useBatchSaveFolder.ts
// 複数ファイル出力(画像ファイル出力・バッチ画像PDF出力等)向けの、
// フォルダ単位アクセス(ACTION_OPEN_DOCUMENT_TREE)による保存。
//
// 単一ファイル保存の useSaveDialog と同じ B方式(pickSaveFolder)を使うが、
// 出力ファイルが複数になるため、衝突確認は1件ずつではなく
// resolveBatchSaveConflict() でバッチ単位に1回だけ行う。
//
// フォルダの選択自体は、実行ボタン押下時など「実際の変換処理を始める前」
// に ensureFolder() で済ませておくこと(デスクトップの「参照」ボタンで
// 未選択のまま実行した場合にダイアログを挟む挙動に合わせるため)。
// commitBatch() は処理完了後、実際に書き出したローカル一時ファイルの
// パス一覧を渡して呼ぶ。

import { useCallback, useState } from "react";
import {
  pickSaveFolder,
  commitBatchToFolder,
  type PickedFolder,
  type BatchFolderEntry,
  type BatchSavedFileInfo,
} from "../lib/tauri";
import { resolveBatchSaveConflict } from "../lib/batchSaveConflict";

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function useBatchSaveFolder() {
  const [folder, setFolder] = useState<PickedFolder | null>(null);

  /** 「参照」ボタン用。選択済みでも常にダイアログを開き直す。 */
  const pickFolder = useCallback(async (): Promise<PickedFolder | null> => {
    const picked = await pickSaveFolder();
    if (picked) setFolder(picked);
    return picked;
  }, []);

  /** 未選択なら pickSaveFolder() でフォルダ選択ダイアログを出す。選択済みならそれを返す。 */
  const ensureFolder = useCallback(async (): Promise<PickedFolder | null> => {
    if (folder) return folder;
    return await pickFolder();
  }, [folder, pickFolder]);

  /**
   * 実際に書き出したローカル一時ファイルのパス一覧を、選択済みフォルダへ
   * まとめてコミットする。衝突確認モーダルでキャンセルされた場合は null。
   */
  const commitBatch = useCallback(
    async (
      filePaths: string[],
      mimeTypeOf: (path: string) => string | null,
    ): Promise<BatchSavedFileInfo[] | null> => {
      if (!folder) throw new Error("save folder is not selected yet");

      const plannedNames = filePaths.map(baseName);
      const resolved = await resolveBatchSaveConflict(
        folder.treeUri,
        plannedNames,
        folder.folderName,
      );
      if (!resolved) return null; // 衝突確認モーダルでキャンセル

      const entries: BatchFolderEntry[] = filePaths.map((p) => {
        const name = baseName(p);
        const r = resolved.get(name)!;
        return {
          sourcePath: p,
          targetName: r.finalName,
          overwrite: r.overwrite,
          mimeType: mimeTypeOf(p),
        };
      });
      return await commitBatchToFolder(folder.treeUri, entries);
    },
    [folder],
  );

  return { folder, pickFolder, ensureFolder, commitBatch };
}
