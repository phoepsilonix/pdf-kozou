// src/pages/ViewerPage.tsx — 簡易PDFビューワー
import { useEffect, useState, useCallback, useRef } from "react";
import { renderPage, getPdfInfo, type PdfInfo } from "../lib/tauri";
import { Spinner, PageHeader } from "../components/common";
import { type FileEntry } from "../store/usePdfStore";
import { C, F } from "../lib/theme";

interface Props {
  filePath?: string;
  pdfInfo?:  PdfInfo;
  fileList?: FileEntry[];
}

const THUMB_DPI = 52;
const VIEW_DPI  = 160;

export function ViewerPage({ filePath, pdfInfo, fileList = [] }: Props) {
  const isMulti  = fileList.length > 1;
  const [activeIdx, setActiveIdx] = useState(0);
  const [activeInfo, setActiveInfo] = useState<PdfInfo | null>(pdfInfo ?? null);
  const activePath = isMulti ? fileList[activeIdx]?.path : (filePath ?? "");

  useEffect(() => {
    if (!isMulti) { setActiveInfo(pdfInfo ?? null); return; }
    setActiveInfo(null);
    const path = fileList[activeIdx]?.path;
    if (path) getPdfInfo(path).then(setActiveInfo).catch(() => {});
  }, [activeIdx, isMulti]);

  const total = activeInfo?.page_count ?? 0;

  // サムネイルキャッシュ
  const thumbCache = useRef<Map<string, (string|undefined)[]>>(new Map());
  const [thumbs,       setThumbs]       = useState<(string|undefined)[]>([]);
  const [viewPage,     setViewPage]     = useState(0);
  const [viewImg,      setViewImg]      = useState<string|null>(null);
  const [viewLoading,  setViewLoading]  = useState(false);
  const [zoom,         setZoom]         = useState(1.0);

  // サムネイル取得
  useEffect(() => {
    if (!activePath || !activeInfo) { setThumbs([]); return; }
    const cached = thumbCache.current.get(activePath);
    if (cached) { setThumbs([...cached]); }
    else {
      const arr: (string|undefined)[] = new Array(activeInfo.page_count).fill(undefined);
      thumbCache.current.set(activePath, arr);
      setThumbs([]);
    }
    let cancelled = false;
    const info = activeInfo;
    (async () => {
      const cur = thumbCache.current.get(activePath)!;
      for (let i=0; i<info.page_count; i++) {
        if (cur[i]) continue; // already cached
        try {
          const b64 = await renderPage(activePath, i, THUMB_DPI);
          if (cancelled) return;
          cur[i] = b64;
          thumbCache.current.set(activePath, [...cur]);
          setThumbs([...cur]);
        } catch {}
      }
    })();
    return () => { cancelled = true; };
  }, [activePath, activeInfo]);

  // 拡大ページ表示
  const openPage = useCallback(async (pageIdx: number) => {
    if (!activePath) return;
    setViewPage(pageIdx);
    setViewLoading(true);
    setViewImg(null);
    try {
      const b64 = await renderPage(activePath, pageIdx, VIEW_DPI);
      setViewImg(b64);
    } catch { setViewImg(null); }
    setViewLoading(false);
  }, [activePath]);

  useEffect(() => {
    if (total > 0) openPage(0);
  }, [activePath, total]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key==="ArrowRight"||e.key==="ArrowDown") { const n=Math.min(viewPage+1,total-1); if(n!==viewPage) openPage(n); }
      if (e.key==="ArrowLeft" ||e.key==="ArrowUp")   { const p=Math.max(viewPage-1,0);       if(p!==viewPage) openPage(p); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewPage, total, openPage]);

  if (!activeInfo) return <Spinner label="読み込み中…" />;
  const fname = activePath.split(/[/\\]/).pop() ?? "";

  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>ビューワー</span>
        <span style={s.fileSub} title={activePath}>{fname}</span>
        <span style={s.pageBadge}>{total}ページ</span>
        <div style={{flex:1}}/>
        {/* ズームコントロール */}
        <div style={s.zoomRow}>
          <button style={s.zBtn} onClick={()=>setZoom(z=>Math.max(0.25,z-0.25))}>−</button>
          <span style={s.zVal}>{Math.round(zoom*100)}%</span>
          <button style={s.zBtn} onClick={()=>setZoom(z=>Math.min(4.0,z+0.25))}>＋</button>
          <button style={s.zBtnSm} onClick={()=>setZoom(1.0)}>100%</button>
          <button style={s.zBtnSm} onClick={()=>setZoom(0.5)}>50%</button>
        </div>
      </PageHeader>

      <div style={s.body}>
        {/* ── 複数ファイルペイン ── */}
        {isMulti && (
          <div style={s.filePane}>
            <div style={s.paneHead}>ファイル ({fileList.length})</div>
            <div style={{flex:1,overflowY:"auto"}}>
              {fileList.map((f,i) => (
                <button key={f.id}
                  style={{...s.filePaneItem,...(i===activeIdx?s.filePaneItemOn:{})}}
                  onClick={()=>{setActiveIdx(i);setZoom(1.0);}}>
                  <span style={s.filePaneIcon}>📄</span>
                  <div style={s.filePaneInfo}>
                    <span style={s.filePaneName}>{f.filename}</span>
                    <span style={s.filePaneMeta}>{f.pageCount}p</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── サムネイルペイン（プレビュー付き） ── */}
        <div style={s.thumbPane}>
          <div style={s.paneHead}>{viewPage+1} / {total}</div>
          <div style={s.thumbList}>
            {Array.from({length:total}, (_,i) => (
              <button key={i}
                style={{...s.thumbItem,...(i===viewPage?s.thumbItemOn:{})}}
                onClick={()=>openPage(i)}
                title={`ページ ${i+1}`}>
                <div style={s.thumbImgBox}>
                  {thumbs[i]
                    ? <img src={`data:image/jpeg;base64,${thumbs[i]}`} style={s.thumbImg} alt=""/>
                    : <div style={s.thumbPh}/>}
                </div>
                <span style={{...s.thumbN,...(i===viewPage?s.thumbNOn:{})}}>{i+1}</span>
              </button>
            ))}
          </div>
        </div>

        {/* ── メインビュー: スクロール前提 ── */}
        <div style={s.mainView}>
          {viewLoading && (
            <div style={s.viewCenter}>
              <div style={s.viewSpinner}/>
            </div>
          )}
          {!viewLoading && viewImg && (
            // overflow: scroll で上下左右スクロール可能
            <div style={s.viewScroll}>
              <div style={{
                display:"flex", alignItems:"flex-start", justifyContent:"center",
                minWidth:"100%", minHeight:"100%", padding:24,
              }}>
                <img
                  src={`data:image/jpeg;base64,${viewImg}`}
                  style={{
                    display:"block",
                    width: `${Math.round(zoom * 600)}px`,
                    height:"auto",
                    boxShadow:"0 4px 32px rgba(0,0,0,0.7)",
                    borderRadius:2,
                    flexShrink:0,
                  }}
                  alt={`ページ ${viewPage+1}`}
                />
              </div>
            </div>
          )}
          {!viewLoading && !viewImg && (
            <div style={s.viewCenter}><span style={{color:C.textDim}}>表示できません</span></div>
          )}

          {/* ページナビ（下部固定） */}
          <div style={s.pageNav}>
            <button style={s.pageNavBtn} disabled={viewPage===0}       onClick={()=>openPage(viewPage-1)}>← 前</button>
            <span style={s.pageNavInfo}>{viewPage+1} / {total}</span>
            <button style={s.pageNavBtn} disabled={viewPage>=total-1} onClick={()=>openPage(viewPage+1)}>次 →</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root:{ display:"flex",flexDirection:"column",height:"100%",background:C.bg,color:C.text,fontFamily:F,overflow:"hidden" },
  title:{ fontSize:16,fontWeight:700,color:C.text },
  fileSub:{ fontSize:13,color:C.textSub,maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" },
  pageBadge:{ padding:"3px 11px",background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:11,fontSize:12,color:C.textSub },

  zoomRow:{ display:"flex",alignItems:"center",gap:4 },
  zBtn:{ width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",background:C.bgCard,border:`1px solid ${C.borderHi}`,borderRadius:5,cursor:"pointer",fontSize:15,color:C.text,fontFamily:F },
  zVal:{ fontSize:13,color:C.textSub,minWidth:36,textAlign:"center" as const },
  zBtnSm:{ padding:"5px 12px",background:C.bgCard,border:`1px solid ${C.borderHi}`,borderRadius:5,cursor:"pointer",fontSize:10,color:C.textSub,fontFamily:F },

  body:{ flex:1,display:"flex",overflow:"hidden" },

  // 複数ファイルペイン
  filePane:{ width:180,flexShrink:0,display:"flex",flexDirection:"column",borderRight:`1px solid ${C.border}`,overflow:"hidden" },
  paneHead:{ padding:"7px 10px",fontSize:10,color:C.textDim,letterSpacing:"0.06em",textTransform:"uppercase" as const,borderBottom:`1px solid ${C.border}`,flexShrink:0,background:C.bgCard },
  filePaneItem:{ display:"flex",alignItems:"center",gap:7,padding:"9px 10px",background:"transparent",border:"none",borderBottom:`1px solid ${C.border}`,cursor:"pointer",fontFamily:F,textAlign:"left" as const,transition:"background 0.08s",width:"100%" },
  filePaneItemOn:{ background:C.accentBg },
  filePaneIcon:{ fontSize:14,flexShrink:0 },
  filePaneInfo:{ flex:1,display:"flex",flexDirection:"column",gap:1,minWidth:0 },
  filePaneName:{ fontSize:13,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" },
  filePaneMeta:{ fontSize:9,color:C.textSub },

  // サムネイルペイン（幅を広げてプレビューを見やすく）
  thumbPane:{ width:120,flexShrink:0,display:"flex",flexDirection:"column",borderRight:`1px solid ${C.border}`,overflow:"hidden",background:C.bgCard },
  thumbList:{ flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:3,padding:"6px 5px" },
  thumbItem:{ display:"flex",flexDirection:"column",alignItems:"center",gap:2,padding:"3px",background:"transparent",border:"1px solid transparent",borderRadius:5,cursor:"pointer",transition:"all 0.1s",fontFamily:F },
  thumbItemOn:{ border:`1px solid ${C.accent}`,background:C.accentBg },
  // 画像ボックスは固定高で縦スクロールに対応
  thumbImgBox:{ width:102,height:145,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",background:C.bg,borderRadius:2 },
  thumbImg:{ width:"100%",height:"100%",objectFit:"contain" as const },
  thumbPh:{ width:"100%",height:"100%",background:C.border },
  thumbN:{ fontSize:9,color:C.textDim },
  thumbNOn:{ color:C.accent,fontWeight:700 },

  // メインビュー
  mainView:{ flex:1,display:"flex",flexDirection:"column",overflow:"hidden",background:"#070e09" },
  viewCenter:{ flex:1,display:"flex",alignItems:"center",justifyContent:"center" },
  viewSpinner:{ width:28,height:28,border:`3px solid ${C.border}`,borderTop:`3px solid ${C.accent}`,borderRadius:"50%",animation:"spin 0.8s linear infinite" },
  // スクロール可能なビューエリア（overflow両方scroll）
  viewScroll:{ flex:1,overflow:"scroll",overscrollBehavior:"contain" },

  // ページナビ
  pageNav:{ flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",gap:14,padding:"8px",borderTop:`1px solid ${C.border}`,background:C.bgCard },
  pageNavBtn:{ padding:"5px 18px",background:C.accentBg,border:`1px solid ${C.accentBd}`,borderRadius:6,color:C.accent,cursor:"pointer",fontSize:12,fontFamily:F },
  pageNavInfo:{ fontSize:14,color:C.textSub,minWidth:52,textAlign:"center" as const },
};
