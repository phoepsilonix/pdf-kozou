import { useI18n } from "../lib/i18n";
import { PAGE_ORIENTATION_DEFS, PAGE_SIZE_DEFS } from "../lib/pageSize";
import { FS } from "../lib/typography";
import { usePdfStore } from "../store/usePdfStore";

/**
 * 標準ページサイズ設定セレクタ（共有コンポーネント）。
 * store の pageSizeId / pageOrientation を直接読み書きするため、
 * ホーム画面・結合画面など複数箇所で使っても設定値は共有される。
 *
 * 画像をPDF/画像に変換する際の出力ページサイズを決める。
 * PDF入力など既にサイズが確定しているものには適用されない。
 */
export function PageSizeSelector({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const { pageSizeId, pageOrientation, setPageSize } = usePdfStore();

  return (
    <div
      style={{
        border: "1px solid var(--c-border)",
        borderRadius: 8,
        padding: compact ? "8px 10px" : "10px 12px",
        background: "var(--c-surface, var(--c-bg))",
      }}
    >
      <div style={{ fontSize: FS.body, fontWeight: 600, marginBottom: 2 }}>
        {t("pagesize.title" as any)}
      </div>
      <div style={{ fontSize: FS.caption, color: "var(--c-textSub)", marginBottom: 8 }}>
        {t("pagesize.hint" as any)}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {PAGE_SIZE_DEFS.map((ps) => (
          <button
            type="button"
            key={ps.id}
            aria-label={t(ps.labelKey as any)}
            aria-pressed={pageSizeId === ps.id}
            onClick={(e) => {
              setPageSize(ps.id, pageOrientation);
              (e.currentTarget as HTMLButtonElement).blur();
            }}
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              border: `1px solid ${pageSizeId === ps.id ? "var(--c-accent, #e0457b)" : "var(--c-border)"}`,
              background: pageSizeId === ps.id ? "var(--c-accent, #e0457b)" : "transparent",
              color: pageSizeId === ps.id ? "#fff" : "var(--c-text)",
              fontSize: FS.body,
              fontWeight: pageSizeId === ps.id ? 700 : 400,
              cursor: "pointer",
            }}
          >
            {t(ps.labelKey as any)}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: FS.small, color: "var(--c-textSub)" }}>
          {t("pagesize.orientation" as any)}:
        </span>
        {PAGE_ORIENTATION_DEFS.map((o) => (
          <button
            type="button"
            key={o.id}
            aria-label={t(o.labelKey as any)}
            aria-pressed={pageOrientation === o.id && pageSizeId !== "image"}
            disabled={pageSizeId === "image"}
            onClick={(e) => {
              setPageSize(pageSizeId, o.id);
              (e.currentTarget as HTMLButtonElement).blur();
            }}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              border: `1px solid ${pageOrientation === o.id ? "var(--c-accent, #e0457b)" : "var(--c-border)"}`,
              background:
                pageOrientation === o.id && pageSizeId !== "image"
                  ? "var(--c-accent, #e0457b)"
                  : "transparent",
              color:
                pageSizeId === "image"
                  ? "var(--c-textDim)"
                  : pageOrientation === o.id
                    ? "#fff"
                    : "var(--c-text)",
              fontSize: FS.small,
              cursor: pageSizeId === "image" ? "default" : "pointer",
              opacity: pageSizeId === "image" ? 0.5 : 1,
            }}
          >
            {t(o.labelKey as any)}
          </button>
        ))}
      </div>
    </div>
  );
}
