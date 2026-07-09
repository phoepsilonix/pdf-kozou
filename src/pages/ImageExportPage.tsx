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
  getPdfInfo,
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
import { announceValueChange } from "../lib/announce";
import { FS } from "../lib/typography";
import { useSaveDialog } from "../hooks/useSaveDialog";
import {
  type ImpositionMode,
  IMPOSITION_MODE_DEFS,
  IMPOSITION_MODES,
  calcSheets,
  type DeImpositionMode,
  DE_IMPOSITION_MODE_DEFS,
  calcBookletSheets,
  calcSplitCells,
} from "../lib/imposition";
import {
  renderImposition,
  rasterizeImposition,
  splitImpositionPdf,
  splitCellRender,
  isMobile,
} from "../lib/tauri";
import { PreviewPane } from "../components/PreviewPane";
import { usePreview } from "../hooks/usePreview";
import { useViewport } from "../hooks/useViewport";
import { useSectionToggle } from "../hooks/useSectionToggle";
import { FixedMobileNav } from "../components/FixedMobileNav";
import {
  buildMobileOutputSubfolder,
  mobileOutputPreviewLabel,
  commitSavedBatch,
  type MobileSavedFileInfo,
} from "../lib/mobileOutput";

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
  // pdfPath: PDF 1ファイルとして保存した場合の出力パス
  // savedFiles: 画像分割など複数ファイルに出力した場合の全保存パス一覧
  done: { file: string; count: number; pdfPath?: string; savedFiles?: string[] }[];
  errors: { file: string; msg: string }[];
}

function buildOpToken({
  processDir,
  impositionMode,
  outputMode,
  deimpIndex,
  t,
}: {
  processDir: string;
  impositionMode: string;
  outputMode: string;
  deimpIndex: number;
  t: any;
}) {
  const opTokenKey =
    processDir === "deimpose"
      ? "deimposed"
      : impositionMode === "1up"
        ? "rasterized"
        : impositionMode;

  const modePrefixMap: Record<string, string> = {
    "image.deimp_2up": "2up",
    "image.deimp_4up": "4up",
    "image.deimp_booklet": "booklet",
    "image.deimp_booklet_rtl": "booklet-rtl",
  };

  // deimpose 以外
  if (opTokenKey !== "deimposed") {
    if (impositionMode !== "1up" && outputMode === "pdf") {
      return t("filename.label.rasterized") + "_" + t(`filename.label.${opTokenKey}`);
    }
    if (impositionMode === "1up" && outputMode !== "pdf") {
      return "";
    }
    // booklet-rtl は filename.label.booklet-rtl を参照
    return t(`filename.label.${opTokenKey}`);
  }

  // deimpose の場合
  const def = DE_IMPOSITION_MODE_DEFS[deimpIndex];
  const prefix = modePrefixMap[def.labelKey] ?? "booklet";
  return t(`filename.label.${prefix}`) + "_" + t(`filename.label.${opTokenKey}`);
}

export function ImageExportPage({ filePath, pdfInfo, batchFiles }: Props) {
  const { setError, convertLayoutW, convertLayoutH, convertLayoutEm } = usePdfStore();
  const { announceScreen, announceSuccess, announceError, announceKey } = useA11y();
  const { t } = useI18n();
  const { pickSave, commitSave } = useSaveDialog();
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
  const { isNarrow } = useViewport();
  const settingsTopRef = useRef<HTMLDivElement>(null);
  const previewTopRef = useRef<HTMLDivElement>(null);
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const { showingB: showingPreview, toggle: toggleSection } = useSectionToggle(
    bodyScrollRef,
    previewTopRef,
  );
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
  // 出力ファイル名の中間ラベル（初期値はモードの操作トークン。空可・自由入力可）
  const [label, setLabel] = useState("");
  // ユーザーがラベルを手動編集したか（編集後はモード/言語切替で上書きしない）
  const [labelEdited, setLabelEdited] = useState(false);
  // 先頭に元ファイル名を付けるか（単体・手動処理での衝突回避と追跡用。初期ON）
  const [keepOriginalName, setKeepOriginalName] = useState(true);
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

  // 入力ファイルのステム（拡張子なし）
  const srcStem = useMemo(
    () =>
      filePath
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.[^/.]+$/, "") || "output",
    [filePath],
  );

  // ── モバイル (Android) 向けバッチ出力: フォルダピッカーが無いため、
  // 決め打ちのサブフォルダ名を「保存先プレビュー」として表示し、
  // 実行後に同じ名前で MediaStore の Downloads へコピーする ──
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    isMobile()
      .then(setMobile)
      .catch(() => setMobile(false));
  }, []);
  const mobileRelativeDir = useMemo(() => {
    const label =
      batchFiles && batchFiles.length > 0
        ? batchFiles.length === 1
          ? batchFiles[0].filename.replace(/\.[^/.]+$/, "")
          : `${batchFiles.length}件`
        : srcStem;
    return buildMobileOutputSubfolder(label);
    // batchFiles/srcStem の参照が変わるたびに再生成すると保存のたびに違う
    // フォルダ名になってしまうため、識別に必要な情報のみを依存にする。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchFiles?.length, batchFiles?.[0]?.filename, srcStem]);
  const [mobileSavedFiles, setMobileSavedFiles] = useState<MobileSavedFileInfo[] | null>(null);
  const [mobileSaveError, setMobileSaveError] = useState<string | null>(null);


  // 現在のモードに対応するファイル名トークンのキー
  const opTokenKey = useMemo(() => {
    if (processDir === "deimpose") return "deimposed";
    return impositionMode === "1up" ? "rasterized" : impositionMode; // 2up/4up/booklet
  }, [processDir, impositionMode]);

  // ローカライズ済みトークン（例: 画像化 / 2面 / 中綴じ / 面付け解除）
  /*
  let opTokenTmp;
  if (opTokenKey !== "deimposed") {
    if (impositionMode !== "1up" && outputMode === "pdf") {
      opTokenTmp = t(`filename.label.rasterized`) + "_" + t(`filename.label.${opTokenKey}` as any);
    } else if (impositionMode === "1up" && outputMode !== "pdf") {
      opTokenTmp = "";
    } else {
      opTokenTmp = t(`filename.label.${opTokenKey}` as any);
    }
  } else {
    const def = DE_IMPOSITION_MODE_DEFS[deimpIndex];
    if (def.id === "sequential") {
      if (def.labelKey === "image.deimp_2up") {
        opTokenTmp = t("filename.label.2up") + "_" + t(`filename.label.${opTokenKey}` as any);
      } else if (def.labelKey === "image.deimp_4up") {
        opTokenTmp = t("filename.label.4up") + "_" + t(`filename.label.${opTokenKey}` as any);
      }
    } else {
      opTokenTmp = t("filename.label.booklet") + "_" + t(`filename.label.${opTokenKey}` as any);
    }
  }
  const opToken = opTokenTmp;*/
  const opToken = buildOpToken({
    processDir,
    impositionMode,
    outputMode,
    deimpIndex,
    t,
  });

  // 実効ラベルはレンダリング中に派生させる（state同期のeffectを使わない）。
  // 未編集ならモード/言語に追従した opToken、編集済みなら手入力値 label。
  // こうすることで impositionMode 切替と同じレンダリングで必ず一致し、
  // 切替直後の即実行でも n-up/中綴じ等のトークンが取りこぼされない。
  const effectiveLabel = labelEdited ? label : opToken;

  // 出力名のベース部分を組み立てる。
  //   keep=元名を付ける / effectiveLabel=中間ラベル。例: 写真_2面 / 2面
  const composeBase = useCallback(
    (stem: string, keep: boolean): string => {
      const parts: string[] = [];
      if (keep && stem) parts.push(stem);
      if (effectiveLabel) parts.push(effectiveLabel);
      return parts.join("_");
    },
    [effectiveLabel],
  );
  // 画像1枚分のファイル名（連番3桁）。ベースが空なら page で補完。
  const imageName = useCallback(
    (stem: string, keep: boolean, seq: number, ext: string): string =>
      `${composeBase(stem, keep) || "page"}_${String(seq).padStart(3, "0")}.${ext}`,
    [composeBase],
  );
  // exportImages 用プレフィックス（バックエンドが連番を後置するため末尾に "_"）
  const imagePrefix = useCallback(
    (stem: string, keep: boolean): string => `${composeBase(stem, keep) || "page"}_`,
    [composeBase],
  );
  // PDF1ファイルのファイル名。ベースが空なら output で補完。
  const composePdfName = useCallback(
    (stem: string, keep: boolean): string => `${composeBase(stem, keep) || "output"}.pdf`,
    [composeBase],
  );

  // ライブプレビュー（設定画面に表示する出力名の例）
  const namePreview = useMemo(() => {
    const ext = format === "jpeg" ? "jpg" : format;
    if (outputMode === "pdf") {
      // バッチPDFはフラット出力のため常に元名付き
      return composePdfName(srcStem, isBatch ? true : keepOriginalName);
    }
    if (isBatch) {
      // バッチ画像はサブフォルダ {元名}/ 配下に元名OFF形で出力
      return `${srcStem}/${imageName(srcStem, false, 1, ext)}`;
    }
    return imageName(srcStem, keepOriginalName, 1, ext);
  }, [format, outputMode, isBatch, srcStem, keepOriginalName, composePdfName, imageName]);

  // 衝突チェック（単体PDF出力時のみ）。
  // バッチPDFは出力名に _画像化 / _rasterized サフィックスが必ず付くため、
  // 入力フォルダと同じ場所へ出力しても元ファイルと衝突せず、チェック対象外とする。
  useEffect(() => {
    const checkConflict = async () => {
      if (outputMode !== "pdf" || !outDir || isBatch) {
        setConflictPaths([]);
        return;
      }

      try {
        const conflicts = await checkPathConflict({
          inputPath: filePath, // ← input_path → inputPath
          outDir: outDir, // ← out_dir → outDir
          pdfName: pdfName || undefined,
          isBatch: false, // ← is_batch → isBatch
          batchFiles: null, // ← batch_files → batchFiles
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
  // 選択中バッチファイルの詳細プレビュー(単体と同じ面付け/面付け解除の
  // 合成プレビューを見せるために必要な、全ページのサムネイルとPdfInfo)。
  const [batchPreviewInfo, setBatchPreviewInfo] = useState<PdfInfo | null>(null);
  const [batchPreviewThumbs, setBatchPreviewThumbs] = useState<(string | undefined)[]>([]);
  // ファイル一覧側の表紙サムネイルは、ファイル数が多いバッチだと生成に
  // 時間がかかりメモリも食うため、先頭 BATCH_LIST_THUMB_LIMIT 件までに
  // 限定する（それ以降はプレースホルダーのまま。選択すれば下の詳細
  // プレビューで全ページを確認できるので実用上困らない）。
  const BATCH_LIST_THUMB_LIMIT = 40;

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

  // バッチ: ファイル一覧の表紙サムネイル（先頭ページのみ・件数上限あり）
  useEffect(() => {
    if (!isBatch || !batchFiles) return;
    if (!previewEnabled) {
      setBatchThumbs([]);
      return;
    }
    let cancelled = false;
    setBatchThumbs(new Array(batchFiles.length).fill(undefined));
    (async () => {
      const limit = Math.min(batchFiles.length, BATCH_LIST_THUMB_LIMIT);
      for (let i = 0; i < limit; i++) {
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

  // バッチ: 選択中ファイルの詳細プレビュー（単体と同じ面付け/面付け解除の
  // 合成プレビュー用に、選択ファイルの PdfInfo と全ページサムネイルを取得）。
  // previewIdx の切り替え・レイアウト設定(禁則/文字送り等)の変更に追従する。
  // 面付け/製本モードそのものの切り替えはクライアント側の合成表示なので
  // ここでの再取得は不要（単体プレビューと同じ仕組み）。
  useEffect(() => {
    if (!isBatch || !batchFiles || !batchFiles[previewIdx]) return;
    if (!previewEnabled) {
      setBatchPreviewInfo(null);
      setBatchPreviewThumbs([]);
      return;
    }
    let cancelled = false;
    const f = batchFiles[previewIdx];
    setBatchPreviewInfo(null);
    setBatchPreviewThumbs([]);
    (async () => {
      try {
        const info = await getPdfInfo(f.path);
        if (cancelled) return;
        setBatchPreviewInfo(info);
        setBatchPreviewThumbs(new Array(info.page_count).fill(undefined));
        for (let i = 0; i < info.page_count; i++) {
          if (cancelled) return;
          try {
            const b64 = await renderPage(f.path, i, THUMB_DPI, {
              layoutW: convertLayoutW,
              layoutH: convertLayoutH,
              layoutEm: convertLayoutEm,
            });
            if (cancelled) return;
            setBatchPreviewThumbs((p) => {
              const a = [...p];
              a[i] = b64;
              return a;
            });
          } catch {}
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isBatch,
    batchFiles,
    previewIdx,
    previewEnabled,
    convertLayoutW,
    convertLayoutH,
    convertLayoutEm,
  ]);

  const pickDir = useCallback(async (): Promise<string | null> => {
    const dir = await invoke<string | null>("pick_output_dir").catch(() => null);
    if (dir) setOutDir(dir);
    return dir;
  }, []);

  // Android: 一時ディレクトリに書き出した結果を「ダウンロード」フォルダ
  // 配下へコピーする。プレビュー表示に使った mobileRelativeDir と同じ
  // 名前を使うことで、実行前後の表示を一致させる。
  const finalizeMobileOutput = useCallback(
    async (dir: string) => {
      if (!mobile) return;
      try {
        const saved = await commitSavedBatch(dir, mobileRelativeDir);
        setMobileSavedFiles(saved);
      } catch (e) {
        setMobileSaveError(String(e));
      }
    },
    [mobile, mobileRelativeDir],
  );

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
    setMobileSavedFiles(null);
    setMobileSaveError(null);
    // ── 面付け解除（split / de-imposition）: A3見開きなどを分割 ──
    if (processDir === "deimpose") {
      const def = DE_IMPOSITION_MODE_DEFS[deimpIndex];

      // 入力（A3等）シートの枚数 = 対象ページ数
      const pageSpec = resolvePageSpec(pages || "", total); // 0始まり
      let sheetPageNums = (
        pageSpec.length ? pageSpec : Array.from({ length: total }, (_, i) => i)
      ).map((i) => i + 1); // 1始まり

      // calcSplitCells 内で total を4の倍数に切り上げるため、
      // 手動での 1ページ補完は不要（以前は必要だったが修正済み）。

      const sheetCount = sheetPageNums.length;
      if (sheetCount === 0) {
        setStatusMsg(t("image.deimp_no_pages" as any));
        return;
      }

      // calcSplitCells はシート番号1..sheetCount で計算する
      const cellsLogical = calcSplitCells(sheetCount, def.cols, def.rows, def.id);

      // logical sheet番号(1..sheetCount) → 実ページ番号
      const cells: [number, number, number][] = cellsLogical.map((c) => [
        sheetPageNums[c.page - 1] ?? 0, // ← ここも安全に0フォールバック
        c.row,
        c.col,
      ]);

      if (outputMode === "pdf") {
        const outPath = await pickSave(composePdfName(srcStem, keepOriginalName));
        if (!outPath) {
          setPdfName("");
          return;
        }
        const dir = outPath.replace(/[/\\][^/\\]+$/, "");
        if (dir) setOutDir(dir);
        setPhase("processing");
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => setTimeout(resolve, 0));
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
          await commitSave(outPath);
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
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => setTimeout(resolve, 0));
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
          const outName = imageName(srcStem, keepOriginalName, k + 1, ext);
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
        await finalizeMobileOutput(resolvedDir);
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
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => setTimeout(resolve, 0));
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

          // base64 → ファイル保存（ラベルが操作トークンを内包）
          const outName = imageName(srcStem, keepOriginalName, si + 1, ext);
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
        await finalizeMobileOutput(resolvedDir);
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
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      if (outputMode === "pdf") {
        const outPath = await pickSave(composePdfName(srcStem, keepOriginalName));

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
          await commitSave(outPath);
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
        await commitSave(outPath);
        setPdfOutPath(outPath);
        setPdfPageCount(resolvedPageCount);
        setPdfName("");
        if (res.warning) setStatusMsg(res.warning);
        announceSuccess("done.image");
        setPhase("result");
      } else {
        const res = await exportImages(
          filePath,
          effectiveOutDir,
          format,
          dpi,
          format === "jpeg" ? quality : undefined,
          imagePrefix(srcStem, keepOriginalName),
          pages || undefined,
          { layoutW: convertLayoutW, layoutH: convertLayoutH, layoutEm: convertLayoutEm },
        );
        console.log("res", res);
        setImages(res.files);
        await finalizeMobileOutput(effectiveOutDir);
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
    pages,
    resolvedPageCount,
    conflictPaths,
    srcStem,
    keepOriginalName,
    composePdfName,
    imageName,
    imagePrefix,
    pickSave,
    commitSave,
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
  // バッチ実行（面付け解除・面付けPDF・全モード対応版）
  const handleExecuteBatch = useCallback(async () => {
    const batchDir = outDir || (await pickDir());
    if (!batchDir) return; // キャンセル
    if (conflictPaths.length > 0) return;
    setMobileSavedFiles(null);
    setMobileSaveError(null);

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

      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => setTimeout(resolve, 0));

      try {
        const stem = f.filename.replace(/\.[^/.]+$/, "");
        const fileTotal = f.pageCount || 0;
        const filePageSpec = resolvePageSpec(pages || "", fileTotal).map((idx) => idx + 1);
        const filePageSet = new Set(filePageSpec);
        const fileEffective = filePageSpec.length || fileTotal;

        // ── 面付け解除（split / de-imposition）: A3見開きなどを分割 ──
        if (processDir === "deimpose") {
          const def = DE_IMPOSITION_MODE_DEFS[deimpIndex];

          // 入力（A3等）シートの枚数 = 対象ページ数
          const pageSpec = resolvePageSpec(pages || "", total); // 0始まり
          let sheetPageNums = (
            pageSpec.length ? pageSpec : Array.from({ length: total }, (_, i) => i)
          ).map((i) => i + 1); // 1始まり

          // calcSplitCells 内で total を4の倍数に切り上げるため、
          // 手動での 1ページ補完は不要（以前は必要だったが修正済み）。

          const sheetCount = sheetPageNums.length;
          if (sheetCount === 0) {
            setStatusMsg(t("image.deimp_no_pages" as any));
            return;
          }

          // calcSplitCells はシート番号1..sheetCount で計算する
          const cellsLogical = calcSplitCells(sheetCount, def.cols, def.rows, def.id);

          // logical sheet番号(1..sheetCount) → 実ページ番号
          const cells: [number, number, number][] = cellsLogical.map((c) => [
            sheetPageNums[c.page - 1] ?? 0, // ← ここも安全に0フォールバック
            c.row,
            c.col,
          ]);

          if (outputMode === "pdf") {
            // PDF出力（1ファイル）
            const outPath = joinPath(batchDir, composePdfName(stem, true));
            await splitImpositionPdf({
              input: f.path,
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
            progress.done.push({ file: f.filename, count: cells.length, pdfPath: outPath });
          } else {
            // 画像出力（セルごとに分割）
            const subDir = joinPath(batchDir, stem);
            const ext = format === "png" ? "png" : format === "svg" ? "svg" : "jpg";
            const savedFiles: string[] = [];

            for (let k = 0; k < cells.length; k++) {
              const [pg, row, col] = cells[k];
              const res = await splitCellRender({
                input: f.path,
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

              const outName = imageName(stem, false, k + 1, ext);
              const outPath = joinPath(subDir, outName);
              await invoke("save_base64_image", {
                data: res.data_b64,
                path: outPath,
                sourcePath: format === "svg" ? undefined : f.path,
              });
              savedFiles.push(outPath);
            }
            progress.done.push({
              file: f.filename,
              count: savedFiles.length,
              savedFiles,
            });
          }
        }
        // ==================== 通常モード（面付け含む） ====================
        else if (outputMode === "pdf") {
          const outPath = joinPath(batchDir, composePdfName(stem, true));

          if (impositionMode !== "1up") {
            // 面付けPDF（rasterizeImposition）
            const modeInfo = IMPOSITION_MODES_I18N.find((m) => m.id === impositionMode)!;
            const sheets = calcSheets(
              impositionMode,
              fileEffective,
              t("common.imposition_blank_page" as any),
              (n) => t("image.imposition_sheet_front" as any, { n: String(n) }),
              (n) => t("image.imposition_sheet_back" as any, { n: String(n) }),
            );
            const cells = modeInfo.cols * modeInfo.rows;
            const hasPageFilter = filePageSpec.length > 0;
            const sheetPages: number[] = [];

            for (const sheet of sheets) {
              for (let c = 0; c < cells; c++) {
                const p = sheet.pages[c] ?? 0;
                sheetPages.push(p !== 0 && hasPageFilter && !filePageSet.has(p) ? 0 : p);
              }
            }

            await rasterizeImposition({
              input: f.path,
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
            progress.done.push({ file: f.filename, count: sheets.length, pdfPath: outPath });
          } else {
            // 1up PDF
            const res = await exportImagePdf(
              f.path,
              outPath,
              dpi,
              quality,
              format === "png",
              pages || undefined,
              { layoutW: convertLayoutW, layoutH: convertLayoutH, layoutEm: convertLayoutEm },
            );
            const pageCount = filePageSpec.length || fileTotal;
            progress.done.push({ file: f.filename, count: pageCount, pdfPath: outPath });
            if (res.warning) console.warn(res.warning);
          }
        } else if (impositionMode !== "1up") {
          // 面付け画像（既存ロジックを維持）
          const subDir = joinPath(batchDir, stem);
          const modeInfo = IMPOSITION_MODE_DEFS.find((m) => m.id === impositionMode)!;
          const fmt = format === "png" ? "png" : "jpeg";
          const ext = format === "png" ? "png" : "jpg";
          const sheets = calcSheets(
            impositionMode,
            fileEffective,
            t("common.imposition_blank_page" as any),
            (n) => t("image.imposition_sheet_front" as any, { n: String(n) }),
            (n) => t("image.imposition_sheet_back" as any, { n: String(n) }),
          );
          const savedFiles: string[] = [];

          for (let si = 0; si < sheets.length; si++) {
            const sheet = sheets[si];
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

            const outName = imageName(stem, false, si + 1, ext);
            const outPath = joinPath(subDir, outName);
            await invoke("save_base64_image", {
              data: result.image_b64,
              path: outPath,
              sourcePath: f.path,
            });
            savedFiles.push(outPath);
          }
          progress.done.push({ file: f.filename, count: savedFiles.length, savedFiles });
        } else {
          // 1-up 画像（既存）
          const subDir = joinPath(batchDir, stem);
          const res = await exportImages(
            f.path,
            subDir,
            format,
            dpi,
            format === "jpeg" ? quality : undefined,
            imagePrefix(stem, false),
            pages || undefined,
            { layoutW: convertLayoutW, layoutH: convertLayoutH, layoutEm: convertLayoutEm },
          );
          progress.done.push({ file: f.filename, count: res.files.length, savedFiles: res.files });
        }
      } catch (e) {
        progress.errors.push({ file: f.filename, msg: String(e) });
        console.error(`Batch error on ${f.filename}:`, e);
      }

      setBatchProgress({ ...progress });
    }

    // Android: 一時ディレクトリに書き出した結果を、ユーザーから見える
    // 「ダウンロード」フォルダ配下へコピーする。ピッカーを使っていない
    // ため、実行前プレビューと同じ mobileRelativeDir をそのまま使う。
    if (mobile) {
      try {
        const saved = await commitSavedBatch(batchDir, mobileRelativeDir);
        setMobileSavedFiles(saved);
      } catch (e) {
        setMobileSaveError(String(e));
      }
    }

    announceSuccess("done.image");
    setPhase("result");
  }, [
    batchFiles,
    outDir,
    outputMode,
    impositionMode,
    processDir,
    deimpIndex,
    format,
    dpi,
    quality,
    pages,
    conflictPaths,
    composePdfName,
    imageName,
    imagePrefix,
    pickDir,
    announceSuccess,
    t,
    convertLayoutW,
    convertLayoutH,
    convertLayoutEm,
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
                <span style={s.bpFile}>{d.file} → </span>
                {d.pdfPath ? (
                  <>
                    <span style={s.bpMeta}>{d.pdfPath.split(/[\/\\]/).pop() ?? ""}</span>
                    <span style={s.bpCount}>
                      {t("image.pages_count", { count: String(d.count) })}
                    </span>
                  </>
                ) : d.savedFiles && d.savedFiles.length > 0 ? (
                  <>
                    <span style={s.bpMeta}>{d.savedFiles[0].split(/[\/\\]/).pop() ?? ""}</span>
                    <span style={s.bpCount}>
                      {t("image.images_total", { count: String(d.savedFiles.length) })}
                    </span>
                  </>
                ) : (
                  <span style={s.bpCount}>
                    {t("image.pages_count", { count: String(d.count) })}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
        <Spinner />
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
          {mobile ? (
            <div style={{ fontSize: FS.small, color: "var(--c-textSub)" }}>
              {mobileSaveError ? (
                <span style={{ color: "var(--c-err)" }}>
                  {t("mobile.save_unsupported" as any)}
                </span>
              ) : mobileSavedFiles ? (
                <>
                  <div>
                    {t("mobile.save_done_summary" as any, {
                      count: String(mobileSavedFiles.length),
                    })}
                  </div>
                  <div>
                    {t("mobile.save_location" as any, {
                      path: mobileOutputPreviewLabel(mobileRelativeDir),
                    })}
                  </div>
                </>
              ) : (
                t("mobile.save_preview_pending" as any)
              )}
            </div>
          ) : (
            <div style={{ fontSize: FS.small, color: "var(--c-textSub)" }}>{outDir}</div>
          )}
          <div style={s.bpLog}>
            {batchProgress.done.map((d, i) => (
              <div key={i} style={s.bpRow}>
                <span style={{ color: "var(--c-accent)" }}>✓</span>
                <span style={s.bpFile}>{d.file} → </span>
                {d.pdfPath ? (
                  <>
                    <span style={s.bpMeta}>{d.pdfPath.split(/[\/\\]/).pop() ?? ""}</span>
                    <span style={s.bpCount}>
                      {t("image.pages_count", { count: String(d.count) })}
                    </span>
                  </>
                ) : d.savedFiles && d.savedFiles.length > 0 ? (
                  <>
                    <span style={s.bpMeta}>{d.savedFiles[0].split(/[\/\\]/).pop() ?? ""}</span>
                    <span style={s.bpCount}>
                      {t("image.images_total", { count: String(d.savedFiles.length) })}
                    </span>
                  </>
                ) : (
                  <span style={s.bpCount}>
                    {t("image.pages_count", { count: String(d.count) })}
                  </span>
                )}
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
              <div style={{ fontSize: FS.small, color: "var(--c-textSub)" }}>{pdfOutPath}</div>
              {statusMsg && (
                <div
                  style={{
                    fontSize: FS.small,
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
              {mobile ? (
                <div style={{ fontSize: FS.small, color: "var(--c-textSub)" }}>
                  {mobileSaveError ? (
                    <span style={{ color: "var(--c-err)" }}>
                      {t("mobile.save_unsupported" as any)}
                    </span>
                  ) : mobileSavedFiles ? (
                    <>
                      <div>
                        {t("mobile.save_done_summary" as any, {
                          count: String(mobileSavedFiles.length),
                        })}
                      </div>
                      <div>
                        {t("mobile.save_location" as any, {
                          path: mobileOutputPreviewLabel(mobileRelativeDir),
                        })}
                      </div>
                    </>
                  ) : (
                    t("mobile.save_preview_pending" as any)
                  )}
                </div>
              ) : (
                <div style={{ fontSize: FS.small, color: "var(--c-textSub)" }}>{outDir}</div>
              )}
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
                      fontSize: FS.small,
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
  // 狭い画面（スマホ / 縦長に狭めたPCウィンドウ）では設定とプレビューを縦積みにする。
  //
  // 【重要】panel/previewWrap は flex-shrink: 0 を明示すること。
  // 既定値(flex-shrink:1)のままだと、column方向のflexコンテナ(body)の
  // 可視領域に収まるよう両方が圧縮され、「設定とプレビューが重なって見える」
  // 「領域がほとんど確保できない」といった崩れ方をする。overflowY:auto で
  // スクロールさせたいので、各ブロックは常に自然な高さのまま確保する。
  const bodyStyle: React.CSSProperties = isNarrow
    ? {
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        minHeight: 0,
        paddingBottom: 56,
      }
    : s.body;
  const panelStyle: React.CSSProperties = isNarrow
    ? { display: "flex", flexDirection: "column", flexShrink: 0, minHeight: 0 }
    : s.panel;
  const panelScrollStyle: React.CSSProperties = isNarrow
    ? { padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }
    : s.panelScroll;
  const actionBarStyle: React.CSSProperties = isNarrow
    ? { ...s.actionBar, position: "sticky", bottom: 0, flexShrink: 0 }
    : s.actionBar;
  const previewWrapStyle: React.CSSProperties = isNarrow
    ? { flexShrink: 0 }
    : { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" };

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

      <div style={bodyStyle} ref={bodyScrollRef}>
        {/* 設定パネル */}
        <div style={panelStyle} ref={settingsTopRef}>
          <div style={panelScrollStyle}>
            <div style={s.secLabel}>フォーマット</div>
            <div style={s.fmtRow}>
              {(["jpeg", "png", "svg"] as const).map((f) => (
                <button
                  key={f}
                  aria-label={f.toUpperCase()}
                  aria-pressed={format === f}
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
                aria-label={t("image.process_dir_normal" as any)}
                aria-pressed={processDir === "normal"}
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
                aria-label={t("image.process_dir_split" as any)}
                aria-pressed={processDir === "deimpose"}
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
                aria-label={t("image.mode_images")}
                aria-pressed={outputMode === "images"}
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
                aria-label={t("image.mode_pdf")}
                aria-pressed={outputMode === "pdf"}
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
                      aria-label={m.label}
                      aria-pressed={impositionMode === m.id}
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
                  <div style={{ fontSize: FS.caption, color: "var(--c-textDim)", marginTop: 2 }}>
                    {(() => {
                      const n = resolvedPageCount || total;
                      const sheetCount = calcSheets(impositionMode, n).length;
                      const pageLabel =
                        n !== total
                          ? t("image.imposition_page_label_filtered" as any, { n: String(n) })
                          : t("image.imposition_page_label_all" as any, { total: String(total) });
                      return impositionMode === "booklet" || impositionMode === "booklet-rtl"
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
                      aria-label={t(m.labelKey as any)}
                      aria-pressed={deimpIndex === idx}
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
                <div style={{ fontSize: FS.caption, color: "var(--c-textDim)", marginTop: 2 }}>
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
                      aria-label={p.label}
                      aria-pressed={dpi === p.val}
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
                  <button
                    style={s.stepBtn}
                    data-voice-skip
                    onClick={() => {
                      const nv = Math.max(36, dpi - 12);
                      setDpi(nv);
                      announceValueChange(t("image.dpi_label"), nv);
                    }}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    style={s.numInput}
                    value={dpi}
                    min={36}
                    max={1200}
                    aria-label={t("image.dpi_label")}
                    onChange={(e) => setDpi(parseInt(e.target.value) || 72)}
                  />
                  <button
                    style={s.stepBtn}
                    data-voice-skip
                    onClick={() => {
                      const nv = Math.min(1200, dpi + 12);
                      setDpi(nv);
                      announceValueChange(t("image.dpi_label"), nv);
                    }}
                  >
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
                  aria-label={t("image.quality_label")}
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

            {/* 出力ファイル名: 元名トグル ＋ ラベル自由入力 ＋ ライブプレビュー */}
            <div style={s.secLabel}>{t("image.outname_label")}</div>
            {!isBatch && (
              <label style={s.keepNameRow}>
                <input
                  type="checkbox"
                  checked={keepOriginalName}
                  onChange={(e) => setKeepOriginalName(e.target.checked)}
                />
                <span>{t("image.outname_keep_original")}</span>
              </label>
            )}
            <div style={s.prefixRow}>
              <input
                type="text"
                style={s.textInput}
                value={effectiveLabel}
                placeholder={opToken}
                aria-label={t("image.outname_label")}
                onChange={(e) => {
                  setLabel(e.target.value);
                  setLabelEdited(true);
                }}
              />
            </div>
            <div style={s.namePreview} title={namePreview}>
              {t("image.outname_preview")} → <span style={s.namePreviewName}>{namePreview}</span>
            </div>

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
                {mobile ? (
                  <div style={s.dirRow}>
                    <div style={s.dirPath} title={mobileOutputPreviewLabel(mobileRelativeDir)}>
                      {t("mobile.save_preview" as any, {
                        path: mobileOutputPreviewLabel(mobileRelativeDir),
                      })}
                    </div>
                  </div>
                ) : (
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
                )}
              </>
            )}
          </div>

          {!isNarrow && (
            <div style={actionBarStyle}>
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
          )}
        </div>

        {/* プレビューエリア */}
        <div style={previewWrapStyle} ref={previewTopRef}>
          <PreviewPane
            pageKey="image"
            label={
              isBatch
                ? `${batchFiles![previewIdx]?.filename ?? ""} — ${
                    impositionMode !== "1up"
                      ? IMPOSITION_MODES_I18N.find((m) => m.id === impositionMode)?.label
                      : t("common.pages", {
                          count: String(
                            batchPreviewInfo?.page_count ?? batchFiles![previewIdx]?.pageCount ?? 0,
                          ),
                        })
                  }`
                : t("common.preview_pages", { count: String(resolvedPageCount) })
            }
          >
            {isBatch ? (
              <div
                style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
              >
                {/* ファイル選択ストリップ（横スクロール・コンパクトな表紙のみ） */}
                <div style={s.batchFileStrip}>
                  {batchFiles!.map((f, i) => {
                    const fEff =
                      resolvePageSpec(pages || "", f.pageCount || 0).length || f.pageCount || 0;
                    const metaText =
                      outputMode === "pdf"
                        ? t("image.result_suffix_pdf", { pages: String(fEff) })
                        : impositionMode !== "1up"
                          ? (() => {
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
                              pages: String(fEff),
                              format: format === "jpeg" ? "JPG" : format.toUpperCase(),
                            });
                    return (
                      <button
                        key={f.id}
                        type="button"
                        style={{
                          ...s.batchFileChip,
                          ...(i === previewIdx ? s.batchFileChipOn : {}),
                          appearance: "none",
                          cursor: "pointer",
                        }}
                        title={`${f.filename} — ${t("common.pages", { count: String(f.pageCount) })} — ${metaText}`}
                        onClick={(e) => {
                          setPreviewIdx(i);
                          (e.currentTarget as HTMLButtonElement).blur();
                        }}
                      >
                        {batchThumbs[i] ? (
                          <img
                            src={`data:image/jpeg;base64,${batchThumbs[i]}`}
                            style={s.batchThumbSmall}
                            alt=""
                          />
                        ) : (
                          <div style={s.batchThumbSmallPh} />
                        )}
                        <span style={s.batchFileChipName}>{f.filename}</span>
                      </button>
                    );
                  })}
                </div>

                {/* 選択中ファイルの詳細プレビュー（単体と同じ合成表示） */}
                <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex" }}>
                  {!batchPreviewInfo ? (
                    <div
                      style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Spinner />
                    </div>
                  ) : processDir === "deimpose" ? (
                    <DeImpositionPreview
                      def={DE_IMPOSITION_MODE_DEFS[deimpIndex]}
                      total={batchPreviewInfo.page_count}
                      pages={pages}
                      thumbs={batchPreviewThumbs}
                      pdfInfo={batchPreviewInfo}
                    />
                  ) : impositionMode !== "1up" ? (
                    <ImpositionPreview
                      impositionMode={impositionMode}
                      total={batchPreviewInfo.page_count}
                      effectiveTotal={
                        resolvePageSpec(pages || "", batchPreviewInfo.page_count).length ||
                        batchPreviewInfo.page_count
                      }
                      thumbs={batchPreviewThumbs}
                      pdfInfo={batchPreviewInfo}
                      pages={pages}
                    />
                  ) : (
                    <div style={s.thumbGrid}>
                      {resolvePageSpec(pages || "", batchPreviewInfo.page_count).map((i) => {
                        const pb = batchPreviewInfo.pages?.[i];
                        const aspect = pb ? pb.w / pb.h : undefined;
                        return (
                          <ThumbCard
                            key={i}
                            b64={batchPreviewThumbs[i]}
                            pageNum={i + 1}
                            width={195}
                            aspectRatio={aspect}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
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
                      width={195}
                      aspectRatio={aspect}
                    />
                  );
                })}
              </div>
            )}
          </PreviewPane>
        </div>
      </div>
      {isNarrow && (
        <FixedMobileNav
          showingSecondSection={showingPreview}
          onToggle={toggleSection}
          toSecondLabel={t("common.jump_to_preview")}
          toFirstLabel={t("common.jump_to_settings")}
        >
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
        </FixedMobileNav>
      )}
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
  const { isNarrow } = useViewport();
  // effectiveTotal: pages指定を反映した実際の対象ページ数
  const sheets = calcSheets(impositionMode, effectiveTotal);
  const modeInfo = {
    ...IMPOSITION_MODE_DEFS.find((m) => m.id === impositionMode)!,
    label: t(IMPOSITION_MODE_DEFS.find((m) => m.id === impositionMode)!.labelKey as any),
  };
  const pageSet = new Set(resolvePageSpec(pages || "", total).map((i) => i + 1));

  // 「1ページあたりの表示サイズ」を基準に固定し、シートサイズを導出する。
  // これにより 1-up / 2-up / 4-up / booklet のどのモードでも
  // 元の1ページが同じ大きさで見え、製本・面付けの状態が直感的に分かる。
  //
  // ページの向きに関わらず「短辺を PAGE_SHORT_SIDE px」に統一:
  //   縦長ページ(h>w): w=PAGE_SHORT_SIDE, h=PAGE_SHORT_SIDE/aspect
  //   横長ページ(w>h): h=PAGE_SHORT_SIDE, w=PAGE_SHORT_SIDE*aspect
  const repPage = pdfInfo.pages?.[0];
  const repAspect = repPage ? repPage.w / repPage.h : 1 / 1.414;
  // 1ページの短辺サイズ。サイズ変更・製本ページの基準(480×330)と同じ
  // 1.5倍スケールに合わせて 120px → 180px に統一。
  // 狭い画面ではサイズ変更・製本ページと同じ比率(0.625倍)で縮小する。
  const PAGE_SHORT_SIDE = isNarrow ? 112 : 180;
  let PAGE_W: number, PAGE_H: number;
  if (repAspect >= 1) {
    // 横長ページ: 高さが短辺
    PAGE_H = PAGE_SHORT_SIDE;
    PAGE_W = Math.round(PAGE_SHORT_SIDE * repAspect);
  } else {
    // 縦長ページ: 幅が短辺
    PAGE_W = PAGE_SHORT_SIDE;
    PAGE_H = Math.round(PAGE_SHORT_SIDE / repAspect);
  }
  const CELL_W = PAGE_W;
  const CELL_H = PAGE_H;

  return (
    <div style={{ padding: 10, overflowY: "auto", overflowX: "auto", width: "100%" }}>
      <div style={{ fontSize: FS.caption, color: "var(--c-textSub)", marginBottom: 8 }}>
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
        {(impositionMode === "booklet" || impositionMode === "booklet-rtl") && (
          <span style={{ marginLeft: 6, color: "var(--c-textDim)" }}>
            {t("image.imposition_booklet_note" as any)}
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {sheets.map((sheet, si) => (
          <div key={si}>
            <div style={{ fontSize: FS.caption, color: "var(--c-textDim)", marginBottom: 4 }}>
              {sheet.label}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${modeInfo.cols}, ${CELL_W}px)`,
                gridTemplateRows: `repeat(${modeInfo.rows}, ${CELL_H}px)`,
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
                return (
                  <div
                    key={ci}
                    style={{
                      width: CELL_W,
                      height: CELL_H,
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
                      <span style={{ fontSize: FS.caption, color: "#aaa" }}>
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
                          fontSize: FS.caption,
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
                        <span style={{ fontSize: FS.caption, color: "white" }}>対象外</span>
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
  const { isNarrow } = useViewport();
  const targetIdx = resolvePageSpec(pages || "", total); // 0始まり
  const sheetIdx = targetIdx.length ? targetIdx : Array.from({ length: total }, (_, i) => i);

  // calcSplitCells 内で total を4の倍数に切り上げるため、
  // 手動での 1ページ補完は不要（以前は必要だったが修正済み）。

  // calcSplitCells の出力セル一覧。
  // 各要素: { page: 論理シート番号(1始まり、0=空白), row, col }
  // 出力ページ番号 = インデックス+1
  const splitCells = useMemo(
    () => calcSplitCells(sheetIdx.length, def.cols, def.rows, def.id),
    [sheetIdx.length, def.cols, def.rows, def.id],
  );
  const outCount = splitCells.length;

  // 代表アスペクト（空白ページのサイズ決定にも使う）
  const repPb = pdfInfo.pages?.[sheetIdx[0]];
  const repAspect = repPb ? repPb.w / repPb.h : 1.414;
  // プレビュー基準サイズ: サイズ変更・製本ページの基準(480×330)に統一。
  // 狭い画面では同ページと同じ比率(0.625倍)で縮小する。
  const MAX_SHEET_H = isNarrow ? 210 : 330;
  const MAX_SHEET_W = isNarrow ? 300 : 480;
  const repThumbW =
    repAspect >= MAX_SHEET_W / MAX_SHEET_H ? MAX_SHEET_W : Math.round(MAX_SHEET_H * repAspect);
  const repThumbH =
    repAspect >= MAX_SHEET_W / MAX_SHEET_H ? Math.round(MAX_SHEET_W / repAspect) : MAX_SHEET_H;

  return (
    <div style={{ padding: 10, overflowY: "auto", overflowX: "auto", width: "100%" }}>
      <div style={{ fontSize: FS.caption, color: "var(--c-textSub)", marginBottom: 8 }}>
        {def.icon} {t(def.labelKey as any)} —{" "}
        {t("image.deimp_page_count" as any, {
          sheets: String(sheetIdx.length),
          pages: String(outCount),
        })}
      </div>
      {/* 凡例: セル内の数字が出力ページ番号であることを明示 */}
      <div
        style={{
          fontSize: FS.caption,
          color: "var(--c-textDim)",
          marginBottom: 8,
          textAlign: "center",
        }}
      >
        {t("image.deimp_cell_legend" as any)}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, justifyContent: "center" }}>
        {/* 出力ページ順（splitCells の並び）でシートカードを表示。
            同じ入力シートのセルをグループ化し、1つのカードにまとめる。 */}
        {(() => {
          // 入力シートごとにセルをグループ化（論理シート番号 → セルインデックス[]）
          const groupBySheet = new Map<number, number[]>();
          splitCells.forEach((c, idx) => {
            const key = c.page; // 0=空白, 1..n=入力シート
            if (!groupBySheet.has(key)) groupBySheet.set(key, []);
            groupBySheet.get(key)!.push(idx);
          });

          // 出力順を保つため、splitCells の登場順で unique な page を取り出す
          const sheetOrder: number[] = [];
          const seen = new Set<number>();
          splitCells.forEach((c) => {
            if (!seen.has(c.page)) {
              seen.add(c.page);
              sheetOrder.push(c.page);
            }
          });

          return sheetOrder.map((logicalSheet) => {
            const cellIndices = groupBySheet.get(logicalSheet) ?? [];
            const isBlank = logicalSheet === 0;
            const inputSheetArrayIdx = isBlank ? -1 : logicalSheet - 1; // sheetIdx への添字
            const inputPageIdx = isBlank ? -1 : (sheetIdx[inputSheetArrayIdx] ?? -1); // pdfInfo.pages[]への添字
            const pb = inputPageIdx >= 0 ? pdfInfo.pages?.[inputPageIdx] : undefined;
            const aspect = pb ? pb.w / pb.h : repAspect;
            let thumbW: number, thumbH: number;
            if (aspect >= MAX_SHEET_W / MAX_SHEET_H) {
              thumbW = MAX_SHEET_W;
              thumbH = Math.round(MAX_SHEET_W / aspect);
            } else {
              thumbH = MAX_SHEET_H;
              thumbW = Math.round(MAX_SHEET_H * aspect);
            }

            // 出力ページ番号バッジ（row ごとに横並び）
            const badgesByRow: (number | undefined)[][] = Array.from({ length: def.rows }, () =>
              Array(def.cols).fill(undefined),
            );
            cellIndices.forEach((idx) => {
              const c = splitCells[idx];
              if (c.row < def.rows && c.col < def.cols) {
                badgesByRow[c.row][c.col] = c.outPage || idx + 1;
              }
            });

            const numberBar = (row: number) => (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(${def.cols}, 1fr)`,
                  width: thumbW,
                  gap: 0,
                }}
              >
                {badgesByRow[row].map((outPage, col) => (
                  <div key={col} style={{ textAlign: "center" }}>
                    <span style={s.deimpPageBadge}>
                      {t("image.deimp_cell_prefix" as any)}
                      {outPage ?? "—"}
                    </span>
                  </div>
                ))}
              </div>
            );

            if (isBlank) {
              // 空白ページ: 点線枠で表示
              return (
                <div
                  key={`blank-${logicalSheet}-${cellIndices[0]}`}
                  style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}
                >
                  {numberBar(0)}
                  <div
                    style={{
                      width: repThumbW,
                      height: repThumbH,
                      background: "var(--c-bgCard)",
                      border: "2px dashed var(--c-border)",
                      borderRadius: 6,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--c-textDim)",
                      fontSize: FS.caption,
                    }}
                  >
                    {t("common.imposition_blank_page" as any)}
                  </div>
                  {def.rows > 1 && numberBar(def.rows - 1)}
                  <div
                    style={{ textAlign: "center", fontSize: FS.caption, color: "var(--c-textDim)" }}
                  >
                    {t("common.imposition_blank_page" as any)}
                  </div>
                </div>
              );
            } else
              return (
                <div
                  key={`sheet-${logicalSheet}`}
                  style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}
                >
                  {numberBar(0)}
                  <div style={{ position: "relative", width: thumbW }}>
                    {thumbs[inputPageIdx] ? (
                      <img
                        src={`data:image/jpeg;base64,${thumbs[inputPageIdx]}`}
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
                  {def.rows > 1 && numberBar(def.rows - 1)}
                  <div
                    style={{ textAlign: "center", fontSize: FS.caption, color: "var(--c-textSub)" }}
                  >
                    {t("common.page_n" as any, { n: String(inputPageIdx + 1) })}
                  </div>
                </div>
              );
          });
        })()}
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
    fontSize: FS.body,
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
  title: { fontSize: FS.title, fontWeight: 700, color: "var(--c-text)" },
  sub: {
    fontSize: FS.body,
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
    fontSize: FS.small,
    color: "var(--c-textSub)",
  },
  outBadge: { fontSize: FS.label, color: "var(--c-accent)", fontWeight: 700 },

  body: {
    flex: 1,
    display: "flex",
    overflow: "hidden",
    minHeight: 0,
  },
  panel: {
    width: 300,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    borderRight: `1px solid var(--c-border)`,
  },
  // 設定値だけをスクロールさせ、actionBar（ボタン）は下部固定にする
  panelScroll: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
    padding: "16px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  secLabel: {
    fontSize: FS.small,
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
  fmtName: { fontSize: FS.label, fontWeight: 700, color: "var(--c-text)" },
  fmtDesc: { fontSize: FS.caption, color: "var(--c-textSub)", textAlign: "center" as const },

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
  dpiLabel: { fontSize: FS.subtitle, fontWeight: 700, color: "var(--c-text)" },
  dpiDesc: { fontSize: FS.caption, color: "var(--c-textSub)" },

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
  numLabel: { fontSize: FS.caption, color: "var(--c-textSub)" },
  rangeLabels: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: FS.caption,
    color: "var(--c-textDim)",
  },

  actionBar: {
    flexShrink: 0,
    display: "flex",
    gap: 10,
    justifyContent: "flex-end",
    alignItems: "center",
    padding: "10px 14px",
    borderTop: "1px solid var(--c-border)",
    background: "var(--c-bg)",
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
  prefixSuffix: { fontSize: FS.caption, color: "var(--c-textDim)", flexShrink: 0 },
  keepNameRow: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    fontSize: FS.body,
    color: "var(--c-text)",
    cursor: "pointer",
  },
  namePreview: {
    fontSize: FS.small,
    color: "var(--c-textSub)",
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-border)",
    borderRadius: 6,
    padding: "6px 9px",
    lineHeight: 1.5,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  namePreviewName: { color: "var(--c-text)", fontWeight: 600 },
  dirRow: { display: "flex", gap: 7 },
  dirPath: {
    flex: 1,
    padding: "8px 10px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 7,
    color: "var(--c-textSub)",
    fontSize: FS.small,
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
    fontSize: FS.body,
    fontFamily: F,
    flexShrink: 0,
  },
  batchNote: {
    padding: "10px 12px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-accentBd)`,
    borderRadius: 7,
    fontSize: FS.small,
    color: "var(--c-textSub)",
    lineHeight: 1.6,
  },

  conflictBanner: {
    padding: "10px 12px",
    background: "var(--c-errBg)",
    border: `1px solid var(--c-errBd)`,
    borderRadius: 7,
    fontSize: FS.small,
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
  bpTitle: { fontSize: FS.subtitle, fontWeight: 700, color: "var(--c-text)" },
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
  bpCurrent: { fontSize: FS.body, color: "var(--c-textSub)" },
  bpLog: {
    width: "100%",
    maxWidth: 480,
    display: "flex",
    flexDirection: "column",
    gap: 5,
    maxHeight: 360,
    overflowY: "auto",
  },
  bpRow: {
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap" as const,
    gap: "2px 8px",
    padding: "6px 10px",
    background: "var(--c-bgCard)",
    borderRadius: 6,
    border: `1px solid var(--c-border)`,
  },
  bpFile: {
    fontSize: FS.caption,
    color: "var(--c-textDim)",
    wordBreak: "break-all" as const,
  },
  bpMeta: {
    fontSize: FS.small,
    fontWeight: 700,
    color: "var(--c-text)",
    wordBreak: "break-all" as const,
  },
  bpCount: {
    fontSize: FS.small,
    fontWeight: 700,
    color: "var(--c-accent)",
    wordBreak: "break-all" as const,
  },

  preview: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  previewHead: {
    padding: "11px 18px",
    fontSize: FS.body,
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

  // ファイル選択ストリップ（横スクロール・コンパクトな表紙のみ）。
  // 単体プレビューと合わせるため、この下に合成プレビュー本体が続く。
  batchFileStrip: {
    display: "flex",
    flexDirection: "row",
    gap: 8,
    overflowX: "auto",
    padding: "8px 10px",
    borderBottom: `1px solid var(--c-border)`,
    flexShrink: 0,
  },
  batchFileChip: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    padding: "6px 6px",
    borderRadius: 6,
    border: "1px solid transparent",
    background: "none",
    appearance: "none" as const,
    flexShrink: 0,
    width: 64,
    cursor: "pointer",
  },
  batchFileChipOn: {
    background: "var(--c-accentBg)",
    border: `1px solid var(--c-accentBd)`,
  },
  batchThumbSmall: {
    maxWidth: 44,
    maxHeight: 62,
    objectFit: "contain" as const,
    borderRadius: 3,
  },
  batchThumbSmallPh: {
    width: 36,
    height: 50,
    background: "var(--c-border)",
    borderRadius: 3,
  },
  batchFileChipName: {
    fontSize: FS.caption,
    color: "var(--c-textSub)",
    maxWidth: 64,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    textAlign: "center" as const,
  },
};
