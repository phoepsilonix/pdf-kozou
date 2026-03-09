// src/pages/TrimPage.tsx
import { useEffect, useState, useCallback } from "react";
import { invoke }          from "@tauri-apps/api/core";
import { TrimCanvas }      from "../components/trim/TrimCanvas";
import { TrimControls }    from "../components/trim/TrimControls";
import { CompressPage }    from "./CompressPage";
import { usePdfStore, type FileEntry } from "../store/usePdfStore";
import { useSaveDialog }   from "../hooks/useSaveDialog";
import { renderPage, trimPdf, getPdfInfo, type TrimMargins, type PdfInfo } from "../lib/tauri";
import { resolvePageSpec } from "../components/PageSelector";
import { C, F } from "../lib/theme";

interface Props {
  filePath:    string;
  pdfInfo:     PdfInfo;
  batchFiles?: FileEntry[];
}

const PREVIEW_DPI = 72;
const RESULT_DPI  = 96;
const THUMB_DPI   = 40;
const CANVAS_W    = 520;

type Phase = "edit" | "processing" | "result" | "error" | "compress" | "batchResult";
const zero = (): TrimMargins => ({ left:0, right:0, top:0, bottom:0 });

export function TrimPage({ filePath, pdfInfo, batchFiles }: Props) {
  const isBatch = (batchFiles?.length ?? 0) > 1;
  if (isBatch) return <TrimPageBatch files={batchFiles!} firstPdfInfo={pdfInfo} />;
  return <TrimPageSingle filePath={filePath} pdfInfo={pdfInfo} />;
}

// ── バッチトリム ──────────────────────────────────────────────────────────────
function TrimPageBatch({ files, firstPdfInfo }: { files:FileEntry[]; firstPdfInfo:PdfInfo }) {
  const { setError } = usePdfStore();
  const [trimMargins, setTrimMargins] = useState<TrimMargins>(zero());
  const [trimPages,   setTrimPages]   = useState<any>({ type:"All" });
  const [outDir,      setOutDir]      = useState("");
  const [phase,       setPhase]       = useState<"edit"|"processing"|"result">("edit");
  const [progress,    setProgress]    = useState<{ current:number; done:{f:string}[]; errors:{f:string;msg:string}[] }>
    ({ current:0, done:[], errors:[] });
  const [previewIdx,  setPreviewIdx]  = useState(0);
  const [batchThumbs, setBatchThumbs] = useState<(string|undefined)[]>([]);
  const [previewPage, setPreviewPage] = useState(0);
  const [pageImage,   setPageImage]   = useState("");
  const [curPageInfo, setCurPageInfo] = useState<PdfInfo|null>(null);

  useEffect(() => {
    let cancelled = false;
    setBatchThumbs(new Array(files.length).fill(undefined));
    (async () => {
      for (let i=0; i<files.length; i++) {
        try {
          const b64 = await renderPage(files[i].path, 0, 56);
          if (cancelled) return;
          setBatchThumbs(p => { const a=[...p]; a[i]=b64; return a; });
        } catch {}
      }
    })();
    return () => { cancelled = true; };
  }, [files]);

  useEffect(() => {
    const path = files[previewIdx]?.path;
    if (!path) return;
    let cancelled = false;
    setCurPageInfo(null);
    getPdfInfo(path).then(info => { if (!cancelled) setCurPageInfo(info); }).catch(()=>{});
    setPageImage("");
    renderPage(path, previewPage, PREVIEW_DPI)
      .then(b64 => { if (!cancelled) setPageImage(b64); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [files, previewIdx, previewPage]);

  const pickDir = useCallback(async () => {
    const dir = await invoke<string|null>("pick_output_dir").catch(()=>null);
    if (dir) setOutDir(dir);
  }, []);

  const handleExecute = useCallback(async () => {
    if (!outDir) { await pickDir(); return; }
    setPhase("processing");
    const prog = { current:0, done:[] as any[], errors:[] as any[] };
    setProgress({...prog});
    for (let i=0; i<files.length; i++) {
      const f = files[i];
      prog.current = i+1;
      setProgress({...prog});
      try {
        const out = `${outDir}/${f.filename.replace(/\.pdf$/i,"")}_trimmed.pdf`;
        await trimPdf(f.path, out, trimMargins, trimPages);
        prog.done.push({ f:f.filename });
      } catch (e) {
        prog.errors.push({ f:f.filename, msg:String(e) });
      }
      setProgress({...prog});
    }
    setPhase("result");
  }, [files, outDir, trimMargins, trimPages, pickDir]);

  // 処理中
  if (phase === "processing") {
    const pct = progress.current / files.length * 100;
    return (
      <div style={b.center}>
        <div style={b.title}>トリミング中… {progress.current}/{files.length}</div>
        <div style={b.barWrap}><div style={{...b.bar, width:`${pct}%`}}/></div>
        <div style={b.log}>
          {progress.done.map((d,i)=>(
            <div key={i} style={b.logRow}>
              <span style={{color:"var(--c-accent)"}}>✓</span>
              <span style={b.logFile}>{d.f}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // 完了
  if (phase === "result") {
    return (
      <div style={b.center}>
        <span style={{fontSize:56,color:progress.errors.length?"var(--c-warn)":"var(--c-accent)"}}>
          {progress.errors.length?"⚠":"✓"}
        </span>
        <div style={b.title}>バッチトリミング完了 — {progress.done.length}件</div>
        <div style={{fontSize:12,color:"var(--c-textSub)"}}>{outDir}</div>
        <div style={b.log}>
          {progress.done.map((d,i)=>(
            <div key={i} style={b.logRow}><span style={{color:"var(--c-accent)"}}>✓</span><span style={b.logFile}>{d.f}</span></div>
          ))}
          {progress.errors.map((e,i)=>(
            <div key={`e${i}`} style={{...b.logRow,background:"var(--c-errBg)",borderColor:"var(--c-errBd)"}}>
              <span style={{color:"var(--c-err)"}}>✕</span>
              <span style={b.logFile}>{e.f}</span>
              <span style={{fontSize:10,color:"var(--c-err)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.msg}</span>
            </div>
          ))}
        </div>
        <button style={b.backBtn} onClick={e=>{ setPhase("edit"); (e.currentTarget as HTMLButtonElement).blur(); }}>← 設定に戻る</button>
      </div>
    );
  }

  const curFile  = files[previewIdx];
  const curPages = curFile?.pageCount ?? 1;

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%",background:"var(--c-bg)",color:"var(--c-text)",fontFamily:F,overflow:"hidden"}}>
      <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 20px",borderBottom:`1px solid var(--c-border)`,flexShrink:0}}>
        <span style={{fontSize:16,fontWeight:700}}>トリミング — {files.length}件バッチ</span>
        <span style={{fontSize:13,color:"var(--c-textSub)"}}>同じ余白設定を全ファイルに適用</span>
      </div>

      <div style={{flex:1,display:"flex",overflow:"hidden"}}>
        {/* 左: ファイル一覧 */}
        <div style={{width:172,flexShrink:0,borderRight:`1px solid var(--c-border)`,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          <div style={{padding:"8px 12px",fontSize:11,color:"var(--c-textDim)",borderBottom:`1px solid var(--c-border)`,background:"var(--c-bgCard)"}}>
            プレビュー対象
          </div>
          <div style={{flex:1,overflowY:"auto"}}>
            {files.map((f,i) => (
              <button key={f.id}
                style={{display:"flex",alignItems:"center",gap:9,padding:"10px 12px",background:i===previewIdx?"var(--c-accentBg)":"transparent",border:"none",borderBottom:`1px solid var(--c-border)`,cursor:"pointer",fontFamily:F,width:"100%",textAlign:"left" as const, borderLeft: i===previewIdx?`3px solid var(--c-accent)`:"3px solid transparent"}}
                onClick={()=>{setPreviewIdx(i);setPreviewPage(0);}}>
                {batchThumbs[i]
                  ? <img src={`data:image/jpeg;base64,${batchThumbs[i]}`} style={{width:44,maxHeight:62,objectFit:"contain" as const,background:"var(--c-bg)",borderRadius:3,flexShrink:0}} alt=""/>
                  : <div style={{width:36,height:50,background:"var(--c-border)",borderRadius:3,flexShrink:0}}/>}
                <div style={{flex:1,display:"flex",flexDirection:"column",gap:2,minWidth:0}}>
                  <span style={{fontSize:12,color:"var(--c-text)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.filename}</span>
                  <span style={{fontSize:10,color:"var(--c-textSub)"}}>{f.pageCount}ページ</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* 中: キャンバス */}
        <div style={{flex:1,overflow:"auto",display:"flex",flexDirection:"column",alignItems:"center",padding:"20px 12px",gap:12}}>
          {pageImage ? (
            <TrimCanvas
              pageImageB64={pageImage}
              pageWidthPt={curPageInfo?.pages[previewPage]?.w ?? 595}
              pageHeightPt={curPageInfo?.pages[previewPage]?.h ?? 842}
              margins={trimMargins}
              onChange={setTrimMargins}
              displayWidth={CANVAS_W}
            />
          ) : (
            <div style={{width:CANVAS_W,height:400,background:"var(--c-bgCard)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",color:"var(--c-textDim)"}}>
              読み込み中…
            </div>
          )}
          <div style={{display:"flex",gap:6,flexWrap:"wrap" as const,justifyContent:"center"}}>
            {Array.from({length:Math.min(curPages,8)},(_,i)=>(
              <button key={i}
                style={{padding:"5px 10px",background:i===previewPage?"var(--c-accentBg)":"var(--c-bgCard)",border:`1px solid ${i===previewPage?"var(--c-accent)":"var(--c-border)"}`,borderRadius:5,color:i===previewPage?"var(--c-accent)":"var(--c-textSub)",cursor:"pointer",fontSize:13,fontFamily:F}}
                onClick={e=>{ setPreviewPage(i); (e.currentTarget as HTMLButtonElement).blur(); }}>
                p.{i+1}
              </button>
            ))}
          </div>
        </div>

        {/* 右: コントロール + フォルダ出力 */}
        <div style={{width:290,flexShrink:0,borderLeft:`1px solid var(--c-border)`,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          <div style={{flex:1,overflow:"auto"}}>
            <TrimControls
              margins={trimMargins}
              pageW={curPageInfo?.pages[previewPage]?.w ?? 595}
              pageH={curPageInfo?.pages[previewPage]?.h ?? 842}
              pages={trimPages}
              onMargins={setTrimMargins}
              onPages={setTrimPages}
              onApply={()=>{}} onReset={()=>setTrimMargins(zero())}
              processing={false}
            />
          </div>
          <div style={{padding:"14px 16px",borderTop:`1px solid var(--c-border)`,display:"flex",flexDirection:"column",gap:10,flexShrink:0}}>
            <div style={{fontSize:12,color:"var(--c-textDim)"}}>出力フォルダ</div>
            <div style={{display:"flex",gap:7}}>
              <div style={{flex:1,padding:"8px 10px",background:"var(--c-bgCard)",border:`1px solid var(--c-border)`,borderRadius:6,fontSize:12,color:"var(--c-textSub)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                {outDir||"（未選択）"}
              </div>
              <button style={{padding:"8px 13px",background:"var(--c-bgCard)",border:`1px solid var(--c-borderHi)`,borderRadius:6,color:"var(--c-text)",cursor:"pointer",fontSize:12,fontFamily:F,flexShrink:0}}
                onClick={pickDir}>参照…</button>
            </div>
            <button
              style={{padding:"13px 0",background:outDir?"var(--c-accentBg)":"var(--c-bgCard)",border:`1px solid ${outDir?"var(--c-accentBd)":"var(--c-border)"}`,borderRadius:8,color:outDir?"var(--c-accent)":"var(--c-textDim)",cursor:"pointer",fontWeight:700,fontSize:15,fontFamily:F}}
              onClick={handleExecute}>
              {outDir ? `✂ ${files.length}件まとめてトリミング` : "📁 出力先を選択して実行"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 単体トリム ────────────────────────────────────────────────────────────────
function TrimPageSingle({ filePath, pdfInfo }: { filePath:string; pdfInfo:PdfInfo }) {
  const { trimMargins, trimPages, setTrimMargins, setTrimPages, previewPage, setPreviewPage, setError } = usePdfStore();
  const { pickSave } = useSaveDialog();

  const [phase,        setPhase]        = useState<Phase>("edit");
  const [pageImage,    setPageImage]    = useState("");
  const [thumbImages,  setThumbImages]  = useState<(string|undefined)[]>([]);
  const [resultImages, setResultImages] = useState<string[]>([]);
  const [trimmedTmp,   setTrimmedTmp]   = useState("");
  const [isSaving,     setIsSaving]     = useState(false);
  const [errMsg,       setErrMsg]       = useState("");
  const [extractSpec,  setExtractSpec]  = useState("");   // ページ抽出 "" = 全ページ
  const [trimPageSpec, setTrimPageSpec] = useState("");   // トリミング適用ページ範囲

  const currentPage = pdfInfo.pages[previewPage] ?? pdfInfo.pages[0];
  const pageW = currentPage?.w ?? 595;
  const pageH = currentPage?.h ?? 842;

  useEffect(() => {
    setPhase("edit"); setResultImages([]); setErrMsg(""); setTrimmedTmp(""); setTrimMargins(zero());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  useEffect(() => {
    if (phase !== "edit") return;
    let cancelled = false;
    setPageImage("");
    renderPage(filePath, previewPage, PREVIEW_DPI).then(b64 => { if (!cancelled) setPageImage(b64); }).catch(e => setError(String(e)));
    return () => { cancelled = true; };
  }, [filePath, previewPage, phase, setError]);

  useEffect(() => {
    let cancelled = false;
    setThumbImages([]);
    (async () => {
      for (let i=0; i<pdfInfo.page_count; i++) {
        try {
          const b64 = await renderPage(filePath, i, THUMB_DPI);
          if (cancelled) return;
          setThumbImages(prev => { const a=[...prev]; a[i]=b64; return a; });
        } catch {}
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, pdfInfo.page_count]);

  const handlePageSelect = useCallback((idx: number) => {
    setPreviewPage(idx); setTrimMargins(zero());
  }, [setPreviewPage, setTrimMargins]);

  const handleExecute = useCallback(async () => {
    setPhase("processing"); setErrMsg("");
    try {
      const tmp = await invoke<string>("get_tmp_path", { filename:"kozou_trim_preview.pdf" });
      const ep = extractSpec ? resolvePageSpec(extractSpec, pdfInfo.page_count).map(i => i+1) : undefined;
      await trimPdf(filePath, tmp, trimMargins, trimPages, ep);
      const previews: string[] = [];
      for (let i=0; i<Math.min(pdfInfo.page_count,4); i++) {
        try { previews.push(await renderPage(tmp, i, RESULT_DPI)); } catch { previews.push(""); }
      }
      setResultImages(previews); setTrimmedTmp(tmp); setPhase("result");
    } catch (e) {
      const msg = String(e); setErrMsg(msg); setPhase("error"); setError(msg);
    }
  }, [filePath, trimMargins, trimPages, extractSpec, pdfInfo.page_count, setError]);

  const handleSave = useCallback(async () => {
    const base = filePath.split(/[/\\]/).pop()?.replace(/\.pdf$/i,"") ?? "file";
    const savePath = await pickSave(`${base}_trimmed.pdf`);
    if (!savePath) return;
    setIsSaving(true);
    try {
      const ep2 = extractSpec ? resolvePageSpec(extractSpec, pdfInfo.page_count).map(i => i+1) : undefined;
      await trimPdf(filePath, savePath, trimMargins, trimPages, ep2);
    }
    catch (e) { setError(String(e)); }
    finally { setIsSaving(false); }
  }, [filePath, trimMargins, trimPages, extractSpec, pickSave, setError]);

  if (phase === "processing") return (
    <div style={s.center}>
      <div style={s.spinner}/>
      <span style={s.centSub}>トリミング + プレビュー生成中…</span>
    </div>
  );

  if (phase === "error") return (
    <div style={s.center}>
      <span style={{fontSize:40,color:"var(--c-err)"}}>✕</span>
      <span style={{fontSize:16,fontWeight:700,color:"var(--c-err)"}}>エラー</span>
      <pre style={s.errMsg}>{errMsg}</pre>
      <button style={s.errBtn} onClick={()=>{setPhase("edit");setErrMsg("");}}>← 設定に戻る</button>
    </div>
  );

  if (phase === "compress") return (
    <CompressPage filePath={filePath} pdfInfo={pdfInfo} sourceFile={trimmedTmp||undefined} onDone={()=>setPhase("result")}/>
  );

  if (phase === "result") return (
    <ResultView images={resultImages} pageCount={pdfInfo.page_count}
      onSave={handleSave} onBack={()=>{setPhase("edit");setResultImages([]);setErrMsg("");}}
      onCompress={()=>setPhase("compress")} isSaving={isSaving}/>
  );

  return (
    <div style={s.root}>
      <aside style={s.sidebar}>
        <div style={s.sbHead}>
          <span style={s.sbTitle}>ページ</span>
          <span style={s.sbCount}>{pdfInfo.page_count}枚</span>
        </div>
        <div style={s.thumbList}>
          {Array.from({length:pdfInfo.page_count}, (_,i) => (
            <button key={i} style={{...s.thumb,...(previewPage===i?s.thumbOn:{})}} onClick={()=>handlePageSelect(i)}>
              {thumbImages[i]
                ? <img src={`data:image/jpeg;base64,${thumbImages[i]}`} style={s.thumbImg} alt=""/>
                : <div style={s.thumbPh}/>}
              <span style={s.thumbN}>{i+1}</span>
            </button>
          ))}
        </div>
      </aside>

      <main style={s.main}>
        <div style={s.mainHead}>
          <span style={s.mainTitle}>トリミング設定</span>
          <span style={s.pageInd}>{previewPage+1} / {pdfInfo.page_count} ページ</span>
        </div>
        <div style={s.canvasWrap}>
          {pageImage
            ? <TrimCanvas pageImageB64={pageImage} pageWidthPt={pageW} pageHeightPt={pageH}
                margins={trimMargins} onChange={setTrimMargins} displayWidth={CANVAS_W}/>
            : <div style={{...s.ph, width:CANVAS_W, height:Math.round(CANVAS_W*pageH/pageW)}}>
                <div style={s.spinner}/>
                <span style={s.centSub}>読み込み中…</span>
              </div>}
        </div>
      </main>

      <aside style={s.panel}>
        <TrimControls margins={trimMargins} pageW={pageW} pageH={pageH} pages={trimPages}
          totalPages={pdfInfo.page_count}
          onMargins={setTrimMargins} onPages={setTrimPages}
          onApply={handleExecute} onReset={()=>setTrimMargins(zero())} processing={false}
          trimPageSpec={trimPageSpec} onTrimPageSpec={setTrimPageSpec}
          extractSpec={extractSpec} onExtract={setExtractSpec}/>
      </aside>
    </div>
  );
}

// ── 結果ビュー ────────────────────────────────────────────────────────────────
function ResultView({ images, pageCount, onSave, onBack, onCompress, isSaving }: {
  images:string[]; pageCount:number; onSave:()=>void; onBack:()=>void; onCompress:()=>void; isSaving:boolean;
}) {
  return (
    <div style={r.root}>
      <div style={r.header}>
        <button style={r.btnBack} onClick={onBack}>← 設定に戻る</button>
        <span style={r.title}>トリミング結果確認</span>
        <span style={r.sub}>{pageCount}ページ（先頭{images.length}ページ表示）</span>
        <div style={{flex:1}}/>
        <button style={r.btnCompress} onClick={onCompress}>⚡ 続けて圧縮</button>
        <button style={{...r.btnSave,...(isSaving?r.dis:{})}} onClick={onSave} disabled={isSaving}>
          {isSaving?"保存中…":"💾 PDFを保存"}
        </button>
      </div>

      <div style={r.gallery}>
        {images.map((b64,i) => (
          <div key={i} style={r.card}>
            <span style={r.pageN}>{i+1} ページ</span>
            {b64
              ? <img src={`data:image/jpeg;base64,${b64}`} style={r.img} alt=""/>
              : <div style={r.imgPh}>プレビュー失敗</div>}
          </div>
        ))}
        {pageCount > images.length && (
          <div style={r.more}>… 他 {pageCount-images.length} ページ</div>
        )}
      </div>

      <div style={r.footer}>
        <button style={r.btnBack} onClick={onBack}>← 設定に戻る</button>
        <button style={r.btnCompress} onClick={onCompress}>⚡ 続けて圧縮</button>
        <button style={{...r.btnSave,...(isSaving?r.dis:{})}} onClick={onSave} disabled={isSaving}>
          {isSaving?"保存中…":"💾 PDFを保存"}
        </button>
      </div>
    </div>
  );
}

// ── スタイル ─────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root:    { display:"flex", height:"100%", background:"var(--c-bg)", color:"var(--c-text)", fontFamily:F, overflow:"hidden" },
  center:  { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:18, background:"var(--c-bg)" },
  spinner: { width:32, height:32, border:`3px solid var(--c-border)`, borderTop:`3px solid var(--c-accent)`, borderRadius:"50%", animation:"spin 0.8s linear infinite" },
  centSub: { color:"var(--c-textSub)", fontSize:13 },

  sidebar:  { width:128, flexShrink:0, display:"flex", flexDirection:"column", background:"var(--c-bgCard)", borderRight:`1px solid var(--c-border)`, overflow:"hidden" },
  sbHead:   { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 10px 7px", borderBottom:`1px solid var(--c-border)` },
  sbTitle:  { fontSize:10, color:"var(--c-textDim)", letterSpacing:"0.1em", textTransform:"uppercase" },
  sbCount:  { fontSize:10, color:"var(--c-textDim)" },
  thumbList:{ flex:1, overflowY:"auto", padding:"6px 5px", display:"flex", flexDirection:"column", gap:5 },
  thumb:    { display:"flex", flexDirection:"column", alignItems:"center", gap:3, padding:"5px 4px", borderRadius:6, border:"1px solid transparent", background:"transparent", cursor:"pointer", transition:"all 0.12s" },
  thumbOn:  { borderColor:"var(--c-accent)", background:"var(--c-accentBg)" },
  thumbImg: { width:104, height:"auto", borderRadius:2, display:"block" },
  thumbPh:  { width:104, height:140, background:"var(--c-border)", borderRadius:2 },
  thumbN:   { fontSize:10, color:"var(--c-textDim)" },

  main:      { flex:1, display:"flex", flexDirection:"column", overflow:"hidden", padding:"16px 20px", gap:12 },
  mainHead:  { display:"flex", alignItems:"center", gap:12 },
  mainTitle: { fontSize:15, fontWeight:600, color:"var(--c-text)" },
  pageInd:   { fontSize:12, color:"var(--c-textSub)" },
  canvasWrap:{ flex:1, overflow:"auto", display:"flex", alignItems:"flex-start", justifyContent:"center" },
  ph:        { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"var(--c-bgCard)", borderRadius:8, gap:12 },
  panel:     { width:280, flexShrink:0, borderLeft:`1px solid var(--c-border)`, overflow:"hidden" },

  errMsg: { fontSize:12, color:"var(--c-err)", background:"var(--c-errBg)", border:`1px solid var(--c-errBd)`, borderRadius:6, padding:"12px 16px", maxWidth:480, whiteSpace:"pre-wrap", wordBreak:"break-all" },
  errBtn: { padding:"8px 22px", background:"transparent", border:`1px solid var(--c-errBd)`, borderRadius:7, color:"var(--c-err)", cursor:"pointer", fontSize:13, fontFamily:F },
};

const r: Record<string, React.CSSProperties> = {
  root:       { display:"flex", flexDirection:"column", height:"100%", background:"var(--c-bg)", color:"var(--c-text)", fontFamily:F },
  header:     { display:"flex", alignItems:"center", gap:10, padding:"12px 20px", borderBottom:`1px solid var(--c-border)`, flexShrink:0 },
  btnBack:    { padding:"6px 14px", background:"transparent", border:`1px solid var(--c-borderHi)`, borderRadius:6, color:"var(--c-textSub)", cursor:"pointer", fontSize:13, fontFamily:F },
  btnCompress:{ padding:"8px 18px", background:"var(--c-accentBg)", border:`1px solid var(--c-accentBd)`, borderRadius:7, color:"var(--c-accent)", fontWeight:600, cursor:"pointer", fontSize:13, fontFamily:F },
  btnSave:    { padding:"9px 22px", background:"var(--c-accentBg)", border:`2px solid var(--c-accentBd)`, borderRadius:7, color:"var(--c-accent)", fontWeight:700, cursor:"pointer", fontSize:14, fontFamily:F },
  dis:        { opacity:0.4, cursor:"not-allowed" },
  title:      { fontSize:15, fontWeight:600, color:"var(--c-text)" },
  sub:        { fontSize:12, color:"var(--c-textSub)" },
  gallery:    { flex:1, overflowY:"auto", display:"flex", flexWrap:"wrap", gap:20, padding:24, alignContent:"flex-start", justifyContent:"center" },
  card:       { display:"flex", flexDirection:"column", alignItems:"center", gap:8, background:"var(--c-bgCard)", border:`1px solid var(--c-border)`, borderRadius:9, padding:14 },
  pageN:      { fontSize:11, color:"var(--c-textSub)" },
  img:        { maxWidth:290, maxHeight:390, display:"block", borderRadius:4 },
  imgPh:      { width:200, height:260, background:"var(--c-bgHover)", borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center", color:"var(--c-textDim)", fontSize:12 },
  more:       { display:"flex", alignItems:"center", justifyContent:"center", color:"var(--c-textDim)", fontSize:13, padding:"30px 20px" },
  footer:     { display:"flex", justifyContent:"flex-end", gap:10, padding:"12px 20px", borderTop:`1px solid var(--c-border)`, flexShrink:0 },
};

const b: Record<string, React.CSSProperties> = {
  center:  { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:14, background:"var(--c-bg)", padding:32 },
  title:   { fontSize:17, fontWeight:700, color:"var(--c-text)" },
  barWrap: { width:"100%", maxWidth:460, height:8, background:"var(--c-border)", borderRadius:4, overflow:"hidden" },
  bar:     { height:"100%", background:"var(--c-accent)", borderRadius:4, transition:"width 0.3s" },
  log:     { width:"100%", maxWidth:460, display:"flex", flexDirection:"column", gap:5, maxHeight:300, overflowY:"auto" },
  logRow:  { display:"flex", alignItems:"center", gap:9, padding:"6px 10px", background:"var(--c-bgCard)", borderRadius:6, border:`1px solid var(--c-border)` },
  logFile: { flex:1, fontSize:12, color:"var(--c-text)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  backBtn: { padding:"9px 26px", background:"transparent", border:`1px solid var(--c-borderHi)`, borderRadius:7, color:"var(--c-textSub)", cursor:"pointer", fontSize:13, fontFamily:F, marginTop:8 },
};
