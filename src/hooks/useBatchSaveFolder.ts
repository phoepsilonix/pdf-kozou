// src/hooks/useBatchSaveFolder.ts
// 複数ファイル出力(画像ファイル出力・バッチ画像PDF出力等)向けの、
// フォルダ単位アクセス(ACTION_OPEN_DOCUMENT_TREE)による保存。
//
// 単一ファイル保存の useSaveDialog と同じ B方式(pickSaveFolder)を使うが、
// 出力ファイルが複数になるため、衝突確認は1件ずつではなく
// resolveGroupsSaveConflict() でバッチ単位に1回だけ行う。
//
// デスクトップ版のバッチ画像出力は入力PDFごとにサブフォルダを作る
// (例: "invoice1/page_001.jpg")。SAF側でも同じ構成を再現しないと、
// 複数PDFの page_001.jpg 等が選択フォルダ直下で衝突してしまうため、
// commitGrouped() は書き出し元のローカル一時パスから「どのフォルダの
// 直下か」を判定し、必要なら getOrCreateSubfolder() でサブフォルダを
// 用意してから書き込む。
//
// フォルダの選択自体は、実行ボタン押下時など「実際の変換処理を始める前」
// に ensureFolder() で済ませておくこと(デスクトップの「参照」ボタンで
// 未選択のまま実行した場合にダイアログを挟む挙動に合わせるため)。
//
// アプリ再起動をまたいだ永続化(androidSaveFolder.ts)にも対応している。
// マウント時に永続化された前回のフォルダを検証の上で読み込むため、
// 「参照」ボタンや実行ボタンを押す前から `folder` に値が入っている。
// これにより、画面上の表示(空欄=未選択)と実際の挙動(黙って前回の
// フォルダへ保存する)が食い違わないようにしている。無効(権限失効・
// 削除等)や初回起動時は folder は null のままで、ensureFolder() が
// 通常のピッカーを開く。
//
// ⚠ ensureFolder()/pickFolder() が返す値をそのまま呼び出し側で保持し、
// commitGrouped() の引数として明示的に渡すこと。フック内部の `folder`
// state は非同期更新のため、同一の実行フロー内で setFolder 直後に
// 参照すると再レンダー前の古い値(null)を掴むことがある。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  pickSaveFolder,
  getOrCreateSubfolder,
  commitBatchToFolder,
  isAndroid,
  type PickedFolder,
  type BatchFolderEntry,
  type BatchSavedFileInfo,
} from "../lib/tauri";
import { resolveGroupsSaveConflict, type PlannedGroup } from "../lib/batchSaveConflict";
import { getValidPersistedAndroidFolder, persistAndroidSaveFolder } from "../lib/androidSaveFolder";

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function dirName(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx < 0 ? "" : path.slice(0, idx);
}

export function useBatchSaveFolder() {
  const [folder, setFolder] = useState<PickedFolder | null>(null);
  // 永続化フォルダの読み込みは重複させず1回だけ行う(マウント時の
  // useEffect と、実行前の ensureFolder() 両方から呼ばれ得るため)。
  const loadPromiseRef = useRef<Promise<PickedFolder | null> | null>(null);
  const loadPersisted = useCallback((): Promise<PickedFolder | null> => {
    if (!loadPromiseRef.current) {
      loadPromiseRef.current = (async () => {
        if (!(await isAndroid())) return null;
        const persisted = await getValidPersistedAndroidFolder();
        if (persisted) setFolder(persisted);
        return persisted;
      })();
    }
    return loadPromiseRef.current;
  }, []);

  useEffect(() => {
    loadPersisted();
  }, [loadPersisted]);

  /** 「参照」ボタン用。選択済みでも常にダイアログを開き直す。 */
  const pickFolder = useCallback(async (): Promise<PickedFolder | null> => {
    const picked = await pickSaveFolder();
    if (picked) {
      setFolder(picked);
      persistAndroidSaveFolder(picked);
    }
    return picked;
  }, []);

  /**
   * 未選択なら、まず永続化された前回のフォルダを検証の上で再利用を試み、
   * 無効/未永続化ならピッカーを開く。選択済みならそれを返す。
   */
  const ensureFolder = useCallback(async (): Promise<PickedFolder | null> => {
    if (folder) return folder;
    const persisted = await loadPersisted();
    if (persisted) return persisted;
    return await pickFolder();
  }, [folder, loadPersisted, pickFolder]);

  /**
   * 実際に書き出したローカル一時ファイルのパス一覧を、選択済みフォルダへ
   * まとめてコミットする。`dir` はそれらの書き出し元の基準ディレクトリ
   * (バッチのベースフォルダ等)。`dirName(path) !== dir` のファイルは、
   * その直下のフォルダ名をサブフォルダ名として選択フォルダ内に再現する。
   *
   * 衝突確認モーダルでキャンセルされた場合は null(どのフォルダにも
   * 書き込まれない)。
   */
  const commitGrouped = useCallback(
    async (
      targetFolder: PickedFolder,
      dir: string,
      filePaths: string[],
      mimeTypeOf: (path: string) => string | null,
    ): Promise<BatchSavedFileInfo[] | null> => {
      // ローカル一時パスを「サブフォルダ名 (rel)」ごとにグループ化する。
      // rel === "" はルート(サブフォルダ無し)扱い。
      const pathsByRel = new Map<string, string[]>();
      for (const p of filePaths) {
        const rel = dirName(p) === dir ? "" : baseName(dirName(p));
        if (!pathsByRel.has(rel)) pathsByRel.set(rel, []);
        pathsByRel.get(rel)!.push(p);
      }

      // rel → 実際の書き込み先 treeUri を解決(サブフォルダは無ければ作成)。
      const treeUriByRel = new Map<string, string>();
      for (const rel of pathsByRel.keys()) {
        treeUriByRel.set(
          rel,
          rel === "" ? targetFolder.treeUri : await getOrCreateSubfolder(targetFolder.treeUri, rel),
        );
      }

      const groups: PlannedGroup[] = Array.from(pathsByRel.entries()).map(([rel, paths]) => ({
        treeUri: treeUriByRel.get(rel)!,
        plannedNames: paths.map(baseName),
      }));

      const resolved = await resolveGroupsSaveConflict(groups, targetFolder.folderName);
      if (!resolved) return null; // 衝突確認モーダルでキャンセル

      const allSaved: BatchSavedFileInfo[] = [];
      for (const [rel, paths] of pathsByRel) {
        const treeUri = treeUriByRel.get(rel)!;
        const resolvedForGroup = resolved.get(treeUri)!;
        const entries: BatchFolderEntry[] = paths.map((p) => {
          const name = baseName(p);
          const r = resolvedForGroup.get(name)!;
          return {
            sourcePath: p,
            targetName: r.finalName,
            overwrite: r.overwrite,
            mimeType: mimeTypeOf(p),
          };
        });
        const saved = await commitBatchToFolder(treeUri, entries);
        allSaved.push(...saved);
      }
      return allSaved;
    },
    [],
  );

  return { folder, pickFolder, ensureFolder, commitGrouped };
}
