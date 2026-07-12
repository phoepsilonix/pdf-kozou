// src/hooks/useMobileBatchOutput.ts
// バッチ/複数ファイル出力を行う各機能ページ(画像変換・サイズ変更/製本・
// トリミング・圧縮・分割・隠しテキスト等)で共通して使う、モバイル向けの
// 保存後処理をまとめたフック。
//
// Android は SAF フォルダ選択(useBatchSaveFolder、永続化対応)、
// iOS は従来通りダウンロードフォルダ配下へのコピー(commitSavedBatch)
// を使う。各ページはこのフックの commitMobileOutput() を、自前の
// finalizeMobileOutput() (mobileSavedFiles/mobileSaveError の state 管理)
// から呼び出す薄いラッパーにするだけでよい。

import { useCallback, useEffect, useState } from "react";
import { isMobile, isAndroid, type PickedFolder } from "../lib/tauri";
import { commitSavedBatch, type MobileSavedFileInfo } from "../lib/mobileOutput";
import { useBatchSaveFolder } from "./useBatchSaveFolder";
import { guessMimeTypeFromPath } from "../lib/mimeType";

/**
 * commitMobileOutput() が投げるエラーのうち、「実行前に ensureAndroidFolder()
 * 済みのはずなのにフォルダが無い」という、通常到達しないはずのケースを
 * 判別するための識別子。呼び出し側は e.message === this で判定し、
 * mobile.save_unsupported 等の翻訳済みメッセージを表示すること。
 */
export const ANDROID_FOLDER_MISSING = "android save folder is not selected";

export function useMobileBatchOutput() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    isMobile()
      .then(setMobile)
      .catch(() => setMobile(false));
  }, []);

  // JSXの分岐は同期的な値が要るため、isAndroid() の結果をstate化しておく。
  // 実処理側(guard/finalize)は毎回 isAndroid() を直接awaitして使うこと。
  const [androidUI, setAndroidUI] = useState(false);
  useEffect(() => {
    isAndroid()
      .then(setAndroidUI)
      .catch(() => setAndroidUI(false));
  }, []);

  const {
    folder: androidFolder,
    pickFolder: pickAndroidFolder,
    ensureFolder: ensureAndroidFolder,
    commitGrouped,
  } = useBatchSaveFolder();

  /**
   * バッチ/複数ファイル出力の完了後の後処理。
   *
   * `folderOverride` には、実行前に呼んだ ensureAndroidFolder()/
   * pickAndroidFolder() の戻り値をそのまま渡すこと。フックの `androidFolder`
   * state は非同期更新のため、同一の実行フロー内で setFolder 直後に
   * 参照すると再レンダー前の古い値(null)を掴むことがある。
   *
   * 戻り値が null の場合は、衝突確認モーダルでユーザーがキャンセルした
   * ことを意味する(どのフォルダにも書き込まれていない)。
   */
  const commitMobileOutput = useCallback(
    async (
      dir: string,
      filePaths: string[],
      mobileRelativeDir: string,
      folderOverride?: PickedFolder | null,
    ): Promise<MobileSavedFileInfo[] | null> => {
      if (await isAndroid()) {
        const folder = folderOverride ?? androidFolder;
        if (!folder) throw new Error(ANDROID_FOLDER_MISSING);
        const saved = await commitGrouped(folder, dir, filePaths, guessMimeTypeFromPath);
        if (saved === null) return null; // 衝突確認モーダルでキャンセル
        return saved.map((s) => ({
          uri: s.uri,
          displayName: s.displayName,
          relativePath: s.relativePath,
          sourceRelative: s.sourceRelative,
        }));
      }
      return await commitSavedBatch(dir, mobileRelativeDir, filePaths);
    },
    [androidFolder, commitGrouped],
  );

  return {
    mobile,
    androidUI,
    androidFolder,
    pickAndroidFolder,
    ensureAndroidFolder,
    commitMobileOutput,
  };
}
