// src/components/GidFixConfirmModal.tsx
// GID 補正がオフのまま、補正が必要なファイルを出力しようとしたときの確認モーダル。
// 補正をオンにして出力 / このまま出力 / キャンセル を選ばせる。
// useGidFixConfirmStore 経由で lib/gidFixGuard.ts から要求され、選択結果を Promise の解決として返す
// (モーダル自身は出力処理を知らない)。

import { useI18n } from "../lib/i18n";
import { F } from "../lib/theme";
import { FS } from "../lib/typography";
import { useGidFixConfirmStore } from "../store/useGidFixConfirmStore";

/** 表示するファイル名の最大数 (超える分は「ほか N 件」) */
const MAX_FILES = 5;

export function GidFixConfirmModal() {
  const { request, resolve } = useGidFixConfirmStore();
  const { t } = useI18n();
  if (!request) return null;

  const shown = request.files.slice(0, MAX_FILES);
  const rest = request.files.length - shown.length;

  return (
    <>
      <div style={s.overlay} aria-hidden />
      <div role="dialog" aria-modal="true" aria-label={t("gid_fix.confirm_title")} style={s.modal}>
        <div style={s.header}>
          <span style={s.headerTitle}>⚠️ {t("gid_fix.confirm_title")}</span>
        </div>
        <div style={s.body}>
          <p style={s.message}>
            {t(
              request.kind === "image"
                ? "gid_fix.confirm_message_image"
                : "gid_fix.confirm_message_pdf",
              { count: String(request.count) },
            )}
          </p>
          <ul style={s.files}>
            {shown.map((name) => (
              <li key={name}>{name}</li>
            ))}
            {rest > 0 && <li>{t("gid_fix.confirm_more", { n: String(rest) })}</li>}
          </ul>
          <div style={s.choices}>
            <button type="button" style={s.choiceBtn} onClick={() => resolve("on")}>
              {t("gid_fix.confirm_on")}
            </button>
            <button type="button" style={s.choiceBtn} onClick={() => resolve("continue")}>
              {t("gid_fix.confirm_continue")}
            </button>
            <button
              type="button"
              style={{ ...s.choiceBtn, ...s.cancelBtn }}
              onClick={() => resolve("cancel")}
            >
              {t("gid_fix.confirm_cancel")}
            </button>
          </div>
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
    width: "min(460px, 92vw)",
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
  },
  files: {
    margin: 0,
    paddingLeft: 20,
    fontSize: FS.small,
    color: "var(--c-textSub)",
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
