// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
// src/App.tsx
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

const TrimPage = lazy(() => import("./pages/TrimPage"));
const CompressPage = lazy(() => import("./pages/CompressPage"));
const SplitPage = lazy(() => import("./pages/SplitPage"));
const MergePage = lazy(() => import("./pages/MergePage"));
const RotatePage = lazy(() => import("./pages/RotatePage"));
const ImageExportPage = lazy(() => import("./pages/ImageExportPage"));
const ViewerPage = lazy(() => import("./pages/ViewerPage"));
const HiddenTextPage = lazy(() => import("./pages/HiddenTextPage"));
const PageSizeBookletPage = lazy(() => import("./pages/PageSizeBookletPage"));
const LicensePage = lazy(() => import("./pages/LicensePage"));

import { invoke } from "@tauri-apps/api/core";
import pkg from "../package.json";
import { A11yControls, LiveRegion } from "./components/A11yControls";
import { BatchSaveConflictModal } from "./components/BatchSaveConflictModal";
import { ConvertOptionsPanel } from "./components/ConvertOptionsPanel";
import { TapRevealText } from "./components/common";
import { FloatingMenu } from "./components/FloatingMenu";
import { FontScaleControl } from "./components/FontScaleControl";
import { JumpButton } from "./components/JumpNav";
import { LayoutModeControl } from "./components/LayoutModeControl";
import { LazyBoundary } from "./components/LazyBoundary";
import { PageSizeSelector } from "./components/PageSizeSelector";
import { SaveConflictModal } from "./components/SaveConflictModal";
import { SaveNamePromptModal } from "./components/SaveNamePromptModal";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { useA11y } from "./hooks/useA11y";
import { useFocusAnnouncer } from "./hooks/useFocusAnnouncer";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useIsMobilePlatform } from "./hooks/usePlatform";
import { useViewport } from "./hooks/useViewport";
import { hasImage, hasReflowable, isMupdfExtension } from "./lib/fileTypes";
import { useI18n } from "./lib/i18n";
import { loadLastTool, saveLastTool } from "./lib/lastTool";
import { formatFilenameForSpeech } from "./lib/speakName";
import { getPdfInfo, type PdfInfo } from "./lib/tauri";
//import { C, F, setTheme, loadThemeId, getTheme, THEMES, applyThemeCssVars, initThemeCssVars } from "./lib/theme";
import {
  applyThemeCssVars,
  type C,
  F,
  initThemeCssVars,
  loadThemeId,
  setTheme,
  THEMES,
} from "./lib/theme";
import type { ThemeId } from "./lib/themes";
import { tts } from "./lib/tts";
import { FS } from "./lib/typography";
import { applyUiScale, loadUiScale, saveUiScale } from "./lib/uiScale";
import { type FileEntry, usePdfStore } from "./store/usePdfStore";

const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    alert("URL copied!");
  } catch (err) {
    console.error("Failed to copy: ", err);
  }
};

// GLOBAL_CSS は関数にして themeId 変更時に再評価
function makeGlobalCss(t: typeof C) {
  return `
  * { box-sizing: border-box; }
  /* ページ自体はスクロールさせず #root 内でスクロールさせる
     （表示サイズ補正で #root を実ビューポートにロックするため） */
  /* html, body のリセット（margin/height/overflow）は index.html に静的記述済み。
     initUiScale() の初回計測タイミングより前に確定させる必要があるため。 */
  body { background: ${t.bg}; font-size: 15px; }
  @keyframes spin   { to { transform: rotate(360deg); } }
  @keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
  input[type=number]::-webkit-inner-spin-button { opacity:0.5; }
  input:focus { border-color:${t.accent} !important; }
  ::-webkit-scrollbar       { width:6px; height:6px; }
  ::-webkit-scrollbar-track { background:${t.bg}; }
  ::-webkit-scrollbar-thumb { background:${t.borderHi}; border-radius:3px; }
  button:hover:not(:disabled) { filter:brightness(1.1); }
  button:active:not(:disabled){ filter:brightness(0.9); }
  button:disabled { cursor:not-allowed !important; }
  /* キーボード操作時のフォーカス位置をわかりやすくする。
     マウス/タッチでのクリック直後（:focus だが :focus-visible ではない）は
     従来通り枠を出さず、Tabキー移動時にだけ、アクセントカラーの二重リングで
     はっきり示す（背景色によらず視認できるよう accentBg の外側リングを併用）。
     button 以外にも、独自の tabIndex 付き div（ファイル行など）や
     input/select/textarea/リンクにも同じルールを適用する。 */
  :where(button, [tabindex]:not([tabindex="-1"]), input, select, textarea, a[href]):focus-visible {
    outline: 3px solid ${t.accent} !important;
    outline-offset: 2px;
    box-shadow: 0 0 0 5px ${t.accentBg} !important;
  }
  :where(button, [tabindex]:not([tabindex="-1"]), input, select, textarea, a[href]):focus:not(:focus-visible) {
    outline: none !important;
    box-shadow: none !important;
  }
`;
}

export type ToolId =
  | "split"
  | "merge"
  | "trim"
  | "rotate"
  | "compress"
  | "image"
  | "booklet"
  | "hidden"
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
  { id: "booklet", icon: "📖", minFiles: 1, maxFiles: null },
  { id: "hidden", icon: "🔍", minFiles: 1, maxFiles: null },
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
    layoutModeOverride,
    setLayoutModeOverride,
    floatingMenuNarrow,
    floatingMenuWide,
    setFloatingMenuNarrow,
    setFloatingMenuWide,
  } = usePdfStore();

  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const { isNarrow, width: viewportWidth, useFloatingMenu } = useViewport();
  const mobilePlatform = useIsMobilePlatform();
  const fileListTopRef = useRef<HTMLDivElement>(null);
  const optionsTopRef = useRef<HTMLDivElement>(null);
  const mobileMenuToggleRef = useRef<HTMLButtonElement>(null);
  // ファイル追加後、最後に使った機能（なければビューワ）のツールボタンへ
  // フォーカスを移すための参照
  const toolButtonRefs = useRef<Partial<Record<ToolId, HTMLButtonElement | null>>>({});
  const [toolFiles, setToolFiles] = useState<FileEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [photoOnlyMode, setPhotoOnlyMode] = useState(false);
  const [photoOverlayHover, setPhotoOverlayHover] = useState(false);
  const [themeId, setThemeId] = useState<ThemeId>(loadThemeId);
  const [uiScale, setUiScale] = useState<number>(loadUiScale);
  // 狭幅時、上部の表示設定メニューを畳んでおくためのトグル（フローティング表示）
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const dragCounter = useRef(0);
  const [statusMsg, setStatusMsg] = useState("");
  const { announceScreen, announceSuccess, announceError, announceKey } = useA11y();
  const { locale, setLocale, t } = useI18n();
  // アプリ全体のフォーカス読み上げ（ボタン/入力/選択などにフォーカスが当たると読み上げ）
  useFocusAnnouncer();

  // TOOLS を言語に応じて動的生成（言語切り替え時に再レンダリングされる）
  const TOOLS = useMemo(
    () => [
      { ...TOOL_DEFS[0], label: t("tool.split"), desc: t("tool.split_desc") },
      { ...TOOL_DEFS[1], label: t("tool.merge"), desc: t("tool.merge_desc") },
      { ...TOOL_DEFS[2], label: t("tool.trim"), desc: t("tool.trim_desc") },
      { ...TOOL_DEFS[3], label: t("tool.rotate"), desc: t("tool.rotate_desc") },
      { ...TOOL_DEFS[4], label: t("tool.compress"), desc: t("tool.compress_desc") },
      { ...TOOL_DEFS[5], label: t("tool.image"), desc: t("tool.image_desc") },
      { ...TOOL_DEFS[6], label: t("tool.booklet"), desc: t("tool.booklet_desc") },
      { ...TOOL_DEFS[7], label: t("tool.hidden"), desc: t("tool.hidden_desc") },
      { ...TOOL_DEFS[8], label: t("tool.viewer"), desc: t("tool.viewer_desc") },
    ],
    [t],
  );

  const handleThemeChange = useCallback((id: ThemeId) => {
    setTheme(id);
    setThemeId(id);
    applyThemeCssVars(THEMES[id]);
  }, []);

  const handleUiScaleChange = useCallback((pct: number) => {
    setUiScale(pct);
    applyUiScale(pct);
    saveUiScale(pct);
  }, []);

  // 起動時／復帰時に保存済みの表示スケールを適用
  useEffect(() => {
    applyUiScale(uiScale);
  }, [uiScale]);

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
      const pdfPaths = paths.filter((p) => isMupdfExtension(p.split(/[/\\]/).pop() ?? p));

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
            // 読み上げはハッシュ等の不透明名を綴り読みに整形（表示はそのまま）
            announceSuccess("file.added", {
              name: formatFilenameForSpeech(fname),
              pages: String(info.page_count),
            });
          } catch (e) {
            announceError(String(e));
            setError(`${path.split(/[/\\]/).pop()}: ${e}`);
          }
        }),
      );
      // ファイル追加の一連の流れ（複数ファイルの連続追加も含む）が完了した後、
      // 次に行うのは機能（ツール）の選択という自然な流れになるため、
      // 最後に使った機能（未使用ならビューワ→分割の順にフォールバック）の
      // ツールボタンへ自動でフォーカスを移す。
      // ツールボタンはこの直前の addFiles によって初めて描画されるため、
      // 描画・コミットが終わってから（次の描画フレームで）フォーカスする。
      if (pdfPaths.length > 0) {
        requestAnimationFrame(() => {
          const preferred = loadLastTool() ?? "viewer";
          // 優先候補が無効化されている場合（例: 最後に使ったのが merge で
          // 今回はファイルが1つだけ）に備え、viewer → split の順にフォールバックする
          const candidates: ToolId[] = [preferred, "viewer", "split"];
          let target: HTMLButtonElement | null | undefined = null;
          for (const id of candidates) {
            const el = toolButtonRefs.current[id];
            if (el && !el.disabled) {
              target = el;
              break;
            }
          }
          target?.focus();
        });
      }
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

  // Android: 「共有(Share)」/「アプリで開く(Open with)」で渡されたファイルは
  // ネイティブ側のキュー(PendingFilesPlugin)に溜められる。デスクトップ/iOS
  // では get_pending_open_files は常に空配列を返すため無害。
  // - 起動直後(コールドスタート)に1回
  // - ウィンドウがフォーカスされた際(アプリ起動中に共有され、Androidが
  //   singleTaskのタスクを前面に戻したタイミング)に都度
  // ポーリングして取りこぼしを防ぐ。
  useEffect(() => {
    let cancelled = false;
    const pollPending = async () => {
      try {
        const paths = await invoke<string[]>("get_pending_open_files");
        if (!cancelled && paths.length) await handleAddPaths(paths);
      } catch {
        // 起動直後の一時的な失敗等は無視して黙ってスキップする
      }
    };
    pollPending();

    let unlistenFocus: (() => void) | null = null;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) pollPending();
      })
      .then((un) => {
        unlistenFocus = un;
      });

    return () => {
      cancelled = true;
      if (unlistenFocus) unlistenFocus();
    };
  }, [handleAddPaths]);

  const handlePickFiles = useCallback(async () => {
    let paths: string[];
    try {
      paths = await invoke<string[]>("pick_open_files");
    } catch (e) {
      announceError(String(e));
      setError(String(e));
      return;
    }
    if (paths.length) await handleAddPaths(paths);
  }, [handleAddPaths, setError]);

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
      saveLastTool(toolId);
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
      saveLastTool(t);
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

  // ツール番号ショートカット（Alt+1〜9）
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
    "Alt+7": () => handleToolShortcut("booklet", 7),
    "Alt+8": () => handleToolShortcut("hidden", 8),
    "Alt+9": () => handleToolShortcut("viewer", 9),
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
        uiScale={uiScale}
        onUiScaleChange={handleUiScaleChange}
      />
    );
  }

  const photoCreditBlock = THEMES[themeId].customBg && (
    <div
      style={{
        padding: "6px 6px",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 3,
        background: "rgba(0,0,0,0.6)",
        borderRadius: 8,
      }}
    >
      <span style={{ fontSize: "12px", color: "#fff", fontWeight: 700 }}>
        {t(`theme.${themeId}`)}
      </span>
      {THEMES[themeId].customIconCredit && (
        <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.8)" }}>
          {t("theme.icon")} © {THEMES[themeId].customIconYear} {THEMES[themeId].customIconCredit}
        </span>
      )}
      {THEMES[themeId].customBgCredit && (
        <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.8)" }}>
          {t("theme.bg")} © {THEMES[themeId].customBgYear} {THEMES[themeId].customBgCredit}
        </span>
      )}
    </div>
  );

  const showOptions =
    hasReflowable(fileList.map((f) => f.filename)) || hasImage(fileList.map((f) => f.filename));

  // 狭い画面ではファイル一覧と変換設定を縦積みにする。
  // listCard 等は align-items:center な親の直下で width:"%" を使うと
  // WebKitGTK環境で意図しない幅に潰れる既知の事象があるため、
  // 狭幅時は % ではなく実測pxから計算した固定値を使う。
  const narrowContentWidth = Math.max(240, Math.min(720, viewportWidth - 48));

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
      {!photoOnlyMode && (
        <>
          {/* 読み上げ・言語・テーマ選択（設定でフローティング表示が有効な場合は畳める） */}
          {useFloatingMenu ? (
            <div
              style={{
                width: "100%",
                display: "flex",
                justifyContent: "flex-end",
                zIndex: 20,
                flexShrink: 0,
              }}
            >
              <button
                ref={mobileMenuToggleRef}
                type="button"
                onClick={() => setMobileMenuOpen((v) => !v)}
                aria-expanded={mobileMenuOpen}
                aria-label={mobileMenuOpen ? t("common.menu_hide") : t("common.menu_show")}
                style={s.mobileMenuToggle}
              >
                {mobileMenuOpen ? "✕" : "☰"}
              </button>
              <FloatingMenu
                open={mobileMenuOpen}
                onClose={() => setMobileMenuOpen(false)}
                anchorRef={mobileMenuToggleRef}
              >
                <div
                  style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}
                >
                  <A11yControls />
                  <FontScaleControl scale={uiScale} onChange={handleUiScaleChange} />
                  <ThemeSwitcher currentId={themeId} onChange={handleThemeChange} />
                  <LayoutModeControl
                    mode={layoutModeOverride}
                    onChange={setLayoutModeOverride}
                    floatingNarrow={floatingMenuNarrow}
                    floatingWide={floatingMenuWide}
                    onFloatingNarrowChange={setFloatingMenuNarrow}
                    onFloatingWideChange={setFloatingMenuWide}
                  />
                </div>
              </FloatingMenu>
            </div>
          ) : (
            <div
              style={{
                width: "100%",
                maxWidth: 820,
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "flex-end",
                gap: 8,
                alignItems: "center",
                zIndex: 20,
                flexShrink: 0,
              }}
            >
              <A11yControls />
              <FontScaleControl scale={uiScale} onChange={handleUiScaleChange} />
              <ThemeSwitcher currentId={themeId} onChange={handleThemeChange} />
              <LayoutModeControl
                mode={layoutModeOverride}
                onChange={setLayoutModeOverride}
                floatingNarrow={floatingMenuNarrow}
                floatingWide={floatingMenuWide}
                onFloatingNarrowChange={setFloatingMenuNarrow}
                onFloatingWideChange={setFloatingMenuWide}
              />
            </div>
          )}
        </>
      )}

      {/* 募集テーマの背景画像（コンテンツエリアに薄く表示） */}
      {THEMES[themeId].customBg && (
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

      {!photoOnlyMode && (
        <>
          <header style={s.header}>
            {/* アプリ名エリア（常に不透明背景） */}
            <div
              style={{
                width: "100%",
                background: "var(--c-bg)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                padding: "4px 8px 8px",
                position: "relative",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <img
                  src={THEMES[themeId].customIcon ?? "/app-icon.svg"}
                  style={{
                    width: isNarrow ? "32px" : "48px",
                    height: isNarrow ? "32px" : "48px",
                    lineHeight: 2,
                    gap: 6,
                    borderRadius: 10,
                  }}
                  alt="logo"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = "/app-icon.svg";
                  }}
                />
                <span
                  style={
                    isNarrow
                      ? { ...s.logo, fontSize: "32px", height: "48px", lineHeight: "48px" }
                      : s.logo
                  }
                >
                  PDF<span style={{ color: "var(--c-accent)" }}>小僧</span>
                </span>
                {/* Aboutボタン */}
                <button
                  type="button"
                  onClick={() => setActiveTool("about")}
                  style={{
                    background: "var(--c-bgSub)",
                    border: "1px solid var(--c-border)",
                    borderRadius: "18px",
                    padding: "4px 4px",
                    fontSize: "12px",
                    color: "var(--c-textSub)",
                    cursor: "pointer",
                    marginTop: "24px",
                    lineHeight: 2,
                  }}
                >
                  ℹ️ About
                </button>
              </div>

              {(THEMES[themeId].customBg && (
                <div
                  style={{
                    display: "flex",
                    height: "60px",
                  }}
                >
                  <span style={{ ...s.tagline, position: "absolute", width: "70%", right: 0 }}>
                    v{pkg.version}
                  </span>
                  {/* 背景画像クレジット */}
                  {THEMES[themeId].customBg && (
                    <div
                      style={{
                        position: "absolute",
                        right: 0,
                        width: "50%",
                        height: "54px",
                      }}
                    >
                      {/* クレジット表示（ヘッダー画像の右下） */}
                      {
                        <div
                          style={{
                            position: "relative",
                            right: "6px",
                            bottom: "6px",
                            padding: "6px 6px",
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "flex-end",
                            gap: 3,
                            background: "rgba(0,0,0,0.45)",
                            borderRadius: 8,
                          }}
                        >
                          <span style={{ fontSize: "12px", color: "#fff", fontWeight: 700 }}>
                            {t(`theme.${themeId}`)}
                          </span>
                          {THEMES[themeId].customIconCredit && (
                            <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.8)" }}>
                              {t("theme.icon")} © {THEMES[themeId].customIconYear}{" "}
                              {THEMES[themeId].customIconCreditURL ? (
                                <span
                                  onClick={async (e) => {
                                    e.stopPropagation(); // 親要素へのイベント伝播を止める
                                    await copyToClipboard(
                                      THEMES[themeId].customIconCreditURL || "",
                                    );
                                  }}
                                  style={{
                                    color: "inherit",
                                    textDecoration: "dotted underline", // コピーであることを示すために点線にするのもあり
                                    display: "inline-block", // クリック領域を確保
                                    position: "relative", // 重なり順を安定させる
                                    cursor: "pointer",
                                  }}
                                  title={THEMES[themeId].customIconCreditURL} // マウスホバーで説明を出す
                                >
                                  {THEMES[themeId].customIconCredit}
                                </span>
                              ) : (
                                THEMES[themeId].customIconCredit
                              )}
                            </span>
                          )}

                          {THEMES[themeId].customBgCredit && (
                            <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.8)" }}>
                              {t("theme.bg")} © {THEMES[themeId].customBgYear}{" "}
                              {THEMES[themeId].customBgCreditURL ? (
                                <span
                                  onClick={async (e) => {
                                    e.stopPropagation(); // 親要素へのイベント伝播を止める
                                    await copyToClipboard(THEMES[themeId].customBgCreditURL || "");
                                  }}
                                  style={{
                                    color: "inherit",
                                    textDecoration: "dotted underline", // コピーであることを示すために点線にするのもあり
                                    display: "inline-block", // クリック領域を確保
                                    position: "relative", // 重なり順を安定させる
                                    cursor: "pointer",
                                  }}
                                  title={THEMES[themeId].customBgCreditURL} // マウスホバーで説明を出す
                                >
                                  {THEMES[themeId].customBgCredit}
                                </span>
                              ) : (
                                THEMES[themeId].customBgCredit
                              )}
                            </span>
                          )}
                        </div>
                      }
                    </div>
                  )}
                </div>
              )) || <span style={{ ...s.tagline, position: "relative" }}>v{pkg.version}</span>}
              <span style={{ ...s.tagline }}>{t("app.tagline")}</span>
            </div>
          </header>
        </>
      )}

      {!photoOnlyMode && (
        <>
          {fileList.length > 0 && (
            <div style={s.toolBar}>
              {TOOLS.map((tool) => {
                const enabled =
                  selCount >= tool.minFiles && (tool.maxFiles == null || selCount <= tool.maxFiles);
                return (
                  <button
                    type="button"
                    key={tool.id}
                    ref={(el) => {
                      toolButtonRefs.current[tool.id] = el;
                    }}
                    style={{ ...s.toolBtn, ...(enabled ? s.toolBtnOn : s.toolBtnOff) }}
                    onClick={() => enabled && handleLaunchTool(tool.id)}
                    disabled={!enabled}
                    aria-label={`Alt+${TOOL_DEFS.findIndex((d) => d.id === tool.id) + 1} ${tool.label}: ${tool.desc}${!enabled ? ` (${t("app.select_prompt")})` : ""}`}
                    onFocus={() => {
                      const num = TOOL_DEFS.findIndex((d) => d.id === tool.id) + 1;
                      const msg = enabled
                        ? t("home.tool_focus", {
                            num: String(num),
                            name: tool.label,
                            desc: tool.desc,
                          })
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

          {/* 幅に応じたレイアウト:
              ・狭い画面: 縦積み（実測pxベースの幅。理由は useViewport.ts のコメント参照）
              ・広い画面・設定パネルあり: CSS Grid で2カラムを流動的に伸縮させる。
                Grid のトラックサイズは常に確定値として計算されるため、
                Flexbox の align-items:center + width:"%" で起きていた
                WebKitGTK の潰れ問題を経由しない。
              ・広い画面・設定パネルなし: ファイル一覧のみを中央寄せ（従来通り固定720px、
                768px以上では常に収まるため流動化の必要なし） */}
          <div
            style={
              isNarrow
                ? {
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 24,
                    padding: "16px 12px",
                  }
                : showOptions
                  ? {
                      display: "grid",
                      // 1カラム目(ファイル一覧): 280〜720pxの間で流動的に伸縮
                      // 2カラム目(変換設定): 240〜300pxの間で流動的に伸縮
                      gridTemplateColumns: "minmax(280px, 720px) minmax(240px, 300px)",
                      justifyContent: "center",
                      alignItems: "start",
                      gap: 24,
                      padding: 24,
                    }
                  : {
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 24,
                      padding: 24,
                    }
            }
          >
            {/* ファイル一覧とファイル情報のサマリ */}
            <div ref={fileListTopRef}>
              {/* ファイル一覧エリア */}
              <div
                style={{
                  ...s.listCard,
                  // Grid/縦積み時は各トラック・親要素の幅がすでに確定しているため
                  // width:"100%" のままで安全（潰れ問題は起きない）。
                  // !showOptions（1カラムのみ）の時だけ従来通り固定720pxにする。
                  width: !isNarrow && !showOptions ? 720 : isNarrow ? narrowContentWidth : "100%",
                  maxWidth:
                    !isNarrow && !showOptions ? 720 : isNarrow ? narrowContentWidth : "100%",
                  transition: "all 0.3s ease",
                }}
              >
                {fileList.length === 0 ? (
                  <div style={s.emptyZone}>
                    <button
                      type="button"
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
                          mobilePlatform={mobilePlatform}
                          onToggle={() => {
                            // 対象PDFとして使うかどうかのオンオフ。新しい状態をファイル名付きで読み上げ
                            const willUse = !f.selected;
                            toggleSelect(f.id);
                            announceSuccess(
                              willUse ? "file.use_target_on" : "file.use_target_off",
                              {
                                name: formatFilenameForSpeech(f.filename),
                              },
                            );
                          }}
                          onRemove={() => {
                            // 「削除」ではなく読み込み対象の一覧から外す操作
                            removeFile(f.id);
                            announceSuccess("file.remove_one", {
                              name: formatFilenameForSpeech(f.filename),
                            });
                          }}
                          onDragReorder={reorderFiles}
                        />
                      ))}
                    </div>
                    <div style={s.listFooter}>
                      <button type="button" style={s.btnAdd} onClick={handlePickFiles}>
                        {t("file.add")}
                      </button>
                      <button type="button" style={s.btnSm} onClick={selectAll}>
                        {t("file.select_all")}
                      </button>
                      <button type="button" style={s.btnSm} onClick={selectNone}>
                        {t("file.deselect")}
                      </button>
                      <div style={{ flex: 1 }} />
                      <button
                        type="button"
                        style={s.btnClear}
                        onClick={() => {
                          // 全ファイルを読み込み対象の一覧から外す（ディスクからの削除ではない）
                          clearList();
                          announceSuccess("file.cleared");
                        }}
                        aria-label={t("file.clear_aria")}
                        title={t("file.clear_aria")}
                      >
                        {t("file.clear")}
                      </button>
                    </div>
                  </>
                )}
                {/* ファイル一欄 閉じ */}
              </div>

              {fileList.length > 0 && (
                <div style={s.summary}>
                  {selCount > 0 ? (
                    <>
                      <span style={s.sumSel}>
                        {t("file.sel_count", { count: String(selCount) })}
                      </span>
                      <span style={s.sumDot}>·</span>
                      <span style={s.sumInfo}>
                        {t("file.sel_pages", { pages: String(selPages) })}
                      </span>
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
              {/* ファイル一覧とファイル情報のサマリ 閉じ*/}
              {isNarrow && showOptions && (
                <div style={{ paddingTop: 12 }}>
                  <JumpButton
                    targetRef={optionsTopRef}
                    label={t("common.jump_to_options")}
                    direction="down"
                  />
                </div>
              )}
            </div>

            <div ref={optionsTopRef} style={isNarrow ? { width: narrowContentWidth } : undefined}>
              {isNarrow && showOptions && (
                <div style={{ paddingBottom: 8 }}>
                  <JumpButton
                    targetRef={fileListTopRef}
                    label={t("common.jump_to_filelist")}
                    direction="up"
                  />
                </div>
              )}
              {/* リフロー文書（EPUB/HTML/DOCX等）が含まれる場合のみレイアウト設定を表示。
              画像や固定レイアウト文書ではリフローが効かないため出さない。 */}
              {showOptions && hasReflowable(fileList.map((f) => f.filename)) && (
                <div
                  style={{
                    padding: "0 12px",
                    width: "100%",
                    boxSizing: "border-box",
                  }}
                >
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
                          const info = await getPdfInfo(f.path, {
                            layoutW: w,
                            layoutH: h,
                            layoutEm: em,
                          });
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

              {/* 画像が含まれる場合に標準ページサイズ設定を表示 */}
              {showOptions && hasImage(fileList.map((f) => f.filename)) && (
                <div
                  style={{
                    padding: "8px 12px",
                    width: "100%",
                    boxSizing: "border-box",
                    paddingBottom: 8,
                  }}
                >
                  <PageSizeSelector />
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {THEMES[themeId].customBg && (
        <div
          onMouseEnter={() => setPhotoOverlayHover(true)}
          onMouseLeave={() => setPhotoOverlayHover(false)}
          style={{
            position: "fixed",
            right: 18,
            bottom: 18,
            zIndex: 6000,
            display: "flex",
            alignItems: "flex-end",
            gap: 10,
            opacity: photoOverlayHover ? 1 : 0.3,
            transition: "all 0.2s",
          }}
        >
          <div
            style={{
              opacity: photoOverlayHover ? 1 : 0,
            }}
          >
            {photoOnlyMode && photoCreditBlock}
          </div>
          <button
            type="button"
            title={photoOnlyMode ? t("home.home_screen") : t("home.photo_only")}
            onClick={() => setPhotoOnlyMode((v) => !v)}
            className={photoOnlyMode ? "sh.BgBtn sh.BgBtnSubtle" : "sh.BgBtn sh.BgBtnSolid"}
            aria-pressed={photoOnlyMode}
          >
            👁
          </button>
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
  mobilePlatform,
  onToggle,
  onRemove,
  onDragReorder,
}: {
  entry: FileEntry;
  index: number;
  mobilePlatform: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onDragReorder: (f: number, t: number) => void;
}) {
  const { t } = useI18n();
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const mb = entry.sizeBytes > 0 ? `${(entry.sizeBytes / 1048576).toFixed(1)} MB` : "";
  return (
    <div
      tabIndex={0}
      role="listitem"
      draggable
      // 行・チェック・✘ の汎用読み上げは抑止し、行は下の onFocus（整形済み
      // ファイル名）、チェック/✘ は操作ハンドラの明示読み上げに一本化する。
      data-voice-skip
      onFocus={() => {
        const info = `${formatFilenameForSpeech(entry.filename)}、${entry.pageCount}${t("file.pages_unit")}`;
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
        const fid = parseInt(e.dataTransfer.getData("fileId") || "0", 10);
        if (fid && fid !== entry.id) onDragReorder(fid, entry.id);
      }}
      style={{
        ...fr.row,
        ...(entry.selected ? fr.rowSel : {}),
        ...(isDragOver ? fr.rowDO : {}),
        ...(isDragging ? fr.rowDrag : {}),
      }}
    >
      <button
        type="button"
        style={{ ...fr.check, ...(entry.selected ? fr.checkOn : {}) }}
        onClick={onToggle}
        role="checkbox"
        aria-checked={entry.selected}
        aria-label={t("file.use_target_on", { name: entry.filename })}
        title={t("file.use_target_on", { name: entry.filename })}
      >
        {entry.selected && <span style={fr.checkMark}>✓</span>}
      </button>
      <span style={fr.handle}>⣿</span>
      <span style={fr.num}>{index + 1}</span>
      <div style={fr.info}>
        {/* フルパスは表示しない（Androidのキャッシュインポートパス対策）。
            スマホは横長ではないため、長いファイル名は1行に省略するより
            折り返して全文を表示する方が実用的。TapRevealText(1行省略+
            タップ全文表示)ではなく、折り返し可能な素のspanで常に全文を
            表示する。折り返し表示できる場合でもtitle属性(代替テキスト)は
            維持する */}
        <TapRevealText
          text={entry.filename}
          fullText={entry.filename}
          mobilePlatform={mobilePlatform}
          style={fr.name}
        />
        <span style={fr.meta}>
          {entry.pageCount}
          {t("file.pages_unit")}
          {mb ? `  ${mb}` : ""}
        </span>
      </div>
      <button
        type="button"
        style={fr.del}
        onClick={onRemove}
        aria-label={t("file.remove_one", { name: entry.filename })}
        title={t("file.remove_one", { name: entry.filename })}
      >
        ✘
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
  uiScale,
  onUiScaleChange,
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
  uiScale: number;
  onUiScaleChange: (pct: number) => void;
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
      { ...TOOL_DEFS[6], label: t("tool.booklet"), desc: t("tool.booklet_desc") },
      { ...TOOL_DEFS[7], label: t("tool.hidden"), desc: t("tool.hidden_desc") },
      { ...TOOL_DEFS[8], label: t("tool.viewer"), desc: t("tool.viewer_desc") },
    ],
    [t],
  );
  const { isNarrow, useFloatingMenu } = useViewport();
  const mobilePlatform = useIsMobilePlatform();
  const filename = filePath.split(/[/\\]/).pop() ?? "";
  const batchFiles = isBatch ? toolFiles : undefined;
  const {
    layoutModeOverride,
    setLayoutModeOverride,
    floatingMenuNarrow,
    floatingMenuWide,
    setFloatingMenuNarrow,
    setFloatingMenuWide,
  } = usePdfStore();
  // 狭幅時、テーマメニュー・ツールタブを畳んでフローティング表示にするためのトグル
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuToggleRef = useRef<HTMLButtonElement>(null);
  // 画面（アクティブツール）が変わったらフローティングメニューは自動で閉じる
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [activeTool]);

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
      onToolChange("booklet");
      tts.speak(t("shortcut.tool_switched", { name: t("tool.booklet") }));
    },
    "Alt+8": () => {
      onToolChange("hidden");
      tts.speak(t("shortcut.tool_switched", { name: t("tool.hidden") }));
    },
    "Alt+9": () => {
      onToolChange("viewer");
      tts.speak(t("shortcut.tool_switched", { name: t("tool.viewer") }));
    },
    "Alt+H": () => {
      onHome();
      tts.speak(t("screen.home"));
    },
    F1: () => announceKey("shortcut.tool"),
  });

  const toolTabsContent = (
    <>
      {TOOLS.map((tool) => (
        <button
          type="button"
          key={tool.id}
          style={{ ...sh.tab, ...(activeTool === tool.id ? sh.tabOn : {}) }}
          onClick={(e) => {
            onToolChange(tool.id);
            (e.currentTarget as HTMLButtonElement).blur();
            if (isNarrow) setMobileMenuOpen(false);
          }}
          title={`${tool.label} (Alt+${TOOL_DEFS.findIndex((d) => d.id === tool.id) + 1})`}
          aria-label={`${tool.label} Alt+${TOOL_DEFS.findIndex((d) => d.id === tool.id) + 1}${activeTool === tool.id ? " 現在のツール" : ""}`}
        >
          <span>{tool.icon}</span>
          <span style={sh.tabLabel}>{tool.label}</span>
        </button>
      ))}
    </>
  );

  const themeControlsContent = (
    <>
      <A11yControls />
      <FontScaleControl scale={uiScale} onChange={onUiScaleChange} />
      <ThemeSwitcher currentId={themeId} onChange={onThemeChange} />
      <LayoutModeControl
        mode={layoutModeOverride}
        onChange={setLayoutModeOverride}
        floatingNarrow={floatingMenuNarrow}
        floatingWide={floatingMenuWide}
        onFloatingNarrowChange={setFloatingMenuNarrow}
        onFloatingWideChange={setFloatingMenuWide}
      />
    </>
  );

  return (
    <div style={sh.root}>
      <nav style={{ ...sh.nav, position: "relative" }}>
        <div style={sh.navTop}>
          <button type="button" style={sh.homeBtn} onClick={onHome}>
            PDF<span style={{ color: "var(--c-accent)" }}>小僧</span>
            {!isNarrow && (
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
            )}
            <img src="/app-icon.svg" style={{ width: 20, height: 20, borderRadius: 4 }} alt="" />
          </button>
          <div style={sh.div} />
          {activeTool === "about" ? (
            <span style={sh.batchLabel}>{t("app.about_label")}</span>
          ) : isBatch ? (
            <span style={sh.batchLabel}>📂 {toolFiles.length}ファイル</span>
          ) : (
            <TapRevealText
              // ヘッダーはフルパスを表示しない方針（Androidはキャッシュ
              // インポート時のパスになるため、表示するとユーザーが混乱する）。
              // text/fullTextとも常にファイル名のみとする。
              text={filename}
              fullText={filename}
              mobilePlatform={mobilePlatform}
              style={sh.filename}
            />
          )}
          <div style={{ flex: 1 }} />
          {useFloatingMenu ? (
            <button
              ref={mobileMenuToggleRef}
              type="button"
              style={sh.mobileMenuToggle}
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-expanded={mobileMenuOpen}
              aria-label={mobileMenuOpen ? t("common.menu_hide") : t("common.menu_show")}
            >
              {mobileMenuOpen ? "✕" : "☰"}
            </button>
          ) : (
            <div style={sh.navRight}>{themeControlsContent}</div>
          )}
        </div>
        {useFloatingMenu ? (
          <FloatingMenu
            open={mobileMenuOpen}
            onClose={() => setMobileMenuOpen(false)}
            anchorRef={mobileMenuToggleRef}
          >
            {/* 縦積み(モバイル既定)ではツールタブをグリッドで畳んで縦に、
                横並び(デスクトップでフローティングを有効にした場合)では
                横に並べて表示する。 */}
            <div
              style={
                isNarrow
                  ? sh.mobileNavPanelTabs
                  : { display: "flex", flexWrap: "wrap" as const, gap: 6 }
              }
            >
              {toolTabsContent}
            </div>
            <div style={sh.mobileNavPanelDiv} />
            <div
              style={
                isNarrow
                  ? sh.mobileNavPanelControls
                  : { display: "flex", flexWrap: "wrap" as const, gap: 6 }
              }
            >
              {themeControlsContent}
            </div>
          </FloatingMenu>
        ) : (
          <div style={sh.navTabs}>{toolTabsContent}</div>
        )}
      </nav>

      <div style={{ flex: 1, overflow: "hidden" }}>
        <LazyBoundary resetKey={activeTool ?? "home"}>
          <Suspense
            fallback={<div style={{ padding: "40px", textAlign: "center" }}>Loading tool...</div>}
          >
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
            {activeTool === "booklet" && (
              <PageSizeBookletPage
                filePath={filePath}
                pdfInfo={pdfInfo}
                batchFiles={isBatch ? toolFiles : undefined}
              />
            )}
            {activeTool === "hidden" && (
              <HiddenTextPage
                filePath={filePath}
                pdfInfo={pdfInfo}
                batchFiles={isBatch ? toolFiles : undefined}
              />
            )}
            {activeTool === "viewer" && (
              <ViewerPage filePath={filePath} pdfInfo={pdfInfo} fileList={batchFiles} />
            )}
            {activeTool === "about" && <LicensePage />}
          </Suspense>
        </LazyBoundary>
      </div>
      <SaveConflictModal />
      <SaveNamePromptModal />
      <BatchSaveConflictModal />
    </div>
  );
}

// ── styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: {
    height: "100%",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 16,
    background: "var(--c-bg)",
    color: "var(--c-text)",
    fontFamily: F,
    padding: "12px 24px 16px",
    position: "relative",
    transition: "background 0.15s",
    overflowX: "hidden",
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
    fontSize: "52px",
    fontWeight: 800,
    height: "80px",
    lineHeight: "80px",
    color: "var(--c-text)",
    padding: "8pt",
    letterSpacing: "-0.02em",
  },
  tagline: {
    fontSize: "12px",
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
    minHeight: 120,
    // 【修正】maxHeight を削除し、height で 5-7ファイル分の高さを上限にする
    // FileRow のパディングやボーダーを含めて 5-7個分（約 260px 前後）を上限とします
    maxHeight: "calc(11px * 2 + 1px + (44px * 9))",
    display: "flex",
    flexDirection: "column",
    position: "relative" as const,
    zIndex: 1,
  },
  emptyZone: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    padding: "32px 28px",
    flex: 1,
  },
  emptyIcon: { fontSize: 44, color: "var(--c-borderHi)" },
  emptyTitle: { fontSize: 18, fontWeight: 600, color: "var(--c-textSub)" },
  emptySub: { fontSize: FS.label, color: "var(--c-textDim)" },
  btnAddBig: {
    padding: "12px 32px",
    background: "var(--c-accentBg)",
    border: `1px solid var(--c-accentBd)`,
    borderRadius: 8,
    color: "var(--c-accent)",
    fontWeight: 700,
    cursor: "pointer",
    fontSize: "15px",
    fontFamily: F,
  },
  fileRows: { display: "flex", flexDirection: "column", overflowY: "auto", flex: 1 },
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
    fontSize: FS.body,
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
    fontSize: FS.body,
    fontFamily: F,
  },
  btnClear: {
    padding: "6px 14px",
    background: "transparent",
    border: `1px solid var(--c-errBd)`,
    borderRadius: 7,
    color: "var(--c-err)",
    cursor: "pointer",
    fontSize: FS.body,
    fontFamily: F,
  },
  summary: { display: "flex", alignItems: "center", gap: 9, height: 28 },
  sumSel: { fontSize: FS.subtitle, fontWeight: 700, color: "var(--c-text)" },
  sumDot: { color: "var(--c-textDim)" },
  sumInfo: { fontSize: FS.label, color: "var(--c-textSub)" },
  sumNone: { fontSize: FS.label, color: "var(--c-textDim)" },
  toolBar: {
    // CSS Grid の auto-fill で均等な多段グリッドにする。
    // 幅に応じて列数が自動で変わり、最終行が1個でもセル幅のまま（横長に伸びない）。
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))",
    gap: 9,
    width: "100%",
    maxWidth: 820,
    position: "relative" as const,
    zIndex: 1,
  },
  toolBtn: {
    // 幅・段組みは親(grid)が制御。ボタンはセル幅いっぱいに表示。
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
  toolLabel: { fontSize: FS.label, fontWeight: 700, color: "inherit" },
  toolDesc: { fontSize: FS.caption, color: "var(--c-textSub)", textAlign: "center" as const },
  mobileMenuToggle: {
    width: 36,
    height: 36,
    borderRadius: 8,
    border: "1px solid var(--c-border)",
    background: "var(--c-bgCard)",
    color: "var(--c-text)",
    fontSize: 16,
    cursor: "pointer",
    flexShrink: 0,
  },
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
    fontSize: FS.body,
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
  checkMark: { fontSize: FS.body, color: "var(--c-accentText)", fontWeight: 700, lineHeight: 1 },
  handle: { fontSize: FS.subtitle, color: "var(--c-borderHi)", cursor: "grab", flexShrink: 0 },
  num: {
    fontSize: FS.body,
    color: "var(--c-textDim)",
    width: 22,
    textAlign: "center" as const,
    flexShrink: 0,
  },
  info: { flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  name: {
    fontSize: FS.label,
    color: "var(--c-text)",
    overflowWrap: "break-word",
    wordBreak: "break-word",
  },
  meta: { fontSize: FS.small, color: "var(--c-textSub)" },
  del: {
    width: 26,
    height: 26,
    flexShrink: 0,
    background: "transparent",
    border: "none",
    color: "var(--c-textDim)",
    cursor: "pointer",
    fontSize: FS.subtitle,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 5,
    padding: 0,
    fontFamily: F,
  },
};

const sh: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100%", background: "var(--c-bg)" },
  nav: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "4px 14px",
    minHeight: 46,
    background: "var(--c-navBg)",
    borderBottom: `1px solid var(--c-navBd)`,
    flexShrink: 0,
    fontFamily: F,
    zIndex: 10,
    overflow: "visible",
  },
  navTop: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    minHeight: 38,
  },
  navTabs: {
    // タブ専用の行。幅 100% なので幅不足時は確実に複数段へ折り返す（横スクロールなし）。
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 4,
    rowGap: 4,
    width: "100%",
  },
  homeBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: 5,
    fontFamily: F,
    fontSize: FS.label,
    fontWeight: 700,
    color: "var(--c-text)",
    whiteSpace: "nowrap",
    display: "flex",
    alignItems: "center",
  },
  div: { width: 1, height: 20, background: "var(--c-border)", margin: "0 3px", flexShrink: 0 },
  filename: {
    fontSize: FS.small,
    color: "var(--c-textSub)",
    maxWidth: 180,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  batchLabel: {
    fontSize: FS.small,
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
    fontSize: FS.small,
    transition: "all 0.1s",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  tabOn: {
    background: "var(--c-accentBg)",
    borderColor: "var(--c-accentBd)",
    color: "var(--c-accent)",
  },
  tabLabel: { fontSize: FS.caption },
  navRight: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    flexShrink: 0, // 言語/テーマ/A11y は縮めず常に表示
  },
  openBtn: {
    padding: "4px 11px",
    background: "transparent",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 5,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontFamily: F,
    fontSize: FS.small,
    flexShrink: 0,
  },
  BgBtn: {
    fontSize: "24px",
    border: "none",
    borderRadius: "50%",
    width: "48px",
    height: "48px",
    cursor: "pointer",
  },
  BgBtnSubtle: {
    background: "rgba(0, 0, 0, 0.2)",
    color: "rgba(255, 255, 255, 0.45)",
  },
  BgBtnSolid: {
    background: "rgba(0, 0, 0, 0.45)",
    color: "rgba(255, 255, 255, 1)",
  },
  mobileMenuToggle: {
    width: 34,
    height: 34,
    borderRadius: 8,
    border: "1px solid var(--c-border)",
    background: "var(--c-bgCard)",
    color: "var(--c-text)",
    fontSize: 15,
    cursor: "pointer",
    flexShrink: 0,
  },
  mobileNavPanelTabs: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
    gap: 6,
  },
  mobileNavPanelDiv: { height: 1, background: "var(--c-border)" },
  mobileNavPanelControls: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 6,
  },
};
