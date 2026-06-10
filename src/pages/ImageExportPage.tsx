// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/pages/ImageExportPage.tsx — 単体 & バッチ対応
export default ImageExportPage;

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
  joinPath,
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
import {
  type ImpositionMode,
  IMPOSITION_MODE_DEFS,
  IMPOSITION_MODES,
  calcSheets,
  type DeImpositionMode,
  DE_IMPOSITION_MODE_DEFS,
  calcSplitCells,
} from "../lib/imposition";
import {
  renderImposition,
  rasterizeImposition,
  splitImpositionPdf,
  splitCellRender,
} from "../lib/tauri";
import { PreviewPane } from "../components/PreviewPane";
import { usePreview } from "../hooks/usePreview";

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
  // i18n対応の面付けモード（label/descを翻訳済みで上書き）
  const IMPOSITION_MODES_I18N = IMPOSITION_MODE_DEFS.map((m) => ({
    ...m,
    label: t(m.labelKey as any),
    desc: t(m.descKey as any),
  }));
  const { enabled: previewEnabled } = usePreview("image");
  const total = pdfInfo.page_count;
  console.log("Image: filePath,pdfInfo", filePath, pdfInfo);
  console.log("Image: total(pages)", total);

  const [phase, setPhase] = useState<Phase>("edit");
  // 処理方向: "normal"=通常変換/面付け, "deimpose"=面付け解除/分割
  const [processDir, setProcessDir] = useState<"normal" | "deimpose">("normal");
  // 面付けモード
  const [impositionMode, setImpositionMode] = useState<ImpositionMode>("1up");
  // 面付け解除の選択（DE_IMPOSITION_MODE_DEFS のインデックス）
  const [deimpIndex, setDeimpIndex] = useState(0);
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

  // 単体: サムネイル（プレビュー有効時のみ）
  useEffect(() => {
    if (isBatch) return;
    if (!previewEnabled) {
      setThumbs([]);
      return;
    }
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
  }, [filePath, isBatch, previewEnabled]);

  // バッチ: 先頭ページサムネイル（プレビュー有効時のみ）
  useEffect(() => {
    if (!isBatch || !batchFiles) return;
    if (!previewEnabled) {
      setBatchThumbs([]);
      return;
    }
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
  }, [isBatch, batchFiles, previewEnabled]);

  const pickDir = useCallback(async (): Promise<string | null> => {
    const dir = await invoke<string | null>("pick_output_dir").catch(() => null);
    if (dir) setOutDir(dir);
    return dir;
  }, []);

  // サイズ概算（目安）。入力1ページの基準サイズ（A4 595×842pt）を基に、
  // 面付け（N-up/booklet）なら合成後シート、面付け解除なら1セルのサイズを表示する。
  const scale = dpi / 72;
  const baseW = 595;
  const baseH = 842;
  const { estW: pw, estH: ph } = useMemo(() => {
    if (processDir === "deimpose") {
      // 面付け解除: 1セル = 入力ページを cols×rows で割ったサイズ
      const def = DE_IMPOSITION_MODE_DEFS[deimpIndex];
      return {
        estW: Math.round((baseW / def.cols) * scale),
        estH: Math.round((baseH / def.rows) * scale),
      };
    }
    if (impositionMode !== "1up") {
      const info = IMPOSITION_MODE_DEFS.find((m) => m.id === impositionMode)!;
      // 面付け: シート = cols×rows のセルを並べたサイズ
      return {
        estW: Math.round(baseW * info.cols * scale),
        estH: Math.round(baseH * info.rows * scale),
      };
    }
    // 通常: 1ページ
    return { estW: Math.round(baseW * scale), estH: Math.round(baseH * scale) };
  }, [processDir, deimpIndex, impositionMode, scale]);

  // 単体実行（面付け対応版）
  const handleExecuteSingle = useCallback(async () => {
    // ── 面付け解除（split / de-imposition）: A3見開きなどを分割 ──
    if (processDir === "deimpose") {
      const def = DE_IMPOSITION_MODE_DEFS[deimpIndex];
      // 入力（A3等）シートの枚数 = 対象ページ数
      const pageSpec = resolvePageSpec(pages || "", total); // 0始まり
      const sheetPageNums = (
        pageSpec.length ? pageSpec : Array.from({ length: total }, (_, i) => i)
      ).map((i) => i + 1); // 1始まり
      const sheetCount = sheetPageNums.length;
      if (sheetCount === 0) {
        setStatusMsg(t("image.deimp_no_pages" as any));
        return;
      }
      // calcSplitCells はシート番号1..sheetCount で計算するので、
      // 実ページ番号へのマッピングを用意する
      const cellsLogical = calcSplitCells(sheetCount, def.cols, def.rows, def.id);
      // logical sheet番号(1..sheetCount) → 実ページ番号
      const cells: [number, number, number][] = cellsLogical.map((c) => [
        sheetPageNums[c.page - 1],
        c.row,
        c.col,
      ]);

      if (outputMode === "pdf") {
        const outPath = await pickSave(rasterizedDefaultName);
        if (!outPath) {
          setPdfName("");
          return;
        }
        const dir = outPath.replace(/[/\\][^/\\]+$/, "");
        if (dir) setOutDir(dir);
        setPhase("processing");
        try {
          await splitImpositionPdf({
            input: filePath,
            output: outPath,
            cells,
            cols: def.cols,
            rows: def.rows,
            dpi,
            quality,
            usePng: format === "png",
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          });
          setPdfOutPath(outPath);
          setPdfPageCount(cells.length);
          setPdfName("");
          // 画像PDFなのでテキスト消失の注意を表示
          setStatusMsg(t("image.rasterize_warning" as any));
          announceSuccess("done.image");
          setPhase("result");
        } catch (e) {
          console.error("splitImpositionPdf failed", e);
          setStatusMsg(String(e));
          setPhase("edit");
        }
        return;
      }

      // 個別画像出力（JPEG/PNG/SVG）
      const resolvedDir = outDir || (await pickDir());
      if (!resolvedDir) return;
      setPhase("processing");
      try {
        const ext = format === "png" ? "png" : format === "svg" ? "svg" : "jpg";
        const savedFiles: string[] = [];
        for (let k = 0; k < cells.length; k++) {
          const [pg, row, col] = cells[k];
          setStatusMsg(
            t("image.deimp_rendering" as any, {
              n: String(k + 1),
              total: String(cells.length),
            }),
          );
          const res = await splitCellRender({
            input: filePath,
            page: pg,
            cols: def.cols,
            rows: def.rows,
            cellRow: row,
            cellCol: col,
            dpi,
            format,
            quality,
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          });
          const outName = `${rasterizedDefaultName.replace(/\.pdf$/i, "")}_${String(k + 1).padStart(3, "0")}.${ext}`;
          const outPath = joinPath(resolvedDir, outName);
          await invoke("save_base64_image", {
            data: res.data_b64,
            path: outPath,
            // SVG はラスタ画像でないため EXIF/PNG メタデータ埋め込みはスキップ
            sourcePath: format === "svg" ? undefined : filePath,
          });
          savedFiles.push(outPath);
        }
        setImages(savedFiles);
        setOutDir(resolvedDir);
        setStatusMsg("");
        announceSuccess("done.image");
        setPhase("result");
      } catch (e) {
        console.error("splitCellRender failed", e);
        setStatusMsg(String(e));
        setPhase("edit");
      }
      return;
    }

    // 面付けモードかつ images 出力: renderImposition で直接レンダリングして保存
    console.log(
      "[imposition] outputMode:",
      outputMode,
      "mode:",
      impositionMode,
      "isBatch:",
      isBatch,
    );
    if (outputMode === "images" && impositionMode !== "1up" && !isBatch) {
      const resolvedDir = outDir || (await pickDir());
      if (!resolvedDir) return; // キャンセル
      setPhase("processing");
      setStatusMsg(t("image.imposition_rendering_init" as any));
      try {
        // 高DPI × 多ページのメモリ試算（600MB超は確認ダイアログ）
        const modeInfo0 = IMPOSITION_MODES_I18N.find((m) => m.id === impositionMode)!;
        const estimatedMB = Math.round(
          (Math.round((595 * dpi) / 72) *
            modeInfo0.cols *
            Math.round((842 * dpi) / 72) *
            modeInfo0.rows *
            3) /
            1024 /
            1024,
        );
        if (estimatedMB > 600) {
          const ok = window.confirm(
            t("image.imposition_memory_warn" as any, {
              mb: String(estimatedMB),
              dpi: String(dpi),
              mode:
                IMPOSITION_MODES_I18N.find((m) => m.id === impositionMode)?.label ?? impositionMode,
            }),
          );
          if (!ok) {
            setPhase("edit");
            return;
          }
        }

        // pages指定を反映した実際の対象ページ数でシートを計算
        const pageSpec = resolvePageSpec(pages || "", total).map((i) => i + 1); // 1始まり
        const pageSet = new Set(pageSpec);
        const effectiveCount = pageSpec.length || total;
        const sheets = calcSheets(
          impositionMode,
          effectiveCount,
          t("common.imposition_blank_page" as any),
          (n) => t("image.imposition_sheet_front" as any, { n: String(n) }),
          (n) => t("image.imposition_sheet_back" as any, { n: String(n) }),
        );
        console.log(
          "[imposition] effectiveCount:",
          effectiveCount,
          "sheets:",
          sheets.length,
          sheets.map((s) => s.label),
        );
        const modeInfo = IMPOSITION_MODES_I18N.find((m) => m.id === impositionMode)!;
        const fmt = format === "png" ? "png" : "jpeg";
        const base =
          filePath
            .split(/[\\/]/)
            .pop()
            ?.replace(/\.pdf$/i, "") ?? "page";
        const ext = format === "png" ? "png" : "jpg";
        const totalSheets = sheets.length;
        const savedFiles: string[] = [];

        for (let si = 0; si < totalSheets; si++) {
          const sheet = sheets[si];
          // 対象外ページは 0（空白）に置き換え
          const pageNums = sheet.pages.map((p) => (p === 0 || pageSet.has(p) ? p : 0));

          // 進捗: レンダリング開始前に表示
          setStatusMsg(
            t("image.imposition_rendering" as any, {
              current: String(si + 1),
              total: String(totalSheets),
              label: sheet.label,
            }),
          );

          const result = await renderImposition({
            path: filePath,
            pageNums,
            cols: modeInfo.cols,
            rows: modeInfo.rows,
            dpi,
            format: fmt,
            quality: fmt === "jpeg" ? quality : undefined,
            gapPx: 0,
          });

          // base64 → ファイル保存
          const outName = `${prefix}${impositionMode}_${String(si + 1).padStart(3, "0")}.${ext}`;
          const outPath = joinPath(resolvedDir, outName);
          setStatusMsg(
            t("image.imposition_saving" as any, {
              current: String(si + 1),
              total: String(totalSheets),
              name: outName,
            }),
          );
          await invoke("save_base64_image", {
            data: result.image_b64,
            path: outPath,
            sourcePath: filePath,
          });
          savedFiles.push(outPath);
        }
        setImages(savedFiles);
        setPhase("result");
        setStatusMsg(
          t("image.imposition_done" as any, { count: String(totalSheets), dir: resolvedDir }),
        );
      } catch (e) {
        setPhase("error");
        setError(String(e));
      }
      return;
    }

    let effectiveOutDir = outDir;
    if (outputMode === "images" && !outDir) {
      const d = await pickDir();
      if (!d) return; // キャンセル
      effectiveOutDir = d;
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

        // 面付けモード（2up/4up/booklet）: 各シートを1ページに合成した画像PDFを出力
        if (impositionMode !== "1up") {
          const modeInfo = IMPOSITION_MODES_I18N.find((m) => m.id === impositionMode)!;
          // pages指定を反映した対象ページでシートを計算
          const pageSpec = resolvePageSpec(pages || "", total).map((i) => i + 1);
          const pageSet = new Set(pageSpec);
          const effectiveCount = pageSpec.length || total;
          const sheets = calcSheets(
            impositionMode,
            effectiveCount,
            t("common.imposition_blank_page" as any),
            (n) => t("image.imposition_sheet_front" as any, { n: String(n) }),
            (n) => t("image.imposition_sheet_back" as any, { n: String(n) }),
          );
          const cells = modeInfo.cols * modeInfo.rows;
          // ページ指定の有無
          const hasPageFilter = pageSpec.length > 0;
          // 全シートのページ番号を連結（セル数に満たない分は0=空白で埋める）
          const sheetPages: number[] = [];
          for (const sheet of sheets) {
            for (let c = 0; c < cells; c++) {
              const p = sheet.pages[c] ?? 0;
              // ページ指定があり、対象外なら空白(0)に
              if (p !== 0 && hasPageFilter && !pageSet.has(p)) {
                sheetPages.push(0);
              } else {
                sheetPages.push(p);
              }
            }
          }
          const res = await rasterizeImposition({
            input: filePath,
            output: outPath,
            sheetPages,
            nSheets: sheets.length,
            cols: modeInfo.cols,
            rows: modeInfo.rows,
            dpi,
            quality,
            usePng: format === "png",
            gapPx: 0,
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          });
          setPdfOutPath(outPath);
          setPdfPageCount(sheets.length);
          setPdfName("");
          // 面付け画像PDFも各ページが画像化されるため、
          // 1ページごとの画像PDFと同様にテキスト消失の注意を表示する
          setStatusMsg(t("image.rasterize_warning" as any));
          announceSuccess("done.image");
          setPhase("result");
          return;
        }

        const res = await exportImagePdf(
          filePath,
          outPath,
          dpi,
          quality,
          format === "png",
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
          effectiveOutDir,
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
    impositionMode,
    isBatch,
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
    total,
    processDir,
    deimpIndex,
    convertLayoutW,
    convertLayoutH,
    convertLayoutEm,
  ]);

  // バッチ実行
  const handleExecuteBatch = useCallback(async () => {
    const batchDir = outDir || (await pickDir());
    if (!batchDir) return; // キャンセル
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
          const outPath = joinPath(batchDir, `${stem}.pdf`);
          const res = await exportImagePdf(
            f.path,
            outPath,
            dpi,
            quality,
            format === "png",
            pages || undefined,
            { layoutW: convertLayoutW, layoutH: convertLayoutH, layoutEm: convertLayoutEm },
          );
          const pageCount =
            resolvePageSpec(pages || "", f.pageCount || 0).length || f.pageCount || 0;
          progress.done.push({ file: f.filename, count: pageCount, pdfPath: outPath });
          if (res.warning) console.warn(res.warning);
        } else if (impositionMode !== "1up") {
          // 面付けモード: サブフォルダにシートごとに出力
          const subDir = joinPath(batchDir, stem);
          const fileTotal = f.pageCount || 0;
          const filePageSpec = resolvePageSpec(pages || "", fileTotal).map((i) => i + 1);
          const filePageSet = new Set(filePageSpec);
          const fileEffective = filePageSpec.length || fileTotal;
          const fileSheets = calcSheets(
            impositionMode,
            fileEffective,
            t("common.imposition_blank_page" as any),
            (n) => t("image.imposition_sheet_front" as any, { n: String(n) }),
            (n) => t("image.imposition_sheet_back" as any, { n: String(n) }),
          );
          const modeInfo = IMPOSITION_MODE_DEFS.find((m) => m.id === impositionMode)!;
          const fmt = format === "png" ? "png" : "jpeg";
          const ext = format === "png" ? "png" : "jpg";
          const savedFiles: string[] = [];
          for (let si = 0; si < fileSheets.length; si++) {
            const sheet = fileSheets[si];
            const pageNums = sheet.pages.map((p) => (p === 0 || filePageSet.has(p) ? p : 0));
            const result = await renderImposition({
              path: f.path,
              pageNums,
              cols: modeInfo.cols,
              rows: modeInfo.rows,
              dpi,
              format: fmt,
              quality: fmt === "jpeg" ? quality : undefined,
              gapPx: 0,
            });
            const outName = `${prefix}${impositionMode}_${String(si + 1).padStart(3, "0")}.${ext}`;
            const outPath = joinPath(subDir, outName);
            await invoke("save_base64_image", {
              data: result.image_b64,
              path: outPath,
              sourcePath: f.path,
            });
            savedFiles.push(outPath);
          }
          progress.done.push({ file: f.filename, count: savedFiles.length });
        } else {
          // 1-upモード: サブフォルダに1ページずつ
          const subDir = joinPath(batchDir, stem);
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
    impositionMode,
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
    return (
      <Spinner
        label={
          statusMsg && statusMsg !== ""
            ? statusMsg
            : t("image.processing", { current: String(resolvedPageCount) })
        }
      />
    );

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
          {processDir === "deimpose"
            ? ` (${t("image.est_per_cell" as any)})`
            : impositionMode !== "1up"
              ? ` (${t("image.est_per_sheet" as any)})`
              : ""}
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
                  if (f === "svg") setOutputMode("images"); // SVGは画像PDF非対応
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

          {/* 処理方向: 通常変換/面付け ⇔ 面付け解除/分割 */}
          <div style={s.secLabel}>{t("image.process_dir_label" as any)}</div>
          <div style={s.fmtRow}>
            <button
              onClick={(e) => {
                setProcessDir("normal");
                setStatusMsg("");
                (e.currentTarget as HTMLButtonElement).blur();
              }}
              style={{ ...s.modeBtn, ...(processDir === "normal" ? s.modeBtnOn : {}) }}
            >
              <span style={s.fmtName}>{t("image.process_dir_normal" as any)}</span>
              <span style={s.fmtDesc}>{t("image.process_dir_normal_sub" as any)}</span>
            </button>
            <button
              onClick={(e) => {
                setProcessDir("deimpose");
                // 面付け解除は面付けと排他: 面付けモードを 1up に戻す
                setImpositionMode("1up");
                setStatusMsg("");
                (e.currentTarget as HTMLButtonElement).blur();
              }}
              style={{
                ...s.modeBtn,
                ...(processDir === "deimpose"
                  ? { ...s.modeBtnOn, borderColor: "var(--c-accent2, var(--c-accent))" }
                  : {}),
              }}
            >
              <span style={s.fmtName}>{t("image.process_dir_split" as any)}</span>
              <span style={s.fmtDesc}>{t("image.process_dir_split_sub" as any)}</span>
            </button>
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
                setStatusMsg("");
                (e.currentTarget as HTMLButtonElement).blur();
              }}
              style={{
                ...s.modeBtn,
                ...(outputMode === "pdf" ? s.modeBtnOn : {}),
                ...(format === "svg" ? { opacity: 0.4, cursor: "not-allowed" } : {}),
              }}
            >
              <span style={s.fmtName}>{t("image.mode_pdf")}</span>
              <span style={s.fmtDesc}>{t("image.mode_pdf_sub_1")}</span>
              <span style={s.fmtDesc}>{t("image.mode_pdf_sub_2")}</span>
            </button>
          </div>

          {/* 面付けモード（通常変換時のみ。画像・PDF出力どちらでも利用可） */}
          {processDir === "normal" && format !== "svg" && (
            <>
              <div style={s.secLabel}>{t("image.imposition_section_label" as any)}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {IMPOSITION_MODES_I18N.map((m) => (
                  <button
                    key={m.id}
                    onClick={(e) => {
                      setImpositionMode(m.id);
                      setStatusMsg("");
                      (e.currentTarget as HTMLButtonElement).blur();
                    }}
                    style={{
                      ...s.modeBtn,
                      ...(impositionMode === m.id ? s.modeBtnOn : {}),
                      flexBasis: "calc(50% - 3px)",
                    }}
                  >
                    <span style={s.fmtIcon}>{m.icon}</span>
                    <span style={s.fmtName}>{m.label}</span>
                    <span style={s.fmtDesc}>{m.desc}</span>
                  </button>
                ))}
              </div>
              {impositionMode !== "1up" && (
                <div style={{ fontSize: 11, color: "var(--c-textDim)", marginTop: 2 }}>
                  {(() => {
                    const n = resolvedPageCount || total;
                    const sheetCount = calcSheets(impositionMode, n).length;
                    const pageLabel =
                      n !== total
                        ? t("image.imposition_page_label_filtered" as any, { n: String(n) })
                        : t("image.imposition_page_label_all" as any, { total: String(total) });
                    return impositionMode === "booklet"
                      ? t("image.imposition_sheet_count_booklet" as any, {
                          count: String(sheetCount),
                          pages: pageLabel,
                        })
                      : t("image.imposition_sheet_count" as any, {
                          count: String(sheetCount),
                          pages: String(n),
                        });
                  })()}
                </div>
              )}
            </>
          )}

          {/* 面付け解除モード（分割時） */}
          {processDir === "deimpose" && (
            <>
              <div style={s.secLabel}>{t("image.deimp_section_label" as any)}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {DE_IMPOSITION_MODE_DEFS.map((m, idx) => (
                  <button
                    key={idx}
                    onClick={(e) => {
                      setDeimpIndex(idx);
                      setStatusMsg("");
                      (e.currentTarget as HTMLButtonElement).blur();
                    }}
                    style={{
                      ...s.modeBtn,
                      ...(deimpIndex === idx ? s.modeBtnOn : {}),
                      flexBasis: "calc(50% - 3px)",
                    }}
                  >
                    <span style={s.fmtIcon}>{m.icon}</span>
                    <span style={s.fmtName}>{t(m.labelKey as any)}</span>
                    <span style={s.fmtDesc}>{t(m.descKey as any)}</span>
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "var(--c-textDim)", marginTop: 2 }}>
                {(() => {
                  const def = DE_IMPOSITION_MODE_DEFS[deimpIndex];
                  const n = resolvedPageCount || total;
                  const outCount = n * def.cols * def.rows;
                  return t("image.deimp_page_count" as any, {
                    sheets: String(n),
                    pages: String(outCount),
                  });
                })()}
              </div>
            </>
          )}

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
                  : impositionMode !== "1up"
                    ? `🖼 ${batchFiles!.length}件を${IMPOSITION_MODES_I18N.find((m) => m.id === impositionMode)?.label}で変換`
                    : t("image.execute_batch", { count: String(batchFiles!.length) })
                : outputMode === "pdf"
                  ? t("image.execute_pdf")
                  : t("image.execute", {
                      count: String(
                        impositionMode !== "1up"
                          ? calcSheets(impositionMode, resolvedPageCount || total).length
                          : resolvedPageCount,
                      ),
                    })
              : isBatch
                ? t("common.no_dir_btn")
                : outputMode === "pdf"
                  ? t("image.execute_pdf")
                  : t("common.no_dir_btn")}
          </BtnPrimary>
        </div>

        {/* プレビューエリア */}
        <PreviewPane
          pageKey="image"
          label={
            isBatch
              ? impositionMode !== "1up"
                ? `${batchFiles!.length}件 — ${IMPOSITION_MODES_I18N.find((m) => m.id === impositionMode)?.label}`
                : t("image.target_files", { count: String(batchFiles!.length) })
              : t("common.preview_pages", { count: String(resolvedPageCount) })
          }
        >
          {isBatch ? (
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
                    setPreviewIdx(i);
                    (e.currentTarget as HTMLButtonElement).blur();
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
                              resolvePageSpec(pages || "", f.pageCount || 0).length || f.pageCount,
                            ),
                          })
                        : impositionMode !== "1up"
                          ? (() => {
                              const fEff =
                                resolvePageSpec(pages || "", f.pageCount || 0).length ||
                                f.pageCount ||
                                0;
                              const fSheets = calcSheets(impositionMode, fEff).length;
                              const mInfo = IMPOSITION_MODES_I18N.find(
                                (m) => m.id === impositionMode,
                              )!;
                              return t("image.imposition_batch_mode_sheets" as any, {
                                icon: mInfo.icon,
                                mode: mInfo.label,
                                sheets: String(fSheets),
                              });
                            })()
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
          ) : processDir === "deimpose" ? (
            /* 面付け解除プレビュー: 各入力シートを分割線付きで表示 */
            <DeImpositionPreview
              def={DE_IMPOSITION_MODE_DEFS[deimpIndex]}
              total={total}
              pages={pages}
              thumbs={thumbs}
              pdfInfo={pdfInfo}
            />
          ) : impositionMode !== "1up" ? (
            /* 面付けプレビュー: 合成済みサムネイルを表示 */
            <ImpositionPreview
              impositionMode={impositionMode}
              total={total}
              effectiveTotal={resolvedPageCount || total}
              thumbs={thumbs}
              pdfInfo={pdfInfo}
              pages={pages}
            />
          ) : (
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
          )}
        </PreviewPane>
      </div>
      <LiveRegion message={statusMsg} />
    </div>
  );
}

// ── ImpositionPreview ────────────────────────────────────────────────────────
// サムネイル画像（thumbs配列）を使って面付けシートをプレビュー表示する。
// thumbsはTHUMB_DPIで既にレンダリング済みのbase64文字列配列。
// Canvas合成ではなくCSSのflexboxで並べるだけなので軽量。

function ImpositionPreview({
  impositionMode,
  total,
  effectiveTotal,
  thumbs,
  pdfInfo,
  pages,
}: {
  impositionMode: ImpositionMode;
  total: number;
  effectiveTotal: number;
  thumbs: (string | undefined)[];
  pdfInfo: PdfInfo;
  pages: string;
}) {
  const { t } = useI18n();
  // effectiveTotal: pages指定を反映した実際の対象ページ数
  const sheets = calcSheets(impositionMode, effectiveTotal);
  const modeInfo = {
    ...IMPOSITION_MODE_DEFS.find((m) => m.id === impositionMode)!,
    label: t(IMPOSITION_MODE_DEFS.find((m) => m.id === impositionMode)!.labelKey as any),
  };
  const pageSet = new Set(resolvePageSpec(pages || "", total).map((i) => i + 1));

  // 1枚のサムネイル表示サイズ
  const thumbW = modeInfo.cols === 1 ? 200 : 130;

  return (
    <div style={{ padding: 10, overflowY: "auto", width: "100%" }}>
      <div style={{ fontSize: 11, color: "var(--c-textSub)", marginBottom: 8 }}>
        {t("image.imposition_preview_header" as any, {
          icon: modeInfo.icon,
          mode: modeInfo.label,
          sheets: String(sheets.length),
        })}
        {effectiveTotal !== total && (
          <span style={{ marginLeft: 4, color: "var(--c-textDim)" }}>
            {t("image.imposition_preview_filtered" as any, { n: String(effectiveTotal) })}
          </span>
        )}
        {impositionMode === "booklet" && (
          <span style={{ marginLeft: 6, color: "var(--c-textDim)" }}>
            {t("image.imposition_booklet_note" as any)}
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {sheets.map((sheet, si) => (
          <div key={si}>
            <div style={{ fontSize: 10, color: "var(--c-textDim)", marginBottom: 4 }}>
              {sheet.label}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${modeInfo.cols}, ${thumbW}px)`,
                gridTemplateRows: `repeat(${modeInfo.rows}, auto)`,
                gap: 2,
                background: "var(--c-bgCard)",
                border: "1px solid var(--c-border)",
                borderRadius: 4,
                padding: 4,
                position: "relative",
                width: "fit-content",
              }}
            >
              {/* 折り線（2-up/booklet の中央縦線） */}
              {modeInfo.cols >= 2 && modeInfo.rows === 1 && (
                <div
                  style={{
                    position: "absolute",
                    left: "50%",
                    top: 4,
                    bottom: 4,
                    width: 0,
                    borderLeft: "1px dashed rgba(100,100,100,0.4)",
                    zIndex: 1,
                    pointerEvents: "none",
                  }}
                />
              )}
              {Array.from({ length: modeInfo.cols * modeInfo.rows }, (_, ci) => {
                const pageNo = sheet.pages[ci] ?? 0;
                const inRange = pageNo > 0 && pageSet.has(pageNo);
                const b64 = pageNo > 0 ? thumbs[pageNo - 1] : undefined;
                const pb = pageNo > 0 ? pdfInfo.pages?.[pageNo - 1] : undefined;
                const aspect = pb ? pb.w / pb.h : 1 / 1.414;
                const thumbH = Math.round(thumbW / aspect);
                return (
                  <div
                    key={ci}
                    style={{
                      width: thumbW,
                      height: thumbH,
                      background: pageNo === 0 ? "#f0f0f0" : "white",
                      border: `1px solid ${inRange ? "var(--c-accentBd)" : "var(--c-border)"}`,
                      borderRadius: 2,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      position: "relative",
                      overflow: "hidden",
                    }}
                  >
                    {b64 ? (
                      <img
                        src={`data:image/jpeg;base64,${b64}`}
                        style={{ width: "100%", height: "100%", objectFit: "contain" }}
                        alt={`p${pageNo}`}
                      />
                    ) : (
                      <span style={{ fontSize: 10, color: "#aaa" }}>
                        {pageNo === 0 ? "空白" : "…"}
                      </span>
                    )}
                    {/* ページ番号バッジ */}
                    {pageNo > 0 && (
                      <span
                        style={{
                          position: "absolute",
                          bottom: 2,
                          right: 3,
                          fontSize: 9,
                          color: "rgba(0,0,0,0.45)",
                          background: "rgba(255,255,255,0.7)",
                          borderRadius: 2,
                          padding: "0 2px",
                        }}
                      >
                        {pageNo}
                      </span>
                    )}
                    {/* 対象外ページはグレーアウト */}
                    {pageNo > 0 && !inRange && (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          background: "rgba(0,0,0,0.25)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <span style={{ fontSize: 9, color: "white" }}>対象外</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── DeImpositionPreview ──────────────────────────────────────────────────────
// 面付け解除のプレビュー。各入力シート（A3など）のサムネイルに、
// 分割線（cols×rows）を重ねて、どのように分割されるかを示す。
function DeImpositionPreview({
  def,
  total,
  pages,
  thumbs,
  pdfInfo,
}: {
  def: {
    id: DeImpositionMode;
    cols: number;
    rows: number;
    labelKey: string;
    descKey: string;
    icon: string;
  };
  total: number;
  pages: string;
  thumbs: (string | undefined)[];
  pdfInfo: PdfInfo;
}) {
  const { t } = useI18n();
  const targetIdx = resolvePageSpec(pages || "", total); // 0始まり
  const sheetIdx = targetIdx.length ? targetIdx : Array.from({ length: total }, (_, i) => i);
  const outCount = sheetIdx.length * def.cols * def.rows;

  // 出力ページ番号の逆引きマップを作る:
  // calcSplitCells は出力順に並んだセル割り当てを返す。
  // 配列インデックス+1 が「そのセルが出力で第何ページになるか」。
  // キー: 論理シート番号(1始まり)・row・col → 出力ページ番号
  const cellToOutPage = useMemo(() => {
    const cells = calcSplitCells(sheetIdx.length, def.cols, def.rows, def.id);
    const map = new Map<string, number>();
    cells.forEach((c, idx) => {
      map.set(`${c.page}:${c.row}:${c.col}`, idx + 1);
    });
    return map;
  }, [sheetIdx.length, def.cols, def.rows, def.id]);

  return (
    <div style={{ padding: 10, overflowY: "auto", width: "100%" }}>
      <div style={{ fontSize: 11, color: "var(--c-textSub)", marginBottom: 8 }}>
        {def.icon} {t(def.labelKey as any)} —{" "}
        {t("image.deimp_page_count" as any, {
          sheets: String(sheetIdx.length),
          pages: String(outCount),
        })}
      </div>
      {/* 凡例: セル内の数字が出力ページ番号であることを明示 */}
      <div
        style={{ fontSize: 10, color: "var(--c-textDim)", marginBottom: 8, textAlign: "center" }}
      >
        {t("image.deimp_cell_legend" as any)}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, justifyContent: "center" }}>
        {sheetIdx.map((i, logicalIdx) => {
          const pb = pdfInfo.pages?.[i];
          const aspect = pb ? pb.w / pb.h : 1.414;
          const thumbW = 180;
          const thumbH = thumbW / aspect;
          const logicalSheet = logicalIdx + 1; // calcSplitCells の page は1始まり論理番号

          // 各列の番号を、指定 row について取得する
          const numbersForRow = (row: number) =>
            Array.from({ length: def.cols }, (_, col) =>
              cellToOutPage.get(`${logicalSheet}:${row}:${col}`),
            );
          // ページ番号バッジの行（画像の外側に置く）
          const numberBar = (row: number) => (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${def.cols}, 1fr)`,
                width: thumbW,
                gap: 0,
              }}
            >
              {numbersForRow(row).map((outPage, col) => (
                <div key={col} style={{ textAlign: "center" }}>
                  <span style={s.deimpPageBadge}>
                    {t("image.deimp_cell_prefix" as any)}
                    {outPage ?? "—"}
                  </span>
                </div>
              ))}
            </div>
          );

          return (
            <div
              key={i}
              style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}
            >
              {/* 上側のページ番号（row 0） */}
              {numberBar(0)}

              <div style={{ position: "relative", width: thumbW }}>
                {thumbs[i] ? (
                  <img
                    src={`data:image/jpeg;base64,${thumbs[i]}`}
                    style={{
                      width: thumbW,
                      height: thumbH,
                      borderRadius: 4,
                      display: "block",
                      border: "1px solid var(--c-border)",
                    }}
                    alt=""
                  />
                ) : (
                  <div
                    style={{
                      width: thumbW,
                      height: thumbH,
                      background: "var(--c-border)",
                      borderRadius: 4,
                    }}
                  />
                )}
                {/* 分割線オーバーレイ（区切りのみ。番号は外側に配置） */}
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "grid",
                    gridTemplateColumns: `repeat(${def.cols}, 1fr)`,
                    gridTemplateRows: `repeat(${def.rows}, 1fr)`,
                    pointerEvents: "none",
                  }}
                >
                  {Array.from({ length: def.cols * def.rows }).map((_, k) => (
                    <div
                      key={k}
                      style={{
                        border: "1px dashed var(--c-accent, #e0457b)",
                        boxSizing: "border-box",
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* 下側のページ番号（rows>1 のときのみ、最終 row） */}
              {def.rows > 1 && numberBar(def.rows - 1)}

              <div style={{ textAlign: "center", fontSize: 11, color: "var(--c-textSub)" }}>
                {t("common.page_n" as any, { n: String(i + 1) })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  deimpPageBadge: {
    display: "inline-block",
    minWidth: 28,
    padding: "2px 8px",
    borderRadius: 10,
    background: "var(--c-accent, #e0457b)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 700,
    lineHeight: 1.4,
  },
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
