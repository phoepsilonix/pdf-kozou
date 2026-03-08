// src/App.tsx  —  新アーキテクチャ: ファイルが先、ツールが後
import { useState, useCallback, useEffect, useRef } from "react";
import { listen }          from "@tauri-apps/api/event";
import { TrimPage }        from "./pages/TrimPage";
import { CompressPage }    from "./pages/CompressPage";
import { SplitPage }       from "./pages/SplitPage";
import { MergePage }       from "./pages/MergePage";
import { RotatePage }      from "./pages/RotatePage";
import { ImageExportPage } from "./pages/ImageExportPage";
import { ViewerPage }      from "./pages/ViewerPage";
import { usePdfStore, type FileEntry } from "./store/usePdfStore";
import { getPdfInfo, type PdfInfo }    from "./lib/tauri";
import { invoke }          from "@tauri-apps/api/core";
import { C, F }            from "./lib/theme";

// ─────────────────────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: ${C.bg}; }
  @keyframes spin   { to { transform: rotate(360deg); } }
  @keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
  @keyframes fadeUp { from { opacity:0; transform:translateY(14px) scale(0.97); } to { opacity:1; transform:none; } }
  input[type=number]::-webkit-inner-spin-button { opacity:0.4; }
  input:focus  { border-color:${C.accent} !important; outline:none; }
  ::-webkit-scrollbar       { width:4px; height:4px; }
  ::-webkit-scrollbar-track { background:${C.bg}; }
  ::-webkit-scrollbar-thumb { background:${C.borderHi}; border-radius:2px; }
  button:hover:not(:disabled) { filter:brightness(1.12); }
  button:active:not(:disabled){ filter:brightness(0.92); }
`;

export type ToolId = "split" | "merge" | "trim" | "rotate" | "compress" | "image" | "viewer";

const TOOLS: { id: ToolId; icon: string; label: string; desc: string;
               minFiles: number; maxFiles: number | null }[] = [
  { id:"split",    icon:"⊗", label:"分割",      desc:"ページを分割",     minFiles:1, maxFiles:null },
  { id:"merge",    icon:"⊕", label:"結合",      desc:"複数PDFを合体",   minFiles:2, maxFiles:null },
  { id:"trim",     icon:"✂", label:"トリミング",  desc:"余白をカット",     minFiles:1, maxFiles:null },
  { id:"rotate",   icon:"↻", label:"回転",       desc:"ページを回転",     minFiles:1, maxFiles:null },
  { id:"compress", icon:"⊙", label:"圧縮",       desc:"ファイルを軽量化", minFiles:1, maxFiles:null },
  { id:"image",    icon:"🖼",label:"画像変換",   desc:"ページを画像に",   minFiles:1, maxFiles:null },
  { id:"viewer",   icon:"👁", label:"ビューワー",  desc:"PDFを確認・閲覧",  minFiles:1, maxFiles:null },
];

// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const {
    fileList, addFiles, removeFile, toggleSelect,
    selectAll, selectNone, clearList, reorderFiles,
    setFile, setError, lastError,
  } = usePdfStore();

  // ツール画面
  const [activeTool,  setActiveTool]  = useState<ToolId | null>(null);
  const [toolFiles,   setToolFiles]   = useState<FileEntry[]>([]);
  // D&Dハイライト
  const [dragOver,    setDragOver]    = useState(false);
  const dragCounter = useRef(0);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = GLOBAL_CSS;
    document.head.appendChild(style);
    return () => { document.head.removeChild(style); };
  }, []);

  // ── 起動時: Tauri の open-pdf-files イベントを受け取る ──────────────────
  useEffect(() => {
    const unlisten = listen<string[]>("open-pdf-files", e => {
      handleAddPaths(e.payload);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // ── ファイル追加処理 ─────────────────────────────────────────────────────
  const handleAddPaths = useCallback(async (paths: string[]) => {
    for (const path of paths) {
      try {
        const info = await getPdfInfo(path);
        const stat = await invoke<{ size: number }>("get_file_stat", { path }).catch(() => ({ size: 0 }));
        addFiles([{
          path,
          filename: path.split(/[/\\]/).pop() ?? path,
          pageCount: info.page_count,
          sizeBytes: stat.size,
          selected: true,
        }]);
      } catch (e) { setError(`${path.split(/[/\\]/).pop()}: ${e}`); }
    }
  }, [addFiles, setError]);

  const handlePickFiles = useCallback(async () => {
    const paths = await invoke<string[]>("pick_open_files").catch(() => [] as string[]);
    if (paths.length) await handleAddPaths(paths);
  }, [handleAddPaths]);

  // ── D&D ─────────────────────────────────────────────────────────────────
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);
    const paths = Array.from(e.dataTransfer.files)
      .filter(f => f.name.toLowerCase().endsWith(".pdf"))
      .map(f => (f as unknown as { path?: string }).path)
      .filter((p): p is string => !!p);
    if (paths.length) await handleAddPaths(paths);
  }, [handleAddPaths]);

  // ── ツール起動 ───────────────────────────────────────────────────────────
  const handleLaunchTool = useCallback(async (toolId: ToolId) => {
    const selected = fileList.filter(f => f.selected);
    if (selected.length === 0) return;

    // viewer / merge はファイルを store に入れなくてよい
    const noStoreTools: ToolId[] = ["merge", "viewer"];
    if (!noStoreTools.includes(toolId)) {
      try {
        const info = await getPdfInfo(selected[0].path);
        setFile(selected[0].path, info);
      } catch (e) { setError(String(e)); return; }
    }

    setToolFiles(selected);
    setActiveTool(toolId);
  }, [fileList, setFile, setError]);

  const handleHome = useCallback(() => {
    setActiveTool(null);
    setToolFiles([]);
  }, []);

  // ── 選択ファイルの集計 ───────────────────────────────────────────────────
  const selected = fileList.filter(f => f.selected);
  const selCount = selected.length;
  const selPages = selected.reduce((s, f) => s + f.pageCount, 0);
  const selBytes = selected.reduce((s, f) => s + f.sizeBytes, 0);

  // ── ツール画面 ───────────────────────────────────────────────────────────
  const { filePath, pdfInfo } = usePdfStore();

  // ── ツール画面 ───────────────────────────────────────────────────────────
  if (activeTool) {
    return (
      <ToolShell
        activeTool={activeTool}
        toolFiles={toolFiles}
        filePath={filePath ?? ""}
        pdfInfo={pdfInfo ?? { page_count: 0, pages: [] }}
        onHome={handleHome}
        onOpenMore={handlePickFiles}
        onToolChange={(t) => {
          if (toolFiles.length <= 1) setActiveTool(t);
        }}
      />
    );
  }

  // ── ホーム画面 ───────────────────────────────────────────────────────────
  return (
    <div
      style={{ ...s.root, ...(dragOver ? s.rootDrag : {}) }}
      onDragOver={e => e.preventDefault()}
      onDragEnter={e => { e.preventDefault(); dragCounter.current++; setDragOver(true); }}
      onDragLeave={() => { if (--dragCounter.current <= 0) { setDragOver(false); dragCounter.current = 0; } }}
      onDrop={handleDrop}
    >
      {/* ヘッダー */}
      <header style={s.header}>
        <span style={s.logo}>PDF<span style={{ color: C.accent }}>小僧</span></span>
        <span style={s.tagline}>Pure Rust · MuPDF · オフライン完全動作</span>
      </header>

      {/* ファイルリスト */}
      <div style={s.listCard}>
        {fileList.length === 0 ? (
          // 空状態
          <div style={s.emptyZone}>
            <span style={s.emptyIcon}>⊕</span>
            <span style={s.emptyTitle}>PDFをドロップ、または追加</span>
            <span style={s.emptySub}>複数ファイルを一度に追加できます</span>
            <button style={s.btnAddBig} onClick={handlePickFiles}>
              ファイルを選択…
            </button>
          </div>
        ) : (
          <>
            {/* ファイル行リスト */}
            <div style={s.fileRows}>
              {fileList.map((f, i) => (
                <FileRow
                  key={f.id}
                  entry={f}
                  index={i}
                  onToggle={() => toggleSelect(f.id)}
                  onRemove={() => removeFile(f.id)}
                  onDragReorder={reorderFiles}
                />
              ))}
            </div>

            {/* リスト下部のアクションバー */}
            <div style={s.listFooter}>
              <button style={s.btnAdd} onClick={handlePickFiles}>＋ 追加</button>
              <button style={s.btnSm} onClick={selectAll}>全選択</button>
              <button style={s.btnSm} onClick={selectNone}>解除</button>
              <div style={{ flex: 1 }} />
              <button style={s.btnClear} onClick={clearList}>クリア</button>
            </div>
          </>
        )}
      </div>

      {/* 選択サマリー */}
      {fileList.length > 0 && (
        <div style={s.summary}>
          {selCount > 0 ? (
            <>
              <span style={s.sumSel}>{selCount}ファイル選択中</span>
              <span style={s.sumDot}>·</span>
              <span style={s.sumInfo}>合計 {selPages}ページ</span>
              {selBytes > 0 && <>
                <span style={s.sumDot}>·</span>
                <span style={s.sumInfo}>{(selBytes / 1048576).toFixed(1)} MB</span>
              </>}
            </>
          ) : (
            <span style={s.sumNone}>ファイルを選択してください</span>
          )}
        </div>
      )}

      {/* ツールボタン */}
      {fileList.length > 0 && (
        <div style={s.toolBar}>
          {TOOLS.map(t => {
            const enabled = selCount >= t.minFiles &&
              (t.maxFiles == null || selCount <= t.maxFiles);
            return (
              <button
                key={t.id}
                style={{ ...s.toolBtn, ...(enabled ? s.toolBtnOn : s.toolBtnOff) }}
                onClick={() => enabled && handleLaunchTool(t.id)}
                disabled={!enabled}
                title={!enabled
                  ? t.id === "merge"
                    ? "2ファイル以上選択してください"
                    : "1ファイル以上選択してください"
                  : t.label}
              >
                <span style={s.toolIcon}>{t.icon}</span>
                <span style={s.toolLabel}>{t.label}</span>
                <span style={s.toolDesc}>{
                  selCount > 1 && t.id !== "merge"
                    ? `${selCount}件一括`
                    : t.desc
                }</span>
              </button>
            );
          })}
        </div>
      )}

      {/* ドラッグ時オーバーレイ */}
      {dragOver && (
        <div style={s.dragOverlay}>
          <span style={s.dragIcon}>⊕</span>
          <span style={s.dragText}>PDFをドロップして追加</span>
        </div>
      )}

      {lastError && <div style={s.error}>{lastError}</div>}
    </div>
  );
}

// ── ファイル行コンポーネント ─────────────────────────────────────────────────

function FileRow({ entry, index, onToggle, onRemove, onDragReorder }: {
  entry: FileEntry;
  index: number;
  onToggle: () => void;
  onRemove: () => void;
  onDragReorder: (fromId: number, toId: number) => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const mb = entry.sizeBytes > 0 ? (entry.sizeBytes / 1048576).toFixed(1) + " MB" : "";

  return (
    <div
      draggable
      onDragStart={e => { setIsDragging(true); e.dataTransfer.setData("fileId", String(entry.id)); }}
      onDragEnd={() => { setIsDragging(false); setIsDragOver(false); }}
      onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={e => {
        e.preventDefault(); setIsDragOver(false);
        const fromId = parseInt(e.dataTransfer.getData("fileId") || "0");
        if (fromId && fromId !== entry.id) onDragReorder(fromId, entry.id);
      }}
      style={{
        ...fr.row,
        ...(entry.selected ? fr.rowSel : {}),
        ...(isDragOver ? fr.rowDragOver : {}),
        ...(isDragging ? fr.rowDragging : {}),
      }}
    >
      {/* チェックボックス */}
      <button style={{ ...fr.check, ...(entry.selected ? fr.checkOn : {}) }}
        onClick={onToggle}>
        {entry.selected && <span style={fr.checkMark}>✓</span>}
      </button>

      {/* ドラッグハンドル */}
      <span style={fr.handle}>⣿</span>

      {/* 番号 */}
      <span style={fr.num}>{index + 1}</span>

      {/* ファイル名・情報 */}
      <div style={fr.info}>
        <span style={fr.name} title={entry.path}>{entry.filename}</span>
        <span style={fr.meta}>{entry.pageCount}ページ{mb ? "  " + mb : ""}</span>
      </div>

      {/* 削除ボタン */}
      <button style={fr.del} onClick={onRemove} title="リストから削除">×</button>
    </div>
  );
}

// ── ツールシェル ─────────────────────────────────────────────────────────────

function ToolShell({ activeTool, toolFiles, filePath, pdfInfo, onHome, onOpenMore, onToolChange }: {
  activeTool:   ToolId;
  toolFiles:    FileEntry[];
  filePath:     string;
  pdfInfo:      PdfInfo;
  onHome:       () => void;
  onOpenMore:   () => void;
  onToolChange: (t: ToolId) => void;
}) {
  const isBatch = toolFiles.length > 1;
  const filename = filePath.split(/[/\\]/).pop() ?? "";

  return (
    <div style={sh.root}>
      {/* ナビバー */}
      <nav style={sh.nav}>
        <button style={sh.homeBtn} onClick={onHome}>
          PDF<span style={{ color: C.accent }}>小僧</span>
        </button>
        <div style={sh.divider} />

        {isBatch ? (
          <span style={sh.batchLabel}>{toolFiles.length}ファイル一括処理</span>
        ) : (
          <span style={sh.filename} title={filePath}>{filename}</span>
        )}

        <div style={{ flex: 1 }} />

        {/* ツールタブ */}
        {TOOLS.map(t => (
          <button key={t.id}
            style={{ ...sh.tab, ...(activeTool === t.id ? sh.tabOn : {}) }}
            onClick={() => !isBatch && onToolChange(t.id)}
            title={isBatch ? "一括処理中はタブ切り替え不可" : t.label}>
            <span>{t.icon}</span>
            <span style={sh.tabLabel}>{t.label}</span>
          </button>
        ))}

        <div style={sh.divider} />
        <button style={sh.openBtn} onClick={onOpenMore}>開く…</button>
      </nav>

      {/* ツール本体 */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {activeTool === "trim"     && <TrimPage        filePath={filePath} pdfInfo={pdfInfo} />}
        {activeTool === "compress" && <CompressPage    filePath={filePath} pdfInfo={pdfInfo} />}
        {activeTool === "split"    && <SplitPage       filePath={filePath} pdfInfo={pdfInfo} batchFiles={toolFiles.length>1?toolFiles:undefined} />}
        {activeTool === "merge"    && <MergePage       initPaths={toolFiles.map(f => f.path)} />}
        {activeTool === "rotate"   && <RotatePage      filePath={filePath} pdfInfo={pdfInfo} />}
        {activeTool === "image"    && <ImageExportPage filePath={filePath} pdfInfo={pdfInfo} batchFiles={toolFiles.length>1?toolFiles:undefined} />}
        {activeTool === "viewer"   && <ViewerPage      filePath={filePath} pdfInfo={pdfInfo} fileList={toolFiles.length>1?toolFiles:undefined} />}
      </div>
    </div>
  );
}

// ── スタイル: ホーム ──────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh", display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", gap: 28,
    background: C.bg, color: C.text, fontFamily: F,
    padding: "32px 40px", position: "relative",
    transition: "background 0.15s",
  },
  rootDrag: { background: "#0c1520" },

  header:  { display: "flex", flexDirection: "column", alignItems: "center", gap: 6 },
  logo:    { fontSize: 52, fontWeight: 800, color: C.text, letterSpacing: "-0.02em", lineHeight: 1 },
  tagline: { fontSize: 12, color: C.textDim, letterSpacing: "0.12em", textTransform: "uppercase" },

  // ファイルリストカード
  listCard: {
    width: "100%", maxWidth: 680,
    background: C.bgCard, border: `1px solid ${C.border}`,
    borderRadius: 14, overflow: "hidden",
    minHeight: 200,
  },
  emptyZone: {
    display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", gap: 14, padding: "52px 32px",
  },
  emptyIcon:  { fontSize: 44, color: C.borderHi },
  emptyTitle: { fontSize: 17, fontWeight: 600, color: C.textSub },
  emptySub:   { fontSize: 13, color: C.textDim },
  btnAddBig:  {
    padding: "11px 32px",
    background: C.accentBg, border: `1px solid ${C.accentBd}`,
    borderRadius: 9, color: C.accent,
    fontWeight: 700, cursor: "pointer", fontSize: 14, fontFamily: F,
  },

  fileRows: { display: "flex", flexDirection: "column" },

  listFooter: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "10px 16px",
    borderTop: `1px solid ${C.border}`,
    background: C.bg,
  },
  btnAdd:   { padding: "6px 16px", background: C.accentBg, border: `1px solid ${C.accentBd}`, borderRadius: 7, color: C.accent, cursor: "pointer", fontSize: 13, fontFamily: F, fontWeight: 600 },
  btnSm:    { padding: "6px 12px", background: "transparent", border: `1px solid ${C.borderHi}`, borderRadius: 7, color: C.textSub, cursor: "pointer", fontSize: 12, fontFamily: F },
  btnClear: { padding: "6px 14px", background: "transparent", border: `1px solid ${C.errBd}`, borderRadius: 7, color: "#aa4040", cursor: "pointer", fontSize: 12, fontFamily: F },

  // 選択サマリー
  summary:  { display: "flex", alignItems: "center", gap: 8, height: 28 },
  sumSel:   { fontSize: 15, fontWeight: 700, color: C.text },
  sumDot:   { color: C.textDim },
  sumInfo:  { fontSize: 14, color: C.textSub },
  sumNone:  { fontSize: 13, color: C.textDim },

  // ツールボタン
  toolBar: {
    display: "flex", gap: 10,
    width: "100%", maxWidth: 680,
  },
  toolBtn: {
    flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
    padding: "16px 8px", borderRadius: 12,
    border: `1px solid ${C.border}`,
    cursor: "pointer", fontFamily: F, transition: "all 0.12s",
  },
  toolBtnOn: {
    background: C.bgCard, borderColor: C.border, color: C.text,
  },
  toolBtnOff: {
    background: "transparent", borderColor: C.border,
    color: C.textDim, cursor: "not-allowed", opacity: 0.38,
  },
  toolIcon:  { fontSize: 24 },
  toolLabel: { fontSize: 13, fontWeight: 700, color: "inherit" },
  toolDesc:  { fontSize: 11, color: C.textSub, textAlign: "center" as const },

  // D&Dオーバーレイ
  dragOverlay: {
    position: "absolute", inset: 0,
    background: "rgba(10,20,40,0.88)",
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    gap: 16, borderRadius: 0,
    border: `2px dashed ${C.accent}`,
    pointerEvents: "none",
  },
  dragIcon: { fontSize: 56, color: C.accent },
  dragText: { fontSize: 20, fontWeight: 600, color: C.accent },

  error: {
    padding: "11px 22px", background: C.errBg,
    border: `1px solid ${C.errBd}`, borderRadius: 9,
    color: "#ff7070", fontSize: 13, maxWidth: 460, textAlign: "center" as const,
  },
};

// ── スタイル: FileRow ─────────────────────────────────────────────────────────

const fr: Record<string, React.CSSProperties> = {
  row: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "10px 14px",
    borderBottom: `1px solid ${C.border}`,
    background: "transparent", transition: "background 0.08s",
    userSelect: "none",
  },
  rowSel:      { background: "#0d1620" },
  rowDragOver: { background: C.accentBg, borderColor: C.accent },
  rowDragging: { opacity: 0.4 },

  check: {
    width: 20, height: 20, borderRadius: 5, flexShrink: 0,
    border: `1.5px solid ${C.borderHi}`, background: "transparent",
    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
    padding: 0, transition: "all 0.1s",
  },
  checkOn:   { background: C.accent, borderColor: C.accent },
  checkMark: { fontSize: 12, color: "#000", fontWeight: 700, lineHeight: 1 },

  handle: { fontSize: 16, color: C.borderHi, cursor: "grab", flexShrink: 0 },
  num:    { fontSize: 12, color: C.textDim, width: 22, textAlign: "center" as const, flexShrink: 0 },

  info:  { flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  name:  { fontSize: 14, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  meta:  { fontSize: 11, color: C.textSub },

  del: {
    width: 26, height: 26, flexShrink: 0,
    background: "transparent", border: "none",
    color: C.textDim, cursor: "pointer",
    fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center",
    borderRadius: 5, padding: 0, fontFamily: F,
    transition: "color 0.1s",
  },
};

// ── スタイル: ToolShell ───────────────────────────────────────────────────────

const sh: Record<string, React.CSSProperties> = {
  root:        { display: "flex", flexDirection: "column", height: "100vh", background: C.bg },
  nav:         { display: "flex", alignItems: "center", gap: 6, padding: "0 14px", height: 46, background: C.navBg, borderBottom: `1px solid ${C.navBd}`, flexShrink: 0, fontFamily: F },
  homeBtn:     { background: "transparent", border: "none", cursor: "pointer", padding: "4px 8px", borderRadius: 6, fontFamily: F, fontSize: 15, fontWeight: 700, color: C.text },
  divider:     { width: 1, height: 20, background: C.border, margin: "0 4px", flexShrink: 0 },
  filename:    { fontSize: 12, color: C.textSub, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  batchLabel:  { fontSize: 12, color: C.accent, fontWeight: 600 },
  tab:         { display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", background: "transparent", border: "1px solid transparent", borderRadius: 6, cursor: "pointer", color: C.textSub, fontFamily: F, fontSize: 12, transition: "all 0.1s" },
  tabOn:       { background: C.accentBg, borderColor: C.accentBd, color: C.accent },
  tabLabel:    { fontSize: 11 },
  openBtn:     { padding: "5px 12px", background: "transparent", border: `1px solid ${C.borderHi}`, borderRadius: 6, color: C.textSub, cursor: "pointer", fontFamily: F, fontSize: 12 },
};
