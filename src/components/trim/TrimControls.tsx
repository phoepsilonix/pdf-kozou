// src/components/trim/TrimControls.tsx
// 余白指定パネル: 上下左右それぞれ「何mm削るか」を指定

import { useCallback } from "react";
import type { TrimMargins, PageSelection } from "../../lib/tauri";

interface Props {
  margins:    TrimMargins;  // pt単位の余白幅
  pageW:      number;       // ページ幅 pt
  pageH:      number;       // ページ高さ pt
  pages:      PageSelection;
  onMargins:  (m: TrimMargins) => void;
  onPages:    (p: PageSelection) => void;
  onApply:    () => void;
  onReset:    () => void;
  processing: boolean;
}

const PT_TO_MM = 1 / 2.8346;
const MM_TO_PT = 2.8346;

const toMm  = (pt: number)  => +(pt * PT_TO_MM).toFixed(1);
const toPt  = (mm: number)  => mm * MM_TO_PT;

const PAGE_OPTS: { label: string; value: PageSelection }[] = [
  { label: "全ページ",   value: { type: "All" } },
  { label: "偶数ページ", value: { type: "Even" } },
  { label: "奇数ページ", value: { type: "Odd" } },
];

export function TrimControls({
  margins, pageW, pageH, pages,
  onMargins, onPages, onApply, onReset, processing,
}: Props) {

  const set = useCallback((key: keyof TrimMargins, mm: number) => {
    onMargins({ ...margins, [key]: toPt(Math.max(0, mm)) });
  }, [margins, onMargins]);

  const trimW  = toMm(pageW  - margins.left - margins.right);
  const trimH  = toMm(pageH  - margins.top  - margins.bottom);
  const origW  = toMm(pageW);
  const origH  = toMm(pageH);

  return (
    <div style={s.panel}>
      {/* 余白指定 */}
      <section style={s.section}>
        <h3 style={s.heading}>削る余白 (mm)</h3>
        <div style={s.cross}>
          {/* 上 */}
          <div style={s.crossTop}>
            <MmField label="上" value={toMm(margins.top)}
              max={toMm(pageH - margins.bottom - MM_TO_PT)}
              onChange={v => set("top", v)} />
          </div>
          {/* 左・中央・右 */}
          <div style={s.crossMid}>
            <MmField label="左" value={toMm(margins.left)}
              max={toMm(pageW - margins.right - MM_TO_PT)}
              onChange={v => set("left", v)} />
            <div style={s.pageBox}>
              <span style={s.pageSize}>{origW} × {origH}</span>
              <span style={s.pageUnit}>mm (元サイズ)</span>
              <span style={s.arrow}>↓</span>
              <span style={{ ...s.pageSize, color: "#4f9eff" }}>{trimW} × {trimH}</span>
              <span style={s.pageUnit}>mm (トリム後)</span>
            </div>
            <MmField label="右" value={toMm(margins.right)}
              max={toMm(pageW - margins.left - MM_TO_PT)}
              onChange={v => set("right", v)} />
          </div>
          {/* 下 */}
          <div style={s.crossBot}>
            <MmField label="下" value={toMm(margins.bottom)}
              max={toMm(pageH - margins.top - MM_TO_PT)}
              onChange={v => set("bottom", v)} />
          </div>
        </div>
      </section>

      {/* 適用ページ */}
      <section style={s.section}>
        <h3 style={s.heading}>適用ページ</h3>
        <div style={s.chips}>
          {PAGE_OPTS.map(o => (
            <button key={o.label}
              style={{ ...s.chip, ...(pages.type === o.value.type ? s.chipOn : {}) }}
              onClick={() => onPages(o.value)}
            >{o.label}</button>
          ))}
        </div>
      </section>

      {/* アクション */}
      <section style={s.actions}>
        <button style={s.btnReset} onClick={onReset} disabled={processing}>
          リセット
        </button>
        <button
          style={{ ...s.btnApply, ...(processing ? s.btnDisabled : {}) }}
          onClick={onApply} disabled={processing}
        >
          {processing ? "処理中…" : "プレビュー →"}
        </button>
      </section>

      {/* ヒント */}
      <p style={s.hint}>
        💡 プレビュー画像の枠をドラッグして余白を調整できます
      </p>
    </div>
  );
}

// ── 数値入力サブコンポーネント ─────────────────────────────────────────────────

function MmField({ label, value, max, onChange }: {
  label: string; value: number; max: number; onChange: (v: number) => void;
}) {
  return (
    <div style={s.field}>
      <label style={s.fieldLabel}>{label}</label>
      <input
        type="number" style={s.input}
        value={value} min={0} max={max} step={0.5}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
      />
      <span style={s.unit}>mm</span>
    </div>
  );
}

// ── スタイル ──────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex", flexDirection: "column", gap: 20,
    padding: "18px 14px",
    background: "#0d1017", color: "#e8eaf0",
    fontFamily: "'JetBrains Mono','Noto Sans JP',monospace",
    fontSize: 13, height: "100%", overflowY: "auto",
  },
  section: { display: "flex", flexDirection: "column", gap: 10 },
  heading: { margin: 0, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "#5a6070" },

  cross:    { display: "flex", flexDirection: "column", alignItems: "center", gap: 6 },
  crossTop: { display: "flex", justifyContent: "center" },
  crossMid: { display: "flex", alignItems: "center", gap: 10 },
  crossBot: { display: "flex", justifyContent: "center" },

  pageBox:  { display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 90 },
  pageSize: { fontSize: 11, color: "#5a6070" },
  pageUnit: { fontSize: 9, color: "#3a4050" },
  arrow:    { fontSize: 12, color: "#2a3040" },

  field:      { display: "flex", flexDirection: "column", alignItems: "center", gap: 3 },
  fieldLabel: { fontSize: 10, color: "#5a6070" },
  input: {
    width: 68, padding: "5px 6px",
    background: "#1a1d24", border: "1px solid #2a2e38", borderRadius: 6,
    color: "#e8eaf0", fontSize: 13, textAlign: "center",
    outline: "none", fontFamily: "inherit",
  },
  unit: { fontSize: 9, color: "#3a4050" },

  chips: { display: "flex", gap: 5 },
  chip: {
    padding: "4px 10px", borderRadius: 16,
    border: "1px solid #2a2e38", background: "#1a1d24",
    color: "#7a8090", cursor: "pointer", fontSize: 11,
    fontFamily: "inherit", transition: "all 0.12s",
  },
  chipOn: { background: "#1a3a5c", borderColor: "#4f9eff", color: "#4f9eff" },

  actions: { display: "flex", gap: 8 },
  btnReset: {
    padding: "9px 12px", background: "transparent",
    border: "1px solid #2a2e38", borderRadius: 7,
    color: "#5a6070", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
  },
  btnApply: {
    flex: 1, padding: "9px 0",
    background: "#1a4a8a", border: "1px solid #4f9eff", borderRadius: 7,
    color: "#4f9eff", fontWeight: 600, cursor: "pointer",
    fontFamily: "inherit", fontSize: 13, letterSpacing: "0.03em",
  },
  btnDisabled: { opacity: 0.4, cursor: "not-allowed" },
  hint: { margin: 0, fontSize: 10, color: "#3a4050", lineHeight: 1.6 },
};
