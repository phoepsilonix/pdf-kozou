// src/components/trim/TrimControls.tsx
//
// トリミング数値入力パネル
// Canvas の TrimCanvas と双方向同期する

import { useCallback } from "react";
import type { TrimMargins, PageSelection } from "../../lib/tauri";

interface Props {
  margins:    TrimMargins;
  pageW:      number;  // ページ幅 (pt) — 入力値の上限
  pageH:      number;
  pages:      PageSelection;
  onMargins:  (m: TrimMargins) => void;
  onPages:    (p: PageSelection) => void;
  onApply:    () => void;
  onReset:    () => void;
  processing: boolean;
}

// ── 単位変換ヘルパー ──────────────────────────────────────────────────────────
const PT_PER_MM = 2.8346;
const ptToMm  = (pt: number) => (pt / PT_PER_MM).toFixed(1);
const mmToPt  = (mm: number) => mm * PT_PER_MM;

// ── フィールド定義 ────────────────────────────────────────────────────────────
type FieldKey = "left" | "right" | "top" | "bottom";

interface Field {
  key:   FieldKey;
  label: string;
  icon:  string;
  max:   (pageW: number, pageH: number) => number;
}

const FIELDS: Field[] = [
  { key: "left",   label: "左",   icon: "←", max: (w) => w },
  { key: "right",  label: "右",   icon: "→", max: (w) => w },
  { key: "top",    label: "上",   icon: "↑", max: (_, h) => h },
  { key: "bottom", label: "下",   icon: "↓", max: (_, h) => h },
];

export function TrimControls({
  margins, pageW, pageH, pages,
  onMargins, onPages, onApply, onReset, processing,
}: Props) {

  const handleMm = useCallback((key: FieldKey, mmStr: string) => {
    const mm = parseFloat(mmStr);
    if (isNaN(mm)) return;
    const pt = mmToPt(mm);
    onMargins({ ...margins, [key]: pt });
  }, [margins, onMargins]);

  const pageOptions: { label: string; value: PageSelection }[] = [
    { label: "全ページ",   value: { type: "All" } },
    { label: "偶数ページ", value: { type: "Even" } },
    { label: "奇数ページ", value: { type: "Odd" } },
  ];

  return (
    <div style={styles.panel}>
      {/* ── ページ選択 ─────────────────────────────────────────────────────── */}
      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>適用ページ</h3>
        <div style={styles.chipRow}>
          {pageOptions.map(opt => (
            <button
              key={opt.label}
              style={{
                ...styles.chip,
                ...(pages.type === opt.value.type ? styles.chipActive : {}),
              }}
              onClick={() => onPages(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      {/* ── マージン入力 (mm) ─────────────────────────────────────────────── */}
      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>トリミング位置 (mm)</h3>

        {/* 上 */}
        <div style={styles.crossLayout}>
          <div style={styles.crossTop}>
            <MmInput
              icon="↑" label="上"
              value={parseFloat(ptToMm(margins.top))}
              max={parseFloat(ptToMm(pageH))}
              onChange={v => handleMm("top", String(v))}
            />
          </div>
          <div style={styles.crossMiddle}>
            <MmInput
              icon="←" label="左"
              value={parseFloat(ptToMm(margins.left))}
              max={parseFloat(ptToMm(pageW))}
              onChange={v => handleMm("left", String(v))}
            />
            {/* ページサイズ表示 */}
            <div style={styles.pageSize}>
              <span style={styles.pageSizeText}>
                {ptToMm(pageW)} × {ptToMm(pageH)} mm
              </span>
              <span style={styles.pageSizeUnit}>ページサイズ</span>
            </div>
            <MmInput
              icon="→" label="右"
              value={parseFloat(ptToMm(margins.right))}
              max={parseFloat(ptToMm(pageW))}
              onChange={v => handleMm("right", String(v))}
            />
          </div>
          <div style={styles.crossBottom}>
            <MmInput
              icon="↓" label="下"
              value={parseFloat(ptToMm(margins.bottom))}
              max={parseFloat(ptToMm(pageH))}
              onChange={v => handleMm("bottom", String(v))}
            />
          </div>
        </div>

        {/* ── 現在のトリム領域サイズ ──────────────────────────────────────── */}
        <div style={styles.resultBox}>
          <span style={styles.resultLabel}>トリム後サイズ</span>
          <span style={styles.resultValue}>
            {ptToMm(margins.right - margins.left)} ×{" "}
            {ptToMm(margins.top   - margins.bottom)} mm
          </span>
        </div>
      </section>

      {/* ── アクション ────────────────────────────────────────────────────── */}
      <section style={styles.actionRow}>
        <button style={styles.btnSecondary} onClick={onReset} disabled={processing}>
          リセット
        </button>
        <button
          style={{ ...styles.btnPrimary, ...(processing ? styles.btnDisabled : {}) }}
          onClick={onApply}
          disabled={processing}
        >
          {processing ? "処理中…" : "トリミング実行"}
        </button>
      </section>
    </div>
  );
}

// ── 数値入力サブコンポーネント ────────────────────────────────────────────────

interface MmInputProps {
  icon:     string;
  label:    string;
  value:    number;
  max:      number;
  onChange: (v: number) => void;
}

function MmInput({ icon, label, value, max, onChange }: MmInputProps) {
  return (
    <div style={styles.inputWrapper}>
      <label style={styles.inputLabel}>{icon} {label}</label>
      <input
        type="number"
        style={styles.input}
        value={value}
        min={0}
        max={max}
        step={0.1}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
      />
      <span style={styles.inputUnit}>mm</span>
    </div>
  );
}

// ── スタイル ──────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display:        "flex",
    flexDirection:  "column",
    gap:            20,
    padding:        "20px 16px",
    background:     "#111318",
    borderRadius:   12,
    color:          "#e8eaf0",
    fontFamily:     "'JetBrains Mono', 'Fira Code', monospace",
    fontSize:       13,
    minWidth:       240,
  },
  section: { display: "flex", flexDirection: "column", gap: 12 },
  sectionTitle: {
    margin: 0, fontSize: 11,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "#5a6070",
  },
  chipRow:   { display: "flex", gap: 6 },
  chip: {
    padding:      "5px 12px",
    borderRadius: 20,
    border:       "1px solid #2a2e38",
    background:   "#1a1d24",
    color:        "#7a8090",
    cursor:       "pointer",
    fontSize:     12,
    transition:   "all 0.15s",
  },
  chipActive: {
    background: "#1a3a5c",
    borderColor: "#4f9eff",
    color: "#4f9eff",
  },
  crossLayout: {
    display:       "flex",
    flexDirection: "column",
    alignItems:    "center",
    gap:           8,
  },
  crossTop:    { display: "flex", justifyContent: "center" },
  crossMiddle: { display: "flex", alignItems: "center", gap: 12 },
  crossBottom: { display: "flex", justifyContent: "center" },
  pageSize: {
    display:       "flex",
    flexDirection: "column",
    alignItems:    "center",
    gap:           2,
    minWidth:      80,
  },
  pageSizeText: { fontSize: 11, color: "#4a5060" },
  pageSizeUnit: { fontSize: 10, color: "#3a4050" },
  inputWrapper: {
    display:       "flex",
    flexDirection: "column",
    alignItems:    "center",
    gap:           3,
  },
  inputLabel: { fontSize: 10, color: "#5a6070" },
  input: {
    width:        "72px",
    padding:      "6px 8px",
    background:   "#1a1d24",
    border:       "1px solid #2a2e38",
    borderRadius: 6,
    color:        "#e8eaf0",
    fontSize:     13,
    textAlign:    "center",
    outline:      "none",
    fontFamily:   "inherit",
  },
  inputUnit: { fontSize: 10, color: "#3a4050" },
  resultBox: {
    display:        "flex",
    justifyContent: "space-between",
    alignItems:     "center",
    padding:        "8px 12px",
    background:     "#0d1117",
    borderRadius:   6,
    border:         "1px solid #2a2e38",
  },
  resultLabel: { fontSize: 11, color: "#5a6070" },
  resultValue: { fontSize: 13, color: "#4f9eff", fontWeight: 600 },
  actionRow: {
    display: "flex",
    gap: 8,
    marginTop: 4,
  },
  btnPrimary: {
    flex:         1,
    padding:      "10px 0",
    background:   "#1a4a8a",
    border:       "1px solid #4f9eff",
    borderRadius: 8,
    color:        "#4f9eff",
    fontSize:     13,
    fontWeight:   600,
    cursor:       "pointer",
    fontFamily:   "inherit",
    letterSpacing: "0.04em",
    transition:   "all 0.15s",
  },
  btnSecondary: {
    padding:      "10px 16px",
    background:   "transparent",
    border:       "1px solid #2a2e38",
    borderRadius: 8,
    color:        "#5a6070",
    fontSize:     13,
    cursor:       "pointer",
    fontFamily:   "inherit",
    transition:   "all 0.15s",
  },
  btnDisabled: {
    opacity: 0.4,
    cursor:  "not-allowed",
  },
};
