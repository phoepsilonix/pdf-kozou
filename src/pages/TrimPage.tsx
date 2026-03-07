// src/pages/TrimPage.tsx
//
// トリミング画面
//
// レイアウト:
//   [サイドバー: ページサムネイル一覧]
//   [メイン: TrimCanvas] [右パネル: TrimControls]
//
// 状態フロー:
//   1. PDF パスを受け取りページ情報を取得
//   2. 選択ページを renderPage() でレンダリング → TrimCanvas に渡す
//   3. Canvas/数値入力の変更 → TrimMargins を更新 (debounce 500ms)
//   4. trimPreview() でリアルタイムプレビュー更新
//   5. [実行] → trimPdf() → 保存先ダイアログ → 保存

import { useEffect, useState, useCallback, useRef } from "react";
import { TrimCanvas }   from "../components/trim/TrimCanvas";
import { TrimControls } from "../components/trim/TrimControls";
import { usePdfStore }  from "../store/usePdfStore";
import {
  renderPage, trimPreview, trimPdf, pickSaveFile,
  type TrimMargins, type PageSelection, type PdfInfo,
} from "../lib/tauri";

interface Props {
  /** 開かれた PDF のパス */
  filePath: string;
  pdfInfo:  PdfInfo;
}

// ── プレビュー解像度 ──────────────────────────────────────────────────────────
const PREVIEW_DPI    = 96;
const CANVAS_WIDTH   = 560;  // トリムキャンバスの表示幅 (px)
const THUMB_DPI      = 48;   // サムネイル用低解像度

export function TrimPage({ filePath, pdfInfo }: Props) {
  const {
    trimMargins, trimPages,
    setTrimMargins, setTrimPages, resetTrim,
    previewPage, setPreviewPage,
    isProcessing, setProcessing,
    setError,
  } = usePdfStore();

  // ── ページ画像 ─────────────────────────────────────────────────────────────
  const [pageImage,   setPageImage]   = useState<string>("");
  const [thumbImages, setThumbImages] = useState<string[]>([]);

  // 選択ページのサイズ
  const currentPage = pdfInfo.pages[previewPage] ?? pdfInfo.pages[0];
  const pageW = currentPage?.w ?? 595;
  const pageH = currentPage?.h ?? 842;

  // ── 初期化 ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    resetTrim(pageW, pageH);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  // ── ページ画像読み込み ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b64 = await renderPage(filePath, previewPage, PREVIEW_DPI);
        if (!cancelled) setPageImage(b64);
      } catch (e) {
        setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [filePath, previewPage, setError]);

  // ── サムネイル (全ページ・一度だけ) ───────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const thumbs: string[] = [];
      for (let i = 0; i < pdfInfo.page_count; i++) {
        try {
          const b64 = await renderPage(filePath, i, THUMB_DPI);
          if (cancelled) return;
          thumbs.push(b64);
          setThumbImages([...thumbs]);
        } catch { thumbs.push(""); }
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, pdfInfo.page_count]);

  // ── マージン変更 → プレビュー更新 (Canvas/数値どちらから来ても) ───────────
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewOverlay, setPreviewOverlay] = useState<{
    x: number; y: number; w: number; h: number;
  } | null>(null);

  const handleMarginsChange = useCallback((m: TrimMargins) => {
    setTrimMargins(m);
    // プレビュー更新を debounce
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(async () => {
      try {
        const result = await trimPreview(filePath, previewPage, m, PREVIEW_DPI);
        setPreviewOverlay(result.crop_rect);
      } catch { /* ignore */ }
    }, 400);
  }, [filePath, previewPage, setTrimMargins]);

  // ── トリミング実行 ─────────────────────────────────────────────────────────
  const handleApply = useCallback(async () => {
    const savePath = await pickSaveFile("trimmed.pdf");
    if (!savePath) return;

    setProcessing(true);
    try {
      await trimPdf(filePath, savePath, trimMargins, trimPages);
    } catch (e) {
      setError(String(e));
    } finally {
      setProcessing(false);
    }
  }, [filePath, trimMargins, trimPages, setProcessing, setError]);

  // ── リセット ────────────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    resetTrim(pageW, pageH);
    setPreviewOverlay(null);
  }, [resetTrim, pageW, pageH]);

  // ── ページ変更 ─────────────────────────────────────────────────────────────
  const handlePageSelect = useCallback((idx: number) => {
    setPreviewPage(idx);
    const page = pdfInfo.pages[idx];
    if (page) resetTrim(page.w, page.h);
  }, [pdfInfo.pages, setPreviewPage, resetTrim]);

  // ── レンダリング ───────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>

      {/* ── サムネイルサイドバー ─────────────────────────────────────────── */}
      <aside style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <span style={styles.sidebarTitle}>ページ</span>
          <span style={styles.pageCount}>{pdfInfo.page_count}枚</span>
        </div>
        <div style={styles.thumbList}>
          {Array.from({ length: pdfInfo.page_count }, (_, i) => (
            <button
              key={i}
              style={{
                ...styles.thumbItem,
                ...(previewPage === i ? styles.thumbActive : {}),
              }}
              onClick={() => handlePageSelect(i)}
            >
              {thumbImages[i] ? (
                <img
                  src={`data:image/jpeg;base64,${thumbImages[i]}`}
                  style={styles.thumbImg}
                  alt={`Page ${i + 1}`}
                />
              ) : (
                <div style={styles.thumbPlaceholder}>
                  <span style={styles.thumbLoading}>…</span>
                </div>
              )}
              <span style={styles.thumbLabel}>{i + 1}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* ── メインキャンバスエリア ──────────────────────────────────────── */}
      <main style={styles.main}>
        <div style={styles.canvasHeader}>
          <h2 style={styles.canvasTitle}>
            トリミング
            <span style={styles.pageIndicator}>— {previewPage + 1} / {pdfInfo.page_count} ページ</span>
          </h2>
          <div style={styles.dpiLabel}>{PREVIEW_DPI} dpi プレビュー</div>
        </div>

        <div style={styles.canvasWrapper}>
          {pageImage ? (
            <TrimCanvas
              pageImageB64={pageImage}
              pageWidthPt={pageW}
              pageHeightPt={pageH}
              margins={trimMargins}
              onChange={handleMarginsChange}
              displayWidth={CANVAS_WIDTH}
            />
          ) : (
            <div style={{ ...styles.canvasPlaceholder, width: CANVAS_WIDTH, height: CANVAS_WIDTH * pageH / pageW }}>
              <div style={styles.spinner} />
              <span style={styles.loadingText}>レンダリング中…</span>
            </div>
          )}
        </div>

        {/* ── キーボードショートカット ──────────────────────────────────── */}
        <div style={styles.shortcuts}>
          <ShortcutHint keys={["←", "→"]} label="ページ移動" />
          <ShortcutHint keys={["R"]}       label="リセット" />
          <ShortcutHint keys={["Enter"]}   label="実行" />
        </div>
      </main>

      {/* ── 右パネル: 数値入力 ───────────────────────────────────────────── */}
      <aside style={styles.rightPanel}>
        <TrimControls
          margins={trimMargins}
          pageW={pageW}
          pageH={pageH}
          pages={trimPages}
          onMargins={handleMarginsChange}
          onPages={setTrimPages}
          onApply={handleApply}
          onReset={handleReset}
          processing={isProcessing}
        />
      </aside>
    </div>
  );
}

// ── ショートカットヒント ──────────────────────────────────────────────────────

function ShortcutHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div style={shortcutStyles.hint}>
      {keys.map(k => (
        <kbd key={k} style={shortcutStyles.key}>{k}</kbd>
      ))}
      <span style={shortcutStyles.label}>{label}</span>
    </div>
  );
}

// ── スタイル ──────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  root: {
    display:        "flex",
    height:         "100vh",
    background:     "#0a0c10",
    color:          "#e8eaf0",
    fontFamily:     "'JetBrains Mono', 'Noto Sans JP', monospace",
    overflow:       "hidden",
  },

  // サイドバー
  sidebar: {
    width:          "120px",
    flexShrink:     0,
    display:        "flex",
    flexDirection:  "column",
    background:     "#0d1017",
    borderRight:    "1px solid #1a1d24",
    overflow:       "hidden",
  },
  sidebarHeader: {
    display:        "flex",
    justifyContent: "space-between",
    alignItems:     "center",
    padding:        "12px 10px 8px",
    borderBottom:   "1px solid #1a1d24",
  },
  sidebarTitle: { fontSize: 10, color: "#5a6070", letterSpacing: "0.1em", textTransform: "uppercase" },
  pageCount:    { fontSize: 10, color: "#3a4050" },
  thumbList: {
    flex:           1,
    overflowY:      "auto",
    padding:        "8px 6px",
    display:        "flex",
    flexDirection:  "column",
    gap:            6,
  },
  thumbItem: {
    display:        "flex",
    flexDirection:  "column",
    alignItems:     "center",
    gap:            4,
    padding:        "6px 4px",
    borderRadius:   6,
    border:         "1px solid transparent",
    background:     "transparent",
    cursor:         "pointer",
    transition:     "all 0.12s",
  },
  thumbActive: {
    borderColor: "#4f9eff",
    background:  "#0d1a2d",
  },
  thumbImg: {
    width:        "80px",
    height:       "auto",
    borderRadius: 3,
    display:      "block",
  },
  thumbPlaceholder: {
    width:          "80px",
    height:         "110px",
    background:     "#111520",
    borderRadius:   3,
    display:        "flex",
    alignItems:     "center",
    justifyContent: "center",
  },
  thumbLoading: { color: "#3a4050", fontSize: 16 },
  thumbLabel:   { fontSize: 10, color: "#3a4050" },

  // メイン
  main: {
    flex:           1,
    display:        "flex",
    flexDirection:  "column",
    overflow:       "hidden",
    padding:        "20px 24px",
    gap:            16,
  },
  canvasHeader: {
    display:        "flex",
    alignItems:     "baseline",
    justifyContent: "space-between",
  },
  canvasTitle: {
    margin:       0,
    fontSize:     16,
    fontWeight:   600,
    color:        "#c8cad8",
    letterSpacing: "0.02em",
  },
  pageIndicator: { marginLeft: 10, fontSize: 12, color: "#4a5060", fontWeight: 400 },
  dpiLabel:      { fontSize: 10, color: "#3a4050" },
  canvasWrapper: {
    flex:           1,
    overflow:       "auto",
    display:        "flex",
    alignItems:     "flex-start",
    justifyContent: "center",
  },
  canvasPlaceholder: {
    display:        "flex",
    flexDirection:  "column",
    alignItems:     "center",
    justifyContent: "center",
    background:     "#0d1017",
    borderRadius:   8,
    gap:            16,
  },
  spinner: {
    width:  32, height: 32,
    border: "3px solid #1a2030",
    borderTop: "3px solid #4f9eff",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  loadingText: { fontSize: 12, color: "#4a5060" },
  shortcuts: {
    display:    "flex",
    gap:        20,
    paddingTop: 8,
    borderTop:  "1px solid #1a1d24",
  },

  // 右パネル
  rightPanel: {
    width:          "280px",
    flexShrink:     0,
    overflowY:      "auto",
    borderLeft:     "1px solid #1a1d24",
  },
};

const shortcutStyles: Record<string, React.CSSProperties> = {
  hint:  { display: "flex", alignItems: "center", gap: 6 },
  key: {
    padding:      "2px 6px",
    background:   "#1a1d24",
    border:       "1px solid #2a2e38",
    borderRadius: 4,
    fontSize:     10,
    color:        "#5a6070",
    fontFamily:   "inherit",
  },
  label: { fontSize: 10, color: "#3a4050" },
};
