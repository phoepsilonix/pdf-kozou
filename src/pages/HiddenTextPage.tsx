// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// src/pages/HiddenTextPage.tsx — 隠しテキスト検出・無害化（試験的）

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader, Spinner, TapRevealText } from "../components/common";
import { useA11y } from "../hooks/useA11y";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { ANDROID_FOLDER_MISSING, useMobileBatchOutput } from "../hooks/useMobileBatchOutput";
import { useIsMobilePlatform } from "../hooks/usePlatform";
import { useSaveDialog } from "../hooks/useSaveDialog";
import { useViewport } from "../hooks/useViewport";
import { buildName } from "../lib/filename";
import { useI18n } from "../lib/i18n";
import {
  buildMobileOutputSubfolder,
  type MobileSavedFileInfo,
  mobileOutputPreviewLabel,
} from "../lib/mobileOutput";
import {
  detectBuriedText,
  detectControlChars,
  detectLowContrastText,
  detectTinyText,
  detectTransparentText,
  isAndroid,
  joinPath,
  type PdfInfo,
  type PickedFolder,
  renderPage,
  type SanitizeOrigin,
  sanitizeHiddenText,
} from "../lib/tauri";
import { F } from "../lib/theme";
import { tts } from "../lib/tts";
import { FS } from "../lib/typography";
import type { FileEntry } from "../store/usePdfStore";

// ── 型定義 ─────────────────────────────────────────────────────────────────

type DetectType = "transparent" | "low_contrast" | "tiny" | "buried" | "control_chars";

const DETECT_TYPE_DEFS: { id: DetectType; labelKey: string; icon: string; color: string }[] = [
  { id: "transparent", labelKey: "hidden.transparent", icon: "👻", color: "#8b5cf6" },
  { id: "low_contrast", labelKey: "hidden.low_contrast", icon: "🎨", color: "#f59e0b" },
  { id: "tiny", labelKey: "hidden.tiny", icon: "🔬", color: "#10b981" },
  { id: "buried", labelKey: "hidden.buried", icon: "🪦", color: "#ef4444" },
  { id: "control_chars", labelKey: "hidden.control_chars", icon: "⚡", color: "#3b82f6" },
];

// ── プレビューのズーム設定 ──────────────────────────────────────────────────
// "fit" = プレビュー領域に収まるよう自動縮小（従来どおりの挙動）。
// 数値 = 画像の原寸(natural size)に対する倍率。ズーム時はプレビュー領域内で
// 上下左右にスクロールして閲覧する。
type ZoomLevel = "fit" | number;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

const REASON_KEY: Record<string, string> = {
  invisible_mode: "hidden.reason_invisible",
  clip_only_mode: "hidden.reason_clip_only",
  transparent: "hidden.reason_transparent",
  low_contrast: "hidden.reason_low_contrast",
  tiny_font: "hidden.reason_tiny",
  buried: "hidden.reason_buried",
  clipped: "hidden.reason_clipped",
  control_char: "hidden.reason_control",
  whitespace_only: "hidden.reason_whitespace",
};

// lcRatio: 低コントラスト検出の外周リング(32点)のうち何割が低コントラスト
// なら「埋没」と判定するか(0.0〜1.0)。大きいほど厳格(全周が同化して
// いる場合のみ検出)、小さいほど緩め(部分的な同化も拾う)。
const DEFAULT_THR = { alpha: 13, contrast: 1.2, size: 2.0, cover: 0.8, lcRatio: 0.75 };

type Thr = typeof DEFAULT_THR;

const PRESETS: { id: string; labelKey: string; thr: Thr }[] = [
  {
    id: "strict",
    labelKey: "hidden.preset_strict",
    thr: { alpha: 5, contrast: 1.0, size: 1.0, cover: 0.9, lcRatio: 0.9 },
  },
  {
    id: "normal",
    labelKey: "hidden.preset_normal",
    thr: { alpha: 13, contrast: 1.2, size: 2.0, cover: 0.8, lcRatio: 0.75 },
  },
  {
    id: "loose",
    labelKey: "hidden.preset_loose",
    thr: { alpha: 30, contrast: 1.5, size: 4.0, cover: 0.6, lcRatio: 0.5 },
  },
];

const LAST_THR_KEY = "hidden_thr_last";

function loadLastThr(): Thr | null {
  try {
    const raw = localStorage.getItem(LAST_THR_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Thr;
    if (typeof v.alpha === "number" && typeof v.contrast === "number") {
      // 旧バージョンで保存された値に lcRatio が無い場合はデフォルトで補完
      return { ...DEFAULT_THR, ...v };
    }
  } catch {}
  return null;
}

function saveLastThr(thr: Thr) {
  try {
    localStorage.setItem(LAST_THR_KEY, JSON.stringify(thr));
  } catch {}
}

type AnyHit = {
  type: DetectType;
  char: string;
  reason: string;
  origin: [number, number];
  quad: [number, number, number, number, number, number, number, number];
  size: number;
  extra: string;
  isType3: boolean;
  xobjXref: number; // 0 = トップレベル
  xobjTjSeq: number; // 所属XObject内でのTj/TJコマンド通し番号。-1=未確定
  internalOrigin: [number, number]; // XObject 内部座標
  page: number; // 検出ページ番号（0始まり）
};

type HitGroup = {
  id: string;
  type: DetectType;
  reason: string;
  label: string;
  fullLabel: string;
  chars: AnyHit[];
  y: number;
  isWs: boolean;
  expanded: boolean;
};

// バッチ進捗
type BatchProgress = {
  current: number;
  total: number;
  currentFile: string;
  // 将来デスクトップ版の進捗表示でフルパス表示を選択可能にするための予備
  // フィールド。現状は未使用（表示は常にファイル名のみ）
  currentFilePath: string;
  done: { file: string; hits: number; saved?: string }[];
  errors: { file: string; msg: string }[];
};

// バックエンド(mupdf-core)から返る生の検出結果(snake_case)
type RawHit = {
  char?: string;
  reason?: string;
  origin?: [number, number];
  quad?: [number, number, number, number, number, number, number, number];
  size?: number;
  alpha?: number;
  contrast?: number;
  category?: string;
  is_type3?: boolean;
  xobj_xref?: number;
  xobj_tj_seq?: number;
  internal_origin?: [number, number];
};

function toAnyHits(type: DetectType, hits: RawHit[], pageIdx = 0): AnyHit[] {
  return hits.map((h) => ({
    type,
    char: h.char ?? "",
    reason: h.reason ?? "",
    origin: h.origin ?? [0, 0],
    quad: h.quad ?? [0, 0, 0, 0, 0, 0, 0, 0],
    size: h.size ?? 0,
    extra:
      type === "transparent"
        ? `alpha=${h.alpha ?? "?"}`
        : type === "low_contrast"
          ? `cr=${(h.contrast ?? 0).toFixed(2)}`
          : type === "control_chars"
            ? (h.category ?? "")
            : "",
    isType3: h.is_type3 ?? false,
    xobjXref: h.xobj_xref ?? 0,
    xobjTjSeq: h.xobj_tj_seq ?? -1,
    internalOrigin: h.internal_origin ?? [h.origin?.[0] ?? 0, h.origin?.[1] ?? 0],
    page: pageIdx,
  }));
}

const LINE_Y_TOL = 4;

// 描画モード(取り違え防止)を検出 reason から導出する。
// invisible_mode / clip_only_mode は不可視(Tr=3/7)として描画されるため 1。
// それ以外(transparent/low_contrast/tiny/buried/control_chars 等)は可視描画なので 0。
// 無害化側は、同一座標に重なる別グリフを巻き込まないようこの値で show 演算子を選別する。
function renderInvisibleOf(reason: string): number {
  return reason === "invisible_mode" || reason === "clip_only_mode" ? 1 : 0;
}

// ca (ExtGState 塗り不透明度) 照合が必要な検出理由か。
// "transparent" (Tr は塗り/線ありだが ExtGState ca=0 による透明) だけが対象。
// 同一位置に影(ca=0.4)/透明(ca=0)/本体(ca=1.0)のように複数レイヤーで重ねて
// 描画される場合、無害化側で実際の ca も確認しないと、検出された透明レイヤー
// 以外の可視レイヤーまで巻き添えで消してしまう(実機で確認: 完全に見えている
// 見出しが透明無害化だけで消える不具合)。low_contrast/tiny/buried/
// invisible_mode/clip_only_mode は ca と無関係なので対象外(0)。
function alphaGateOf(reason: string): number {
  return reason === "transparent" ? 1 : 0;
}

// 検出グリフの先頭 Unicode コードポイントを返す(取り違え防止の文字 identity)。
// 文字が無い/不明の場合は -1(C 層で従来の座標のみ照合にフォールバック)。
function codepointOf(ch: string | undefined): number {
  if (!ch || ch.length === 0) return -1;
  const cp = ch.codePointAt(0);
  return cp === undefined ? -1 : cp;
}

function buildLabel(type: DetectType, _reason: string, chars: AnyHit[]): string {
  if (type === "control_chars") return `${chars[0].char} (${chars[0].extra}) × ${chars.length}`;
  const text = chars.map((c) => (c.char === " " ? "·" : c.char)).join("");
  if (text.length <= 60) return `"${text}"`;
  return `"${text.slice(0, 57)}…"`;
}

// buildLabel の省略なし版。一覧では60字で切り詰めた label をそのまま表示し、
// ellipsis や幅の都合で表示しきれない分は、この fullLabel をポップアップ
// (TapRevealText、ファイル名表示と同じ共通コンポーネント)で確認できるようにする。
// control_chars は元々1文字+件数の短い表示なので、label と同じでよい。
function buildFullLabel(type: DetectType, _reason: string, chars: AnyHit[]): string {
  if (type === "control_chars") return `${chars[0].char} (${chars[0].extra}) × ${chars.length}`;
  const text = chars.map((c) => (c.char === " " ? "·" : c.char)).join("");
  return `"${text}"`;
}

function groupHits(hits: AnyHit[]): HitGroup[] {
  const groups: HitGroup[] = [];
  let gid = 0;
  for (const hit of hits) {
    const pageIdx = hit.page ?? 0;
    const groupKey =
      hit.type === "control_chars"
        ? `${hit.type}::${hit.reason}::${hit.extra}::p${pageIdx}`
        : `${hit.type}::${hit.reason}::p${pageIdx}`;
    const existing = groups.find(
      (g) => g.id.startsWith(groupKey) && Math.abs(g.y - hit.origin[1]) <= LINE_Y_TOL,
    );
    if (existing) {
      existing.chars.push(hit);
      existing.label = buildLabel(existing.type, existing.reason, existing.chars);
      existing.fullLabel = buildFullLabel(existing.type, existing.reason, existing.chars);
    } else {
      groups.push({
        id: `${groupKey}::${gid++}::${hit.origin[1].toFixed(0)}`,
        type: hit.type,
        reason: hit.reason,
        label: buildLabel(hit.type, hit.reason, [hit]),
        fullLabel: buildFullLabel(hit.type, hit.reason, [hit]),
        chars: [hit],
        y: hit.origin[1],
        isWs: hit.reason === "whitespace_only",
        expanded: false,
      });
    }
  }
  /* ページ番号優先でソート、同ページ内は y 座標順 */
  groups.sort((a, b) => {
    const pa = a.chars[0]?.page ?? 0;
    const pb = b.chars[0]?.page ?? 0;
    if (pa !== pb) return pa - pb;
    return a.y - b.y;
  });
  return groups;
}

// 全ページの全ヒットを取得（バッチ用）
async function detectAllPages(
  path: string,
  pageCount: number,
  enabled: Set<DetectType>,
  thr: typeof DEFAULT_THR,
): Promise<AnyHit[]> {
  const all: AnyHit[] = [];
  for (let p = 0; p < pageCount; p++) {
    if (enabled.has("transparent"))
      all.push(
        ...toAnyHits("transparent", (await detectTransparentText(path, p, thr.alpha)).hits, p),
      );
    if (enabled.has("low_contrast"))
      all.push(
        ...toAnyHits(
          "low_contrast",
          (await detectLowContrastText(path, p, thr.contrast, thr.lcRatio)).hits,
          p,
        ),
      );
    if (enabled.has("tiny"))
      all.push(...toAnyHits("tiny", (await detectTinyText(path, p, thr.size)).hits, p));
    if (enabled.has("buried"))
      all.push(...toAnyHits("buried", (await detectBuriedText(path, p, thr.cover)).hits, p));
    if (enabled.has("control_chars"))
      all.push(...toAnyHits("control_chars", (await detectControlChars(path, p)).hits, p));
  }
  return all;
}

// ── HiddenTextPage ─────────────────────────────────────────────────────────

export function HiddenTextPage({
  filePath,
  pdfInfo,
  batchFiles,
}: {
  filePath: string;
  pdfInfo: PdfInfo;
  batchFiles?: FileEntry[];
}) {
  const isBatch = (batchFiles?.length ?? 0) > 1;
  const { announceScreen } = useA11y();
  // biome-ignore lint/correctness/useExhaustiveDependencies: マウント時に一度だけ画面名を読み上げる意図。
  useEffect(() => {
    announceScreen("screen.hidden");
  }, []);

  return isBatch ? (
    // biome-ignore lint/style/noNonNullAssertion: isBatchはbatchFiles有無から導出されているため必ず存在
    <BatchView batchFiles={batchFiles!} />
  ) : (
    <SingleView filePath={filePath} pdfInfo={pdfInfo} />
  );
}

// ── BatchView ──────────────────────────────────────────────────────────────

function BatchView({ batchFiles }: { batchFiles: FileEntry[] }) {
  const { t } = useI18n();
  const { isNarrow } = useViewport();
  const mobilePlatform = useIsMobilePlatform();
  const DETECT_TYPES = DETECT_TYPE_DEFS.map((d) => ({ ...d, label: t(d.labelKey) }));
  const [enabled, setEnabled] = useState<Set<DetectType>>(
    new Set(DETECT_TYPE_DEFS.map((d) => d.id)),
  );
  const [thr, setThr] = useState(() => loadLastThr() ?? DEFAULT_THR);
  const [showThr, setShowThr] = useState(false);
  const [outDir, setOutDir] = useState("");

  // ── モバイル (Android) 向け出力: SAFフォルダ選択(useMobileBatchOutput)。
  // iOS は従来通り決め打ちのサブフォルダ名を「保存先プレビュー」として
  // 表示し、実行後に同じ名前で MediaStore の Downloads へコピーする ──
  const {
    mobile,
    androidUI,
    androidFolder,
    pickAndroidFolder,
    ensureAndroidFolder,
    commitMobileOutput,
  } = useMobileBatchOutput();
  const mobileRelativeDir = useMemo(
    () => buildMobileOutputSubfolder(`${batchFiles.length}件`),
    [batchFiles.length],
  );
  const [mobileSavedFiles, setMobileSavedFiles] = useState<MobileSavedFileInfo[] | null>(null);
  const [mobileSaveError, setMobileSaveError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [phase, setPhase] = useState<"edit" | "processing" | "result">("edit");
  const [skipType3, setSkipType3] = useState(false);

  // 狭い画面では左(設定/進捗/サマリー)と右(ファイル一覧/ログ)を
  // 横並びではなく縦積みにする。左側は元々自身で overflowY:auto を
  // 持つ設定フォームなので、狭幅では幅いっぱいにしつつ高さの上限を
  // 設けて内部スクロールのままにし、残りを右側(flex:1)に譲る。
  const layoutStyle: React.CSSProperties = isNarrow
    ? { display: "flex", flex: 2, flexDirection: "column", overflow: "auto", minHeight: 0 }
    : s.layout;
  const leftStyle: React.CSSProperties = isNarrow
    ? {
        ...s.left,
        width: "100%",
        maxHeight: "42vh",
        borderRight: "none",
        borderBottom: "1px solid var(--c-border)",
      }
    : s.left;
  const rightStyle: React.CSSProperties = isNarrow
    ? { ...s.right, minHeight: 0, flex: 4, display: "flex" }
    : s.right;

  const pickDir = useCallback(async (): Promise<string | null> => {
    // Android/iOS: tauri-plugin-dialog の open({ directory: true }) は
    // モバイル向けのフォルダ選択ダイアログを実装していない
    // (ファイル選択・保存ダイアログのみ)。モバイルではこの分岐を
    // 使わず、pick_output_dir 経由でアプリの一時ディレクトリを取得し、
    // 実行後に finalizeMobileOutput で保存先(Android: SAFで選択した
    // フォルダ / iOS: ダウンロードフォルダ)へ移す。
    if (mobile) {
      const dir = await invoke("pick_output_dir").catch(() => null);
      if (dir) setOutDir(String(dir));
      return dir ? String(dir) : null;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, title: t("hidden.output_dir_dialog") });
      const resolved = dir ? (typeof dir === "string" ? dir : dir[0]) : null;
      if (resolved) setOutDir(resolved);
      return resolved;
    } catch (e) {
      console.error(e);
      return null;
    }
  }, [t, mobile]);

  // Android: 一時ディレクトリに書き出した結果を「ダウンロード」フォルダ
  // 配下へコピーする。プレビュー表示に使った mobileRelativeDir と同じ
  // 名前を使うことで、実行前後の表示を一致させる。
  // ⚠ dir (一時ディレクトリ) は共有の使い回しキャッシュなので、必ず
  // この回で実際に書き出したファイルの絶対パス一覧を filePaths として
  // 渡すこと(丸ごとコピーすると、過去の別処理の残骸まで保存されてしまう)。
  const finalizeMobileOutput = useCallback(
    async (dir: string, filePaths: string[], folderOverride?: PickedFolder | null) => {
      if (!mobile) return;
      try {
        const saved = await commitMobileOutput(dir, filePaths, mobileRelativeDir, folderOverride);
        if (saved === null) {
          setMobileSaveError(t("mobile.save_cancelled"));
          return;
        }
        setMobileSavedFiles(saved);
      } catch (e) {
        setMobileSaveError(
          e instanceof Error && e.message === ANDROID_FOLDER_MISSING
            ? t("mobile.save_unsupported")
            : String(e),
        );
      }
    },
    [mobile, mobileRelativeDir, commitMobileOutput, t],
  );

  const runBatch = useCallback(async () => {
    const resolvedDir = outDir || (await pickDir());
    if (!resolvedDir) return; // キャンセル
    let androidFolderForRun: PickedFolder | null = null;
    if (await isAndroid()) {
      androidFolderForRun = await ensureAndroidFolder();
      if (!androidFolderForRun) return; // フォルダ選択をキャンセル
    }
    setMobileSavedFiles(null);
    setMobileSaveError(null);
    setRunning(true);
    saveLastThr(thr); // 閾値を履歴保存
    setPhase("processing");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const prog: BatchProgress = {
      current: 0,
      total: batchFiles.length,
      currentFile: "",
      currentFilePath: "",
      done: [],
      errors: [],
    };
    setProgress({ ...prog });

    const producedPaths: string[] = [];
    for (let i = 0; i < batchFiles.length; i++) {
      const f = batchFiles[i];
      prog.current = i + 1;
      prog.currentFile = f.filename;
      prog.currentFilePath = f.path;
      setProgress({ ...prog });
      try {
        const hits = await detectAllPages(f.path, f.pageCount, enabled, thr);
        const targets: SanitizeOrigin[] = hits
          .filter((h) => h.reason !== "whitespace_only")
          .filter((h) => !(skipType3 && h.isType3))
          .map((h) => ({
            x: h.origin[0],
            y: h.origin[1],
            page: h.page,
            xobj_xref: h.xobjXref ?? 0,
            internal_x: h.internalOrigin?.[0] ?? h.origin[0],
            internal_y: h.internalOrigin?.[1] ?? h.origin[1],
            ox: h.origin[0],
            oy: h.origin[1],
            is_buried: h.type === "buried" ? 1 : 0,
            render_invisible: renderInvisibleOf(h.reason),
            // 文字 identity(取り違え防止): 検出グリフの Unicode とサイズ
            codepoint: codepointOf(h.char),
            size: h.size ?? 0,
            alpha_gate: alphaGateOf(h.reason),
            font_class: h.isType3 ? 1 : 0,
            xobj_tj_seq: h.xobjTjSeq ?? -1,
          }));
        if (targets.length === 0) {
          prog.done.push({ file: f.filename, hits: 0 });
        } else {
          const outPath = joinPath(resolvedDir, buildName(f.filename, ["sanitized"]));
          await sanitizeHiddenText({
            input: f.path,
            output: outPath,
            targets,
            tolerance: 1.5,
            alphaThreshold: thr.alpha,
          });
          prog.done.push({
            file: f.filename,
            hits: targets.length,
            saved: outPath.split(/[/\\]/).pop(),
          });
          producedPaths.push(outPath);
        }
      } catch (e) {
        prog.errors.push({ file: f.filename, msg: String(e) });
      }
      setProgress({ ...prog });
    }
    await finalizeMobileOutput(resolvedDir, producedPaths, androidFolderForRun);
    setRunning(false);
    setPhase("result");
  }, [
    batchFiles,
    outDir,
    enabled,
    thr,
    pickDir,
    ensureAndroidFolder,
    skipType3,
    finalizeMobileOutput,
  ]);

  const { announceKey } = useA11y();
  useKeyboardShortcuts({
    "Ctrl+Enter": () => {
      if (phase === "edit") {
        tts.speak(t("shortcut.executing"));
        runBatch();
      }
    },
    Escape: () => {
      if (phase === "result") {
        setPhase("edit");
        tts.speak(t("shortcut.back_to_edit"));
      }
    },
    F1: () => announceKey("shortcut.tool"),
  });

  // ── 処理中画面 ────────────────────────────────────────────────────────────
  if (phase === "processing" && progress) {
    return (
      <div style={s.root}>
        <PageHeader>
          <span style={s.title}>{t("hidden.title_batch", { count: String(progress.total) })}</span>
        </PageHeader>
        <BatchBanner />
        <div style={layoutStyle}>
          {/* 左: 進捗情報 */}
          <div style={s.left}>
            <div style={s.secTitle}>{t("hidden.batch_processing")}</div>
            <div style={s.statusBox}>
              {progress.current} / {progress.total}
            </div>
            <TapRevealText
              // 進捗表示: 現状はモバイル・デスクトップともファイル名のみ。
              // デスクトップは将来的にfullTextをprogress.currentFilePath
              // （フルパス）に切り替える余地を残してある
              text={progress.currentFile}
              fullText={progress.currentFile}
              mobilePlatform={mobilePlatform}
              style={s.currentFileBox}
            />
          </div>
          {/* 右: ログ */}
          <div style={rightStyle}>
            <div style={s.preview}>
              <div style={s.sec}>
                {progress.done.map((d) => (
                  <div key={d.file} style={s.statusBox}>
                    {d.file} →{" "}
                    {d.hits === 0 ? t("hidden.batch_no_detection") : `${d.hits}字 → ${d.saved}`}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── 結果画面 ──────────────────────────────────────────────────────────────
  if (phase === "result" && progress) {
    const succeeded = progress.done.filter((d) => d.hits > 0).length;
    const skipped = progress.done.filter((d) => d.hits === 0).length;
    return (
      <div style={s.root}>
        <PageHeader>
          <span style={s.title}>{t("hidden.title_batch", { count: String(progress.total) })}</span>
        </PageHeader>
        <BatchBanner />
        <div style={layoutStyle}>
          <div style={s.left}>
            <div style={s.statusBox}>{t("hidden.batch_done")}</div>
            <div style={s.statusBox}>
              {t("hidden.batch_sanitized", { count: String(succeeded) })}
            </div>
            {succeeded > 0 && <div style={s.statusBox}>{t("hidden.batch_rescan_note")}</div>}
            <div style={s.statusBox}>{t("hidden.batch_skipped", { count: String(skipped) })}</div>
            {progress.errors.length > 0 && (
              <div style={s.statusBox}>
                {t("hidden.batch_errors", { count: String(progress.errors.length) })}
              </div>
            )}
            {mobile &&
              (mobileSaveError ? (
                <div style={s.statusBox}>{mobileSaveError}</div>
              ) : mobileSavedFiles ? (
                <>
                  <div style={s.statusBox}>
                    {t("mobile.save_done_summary_folder", {
                      count: String(mobileSavedFiles.length),
                    })}
                  </div>
                  <div style={s.statusBox}>
                    {t("mobile.save_location", {
                      path: androidUI
                        ? (androidFolder?.folderName ?? "")
                        : mobileOutputPreviewLabel(mobileRelativeDir, t("mobile.downloads_root")),
                    })}
                  </div>
                </>
              ) : (
                <div style={s.statusBox}>{t("mobile.save_preview_pending")}</div>
              ))}
            <button
              type="button"
              style={s.detectBtn}
              onClick={() => {
                setPhase("edit");
                setProgress(null);
              }}
            >
              {t("hidden.batch_back")}
            </button>
          </div>
          <div style={rightStyle}>
            <div style={s.preview}>
              <div style={s.sec}>
                {progress.done.map((d) => (
                  <div key={d.file} style={s.logRow}>
                    <span style={s.logFile}>{d.file}</span>
                    <span style={s.logMeta}>→</span>
                    <span style={s.logMeta}>
                      {d.hits === 0
                        ? t("hidden.batch_no_detection")
                        : `${d.hits}字無害化 → ${d.saved}`}
                    </span>
                  </div>
                ))}
                {progress.errors.map((e) => (
                  <div key={e.file} style={s.logRow}>
                    <span style={s.logFile}>{e.file}</span>
                    <span style={s.logMeta}>→</span>
                    <span style={s.logMeta}>{e.msg.slice(0, 60)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── 設定画面 ──────────────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>{t("hidden.title_batch", { count: String(batchFiles.length) })}</span>
      </PageHeader>
      <BatchBanner />
      <div style={layoutStyle}>
        {/* 左: 設定 */}
        <div style={leftStyle}>
          {/* 検出タイプ */}
          <div style={s.sec}>
            <div style={s.secTitle}>検出タイプ</div>
            {DETECT_TYPES.map((dt) => (
              <label key={dt.id} style={s.chkRow}>
                <input
                  type="checkbox"
                  checked={enabled.has(dt.id)}
                  onChange={(e) => {
                    const n = new Set(enabled);
                    e.target.checked ? n.add(dt.id) : n.delete(dt.id);
                    setEnabled(n);
                  }}
                />
                <span style={{ color: dt.color }}>{dt.icon}</span>
                <span style={{ fontSize: FS.body }}>{dt.label}</span>
              </label>
            ))}
          </div>
          {/* 閾値 */}
          <button type="button" style={s.thrToggle} onClick={() => setShowThr((v) => !v)}>
            ⚙ 閾値設定 {showThr ? "▲" : "▼"}
          </button>
          {showThr && <ThrPanel thr={thr} setThr={setThr} t={t} />}
          {/* Type3フォントの扱い */}
          {
            <div style={s.sec}>
              <div style={s.secTitle}>Type3</div>
              <label style={s.chkRow}>
                <input
                  type="checkbox"
                  checked={skipType3}
                  onChange={(e) => setSkipType3(e.target.checked)}
                />
                {t("hidden.skip_type3")}
              </label>
            </div>
          }
          {/* 出力先フォルダ */}
          <div style={s.sec}>
            <div style={s.secTitle}>出力先フォルダ</div>
            {mobile ? (
              androidUI ? (
                <>
                  <div style={s.statusBox}>
                    {androidFolder?.folderName || t("hidden.output_dir_empty")}
                  </div>
                  <button type="button" style={s.navBtn} onClick={() => pickAndroidFolder()}>
                    {t("hidden.output_dir_pick")}
                  </button>
                </>
              ) : (
                <div style={s.statusBox}>
                  {t("mobile.save_preview", {
                    path: mobileOutputPreviewLabel(mobileRelativeDir, t("mobile.downloads_root")),
                  })}
                </div>
              )
            ) : (
              <>
                <div style={s.statusBox}>{outDir || t("hidden.output_dir_empty")}</div>
                <button type="button" style={s.navBtn} onClick={pickDir}>
                  {t("hidden.output_dir_pick")}
                </button>
              </>
            )}
            <div style={s.statusBox}>{t("hidden.output_dir_note")}</div>
          </div>
          <div style={s.sec}>
            <div style={s.secTitle}>実行</div>
          </div>
        </div>
        <div style={rightStyle}>
          <div style={s.preview}>
            <div style={s.sec}>
              <div style={s.secTitle}>
                {t("hidden.batch_files_label", { count: String(batchFiles.length) })}
              </div>
              {batchFiles.map((f, i) => (
                <div key={f.path} style={s.statusBox}>
                  {i + 1}. {f.filename} {f.pageCount}p
                </div>
              ))}
              {/* 実行ボタン */}
              <button
                type="button"
                style={s.detectBtn}
                onClick={() => {
                  const r = runBatch();
                  void r;
                }}
                disabled={running}
              >
                {running ? (
                  <Spinner />
                ) : (
                  t("hidden.batch_run_btn", { count: String(batchFiles.length) })
                )}
              </button>
              {/* 注意書き */}
              {batchFiles.length > 0 && <div style={s.statusBox}>{t("hidden.batch_warning")}</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── SingleView ─────────────────────────────────────────────────────────────

function SingleView({ filePath, pdfInfo }: { filePath: string; pdfInfo: PdfInfo }) {
  const { t } = useI18n();
  const { isNarrow } = useViewport();
  const mobilePlatform = useIsMobilePlatform();
  // 横長画面（isNarrow===false）でのみ、設定タブを手動で折りたためるようにする。
  // 折りたたむと設定タブの分の幅が空くので、プレビュー(検出したテキストの
  // 表示領域)は flex 指定により自動的にその分だけ広がる。狭幅画面では
  // 従来通り常に表示する（ここでは操作させない）。
  const [settingsCollapsed, setSettingsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("pdf-kozou-hiddentext-settings-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleSettingsPane = useCallback(() => {
    setSettingsCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("pdf-kozou-hiddentext-settings-collapsed", next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);
  const DETECT_TYPES = DETECT_TYPE_DEFS.map((d) => ({ ...d, label: t(d.labelKey) }));
  const [pageIndex, setPageIndex] = useState(0);
  const [allPagesMode, setAllPagesMode] = useState(false);
  const [enabled, setEnabled] = useState<Set<DetectType>>(
    new Set(DETECT_TYPE_DEFS.map((d) => d.id)),
  );
  const [thr, setThr] = useState(() => loadLastThr() ?? DEFAULT_THR);
  const [showThr, setShowThr] = useState(false);
  const [running, setRunning] = useState(false);
  const [groups, setGroups] = useState<HitGroup[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sanitizing, setSanitizing] = useState(false);
  const [status, setStatus] = useState("");
  const [imgSrc, setImgSrc] = useState("");
  const [imgNatW, setImgNatW] = useState(1);
  const [imgNatH, setImgNatH] = useState(1);
  const { pickSave, commitSave } = useSaveDialog();
  const { announceSuccess, announceError, announceKey } = useA11y();
  const [skipType3, setSkipType3] = useState(false);

  // ── プレビューのズーム／スクロール ──────────────────────────────────────
  const [zoom, setZoom] = useState<ZoomLevel>("fit");
  const imgRef = useRef<HTMLImageElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const panState = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  // "fit"表示中に実際に描画されているスケール（原寸比）を求める。
  // ズームボタンは「今見えている大きさ」からの相対的な拡大/縮小として
  // 振る舞わせたいため、fit→数値切り替え時にジャンプしないようにする。
  const currentRenderScale = useCallback((): number => {
    if (typeof zoom === "number") return zoom;
    const el = imgRef.current;
    if (el && imgNatW > 1) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) return rect.width / imgNatW;
    }
    return 1;
  }, [zoom, imgNatW]);

  const zoomIn = useCallback(
    () => setZoom(clampZoom(currentRenderScale() + ZOOM_STEP)),
    [currentRenderScale],
  );
  const zoomOut = useCallback(
    () => setZoom(clampZoom(currentRenderScale() - ZOOM_STEP)),
    [currentRenderScale],
  );
  const zoomFit = useCallback(() => setZoom("fit"), []);

  // Ctrl/Cmd+ホイールでカーソル位置を中心にズーム（デスクトップの補助操作）。
  const handleWheelZoom = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const next = clampZoom(currentRenderScale() + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
      setZoom(next);
    },
    [currentRenderScale],
  );

  // マウスドラッグでのパン（上下左右スクロール）。タッチ端末はネイティブの
  // スクロール操作をそのまま使えるため、pointer type が mouse の場合のみ有効化する。
  const handlePanPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const el = previewRef.current;
    if (!el) return;
    panState.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    setIsPanning(true);
    el.setPointerCapture(e.pointerId);
  }, []);
  const handlePanPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = panState.current;
    const el = previewRef.current;
    if (!start || !el) return;
    el.scrollLeft = start.left - (e.clientX - start.x);
    el.scrollTop = start.top - (e.clientY - start.y);
  }, []);
  const endPan = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    panState.current = null;
    setIsPanning(false);
    previewRef.current?.releasePointerCapture(e.pointerId);
  }, []);

  // ページ／ファイルを切り替えたら毎回フィット表示に戻す（スクロール位置も
  // 自動でリセットされ、前ページのズーム状態を引きずらない）。filePath は
  // 別ファイルを開いた場合にもリセットするための意図的な依存。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 上記コメントの通り
  useEffect(() => {
    setZoom("fit");
    const el = previewRef.current;
    if (el) {
      el.scrollLeft = 0;
      el.scrollTop = 0;
    }
  }, [pageIndex, filePath]);
  // ズーム倍率が変わるたびにスクロール位置を左上へ戻す（zoom 自体は本文で
  // 参照しないが、変更のたびに再実行したい意図的な依存）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 上記コメントの通り
  useEffect(() => {
    const el = previewRef.current;
    if (el) {
      el.scrollLeft = 0;
      el.scrollTop = 0;
    }
  }, [zoom]);

  const layoutStyle: React.CSSProperties = isNarrow
    ? { display: "flex", flex: 1, flexDirection: "column", overflow: "hidden", minHeight: 0 }
    : s.layout;
  const leftStyle: React.CSSProperties = isNarrow
    ? {
        ...s.left,
        width: "100%",
        maxHeight: "42vh",
        borderRight: "none",
        borderBottom: "1px solid var(--c-border)",
      }
    : s.left;

  // ── 横長画面: プレビュー列(previewCol) / 検出結果一覧(groupList) の幅配分 ──
  // 検出結果一覧は「隠しテキストに何が埋め込まれていたか」を確認するための
  // 領域であり、プレビューの画像そのものより優先して幅を確保したい。
  // 以前は下記2点が原因で、設定タブを折りたたんでもプレビューだけが広がり、
  // 検出結果一覧の幅はまったく変わらなかった:
  //  (a) 設定タブ折りたたみで空いた分を previewCol(flex:2) だけが吸収し、
  //      groupList は幅固定(280px)で伸びなかった。
  //  (b) ズームで画像を縮小しても previewCol 自体の箱は縮まないため、
  //      画像の周りに余白ができるだけで groupList には何も回らなかった。
  // ここでは、設定タブを折りたたんだ分はそのまま groupList の幅に加算し、
  // さらに数値ズーム時(="fit"以外)は previewCol を「現在の倍率で画像を
  // 表示するのに必要な幅」までに制限し、余った分を groupList 側の伸長
  // (flexGrow)で吸収させる。"fit" 表示中は画像自体がプレビュー領域いっぱいに
  // 自動で収まるため、previewCol は従来通り flex:2 で残りスペースを占有する。
  const SETTINGS_PANE_WIDTH = 230; // s.left.width と合わせる
  const SETTINGS_COLLAPSED_BAR_WIDTH = 18; // s.paneCollapsedBar.width と合わせる
  const SETTINGS_FREED_WIDTH = SETTINGS_PANE_WIDTH - SETTINGS_COLLAPSED_BAR_WIDTH;
  const GROUP_LIST_BASE_WIDTH = 280;
  const PREVIEW_MIN_WIDTH = 260; // ズームアウト時でもズームバー等が窮屈にならない下限
  const PREVIEW_HORIZONTAL_PAD = 44; // s.preview の左右 padding(10×2)+余裕分

  // 数値ズーム時、画像の実表示幅(自然サイズ×倍率)を基準に previewCol の
  // 必要幅を概算する。"fit" のときは null にして previewCol を従来通り
  // flex:2 のまま(=残りスペースを自動で占有)にする。
  const previewFlexBasis: number | null =
    typeof zoom === "number" && imgNatW > 1
      ? Math.max(PREVIEW_MIN_WIDTH, Math.round(imgNatW * zoom) + PREVIEW_HORIZONTAL_PAD)
      : null;

  const previewColStyle: React.CSSProperties = isNarrow
    ? {
        // 縦積み(狭幅)時、previewCol は flex:2/flex-basis:0% のままだと、
        // 設定パネル(leftStyle, 最大42vh)や検出結果一覧(groupList, 高さ160px
        // 固定)の分だけで画面の縦スペースを使い切ってしまう小さめの端末では、
        // flexboxの縮小計算上プレビュー列がほぼ0の高さまで潰れて消えてしまう
        // （flex-basis:0%の項目はflex-shrinkの重み計算で真っ先に潰されるため）。
        // これを防ぐため、最低限プレビューが見える高さを minHeight で保証する。
        // それでも全体が収まらない場合は、外側のラッパー(overflow:auto)側で
        // 縦スクロールさせる。
        ...s.previewCol,
        minHeight: 220,
      }
    : previewFlexBasis === null
      ? s.previewCol
      : { ...s.previewCol, flex: `0 1 ${previewFlexBasis}px`, maxWidth: previewFlexBasis };

  // 設定タブ折りたたみで空いた分をそのまま底上げする基準幅。
  const groupListBaseWidth = GROUP_LIST_BASE_WIDTH + (settingsCollapsed ? SETTINGS_FREED_WIDTH : 0);

  const groupListStyle: React.CSSProperties = isNarrow
    ? { ...s.groupList, height: 160 }
    : previewFlexBasis === null
      ? {
          // "fit" 表示中: 従来通り幅固定(設定タブ折りたたみ分のみ加算)。
          ...s.groupList,
          width: groupListBaseWidth,
          flexShrink: 0,
          borderTop: "none",
          borderLeft: "1px solid var(--c-border)",
        }
      : {
          // 数値ズーム中: previewCol が縮んだ分をここで吸収して伸びる。
          ...s.groupList,
          flex: "1 1 auto",
          minWidth: groupListBaseWidth,
          borderTop: "none",
          borderLeft: "1px solid var(--c-border)",
        };

  const pageCount = pdfInfo.page_count;
  const pageInfo = pdfInfo.pages?.[pageIndex];

  const renderCurrent = useCallback(async () => {
    try {
      const b64 = await renderPage(filePath, pageIndex, 96);
      setImgSrc(`data:image/jpeg;base64,${b64}`);
    } catch (e) {
      console.error(e);
    }
  }, [filePath, pageIndex]);

  useEffect(() => {
    renderCurrent();
  }, [renderCurrent]);

  const displayGroups = useMemo(
    () => groups.filter((g) => g.chars.length > 0 && g.chars[0].page === pageIndex),
    [groups, pageIndex],
  );
  // 検出タイプのチェックボックスは「次回の検出実行対象」を決めるものだが、
  // 既に検出済みのプレビュー上のハイライトについても同じチェックボックスで
  // 即座に表示/非表示を切り替えられるようにする（再検出せずに見たいタイプ
  // だけを視認しやすくするため）。一覧側は行を消さずに減光表示に留め、
  // 選択状態(selectedIds)や無害化対象には影響しない。
  const overlayGroups = useMemo(
    () => displayGroups.filter((g) => enabled.has(g.type)),
    [displayGroups, enabled],
  );

  const runDetect = useCallback(
    async (forceAllPages?: boolean) => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const effectiveAllPages = forceAllPages ?? allPagesMode;
      setRunning(true);
      setGroups([]);
      setSelectedIds(new Set());
      setStatus("検出中...");
      saveLastThr(thr);
      try {
        const all: AnyHit[] = [];
        const pages = effectiveAllPages
          ? Array.from({ length: pageCount }, (_, i) => i)
          : [pageIndex];
        for (const p of pages) {
          if (enabled.has("transparent"))
            all.push(
              ...toAnyHits(
                "transparent",
                (await detectTransparentText(filePath, p, thr.alpha)).hits,
                p,
              ),
            );
          if (enabled.has("low_contrast"))
            all.push(
              ...toAnyHits(
                "low_contrast",
                (await detectLowContrastText(filePath, p, thr.contrast, thr.lcRatio)).hits,
                p,
              ),
            );
          if (enabled.has("tiny"))
            all.push(...toAnyHits("tiny", (await detectTinyText(filePath, p, thr.size)).hits, p));
          if (enabled.has("buried"))
            all.push(
              ...toAnyHits("buried", (await detectBuriedText(filePath, p, thr.cover)).hits, p),
            );
          if (enabled.has("control_chars"))
            all.push(
              ...toAnyHits("control_chars", (await detectControlChars(filePath, p)).hits, p),
            );
        }
        // skipType3 が有効な場合、Type3(輪郭/装飾フォント等)由来のヒットは
        // 現状 sanitizeType3Text と連携しておらず無害化できないため、
        // 「選択できるのに無害化ボタンを押すと対象なしになる」という
        // 分かりにくい挙動を避けるべく一覧に出す前段階で除外する。
        const visible = skipType3 ? all.filter((h) => !h.isType3) : all;
        const grps = groupHits(visible);
        setGroups(grps);
        // 空白系(whitespace_only)は無害化対象から常に除外される(選択不可)ため、
        // 検出件数/文字数の集計もここで揃える。空白系のみが検出された場合は
        // 「検出なし」と同じ扱いにする(バッチ処理側の targets.length===0 判定と挙動を一致させる)。
        const sanitizableGrps = grps.filter((g) => !g.isWs);
        const sanitizableCharCount = sanitizableGrps.reduce((s, g) => s + g.chars.length, 0);
        const autoSel = new Set(sanitizableGrps.map((g) => g.id));
        setSelectedIds(autoSel);
        setStatus(
          sanitizableCharCount === 0
            ? t("hidden.batch_no_detection")
            : effectiveAllPages
              ? `${sanitizableGrps.length}件検出（${sanitizableCharCount}文字、全${pages.length}ページ）`
              : `${sanitizableGrps.length}件検出（${sanitizableCharCount}文字）`,
        );
      } catch (e) {
        setStatus(`エラー: ${e}`);
      } finally {
        setRunning(false);
      }
    },
    [filePath, pageIndex, pageCount, enabled, thr, allPagesMode, t, skipType3],
  );

  const runSanitize = useCallback(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const targets: SanitizeOrigin[] = groups
      .filter((g) => selectedIds.has(g.id))
      .flatMap((g) =>
        g.chars
          .filter((c) => !(skipType3 && c.isType3))
          .map((c) => ({
            x: c.origin[0],
            y: c.origin[1],
            page: c.page,
            xobj_xref: c.xobjXref ?? 0,
            internal_x: c.internalOrigin?.[0] ?? c.origin[0],
            internal_y: c.internalOrigin?.[1] ?? c.origin[1],
            ox: c.origin[0],
            oy: c.origin[1],
            is_buried: g.type === "buried" ? 1 : 0,
            render_invisible: renderInvisibleOf(c.reason),
            codepoint: codepointOf(c.char),
            size: c.size ?? 0,
            alpha_gate: alphaGateOf(c.reason),
            font_class: c.isType3 ? 1 : 0,
            xobj_tj_seq: c.xobjTjSeq ?? -1,
          })),
      );
    if (!targets.length) {
      setStatus(t("hidden.no_targets"));
      return;
    }

    const outPath = await pickSave(buildName(filePath, ["sanitized"]));
    if (!outPath) return;
    setSanitizing(true);
    setStatus(t("hidden.sanitize_btn", { chars: String(targets.length) }));
    try {
      await sanitizeHiddenText({
        input: filePath,
        output: outPath,
        targets,
        tolerance: 1.5,
        alphaThreshold: thr.alpha,
      });
      await commitSave(outPath);
      const doneName = outPath.split(/[/\\]/).pop() ?? "";
      // 無害化(空白置き換え)は近接する未選択文字の見え方(特にラスタベースの
      // 低コントラスト判定)に影響しうるため、再検出を促す注記を毎回添える。
      // 詳細: ドキュメント全体を白レイヤー+可視レイヤーで完全に重ねて複製する
      // ようなPDFでは、リングサンプリングによる低コントラスト判定が閾値
      // ギリギリで不安定になり、隣接文字を空白化した結果、それまで検出
      // されていなかった文字が次の検出で新たに見つかることがある(既知の
      // 挙動。自動ループはGUIでの人手確認という設計方針上、行わない)。
      setStatus(
        `${t("hidden.sanitize_done", { name: doneName })}\n${t("hidden.sanitize_rescan_note")}`,
      );
      announceSuccess("hidden.sanitize_done", { name: doneName });
    } catch (e) {
      const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      setStatus(t("hidden.sanitize_error", { msg }));
      announceError(msg);
    } finally {
      setSanitizing(false);
    }
  }, [
    filePath,
    groups,
    selectedIds,
    pickSave,
    commitSave,
    t,
    skipType3,
    announceSuccess,
    announceError,
    thr.alpha,
  ]);

  const toggleGroup = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }, []);
  const toggleExpand = useCallback((id: string) => {
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, expanded: !g.expanded } : g)));
  }, []);

  useKeyboardShortcuts({
    "Ctrl+Enter": () => {
      if (!running) {
        tts.speak(t("shortcut.executing"));
        setAllPagesMode(true);
        runDetect(true);
      }
    },
    "Ctrl+Shift+Enter": () => {
      if (!sanitizing && groups.length > 0) {
        tts.speak(t("shortcut.executing"));
        runSanitize();
      }
    },
    F1: () => announceKey("shortcut.tool"),
  });

  const scaleX = pageInfo ? imgNatW / pageInfo.w : 1;
  const scaleY = pageInfo ? imgNatH / pageInfo.h : 1;
  const renderScale = currentRenderScale();
  const typeColor = (t: DetectType) => DETECT_TYPES.find((d) => d.id === t)?.color ?? "#888";
  const typeSummary = DETECT_TYPES.map((dt) => ({
    ...dt,
    gc: groups.filter((g) => g.type === dt.id && !g.isWs).length,
    cc: groups.filter((g) => g.type === dt.id && !g.isWs).reduce((s, g) => s + g.chars.length, 0),
  })).filter((dt) => dt.gc > 0);
  const selCharCount = groups
    .filter((g) => selectedIds.has(g.id))
    .reduce((s, g) => s + g.chars.length, 0);

  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>{t("hidden.title_single")}</span>
      </PageHeader>
      <SingleBanner />
      <div style={layoutStyle}>
        <div
          style={
            isNarrow
              ? { flex: 1, flexDirection: "column", display: "flex", overflow: "auto" }
              : { flex: 1, flexDirection: "row", display: "flex", overflow: "auto" }
          }
        >
          {!isNarrow && settingsCollapsed ? (
            <button
              type="button"
              style={s.paneCollapsedBar}
              onClick={toggleSettingsPane}
              title={t("hidden.settings_pane")}
              aria-label={t("hidden.settings_pane")}
            >
              ▶
            </button>
          ) : (
            <div style={leftStyle}>
              {!isNarrow && (
                <div style={s.paneHead}>
                  <span style={{ flex: 1 }}>{t("hidden.settings_pane")}</span>
                  <button
                    type="button"
                    style={s.paneCollapseBtn}
                    onClick={toggleSettingsPane}
                    title={t("common.collapse_pane")}
                    aria-label={t("common.collapse_pane")}
                  >
                    ◀
                  </button>
                </div>
              )}
              <div style={s.sec}>
                <div style={s.secTitle}>ページ</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button
                    type="button"
                    style={s.navBtn}
                    onClick={() => {
                      setPageIndex((p) => Math.max(0, p - 1));
                      if (!allPagesMode) {
                        setGroups([]);
                        setSelectedIds(new Set());
                        setStatus("");
                      }
                    }}
                    disabled={pageIndex === 0}
                  >
                    ◀
                  </button>
                  <div style={s.pageLbl}>
                    {pageIndex + 1} / {pageCount}
                  </div>
                  <button
                    type="button"
                    style={s.navBtn}
                    onClick={() => {
                      setPageIndex((p) => Math.min(pageCount - 1, p + 1));
                      if (!allPagesMode) {
                        setGroups([]);
                        setSelectedIds(new Set());
                        setStatus("");
                      }
                    }}
                    disabled={pageIndex >= pageCount - 1}
                  >
                    ▶
                  </button>
                </div>
              </div>
              <div>
                <div>検出タイプ</div>
                <div
                  style={
                    // 狭幅時のみ横並びにしていたが、英語ラベルなどで横スクロール
                    // が発生してしまうため撤回し、常に横長表示と同じ縦並びにする
                    { flex: 1, flexDirection: "column", display: "flex", overflow: "auto" }
                  }
                >
                  {DETECT_TYPES.map((dt) => {
                    const on = enabled.has(dt.id);
                    const dtCount = groups.filter((g) => g.type === dt.id && !g.isWs).length;
                    return (
                      <label
                        key={dt.id}
                        style={s.chkRow}
                        title={
                          dtCount > 0
                            ? on
                              ? "チェックを外すとプレビューのハイライトを一時的に非表示にします"
                              : "チェックするとプレビューのハイライトを再表示します"
                            : undefined
                        }
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => {
                            const n = new Set(enabled);
                            e.target.checked ? n.add(dt.id) : n.delete(dt.id);
                            setEnabled(n);
                          }}
                        />
                        <span
                          aria-hidden="true"
                          style={{
                            ...s.typeSwatch,
                            background: dt.color,
                            opacity: on ? 1 : 0.25,
                          }}
                        />
                        <span style={{ opacity: on ? 1 : 0.5 }}>{dt.icon}</span>
                        <span style={{ opacity: on ? 1 : 0.5 }}>{dt.label}</span>
                        {dtCount > 0 && <span style={s.typeCount}>{dtCount}</span>}
                      </label>
                    );
                  })}
                </div>
              </div>

              <button type="button" style={s.thrToggle} onClick={() => setShowThr((v) => !v)}>
                ⚙ 閾値設定 {showThr ? "▲" : "▼"}
              </button>
              {showThr && <ThrPanel thr={thr} setThr={setThr} t={t} />}

              {
                <div style={s.sec}>
                  <div style={s.secTitle}>Type3</div>
                  <label style={s.chkRow}>
                    <input
                      type="checkbox"
                      checked={skipType3}
                      onChange={(e) => setSkipType3(e.target.checked)}
                    />
                    {t("hidden.skip_type3")}
                  </label>
                </div>
              }

              <div style={s.sec}>
                <div style={s.secTitle}>実行</div>
                {status && <div style={s.statusBox}>{status}</div>}
              </div>
            </div>
          )}

          <div style={previewColStyle}>
            <div style={s.zoomBar}>
              <button
                type="button"
                style={s.zoomBtn}
                onClick={zoomOut}
                disabled={!imgSrc || renderScale <= ZOOM_MIN}
                aria-label={t("hidden.zoom_out")}
                title={t("hidden.zoom_out")}
              >
                －
              </button>
              <button
                type="button"
                style={{ ...s.zoomBtn, minWidth: 56 }}
                onClick={zoomFit}
                disabled={!imgSrc}
                aria-label={t("hidden.zoom_fit")}
                title={t("hidden.zoom_fit")}
              >
                {zoom === "fit" ? t("hidden.zoom_fit_short") : `${Math.round(renderScale * 100)}%`}
              </button>
              <button
                type="button"
                style={s.zoomBtn}
                onClick={zoomIn}
                disabled={!imgSrc || renderScale >= ZOOM_MAX}
                aria-label={t("hidden.zoom_in")}
                title={t("hidden.zoom_in")}
              >
                ＋
              </button>
            </div>
            <div
              ref={previewRef}
              style={{
                ...s.preview,
                // ズーム時は中央寄せのままだとブラウザによっては左/上端側へ
                // スクロールしきれないため、拡大中は左上基準に切り替える
                justifyContent: zoom === "fit" ? "center" : "flex-start",
                cursor: isPanning ? "grabbing" : imgSrc ? "grab" : "default",
              }}
              onWheel={handleWheelZoom}
              onPointerDown={handlePanPointerDown}
              onPointerMove={handlePanPointerMove}
              onPointerUp={endPan}
              onPointerLeave={endPan}
              onPointerCancel={endPan}
            >
              {imgSrc ? (
                <div
                  style={
                    zoom === "fit"
                      ? { position: "relative", display: "inline-block" }
                      : {
                          position: "relative",
                          display: "inline-block",
                          width: imgNatW * zoom,
                          height: imgNatH * zoom,
                          flexShrink: 0,
                        }
                  }
                >
                  <img
                    ref={imgRef}
                    src={imgSrc}
                    onLoad={(e) => {
                      setImgNatW(e.currentTarget.naturalWidth);
                      setImgNatH(e.currentTarget.naturalHeight);
                    }}
                    draggable={false}
                    style={
                      zoom === "fit"
                        ? {
                            display: "block",
                            maxWidth: "100%",
                            maxHeight: "100%",
                            userSelect: "none",
                          }
                        : {
                            display: "block",
                            width: "100%",
                            height: "100%",
                            userSelect: "none",
                          }
                    }
                    alt={`p${pageIndex + 1}`}
                  />
                  {groups.length > 0 && imgNatW > 1 && (
                    <svg
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        inset: 0,
                        pointerEvents: "none",
                        overflow: "visible",
                      }}
                      width="100%"
                      height="100%"
                      viewBox={`0 0 ${imgNatW} ${imgNatH}`}
                    >
                      {overlayGroups.map((g) =>
                        g.chars.map((c) => {
                          const q = c.quad;
                          const pts = [
                            `${q[0] * scaleX},${q[1] * scaleY}`,
                            `${q[2] * scaleX},${q[3] * scaleY}`,
                            `${q[6] * scaleX},${q[7] * scaleY}`,
                            `${q[4] * scaleX},${q[5] * scaleY}`,
                          ].join(" ");
                          return (
                            <polygon
                              key={`${g.id}-${q.join(",")}`}
                              points={pts}
                              fill="none"
                              stroke={selectedIds.has(g.id) ? "#22c55e" : typeColor(g.type)}
                              strokeWidth={
                                (selectedIds.has(g.id) ? 3 : 2) / Math.max(renderScale, 0.5)
                              }
                            />
                          );
                        }),
                      )}
                    </svg>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          <div style={groupListStyle}>
            {groups.length > 0 && (
              <>
                <div style={s.statusBox}>
                  {typeSummary.map((dt) => (
                    <span key={dt.id} style={{ marginRight: 8 }}>
                      {dt.icon} {dt.label} {dt.gc}行/{dt.cc}字
                    </span>
                  ))}
                </div>
                {groups.map((g) => {
                  const sel = selectedIds.has(g.id);
                  const icon = DETECT_TYPES.find((d) => d.id === g.type)?.icon ?? "";
                  // 検出タイプのチェックボックスをオフにした行はプレビュー上のハイライト
                  // も非表示になるため、一覧側も減光して現在の表示状態と一致させる
                  // （選択状態やチェック自体は変えない＝再度チェックすれば復元）。
                  const typeHidden = !g.isWs && !enabled.has(g.type);
                  return (
                    <div
                      key={g.id}
                      style={{
                        ...s.groupRow,
                        borderBottom: "1px solid var(--c-border)",
                        background: sel ? "var(--c-accentBg)" : undefined,
                        opacity: typeHidden ? 0.4 : 1,
                      }}
                      {...(g.isWs
                        ? {}
                        : {
                            role: "button" as const,
                            tabIndex: 0,
                            onClick: () => toggleGroup(g.id),
                            onKeyDown: (e: React.KeyboardEvent) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                toggleGroup(g.id);
                              }
                            },
                            "aria-label": t("aria.hidden_group", {
                              label: g.label.slice(0, 40),
                              reason: t(REASON_KEY[g.reason] ?? "hidden.reason_whitespace"),
                              count: String(g.chars.length),
                            }),
                            "aria-pressed": sel,
                          })}
                    >
                      {!g.isWs ? (
                        <input
                          type="checkbox"
                          checked={sel}
                          onChange={() => toggleGroup(g.id)}
                          onClick={(e) => e.stopPropagation()}
                          style={{ flexShrink: 0 }}
                        />
                      ) : (
                        <span style={{ width: 16, flexShrink: 0 }} />
                      )}
                      <span>{icon}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <TapRevealText
                          text={g.label}
                          fullText={g.fullLabel}
                          mobilePlatform={mobilePlatform}
                          style={s.groupLabel}
                        />
                      </span>
                      <span style={s.groupReason}>
                        {t(REASON_KEY[g.reason] ?? "hidden.reason_whitespace")}
                      </span>
                      <span style={s.groupCount}>{g.chars.length}字</span>
                      <button
                        type="button"
                        style={s.expandBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(g.id);
                        }}
                        aria-label={t("aria.hidden_expand", { label: g.label.slice(0, 30) })}
                        aria-expanded={g.expanded}
                      >
                        {g.expanded ? "▲" : "▼"}
                      </button>
                      {g.expanded && (
                        <div style={s.charList}>
                          {g.chars.map((c) => (
                            <div key={`${g.id}-${c.quad.join(",")}`} style={s.charRow}>
                              <span style={s.charCell}>{c.char === " " ? "·" : c.char || "?"}</span>
                              <span>
                                U+
                                {(c.char.codePointAt(0) ?? 0)
                                  .toString(16)
                                  .toUpperCase()
                                  .padStart(4, "0")}
                              </span>
                              <span>
                                ({c.origin[0].toFixed(1)},{c.origin[1].toFixed(1)})
                              </span>
                              {c.extra && <span>{c.extra}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      </div>

      <div style={s.runBar}>
        <button
          type="button"
          style={s.detectBtn}
          onClick={() => {
            setAllPagesMode(false);
            runDetect(false);
          }}
          disabled={running}
          aria-label={`${pageIndex + 1}ページのみ隠しテキスト検出`}
        >
          {running && !allPagesMode ? <Spinner /> : `🔍 ${pageIndex + 1}P`}
        </button>
        {pageCount > 1 && (
          <button
            type="button"
            style={s.detectBtn}
            onClick={() => {
              setAllPagesMode(true);
              runDetect(true);
            }}
            disabled={running}
            aria-label={t("aria.hidden_detect_all_btn")}
          >
            {running && allPagesMode ? <Spinner /> : t("hidden.detect_all_pages")}
          </button>
        )}
        {groups.some((g) => !g.isWs) && (
          <button type="button" style={s.sanBtn} onClick={runSanitize} disabled={sanitizing}>
            {sanitizing ? <Spinner /> : `🧹 無害化 (${selCharCount}字)`}
          </button>
        )}
      </div>
      <div style={s.footer} />
    </div>
  );
}

// ── バナー ────────────────────────────────────────────────────────────────────

function SingleBanner() {
  const { t } = useI18n();
  return (
    <div style={s.expBanner}>
      <div>⚠️</div>
      <div>
        <div style={s.expTitle}>{t("hidden.experimental_title")}</div>
        <div style={s.expBody}>{t("hidden.experimental_body")}</div>
      </div>
    </div>
  );
}

function BatchBanner() {
  const { t } = useI18n();
  return (
    <div style={s.expBanner}>
      <div>⚠️</div>
      <div>
        <div style={s.expTitle}>{t("hidden.experimental_batch_title")}</div>
        <div style={s.expBody}>{t("hidden.experimental_batch_body")}</div>
      </div>
    </div>
  );
}

// ── 閾値パネル共通コンポーネント ───────────────────────────────────────────────

function ThrPanel({
  thr,
  setThr,
  t,
}: {
  thr: Thr;
  setThr: (fn: (prev: Thr) => Thr) => void;
  t: (key: string, vars?: Record<string, string>) => string;
}) {
  const lastThr = loadLastThr();
  // strictAt: そのスライダーで「厳格(検出を絞り込む)」側が min/max どちらか。
  // alpha/contrast/size は数値が小さいほど厳格、cover/lcRatio は数値が
  // 大きいほど厳格(=より高い被覆率/割合を要求する)という、パラメータの
  // 意味上どうしても生じる向きの違いがある。数値の並び自体(左=小さい値/
  // 右=大きい値)はスライダーとして自然なので変えず、代わりに全スライダー
  // 共通で「厳格 ←→ 緩め」の文言をこのフラグに従って実際の向きに配置する
  // ことで、方向の矛盾を解消する。
  const sliders = [
    {
      key: "alpha",
      label: t("hidden.threshold_alpha"),
      min: 0,
      max: 255,
      step: 1,
      strictAt: "min",
    },
    {
      key: "contrast",
      label: t("hidden.threshold_contrast"),
      min: 1,
      max: 21,
      step: 0.1,
      strictAt: "min",
    },
    // lcRatio は low_contrast 用の2つ目のパラメータなので contrast の直後に置き、
    // ラベル自体にも「低コントラスト」を明記して同じ検出タイプへの対応が
    // 一目でわかるようにする(alpha/contrast/size/coverだけだと見た目上
    // どの検出トグルに対応するかが名前からしか判断できなかったため)。
    {
      key: "lcRatio",
      label: t("hidden.threshold_lc_ratio"),
      min: 0.1,
      max: 1,
      step: 0.05,
      strictAt: "max",
    },
    {
      key: "size",
      label: t("hidden.threshold_size"),
      min: 0.1,
      max: 10,
      step: 0.1,
      strictAt: "min",
    },
    {
      key: "cover",
      label: t("hidden.threshold_cover"),
      min: 0.1,
      max: 1,
      step: 0.05,
      strictAt: "max",
    },
  ] as const;

  return (
    <div style={s.thrPanel}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {t("hidden.preset_label")}:{" "}
        {PRESETS.map((p) => {
          const active = JSON.stringify(thr) === JSON.stringify(p.thr);
          return (
            <button
              type="button"
              key={p.id}
              style={{ ...s.smBtn, fontWeight: active ? 700 : 400 }}
              onClick={() => setThr(() => p.thr)}
            >
              {t(p.labelKey)}
            </button>
          );
        })}
        {lastThr && (
          <button type="button" style={s.smBtn} onClick={() => setThr(() => lastThr)}>
            ↩ {t("hidden.preset_last")}
          </button>
        )}
      </div>

      {sliders.map(({ key, label, min, max, step, strictAt }) => (
        <label key={key} style={s.sec}>
          <div style={s.secTitle}>{label}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={thr[key as keyof Thr]}
              onChange={(e) => setThr((prev) => ({ ...prev, [key]: Number(e.target.value) }))}
              style={{ width: "100%" }}
            />
            <span style={s.badge}>
              {key === "alpha"
                ? Math.round(thr[key as keyof Thr])
                : thr[key as keyof Thr].toFixed(step < 0.1 ? 2 : 1)}
            </span>
          </div>
          <div style={s.strictLooseRow}>
            <span>
              {strictAt === "min" ? t("hidden.threshold_strict") : t("hidden.threshold_loose")}
            </span>
            <span>
              {strictAt === "min" ? t("hidden.threshold_loose") : t("hidden.threshold_strict")}
            </span>
          </div>
        </label>
      ))}
      <button type="button" style={s.resetBtn} onClick={() => setThr(() => DEFAULT_THR)}>
        {t("hidden.threshold_reset")}
      </button>
    </div>
  );
}

// ── スタイル ──────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
    fontFamily: F,
    color: "var(--c-text)",
    background: "var(--c-bg)",
    paddingBottom: "calc(env(safe-area-inset-bottom))",
  },
  expBanner: {
    display: "flex",
    gap: 10,
    alignItems: "flex-start",
    background: "#7c3aed18",
    border: "1px solid #7c3aed55",
    borderRadius: 6,
    padding: "7px 12px",
    margin: "5px 8px",
    flexShrink: 0,
  },
  expTitle: { fontSize: FS.small, fontWeight: 700, color: "#a78bfa", marginBottom: 1 },
  expBody: { fontSize: FS.caption, color: "#c4b5fd", lineHeight: 1.5 },
  title: {
    fontSize: FS.title,
    fontWeight: 700,
    color: "var(--c-text)",
    flexShrink: 0,
    whiteSpace: "nowrap" as const,
  },
  layout: { display: "flex", flex: 2, overflow: "hidden" },
  left: {
    width: 230,
    flexShrink: 0,
    overflowY: "auto",
    borderRight: "1px solid var(--c-border)",
    padding: "8px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  right: { flex: 1, display: "flex", flexDirection: "column", overflow: "auto" },
  // 設定タブ（左ペイン）の折りたたみヘッダーと、折りたたみ時に残す帯。
  // 横長画面でのみ使用する（狭幅では左ペインは常時表示のまま）。折りたたむと
  // 左ペイン分の幅が空くが、その空いた分は SingleView 側(previewColStyle /
  // groupListStyle の計算)で検出結果一覧(groupList＝検出したテキストの
  // 表示領域)の幅にそのまま加算される。previewCol の見た目の幅は変わらない。
  paneHead: {
    display: "flex",
    alignItems: "center",
    fontSize: FS.caption,
    fontWeight: 700,
    padding: "2px 2px 6px 2px",
    color: "var(--c-textDim)",
    borderBottom: "1px solid var(--c-border)",
  },
  paneCollapseBtn: {
    flexShrink: 0,
    width: 24,
    height: 24,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "none",
    color: "var(--c-textDim)",
    cursor: "pointer",
    borderRadius: 4,
    fontSize: 11,
  },
  paneCollapsedBar: {
    flexShrink: 0,
    width: 18,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--c-bgCard)",
    borderRight: "1px solid var(--c-border)",
    border: "none",
    borderLeft: "none",
    borderTop: "none",
    borderBottom: "none",
    cursor: "pointer",
    color: "var(--c-textDim)",
    fontSize: 10,
    padding: 0,
  },
  // ズームバー＋プレビュー本体をまとめる列。preview 本体は flex:1 + minHeight:0
  // にして、ズーム時にはみ出た画像をこの中だけでスクロールさせる
  // （外側レイアウト全体が伸びてページごとスクロールしてしまうのを防ぐ）。
  // ここでの flex:2 は "fit" 表示時のデフォルト値。数値ズーム時は
  // SingleView 側の previewColStyle が flex を上書きし、画像の実表示幅相当
  // までに制限した上で、余った幅を groupList(検出結果一覧)に譲る。
  previewCol: {
    flex: 2,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  zoomBar: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 8px",
    flexShrink: 0,
    borderBottom: "1px solid var(--c-border)",
    background: "var(--c-bgSub)",
  },
  zoomBtn: {
    padding: "3px 10px",
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-border)",
    borderRadius: 4,
    cursor: "pointer",
    color: "var(--c-text)",
    fontFamily: F,
    fontSize: FS.body,
    minWidth: 30,
    fontVariantNumeric: "tabular-nums",
  },
  preview: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: "auto",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    padding: 10,
    background: "var(--c-bgSub)",
    touchAction: "pan-x pan-y",
  },
  // 基本スタイル。実際の幅/flex 挙動は SingleView 側の groupListStyle が
  // 状況（狭幅／設定タブ折りたたみ／ズーム倍率）に応じて上書きする。
  groupList: {
    minHeight: 0,
    overflowY: "auto",
    borderTop: "1px solid var(--c-border)",
    flexShrink: 0,
  },
  groupRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 8px",
    cursor: "pointer",
    userSelect: "none",
    fontSize: FS.body,
  },
  groupLabel: {
    flex: 1,
    fontFamily: "monospace",
    fontSize: FS.body,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--c-text)",
  },
  groupReason: {
    fontSize: FS.caption,
    color: "var(--c-textSub)",
    flexShrink: 0,
    whiteSpace: "nowrap",
  },
  groupCount: {
    fontSize: FS.caption,
    color: "var(--c-textDim)",
    flexShrink: 0,
    minWidth: 28,
    textAlign: "right",
  },
  expandBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: "var(--c-textDim)",
    fontSize: FS.caption,
    padding: "0 2px",
    flexShrink: 0,
    fontFamily: F,
  },
  charList: {
    background: "var(--c-bgCard)",
    padding: "4px 24px",
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  charRow: { display: "flex", gap: 8, alignItems: "center", fontSize: FS.small },
  charCell: {
    fontFamily: "monospace",
    background: "var(--c-bg)",
    borderRadius: 2,
    padding: "0 4px",
    minWidth: 20,
    textAlign: "center",
  },
  sec: { display: "flex", flexDirection: "column", gap: 4 },
  strictLooseRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: FS.caption,
    color: "var(--c-textDim)",
    opacity: 0.75,
  },
  secTitle: {
    fontSize: FS.caption,
    fontWeight: 700,
    color: "var(--c-textDim)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
  navBtn: {
    padding: "3px 8px",
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-border)",
    borderRadius: 4,
    cursor: "pointer",
    color: "var(--c-text)",
    fontFamily: F,
    fontSize: FS.body,
  },
  pageLbl: {
    flex: 1,
    textAlign: "center",
    fontSize: FS.body,
    fontVariantNumeric: "tabular-nums",
  },
  chkRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: FS.body,
    cursor: "pointer",
    padding: "1px 0",
  },
  typeSwatch: {
    display: "inline-block",
    width: 10,
    height: 10,
    borderRadius: 2,
    flexShrink: 0,
  },
  typeCount: {
    marginLeft: "auto",
    fontSize: FS.caption,
    color: "var(--c-textDim)",
    fontVariantNumeric: "tabular-nums",
  },
  thrToggle: {
    padding: "4px 8px",
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-border)",
    borderRadius: 4,
    cursor: "pointer",
    color: "var(--c-textSub)",
    fontSize: FS.small,
    fontFamily: F,
    textAlign: "left",
  },
  thrPanel: {
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-border)",
    borderRadius: 5,
    padding: "8px 8px 4px",
  },
  resetBtn: {
    padding: "2px 8px",
    background: "transparent",
    border: "1px solid var(--c-border)",
    borderRadius: 3,
    cursor: "pointer",
    fontSize: FS.caption,
    color: "var(--c-textSub)",
    fontFamily: F,
  },
  detectBtn: {
    padding: "7px 6px",
    background: "var(--c-accentBg)",
    border: "1px solid var(--c-accentBd)",
    borderRadius: 6,
    color: "var(--c-accent)",
    fontWeight: 700,
    fontSize: FS.body,
    cursor: "pointer",
    fontFamily: F,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    width: "100%",
    whiteSpace: "nowrap",
    boxSizing: "border-box",
  },
  sanBtn: {
    padding: "7px 8px",
    background: "#7c3aed18",
    border: "1px solid #7c3aed55",
    borderRadius: 6,
    color: "#a78bfa",
    fontWeight: 700,
    fontSize: FS.body,
    cursor: "pointer",
    fontFamily: F,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    width: "100%",
    boxSizing: "border-box",
  },
  btnDis: { opacity: 0.4, cursor: "not-allowed" },
  badge: {
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-border)",
    borderRadius: 8,
    padding: "0 6px",
    fontSize: FS.caption,
    fontWeight: 600,
  },
  smBtn: {
    padding: "2px 7px",
    background: "transparent",
    border: "1px solid var(--c-border)",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: FS.caption,
    color: "var(--c-textSub)",
    fontFamily: F,
  },
  statusBox: {
    fontSize: FS.small,
    color: "var(--c-textSub)",
    padding: "5px 7px",
    background: "var(--c-bgCard)",
    borderRadius: 4,
    wordBreak: "break-all",
    // sanitize_rescan_note 等、複数行にわたる注記メッセージを
    // \n 区切りで渡した際に改行として表示するため。単発の一行
    // ステータス文字列の見た目には影響しない。
    whiteSpace: "pre-line",
  },
  currentFileBox: {
    fontSize: FS.small,
    color: "var(--c-textSub)",
    padding: "5px 7px",
    background: "var(--c-bgCard)",
    borderRadius: 4,
    maxWidth: 220,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  type3Note: {
    fontSize: FS.small,
    color: "#f59e0b",
    background: "#f59e0b12",
    borderBottom: "1px solid #f59e0b33",
    padding: "6px 10px",
    lineHeight: 1.8,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  type3Btn: {
    padding: "4px 10px",
    background: "#f59e0b22",
    border: "1px solid #f59e0b88",
    borderRadius: 4,
    color: "#f59e0b",
    fontSize: FS.small,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
    display: "flex",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
  },
  logRow: {
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
    gap: "2px 8px",
    fontSize: FS.body,
    padding: "6px 10px",
    background: "var(--c-bgCard)",
    borderRadius: 6,
    border: "1px solid var(--c-border)",
  },
  logFile: {
    fontSize: FS.caption,
    color: "var(--c-textDim)",
    wordBreak: "break-all",
  },
  logMeta: {
    fontSize: FS.small,
    fontWeight: 700,
    color: "var(--c-text)",
    wordBreak: "break-all",
  },
  runBar: {
    display: "flex",
    gap: 8,
    padding: 8,
    borderTop: "1px solid var(--c-border)",
    background: "var(--c-bg)",
    paddingBottom: "12px",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    flexShrink: 0,
    paddingBottom: "calc(env(safe-area-inset-bottom))",
  },
};

export default HiddenTextPage;
