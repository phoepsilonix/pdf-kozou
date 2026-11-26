// src/components/GidFixNotice.tsx
// GID 補正がオフのとき、補正が必要なファイルを開いた (情報を読んだ) ことを、画面左下に通知する。
// 「オンにする」で補正をオンにできる。自動では消さずに ✕ で閉じる (新しいファイルが加わるとまた出る)。

import { changeGidFix } from "../lib/gidFix";
import { useI18n } from "../lib/i18n";
import { FS } from "../lib/typography";
import { useGidFixNoticeStore } from "../store/useGidFixNoticeStore";

export function GidFixNotice() {
  const { t } = useI18n();
  const entries = useGidFixNoticeStore((s) => s.entries);
  const dismissed = useGidFixNoticeStore((s) => s.dismissed);
  const dismiss = useGidFixNoticeStore((s) => s.dismiss);
  const files = Object.keys(entries).length;
  if (dismissed || files === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        left: 12,
        bottom: "calc(12px + env(safe-area-inset-bottom))",
        zIndex: 9999,
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "8px 10px",
        background: "var(--c-warnBg)",
        border: "1px solid var(--c-warnBd)",
        borderRadius: 8,
        boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
        maxWidth: "min(420px, calc(100vw - 24px))",
      }}
    >
      <span style={{ color: "var(--c-warn)", fontSize: FS.body }}>⚠</span>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: FS.small, color: "var(--c-text)" }}>
          {t("gid_fix.notice_message", { files: String(files) })}
        </span>
        <button
          type="button"
          onClick={() => void changeGidFix("on").catch(() => {})}
          style={{
            alignSelf: "flex-start",
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid var(--c-borderHi)",
            background: "var(--c-bg)",
            color: "var(--c-text)",
            fontSize: FS.small,
            cursor: "pointer",
          }}
        >
          {t("gid_fix.notice_turn_on")}
        </button>
      </div>
      <button
        type="button"
        aria-label={t("gid_fix.notice_close")}
        onClick={dismiss}
        style={{
          background: "none",
          border: "none",
          color: "var(--c-textSub)",
          cursor: "pointer",
          fontSize: FS.body,
        }}
      >
        ✕
      </button>
    </div>
  );
}
