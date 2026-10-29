// src/components/EngineFallbackLog.tsx
// バッチ処理のログで、そのファイルの処理中に hayro から MuPDF へ切り替わった記録を
// 進捗行の下に注記として出す。記録はバッチ側が 1 ファイルごとに take() して渡す。
// 記録が無いときは何も描画しない。

import { formatPages } from "../lib/engineFallback";
import { useI18n } from "../lib/i18n";
import { FS } from "../lib/typography";
import type { EngineFallbackEntry } from "../store/useEngineFallbackStore";

export function opLabelKey(op: string): string {
  return `engine_fallback.op.${op.replace(/-/g, "_")}`;
}

/** バッチの結果行に持たせる、表示に必要な分だけの記録 */
export type BatchFallback = Pick<EngineFallbackEntry, "op" | "reason" | "pages">;

export function toBatchFallbacks(entries: EngineFallbackEntry[]): BatchFallback[] {
  return entries.map(({ op, reason, pages }) => ({ op, reason, pages }));
}

export function EngineFallbackNotes({ fallbacks }: { fallbacks?: BatchFallback[] }) {
  const { t } = useI18n();
  if (!fallbacks || fallbacks.length === 0) return null;
  return (
    <div
      style={{
        flexBasis: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        paddingLeft: 18,
      }}
    >
      {fallbacks.map((f) => (
        <div key={`${f.op}\u0000${f.reason}`} style={{ fontSize: FS.caption, wordBreak: "break-all" }}>
          <span style={{ color: "var(--c-warn)" }}>⚠ </span>
          <span style={{ color: "var(--c-text)" }}>
            {t("engine_fallback.log", { op: t(opLabelKey(f.op)) })}
            {f.pages.length > 0
              ? ` (${t("engine_fallback.pages", { pages: formatPages(f.pages) })})`
              : ""}
          </span>{" "}
          <span style={{ color: "var(--c-textSub)" }}>
            {t("engine_fallback.reason", { reason: f.reason })}
          </span>
        </div>
      ))}
    </div>
  );
}
