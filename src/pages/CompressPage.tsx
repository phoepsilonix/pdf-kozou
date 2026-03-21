// src/pages/CompressPage.tsx
import { useState, useCallback, useEffect } from "react";
import { invoke }        from "@tauri-apps/api/core";
import { useSaveDialog } from "../hooks/useSaveDialog";
import { 
  compressPdf, getTmpPath, renderPage, 
  type CompressPreset, type PdfInfo 
} from "../lib/tauri";
import { F } from "../lib/theme";

export type GsLevel = "prepress" | "printer" | "ebook";

interface Props {
  filePath:    string;
  pdfInfo:     PdfInfo;
  sourceFile?: string;
  onDone?:     () => void;
  batchFiles?: import("../store/usePdfStore").FileEntry[];
}

type Phase = "edit" | "processing" | "result" | "batchResult" | "error";

// --- 元のプリセット定義 (完全復旧) ---
const PRESETS: {
  id: CompressPreset; icon: string; label: string; desc: string; note: string; color: string;
}[] = [
  { id: "light",      icon: "☁", label: "軽め",   desc: "GC=1、画像圧縮なし", note: "フォント完全保護。効果小さめ", color: "#3a7a4a" },
  { id: "standard",   icon: "⚖", label: "標準",   desc: "GC=2、画像圧縮あり", note: "バランス重視。ほとんどのPDFに安全", color: "#2a5a9a" },
  { id: "aggressive", icon: "⚡", label: "強め",   desc: "GC=2、sanitize,merge-fonts,object-stream", note: "⚠ 埋め込みフォントに影響する場合あり", color: "#7a5a1a" },
  { id: "maximum",    icon: "🔥", label: "最大",   desc: "GC=3、sanitize,clean,merge-fonts,object-stream", note: "⚠ 最大圧縮。フォントへの影響リスク高", color: "#7a2020" },
];

const GS_PRESETS: { id: GsLevel; icon: string; label: string; desc: string; note: string; color: string; }[] = [
  { id: "prepress", icon: "🎨", label: "プロ:高品質", desc: "300dpi / 低圧縮", note: "印刷品質を維持して再構築", color: "#4a3a7a" },
  { id: "printer",  icon: "📄", label: "プロ:標準",   desc: "300dpi / 中圧縮", note: "Type3フォント問題を解消。推奨", color: "#2e5c8a" },
  { id: "ebook",    icon: "📱", label: "プロ:軽量",   desc: "150dpi / 高圧縮", note: "モバイル閲覧に最適化", color: "#8a5c2e" },
];

export function CompressPage({ filePath, pdfInfo, sourceFile, onDone, batchFiles }: Props) {
  const { pickSave, pickDir } = useSaveDialog();
  const [phase, setPhase] = useState<Phase>("edit");
  const [preset, setPreset] = useState<CompressPreset>("standard");
  const [gsLevel, setGsLevel] = useState<GsLevel>("printer");
  const [useGs, setUseGs] = useState(false);
  const [gsAvailable, setGsAvailable] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState("");
  const [tmpFile, setTmpFile] = useState("");
  const [result, setResult] = useState<{input_bytes:number; output_bytes:number; ratio:number} | null>(null);

  // --- バッチ処理用の状態管理 ---
  const [batchProgress, setBatchProgress] = useState(0);
  const [batchLog, setBatchLog] = useState<{name:string, status:"ok"|"error", msg?:string}[]>([]);

  const isBatch = !!batchFiles && batchFiles.length > 0;
  const inputFile = sourceFile || filePath;

  useEffect(() => {
    invoke<boolean>("check_ghostscript_installed").then(setGsAvailable);
  }, []);

  // --- プレビュー (単体時のみ利用) ---
  const handlePreview = useCallback(async () => {
    setPhase("processing");
    try {
      const tmp = await getTmpPath("kozou_preview.pdf");
      if (useGs) {
        await invoke("run_gs_preview", { input: inputFile, output: tmp, levelStr: gsLevel });
        const stat = await invoke<{size:number}>("get_file_stat", { path: tmp });
        setResult({ input_bytes: pdfInfo.size_bytes || 0, output_bytes: stat.size, ratio: stat.size / (pdfInfo.size_bytes || 1) });
      } else {
        await compressPdf(inputFile, tmp, { preset });
        setResult(null); // compressPdfの結果を正しくセットする場合は戻り値を使用
      }
      setTmpFile(tmp);
      try { setPreview(await renderPage(tmp, 0, 120)); } catch { setPreview(""); }
      setPhase("result");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }, [useGs, gsLevel, inputFile, preset, pdfInfo]);

  // --- 保存 (単体時のみ利用) ---
  const handleSave = useCallback(async () => {
    const fname = filePath.split(/[/\\]/).pop() || "document.pdf";
    const savePath = await pickSave(`${fname.replace(/\.pdf$/i, "")}_optimized.pdf`);
    if (!savePath) return;

    setSaving(true);
    try {
      if (useGs) {
        await invoke("run_gs_optimize", { input: inputFile, output: savePath, levelStr: gsLevel });
      } else {
        await compressPdf(inputFile, savePath, { preset });
      }
      if (onDone) onDone();
    } catch (e) { alert(String(e)); } finally { setSaving(false); }
  }, [useGs, gsLevel, inputFile, filePath, preset, pickSave, onDone]);

  // --- ★バッチ処理実行 (GSモード対応版) ---
  const handleBatchRun = useCallback(async () => {
    if (!batchFiles) return;
    const outDir = await pickDir();
    if (!outDir) return;

    setPhase("batchResult");
    setBatchProgress(0);
    setBatchLog([]);

    for (let i = 0; i < batchFiles.length; i++) {
      const f = batchFiles[i];
      const outPath = `${outDir}/${f.name.replace(/\.pdf$/i, "")}_opt.pdf`;
      try {
        if (useGs) {
          // GSモードが選択されている場合はGSで一括処理
          await invoke("run_gs_optimize", { input: f.path, output: outPath, levelStr: gsLevel });
        } else {
          // 標準モードの場合はMuPDFで一括処理
          await compressPdf(f.path, outPath, { preset });
        }
        setBatchLog(prev => [...prev, { name: f.name, status: "ok" }]);
      } catch (e) {
        setBatchLog(prev => [...prev, { name: f.name, status: "error", msg: String(e) }]);
      }
      setBatchProgress(Math.round(((i + 1) / batchFiles.length) * 100));
    }
  }, [batchFiles, useGs, gsLevel, preset, pickDir]);

  // レンダリングロジック
  if (phase === "processing") return <div style={sh.center}><div style={sh.spinner}/><div style={{marginTop:12}}>処理中...</div></div>;
  if (phase === "error") return <div style={sh.center}><div style={{color:"#e55"}}>Error</div><div>{error}</div><button style={sh.btn} onClick={() => setPhase("edit")}>戻る</button></div>;

  // --- バッチ結果表示画面 ---
  if (phase === "batchResult") {
    return (
      <div style={sh.root}>
        <div style={sh.header}><div style={sh.title}>一括処理進捗 ({batchProgress}%)</div></div>
        <div style={sh.scroll}>
          <div style={sh.batchLog}>
            {batchLog.map((l, i) => (
              <div key={i} style={sh.logRow}>
                <span>{l.status === "ok" ? "✅" : "❌"}</span>
                <span style={{flex:1, overflow: "hidden", textOverflow: "ellipsis"}}>{l.name}</span>
                {l.msg && <span style={{fontSize:11, color:"#e55"}}>{l.msg}</span>}
              </div>
            ))}
          </div>
        </div>
        <div style={sh.footer}>{batchProgress === 100 && <button style={sh.primaryBtn} onClick={onDone}>完了</button>}</div>
      </div>
    );
  }

  // --- 単体結果表示画面 ---
  if (phase === "result") {
    return (
      <div style={sh.root}>
        <div style={sh.resHeader}>
           <div style={sh.resTitle}>プレビュー {useGs && "(プロモード)"}</div>
        </div>
        <div style={sh.previewArea}>{preview ? <img src={preview} style={sh.img} /> : "No Preview"}</div>
        <div style={sh.footer}>
          <button style={sh.btn} onClick={() => setPhase("edit")}>設定に戻る</button>
          <button style={sh.saveBtn} onClick={handleSave} disabled={saving}>{saving ? "保存中..." : "保存する"}</button>
        </div>
      </div>
    );
  }

  // --- 初期設定画面 ---
  return (
    <div style={sh.root}>
      <div style={sh.header}>
        <div style={sh.title}>最適化設定 {isBatch && `(一括: ${batchFiles.length}件)`}</div>
        {gsAvailable && (
          <div style={sh.tabContainer}>
            <button style={{...sh.tab, ...(useGs ? {} : sh.tabActive)}} onClick={() => setUseGs(false)}>標準 (MuPDF)</button>
            <button style={{...sh.tab, ...(useGs ? sh.tabActive : {})}} onClick={() => setUseGs(true)}>プロ (Ghostscript)</button>
          </div>
        )}
      </div>

      <div style={sh.scroll}>
        {!useGs ? (
          <div style={sh.section}>
            <div style={sh.grid4}>
              {PRESETS.map(p => (
                <button key={p.id} onClick={() => setPreset(p.id)} style={{...sh.card, borderColor: preset === p.id ? p.color : "transparent", background: preset === p.id ? `${p.color}15` : "var(--c-bgCard)"}}>
                  <span style={{fontSize:24, color: p.color}}>{p.icon}</span>
                  <div style={sh.cardLabel}>{p.label}</div>
                  <div style={sh.cardDesc}>{p.desc}</div>
                  <div style={{fontSize:10, color:"var(--c-textDim)", marginTop:8}}>{p.note}</div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div style={sh.section}>
            <div style={sh.grid3}>
              {GS_PRESETS.map(p => (
                <button key={p.id} onClick={() => setGsLevel(p.id)} style={{...sh.card, borderColor: gsLevel === p.id ? p.color : "transparent", background: gsLevel === p.id ? `${p.color}15` : "var(--c-bgCard)"}}>
                  <span style={{fontSize:24}}>{p.icon}</span>
                  <div style={sh.cardLabel}>{p.label}</div>
                  <div style={sh.cardDesc}>{p.desc}</div>
                  <div style={{fontSize:10, color:"var(--c-textDim)", marginTop:8}}>{p.note}</div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={sh.footer}>
        {isBatch ? (
          <button style={sh.primaryBtn} onClick={handleBatchRun}>一括処理を開始</button>
        ) : (
          <button style={sh.primaryBtn} onClick={handlePreview}>プレビュー確認</button>
        )}
      </div>
    </div>
  );
}

const sh: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100%", background: "var(--c-bg)" },
  header: { padding: "16px 20px", borderBottom: "1px solid var(--c-border)" },
  title: { fontSize: 16, fontWeight: 700, marginBottom: 12 },
  tabContainer: { display: "flex", gap: 6 },
  tab: { padding: "4px 12px", fontSize: 12, borderRadius: 5, border: "1px solid var(--c-border)", cursor: "pointer", background: "transparent", color: "var(--c-textSub)", fontFamily: F },
  tabActive: { background: "var(--c-accent)", color: "#fff", borderColor: "var(--c-accent)" },
  scroll: { flex: 1, overflowY: "auto", padding: 24 },
  section: { maxWidth: 900, margin: "0 auto" },
  grid4: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 },
  grid3: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 },
  card: { padding: "16px 12px", borderRadius: 10, border: "2px solid transparent", textAlign: "left", cursor: "pointer", transition: "0.2s", fontFamily: F },
  cardLabel: { fontWeight: 700, fontSize: 15, marginTop: 6 },
  cardDesc: { fontSize: 11, color: "var(--c-textSub)", marginTop: 2 },
  footer: { padding: "12px 24px", borderTop: "1px solid var(--c-border)", display: "flex", justifyContent: "flex-end", gap: 10 },
  primaryBtn: { padding: "8px 24px", background: "var(--c-accent)", color: "#fff", border: "none", borderRadius: 6, fontWeight: 700, cursor: "pointer" },
  saveBtn: { padding: "8px 24px", background: "#3a7a4a", color: "#fff", border: "none", borderRadius: 6, fontWeight: 700, cursor: "pointer" },
  btn: { padding: "8px 20px", background: "transparent", border: "1px solid var(--c-border)", borderRadius: 6, cursor: "pointer" },
  previewArea: { flex: 1, overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center", background: "#333" },
  img: { maxHeight: "100%", boxShadow: "0 0 20px rgba(0,0,0,0.5)", background: "#fff" },
  spinner: { width: 24, height: 24, border: "3px solid #ccc", borderTopColor: "var(--c-accent)", borderRadius: "50%", animation: "spin 1s linear infinite" },
  center: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%" },
  resHeader: { padding: "12px 24px", background: "var(--c-bgCard)", borderBottom: "1px solid var(--c-border)" },
  resTitle: { fontSize: 13, fontWeight: 700 },
  batchLog: { display: "flex", flexDirection: "column", gap: 4 },
  logRow: { padding: "6px 12px", background: "var(--c-bgCard)", borderRadius: 5, display: "flex", alignItems: "center", gap: 10, fontSize: 12, border: "1px solid var(--c-border)" }
};
