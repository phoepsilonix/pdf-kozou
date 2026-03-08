// src/pages/MergePage.tsx

import { useState, useCallback, useEffect, useRef } from "react";
import { invoke }        from "@tauri-apps/api/core";
import { Spinner, ErrorView, ThumbCard, PageHeader, BtnBack, BtnPrimary } from "../components/common";
import { usePdfStore }   from "../store/usePdfStore";
import { useSaveDialog } from "../hooks/useSaveDialog";
import { mergePdf, renderPage, getPdfInfo, type MergeResponse } from "../lib/tauri";
import { C, F } from "../lib/theme";

interface PdfEntry {
  id:        number;
  path:      string;
  filename:  string;
  pageCount: number;
  thumbs:    (string|undefined)[];  // 先頭3枚
}

type Phase = "edit" | "preview" | "processing" | "result" | "error";

let _id = 1;
const THUMB_DPI = 48;

export function MergePage({ initPaths = [] }: { initPaths?: string[] }) {
  const { setError } = usePdfStore();
  const { pickSave } = useSaveDialog();

  const [phase,      setPhase]     = useState<Phase>("edit");
  const [entries,    setEntries]   = useState<PdfEntry[]>([]);
  const [result,     setResult]    = useState<MergeResponse | null>(null);
  const [errMsg,     setErrMsg]    = useState("");
  const [dropOver,   setDropOver]  = useState(false);
  const [dragId,     setDragId]    = useState<number|null>(null);
  const [dragOverId, setDragOverId]= useState<number|null>(null);
  const [previewThumbs, setPreviewThumbs] = useState<string[]>([]);
  const [savePath,   setSavePath]  = useState("");
  const dragCounter = useRef(0);

  // initPaths が渡された場合はマウント時に読み込む
  useEffect(() => {
    if (initPaths.length > 0) addFiles(initPaths);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ファイル追加
  const addFiles = useCallback(async (paths: string[]) => {
    for (const path of paths) {
      try {
        const info = await getPdfInfo(path);
        const thumbs: (string|undefined)[] = [];
        // 先頭最大3ページのサムネイルを取得
        for (let i=0; i<Math.min(3, info.page_count); i++) {
          try { thumbs[i] = await renderPage(path, i, THUMB_DPI); }
          catch { thumbs[i] = undefined; }
        }
        setEntries(prev => [...prev, {
          id: _id++, path,
          filename: path.split(/[/\\]/).pop() ?? path,
          pageCount: info.page_count, thumbs,
        }]);
      } catch (e) { setError(`${path}: ${e}`); }
    }
  }, [setError]);

  const pickFiles = useCallback(async () => {
    const paths = await invoke<string[]>("pick_open_files").catch(() => [] as string[]);
    if (paths.length) await addFiles(paths);
  }, [addFiles]);

  // ドラッグ並べ替え
  const onDragStart = (id: number) => setDragId(id);
  const onDragEnter = (id: number) => setDragOverId(id);
  const onDragEnd   = () => {
    if (dragId != null && dragOverId != null && dragId !== dragOverId) {
      setEntries(prev => {
        const a=[...prev];
        const fi=a.findIndex(e=>e.id===dragId), ti=a.findIndex(e=>e.id===dragOverId);
        const [item]=a.splice(fi,1); a.splice(ti,0,item); return a;
      });
    }
    setDragId(null); setDragOverId(null);
  };

  const moveUp   = (i:number) => { if(i===0) return; setEntries(p=>{ const a=[...p]; [a[i-1],a[i]]=[a[i],a[i-1]]; return a; }); };
  const moveDown = (i:number) => setEntries(p=>{ if(i>=p.length-1) return p; const a=[...p]; [a[i],a[i+1]]=[a[i+1],a[i]]; return a; });
  const remove   = (id:number) => setEntries(p=>p.filter(e=>e.id!==id));

  // プレビュー確認画面へ
  const handlePreview = useCallback(async () => {
    if (entries.length < 2) return;
    setPhase("preview");
    // 全ファイルの全ページサムネイルを収集
    const allThumbs: string[] = [];
    for (const e of entries) {
      for (let i=0; i<e.pageCount; i++) {
        try {
          const b64 = await renderPage(e.path, i, THUMB_DPI);
          allThumbs.push(b64);
        } catch { allThumbs.push(""); }
      }
    }
    setPreviewThumbs(allThumbs);
  }, [entries]);

  // 保存実行
  const handleSave = useCallback(async () => {
    const sp = await pickSave("merged.pdf");
    if (!sp) return;
    setSavePath(sp);
    setPhase("processing");
    try {
      const res = await mergePdf(entries.map(e=>e.path), sp);
      setResult(res);
      setPhase("result");
    } catch (e) {
      setErrMsg(String(e)); setPhase("error"); setError(String(e));
    }
  }, [entries, pickSave, setError]);

  const totalPages = entries.reduce((s,e)=>s+e.pageCount, 0);

  if (phase === "processing") return <Spinner label="結合処理中…" />;
  if (phase === "error")      return <ErrorView msg={errMsg} onBack={()=>{setPhase("edit");setErrMsg("");}}/>;

  // 結果
  if (phase === "result" && result) {
    const mb = (result.output_bytes/1048576).toFixed(2);
    return (
      <div style={s.root}>
        <PageHeader>
          <BtnBack onClick={()=>{setPhase("edit");setResult(null);}} />
          <span style={s.title}>結合完了</span>
        </PageHeader>
        <div style={s.resultBody}>
          <div style={s.resultIcon}>✓</div>
          <div style={s.resultStat}>{result.page_count} ページ / {mb} MB</div>
          <div style={s.resultSub}>{savePath.split(/[/\\]/).pop()}</div>
          <div style={s.resultDetail}>{entries.length} ファイルを結合しました</div>
        </div>
      </div>
    );
  }

  // プレビュー確認
  if (phase === "preview") {
    let pageIdx = 0;
    return (
      <div style={s.root}>
        <PageHeader>
          <BtnBack onClick={()=>setPhase("edit")} />
          <span style={s.title}>結合プレビュー確認</span>
          <span style={s.sub}>合計 {totalPages} ページ</span>
          <div style={{flex:1}}/>
          <BtnPrimary onClick={handleSave}>💾 この内容で保存</BtnPrimary>
        </PageHeader>
        <div style={s.previewBody}>
          {entries.map(entry => {
            const pages = Array.from({length:entry.pageCount}, (_,i) => ({
              b64: previewThumbs[pageIdx+i],
              num: pageIdx+i+1,
            }));
            pageIdx += entry.pageCount;
            return (
              <div key={entry.id} style={s.previewGroup}>
                <div style={s.previewGroupLabel}>
                  <span style={s.previewGroupName}>{entry.filename}</span>
                  <span style={s.previewGroupPages}>{entry.pageCount}ページ</span>
                </div>
                <div style={s.previewThumbs}>
                  {pages.map(p => (
                    <ThumbCard key={p.num} b64={p.b64} pageNum={p.num} width={76} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div style={s.previewFooter}>
          <BtnBack onClick={()=>setPhase("edit")} />
          <BtnPrimary onClick={handleSave}>💾 保存</BtnPrimary>
        </div>
      </div>
    );
  }

  // 設定画面
  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>PDFを結合</span>
        {entries.length > 0 && <>
          <span style={s.sub}>{entries.length} ファイル · 合計 {totalPages} ページ</span>
          <div style={{flex:1}}/>
          <button style={s.btnClear} onClick={()=>setEntries([])}>クリア</button>
        </>}
        {entries.length === 0 && <div style={{flex:1}}/>}
      </PageHeader>

      <div style={s.body}>
        {entries.length === 0 ? (
          // 空状態: 大きなドロップゾーン
          <div
            style={{...s.dropZone, ...(dropOver ? s.dropZoneOn : {})}}
            onDragOver={e=>{ e.preventDefault(); }}
            onDragEnter={e=>{ e.preventDefault(); dragCounter.current++; setDropOver(true); }}
            onDragLeave={()=>{ dragCounter.current--; if(dragCounter.current<=0){ setDropOver(false); dragCounter.current=0; } }}
            onDrop={e=>{ e.preventDefault(); setDropOver(false); dragCounter.current=0;
              const paths=Array.from(e.dataTransfer.files).filter(f=>f.name.endsWith(".pdf")).map(f=>(f as any).path as string).filter(Boolean);
              if(paths.length) addFiles(paths);
            }}
          >
            <span style={s.dropIcon}>⊕</span>
            <span style={s.dropTitle}>PDFをここにドロップ</span>
            <span style={s.dropSub}>複数ファイルを一度に追加できます</span>
            <button style={s.btnAddBig} onClick={pickFiles}>ファイルを選択…</button>
          </div>
        ) : (
          <div style={s.listArea}>
            <div style={s.list}>
              {entries.map((entry, i) => (
                <div key={entry.id}
                  draggable
                  onDragStart={()=>onDragStart(entry.id)}
                  onDragEnter={()=>onDragEnter(entry.id)}
                  onDragEnd={onDragEnd}
                  onDragOver={e=>e.preventDefault()}
                  style={{
                    ...s.listItem,
                    ...(dragId===entry.id   ? s.itemDragging : {}),
                    ...(dragOverId===entry.id && dragId!==entry.id ? s.itemTarget : {}),
                  }}
                >
                  {/* 順番 */}
                  <span style={s.itemSeq}>{i+1}</span>

                  {/* ドラッグハンドル */}
                  <span style={s.handle} title="ドラッグで並べ替え">⣿</span>

                  {/* サムネイル3枚 */}
                  <div style={s.itemThumbs}>
                    {entry.thumbs.slice(0,3).map((b64,ti) => (
                      <ThumbCard key={ti} b64={b64} pageNum={ti+1} width={48} />
                    ))}
                    {entry.pageCount > 3 && (
                      <div style={s.thumbMore}>+{entry.pageCount-3}</div>
                    )}
                  </div>

                  {/* ファイル情報 */}
                  <div style={s.itemInfo}>
                    <span style={s.itemName} title={entry.path}>{entry.filename}</span>
                    <span style={s.itemPages}>{entry.pageCount} ページ</span>
                  </div>

                  {/* 上下ボタン */}
                  <div style={s.moveBtns}>
                    <button style={s.moveBtn} onClick={()=>moveUp(i)}   disabled={i===0}>↑</button>
                    <button style={s.moveBtn} onClick={()=>moveDown(i)} disabled={i===entries.length-1}>↓</button>
                  </div>

                  <button style={s.delBtn} onClick={()=>remove(entry.id)} title="削除">✕</button>
                </div>
              ))}

              {/* 追加ゾーン */}
              <div
                style={{...s.addZone, ...(dropOver ? s.addZoneOn : {})}}
                onDragOver={e=>{ e.preventDefault(); }}
                onDragEnter={e=>{ e.preventDefault(); dragCounter.current++; setDropOver(true); }}
                onDragLeave={()=>{ dragCounter.current--; if(dragCounter.current<=0){ setDropOver(false); dragCounter.current=0; } }}
                onDrop={e=>{ e.preventDefault(); setDropOver(false); dragCounter.current=0;
                  const paths=Array.from(e.dataTransfer.files).filter(f=>f.name.endsWith(".pdf")).map(f=>(f as any).path as string).filter(Boolean);
                  if(paths.length) addFiles(paths);
                }}
              >
                <button style={s.btnAdd} onClick={pickFiles}>＋ PDFを追加</button>
                <span style={s.addHint}>ここにドロップしても追加できます</span>
              </div>
            </div>

            {/* 実行エリア */}
            <div style={s.execArea}>
              <div style={s.summaryRow}>
                <span style={s.sumFile}>{entries.length} ファイル</span>
                <span style={s.sumDot}>·</span>
                <span style={s.sumPages}>合計 {totalPages} ページ</span>
                <span style={s.sumArrow}>→</span>
                <span style={s.sumOut}>1 ファイル</span>
              </div>
              <div style={s.execBtns}>
                <button style={{...s.btnPreview, ...(entries.length<2 ? s.btnDis:{})}}
                  onClick={handlePreview} disabled={entries.length<2}>
                  👁 プレビュー確認
                </button>
                <BtnPrimary onClick={handleSave} disabled={entries.length<2}>
                  ⊕ 結合して保存
                </BtnPrimary>
              </div>
              {entries.length < 2 && (
                <span style={s.execHint}>2ファイル以上必要です</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root:   {display:"flex",flexDirection:"column",height:"100%",background:C.bg,color:C.text,fontFamily:F,overflow:"hidden"},
  title:  {fontSize:16,fontWeight:700,color:C.text},
  sub:    {fontSize:13,color:C.textSub},
  btnClear:{padding:"6px 16px",background:"transparent",border:`1px solid ${C.errBd}`,borderRadius:7,color:"#aa4040",cursor:"pointer",fontSize:13,fontFamily:F},

  body:    {flex:1,display:"flex",overflow:"hidden"},

  dropZone:   {flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16,margin:24,borderRadius:14,border:`2px dashed ${C.border}`,background:C.bgCard,transition:"all 0.15s"},
  dropZoneOn: {borderColor:C.accent,background:C.accentBg},
  dropIcon:   {fontSize:52,color:C.borderHi},
  dropTitle:  {fontSize:18,fontWeight:600,color:C.textSub},
  dropSub:    {fontSize:13,color:C.textDim},
  btnAddBig:  {padding:"12px 32px",background:C.accentBg,border:`1px solid ${C.accentBd}`,borderRadius:9,color:C.accent,fontWeight:700,cursor:"pointer",fontSize:15,fontFamily:F},

  listArea:  {flex:1,display:"flex",flexDirection:"column",padding:"16px 20px",gap:0,overflow:"hidden"},
  list:      {flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:8,paddingBottom:8},

  listItem:   {display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:10,cursor:"grab",transition:"all 0.1s",userSelect:"none"},
  itemDragging:{opacity:0.35,transform:"scale(0.97)"},
  itemTarget: {borderColor:C.accent,background:C.accentBg,transform:"translateY(-3px)"},

  itemSeq:   {fontSize:14,fontWeight:700,color:C.textDim,width:24,textAlign:"center",flexShrink:0},
  handle:    {fontSize:18,color:C.borderHi,cursor:"grab",flexShrink:0},
  itemThumbs:{display:"flex",gap:4,flexShrink:0},
  thumbMore: {width:48,height:68,display:"flex",alignItems:"center",justifyContent:"center",background:C.border,borderRadius:4,fontSize:12,color:C.textSub},
  itemInfo:  {flex:1,display:"flex",flexDirection:"column",gap:3,minWidth:0},
  itemName:  {fontSize:14,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"},
  itemPages: {fontSize:12,color:C.textSub},

  moveBtns:  {display:"flex",flexDirection:"column",gap:4,flexShrink:0},
  moveBtn:   {width:32,height:28,display:"flex",alignItems:"center",justifyContent:"center",background:C.bgCard,border:`1px solid ${C.borderHi}`,borderRadius:5,color:C.textSub,cursor:"pointer",fontSize:14,fontFamily:F},
  delBtn:    {width:28,height:28,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:"none",color:C.textDim,cursor:"pointer",fontSize:15,fontFamily:F,flexShrink:0},

  addZone:   {display:"flex",alignItems:"center",gap:14,padding:"12px 14px",borderRadius:9,border:`1px dashed ${C.border}`,transition:"all 0.12s"},
  addZoneOn: {borderColor:C.accent,background:C.accentBg},
  btnAdd:    {padding:"8px 18px",background:"transparent",border:`1px solid ${C.borderHi}`,borderRadius:7,color:C.textSub,cursor:"pointer",fontSize:13,fontFamily:F,flexShrink:0},
  addHint:   {fontSize:12,color:C.textDim},

  execArea:   {flexShrink:0,paddingTop:14,display:"flex",flexDirection:"column",gap:10,borderTop:`1px solid ${C.border}`},
  summaryRow: {display:"flex",alignItems:"center",gap:10,justifyContent:"center"},
  sumFile:    {fontSize:15,fontWeight:700,color:C.text},
  sumDot:     {color:C.textDim},
  sumPages:   {fontSize:14,color:C.textSub},
  sumArrow:   {fontSize:18,color:C.textDim},
  sumOut:     {fontSize:15,fontWeight:700,color:C.accent},
  execBtns:   {display:"flex",gap:10,justifyContent:"center"},
  btnPreview: {padding:"11px 24px",background:C.bgCard,border:`1px solid ${C.borderHi}`,borderRadius:8,color:C.text,fontWeight:600,cursor:"pointer",fontSize:14,fontFamily:F},
  btnDis:     {opacity:0.35,cursor:"not-allowed"},
  execHint:   {textAlign:"center",fontSize:12,color:C.textDim},

  // プレビュー
  previewBody:       {flex:1,overflowY:"auto",padding:"16px 20px",display:"flex",flexDirection:"column",gap:14},
  previewGroup:      {background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden"},
  previewGroupLabel: {display:"flex",alignItems:"center",gap:10,padding:"10px 16px",borderBottom:`1px solid ${C.border}`,background:C.bg},
  previewGroupName:  {fontSize:14,fontWeight:600,color:C.text,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"},
  previewGroupPages: {fontSize:12,color:C.textSub},
  previewThumbs:     {display:"flex",flexWrap:"wrap",gap:6,padding:"12px 14px"},
  previewFooter:     {flexShrink:0,display:"flex",justifyContent:"space-between",padding:"12px 20px",borderTop:`1px solid ${C.border}`},

  // 結果
  resultBody:  {flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14},
  resultIcon:  {fontSize:56,color:C.green},
  resultStat:  {fontSize:22,fontWeight:700,color:C.text},
  resultSub:   {fontSize:15,color:C.textSub},
  resultDetail:{fontSize:13,color:C.textDim},
};
