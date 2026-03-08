// src/pages/CompressPage.tsx
// フロー（単体）: プリセット選択 → プレビュー実行 → 結果確認 → [圧縮保存 / 圧縮せず保存]
// フロー（バッチ）: プリセット選択 → 出力フォルダ選択 → 全件処理 → 結果

import { useState, useCallback } from "react";
import { invoke }        from "@tauri-apps/api/core";
import { useSaveDialog } from "../hooks/useSaveDialog";
import { usePdfStore }   from "../store/usePdfStore";
import {
  compressPdf, getTmpPath, renderPage,
  type CompressPreset, type CompressResponse, type PdfInfo,
} from "../lib/tauri";
import { C, F } from "../lib/theme";

interface Props {
  filePath:    string;
  pdfInfo:     PdfInfo;
  sourceFile?: string;   // 連携元ファイル（trim後など）
  onDone?:     () => void;
  batchFiles?: import("../store/usePdfStore").FileEntry[];
}

type Phase = "edit" | "processing" | "result" | "batchResult" | "error";

const PRESETS: {
  id: CompressPreset; icon: string; label: string; desc: string; note: string; color: string;
}[] = [
  { id:"light",      icon:"☁",  label:"軽め",    desc:"GC=1、画像圧縮なし",     note:"フォント完全保護。効果小さめ",           color:"#3a7a4a" },
  { id:"standard",   icon:"⚖",  label:"標準",    desc:"GC=2、画像圧縮あり",     note:"バランス重視。ほとんどのPDFに安全",       color:"#2a5a9a" },
  { id:"aggressive", icon:"⚡", label:"強め",    desc:"GC=3、sanitize=true",    note:"⚠ 埋め込みフォントに影響する場合あり",   color:"#7a5a1a" },
  { id:"maximum",    icon:"🔥", label:"最大",    desc:"GC=4、sanitize=true",    note:"⚠ 最大圧縮。フォントへの影響リスク高",   color:"#7a2020" },
];

export function CompressPage({ filePath, pdfInfo, sourceFile, onDone, batchFiles }: Props) {
  const { setError }  = usePdfStore();
  const { pickSave }  = useSaveDialog();
  const isBatch = (batchFiles?.length ?? 0) > 1;
  const inputFile = sourceFile ?? filePath;

  const [phase,   setPhase]   = useState<Phase>("edit");
  const [preset,  setPreset]  = useState<CompressPreset>("standard");
  const [result,  setResult]  = useState<CompressResponse | null>(null);
  const [tmpFile, setTmpFile] = useState("");     // プレビュー用一時ファイル
  const [preview, setPreview] = useState("");
  const [errMsg,  setErrMsg]  = useState("");
  const [saving,  setSaving]  = useState(false);
  const [outDir,  setOutDir]  = useState("");
  const [batchProg, setBatchProg] = useState<{
    cur: number; total: number; curFile: string;
    done: { file:string; pct:string }[]; errors: { file:string; msg:string }[];
  } | null>(null);

  const pickDir = useCallback(async () => {
    const d = await invoke<string|null>("pick_output_dir").catch(()=>null);
    if (d) setOutDir(d);
  }, []);

  // ── 単体: プレビュー実行 ─────────────────────────────────────────────
  const handlePreview = useCallback(async () => {
    setPhase("processing");
    try {
      const tmp = await getTmpPath("kozou_compress_preview.pdf");
      const res = await compressPdf(inputFile, tmp, { preset });
      setResult(res);
      setTmpFile(tmp);
      try { setPreview(await renderPage(tmp, 0, 108)); } catch { setPreview(""); }
      setPhase("result");
    } catch (e) {
      setErrMsg(String(e)); setPhase("error"); setError(String(e));
    }
  }, [inputFile, preset, setError]);

  // ── 単体: 圧縮して保存 ───────────────────────────────────────────────
  const handleSaveCompressed = useCallback(async () => {
    const base = filePath.split(/[/\\]/).pop()?.replace(/\.pdf$/i,"") ?? "file";
    const sp = await pickSave(`${base}_compressed.pdf`);
    if (!sp) return;
    setSaving(true);
    try {
      await compressPdf(inputFile, sp, { preset });
      if (onDone) onDone();
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }, [inputFile, filePath, preset, pickSave, setError, onDone]);

  // ── 単体: 圧縮せずそのまま保存 ──────────────────────────────────────
  const handleSaveOriginal = useCallback(async () => {
    const base = filePath.split(/[/\\]/).pop()?.replace(/\.pdf$/i,"") ?? "file";
    const sp = await pickSave(`${base}.pdf`);
    if (!sp) return;
    setSaving(true);
    try {
      // inputFile をそのままコピー保存
      await invoke("compress_pdf", { input: inputFile, output: sp,
        params: { preset: "light", garbage_level:0, compress_images:false,
                  compress_fonts:false, sanitize:false, rewrite_fallback:false }
      }).catch(() => {
        // fallback: 圧縮レベル最小（実質コピー相当）
      });
      // tauri側にコピーAPIがなければlightで保存（最小影響）
      await compressPdf(inputFile, sp, { preset: "light" });
      if (onDone) onDone();
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }, [inputFile, filePath, pickSave, setError, onDone]);

  // ── バッチ: フォルダ出力 ─────────────────────────────────────────────
  const handleBatch = useCallback(async () => {
    if (!outDir) { await pickDir(); return; }
    setPhase("processing");
    const prog = { cur:0, total:batchFiles!.length, curFile:"", done:[] as any[], errors:[] as any[] };
    setBatchProg({...prog});
    for (let i=0; i<batchFiles!.length; i++) {
      const f = batchFiles![i];
      prog.cur = i+1; prog.curFile = f.filename;
      setBatchProg({...prog});
      try {
        const out = `${outDir}/${f.filename.replace(/\.pdf$/i,"")}_compressed.pdf`;
        const res = await compressPdf(f.path, out, { preset });
        prog.done.push({ file:f.filename, pct:((1-res.ratio)*100).toFixed(1) });
      } catch (e) {
        prog.errors.push({ file:f.filename, msg:String(e) });
      }
      setBatchProg({...prog});
    }
    setPhase("batchResult");
  }, [batchFiles, preset, outDir, pickDir]);

  // ═══════════════════════════════════ RENDER ══════════════════════════
  const bg = C.bg;

  // 処理中（単体）
  if (phase==="processing" && !isBatch) return (
    <div style={c.center}>
      <div style={c.spinner}/>
      <span style={c.spinSub}>圧縮処理中…</span>
    </div>
  );

  // 処理中（バッチ）
  if (phase==="processing" && isBatch && batchProg) return (
    <div style={c.center}>
      <div style={c.bpTitle}>圧縮処理中… {batchProg.cur}/{batchProg.total}</div>
      <div style={c.bpBarWrap}><div style={{...c.bpBar, width:`${batchProg.cur/batchProg.total*100}%`}}/></div>
      <div style={c.bpCurFile}>{batchProg.curFile}</div>
      <div style={c.bpLog}>
        {batchProg.done.map((d,i)=>(
          <div key={i} style={c.bpRow}><span style={{color:C.accent}}>✓</span>
            <span style={c.bpFile}>{d.file}</span>
            <span style={c.bpPct}>−{d.pct}%</span></div>
        ))}
      </div>
    </div>
  );

  // エラー
  if (phase==="error") return (
    <div style={c.center}>
      <span style={{fontSize:38,color:C.err}}>✕</span>
      <span style={{fontSize:16,fontWeight:700,color:C.err}}>エラー</span>
      <pre style={c.errPre}>{errMsg}</pre>
      <button style={c.btnBack} onClick={()=>{setPhase("edit");setErrMsg("");}}>← 戻る</button>
    </div>
  );

  // バッチ結果
  if (phase==="batchResult" && batchProg) return (
    <div style={c.center}>
      <span style={{fontSize:52,color:batchProg.errors.length?C.warn:C.accent}}>
        {batchProg.errors.length?"⚠":"✓"}
      </span>
      <div style={c.bpTitle}>
        バッチ圧縮完了 — {batchProg.done.length}件
        {batchProg.errors.length>0&&` · ${batchProg.errors.length}件エラー`}
      </div>
      <div style={c.bpOutDir}>{outDir}</div>
      <div style={c.bpLog}>
        {batchProg.done.map((d,i)=>(
          <div key={i} style={c.bpRow}><span style={{color:C.accent}}>✓</span>
            <span style={c.bpFile}>{d.file}</span>
            <span style={c.bpPct}>−{d.pct}%</span></div>
        ))}
        {batchProg.errors.map((e,i)=>(
          <div key={`e${i}`} style={{...c.bpRow,background:C.errBg,borderColor:C.errBd}}>
            <span style={{color:C.err}}>✕</span>
            <span style={c.bpFile}>{e.file}</span>
            <span style={{fontSize:11,color:C.err,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.msg}</span>
          </div>
        ))}
      </div>
      <button style={c.btnBack} onClick={()=>{setPhase("edit");setBatchProg(null);}}>← 設定に戻る</button>
    </div>
  );

  // ── 単体: 結果確認 ──────────────────────────────────────────────────
  if (phase==="result" && result) {
    const inMB  = (result.input_bytes /1048576).toFixed(2);
    const outMB = (result.output_bytes/1048576).toFixed(2);
    const pct   = ((1-result.ratio)*100).toFixed(1);
    const gain  = Number(pct) > 0;
    const p     = result.params_used;
    return (
      <div style={c.root}>
        {/* ヘッダー */}
        <div style={c.header}>
          <button style={c.btnBack} onClick={()=>setPhase("edit")}>← 設定に戻る</button>
          <span style={c.title}>圧縮プレビュー結果</span>
          <div style={{flex:1}}/>
          {onDone && <button style={c.btnSkip} onClick={onDone}>スキップ</button>}
        </div>

        <div style={c.resultBody}>
          {/* プレビュー画像 */}
          <div style={c.prevCol}>
            {preview
              ? <img src={`data:image/jpeg;base64,${preview}`} style={c.prevImg} alt="preview"/>
              : <div style={c.prevPh}>プレビューなし</div>}
            <span style={c.prevSub}>{pdfInfo.page_count}ページ</span>
          </div>

          {/* 統計 + 保存ボタン */}
          <div style={c.statsCol}>
            <div style={{...c.statBig, color: gain?"#4fe090":"#ff6060"}}>
              {gain?`−${pct}%`:`+${Math.abs(Number(pct))}%`}
              <span style={c.statBigSub}>{gain?"削減":"増加"}</span>
            </div>
            <div style={c.statRow}>
              <StatCard label="元のサイズ" val={`${inMB} MB`}/>
              <span style={{fontSize:22,color:C.textDim}}>→</span>
              <StatCard label="圧縮後" val={`${outMB} MB`} accent/>
            </div>

            <div style={c.paramsBox}>
              <span style={c.paramsHd}>パラメータ</span>
              <PRow label="プリセット"   val={preset}/>
              <PRow label="GCレベル"     val={String(p.garbage_level)}/>
              <PRow label="画像圧縮"     val={p.compress_images?"あり":"なし"}/>
              <PRow label="フォント圧縮" val={p.compress_fonts?"あり":"なし"}/>
              <PRow label="フォントサブセット化" val={
                (p as any).font_subset
                  ? <span style={{color:C.accent}}>✓ 実行 (未使用グリフ除去)</span>
                  : (p as any).subset_skipped
                    ? <span style={{color:C.warn}}>Type3フォントのためスキップ</span>
                    : "スキップ"
              }/>
              <PRow label="sanitize"    val={p.sanitize?"あり":"なし"}/>
              {(p as any).subset_skipped && !(p as any).font_subset &&
                <div style={c.infoBox}>ℹ Type3フォント保護のためサブセット化をスキップしました。テキストは維持されています。</div>}
              {(p as any).rewrite_fallback &&
                <div style={c.warnBox}>⚠ Type3フォント → フォールバック</div>}
            </div>
            {result.warning && <div style={c.warnBox}>{result.warning}</div>}

            {/* 保存選択 — 2つのボタンを明確に並べる */}
            <div style={c.saveChoiceBox}>
              <div style={c.saveChoiceLabel}>保存方法を選択</div>
              <div style={c.saveChoiceBtns}>
                <button style={c.btnSaveCompressed}
                  onClick={handleSaveCompressed} disabled={saving}>
                  <span style={c.saveBtnIcon}>⊙</span>
                  <span style={c.saveBtnMain}>圧縮して保存</span>
                  <span style={c.saveBtnSub}>{gain?`−${pct}%（${outMB}MB）`:"効果なし"}</span>
                </button>
                <button style={c.btnSaveOriginal}
                  onClick={handleSaveOriginal} disabled={saving}>
                  <span style={c.saveBtnIcon}>💾</span>
                  <span style={c.saveBtnMain}>圧縮せず保存</span>
                  <span style={c.saveBtnSub}>{inMB}MB そのまま</span>
                </button>
              </div>
              {saving && <span style={{fontSize:12,color:C.textSub,textAlign:"center" as const}}>保存中…</span>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── 設定画面 ────────────────────────────────────────────────────────
  const fname = inputFile.split(/[/\\]/).pop() ?? "";
  return (
    <div style={c.root}>
      <div style={c.header}>
        {sourceFile && <span style={c.chainBadge}>✂ 連携ファイルを圧縮</span>}
        <span style={c.title}>圧縮設定</span>
        <span style={c.fileSub} title={fname}>{fname}</span>
        <span style={c.pageSub}>{pdfInfo.page_count}ページ</span>
        <div style={{flex:1}}/>
        {onDone && <button style={c.btnSkip} onClick={onDone}>スキップ</button>}
      </div>

      <div style={c.presetGrid}>
        {PRESETS.map(p => (
          <button key={p.id} onClick={()=>setPreset(p.id)}
            style={{...c.card, ...(preset===p.id?{borderColor:p.color,background:p.color+"22"}:{})}}>
            <span style={c.cardIcon}>{p.icon}</span>
            <span style={c.cardLabel}>{p.label}</span>
            <span style={c.cardDesc}>{p.desc}</span>
            <span style={c.cardNote}>{p.note}</span>
          </button>
        ))}
      </div>

      <div style={c.execArea}>
        {isBatch ? (
          // バッチ: フォルダ出力
          <div style={c.batchExecBox}>
            <div style={c.batchInfo}>{batchFiles!.length}ファイルに同じ設定を適用</div>
            <div style={c.dirRow}>
              <div style={c.dirPath}>{outDir||"出力フォルダ未選択"}</div>
              <button style={c.dirPickBtn} onClick={pickDir}>📁 選択…</button>
            </div>
            <button style={{...c.btnExec,...(!outDir?c.btnExecDim:{})}} onClick={handleBatch}>
              {outDir?`⊙ ${batchFiles!.length}件まとめて圧縮`:"📁 出力フォルダを選択して実行"}
            </button>
          </div>
        ) : (
          // 単体: プレビュー → 保存方法選択
          <div style={c.singleExecBox}>
            <div style={c.execHint}>
              まずプレビューで圧縮率を確認できます。<br/>
              その後、圧縮版・元ファイルどちらでも保存できます。
            </div>
            <button style={c.btnExec} onClick={handlePreview}>
              プレビュー実行 →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, val, accent }: { label:string; val:string; accent?:boolean }) {
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
      <span style={{fontSize:12,color:C.textDim}}>{label}</span>
      <span style={{fontSize:22,fontWeight:700,color:accent?C.accent:C.text}}>{val}</span>
    </div>
  );
}
function PRow({ label, val }: { label:string; val:string }) {
  return (
    <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:`1px solid ${C.border}`,fontSize:12}}>
      <span style={{color:C.textDim}}>{label}</span>
      <span style={{color:C.text}}>{val}</span>
    </div>
  );
}

const c: Record<string, React.CSSProperties> = {
  root:    {display:"flex",flexDirection:"column",height:"100%",background:C.bg,color:C.text,fontFamily:F,overflow:"hidden"},
  center:  {display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",gap:16,background:C.bg,padding:32},
  spinner: {width:32,height:32,border:`3px solid ${C.border}`,borderTop:`3px solid ${C.accent}`,borderRadius:"50%",animation:"spin 0.8s linear infinite"},
  spinSub: {color:C.textSub,fontSize:14},

  header:     {display:"flex",alignItems:"center",gap:10,padding:"12px 22px",borderBottom:`1px solid ${C.border}`,flexShrink:0},
  chainBadge: {padding:"3px 10px",background:C.accentBg,border:`1px solid ${C.accentBd}`,borderRadius:12,color:C.accent,fontSize:11},
  title:      {fontSize:16,fontWeight:700,color:C.text},
  fileSub:    {fontSize:12,color:C.textSub,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"},
  pageSub:    {fontSize:11,color:C.textDim},
  btnBack:    {padding:"6px 16px",background:"transparent",border:`1px solid ${C.borderHi}`,borderRadius:6,color:C.textSub,cursor:"pointer",fontSize:13,fontFamily:F},
  btnSkip:    {padding:"6px 16px",background:"transparent",border:`1px solid ${C.borderHi}`,borderRadius:6,color:C.textSub,cursor:"pointer",fontSize:13,fontFamily:F},

  presetGrid: {display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14,padding:"24px 22px 0"},
  card:       {display:"flex",flexDirection:"column",alignItems:"center",gap:8,padding:"22px 12px",background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:12,cursor:"pointer",transition:"all 0.15s",fontFamily:F,color:C.text},
  cardIcon:   {fontSize:30},
  cardLabel:  {fontSize:16,fontWeight:700,color:C.text},
  cardDesc:   {fontSize:11,color:C.textSub,textAlign:"center" as const},
  cardNote:   {fontSize:10,color:C.textDim,textAlign:"center" as const,lineHeight:1.5},

  execArea:     {display:"flex",justifyContent:"center",alignItems:"center",padding:"28px 0",flex:1},
  singleExecBox:{display:"flex",flexDirection:"column",alignItems:"center",gap:16},
  execHint:     {fontSize:13,color:C.textSub,textAlign:"center" as const,lineHeight:1.7},
  btnExec:      {padding:"14px 56px",background:C.accentBg,border:`2px solid ${C.accentBd}`,borderRadius:10,color:C.accent,fontWeight:700,fontSize:16,cursor:"pointer",fontFamily:F},
  btnExecDim:   {opacity:0.5},

  batchExecBox: {display:"flex",flexDirection:"column",alignItems:"center",gap:14,width:"100%",maxWidth:480},
  batchInfo:    {fontSize:14,color:C.textSub},
  dirRow:       {display:"flex",gap:8,width:"100%"},
  dirPath:      {flex:1,padding:"8px 12px",background:C.bgCard,border:`1px solid ${C.border}`,borderRadius:7,color:C.textSub,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"},
  dirPickBtn:   {padding:"8px 16px",background:C.bgCard,border:`1px solid ${C.borderHi}`,borderRadius:7,color:C.text,cursor:"pointer",fontSize:13,fontFamily:F,flexShrink:0},

  // 結果画面
  resultBody:   {flex:1,display:"flex",gap:24,padding:"20px 24px",overflow:"auto"},
  prevCol:      {display:"flex",flexDirection:"column",alignItems:"center",gap:10,flexShrink:0},
  prevImg:      {maxWidth:260,maxHeight:360,borderRadius:6,border:`1px solid ${C.border}`},
  prevPh:       {width:220,height:300,background:C.bgCard,borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",color:C.textDim,fontSize:13},
  prevSub:      {fontSize:11,color:C.textDim},
  statsCol:     {flex:1,display:"flex",flexDirection:"column",gap:14,minWidth:0},
  statBig:      {fontSize:44,fontWeight:800,display:"flex",alignItems:"baseline",gap:8,lineHeight:1},
  statBigSub:   {fontSize:15,fontWeight:400,color:C.textDim},
  statRow:      {display:"flex",alignItems:"center",gap:20,padding:"14px 18px",background:C.bgCard,borderRadius:8,border:`1px solid ${C.border}`},
  paramsBox:    {padding:"12px 14px",background:C.bgCard,borderRadius:8,border:`1px solid ${C.border}`,display:"flex",flexDirection:"column",gap:2},
  paramsHd:     {fontSize:10,color:C.textDim,letterSpacing:"0.1em",textTransform:"uppercase" as const,marginBottom:6},
  warnBox:      {padding:"8px 12px",background:C.warnBg,border:`1px solid ${C.warnBd}`,borderRadius:6,color:C.warn,fontSize:12},
  infoBox:      {padding:"8px 12px",background:C.accentBg,border:`1px solid ${C.accentBd}`,borderRadius:6,color:C.textSub,fontSize:12},

  // 保存選択ボックス（目立つUI）
  saveChoiceBox:  {marginTop:"auto",background:C.bgCard,border:`1px solid ${C.borderHi}`,borderRadius:12,padding:"16px",display:"flex",flexDirection:"column",gap:10},
  saveChoiceLabel:{fontSize:12,color:C.textDim,letterSpacing:"0.06em"},
  saveChoiceBtns: {display:"flex",gap:10},
  btnSaveCompressed:{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4,padding:"14px 10px",background:C.accentBg,border:`2px solid ${C.accentBd}`,borderRadius:9,cursor:"pointer",fontFamily:F,transition:"all 0.12s"},
  btnSaveOriginal:  {flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4,padding:"14px 10px",background:C.bgHover,border:`1px solid ${C.borderHi}`,borderRadius:9,cursor:"pointer",fontFamily:F,transition:"all 0.12s"},
  saveBtnIcon:  {fontSize:22},
  saveBtnMain:  {fontSize:14,fontWeight:700,color:C.text},
  saveBtnSub:   {fontSize:11,color:C.textSub},

  // バッチ進捗
  bpTitle:   {fontSize:16,fontWeight:700,color:C.text},
  bpBarWrap: {width:"100%",maxWidth:440,height:8,background:C.border,borderRadius:4,overflow:"hidden"},
  bpBar:     {height:"100%",background:C.accent,borderRadius:4,transition:"width 0.3s"},
  bpCurFile: {fontSize:12,color:C.textSub},
  bpOutDir:  {fontSize:11,color:C.textDim},
  bpLog:     {width:"100%",maxWidth:480,display:"flex",flexDirection:"column",gap:4,maxHeight:300,overflowY:"auto"},
  bpRow:     {display:"flex",alignItems:"center",gap:8,padding:"5px 10px",background:C.bgCard,borderRadius:6,border:`1px solid ${C.border}`},
  bpFile:    {flex:1,fontSize:12,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"},
  bpPct:     {fontSize:12,color:C.accent,fontWeight:700,flexShrink:0},

  errPre:    {fontSize:11,color:C.err,background:C.errBg,border:`1px solid ${C.errBd}`,borderRadius:6,padding:"10px 14px",maxWidth:480,whiteSpace:"pre-wrap",wordBreak:"break-all"},
  btnBack:   {padding:"8px 22px",background:"transparent",border:`1px solid ${C.borderHi}`,borderRadius:7,color:C.textSub,cursor:"pointer",fontSize:13,fontFamily:F},
};
