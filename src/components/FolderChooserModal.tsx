// src/components/FolderChooserModal.tsx
// Android のバッチ出力の保存先選択。許可済みフォルダの一覧から選べば
// システムのフォルダピッカー(OSの権限確認)を開かずに切り替えられる。
// 一覧に無いフォルダは「他のフォルダを選ぶ」でシステムのピッカーを開く。

import { useI18n } from "../lib/i18n";
import { F } from "../lib/theme";
import { FS } from "../lib/typography";
import { useFolderChooserStore } from "../store/useFolderChooserStore";

export function FolderChooserModal() {
  const { request, resolve } = useFolderChooserStore();
  const { t } = useI18n();

  if (!request) return null;

  return (
    <>
      <div style={s.overlay} aria-hidden />
      <div role="dialog" aria-modal="true" aria-label={t("folder_chooser.title")} style={s.modal}>
        <div style={s.header}>
          <span style={s.headerTitle}>{t("folder_chooser.title")}</span>
        </div>
        <div style={s.body}>
          <span style={s.note}>{t("folder_chooser.note")}</span>
          <div style={s.list}>
            {request.folders.map((g) => {
              const selected = g.treeUri === request.current?.treeUri;
              return (
                <button
                  key={g.treeUri}
                  type="button"
                  style={selected ? { ...s.item, ...s.itemSelected } : s.item}
                  title={g.folderPath ?? g.folderName}
                  onClick={() => resolve(g)}
                >
                  <span style={s.itemName}>
                    {selected ? "✓ " : ""}
                    {g.folderName}
                  </span>
                  {g.folderPath && <span style={s.itemPath}>{g.folderPath}</span>}
                </button>
              );
            })}
          </div>
          <div style={s.btnRow}>
            <button type="button" style={s.cancelBtn} onClick={() => resolve(null)}>
              {t("folder_chooser.cancel")}
            </button>
            <button type="button" style={s.otherBtn} onClick={() => resolve("picker")}>
              {t("folder_chooser.other")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

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
    gap: 12,
    overflowY: "auto",
  },
  note: {
    fontSize: FS.caption,
    color: "var(--c-textSub)",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  item: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 2,
    padding: "10px 12px",
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
  itemSelected: {
    border: "1px solid var(--c-accent)",
  },
  itemName: {
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  itemPath: {
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    fontSize: FS.caption,
    color: "var(--c-textSub)",
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
  otherBtn: {
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid var(--c-borderHi)",
    background: "var(--c-bg)",
    color: "var(--c-text)",
    fontSize: FS.body,
    fontFamily: F,
    cursor: "pointer",
  },
};
