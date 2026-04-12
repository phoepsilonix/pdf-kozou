// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/App.tsx
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
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
import { isMupdfExtension, hasNonPdf } from "./lib/fileTypes";
import { ConvertOptionsPanel } from "./components/ConvertOptionsPanel";
import type { ConvertOptions } from "./lib/tauri";
import pkg from "../package.json";
import { A11yControls, LiveRegion } from "./components/A11yControls";
import { useA11y } from "./hooks/useA11y";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { tts } from "./lib/tts";
import { useI18n } from "./lib/i18n";

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

// TOOLS の静的定義 (アイコン・minFiles・maxFiles のみ)
// ラベルと説明は App コンポーネント内で useI18n() を使って動的生成する
const TOOL_DEFS: { id: ToolId; icon: string; minFiles: number; maxFiles: number | null }[] = [
  { id: "split", icon: "⊗", minFiles: 1, maxFiles: null },
  { id: "merge", icon: "⊕", minFiles: 2, maxFiles: null },
  { id: "trim", icon: "✂", minFiles: 1, maxFiles: null },
  { id: "rotate", icon: "↻", minFiles: 1, maxFiles: null },
  { id: "compress", icon: "⊙", minFiles: 1, maxFiles: null },
  { id: "image", icon: "🖼", minFiles: 1, maxFiles: null },
  { id: "viewer", icon: "👁", minFiles: 1, maxFiles: null },
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
    convertLayoutW,
    convertLayoutH,
    convertLayoutEm,
    setConvertLayout,
    updatePageCount,
  } = usePdfStore();

  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const [toolFiles, setToolFiles] = useState<FileEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [themeId, setThemeId] = useState<ThemeId>(loadThemeId);
  const dragCounter = useRef(0);
  const [statusMsg, setStatusMsg] = useState("");
  const { announceScreen, announceSuccess, announceError, announceKey } = useA11y();
  const { locale, setLocale, t } = useI18n();

  // TOOLS を言語に応じて動的生成（言語切り替え時に再レンダリングされる）
  const TOOLS = useMemo(
    () => [
      { ...TOOL_DEFS[0], label: t("tool.split"), desc: t("tool.split_desc") },
      { ...TOOL_DEFS[1], label: t("tool.merge"), desc: t("tool.merge_desc") },
      { ...TOOL_DEFS[2], label: t("tool.trim"), desc: t("tool.trim_desc") },
      { ...TOOL_DEFS[3], label: t("tool.rotate"), desc: t("tool.rotate_desc") },
      { ...TOOL_DEFS[4], label: t("tool.compress"), desc: t("tool.compress_desc") },
      { ...TOOL_DEFS[5], label: t("tool.image"), desc: t("tool.image_desc") },
      { ...TOOL_DEFS[6], label: t("tool.viewer"), desc: t("tool.viewer_desc") },
    ],
    [t],
  );

  const handleThemeChange = useCallback((id: ThemeId) => {
    setTheme(id);
    setThemeId(id);
    applyThemeCssVars(THEMES[id]);
  }, []);

  // ホーム画面表示時に読み上げ
  useEffect(() => {
    if (!activeTool) announceScreen("screen.home");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool]);

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
      // MuPDF 対応ファイルに絞り込み（PDF, EPUB, DOCX, XPS, CBZ, 画像 等）
      const pdfPaths = paths.filter((p) => isMupdfExtension(p.split(/[\/\\]/).pop() ?? p));

      await Promise.all(
        pdfPaths.map(async (path) => {
          try {
            const info = await getPdfInfo(path, {
              layoutW: convertLayoutW,
              layoutH: convertLayoutH,
              layoutEm: convertLayoutEm,
            });
            const stat = await invoke<{ size: number }>("get_file_stat", { path }).catch(() => ({
              size: 0,
            }));

            const fname = path.split(/[/\\]/).pop() ?? path;
            addFiles([
              {
                path,
                filename: fname,
                pageCount: info.page_count,
                sizeBytes: stat.size,
                selected: true,
              },
            ]);
            const addedMsg = t("file.added", { name: fname, pages: String(info.page_count) });
            setStatusMsg(addedMsg);
            announceSuccess("file.added", { name: fname, pages: String(info.page_count) });
          } catch (e) {
            announceError(String(e));
            setError(`${path.split(/[/\\]/).pop()}: ${e}`);
          }
        }),
      );
    },
    [addFiles, setError, convertLayoutW, convertLayoutH, convertLayoutEm],
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
        .filter((f) => isMupdfExtension(f.name))
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
          const info = await getPdfInfo(sel[0].path, {
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          });
          setFile(sel[0].path, info);
        } catch (e) {
          setError(String(e));
          return;
        }
      }
      setToolFiles(sel);
      setActiveTool(toolId);
    },
    [fileList, setFile, setError, convertLayoutW, convertLayoutH, convertLayoutEm],
  );

  const handleHome = useCallback(() => {
    setActiveTool(null);
    setToolFiles([]);
  }, []);

  const handleToolChange = useCallback(
    async (t: ToolId) => {
      // about への切り替えはファイル不要
      if (t === "about") {
        setActiveTool("about");
        return;
      }
      // about 画面からの切り替えは toolFiles を使う
      // toolFiles が空なら fileList の選択ファイルを代わりに使う
      const sel = toolFiles.length > 0 ? toolFiles : fileList.filter((f) => f.selected);
      if (sel.length === 0) return;
      if (t !== "merge" && t !== "viewer") {
        try {
          const info = await getPdfInfo(sel[0].path, {
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          });
          setFile(sel[0].path, info);
        } catch (e) {
          setError(String(e));
          return;
        }
      }
      // about から切り替える場合は toolFiles を更新
      if (toolFiles.length === 0 && sel.length > 0) {
        setToolFiles(sel);
      }
      setActiveTool(t);
    },
    [
      toolFiles,
      fileList,
      setFile,
      setError,
      setToolFiles,
      convertLayoutW,
      convertLayoutH,
      convertLayoutEm,
    ],
  );

  // ツール番号ショートカット（Alt+1〜7）
  // handleLaunchTool・handleToolChange の後に定義して "used before declaration" を回避
  const handleToolShortcut = useCallback(
    (toolId: ToolId, _num: number) => {
      const toolName = TOOLS.find((tool) => tool.id === toolId)?.label ?? toolId;
      if (activeTool) {
        // about 画面からの切り替えはファイルが必要
        if (activeTool === "about" && toolFiles.length === 0) {
          tts.speak(t("shortcut.tool_no_file", { name: toolName }));
          return;
        }
        handleToolChange(toolId);
        tts.speak(t("shortcut.tool_switched", { name: toolName }));
      } else {
        const selected = fileList.filter((f) => f.selected);
        if (selected.length === 0) {
          tts.speak(t("shortcut.tool_no_file", { name: toolName }));
        } else {
          handleLaunchTool(toolId);
        }
      }
    },
    [activeTool, fileList, toolFiles, handleToolChange, handleLaunchTool, TOOLS, t],
  );

  // グローバルショートカット（全画面共通）
  useKeyboardShortcuts({
    "Ctrl+O": handlePickFiles,
    "Alt+1": () => handleToolShortcut("split", 1),
    "Alt+2": () => handleToolShortcut("merge", 2),
    "Alt+3": () => handleToolShortcut("trim", 3),
    "Alt+4": () => handleToolShortcut("rotate", 4),
    "Alt+5": () => handleToolShortcut("compress", 5),
    "Alt+6": () => handleToolShortcut("image", 6),
    "Alt+7": () => handleToolShortcut("viewer", 7),
    "Alt+H": () => {
      handleHome();
      tts.speak(t("screen.home"));
    },
    "Alt+T": () => tts.toggle(),
    "Alt+L": () => setLocale(locale === "ja" ? "en" : "ja"),
    F1: () => announceKey(activeTool ? "shortcut.tool" : "shortcut.home"),
  });

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
          const info = await getPdfInfo(firstSelected.path, {
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          });
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
        activeTool={activeTool}
        toolFiles={toolFiles}
        filePath={filePath ?? ""} // 修正後（全フィールドを埋める）
        pdfInfo={
          pdfInfo ?? {
            page_count: 0,
            pdf_version: "1.4", // 仮の値（実際のPDFがない場合のダミー値）
            encrypted: false,
            linearized: false,
            pages: [], // 空配列でOK（PageBounds[]）
            metadata: {},
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
      {/* 読み上げ・言語・テーマ選択 */}
      <div
        style={{
          position: "absolute",
          top: 16,
          right: 20,
          display: "flex",
          gap: 8,
          alignItems: "center",
          zIndex: 1,
        }}
      >
        <A11yControls />
        <ThemeSwitcher currentId={themeId} onChange={handleThemeChange} />
      </div>

      {/* 募集テーマの背景画像（コンテンツエリアに薄く表示） */}
      {THEMES[themeId].cupTitle && THEMES[themeId].customBg && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundImage: `url(${THEMES[themeId].customBg})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            opacity: 1,
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
      )}
      <header style={s.header}>
        {/* アプリ名エリア（常に不透明背景） */}
        <div
          style={{
            width: "100%",
            background: "var(--c-bg)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            padding: "24px 8px 8px",
            position: "relative",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <img
              src={THEMES[themeId].customIcon ?? "/app-icon.svg"}
              style={{ width: 48, height: 48, borderRadius: 10 }}
              alt="logo"
              onError={(e) => {
                (e.target as HTMLImageElement).src = "/app-icon.svg";
              }}
            />
            <span style={s.logo}>
              PDF<span style={{ color: "var(--c-accent)" }}>小僧</span>
            </span>
            {/* Aboutボタン */}
            <button
              onClick={() => setActiveTool("about")}
              style={{
                background: "var(--c-bgSub)",
                border: "1px solid var(--c-border)",
                borderRadius: "18px",
                padding: "4px 12px",
                fontSize: "12px",
                color: "var(--c-textSub)",
                cursor: "pointer",
                marginTop: "4px",
              }}
            >
              ℹ️ About
            </button>
          </div>

          {(THEMES[themeId].cupTitle && (
            <span style={{ ...s.tagline, position: "relative", width: "30%" }}>v{pkg.version}</span>
          )) || <span style={{ ...s.tagline, position: "relative" }}>v{pkg.version}</span>}

          {/* 背景画像クレジット */}
          {THEMES[themeId].customBg && (
            <div
              style={{
                width: "100%",
                position: "relative",
              }}
            >
              {/* クレジット表示（ヘッダー画像の右下） */}
              {THEMES[themeId].cupTitle && (
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    bottom: -6,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-end",
                    gap: 1,
                    background: "rgba(0,0,0,0.45)",
                    borderRadius: 4,
                    padding: "6px 6px 10px 10px",
                  }}
                >
                  <span style={{ fontSize: 10, color: "#fff", fontWeight: 700 }}>
                    {t("theme.kozou-cup")}
                  </span>
                  {THEMES[themeId].customIconCredit && (
                    <span style={{ fontSize: 9, color: "rgba(255,255,255,0.8)" }}>
                      {t("theme.icon")} © {THEMES[themeId].customIconYear}{" "}
                      {THEMES[themeId].customIconCredit}
                    </span>
                  )}
                  {THEMES[themeId].customBgCredit && (
                    <span style={{ fontSize: 9, color: "rgba(255,255,255,0.8)" }}>
                      {t("theme.bg")} © {THEMES[themeId].customBgYear}{" "}
                      {THEMES[themeId].customBgCredit}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          <span style={{ ...s.tagline }}>{t("app.tagline")}</span>
        </div>
      </header>

      {fileList.length > 0 && (
        <div style={s.toolBar}>
          {TOOLS.map((tool) => {
            const enabled =
              selCount >= tool.minFiles && (tool.maxFiles == null || selCount <= tool.maxFiles);
            return (
              <button
                key={tool.id}
                style={{ ...s.toolBtn, ...(enabled ? s.toolBtnOn : s.toolBtnOff) }}
                onClick={() => enabled && handleLaunchTool(tool.id)}
                disabled={!enabled}
                aria-label={`Alt+${TOOL_DEFS.findIndex((d) => d.id === tool.id) + 1} ${tool.label}: ${tool.desc}${!enabled ? ` (${t("app.select_prompt")})` : ""}`}
                onFocus={() => {
                  const num = TOOL_DEFS.findIndex((d) => d.id === tool.id) + 1;
                  const msg = enabled
                    ? t("home.tool_focus", { num: String(num), name: tool.label, desc: tool.desc })
                    : t("home.tool_focus_disabled", { num: String(num), name: tool.label });
                  tts.speak(msg);
                }}
              >
                <span style={s.toolIcon}>{tool.icon}</span>
                <span style={s.toolLabel}>{tool.label}</span>
                <span style={s.toolDesc}>
                  {selCount > 1 && !["merge", "viewer"].includes(tool.id)
                    ? `${selCount}${t("file.batch_suffix")}`
                    : tool.desc}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div style={s.listCard}>
        {fileList.length === 0 ? (
          <div style={s.emptyZone}>
            {/*            <span style={s.emptyIcon}>⊕</span>
            <span style={s.emptyTitle}>PDFをドロップ、または追加</span>
            <span style={s.emptySub}>複数ファイルを一度に追加できます</span>*/}
            <button
              style={s.btnAddBig}
              onClick={handlePickFiles}
              aria-label={t("app.select_file_hint")}
              onFocus={() => tts.speak(t("app.select_file_hint"))}
            >
              {t("app.select_file")}
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
                {t("file.add")}
              </button>
              <button style={s.btnSm} onClick={selectAll}>
                {t("file.select_all")}
              </button>
              <button style={s.btnSm} onClick={selectNone}>
                {t("file.deselect")}
              </button>
              <div style={{ flex: 1 }} />
              <button style={s.btnClear} onClick={clearList}>
                {t("file.clear")}
              </button>
            </div>
          </>
        )}
      </div>

      {fileList.length > 0 && (
        <div style={s.summary}>
          {selCount > 0 ? (
            <>
              <span style={s.sumSel}>{t("file.sel_count", { count: String(selCount) })}</span>
              <span style={s.sumDot}>·</span>
              <span style={s.sumInfo}>{t("file.sel_pages", { pages: String(selPages) })}</span>
              {selBytes > 0 && (
                <>
                  <span style={s.sumDot}>·</span>
                  <span style={s.sumInfo}>{(selBytes / 1048576).toFixed(1)} MB</span>
                </>
              )}
            </>
          ) : (
            <span style={s.sumNone}>{t("app.no_file_hint")}</span>
          )}
        </div>
      )}

      {/* 非 PDF が含まれる場合にレイアウト設定パネルを表示 */}
      {hasNonPdf(fileList.map((f) => f.filename)) && (
        <div style={{ padding: "0 12px" }}>
          <ConvertOptionsPanel
            options={{
              layoutW: convertLayoutW,
              layoutH: convertLayoutH,
              layoutEm: convertLayoutEm,
            }}
            onChange={async (opts) => {
              const w = opts.layoutW ?? 450;
              const h = opts.layoutH ?? 600;
              const em = opts.layoutEm ?? 12;
              setConvertLayout(w, h, em);
              // レイアウト変更後、非 PDF ファイルのページ数を再取得
              const nonPdfFiles = fileList.filter(
                (f) => !f.filename.toLowerCase().endsWith(".pdf"),
              );
              for (const f of nonPdfFiles) {
                try {
                  const info = await getPdfInfo(f.path, { layoutW: w, layoutH: h, layoutEm: em });
                  updatePageCount(f.path, info.page_count);
                  // 現在アクティブなファイルの pdfInfo も更新する
                  if (f.path === filePath) {
                    setFile(f.path, info);
                  }
                } catch {
                  /* 失敗は無視 */
                }
              }
            }}
          />
        </div>
      )}

      {/*
      {dragOver && (
        <div style={s.dragOverlay}>
          <span style={s.dragIcon}>⊕</span>
          <span style={s.dragText}>{t("app.drag_text")}</span>
        </div>
      )}*/}
      {lastError && <div style={s.error}>{lastError}</div>}
      <LiveRegion message={statusMsg} />
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
  const { t } = useI18n();
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const mb = entry.sizeBytes > 0 ? (entry.sizeBytes / 1048576).toFixed(1) + " MB" : "";
  return (
    <div
      tabIndex={0}
      role="listitem"
      draggable
      onFocus={() => {
        const info = `${entry.filename}、${entry.pageCount}${t("file.pages_unit")}`;
        tts.speak(info);
      }}
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
          {entry.pageCount}
          {t("file.pages_unit")}
          {mb ? "  " + mb : ""}
        </span>
      </div>
      <button style={fr.del} onClick={onRemove} title={t("app.delete_file")}>
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
  const { t } = useI18n();
  const { announceKey } = useA11y();
  const TOOLS = useMemo(
    () => [
      { ...TOOL_DEFS[0], label: t("tool.split"), desc: t("tool.split_desc") },
      { ...TOOL_DEFS[1], label: t("tool.merge"), desc: t("tool.merge_desc") },
      { ...TOOL_DEFS[2], label: t("tool.trim"), desc: t("tool.trim_desc") },
      { ...TOOL_DEFS[3], label: t("tool.rotate"), desc: t("tool.rotate_desc") },
      { ...TOOL_DEFS[4], label: t("tool.compress"), desc: t("tool.compress_desc") },
      { ...TOOL_DEFS[5], label: t("tool.image"), desc: t("tool.image_desc") },
      { ...TOOL_DEFS[6], label: t("tool.viewer"), desc: t("tool.viewer_desc") },
    ],
    [t],
  );
  const filename = filePath.split(/[/\\]/).pop() ?? "";
  const batchFiles = isBatch ? toolFiles : undefined;

  // ツール画面でのショートカット（切り替え + ホーム）
  useKeyboardShortcuts({
    "Alt+1": () => {
      onToolChange("split");
      tts.speak(t("shortcut.tool_switched", { name: t("tool.split") }));
    },
    "Alt+2": () => {
      onToolChange("merge");
      tts.speak(t("shortcut.tool_switched", { name: t("tool.merge") }));
    },
    "Alt+3": () => {
      onToolChange("trim");
      tts.speak(t("shortcut.tool_switched", { name: t("tool.trim") }));
    },
    "Alt+4": () => {
      onToolChange("rotate");
      tts.speak(t("shortcut.tool_switched", { name: t("tool.rotate") }));
    },
    "Alt+5": () => {
      onToolChange("compress");
      tts.speak(t("shortcut.tool_switched", { name: t("tool.compress") }));
    },
    "Alt+6": () => {
      onToolChange("image");
      tts.speak(t("shortcut.tool_switched", { name: t("tool.image") }));
    },
    "Alt+7": () => {
      onToolChange("viewer");
      tts.speak(t("shortcut.tool_switched", { name: t("tool.viewer") }));
    },
    "Alt+H": () => {
      onHome();
      tts.speak(t("screen.home"));
    },
    F1: () => announceKey("shortcut.tool"),
  });

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
          <span style={sh.batchLabel}>{t("app.about_label")}</span>
        ) : isBatch ? (
          <span style={sh.batchLabel}>📂 {toolFiles.length}ファイル</span>
        ) : (
          <span style={sh.filename} title={filePath}>
            {filename}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            style={{ ...sh.tab, ...(activeTool === tool.id ? sh.tabOn : {}) }}
            onClick={(e) => {
              onToolChange(tool.id);
              (e.currentTarget as HTMLButtonElement).blur();
            }}
            title={`${tool.label} (Alt+${TOOL_DEFS.findIndex((d) => d.id === tool.id) + 1})`}
            aria-label={`${tool.label} Alt+${TOOL_DEFS.findIndex((d) => d.id === tool.id) + 1}${activeTool === tool.id ? " 現在のツール" : ""}`}
          >
            <span>{tool.icon}</span>
            <span style={sh.tabLabel}>{tool.label}</span>
          </button>
        ))}
        <div style={sh.div} />
        <A11yControls />
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
  rootDrag: { background: "var(--c-accentBg)" },
  header: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6,
    position: "relative" as const,
  },
  logo: {
    fontSize: 52,
    fontWeight: 800,
    height: 78,
    lineHeight: 2,
    color: "var(--c-text)",
    padding: "4pt",
    letterSpacing: "-0.02em",
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
    position: "relative" as const,
    zIndex: 1, // 背景画像より前面に
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
  toolBar: {
    display: "flex",
    gap: 9,
    width: "100%",
    maxWidth: 720,
    flexWrap: "wrap",
    position: "relative" as const,
    zIndex: 1,
  },
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
    backgroundColor: "var(--c-accentBg)",
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
    color: "var(--c-err)",
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
  rowSel: { background: "var(--c-accentBg)" },
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
  checkMark: { fontSize: 13, color: "var(--c-accentText)", fontWeight: 700, lineHeight: 1 },
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
