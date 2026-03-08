// src/pages/CompressPage.tsx
// フロー: [プリセット選択] → [実行中] → [結果確認] → [保存]

import { useState, useCallback } from "react";
import { useSaveDialog } from "../hooks/useSaveDialog";
import { usePdfStore }   from "../store/usePdfStore";
import {
  compressPdf, getTmpPath, renderPage,
  type CompressPreset, type CompressResponse, type PdfInfo,
} from "../lib/tauri";

interface Props {
  filePath:    string;
  pdfInfo:     PdfInfo;
  /** トリム後の一時ファイルを続けて圧縮する場合に渡す */
  sourceFile?: string;
  /** 「完了/スキップ」ボタンのコールバック */
  onDone?:     () => void;
}

type Phase = "edit" | "processing" | "result" | "error";

const PRESETS: {
  id: CompressPreset; icon: string; label: string;
  desc: string; note: string; accent: string;
}[] = [
  { id: "light",      icon: "☁",  label: "軽め",
    desc: "gc=1、画像圧縮なし",
    note: "フォント完全保護。削減効果は小さめ",
    accent: "#2a6a3a" },
  { id: "standard",   icon: "⚖",  label: "標準",
    desc: "gc=2、画像圧縮あり",
    note: "バランス重視。ほとんどのPDFに安全",
    accent: "#1a4a8a" },
  { id: "aggressive", icon: "⚡", label: "強め",
    desc: "gc=3、sanitize=true",
    note: "⚠ 埋め込みフォントに影響する場合あり",
    accent: "#6a4a1a" },
  { id: "maximum",    icon: "🔥", label: "最大",
    desc: "gc=4、sanitize=true",
    note: "⚠ 最大圧縮。フォントへの影響リスク高",
    accent: "#6a1a1a" },
];

export function CompressPage({ filePath, pdfInfo, sourceFile, onDone }: Props) {
  const { setError } = usePdfStore();
  const { pickSave } = useSaveDialog();

  const inputFile = sourceFile ?? filePath;

  const [phase,    setPhase]   = useState<Phase>("edit");
  const [preset,   setPreset]  = useState<CompressPreset>("standard");
  const [result,   setResult]  = useState<CompressResponse | null>(null);
  const [preview,  setPreview] = useState<string>("");
  const [errMsg,   setErrMsg]  = useState("");
  const [isSaving, setSaving]  = useState(false);

  // ── 実行 ────────────────────────────────────────────────────────────────
  const handleExecute = useCallback(async () => {
    setPhase("processing");
    try {
      const tmp = await getTmpPath("kozou_compress_preview.pdf");
      const res = await compressPdf(inputFile, tmp, { preset });
      setResult(res);
      try { setPreview(await renderPage(tmp, 0, 96)); }
      catch { setPreview(""); }
      setPhase("result");
    } catch (e) {
      setErrMsg(String(e));
      setPhase("error");
      setError(String(e));
    }
  }, [inputFile, preset, setError]);

  // ── 保存 ────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const base = filePath.split(/[/\\]/).pop()?.replace(/\.pdf$/i, "") ?? "file";
    const savePath = await pickSave(`${base}_compressed.pdf`);
    if (!savePath) return;
    setSaving(true);
    try {
      await compressPdf(inputFile, savePath, { preset });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [inputFile, filePath, preset, pickSave, setError]);

  // ── 処理中 ─────────────────────────────────────────────────────────────
  if (phase === "processing") {
    return (
      <div style={s.center}>
        <div style={s.spinner} />
        <span style={s.centSub}>圧縮処理中…</span>
      </div>
    );
  }

  // ── エラー ─────────────────────────────────────────────────────────────
  if (phase === "error") {
    return (
      <div style={s.center}>
        <span style={s.errIcon}>✕</span>
        <span style={s.errTitle}>エラーが発生しました</span>
        <pre style={s.errMsg}>{errMsg}</pre>
        <button style={s.errBtn} onClick={() => setPhase("edit")}>← 戻る</button>
      </div>
    );
  }

  // ── 結果確認 ────────────────────────────────────────────────────────────
  if (phase === "result" && result) {
    const inMB  = (result.input_bytes  / 1048576).toFixed(2);
    const outMB = (result.output_bytes / 1048576).toFixed(2);
    const pct   = ((1 - result.ratio) * 100).toFixed(1);
    const gain  = Number(pct) > 0;
    const p     = result.params_used;

    return (
      <div style={s.root}>
        <div style={s.header}>
          <button style={s.btnBack} onClick={() => setPhase("edit")}>← 設定に戻る</button>
          <span style={s.title}>圧縮結果</span>
          <div style={{ flex: 1 }} />
          <button
            style={{ ...s.btnSave, ...(isSaving ? s.btnDis : {}) }}
            onClick={handleSave} disabled={isSaving}
          >
            {isSaving ? "保存中…" : "💾 PDFを保存"}
          </button>
          {onDone && (
            <button style={s.btnSkip} onClick={onDone}>完了</button>
          )}
        </div>

        <div style={s.resultBody}>
          {/* 左: プレビュー */}
          <div style={s.prevCol}>
            {preview
              ? <img src={`data:image/jpeg;base64,${preview}`} style={s.prevImg} alt="preview" />
              : <div style={s.prevPh}>プレビューなし</div>}
            <span style={s.prevSub}>{pdfInfo.page_count} ページ</span>
          </div>

          {/* 右: 統計 */}
          <div style={s.statsCol}>
            <div style={{ ...s.statBig, color: gain ? "#4fe090" : "#ff6060" }}>
              {gain ? `−${pct}%` : `+${Math.abs(Number(pct))}%`}
              <span style={s.statBigSub}>{gain ? "削減" : "増加"}</span>
            </div>
            <div style={s.statRow}>
              <StatCard label="元のサイズ" val={`${inMB} MB`} />
              <span style={s.arrow}>→</span>
              <StatCard label="圧縮後"     val={`${outMB} MB`} accent />
            </div>

            <div style={s.paramsBox}>
              <span style={s.paramsHd}>使用パラメータ</span>
              <PRow label="プリセット"   val={preset} />
              <PRow label="GCレベル"     val={String(p.garbage_level)} />
              <PRow label="画像圧縮"     val={p.compress_images ? "あり" : "なし"} />
              <PRow label="フォント圧縮" val={p.compress_fonts  ? "あり" : "なし"} />
              <PRow label="sanitize"    val={p.sanitize ? "あり" : "なし"} />
              {p.rewrite_fallback && (
                <div style={s.warnBox}>⚠ Type3フォント検出 → フォールバックモード</div>
              )}
            </div>

            {result.warning && <div style={s.warnBox}>{result.warning}</div>}
          </div>
        </div>

        <div style={s.footer}>
          <button style={s.btnBack} onClick={() => setPhase("edit")}>← 設定に戻る</button>
          <button
            style={{ ...s.btnSave, ...(isSaving ? s.btnDis : {}) }}
            onClick={handleSave} disabled={isSaving}
          >
            {isSaving ? "保存中…" : "💾 PDFを保存"}
          </button>
        </div>
      </div>
    );
  }

  // ── 設定画面 ────────────────────────────────────────────────────────────
  const fname = inputFile.split(/[/\\]/).pop() ?? "";

  return (
    <div style={s.root}>
      <div style={s.header}>
        {sourceFile && (
          <span style={s.chainBadge}>✂ トリム済みファイルを圧縮</span>
        )}
        <span style={s.title}>圧縮設定</span>
        <span style={s.fileSub} title={fname}>{fname}</span>
        <span style={s.pageSub}>{pdfInfo.page_count} ページ</span>
        <div style={{ flex: 1 }} />
        {onDone && (
          <button style={s.btnSkip} onClick={onDone}>スキップ</button>
        )}
      </div>

      <div style={s.presetGrid}>
        {PRESETS.map(p => (
          <button key={p.id}
            onClick={() => setPreset(p.id)}
            style={{
              ...s.card,
              ...(preset === p.id
                ? { borderColor: p.accent, background: p.accent + "28" }
                : {}),
            }}
          >
            <span style={s.cardIcon}>{p.icon}</span>
            <span style={s.cardLabel}>{p.label}</span>
            <span style={s.cardDesc}>{p.desc}</span>
            <span style={s.cardNote}>{p.note}</span>
          </button>
        ))}
      </div>

      <div style={s.execArea}>
        <button style={s.btnExec} onClick={handleExecute}>
          プレビュー実行 →
        </button>
      </div>
    </div>
  );
}

function StatCard({ label, val, accent }: { label: string; val: string; accent?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <span style={{ fontSize: 10, color: "#5a6070" }}>{label}</span>
      <span style={{ fontSize: 18, fontWeight: 700, color: accent ? "#4f9eff" : "#c8cad8" }}>{val}</span>
    </div>
  );
}

function PRow({ label, val }: { label: string; val: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #1a1d24", fontSize: 11 }}>
      <span style={{ color: "#5a6070" }}>{label}</span>
      <span style={{ color: "#c8cad8" }}>{val}</span>
    </div>
  );
}

const F = "'JetBrains Mono','Noto Sans JP',monospace";

const s: Record<string, React.CSSProperties> = {
  root:    { display:"flex", flexDirection:"column", height:"100%", background:"#0a0c10", color:"#e8eaf0", fontFamily:F, overflow:"hidden" },
  center:  { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:16, background:"#0a0c10" },
  spinner: { width:30, height:30, border:"3px solid #1a2030", borderTop:"3px solid #4f9eff", borderRadius:"50%", animation:"spin 0.8s linear infinite" },
  centSub: { color:"#5a6070", fontSize:12 },

  header:    { display:"flex", alignItems:"center", gap:10, padding:"12px 20px", borderBottom:"1px solid #1a1d24", flexShrink:0 },
  chainBadge:{ padding:"3px 10px", background:"#0d1a2d", border:"1px solid #4f9eff", borderRadius:12, color:"#4f9eff", fontSize:10 },
  title:     { fontSize:15, fontWeight:700, color:"#c8cad8" },
  fileSub:   { fontSize:11, color:"#4a5060", maxWidth:220, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  pageSub:   { fontSize:10, color:"#3a4050" },
  btnBack:   { padding:"5px 14px", background:"transparent", border:"1px solid #2a2e38", borderRadius:6, color:"#5a6070", cursor:"pointer", fontSize:11, fontFamily:F },
  btnSave:   { padding:"8px 22px", background:"#1a4a8a", border:"1px solid #4f9eff", borderRadius:7, color:"#4f9eff", fontWeight:700, cursor:"pointer", fontSize:13, fontFamily:F },
  btnSkip:   { padding:"5px 14px", background:"transparent", border:"1px solid #2a2e38", borderRadius:6, color:"#5a6070", cursor:"pointer", fontSize:11, fontFamily:F },
  btnDis:    { opacity:0.4, cursor:"not-allowed" },

  presetGrid:{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:14, padding:"28px 24px 0" },
  card:      { display:"flex", flexDirection:"column", alignItems:"center", gap:8, padding:"20px 10px", background:"#0d1017", border:"1px solid #1a1d24", borderRadius:12, cursor:"pointer", transition:"all 0.15s", fontFamily:F, color:"#e8eaf0" },
  cardIcon:  { fontSize:28 },
  cardLabel: { fontSize:14, fontWeight:700, color:"#c8cad8" },
  cardDesc:  { fontSize:10, color:"#5a6070", textAlign:"center" },
  cardNote:  { fontSize:9, color:"#3a4050", textAlign:"center", lineHeight:1.5 },

  execArea:{ display:"flex", justifyContent:"center", padding:"32px 0" },
  btnExec: { padding:"14px 52px", background:"#1a4a8a", border:"1px solid #4f9eff", borderRadius:10, color:"#4f9eff", fontWeight:700, fontSize:15, cursor:"pointer", fontFamily:F, letterSpacing:"0.04em" },

  resultBody:{ flex:1, display:"flex", gap:24, padding:24, overflow:"auto" },
  prevCol:   { display:"flex", flexDirection:"column", alignItems:"center", gap:10, flexShrink:0 },
  prevImg:   { maxWidth:260, maxHeight:360, borderRadius:6, border:"1px solid #1a1d24" },
  prevPh:    { width:220, height:300, background:"#0d1017", borderRadius:6, display:"flex", alignItems:"center", justifyContent:"center", color:"#3a4050", fontSize:12 },
  prevSub:   { fontSize:10, color:"#4a5060" },
  statsCol:  { flex:1, display:"flex", flexDirection:"column", gap:14 },
  statBig:   { fontSize:42, fontWeight:800, display:"flex", alignItems:"baseline", gap:8, lineHeight:1 },
  statBigSub:{ fontSize:14, fontWeight:400, color:"#5a6070" },
  statRow:   { display:"flex", alignItems:"center", gap:20, padding:"14px 16px", background:"#0d1017", borderRadius:8, border:"1px solid #1a1d24" },
  arrow:     { fontSize:20, color:"#3a4050" },
  paramsBox: { padding:"12px 14px", background:"#0d1017", borderRadius:8, border:"1px solid #1a1d24", display:"flex", flexDirection:"column", gap:1 },
  paramsHd:  { fontSize:10, color:"#5a6070", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:6 },
  warnBox:   { padding:"8px 12px", background:"#2a1a0a", border:"1px solid #5a3a1a", borderRadius:6, color:"#cc8844", fontSize:11 },

  footer: { display:"flex", justifyContent:"flex-end", gap:10, padding:"12px 20px", borderTop:"1px solid #1a1d24", flexShrink:0 },

  errIcon:  { fontSize:36, color:"#ff4444" },
  errTitle: { fontSize:14, fontWeight:600, color:"#ff6060" },
  errMsg:   { fontSize:11, color:"#cc4444", background:"#1a0808", border:"1px solid #3a1212", borderRadius:6, padding:"10px 14px", maxWidth:480, whiteSpace:"pre-wrap", wordBreak:"break-all" },
  errBtn:   { padding:"8px 20px", background:"transparent", border:"1px solid #3a2020", borderRadius:7, color:"#cc4444", cursor:"pointer", fontSize:13, fontFamily:F },
};
