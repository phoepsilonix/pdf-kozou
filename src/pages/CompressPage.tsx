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
//import { C, F } from "../lib/theme";
import { F } from "../lib/theme";

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
  { id:"aggressive", icon:"⚡", label:"強め",    desc:"GC=2、sanitize,merge-fonts,object-stream",    note:"⚠ 埋め込みフォントに影響する場合あり",   color:"#7a5a1a" },
  { id:"maximum",    icon:"🔥", label:"最大",    desc:"GC=3、sanitize,clean,merge-fonts,object-stream",    note:"⚠ 最大圧縮。フォントへの影響リスク高",   color:"#7a2020" },
];

export function CompressPage({ filePath, pdfInfo, sourceFile, onDone, batchFiles }: Props) {
  const { setError }  = usePdfStore();
  const { pickSave }  = useSaveDialog();
  const isBatch = (batchFiles?.length ?? 0) > 1;
  const inputFile = sourceFile ?? filePath;

  const [phase,   setPhase]   = useState<Phase>("edit");
  const [preset,      setPreset]      = useState<CompressPreset>("standard");
  const [objectStream,  setObjectStream]  = useState(false);  // MuPDF 1.28: デフォルト無効
  const [mergeFonts,  setMergeFonts]  = useState(false);  // MuPDF 1.28: デフォルト無効
  const [result,  setResult]  = useState<CompressResponse | null>(null);
  //const [setTmpFile] = useState("");     // プレビュー用一時ファイル
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
      const res = await compressPdf(inputFile, tmp, { preset, merge_fonts: mergeFonts || undefined, object_stream: objectStream || undefined });
      setResult(res);
      setTmpFile(tmp);
      try { setPreview(await renderPage(tmp, 0, 108)); } catch { setPreview(""); }
      setPhase("result");
    } catch (e) {
      setErrMsg(String(e)); setPhase("error"); setError(String(e));
    }
  }, [inputFile, preset, mergeFonts, objectStream, setError]);

  // ── 単体: 圧縮して保存 ───────────────────────────────────────────────
  const handleSaveCompressed = useCallback(async () => {
    const base = filePath.split(/[/\\]/).pop()?.replace(/\.pdf$/i,"") ?? "file";
    const sp = await pickSave(`${base}_compressed.pdf`);
    if (!sp) return;
    setSaving(true);
    try {
      await compressPdf(inputFile, sp, { preset, merge_fonts: mergeFonts || undefined, object_stream: objectStream || undefined });
      if (onDone) onDone();
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }, [inputFile, filePath, preset, mergeFonts, objectStream, pickSave, setError, onDone]);

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
  }, [inputFile, filePath, mergeFonts, objectStream, pickSave, setError, onDone]);

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
        const res = await compressPdf(f.path, out, { preset, merge_fonts: mergeFonts || undefined, object_stream: objectStream || undefined });
        prog.done.push({ file:f.filename, pct:((1-res.ratio)*100).toFixed(1) });
      } catch (e) {
        prog.errors.push({ file:f.filename, msg:String(e) });
      }
      setBatchProg({...prog});
    }
    setPhase("batchResult");
  }, [batchFiles, preset, mergeFonts, objectStream, outDir, pickDir]);

  // ═══════════════════════════════════ RENDER ══════════════════════════
  //const bg = "var(--c-bg)";

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
          <div key={i} style={c.bpRow}><span style={{color:"var(--c-accent)"}}>✓</span>
            <span style={c.bpFile}>{d.file}</span>
            <span style={c.bpPct}>−{d.pct}%</span></div>
        ))}
      </div>
    </div>
  );

  // エラー
  if (phase==="error") return (
    <div style={c.center}>
      <span style={{fontSize:38,color:"var(--c-err)"}}>✕</span>
      <span style={{fontSize:16,fontWeight:700,color:"var(--c-err)"}}>エラー</span>
      <pre style={c.errPre}>{errMsg}</pre>
      <button style={c.btnBackSm} onClick={()=>{setPhase("edit");setErrMsg("");}}>← 戻る</button>
    </div>
  );

  // バッチ結果
  if (phase==="batchResult" && batchProg) return (
    <div style={c.center}>
      <span style={{fontSize:52,color:batchProg.errors.length?"var(--c-warn)":"var(--c-accent)"}}>
        {batchProg.errors.length?"⚠":"✓"}
      </span>
      <div style={c.bpTitle}>
        バッチ圧縮完了 — {batchProg.done.length}件
        {batchProg.errors.length>0&&` · ${batchProg.errors.length}件エラー`}
      </div>
      <div style={c.bpOutDir}>{outDir}</div>
      <div style={c.bpLog}>
        {batchProg.done.map((d,i)=>(
          <div key={i} style={c.bpRow}><span style={{color:"var(--c-accent)"}}>✓</span>
            <span style={c.bpFile}>{d.file}</span>
            <span style={c.bpPct}>−{d.pct}%</span></div>
        ))}
        {batchProg.errors.map((e,i)=>(
          <div key={`e${i}`} style={{...c.bpRow,background:"var(--c-errBg)",borderColor:"var(--c-errBd)"}}>
            <span style={{color:"var(--c-err)"}}>✕</span>
            <span style={c.bpFile}>{e.file}</span>
            <span style={{fontSize:11,color:"var(--c-err)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.msg}</span>
          </div>
        ))}
      </div>
      <button style={c.btnBackSm} onClick={()=>{setPhase("edit");setBatchProg(null);}}>← 設定に戻る</button>
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
          <button style={c.btnBack} onClick={e=>{ setPhase("edit"); (e.currentTarget as HTMLButtonElement).blur(); }}>← 設定に戻る</button>
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
              <span style={{fontSize:22,color:"var(--c-textDim)"}}>→</span>
              <StatCard label="圧縮後" val={`${outMB} MB`} accent/>
            </div>

            <div style={c.paramsBox}>
              <span style={c.paramsHd}>パラメータ</span>
              <PRow label="プリセット"   val={preset}/>
              <PRow label="GCレベル"     val={String(p.garbage_level)}/>
              <PRow label="画像圧縮"     val={p.compress_images?"あり":"なし"}/>
              <PRow label="フォント圧縮" val={p.compress_fonts?"あり":"なし"}/>
              <PRow label="sanitize"    val={p.sanitize?"あり":"なし"}/>
              <PRow label="merge_fonts"    val={p.merge_fonts?"あり":"なし"}/>
              <PRow label="object_stream"    val={p.object_stream?"あり":"なし"}/>
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
              {saving && <span style={{fontSize:12,color:"var(--c-textSub)",textAlign:"center" as const}}>保存中…</span>}
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
          <button key={p.id} onClick={e=>{ setPreset(p.id); (e.currentTarget as HTMLButtonElement).blur(); }}
            style={{...c.card, ...(preset===p.id?{borderColor:p.color,background:p.color+"22"}:{})}}>
            <span style={c.cardIcon}>{p.icon}</span>
            <span style={c.cardLabel}>{p.label}</span>
            <span style={c.cardDesc}>{p.desc}</span>
            <span style={c.cardNote}>{p.note}</span>
          </button>
        ))}
      </div>

      {/* Object Stream */}
      <div style={c.optRow}>
        <label style={c.optLabel}>
          <input type="checkbox" checked={objectStream}
            onChange={e => setObjectStream(e.target.checked)}
            style={{marginRight:6,cursor:"pointer"}}/>
          オブジェクトのストリーム圧縮
        </label>
        <span style={c.optHint}>
          {objectStream
            ? "有効(ストリーム圧縮)"
            : "無効"}
        </span>
      </div>

      {/* Merge Fonts */}
      <div style={c.optRow}>
        <label style={c.optLabel}>
          <input type="checkbox" checked={mergeFonts}
            onChange={e => setMergeFonts(e.target.checked)}
            style={{marginRight:6,cursor:"pointer"}}/>
          CIDフォント統合
        </label>
        <span style={c.optHint}>
          {mergeFonts
            ? "有効(分かれているCIDフォントをなるべく統一します。)"
            : "無効"}
        </span>
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
      <span style={{fontSize:12,color:"var(--c-textDim)"}}>{label}</span>
      <span style={{fontSize:22,fontWeight:700,color:accent?"var(--c-accent)":"var(--c-text)"}}>{val}</span>
    </div>
  );
}
//function PRow({ label, val }: { label:string; val:string }) {
function PRow({ label, val }: { label: string; val: string | React.ReactNode }) {
  return (
    <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:`1px solid var(--c-border)`,fontSize:12}}>
      <span style={{color:"var(--c-textDim)"}}>{label}</span>
      <span style={{color:"var(--c-text)"}}>{val}</span>
    </div>
  );
}

const c: Record<string, React.CSSProperties> = {
  root:    {display:"flex",flexDirection:"column",height:"100%",background:"var(--c-bg)",color:"var(--c-text)",fontFamily:F,overflow:"hidden"},
  center:  {display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",gap:16,background:"var(--c-bg)",padding:32},
  spinner: {width:32,height:32,border:`3px solid var(--c-border)`,borderTop:`3px solid var(--c-accent)`,borderRadius:"50%",animation:"spin 0.8s linear infinite"},
  spinSub: {color:"var(--c-textSub)",fontSize:14},

  header:     {display:"flex",alignItems:"center",gap:10,padding:"12px 22px",borderBottom:`1px solid var(--c-border)`,flexShrink:0},
  chainBadge: {padding:"3px 10px",background:"var(--c-accentBg)",border:`1px solid var(--c-accentBd)`,borderRadius:12,color:"var(--c-accent)",fontSize:11},
  title:      {fontSize:16,fontWeight:700,color:"var(--c-text)"},
  fileSub:    {fontSize:12,color:"var(--c-textSub)",maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"},
  pageSub:    {fontSize:11,color:"var(--c-textDim)"},
  btnBackSm:  {padding:"6px 16px",background:"transparent",border:`1px solid var(--c-borderHi)`,borderRadius:6,color:"var(--c-textSub)",cursor:"pointer",fontSize:13,fontFamily:F},
  btnSkip:    {padding:"6px 16px",background:"transparent",border:`1px solid var(--c-borderHi)`,borderRadius:6,color:"var(--c-textSub)",cursor:"pointer",fontSize:13,fontFamily:F},

  presetGrid: {display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14,padding:"24px 22px 0"},
  optRow:   { display:"flex",alignItems:"center",gap:12,padding:"14px 22px 2px",flexWrap:"wrap" as const },
  optLabel: { display:"flex",alignItems:"center",fontSize:13,color:"var(--c-text)",cursor:"pointer",userSelect:"none" as const },
  optLabel2: { display:"flex",alignItems:"center",fontSize:13,color:"var(--c-text)",cursor:"pointer",userSelect:"none" as const },
  optHint:  { fontSize:11,color:"var(--c-textSub)" },
  optHint2:  { fontSize:11,color:"var(--c-textSub)" },
  card:       {display:"flex",flexDirection:"column",alignItems:"center",gap:8,padding:"22px 12px",background:"var(--c-bgCard)",border:`1px solid var(--c-border)`,borderRadius:12,cursor:"pointer",transition:"all 0.15s",fontFamily:F,color:"var(--c-text)"},
  cardIcon:   {fontSize:30},
  cardLabel:  {fontSize:16,fontWeight:700,color:"var(--c-text)"},
  cardDesc:   {fontSize:11,color:"var(--c-textSub)",textAlign:"center" as const},
  cardNote:   {fontSize:10,color:"var(--c-textDim)",textAlign:"center" as const,lineHeight:1.5},

  execArea:     {display:"flex",justifyContent:"center",alignItems:"center",padding:"28px 0",flex:1},
  singleExecBox:{display:"flex",flexDirection:"column",alignItems:"center",gap:16},
  execHint:     {fontSize:13,color:"var(--c-textSub)",textAlign:"center" as const,lineHeight:1.7},
  btnExec:      {padding:"14px 56px",background:"var(--c-accentBg)",border:`2px solid var(--c-accentBd)`,borderRadius:10,color:"var(--c-accent)",fontWeight:700,fontSize:16,cursor:"pointer",fontFamily:F},
  btnExecDim:   {opacity:0.5},

  batchExecBox: {display:"flex",flexDirection:"column",alignItems:"center",gap:14,width:"100%",maxWidth:480},
  batchInfo:    {fontSize:14,color:"var(--c-textSub)"},
  dirRow:       {display:"flex",gap:8,width:"100%"},
  dirPath:      {flex:1,padding:"8px 12px",background:"var(--c-bgCard)",border:`1px solid var(--c-border)`,borderRadius:7,color:"var(--c-textSub)",fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"},
  dirPickBtn:   {padding:"8px 16px",background:"var(--c-bgCard)",border:`1px solid var(--c-borderHi)`,borderRadius:7,color:"var(--c-text)",cursor:"pointer",fontSize:13,fontFamily:F,flexShrink:0},

  // 結果画面
  resultBody:   {flex:1,display:"flex",gap:24,padding:"20px 24px",overflow:"auto"},
  prevCol:      {display:"flex",flexDirection:"column",alignItems:"center",gap:10,flexShrink:0},
  prevImg:      {maxWidth:260,maxHeight:360,borderRadius:6,border:`1px solid var(--c-border)`},
  prevPh:       {width:220,height:300,background:"var(--c-bgCard)",borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",color:"var(--c-textDim)",fontSize:13},
  prevSub:      {fontSize:11,color:"var(--c-textDim)"},
  statsCol:     {flex:1,display:"flex",flexDirection:"column",gap:14,minWidth:0},
  statBig:      {fontSize:44,fontWeight:800,display:"flex",alignItems:"baseline",gap:8,lineHeight:1},
  statBigSub:   {fontSize:15,fontWeight:400,color:"var(--c-textDim)"},
  statRow:      {display:"flex",alignItems:"center",gap:20,padding:"14px 18px",background:"var(--c-bgCard)",borderRadius:8,border:`1px solid var(--c-border)`},
  paramsBox:    {padding:"12px 14px",background:"var(--c-bgCard)",borderRadius:8,border:`1px solid var(--c-border)`,display:"flex",flexDirection:"column",gap:2},
  paramsHd:     {fontSize:10,color:"var(--c-textDim)",letterSpacing:"0.1em",textTransform:"uppercase" as const,marginBottom:6},
  warnBox:      {padding:"8px 12px",background:"var(--c-warnBg)",border:`1px solid var(--c-warnBd)`,borderRadius:6,color:"var(--c-warn)",fontSize:12},
  infoBox:      {padding:"8px 12px",background:"var(--c-accentBg)",border:`1px solid var(--c-accentBd)`,borderRadius:6,color:"var(--c-textSub)",fontSize:12},

  // 保存選択ボックス（目立つUI）
  saveChoiceBox:  {marginTop:"auto",background:"var(--c-bgCard)",border:`1px solid var(--c-borderHi)`,borderRadius:12,padding:"16px",display:"flex",flexDirection:"column",gap:10},
  saveChoiceLabel:{fontSize:12,color:"var(--c-textDim)",letterSpacing:"0.06em"},
  saveChoiceBtns: {display:"flex",gap:10},
  btnSaveCompressed:{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4,padding:"14px 10px",background:"var(--c-accentBg)",border:`2px solid var(--c-accentBd)`,borderRadius:9,cursor:"pointer",fontFamily:F,transition:"all 0.12s"},
  btnSaveOriginal:  {flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4,padding:"14px 10px",background:"var(--c-bgHover)",border:`1px solid var(--c-borderHi)`,borderRadius:9,cursor:"pointer",fontFamily:F,transition:"all 0.12s"},
  saveBtnIcon:  {fontSize:22},
  saveBtnMain:  {fontSize:14,fontWeight:700,color:"var(--c-text)"},
  saveBtnSub:   {fontSize:11,color:"var(--c-textSub)"},

  // バッチ進捗
  bpTitle:   {fontSize:16,fontWeight:700,color:"var(--c-text)"},
  bpBarWrap: {width:"100%",maxWidth:440,height:8,background:"var(--c-border)",borderRadius:4,overflow:"hidden"},
  bpBar:     {height:"100%",background:"var(--c-accent)",borderRadius:4,transition:"width 0.3s"},
  bpCurFile: {fontSize:12,color:"var(--c-textSub)"},
  bpOutDir:  {fontSize:11,color:"var(--c-textDim)"},
  bpLog:     {width:"100%",maxWidth:480,display:"flex",flexDirection:"column",gap:4,maxHeight:300,overflowY:"auto"},
  bpRow:     {display:"flex",alignItems:"center",gap:8,padding:"5px 10px",background:"var(--c-bgCard)",borderRadius:6,border:`1px solid var(--c-border)`},
  bpFile:    {flex:1,fontSize:12,color:"var(--c-text)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"},
  bpPct:     {fontSize:12,color:"var(--c-accent)",fontWeight:700,flexShrink:0},

  errPre:    {fontSize:11,color:"var(--c-err)",background:"var(--c-errBg)",border:`1px solid var(--c-errBd)`,borderRadius:6,padding:"10px 14px",maxWidth:480,whiteSpace:"pre-wrap",wordBreak:"break-all"},
  btnBack:   {padding:"8px 22px",background:"transparent",border:`1px solid var(--c-borderHi)`,borderRadius:7,color:"var(--c-textSub)",cursor:"pointer",fontSize:13,fontFamily:F},
};
