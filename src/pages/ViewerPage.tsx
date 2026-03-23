// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/pages/ViewerPage.tsx
import { useEffect, useState, useCallback, useRef } from "react";
import { renderPage, getPdfInfo, type PdfInfo } from "../lib/tauri";
import { Spinner, PageHeader } from "../components/common";
import { type FileEntry } from "../store/usePdfStore";
import { F } from "../lib/theme";
import * as pdfjsLib from "pdfjs-dist";
import { convertFileSrc } from "@tauri-apps/api/core";

// テキストレイヤー用の標準CSSをインポート
import "pdfjs-dist/web/pdf_viewer.css";

// ワーカーの設定
const workerSrc = window.location.protocol === 'http:' 
  ? '/pdf.worker.min.mjs' 
  : 'asset://localhost/pdfjs/build/pdf.worker.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

interface Props {
  filePath?: string;
  pdfInfo?: PdfInfo;
  fileList?: FileEntry[];
}

const THUMB_DPI = 52;
const VIEW_DPI = 1.5; // PDF.jsの基本スケール

function pageAspect(info: PdfInfo | null, pageIdx: number): number {
  if (!info || !info.pages[pageIdx]) return 1 / 1.414;
  const p = info.pages[pageIdx];
  const r = (p as any).rotate ?? 0;
  if (r === 90 || r === 270) return p.h / p.w;
  return p.w / p.h;
}

export function ViewerPage({ filePath, pdfInfo, fileList = [] }: Props) {
  const isMulti = fileList.length > 1;
  const [activeIdx, setActiveIdx] = useState(0);
  const [activeInfo, setActiveInfo] = useState<PdfInfo | null>(pdfInfo ?? null);
  const [pdfDoc, setPdfDoc] = useState<any>(null); // useRefからuseStateに変更
  useEffect(() => {
    if (filePath) {
      // PDF読み込みロジックを実行
    }
  }, [filePath]);

  // 修正：単一ファイルの場合でも確実にパスを取得する
  const activePath = isMulti 
    ? (fileList[activeIdx]?.path || "") 
    : (filePath || (fileList.length > 0 ? fileList[0].path : ""));

  const [viewPage, setViewPage] = useState(0);
  const [viewLoading, setViewLoading] = useState(false);
  const [zoom, setZoom] = useState(1.0);
  const [total, setTotal] = useState(0);
  const [fileCoverThumbs, setFileCoverThumbs] = useState<Map<string, string>>(new Map());

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const pdfDocRef = useRef<any>(null);
  const renderTaskRef = useRef<any>(null);

  // PDF.js描画用のRef
  const scrollRef = useRef<HTMLDivElement>(null);

  // サムネイルキャッシュ（既存の画像ベースロジックを維持 [cite: 11, 12]）
  const thumbCache = useRef<Map<string, (string | undefined)[]>>(new Map());
  const [thumbs, setThumbs] = useState<(string | undefined)[]>([]);
  const LIST_THUMB_DPI = 24; // リスト用は低解像度でOK

// 1. ファイル情報・ページ総数の管理
  useEffect(() => {
    if (!isMulti) {
      if (pdfInfo) {
        setActiveInfo(pdfInfo);
        setTotal(pdfInfo.page_count);
      } else if (activePath) {
        getPdfInfo(activePath).then(info => {
          setActiveInfo(info);
          setTotal(info.page_count);
        });
      }
      return;
    }
    const path = fileList[activeIdx]?.path;
    if (path) {
      getPdfInfo(path).then(info => {
        setActiveInfo(info);
        setTotal(info.page_count);
      });
    }
  }, [activeIdx, isMulti, filePath, pdfInfo, fileList]);

// 2. メインビュー用のPDF読み込み（ドキュメントの保持）
  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;
    
    (async () => {
      try {
        const url = convertFileSrc(activePath);
        const loadingTask = pdfjsLib.getDocument(url);
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        
        pdfDocRef.current = pdf;
        // ドキュメントがロードされたら描画を実行
        renderPdfPage();
      } catch (e) {
        console.error("PDF load error:", e);
      }
    })();
    
    return () => { cancelled = true; };
  }, [activePath]);

  useEffect(() => {
    // Propsで渡されなかった場合のみ取得、ある場合はそれを使う
    if (!pdfInfo && filePath) {
      getPdfInfo(filePath).then(setActiveInfo(pdfInfo));
    } else {
      setActiveInfo(pdfInfo || null);
    }
  }, [filePath, pdfInfo]);

// 3. 描画ロジック
  const renderPdfPage = useCallback(async () => {
    // pdfDocRef.current が無い場合は何もしない
    if (!pdfDocRef.current || !canvasRef.current) return;
    
    setViewLoading(true);
    try {
      const pdf = pdfDocRef.current;
      const page = await pdf.getPage(viewPage + 1);
      const viewport = page.getViewport({ scale: zoom * VIEW_DPI });

      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d')!;
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
      }

      const renderContext = { canvasContext: ctx, viewport: viewport };
      renderTaskRef.current = page.render(renderContext);
      await renderTaskRef.current.promise;
      renderTaskRef.current = null;

      if (textLayerRef.current) {
        textLayerRef.current.innerHTML = '';
        textLayerRef.current.style.height = `${viewport.height}px`;
        textLayerRef.current.style.width = `${viewport.width}px`;
        const textContent = await page.getTextContent();
        const textLayer = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayerRef.current,
          viewport: viewport,
        });
        await textLayer.render();
      }
    } catch (e: any) {
      if (e.name !== "RenderingCancelledException") console.error(e);
    } finally {
      setViewLoading(false);
    }
  }, [viewPage, zoom]);

  // ページやズームが変わった際にも再描画
  useEffect(() => {
    if (pdfDocRef.current) renderPdfPage();
  }, [viewPage, zoom, renderPdfPage]);

  useEffect(() => {
    renderPdfPage();
  }, [renderPdfPage]);

  // --- 追加: ファイルリストの各表紙サムネイルを取得するエフェクト ---
  useEffect(() => {
    if (fileList.length === 0) return;

   const loadCovers = async () => {
      const newCovers = new Map(fileCoverThumbs);
      let changed = false;

      for (const f of fileList) {
        if (!newCovers.has(f.path)) {
          try {
            // 各ファイルの0ページ目をサムネイルとして取得
            const b64 = await renderPage(f.path, 0, THUMB_DPI);
            newCovers.set(f.path, b64);
            changed = true;
          } catch (e) {
            console.error(`Failed to load cover for ${f.filename}`, e);
          }
        }
      }

      if (changed) {
        setFileCoverThumbs(new Map(newCovers));
      }
    };

    loadCovers();
  }, [fileList]);

  // 4. サムネイル一覧の画像レンダリング (既存のrenderPageを使用 [cite: 14, 15, 16])
  useEffect(() => {
    if (!activePath || !activeInfo) {
      setThumbs([]);
      return;
    }
    const cached = thumbCache.current.get(activePath);
    if (cached) {
      setThumbs([...cached]);
    } else {
      const arr = new Array(activeInfo.page_count).fill(undefined);
      thumbCache.current.set(activePath, arr);
      setThumbs([]);
    }
    let cancelled = false;
    (async () => {
      const cur = thumbCache.current.get(activePath)!;
      for (let i = 0; i < activeInfo.page_count; i++) {
        if (cur[i]) continue;
        try {
          const b64 = await renderPage(activePath, i, THUMB_DPI);
          if (cancelled) return;
          cur[i] = b64;
          setThumbs([...cur]);
        } catch {}
      }
    })();
    return () => { cancelled = true; };
  }, [activePath, activeInfo]);

  const openPage = (idx: number) => setViewPage(idx);

if (!activeInfo && !viewLoading) return <Spinner label="読み込み中…" />;
  const fname = activePath.split(/[/\\]/).pop() ?? "";
  const THUMB_W = 104;

return (
    <div style={s.root}>
      {/* PageHeader などはそのまま */}
      <div style={s.body}>
        {/* 左ペイン: ファイルリスト表示の修正 */}
{/* 左ペイン: ファイルリスト表示の修正 */}
        {isMulti && (
          <div style={s.filePane}>
            <div style={s.paneHead}>ファイル ({fileList.length})</div>
            <div style={{ flex: 1, overflowY: "auto" }}>
{fileList.map((f, i) => {
  const cover = fileCoverThumbs.get(f.path);
  return (
    <button
      key={f.id}
      style={{ ...s.filePaneItem, ...(i === activeIdx ? s.filePaneItemOn : {}) }}
      onClick={() => {
        setActiveIdx(i);
        setViewPage(0);
        pdfDocRef.current = null;
      }}
    >
      {/* サムネイル：サイズを小さく固定 */}
      <div style={s.filePaneThumbBox}>
        {cover ? (
          <img src={`data:image/jpeg;base64,${cover}`} style={s.filePaneThumbImg} alt="" />
        ) : (
          <span style={s.filePaneIcon}>📄</span>
        )}
      </div>

      {/* テキスト情報：はみ出し防止（ellipsis） */}
      <div style={s.filePaneInfo}>
        <div style={s.filePaneName} title={f.filename}>{f.filename || "無題"}</div>
        <div style={s.filePaneMeta}>{f.pageCount}p</div>
      </div>
    </button>
  );
})}            </div>
          </div>
        )}
        {/* 中ペイン: サムネイル一覧 (既存の画像ベース [cite: 39-50]) */}
        <div style={s.thumbPane}>
          <div style={s.paneHead}>{viewPage + 1} / {total}</div>
          <div style={s.thumbList}>
            {Array.from({ length: total }, (_, i) => {
              const aspect = pageAspect(activeInfo, i);
              const th = Math.round(THUMB_W / aspect);
              return (
                <button key={i} style={{ ...s.thumbItem, ...(i === viewPage ? s.thumbItemOn : {}) }} onClick={() => openPage(i)}>
                  <div style={{ width: THUMB_W, height: th, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", background: "var(--c-bg)", borderRadius: 2 }}>
                    {thumbs[i] ? (
                      <img src={`data:image/jpeg;base64,${thumbs[i]}`} style={{ maxWidth: THUMB_W, maxHeight: th, objectFit: "contain" }} alt="" />
                    ) : (
                      <div style={{ width: THUMB_W, height: th, background: "var(--c-border)" }} />
                    )}
                  </div>
                  <span style={{ ...s.thumbN, ...(i === viewPage ? s.thumbNOn : {}) }}>{i + 1}</span>
                </button>
              );
            })}
          </div>
        </div>

 {/* メインビュー */}
        <div style={s.mainView}>
          <div ref={scrollRef} style={s.viewScroll}>
            <div style={s.viewInner}>
              <div style={{ position: 'relative', boxShadow: "0 4px 32px rgba(0,0,0,0.7)", visibility: viewLoading ? 'hidden' : 'visible' }}>
                <canvas ref={canvasRef} />
                <div ref={textLayerRef} className="textLayer" style={s.textLayerStyle} />
              </div>
              {viewLoading && <div style={s.viewCenter}><div style={s.viewSpinner} /></div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// スタイル定義（s）は既存のものを適宜補完してください
const s: Record<string, React.CSSProperties> = {
  root: { height: "100%", display: "flex", flexDirection: "column", background: "var(--c-bg)" },
  body: { flex: 1, display: "flex", overflow: "hidden" },
  filePane: { width: 120, borderRight: "1px solid var(--c-border)", background: "var(--c-bgSub)", overflowY: "auto" },
  fileItem: { padding: "8px", fontSize: "11px", cursor: "pointer", borderBottom: "1px solid var(--c-border)" },
  fileItemActive: { background: "var(--c-accentBg)", color: "var(--c-accent)", fontWeight: "bold" },
  thumbPane: { width: 140, borderRight: "1px solid var(--c-border)", overflowY: "auto", padding: "10px" },
  thumbItem: { display: "flex", flexDirection: "column", alignItems: "center", marginBottom: "15px", background: "none", border: "2px", borderStyle: "solid", borderColor: "transparent", cursor: "pointer" },
  thumbItemOn: { borderColor: "var(--c-accent)" },
  textLayerStyle: {
    position: 'absolute',
    top: 0,
    left: 0,
    overflow: 'hidden',
    lineHeight: 1,
    unicodeBidi: 'plaintext'
  },
filePane: {
    width: 220, // 左ペイン自体の幅を固定
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    borderRight: "1px solid var(--c-border)",
    background: "var(--c-bgSide)",
  },
  filePaneItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 12px",
    width: "100%",
    background: "transparent",
    border: "none",
    borderBottom: "1px solid rgba(255,255,255,0.05)",
    cursor: "pointer",
    transition: "background 0.2s",
    overflow: "hidden", // はみ出し防止
  },
  filePaneItemOn: {
    background: "rgba(255,255,255,0.1)",
    borderLeft: "3px solid var(--c-accent)", // 選択中を強調
  },
  filePaneThumbBox: {
    width: 36,  // サムネイルの横幅を小さく固定
    height: 48, // 縦横比を維持しやすい高さ
    flexShrink: 0,
    background: "#000",
    borderRadius: 2,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    boxShadow: "0 2px 4px rgba(0,0,0,0.3)",
  },
  filePaneThumbImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover", // 枠いっぱいに表示
  },
  filePaneInfo: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0, // 文字が長くても親を突き破らないために必須
    textAlign: "left",
  },
  filePaneName: {
    fontSize: "12px",
    color: "var(--c-text)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis", // 長いファイル名を「...」にする
    fontWeight: 500,
  },
  filePaneMeta: {
    fontSize: "10px",
    color: "var(--c-textDim)",
  },
  mainView: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "#070e09",
    position: 'relative'
  },
  viewScroll: { flex: 1, overflow: "auto" },
  viewInner: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    minWidth: "100%",
    minHeight: "100%",
    padding: 24,
  }, 
  viewCenter: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center" },
  title: { fontWeight: 700, fontSize: 14, fontFamily: F },
  pageBadge: { fontSize: 11, background: "var(--c-border)", padding: "2px 8px", borderRadius: 10, marginLeft: 8 },
  zoomRow: { display: "flex", alignItems: "center", gap: 8 },
  zBtn: { width: 28, height: 28, cursor: "pointer" },
  zVal: { fontSize: 12, minWidth: 40, textAlign: "center" },
  thumbN: { fontSize: "10px", marginTop: "4px", color: "#ccc" }
};


