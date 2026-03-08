// src/pages/TrimPage.tsx
// フロー: [設定・Canvas操作] → [処理中] → [結果確認] → [保存 or 続けて圧縮]

import { useEffect, useState, useCallback } from "react";
import { invoke }          from "@tauri-apps/api/core";
import { TrimCanvas }      from "../components/trim/TrimCanvas";
import { TrimControls }    from "../components/trim/TrimControls";
import { CompressPage }    from "./CompressPage";
import { usePdfStore }     from "../store/usePdfStore";
import { useSaveDialog }   from "../hooks/useSaveDialog";
import {
  renderPage, trimPdf,
  type TrimMargins, type PdfInfo,
} from "../lib/tauri";

interface Props { filePath: string; pdfInfo: PdfInfo; }

const PREVIEW_DPI = 72;
const RESULT_DPI  = 96;
const THUMB_DPI   = 36;
const CANVAS_W    = 520;

type Phase = "edit" | "processing" | "result" | "error" | "compress";

const zero = (): TrimMargins => ({ left: 0, right: 0, top: 0, bottom: 0 });

export function TrimPage({ filePath, pdfInfo }: Props) {
  const {
    trimMargins, trimPages,
    setTrimMargins, setTrimPages,
    previewPage, setPreviewPage,
    setError,
  } = usePdfStore();
  const { pickSave } = useSaveDialog();

  const [phase,        setPhase]        = useState<Phase>("edit");
  const [pageImage,    setPageImage]    = useState<string>("");
  const [thumbImages,  setThumbImages]  = useState<(string | undefined)[]>([]);
  const [resultImages, setResultImages] = useState<string[]>([]);
  const [trimmedTmp,   setTrimmedTmp]   = useState<string>("");
  const [isSaving,     setIsSaving]     = useState(false);
  const [errMsg,       setErrMsg]       = useState<string>("");

  const currentPage = pdfInfo.pages[previewPage] ?? pdfInfo.pages[0];
  const pageW = currentPage?.w ?? 595;
  const pageH = currentPage?.h ?? 842;

  // ── ファイル変更時リセット ────────────────────────────────────────────
  useEffect(() => {
    setPhase("edit");
    setResultImages([]);
    setErrMsg("");
    setTrimmedTmp("");
    setTrimMargins(zero());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  // ── プレビューページ画像 ─────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "edit") return;
    let cancelled = false;
    setPageImage("");
    renderPage(filePath, previewPage, PREVIEW_DPI)
      .then(b64 => { if (!cancelled) setPageImage(b64); })
      .catch(e  => setError(String(e)));
    return () => { cancelled = true; };
  }, [filePath, previewPage, phase, setError]);

  // ── サムネイル逐次取得 ───────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setThumbImages([]);
    (async () => {
      for (let i = 0; i < pdfInfo.page_count; i++) {
        try {
          const b64 = await renderPage(filePath, i, THUMB_DPI);
          if (cancelled) return;
          setThumbImages(prev => { const a = [...prev]; a[i] = b64; return a; });
        } catch { /* skip */ }
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, pdfInfo.page_count]);

  const handlePageSelect = useCallback((idx: number) => {
    setPreviewPage(idx);
    setTrimMargins(zero());
  }, [setPreviewPage, setTrimMargins]);

  // ── 実行 → 一時ファイル → プレビュー ────────────────────────────────
  const handleExecute = useCallback(async () => {
    setPhase("processing");
    setErrMsg("");
    try {
      const tmp = await invoke<string>("get_tmp_path", { filename: "kozou_trim_preview.pdf" });
      await trimPdf(filePath, tmp, trimMargins, trimPages);

      const previews: string[] = [];
      const maxP = Math.min(pdfInfo.page_count, 4);
      for (let i = 0; i < maxP; i++) {
        try { previews.push(await renderPage(tmp, i, RESULT_DPI)); }
        catch { previews.push(""); }
      }
      setResultImages(previews);
      setTrimmedTmp(tmp);
      setPhase("result");
    } catch (e) {
      const msg = String(e);
      setErrMsg(msg);
      setPhase("error");
      setError(msg);
    }
  }, [filePath, trimMargins, trimPages, pdfInfo.page_count, setError]);

  // ── 保存 ────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const base = filePath.split(/[/\\]/).pop()?.replace(/\.pdf$/i, "") ?? "file";
    const savePath = await pickSave(`${base}_trimmed.pdf`);
    if (!savePath) return;
    setIsSaving(true);
    try {
      await trimPdf(filePath, savePath, trimMargins, trimPages);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsSaving(false);
    }
  }, [filePath, trimMargins, trimPages, pickSave, setError]);

  const handleBack = useCallback(() => {
    setPhase("edit");
    setResultImages([]);
    setErrMsg("");
  }, []);

  // ── 処理中 ──────────────────────────────────────────────────────────
  if (phase === "processing") {
    return (
      <div style={s.center}>
        <div style={s.spinner} />
        <span style={s.centSub}>トリミング + プレビュー生成中…</span>
      </div>
    );
  }

  // ── エラー ──────────────────────────────────────────────────────────
  if (phase === "error") {
    return (
      <div style={s.center}>
        <span style={s.errIcon}>✕</span>
        <span style={s.errTitle}>エラーが発生しました</span>
        <pre style={s.errMsg}>{errMsg}</pre>
        <button style={s.errBtn} onClick={() => { setPhase("edit"); setErrMsg(""); }}>
          ← 設定に戻る
        </button>
      </div>
    );
  }

  // ── 続けて圧縮 ──────────────────────────────────────────────────────
  if (phase === "compress") {
    return (
      <CompressPage
        filePath={filePath}
        pdfInfo={pdfInfo}
        sourceFile={trimmedTmp || undefined}
        onDone={() => setPhase("result")}
      />
    );
  }

  // ── 結果確認 ────────────────────────────────────────────────────────
  if (phase === "result") {
    return (
      <ResultView
        images={resultImages}
        pageCount={pdfInfo.page_count}
        onSave={handleSave}
        onBack={handleBack}
        onCompress={() => setPhase("compress")}
        isSaving={isSaving}
      />
    );
  }

  // ── 編集フェーズ ─────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      {/* サムネイルサイドバー */}
      <aside style={s.sidebar}>
        <div style={s.sbHead}>
          <span style={s.sbTitle}>ページ</span>
          <span style={s.sbCount}>{pdfInfo.page_count}枚</span>
        </div>
        <div style={s.thumbList}>
          {Array.from({ length: pdfInfo.page_count }, (_, i) => (
            <button key={i}
              style={{ ...s.thumb, ...(previewPage === i ? s.thumbOn : {}) }}
              onClick={() => handlePageSelect(i)}
            >
              {thumbImages[i]
                ? <img src={`data:image/jpeg;base64,${thumbImages[i]}`} style={s.thumbImg} alt="" />
                : <div style={s.thumbPh} />}
              <span style={s.thumbN}>{i + 1}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* キャンバスエリア */}
      <main style={s.main}>
        <div style={s.mainHead}>
          <span style={s.mainTitle}>トリミング設定</span>
          <span style={s.pageInd}>{previewPage + 1} / {pdfInfo.page_count} ページ</span>
          <span style={s.dpiNote}>{PREVIEW_DPI} dpi</span>
        </div>
        <div style={s.canvasWrap}>
          {pageImage
            ? <TrimCanvas
                pageImageB64={pageImage}
                pageWidthPt={pageW} pageHeightPt={pageH}
                margins={trimMargins}
                onChange={setTrimMargins}
                displayWidth={CANVAS_W}
              />
            : <div style={{ ...s.ph, width: CANVAS_W, height: Math.round(CANVAS_W * pageH / pageW) }}>
                <div style={s.spinner} />
                <span style={s.centSub}>読み込み中…</span>
              </div>}
        </div>
      </main>

      {/* 右パネル */}
      <aside style={s.panel}>
        <TrimControls
          margins={trimMargins} pageW={pageW} pageH={pageH}
          pages={trimPages}
          onMargins={setTrimMargins}
          onPages={setTrimPages}
          onApply={handleExecute}
          onReset={() => setTrimMargins(zero())}
          processing={false}
        />
      </aside>
    </div>
  );
}

// ── 結果ビュー ───────────────────────────────────────────────────────────────

function ResultView({ images, pageCount, onSave, onBack, onCompress, isSaving }: {
  images:     string[];
  pageCount:  number;
  onSave:     () => void;
  onBack:     () => void;
  onCompress: () => void;
  isSaving:   boolean;
}) {
  return (
    <div style={r.root}>
      <div style={r.header}>
        <button style={r.btnBack} onClick={onBack}>← 設定に戻る</button>
        <span style={r.title}>トリミング結果確認</span>
        <span style={r.sub}>{pageCount} ページ（先頭 {images.length} ページ表示）</span>
        <div style={{ flex: 1 }} />
        <button style={r.btnCompress} onClick={onCompress}>⚡ 続けて圧縮</button>
        <button style={{ ...r.btnSave, ...(isSaving ? r.dis : {}) }}
          onClick={onSave} disabled={isSaving}>
          {isSaving ? "保存中…" : "💾 PDFを保存"}
        </button>
      </div>

      <div style={r.gallery}>
        {images.map((b64, i) => (
          <div key={i} style={r.card}>
            <span style={r.pageN}>{i + 1} ページ</span>
            {b64
              ? <img src={`data:image/jpeg;base64,${b64}`} style={r.img} alt="" />
              : <div style={r.imgPh}>プレビュー失敗</div>}
          </div>
        ))}
        {pageCount > images.length && (
          <div style={r.more}>… 他 {pageCount - images.length} ページ</div>
        )}
      </div>

      <div style={r.footer}>
        <button style={r.btnBack} onClick={onBack}>← 設定に戻る</button>
        <button style={r.btnCompress} onClick={onCompress}>⚡ 続けて圧縮</button>
        <button style={{ ...r.btnSave, ...(isSaving ? r.dis : {}) }}
          onClick={onSave} disabled={isSaving}>
          {isSaving ? "保存中…" : "💾 PDFを保存"}
        </button>
      </div>
    </div>
  );
}

// ── スタイル ─────────────────────────────────────────────────────────────────

const F = "'JetBrains Mono','Noto Sans JP',monospace";

const s: Record<string, React.CSSProperties> = {
  root:    { display:"flex", height:"100%", background:"#0a0c10", color:"#e8eaf0", fontFamily:F, overflow:"hidden" },
  center:  { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:18, background:"#0a0c10" },
  spinner: { width:30, height:30, border:"3px solid #1a2030", borderTop:"3px solid #4f9eff", borderRadius:"50%", animation:"spin 0.8s linear infinite" },
  centSub: { color:"#5a6070", fontSize:12 },

  sidebar:  { width:106, flexShrink:0, display:"flex", flexDirection:"column", background:"#0d1017", borderRight:"1px solid #1a1d24", overflow:"hidden" },
  sbHead:   { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"9px 8px 6px", borderBottom:"1px solid #1a1d24" },
  sbTitle:  { fontSize:9, color:"#5a6070", letterSpacing:"0.1em", textTransform:"uppercase" },
  sbCount:  { fontSize:9, color:"#3a4050" },
  thumbList:{ flex:1, overflowY:"auto", padding:"5px 4px", display:"flex", flexDirection:"column", gap:4 },
  thumb:    { display:"flex", flexDirection:"column", alignItems:"center", gap:3, padding:"4px 3px", borderRadius:5, border:"1px solid transparent", background:"transparent", cursor:"pointer", transition:"all 0.12s" },
  thumbOn:  { borderColor:"#4f9eff", background:"#0d1a2d" },
  thumbImg: { width:70, height:"auto", borderRadius:2, display:"block" },
  thumbPh:  { width:70, height:96, background:"#111520", borderRadius:2 },
  thumbN:   { fontSize:9, color:"#3a4050" },

  main:      { flex:1, display:"flex", flexDirection:"column", overflow:"hidden", padding:"14px 18px", gap:10 },
  mainHead:  { display:"flex", alignItems:"center", gap:10 },
  mainTitle: { fontSize:13, fontWeight:600, color:"#c8cad8" },
  pageInd:   { fontSize:10, color:"#4a5060" },
  dpiNote:   { fontSize:9, color:"#2a3040", marginLeft:"auto" },
  canvasWrap:{ flex:1, overflow:"auto", display:"flex", alignItems:"flex-start", justifyContent:"center" },
  ph:        { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"#0d1017", borderRadius:8, gap:12 },
  panel:     { width:268, flexShrink:0, borderLeft:"1px solid #1a1d24", overflow:"hidden" },

  errIcon:  { fontSize:36, color:"#ff4444" },
  errTitle: { fontSize:14, fontWeight:600, color:"#ff6060" },
  errMsg:   { fontSize:11, color:"#cc4444", background:"#1a0808", border:"1px solid #3a1212", borderRadius:6, padding:"12px 16px", maxWidth:480, whiteSpace:"pre-wrap", wordBreak:"break-all" },
  errBtn:   { padding:"8px 20px", background:"transparent", border:"1px solid #3a2020", borderRadius:7, color:"#cc4444", cursor:"pointer", fontSize:13, fontFamily:F },
};

const r: Record<string, React.CSSProperties> = {
  root:       { display:"flex", flexDirection:"column", height:"100%", background:"#0a0c10", color:"#e8eaf0", fontFamily:F },
  header:     { display:"flex", alignItems:"center", gap:10, padding:"10px 18px", borderBottom:"1px solid #1a1d24", flexShrink:0 },
  btnBack:    { padding:"5px 12px", background:"transparent", border:"1px solid #2a2e38", borderRadius:6, color:"#5a6070", cursor:"pointer", fontSize:11, fontFamily:F },
  btnCompress:{ padding:"7px 16px", background:"#1a2a4a", border:"1px solid #3a6aaa", borderRadius:7, color:"#6aafff", fontWeight:600, cursor:"pointer", fontSize:12, fontFamily:F },
  btnSave:    { padding:"8px 20px", background:"#1a4a8a", border:"1px solid #4f9eff", borderRadius:7, color:"#4f9eff", fontWeight:700, cursor:"pointer", fontSize:13, fontFamily:F },
  dis:        { opacity:0.4, cursor:"not-allowed" },
  title:      { fontSize:14, fontWeight:600, color:"#c8cad8" },
  sub:        { fontSize:10, color:"#4a5060" },
  gallery:    { flex:1, overflowY:"auto", display:"flex", flexWrap:"wrap", gap:20, padding:24, alignContent:"flex-start", justifyContent:"center" },
  card:       { display:"flex", flexDirection:"column", alignItems:"center", gap:8, background:"#0d1017", border:"1px solid #1a1d24", borderRadius:8, padding:12 },
  pageN:      { fontSize:10, color:"#5a6070" },
  img:        { maxWidth:280, maxHeight:380, display:"block", borderRadius:4 },
  imgPh:      { width:200, height:260, background:"#111520", borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center", color:"#3a4050", fontSize:11 },
  more:       { display:"flex", alignItems:"center", justifyContent:"center", color:"#3a4050", fontSize:12, padding:"30px 20px" },
  footer:     { display:"flex", justifyContent:"flex-end", gap:10, padding:"10px 18px", borderTop:"1px solid #1a1d24", flexShrink:0 },
};
