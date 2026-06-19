// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/pages/TrimPage.tsx
export default TrimPage;
import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TrimCanvas } from "../components/trim/TrimCanvas";
import { TrimControls } from "../components/trim/TrimControls";
import { CompressPage } from "./CompressPage";
import { usePdfStore, type FileEntry } from "../store/usePdfStore";
import { hasImage } from "../lib/fileTypes";
import { buildName, stem, opSuffix } from "../lib/filename";
import { resolvePageSizePt } from "../lib/pageSize";
import { useSaveDialog } from "../hooks/useSaveDialog";
import {
  getTempPath,
  renderPage,
  moveFile,
  trimPdf,
  getPdfInfo,
  composeImpositionPdf,
  type TrimMargins,
  type PdfInfo,
  joinPath,
} from "../lib/tauri";
import { C, F } from "../lib/theme";
import { useA11y } from "../hooks/useA11y";
import { tts } from "../lib/tts";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { LiveRegion } from "../components/A11yControls";
import { useI18n } from "../lib/i18n";
import { PreviewPane } from "../components/PreviewPane";
import { usePreview } from "../hooks/usePreview";
import { MetadataEditModal, type PdfMeta } from "../components/MetadataEditModal";

interface Props {
  filePath: string;
  pdfInfo: PdfInfo;
  batchFiles?: FileEntry[];
}

const PREVIEW_DPI = 72;
const RESULT_DPI = 96;
const THUMB_DPI = 40;
const CANVAS_W_DEFAULT = 520;

type Phase = "edit" | "processing" | "result" | "error" | "compress" | "saved" | "batchResult";
const zero = (): TrimMargins => ({ left: 0, right: 0, top: 0, bottom: 0 });

/**
 * 画像をトリムした結果（自然サイズ・1ページ）を、指定ページサイズへアスペクト維持で
 * フィットさせる。compose_imposition_pdf を 1-up(cols=1,rows=1) で使い、トリム後の
 * ベクター/JPEG を保ったまま目標サイズの台紙へ中央配置する。
 * autoOrient=true のときは台紙の向きをトリム結果の向きに合わせる（1-up の仕様）。
 */
async function fitTrimmedToPageSize(
  inputPath: string,
  outputPath: string,
  psize: { w: number; h: number },
  autoOrient: boolean,
): Promise<void> {
  await composeImpositionPdf({
    input: inputPath,
    output: outputPath,
    targetW: psize.w,
    targetH: psize.h,
    cols: 1,
    rows: 1,
    sheetPages: [1],
    nSheets: 1,
    margin: 0,
    gutter: 0,
    autoOrient,
  });
}

export function TrimPage({ filePath, pdfInfo, batchFiles }: Props) {
  console.log("[TrimPage] pdfInfo:", pdfInfo);
  const isBatch = (batchFiles?.length ?? 0) > 1;
  if (isBatch) {
    console.log("[TrimPage] → バッチモードへ");
    return <TrimPageBatch files={batchFiles!} firstPdfInfo={pdfInfo} />;
  } else {
    console.log("[TrimPage] → 単体モードへ");
    return <TrimPageSingle filePath={filePath} pdfInfo={pdfInfo} />;
  }
}

// ── バッチトリム ──────────────────────────────────────────────────────────────
function TrimPageBatch({ files, firstPdfInfo }: { files: FileEntry[]; firstPdfInfo: PdfInfo }) {
  const { setError, convertLayoutW, convertLayoutH, convertLayoutEm, pageSizeId, pageOrientation } =
    usePdfStore();
  const { announceSuccess, announceError } = useA11y();
  const { t } = useI18n();
  const [trimMargins, setTrimMargins] = useState<TrimMargins>(zero());
  const [outDir, setOutDir] = useState("");
  const [phase, setPhase] = useState<"edit" | "processing" | "result">("edit");
  const [progress, setProgress] = useState<{
    current: number;
    done: { f: string }[];
    errors: { f: string; msg: string }[];
  }>({ current: 0, done: [], errors: [] });
  const [previewIdx, setPreviewIdx] = useState(0);
  const [previewPage, setPreviewPage] = useState(0);
  const [pageImage, setPageImage] = useState("");
  const [curPageInfo, setCurPageInfo] = useState<PdfInfo | null>(null);
  const [trimPages, onPages] = useState("all");
  const [excludeSpec, onExclude] = useState("");
  const [extractSpec, onExtract] = useState("all");
  const [cropCleanup, setCropCleanup] = useState(false);

  const [batchThumbs, setBatchThumbs] = useState<(string | undefined)[]>([]);
  const [zoom, setZoom] = useState(0.75);
  const [canvasWidth, setCanvasWidth] = useState(CANVAS_W_DEFAULT);
  const canvasWrapRef = useRef<HTMLDivElement>(null);

  const currentPage = firstPdfInfo.pages[previewPage] ?? { w: 595, h: 842, rotate: 0 };
  const pageW = currentPage.w;
  const pageH = currentPage.h;

  // コンテナ幅に追従してプレビューサイズを動的更新
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? CANVAS_W_DEFAULT;
      setCanvasWidth(Math.max(300, Math.floor(w - 24)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ctrl+ホイール でズーム（document レベルで捕捉して WebView のピンチズームより先に処理）
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom((z) => +Math.min(4.0, Math.max(0.25, z + delta)).toFixed(2));
    };
    window.addEventListener("wheel", handler, { passive: false });
    return () => window.removeEventListener("wheel", handler);
  }, []);

  // バッチ全体のサムネイル（先頭ページ）
  useEffect(() => {
    usePdfStore.getState().resetTrimState();
    let cancelled = false;
    setBatchThumbs(new Array(files.length).fill(undefined));
    (async () => {
      for (let i = 0; i < files.length; i++) {
        try {
          const b64 = await renderPage(files[i].path, 0, 56, {
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          });
          if (cancelled) return;
          setBatchThumbs((p) => {
            const a = [...p];
            a[i] = b64;
            return a;
          });
        } catch {}
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [files]);

  // {t("trim.preview_target")}ファイルの情報 + 画像取得
  useEffect(() => {
    const path = files[previewIdx]?.path;
    if (!path) return;

    let cancelled = false;

    // PDF情報取得
    getPdfInfo(path, {
      layoutW: convertLayoutW,
      layoutH: convertLayoutH,
      layoutEm: convertLayoutEm,
    })
      .then((info) => {
        if (!cancelled) setCurPageInfo(info);
      })
      .catch(() => {});

    // プレビュー画像（現在のプレビューページ）
    setPageImage("");
    renderPage(path, previewPage, PREVIEW_DPI, {
      layoutW: convertLayoutW,
      layoutH: convertLayoutH,
      layoutEm: convertLayoutEm,
    })
      .then((b64) => {
        if (!cancelled) setPageImage(b64);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [files, previewIdx, previewPage]);

  const pickDir = useCallback(async () => {
    const dir = await invoke<string | null>("pick_output_dir").catch(() => null);
    if (dir) {
      setOutDir(dir);
      usePdfStore.getState().setLastSaveDir(dir);
    }
  }, []);

  const handleExecute = useCallback(async () => {
    if (!outDir) return;

    setPhase("processing");
    const prog = {
      current: 0,
      done: [] as { f: string }[],
      errors: [] as { f: string; msg: string }[],
    };
    setProgress({ ...prog });

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      prog.current = i + 1;
      setProgress({ ...prog });

      try {
        const out = joinPath(outDir, buildName(f.filename, ["trimmed"]));

        console.log(
          "[DEBUG] trim_pdf in out margin pages exclude extract: ",
          f.path,
          out,
          trimMargins,
          trimPages,
          excludeSpec,
          extractSpec,
        );
        const psize = resolvePageSizePt(pageSizeId, pageOrientation);
        const needFit = hasImage([f.filename]) && psize != null;
        const trimOut = needFit ? await getTempPath("trimmed_natural_batch_tmp.pdf") : out;
        const res = await trimPdf(
          f.path,
          trimOut,
          trimMargins,
          trimPages,
          excludeSpec,
          extractSpec,
          convertLayoutW,
          convertLayoutH,
          convertLayoutEm,
          cropCleanup,
        );
        if (needFit && psize) {
          await fitTrimmedToPageSize(
            trimOut,
            out,
            psize,
            pageOrientation === "auto" && pageSizeId !== "image",
          );
        }
        console.log("[DEBUG] trim_pdf 結果:", res);
        prog.done.push({ f: f.filename });
      } catch (e) {
        prog.errors.push({ f: f.filename, msg: String(e) });
      }
      setProgress({ ...prog });
    }

    announceSuccess("done.trim");
    setPhase("result");
  }, [
    files,
    trimMargins,
    trimPages,
    excludeSpec,
    extractSpec,
    outDir,
    pageSizeId,
    pageOrientation,
  ]);

  // 処理中画面
  if (phase === "processing") {
    const pct = (progress.current / files.length) * 100;
    return (
      <div style={b.center}>
        <div style={b.title}>
          {t("trim.processing", { current: String(progress.current), total: String(files.length) })}
        </div>
        <div style={b.barWrap}>
          <div style={{ ...b.bar, width: `${pct}%` }} />
        </div>
        <div style={b.log}>
          {progress.done.map((d, i) => (
            <div key={i} style={b.logRow}>
              <span style={{ color: "var(--c-accent)" }}>✓</span>
              <span style={b.logFile}>{d.f}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // 結果画面
  if (phase === "result") {
    return (
      <div style={b.center}>
        <span
          style={{
            fontSize: 56,
            color: progress.errors.length ? "var(--c-warn)" : "var(--c-accent)",
          }}
        >
          {progress.errors.length ? "⚠" : "✓"}
        </span>
        <div style={b.title}>
          {t("trim.batch_done_title", { count: String(progress.done.length) })}
        </div>
        <div style={{ fontSize: 12, color: "var(--c-textSub)" }}>
          {usePdfStore.getState().lastSaveDir}
        </div>
        <div style={b.log}>
          {progress.done.map((d, i) => (
            <div key={i} style={b.logRow}>
              <span style={{ color: "var(--c-accent)" }}>✓</span>
              <span style={b.logFile}>{d.f}</span>
            </div>
          ))}
          {progress.errors.map((e, i) => (
            <div
              key={`e${i}`}
              style={{
                ...b.logRow,
                background: "var(--c-errBg)",
                borderColor: "var(--c-errBd)",
              }}
            >
              <span style={{ color: "var(--c-err)" }}>✕</span>
              <span style={b.logFile}>{e.f}</span>
              <span style={{ fontSize: 10, color: "var(--c-err)" }}>{e.msg}</span>
            </div>
          ))}
        </div>
        <button
          style={b.backBtn}
          onClick={() => {
            setPhase("edit");
          }}
        >
          {t("common.back")}
        </button>
      </div>
    );
  }

  // 編集画面
  const curFile = files[previewIdx];
  const curPages = curFile?.pageCount ?? 1;
  const curW = curPageInfo?.pages[previewPage]?.w ?? 595;
  const curH = curPageInfo?.pages[previewPage]?.h ?? 842;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--c-bg)",
        color: "var(--c-text)",
        fontFamily: F,
        overflow: "hidden",
      }}
    >
      {/* ヘッダー */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 20px",
          borderBottom: `1px solid var(--c-border)`,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 700 }}>
          {t("trim.batch_title", { count: String(files.length) })}
        </span>
        <span style={{ fontSize: 13, color: "var(--c-textSub)" }}>{t("trim.apply_all")}</span>
      </div>

      {/* 本体 */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* 左: ファイル一覧 */}
        <div
          style={{
            width: 172,
            flexShrink: 0,
            borderRight: `1px solid var(--c-border)`,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "8px 12px",
              fontSize: 11,
              color: "var(--c-textDim)",
              borderBottom: `1px solid var(--c-border)`,
              background: "var(--c-bgCard)",
            }}
          >
            {t("trim.preview_target")}
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {files.map((f, i) => (
              <button
                key={f.id}
                style={{
                  ...s.thumb,
                  ...(previewIdx === i ? s.thumbOn : {}),
                }}
                onClick={() => setPreviewIdx(i)}
              >
                {batchThumbs[i] ? (
                  <img src={`data:image/jpeg;base64,${batchThumbs[i]}`} style={s.thumbImg} alt="" />
                ) : (
                  <div style={s.thumbPh} />
                )}
                <span style={s.thumbN}>{f.filename}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 中央: キャンバス */}
        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            padding: "16px 20px",
            gap: 12,
          }}
        >
          {/* ズームコントロール */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <button
              style={s.zBtn}
              onClick={() => setZoom((z) => +Math.max(0.25, z - 0.25).toFixed(2))}
            >
              −
            </button>
            <span style={{ fontSize: 11, minWidth: 36, textAlign: "center" }}>
              {Math.round(zoom * 100)}%
            </span>
            <button
              style={s.zBtn}
              onClick={() => setZoom((z) => +Math.min(4.0, z + 0.25).toFixed(2))}
            >
              ＋
            </button>
            <button style={s.zBtn} onClick={() => setZoom(1.0)}>
              100%
            </button>
            <span style={{ fontSize: 10, color: "var(--c-textDim)", marginLeft: 4 }}>
              {t("trim.scroll_hint")}
            </span>
          </div>
          <div
            style={{ ...s.canvasWrap, overflow: "auto" }}
            ref={canvasWrapRef}
            tabIndex={0}
            onKeyDown={(e) => {
              if (!e.ctrlKey) return;
              if (e.key === "+" || e.key === "=") {
                e.preventDefault();
                setZoom((z) => +Math.min(4.0, z + 0.25).toFixed(2));
              } else if (e.key === "-") {
                e.preventDefault();
                setZoom((z) => +Math.max(0.25, z - 0.25).toFixed(2));
              } else if (e.key === "0") {
                e.preventDefault();
                setZoom(1.0);
              }
            }}
            onWheel={(e) => {
              if (!e.ctrlKey) return;
              e.preventDefault();
              const delta = e.deltaY > 0 ? -0.1 : 0.1;
              setZoom((z) => +Math.max(0.25, Math.min(4.0, z + delta)).toFixed(2));
            }}
          >
            {pageImage ? (
              <TrimCanvas
                pageImageB64={pageImage}
                pageWidthPt={curW}
                pageHeightPt={curH}
                margins={trimMargins}
                onChange={setTrimMargins}
                displayWidth={Math.round(canvasWidth * zoom)}
              />
            ) : (
              <div style={s.ph}>{t("trim.page_loading")}</div>
            )}
          </div>
        </main>

        {/* 右: コントロール */}
        <aside style={s.panel}>
          <TrimControls
            margins={trimMargins}
            pageW={curW}
            pageH={curH}
            trimPages={trimPages}
            onPages={onPages}
            totalPages={curPages}
            onMargins={setTrimMargins}
            onApply={handleExecute}
            onReset={() => setTrimMargins(zero())}
            processing={phase !== "edit"}
            applyLabel={
              outDir
                ? t("trim.apply_label", { count: String(files.length) })
                : t("trim.no_dir_apply")
            }
            outDir={outDir}
            onPickDir={pickDir}
            excludeSpec={excludeSpec}
            onExclude={onExclude}
            extractSpec={extractSpec}
            onExtract={onExtract}
            showImagePageSize={files.some((f) => hasImage([f.filename]))}
          />
        </aside>
      </div>
    </div>
  );
}

// ── 単体トリム ────────────────────────────────────────────────────────────────
export function TrimPageSingle({ filePath, pdfInfo }: { filePath: string; pdfInfo: PdfInfo }) {
  // Zustand から状態を直接取得・更新
  const {
    //trimMargins,
    //setTrimMargins,
    //previewPage,
    //setPreviewPage,
    setError,
    convertLayoutW,
    convertLayoutH,
    convertLayoutEm,
    pageSizeId,
    pageOrientation,
  } = usePdfStore();
  const { announceScreen, announceSuccess, announceError, announceKey } = useA11y();
  const { t } = useI18n();
  const [statusMsg, setStatusMsg] = useState("");
  const marginTopRef = useRef<HTMLInputElement | null>(null);
  const rangeRef = useRef<HTMLInputElement | null>(null);
  // TrimPageSingle では出力先フォルダはファイル保存ダイアログで処理するため
  // Alt+D は設定中の旨を読み上げるのみ（バッチ側の pickDir とは別）
  const pickSingle = useSaveDialog().pickSave;

  useEffect(() => {
    announceScreen("screen.trim");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useKeyboardShortcuts({
    "Ctrl+Enter": () => {
      if (phase === "edit") handleExecute();
    },
    "Ctrl+S": () => {
      if (phase === "result") handleSave();
    },
    "Ctrl+Shift+S": () => {
      if (phase === "result") {
      }
    },
    "Alt+D": () => {
      // TrimPageSingle では保存先は実行時に選択するため、その旨を読み上げる
      tts.speak(t("aria.output_dir_btn"));
    },
    "Alt+M": () => {
      marginTopRef.current?.focus();
      tts.speak(t("aria.margin_top"));
    },
    "Alt+R": () => {
      rangeRef.current?.focus();
      tts.speak(t("aria.range_input"));
    },
    Escape: () => {
      if (phase === "result") {
        setPhase("edit");
        tts.speak(t("shortcut.back_to_edit"));
      }
    },
    F1: () => announceKey("shortcut.trim_tool"),
  });

  const [zoom, setZoom] = useState(0.75);
  const [canvasWidth, setCanvasWidth] = useState(CANVAS_W_DEFAULT);
  const canvasWrapRef = useRef<HTMLDivElement>(null);

  // コンテナ幅追従
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? CANVAS_W_DEFAULT;
      setCanvasWidth(Math.max(300, Math.floor(w - 24)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [previewPage, setPreviewPage] = useState(0);
  const [trimMargins, setTrimMargins] = useState<TrimMargins>(zero());
  const [phase, setPhase] = useState<Phase>("edit");
  const [pageImage, setPageImage] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [resultImgs, setResultImgs] = useState<string[]>([]);
  const [tmpPageInfo, setTmpPageInfo] = useState<PdfInfo | null>(null);
  // 左ペイン各ページのサムネイル
  const [thumbs, setThumbs] = useState<(string | undefined)[]>([]);

  const [trimPages, onPages] = useState("all");
  const [excludeSpec, onExclude] = useState("");
  const [extractSpec, onExtract] = useState("all");
  const [cropCleanup, setCropCleanup] = useState(false);
  const { pickSave } = useSaveDialog();
  const [outTmp, setOutTmp] = useState<string>("");
  const [metaEditOpen, setMetaEditOpen] = useState(false);

  const currentPage = pdfInfo.pages[previewPage] ?? { w: 595, h: 842, rotate: 0 };
  const pageW = currentPage.w;
  const pageH = currentPage.h;
  const [Pages, setPages] = useState(pdfInfo.page_count) || 1;

  // プレビューページ変更時に画像を再取得
  useEffect(() => {
    usePdfStore.getState().resetTrimState();
    renderPage(filePath, previewPage, PREVIEW_DPI, {
      layoutW: convertLayoutW,
      layoutH: convertLayoutH,
      layoutEm: convertLayoutEm,
    })
      .then(setPageImage)
      .catch(() => setPageImage(""));
  }, [filePath, previewPage, pageImage]);

  const { enabled: previewEnabled } = usePreview("trim");

  // 左ペインのサムネイルをバックグラウンドで順次取得
  useEffect(() => {
    if (!previewEnabled) {
      setThumbs([]);
      return;
    }
    setThumbs(new Array(pdfInfo.page_count).fill(undefined));
    let cancelled = false;
    (async () => {
      for (let i = 0; i < pdfInfo.page_count; i++) {
        try {
          const b64 = await renderPage(filePath, i, THUMB_DPI, {
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          });
          if (cancelled) return;
          setThumbs((prev) => {
            const a = [...prev];
            a[i] = b64;
            return a;
          });
        } catch {}
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath, pdfInfo.page_count, previewEnabled]);

  // Ctrl+ホイール / Ctrl+キーボードでキャンバスズーム（document レベルで捕捉）
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      setZoom((z) => +Math.min(4.0, Math.max(0.25, z + delta)).toFixed(2));
    };
    window.addEventListener("wheel", handler, { passive: false });
    return () => window.removeEventListener("wheel", handler);
  }, []);

  const handleCanvasKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!e.ctrlKey) return;
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      setZoom((z) => +Math.min(4.0, z + 0.25).toFixed(2));
    } else if (e.key === "-") {
      e.preventDefault();
      setZoom((z) => +Math.max(0.25, z - 0.25).toFixed(2));
    } else if (e.key === "0") {
      e.preventDefault();
      setZoom(1.0);
    }
  }, []);

  const handleExecute = useCallback(async () => {
    setPhase("processing");
    setResultImgs([]);
    try {
      const tmpPath = await getTempPath("trimmed_tmp.pdf");
      setOutTmp(tmpPath);

      console.log(
        "[DEBUG] trim_pdf",
        filePath,
        tmpPath,
        trimMargins,
        trimPages,
        excludeSpec,
        extractSpec,
      );
      const psize = resolvePageSizePt(pageSizeId, pageOrientation);
      // 画像入力 + ページサイズ指定時は「自然サイズでトリム → 結果を目標サイズへフィット」。
      // マージンは自然サイズ基準のまま使えるので座標の割合再計算が不要。
      const needFit = hasImage([filePath]) && psize != null;
      const trimOut = needFit ? await getTempPath("trimmed_natural_tmp.pdf") : tmpPath;
      const res = await trimPdf(
        filePath,
        trimOut,
        trimMargins,
        trimPages,
        excludeSpec,
        extractSpec,
        convertLayoutW,
        convertLayoutH,
        convertLayoutEm,
        cropCleanup,
      );
      if (needFit && psize) {
        await fitTrimmedToPageSize(
          trimOut,
          tmpPath,
          psize,
          pageOrientation === "auto" && pageSizeId !== "image",
        );
      }
      /*
      .then(() => { 
        // プレビュー用に結果画像を取得（任意で最大6ページ）
        getPdfInfo(tmpPath, { layoutW: convertLayoutW, layoutH: convertLayoutH, layoutEm: convertLayoutEm }).then(info => {
          setTmpPageInfo(info);
	  pages = info.page_count;
          console.log("pages1", pages);
        }).catch(() => { pages = pdfInfo.page_count; });
      }).catch(() => {});
*/
      let pages = pdfInfo.page_count;
      await getPdfInfo(tmpPath, {
        layoutW: convertLayoutW,
        layoutH: convertLayoutH,
        layoutEm: convertLayoutEm,
      })
        .then((info) => {
          setTmpPageInfo(info);
          pages = info.page_count;
          setPages(pages);
        })
        .catch(() => {
          pages = pdfInfo.page_count;
          setPages(pages);
        });

      console.log("[DEBUG] trim_pdf 結果:", res);
      console.log("Pages", Pages, pages);

      const n = Math.min(6, pages);
      const imgs: string[] = [];
      for (let i = 0; i < n; i++) {
        try {
          const b64 = await renderPage(tmpPath, i, RESULT_DPI, {
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          });
          imgs.push(b64);
        } catch (e) {
          break;
        }
      }
      setResultImgs(imgs); // 必要なら状態追加
      //setSavedPath(outTmp);
      announceSuccess("done.trim");
      setPhase("result");
    } catch (e) {
      console.error("[ERROR] trimPdf エラー:", e);
      announceError(String(e));
      setErrMsg(String(e));
      setPhase("error");
      setError(String(e));
    }
  }, [
    filePath,
    outTmp,
    trimMargins,
    trimPages,
    excludeSpec,
    extractSpec,
    pdfInfo.page_count,
    tmpPageInfo,
    Pages,
    setError,
    pageSizeId,
    pageOrientation,
  ]);

  const handleSave = async () => {
    const sp = await pickSave(buildName(filePath, ["trimmed"]));
    if (!sp) return;
    setIsSaving(true);
    try {
      // 保存は終端処理。保存後は「保存完了」画面へ遷移し、そこに「圧縮して保存」は
      // 出さないため、moveFile で一時ファイルを消費して問題ない（後始末も兼ねる）。
      await moveFile(outTmp, sp);
      setSavedPath(sp);
      setPhase("saved");
    } catch (e) {
      announceError(String(e));
      setErrMsg(String(e));
      setPhase("error");
    } finally {
      setIsSaving(false);
    }
  };

  if (phase === "processing")
    return (
      <div style={s.center}>
        <div style={s.spinner} />
        <span style={s.centSub}>{t("trim.processing_preview")}</span>
      </div>
    );

  if (phase === "error")
    return (
      <div style={s.center}>
        <span style={{ fontSize: 40, color: "var(--c-err)" }}>✕</span>
        <span style={{ fontSize: 16, fontWeight: 700, color: "var(--c-err)" }}>エラー</span>
        <pre style={s.errMsg}>{errMsg}</pre>
        <button
          style={s.errBtn}
          onClick={() => {
            setPhase("edit");
            setErrMsg("");
          }}
        >
          {t("common.back")}
        </button>
      </div>
    );

  if (phase === "compress") {
    return (
      <CompressPage
        filePath={filePath}
        pdfInfo={pdfInfo}
        sourceFile={outTmp || undefined}
        outputBaseName={stem(filePath) + opSuffix("trimmed")}
      />
    );
  }

  if (phase === "saved")
    return (
      <div style={s.center}>
        <span style={{ fontSize: 40, color: "var(--c-accent)" }}>✓</span>
        <span style={{ fontSize: 16, fontWeight: 700 }}>{t("trim.saved_title")}</span>
        <span
          style={{
            ...s.centSub,
            maxWidth: 480,
            textAlign: "center",
            wordBreak: "break-all",
          }}
        >
          {savedPath}
        </span>
        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <button style={s.errBtn} onClick={() => setMetaEditOpen(true)}>
            ✏️ {t("meta_edit.title")}
          </button>
          <button
            style={s.errBtn}
            onClick={() => {
              setPhase("edit");
              setResultImgs([]);
              setSavedPath("");
              setErrMsg("");
            }}
          >
            {t("trim.back_to_edit")}
          </button>
        </div>
        {metaEditOpen && savedPath && (
          <MetadataEditModal
            filePath={savedPath}
            onClose={() => setMetaEditOpen(false)}
            isOutputFile
          />
        )}
      </div>
    );

  if (phase === "result")
    return (
      <ResultView
        images={resultImgs}
        pageCount={Pages}
        onSave={handleSave}
        onBack={() => {
          setPhase("edit");
          setResultImgs([]);
          setErrMsg("");
        }}
        onCompress={() => setPhase("compress")}
        isSaving={isSaving}
        savedPath={savedPath}
      />
    );

  return (
    <div style={s.root}>
      <div style={s.sidebar}>
        <PreviewPane
          pageKey="trim"
          label={t("common.pages", { count: String(pdfInfo.page_count) })}
        >
          <div style={s.thumbList}>
            {Array.from({ length: pdfInfo.page_count }, (_, i) => (
              <button
                key={i}
                style={{
                  ...s.thumb,
                  ...(previewPage === i ? s.thumbOn : {}),
                }}
                onClick={() => setPreviewPage(i)}
              >
                {thumbs[i] ? (
                  <img
                    src={`data:image/jpeg;base64,${thumbs[i]}`}
                    style={s.thumbImg}
                    alt={`Page ${i + 1}`}
                  />
                ) : (
                  <div style={s.thumbPh}>{t("common.page_placeholder", { n: String(i + 1) })}</div>
                )}
                <span style={s.thumbN}>{i + 1}</span>
              </button>
            ))}
          </div>
        </PreviewPane>
      </div>

      <main style={s.main}>
        <div style={s.mainHead}>
          <span style={s.mainTitle}>{t("trim.settings_title")}</span>
          <span style={s.pageInd}>
            {t("common.page_of", {
              current: String(previewPage + 1),
              total: String(pdfInfo.page_count),
            })}
          </span>
          {/* ズームコントロール */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: "auto" }}>
            <button
              style={s.zBtn}
              onClick={() => setZoom((z) => +Math.max(0.25, z - 0.25).toFixed(2))}
            >
              −
            </button>
            <span style={{ fontSize: 11, minWidth: 36, textAlign: "center" }}>
              {Math.round(zoom * 100)}%
            </span>
            <button
              style={s.zBtn}
              onClick={() => setZoom((z) => +Math.min(4.0, z + 0.25).toFixed(2))}
            >
              ＋
            </button>
            <button style={s.zBtn} onClick={() => setZoom(1.0)}>
              100%
            </button>
          </div>
        </div>
        <div
          style={{ ...s.canvasWrap, overflow: "auto" }}
          ref={canvasWrapRef}
          tabIndex={0}
          onKeyDown={handleCanvasKeyDown}
        >
          {pageImage ? (
            <TrimCanvas
              pageImageB64={pageImage}
              pageWidthPt={pageW}
              pageHeightPt={pageH}
              margins={trimMargins}
              onChange={setTrimMargins}
              displayWidth={Math.round(canvasWidth * zoom)}
            />
          ) : (
            <div
              style={{
                ...s.ph,
                width: canvasWidth,
                height: Math.round((canvasWidth * pageH) / pageW),
              }}
            >
              <div style={s.spinner} />
              <span style={s.centSub}>{t("trim.loading")}</span>
            </div>
          )}
        </div>
      </main>

      <aside style={s.panel}>
        <TrimControls
          margins={trimMargins}
          pageW={pageW}
          pageH={pageH}
          totalPages={pdfInfo.page_count}
          onMargins={setTrimMargins} // Zustand 更新
          trimPages={trimPages}
          onPages={onPages} // Zustand 更新
          topInputRef={marginTopRef}
          rangeInputRef={rangeRef}
          onApply={handleExecute}
          onReset={() => setTrimMargins(zero())}
          processing={phase !== "edit"}
          excludeSpec={excludeSpec}
          onExclude={onExclude}
          extractSpec={extractSpec}
          onExtract={onExtract}
          cropCleanup={cropCleanup}
          onCropCleanupChange={setCropCleanup}
          showImagePageSize={hasImage([filePath])}
        />
      </aside>
      <LiveRegion message={statusMsg} />
    </div>
  );
}

// ── 結果ビュー ────────────────────────────────────────────────────────────────
function ResultView({
  images,
  pageCount,
  onSave,
  onBack,
  onCompress,
  isSaving,
  savedPath,
}: {
  images: string[];
  pageCount: number;
  onSave: () => void;
  onBack: () => void;
  onCompress: () => void;
  isSaving: boolean;
  savedPath?: string;
}) {
  const [localZoom, setLocalZoom] = useState(0.5);
  const galleryRef = useRef<HTMLDivElement>(null);
  // 結果画面に入ったら「保存」(圧縮せず保存)ボタンへフォーカス
  const saveBtnRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const id = window.setTimeout(() => saveBtnRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);
  const [cardWidth, setCardWidth] = useState(400);

  // ギャラリーコンテナ幅に追従して1枚あたりのカード幅を算出
  useEffect(() => {
    const el = galleryRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 800;
      // 余白 48px（padding 24px×2）を引いて1枚分の幅にする
      setCardWidth(Math.max(200, Math.floor(w - 48)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { t } = useI18n();
  const [metaEditOpen, setMetaEditOpen] = useState(false);

  // Ctrl+ホイールでズーム
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setLocalZoom((z) => +Math.min(4.0, Math.max(0.25, z + delta)).toFixed(2));
    };
    window.addEventListener("wheel", handler, { passive: false });
    return () => window.removeEventListener("wheel", handler);
  }, []);

  return (
    <div style={r.root}>
      <div style={r.header}>
        <button style={r.btnBack} onClick={onBack}>
          {t("common.back")}
        </button>
        <span style={r.title}>{t("trim.result_title")}</span>
        <span style={r.sub}>
          {t("trim.result_pages", { pages: String(pageCount), shown: String(images.length) })}
        </span>
        <div style={{ flex: 1 }} />
        {/* ズームコントロール */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button
            style={r.btnBack}
            onClick={() => setLocalZoom((z) => +Math.max(0.25, z - 0.25).toFixed(2))}
          >
            −
          </button>
          <span style={{ fontSize: 11, minWidth: 36, textAlign: "center" }}>
            {Math.round(localZoom * 100)}%
          </span>
          <button
            style={r.btnBack}
            onClick={() => setLocalZoom((z) => +Math.min(4.0, z + 0.25).toFixed(2))}
          >
            ＋
          </button>
          <button style={r.btnBack} onClick={() => setLocalZoom(1.0)}>
            100%
          </button>
        </div>
      </div>

      <div style={r.gallery} ref={galleryRef}>
        {images.map((b64, i) => (
          <div key={i} style={r.card}>
            <span style={r.pageN}>{t("common.page_n", { n: String(i + 1) })}</span>
            {b64 ? (
              <img
                src={`data:image/jpeg;base64,${b64}`}
                style={{ ...r.img, width: Math.round(cardWidth * localZoom), maxWidth: "none" }}
                alt=""
              />
            ) : (
              <div style={r.imgPh}>{t("trim.preview_fail")}</div>
            )}
          </div>
        ))}
      </div>

      <div style={r.footer}>
        <button style={r.btnBack} onClick={onBack}>
          {t("common.back")}
        </button>
        <button
          style={{ ...r.btnSave, ...(isSaving ? r.dis : {}) }}
          onClick={onSave}
          disabled={isSaving}
        >
          {isSaving ? t("common.saving") : t("common.save_pdf")}
        </button>
        <button ref={saveBtnRef} style={r.btnCompress} onClick={onCompress}>
          {t("common.compress_then_save")}
        </button>
        {savedPath && (
          <button
            style={r.btnMeta}
            onClick={() => setMetaEditOpen(true)}
            title={t("meta_edit.title")}
            aria-label={t("meta_edit.title")}
          >
            ✏️ {t("meta_edit.title")}
          </button>
        )}
      </div>

      {metaEditOpen && savedPath && (
        <MetadataEditModal
          filePath={savedPath}
          onClose={() => setMetaEditOpen(false)}
          isOutputFile
        />
      )}
    </div>
  );
}

// ── スタイル ─────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    height: "100%",
    background: "var(--c-bg)",
    color: "var(--c-text)",
    fontFamily: F,
    overflow: "hidden",
  },
  center: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: 18,
    background: "var(--c-bg)",
  },
  spinner: {
    width: 32,
    height: 32,
    border: `3px solid var(--c-border)`,
    borderTop: `3px solid var(--c-accent)`,
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  centSub: { color: "var(--c-textSub)", fontSize: 13 },

  sidebar: {
    width: 128,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    background: "var(--c-bgCard)",
    borderRight: `1px solid var(--c-border)`,
    overflow: "hidden",
  },
  sbHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 10px 7px",
    borderBottom: `1px solid var(--c-border)`,
  },
  sbTitle: {
    fontSize: 10,
    color: "var(--c-textDim)",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
  },
  sbCount: { fontSize: 10, color: "var(--c-textDim)" },
  thumbList: {
    flex: 1,
    overflowY: "auto",
    padding: "6px 5px",
    display: "flex",
    flexDirection: "column",
    gap: 5,
  },
  thumb: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 3,
    padding: "5px 4px",
    borderRadius: 6,
    border: "1px solid transparent",
    background: "transparent",
    cursor: "pointer",
    transition: "all 0.12s",
  },
  thumbOn: { borderColor: "var(--c-accent)", background: "var(--c-accentBg)" },
  thumbImg: { width: 104, height: "auto", borderRadius: 2, display: "block" },
  thumbPh: { width: 104, height: 140, background: "var(--c-border)", borderRadius: 2 },
  thumbN: { fontSize: 10, color: "var(--c-textDim)" },

  main: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    padding: "16px 20px",
    gap: 12,
  },
  mainHead: { display: "flex", alignItems: "center", gap: 12 },
  mainTitle: { fontSize: 15, fontWeight: 600, color: "var(--c-text)" },
  pageInd: { fontSize: 12, color: "var(--c-textSub)" },
  canvasWrap: {
    flex: 1,
    overflow: "auto",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
  },
  zBtn: {
    fontSize: 12,
    padding: "2px 6px",
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-border)",
    borderRadius: 4,
    cursor: "pointer",
    color: "var(--c-text)",
  },
  ph: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--c-bgCard)",
    borderRadius: 8,
    gap: 12,
  },
  panel: { width: 280, flexShrink: 0, borderLeft: `1px solid var(--c-border)`, overflow: "hidden" },

  errMsg: {
    fontSize: 12,
    color: "var(--c-err)",
    background: "var(--c-errBg)",
    border: `1px solid var(--c-errBd)`,
    borderRadius: 6,
    padding: "12px 16px",
    maxWidth: 480,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  errBtn: {
    padding: "8px 22px",
    background: "transparent",
    border: `1px solid var(--c-errBd)`,
    borderRadius: 7,
    color: "var(--c-err)",
    cursor: "pointer",
    fontSize: 13,
    fontFamily: F,
  },
};

const r: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "var(--c-bg)",
    color: "var(--c-text)",
    fontFamily: F,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "12px 20px",
    borderBottom: `1px solid var(--c-border)`,
    flexShrink: 0,
  },
  btnBack: {
    padding: "6px 14px",
    background: "transparent",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 6,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontSize: 13,
    fontFamily: F,
  },
  btnCompress: {
    padding: "8px 18px",
    background: "var(--c-accentBg)",
    border: `1px solid var(--c-accentBd)`,
    borderRadius: 7,
    color: "var(--c-accent)",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: 13,
    fontFamily: F,
  },
  btnMeta: {
    padding: "6px 12px",
    background: "transparent",
    border: "1px solid var(--c-accent)",
    borderRadius: 7,
    color: "var(--c-accent)",
    cursor: "pointer",
    fontSize: 12,
    fontFamily: "inherit",
  },
  btnSave: {
    padding: "9px 22px",
    background: "var(--c-accentBg)",
    border: `2px solid var(--c-accentBd)`,
    borderRadius: 7,
    color: "var(--c-accent)",
    fontWeight: 700,
    cursor: "pointer",
    fontSize: 14,
    fontFamily: F,
  },
  dis: { opacity: 0.4, cursor: "not-allowed" },
  title: { fontSize: 15, fontWeight: 600, color: "var(--c-text)" },
  sub: { fontSize: 12, color: "var(--c-textSub)" },
  gallery: {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 20,
    padding: 24,
    alignItems: "center",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 9,
    padding: 14,
  },
  pageN: { fontSize: 11, color: "var(--c-textSub)" },
  img: { display: "block", borderRadius: 4, height: "auto" },
  imgPh: {
    width: 200,
    height: 260,
    background: "var(--c-bgHover)",
    borderRadius: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--c-textDim)",
    fontSize: 12,
  },
  more: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--c-textDim)",
    fontSize: 13,
    padding: "30px 20px",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    padding: "12px 20px",
    borderTop: `1px solid var(--c-border)`,
    flexShrink: 0,
  },
};

const b: Record<string, React.CSSProperties> = {
  center: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: 14,
    background: "var(--c-bg)",
    padding: 32,
  },
  title: { fontSize: 17, fontWeight: 700, color: "var(--c-text)" },
  barWrap: {
    width: "100%",
    maxWidth: 460,
    height: 8,
    background: "var(--c-border)",
    borderRadius: 4,
    overflow: "hidden",
  },
  bar: { height: "100%", background: "var(--c-accent)", borderRadius: 4, transition: "width 0.3s" },
  log: {
    width: "100%",
    maxWidth: 460,
    display: "flex",
    flexDirection: "column",
    gap: 5,
    maxHeight: 300,
    overflowY: "auto",
  },
  logRow: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "6px 10px",
    background: "var(--c-bgCard)",
    borderRadius: 6,
    border: `1px solid var(--c-border)`,
  },
  logFile: {
    flex: 1,
    fontSize: 12,
    color: "var(--c-text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  backBtn: {
    padding: "9px 26px",
    background: "transparent",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 7,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontSize: 13,
    fontFamily: F,
    marginTop: 8,
  },
};
