// src/App.tsx
import { useState, useCallback, useEffect, useRef } from "react";
import { listen }          from "@tauri-apps/api/event";
import { TrimPage }        from "./pages/TrimPage";
import { CompressPage }    from "./pages/CompressPage";
import { SplitPage }       from "./pages/SplitPage";
import { MergePage }       from "./pages/MergePage";
import { RotatePage }      from "./pages/RotatePage";
import { ImageExportPage } from "./pages/ImageExportPage";
import { ViewerPage }      from "./pages/ViewerPage";
import { usePdfStore, type FileEntry } from "./store/usePdfStore";
import { getPdfInfo, type PdfInfo }    from "./lib/tauri";
import { invoke }          from "@tauri-apps/api/core";
import { C, F }            from "./lib/theme";

const GLOBAL_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: ${C.bg}; font-size: 15px; }
  @keyframes spin   { to { transform: rotate(360deg); } }
  @keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
  input[type=number]::-webkit-inner-spin-button { opacity:0.5; }
  input:focus  { border-color:${C.accent} !important; outline:none; }
  ::-webkit-scrollbar       { width:6px; height:6px; }
  ::-webkit-scrollbar-track { background:${C.bg}; }
  ::-webkit-scrollbar-thumb { background:${C.borderHi}; border-radius:3px; }
  button:hover:not(:disabled) { filter:brightness(1.1); }
  button:active:not(:disabled){ filter:brightness(0.9); }
  button:disabled { cursor:not-allowed !important; }
`;

export type ToolId = "split" | "merge" | "trim" | "rotate" | "compress" | "image" | "viewer";

const TOOLS: { id:ToolId; icon:string; label:string; desc:string; minFiles:number; maxFiles:number|null }[] = [
  { id:"split",    icon:"⊗", label:"分割",      desc:"ページを分割",     minFiles:1, maxFiles:null },
  { id:"merge",    icon:"⊕", label:"結合",      desc:"複数PDFを合体",    minFiles:2, maxFiles:null },
  { id:"trim",     icon:"✂", label:"トリミング", desc:"余白をカット",     minFiles:1, maxFiles:null },
  { id:"rotate",   icon:"↻", label:"回転",       desc:"ページを回転",     minFiles:1, maxFiles:null },
  { id:"compress", icon:"⊙", label:"圧縮",       desc:"ファイルを軽量化", minFiles:1, maxFiles:null },
  { id:"image",    icon:"🖼",label:"画像変換",   desc:"ページを画像に",   minFiles:1, maxFiles:null },
  { id:"viewer",   icon:"👁", label:"ビューワー", desc:"PDFを確認・閲覧",  minFiles:1, maxFiles:null },
];

export default function App() {
  const { fileList, addFiles, removeFile, toggleSelect,
          selectAll, selectNone, clearList, reorderFiles,
          setFile, setError, lastError } = usePdfStore();

  const [activeTool, setActiveTool] = useState<ToolId|null>(null);
  const [toolFiles,  setToolFiles]  = useState<FileEntry[]>([]);
  const [dragOver,   setDragOver]   = useState(false);
  const dragCounter = useRef(0);

  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = GLOBAL_CSS;
    document.head.appendChild(el);
    return () => { document.head.removeChild(el); };
  }, []);

  useEffect(() => {
    const ul = listen<string[]>("open-pdf-files", e => handleAddPaths(e.payload));
    return () => { ul.then(fn => fn()); };
  }, []);

  const handleAddPaths = useCallback(async (paths: string[]) => {
    for (const path of paths) {
      try {
        const info = await getPdfInfo(path);
        const stat = await invoke<{size:number}>("get_file_stat",{path}).catch(()=>({size:0}));
        addFiles([{ path, filename:path.split(/[/\\]/).pop()??path,
          pageCount:info.page_count, sizeBytes:stat.size, selected:true }]);
      } catch(e) { setError(`${path.split(/[/\\]/).pop()}: ${e}`); }
    }
  }, [addFiles, setError]);

  const handlePickFiles = useCallback(async () => {
    const paths = await invoke<string[]>("pick_open_files").catch(()=>[] as string[]);
    if (paths.length) await handleAddPaths(paths);
  }, [handleAddPaths]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); dragCounter.current=0; setDragOver(false);
    const paths = Array.from(e.dataTransfer.files)
      .filter(f=>f.name.toLowerCase().endsWith(".pdf"))
      .map(f=>(f as any).path as string).filter(Boolean);
    if (paths.length) await handleAddPaths(paths);
  }, [handleAddPaths]);

  const handleLaunchTool = useCallback(async (toolId: ToolId) => {
    const sel = fileList.filter(f=>f.selected);
    if (sel.length===0) return;
    if (toolId!=="merge" && toolId!=="viewer") {
      try {
        const info = await getPdfInfo(sel[0].path);
        setFile(sel[0].path, info);
      } catch(e) { setError(String(e)); return; }
    }
    setToolFiles(sel);
    setActiveTool(toolId);
  }, [fileList, setFile, setError]);

  const handleHome = useCallback(() => {
    setActiveTool(null); setToolFiles([]);
  }, []);

  const handleToolChange = useCallback(async (t: ToolId) => {
    const sel = toolFiles;
    if (sel.length===0) return;
    if (t!=="merge" && t!=="viewer") {
      try {
        const info = await getPdfInfo(sel[0].path);
        setFile(sel[0].path, info);
      } catch(e) { setError(String(e)); return; }
    }
    setActiveTool(t);
  }, [toolFiles, setFile, setError]);

  const sel      = fileList.filter(f=>f.selected);
  const selCount = sel.length;
  const selPages = sel.reduce((s,f)=>s+f.pageCount,0);
  const selBytes = sel.reduce((s,f)=>s+f.sizeBytes,0);

  const { filePath, pdfInfo } = usePdfStore();

  if (activeTool) {
    const isBatch = toolFiles.length > 1;
    return (
      <ToolShell
        activeTool={activeTool} toolFiles={toolFiles}
        filePath={filePath??""} pdfInfo={pdfInfo??{page_count:0,pages:[]}}
        onHome={handleHome} onOpenMore={handlePickFiles}
        onToolChange={handleToolChange} isBatch={isBatch}
      />
    );
  }

  return (
    <div style={{...s.root,...(dragOver?s.rootDrag:{})}}
      onDragOver={e=>e.preventDefault()}
      onDragEnter={e=>{e.preventDefault();dragCounter.current++;setDragOver(true);}}
      onDragLeave={()=>{if(--dragCounter.current<=0){setDragOver(false);dragCounter.current=0;}}}
      onDrop={handleDrop}>

      <header style={s.header}>
        <span style={s.logo}>PDF<span style={{color:C.accent}}>小僧</span></span>
        <span style={s.tagline}>Pure Rust · MuPDF · オフライン完全動作</span>
      </header>

      <div style={s.listCard}>
        {fileList.length===0 ? (
          <div style={s.emptyZone}>
            <span style={s.emptyIcon}>⊕</span>
            <span style={s.emptyTitle}>PDFをドロップ、または追加</span>
            <span style={s.emptySub}>複数ファイルを一度に追加できます</span>
            <button style={s.btnAddBig} onClick={handlePickFiles}>ファイルを選択…</button>
          </div>
        ) : (
          <>
            <div style={s.fileRows}>
              {fileList.map((f,i)=>(
                <FileRow key={f.id} entry={f} index={i}
                  onToggle={()=>toggleSelect(f.id)}
                  onRemove={()=>removeFile(f.id)}
                  onDragReorder={reorderFiles}/>
              ))}
            </div>
            <div style={s.listFooter}>
              <button style={s.btnAdd} onClick={handlePickFiles}>＋ 追加</button>
              <button style={s.btnSm}  onClick={selectAll}>全選択</button>
              <button style={s.btnSm}  onClick={selectNone}>解除</button>
              <div style={{flex:1}}/>
              <button style={s.btnClear} onClick={clearList}>クリア</button>
            </div>
          </>
        )}
      </div>

      {fileList.length>0 && (
        <div style={s.summary}>
          {selCount>0 ? (
            <>
              <span style={s.sumSel}>{selCount}ファイル選択中</span>
              <span style={s.sumDot}>·</span>
              <span style={s.sumInfo}>{selPages}ページ</span>
              {selBytes>0 && <><span style={s.sumDot}>·</span><span style={s.sumInfo}>{(selBytes/1048576).toFixed(1)} MB</span></>}
            </>
          ) : <span style={s.sumNone}>ファイルを選択してください</span>}
        </div>
      )}

      {fileList.length>0 && (
        <div style={s.toolBar}>
          {TOOLS.map(t=>{
            const enabled = selCount>=t.minFiles && (t.maxFiles==null||selCount<=t.maxFiles);
            return (
              <button key={t.id}
                style={{...s.toolBtn,...(enabled?s.toolBtnOn:s.toolBtnOff)}}
                onClick={()=>enabled&&handleLaunchTool(t.id)} disabled={!enabled}>
                <span style={s.toolIcon}>{t.icon}</span>
                <span style={s.toolLabel}>{t.label}</span>
                <span style={s.toolDesc}>
                  {selCount>1 && !["merge","viewer"].includes(t.id) ? `${selCount}件一括` : t.desc}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {dragOver && (
        <div style={s.dragOverlay}>
          <span style={s.dragIcon}>⊕</span>
          <span style={s.dragText}>PDFをドロップして追加</span>
        </div>
      )}
      {lastError && <div style={s.error}>{lastError}</div>}
    </div>
  );
}

// ── FileRow ──────────────────────────────────────────────────────────────────

function FileRow({ entry, index, onToggle, onRemove, onDragReorder }: {
  entry:FileEntry; index:number; onToggle:()=>void; onRemove:()=>void;
  onDragReorder:(f:number,t:number)=>void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const mb = entry.sizeBytes>0 ? (entry.sizeBytes/1048576).toFixed(1)+" MB" : "";
  return (
    <div draggable
      onDragStart={e=>{setIsDragging(true);e.dataTransfer.setData("fileId",String(entry.id));}}
      onDragEnd={()=>{setIsDragging(false);setIsDragOver(false);}}
      onDragOver={e=>{e.preventDefault();setIsDragOver(true);}}
      onDragLeave={()=>setIsDragOver(false)}
      onDrop={e=>{e.preventDefault();setIsDragOver(false);
        const fid=parseInt(e.dataTransfer.getData("fileId")||"0");
        if(fid&&fid!==entry.id) onDragReorder(fid,entry.id);}}
      style={{...fr.row,...(entry.selected?fr.rowSel:{}),...(isDragOver?fr.rowDO:{}),...(isDragging?fr.rowDrag:{})}}>
      <button style={{...fr.check,...(entry.selected?fr.checkOn:{})}} onClick={onToggle}>
        {entry.selected&&<span style={fr.checkMark}>✓</span>}
      </button>
      <span style={fr.handle}>⣿</span>
      <span style={fr.num}>{index+1}</span>
      <div style={fr.info}>
        <span style={fr.name} title={entry.path}>{entry.filename}</span>
        <span style={fr.meta}>{entry.pageCount}ページ{mb?"  "+mb:""}</span>
      </div>
      <button style={fr.del} onClick={onRemove} title="削除">×</button>
    </div>
  );
}

// ── ToolShell ────────────────────────────────────────────────────────────────

function ToolShell({ activeTool, toolFiles, filePath, pdfInfo, onHome, onOpenMore, onToolChange, isBatch }: {
  activeTool:ToolId; toolFiles:FileEntry[]; filePath:string; pdfInfo:PdfInfo;
  onHome:()=>void; onOpenMore:()=>void; onToolChange:(t:ToolId)=>void; isBatch:boolean;
}) {
  const filename = filePath.split(/[/\\]/).pop()??"";
  const batchFiles = isBatch ? toolFiles : undefined;

  return (
    <div style={sh.root}>
      <nav style={sh.nav}>
        <button style={sh.homeBtn} onClick={onHome}>
          PDF<span style={{color:C.accent}}>小僧</span>
        </button>
        <div style={sh.div}/>
        {isBatch
          ? <span style={sh.batchLabel}>📂 {toolFiles.length}ファイル</span>
          : <span style={sh.filename} title={filePath}>{filename}</span>}
        <div style={{flex:1}}/>
        {TOOLS.map(t=>(
          <button key={t.id}
            style={{...sh.tab,...(activeTool===t.id?sh.tabOn:{})}}
            onClick={()=>onToolChange(t.id)} title={t.label}>
            <span>{t.icon}</span>
            <span style={sh.tabLabel}>{t.label}</span>
          </button>
        ))}
        <div style={sh.div}/>
        <button style={sh.openBtn} onClick={onOpenMore}>開く…</button>
      </nav>

      <div style={{flex:1,overflow:"hidden"}}>
        {activeTool==="trim"     && <TrimPage        filePath={filePath} pdfInfo={pdfInfo} batchFiles={batchFiles}/>}
        {activeTool==="compress" && <CompressPage    filePath={filePath} pdfInfo={pdfInfo} batchFiles={batchFiles}/>}
        {activeTool==="split"    && <SplitPage       filePath={filePath} pdfInfo={pdfInfo} batchFiles={batchFiles}/>}
        {activeTool==="merge"    && <MergePage       initPaths={toolFiles.map(f=>f.path)}/>}
        {activeTool==="rotate"   && <RotatePage      filePath={filePath} pdfInfo={pdfInfo} batchFiles={batchFiles}/>}
        {activeTool==="image"    && <ImageExportPage filePath={filePath} pdfInfo={pdfInfo} batchFiles={batchFiles}/>}
        {activeTool==="viewer"   && <ViewerPage      filePath={filePath} pdfInfo={pdfInfo} fileList={batchFiles}/>}
      </div>
    </div>
  );
}

// ── styles ───────────────────────────────────────────────────────────────────

const s: Record<string,React.CSSProperties> = {
  root:{ minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:24,background:C.bg,color:C.text,fontFamily:F,padding:"28px 32px",position:"relative",transition:"background 0.15s" },
  rootDrag:{ background:"#0e1510" },
  header:{ display:"flex",flexDirection:"column",alignItems:"center",gap:6 },
  logo:{ fontSize:52,fontWeight:800,color:C.text,letterSpacing:"-0.02em",lineHeight:1 },
  tagline:{ fontSize:12,color:C.textDim,letterSpacing:"0.12em",textTransform:"uppercase" },
  listCard:{ width:"100%",maxWidth:720,background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden",minHeight:180 },
  emptyZone:{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14,padding:"48px 28px" },
  emptyIcon:{ fontSize:44,color:C.borderHi },
  emptyTitle:{ fontSize:18,fontWeight:600,color:C.textSub },
  emptySub:{ fontSize:14,color:C.textDim },
  btnAddBig:{ padding:"12px 32px",background:C.accentBg,border:`1px solid ${C.accentBd}`,borderRadius:8,color:C.accent,fontWeight:700,cursor:"pointer",fontSize:15,fontFamily:F },
  fileRows:{ display:"flex",flexDirection:"column" },
  listFooter:{ display:"flex",alignItems:"center",gap:8,padding:"10px 16px",borderTop:`1px solid ${C.border}`,background:C.bg },
  btnAdd:{ padding:"6px 16px",background:C.accentBg,border:`1px solid ${C.accentBd}`,borderRadius:7,color:C.accent,cursor:"pointer",fontSize:13,fontFamily:F,fontWeight:600 },
  btnSm:{ padding:"6px 13px",background:"transparent",border:`1px solid ${C.borderHi}`,borderRadius:7,color:C.textSub,cursor:"pointer",fontSize:13,fontFamily:F },
  btnClear:{ padding:"6px 14px",background:"transparent",border:`1px solid ${C.errBd}`,borderRadius:7,color:C.err,cursor:"pointer",fontSize:13,fontFamily:F },
  summary:{ display:"flex",alignItems:"center",gap:9,height:28 },
  sumSel:{ fontSize:16,fontWeight:700,color:C.text },
  sumDot:{ color:C.textDim },
  sumInfo:{ fontSize:15,color:C.textSub },
  sumNone:{ fontSize:14,color:C.textDim },
  toolBar:{ display:"flex",gap:9,width:"100%",maxWidth:720,flexWrap:"wrap" },
  toolBtn:{ flex:"1 1 88px",display:"flex",flexDirection:"column",alignItems:"center",gap:5,padding:"16px 8px",borderRadius:11,border:`1px solid ${C.border}`,cursor:"pointer",fontFamily:F,transition:"all 0.12s" },
  toolBtnOn:{ background:C.bgCard,borderColor:C.borderHi,color:C.text },
  toolBtnOff:{ background:"transparent",borderColor:C.border,color:C.textDim,opacity:0.38 },
  toolIcon:{ fontSize:24 },
  toolLabel:{ fontSize:14,fontWeight:700,color:"inherit" },
  toolDesc:{ fontSize:11,color:C.textSub,textAlign:"center" as const },
  dragOverlay:{ position:"absolute",inset:0,background:"rgba(12,20,14,0.88)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16,border:`2px dashed ${C.accent}`,pointerEvents:"none" },
  dragIcon:{ fontSize:56,color:C.accent },
  dragText:{ fontSize:20,fontWeight:600,color:C.accent },
  error:{ padding:"11px 22px",background:C.errBg,border:`1px solid ${C.errBd}`,borderRadius:9,color:"#ff7070",fontSize:13,maxWidth:460,textAlign:"center" as const },
};

const fr: Record<string,React.CSSProperties> = {
  row:{ display:"flex",alignItems:"center",gap:11,padding:"11px 14px",borderBottom:`1px solid ${C.border}`,background:"transparent",transition:"background 0.08s",userSelect:"none" },
  rowSel:{ background:"#192b1e" },
  rowDO:{ background:C.accentBg,borderColor:C.accent },
  rowDrag:{ opacity:0.4 },
  check:{ width:22,height:22,borderRadius:5,flexShrink:0,border:`1.5px solid ${C.borderHi}`,background:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0,transition:"all 0.1s" },
  checkOn:{ background:C.accent,borderColor:C.accent },
  checkMark:{ fontSize:13,color:"#000",fontWeight:700,lineHeight:1 },
  handle:{ fontSize:16,color:C.borderHi,cursor:"grab",flexShrink:0 },
  num:{ fontSize:13,color:C.textDim,width:22,textAlign:"center" as const,flexShrink:0 },
  info:{ flex:1,display:"flex",flexDirection:"column",gap:2,minWidth:0 },
  name:{ fontSize:15,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" },
  meta:{ fontSize:12,color:C.textSub },
  del:{ width:26,height:26,flexShrink:0,background:"transparent",border:"none",color:C.textDim,cursor:"pointer",fontSize:17,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:5,padding:0,fontFamily:F },
};

const sh: Record<string,React.CSSProperties> = {
  root:{ display:"flex",flexDirection:"column",height:"100vh",background:C.bg },
  nav:{ display:"flex",alignItems:"center",gap:4,padding:"0 14px",height:46,background:C.navBg,borderBottom:`1px solid ${C.navBd}`,flexShrink:0,fontFamily:F,overflowX:"auto" },
  homeBtn:{ background:"transparent",border:"none",cursor:"pointer",padding:"4px 8px",borderRadius:5,fontFamily:F,fontSize:15,fontWeight:700,color:C.text,whiteSpace:"nowrap" },
  div:{ width:1,height:20,background:C.border,margin:"0 3px",flexShrink:0 },
  filename:{ fontSize:12,color:C.textSub,maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flexShrink:0 },
  batchLabel:{ fontSize:12,color:C.accent,fontWeight:600,whiteSpace:"nowrap",flexShrink:0 },
  tab:{ display:"flex",alignItems:"center",gap:4,padding:"4px 9px",background:"transparent",border:"1px solid transparent",borderRadius:5,cursor:"pointer",color:C.textSub,fontFamily:F,fontSize:12,transition:"all 0.1s",whiteSpace:"nowrap",flexShrink:0 },
  tabOn:{ background:C.accentBg,borderColor:C.accentBd,color:C.accent },
  tabLabel:{ fontSize:11 },
  openBtn:{ padding:"4px 11px",background:"transparent",border:`1px solid ${C.borderHi}`,borderRadius:5,color:C.textSub,cursor:"pointer",fontFamily:F,fontSize:12,flexShrink:0 },
};
