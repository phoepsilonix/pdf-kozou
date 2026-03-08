// src/pages/RotatePage.tsx — 単体 & バッチ対応
import { useEffect, useState, useCallback } from "react";
import { invoke }     from "@tauri-apps/api/core";
import { Spinner, ErrorView, PageHeader, BtnBack, BtnPrimary } from "../components/common";
import { usePdfStore, type FileEntry } from "../store/usePdfStore";
import { renderPage, rotatePdf, getPdfInfo, type PdfInfo } from "../lib/tauri";
import { C, F } from "../lib/theme";

interface Props {
  filePath:    string;
  pdfInfo:     PdfInfo;
  batchFiles?: FileEntry[];
}
import { CompressPage } from "./CompressPage";
type Phase = "edit" | "processing" | "result" | "error" | "compress";
const THUMB_DPI = 80;

interface BatchProgress {
  current: number; total: number; currentFile: string;
  done: { file: string }[]; errors: { file: string; msg: string }[];
}

export function RotatePage({ filePath, pdfInfo, batchFiles }: Props) {
  const { setError } = usePdfStore();
  const isBatch = (batchFiles?.length ?? 0) > 1;

  // バッチ時: 選択中ファイルインデックス
  const [batchIdx,   setBatchIdx]   = useState(0);
  const curPath  = isBatch ? batchFiles![batchIdx].path : filePath;
  const curInfo  = isBatch ? null : pdfInfo; // バッチ時は都度取得
  const [curPageCount, setCurPageCount] = useState(pdfInfo.page_count);

  const [phase,    setPhase]    = useState<Phase>("edit");
  const [thumbs,   setThumbs]   = useState<(string|undefined)[]>([]);
  const [rotations,setRotations]= useState<number[]>(() => new Array(pdfInfo.page_count).fill(0));
  const [globalRot,setGlobalRot]= useState<0|90|180|270>(0);
  const [errMsg,   setErrMsg]   = useState("");
  const [outDir,   setOutDir]   = useState("");
  const [savedPath, setSavedPath] = useState("");
  const [batchProgress, setBatchProgress] = useState<BatchProgress|null>(null);
  const [batchThumbs, setBatchThumbs] = useState<(string|undefined)[]>([]);

  // バッチ切り替え時: そのファイルのページ数取得とサムネイルリセット
  useEffect(() => {
    if (!isBatch) return;
    const path = batchFiles![batchIdx].path;
    getPdfInfo(path).then(info => {
      setCurPageCount(info.page_count);
      setRotations(new Array(info.page_count).fill(globalRot));
      setThumbs([]);
    }).catch(() => {});
  }, [batchIdx, isBatch]);

  // サムネイル取得
  useEffect(() => {
    let cancelled = false;
    setThumbs([]);
    (async () => {
      const n = isBatch ? curPageCount : pdfInfo.page_count;
      for (let i=0; i<n; i++) {
        try {
          const b64 = await renderPage(curPath, i, THUMB_DPI);
          if (cancelled) return;
          setThumbs(p => { const a=[...p]; a[i]=b64; return a; });
        } catch { /* skip */ }
      }
    })();
    return () => { cancelled = true; };
  }, [curPath, curPageCount]);

  // バッチ: 各ファイルの先頭サムネイル
  useEffect(() => {
    if (!isBatch || !batchFiles) return;
    let cancelled = false;
    setBatchThumbs(new Array(batchFiles.length).fill(undefined));
    (async () => {
      for (let i=0; i<batchFiles.length; i++) {
        try {
          const b64 = await renderPage(batchFiles[i].path, 0, 52);
          if (cancelled) return;
          setBatchThumbs(p => { const a=[...p]; a[i]=b64; return a; });
        } catch {}
      }
    })();
    return () => { cancelled = true; };
  }, [isBatch, batchFiles]);

  const rotate = (idx: number, delta: 90|-90) =>
    setRotations(r => r.map((v,i) => i===idx ? (v+delta+360)%360 : v));

  const applyGlobal = (deg: 0|90|180|270) => {
    setGlobalRot(deg);
    setRotations(new Array(curPageCount).fill(deg));
  };
  const resetAll = () => { setRotations(new Array(curPageCount).fill(0)); setGlobalRot(0); };

  const changedPages = rotations.map((v,i)=>({page:i+1,angle:v})).filter(p=>p.angle!==0);

  const pickDir = useCallback(async () => {
    const dir = await invoke<string|null>("pick_output_dir").catch(()=>null);
    if (dir) setOutDir(dir);
  }, []);

  // ── 単体実行 ─────────────────────────────────────────────────────────────
  const handleExecuteSingle = useCallback(async () => {
    if (changedPages.length === 0) return;
    const base = filePath.split(/[/\\]/).pop()?.replace(/\.pdf$/i,"") ?? "file";
    const sp = await invoke<string|null>("pick_save_file",
      { defaultName:`${base}_rotated.pdf`, initialDir:outDir||undefined }).catch(()=>null);
    if (!sp) return;
    setPhase("processing");
    try {
      await rotatePdf(filePath, sp, changedPages);
      setSavedPath(sp);
      setPhase("result");
    } catch (e) {
      setErrMsg(String(e)); setPhase("error"); setError(String(e));
    }
  }, [filePath, changedPages, outDir, setError]);

  // ── バッチ実行 ────────────────────────────────────────────────────────────
  const handleExecuteBatch = useCallback(async () => {
    if (!outDir) { await pickDir(); return; }
    const files = batchFiles!;
    setPhase("processing");
    const prog: BatchProgress = { current:0, total:files.length, currentFile:"", done:[], errors:[] };
    setBatchProgress({...prog});
    for (let i=0; i<files.length; i++) {
      const f = files[i];
      prog.current = i+1; prog.currentFile = f.filename;
      setBatchProgress({...prog});
      try {
        const info = await getPdfInfo(f.path);
        const pages = rotations
          .slice(0, info.page_count)
          .map((v,idx)=>({page:idx+1,angle:v}))
          .filter(p=>p.angle!==0);
        if (pages.length > 0) {
          const out = `${outDir}/${f.filename.replace(/\.pdf$/i,"")}_rotated.pdf`;
          await rotatePdf(f.path, out, pages);
        }
        prog.done.push({ file: f.filename });
      } catch (e) {
        prog.errors.push({ file: f.filename, msg: String(e) });
      }
      setBatchProgress({...prog});
    }
    setPhase("result");
  }, [batchFiles, rotations, outDir, pickDir]);

  // ── フェーズ ──────────────────────────────────────────────────────────────
  if (phase==="processing" && !isBatch) return <Spinner label="回転処理中…" />;

  if (phase==="processing" && isBatch && batchProgress) return (
    <div style={s.root}>
      <div style={s.batchProgress}>
        <div style={s.bpTitle}>回転処理中… {batchProgress.current}/{batchProgress.total}</div>
        <div style={s.bpBar}><div style={{...s.bpFill, width:`${(batchProgress.current/batchProgress.total)*100}%`}}/></div>
        <div style={s.bpCurrent}>{batchProgress.currentFile}</div>
        <div style={s.bpLog}>
          {batchProgress.done.map((d,i)=>(
            <div key={i} style={s.bpRow}><span style={{color:C.accent}}>✓</span><span style={s.bpFile}>{d.file}</span></div>
          ))}
          {batchProgress.errors.map((e,i)=>(
            <div key={`e${i}`} style={s.bpRow}><span style={{color:C.err}}>✕</span><span style={s.bpFile}>{e.file}</span><span style={{fontSize:10,color:C.err}}>{e.msg}</span></div>
          ))}
        </div>
      </div>
    </div>
  );

  if (phase==="error") return <ErrorView msg={errMsg} onBack={()=>{setPhase("edit");setErrMsg("");}}/>;

  // 続けて圧縮
  if (phase==="compress" && savedPath) return (
    <CompressPage
      filePath={filePath}
      pdfInfo={pdfInfo}
      sourceFile={savedPath}
      onDone={()=>setPhase("result")}
    />
  );

  if (phase==="result") return (
    <div style={s.root}>
      <PageHeader>
        <BtnBack onClick={()=>{setPhase("edit");setBatchProgress(null);setSavedPath("");}} />
        <span style={s.title}>{isBatch?"バッチ回転完了":"回転完了"}</span>
      </PageHeader>
      <div style={s.resultBody}>
        <div style={s.resultIcon}>{batchProgress?.errors.length ? "⚠" : "✓"}</div>
        {isBatch && batchProgress ? (
          <>
            <div style={s.resultStat}>{batchProgress.done.length}件処理完了{batchProgress.errors.length>0?` · ${batchProgress.errors.length}件エラー`:""}</div>
            <div style={s.resultDir}>{outDir}</div>
          </>
        ) : (
          <>
            <div style={s.resultStat}>{changedPages.length}ページを回転</div>
            {savedPath && (
              <button style={s.compressBtn} onClick={()=>setPhase("compress")}>
                ⊙ 続けて圧縮する
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );

  // ── 設定画面 ──────────────────────────────────────────────────────────────
  const n = isBatch ? curPageCount : pdfInfo.page_count;

  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>回転{isBatch?` — ${batchFiles!.length}件バッチ`:""}</span>
        {!isBatch && <span style={s.sub}>{filePath.split(/[/\\]/).pop()}</span>}
        <span style={s.pageBadge}>{n}ページ</span>
        <div style={{flex:1}}/>
        {changedPages.length>0 && <span style={s.changeBadge}>{changedPages.length}ページ変更</span>}
      </PageHeader>

      <div style={s.body}>
        {/* 左パネル */}
        <div style={s.panel}>
          {/* バッチ時: ファイルリスト */}
          {isBatch && (
            <>
              <div style={s.secLabel}>対象ファイル ({batchFiles!.length}件)</div>
              <div style={s.fileList}>
                {batchFiles!.map((f,i)=>(
                  <button key={f.id} style={{...s.fileItem,...(i===batchIdx?s.fileItemOn:{})}}
                    onClick={()=>setBatchIdx(i)}>
                    {batchThumbs[i]
                      ? <img src={`data:image/jpeg;base64,${batchThumbs[i]}`} style={s.fileThumb} alt=""/>
                      : <div style={s.fileThumbPh}/>}
                    <div style={s.fileItemInfo}>
                      <span style={s.fileItemName}>{f.filename}</span>
                      <span style={s.fileItemMeta}>{f.pageCount}p</span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}

          <div style={s.secLabel}>一括回転</div>
          <div style={s.globalBtns}>
            {([0,90,180,270] as const).map(deg=>(
              <button key={deg} style={{...s.globalBtn,...(globalRot===deg?s.globalBtnOn:{})}}
                onClick={()=>applyGlobal(deg)}>
                <span style={s.rotIcon}>{rotIcon(deg)}</span>
                <span>{deg===0?"元に戻す":`${deg}°`}</span>
              </button>
            ))}
          </div>

          <div style={s.secLabel}>個別設定</div>
          <p style={s.hint}>各ページの ↺↻ ボタンで個別回転できます。</p>
          <button style={s.resetBtn} onClick={resetAll}>全てリセット</button>
          <div style={{flex:1}}/>

          {isBatch ? (
            <>
              <div style={s.secLabel}>出力フォルダ</div>
              <div style={s.dirRow}>
                <div style={s.dirPath} title={outDir}>{outDir||"（未選択）"}</div>
                <button style={s.dirPickBtn} onClick={pickDir}>参照…</button>
              </div>
              <BtnPrimary onClick={handleExecuteBatch} disabled={changedPages.length===0}>
                {outDir ? `↻ ${batchFiles!.length}件まとめて回転` : "📁 出力先を選択して実行"}
              </BtnPrimary>
            </>
          ) : (
            <BtnPrimary onClick={handleExecuteSingle} disabled={changedPages.length===0}>
              {changedPages.length===0 ? "回転なし" : `↻ ${changedPages.length}ページを回転して保存`}
            </BtnPrimary>
          )}
        </div>

        {/* 右: ページグリッド */}
        <div style={s.grid}>
          {Array.from({length:n}, (_,i) => {
            const rot     = rotations[i] ?? 0;
            const changed = rot !== 0;
            // 横長になる回転かどうか
            const isLandscape = rot===90 || rot===270;
            const cardW = isLandscape ? 170 : 120;
            const cardH = isLandscape ? 120 : 170;
            const imgW  = isLandscape ? 140 : 100;
            const imgH  = isLandscape ? 100 : 140;
            return (
              <div key={i} style={{...s.pageCard,...(changed?s.pageCardChanged:{}), width:cardW}}>
                <div style={{...s.pageImgWrap, width:cardW, height:cardH, overflow:"hidden", transition:"all 0.3s"}}>
                  {thumbs[i]
                    ? <img src={`data:image/jpeg;base64,${thumbs[i]}`}
                           style={{width:imgW,height:imgH,objectFit:"contain",transform:`rotate(${rot}deg)`,transition:"transform 0.3s"}} alt="" />
                    : <div style={{width:imgW,height:imgH,background:C.border,borderRadius:3}}/>}
                </div>
                <div style={s.pageCardBottom}>
                  <span style={s.pageNum}>p.{i+1}</span>
                  {changed && <span style={s.rotBadge}>{rot}°</span>}
                  <div style={s.rotateBtns}>
                    <button style={s.rotBtn} onClick={()=>rotate(i,-90)} title="左90°">↺</button>
                    <button style={s.rotBtn} onClick={()=>rotate(i, 90)} title="右90°">↻</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function rotIcon(deg: number) {
  return deg===0?"⟳":deg===90?"↻":deg===180?"↕":"↺";
}

const s: Record<string, React.CSSProperties> = {
  root:{ display:"flex",flexDirection:"column",height:"100%",background:C.bg,color:C.text,fontFamily:F,overflow:"hidden" },
  title:{ fontSize:16,fontWeight:700,color:C.text },
  sub:{ fontSize:13,color:C.textSub,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" },
  pageBadge:{ padding:"3px 10px",background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:11,fontSize:12,color:C.textSub },
  changeBadge:{ padding:"3px 11px",background:C.accentBg,border:`1px solid ${C.accentBd}`,borderRadius:11,fontSize:13,color:C.accent,fontWeight:600 },
  body:{ flex:1,display:"flex",overflow:"hidden" },
  panel:{ width:240,flexShrink:0,padding:"16px",display:"flex",flexDirection:"column",gap:12,borderRight:`1px solid ${C.border}`,overflowY:"auto" },
  secLabel:{ fontSize:11,color:C.textSub,letterSpacing:"0.08em",textTransform:"uppercase" as const },
  globalBtns:{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:6 },
  globalBtn:{ display:"flex",flexDirection:"column",alignItems:"center",gap:5,padding:"11px 8px",background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:8,cursor:"pointer",fontSize:14,color:C.text,fontFamily:F,transition:"all 0.12s" },
  globalBtnOn:{ borderColor:C.accent,background:C.accentBg,color:C.accent },
  rotIcon:{ fontSize:22 },
  hint:{ fontSize:12,color:C.textSub,lineHeight:1.6,margin:0 },
  resetBtn:{ padding:"9px 0",background:"transparent",border:`1px solid ${C.borderHi}`,borderRadius:7,color:C.textSub,cursor:"pointer",fontSize:13,fontFamily:F },
  fileList:{ display:"flex",flexDirection:"column",gap:3,maxHeight:220,overflowY:"auto" },
  fileItem:{ display:"flex",alignItems:"center",gap:8,padding:"7px 8px",background:"transparent",border:`1px solid transparent`,borderRadius:6,cursor:"pointer",fontFamily:F,textAlign:"left" as const,transition:"all 0.1s" },
  fileItemOn:{ background:C.accentBg,borderColor:C.accentBd },
  fileThumb:{ width:36,height:50,objectFit:"cover" as const,borderRadius:3,flexShrink:0 },
  fileThumbPh:{ width:36,height:50,background:C.border,borderRadius:3,flexShrink:0 },
  fileItemInfo:{ flex:1,display:"flex",flexDirection:"column",gap:2,minWidth:0 },
  fileItemName:{ fontSize:11,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" },
  fileItemMeta:{ fontSize:10,color:C.textSub },
  dirRow:{ display:"flex",gap:6 },
  dirPath:{ flex:1,padding:"7px 9px",background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:6,color:C.textSub,fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" },
  dirPickBtn:{ padding:"7px 12px",background:C.bgCard,border:`1px solid ${C.borderHi}`,borderRadius:6,color:C.text,cursor:"pointer",fontSize:12,fontFamily:F,flexShrink:0 },

  grid:{ flex:1,overflowY:"auto",padding:14,display:"flex",flexWrap:"wrap" as const,gap:10,alignContent:"flex-start" },
  pageCard:{ display:"flex",flexDirection:"column",background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:9,overflow:"hidden",transition:"all 0.15s" },
  pageCardChanged:{ borderColor:C.accentBd,background:C.accentBg },
  pageImgWrap:{ display:"flex",alignItems:"center",justifyContent:"center",background:C.bg },
  pageCardBottom:{ display:"flex",alignItems:"center",gap:4,padding:"6px 8px",borderTop:`1px solid ${C.border}` },
  pageNum:{ fontSize:11,color:C.textDim },
  rotBadge:{ fontSize:10,padding:"1px 6px",background:C.accentBg,border:`1px solid ${C.accentBd}`,borderRadius:9,color:C.accent },
  rotateBtns:{ display:"flex",gap:3,marginLeft:"auto" },
  rotBtn:{ width:30,height:30,display:"flex",alignItems:"center",justifyContent:"center",background:C.bg,border:`1px solid ${C.borderHi}`,borderRadius:5,cursor:"pointer",fontSize:18,color:C.text,fontFamily:F },

  resultBody:{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14 },
  resultIcon:{ fontSize:56,color:C.accent },
  resultStat:{ fontSize:20,fontWeight:700,color:C.text },
  resultDir:{ fontSize:12,color:C.textSub },
  compressBtn:{ padding:"12px 32px",background:C.accentBg,border:`1px solid ${C.accentBd}`,borderRadius:9,color:C.accent,fontWeight:600,cursor:"pointer",fontSize:15,fontFamily:F },

  batchProgress:{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16,padding:32 },
  bpTitle:{ fontSize:16,fontWeight:700,color:C.text },
  bpBar:{ width:"100%",maxWidth:440,height:8,background:C.border,borderRadius:4,overflow:"hidden" },
  bpFill:{ height:"100%",background:C.accent,borderRadius:4,transition:"width 0.3s" },
  bpCurrent:{ fontSize:13,color:C.textSub },
  bpLog:{ width:"100%",maxWidth:440,display:"flex",flexDirection:"column",gap:5,maxHeight:260,overflowY:"auto" },
  bpRow:{ display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:C.bgCard,borderRadius:6,border:`1px solid ${C.border}` },
  bpFile:{ flex:1,fontSize:12,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" },
};

  body:{ flex:1,display:"flex",overflow:"hidden" },
  panel:{ width:220,flexShrink:0,padding:"14px 14px",display:"flex",flexDirection:"column",gap:10,borderRight:`1px solid ${C.border}`,overflowY:"auto" },
  secLabel:{ fontSize:10,color:C.textSub,letterSpacing:"0.08em",textTransform:"uppercase" as const },
  globalBtns:{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:5 },
  globalBtn:{ display:"flex",flexDirection:"column",alignItems:"center",gap:4,padding:"9px 6px",background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:7,cursor:"pointer",fontSize:12,color:C.text,fontFamily:F,transition:"all 0.12s" },
  globalBtnOn:{ borderColor:C.accent,background:C.accentBg,color:C.accent },
  rotIcon:{ fontSize:18 },
  hint:{ fontSize:11,color:C.textSub,lineHeight:1.6,margin:0 },
  resetBtn:{ padding:"7px 0",background:"transparent",border:`1px solid ${C.borderHi}`,borderRadius:7,color:C.textSub,cursor:"pointer",fontSize:12,fontFamily:F },
  fileList:{ display:"flex",flexDirection:"column",gap:3,maxHeight:200,overflowY:"auto" },
  fileItem:{ display:"flex",alignItems:"center",gap:7,padding:"5px 7px",background:"transparent",border:`1px solid transparent`,borderRadius:6,cursor:"pointer",fontFamily:F,textAlign:"left" as const,transition:"all 0.1s" },
  fileItemOn:{ background:C.accentBg,borderColor:C.accentBd },
  fileThumb:{ width:32,height:45,objectFit:"cover" as const,borderRadius:2,flexShrink:0 },
  fileThumbPh:{ width:32,height:45,background:C.border,borderRadius:2,flexShrink:0 },
  fileItemInfo:{ flex:1,display:"flex",flexDirection:"column",gap:1,minWidth:0 },
  fileItemName:{ fontSize:10,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" },
  fileItemMeta:{ fontSize:9,color:C.textSub },
  dirRow:{ display:"flex",gap:5 },
  dirPath:{ flex:1,padding:"5px 7px",background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:5,color:C.textSub,fontSize:10,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" },
  dirPickBtn:{ padding:"5px 10px",background:C.bgCard,border:`1px solid ${C.borderHi}`,borderRadius:5,color:C.text,cursor:"pointer",fontSize:10,fontFamily:F,flexShrink:0 },

  grid:{ flex:1,overflowY:"auto",padding:12,display:"flex",flexWrap:"wrap" as const,gap:8,alignContent:"flex-start" },
  pageCard:{ display:"flex",flexDirection:"column",background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden",transition:"all 0.15s" },
  pageCardChanged:{ borderColor:C.accentBd,background:C.accentBg },
  pageImgWrap:{ display:"flex",alignItems:"center",justifyContent:"center",background:C.bg },
  pageCardBottom:{ display:"flex",alignItems:"center",gap:4,padding:"5px 7px",borderTop:`1px solid ${C.border}` },
  pageNum:{ fontSize:10,color:C.textDim },
  rotBadge:{ fontSize:9,padding:"1px 5px",background:C.accentBg,border:`1px solid ${C.accentBd}`,borderRadius:9,color:C.green },
  rotateBtns:{ display:"flex",gap:2,marginLeft:"auto" },
  rotBtn:{ width:26,height:26,display:"flex",alignItems:"center",justifyContent:"center",background:C.bg,border:`1px solid ${C.borderHi}`,borderRadius:4,cursor:"pointer",fontSize:15,color:C.text,fontFamily:F },

  resultBody:{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12 },
  resultIcon:{ fontSize:52,color:C.green },
  resultStat:{ fontSize:18,fontWeight:700,color:C.text },
  resultDir:{ fontSize:11,color:C.textSub },
  compressBtn:{ padding:"10px 28px",background:C.accentBg,border:`1px solid ${C.accentBd}`,borderRadius:8,color:C.accent,fontWeight:600,cursor:"pointer",fontSize:14,fontFamily:F },

  batchProgress:{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14,padding:32 },
  bpTitle:{ fontSize:14,fontWeight:700,color:C.text },
  bpBar:{ width:"100%",maxWidth:420,height:7,background:C.border,borderRadius:4,overflow:"hidden" },
  bpFill:{ height:"100%",background:C.accent,borderRadius:4,transition:"width 0.3s" },
  bpCurrent:{ fontSize:11,color:C.textSub },
  bpLog:{ width:"100%",maxWidth:420,display:"flex",flexDirection:"column",gap:4,maxHeight:240,overflowY:"auto" },
  bpRow:{ display:"flex",alignItems:"center",gap:8,padding:"4px 8px",background:C.bgCard,borderRadius:5,border:`1px solid ${C.border}` },
  bpFile:{ flex:1,fontSize:11,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" },
};
