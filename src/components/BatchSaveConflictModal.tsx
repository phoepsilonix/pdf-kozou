// src/components/BatchSaveConflictModal.tsx
// モバイルのバッチ出力(画像ファイル出力・バッチ画像PDF出力等)で、
// 保存先フォルダ内に同名ファイルが既にある場合の確認モーダル。
// ファイル単位の SaveConflictModal と異なり、衝突件数をまとめて提示し
// 「すべて上書き / 重複分だけ自動連番 / キャンセル」の3択のみを出す
// (出力ファイルが多数になり得るため、1件ずつの個別リネームは扱わない)。

import { useBatchSaveConflictStore } from "../store/useBatchSaveConflictStore";
import { useI18n } from "../lib/i18n";
import { FS } from "../lib/typography";
import { F } from "../lib/theme";

export function BatchSaveConflictModal() {
  const { request, resolve } = useBatchSaveConflictStore();
  const { t } = useI18n();

  if (!request) return null;

  return (
    <>
      <div style={s.overlay} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("batch_save_conflict.title" as any)}
        style={s.modal}
      >
        <div style={s.header}>
          <span style={s.headerTitle}>⚠️ {t("batch_save_conflict.title" as any)}</span>
        </div>

        <div style={s.body}>
          <p style={s.message}>
            {t("batch_save_conflict.message" as any, {
              count: String(request.conflictCount),
              folder: request.folderName,
            })}
          </p>

          <div style={s.choices}>
            <button style={s.choiceBtn} onClick={() => resolve({ action: "overwrite" })}>
              {t("batch_save_conflict.overwrite" as any)}
            </button>
            <button style={s.choiceBtn} onClick={() => resolve({ action: "auto" })}>
              {t("batch_save_conflict.auto_rename" as any)}
            </button>
            <button
              style={{ ...s.choiceBtn, ...s.cancelBtn }}
              onClick={() => resolve({ action: "cancel" })}
            >
              {t("batch_save_conflict.cancel" as any)}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── スタイル(SaveConflictModal と共通)────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    zIndex: 300,
  },
  modal: {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    zIndex: 301,
    width: "min(420px, 92vw)",
    maxHeight: "90vh",
    display: "flex",
    flexDirection: "column",
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-borderHi)",
    borderRadius: 12,
    boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
    fontFamily: F,
    overflow: "hidden",
    boxSizing: "border-box" as const,
  },
  header: {
    padding: "14px 18px",
    borderBottom: "1px solid var(--c-border)",
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: FS.subtitle,
    fontWeight: 700,
    color: "var(--c-text)",
  },
  body: {
    padding: 18,
    display: "flex",
    flexDirection: "column",
    gap: 14,
    overflowY: "auto",
  },
  message: {
    margin: 0,
    fontSize: FS.body,
    color: "var(--c-text)",
    lineHeight: 1.5,
    wordBreak: "break-all",
  },
  choices: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  choiceBtn: {
    padding: "12px 14px",
    borderRadius: 8,
    border: "1px solid var(--c-borderHi)",
    background: "var(--c-bg)",
    color: "var(--c-text)",
    fontSize: FS.body,
    fontFamily: F,
    cursor: "pointer",
    textAlign: "left" as const,
  },
  cancelBtn: {
    color: "var(--c-textSub)",
    borderColor: "var(--c-border)",
  },
};
