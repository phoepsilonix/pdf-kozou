// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/pages/ViewerPage.tsx
import { useEffect, useState, useCallback, useRef } from "react";
import { renderPage, getPdfInfo, type PdfInfo, type PdfMetadata } from "../lib/tauri";
import { Spinner, PageHeader } from "../components/common";
import { type FileEntry } from "../store/usePdfStore";
import { F } from "../lib/theme";
import * as pdfjsLib from "pdfjs-dist";
import { convertFileSrc } from "@tauri-apps/api/core";

import "pdfjs-dist/web/pdf_viewer.css";

const workerSrc = window.location.protocol === 'http:'
  ? '/pdf.worker.min.mjs'
  : 'asset://localhost/pdf.worker.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

interface Props {
  filePath?: string;
  pdfInfo?: PdfInfo;
  fileList?: FileEntry[];
}

const THUMB_DPI = 52;
const VIEW_DPI = 1.5;

function pageAspect(info: PdfInfo | null, pageIdx: number): number {
  if (!info || !info.pages[pageIdx]) return 1 / 1.414;
  const p = info.pages[pageIdx];
  const r = (p as any).rotate ?? 0;
  if (r === 90 || r === 270) return p.h / p.w;
  return p.w / p.h;
}

// ─────────────────────────────────────────────────────────────────────────────
// MetaRow: 1行のメタデータ表示 + コピーボタン
// ─────────────────────────────────────────────────────────────────────────────
function MetaRow({ label, value }: { label: string; value?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div style={ds.row}>
      <span style={ds.label}>{label}</span>
      <span style={ds.value} title={value}>{value}</span>
      <button
        style={{ ...ds.copyBtn, ...(copied ? ds.copyBtnDone : {}) }}
        onClick={handleCopy}
        title="コピー"
      >
        {copied ? "✓" : "⎘"}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// InfoDrawer: スライドインドロワー
// ─────────────────────────────────────────────────────────────────────────────
function InfoDrawer({
  open, onClose, info, filePath, fileName,
}: {
  open: boolean;
  onClose: () => void;
  info: PdfInfo | null;
  filePath: string;
  fileName: string;
}) {
  const [allCopied, setAllCopied] = useState(false);
  const meta: PdfMetadata = info?.metadata ?? {};

  const handleCopyAll = () => {
    const lines: string[] = [];
    if (fileName)            lines.push(`ファイル名: ${fileName}`);
    if (filePath)            lines.push(`パス: ${filePath}`);
    if (info?.file_size)     lines.push(`サイズ: ${formatBytes(info.file_size)}`);
    if (info?.page_count)    lines.push(`ページ数: ${info.page_count}`);
    if (meta.title)          lines.push(`タイトル: ${meta.title}`);
    if (meta.author)         lines.push(`作成者: ${meta.author}`);
    if (meta.subject)        lines.push(`件名: ${meta.subject}`);
    if (meta.keywords)       lines.push(`キーワード: ${meta.keywords}`);
    if (meta.creator)        lines.push(`アプリ: ${meta.creator}`);
    if (meta.producer)       lines.push(`変換: ${meta.producer}`);
    if (meta.creation_date)  lines.push(`作成日: ${formatDate(meta.creation_date)}`);
    if (meta.mod_date)       lines.push(`更新日: ${formatDate(meta.mod_date)}`);
    navigator.clipboard.writeText(lines.join("\n")).then(() => {
      setAllCopied(true);
      setTimeout(() => setAllCopied(false), 1800);
    });
  };

  const hasAnyMeta = !!(meta.title || meta.author || meta.subject || meta.keywords
    || meta.creator || meta.producer || meta.creation_date || meta.mod_date);

  const firstPage = info?.pages?.[0];
  const pageSize = firstPage
    ? `${ptToMm(firstPage.w)} × ${ptToMm(firstPage.h)} mm`
    : null;

  return (
    <div style={{
      ...ds.drawer,
      transform: open ? "translateX(0)" : "translateX(100%)",
      pointerEvents: open ? "auto" : "none",
    }}>
      {/* ヘッダー */}
      <div style={ds.drawerHead}>
        <span style={ds.drawerTitle}>ℹ ファイル情報</span>
        <div style={{ flex: 1 }} />
        <button
          style={{ ...ds.copyBtn, padding: "3px 10px", fontSize: 11 }}
          onClick={handleCopyAll}
        >
          {allCopied ? "✓ コピー済" : "全コピー"}
        </button>
        <button style={ds.closeBtn} onClick={onClose} title="閉じる">✕</button>
      </div>

      <div style={ds.drawerBody}>
        {/* ── ファイル情報 ── */}
        <div style={ds.section}>ファイル</div>

        <div style={ds.row}>
          <span style={ds.label}>ファイル名</span>
          <span style={{ ...ds.value, wordBreak: "break-all" }} title={fileName}>{fileName}</span>
          <button style={ds.copyBtn} onClick={() => navigator.clipboard.writeText(fileName)} title="コピー">⎘</button>
        </div>

        <div style={ds.row}>
          <span style={ds.label}>パス</span>
          <span style={{ ...ds.value, wordBreak: "break-all", fontSize: 10 }} title={filePath}>{filePath}</span>
          <button style={ds.copyBtn} onClick={() => navigator.clipboard.writeText(filePath)} title="コピー">⎘</button>
        </div>

        {info?.file_size != null && (
          <div style={ds.row}>
            <span style={ds.label}>サイズ</span>
            <span style={ds.value}>{formatBytes(info.file_size)}</span>
          </div>
        )}

        {info?.page_count != null && (
          <div style={ds.row}>
            <span style={ds.label}>ページ数</span>
            <span style={ds.value}>{info.page_count} ページ</span>
          </div>
        )}

        {pageSize && (
          <div style={ds.row}>
            <span style={ds.label}>ページサイズ</span>
            <span style={ds.value}>{pageSize}</span>
          </div>
        )}

        {/* ── PDFメタデータ ── */}
        <div style={{ ...ds.section, marginTop: 14 }}>メタデータ</div>

        {hasAnyMeta ? (
          <>
            <MetaRow label="タイトル"   value={meta.title} />
            <MetaRow label="作成者"     value={meta.author} />
            <MetaRow label="件名"       value={meta.subject} />
            <MetaRow label="キーワード" value={meta.keywords} />
            <MetaRow label="アプリ"     value={meta.creator} />
            <MetaRow label="変換"       value={meta.producer} />
            <MetaRow label="作成日"     value={meta.creation_date ? formatDate(meta.creation_date) : undefined} />
            <MetaRow label="更新日"     value={meta.mod_date ? formatDate(meta.mod_date) : undefined} />
          </>
        ) : (
          <div style={{ color: "var(--c-textDim)", fontSize: 11, padding: "10px 0", textAlign: "center" }}>
            メタデータなし
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function ptToMm(pt: number): string {
  return (pt * 25.4 / 72).toFixed(1);
}

/** PDF 日付文字列 "D:YYYYMMDDHHmmSS..." → 読みやすい形式 */
function formatDate(d: string): string {
  const s = d.startsWith("D:") ? d.slice(2) : d;
  if (s.length >= 8) {
    const yyyy = s.slice(0, 4);
    const mm   = s.slice(4, 6);
    const dd   = s.slice(6, 8);
    if (s.length >= 14) {
      return `${yyyy}/${mm}/${dd} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
    }
    return `${yyyy}/${mm}/${dd}`;
  }
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// メインコンポーネント
// ─────────────────────────────────────────────────────────────────────────────

export function ViewerPage({ filePath, pdfInfo, fileList = [] }: Props) {
  const isMulti = fileList.length > 1;
  const [activeIdx, setActiveIdx] = useState(0);
  const [activeInfo, setActiveInfo] = useState<PdfInfo | null>(pdfInfo ?? null);
  const [infoOpen, setInfoOpen] = useState(false);

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
  const scrollRef = useRef<HTMLDivElement>(null);

  const thumbCache = useRef<Map<string, (string | undefined)[]>>(new Map());
  const [thumbs, setThumbs] = useState<(string | undefined)[]>([]);

  // 1. ファイル情報
  useEffect(() => {
    if (!isMulti) {
      if (pdfInfo) { setActiveInfo(pdfInfo); setTotal(pdfInfo.page_count); }
      else if (activePath) {
        getPdfInfo(activePath).then(info => { setActiveInfo(info); setTotal(info.page_count); });
      }
      return;
    }
    const path = fileList[activeIdx]?.path;
    if (path) getPdfInfo(path).then(info => { setActiveInfo(info); setTotal(info.page_count); });
  }, [activeIdx, isMulti, filePath, pdfInfo, fileList]);

  // 2. PDF.js ドキュメント読み込み
  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;
    (async () => {
      try {
        const url = convertFileSrc(activePath);
        const pdf = await pdfjsLib.getDocument(url).promise;
        if (cancelled) return;
        pdfDocRef.current = pdf;
        renderPdfPage();
      } catch (e) { console.error("PDF load error:", e); }
    })();
    return () => { cancelled = true; };
  }, [activePath]);

  useEffect(() => {
    if (!pdfInfo && filePath) getPdfInfo(filePath).then(info => setActiveInfo(info));
    else setActiveInfo(pdfInfo || null);
  }, [filePath, pdfInfo]);

  // 3. 描画
  const renderPdfPage = useCallback(async () => {
    if (!pdfDocRef.current || !canvasRef.current) return;
    setViewLoading(true);
    try {
      const page = await pdfDocRef.current.getPage(viewPage + 1);
      const viewport = page.getViewport({ scale: zoom * VIEW_DPI });
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d')!;
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      if (renderTaskRef.current) renderTaskRef.current.cancel();
      renderTaskRef.current = page.render({ canvasContext: ctx, viewport });
      await renderTaskRef.current.promise;
      renderTaskRef.current = null;
      if (textLayerRef.current) {
        await page.getOperatorList();
        let textContent: any = { items: [], styles: Object.create(null) };
        try {
          textContent = await page.getTextContent();
        } catch {
          const reader = page.streamTextContent().getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value.items) textContent.items.push(...value.items);
            if (value.styles) Object.assign(textContent.styles, value.styles);
          }
        }
        textLayerRef.current.innerHTML = '';
        textLayerRef.current.style.height = `${viewport.height}px`;
        textLayerRef.current.style.width = `${viewport.width}px`;
        const tl = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayerRef.current, viewport });
        await tl.render();
      }
    } catch (e: any) {
      if (e.name !== "RenderingCancelledException") console.error(e);
    } finally { setViewLoading(false); }
  }, [viewPage, zoom]);

  useEffect(() => { if (pdfDocRef.current) renderPdfPage(); }, [viewPage, zoom, renderPdfPage]);
  useEffect(() => { renderPdfPage(); }, [renderPdfPage]);

  // 4. カバーサムネイル
  useEffect(() => {
    if (!fileList.length) return;
    (async () => {
      const m = new Map(fileCoverThumbs);
      let changed = false;
      for (const f of fileList) {
        if (!m.has(f.path)) {
          try { m.set(f.path, await renderPage(f.path, 0, THUMB_DPI)); changed = true; }
          catch {}
        }
      }
      if (changed) setFileCoverThumbs(new Map(m));
    })();
  }, [fileList]);

  // 5. サムネイル
  useEffect(() => {
    if (!activePath || !activeInfo) { setThumbs([]); return; }
    const cached = thumbCache.current.get(activePath);
    if (cached) setThumbs([...cached]);
    else { const arr = new Array(activeInfo.page_count).fill(undefined); thumbCache.current.set(activePath, arr); setThumbs([]); }
    let cancelled = false;
    (async () => {
      const cur = thumbCache.current.get(activePath)!;
      for (let i = 0; i < activeInfo.page_count; i++) {
        if (cur[i]) continue;
        try {
          const b64 = await renderPage(activePath, i, THUMB_DPI);
          if (cancelled) return;
          cur[i] = b64; setThumbs([...cur]);
        } catch {}
      }
    })();
    return () => { cancelled = true; };
  }, [activePath, activeInfo]);

  if (!activeInfo && !viewLoading) return <Spinner label="読み込み中…" />;
  const fname = activePath.split(/[/\\]/).pop() ?? "";
  const THUMB_W = 104;

  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>ビューワー</span>
        <span style={s.fileSub} title={activePath}>{fname}</span>
        <span style={s.pageBadge}>{total}ページ</span>
        <div style={{ flex: 1 }} />
        {/* ℹ 情報ボタン */}
        <button
          style={{ ...s.zBtn, ...(infoOpen ? s.infoBtnOn : {}), marginRight: 8 }}
          onClick={() => setInfoOpen(v => !v)}
          title="ファイル情報 (ℹ)"
        >ℹ</button>
        <div style={s.zoomRow}>
          <button style={s.zBtn} onClick={() => setZoom(z => Math.max(0.2, z - 0.25))}>−</button>
          <span style={s.zVal}>{Math.round(zoom * 100)}%</span>
          <button style={s.zBtn} onClick={() => setZoom(z => Math.min(4.0, z + 0.25))}>＋</button>
          <button style={s.zBtnSm} onClick={() => setZoom(1.0)}>100%</button>
          <button style={s.zBtnSm} onClick={() => setZoom(1.5)}>150%</button>
        </div>
      </PageHeader>

      <div style={s.body}>
        {/* 左ペイン: 複数ファイル一覧 */}
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
                    onClick={() => { setActiveIdx(i); setViewPage(0); pdfDocRef.current = null; setInfoOpen(false); }}
                  >
                    <div style={s.filePaneThumbBox}>
                      {cover
                        ? <img src={`data:image/jpeg;base64,${cover}`} style={s.filePaneThumbImg} alt="" />
                        : <span style={s.filePaneIcon}>📄</span>}
                    </div>
                    <div style={s.filePaneInfo}>
                      <div style={s.filePaneName} title={f.filename}>{f.filename || "無題"}</div>
                      <div style={s.filePaneMeta}>{f.pageCount}p</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 中ペイン: サムネイル一覧 */}
        <div style={s.thumbPane}>
          <div style={s.paneHead}>{viewPage + 1} / {total}</div>
          <div>
            {Array.from({ length: total }, (_, i) => {
              const aspect = pageAspect(activeInfo, i);
              const th = Math.round(THUMB_W / aspect);
              return (
                <button key={i} style={{ ...s.thumbItem, ...(i === viewPage ? s.thumbItemOn : {}) }} onClick={() => setViewPage(i)}>
                  <div style={{ width: THUMB_W, height: th, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", background: "var(--c-bg)", borderRadius: 2 }}>
                    {thumbs[i]
                      ? <img src={`data:image/jpeg;base64,${thumbs[i]}`} style={{ maxWidth: THUMB_W, maxHeight: th, objectFit: "contain" }} alt="" />
                      : <div style={{ width: THUMB_W, height: th, background: "var(--c-border)" }} />}
                  </div>
                  <span style={{ ...s.thumbN, ...(i === viewPage ? s.thumbNOn : {}) }}>{i + 1}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* メインビュー + 情報ドロワー */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>
          <div style={s.mainView}>
            <div ref={scrollRef} style={s.viewScroll}>
              <div style={s.viewInner}>
                <div style={{ position: "relative", boxShadow: "0 4px 32px rgba(0,0,0,0.7)", visibility: viewLoading ? "hidden" : "visible" }}>
                  <canvas ref={canvasRef} />
                  <div ref={textLayerRef} className="textLayer" style={s.textLayerStyle} />
                </div>
                {viewLoading && <div style={s.viewCenter}><div style={s.viewSpinner} /></div>}
              </div>
            </div>
          </div>

          {/* 情報ドロワー */}
          <InfoDrawer
            open={infoOpen}
            onClose={() => setInfoOpen(false)}
            info={activeInfo}
            filePath={activePath}
            fileName={fname}
          />
        </div>
      </div>
    </div>
  );
}

// ── ドロワー専用スタイル ──────────────────────────────────────────────────────
const ds: Record<string, React.CSSProperties> = {
  drawer: {
    position: "absolute", top: 0, right: 0, bottom: 0,
    width: 300,
    background: "var(--c-bgSub, #1a1f1b)",
    borderLeft: "1px solid var(--c-border)",
    display: "flex", flexDirection: "column",
    zIndex: 20,
    transition: "transform 0.22s cubic-bezier(0.4, 0, 0.2, 1)",
    boxShadow: "-4px 0 24px rgba(0,0,0,0.4)",
    overflowY: "auto",
  },
  drawerHead: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "10px 12px",
    borderBottom: "1px solid var(--c-border)",
    position: "sticky", top: 0,
    background: "var(--c-bgSub, #1a1f1b)", zIndex: 1,
  },
  drawerTitle: { fontWeight: 700, fontSize: 13, color: "var(--c-text)" },
  drawerBody: { flex: 1, padding: "10px 12px", overflowY: "auto" },
  section: {
    fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
    color: "var(--c-textDim)", marginBottom: 6,
    paddingBottom: 4, borderBottom: "1px solid var(--c-border)",
  },
  row: {
    display: "flex", alignItems: "flex-start", gap: 6,
    padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,0.04)",
  },
  label: { flexShrink: 0, width: 72, fontSize: 10, color: "var(--c-textDim)", paddingTop: 1 },
  value: { flex: 1, fontSize: 11, color: "var(--c-text)", wordBreak: "break-word", lineHeight: 1.5, minWidth: 0 },
  copyBtn: {
    flexShrink: 0, background: "transparent",
    border: "1px solid var(--c-border)", borderRadius: 4,
    color: "var(--c-textDim)", fontSize: 11, cursor: "pointer",
    padding: "1px 5px", lineHeight: 1.4,
    transition: "background 0.15s, color 0.15s",
  },
  copyBtnDone: { background: "var(--c-accent, #3a7a4a)", color: "#fff", borderColor: "transparent" },
  closeBtn: { background: "transparent", border: "none", color: "var(--c-textDim)", fontSize: 14, cursor: "pointer", padding: "2px 6px", marginLeft: 4 },
};

// ── メインスタイル ─────────────────────────────────────────────────────────────
const s: Record<string, React.CSSProperties> = {
  root: { height: "100%", display: "flex", flexDirection: "column", background: "var(--c-bg)" },
  body: { flex: 1, display: "flex", overflow: "hidden" },
  fileItem: { padding: "8px", fontSize: "11px", cursor: "pointer", borderBottom: "1px solid var(--c-border)" },
  fileItemActive: { background: "var(--c-accentBg)", color: "var(--c-accent)", fontWeight: "bold" },
  thumbPane: { width: 140, borderRight: "1px solid var(--c-border)", overflowY: "auto", padding: "10px" },
  thumbItem: { display: "flex", flexDirection: "column", alignItems: "center", marginBottom: "15px", background: "none", border: "2px solid transparent", cursor: "pointer" },
  thumbItemOn: { borderColor: "var(--c-accent)" },
  thumbN: { fontSize: "10px", marginTop: "4px", color: "#ccc" },
  thumbNOn: { color: "var(--c-accent)" },
  textLayerStyle: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    overflow: "hidden", lineHeight: 1, opacity: 0.2,
    mixBlendMode: "multiply", pointerEvents: "auto", zIndex: 2, unicodeBidi: "plaintext",
  },
  filePane: {
    width: 220, flexShrink: 0, display: "flex", flexDirection: "column",
    borderRight: "1px solid var(--c-border)", background: "var(--c-bgSide)",
  },
  filePaneItem: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "8px 12px", width: "100%",
    background: "transparent", border: "none",
    borderBottom: "1px solid rgba(255,255,255,0.05)",
    cursor: "pointer", transition: "background 0.2s", overflow: "hidden",
  },
  filePaneItemOn: { background: "rgba(255,255,255,0.1)", borderLeft: "3px solid var(--c-accent)" },
  filePaneThumbBox: {
    width: 36, height: 48, flexShrink: 0, background: "#000", borderRadius: 2,
    display: "flex", alignItems: "center", justifyContent: "center",
    overflow: "hidden", boxShadow: "0 2px 4px rgba(0,0,0,0.3)",
  },
  filePaneThumbImg: { width: "100%", height: "100%", objectFit: "cover" },
  filePaneIcon: { fontSize: 18, opacity: 0.5 },
  filePaneInfo: { flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0, textAlign: "left" },
  filePaneName: { fontSize: "12px", color: "var(--c-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 500 },
  filePaneMeta: { fontSize: "10px", color: "var(--c-textDim)" },
  mainView: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "#070e09", position: "relative" },
  viewScroll: { flex: 1, overflow: "auto" },
  viewInner: { display: "flex", alignItems: "flex-start", justifyContent: "center", minWidth: "100%", minHeight: "100%", padding: 24 },
  viewCenter: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center" },
  viewSpinner: { width: 32, height: 32, borderRadius: "50%", border: "3px solid rgba(255,255,255,0.15)", borderTopColor: "var(--c-accent)", animation: "spin 0.8s linear infinite" },
  title: { fontWeight: 700, fontSize: 14, fontFamily: F },
  fileSub: { fontSize: 11, color: "var(--c-textDim)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  pageBadge: { fontSize: 11, background: "var(--c-border)", padding: "2px 8px", borderRadius: 10, marginLeft: 8 },
  paneHead: { fontSize: 11, fontWeight: 700, padding: "8px 12px", color: "var(--c-textDim)", borderBottom: "1px solid var(--c-border)" },
  zoomRow: { display: "flex", alignItems: "center", gap: 8 },
  zBtn: { width: 28, height: 28, cursor: "pointer", borderRadius: 4, border: "1px solid var(--c-border)", background: "var(--c-bgSub)", color: "var(--c-text)", fontSize: 14 },
  infoBtnOn: { background: "var(--c-accent, #3a7a4a)", color: "#fff", borderColor: "transparent" },
  zBtnSm: { height: 24, padding: "0 8px", cursor: "pointer", fontSize: 11, borderRadius: 4, border: "1px solid var(--c-border)", background: "var(--c-bgSub)", color: "var(--c-text)" },
  zVal: { fontSize: 12, minWidth: 40, textAlign: "center" },
};
