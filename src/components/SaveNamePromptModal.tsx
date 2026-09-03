// src/components/SaveNamePromptModal.tsx
// Android の単一ファイル保存の直前に、保存先フォルダとファイル名を
// 確認・編集させるモーダル。デスクトップのネイティブ「名前を付けて
// 保存」ダイアログに相当する、保存先を変更する最後の機会。
//
// 「変更」ボタンはシステムのフォルダピッカー(ACTION_OPEN_DOCUMENT_TREE)
// をその場で開き直す。システムのピッカーはフォルダ内でのサブフォルダ
// 新規作成にも対応しているため、「サブフォルダを作って保存したい」場合も
// ここから行える。

import { useEffect, useState } from "react";
import { persistAndroidSaveFolder } from "../lib/androidSaveFolder";
import { useI18n } from "../lib/i18n";
import { type PickedFolder, pickSaveFolder } from "../lib/tauri";
import { F } from "../lib/theme";
import { FS } from "../lib/typography";
import { useSaveNamePromptStore } from "../store/useSaveNamePromptStore";

export function SaveNamePromptModal() {
  const { request, resolve } = useSaveNamePromptStore();
  const { t } = useI18n();
  const [nameInput, setNameInput] = useState("");
  const [folder, setFolder] = useState<PickedFolder | null>(null);

  useEffect(() => {
    if (request) {
      setNameInput(request.suggestedName);
      setFolder(request.folder);
    }
  }, [request]);

  if (!request) return null;

  const confirm = () => {
    const name = nameInput.trim();
    if (name && folder) resolve({ name, folder });
  };

  const changeFolder = async () => {
    const picked = await pickSaveFolder();
    if (picked) {
      setFolder(picked);
      // ここで明示的に選び直した場合は、以後の既定値としても更新する。
      persistAndroidSaveFolder(picked);
    }
  };

  return (
    <>
      <div style={s.overlay} aria-hidden />
      <div role="dialog" aria-modal="true" aria-label={t("save_name_prompt.title")} style={s.modal}>
        <div style={s.header}>
          <span style={s.headerTitle}>{t("save_name_prompt.title")}</span>
        </div>

        <div style={s.body}>
          <div style={s.form}>
            <label style={s.label}>{t("save_name_prompt.folder_label")}</label>
            <div style={s.folderRow}>
              <div style={s.folderPath} title={folder?.folderName ?? ""}>
                {folder?.folderName ?? ""}
              </div>
              <button type="button" style={s.changeBtn} onClick={changeFolder}>
                {t("save_name_prompt.change_folder")}
              </button>
            </div>
          </div>
          <div style={s.form}>
            <label style={s.label} htmlFor="save-name-prompt-input">
              {t("save_name_prompt.input_label")}
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
            <button type="button" style={s.cancelBtn} onClick={() => resolve(null)}>
              {t("save_name_prompt.cancel")}
            </button>
            <button
              type="button"
              style={s.confirmBtn}
              disabled={!nameInput.trim()}
              onClick={confirm}
            >
              {t("save_name_prompt.save")}
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
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  label: {
    fontSize: FS.caption,
    color: "var(--c-textSub)",
  },
  folderRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  folderPath: {
    flex: 1,
    minWidth: 0,
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid var(--c-border)",
    background: "var(--c-bg)",
    color: "var(--c-text)",
    fontSize: FS.body,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  changeBtn: {
    flexShrink: 0,
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid var(--c-borderHi)",
    background: "var(--c-bg)",
    color: "var(--c-text)",
    fontSize: FS.body,
    fontFamily: F,
    cursor: "pointer",
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
