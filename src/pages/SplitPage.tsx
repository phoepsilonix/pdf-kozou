// src/pages/SplitPage.tsx  —  単体 & バッチ対応

import { useEffect, useState, useCallback } from "react";
import { invoke }   from "@tauri-apps/api/core";
import { Spinner, ErrorView, ThumbCard, PageHeader, BtnBack, BtnPrimary } from "../components/common";
import { usePdfStore, type FileEntry } from "../store/usePdfStore";
import { renderPage, splitPdf, getPdfInfo, type SplitMode, type SplitResponse, type PdfInfo } from "../lib/tauri";
import { C, F } from "../lib/theme";

// ── 型 ───────────────────────────────────────────────────────────────────────

interface Props {
  filePath:    string;
  pdfInfo:     PdfInfo;
  batchFiles?: FileEntry[];   // バッチ時: 選択ファイル一覧
}

type Phase  = "edit" | "processing" | "result" | "error";
type ModeId = "all" | "every" | "ranges";

const THUMB_DPI = 52;

// バッチ実行の進捗
interface BatchProgress {
  current: number;
  total:   number;
  currentFile: string;
  done:    { file: string; count: number }[];
  errors:  { file: string; msg: string }[];
}

// ── コンポーネント ────────────────────────────────────────────────────────────

export function SplitPage({ filePath, pdfInfo, batchFiles }: Props) {
  const { setError } = usePdfStore();
  const isBatch = (batchFiles?.length ?? 0) > 1;

  // 現在表示中のファイル（バッチの場合はプレビュー用に切り替え可能）
  const [previewIdx, setPreviewIdx] = useState(0);
  const previewFile = isBatch ? (batchFiles![previewIdx]) : null;
  const previewPath = isBatch ? previewFile!.path : filePath;
  const total       = isBatch ? (previewFile?.pageCount ?? 1) : pdfInfo.page_count;

  const [phase,    setPhase]    = useState<Phase>("edit");
  const [modeId,   setModeId]   = useState<ModeId>("all");
  const [everyN,   setEveryN]   = useState(2);
  const [ranges,   setRanges]   = useState<[number,number][]>([[1, pdfInfo.page_count]]);
  const [outDir,   setOutDir]   = useState("");
  const [prefix,   setPrefix]   = useState("page");
  const [thumbs,   setThumbs]   = useState<(string|undefined)[]>([]);
  const [result,   setResult]   = useState<SplitResponse | null>(null);
  const [errMsg,   setErrMsg]   = useState("");

  // バッチ用
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  // バッチ各ファイルの先頭サムネイル
  const [batchThumbs, setBatchThumbs] = useState<(string|undefined)[]>([]);

  // ── サムネイル取得（プレビュー対象ファイル） ─────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setThumbs([]);
    (async () => {
      const info = isBatch
        ? await getPdfInfo(previewPath).catch(() => null)
        : pdfInfo;
      const n = info?.page_count ?? 0;
      for (let i = 0; i < n; i++) {
        try {
          const b64 = await renderPage(previewPath, i, THUMB_DPI);
          if (cancelled) return;
          setThumbs(p => { const a=[...p]; a[i]=b64; return a; });
        } catch { /* skip */ }
      }
    })();
    return () => { cancelled = true; };
  }, [previewPath, isBatch]);

  // ── バッチ用: 各ファイルの先頭ページサムネイル ──────────────────────────
  useEffect(() => {
    if (!isBatch || !batchFiles) return;
    let cancelled = false;
    setBatchThumbs(new Array(batchFiles.length).fill(undefined));
    (async () => {
      for (let i = 0; i < batchFiles.length; i++) {
        try {
          const b64 = await renderPage(batchFiles[i].path, 0, THUMB_DPI);
          if (cancelled) return;
          setBatchThumbs(p => { const a=[...p]; a[i]=b64; return a; });
        } catch { /* skip */ }
      }
    })();
    return () => { cancelled = true; };
  }, [isBatch, batchFiles]);

  const pickDir = useCallback(async () => {
    const dir = await invoke<string|null>("pick_output_dir").catch(() => null);
    if (dir) setOutDir(dir);
  }, []);

  // ── 実行（単体）────────────────────────────────────────────────────────────
  const handleExecuteSingle = useCallback(async () => {
    if (!outDir) { await pickDir(); return; }
    setPhase("processing");
    try {
      const mode: SplitMode =
        modeId === "all"   ? { type:"AllPages" } :
        modeId === "every" ? { type:"EveryN", n: everyN } :
                             { type:"Ranges", ranges };
      const res = await splitPdf(filePath, outDir, mode, prefix || undefined);
      setResult(res);
      setPhase("result");
    } catch (e) {
      setErrMsg(String(e)); setPhase("error"); setError(String(e));
    }
  }, [filePath, outDir, modeId, everyN, ranges, prefix, pickDir, setError]);

  // ── 実行（バッチ）──────────────────────────────────────────────────────────
  const handleExecuteBatch = useCallback(async () => {
    if (!outDir) { await pickDir(); return; }
    const files = batchFiles!;
    setPhase("processing");
    const progress: BatchProgress = {
      current: 0, total: files.length,
      currentFile: "", done: [], errors: [],
    };
    setBatchProgress({ ...progress });

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      progress.current   = i + 1;
      progress.currentFile = f.filename;
      setBatchProgress({ ...progress });
      try {
        const info = await getPdfInfo(f.path);
        const mode: SplitMode =
          modeId === "all"   ? { type:"AllPages" } :
          modeId === "every" ? { type:"EveryN", n: everyN } :
                               { type:"Ranges", ranges: [[1, info.page_count]] };
        const filePrefix = prefix ? `${prefix}_${f.filename.replace(/\.pdf$/i,"")}` : f.filename.replace(/\.pdf$/i,"");
        const res = await splitPdf(f.path, outDir, mode, filePrefix);
        progress.done.push({ file: f.filename, count: res.files.length });
      } catch (e) {
        progress.errors.push({ file: f.filename, msg: String(e) });
      }
      setBatchProgress({ ...progress });
    }
    setPhase("result");
  }, [batchFiles, outDir, modeId, everyN, ranges, prefix, pickDir]);

  // ── グループプレビュー計算 ────────────────────────────────────────────────
  const groups: number[][] = (() => {
    if (modeId === "all")   return Array.from({length:total}, (_, i) => [i]);
    if (modeId === "every") {
      const g: number[][] = [];
      for (let i=0; i<total; i+=everyN) {
        g.push(Array.from({length:Math.min(everyN, total-i)}, (_, j) => i+j));
      }
      return g;
    }
    return ranges.map(([s,e]) =>
      Array.from({length:Math.max(0,e-s+1)}, (_, i) => s-1+i)
        .filter(i => i>=0 && i<total)
    );
  })();

  // ── フェーズ分岐 ──────────────────────────────────────────────────────────
  if (phase === "processing" && !isBatch) return <Spinner label="分割処理中…" />;

  // バッチ処理中
  if (phase === "processing" && isBatch && batchProgress) return (
    <div style={s.root}>
      <div style={s.batchProgress}>
        <div style={s.bpTitle}>分割処理中… {batchProgress.current}/{batchProgress.total}</div>
        <div style={s.bpBar}>
          <div style={{ ...s.bpFill, width:`${(batchProgress.current/batchProgress.total)*100}%` }}/>
        </div>
        <div style={s.bpCurrent}>{batchProgress.currentFile}</div>
        <div style={s.bpLog}>
          {batchProgress.done.map((d,i) => (
            <div key={i} style={s.bpLogRow}>
              <span style={{color:C.accent}}>✓</span>
              <span style={s.bpLogFile}>{d.file}</span>
              <span style={s.bpLogMeta}>→ {d.count}ファイル</span>
            </div>
          ))}
          {batchProgress.errors.map((e,i) => (
            <div key={i} style={{...s.bpLogRow}}>
              <span style={{color:C.err}}>✕</span>
              <span style={s.bpLogFile}>{e.file}</span>
              <span style={{...s.bpLogMeta, color:C.err}}>{e.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  if (phase === "error") return (
    <ErrorView msg={errMsg} onBack={() => { setPhase("edit"); setErrMsg(""); }} />
  );

  // バッチ完了
  if (phase === "result" && isBatch && batchProgress) return (
    <div style={s.root}>
      <PageHeader>
        <BtnBack onClick={() => { setPhase("edit"); setBatchProgress(null); }} />
        <span style={s.title}>バッチ分割完了</span>
      </PageHeader>
      <div style={s.resultBody}>
        <div style={s.resultIcon}>{batchProgress.errors.length > 0 ? "⚠" : "✓"}</div>
        <div style={s.resultStat}>
          {batchProgress.done.length}件成功
          {batchProgress.errors.length > 0 && ` · ${batchProgress.errors.length}件エラー`}
        </div>
        <div style={s.bpLog}>
          {batchProgress.done.map((d,i) => (
            <div key={i} style={s.bpLogRow}>
              <span style={{color:C.accent}}>✓</span>
              <span style={s.bpLogFile}>{d.file}</span>
              <span style={s.bpLogMeta}>→ {d.count}ファイル</span>
            </div>
          ))}
          {batchProgress.errors.map((e,i) => (
            <div key={`e${i}`} style={s.bpLogRow}>
              <span style={{color:C.err}}>✕</span>
              <span style={s.bpLogFile}>{e.file}</span>
              <span style={{...s.bpLogMeta, color:C.err}}>{e.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // 単体完了
  if (phase === "result" && result) return (
    <div style={s.root}>
      <PageHeader>
        <BtnBack onClick={() => setPhase("edit")} />
        <span style={s.title}>分割完了 — {result.files.length}ファイルを出力</span>
      </PageHeader>
      <div style={s.resultBody}>
        <div style={s.resultIcon}>✓</div>
        <div style={s.resultDir}>{outDir}</div>
        <div style={s.fileList}>
          {result.files.map((f,i) => (
            <div key={i} style={s.fileRow}>
              <span>📄</span>
              <span style={s.fileName}>{f.split(/[/\\]/).pop()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // ── 設定画面 ──────────────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>分割{isBatch ? ` — ${batchFiles!.length}件バッチ` : ""}</span>
        {!isBatch && <span style={s.sub}>{filePath.split(/[/\\]/).pop()}</span>}
        {!isBatch && <span style={s.pageBadge}>{total}ページ</span>}
        <div style={{flex:1}}/>
        <span style={s.groupCount}>
          {isBatch
            ? `各ファイルに同じ設定を適用`
            : `→ ${groups.length}ファイル`}
        </span>
      </PageHeader>

      <div style={s.body}>
        {/* ── 左パネル: 設定 ── */}
        <div style={s.panel}>
          <div style={s.secLabel}>分割モード</div>
          <div style={s.modeList}>
            {([
              { id:"all",    icon:"⧉", label:"1ページずつ", desc:"全ページを個別ファイルに" },
              { id:"every",  icon:"⊞", label:"N枚ごと",     desc:"指定枚数をひとまとめに" },
              { id:"ranges", icon:"⊟", label:"範囲指定",     desc:"ページ範囲を自由に指定" },
            ] as const).map(m => (
              <button key={m.id} onClick={() => setModeId(m.id)}
                style={{ ...s.modeBtn, ...(modeId===m.id ? s.modeBtnOn : {}) }}>
                <span style={s.modeIcon}>{m.icon}</span>
                <div style={{display:"flex",flexDirection:"column",alignItems:"flex-start",gap:2}}>
                  <span style={s.modeName}>{m.label}</span>
                  <span style={s.modeDesc}>{m.desc}</span>
                </div>
              </button>
            ))}
          </div>

          {modeId === "every" && (
            <>
              <div style={s.secLabel}>N枚の数</div>
              {isBatch && (
                <div style={s.batchRangeNote}>全ファイルに同じN枚設定を適用します</div>
              )}
              <div style={s.numRow}>
                <button style={s.stepBtn} onClick={() => setEveryN(v=>Math.max(1,v-1))}>−</button>
                <input type="number" style={s.numInput} value={everyN} min={1} max={isBatch?999:total}
                  onChange={e => setEveryN(Math.max(1,parseInt(e.target.value)||1))} />
                <button style={s.stepBtn} onClick={() => setEveryN(v=>v+1)}>＋</button>
                <span style={s.numLabel}>ページで1ファイル</span>
              </div>
            </>
          )}

          {modeId === "ranges" && !isBatch && (
            <>
              <div style={s.secLabel}>ページ範囲</div>
              {ranges.map((rng,i) => (
                <div key={i} style={s.rangeRow}>
                  <span style={s.rangeIdx}>#{i+1}</span>
                  <button style={s.rangeArrow} onClick={()=>setRanges(r=>r.map((x,j)=>j===i?[Math.max(1,x[0]-1),x[1]]:x))}>◀</button>
                  <input type="number" style={s.rangeInput} value={rng[0]} min={1} max={total}
                    onChange={e=>setRanges(r=>r.map((x,j)=>j===i?[parseInt(e.target.value)||1,x[1]]:x))} />
                  <span style={s.rangeSep}>〜</span>
                  <input type="number" style={s.rangeInput} value={rng[1]} min={1} max={total}
                    onChange={e=>setRanges(r=>r.map((x,j)=>j===i?[x[0],parseInt(e.target.value)||1]:x))} />
                  <button style={s.rangeArrow} onClick={()=>setRanges(r=>r.map((x,j)=>j===i?[x[0],Math.min(total,x[1]+1)]:x))}>▶</button>
                  {ranges.length > 1 && (
                    <button style={s.delBtn} onClick={()=>setRanges(r=>r.filter((_,j)=>j!==i))}>✕</button>
                  )}
                </div>
              ))}
              <button style={s.addBtn} onClick={()=>setRanges(r=>[...r,[1,total]])}>＋ 範囲を追加</button>
            </>
          )}

          {modeId === "ranges" && isBatch && (
            <>
              <div style={s.batchRangeNote}>
                ⚠ バッチ時: 各ファイルのページ数に合わせて範囲を自動クリップします
              </div>
              {ranges.map((rng,i) => (
                <div key={i} style={s.rangeRow}>
                  <span style={s.rangeIdx}>#{i+1}</span>
                  <button style={s.rangeArrow} onClick={()=>setRanges(r=>r.map((x,j)=>j===i?[Math.max(1,x[0]-1),x[1]]:x))}>◀</button>
                  <input type="number" style={s.rangeInput} value={rng[0]} min={1}
                    onChange={e=>setRanges(r=>r.map((x,j)=>j===i?[parseInt(e.target.value)||1,x[1]]:x))} />
                  <span style={s.rangeSep}>〜</span>
                  <input type="number" style={s.rangeInput} value={rng[1]} min={1}
                    onChange={e=>setRanges(r=>r.map((x,j)=>j===i?[x[0],parseInt(e.target.value)||1]:x))} />
                  <button style={s.rangeArrow} onClick={()=>setRanges(r=>r.map((x,j)=>j===i?[x[0],x[1]+1]:x))}>▶</button>
                  {ranges.length>1 && <button style={s.delBtn} onClick={()=>setRanges(r=>r.filter((_,j)=>j!==i))}>✕</button>}
                </div>
              ))}
              <button style={s.addBtn} onClick={()=>setRanges(r=>[...r,[1,99]])}>＋ 範囲を追加</button>
            </>
          )}

          <div style={s.secLabel}>ファイル名プレフィックス</div>
          <div style={s.prefixRow}>
            <input type="text" style={s.textInput} value={prefix} placeholder="page"
              onChange={e=>setPrefix(e.target.value)} />
            <span style={s.prefixSuffix}>_0001.pdf</span>
          </div>

          <div style={s.secLabel}>出力フォルダ</div>
          <div style={s.dirRow}>
            <div style={s.dirPath} title={outDir}>{outDir || "（未選択）"}</div>
            <button style={s.dirPickBtn} onClick={pickDir}>参照…</button>
          </div>

          <BtnPrimary onClick={isBatch ? handleExecuteBatch : handleExecuteSingle}>
            {outDir
              ? isBatch
                ? `✂ ${batchFiles!.length}件をまとめて分割`
                : `✂ 分割実行 → ${groups.length}ファイル`
              : "📁 出力先を選択して実行"}
          </BtnPrimary>
        </div>

        {/* ── 右: プレビューエリア ── */}
        <div style={s.preview}>
          {isBatch ? (
            // バッチ: ファイル一覧 + 先頭ページサムネイル
            <>
              <div style={s.previewHead}>
                対象ファイル — {batchFiles!.length}件
              </div>
              <div style={s.batchFileList}>
                {batchFiles!.map((f, i) => (
                  <div key={f.id}
                    style={{ ...s.batchFileItem, ...(i === previewIdx ? s.batchFileItemOn : {}) }}
                    onClick={() => setPreviewIdx(i)}
                  >
                    {batchThumbs[i]
                      ? <img src={`data:image/jpeg;base64,${batchThumbs[i]}`} style={s.batchThumb} alt="" />
                      : <div style={s.batchThumbPh} />}
                    <div style={s.batchFileInfo}>
                      <span style={s.batchFileName}>{f.filename}</span>
                      <span style={s.batchFileMeta}>{f.pageCount}p</span>
                      <span style={s.batchFileMeta}>
                        {modeId==="all" ? `→ ${f.pageCount}ファイル`
                          : modeId==="every" ? `→ ${Math.ceil(f.pageCount/everyN)}ファイル`
                          : "→ 範囲指定"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            // 単体: グループプレビュー
            <>
              <div style={s.previewHead}>
                グループプレビュー — {groups.length}ファイル
              </div>
              <div style={s.groupList}>
                {groups.map((pages, gi) => (
                  <div key={gi} style={s.group}>
                    <div style={s.groupLabel}>
                      <span style={s.groupNum}>#{gi+1}</span>
                      <span style={s.groupPages}>{pages.length}ページ</span>
                      <span style={s.groupRange}>
                        {pages.length===1 ? `p.${pages[0]+1}` : `p.${pages[0]+1}〜${pages[pages.length-1]+1}`}
                      </span>
                    </div>
                    <div style={s.groupThumbs}>
                      {pages.slice(0,6).map(pi => (
                        <ThumbCard key={pi} b64={thumbs[pi]} pageNum={pi+1} width={70} />
                      ))}
                      {pages.length > 6 && (
                        <div style={s.groupMore}>+{pages.length-6}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── スタイル ──────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root:      { display:"flex", flexDirection:"column", height:"100%", background:C.bg, color:C.text, fontFamily:F, overflow:"hidden" },
  title:     { fontSize:15, fontWeight:700, color:C.text },
  sub:       { fontSize:12, color:C.textSub, maxWidth:180, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  pageBadge: { padding:"2px 10px", background:C.bgCard, border:`1px solid ${C.border}`, borderRadius:12, fontSize:11, color:C.textSub },
  groupCount:{ fontSize:13, color:C.accent, fontWeight:700 },

  body:    { flex:1, display:"flex", overflow:"hidden" },
  panel:   { width:296, flexShrink:0, padding:"16px 18px", display:"flex", flexDirection:"column", gap:12, overflowY:"auto", borderRight:`1px solid ${C.border}` },

  secLabel:  { fontSize:11, color:C.textSub, letterSpacing:"0.08em", textTransform:"uppercase" as const },
  modeList:  { display:"flex", flexDirection:"column", gap:5 },
  modeBtn:   { display:"flex", alignItems:"center", gap:11, padding:"11px 13px", background:C.bgCard, border:`1px solid ${C.border}`, borderRadius:8, cursor:"pointer", fontFamily:F, color:C.text, textAlign:"left" as const, transition:"all 0.1s" },
  modeBtnOn: { borderColor:C.accent, background:C.accentBg },
  modeIcon:  { fontSize:20, flexShrink:0 },
  modeName:  { fontSize:13, fontWeight:600, color:C.text },
  modeDesc:  { fontSize:11, color:C.textSub },

  numRow:    { display:"flex", alignItems:"center", gap:7 },
  stepBtn:   { width:44, height:44, display:"flex", alignItems:"center", justifyContent:"center", background:C.bgCard, border:`1px solid ${C.borderHi}`, borderRadius:7, cursor:"pointer", fontSize:22, color:C.text, fontFamily:F, flexShrink:0 },
  numInput:  { width:80, padding:"8px 0", background:C.bgCard, border:`1px solid ${C.borderHi}`, borderRadius:7, color:C.text, fontSize:28, fontFamily:F, textAlign:"center" as const, fontWeight:700 },
  numLabel:  { fontSize:12, color:C.textSub },

  rangeRow:    { display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" as const },
  rangeIdx:    { fontSize:11, color:C.textDim, width:24, flexShrink:0 },
  rangeInput:  { width:80, padding:"8px 4px", background:C.bgCard, border:`1px solid ${C.borderHi}`, borderRadius:7, color:C.text, fontSize:26, fontFamily:F, textAlign:"center" as const, fontWeight:700 },
  rangeSep:    { fontSize:14, color:C.textDim },
  rangeArrow:  { width:44, height:44, display:"flex", alignItems:"center", justifyContent:"center", background:C.bgCard, border:`1px solid ${C.borderHi}`, borderRadius:7, cursor:"pointer", fontSize:22, color:C.text, fontFamily:F },
  rangeSteps:  { display:"flex", gap:3 },
  delBtn:      { width:28, height:28, display:"flex", alignItems:"center", justifyContent:"center", background:"transparent", border:"none", color:C.textDim, cursor:"pointer", fontSize:14, padding:0, fontFamily:F },
  addBtn:      { padding:"8px 14px", background:"transparent", border:`1px dashed ${C.borderHi}`, borderRadius:6, color:C.textSub, cursor:"pointer", fontSize:12, fontFamily:F },
  batchRangeNote: { padding:"9px 11px", background:"#1a2a1a", border:`1px solid #3a5a2a`, borderRadius:7, fontSize:11, color:C.textSub, lineHeight:1.6 },

  prefixRow:  { display:"flex", alignItems:"center", gap:6 },
  textInput:  { flex:1, padding:"7px 9px", background:C.bgCard, border:`1px solid ${C.borderHi}`, borderRadius:6, color:C.text, fontSize:13, fontFamily:F },
  prefixSuffix:{ fontSize:11, color:C.textDim, flexShrink:0 },
  dirRow:     { display:"flex", gap:7 },
  dirPath:    { flex:1, padding:"7px 9px", background:C.bgCard, border:`1px solid ${C.border}`, borderRadius:6, color:C.textSub, fontSize:11, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  dirPickBtn: { padding:"7px 14px", background:C.bgCard, border:`1px solid ${C.borderHi}`, borderRadius:6, color:C.text, cursor:"pointer", fontSize:12, fontFamily:F, flexShrink:0 },

  // バッチ進捗
  batchProgress: { flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:18, padding:40 },
  bpTitle:    { fontSize:16, fontWeight:700, color:C.text },
  bpBar:      { width:"100%", maxWidth:480, height:8, background:C.border, borderRadius:4, overflow:"hidden" },
  bpFill:     { height:"100%", background:C.accent, borderRadius:4, transition:"width 0.3s" },
  bpCurrent:  { fontSize:13, color:C.textSub },
  bpLog:      { width:"100%", maxWidth:480, display:"flex", flexDirection:"column", gap:5, maxHeight:300, overflowY:"auto" },
  bpLogRow:   { display:"flex", alignItems:"center", gap:10, padding:"6px 10px", background:C.bgCard, borderRadius:6, border:`1px solid ${C.border}` },
  bpLogFile:  { flex:1, fontSize:12, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  bpLogMeta:  { fontSize:11, color:C.textSub },

  // プレビューエリア
  preview:    { flex:1, display:"flex", flexDirection:"column", overflow:"hidden" },
  previewHead:{ padding:"10px 18px", fontSize:12, color:C.textSub, borderBottom:`1px solid ${C.border}`, flexShrink:0, letterSpacing:"0.04em" },

  // バッチファイルリスト
  batchFileList: { flex:1, overflowY:"auto", display:"flex", flexDirection:"column", gap:0 },
  batchFileItem: { display:"flex", alignItems:"center", gap:14, padding:"12px 16px", borderBottom:`1px solid ${C.border}`, cursor:"pointer", transition:"background 0.1s" },
  batchFileItemOn: { background:C.accentBg, borderLeft:`3px solid ${C.accent}` },
  batchThumb:    { width:72, height:102, objectFit:"cover" as const, borderRadius:4, flexShrink:0 },
  batchThumbPh:  { width:72, height:102, background:C.border, borderRadius:4, flexShrink:0 },
  batchFileInfo: { flex:1, display:"flex", flexDirection:"column", gap:5, minWidth:0 },
  batchFileName: { fontSize:13, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  batchFileMeta: { fontSize:11, color:C.textSub },

  // 単体グループプレビュー
  groupList:   { flex:1, overflowY:"auto", padding:14, display:"flex", flexDirection:"column", gap:8 },
  group:       { background:C.bgCard, border:`1px solid ${C.border}`, borderRadius:9, overflow:"hidden" },
  groupLabel:  { display:"flex", alignItems:"center", gap:9, padding:"7px 13px", borderBottom:`1px solid ${C.border}`, background:C.bg },
  groupNum:    { fontSize:12, fontWeight:700, color:C.accent, minWidth:28 },
  groupPages:  { fontSize:11, color:C.textSub },
  groupRange:  { fontSize:11, color:C.textDim, marginLeft:"auto" },
  groupThumbs: { display:"flex", gap:5, padding:"9px 11px", flexWrap:"wrap" as const },
  groupMore:   { width:70, height:99, display:"flex", alignItems:"center", justifyContent:"center", background:C.border, borderRadius:4, fontSize:12, color:C.textSub },

  // 結果
  resultBody:  { flex:1, display:"flex", flexDirection:"column", alignItems:"center", padding:28, gap:12, overflowY:"auto" },
  resultIcon:  { fontSize:52, color:C.accent },
  resultStat:  { fontSize:18, fontWeight:700, color:C.text },
  resultDir:   { fontSize:12, color:C.textSub },
  fileList:    { width:"100%", maxWidth:500, display:"flex", flexDirection:"column", gap:4 },
  fileRow:     { display:"flex", alignItems:"center", gap:9, padding:"7px 11px", background:C.bgCard, borderRadius:6, border:`1px solid ${C.border}` },
  fileName:    { fontSize:12, color:C.text },
};
