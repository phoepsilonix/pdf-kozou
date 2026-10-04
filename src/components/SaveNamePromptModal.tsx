// src/components/SaveNamePromptModal.tsx
// Android の単一ファイル保存の直前に、保存先フォルダとファイル名を
// 確認・編集させるモーダル。デスクトップのネイティブ「名前を付けて
// 保存」ダイアログに相当する、保存先を変更する最後の機会。
//
// 「変更」ボタンはシステムのフォルダピッカー(ACTION_OPEN_DOCUMENT_TREE)
// をその場で開き直す。システムのピッカーはフォルダ内でのサブフォルダ
// 新規作成にも対応しているため、「サブフォルダを作って保存したい」場合も
// ここから行える。

import { useEffect, useRef, useState } from "react";
import { persistAndroidSaveFolder, pickAndPersistSaveFolder } from "../lib/androidSaveFolder";
import { useI18n } from "../lib/i18n";
import { type GrantedFolder, listGrantedFolders, type PickedFolder } from "../lib/tauri";
import { F } from "../lib/theme";
import { FS } from "../lib/typography";
import { useSaveNamePromptStore } from "../store/useSaveNamePromptStore";

export function SaveNamePromptModal() {
  const { request, resolve } = useSaveNamePromptStore();
  const { t } = useI18n();
  const [nameInput, setNameInput] = useState("");
  const [folder, setFolder] = useState<PickedFolder | null>(null);
  const [granted, setGranted] = useState<GrantedFolder[]>([]);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (request) {
      setNameInput(request.suggestedName);
      setFolder(request.folder);
    }
  }, [request]);

  // 既に権限を持っているフォルダの一覧。ここから選べばシステムの
  // フォルダピッカー(毎回出る権限確認)を開かずに保存先を切り替えられる。
  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    listGrantedFolders()
      .then((list) => {
        if (!cancelled) setGranted(list);
      })
      .catch(() => {
        if (!cancelled) setGranted([]);
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  // モーダル表示直後に入力欄へフォーカスする(autoFocus属性の代わり)。
  useEffect(() => {
    if (request) {
      nameInputRef.current?.focus();
    }
  }, [request]);

  if (!request) return null;

  const confirm = () => {
    const name = nameInput.trim();
    if (name && folder) resolve({ name, folder });
  };

  const changeFolder = async () => {
    // 明示的に選び直した場合は、以後の既定値としても更新される。
    const picked = await pickAndPersistSaveFolder();
    if (picked) setFolder(picked);
  };

  // 許可済みフォルダを選ぶ(OSの権限確認なし)。
  const selectGrantedFolder = (g: GrantedFolder) => {
    const picked: PickedFolder = { treeUri: g.treeUri, folderName: g.folderName };
    setFolder(picked);
    persistAndroidSaveFolder(picked);
  };

  const otherGranted = granted.filter((g) => g.treeUri !== folder?.treeUri);

  return (
    <>
      <div style={s.overlay} aria-hidden />
      <div role="dialog" aria-modal="true" aria-label={t("save_name_prompt.title")} style={s.modal}>
        <div style={s.header}>
          <span style={s.headerTitle}>{t("save_name_prompt.title")}</span>
        </div>

        <div style={s.body}>
          <fieldset style={s.fieldset}>
            <legend style={{ ...s.label, padding: 0, border: "none", width: "100%" }}>
              {t("save_name_prompt.folder_label")}
            </legend>
            <div style={s.folderRow}>
              <div style={s.folderPath} title={folder?.folderName ?? ""}>
                {folder?.folderName ?? ""}
              </div>
              <button type="button" style={s.changeBtn} onClick={changeFolder}>
                {t("save_name_prompt.change_folder")}
              </button>
            </div>
            {otherGranted.length > 0 && (
              <div style={s.grantedBox}>
                <span style={s.grantedLabel}>{t("save_name_prompt.granted_label")}</span>
                <div style={s.grantedList}>
                  {otherGranted.map((g) => (
                    <button
                      key={g.treeUri}
                      type="button"
                      style={s.grantedBtn}
                      title={g.folderPath ?? g.folderName}
                      onClick={() => selectGrantedFolder(g)}
                    >
                      <span style={s.grantedName}>{g.folderName}</span>
                      {g.folderPath && <span style={s.grantedPath}>{g.folderPath}</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </fieldset>
          <div style={s.form}>
            <label style={s.label} htmlFor="save-name-prompt-input">
              {t("save_name_prompt.input_label")}
            </label>
            <input
              ref={nameInputRef}
              id="save-name-prompt-input"
              style={s.input}
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
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
  fieldset: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    border: "none",
    padding: 0,
    margin: 0,
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
  grantedBox: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  grantedLabel: {
    fontSize: FS.caption,
    color: "var(--c-textSub)",
  },
  grantedList: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    maxHeight: 140,
    overflowY: "auto",
  },
  grantedBtn: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 2,
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid var(--c-border)",
    background: "var(--c-bg)",
    color: "var(--c-text)",
    fontSize: FS.body,
    fontFamily: F,
    cursor: "pointer",
    textAlign: "left" as const,
    minWidth: 0,
  },
  grantedName: {
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  grantedPath: {
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
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
