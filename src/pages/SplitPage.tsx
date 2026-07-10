// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/pages/SplitPage.tsx  —  単体 & バッチ対応
export default SplitPage;

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
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
  splitPdf,
  getPdfInfo,
  type SplitMode,
  type SplitResponse,
  type PdfInfo,
  type OverrideMeta,
  isMobile,
} from "../lib/tauri";
import {
  buildMobileOutputSubfolder,
  mobileOutputPreviewLabel,
  commitSavedBatch,
  type MobileSavedFileInfo,
} from "../lib/mobileOutput";
import { MetadataEditModal } from "../components/MetadataEditModal";
//import { C, F } from "../lib/theme";
import { F } from "../lib/theme";
//import { CompressPage } from "./CompressPage";
import { useA11y } from "../hooks/useA11y";
import { tts } from "../lib/tts";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { LiveRegion } from "../components/A11yControls";
import { useI18n } from "../lib/i18n";
import { announceValueChange } from "../lib/announce";
import { FS } from "../lib/typography";
import { PreviewPane } from "../components/PreviewPane";
import { usePreview } from "../hooks/usePreview";
import { useViewport } from "../hooks/useViewport";
import { useSectionToggle } from "../hooks/useSectionToggle";
import { FixedMobileNav } from "../components/FixedMobileNav";

// ── 型 ───────────────────────────────────────────────────────────────────────

interface Props {
  filePath: string;
  pdfInfo: PdfInfo;
  batchFiles?: FileEntry[]; // バッチ時: 選択ファイル一覧
}

type Phase = "edit" | "processing" | "result" | "error" | "compress";
type ModeId = "all" | "every" | "ranges";

const THUMB_DPI = 52;

// バッチ実行の進捗
interface BatchProgress {
  current: number;
  total: number;
  currentFile: string;
  done: { file: string; count: number }[];
  errors: { file: string; msg: string }[];
}

// ── コンポーネント ────────────────────────────────────────────────────────────

export function SplitPage({ filePath, pdfInfo, batchFiles }: Props) {
  const { setError, convertLayoutW, convertLayoutH, convertLayoutEm } = usePdfStore();
  const isBatch = (batchFiles?.length ?? 0) > 1;
  const { announceScreen, announceSuccess, announceError, announceKey } = useA11y();
  const { t } = useI18n();
  const { isNarrow } = useViewport();
  const [statusMsg, setStatusMsg] = useState("");
  const rangeRef = useRef<HTMLInputElement | null>(null);
  const dirBtnRef = useRef<HTMLButtonElement | null>(null);
  const [metaEditOpen, setMetaEditOpen] = useState(false);
  const [overrideMetadata, setOverrideMetadata] = useState<OverrideMeta[] | undefined>(undefined);
  // 縦積みレイアウト用: 設定パネル⇄プレビューの表示切替とジャンプ
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const settingsTopRef = useRef<HTMLDivElement>(null);
  const previewTopRef = useRef<HTMLDivElement>(null);
  const { showingB: showingPreview, toggle: toggleSection } = useSectionToggle(
    bodyScrollRef,
    previewTopRef,
  );

  // 現在表示中のファイル（バッチの場合はプレビュー用に切り替え可能）
  const [previewIdx, setPreviewIdx] = useState(0);
  const previewFile = isBatch ? batchFiles![previewIdx] : null;
  const previewPath = isBatch ? previewFile!.path : filePath;
  const total = isBatch ? (previewFile?.pageCount ?? 1) : pdfInfo.page_count;

  const [phase, setPhase] = useState<Phase>("edit");
  const [savedDir, setSavedDir] = useState("");
  const [modeId, setModeId] = useState<ModeId>("all");
  const [everyN, setEveryN] = useState(2);
  const [ranges, setRanges] = useState<[number, number][]>([[1, pdfInfo.page_count]]);
  // 範囲指定の ◀▶ ステッパー: 開始(idx=0)/終了(idx=1)を増減し、新しい値を読み上げる
  const stepRange = (i: number, idx: 0 | 1, delta: 1 | -1) => {
    const cur = ranges[i];
    if (!cur) return;
    let nv: number;
    if (idx === 0) {
      nv = delta < 0 ? Math.max(1, cur[0] - 1) : Math.min(cur[1], cur[0] + 1);
    } else {
      nv = delta < 0 ? Math.max(cur[0], cur[1] - 1) : Math.min(total, cur[1] + 1);
    }
    setRanges((r) => r.map((x, j) => (j === i ? (idx === 0 ? [nv, x[1]] : [x[0], nv]) : x)));
    announceValueChange(`${t("aria.range_input")} #${i + 1}`, nv);
  };
  const [outDir, setOutDir] = useState("");
  // 出力ファイル名（画像変換ページと同じ「元名トグル＋ラベル＋プレビュー」方式）
  const [keepOriginalName, setKeepOriginalName] = useState(true);
  const [label, setLabel] = useState("");
  const [labelEdited, setLabelEdited] = useState(false);
  const [thumbs, setThumbs] = useState<(string | undefined)[]>([]);
  const [result, setResult] = useState<SplitResponse | null>(null);
  const [errMsg, setErrMsg] = useState("");
  const { enabled: previewEnabled } = usePreview("split");

  // バッチ用
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  // バッチ各ファイルの先頭サムネイル
  const [batchThumbs, setBatchThumbs] = useState<(string | undefined)[]>([]);

  // ── 出力ファイル名ヘルパー ───────────────────────────────────────────────
  // 入力ファイルのステム（拡張子なし）
  const srcStem = useMemo(
    () =>
      filePath
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.[^/.]+$/, "") || "output",
    [filePath],
  );
  // 既定ラベル（分割 / split）。未編集なら言語切替に追従。
  const defaultLabel = t("filename.label.split" as any);
  // 実効ラベルはレンダリング中に派生（state同期のeffectを使わない）。
  // 未編集なら defaultLabel、編集済みなら手入力値 label。初回や言語切替でも
  // 同一レンダリングで一致するため取りこぼしが起きない。
  const effectiveLabel = labelEdited ? label : defaultLabel;
  // prefix を組み立てる。バックエンドが _0001.pdf を後置するため末尾に "_" は付けない。
  //   例: 書類_分割 → 書類_分割_0001.pdf
  const splitPrefix = useCallback(
    (stem: string, keep: boolean): string => {
      const parts: string[] = [];
      if (keep && stem) parts.push(stem);
      if (effectiveLabel) parts.push(effectiveLabel);
      return parts.join("_") || "page";
    },
    [effectiveLabel],
  );
  // ライブプレビュー（バッチは1フォルダへ複数出力するため常に元名付き）
  const namePreview = useMemo(
    () => `${splitPrefix(srcStem, isBatch ? true : keepOriginalName)}_0001.pdf`,
    [splitPrefix, srcStem, isBatch, keepOriginalName],
  );

  // ── モバイル (Android) 向け出力: フォルダピッカーが無いため、
  // 決め打ちのサブフォルダ名を「保存先プレビュー」として表示し、
  // 実行後に同じ名前で MediaStore の Downloads へコピーする。
  // 分割はバッチでなくても常に複数ファイル出力になるため、単体/バッチ
  // 両方でこの仕組みを使う。
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    isMobile()
      .then(setMobile)
      .catch(() => setMobile(false));
  }, []);
  const mobileRelativeDir = useMemo(() => {
    const label =
      isBatch && batchFiles && batchFiles.length > 0 ? `${batchFiles.length}件` : srcStem;
    return buildMobileOutputSubfolder(label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBatch, batchFiles?.length, srcStem]);
  const [mobileSavedFiles, setMobileSavedFiles] = useState<MobileSavedFileInfo[] | null>(null);
  const [mobileSaveError, setMobileSaveError] = useState<string | null>(null);

  // ── サムネイル取得（プレビュー対象ファイル） ─────────────────────────────
  useEffect(() => {
    if (!previewEnabled) {
      setThumbs([]);
      return;
    }
    let cancelled = false;
    setThumbs([]);
    (async () => {
      const info = isBatch
        ? await getPdfInfo(previewPath, {
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          }).catch(() => null)
        : pdfInfo;
      const n = info?.page_count ?? 0;
      for (let i = 0; i < n; i++) {
        try {
          const b64 = await renderPage(previewPath, i, THUMB_DPI, {
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
        } catch {
          /* skip */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewPath, isBatch, previewEnabled]);

  // ── バッチ用: 各ファイルの先頭ページサムネイル ──────────────────────────
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
        } catch {
          /* skip */
        }
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

  // Android: 一時ディレクトリに書き出した結果を「ダウンロード」フォルダ
  // 配下へコピーする。プレビュー表示に使った mobileRelativeDir と同じ
  // 名前を使うことで、実行前後の表示を一致させる。
  // ⚠ dir (一時ディレクトリ) は共有の使い回しキャッシュなので、必ず
  // この回で実際に書き出したファイルの絶対パス一覧を filePaths として
  // 渡すこと(丸ごとコピーすると、過去の別処理の残骸まで保存されてしまう)。
  const finalizeMobileOutput = useCallback(
    async (dir: string, filePaths: string[]) => {
      if (!mobile) return;
      try {
        const saved = await commitSavedBatch(dir, mobileRelativeDir, filePaths);
        setMobileSavedFiles(saved);
      } catch (e) {
        setMobileSaveError(String(e));
      }
    },
    [mobile, mobileRelativeDir],
  );

  // 画面表示時の読み上げ
  useEffect(() => {
    announceScreen("screen.split");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ショートカット
  useKeyboardShortcuts({
    "Ctrl+Enter": () => {
      if (phase === "edit") {
        isBatch ? handleExecuteBatch() : handleExecuteSingle();
      }
    },
    "Ctrl+S": () => {},
    "Alt+D": () => {
      pickDir();
      tts.speak(t("aria.output_dir_btn"));
    },
    "Alt+R": () => {
      setModeId("ranges");
      setTimeout(() => {
        rangeRef.current?.focus();
        tts.speak(t("aria.range_input"));
      }, 50);
    },
    Escape: () => {
      if (phase === "result" || phase === "compress") {
        setPhase("edit");
        tts.speak(t("shortcut.back_to_edit"));
      }
    },
    F1: () => announceKey("shortcut.tool"),
  });

  // ── 実行（単体）────────────────────────────────────────────────────────────
  const handleExecuteSingle = useCallback(async () => {
    const resolvedDir = outDir || (await pickDir());
    if (!resolvedDir) return;
    setMobileSavedFiles(null);
    setMobileSaveError(null);
    setPhase("processing");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      const mode: SplitMode =
        modeId === "all"
          ? { type: "AllPages" }
          : modeId === "every"
            ? { type: "EveryN", n: everyN }
            : { type: "Ranges", ranges };
      const res = await splitPdf(
        filePath,
        resolvedDir,
        mode,
        splitPrefix(srcStem, keepOriginalName),
        convertLayoutW,
        convertLayoutH,
        convertLayoutEm,
        overrideMetadata,
      );
      setResult(res);
      setSavedDir(resolvedDir);
      const msg = t("common.files_split_done", { count: String(res.files.length) });
      setStatusMsg(msg);
      await finalizeMobileOutput(resolvedDir, res.files);
      announceSuccess("done.split", { count: String(res.files.length) });
      setPhase("result");
    } catch (e) {
      announceError(String(e));
      setErrMsg(String(e));
      setPhase("error");
      setError(String(e));
    }
  }, [
    filePath,
    outDir,
    modeId,
    everyN,
    ranges,
    splitPrefix,
    srcStem,
    keepOriginalName,
    pickDir,
    overrideMetadata,
    setError,
    announceSuccess,
    announceError,
    finalizeMobileOutput,
  ]);

  // ── 実行（バッチ）──────────────────────────────────────────────────────────
  const handleExecuteBatch = useCallback(async () => {
    const resolvedDir = outDir || (await pickDir());
    if (!resolvedDir) return;
    const files = batchFiles!;
    setMobileSavedFiles(null);
    setMobileSaveError(null);
    setPhase("processing");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const progress: BatchProgress = {
      current: 0,
      total: files.length,
      currentFile: "",
      done: [],
      errors: [],
    };
    setBatchProgress({ ...progress });
    const producedPaths: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      progress.current = i + 1;
      progress.currentFile = f.filename;
      setBatchProgress({ ...progress });
      try {
        const info = await getPdfInfo(f.path, {
          layoutW: convertLayoutW,
          layoutH: convertLayoutH,
          layoutEm: convertLayoutEm,
        });
        const mode: SplitMode =
          modeId === "all"
            ? { type: "AllPages" }
            : modeId === "every"
              ? { type: "EveryN", n: everyN }
              : // Ranges: 各ファイルのページ数でクリップして適用
                {
                  type: "Ranges",
                  ranges: ranges
                    .map(([s, e]) => [s, Math.min(e, info.page_count)] as [number, number])
                    .filter(([s, e]) => s <= info.page_count),
                };
        // バッチは全ファイルを1フォルダへ出すため、必ず元名を付けて衝突回避
        //   例: 書類_分割_0001.pdf
        const filePrefix = splitPrefix(f.filename.replace(/\.[^/.]+$/, ""), true);
        const res = await splitPdf(
          f.path,
          resolvedDir,
          mode,
          filePrefix,
          convertLayoutW,
          convertLayoutH,
          convertLayoutEm,
          overrideMetadata,
        );
        progress.done.push({ file: f.filename, count: res.files.length });
        producedPaths.push(...res.files);
      } catch (e) {
        progress.errors.push({ file: f.filename, msg: String(e) });
      }
      setBatchProgress({ ...progress });
    }
    await finalizeMobileOutput(resolvedDir, producedPaths);
    announceSuccess("done.split", { count: String(files.length) });
    setPhase("result");
  }, [
    batchFiles,
    outDir,
    modeId,
    everyN,
    ranges,
    splitPrefix,
    pickDir,
    overrideMetadata,
    announceSuccess,
    finalizeMobileOutput,
  ]);

  // ── グループプレビュー計算 ────────────────────────────────────────────────
  const groups: number[][] = (() => {
    if (modeId === "all") return Array.from({ length: total }, (_, i) => [i]);
    if (modeId === "every") {
      const g: number[][] = [];
      for (let i = 0; i < total; i += everyN) {
        g.push(Array.from({ length: Math.min(everyN, total - i) }, (_, j) => i + j));
      }
      return g;
    }
    return ranges.map(([s, e]) =>
      Array.from({ length: Math.max(0, e - s + 1) }, (_, i) => s - 1 + i).filter(
        (i) => i >= 0 && i < total,
      ),
    );
  })();

  // ── フェーズ分岐 ──────────────────────────────────────────────────────────
  if (phase === "processing" && !isBatch) return <Spinner label={t("split.processing")} />;

  // バッチ処理中
  if (phase === "processing" && isBatch && batchProgress)
    return (
      <div style={s.root}>
        <div style={s.batchProgress}>
          <div style={s.bpTitle}>
            {t("split.batch_processing", {
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
              <div key={i} style={s.bpLogRow}>
                <span style={{ color: "var(--c-accent)" }}>✓</span>
                <span style={s.bpLogFile}>{d.file}</span>
                <span style={s.bpLogMeta}>
                  {t("common.files_arrow", { count: String(d.count) })}
                </span>
              </div>
            ))}
            {batchProgress.errors.map((e, i) => (
              <div key={i} style={{ ...s.bpLogRow }}>
                <span style={{ color: "var(--c-err)" }}>✕</span>
                <span style={s.bpLogFile}>{e.file}</span>
                <span style={{ ...s.bpLogMeta, color: "var(--c-err)" }}>{e.msg}</span>
              </div>
            ))}
          </div>
        </div>
        <Spinner />;
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
  if (phase === "result" && isBatch && batchProgress)
    return (
      <div style={s.root}>
        <PageHeader>
          <BtnBack
            onClick={() => {
              setPhase("edit");
              setBatchProgress(null);
            }}
          />
          <span style={s.title}>{t("split.batch_done_title")}</span>
        </PageHeader>
        <div style={s.resultBody}>
          <div style={s.resultIcon}>{batchProgress.errors.length > 0 ? "⚠" : "✓"}</div>
          <div style={s.resultStat}>
            {t("split.success_count", { count: String(batchProgress.done.length) })}
            {batchProgress.errors.length > 0 &&
              t("split.error_count", { count: String(batchProgress.errors.length) })}
          </div>
          {mobile && (
            <div style={{ fontSize: FS.small, color: "var(--c-textSub)" }}>
              {mobileSaveError ? (
                <span style={{ color: "var(--c-err)" }}>{t("mobile.save_unsupported" as any)}</span>
              ) : mobileSavedFiles ? (
                <>
                  <div>
                    {t("mobile.save_done_summary" as any, {
                      count: String(mobileSavedFiles.length),
                    })}
                  </div>
                  <div>
                    {t("mobile.save_location" as any, {
                      path: mobileOutputPreviewLabel(
                        mobileRelativeDir,
                        t("mobile.downloads_root" as any),
                      ),
                    })}
                  </div>
                </>
              ) : (
                t("mobile.save_preview_pending" as any)
              )}
            </div>
          )}
          <div style={s.bpLog}>
            {batchProgress.done.map((d, i) => (
              <div key={i} style={s.bpLogRow}>
                <span style={{ color: "var(--c-accent)" }}>✓</span>
                <span style={s.bpLogFile}>{d.file}</span>
                <span style={s.bpLogMeta}>
                  {t("common.files_arrow", { count: String(d.count) })}
                </span>
              </div>
            ))}
            {batchProgress.errors.map((e, i) => (
              <div key={`e${i}`} style={s.bpLogRow}>
                <span style={{ color: "var(--c-err)" }}>✕</span>
                <span style={s.bpLogFile}>{e.file}</span>
                <span style={{ ...s.bpLogMeta, color: "var(--c-err)" }}>{e.msg}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );

  // 単体完了
  if (phase === "result" && result)
    return (
      <div style={s.root}>
        <PageHeader>
          <BtnBack onClick={() => setPhase("edit")} />
          <span style={s.title}>
            分割完了 — {t("split.output_files", { count: String(result.files.length) })}
          </span>
        </PageHeader>
        <div style={s.resultBody}>
          <div style={s.resultIcon}>✓</div>
          {mobile ? (
            <div style={s.resultDir}>
              {mobileSaveError ? (
                <span style={{ color: "var(--c-err)" }}>{t("mobile.save_unsupported" as any)}</span>
              ) : mobileSavedFiles ? (
                <>
                  <div>
                    {t("mobile.save_done_summary" as any, {
                      count: String(mobileSavedFiles.length),
                    })}
                  </div>
                  <div>
                    {t("mobile.save_location" as any, {
                      path: mobileOutputPreviewLabel(
                        mobileRelativeDir,
                        t("mobile.downloads_root" as any),
                      ),
                    })}
                  </div>
                </>
              ) : (
                t("mobile.save_preview_pending" as any)
              )}
            </div>
          ) : (
            <div style={s.resultDir}>{savedDir}</div>
          )}
          <div style={s.fileList}>
            {result.files.slice(0, 20).map((f, i) => (
              <div key={i} style={s.fileRow}>
                <span>📄</span>
                <span style={s.fileName}>{f.split(/[/\\]/).pop()}</span>
              </div>
            ))}
            {result.files.length > 20 && (
              <div
                style={{
                  fontSize: FS.small,
                  color: "var(--c-textDim)",
                  textAlign: "center",
                  padding: 8,
                }}
              >
                {t("split.other_files", { count: String(result.files.length - 20) })}
              </div>
            )}
          </div>
          <div
            style={{
              fontSize: FS.small,
              color: "var(--c-textDim)",
              marginTop: 4,
              textAlign: "center",
            }}
          >
            {t("split.result_hint")}
          </div>
        </div>
      </div>
    );

  // ── 圧縮フェーズ ─────────────────────────────────────────────────────────
  if (phase === "compress") return null; // 分割は複数ファイルのため未対応 (バッチ圧縮を使用)

  // 狭い画面では左パネル（設定）とプレビューを横並びではなく縦積みにする。
  // 【重要】panel/プレビュー側 は flex-shrink: 0 を明示すること。
  // 既定値(flex-shrink:1)のままだと column 方向の flex コンテナ(body)の
  // 可視領域に収めようと両方が圧縮され、内容が重なって見える崩れ方をする。
  const bodyStyle: React.CSSProperties = isNarrow
    ? {
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        minHeight: 0,
        paddingBottom: 12,
      }
    : s.body;
  const panelStyle: React.CSSProperties = isNarrow
    ? { display: "flex", flexDirection: "column", flexShrink: 0, minHeight: 0 }
    : s.panel;
  const panelScrollStyle: React.CSSProperties = isNarrow
    ? { padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }
    : s.panelScroll;
  // プレビュー側(PreviewPane)は狭幅では fill=false にして自然な高さで
  // 伸ばし、body 全体のスクロールに委ねる（Rotate のページグリッドと同じ方式）。
  const previewWrapStyle: React.CSSProperties = isNarrow
    ? { flexShrink: 0, minWidth: 0 }
    : {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      };

  const executeBtn = (
    <BtnPrimary onClick={isBatch ? handleExecuteBatch : handleExecuteSingle}>
      {outDir
        ? isBatch
          ? t("split.execute_batch", { count: String(batchFiles!.length) })
          : t("split.execute", { count: String(groups.length) })
        : t("common.no_dir_btn")}
    </BtnPrimary>
  );

  // ── 設定画面 ──────────────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>
          {isBatch
            ? t("split.title_batch", { count: String(batchFiles!.length) })
            : t("split.title_single")}
        </span>
        {!isBatch && <span style={s.sub}>{filePath.split(/[/\\]/).pop()}</span>}
        {!isBatch && <span style={s.pageBadge}>{t("common.pages", { count: String(total) })}</span>}
        <div style={{ flex: 1 }} />
        <span style={s.groupCount}>
          {isBatch
            ? t("split.apply_all")
            : t("split.preview_count", { count: String(groups.length) })}
        </span>
      </PageHeader>

      <div style={bodyStyle} ref={bodyScrollRef}>
        {/* ── 左パネル: 設定 ── */}
        <div style={panelStyle} ref={settingsTopRef}>
          <div style={panelScrollStyle}>
            <div style={s.secLabel}>{t("split.mode_label")}</div>
            <div style={s.modeList}>
              {(
                [
                  {
                    id: "all",
                    icon: "⧉",
                    label: t("split.mode_all"),
                    desc: t("split.mode_all_desc"),
                  },
                  {
                    id: "every",
                    icon: "⊞",
                    label: t("split.mode_every"),
                    desc: t("split.mode_every_desc"),
                  },
                  {
                    id: "ranges",
                    icon: "⊟",
                    label: t("split.mode_ranges"),
                    desc: t("split.mode_ranges_desc"),
                  },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  aria-label={m.label}
                  aria-pressed={modeId === m.id}
                  onClick={() => setModeId(m.id)}
                  style={{ ...s.modeBtn, ...(modeId === m.id ? s.modeBtnOn : {}) }}
                >
                  <span style={s.modeIcon}>{m.icon}</span>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: 2,
                    }}
                  >
                    <span style={s.modeName}>{m.label}</span>
                    <span style={s.modeDesc}>{m.desc}</span>
                  </div>
                </button>
              ))}
            </div>

            {modeId === "every" && (
              <>
                <div style={s.secLabel}>{t("split.every_n_label")}</div>
                {isBatch && <div style={s.batchRangeNote}>{t("split.every_apply_all")}</div>}
                <div style={s.numRow}>
                  <button
                    style={s.stepBtn}
                    data-voice-skip
                    onClick={() => {
                      const nv = Math.max(1, everyN - 1);
                      setEveryN(nv);
                      announceValueChange(t("aria.every_n_input"), nv);
                    }}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    style={s.numInput}
                    value={everyN}
                    min={1}
                    max={isBatch ? 999 : total}
                    aria-label={t("aria.every_n_input")}
                    onChange={(e) => setEveryN(Math.max(1, parseInt(e.target.value) || 1))}
                  />
                  <button
                    style={s.stepBtn}
                    data-voice-skip
                    onClick={() => {
                      const nv = everyN + 1;
                      setEveryN(nv);
                      announceValueChange(t("aria.every_n_input"), nv);
                    }}
                  >
                    ＋
                  </button>
                  <span style={s.numLabel}>{t("split.pages_per_file")}</span>
                </div>
              </>
            )}

            {modeId === "ranges" && !isBatch && (
              <>
                <div style={s.secLabel}>{t("split.range_label")}</div>
                {ranges.map((rng, i) => (
                  <div key={i} style={s.rangeRow}>
                    <span style={s.rangeIdx}>#{i + 1}</span>
                    <div style={s.rangeGroup}>
                      <button
                        style={s.rangeArrow}
                        data-voice-skip
                        onClick={() => stepRange(i, 0, -1)}
                      >
                        ◀
                      </button>
                      <input
                        type="number"
                        style={s.rangeInput}
                        ref={i === 0 ? rangeRef : undefined}
                        aria-label={
                          i === 0 ? t("aria.range_input") : `${t("aria.range_input")} #${i + 1}`
                        }
                        value={rng[0]}
                        min={1}
                        max={total}
                        onChange={(e) =>
                          setRanges((r) =>
                            r.map((x, j) => (j === i ? [parseInt(e.target.value) || 1, x[1]] : x)),
                          )
                        }
                      />
                      <button
                        style={s.rangeArrow}
                        data-voice-skip
                        onClick={() => stepRange(i, 0, 1)}
                      >
                        ▶
                      </button>
                    </div>
                    <span style={s.rangeSep}>〜</span>
                    <div style={s.rangeGroup}>
                      <button
                        style={s.rangeArrow}
                        data-voice-skip
                        onClick={() => stepRange(i, 1, -1)}
                      >
                        ◀
                      </button>
                      <input
                        type="number"
                        style={s.rangeInput}
                        value={rng[1]}
                        min={1}
                        max={total}
                        aria-label={`${t("aria.range_input")} #${i + 1}`}
                        onChange={(e) =>
                          setRanges((r) =>
                            r.map((x, j) => (j === i ? [x[0], parseInt(e.target.value) || 1] : x)),
                          )
                        }
                      />
                      <button
                        style={s.rangeArrow}
                        data-voice-skip
                        onClick={() => stepRange(i, 1, 1)}
                      >
                        ▶
                      </button>
                    </div>
                    {ranges.length > 1 && (
                      <button
                        style={s.delBtn}
                        onClick={() => setRanges((r) => r.filter((_, j) => j !== i))}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <button
                  style={s.addBtn}
                  onClick={(e) => {
                    setRanges((r) => [...r, [1, total]]);
                    (e.currentTarget as HTMLButtonElement).blur();
                  }}
                >
                  {t("split.add_range")}
                </button>
              </>
            )}

            {modeId === "ranges" && isBatch && (
              <>
                <div style={s.batchRangeNote}>{t("split.batch_clip_hint")}</div>
                {ranges.map((rng, i) => (
                  <div key={i} style={s.rangeRow}>
                    <span style={s.rangeIdx}>#{i + 1}</span>
                    <div style={s.rangeGroup}>
                      <button
                        style={s.rangeArrow}
                        data-voice-skip
                        onClick={() => stepRange(i, 0, -1)}
                      >
                        ◀
                      </button>
                      <input
                        type="number"
                        style={s.rangeInput}
                        value={rng[0]}
                        min={1}
                        aria-label={`${t("aria.range_input")} #${i + 1}`}
                        onChange={(e) =>
                          setRanges((r) =>
                            r.map((x, j) => (j === i ? [parseInt(e.target.value) || 1, x[1]] : x)),
                          )
                        }
                      />
                      <button
                        style={s.rangeArrow}
                        data-voice-skip
                        onClick={() => stepRange(i, 0, 1)}
                      >
                        ▶
                      </button>
                    </div>
                    <span style={s.rangeSep}>〜</span>
                    <div style={s.rangeGroup}>
                      <button
                        style={s.rangeArrow}
                        data-voice-skip
                        onClick={() => stepRange(i, 1, -1)}
                      >
                        ◀
                      </button>
                      <input
                        type="number"
                        style={s.rangeInput}
                        value={rng[1]}
                        min={1}
                        aria-label={`${t("aria.range_input")} #${i + 1}`}
                        onChange={(e) =>
                          setRanges((r) =>
                            r.map((x, j) => (j === i ? [x[0], parseInt(e.target.value) || 1] : x)),
                          )
                        }
                      />
                      <button
                        style={s.rangeArrow}
                        data-voice-skip
                        onClick={() => stepRange(i, 1, 1)}
                      >
                        ▶
                      </button>
                    </div>
                    {ranges.length > 1 && (
                      <button
                        style={s.delBtn}
                        onClick={() => setRanges((r) => r.filter((_, j) => j !== i))}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <button
                  style={s.addBtn}
                  onClick={(e) => {
                    setRanges((r) => [...r, [1, 99]]);
                    (e.currentTarget as HTMLButtonElement).blur();
                  }}
                >
                  {t("split.add_range")}
                </button>
              </>
            )}

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
                placeholder={defaultLabel}
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

            <div style={s.secLabel}>{t("split.output_dir")}</div>
            {mobile ? (
              <div style={s.dirRow}>
                <div
                  style={s.dirPath}
                  title={mobileOutputPreviewLabel(
                    mobileRelativeDir,
                    t("mobile.downloads_root" as any),
                  )}
                >
                  {t("mobile.save_preview" as any, {
                    path: mobileOutputPreviewLabel(
                      mobileRelativeDir,
                      t("mobile.downloads_root" as any),
                    ),
                  })}
                </div>
              </div>
            ) : (
              <div style={s.dirRow}>
                <div style={s.dirPath} title={outDir}>
                  <span aria-label={t("aria.output_dir_btn")}>
                    {outDir || t("common.select_dir")}
                  </span>
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

            {/* メタデータを分割前に編集（任意）*/}
            <div style={s.metaEditRow}>
              <button
                style={s.btnMetaEdit}
                onClick={() => setMetaEditOpen(true)}
                aria-label={t("split.meta_edit_btn")}
              >
                ✏️ {overrideMetadata ? t("split.meta_edit_set") : t("split.meta_edit_btn")}
              </button>
              {overrideMetadata && (
                <button
                  style={s.btnMetaClear}
                  onClick={() => setOverrideMetadata(undefined)}
                  title={t("split.meta_clear")}
                  aria-label={t("split.meta_clear")}
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* 実行ボタン欄（横並び時: 左下に常時表示 / 縦積み時: 画面下部の
              共通固定バー(FixedMobileNav)にのみ表示し、ここには出さない） */}
          {!isNarrow && <div style={s.actionBar}>{executeBtn}</div>}

          {/* メタデータ編集モーダル */}
          {metaEditOpen && (
            <MetadataEditModal
              filePath={filePath}
              initialMeta={
                overrideMetadata
                  ? {
                      // 確定済みの overrideMetadata を initialMeta に変換して引き継ぐ
                      title: overrideMetadata.find((f) => f.key === "Title")?.value,
                      author: overrideMetadata.find((f) => f.key === "Author")?.value,
                      subject: overrideMetadata.find((f) => f.key === "Subject")?.value,
                      keywords: overrideMetadata.find((f) => f.key === "Keywords")?.value,
                      creator: overrideMetadata.find((f) => f.key === "Creator")?.value,
                    }
                  : undefined
              }
              onClose={() => setMetaEditOpen(false)}
              onSaved={(meta) => {
                // 保存ではなく「確定」として overrideMetadata に保持
                const fields = [
                  { key: "Title", value: meta.title ?? "" },
                  { key: "Author", value: meta.author ?? "" },
                  { key: "Subject", value: meta.subject ?? "" },
                  { key: "Keywords", value: meta.keywords ?? "" },
                  { key: "Creator", value: meta.creator ?? "" },
                ].filter((f) => f.value.trim() !== "");
                setOverrideMetadata(fields.length ? fields : undefined);
                setMetaEditOpen(false);
              }}
              saveLabel={t("split.meta_confirm")}
            />
          )}
        </div>

        {/* ── 右: プレビューエリア ── */}
        {/* ── 右: プレビューエリア ── */}
        <div style={previewWrapStyle} ref={previewTopRef}>
          <PreviewPane
            pageKey="split"
            label={
              isBatch
                ? t("split.target_files", { count: String(batchFiles!.length) })
                : t("split.preview_head", { count: String(groups.length) })
            }
            fill={!isNarrow}
          >
            {isBatch ? (
              // バッチ: ファイル一覧 + 先頭ページサムネイル
              <div style={s.batchFileList}>
                {batchFiles!.map((f, i) => (
                  <div
                    key={f.id}
                    style={{ ...s.batchFileItem, ...(i === previewIdx ? s.batchFileItemOn : {}) }}
                    onClick={() => setPreviewIdx(i)}
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
                      <span style={s.batchFileMeta}>{f.pageCount}p</span>
                      <span style={s.batchFileMeta}>
                        {modeId === "all"
                          ? t("common.files_arrow", { count: String(f.pageCount) })
                          : modeId === "every"
                            ? t("common.files_arrow", {
                                count: String(Math.ceil(f.pageCount / everyN)),
                              })
                            : t("split.select_as_ranges")}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              // 単体: グループプレビュー
              <div style={s.groupList}>
                {groups.map((pages, gi) => (
                  <div key={gi} style={s.group}>
                    <div style={s.groupLabel}>
                      <span style={s.groupNum}>#{gi + 1}</span>
                      <span style={s.groupPages}>
                        {t("common.pages", { count: String(pages.length) })}
                      </span>
                      <span style={s.groupRange}>
                        {pages.length === 1
                          ? `p.${pages[0] + 1}`
                          : `p.${pages[0] + 1}〜${pages[pages.length - 1] + 1}`}
                      </span>
                    </div>
                    <div style={s.groupThumbs}>
                      {pages.slice(0, 8).map((pi) => {
                        const pb = pdfInfo?.pages[pi];
                        const aspect = pb ? pb.w / pb.h : undefined;
                        return (
                          <ThumbCard
                            key={pi}
                            b64={thumbs[pi]}
                            pageNum={pi + 1}
                            width={70}
                            aspectRatio={aspect}
                          />
                        );
                      })}
                      {pages.length > 8 && <div style={s.groupMore}>+{pages.length - 8}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </PreviewPane>
        </div>
      </div>
      <LiveRegion message={statusMsg} />
      {isNarrow && (
        <div style={{ paddingBottom: "calc(var(--safe-bottom) + 24px" }}>
        <FixedMobileNav
          showingSecondSection={showingPreview}
          onToggle={toggleSection}
          toSecondLabel={t("common.jump_to_preview")}
          toFirstLabel={t("common.jump_to_settings")}
        >
          {executeBtn}
        </FixedMobileNav>
	</div>
      )}
    </div>
  );
}

// ── スタイル ──────────────────────────────────────────────────────────────────

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
  title: { fontSize: FS.title, fontWeight: 700, color: "var(--c-text)" },
  sub: {
    fontSize: FS.small,
    color: "var(--c-textSub)",
    maxWidth: 180,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pageBadge: {
    padding: "2px 10px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 12,
    fontSize: FS.caption,
    color: "var(--c-textSub)",
  },
  groupCount: { fontSize: FS.body, color: "var(--c-accent)", fontWeight: 700 },

  body: { flex: 1, display: "flex", overflow: "hidden", minHeight: 0 },
  panel: {
    width: 296,
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
    fontSize: FS.caption,
    color: "var(--c-textSub)",
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
  },
  modeList: { display: "flex", flexDirection: "column", gap: 5 },
  modeBtn: {
    display: "flex",
    alignItems: "center",
    gap: 11,
    padding: "11px 13px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 8,
    cursor: "pointer",
    fontFamily: F,
    color: "var(--c-text)",
    textAlign: "left" as const,
    transition: "all 0.1s",
  },
  modeBtnOn: { borderColor: "var(--c-accent)", background: "var(--c-accentBg)" },
  modeIcon: { fontSize: 20, flexShrink: 0 },
  modeName: { fontSize: FS.body, fontWeight: 600, color: "var(--c-text)" },
  modeDesc: { fontSize: FS.caption, color: "var(--c-textSub)" },

  numRow: { display: "flex", alignItems: "center", gap: 7 },
  stepBtn: {
    width: 44,
    height: 44,
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
    width: 80,
    height: 60,
    padding: "4px 0",
    boxSizing: "border-box" as const,
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 7,
    color: "var(--c-text)",
    fontSize: 28,
    lineHeight: "60px",
    fontFamily: F,
    textAlign: "center" as const,
    fontWeight: 700,
  },
  numLabel: { fontSize: FS.small, color: "var(--c-textSub)" },

  rangeRow: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" as const },
  rangeGroup: { display: "flex", alignItems: "center", gap: 2 },
  rangeIdx: { fontSize: FS.caption, color: "var(--c-textDim)", width: 24, flexShrink: 0 },
  rangeInput: {
    width: 80,
    padding: "8px 4px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 7,
    color: "var(--c-text)",
    fontSize: 26,
    fontFamily: F,
    height: "48px",
    lineHeight: "54px",
    textAlign: "center" as const,
    fontWeight: 700,
  },
  rangeSep: { fontSize: FS.label, color: "var(--c-textDim)" },
  rangeArrow: {
    width: 44,
    height: 44,
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
  },
  rangeSteps: { display: "flex", gap: 3 },
  delBtn: {
    width: 28,
    height: 28,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "none",
    color: "var(--c-textDim)",
    cursor: "pointer",
    fontSize: FS.label,
    padding: 0,
    fontFamily: F,
  },
  addBtn: {
    padding: "8px 14px",
    background: "transparent",
    border: `1px dashed var(--c-borderHi)`,
    borderRadius: 6,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontSize: FS.small,
    fontFamily: F,
  },
  batchRangeNote: {
    padding: "9px 11px",
    background: "var(--c-accentBg)",
    border: `1px solid var(--c-accentBd)`,
    borderRadius: 7,
    fontSize: FS.caption,
    color: "var(--c-textSub)",
    lineHeight: 1.6,
  },

  prefixRow: { display: "flex", alignItems: "center", gap: 6 },
  textInput: {
    flex: 1,
    height: 36,
    padding: "4px 9px",
    boxSizing: "border-box" as const,
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 6,
    color: "var(--c-text)",
    fontSize: FS.label,
    lineHeight: "36px",
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
    padding: "7px 9px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 6,
    color: "var(--c-textSub)",
    fontSize: FS.caption,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  dirPickBtn: {
    padding: "7px 14px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 6,
    color: "var(--c-text)",
    cursor: "pointer",
    fontSize: FS.small,
    fontFamily: F,
    flexShrink: 0,
  },
  metaEditRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  btnMetaEdit: {
    flex: 1,
    padding: "6px 10px",
    background: "transparent",
    border: "1px solid var(--c-accent)",
    borderRadius: 7,
    color: "var(--c-accent)",
    cursor: "pointer",
    fontSize: FS.small,
    fontFamily: "inherit",
    textAlign: "left" as const,
  },
  btnMetaClear: {
    padding: "4px 8px",
    background: "transparent",
    border: "1px solid var(--c-border)",
    borderRadius: 6,
    color: "var(--c-textDim)",
    cursor: "pointer",
    fontSize: FS.caption,
    fontFamily: "inherit",
  },

  // バッチ進捗
  batchProgress: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
    padding: 40,
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
    maxHeight: 300,
    overflowY: "auto",
  },
  bpLogRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "6px 10px",
    background: "var(--c-bgCard)",
    borderRadius: 6,
    border: `1px solid var(--c-border)`,
  },
  bpLogFile: {
    flex: 1,
    fontSize: FS.small,
    color: "var(--c-text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  bpLogMeta: { fontSize: FS.caption, color: "var(--c-textSub)" },

  // プレビューエリア
  preview: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  previewHead: {
    padding: "10px 18px",
    fontSize: FS.small,
    color: "var(--c-textSub)",
    borderBottom: `1px solid var(--c-border)`,
    flexShrink: 0,
    letterSpacing: "0.04em",
  },

  // バッチファイルリスト
  batchFileList: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 0 },
  batchFileItem: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "12px 16px",
    borderBottom: `1px solid var(--c-border)`,
    cursor: "pointer",
    transition: "background 0.1s",
  },
  batchFileItemOn: { background: "var(--c-accentBg)", borderLeft: `3px solid var(--c-accent)` },
  batchThumb: {
    width: 72,
    maxHeight: 108,
    objectFit: "contain" as const,
    borderRadius: 4,
    flexShrink: 0,
  },
  batchThumbPh: {
    width: 72,
    height: 102,
    background: "var(--c-border)",
    borderRadius: 4,
    flexShrink: 0,
  },
  batchFileInfo: { flex: 1, display: "flex", flexDirection: "column", gap: 5, minWidth: 0 },
  batchFileName: {
    fontSize: FS.body,
    color: "var(--c-text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  batchFileMeta: { fontSize: FS.caption, color: "var(--c-textSub)" },

  // 単体グループプレビュー
  groupList: {
    flex: 1,
    overflowY: "auto",
    overflowX: "hidden",
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    minHeight: 0, // flex child がスクロール可能になる必須設定
  },
  group: {
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 9,
    overflow: "hidden",
    flexShrink: 0, // カードが縦に潰れないようにする
  },
  groupLabel: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "7px 13px",
    borderBottom: `1px solid var(--c-border)`,
    background: "var(--c-bg)",
  },
  groupNum: { fontSize: FS.small, fontWeight: 700, color: "var(--c-accent)", minWidth: 28 },
  groupPages: { fontSize: FS.caption, color: "var(--c-textSub)" },
  groupRange: { fontSize: FS.caption, color: "var(--c-textDim)", marginLeft: "auto" },
  groupThumbs: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
    gap: 6,
    padding: "10px 12px",
    maxHeight: 200, // サムネイル2行分の高さ上限
    overflow: "hidden",
  },
  groupMore: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--c-border)",
    borderRadius: 4,
    fontSize: FS.small,
    color: "var(--c-textSub)",
    minHeight: 60,
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
    paddingBottom: "calc(var(--safe-bottom) + 8px)",
  },

  // 結果
  resultBody: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: 28,
    gap: 12,
    overflowY: "auto",
  },
  resultIcon: { fontSize: 52, color: "var(--c-accent)" },
  resultStat: { fontSize: 18, fontWeight: 700, color: "var(--c-text)" },
  resultDir: { fontSize: FS.small, color: "var(--c-textSub)" },
  fileList: { width: "100%", maxWidth: 500, display: "flex", flexDirection: "column", gap: 4 },
  fileRow: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "7px 11px",
    background: "var(--c-bgCard)",
    borderRadius: 6,
    border: `1px solid var(--c-border)`,
  },
  fileName: { fontSize: FS.small, color: "var(--c-text)" },
};
