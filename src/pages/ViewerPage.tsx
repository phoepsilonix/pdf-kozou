// src/pages/ViewerPage.tsx — 簡易PDFビューワー
// 単一ファイル: ページサムネイル一覧 + 拡大表示
// 複数ファイル: 左ペインでファイル切り替え

import { useEffect, useState, useCallback, useRef } from "react";
import { renderPage, getPdfInfo, type PdfInfo } from "../lib/tauri";
import { Spinner, PageHeader, BtnBack } from "../components/common";
import { type FileEntry } from "../store/usePdfStore";
import { C, F } from "../lib/theme";

// ── 型 ───────────────────────────────────────────────────────────────────────

interface Props {
  // 単一ファイル時
  filePath?: string;
  pdfInfo?:  PdfInfo;
  // 複数ファイル時（バッチ）
  fileList?: FileEntry[];
}

// ── 定数 ─────────────────────────────────────────────────────────────────────

const THUMB_DPI  = 48;
const VIEW_DPI   = 150;

// ── コンポーネント ────────────────────────────────────────────────────────────

export function ViewerPage({ filePath, pdfInfo, fileList = [] }: Props) {
  // 複数ファイルモードか判定
  const isMulti = fileList.length > 1;

  // 選択中ファイル
  const [activeIdx,  setActiveIdx]  = useState(0);
  const [activeInfo, setActiveInfo] = useState<PdfInfo | null>(pdfInfo ?? null);
  const activePath = isMulti ? fileList[activeIdx]?.path : (filePath ?? "");

  // ファイル切り替え時にpdfInfo再取得
  useEffect(() => {
    if (!isMulti) { setActiveInfo(pdfInfo ?? null); return; }
    const path = fileList[activeIdx]?.path;
    if (!path) return;
    setActiveInfo(null);
    getPdfInfo(path).then(setActiveInfo).catch(() => setActiveInfo(null));
  }, [activeIdx, isMulti, fileList, pdfInfo]);

  const total = activeInfo?.page_count ?? 0;

  // サムネイルキャッシュ: path → pages[]
  const thumbCache = useRef<Map<string, (string|undefined)[]>>(new Map());
  const [thumbs,    setThumbs]    = useState<(string|undefined)[]>([]);
  const [viewPage,  setViewPage]  = useState(0);    // 拡大表示中ページ (0-indexed)
  const [viewImg,   setViewImg]   = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [zoom,      setZoom]      = useState(1.0);

  // サムネイル取得
  useEffect(() => {
    if (!activePath || !activeInfo) { setThumbs([]); return; }
    // キャッシュ確認
    const cached = thumbCache.current.get(activePath);
    if (cached) { setThumbs([...cached]); return; }
    let cancelled = false;
    const arr: (string|undefined)[] = new Array(activeInfo.page_count).fill(undefined);
    thumbCache.current.set(activePath, arr);
    setThumbs([]);
    (async () => {
      for (let i = 0; i < activeInfo.page_count; i++) {
        try {
          const b64 = await renderPage(activePath, i, THUMB_DPI);
          if (cancelled) return;
          arr[i] = b64;
          thumbCache.current.set(activePath, [...arr]);
          setThumbs([...arr]);
        } catch { /* skip */ }
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

  // 最初のページを自動表示
  useEffect(() => {
    if (total > 0) openPage(0);
  }, [activePath, total]);

  // キーボードナビ
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        const next = Math.min(viewPage + 1, total - 1);
        if (next !== viewPage) openPage(next);
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        const prev = Math.max(viewPage - 1, 0);
        if (prev !== viewPage) openPage(prev);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewPage, total, openPage]);

  // ── レンダリング ──────────────────────────────────────────────────────────

  if (!activeInfo) return <Spinner label="読み込み中…" />;

  const fname = activePath.split(/[/\\]/).pop() ?? "";

  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>ビューワー</span>
        <span style={s.fileSub} title={activePath}>{fname}</span>
        <span style={s.pageBadge}>{total}ページ</span>
        <div style={{ flex: 1 }} />
        {/* ズームコントロール */}
        <div style={s.zoomRow}>
          <button style={s.zoomBtn} onClick={() => setZoom(z => Math.max(0.3, z - 0.2))}>−</button>
          <span style={s.zoomVal}>{Math.round(zoom * 100)}%</span>
          <button style={s.zoomBtn} onClick={() => setZoom(z => Math.min(3.0, z + 0.2))}>＋</button>
          <button style={s.zoomBtnSm} onClick={() => setZoom(1.0)}>100%</button>
          <button style={s.zoomBtnSm} onClick={() => setZoom(0.7)}>全体</button>
        </div>
      </PageHeader>

      <div style={s.body}>
        {/* ── 左ペイン1: 複数ファイル一覧（マルチモード時のみ） ── */}
        {isMulti && (
          <div style={s.filePane}>
            <div style={s.filePaneHead}>ファイル ({fileList.length})</div>
            {fileList.map((f, i) => (
              <button key={f.id} style={{
                ...s.filePaneItem,
                ...(i === activeIdx ? s.filePaneItemOn : {}),
              }} onClick={() => { setActiveIdx(i); setZoom(1.0); }}>
                <span style={s.filePaneIcon}>📄</span>
                <div style={s.filePaneInfo}>
                  <span style={s.filePaneName}>{f.filename}</span>
                  <span style={s.filePaneMeta}>{f.pageCount}p</span>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* ── 左ペイン2: サムネイル一覧 ── */}
        <div style={s.thumbPane}>
          <div style={s.thumbPaneHead}>
            {viewPage + 1} / {total}
          </div>
          <div style={s.thumbList}>
            {Array.from({ length: total }, (_, i) => (
              <button
                key={i}
                style={{
                  ...s.thumbItem,
                  ...(i === viewPage ? s.thumbItemOn : {}),
                }}
                onClick={() => openPage(i)}
                title={`ページ ${i + 1}`}
              >
                {thumbs[i]
                  ? <img src={`data:image/jpeg;base64,${thumbs[i]}`}
                         style={s.thumbImg} alt="" />
                  : <div style={s.thumbPh} />}
                <span style={{ ...s.thumbN, ...(i === viewPage ? s.thumbNOn : {}) }}>
                  {i + 1}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* ── メインビュー ── */}
        <div style={s.mainView} tabIndex={0}>
          {viewLoading && (
            <div style={s.viewLoading}>
              <div style={s.viewSpinner} />
            </div>
          )}
          {!viewLoading && viewImg && (
            <div style={s.viewImgWrap}>
              <img
                src={`data:image/jpeg;base64,${viewImg}`}
                style={{
                  ...s.viewImg,
                  transform: `scale(${zoom})`,
                  transformOrigin: "top center",
                }}
                alt={`ページ ${viewPage + 1}`}
              />
            </div>
          )}
          {!viewLoading && !viewImg && (
            <div style={s.viewEmpty}>表示できません</div>
          )}

          {/* ページナビ */}
          <div style={s.pageNav}>
            <button style={s.pageNavBtn}
              disabled={viewPage === 0}
              onClick={() => openPage(viewPage - 1)}>
              ← 前
            </button>
            <span style={s.pageNavInfo}>{viewPage + 1} / {total}</span>
            <button style={s.pageNavBtn}
              disabled={viewPage >= total - 1}
              onClick={() => openPage(viewPage + 1)}>
              次 →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── スタイル ──────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root:     { display:"flex", flexDirection:"column", height:"100%", background:C.bg, color:C.text, fontFamily:F, overflow:"hidden" },
  title:    { fontSize:15, fontWeight:700, color:C.text },
  fileSub:  { fontSize:12, color:C.textSub, maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  pageBadge:{ padding:"2px 10px", background:C.bgCard, border:`1px solid ${C.border}`, borderRadius:12, fontSize:12, color:C.textSub },

  zoomRow:    { display:"flex", alignItems:"center", gap:5 },
  zoomBtn:    { width:28, height:28, display:"flex", alignItems:"center", justifyContent:"center", background:C.bgCard, border:`1px solid ${C.borderHi}`, borderRadius:6, cursor:"pointer", fontSize:16, color:C.text, fontFamily:F },
  zoomVal:    { fontSize:12, color:C.textSub, minWidth:38, textAlign:"center" as const },
  zoomBtnSm:  { padding:"4px 10px", background:C.bgCard, border:`1px solid ${C.borderHi}`, borderRadius:6, cursor:"pointer", fontSize:11, color:C.textSub, fontFamily:F },

  body:     { flex:1, display:"flex", overflow:"hidden" },

  // 複数ファイルペイン
  filePane:      { width:200, flexShrink:0, display:"flex", flexDirection:"column", borderRight:`1px solid ${C.border}`, overflow:"hidden" },
  filePaneHead:  { padding:"9px 12px", fontSize:11, color:C.textDim, letterSpacing:"0.08em", textTransform:"uppercase" as const, borderBottom:`1px solid ${C.border}`, flexShrink:0 },
  filePaneItem:  { display:"flex", alignItems:"center", gap:8, padding:"10px 12px", background:"transparent", border:"none", borderBottom:`1px solid ${C.border}`, cursor:"pointer", fontFamily:F, textAlign:"left" as const, transition:"background 0.1s" },
  filePaneItemOn:{ background:C.accentBg, borderLeft:`3px solid ${C.accent}` },
  filePaneIcon:  { fontSize:16, flexShrink:0 },
  filePaneInfo:  { flex:1, display:"flex", flexDirection:"column", gap:2, minWidth:0 },
  filePaneName:  { fontSize:12, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  filePaneMeta:  { fontSize:10, color:C.textSub },

  // サムネイルペイン
  thumbPane:     { width:110, flexShrink:0, display:"flex", flexDirection:"column", borderRight:`1px solid ${C.border}`, overflow:"hidden", background:C.bgCard },
  thumbPaneHead: { padding:"8px 6px", fontSize:11, color:C.textDim, textAlign:"center" as const, borderBottom:`1px solid ${C.border}`, flexShrink:0 },
  thumbList:     { flex:1, overflowY:"auto", display:"flex", flexDirection:"column", gap:4, padding:"8px 6px" },
  thumbItem:     { display:"flex", flexDirection:"column", alignItems:"center", gap:3, padding:"4px", background:"transparent", border:`1px solid transparent`, borderRadius:6, cursor:"pointer", transition:"all 0.1s", fontFamily:F },
  thumbItemOn:   { border:`1px solid ${C.accent}`, background:C.accentBg },
  thumbImg:      { width:88, height:"auto", display:"block", borderRadius:3, maxHeight:125, objectFit:"contain" as const },
  thumbPh:       { width:88, height:124, background:C.border, borderRadius:3 },
  thumbN:        { fontSize:10, color:C.textDim },
  thumbNOn:      { color:C.accent, fontWeight:700 },

  // メインビュー
  mainView:      { flex:1, display:"flex", flexDirection:"column", overflow:"hidden", position:"relative" as const, background:C.bg },
  viewLoading:   { flex:1, display:"flex", alignItems:"center", justifyContent:"center" },
  viewSpinner:   { width:32, height:32, border:`3px solid ${C.border}`, borderTop:`3px solid ${C.accent}`, borderRadius:"50%", animation:"spin 0.8s linear infinite" },
  viewImgWrap:   { flex:1, overflow:"auto", display:"flex", justifyContent:"center", padding:"24px", background:"#07100a" },
  viewImg:       { maxWidth:"100%", height:"auto", boxShadow:"0 4px 32px rgba(0,0,0,0.7)", borderRadius:2, display:"block" },
  viewEmpty:     { flex:1, display:"flex", alignItems:"center", justifyContent:"center", color:C.textDim, fontSize:14 },

  // ページナビ（下部）
  pageNav:     { flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", gap:16, padding:"10px", borderTop:`1px solid ${C.border}`, background:C.bgCard },
  pageNavBtn:  { padding:"6px 20px", background:C.accentBg, border:`1px solid ${C.accentBd}`, borderRadius:7, color:C.accent, cursor:"pointer", fontSize:13, fontFamily:F },
  pageNavInfo: { fontSize:13, color:C.textSub, minWidth:60, textAlign:"center" as const },
};
