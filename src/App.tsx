// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/App.tsx
import { useState, useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { TrimPage } from "./pages/TrimPage";
import { CompressPage } from "./pages/CompressPage";
import { SplitPage } from "./pages/SplitPage";
import { MergePage } from "./pages/MergePage";
import { RotatePage } from "./pages/RotatePage";
import { ImageExportPage } from "./pages/ImageExportPage";
import { ViewerPage } from "./pages/ViewerPage";
import LicensePage from "./pages/LicensePage";

import { usePdfStore, type FileEntry } from "./store/usePdfStore";
import { getPdfInfo, type PdfInfo } from "./lib/tauri";
import { invoke } from "@tauri-apps/api/core";
import pkg from "../package.json";

//import { C, F, setTheme, loadThemeId, getTheme, THEMES, applyThemeCssVars, initThemeCssVars } from "./lib/theme";
import {
  C,
  F,
  setTheme,
  loadThemeId,
  THEMES,
  applyThemeCssVars,
  initThemeCssVars,
} from "./lib/theme";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import type { ThemeId } from "./lib/themes";

// GLOBAL_CSS は関数にして themeId 変更時に再評価
function makeGlobalCss(t: typeof C) {
  return `
  * { box-sizing: border-box; }
  body { margin: 0; background: ${t.bg}; font-size: 15px; }
  @keyframes spin   { to { transform: rotate(360deg); } }
  @keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
  input[type=number]::-webkit-inner-spin-button { opacity:0.5; }
  input:focus  { border-color:${t.accent} !important; outline:none; }
  ::-webkit-scrollbar       { width:6px; height:6px; }
  ::-webkit-scrollbar-track { background:${t.bg}; }
  ::-webkit-scrollbar-thumb { background:${t.borderHi}; border-radius:3px; }
  button:hover:not(:disabled) { filter:brightness(1.1); }
  button:active:not(:disabled){ filter:brightness(0.9); }
  button:focus         { outline: none !important; box-shadow: none !important; }
  button:focus-visible { outline: 2px solid ${t.accent}; outline-offset: 2px; }
  button:focus:not(:focus-visible) { outline: none !important; box-shadow: none !important; }
  button:disabled { cursor:not-allowed !important; }
`;
}

export type ToolId =
  | "split"
  | "merge"
  | "trim"
  | "rotate"
  | "compress"
  | "image"
  | "viewer"
  | "about";

const TOOLS: {
  id: ToolId;
  icon: string;
  label: string;
  desc: string;
  minFiles: number;
  maxFiles: number | null;
}[] = [
  { id: "split", icon: "⊗", label: "分割", desc: "ページを分割", minFiles: 1, maxFiles: null },
  { id: "merge", icon: "⊕", label: "結合", desc: "複数PDFを合体", minFiles: 2, maxFiles: null },
  { id: "trim", icon: "✂", label: "トリミング", desc: "余白をカット", minFiles: 1, maxFiles: null },
  { id: "rotate", icon: "↻", label: "回転", desc: "ページを回転", minFiles: 1, maxFiles: null },
  {
    id: "compress",
    icon: "⊙",
    label: "圧縮",
    desc: "ファイルを軽量化",
    minFiles: 1,
    maxFiles: null,
  },
  {
    id: "image",
    icon: "🖼",
    label: "画像変換",
    desc: "ページを画像に",
    minFiles: 1,
    maxFiles: null,
  },
  {
    id: "viewer",
    icon: "👁",
    label: "ビューワー",
    desc: "PDFを確認・閲覧",
    minFiles: 1,
    maxFiles: null,
  },
];

export default function App() {
  const {
    fileList,
    addFiles,
    removeFile,
    toggleSelect,
    selectAll,
    selectNone,
    clearList,
    reorderFiles,
    setFile,
    setError,
    lastError,
  } = usePdfStore();

  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const [toolFiles, setToolFiles] = useState<FileEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [themeId, setThemeId] = useState<ThemeId>(loadThemeId);
  const dragCounter = useRef(0);

  const handleThemeChange = useCallback((id: ThemeId) => {
    setTheme(id);
    setThemeId(id);
    applyThemeCssVars(THEMES[id]);
  }, []);

  useEffect(() => {
    const t = THEMES[themeId];
    initThemeCssVars();
    const el = document.createElement("style");
    el.textContent = makeGlobalCss(t);
    document.head.appendChild(el);
    document.body.style.background = t.bg;
    return () => {
      document.head.removeChild(el);
    };
  }, [themeId]);

  const handleAddPaths = useCallback(
    async (paths: string[]) => {
      // PDFファイルのみに絞り込み
      const pdfPaths = paths.filter((p) => p.toLowerCase().endsWith(".pdf"));

      await Promise.all(
        pdfPaths.map(async (path) => {
          try {
            const info = await getPdfInfo(path);
            const stat = await invoke<{ size: number }>("get_file_stat", { path }).catch(() => ({
              size: 0,
            }));

            addFiles([
              {
                path,
                filename: path.split(/[/\\]/).pop() ?? path,
                pageCount: info.page_count,
                sizeBytes: stat.size,
                selected: true,
              },
            ]);
          } catch (e) {
            setError(`${path.split(/[/\\]/).pop()}: ${e}`);
          }
        }),
      );
    },
    [addFiles, setError],
  );

  useEffect(() => {
    let unlistenCustom: (() => void) | null = null;
    const setupListeners = async () => {
      unlistenCustom = await listen<string[]>("open-pdf-files", (event) => {
        handleAddPaths(event.payload);
      });
    };
    setupListeners();

    return () => {
      if (unlistenCustom) unlistenCustom();
    };
  }, [handleAddPaths]);

  const handlePickFiles = useCallback(async () => {
    const paths = await invoke<string[]>("pick_open_files").catch(() => [] as string[]);
    if (paths.length) await handleAddPaths(paths);
  }, [handleAddPaths]);
  /*
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);
      const paths = Array.from(e.dataTransfer.files)
        .filter((f) => f.name.toLowerCase().endsWith(".pdf"))
        .map((f) => (f as any).path as string)
        .filter(Boolean);
      if (paths.length) await handleAddPaths(paths);
    },
    [handleAddPaths],
  );*/

  const handleLaunchTool = useCallback(
    async (toolId: ToolId) => {
      const sel = fileList.filter((f) => f.selected);
      if (sel.length === 0) return;
      if (toolId !== "merge" && toolId !== "viewer") {
        try {
          const info = await getPdfInfo(sel[0].path);
          setFile(sel[0].path, info);
        } catch (e) {
          setError(String(e));
          return;
        }
      }
      setToolFiles(sel);
      setActiveTool(toolId);
    },
    [fileList, setFile, setError],
  );

  const handleHome = useCallback(() => {
    setActiveTool(null);
    setToolFiles([]);
  }, []);

  const handleToolChange = useCallback(
    async (t: ToolId) => {
      const sel = toolFiles;
      if (sel.length === 0) return;
      if (t !== "merge" && t !== "viewer") {
        try {
          const info = await getPdfInfo(sel[0].path);
          setFile(sel[0].path, info);
        } catch (e) {
          setError(String(e));
          return;
        }
      }
      setActiveTool(t);
    },
    [toolFiles, setFile, setError],
  );

  const sel = fileList.filter((f) => f.selected);
  const selCount = sel.length;
  const selPages = sel.reduce((s, f) => s + f.pageCount, 0);
  const selBytes = sel.reduce((s, f) => s + f.sizeBytes, 0);

  const { filePath, pdfInfo } = usePdfStore();

  useEffect(() => {
    const syncSelectedFileInfo = async () => {
      // 選択されている最初のファイルを取得
      const firstSelected = fileList.find((f) => f.selected);

      if (firstSelected) {
        // すでにロード済みのファイルと同じなら何もしない
        if (firstSelected.path === filePath) return;

        try {
          const info = await getPdfInfo(firstSelected.path);
          setFile(firstSelected.path, info);
        } catch (e) {
          console.error("Failed to sync PDF info:", e);
          // 必要に応じて setError(`${firstSelected.filename}: ${e}`);
        }
      } else if (fileList.length > 0 && !filePath) {
        // 何も選択されていないが、リストにファイルがある場合の初期ロード（任意）
        // 1番目のファイルを暫定的にロードしておくならここ
      }
    };

    syncSelectedFileInfo();
  }, [fileList, filePath, setFile]);

  console.log("App: filePath, pdfInfo", filePath, pdfInfo);

  if (activeTool) {
    const isBatch = toolFiles.length > 1;
    return (
      <ToolShell
        key={themeId}
        activeTool={activeTool}
        toolFiles={toolFiles}
        filePath={filePath ?? ""} // 修正後（全フィールドを埋める）
        pdfInfo={
          pdfInfo ?? {
            page_count: 0,
            pdf_version: "1.7", // 仮の値（実際のPDFがない場合のダミー値）
            encrypted: false,
            linearized: false,
            pages: [], // 空配列でOK（PageBounds[]）
          }
        }
        onHome={handleHome}
        onToolChange={handleToolChange}
        isBatch={isBatch}
        themeId={themeId}
        onThemeChange={handleThemeChange}
      />
    );
  }

  return (
    <div
      key={themeId}
      style={{ ...s.root, ...(dragOver ? s.rootDrag : {}) }}
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={(e) => {
        e.preventDefault();
        dragCounter.current++;
        setDragOver(true);
      }}
      onDragLeave={() => {
        if (--dragCounter.current <= 0) {
          setDragOver(false);
          dragCounter.current = 0;
        }
      }}
    >
      <header style={s.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <img src="/app-icon.svg" style={{ width: 48, height: 48, borderRadius: 10 }} alt="logo" />
          <span style={s.logo}>
            PDF<span style={{ color: "var(--c-accent)" }}>小僧</span>
            　　
          </span>
          {/* Aboutボタンを追加 */}
          <button
            onClick={() => setActiveTool("about")}
            style={{
              background: "var(--c-bgSub)",
              border: "1px solid var(--c-border)",
              borderRadius: "20px",
              padding: "4px 12px",
              fontSize: "12px",
              color: "var(--c-textSub)",
              cursor: "pointer",
              marginTop: "10px",
            }}
          >
            ℹ️ About
          </button>
        </div>
        <span style={{ ...s.tagline, marginBottom: 8, opacity: 0.8 }}>v{pkg.version}</span>
        <span style={s.tagline}>Rust with tauri · MuPDF · オフライン完全動作</span>
        <div style={{ position: "absolute", top: 16, right: 20 }}>
          <ThemeSwitcher currentId={themeId} onChange={handleThemeChange} />
        </div>
      </header>

      <div style={s.listCard}>
        {fileList.length === 0 ? (
          <div style={s.emptyZone}>
            {/*            <span style={s.emptyIcon}>⊕</span>
            <span style={s.emptyTitle}>PDFをドロップ、または追加</span>
            <span style={s.emptySub}>複数ファイルを一度に追加できます</span>*/}
            <button style={s.btnAddBig} onClick={handlePickFiles}>
              ファイルを選択…
            </button>
          </div>
        ) : (
          <>
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
            <div style={s.listFooter}>
              <button style={s.btnAdd} onClick={handlePickFiles}>
                ＋ 追加
              </button>
              <button style={s.btnSm} onClick={selectAll}>
                全選択
              </button>
              <button style={s.btnSm} onClick={selectNone}>
                解除
              </button>
              <div style={{ flex: 1 }} />
              <button style={s.btnClear} onClick={clearList}>
                クリア
              </button>
            </div>
          </>
        )}
      </div>

      {fileList.length > 0 && (
        <div style={s.summary}>
          {selCount > 0 ? (
            <>
              <span style={s.sumSel}>{selCount}ファイル選択中</span>
              <span style={s.sumDot}>·</span>
              <span style={s.sumInfo}>{selPages}ページ</span>
              {selBytes > 0 && (
                <>
                  <span style={s.sumDot}>·</span>
                  <span style={s.sumInfo}>{(selBytes / 1048576).toFixed(1)} MB</span>
                </>
              )}
            </>
          ) : (
            <span style={s.sumNone}>ファイルを選択してください</span>
          )}
        </div>
      )}

      {fileList.length > 0 && (
        <div style={s.toolBar}>
          {TOOLS.map((t) => {
            const enabled =
              selCount >= t.minFiles && (t.maxFiles == null || selCount <= t.maxFiles);
            return (
              <button
                key={t.id}
                style={{ ...s.toolBtn, ...(enabled ? s.toolBtnOn : s.toolBtnOff) }}
                onClick={() => enabled && handleLaunchTool(t.id)}
                disabled={!enabled}
              >
                <span style={s.toolIcon}>{t.icon}</span>
                <span style={s.toolLabel}>{t.label}</span>
                <span style={s.toolDesc}>
                  {selCount > 1 && !["merge", "viewer"].includes(t.id)
                    ? `${selCount}件一括`
                    : t.desc}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {/*
      {dragOver && (
        <div style={s.dragOverlay}>
          <span style={s.dragIcon}>⊕</span>
          <span style={s.dragText}>PDFをドロップして追加</span>
        </div>
      )}*/}
      {lastError && <div style={s.error}>{lastError}</div>}
    </div>
  );
}

// ── FileRow ──────────────────────────────────────────────────────────────────

function FileRow({
  entry,
  index,
  onToggle,
  onRemove,
  onDragReorder,
}: {
  entry: FileEntry;
  index: number;
  onToggle: () => void;
  onRemove: () => void;
  onDragReorder: (f: number, t: number) => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const mb = entry.sizeBytes > 0 ? (entry.sizeBytes / 1048576).toFixed(1) + " MB" : "";
  return (
    <div
      draggable
      onDragStart={(e) => {
        setIsDragging(true);
        e.dataTransfer.setData("fileId", String(entry.id));
      }}
      onDragEnd={() => {
        setIsDragging(false);
        setIsDragOver(false);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        const fid = parseInt(e.dataTransfer.getData("fileId") || "0");
        if (fid && fid !== entry.id) onDragReorder(fid, entry.id);
      }}
      style={{
        ...fr.row,
        ...(entry.selected ? fr.rowSel : {}),
        ...(isDragOver ? fr.rowDO : {}),
        ...(isDragging ? fr.rowDrag : {}),
      }}
    >
      <button style={{ ...fr.check, ...(entry.selected ? fr.checkOn : {}) }} onClick={onToggle}>
        {entry.selected && <span style={fr.checkMark}>✓</span>}
      </button>
      <span style={fr.handle}>⣿</span>
      <span style={fr.num}>{index + 1}</span>
      <div style={fr.info}>
        <span style={fr.name} title={entry.path}>
          {entry.filename}
        </span>
        <span style={fr.meta}>
          {entry.pageCount}ページ{mb ? "  " + mb : ""}
        </span>
      </div>
      <button style={fr.del} onClick={onRemove} title="削除">
        ×
      </button>
    </div>
  );
}

// ── ToolShell ────────────────────────────────────────────────────────────────

function ToolShell({
  activeTool,
  toolFiles,
  filePath,
  pdfInfo,
  onHome,
  onToolChange,
  isBatch,
  themeId,
  onThemeChange,
}: {
  activeTool: ToolId;
  toolFiles: FileEntry[];
  filePath: string;
  pdfInfo: PdfInfo;
  onHome: () => void;
  onToolChange: (t: ToolId) => void;
  isBatch: boolean;
  themeId: ThemeId;
  onThemeChange: (id: ThemeId) => void;
}) {
  const filename = filePath.split(/[/\\]/).pop() ?? "";
  const batchFiles = isBatch ? toolFiles : undefined;

  return (
    <div style={sh.root}>
      <nav style={sh.nav}>
        <button style={sh.homeBtn} onClick={onHome}>
          PDF<span style={{ color: "var(--c-accent)" }}>小僧</span>
          <span
            style={{
              color: "var(--c-text)",
              fontSize: 10,
              opacity: 0.6,
              marginLeft: 12,
              fontWeight: 400,
            }}
          >
            {" "}
            v{pkg.version}
          </span>
          <img src="/app-icon.svg" style={{ width: 20, height: 20, borderRadius: 4 }} alt="" />
        </button>
        <div style={sh.div} />
        {activeTool === "about" ? (
          <span style={sh.batchLabel}>ℹ️ アプリについて</span>
        ) : isBatch ? (
          <span style={sh.batchLabel}>📂 {toolFiles.length}ファイル</span>
        ) : (
          <span style={sh.filename} title={filePath}>
            {filename}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {TOOLS.map((t) => (
          <button
            key={t.id}
            style={{ ...sh.tab, ...(activeTool === t.id ? sh.tabOn : {}) }}
            onClick={(e) => {
              onToolChange(t.id);
              (e.currentTarget as HTMLButtonElement).blur();
            }}
            title={t.label}
          >
            <span>{t.icon}</span>
            <span style={sh.tabLabel}>{t.label}</span>
          </button>
        ))}
        <div style={sh.div} />
        <ThemeSwitcher currentId={themeId} onChange={onThemeChange} />
      </nav>

      <div style={{ flex: 1, overflow: "hidden" }}>
        {activeTool === "trim" && (
          <TrimPage filePath={filePath} pdfInfo={pdfInfo} batchFiles={batchFiles} />
        )}
        {activeTool === "compress" && (
          <CompressPage filePath={filePath} pdfInfo={pdfInfo} batchFiles={batchFiles} />
        )}
        {activeTool === "split" && (
          <SplitPage filePath={filePath} pdfInfo={pdfInfo} batchFiles={batchFiles} />
        )}
        {activeTool === "merge" && <MergePage initPaths={toolFiles.map((f) => f.path)} />}
        {activeTool === "rotate" && (
          <RotatePage filePath={filePath} pdfInfo={pdfInfo} batchFiles={batchFiles} />
        )}
        {activeTool === "image" && (
          <ImageExportPage filePath={filePath} pdfInfo={pdfInfo} batchFiles={batchFiles} />
        )}
        {activeTool === "viewer" && (
          <ViewerPage filePath={filePath} pdfInfo={pdfInfo} fileList={batchFiles} />
        )}
        {activeTool === "about" && <LicensePage />}
      </div>
    </div>
  );
}

// ── styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 24,
    background: "var(--c-bg)",
    color: "var(--c-text)",
    fontFamily: F,
    padding: "28px 32px",
    position: "relative",
    transition: "background 0.15s",
  },
  rootDrag: { background: "#0e1510" },
  header: { display: "flex", flexDirection: "column", alignItems: "center", gap: 6 },
  logo: {
    fontSize: 52,
    fontWeight: 800,
    color: "var(--c-text)",
    letterSpacing: "-0.02em",
    lineHeight: 1,
  },
  tagline: {
    fontSize: 12,
    color: "var(--c-textDim)",
    letterSpacing: "0.12em",
    //    textTransform: "uppercase",
  },
  listCard: {
    width: "100%",
    maxWidth: 720,
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 12,
    overflow: "hidden",
    minHeight: 180,
  },
  emptyZone: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    padding: "48px 28px",
  },
  emptyIcon: { fontSize: 44, color: "var(--c-borderHi)" },
  emptyTitle: { fontSize: 18, fontWeight: 600, color: "var(--c-textSub)" },
  emptySub: { fontSize: 14, color: "var(--c-textDim)" },
  btnAddBig: {
    padding: "12px 32px",
    background: "var(--c-accentBg)",
    border: `1px solid var(--c-accentBd)`,
    borderRadius: 8,
    color: "var(--c-accent)",
    fontWeight: 700,
    cursor: "pointer",
    fontSize: 15,
    fontFamily: F,
  },
  fileRows: { display: "flex", flexDirection: "column" },
  listFooter: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 16px",
    borderTop: `1px solid var(--c-border)`,
    background: "var(--c-bg)",
  },
  btnAdd: {
    padding: "6px 16px",
    background: "var(--c-accentBg)",
    border: `1px solid var(--c-accentBd)`,
    borderRadius: 7,
    color: "var(--c-accent)",
    cursor: "pointer",
    fontSize: 13,
    fontFamily: F,
    fontWeight: 600,
  },
  btnSm: {
    padding: "6px 13px",
    background: "transparent",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 7,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontSize: 13,
    fontFamily: F,
  },
  btnClear: {
    padding: "6px 14px",
    background: "transparent",
    border: `1px solid var(--c-errBd)`,
    borderRadius: 7,
    color: "var(--c-err)",
    cursor: "pointer",
    fontSize: 13,
    fontFamily: F,
  },
  summary: { display: "flex", alignItems: "center", gap: 9, height: 28 },
  sumSel: { fontSize: 16, fontWeight: 700, color: "var(--c-text)" },
  sumDot: { color: "var(--c-textDim)" },
  sumInfo: { fontSize: 15, color: "var(--c-textSub)" },
  sumNone: { fontSize: 14, color: "var(--c-textDim)" },
  toolBar: { display: "flex", gap: 9, width: "100%", maxWidth: 720, flexWrap: "wrap" },
  toolBtn: {
    flex: "1 1 88px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 5,
    padding: "16px 8px",
    borderRadius: 11,
    border: `1px solid var(--c-border)`,
    cursor: "pointer",
    fontFamily: F,
    transition: "all 0.12s",
  },
  toolBtnOn: {
    background: "var(--c-bgCard)",
    borderColor: "var(--c-borderHi)",
    color: "var(--c-text)",
  },
  toolBtnOff: {
    background: "transparent",
    borderColor: "var(--c-border)",
    color: "var(--c-textDim)",
    opacity: 0.38,
  },
  toolIcon: { fontSize: 24 },
  toolLabel: { fontSize: 14, fontWeight: 700, color: "inherit" },
  toolDesc: { fontSize: 11, color: "var(--c-textSub)", textAlign: "center" as const },
  dragOverlay: {
    position: "fixed" as const, // fixedにすることで他の要素を動かさない
    inset: 0,
    backgroundColor: "rgba(0, 0, 0, 0.2)",
    border: "3px dashed var(--c-accent)",
    zIndex: 9999,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none" as const, // これが重要！マウス操作を透過させる
  },
  dragIcon: { fontSize: 56, color: "var(--c-accent)" },
  dragText: { fontSize: 20, fontWeight: 600, color: "var(--c-accent)" },
  error: {
    padding: "11px 22px",
    background: "var(--c-errBg)",
    border: `1px solid var(--c-errBd)`,
    borderRadius: 9,
    color: "#ff7070",
    fontSize: 13,
    maxWidth: 460,
    textAlign: "center" as const,
  },
};

const fr: Record<string, React.CSSProperties> = {
  row: {
    display: "flex",
    alignItems: "center",
    gap: 11,
    padding: "11px 14px",
    borderBottom: `1px solid var(--c-border)`,
    background: "transparent",
    transition: "background 0.08s",
    userSelect: "none",
  },
  rowSel: { background: "#192b1e" },
  rowDO: { background: "var(--c-accentBg)", borderColor: "var(--c-accent)" },
  rowDrag: { opacity: 0.4 },
  check: {
    width: 22,
    height: 22,
    borderRadius: 5,
    flexShrink: 0,
    border: `1.5px solid var(--c-borderHi)`,
    background: "transparent",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    transition: "all 0.1s",
  },
  checkOn: { background: "var(--c-accent)", borderColor: "var(--c-accent)" },
  checkMark: { fontSize: 13, color: "#000", fontWeight: 700, lineHeight: 1 },
  handle: { fontSize: 16, color: "var(--c-borderHi)", cursor: "grab", flexShrink: 0 },
  num: {
    fontSize: 13,
    color: "var(--c-textDim)",
    width: 22,
    textAlign: "center" as const,
    flexShrink: 0,
  },
  info: { flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  name: {
    fontSize: 15,
    color: "var(--c-text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  meta: { fontSize: 12, color: "var(--c-textSub)" },
  del: {
    width: 26,
    height: 26,
    flexShrink: 0,
    background: "transparent",
    border: "none",
    color: "var(--c-textDim)",
    cursor: "pointer",
    fontSize: 17,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 5,
    padding: 0,
    fontFamily: F,
  },
};

const sh: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100vh", background: "var(--c-bg)" },
  nav: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "0 14px",
    height: 46,
    background: "var(--c-navBg)",
    borderBottom: `1px solid var(--c-navBd)`,
    flexShrink: 0,
    fontFamily: F,
    position: "relative",
    zIndex: 10,
    overflow: "visible",
  },
  homeBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: 5,
    fontFamily: F,
    fontSize: 15,
    fontWeight: 700,
    color: "var(--c-text)",
    whiteSpace: "nowrap",
    display: "flex",
    alignItems: "center",
  },
  div: { width: 1, height: 20, background: "var(--c-border)", margin: "0 3px", flexShrink: 0 },
  filename: {
    fontSize: 12,
    color: "var(--c-textSub)",
    maxWidth: 180,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  batchLabel: {
    fontSize: 12,
    color: "var(--c-accent)",
    fontWeight: 600,
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 9px",
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: 5,
    cursor: "pointer",
    color: "var(--c-textSub)",
    fontFamily: F,
    fontSize: 12,
    transition: "all 0.1s",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  tabOn: {
    background: "var(--c-accentBg)",
    borderColor: "var(--c-accentBd)",
    color: "var(--c-accent)",
  },
  tabLabel: { fontSize: 11 },
  openBtn: {
    padding: "4px 11px",
    background: "transparent",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 5,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontFamily: F,
    fontSize: 12,
    flexShrink: 0,
  },
};
