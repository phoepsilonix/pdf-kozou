// src/pages/RotatePage.tsx

import { useEffect, useState, useCallback } from "react";
import { Spinner, ErrorView, PageHeader, BtnBack, BtnPrimary } from "../components/common";
import { usePdfStore }   from "../store/usePdfStore";
import { useSaveDialog } from "../hooks/useSaveDialog";
import { renderPage, rotatePdf, type PdfInfo } from "../lib/tauri";
import { C, F } from "../lib/theme";

interface Props { filePath: string; pdfInfo: PdfInfo; }
type Phase = "edit" | "processing" | "result" | "error";

const THUMB_DPI = 72;

export function RotatePage({ filePath, pdfInfo }: Props) {
  const { setError } = usePdfStore();
  const { pickSave } = useSaveDialog();
  const total = pdfInfo.page_count;

  const [phase,    setPhase]   = useState<Phase>("edit");
  const [thumbs,   setThumbs]  = useState<(string|undefined)[]>([]);
  // 各ページの追加回転量 (0/90/180/270)
  const [rotations, setRotations] = useState<number[]>(() => new Array(total).fill(0));
  const [globalRot, setGlobalRot] = useState<0|90|180|270>(0);
  const [errMsg,   setErrMsg]  = useState("");

  // サムネイル取得
  useEffect(() => {
    let cancelled = false;
    setThumbs([]);
    (async () => {
      for (let i=0; i<total; i++) {
        try {
          const b64 = await renderPage(filePath, i, THUMB_DPI);
          if (cancelled) return;
          setThumbs(p=>{ const a=[...p]; a[i]=b64; return a; });
        } catch { /* skip */ }
      }
    })();
    return () => { cancelled = true; };
  }, [filePath, total]);

  const rotate = (idx: number, delta: 90|-90) =>
    setRotations(r => r.map((v, i) => i===idx ? (v + delta + 360) % 360 : v));

  const applyGlobal = (deg: 90|180|270|0) => {
    setGlobalRot(deg as any);
    setRotations(new Array(total).fill(deg));
  };

  const resetAll = () => { setRotations(new Array(total).fill(0)); setGlobalRot(0); };

  const changedPages = rotations.map((v,i)=>({page:i+1,angle:v})).filter(p=>p.angle!==0);

  const handleExecute = useCallback(async () => {
    if (changedPages.length === 0) return;
    const base = filePath.split(/[/\\]/).pop()?.replace(/\.pdf$/i,"") ?? "file";
    const sp = await pickSave(`${base}_rotated.pdf`);
    if (!sp) return;
    setPhase("processing");
    try {
      await rotatePdf(filePath, sp, changedPages);
      setPhase("result");
    } catch (e) {
      setErrMsg(String(e)); setPhase("error"); setError(String(e));
    }
  }, [filePath, changedPages, pickSave, setError]);

  if (phase === "processing") return <Spinner label="回転処理中…" />;
  if (phase === "error")      return <ErrorView msg={errMsg} onBack={()=>{setPhase("edit");setErrMsg("");}} />;
  if (phase === "result") return (
    <div style={s.root}>
      <PageHeader>
        <BtnBack onClick={()=>setPhase("edit")} />
        <span style={s.title}>回転完了</span>
      </PageHeader>
      <div style={s.resultBody}>
        <div style={s.resultIcon}>✓</div>
        <div style={s.resultStat}>{changedPages.length} ページを回転</div>
      </div>
    </div>
  );

  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>回転</span>
        <span style={s.sub}>{filePath.split(/[/\\]/).pop()}</span>
        <span style={s.pageBadge}>{total}ページ</span>
        <div style={{flex:1}}/>
        {changedPages.length > 0 && (
          <span style={s.changeBadge}>{changedPages.length}ページ変更</span>
        )}
      </PageHeader>

      <div style={s.body}>
        {/* 左: 一括設定 */}
        <div style={s.panel}>
          <div style={s.secLabel}>一括回転</div>
          <div style={s.globalBtns}>
            {([0,90,180,270] as const).map(deg => (
              <button key={deg}
                style={{...s.globalBtn, ...(globalRot===deg ? s.globalBtnOn:{})}}
                onClick={()=>applyGlobal(deg)}>
                <span style={s.rotIcon}>{rotIcon(deg)}</span>
                <span>{deg === 0 ? "元に戻す" : `${deg}°`}</span>
              </button>
            ))}
          </div>

          <div style={s.secLabel}>個別設定</div>
          <p style={s.hint}>
            各ページの ↺ ↻ ボタンで個別に回転できます。
            回転は累積（元の向きからの絶対値）です。
          </p>

          <button style={s.resetBtn} onClick={resetAll}>全てリセット</button>

          <div style={{flex:1}}/>
          <BtnPrimary onClick={handleExecute} disabled={changedPages.length===0}>
            {changedPages.length===0 ? "回転なし" : `↻ ${changedPages.length}ページを回転して保存`}
          </BtnPrimary>
        </div>

        {/* 右: ページグリッド */}
        <div style={s.grid}>
          {Array.from({length:total}, (_,i) => {
            const rot = rotations[i];
            const changed = rot !== 0;
            return (
              <div key={i} style={{...s.pageCard, ...(changed ? s.pageCardChanged:{})}}>
                <div style={s.pageImgWrap}>
                  {thumbs[i]
                    ? <img src={`data:image/jpeg;base64,${thumbs[i]}`}
                           style={{...s.pageImg, transform:`rotate(${rot}deg)`}} alt="" />
                    : <div style={s.pageImgPh} />}
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
  if (deg===0)   return "⟳";
  if (deg===90)  return "↻";
  if (deg===180) return "↕";
  return "↺";
}

const s: Record<string, React.CSSProperties> = {
  root:    {display:"flex",flexDirection:"column",height:"100%",background:C.bg,color:C.text,fontFamily:F,overflow:"hidden"},
  title:   {fontSize:16,fontWeight:700,color:C.text},
  sub:     {fontSize:13,color:C.textSub,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"},
  pageBadge:{padding:"2px 10px",background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:12,fontSize:12,color:C.textSub},
  changeBadge:{padding:"3px 12px",background:"#1e2a1a",border:"1px solid #3a5a2a",borderRadius:12,fontSize:13,color:C.green,fontWeight:600},

  body:   {flex:1,display:"flex",overflow:"hidden"},
  panel:  {width:260,flexShrink:0,padding:"18px 18px",display:"flex",flexDirection:"column",gap:14,borderRight:`1px solid ${C.border}`},
  secLabel:{fontSize:12,color:C.textSub,letterSpacing:"0.08em"},
  globalBtns:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6},
  globalBtn:{display:"flex",flexDirection:"column",alignItems:"center",gap:5,padding:"12px 8px",background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:8,cursor:"pointer",fontSize:13,color:C.text,fontFamily:F,transition:"all 0.12s"},
  globalBtnOn:{borderColor:C.accent,background:C.accentBg,color:C.accent},
  rotIcon:{fontSize:20},
  hint:   {fontSize:12,color:C.textSub,lineHeight:1.6,margin:0},
  resetBtn:{padding:"9px 0",background:"transparent",border:`1px solid ${C.borderHi}`,borderRadius:8,color:C.textSub,cursor:"pointer",fontSize:13,fontFamily:F},

  grid:   {flex:1,overflowY:"auto",padding:16,display:"flex",flexWrap:"wrap",gap:10,alignContent:"flex-start"},
  pageCard:{display:"flex",flexDirection:"column",background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:9,overflow:"hidden",width:120,transition:"all 0.12s"},
  pageCardChanged:{borderColor:"#3a5a2a",background:"#0e1810"},
  pageImgWrap:{width:120,height:170,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",background:C.bg},
  pageImg:{width:100,height:141,objectFit:"contain",transition:"transform 0.3s"},
  pageImgPh:{width:100,height:141,background:C.border,borderRadius:3},
  pageCardBottom:{display:"flex",alignItems:"center",gap:5,padding:"6px 8px",borderTop:`1px solid ${C.border}`},
  pageNum:{fontSize:11,color:C.textDim},
  rotBadge:{fontSize:10,padding:"1px 6px",background:"#1e2a1a",border:"1px solid #3a5a2a",borderRadius:10,color:C.green,marginLeft:"auto"},
  rotateBtns:{display:"flex",gap:3,marginLeft:"auto"},
  rotBtn:{width:28,height:28,display:"flex",alignItems:"center",justifyContent:"center",background:C.bg,border:`1px solid ${C.borderHi}`,borderRadius:5,cursor:"pointer",fontSize:16,color:C.text,fontFamily:F},

  resultBody:{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14},
  resultIcon:{fontSize:56,color:C.green},
  resultStat:{fontSize:20,fontWeight:700,color:C.text},
};
