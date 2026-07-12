// src/components/SaveNamePromptModal.tsx
// Android の単一ファイル保存の直前に、ファイル名を確認・編集させる
// モーダル。デスクトップのネイティブ「名前を付けて保存」ダイアログに
// 相当する、ファイル名を変更する最後の機会。

import { useEffect, useState } from "react";
import { useSaveNamePromptStore } from "../store/useSaveNamePromptStore";
import { useI18n } from "../lib/i18n";
import { FS } from "../lib/typography";
import { F } from "../lib/theme";

export function SaveNamePromptModal() {
  const { request, resolve } = useSaveNamePromptStore();
  const { t } = useI18n();
  const [nameInput, setNameInput] = useState("");

  useEffect(() => {
    if (request) setNameInput(request.suggestedName);
  }, [request]);

  if (!request) return null;

  const confirm = () => {
    const name = nameInput.trim();
    if (name) resolve(name);
  };

  return (
    <>
      <div style={s.overlay} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("save_name_prompt.title" as any)}
        style={s.modal}
      >
        <div style={s.header}>
          <span style={s.headerTitle}>{t("save_name_prompt.title" as any)}</span>
        </div>

        <div style={s.body}>
          <p style={s.message}>
            {t("save_name_prompt.message" as any, { folder: request.folderName })}
          </p>
          <div style={s.form}>
            <label style={s.label} htmlFor="save-name-prompt-input">
              {t("save_name_prompt.input_label" as any)}
            </label>
            <input
              id="save-name-prompt-input"
              style={s.input}
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
              autoFocus
            />
          </div>
          <div style={s.btnRow}>
            <button style={s.cancelBtn} onClick={() => resolve(null)}>
              {t("save_name_prompt.cancel" as any)}
            </button>
            <button style={s.confirmBtn} disabled={!nameInput.trim()} onClick={confirm}>
              {t("save_name_prompt.save" as any)}
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
  form: {
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
  btnRow: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 4,
  },
  cancelBtn: {
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
