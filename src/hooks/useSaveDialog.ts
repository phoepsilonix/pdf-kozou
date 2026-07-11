// src/hooks/useSaveDialog.ts
// 保存ダイアログ。前回の保存先ディレクトリを記憶し、初回はDocuments/Downloadsを初期値にする。

import { useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePdfStore } from "../store/usePdfStore";
import { getDefaultSaveDir, commitSavedFile, discardPendingSave } from "../lib/tauri";

export function useSaveDialog() {
  const { lastSaveDir, setLastSaveDir } = usePdfStore();

  // 初回起動時にDocuments/Downloadsを取得
  useEffect(() => {
    if (!lastSaveDir) {
      getDefaultSaveDir()
        .then((dir) => setLastSaveDir(dir))
        .catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pickSave = useCallback(
    async (defaultName: string): Promise<string | null> => {
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
   * ユーザーが実際に選んだ保存先(SAF の content:// URI 等)へはまだ
   * コピーされていない。commitSave() を呼んで初めて、ユーザーから見える
   * 場所にファイルが保存される。デスクトップでは no-op。
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
