// src/pages/TrimPage.tsx
import { useEffect, useState, useCallback } from "react";
import { invoke }          from "@tauri-apps/api/core";
import { TrimCanvas }      from "../components/trim/TrimCanvas";
import { TrimControls }    from "../components/trim/TrimControls";
import { CompressPage }    from "./CompressPage";
import { usePdfStore, type FileEntry } from "../store/usePdfStore";
import { useSaveDialog }   from "../hooks/useSaveDialog";
import { getTempPath, renderPage, trimPdf, getPdfInfo, type TrimMargins, type PdfInfo } from "../lib/tauri";
import { resolvePageSpec } from "../components/PageSelector";
import { C, F } from "../lib/theme";

interface Props {
  filePath:    string;
  pdfInfo:     PdfInfo;
  batchFiles?: FileEntry[];
}

const PREVIEW_DPI = 72;
const RESULT_DPI  = 96;
const THUMB_DPI   = 40;
const CANVAS_W    = 520;

type Phase = "edit" | "processing" | "result" | "error" | "compress" | "batchResult";
const zero = (): TrimMargins => ({ left:0, right:0, top:0, bottom:0 });

export function TrimPage({ filePath, pdfInfo, batchFiles }: Props) {
  console.log("[TrimPage] コンポーネントマウント開始");
  console.log("[TrimPage] isBatch:", !!batchFiles, "files length:", batchFiles?.length ?? 0);
  console.log("[TrimPage] pdfInfo:", pdfInfo);
  const isBatch = (batchFiles?.length ?? 0) > 1;
  if (isBatch) {
	  console.log("[TrimPage] → バッチモードへ");
	  return <TrimPageBatch files={batchFiles!} firstPdfInfo={pdfInfo} />;
  } else {
    console.log("[TrimPage] → 単体モードへ");
    return <TrimPageSingle filePath={filePath} pdfInfo={pdfInfo} />;
  }
}

// ページ指定を文字列に変換する関数（除外対応追加）
function pageSelectionToString(selection: PageSelection, totalPages: number): string | undefined {
  if (selection.type === "All") return undefined;

  if (selection.type === "Even") return "even";
  if (selection.type === "Odd") return "odd";

  if (selection.type === "Ranges" && selection.ranges) {
    // 通常の範囲指定
    return selection.ranges
      .map(([start, end]) => start === end ? start.toString() : `${start}-${end}`)
      .join(",");
  }

  // 除外指定の場合（仮に selection に exclude フィールドを追加する場合の例）
  // 実際には PageSelection に exclude を追加するか、別状態で管理
  // 例: excludePages: number[] = [2,5] として全ページから除外
  if (selection.excludePages && selection.excludePages.length > 0) {
    const includeSet = new Set(Array.from({length: totalPages}, (_, i) => i + 1));
    selection.excludePages.forEach(p => includeSet.delete(p));

    const includeList = Array.from(includeSet).sort((a,b) => a - b);
    if (includeList.length === 0) return undefined;  // 全除外なら全ページ？

    // 連続範囲にまとめる（効率化）
    const ranges: string[] = [];
    let start = includeList[0];
    let prev = start;
    for (let i = 1; i < includeList.length; i++) {
      if (includeList[i] !== prev + 1) {
        ranges.push(start === prev ? start.toString() : `${start}-${prev}`);
        start = includeList[i];
      }
      prev = includeList[i];
    }
    ranges.push(start === prev ? start.toString() : `${start}-${prev}`);
    return ranges.join(",");
  }

  return undefined;
}

// ── バッチトリム ──────────────────────────────────────────────────────────────
function TrimPageBatch({ files, firstPdfInfo }: { files: FileEntry[]; firstPdfInfo: PdfInfo }) {
  const { setError } = usePdfStore();
  const [trimMargins, setTrimMargins] = useState<TrimMargins>(zero());
  const [trimPages,   setTrimPages]   = useState<any>({ type:"All" });
  const [outDir,      setOutDir]      = useState("");
  const [phase,       setPhase]       = useState<"edit"|"processing"|"result">("edit");
  const [progress, setProgress] = useState<{ current: number; done: { f: string }[]; errors: { f: string; msg: string }[] }>(
    { current: 0, done: [], errors: [] }
  );
  const [previewIdx, setPreviewIdx] = useState(0);
  const [previewPage, setPreviewPage] = useState(0);
  const [pageImage, setPageImage] = useState("");
  const [curPageInfo, setCurPageInfo] = useState<PdfInfo | null>(null);
  const [extractSpec, setExtractSpec] = useState("");
  const [trimPageSpec, setTrimPageSpec] = useState("");

  const [batchThumbs, setBatchThumbs] = useState<(string | undefined)[]>([]);
  
  const currentPage = firstPdfInfo.pages[previewPage] ?? { w: 595, h: 842, rotate: 0 };
  const pageW = currentPage.w;
  const pageH = currentPage.h;

  // バッチ全体のサムネイル（先頭ページ）
  useEffect(() => {
    usePdfStore.getState().resetTrimState();
    let cancelled = false;
    setBatchThumbs(new Array(files.length).fill(undefined));
    (async () => {
      for (let i = 0; i < files.length; i++) {
        try {
          const b64 = await renderPage(files[i].path, 0, 56);
          if (cancelled) return;
          setBatchThumbs((p) => { const a = [...p]; a[i] = b64; return a; });
        } catch {}
      }
    })();
    return () => { cancelled = true; };
  }, [files]);

  // プレビュー対象ファイルの情報 + 画像取得
  useEffect(() => {
    const path = files[previewIdx]?.path;
    if (!path) return;

    let cancelled = false;

    // PDF情報取得
    getPdfInfo(path)
      .then((info) => { if (!cancelled) setCurPageInfo(info); })
      .catch(() => {});

    // プレビュー画像（現在のプレビューページ）
    setPageImage("");
    renderPage(path, previewPage, PREVIEW_DPI)
      .then((b64) => { if (!cancelled) setPageImage(b64); })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [files, previewIdx, previewPage]);

  const pickDir = useCallback(async () => {
    const dir = await invoke<string | null>("pick_output_dir").catch(() => null);
    if (dir) {
      // 必要なら lastSaveDir を Zustand に保存
      usePdfStore.getState().setLastSaveDir(dir);
    }
  }, []);

  const handleExecute = useCallback(async () => {
    if (!usePdfStore.getState().lastSaveDir) {
      await pickDir();
      return;
    }

    setPhase("processing");
    const prog = { current: 0, done: [] as { f: string }[], errors: [] as { f: string; msg: string }[] };
    setProgress({ ...prog });

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      prog.current = i + 1;
      setProgress({ ...prog });

      try {
        const out = `${usePdfStore.getState().lastSaveDir}/${f.filename.replace(/\.pdf$/i, "")}_trimmed.pdf`;

        await trimPdf(f.path, out, trimMargins, trimPages, extractSpec);  // ← Zustand の最新状態を使う
        prog.done.push({ f: f.filename });
      } catch (e) {
        prog.errors.push({ f: f.filename, msg: String(e) });
      }
      setProgress({ ...prog });
    }

    setPhase("result");
  }, [files, trimMargins, trimPages, pickDir]);

  // 処理中画面
  if (phase === "processing") {
    const pct = progress.current / files.length * 100;
    return (
      <div style={b.center}>
        <div style={b.title}>トリミング中… {progress.current}/{files.length}</div>
        <div style={b.barWrap}>
          <div style={{ ...b.bar, width: `${pct}%` }} />
        </div>
        <div style={b.log}>
          {progress.done.map((d, i) => (
            <div key={i} style={b.logRow}>
              <span style={{ color: "var(--c-accent)" }}>✓</span>
              <span style={b.logFile}>{d.f}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // 結果画面
  if (phase === "result") {
    return (
      <div style={b.center}>
        <span style={{ fontSize: 56, color: progress.errors.length ? "var(--c-warn)" : "var(--c-accent)" }}>
          {progress.errors.length ? "⚠" : "✓"}
        </span>
        <div style={b.title}>バッチトリミング完了 — {progress.done.length}件</div>
        <div style={{ fontSize: 12, color: "var(--c-textSub)" }}>{usePdfStore.getState().lastSaveDir}</div>
        <div style={b.log}>
          {progress.done.map((d, i) => (
            <div key={i} style={b.logRow}>
              <span style={{ color: "var(--c-accent)" }}>✓</span>
              <span style={b.logFile}>{d.f}</span>
            </div>
          ))}
          {progress.errors.map((e, i) => (
            <div
              key={`e${i}`}
              style={{
                ...b.logRow,
                background: "var(--c-errBg)",
                borderColor: "var(--c-errBd)",
              }}
            >
              <span style={{ color: "var(--c-err)" }}>✕</span>
              <span style={b.logFile}>{e.f}</span>
              <span style={{ fontSize: 10, color: "var(--c-err)" }}>{e.msg}</span>
            </div>
          ))}
        </div>
        <button
          style={b.backBtn}
          onClick={() => {
            setPhase("edit");
          }}
        >
          ← 設定に戻る
        </button>
      </div>
    );
  }

  // 編集画面
  const curFile = files[previewIdx];
  const curPages = curFile?.pageCount ?? 1;
  const curW = curPageInfo?.pages[previewPage]?.w ?? 595;
  const curH = curPageInfo?.pages[previewPage]?.h ?? 842;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--c-bg)", color: "var(--c-text)", fontFamily: F, overflow: "hidden" }}>
      {/* ヘッダー */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", borderBottom: `1px solid var(--c-border)`, flexShrink: 0 }}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>トリミング — {files.length}件バッチ</span>
        <span style={{ fontSize: 13, color: "var(--c-textSub)" }}>同じ余白設定を全ファイルに適用</span>
      </div>

      {/* 本体 */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* 左: ファイル一覧 */}
        <div style={{ width: 172, flexShrink: 0, borderRight: `1px solid var(--c-border)`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--c-textDim)", borderBottom: `1px solid var(--c-border)`, background: "var(--c-bgCard)" }}>
            プレビュー対象
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {files.map((f, i) => (
              <button
                key={f.id}
                style={{
                  ...s.thumb,
                  ...(previewIdx === i ? s.thumbOn : {}),
                }}
                onClick={() => setPreviewIdx(i)}
              >
                {batchThumbs[i] ? (
                  <img src={`data:image/jpeg;base64,${batchThumbs[i]}`} style={s.thumbImg} alt="" />
                ) : (
                  <div style={s.thumbPh} />
                )}
                <span style={s.thumbN}>{f.filename}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 中央: キャンバス */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", padding: "16px 20px", gap: 12 }}>
          <div style={s.canvasWrap}>
            {pageImage ? (
              <TrimCanvas
                pageImageB64={pageImage}
                pageWidthPt={curW}
                pageHeightPt={curH}
                margins={trimMargins}          // ← Zustand から
                onChange={setTrimMargins}      // ← Zustand に更新
                displayWidth={CANVAS_W}
              />
            ) : (
              <div style={s.ph}>ページ読み込み中...</div>
            )}
          </div>
        </main>

        {/* 右: コントロール */}
        <aside style={s.panel}>
          <TrimControls
            margins={trimMargins}
            pageW={curW}
            pageH={curH}
            pages={trimPages}
            totalPages={curPages}
            onMargins={setTrimMargins}
            onPages={setTrimPages}
            onApply={handleExecute}
            onReset={() => setTrimMargins(zero())}
            processing={phase !== "edit"}
            trimPageSpec={trimPageSpec}
            onTrimPageSpec={setTrimPageSpec}
            extractSpec={extractSpec}
            onExtract={setExtractSpec}
          />
        </aside>
      </div>
    </div>
  );
}

// ── 単体トリム ────────────────────────────────────────────────────────────────
export function TrimPageSingle({ filePath, pdfInfo }: { filePath: string; pdfInfo: PdfInfo }) {
  // Zustand から状態を直接取得・更新
  const {
    trimMargins,
    trimPages,
    setTrimMargins,
    setTrimPages,
    previewPage,
    setPreviewPage,
    setError,
  } = usePdfStore();

  const [phase, setPhase] = useState<Phase>("edit");
  const [pageImage, setPageImage] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [extractSpec,  setExtractSpec]  = useState("");
  const [isSaving,     setIsSaving]     = useState(false);
  const [resultImgs, setResultImgs] = useState<string[]>([]);
  const [trimPageSpec, setTrimPageSpec] = useState("");
  const [outTmp] = useState("");

  const { pickSave } = useSaveDialog();

  const currentPage = pdfInfo.pages[previewPage] ?? { w: 595, h: 842, rotate: 0 };
  const pageW = currentPage.w;
  const pageH = currentPage.h;

  // プレビューページ変更時に画像を再取得
  useEffect(() => {
    //usePdfStore.getState().resetTrimState();
    renderPage(filePath, previewPage, PREVIEW_DPI)
      .then(setPageImage)
      .catch(() => setPageImage(""));
  }, [filePath, previewPage]);

  const handleExecute = useCallback(async () => {
    setPhase("processing");
    setResultImgs([]);
    try {
      const outTmp = await getTempPath("trimmed_tmp.pdf");

      // JSON payload を作成
      const request = {
        input: filePath,
        output: outTmp,
        margins: trimMargins,
        page_selection: trimPages,          // { type: "All" | "Even" | "Odd" | "Ranges", ranges?: [[start,end]] }
        extract_spec: extractSpec || undefined  // "" なら undefined（全ページ）
      };
      console.log("[DEBUG] trim_pdf に渡す payload:", request);
      const res = await trimPdf(request);
      console.log("[DEBUG] trim_pdf 結果:", res);
      const res2 = await trimPdf(filePath, outTmp, trimMargins, trimPages, extractSpec);  // ← Zustand の最新状態を使う
      console.log("[DEBUG] trim_pdf 結果:", res2);
      //filePath, outTmp, trimMargins, trimPages, extractSpec);
      
      // プレビュー用に結果画像を取得（任意で最大6ページ）
      const n = Math.min(6, pdfInfo.page_count);
      const imgs: string[] = [];
      for (let i = 0; i < n; i++) {
        const b64 = await renderPage(outTmp, i, RESULT_DPI);
        imgs.push(b64);
      }
      setResultImgs(imgs);  // 必要なら状態追加
      setSavedPath(outTmp);
      setPhase("result");
    } catch (e) {
      console.error("[ERROR] trimPdf エラー:", e);
      setErrMsg(String(e));
      setPhase("error");
      setError(String(e));
    }
  }, [filePath, trimMargins, trimPages, extractSpec, pdfInfo.page_count, setError]);

  const handleSave = async () => {
    const saved = await pickSave(savedPath, {
      defaultName: filePath.replace(/\.pdf$/i, "_trimmed.pdf"),
    });
    if (saved) {
      setSavedPath(saved);
    }
  };

  if (phase === "processing") return (
    <div style={s.center}>
      <div style={s.spinner}/>
      <span style={s.centSub}>トリミング + プレビュー生成中…</span>
    </div>
  );

  if (phase === "error") return (
    <div style={s.center}>
      <span style={{fontSize:40,color:"var(--c-err)"}}>✕</span>
      <span style={{fontSize:16,fontWeight:700,color:"var(--c-err)"}}>エラー</span>
      <pre style={s.errMsg}>{errMsg}</pre>
      <button style={s.errBtn} onClick={()=>{setPhase("edit");setErrMsg("");}}>← 設定に戻る</button>
    </div>
  );

  if (phase === "compress") return (
    <CompressPage filePath={filePath} pdfInfo={pdfInfo} sourceFile={outTmp||undefined} onDone={()=>setPhase("result")}/>
  );

  if (phase === "result") return (
    <ResultView images={resultImgs} pageCount={pdfInfo.page_count}
      onSave={handleSave} onBack={()=>{setPhase("edit");setResultImgs([]);setErrMsg("");}}
      onCompress={()=>setPhase("compress")} isSaving={isSaving}/>
  );

  return (
    <div style={s.root}>
<div style={s.sidebar}>
  <div style={s.sbHead}>
    <span style={s.sbTitle}>ページ一覧</span>
    <span style={s.sbCount}>{pdfInfo.page_count} ページ</span>
  </div>
  <div style={s.thumbList}>
    {Array.from({ length: pdfInfo.page_count }, (_, i) => (
      <button
        key={i}
        style={{
          ...s.thumb,
          ...(previewPage === i ? s.thumbOn : {}),
        }}
        onClick={() => setPreviewPage(i)}
      >
        {/* ここで thumbImages を使わず、pageImage をプレビューとして表示（またはサムネイルを別途ロード） */}
        {i === previewPage && pageImage ? (
          <img
            src={`data:image/jpeg;base64,${pageImage}`}
            style={s.thumbImg}
            alt={`Page ${i + 1}`}
          />
        ) : (
          <div style={s.thumbPh}>ページ {i + 1}</div>
        )}
        <span style={s.thumbN}>{i + 1}</span>
      </button>
    ))}
  </div>
</div>

      <main style={s.main}>
        <div style={s.mainHead}>
          <span style={s.mainTitle}>トリミング設定</span>
          <span style={s.pageInd}>{previewPage+1} / {pdfInfo.page_count} ページ</span>
        </div>
        <div style={s.canvasWrap}>
          {pageImage ? (
	        <TrimCanvas
                  pageImageB64={pageImage}
                  pageWidthPt={pageW}
                  pageHeightPt={pageH}
                  margins={trimMargins}
                  onChange={setTrimMargins}  // Zustand に直接更新
                  displayWidth={CANVAS_W}
                />

	  ) : (
	      <div style={{...s.ph, width:CANVAS_W, height:Math.round(CANVAS_W*pageH/pageW)}}>
                <div style={s.spinner}/>
                <span style={s.centSub}>読み込み中…</span>
              </div>
	  )}
        </div>
      </main>

          <aside style={s.panel}>
            <TrimControls
              margins={trimMargins}
              pageW={pageW}
              pageH={pageH}
              pages={trimPages}
              totalPages={pdfInfo.page_count}
	      onMargins={setTrimMargins}     // Zustand 更新
              onPages={setTrimPages}         // Zustand 更新
              onApply={handleExecute}
              onReset={() => setTrimMargins(zero())}
              processing={phase !== "edit"}
              trimPageSpec={trimPageSpec}
              onTrimPageSpec={setTrimPageSpec}
              extractSpec={extractSpec}
              onExtract={setExtractSpec}
            />
          </aside>
    </div>
  );
}

// ── 結果ビュー ────────────────────────────────────────────────────────────────
function ResultView({ images, pageCount, onSave, onBack, onCompress, isSaving }: {
  images:string[]; pageCount:number; onSave:()=>void; onBack:()=>void; onCompress:()=>void; isSaving:boolean;
}) {
  return (
    <div style={r.root}>
      <div style={r.header}>
        <button style={r.btnBack} onClick={onBack}>← 設定に戻る</button>
        <span style={r.title}>トリミング結果確認</span>
        <span style={r.sub}>{pageCount}ページ（先頭{images.length}ページ表示）</span>
        <div style={{flex:1}}/>
        <button style={r.btnCompress} onClick={onCompress}>⚡ 続けて圧縮</button>
        <button style={{...r.btnSave,...(isSaving?r.dis:{})}} onClick={onSave} disabled={isSaving}>
          {isSaving?"保存中…":"💾 PDFを保存"}
        </button>
      </div>

      <div style={r.gallery}>
        {images.map((b64,i) => (
          <div key={i} style={r.card}>
            <span style={r.pageN}>{i+1} ページ</span>
            {b64
              ? <img src={`data:image/jpeg;base64,${b64}`} style={r.img} alt=""/>
              : <div style={r.imgPh}>プレビュー失敗</div>}
          </div>
        ))}
        {pageCount > images.length && (
          <div style={r.more}>… 他 {pageCount-images.length} ページ</div>
        )}
      </div>

      <div style={r.footer}>
        <button style={r.btnBack} onClick={onBack}>← 設定に戻る</button>
        <button style={r.btnCompress} onClick={onCompress}>⚡ 続けて圧縮</button>
        <button style={{...r.btnSave,...(isSaving?r.dis:{})}} onClick={onSave} disabled={isSaving}>
          {isSaving?"保存中…":"💾 PDFを保存"}
        </button>
      </div>
    </div>
  );
}

// ── スタイル ─────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root:    { display:"flex", height:"100%", background:"var(--c-bg)", color:"var(--c-text)", fontFamily:F, overflow:"hidden" },
  center:  { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:18, background:"var(--c-bg)" },
  spinner: { width:32, height:32, border:`3px solid var(--c-border)`, borderTop:`3px solid var(--c-accent)`, borderRadius:"50%", animation:"spin 0.8s linear infinite" },
  centSub: { color:"var(--c-textSub)", fontSize:13 },

  sidebar:  { width:128, flexShrink:0, display:"flex", flexDirection:"column", background:"var(--c-bgCard)", borderRight:`1px solid var(--c-border)`, overflow:"hidden" },
  sbHead:   { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 10px 7px", borderBottom:`1px solid var(--c-border)` },
  sbTitle:  { fontSize:10, color:"var(--c-textDim)", letterSpacing:"0.1em", textTransform:"uppercase" },
  sbCount:  { fontSize:10, color:"var(--c-textDim)" },
  thumbList:{ flex:1, overflowY:"auto", padding:"6px 5px", display:"flex", flexDirection:"column", gap:5 },
  thumb:    { display:"flex", flexDirection:"column", alignItems:"center", gap:3, padding:"5px 4px", borderRadius:6, border:"1px solid transparent", background:"transparent", cursor:"pointer", transition:"all 0.12s" },
  thumbOn:  { borderColor:"var(--c-accent)", background:"var(--c-accentBg)" },
  thumbImg: { width:104, height:"auto", borderRadius:2, display:"block" },
  thumbPh:  { width:104, height:140, background:"var(--c-border)", borderRadius:2 },
  thumbN:   { fontSize:10, color:"var(--c-textDim)" },

  main:      { flex:1, display:"flex", flexDirection:"column", overflow:"hidden", padding:"16px 20px", gap:12 },
  mainHead:  { display:"flex", alignItems:"center", gap:12 },
  mainTitle: { fontSize:15, fontWeight:600, color:"var(--c-text)" },
  pageInd:   { fontSize:12, color:"var(--c-textSub)" },
  canvasWrap:{ flex:1, overflow:"auto", display:"flex", alignItems:"flex-start", justifyContent:"center" },
  ph:        { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"var(--c-bgCard)", borderRadius:8, gap:12 },
  panel:     { width:280, flexShrink:0, borderLeft:`1px solid var(--c-border)`, overflow:"hidden" },

  errMsg: { fontSize:12, color:"var(--c-err)", background:"var(--c-errBg)", border:`1px solid var(--c-errBd)`, borderRadius:6, padding:"12px 16px", maxWidth:480, whiteSpace:"pre-wrap", wordBreak:"break-all" },
  errBtn: { padding:"8px 22px", background:"transparent", border:`1px solid var(--c-errBd)`, borderRadius:7, color:"var(--c-err)", cursor:"pointer", fontSize:13, fontFamily:F },
};

const r: Record<string, React.CSSProperties> = {
  root:       { display:"flex", flexDirection:"column", height:"100%", background:"var(--c-bg)", color:"var(--c-text)", fontFamily:F },
  header:     { display:"flex", alignItems:"center", gap:10, padding:"12px 20px", borderBottom:`1px solid var(--c-border)`, flexShrink:0 },
  btnBack:    { padding:"6px 14px", background:"transparent", border:`1px solid var(--c-borderHi)`, borderRadius:6, color:"var(--c-textSub)", cursor:"pointer", fontSize:13, fontFamily:F },
  btnCompress:{ padding:"8px 18px", background:"var(--c-accentBg)", border:`1px solid var(--c-accentBd)`, borderRadius:7, color:"var(--c-accent)", fontWeight:600, cursor:"pointer", fontSize:13, fontFamily:F },
  btnSave:    { padding:"9px 22px", background:"var(--c-accentBg)", border:`2px solid var(--c-accentBd)`, borderRadius:7, color:"var(--c-accent)", fontWeight:700, cursor:"pointer", fontSize:14, fontFamily:F },
  dis:        { opacity:0.4, cursor:"not-allowed" },
  title:      { fontSize:15, fontWeight:600, color:"var(--c-text)" },
  sub:        { fontSize:12, color:"var(--c-textSub)" },
  gallery:    { flex:1, overflowY:"auto", display:"flex", flexWrap:"wrap", gap:20, padding:24, alignContent:"flex-start", justifyContent:"center" },
  card:       { display:"flex", flexDirection:"column", alignItems:"center", gap:8, background:"var(--c-bgCard)", border:`1px solid var(--c-border)`, borderRadius:9, padding:14 },
  pageN:      { fontSize:11, color:"var(--c-textSub)" },
  img:        { maxWidth:290, maxHeight:390, display:"block", borderRadius:4 },
  imgPh:      { width:200, height:260, background:"var(--c-bgHover)", borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center", color:"var(--c-textDim)", fontSize:12 },
  more:       { display:"flex", alignItems:"center", justifyContent:"center", color:"var(--c-textDim)", fontSize:13, padding:"30px 20px" },
  footer:     { display:"flex", justifyContent:"flex-end", gap:10, padding:"12px 20px", borderTop:`1px solid var(--c-border)`, flexShrink:0 },
};

const b: Record<string, React.CSSProperties> = {
  center:  { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:14, background:"var(--c-bg)", padding:32 },
  title:   { fontSize:17, fontWeight:700, color:"var(--c-text)" },
  barWrap: { width:"100%", maxWidth:460, height:8, background:"var(--c-border)", borderRadius:4, overflow:"hidden" },
  bar:     { height:"100%", background:"var(--c-accent)", borderRadius:4, transition:"width 0.3s" },
  log:     { width:"100%", maxWidth:460, display:"flex", flexDirection:"column", gap:5, maxHeight:300, overflowY:"auto" },
  logRow:  { display:"flex", alignItems:"center", gap:9, padding:"6px 10px", background:"var(--c-bgCard)", borderRadius:6, border:`1px solid var(--c-border)` },
  logFile: { flex:1, fontSize:12, color:"var(--c-text)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  backBtn: { padding:"9px 26px", background:"transparent", border:`1px solid var(--c-borderHi)`, borderRadius:7, color:"var(--c-textSub)", cursor:"pointer", fontSize:13, fontFamily:F, marginTop:8 },
};
