// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/pages/ImageExportPage.tsx — 単体 & バッチ対応

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Spinner,
  ErrorView,
  ThumbCard,
  PageHeader,
  BtnBack,
  BtnPrimary,
} from "../components/common";
import { usePdfStore, type FileEntry } from "../store/usePdfStore";
import {
  renderPage,
  exportImages,
  exportImagePdf,
  checkPathConflict,
  type PdfInfo,
  type ImageFormat,
} from "../lib/tauri";
import { PageSelector, resolvePageSpec } from "../components/PageSelector";
//import { C, F } from "../lib/theme";
import { F } from "../lib/theme";
import { useA11y } from "../hooks/useA11y";
import { tts } from "../lib/tts";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { LiveRegion } from "../components/A11yControls";
import { useI18n } from "../lib/i18n";
import { useSaveDialog } from "../hooks/useSaveDialog";

interface Props {
  filePath: string;
  pdfInfo: PdfInfo;
  batchFiles?: FileEntry[];
}

type Phase = "edit" | "processing" | "result" | "error";
type OutputMode = "images" | "pdf";
const THUMB_DPI = 56;

// DPI プリセット (desc は翻訳キー)
const DPI_PRESET_KEYS = [
  { label: "72", val: 72, descKey: "image.dpi_screen" },
  { label: "144", val: 144, descKey: "image.dpi_standard" },
  { label: "300", val: 300, descKey: "image.dpi_print" },
  { label: "600", val: 600, descKey: "image.dpi_hires" },
];

interface BatchProgress {
  current: number;
  total: number;
  currentFile: string;
  done: { file: string; count: number; pdfPath?: string }[];
  errors: { file: string; msg: string }[];
}

export function ImageExportPage({ filePath, pdfInfo, batchFiles }: Props) {
  const { setError, convertLayoutW, convertLayoutH, convertLayoutEm } = usePdfStore();
  const { announceScreen, announceSuccess, announceError, announceKey } = useA11y();
  const { t } = useI18n();
  const { pickSave } = useSaveDialog();
  const [statusMsg, setStatusMsg] = useState("");
  const DPI_PRESETS = useMemo(
    () => DPI_PRESET_KEYS.map((p) => ({ ...p, desc: t(p.descKey) })),
    [t],
  );

  useEffect(() => {
    announceScreen("screen.image");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pagesInputRef = useRef<HTMLInputElement | null>(null);
  useKeyboardShortcuts({
    "Ctrl+Enter": () => {
      if (phase === "edit") {
        tts.speak(t("shortcut.executing"));
        isBatch ? handleExecuteBatch() : handleExecuteSingle();
      }
    },
    "Alt+D": () => {
      pickDir();
      tts.speak(t("aria.output_dir_btn"));
    },
    "Alt+R": () => {
      pagesInputRef.current?.focus();
      tts.speak(t("aria.range_input"));
    },
    Escape: () => {
      if (phase === "result") {
        setPhase("edit");
        tts.speak(t("shortcut.back_to_edit"));
      }
    },
    F1: () => announceKey("shortcut.tool"),
  });
  const isBatch = (batchFiles?.length ?? 0) > 1;
  const total = pdfInfo.page_count;
  console.log("Image: filePath,pdfInfo", filePath, pdfInfo);
  console.log("Image: total(pages)", total);

  const [phase, setPhase] = useState<Phase>("edit");
  const [thumbs, setThumbs] = useState<(string | undefined)[]>([]);
  const [format, setFormat] = useState<ImageFormat>("jpeg");
  const [dpi, setDpi] = useState(144);
  const [quality, setQuality] = useState(85);
  const [prefix, setPrefix] = useState("page_");
  const [outputMode, setOutputMode] = useState<OutputMode>("images");
  const [pdfName, setPdfName] = useState("");
  const [outDir, setOutDir] = useState("");
  const [pages, setPages] = useState(""); // "" = 全ページ
  // pages 指定を正確に展開したページ数（odd/even/末尾省略も対応）
  const resolvedPageCount = useMemo(
    () => resolvePageSpec(pages || "", total).length,
    [pages, total],
  );

  // 画像PDFモード時: 出力先が元ファイルと同じになる競合を検出
  // 状態管理
  const [conflictPaths, setConflictPaths] = useState<string[]>([]);

  const rasterizedDefaultName = useMemo(() => {
    const base = filePath
      .split(/[/\\]/)
      .pop()
      ?.replace(/\.pdf$/i, "");
    return `${base || "output"}_rasterized.pdf`;
  }, [filePath]);

  // 衝突チェック
  useEffect(() => {
    const checkConflict = async () => {
      if (outputMode !== "pdf" || !outDir) {
        setConflictPaths([]);
        return;
      }

      try {
        let batchInfo: Array<[string, string]> | null = null;
        if (isBatch && batchFiles) {
          batchInfo = batchFiles.map((f) => [f.filename, f.path]);
        }

        const conflicts = await checkPathConflict({
          inputPath: filePath, // ← input_path → inputPath
          outDir: outDir, // ← out_dir → outDir
          pdfName: isBatch ? undefined : pdfName || undefined,
          isBatch: isBatch, // ← is_batch → isBatch
          batchFiles: batchInfo, // ← batch_files → batchFiles
        });

        setConflictPaths(conflicts);
      } catch (e) {
        console.error("Conflict check failed", e);
        setConflictPaths([]);
      }
    };

    checkConflict();
  }, [outputMode, outDir, pdfName, filePath, isBatch, batchFiles]);

  const [images, setImages] = useState<string[]>([]);
  const [pdfOutPath, setPdfOutPath] = useState("");
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [errMsg, setErrMsg] = useState("");
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [batchThumbs, setBatchThumbs] = useState<(string | undefined)[]>([]);
  const [previewIdx, setPreviewIdx] = useState(0);

  // 単体: サムネイル
  useEffect(() => {
    if (isBatch) return;
    let cancelled = false;
    setThumbs([]);
    (async () => {
      for (let i = 0; i < total; i++) {
        try {
          const b64 = await renderPage(filePath, i, THUMB_DPI, {
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          });
          if (cancelled) return;
          setThumbs((p) => {
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
  }, [filePath, isBatch]);

  // バッチ: 先頭ページサムネイル
  useEffect(() => {
    if (!isBatch || !batchFiles) return;
    let cancelled = false;
    setBatchThumbs(new Array(batchFiles.length).fill(undefined));
    (async () => {
      for (let i = 0; i < batchFiles.length; i++) {
        try {
          const b64 = await renderPage(batchFiles[i].path, 0, THUMB_DPI, {
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
  }, [isBatch, batchFiles]);

  const pickDir = useCallback(async () => {
    const dir = await invoke<string | null>("pick_output_dir").catch(() => null);
    if (dir) setOutDir(dir);
  }, []);

  // サイズ概算
  const scale = dpi / 72;
  const pw = Math.round(595 * scale);
  const ph = Math.round(842 * scale);

  // 単体実行
  const handleExecuteSingle = useCallback(async () => {
    if (outputMode === "images" && !outDir) {
      await pickDir();
      return;
    }
    if (conflictPaths.length > 0) return; // 警告表示中は実行しない
    setPhase("processing");
    try {
      if (outputMode === "pdf") {
        const outPath = await pickSave(rasterizedDefaultName);

        if (!outPath) {
          setPdfName("");
          setPhase("edit");
          return;
        }

        const dir = outPath.replace(/[/\\][^/\\]+$/, "");
        if (dir) {
          setOutDir(dir);
        }

        const res = await exportImagePdf(
          filePath,
          outPath,
          dpi,
          format === "jpeg" ? quality : 85,
          pages || undefined,
          { layoutW: convertLayoutW, layoutH: convertLayoutH, layoutEm: convertLayoutEm },
        );
        setPdfOutPath(outPath);
        setPdfPageCount(resolvedPageCount);
        setPdfName("");
        if (res.warning) setStatusMsg(res.warning);
        announceSuccess("done.image");
        setPhase("result");
      } else {
        console.log("exportImages", prefix, pages, filePath, outDir, format, dpi, format);
        const res = await exportImages(
          filePath,
          outDir,
          format,
          dpi,
          format === "jpeg" ? quality : undefined,
          prefix || undefined,
          pages || undefined,
          { layoutW: convertLayoutW, layoutH: convertLayoutH, layoutEm: convertLayoutEm },
        );
        console.log("res", res);
        setImages(res.files);
        announceSuccess("done.image");
        setPhase("result");
      }
    } catch (e) {
      announceError(String(e));
      setErrMsg(String(e));
      setPhase("error");
      setError(String(e));
    }
  }, [
    filePath,
    outDir,
    outputMode,
    pdfName,
    format,
    dpi,
    quality,
    prefix,
    pages,
    resolvedPageCount,
    conflictPaths,
    rasterizedDefaultName,
    pickSave,
    pickDir,
    setError,
    announceSuccess,
    announceError,
  ]);

  // バッチ実行
  const handleExecuteBatch = useCallback(async () => {
    if (!outDir) {
      await pickDir();
      return;
    }
    if (conflictPaths.length > 0) return; // 警告表示中は実行しない
    const files = batchFiles!;
    setPhase("processing");
    const progress: BatchProgress = {
      current: 0,
      total: files.length,
      currentFile: "",
      done: [],
      errors: [],
    };
    setBatchProgress({ ...progress });
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      progress.current = i + 1;
      progress.currentFile = f.filename;
      setBatchProgress({ ...progress });
      try {
        const stem = f.filename.replace(/\.[^/.]+$/, "");
        if (outputMode === "pdf") {
          // 画像PDFモード: ファイルごとに1つの .pdf を出力
          const outPath = `${outDir}/${stem}.pdf`;
          const res = await exportImagePdf(
            f.path,
            outPath,
            dpi,
            format === "jpeg" ? quality : 85,
            pages || undefined,
            { layoutW: convertLayoutW, layoutH: convertLayoutH, layoutEm: convertLayoutEm },
          );
          const pageCount =
            resolvePageSpec(pages || "", f.pageCount || 0).length || f.pageCount || 0;
          progress.done.push({ file: f.filename, count: pageCount, pdfPath: outPath });
          if (res.warning) console.warn(res.warning);
        } else {
          // 画像ファイルモード: サブフォルダに1ページずつ
          const subDir = `${outDir}/${stem}`;
          const res = await exportImages(
            f.path,
            subDir,
            format,
            dpi,
            format === "jpeg" ? quality : undefined,
            prefix || undefined,
            pages || undefined,
            { layoutW: convertLayoutW, layoutH: convertLayoutH, layoutEm: convertLayoutEm },
          );
          progress.done.push({ file: f.filename, count: res.files.length });
        }
      } catch (e) {
        progress.errors.push({ file: f.filename, msg: String(e) });
      }
      setBatchProgress({ ...progress });
    }
    announceSuccess("done.image");
    setPhase("result");
  }, [
    batchFiles,
    outDir,
    outputMode,
    format,
    dpi,
    quality,
    prefix,
    pages,
    conflictPaths,
    pickDir,
    announceSuccess,
  ]);

  // ─────────── フェーズ ───────────
  if (phase === "processing" && !isBatch)
    return <Spinner label={t("image.processing", { current: String(resolvedPageCount) })} />;

  if (phase === "processing" && isBatch && batchProgress)
    return (
      <div style={s.root}>
        <div style={s.center}>
          <div style={s.bpTitle}>
            {t("image.batch_processing", {
              current: String(batchProgress.current),
              total: String(batchProgress.total),
            })}
          </div>
          <div style={s.bpBar}>
            <div
              style={{
                ...s.bpFill,
                width: `${(batchProgress.current / batchProgress.total) * 100}%`,
              }}
            />
          </div>
          <div style={s.bpCurrent}>{batchProgress.currentFile}</div>
          <div style={s.bpLog}>
            {batchProgress.done.map((d, i) => (
              <div key={i} style={s.bpRow}>
                <span style={{ color: "var(--c-accent)" }}>✓</span>
                <span style={s.bpFile}>{d.file}</span>
                <span style={s.bpMeta}>
                  {d.pdfPath
                    ? t("image.output_pdf", {
                        name: d.pdfPath.split(/[\/\\]/).pop() ?? "",
                        count: String(d.count),
                      })
                    : t("image.pages_count", { count: String(d.count) })}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );

  if (phase === "error")
    return (
      <ErrorView
        msg={errMsg}
        onBack={() => {
          setPhase("edit");
          setErrMsg("");
        }}
      />
    );

  // バッチ完了
  if (phase === "result" && isBatch && batchProgress) {
    return (
      <div style={s.root}>
        <PageHeader>
          <BtnBack
            onClick={() => {
              setPhase("edit");
              setBatchProgress(null);
            }}
          />
          <span style={s.title}>{t("image.batch_done_title")}</span>
        </PageHeader>
        <div style={s.center}>
          <span
            style={{
              fontSize: 56,
              color: batchProgress.errors.length ? "var(--c-warn)" : "var(--c-accent)",
            }}
          >
            {batchProgress.errors.length ? "⚠" : "✓"}
          </span>
          <div style={s.bpTitle}>
            {t("image.done_count", { count: String(batchProgress.done.length) })}
            {batchProgress.errors.length > 0
              ? t("image.error_count", { count: String(batchProgress.errors.length) })
              : ""}
          </div>
          <div style={{ fontSize: 12, color: "var(--c-textSub)" }}>{outDir}</div>
          <div style={s.bpLog}>
            {batchProgress.done.map((d, i) => (
              <div key={i} style={s.bpRow}>
                <span style={{ color: "var(--c-accent)" }}>✓</span>
                <span style={s.bpFile}>{d.file}</span>
                <span style={s.bpMeta}>
                  {d.pdfPath
                    ? t("image.output_pdf", {
                        name: d.pdfPath.split(/[\/\\]/).pop() ?? "",
                        count: String(d.count),
                      })
                    : t("image.pages_count", { count: String(d.count) })}
                </span>
              </div>
            ))}
            {batchProgress.errors.map((e, i) => (
              <div
                key={`e${i}`}
                style={{ ...s.bpRow, background: "var(--c-errBg)", borderColor: "var(--c-errBd)" }}
              >
                <span style={{ color: "var(--c-err)" }}>✕</span>
                <span style={s.bpFile}>{e.file}</span>
                <span style={{ ...s.bpMeta, color: "var(--c-err)" }}>{e.msg}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );

    // 単体完了
  } else if (phase === "result") {
    console.log("images2", images);
    return (
      <div style={s.root}>
        <PageHeader>
          <BtnBack
            onClick={(e) => {
              setPhase("edit");
              (e.currentTarget as HTMLButtonElement).blur();
            }}
          />
          <span style={s.title}>
            {outputMode === "pdf" ? t("image.done_title_pdf") : t("image.done_title")}
          </span>
        </PageHeader>
        <div style={s.center}>
          <span style={{ fontSize: 56, color: "var(--c-accent)" }}>✓</span>
          {outputMode === "pdf" ? (
            <>
              <div style={s.bpTitle}>
                {t("image.output_pdf", {
                  name: pdfOutPath.split(/[/\\]/).pop() ?? "",
                  count: String(pdfPageCount),
                })}
              </div>
              <div style={{ fontSize: 12, color: "var(--c-textSub)" }}>{pdfOutPath}</div>
              {statusMsg && (
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--c-warn)",
                    background: "var(--c-bgCard)",
                    padding: "8px 12px",
                    borderRadius: 7,
                    border: "1px solid var(--c-warnBd)",
                    maxWidth: 480,
                  }}
                >
                  {t("image.rasterize_warning")}
                </div>
              )}
            </>
          ) : (
            <>
              <div style={s.bpTitle}>
                {t("image.output_count", { count: String(images.length) })}
              </div>
              <div style={{ fontSize: 12, color: "var(--c-textSub)" }}>{outDir}</div>
              <div style={s.bpLog}>
                {images.slice(0, 20).map((f, i) => (
                  <div key={i} style={s.bpRow}>
                    <span>🖼</span>
                    <span style={s.bpFile}>{f.split(/[/\\]/).pop()}</span>
                  </div>
                ))}
                {images.length > 20 && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--c-textDim)",
                      textAlign: "center",
                      padding: 8,
                    }}
                  >
                    {t("image.other_files", { count: String(images.length - 20) })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }
  // ─────────── 設定画面 ───────────
  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>
          {isBatch
            ? t("image.title_batch", { count: String(batchFiles!.length) })
            : t("image.title_single")}
        </span>
        {!isBatch && <span style={s.sub}>{filePath.split(/[/\\]/).pop()}</span>}
        {!isBatch && (
          <span style={s.pageBadge}>{t("common.pages", { count: String(resolvedPageCount) })}</span>
        )}
        <div style={{ flex: 1 }} />
        <span style={s.outBadge}>
          → {format.toUpperCase()} {pw}×{ph}px
        </span>
      </PageHeader>

      <div style={s.body}>
        {/* 設定パネル */}
        <div style={s.panel}>
          <div style={s.secLabel}>フォーマット</div>
          <div style={s.fmtRow}>
            {(["jpeg", "png", "svg"] as const).map((f) => (
              <button
                key={f}
                onClick={(e) => {
                  setFormat(f);
                  (e.currentTarget as HTMLButtonElement).blur();
                }}
                style={{ ...s.fmtBtn, ...(format === f ? s.fmtBtnOn : {}) }}
              >
                <span style={s.fmtIcon}>{f === "jpeg" ? "🖼" : "📐"}</span>
                <span style={s.fmtName}>{f.toUpperCase()}</span>
                <span style={s.fmtDesc}>
                  {f === "jpeg"
                    ? t("image.jpeg_small")
                    : f === "png"
                      ? t("image.png_desc")
                      : t("image.svg_desc")}
                </span>
              </button>
            ))}
          </div>

          <div style={s.secLabel}>{t("image.output_mode")}</div>
          <div style={s.fmtRow}>
            <button
              onClick={(e) => {
                setOutputMode("images");
                (e.currentTarget as HTMLButtonElement).blur();
              }}
              style={{ ...s.modeBtn, ...(outputMode === "images" ? s.modeBtnOn : {}) }}
            >
              <span style={s.fmtName}>{t("image.mode_images")}</span>
              <span style={s.fmtDesc}>{t("image.mode_images_sub")}</span>
            </button>
            <button
              disabled={format === "svg"}
              onClick={(e) => {
                setOutputMode("pdf");
                (e.currentTarget as HTMLButtonElement).blur();
              }}
              style={{
                ...s.modeBtn,
                ...(outputMode === "pdf" ? s.modeBtnOn : {}),
                ...(format === "svg" ? { opacity: 0.4, cursor: "not-allowed" } : {}),
              }}
            >
              <span style={s.fmtName}>{t("image.mode_pdf")}</span>
              <span style={s.fmtDesc}>{t("image.mode_pdf_sub")}</span>
            </button>
          </div>

          {format !== "svg" && (
            <>
              <div style={s.secLabel}>{t("image.dpi_label")}</div>
              <div style={s.dpiGrid}>
                {DPI_PRESETS.map((p) => (
                  <button
                    key={p.val}
                    onClick={(e) => {
                      setDpi(p.val);
                      (e.currentTarget as HTMLButtonElement).blur();
                    }}
                    style={{ ...s.dpiBtn, ...(dpi === p.val ? s.dpiBtnOn : {}) }}
                  >
                    <span style={s.dpiLabel}>{p.label}</span>
                    <span style={s.dpiDesc}>{p.desc}</span>
                  </button>
                ))}
              </div>
              {/* DPI 数値直接入力 — 大きめフォント */}
              <div style={s.numRow}>
                <button style={s.stepBtn} onClick={() => setDpi((v) => Math.max(36, v - 12))}>
                  −
                </button>
                <input
                  type="number"
                  style={s.numInput}
                  value={dpi}
                  min={36}
                  max={1200}
                  onChange={(e) => setDpi(parseInt(e.target.value) || 72)}
                />
                <button style={s.stepBtn} onClick={() => setDpi((v) => Math.min(1200, v + 12))}>
                  ＋
                </button>
                <span style={s.numLabel}>
                  dpi → {pw}×{ph}px
                </span>
              </div>
            </>
          )}
          {format === "jpeg" && (
            <>
              <div style={s.secLabel}>
                {t("image.quality_label")}{" "}
                <span style={{ fontSize: 20, fontWeight: 700, color: "var(--c-text)" }}>
                  {quality}
                </span>
                %
              </div>
              <input
                type="range"
                min={10}
                max={100}
                step={5}
                value={quality}
                onChange={(e) => setQuality(parseInt(e.target.value))}
                style={{ width: "100%", accentColor: "var(--c-accent)" }}
              />
              <div style={s.rangeLabels}>
                <span>{t("image.quality_low")}</span>
                <span>{t("image.quality_high")}</span>
              </div>
            </>
          )}

          <div style={s.secLabel}>{t("image.page_label")}</div>
          <PageSelector
            totalPages={isBatch ? 0 : total}
            value={pages}
            onChange={setPages}
            type="1"
            compact
            rangeInputRef={pagesInputRef}
          />

          {outputMode === "images" ? (
            <>
              <div style={s.secLabel}>{t("image.prefix_label")}</div>
              <div style={s.prefixRow}>
                <input
                  type="text"
                  style={s.textInput}
                  value={prefix}
                  placeholder="page"
                  onChange={(e) => setPrefix(e.target.value)}
                />
                <span style={s.prefixSuffix}>0001.{format === "jpeg" ? "jpg" : format}</span>
              </div>
            </>
          ) : (
            ""
          )}

          {/* 競合警告バナー */}
          {conflictPaths.length > 0 && (
            <div style={s.conflictBanner}>
              {isBatch
                ? t("image.conflict_batch", { files: conflictPaths.join(", ") })
                : t("image.conflict_single")}
            </div>
          )}

          {isBatch && (
            <div style={s.batchNote}>
              {outputMode === "pdf" ? t("image.subfolder_note_pdf") : t("image.subfolder_note")}
            </div>
          )}

          {(isBatch || outputMode === "images") && (
            <>
              <div style={s.secLabel}>{t("image.output_dir")}</div>
              <div style={s.dirRow}>
                <div style={s.dirPath} title={outDir}>
                  {outDir || t("common.select_dir")}
                </div>
                <button
                  style={s.dirPickBtn}
                  onClick={pickDir}
                  aria-label={t("aria.output_dir_btn")}
                >
                  {t("common.browse")}
                </button>
              </div>
            </>
          )}

          <BtnPrimary
            onClick={isBatch ? handleExecuteBatch : handleExecuteSingle}
            disabled={conflictPaths.length > 0}
          >
            {outDir
              ? isBatch
                ? outputMode === "pdf"
                  ? t("image.execute_batch_pdf", { count: String(batchFiles!.length) })
                  : t("image.execute_batch", { count: String(batchFiles!.length) })
                : outputMode === "pdf"
                  ? t("image.execute_pdf")
                  : t("image.execute", { count: String(resolvedPageCount) })
              : isBatch
                ? t("common.no_dir_btn")
                : outputMode === "pdf"
                  ? t("image.execute_pdf")
                  : t("common.no_dir_btn")}
          </BtnPrimary>
        </div>

        {/* プレビューエリア */}
        <div style={s.preview}>
          {isBatch ? (
            <>
              <div style={s.previewHead}>
                {t("image.target_files", { count: String(batchFiles!.length) })}
              </div>
              <div style={s.batchFileList}>
                {batchFiles!.map((f, i) => (
                  <button
                    key={f.id}
                    type="button"
                    style={{
                      ...s.batchFileItem,
                      ...(i === previewIdx ? s.batchFileItemOn : {}),
                      appearance: "none",
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      textAlign: "left",
                      width: "100%", // 推奨: リスト項目として横幅を広げる
                      outline: "none", // フォーカス時の枠を消す（任意）
                    }}
                    onClick={(e) => {
                      const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
                      setPreviewIdx(i);
                      itemRefs.current[i]?.blur();
                    }}
                  >
                    {batchThumbs[i] ? (
                      <img
                        src={`data:image/jpeg;base64,${batchThumbs[i]}`}
                        style={s.batchThumb}
                        alt=""
                      />
                    ) : (
                      <div style={s.batchThumbPh} />
                    )}
                    <div style={s.batchFileInfo}>
                      <span style={s.batchFileName}>{f.filename}</span>
                      <span style={s.batchFileMeta}>
                        {t("common.pages", { count: String(f.pageCount) })}
                      </span>
                      <span style={s.batchFileMeta}>
                        {outputMode === "pdf"
                          ? t("image.result_suffix_pdf", {
                              pages: String(
                                resolvePageSpec(pages || "", f.pageCount || 0).length ||
                                  f.pageCount,
                              ),
                            })
                          : t("image.result_suffix", {
                              pages: String(
                                resolvePageSpec(pages || "", f.pageCount || 0).length ||
                                  f.pageCount,
                              ),
                              format: format === "jpeg" ? "JPG" : format.toUpperCase(),
                            })}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div style={s.previewHead}>
                {t("common.preview_pages", { count: String(resolvedPageCount) })}
              </div>
              <div style={s.thumbGrid}>
                {resolvePageSpec(pages || "", total).map((i) => {
                  const pb = pdfInfo.pages?.[i];
                  const aspect = pb ? pb.w / pb.h : undefined;
                  return (
                    <ThumbCard
                      key={i}
                      b64={thumbs[i]}
                      pageNum={i + 1}
                      width={130}
                      aspectRatio={aspect}
                    />
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
      <LiveRegion message={statusMsg} />
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "var(--c-bg)",
    color: "var(--c-text)",
    fontFamily: F,
    overflow: "hidden",
  },
  title: { fontSize: 16, fontWeight: 700, color: "var(--c-text)" },
  sub: {
    fontSize: 13,
    color: "var(--c-textSub)",
    maxWidth: 200,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pageBadge: {
    padding: "3px 11px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 12,
    fontSize: 12,
    color: "var(--c-textSub)",
  },
  outBadge: { fontSize: 14, color: "var(--c-accent)", fontWeight: 700 },

  body: { flex: 1, display: "flex", overflow: "hidden" },
  panel: {
    width: 300,
    flexShrink: 0,
    padding: "16px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    overflowY: "auto",
    borderRight: `1px solid var(--c-border)`,
  },
  secLabel: {
    fontSize: 12,
    color: "var(--c-textSub)",
    letterSpacing: "0.07em",
    textTransform: "uppercase" as const,
    marginTop: 4,
  },

  fmtRow: { display: "flex", gap: 8 },
  fmtBtn: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 5,
    padding: "13px 8px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 9,
    cursor: "pointer",
    fontFamily: F,
    transition: "all 0.1s",
  },
  fmtBtnOn: { borderColor: "var(--c-accent)", background: "var(--c-accentBg)" },
  fmtIcon: { fontSize: 22 },
  fmtName: { fontSize: 14, fontWeight: 700, color: "var(--c-text)" },
  fmtDesc: { fontSize: 11, color: "var(--c-textSub)", textAlign: "center" as const },

  modeBtn: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: 4,
    padding: "10px 8px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 9,
    cursor: "pointer",
    fontFamily: F,
    transition: "all 0.1s",
  },
  modeBtnOn: { borderColor: "var(--c-accent)", background: "var(--c-accentBg)" },

  dpiGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 },
  dpiBtn: {
    display: "flex",
    flexDirection: "column",
    padding: "8px 10px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 7,
    cursor: "pointer",
    fontFamily: F,
    transition: "all 0.1s",
  },
  dpiBtnOn: { borderColor: "var(--c-accent)", background: "var(--c-accentBg)" },
  dpiLabel: { fontSize: 16, fontWeight: 700, color: "var(--c-text)" },
  dpiDesc: { fontSize: 11, color: "var(--c-textSub)" },

  // 数値入力 — 大きめ
  numRow: { display: "flex", alignItems: "center", gap: 7 },
  stepBtn: {
    width: 42,
    height: 42,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 7,
    cursor: "pointer",
    fontSize: 22,
    color: "var(--c-text)",
    fontFamily: F,
    flexShrink: 0,
  },
  numInput: {
    width: 84,
    height: 48,
    padding: "4px 0",
    boxSizing: "border-box" as const,
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 7,
    color: "var(--c-text)",
    fontSize: 20,
    lineHeight: "54px",
    fontFamily: F,
    textAlign: "center" as const,
    fontWeight: 700,
  },
  numLabel: { fontSize: 11, color: "var(--c-textSub)" },
  rangeLabels: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 11,
    color: "var(--c-textDim)",
  },

  prefixRow: { display: "flex", alignItems: "center", gap: 6 },
  textInput: {
    flex: 1,
    padding: "8px 10px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 7,
    color: "var(--c-text)",
    fontSize: 18,
    height: 36,
    lineHeight: "48px",
    fontFamily: F,
  },
  prefixSuffix: { fontSize: 11, color: "var(--c-textDim)", flexShrink: 0 },
  dirRow: { display: "flex", gap: 7 },
  dirPath: {
    flex: 1,
    padding: "8px 10px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 7,
    color: "var(--c-textSub)",
    fontSize: 12,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  dirPickBtn: {
    padding: "8px 14px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 7,
    color: "var(--c-text)",
    cursor: "pointer",
    fontSize: 13,
    fontFamily: F,
    flexShrink: 0,
  },
  batchNote: {
    padding: "10px 12px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-accentBd)`,
    borderRadius: 7,
    fontSize: 12,
    color: "var(--c-textSub)",
    lineHeight: 1.6,
  },

  conflictBanner: {
    padding: "10px 12px",
    background: "var(--c-errBg)",
    border: `1px solid var(--c-errBd)`,
    borderRadius: 7,
    fontSize: 12,
    color: "var(--c-err)",
    lineHeight: 1.6,
    fontWeight: 500,
  },

  // 進捗
  center: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 32,
  },
  bpTitle: { fontSize: 17, fontWeight: 700, color: "var(--c-text)" },
  bpBar: {
    width: "100%",
    maxWidth: 480,
    height: 8,
    background: "var(--c-border)",
    borderRadius: 4,
    overflow: "hidden",
  },
  bpFill: {
    height: "100%",
    background: "var(--c-accent)",
    borderRadius: 4,
    transition: "width 0.3s",
  },
  bpCurrent: { fontSize: 13, color: "var(--c-textSub)" },
  bpLog: {
    width: "100%",
    maxWidth: 480,
    display: "flex",
    flexDirection: "column",
    gap: 5,
    maxHeight: 300,
    overflowY: "auto",
  },
  bpRow: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "6px 10px",
    background: "var(--c-bgCard)",
    borderRadius: 6,
    border: `1px solid var(--c-border)`,
  },
  bpFile: {
    flex: 1,
    fontSize: 13,
    color: "var(--c-text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  bpMeta: { fontSize: 12, color: "var(--c-textSub)", flexShrink: 0 },

  preview: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  previewHead: {
    padding: "11px 18px",
    fontSize: 13,
    color: "var(--c-textSub)",
    borderBottom: `1px solid var(--c-border)`,
    flexShrink: 0,
  },
  thumbGrid: {
    flex: 1,
    overflowY: "auto",
    padding: 14,
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 8,
    alignContent: "flex-start",
  },

  batchFileList: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" },
  batchFileItem: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 16px",
    borderBottom: `1px solid var(--c-border)`,
    cursor: "pointer",
    transition: "background 0.1s",
  },
  batchFileItemOn: { background: "var(--c-accentBg)", borderLeft: `3px solid var(--c-accent)` },
  batchThumb: {
    maxWidth: 72,
    maxHeight: 108,
    objectFit: "contain" as const,
    borderRadius: 4,
    flexShrink: 0,
  },
  batchThumbPh: {
    width: 54,
    height: 76,
    background: "var(--c-border)",
    borderRadius: 4,
    flexShrink: 0,
  },
  batchFileInfo: { flex: 1, display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
  batchFileName: {
    fontSize: 14,
    color: "var(--c-text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  batchFileMeta: { fontSize: 12, color: "var(--c-textSub)" },
};
