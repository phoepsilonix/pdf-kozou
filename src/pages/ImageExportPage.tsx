// src/pages/ImageExportPage.tsx — 単体 & バッチ対応

import { useEffect, useState, useCallback } from "react";
import { invoke }   from "@tauri-apps/api/core";
import { Spinner, ErrorView, ThumbCard, PageHeader, BtnBack, BtnPrimary } from "../components/common";
import { usePdfStore, type FileEntry } from "../store/usePdfStore";
import { renderPage, exportImages, type PdfInfo, type ImageFormat } from "../lib/tauri";
import { C, F } from "../lib/theme";

interface Props {
  filePath:    string;
  pdfInfo:     PdfInfo;
  batchFiles?: FileEntry[];
}

type Phase = "edit" | "processing" | "result" | "error";
const THUMB_DPI = 56;

const DPI_PRESETS = [
  { label:"72",  val:72,  desc:"画面用" },
  { label:"144", val:144, desc:"標準" },
  { label:"300", val:300, desc:"印刷" },
  { label:"600", val:600, desc:"高精細" },
];

interface BatchProgress {
  current: number; total: number; currentFile: string;
  done:    { file:string; count:number }[];
  errors:  { file:string; msg:string }[];
}

export function ImageExportPage({ filePath, pdfInfo, batchFiles }: Props) {
  const { setError } = usePdfStore();
  const isBatch = (batchFiles?.length ?? 0) > 1;
  const total   = pdfInfo.page_count;

  const [phase,   setPhase]   = useState<Phase>("edit");
  const [thumbs,  setThumbs]  = useState<(string|undefined)[]>([]);
  const [format,  setFormat]  = useState<ImageFormat>("jpeg");
  const [dpi,     setDpi]     = useState(144);
  const [quality, setQuality] = useState(85);
  const [prefix,  setPrefix]  = useState("page");
  const [outDir,  setOutDir]  = useState("");
  const [result,  setResult]  = useState<string[]>([]);
  const [errMsg,  setErrMsg]  = useState("");
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [batchThumbs,   setBatchThumbs]   = useState<(string|undefined)[]>([]);
  const [previewIdx,    setPreviewIdx]    = useState(0);

  // 単体: サムネイル
  useEffect(() => {
    if (isBatch) return;
    let cancelled = false;
    setThumbs([]);
    (async () => {
      for (let i=0; i<total; i++) {
        try {
          const b64 = await renderPage(filePath, i, THUMB_DPI);
          if (cancelled) return;
          setThumbs(p => { const a=[...p]; a[i]=b64; return a; });
        } catch {}
      }
    })();
    return () => { cancelled = true; };
  }, [filePath, total, isBatch]);

  // バッチ: 先頭ページサムネイル
  useEffect(() => {
    if (!isBatch || !batchFiles) return;
    let cancelled = false;
    setBatchThumbs(new Array(batchFiles.length).fill(undefined));
    (async () => {
      for (let i=0; i<batchFiles.length; i++) {
        try {
          const b64 = await renderPage(batchFiles[i].path, 0, THUMB_DPI);
          if (cancelled) return;
          setBatchThumbs(p => { const a=[...p]; a[i]=b64; return a; });
        } catch {}
      }
    })();
    return () => { cancelled = true; };
  }, [isBatch, batchFiles]);

  const pickDir = useCallback(async () => {
    const dir = await invoke<string|null>("pick_output_dir").catch(()=>null);
    if (dir) setOutDir(dir);
  }, []);

  // サイズ概算
  const scale = dpi / 72;
  const pw = Math.round(595 * scale);
  const ph = Math.round(842 * scale);

  // 単体実行
  const handleExecuteSingle = useCallback(async () => {
    if (!outDir) { await pickDir(); return; }
    setPhase("processing");
    try {
      const res = await exportImages(filePath, outDir, format, dpi,
        format==="jpeg" ? quality : undefined, prefix||undefined);
      setResult(res.files); setPhase("result");
    } catch (e) {
      setErrMsg(String(e)); setPhase("error"); setError(String(e));
    }
  }, [filePath, outDir, format, dpi, quality, prefix, pickDir, setError]);

  // バッチ実行
  const handleExecuteBatch = useCallback(async () => {
    if (!outDir) { await pickDir(); return; }
    const files = batchFiles!;
    setPhase("processing");
    const progress: BatchProgress = { current:0, total:files.length, currentFile:"", done:[], errors:[] };
    setBatchProgress({...progress});
    for (let i=0; i<files.length; i++) {
      const f = files[i];
      progress.current = i+1; progress.currentFile = f.filename;
      setBatchProgress({...progress});
      try {
        const subDir = `${outDir}/${f.filename.replace(/\.pdf$/i,"")}`;
        const res = await exportImages(f.path, subDir, format, dpi,
          format==="jpeg" ? quality : undefined, prefix||undefined);
        progress.done.push({ file:f.filename, count:res.files.length });
      } catch (e) {
        progress.errors.push({ file:f.filename, msg:String(e) });
      }
      setBatchProgress({...progress});
    }
    setPhase("result");
  }, [batchFiles, outDir, format, dpi, quality, prefix, pickDir]);

  // ─────────── フェーズ ───────────
  if (phase==="processing" && !isBatch) return <Spinner label={`画像変換中… (${total}ページ)`}/>;

  if (phase==="processing" && isBatch && batchProgress) return (
    <div style={s.root}>
      <div style={s.center}>
        <div style={s.bpTitle}>画像変換中… {batchProgress.current}/{batchProgress.total}</div>
        <div style={s.bpBar}><div style={{...s.bpFill, width:`${batchProgress.current/batchProgress.total*100}%`}}/></div>
        <div style={s.bpCurrent}>{batchProgress.currentFile}</div>
        <div style={s.bpLog}>
          {batchProgress.done.map((d,i) => (
            <div key={i} style={s.bpRow}><span style={{color:C.accent}}>✓</span><span style={s.bpFile}>{d.file}</span><span style={s.bpMeta}>→ {d.count}枚</span></div>
          ))}
        </div>
      </div>
    </div>
  );

  if (phase==="error") return <ErrorView msg={errMsg} onBack={()=>{setPhase("edit");setErrMsg("");}}/>;

  // バッチ完了
  if (phase==="result" && isBatch && batchProgress) return (
    <div style={s.root}>
      <PageHeader>
        <BtnBack onClick={()=>{setPhase("edit");setBatchProgress(null);}}/>
        <span style={s.title}>バッチ画像変換完了</span>
      </PageHeader>
      <div style={s.center}>
        <span style={{fontSize:56,color:batchProgress.errors.length?C.warn:C.accent}}>{batchProgress.errors.length?"⚠":"✓"}</span>
        <div style={s.bpTitle}>{batchProgress.done.length}件成功{batchProgress.errors.length>0?` · ${batchProgress.errors.length}件エラー`:""}</div>
        <div style={{fontSize:12,color:C.textSub}}>{outDir}</div>
        <div style={s.bpLog}>
          {batchProgress.done.map((d,i)=>(<div key={i} style={s.bpRow}><span style={{color:C.accent}}>✓</span><span style={s.bpFile}>{d.file}</span><span style={s.bpMeta}>→ {d.count}枚</span></div>))}
          {batchProgress.errors.map((e,i)=>(<div key={`e${i}`} style={{...s.bpRow,background:C.errBg,borderColor:C.errBd}}><span style={{color:C.err}}>✕</span><span style={s.bpFile}>{e.file}</span><span style={{...s.bpMeta,color:C.err}}>{e.msg}</span></div>))}
        </div>
      </div>
    </div>
  );

  // 単体完了
  if (phase==="result") return (
    <div style={s.root}>
      <PageHeader>
        <BtnBack onClick={()=>setPhase("edit")}/>
        <span style={s.title}>画像変換完了</span>
      </PageHeader>
      <div style={s.center}>
        <span style={{fontSize:56,color:C.accent}}>✓</span>
        <div style={s.bpTitle}>{result.length}ファイルを出力</div>
        <div style={{fontSize:12,color:C.textSub}}>{outDir}</div>
        <div style={s.bpLog}>
          {result.slice(0,20).map((f,i)=>(<div key={i} style={s.bpRow}><span>🖼</span><span style={s.bpFile}>{f.split(/[/\\]/).pop()}</span></div>))}
          {result.length>20 && <div style={{fontSize:12,color:C.textDim,textAlign:"center",padding:8}}>… 他 {result.length-20}ファイル</div>}
        </div>
      </div>
    </div>
  );

  // ─────────── 設定画面 ───────────
  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>画像変換{isBatch?` — ${batchFiles!.length}件バッチ`:""}</span>
        {!isBatch && <span style={s.sub}>{filePath.split(/[/\\]/).pop()}</span>}
        {!isBatch && <span style={s.pageBadge}>{total}ページ</span>}
        <div style={{flex:1}}/>
        <span style={s.outBadge}>→ {format.toUpperCase()} {pw}×{ph}px</span>
      </PageHeader>

      <div style={s.body}>
        {/* 設定パネル */}
        <div style={s.panel}>
          <div style={s.secLabel}>フォーマット</div>
          <div style={s.fmtRow}>
            {(["jpeg","png"] as const).map(f=>(
              <button key={f} onClick={()=>setFormat(f)}
                style={{...s.fmtBtn,...(format===f?s.fmtBtnOn:{})}}>
                <span style={s.fmtIcon}>{f==="jpeg"?"🖼":"📐"}</span>
                <span style={s.fmtName}>{f.toUpperCase()}</span>
                <span style={s.fmtDesc}>{f==="jpeg"?"小・写真向き":"可逆・透過対応"}</span>
              </button>
            ))}
          </div>

          <div style={s.secLabel}>解像度 (DPI)</div>
          <div style={s.dpiGrid}>
            {DPI_PRESETS.map(p=>(
              <button key={p.val} onClick={()=>setDpi(p.val)}
                style={{...s.dpiBtn,...(dpi===p.val?s.dpiBtnOn:{})}}>
                <span style={s.dpiLabel}>{p.label}</span>
                <span style={s.dpiDesc}>{p.desc}</span>
              </button>
            ))}
          </div>
          {/* DPI 数値直接入力 — 大きめフォント */}
          <div style={s.numRow}>
            <button style={s.stepBtn} onClick={()=>setDpi(v=>Math.max(36,v-12))}>−</button>
            <input type="number" style={s.numInput} value={dpi} min={36} max={1200}
              onChange={e=>setDpi(parseInt(e.target.value)||72)}/>
            <button style={s.stepBtn} onClick={()=>setDpi(v=>Math.min(1200,v+12))}>＋</button>
            <span style={s.numLabel}>dpi → {pw}×{ph}px</span>
          </div>

          {format==="jpeg" && (
            <>
              <div style={s.secLabel}>JPEG品質 <span style={{fontSize:20,fontWeight:700,color:C.text}}>{quality}</span>%</div>
              <input type="range" min={10} max={100} step={5} value={quality}
                onChange={e=>setQuality(parseInt(e.target.value))}
                style={{width:"100%", accentColor:C.accent}}/>
              <div style={s.rangeLabels}><span>低品質</span><span>高品質</span></div>
            </>
          )}

          <div style={s.secLabel}>ファイル名プレフィックス</div>
          <div style={s.prefixRow}>
            <input type="text" style={s.textInput} value={prefix} placeholder="page"
              onChange={e=>setPrefix(e.target.value)}/>
            <span style={s.prefixSuffix}>_0001.{format==="jpeg"?"jpg":"png"}</span>
          </div>

          {isBatch && (
            <div style={s.batchNote}>
              📁 ファイルごとにサブフォルダを作成して出力します
            </div>
          )}

          <div style={s.secLabel}>出力フォルダ</div>
          <div style={s.dirRow}>
            <div style={s.dirPath} title={outDir}>{outDir||"（未選択）"}</div>
            <button style={s.dirPickBtn} onClick={pickDir}>参照…</button>
          </div>

          <BtnPrimary onClick={isBatch ? handleExecuteBatch : handleExecuteSingle}>
            {outDir
              ? isBatch
                ? `🖼 ${batchFiles!.length}件を変換`
                : `🖼 変換実行 → ${total}ファイル`
              : "📁 出力先を選択して実行"}
          </BtnPrimary>
        </div>

        {/* プレビューエリア */}
        <div style={s.preview}>
          {isBatch ? (
            <>
              <div style={s.previewHead}>対象ファイル — {batchFiles!.length}件</div>
              <div style={s.batchFileList}>
                {batchFiles!.map((f,i)=>(
                  <div key={f.id}
                    style={{...s.batchFileItem,...(i===previewIdx?s.batchFileItemOn:{})}}
                    onClick={()=>setPreviewIdx(i)}>
                    {batchThumbs[i]
                      ? <img src={`data:image/jpeg;base64,${batchThumbs[i]}`} style={s.batchThumb} alt=""/>
                      : <div style={s.batchThumbPh}/>}
                    <div style={s.batchFileInfo}>
                      <span style={s.batchFileName}>{f.filename}</span>
                      <span style={s.batchFileMeta}>{f.pageCount}ページ</span>
                      <span style={s.batchFileMeta}>→ {f.pageCount}枚の{format.toUpperCase()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div style={s.previewHead}>プレビュー — {total}ページ</div>
              <div style={s.thumbGrid}>
                {Array.from({length:total},(_,i)=>(
                  <ThumbCard key={i} b64={thumbs[i]} pageNum={i+1} width={90}/>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root:      { display:"flex", flexDirection:"column", height:"100%", background:C.bg, color:C.text, fontFamily:F, overflow:"hidden" },
  title:     { fontSize:16, fontWeight:700, color:C.text },
  sub:       { fontSize:13, color:C.textSub, maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  pageBadge: { padding:"3px 11px", background:C.bgCard, border:`1px solid ${C.border}`, borderRadius:12, fontSize:12, color:C.textSub },
  outBadge:  { fontSize:14, color:C.accent, fontWeight:700 },

  body:    { flex:1, display:"flex", overflow:"hidden" },
  panel:   { width:300, flexShrink:0, padding:"16px 18px", display:"flex", flexDirection:"column", gap:12, overflowY:"auto", borderRight:`1px solid ${C.border}` },
  secLabel:{ fontSize:12, color:C.textSub, letterSpacing:"0.07em", textTransform:"uppercase" as const, marginTop:4 },

  fmtRow:  { display:"flex", gap:8 },
  fmtBtn:  { flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:5, padding:"13px 8px", background:C.bgCard, border:`1px solid ${C.border}`, borderRadius:9, cursor:"pointer", fontFamily:F, transition:"all 0.1s" },
  fmtBtnOn:{ borderColor:C.accent, background:C.accentBg },
  fmtIcon: { fontSize:22 },
  fmtName: { fontSize:14, fontWeight:700, color:C.text },
  fmtDesc: { fontSize:11, color:C.textSub, textAlign:"center" as const },

  dpiGrid: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 },
  dpiBtn:  { display:"flex", flexDirection:"column", padding:"8px 10px", background:C.bgCard, border:`1px solid ${C.border}`, borderRadius:7, cursor:"pointer", fontFamily:F, transition:"all 0.1s" },
  dpiBtnOn:{ borderColor:C.accent, background:C.accentBg },
  dpiLabel:{ fontSize:16, fontWeight:700, color:C.text },
  dpiDesc: { fontSize:11, color:C.textSub },

  // 数値入力 — 大きめ
  numRow:   { display:"flex", alignItems:"center", gap:7 },
  stepBtn:  { width:42, height:42, display:"flex", alignItems:"center", justifyContent:"center", background:C.bgCard, border:`1px solid ${C.borderHi}`, borderRadius:7, cursor:"pointer", fontSize:22, color:C.text, fontFamily:F, flexShrink:0 },
  numInput: { width:84, padding:"7px 0", background:C.bgCard, border:`1px solid ${C.borderHi}`, borderRadius:7, color:C.text, fontSize:28, fontFamily:F, textAlign:"center" as const, fontWeight:700 },
  numLabel: { fontSize:11, color:C.textSub },
  rangeLabels:{ display:"flex", justifyContent:"space-between", fontSize:11, color:C.textDim },

  prefixRow:   { display:"flex", alignItems:"center", gap:6 },
  textInput:   { flex:1, padding:"8px 10px", background:C.bgCard, border:`1px solid ${C.borderHi}`, borderRadius:7, color:C.text, fontSize:14, fontFamily:F },
  prefixSuffix:{ fontSize:11, color:C.textDim, flexShrink:0 },
  dirRow:      { display:"flex", gap:7 },
  dirPath:     { flex:1, padding:"8px 10px", background:C.bgCard, border:`1px solid ${C.border}`, borderRadius:7, color:C.textSub, fontSize:12, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  dirPickBtn:  { padding:"8px 14px", background:C.bgCard, border:`1px solid ${C.borderHi}`, borderRadius:7, color:C.text, cursor:"pointer", fontSize:13, fontFamily:F, flexShrink:0 },
  batchNote:   { padding:"10px 12px", background:C.bgCard, border:`1px solid ${C.accentBd}`, borderRadius:7, fontSize:12, color:C.textSub, lineHeight:1.6 },

  // 進捗
  center:   { flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16, padding:32 },
  bpTitle:  { fontSize:17, fontWeight:700, color:C.text },
  bpBar:    { width:"100%", maxWidth:480, height:8, background:C.border, borderRadius:4, overflow:"hidden" },
  bpFill:   { height:"100%", background:C.accent, borderRadius:4, transition:"width 0.3s" },
  bpCurrent:{ fontSize:13, color:C.textSub },
  bpLog:    { width:"100%", maxWidth:480, display:"flex", flexDirection:"column", gap:5, maxHeight:300, overflowY:"auto" },
  bpRow:    { display:"flex", alignItems:"center", gap:9, padding:"6px 10px", background:C.bgCard, borderRadius:6, border:`1px solid ${C.border}` },
  bpFile:   { flex:1, fontSize:13, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  bpMeta:   { fontSize:12, color:C.textSub, flexShrink:0 },

  preview:     { flex:1, display:"flex", flexDirection:"column", overflow:"hidden" },
  previewHead: { padding:"11px 18px", fontSize:13, color:C.textSub, borderBottom:`1px solid ${C.border}`, flexShrink:0 },
  thumbGrid:   { flex:1, overflowY:"auto", padding:14, display:"flex", flexWrap:"wrap" as const, gap:8, alignContent:"flex-start" },

  batchFileList:  { flex:1, overflowY:"auto", display:"flex", flexDirection:"column" },
  batchFileItem:  { display:"flex", alignItems:"center", gap:12, padding:"12px 16px", borderBottom:`1px solid ${C.border}`, cursor:"pointer", transition:"background 0.1s" },
  batchFileItemOn:{ background:C.accentBg, borderLeft:`3px solid ${C.accent}` },
  batchThumb:     { width:54, height:76, objectFit:"cover" as const, borderRadius:4, flexShrink:0 },
  batchThumbPh:   { width:54, height:76, background:C.border, borderRadius:4, flexShrink:0 },
  batchFileInfo:  { flex:1, display:"flex", flexDirection:"column", gap:3, minWidth:0 },
  batchFileName:  { fontSize:14, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  batchFileMeta:  { fontSize:12, color:C.textSub },
};
