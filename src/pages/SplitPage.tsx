// src/pages/SplitPage.tsx
// フロー: [モード選択 + サムネイル確認] → [出力先選択 → 実行] → [結果]

import { useEffect, useState, useCallback } from "react";
import { invoke }         from "@tauri-apps/api/core";
import { usePdfStore }    from "../store/usePdfStore";
import {
  renderPage, splitPdf,
  type SplitMode, type SplitResponse, type PdfInfo,
} from "../lib/tauri";

interface Props { filePath: string; pdfInfo: PdfInfo; }

type Phase = "edit" | "processing" | "result" | "error";
type ModeId = "all" | "every" | "ranges";

const THUMB_DPI = 40;

export function SplitPage({ filePath, pdfInfo }: Props) {
  const { setError } = usePdfStore();

  const [phase,      setPhase]      = useState<Phase>("edit");
  const [modeId,     setModeId]     = useState<ModeId>("all");
  const [everyN,     setEveryN]     = useState(1);
  const [ranges,     setRanges]     = useState<[number,number][]>([[1, pdfInfo.page_count]]);
  const [outDir,     setOutDir]     = useState<string>("");
  const [prefix,     setPrefix]     = useState("page");
  const [thumbs,     setThumbs]     = useState<(string|undefined)[]>([]);
  const [result,     setResult]     = useState<SplitResponse | null>(null);
  const [errMsg,     setErrMsg]     = useState("");
  const [selected,   setSelected]   = useState<Set<number>>(new Set());

  // ── サムネイル取得 ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setThumbs([]);
    (async () => {
      for (let i = 0; i < pdfInfo.page_count; i++) {
        try {
          const b64 = await renderPage(filePath, i, THUMB_DPI);
          if (cancelled) return;
          setThumbs(p => { const a = [...p]; a[i] = b64; return a; });
        } catch { /* skip */ }
      }
    })();
    return () => { cancelled = true; };
  }, [filePath, pdfInfo.page_count]);

  // ── 出力先選択 ──────────────────────────────────────────────────────
  const pickDir = useCallback(async () => {
    const dir = await invoke<string | null>("pick_output_dir").catch(() => null);
    if (dir) setOutDir(dir);
  }, []);

  // ── 実行 ────────────────────────────────────────────────────────────
  const handleExecute = useCallback(async () => {
    if (!outDir) { await pickDir(); return; }
    setPhase("processing");
    try {
      let mode: SplitMode;
      if (modeId === "all") {
        mode = { type: "AllPages" };
      } else if (modeId === "every") {
        mode = { type: "EveryN", n: everyN };
      } else {
        mode = { type: "Ranges", ranges };
      }
      const res = await splitPdf(filePath, outDir, mode, prefix || undefined);
      setResult(res);
      setPhase("result");
    } catch (e) {
      setErrMsg(String(e));
      setPhase("error");
      setError(String(e));
    }
  }, [filePath, outDir, modeId, everyN, ranges, prefix, pickDir, setError]);

  // ── 範囲操作ヘルパー ────────────────────────────────────────────────
  const addRange   = () => setRanges(r => [...r, [1, pdfInfo.page_count]]);
  const delRange   = (i: number) => setRanges(r => r.filter((_, j) => j !== i));
  const setRange   = (i: number, side: 0|1, v: number) =>
    setRanges(r => r.map((rng, j) => j === i ? (side === 0 ? [v, rng[1]] : [rng[0], v]) : rng));

  // サムネイルクリックで範囲モードに追加
  const togglePage = (i: number) => {
    if (modeId !== "ranges") return;
    setSelected(prev => {
      const s = new Set(prev);
      s.has(i) ? s.delete(i) : s.add(i);
      // 選択ページから連続範囲を生成
      const sorted = [...s].sort((a,b) => a-b);
      if (sorted.length > 0) {
        setRanges([[sorted[0]+1, sorted[sorted.length-1]+1]]);
      }
      return s;
    });
  };

  // 分割後のファイル数プレビュー
  const previewCount = modeId === "all" ? pdfInfo.page_count
    : modeId === "every" ? Math.ceil(pdfInfo.page_count / Math.max(1, everyN))
    : ranges.length;

  // ── 処理中 ──────────────────────────────────────────────────────────
  if (phase === "processing") return <Spinner label="分割処理中…" />;
  if (phase === "error") return (
    <ErrorView msg={errMsg} onBack={() => { setPhase("edit"); setErrMsg(""); }} />
  );

  // ── 結果 ────────────────────────────────────────────────────────────
  if (phase === "result" && result) return (
    <div style={s.root}>
      <div style={s.header}>
        <button style={s.btnBack} onClick={() => setPhase("edit")}>← 設定に戻る</button>
        <span style={s.title}>分割完了</span>
      </div>
      <div style={s.resultBody}>
        <div style={s.resultIcon}>✓</div>
        <div style={s.resultStat}>{result.files.length} ファイルを出力</div>
        <div style={s.outDirLabel}>{outDir}</div>
        <div style={s.fileList}>
          {result.files.map((f, i) => (
            <div key={i} style={s.fileItem}>
              <span style={s.fileIcon}>📄</span>
              <span style={s.fileName}>{f.split(/[/\\]/).pop()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // ── 設定画面 ─────────────────────────────────────────────────────────
  const fname = filePath.split(/[/\\]/).pop() ?? "";

  return (
    <div style={s.root}>
      <div style={s.header}>
        <span style={s.title}>分割設定</span>
        <span style={s.fileSub} title={fname}>{fname}</span>
        <span style={s.pageSub}>{pdfInfo.page_count} ページ</span>
        <div style={{ flex: 1 }} />
        <span style={s.previewCount}>→ {previewCount} ファイル</span>
      </div>

      <div style={s.body}>
        {/* 左: モード設定 */}
        <div style={s.settingsCol}>

          {/* モード選択 */}
          <section style={s.section}>
            <div style={s.secTitle}>分割モード</div>
            <div style={s.modeCards}>
              {([
                { id: "all",    icon: "⧉", label: "1ページずつ", desc: "各ページを個別ファイルに" },
                { id: "every",  icon: "⊞", label: "N枚ごと",     desc: `${everyN}枚をひとまとめに` },
                { id: "ranges", icon: "⊟", label: "範囲指定",     desc: "ページ範囲を指定" },
              ] as const).map(m => (
                <button key={m.id}
                  style={{ ...s.modeCard, ...(modeId === m.id ? s.modeOn : {}) }}
                  onClick={() => setModeId(m.id)}
                >
                  <span style={s.modeIcon}>{m.icon}</span>
                  <span style={s.modeLabel}>{m.label}</span>
                  <span style={s.modeDesc}>{m.desc}</span>
                </button>
              ))}
            </div>
          </section>

          {/* N枚ごと設定 */}
          {modeId === "every" && (
            <section style={s.section}>
              <div style={s.secTitle}>N枚</div>
              <div style={s.row}>
                <input type="number" style={s.numInput}
                  value={everyN} min={1} max={pdfInfo.page_count}
                  onChange={e => setEveryN(Math.max(1, parseInt(e.target.value)||1))}
                />
                <span style={s.inputLabel}>ページごとに1ファイル</span>
              </div>
            </section>
          )}

          {/* 範囲指定 */}
          {modeId === "ranges" && (
            <section style={s.section}>
              <div style={s.secTitle}>ページ範囲</div>
              {ranges.map((rng, i) => (
                <div key={i} style={s.rangeRow}>
                  <span style={s.rangeN}>{i+1}</span>
                  <input type="number" style={s.rangeInput}
                    value={rng[0]} min={1} max={pdfInfo.page_count}
                    onChange={e => setRange(i, 0, parseInt(e.target.value)||1)}
                  />
                  <span style={s.rangeDash}>—</span>
                  <input type="number" style={s.rangeInput}
                    value={rng[1]} min={1} max={pdfInfo.page_count}
                    onChange={e => setRange(i, 1, parseInt(e.target.value)||1)}
                  />
                  <span style={s.rangePages}>p</span>
                  {ranges.length > 1 && (
                    <button style={s.rangeDelBtn} onClick={() => delRange(i)}>✕</button>
                  )}
                </div>
              ))}
              <button style={s.addRangeBtn} onClick={addRange}>+ 範囲を追加</button>
            </section>
          )}

          {/* プレフィックス */}
          <section style={s.section}>
            <div style={s.secTitle}>ファイル名プレフィックス</div>
            <div style={s.row}>
              <input type="text" style={s.textInput}
                value={prefix} placeholder="page"
                onChange={e => setPrefix(e.target.value)}
              />
              <span style={s.inputLabel}>_0001.pdf</span>
            </div>
          </section>

          {/* 出力先 */}
          <section style={s.section}>
            <div style={s.secTitle}>出力フォルダ</div>
            <div style={s.dirRow}>
              <div style={s.dirPath} title={outDir}>{outDir || "未選択"}</div>
              <button style={s.dirBtn} onClick={pickDir}>参照…</button>
            </div>
          </section>

          {/* 実行 */}
          <button
            style={{ ...s.execBtn, ...(!outDir ? s.execWarn : {}) }}
            onClick={handleExecute}
          >
            {outDir ? `✂ 分割実行 → ${previewCount} ファイル` : "📁 出力先を選択して実行"}
          </button>
        </div>

        {/* 右: サムネイル */}
        <div style={s.thumbCol}>
          <div style={s.thumbHead}>ページ一覧</div>
          <div style={s.thumbGrid}>
            {Array.from({ length: pdfInfo.page_count }, (_, i) => (
              <button key={i}
                style={{
                  ...s.thumbCard,
                  ...(modeId === "ranges" && selected.has(i) ? s.thumbSel : {}),
                }}
                onClick={() => togglePage(i)}
                title={`ページ ${i+1}`}
              >
                {thumbs[i]
                  ? <img src={`data:image/jpeg;base64,${thumbs[i]}`} style={s.thumbImg} alt="" />
                  : <div style={s.thumbPh} />}
                <span style={s.thumbN}>{i+1}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 共通サブコンポーネント ────────────────────────────────────────────────────

export function Spinner({ label }: { label: string }) {
  return (
    <div style={s.center}>
      <div style={s.spinner} />
      <span style={s.centSub}>{label}</span>
    </div>
  );
}

export function ErrorView({ msg, onBack }: { msg: string; onBack: () => void }) {
  return (
    <div style={s.center}>
      <span style={s.errIcon}>✕</span>
      <span style={s.errTitle}>エラーが発生しました</span>
      <pre style={s.errMsg}>{msg}</pre>
      <button style={s.errBtn} onClick={onBack}>← 戻る</button>
    </div>
  );
}

// ── スタイル ──────────────────────────────────────────────────────────────────

const F = "'JetBrains Mono','Noto Sans JP',monospace";

const s: Record<string, React.CSSProperties> = {
  root:    { display:"flex", flexDirection:"column", height:"100%", background:"#0a0c10", color:"#e8eaf0", fontFamily:F, overflow:"hidden" },
  center:  { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:16, background:"#0a0c10" },
  spinner: { width:30, height:30, border:"3px solid #1a2030", borderTop:"3px solid #4f9eff", borderRadius:"50%", animation:"spin 0.8s linear infinite" },
  centSub: { color:"#5a6070", fontSize:12 },

  header:       { display:"flex", alignItems:"center", gap:10, padding:"12px 20px", borderBottom:"1px solid #1a1d24", flexShrink:0 },
  title:        { fontSize:15, fontWeight:700, color:"#c8cad8" },
  fileSub:      { fontSize:11, color:"#4a5060", maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  pageSub:      { fontSize:10, color:"#3a4050" },
  previewCount: { fontSize:12, color:"#4f9eff", fontWeight:600 },
  btnBack:      { padding:"5px 14px", background:"transparent", border:"1px solid #2a2e38", borderRadius:6, color:"#5a6070", cursor:"pointer", fontSize:11, fontFamily:F },

  body:        { flex:1, display:"flex", overflow:"hidden" },
  settingsCol: { width:320, flexShrink:0, padding:"16px 18px", display:"flex", flexDirection:"column", gap:18, overflowY:"auto", borderRight:"1px solid #1a1d24" },
  thumbCol:    { flex:1, display:"flex", flexDirection:"column", overflow:"hidden" },
  thumbHead:   { padding:"10px 16px 6px", fontSize:10, color:"#5a6070", letterSpacing:"0.1em", textTransform:"uppercase", borderBottom:"1px solid #1a1d24" },
  thumbGrid:   { flex:1, overflowY:"auto", padding:12, display:"flex", flexWrap:"wrap", gap:6, alignContent:"flex-start" },
  thumbCard:   { display:"flex", flexDirection:"column", alignItems:"center", gap:3, padding:"5px 4px", borderRadius:5, border:"1px solid #1a1d24", background:"#0d1017", cursor:"pointer", transition:"all 0.1s" },
  thumbSel:    { borderColor:"#4f9eff", background:"#0d1a2d" },
  thumbImg:    { width:58, height:"auto", display:"block", borderRadius:2 },
  thumbPh:     { width:58, height:80, background:"#111520", borderRadius:2 },
  thumbN:      { fontSize:9, color:"#3a4050" },

  section:   { display:"flex", flexDirection:"column", gap:8 },
  secTitle:  { fontSize:10, color:"#5a6070", letterSpacing:"0.1em", textTransform:"uppercase" },

  modeCards: { display:"flex", flexDirection:"column", gap:6 },
  modeCard:  { display:"flex", alignItems:"center", gap:10, padding:"10px 12px", background:"#0d1017", border:"1px solid #1a1d24", borderRadius:8, cursor:"pointer", transition:"all 0.12s", fontFamily:F, color:"#e8eaf0", textAlign:"left" },
  modeOn:    { borderColor:"#4f9eff", background:"#0d1a2d" },
  modeIcon:  { fontSize:18, flexShrink:0 },
  modeLabel: { fontSize:13, fontWeight:600, color:"#c8cad8", flexShrink:0 },
  modeDesc:  { fontSize:10, color:"#4a5060" },

  row:        { display:"flex", alignItems:"center", gap:8 },
  numInput:   { width:72, padding:"6px 8px", background:"#0d1017", border:"1px solid #2a2e38", borderRadius:6, color:"#e8eaf0", fontSize:14, fontFamily:F, textAlign:"center", outline:"none" },
  textInput:  { flex:1, padding:"6px 8px", background:"#0d1017", border:"1px solid #2a2e38", borderRadius:6, color:"#e8eaf0", fontSize:13, fontFamily:F, outline:"none" },
  inputLabel: { fontSize:11, color:"#4a5060" },

  rangeRow:    { display:"flex", alignItems:"center", gap:6, marginBottom:4 },
  rangeN:      { fontSize:10, color:"#3a4050", width:14 },
  rangeInput:  { width:60, padding:"5px 6px", background:"#0d1017", border:"1px solid #2a2e38", borderRadius:6, color:"#e8eaf0", fontSize:13, fontFamily:F, textAlign:"center", outline:"none" },
  rangeDash:   { color:"#3a4050" },
  rangePages:  { fontSize:10, color:"#3a4050" },
  rangeDelBtn: { marginLeft:"auto", background:"transparent", border:"none", color:"#4a3030", cursor:"pointer", fontSize:12, padding:"2px 4px" },
  addRangeBtn: { padding:"5px 12px", background:"transparent", border:"1px dashed #2a2e38", borderRadius:6, color:"#4a5060", cursor:"pointer", fontSize:11, fontFamily:F },

  dirRow:  { display:"flex", gap:8, alignItems:"center" },
  dirPath: { flex:1, padding:"6px 8px", background:"#0d1017", border:"1px solid #1a1d24", borderRadius:6, color:"#4a5060", fontSize:11, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  dirBtn:  { padding:"6px 14px", background:"#0d1017", border:"1px solid #2a2e38", borderRadius:6, color:"#c8cad8", cursor:"pointer", fontSize:12, fontFamily:F, flexShrink:0 },

  execBtn:  { padding:"12px 0", background:"#1a4a8a", border:"1px solid #4f9eff", borderRadius:8, color:"#4f9eff", fontWeight:700, fontSize:14, cursor:"pointer", fontFamily:F, textAlign:"center" },
  execWarn: { background:"#2a1a0a", borderColor:"#6a4a1a", color:"#cc9944" },

  // 結果
  resultBody:  { flex:1, display:"flex", flexDirection:"column", alignItems:"center", padding:32, gap:14, overflowY:"auto" },
  resultIcon:  { fontSize:52, color:"#4fe090" },
  resultStat:  { fontSize:20, fontWeight:700, color:"#c8cad8" },
  outDirLabel: { fontSize:11, color:"#4a5060" },
  fileList:    { width:"100%", maxWidth:480, display:"flex", flexDirection:"column", gap:4, marginTop:8 },
  fileItem:    { display:"flex", alignItems:"center", gap:8, padding:"6px 10px", background:"#0d1017", borderRadius:6, border:"1px solid #1a1d24" },
  fileIcon:    { fontSize:14 },
  fileName:    { fontSize:12, color:"#c8cad8" },

  errIcon:  { fontSize:36, color:"#ff4444" },
  errTitle: { fontSize:14, fontWeight:600, color:"#ff6060" },
  errMsg:   { fontSize:11, color:"#cc4444", background:"#1a0808", border:"1px solid #3a1212", borderRadius:6, padding:"10px 14px", maxWidth:480, whiteSpace:"pre-wrap", wordBreak:"break-all" },
  errBtn:   { padding:"8px 20px", background:"transparent", border:"1px solid #3a2020", borderRadius:7, color:"#cc4444", cursor:"pointer", fontSize:13, fontFamily:F },
};
