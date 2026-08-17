// src/components/SaveConflictModal.tsx
// モバイル単一ファイル保存で、保存先フォルダ内に同名ファイルが既にある
// 場合に、上書き/自動リネーム/別名保存/キャンセルを選ばせるモーダル。
// useSaveConflictStore 経由で useSaveDialog から要求され、選択結果を
// Promise の解決として返す(モーダル自身は保存処理を知らない)。

import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { F } from "../lib/theme";
import { FS } from "../lib/typography";
import { useSaveConflictStore } from "../store/useSaveConflictStore";

export function SaveConflictModal() {
  const { request, resolve } = useSaveConflictStore();
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState("");

  useEffect(() => {
    if (request) {
      setEditing(false);
      setNameInput(request.fileName);
    }
  }, [request]);

  if (!request) return null;

  return (
    <>
      <div style={s.overlay} aria-hidden />
      <div role="dialog" aria-modal="true" aria-label={t("save_conflict.title")} style={s.modal}>
        <div style={s.header}>
          <span style={s.headerTitle}>⚠️ {t("save_conflict.title")}</span>
        </div>

        <div style={s.body}>
          <p style={s.message}>
            {t("save_conflict.message", {
              name: request.fileName,
              folder: request.folderName,
            })}
          </p>

          {!editing ? (
            <div style={s.choices}>
              <button
                type="button"
                style={s.choiceBtn}
                onClick={() => resolve({ action: "overwrite" })}
              >
                {t("save_conflict.overwrite")}
              </button>
              <button type="button" style={s.choiceBtn} onClick={() => resolve({ action: "auto" })}>
                {t("save_conflict.auto_rename")}
              </button>
              <button type="button" style={s.choiceBtn} onClick={() => setEditing(true)}>
                {t("save_conflict.rename")}
              </button>
              <button
                type="button"
                style={{ ...s.choiceBtn, ...s.cancelBtn }}
                onClick={() => resolve({ action: "cancel" })}
              >
                {t("save_conflict.cancel")}
              </button>
            </div>
          ) : (
            <div style={s.renameForm}>
              <label style={s.label} htmlFor="save-conflict-rename">
                {t("save_conflict.rename_input_label")}
              </label>
              <input
                id="save-conflict-rename"
                style={s.input}
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                autoFocus
              />
              <div style={s.renameBtnRow}>
                <button type="button" style={s.backBtn} onClick={() => setEditing(false)}>
                  {t("save_conflict.rename_back")}
                </button>
                <button
                  type="button"
                  style={s.confirmBtn}
                  disabled={!nameInput.trim()}
                  onClick={() => resolve({ action: "rename", fileName: nameInput.trim() })}
                >
                  {t("save_conflict.rename_confirm")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── スタイル ───────────────────────────────────────────────────────────────

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
  renameForm: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  label: {
    fontSize: FS.caption,
    color: "var(--c-textSub)",
  },
  input: {
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid var(--c-borderHi)",
    background: "var(--c-bg)",
    color: "var(--c-text)",
    fontSize: FS.body,
    fontFamily: F,
  },
  renameBtnRow: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 4,
  },
  backBtn: {
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid var(--c-border)",
    background: "transparent",
    color: "var(--c-textSub)",
    fontSize: FS.body,
    fontFamily: F,
    cursor: "pointer",
  },
  confirmBtn: {
    padding: "8px 14px",
    borderRadius: 8,
    border: "none",
    background: "var(--c-accent)",
    color: "var(--c-accentText)",
    fontSize: FS.body,
    fontWeight: 700,
    fontFamily: F,
    cursor: "pointer",
  },
};
