// src/components/trim/TrimControls.tsx
// 余白指定パネル: 上下左右それぞれ「何mm削るか」を指定 + ページ範囲/抽出

import { useCallback } from "react";
import type { TrimMargins, PageSelection } from "../../lib/tauri";
import { PageSelector, PageSelectorB, resolvePageSpec } from "../PageSelector";
import { F } from "../../lib/theme";

interface Props {
  margins:      TrimMargins;
  pageW:        number;
  pageH:        number;
  trimPages:    string;
  onPages:      (v: string) => void;
  totalPages:   number;
  onMargins:    (m: TrimMargins) => void;
  onApply:      () => void;
  onReset:      () => void;
  processing:   boolean;
  // ページ除外指定 (トリミング除外対象)
  excludeSpec:  string;
  onExclude:    (v: string) => void;
  // ページ抽出 (出力に含めるページ)
  extractSpec:  string;
  onExtract:    (v: string) => void;
}

const PT_TO_MM = 1 / 2.8346;
const MM_TO_PT = 2.8346;
const toMm  = (pt: number) => +(pt * PT_TO_MM).toFixed(1);
const toPt  = (mm: number) => mm * MM_TO_PT;

export function TrimControls({
  margins, pageW, pageH, trimPages, totalPages,
  onMargins, onPages, onApply, onReset, processing,
  excludeSpec, onExclude,
  extractSpec, onExtract,
}: Props) {
  const set = useCallback((key: keyof TrimMargins, mm: number) => {
    onMargins({ ...margins, [key]: toPt(Math.max(0, mm)) });
  }, [margins, onMargins]);

  const trimW = toMm(pageW - margins.left - margins.right);
  const trimH = toMm(pageH - margins.top - margins.bottom);
  const origW = toMm(pageW);
  const origH = toMm(pageH);

  return (
    <div style={s.panel}>
      <section style={s.section}>
        <h3 style={s.heading}>削る余白 (mm)</h3>
        <div style={s.cross}>
          <div style={s.crossTop}>
            <MmField label="上" value={toMm(margins.top)}
              max={toMm(pageH - margins.bottom - MM_TO_PT)}
              onChange={v => set("top", v)} />
          </div>
          <div style={s.crossMid}>
            <MmField label="左" value={toMm(margins.left)}
              max={toMm(pageW - margins.right - MM_TO_PT)}
              onChange={v => set("left", v)} />
            <div style={s.pageBox}>
              <span style={s.pageSize}>{origW} × {origH}</span>
              <span style={s.pageUnit}>mm (元)</span>
              <span style={s.arrow}>↓</span>
              <span style={{ ...s.pageSize, color: "var(--c-accent)" }}>{trimW} × {trimH}</span>
              <span style={s.pageUnit}>mm (後)</span>
            </div>
            <MmField label="右" value={toMm(margins.right)}
              max={toMm(pageW - margins.left - MM_TO_PT)}
              onChange={v => set("right", v)} />
          </div>
          <div style={s.crossBot}>
            <MmField label="下" value={toMm(margins.bottom)}
              max={toMm(pageH - margins.top - MM_TO_PT)}
              onChange={v => set("bottom", v)} />
          </div>
        </div>
      </section>

      {/* トリミング適用ページ - PageSelector に置き換え。基本は全ページ適用。 */}
      <section style={s.section}>
        <h3 style={s.heading}>トリミング適用ページ</h3>
        <PageSelector
          totalPages={totalPages}
          value={trimPages}
          onChange={onPages}
          label="トリミング適用ページ (all/even/odd/1-5,7)"
	  type="1"
          compact
        />
      </section>
      <section style={s.section}>
        <h3 style={s.heading}>トリミング除外ページ</h3>
        <PageSelector
          totalPages={totalPages}
          value={excludeSpec}
          onChange={(v) => onExclude(v)}
          label="除外ページ (all/even/odd/1-5,7)"
	  type="2"
          compact
        />
      </section>

      <section style={s.section}>
        <h3 style={s.heading}>ページ抽出 <span style={s.headingOpt}>（オプション）</span></h3>
        <p style={s.hint2}>トリミング後に残すページを指定。空欄=全ページ保持。</p>
        <PageSelector
          totalPages={totalPages}
          value={extractSpec}
          onChange={onExtract}
          label="抽出ページ (all/even/odd/1-5,7)"
	  type="1"
          compact
        />
      </section>

      <section style={s.actions}>
        <button style={s.btnReset} onClick={onReset} disabled={processing}>リセット</button>
        <button style={{ ...s.btnApply, ...(processing ? s.btnDisabled : {}) }}
          onClick={onApply} disabled={processing}>
          {processing ? "処理中…" : "プレビュー →"}
        </button>
      </section>

      <p style={s.hint}>💡 画像の枠をドラッグして余白を調整できます</p>
    </div>
  );
}

function MmField({ label, value, max, onChange }: {
  label: string; value: number; max: number; onChange: (v: number) => void;
}) {
  return (
    <div style={s.field}>
      <label style={s.fieldLabel}>{label}</label>
      <input type="number" style={s.input}
        value={value} min={0} max={max} step={0.5}
        onChange={e => onChange(parseFloat(e.target.value) || 0)} />
      <span style={s.unit}>mm</span>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  panel: {
    display:"flex", flexDirection:"column", gap:18,
    padding:"18px 14px", background:"var(--c-bgCard)", color:"var(--c-text)",
    fontFamily:F, fontSize:14, height:"100%", overflowY:"auto",
  },
  section:    { display:"flex", flexDirection:"column", gap:10 },
  heading:    { margin:0, fontSize:11, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--c-textDim)" },
  headingOpt: { fontSize:10, color:"var(--c-textDim)", fontWeight:400, letterSpacing:0, textTransform:"none" },
  hint2:      { margin:0, fontSize:11, color:"var(--c-textSub)", lineHeight:1.5 },

  cross:    { display:"flex", flexDirection:"column", alignItems:"center", gap:8 },
  crossTop: { display:"flex", justifyContent:"center" },
  crossMid: { display:"flex", alignItems:"center", gap:12 },
  crossBot: { display:"flex", justifyContent:"center" },

  pageBox:  { display:"flex", flexDirection:"column", alignItems:"center", gap:2, minWidth:100 },
  pageSize: { fontSize:12, color:"var(--c-textSub)" },
  pageUnit: { fontSize:10, color:"var(--c-textDim)" },
  arrow:    { fontSize:14, color:"var(--c-textDim)" },

  field:      { display:"flex", flexDirection:"column", alignItems:"center", gap:4 },
  fieldLabel: { fontSize:12, color:"var(--c-textSub)", fontWeight:600 },
  input: {
    width:76, padding:"7px 6px",
    background:"var(--c-bg)", border:`1px solid var(--c-borderHi)`, borderRadius:7,
    color:"var(--c-text)", fontSize:26, textAlign:"center",
    outline:"none", fontFamily:F, fontWeight:700,
  },
  unit: { fontSize:10, color:"var(--c-textDim)" },

  chips: { display:"flex", gap:6, flexWrap:"wrap" },
  chip: {
    padding:"6px 12px", borderRadius:16,
    border:`1px solid var(--c-borderHi)`, background:"var(--c-bgCard)",
    color:"var(--c-textSub)", cursor:"pointer", fontSize:12,
    fontFamily:F, transition:"all 0.12s",
  },
  chipOn: { background:"var(--c-accentBg)", border:"1px solid var(--c-accentBd)", color:"var(--c-accent)" },

  actions:    { display:"flex", gap:8 },
  btnReset:   { padding:"10px 14px", background:"transparent", border:`1px solid var(--c-borderHi)`, borderRadius:7, color:"var(--c-textSub)", cursor:"pointer", fontFamily:F, fontSize:13 },
  btnApply:   { flex:1, padding:"10px 0", background:"var(--c-accentBg)", border:`1px solid var(--c-accentBd)`, borderRadius:7, color:"var(--c-accent)", fontWeight:700, cursor:"pointer", fontFamily:F, fontSize:14 },
  btnDisabled:{ opacity:0.4, cursor:"not-allowed" },
  hint:       { margin:0, fontSize:11, color:"var(--c-textDim)", lineHeight:1.6 },
};
