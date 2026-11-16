// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/BatchCancelButton.tsx
// バッチ出力の進捗画面に置くキャンセルボタン。
// 押すと、いま処理中のファイルが終わった後、次のファイル以降を処理せずに止まる。

import { useEffect } from "react";
import { requestBatchCancel, resetBatchCancel, useBatchCancelStore } from "../lib/batchCancel";
import { useI18n } from "../lib/i18n";

export function BatchCancelButton() {
  const { t } = useI18n();
  const requested = useBatchCancelStore((s) => s.requested);
  // 進捗画面を離れるとき(完了・キャンセル後)に要求を戻し、次回の実行に持ち越さない
  useEffect(() => resetBatchCancel, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <button
        type="button"
        onClick={requestBatchCancel}
        disabled={requested}
        style={{
          padding: "8px 18px",
          borderRadius: 8,
          border: "1px solid var(--c-border)",
          background: "var(--c-bgCard)",
          color: "var(--c-text)",
          cursor: requested ? "default" : "pointer",
          opacity: requested ? 0.6 : 1,
          fontSize: 13,
        }}
      >
        {requested ? t("batch_cancel.cancelling") : t("batch_cancel.button")}
      </button>
      <div role="status" style={{ fontSize: 11, color: "var(--c-textSub)", textAlign: "center" }}>
        {requested ? t("batch_cancel.cancelling_note") : t("batch_cancel.note")}
      </div>
    </div>
  );
}
