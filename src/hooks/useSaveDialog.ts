// src/hooks/useSaveDialog.ts
// 保存ダイアログ。前回の保存先ディレクトリを記憶し、初回はDocuments/Downloadsを初期値にする。

import { useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePdfStore } from "../store/usePdfStore";
import { getDefaultSaveDir } from "../lib/tauri";

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

  return { pickSave };
}
