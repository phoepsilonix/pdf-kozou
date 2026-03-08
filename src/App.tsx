// src/App.tsx
import { useState, useCallback, useEffect } from "react";
import { TrimPage }    from "./pages/TrimPage";
import { CompressPage } from "./pages/CompressPage";
import { usePdfStore } from "./store/usePdfStore";
import { getPdfInfo, pickOpenFile, type PdfInfo } from "./lib/tauri";

const GLOBAL_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #0a0c10; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  input[type=number]::-webkit-inner-spin-button { opacity: 0.4; }
  input[type=number]:focus { border-color: #4f9eff !important; }
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: #0d1017; }
  ::-webkit-scrollbar-thumb { background: #2a2e38; border-radius: 2px; }
  button:hover:not(:disabled) { filter: brightness(1.15); }
`;

export type ToolPage = "trim" | "compress" | "merge" | "split" | "rotate";

export default function App() {
  const [activeTool, setActiveTool] = useState<ToolPage | null>(null);
  const [isDragging, setDragging]   = useState(false);

  const { filePath, pdfInfo, setFile, setError, lastError } = usePdfStore();

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = GLOBAL_CSS;
    document.head.appendChild(style);
    return () => { document.head.removeChild(style); };
  }, []);

  const openPdf = useCallback(async (path: string, tool: ToolPage = "trim") => {
    try {
      const info = await getPdfInfo(path);
      setFile(path, info);
      setActiveTool(tool);
    } catch (e) { setError(String(e)); }
  }, [setFile, setError]);

  const handleOpenDialog = useCallback(async (tool: ToolPage) => {
    const path = await pickOpenFile();
    if (path) await openPdf(path, tool);
  }, [openPdf]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file?.name.endsWith(".pdf")) {
      const path = (file as { path?: string }).path ?? file.name;
      await openPdf(path, "trim");
    }
  }, [openPdf]);

  // ── ツール画面 ─────────────────────────────────────────────────────────────
  if (activeTool && filePath && pdfInfo) {
    return (
      <ToolShell
        filePath={filePath}
        pdfInfo={pdfInfo}
        activeTool={activeTool}
        onToolChange={setActiveTool}
        onHome={() => setActiveTool(null)}
        onOpenFile={(tool) => handleOpenDialog(tool)}
      />
    );
  }

  // ── ホーム画面 ─────────────────────────────────────────────────────────────
  return (
    <div
      style={{ ...home.root, ...(isDragging ? home.dragging : {}) }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <div style={home.logo}>
        <span style={home.logoJa}>PDF</span>
        <span style={home.logoKozou}>小僧</span>
      </div>
      <p style={home.tagline}>Pure Rust · MuPDF · オフライン完全動作</p>

      <div style={home.grid}>
        {TOOLS.map(t => (
          <button key={t.id} style={home.card} onClick={() => handleOpenDialog(t.id as ToolPage)}>
            <span style={home.cardIcon}>{t.icon}</span>
            <span style={home.cardLabel}>{t.label}</span>
            <span style={home.cardDesc}>{t.desc}</span>
          </button>
        ))}
      </div>

      <p style={home.drop}>または PDF をここにドロップ</p>
      {lastError && <div style={home.error}>{lastError}</div>}
    </div>
  );
}

// ── ツールシェル (ナビバー + ツール切替) ──────────────────────────────────────

interface ToolShellProps {
  filePath:    string;
  pdfInfo:     PdfInfo;
  activeTool:  ToolPage;
  onToolChange:(t: ToolPage) => void;
  onHome:      () => void;
  onOpenFile:  (t: ToolPage) => void;
}

function ToolShell({ filePath, pdfInfo, activeTool, onToolChange, onHome, onOpenFile }: ToolShellProps) {
  const filename = filePath.split(/[/\\]/).pop() ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0a0c10" }}>
      {/* ナビバー */}
      <nav style={nav.bar}>
        <button style={nav.homeBtn} onClick={onHome} title="ホームへ戻る">
          <span style={nav.homeLogo}>PDF<span style={{ color: "#4f9eff" }}>小僧</span></span>
        </button>

        <div style={nav.divider} />

        {/* ファイル名 */}
        <span style={nav.filename} title={filePath}>{filename}</span>

        <div style={{ flex: 1 }} />

        {/* ツールタブ */}
        {TOOLS.map(t => (
          <button
            key={t.id}
            style={{ ...nav.tab, ...(activeTool === t.id ? nav.tabActive : {}) }}
            onClick={() => onToolChange(t.id as ToolPage)}
            disabled={!t.implemented}
            title={t.implemented ? t.label : `${t.label}（未実装）`}
          >
            <span>{t.icon}</span>
            <span style={nav.tabLabel}>{t.label}</span>
          </button>
        ))}

        <div style={nav.divider} />

        {/* 別ファイルを開く */}
        <button style={nav.openBtn} onClick={() => onOpenFile(activeTool)}>
          開く…
        </button>
      </nav>

      {/* ツール本体 */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {activeTool === "trim" && (
          <TrimPage filePath={filePath} pdfInfo={pdfInfo} />
        )}
        {activeTool === "compress" && (
          <CompressPage filePath={filePath} pdfInfo={pdfInfo} />
        )}
        {activeTool !== "trim" && activeTool !== "compress" && (
          <NotImplemented label={TOOLS.find(t => t.id === activeTool)?.label ?? ""} />
        )}
      </div>
    </div>
  );
}

function NotImplemented({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#3a4050", fontFamily: "monospace", fontSize: 14 }}>
      {label} — 実装中
    </div>
  );
}

// ── ツール定義 ──────────────────────────────────────────────────────────────

const TOOLS = [
  { id: "trim",     icon: "✂",  label: "トリミング", desc: "余白をカット",     implemented: true  },
  { id: "compress", icon: "⊙",  label: "圧縮",       desc: "ファイルを軽量化", implemented: true  },
  { id: "merge",    icon: "⊕",  label: "結合",       desc: "複数PDFを合体",   implemented: false },
  { id: "split",    icon: "⊗",  label: "分割",       desc: "ページを分割",     implemented: false },
  { id: "rotate",   icon: "↻",  label: "回転",       desc: "ページを回転",     implemented: false },
];

// ── スタイル ──────────────────────────────────────────────────────────────────

const home: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh", display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", gap: 32,
    background: "#0a0c10", color: "#e8eaf0",
    fontFamily: "'JetBrains Mono', 'Noto Sans JP', monospace",
    padding: 40, transition: "background 0.2s",
  },
  dragging: { background: "#0d1a2d", outline: "2px dashed #4f9eff", outlineOffset: "-16px" },
  logo:     { display: "flex", alignItems: "baseline", gap: 4 },
  logoJa:   { fontSize: 52, fontWeight: 800, color: "#e8eaf0", letterSpacing: "-0.02em" },
  logoKozou:{ fontSize: 48, fontWeight: 400, color: "#4f9eff", letterSpacing: "0.04em" },
  tagline:  { margin: 0, fontSize: 11, color: "#3a4050", letterSpacing: "0.12em", textTransform: "uppercase" },
  grid: {
    display: "grid", gridTemplateColumns: "repeat(5, 140px)", gap: 12,
  },
  card: {
    display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
    padding: "20px 12px", background: "#0d1017",
    border: "1px solid #1a1d24", borderRadius: 12,
    cursor: "pointer", color: "#e8eaf0",
    fontFamily: "inherit", transition: "all 0.15s",
  },
  cardIcon:  { fontSize: 28, color: "#2a3a50" },
  cardLabel: { fontSize: 13, fontWeight: 600, color: "#8a9090" },
  cardDesc:  { fontSize: 10, color: "#3a4050", textAlign: "center" },
  drop:      { margin: 0, fontSize: 11, color: "#2a3040" },
  error: {
    padding: "10px 20px", background: "#2a0d0d",
    border: "1px solid #5a1a1a", borderRadius: 8,
    color: "#ff6060", fontSize: 12, maxWidth: 400, textAlign: "center",
  },
};

const nav: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "0 12px", height: 44,
    background: "#0d1017", borderBottom: "1px solid #1a1d24",
    flexShrink: 0,
    fontFamily: "'JetBrains Mono', monospace",
  },
  homeBtn: {
    background: "transparent", border: "none",
    cursor: "pointer", padding: "4px 8px", borderRadius: 6,
    fontFamily: "inherit",
  },
  homeLogo:  { fontSize: 15, fontWeight: 700, color: "#e8eaf0", letterSpacing: "-0.01em" },
  divider:   { width: 1, height: 20, background: "#1a1d24", margin: "0 4px" },
  filename:  { fontSize: 11, color: "#4a5060", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  tab: {
    display: "flex", alignItems: "center", gap: 5,
    padding: "5px 10px", background: "transparent",
    border: "1px solid transparent", borderRadius: 6,
    cursor: "pointer", color: "#4a5060",
    fontFamily: "inherit", fontSize: 12, transition: "all 0.12s",
  },
  tabActive: { background: "#0d1a2d", borderColor: "#4f9eff", color: "#4f9eff" },
  tabLabel:  { fontSize: 11 },
  openBtn: {
    padding: "5px 12px", background: "transparent",
    border: "1px solid #2a2e38", borderRadius: 6,
    color: "#5a6070", cursor: "pointer",
    fontFamily: "inherit", fontSize: 11,
  },
};
