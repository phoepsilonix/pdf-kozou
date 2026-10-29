// src/components/EngineFallbackToast.tsx
// hayro から MuPDF へ自動でフォールバックしたことを、画面右下に通知する。
// バッチ処理のログ (EngineFallbackLog) が無い画面 (ビューア・単体の画像化など) でも
// 気付けるようにするためのもので、自動では消さずに ✕ で閉じる。
// バッチ処理中は出さない (ファイルごとの進捗行に出すため)。

import { baseName, formatPages } from "../lib/engineFallback";
import { useI18n } from "../lib/i18n";
import { FS } from "../lib/typography";
import { useEngineFallbackStore } from "../store/useEngineFallbackStore";
import { opLabelKey } from "./EngineFallbackLog";

/** 同時に出す通知の最大数 (新しいものを優先) */
const MAX_VISIBLE = 3;

export function EngineFallbackToast() {
  const { t } = useI18n();
  const entries = useEngineFallbackStore((s) => s.entries);
  const dismiss = useEngineFallbackStore((s) => s.dismiss);
  const suppressed = useEngineFallbackStore((s) => s.toastSuppressed);
  const visible = entries.filter((e) => !e.dismissed).slice(-MAX_VISIBLE);
  if (suppressed || visible.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        right: 12,
        bottom: "calc(12px + env(safe-area-inset-bottom))",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        maxWidth: "min(420px, calc(100vw - 24px))",
      }}
    >
      {visible.map((e) => (
        <div
          key={e.key}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "8px 10px",
            background: "var(--c-warnBg)",
            border: "1px solid var(--c-warnBd)",
            borderRadius: 8,
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          }}
        >
          <span style={{ color: "var(--c-warn)", fontSize: FS.body }}>⚠</span>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: FS.small, color: "var(--c-text)", wordBreak: "break-all" }}>
              {e.file ? `${baseName(e.file)} — ` : ""}
              {t("engine_fallback.log", { op: t(opLabelKey(e.op)) })}
              {e.pages.length > 0
                ? ` (${t("engine_fallback.pages", { pages: formatPages(e.pages) })})`
                : ""}
            </span>
            <span
              style={{ fontSize: FS.caption, color: "var(--c-textSub)", wordBreak: "break-all" }}
            >
              {t("engine_fallback.reason", { reason: e.reason })}
            </span>
          </div>
          <button
            type="button"
            aria-label={t("engine_fallback.close")}
            title={t("engine_fallback.close")}
            onClick={() => dismiss(e.key)}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--c-textSub)",
              cursor: "pointer",
              fontSize: FS.body,
              padding: 0,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
