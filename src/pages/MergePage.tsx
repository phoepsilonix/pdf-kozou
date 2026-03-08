// src/pages/MergePage.tsx
import { useState, useCallback, useEffect, useRef } from "react";
import { invoke }      from "@tauri-apps/api/core";
import { Spinner, ErrorView, ThumbCard, PageHeader, BtnBack, BtnPrimary } from "../components/common";
import { usePdfStore } from "../store/usePdfStore";
import { useSaveDialog } from "../hooks/useSaveDialog";
import { mergePdf, renderPage, getPdfInfo, type MergeResponse, type PdfInfo } from "../lib/tauri";
import { CompressPage } from "./CompressPage";
import { C, F } from "../lib/theme";

interface PdfEntry {
  id: number; path: string; filename: string;
  pageCount: number; thumbs: (string|undefined)[];
}
type Phase = "edit" | "preview" | "processing" | "result" | "error" | "compress";

let _id = 1;
const THUMB_DPI  = 60;
const PREV_DPI   = 60;

export function MergePage({ initPaths = [] }: { initPaths?: string[] }) {
  const { setError }  = usePdfStore();
  const { pickSave }  = useSaveDialog();

  const [phase,         setPhase]        = useState<Phase>("edit");
  const [entries,       setEntries]      = useState<PdfEntry[]>([]);
  const [result,        setResult]       = useState<MergeResponse | null>(null);
  const [errMsg,        setErrMsg]       = useState("");
  const [dropOver,      setDropOver]     = useState(false);
  const [dragId,        setDragId]       = useState<number|null>(null);
  const [dragOverId,    setDragOverId]   = useState<number|null>(null);
  const [previewThumbs, setPreviewThumbs]= useState<string[]>([]);
  const [savePath,      setSavePath]     = useState("");
  const [mergedInfo,    setMergedInfo]   = useState<PdfInfo|null>(null);
  const dragCounter = useRef(0);
  // initPaths を一度だけ読み込んだかフラグ
  const initLoaded = useRef(false);

  // ── initPaths: マウント時に1回だけ ──────────────────────────────────────
  useEffect(() => {
    if (initLoaded.current || initPaths.length === 0) return;
    initLoaded.current = true;
    loadPaths(initPaths);
  }, []); // 依存配列は空: マウント時のみ

  // ── ファイル追加 ─────────────────────────────────────────────────────────
  const loadPaths = useCallback(async (paths: string[]) => {
    for (const path of paths) {
      try {
        const info = await getPdfInfo(path);
        const thumbs: (string|undefined)[] = [];
        for (let i=0; i<Math.min(3, info.page_count); i++) {
          try { thumbs[i] = await renderPage(path, i, THUMB_DPI); }
          catch { thumbs[i] = undefined; }
        }
        setEntries(prev => {
          // 同じパスの重複追加を防ぐ
          if (prev.some(e => e.path === path)) return prev;
          return [...prev, {
            id: _id++, path,
            filename: path.split(/[/\\]/).pop() ?? path,
            pageCount: info.page_count, thumbs,
          }];
        });
      } catch (e) { setError(`${path}: ${e}`); }
    }
  }, [setError]);

  const pickFiles = useCallback(async () => {
    const paths = await invoke<string[]>("pick_open_files").catch(() => [] as string[]);
    if (paths.length) await loadPaths(paths);
  }, [loadPaths]);

  // ── D&D 並べ替え ─────────────────────────────────────────────────────────
  const onDragStart = useCallback((id: number) => { setDragId(id); }, []);
  const onDragEnter = useCallback((id: number) => { setDragOverId(id); }, []);
  const onDragEnd   = useCallback(() => {
    if (dragId != null && dragOverId != null && dragId !== dragOverId) {
      setEntries(prev => {
        const a = [...prev];
        const fi = a.findIndex(e => e.id === dragId);
        const ti = a.findIndex(e => e.id === dragOverId);
        if (fi < 0 || ti < 0) return prev;
        const [item] = a.splice(fi, 1);
        a.splice(ti, 0, item);
        return a;
      });
    }
    setDragId(null); setDragOverId(null);
  }, [dragId, dragOverId]);

  const moveUp   = (i: number) => setEntries(p => { if(i===0)return p; const a=[...p]; [a[i-1],a[i]]=[a[i],a[i-1]]; return a; });
  const moveDown = (i: number) => setEntries(p => { if(i>=p.length-1)return p; const a=[...p]; [a[i],a[i+1]]=[a[i+1],a[i]]; return a; });
  const remove   = (id: number) => setEntries(p => p.filter(e => e.id !== id));

  // ── プレビュー ────────────────────────────────────────────────────────────
  const handlePreview = useCallback(async () => {
    if (entries.length < 2) return;
    setPhase("preview");
    const all: string[] = [];
    for (const e of entries) {
      for (let i=0; i<e.pageCount; i++) {
        try { all.push(await renderPage(e.path, i, PREV_DPI)); }
        catch { all.push(""); }
      }
    }
    setPreviewThumbs(all);
  }, [entries]);

  // ── 保存 ─────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const sp = await pickSave("merged.pdf");
    if (!sp) return;
    setSavePath(sp);
    setPhase("processing");
    try {
      const res = await mergePdf(entries.map(e => e.path), sp);
      setResult(res);
      // 続けて圧縮用にPdfInfoを生成
      setMergedInfo({ page_count: res.page_count, pages: Array.from({length:res.page_count},()=>({w:595,h:842})) });
      setPhase("result");
    } catch (e) {
      setErrMsg(String(e)); setPhase("error"); setError(String(e));
    }
  }, [entries, pickSave, setError]);

  const totalPages = entries.reduce((s,e) => s + e.pageCount, 0);

  if (phase==="processing") return <Spinner label="結合処理中…" />;
  if (phase==="error")      return <ErrorView msg={errMsg} onBack={()=>{setPhase("edit");setErrMsg("");}}/>;

  // 続けて圧縮
  if (phase==="compress" && savePath && mergedInfo) return (
    <CompressPage
      filePath={savePath}
      pdfInfo={mergedInfo}
      sourceFile={savePath}
      onDone={()=>setPhase("result")}
    />
  );

  // ── 結果 ─────────────────────────────────────────────────────────────────
  if (phase==="result" && result) {
    const mb = (result.output_bytes/1048576).toFixed(2);
    return (
      <div style={s.root}>
        <PageHeader>
          <BtnBack onClick={()=>{setPhase("edit");setResult(null);}} />
          <span style={s.title}>結合完了</span>
        </PageHeader>
        <div style={s.resultBody}>
          <div style={s.resultIcon}>✓</div>
          <div style={s.resultStat}>{result.page_count}ページ / {mb} MB</div>
          <div style={s.resultSub}>{savePath.split(/[/\\]/).pop()}</div>
          <div style={s.resultDetail}>{entries.length}ファイルを結合しました</div>
          <button style={s.compressBtn} onClick={()=>setPhase("compress")}>
            ⊙ 続けて圧縮する
          </button>
        </div>
      </div>
    );
  }

  // ── プレビュー確認（全ページを1ペインに統合） ──────────────────────────
  if (phase==="preview") {
    // 全サムネイルをフラットに表示（区切り線でファイル境界を示す）
    let globalIdx = 0;
    const segments: { label: string; pages: { b64: string; globalNum: number; localNum: number }[] }[] = [];
    for (const entry of entries) {
      const pages = [];
      for (let i=0; i<entry.pageCount; i++) {
        pages.push({ b64: previewThumbs[globalIdx] ?? "", globalNum: globalIdx+1, localNum: i+1 });
        globalIdx++;
      }
      segments.push({ label: entry.filename, pages });
    }
    return (
      <div style={s.root}>
        <PageHeader>
          <BtnBack onClick={()=>setPhase("edit")} />
          <span style={s.title}>結合プレビュー</span>
          <span style={s.sub}>合計 {totalPages}ページ → 1ファイル</span>
          <div style={{flex:1}}/>
          <BtnPrimary onClick={handleSave}>💾 この内容で保存</BtnPrimary>
        </PageHeader>

        {/* 統合プレビュー: ファイル区切りを帯で表示 */}
        <div style={s.previewBody}>
          {segments.map((seg, si) => (
            <div key={si}>
              {/* ファイル区切り帯 */}
              <div style={s.segDivider}>
                <div style={s.segLine}/>
                <span style={s.segLabel}>
                  {si+1}. {seg.label}
                  <span style={s.segPageCount}> ({seg.pages.length}ページ)</span>
                </span>
                <div style={s.segLine}/>
              </div>
              {/* サムネイル行 */}
              <div style={s.previewThumbs}>
                {seg.pages.map(p => (
                  <div key={p.globalNum} style={s.prevThumbWrap}>
                    <ThumbCard b64={p.b64||undefined} pageNum={p.globalNum} width={90} />
                    <span style={s.prevLocalNum}>元{p.localNum}p</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div style={s.previewFooter}>
          <BtnBack onClick={()=>setPhase("edit")} />
          <BtnPrimary onClick={handleSave}>💾 保存</BtnPrimary>
        </div>
      </div>
    );
  }

  // ── 編集画面 ─────────────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>PDFを結合</span>
        {entries.length > 0 && <>
          <span style={s.sub}>{entries.length}ファイル · 合計 {totalPages}ページ</span>
          <div style={{flex:1}}/>
          <button style={s.btnClear} onClick={()=>setEntries([])}>クリア</button>
        </>}
        {entries.length === 0 && <div style={{flex:1}}/>}
      </PageHeader>

      <div style={s.body}>
        {entries.length === 0 ? (
          <div style={{...s.dropZone,...(dropOver?s.dropZoneOn:{})}}
            onDragOver={e=>e.preventDefault()}
            onDragEnter={e=>{e.preventDefault();dragCounter.current++;setDropOver(true);}}
            onDragLeave={()=>{if(--dragCounter.current<=0){setDropOver(false);dragCounter.current=0;}}}
            onDrop={e=>{e.preventDefault();setDropOver(false);dragCounter.current=0;
              const ps=Array.from(e.dataTransfer.files).filter(f=>f.name.endsWith(".pdf")).map(f=>(f as any).path as string).filter(Boolean);
              if(ps.length) loadPaths(ps);}}>
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
                  onDragStart={e=>{e.dataTransfer.setData("mergeId",String(entry.id));onDragStart(entry.id);}}
                  onDragEnter={()=>onDragEnter(entry.id)}
                  onDragEnd={onDragEnd}
                  onDragOver={e=>e.preventDefault()}
                  style={{...s.listItem,
                    ...(dragId===entry.id?s.itemDragging:{}),
                    ...(dragOverId===entry.id&&dragId!==entry.id?s.itemTarget:{}),
                  }}>
                  <span style={s.itemSeq}>{i+1}</span>
                  <span style={s.handle}>⣿</span>
                  <div style={s.itemThumbs}>
                    {entry.thumbs.slice(0,3).map((b64,ti) => (
                      <ThumbCard key={ti} b64={b64} pageNum={ti+1} width={56} />
                    ))}
                    {entry.pageCount > 3 && (
                      <div style={s.thumbMore}>+{entry.pageCount-3}</div>
                    )}
                  </div>
                  <div style={s.itemInfo}>
                    <span style={s.itemName} title={entry.path}>{entry.filename}</span>
                    <span style={s.itemPages}>{entry.pageCount}ページ</span>
                  </div>
                  <div style={s.moveBtns}>
                    <button style={s.moveBtn} onClick={()=>moveUp(i)}   disabled={i===0} title="上へ">↑</button>
                    <button style={s.moveBtn} onClick={()=>moveDown(i)} disabled={i===entries.length-1} title="下へ">↓</button>
                  </div>
                  <button style={s.delBtn} onClick={()=>remove(entry.id)} title="削除">✕</button>
                </div>
              ))}

              <div style={{...s.addZone,...(dropOver?s.addZoneOn:{})}}
                onDragOver={e=>e.preventDefault()}
                onDragEnter={e=>{e.preventDefault();dragCounter.current++;setDropOver(true);}}
                onDragLeave={()=>{if(--dragCounter.current<=0){setDropOver(false);dragCounter.current=0;}}}
                onDrop={e=>{e.preventDefault();setDropOver(false);dragCounter.current=0;
                  const ps=Array.from(e.dataTransfer.files).filter(f=>f.name.endsWith(".pdf")).map(f=>(f as any).path as string).filter(Boolean);
                  if(ps.length) loadPaths(ps);}}>
                <button style={s.btnAdd} onClick={pickFiles}>＋ PDFを追加</button>
                <span style={s.addHint}>ここにドロップしても追加できます</span>
              </div>
            </div>

            <div style={s.execArea}>
              <div style={s.summaryRow}>
                <span style={s.sumFile}>{entries.length}ファイル</span>
                <span style={s.sumDot}>·</span>
                <span style={s.sumPages}>合計 {totalPages}ページ</span>
                <span style={s.sumArrow}>→</span>
                <span style={s.sumOut}>1ファイル</span>
              </div>
              <div style={s.execBtns}>
                <button style={{...s.btnPreview,...(entries.length<2?s.btnDis:{})}}
                  onClick={handlePreview} disabled={entries.length<2}>
                  👁 プレビュー確認
                </button>
                <BtnPrimary onClick={handleSave} disabled={entries.length<2}>
                  ⊕ 結合して保存
                </BtnPrimary>
              </div>
              {entries.length < 2 && <span style={s.execHint}>2ファイル以上必要です</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root:{ display:"flex",flexDirection:"column",height:"100%",background:C.bg,color:C.text,fontFamily:F,overflow:"hidden" },
  title:{ fontSize:17,fontWeight:700,color:C.text },
  sub:{ fontSize:14,color:C.textSub },
  btnClear:{ padding:"5px 14px",background:"transparent",border:`1px solid ${C.errBd}`,borderRadius:6,color:"#aa4040",cursor:"pointer",fontSize:12,fontFamily:F },

  body:{ flex:1,display:"flex",overflow:"hidden" },
  dropZone:{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14,margin:20,borderRadius:12,border:`2px dashed ${C.border}`,background:C.bgCard,transition:"all 0.15s" },
  dropZoneOn:{ borderColor:C.accent,background:C.accentBg },
  dropIcon:{ fontSize:48,color:C.borderHi },
  dropTitle:{ fontSize:19,fontWeight:600,color:C.textSub },
  dropSub:{ fontSize:13,color:C.textDim },
  btnAddBig:{ padding:"12px 32px",background:C.accentBg,border:`1px solid ${C.accentBd}`,borderRadius:9,color:C.accent,fontWeight:700,cursor:"pointer",fontSize:16,fontFamily:F },

  listArea:{ flex:1,display:"flex",flexDirection:"column",padding:"14px 18px",gap:0,overflow:"hidden" },
  list:{ flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:7,paddingBottom:7 },
  listItem:{ display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:9,cursor:"grab",transition:"all 0.1s",userSelect:"none" },
  itemDragging:{ opacity:0.3,transform:"scale(0.97)" },
  itemTarget:{ borderColor:C.accent,background:C.accentBg,transform:"translateY(-2px)" },
  itemSeq:{ fontSize:13,fontWeight:700,color:C.textDim,width:22,textAlign:"center" as const,flexShrink:0 },
  handle:{ fontSize:17,color:C.borderHi,cursor:"grab",flexShrink:0 },
  itemThumbs:{ display:"flex",gap:4,flexShrink:0 },
  thumbMore:{ width:56,height:79,display:"flex",alignItems:"center",justifyContent:"center",background:C.border,borderRadius:4,fontSize:11,color:C.textSub },
  itemInfo:{ flex:1,display:"flex",flexDirection:"column",gap:3,minWidth:0 },
  itemName:{ fontSize:14,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" },
  itemPages:{ fontSize:12,color:C.textSub },
  moveBtns:{ display:"flex",flexDirection:"column",gap:3,flexShrink:0 },
  moveBtn:{ width:30,height:26,display:"flex",alignItems:"center",justifyContent:"center",background:C.bgCard,border:`1px solid ${C.borderHi}`,borderRadius:5,color:C.textSub,cursor:"pointer",fontSize:13,fontFamily:F },
  delBtn:{ width:26,height:26,display:"flex",alignItems:"center",justifyContent:"center",background:"transparent",border:"none",color:C.textDim,cursor:"pointer",fontSize:14,fontFamily:F,flexShrink:0 },
  addZone:{ display:"flex",alignItems:"center",gap:12,padding:"11px 12px",borderRadius:8,border:`1px dashed ${C.border}`,transition:"all 0.12s" },
  addZoneOn:{ borderColor:C.accent,background:C.accentBg },
  btnAdd:{ padding:"7px 16px",background:"transparent",border:`1px solid ${C.borderHi}`,borderRadius:6,color:C.textSub,cursor:"pointer",fontSize:12,fontFamily:F,flexShrink:0 },
  addHint:{ fontSize:11,color:C.textDim },

  execArea:{ flexShrink:0,paddingTop:12,display:"flex",flexDirection:"column",gap:9,borderTop:`1px solid ${C.border}` },
  summaryRow:{ display:"flex",alignItems:"center",gap:9,justifyContent:"center" },
  sumFile:{ fontSize:16,fontWeight:700,color:C.text },
  sumDot:{ color:C.textDim },
  sumPages:{ fontSize:14,color:C.textSub },
  sumArrow:{ fontSize:16,color:C.textDim },
  sumOut:{ fontSize:16,fontWeight:700,color:C.accent },
  execBtns:{ display:"flex",gap:9,justifyContent:"center" },
  btnPreview:{ padding:"12px 26px",background:C.bgCard,border:`1px solid ${C.borderHi}`,borderRadius:8,color:C.text,fontWeight:600,cursor:"pointer",fontSize:15,fontFamily:F },
  btnDis:{ opacity:0.35,cursor:"not-allowed" },
  execHint:{ textAlign:"center" as const,fontSize:13,color:C.textDim },

  // プレビュー
  previewBody:{ flex:1,overflowY:"auto",padding:"0 18px 16px" },
  segDivider:{ display:"flex",alignItems:"center",gap:10,padding:"14px 0 8px" },
  segLine:{ flex:1,height:1,background:C.border },
  segLabel:{ fontSize:14,fontWeight:700,color:C.accent,whiteSpace:"nowrap" },
  segPageCount:{ fontSize:11,color:C.textSub,fontWeight:400 },
  previewThumbs:{ display:"flex",flexWrap:"wrap" as const,gap:8,paddingBottom:4 },
  prevThumbWrap:{ display:"flex",flexDirection:"column",alignItems:"center",gap:3 },
  prevLocalNum:{ fontSize:9,color:C.textDim },
  previewFooter:{ flexShrink:0,display:"flex",justifyContent:"space-between",padding:"10px 18px",borderTop:`1px solid ${C.border}` },

  resultBody:{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12 },
  resultIcon:{ fontSize:52,color:C.green },
  resultStat:{ fontSize:22,fontWeight:700,color:C.text },
  resultSub:{ fontSize:15,color:C.textSub },
  resultDetail:{ fontSize:12,color:C.textDim },
  compressBtn: { padding:"12px 32px", background:C.accentBg, border:`1px solid ${C.accentBd}`, borderRadius:9, color:C.accent, fontWeight:600, cursor:"pointer", fontSize:15, fontFamily:F },
};
