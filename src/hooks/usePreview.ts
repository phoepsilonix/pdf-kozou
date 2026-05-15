// src/hooks/usePreview.ts
// 機能ごとのプレビュー表示フラグを管理するフック。
// 未設定のページはデフォルト true（表示）。

import { useCallback } from "react";
import { usePdfStore } from "../store/usePdfStore";

export function usePreview(pageKey: string) {
  const previewEnabled = usePdfStore((s) => s.previewEnabled);
  const setPreviewEnabled = usePdfStore((s) => s.setPreviewEnabled);

  // 未設定のページは表示（true）扱い
  const enabled = previewEnabled[pageKey] !== false;

  const toggle = useCallback(() => {
    setPreviewEnabled(pageKey, !enabled);
  }, [pageKey, enabled, setPreviewEnabled]);

  return { enabled, toggle };
}
