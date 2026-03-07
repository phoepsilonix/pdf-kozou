// src/App.tsx
import { useState, useCallback, useEffect } from "react";
import { TrimPage }    from "./pages/TrimPage";
import { usePdfStore } from "./store/usePdfStore";
import { getPdfInfo, pickOpenFile, type PdfInfo } from "./lib/tauri";

// ── CSS アニメーション (グローバル) ──────────────────────────────────────────
const GLOBAL_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #0a0c10; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  input[type=number]::-webkit-inner-spin-button { opacity: 0.4; }
  input[type=number]:focus { border-color: #4f9eff !important; }
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: #0d1017; }
  ::-webkit-scrollbar-thumb { background: #2a2e38; border-radius: 2px; }
  button:hover:not(:disabled) { filter: brightness(1.15); }
`;

// ── ページ型 ──────────────────────────────────────────────────────────────────
type Page = "home" | "trim";

export default function App() {
  const [page, setPage]         = useState<Page>("home");
  const [isDragging, setDragging] = useState(false);

  const { filePath, pdfInfo, setFile, setError, lastError } = usePdfStore();

  // ── グローバルスタイル注入 ─────────────────────────────────────────────────
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = GLOBAL_CSS;
    document.head.appendChild(style);
    return () => { document.head.removeChild(style); };
  }, []);

  // ── PDF を開く ─────────────────────────────────────────────────────────────
  const openPdf = useCallback(async (path: string) => {
    try {
      const info = await getPdfInfo(path);
      setFile(path, info);
      setPage("trim");  // 最初はトリミング画面へ
    } catch (e) {
      setError(String(e));
    }
  }, [setFile, setError]);

  // ── ファイルダイアログ ─────────────────────────────────────────────────────
  const handleOpenDialog = useCallback(async () => {
    const path = await pickOpenFile();
    if (path) await openPdf(path);
  }, [openPdf]);

  // ── ドラッグ&ドロップ ─────────────────────────────────────────────────────
  const handleDragOver  = (e: React.DragEvent) => { e.preventDefault(); setDragging(true); };
  const handleDragLeave = () => setDragging(false);
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file?.name.endsWith(".pdf")) {
      // Tauri では file.path が使える
      const path = (file as { path?: string }).path ?? file.name;
      await openPdf(path);
    }
  }, [openPdf]);

  // ── ページルーティング ─────────────────────────────────────────────────────
  if (page === "trim" && filePath && pdfInfo) {
    return (
      <>
        {/* ナビバー */}
        <nav style={navStyles.bar}>
          <button style={navStyles.backBtn} onClick={() => setPage("home")}>
            ← ホーム
          </button>
          <span style={navStyles.filename}>
            {filePath.split(/[/\\]/).pop()}
          </span>
          <span style={navStyles.pageTag}>トリミング</span>
        </nav>
        <div style={{ paddingTop: 40 }}>
          <TrimPage filePath={filePath} pdfInfo={pdfInfo} />
        </div>
      </>
    );
  }

  // ── ホーム画面 ─────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        ...homeStyles.root,
        ...(isDragging ? homeStyles.dragging : {}),
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* ロゴ */}
      <div style={homeStyles.logo}>
        <span style={homeStyles.logoJa}>PDF</span>
        <span style={homeStyles.logoKozou}>小僧</span>
      </div>
      <p style={homeStyles.tagline}>Pure Rust • MuPDF • オフライン完全動作</p>

      {/* ドロップゾーン */}
      <button style={homeStyles.dropZone} onClick={handleOpenDialog}>
        <div style={homeStyles.dropIcon}>⧉</div>
        <div style={homeStyles.dropMain}>
          PDFをドロップ、またはクリックして開く
        </div>
        <div style={homeStyles.dropSub}>
          .pdf ファイル対応
        </div>
      </button>

      {/* 機能一覧 (将来的に各機能へのナビになる) */}
      <div style={homeStyles.features}>
        {FEATURES.map(f => (
          <div key={f.label} style={homeStyles.feature}>
            <span style={homeStyles.featureIcon}>{f.icon}</span>
            <span style={homeStyles.featureLabel}>{f.label}</span>
          </div>
        ))}
      </div>

      {/* エラー表示 */}
      {lastError && (
        <div style={homeStyles.error}>{lastError}</div>
      )}
    </div>
  );
}

const FEATURES = [
  { icon: "✂", label: "トリミング" },
  { icon: "⊕", label: "結合" },
  { icon: "⊗", label: "分割" },
  { icon: "↻", label: "回転" },
  { icon: "⊙", label: "圧縮" },
  { icon: "T", label: "OCR" },
  { icon: "🔒", label: "保護" },
  { icon: "⬚", label: "変換" },
];

// ── スタイル ──────────────────────────────────────────────────────────────────

const navStyles: Record<string, React.CSSProperties> = {
  bar: {
    position:       "fixed",
    top:            0,
    left:           0,
    right:          0,
    height:         40,
    display:        "flex",
    alignItems:     "center",
    gap:            12,
    padding:        "0 16px",
    background:     "#0d1017",
    borderBottom:   "1px solid #1a1d24",
    zIndex:         100,
    fontFamily:     "'JetBrains Mono', monospace",
  },
  backBtn: {
    background:   "transparent",
    border:       "none",
    color:        "#5a6070",
    cursor:       "pointer",
    fontSize:     12,
    padding:      "4px 8px",
    borderRadius: 4,
    fontFamily:   "inherit",
  },
  filename: {
    flex:       1,
    fontSize:   12,
    color:      "#4a5060",
    overflow:   "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pageTag: {
    fontSize:     10,
    padding:      "2px 8px",
    background:   "#1a3a5c",
    border:       "1px solid #4f9eff",
    borderRadius: 10,
    color:        "#4f9eff",
    letterSpacing: "0.08em",
  },
};

const homeStyles: Record<string, React.CSSProperties> = {
  root: {
    minHeight:      "100vh",
    display:        "flex",
    flexDirection:  "column",
    alignItems:     "center",
    justifyContent: "center",
    gap:            32,
    background:     "#0a0c10",
    color:          "#e8eaf0",
    fontFamily:     "'JetBrains Mono', 'Noto Sans JP', monospace",
    padding:        40,
    transition:     "background 0.2s",
  },
  dragging: {
    background: "#0d1a2d",
    outline:    "2px dashed #4f9eff",
    outlineOffset: "-16px",
  },
  logo: { display: "flex", alignItems: "baseline", gap: 4 },
  logoJa: {
    fontSize:     52,
    fontWeight:   800,
    color:        "#e8eaf0",
    letterSpacing: "-0.02em",
  },
  logoKozou: {
    fontSize:     48,
    fontWeight:   400,
    color:        "#4f9eff",
    letterSpacing: "0.04em",
  },
  tagline: {
    margin:       0,
    fontSize:     11,
    color:        "#3a4050",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
  },
  dropZone: {
    display:        "flex",
    flexDirection:  "column",
    alignItems:     "center",
    gap:            10,
    padding:        "40px 80px",
    background:     "#0d1017",
    border:         "1px dashed #2a2e38",
    borderRadius:   16,
    cursor:         "pointer",
    transition:     "all 0.2s",
    fontFamily:     "inherit",
    color:          "inherit",
  },
  dropIcon:  { fontSize: 40, color: "#2a3040" },
  dropMain:  { fontSize: 15, color: "#8a9090" },
  dropSub:   { fontSize: 11, color: "#3a4050" },
  features: {
    display:   "flex",
    flexWrap:  "wrap",
    gap:       12,
    maxWidth:  480,
    justifyContent: "center",
  },
  feature: {
    display:      "flex",
    flexDirection: "column",
    alignItems:   "center",
    gap:          4,
    padding:      "10px 14px",
    background:   "#0d1017",
    borderRadius: 8,
    border:       "1px solid #1a1d24",
    minWidth:     60,
  },
  featureIcon:  { fontSize: 18, color: "#2a3a50" },
  featureLabel: { fontSize: 10, color: "#3a4050", letterSpacing: "0.06em" },
  error: {
    padding:      "10px 20px",
    background:   "#2a0d0d",
    border:       "1px solid #5a1a1a",
    borderRadius: 8,
    color:        "#ff6060",
    fontSize:     12,
    maxWidth:     400,
    textAlign:    "center",
  },
};
