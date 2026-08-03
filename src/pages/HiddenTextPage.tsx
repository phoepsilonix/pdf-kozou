// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// src/pages/HiddenTextPage.tsx — 隠しテキスト検出・無害化（試験的）

import { useState, useCallback, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  renderPage,
  detectTransparentText,
  detectLowContrastText,
  detectTinyText,
  detectBuriedText,
  detectControlChars,
  sanitizeHiddenText,
  sanitizeType3Text,
  type PdfInfo,
  type SanitizeOrigin,
  type PickedFolder,
  joinPath,
  isAndroid,
} from "../lib/tauri";
import {
  buildMobileOutputSubfolder,
  mobileOutputPreviewLabel,
  type MobileSavedFileInfo,
} from "../lib/mobileOutput";
import { useMobileBatchOutput, ANDROID_FOLDER_MISSING } from "../hooks/useMobileBatchOutput";
import { Spinner, PageHeader } from "../components/common";
import { useI18n } from "../lib/i18n";
import { buildName } from "../lib/filename";
import { useA11y } from "../hooks/useA11y";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { tts } from "../lib/tts";
import { F } from "../lib/theme";
import { FS } from "../lib/typography";
import { useSaveDialog } from "../hooks/useSaveDialog";
import { type FileEntry } from "../store/usePdfStore";
import { useViewport } from "../hooks/useViewport";

// ── 型定義 ─────────────────────────────────────────────────────────────────

type DetectType = "transparent" | "low_contrast" | "tiny" | "buried" | "control_chars";

const DETECT_TYPE_DEFS: { id: DetectType; labelKey: string; icon: string; color: string }[] = [
  { id: "transparent", labelKey: "hidden.transparent", icon: "👻", color: "#8b5cf6" },
  { id: "low_contrast", labelKey: "hidden.low_contrast", icon: "🎨", color: "#f59e0b" },
  { id: "tiny", labelKey: "hidden.tiny", icon: "🔬", color: "#10b981" },
  { id: "buried", labelKey: "hidden.buried", icon: "🪦", color: "#ef4444" },
  { id: "control_chars", labelKey: "hidden.control_chars", icon: "⚡", color: "#3b82f6" },
];

const REASON_KEY: Record<string, string> = {
  invisible_mode: "hidden.reason_invisible",
  clip_only_mode: "hidden.reason_clip_only",
  transparent: "hidden.reason_transparent",
  low_contrast: "hidden.reason_low_contrast",
  tiny_font: "hidden.reason_tiny",
  buried: "hidden.reason_buried",
  control_char: "hidden.reason_control",
  whitespace_only: "hidden.reason_whitespace",
};

const DEFAULT_THR = { alpha: 13, contrast: 1.2, size: 2.0, cover: 0.8 };

type Thr = typeof DEFAULT_THR;

const PRESETS: { id: string; labelKey: string; thr: Thr }[] = [
  {
    id: "strict",
    labelKey: "hidden.preset_strict",
    thr: { alpha: 5, contrast: 1.0, size: 1.0, cover: 0.9 },
  },
  {
    id: "normal",
    labelKey: "hidden.preset_normal",
    thr: { alpha: 13, contrast: 1.2, size: 2.0, cover: 0.8 },
  },
  {
    id: "loose",
    labelKey: "hidden.preset_loose",
    thr: { alpha: 30, contrast: 1.5, size: 4.0, cover: 0.6 },
  },
];

const LAST_THR_KEY = "hidden_thr_last";

function loadLastThr(): Thr | null {
  try {
    const raw = localStorage.getItem(LAST_THR_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Thr;
    if (typeof v.alpha === "number" && typeof v.contrast === "number") return v;
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
  internalOrigin: [number, number]; // XObject 内部座標
  page: number; // 検出ページ番号（0始まり）
};

type HitGroup = {
  id: string;
  type: DetectType;
  reason: string;
  label: string;
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
  done: { file: string; hits: number; saved?: string }[];
  errors: { file: string; msg: string }[];
};

function toAnyHits(type: DetectType, hits: any[], pageIdx = 0): AnyHit[] {
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
    xobjXref: (h as any).xobj_xref ?? 0,
    internalOrigin: (h as any).internal_origin ?? [h.origin[0], h.origin[1]],
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

// 検出グリフの先頭 Unicode コードポイントを返す(取り違え防止の文字 identity)。
// 文字が無い/不明の場合は -1(C 層で従来の座標のみ照合にフォールバック)。
function codepointOf(ch: string | undefined): number {
  if (!ch || ch.length === 0) return -1;
  const cp = ch.codePointAt(0);
  return cp === undefined ? -1 : cp;
}

function buildLabel(type: DetectType, reason: string, chars: AnyHit[]): string {
  if (type === "control_chars") return `${chars[0].char} (${chars[0].extra}) × ${chars.length}`;
  const text = chars.map((c) => (c.char === " " ? "·" : c.char)).join("");
  if (text.length <= 60) return `"${text}"`;
  return `"${text.slice(0, 57)}…"`;
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
    } else {
      groups.push({
        id: `${groupKey}::${gid++}::${hit.origin[1].toFixed(0)}`,
        type: hit.type,
        reason: hit.reason,
        label: buildLabel(hit.type, hit.reason, [hit]),
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
        ...toAnyHits("low_contrast", (await detectLowContrastText(path, p, thr.contrast)).hits, p),
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
  useEffect(() => {
    announceScreen("screen.hidden");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return isBatch ? (
    <BatchView batchFiles={batchFiles!} />
  ) : (
    <SingleView filePath={filePath} pdfInfo={pdfInfo} />
  );
}

// ── BatchView ──────────────────────────────────────────────────────────────

function BatchView({ batchFiles }: { batchFiles: FileEntry[] }) {
  const { t } = useI18n();
  const { isNarrow } = useViewport();
  const DETECT_TYPES = DETECT_TYPE_DEFS.map((d) => ({ ...d, label: t(d.labelKey as any) }));
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
      const dir = await open({ directory: true, title: t("hidden.output_dir_dialog" as any) });
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
          setMobileSaveError(t("mobile.save_cancelled" as any));
          return;
        }
        setMobileSavedFiles(saved);
      } catch (e) {
        setMobileSaveError(
          e instanceof Error && e.message === ANDROID_FOLDER_MISSING
            ? t("mobile.save_unsupported" as any)
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
      done: [],
      errors: [],
    };
    setProgress({ ...prog });

    const producedPaths: string[] = [];
    for (let i = 0; i < batchFiles.length; i++) {
      const f = batchFiles[i];
      prog.current = i + 1;
      prog.currentFile = f.filename;
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
          }));
        if (targets.length === 0) {
          prog.done.push({ file: f.filename, hits: 0 });
        } else {
          const outPath = joinPath(resolvedDir, buildName(f.filename, ["sanitized"]));
          await sanitizeHiddenText({ input: f.path, output: outPath, targets, tolerance: 1.5 });
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
          <span style={s.title}>
            {t("hidden.title_batch", { count: String(progress.total) })}
          </span>
        </PageHeader>
        <BatchBanner />
        <div style={layoutStyle}>
          {/* 左: 進捗情報 */}
          <div style={s.left}>
            <div style={s.secTitle}>{t("hidden.batch_processing")}</div>
            <div style={s.statusBox}>
              {progress.current} / {progress.total}
            </div>
            {isNarrow ? (
              <button
                type="button"
                style={{ ...s.currentFileBtn, ...s.currentFileBox }}
                title={progress.currentFile}
                aria-label={`${progress.currentFile} — ${t("common.show_full_filename")}`}
                onClick={() => window.alert(progress.currentFile)}
              >
                {progress.currentFile}
              </button>
            ) : (
              <div style={s.currentFileBox} title={progress.currentFile}>
                {progress.currentFile}
              </div>
            )}
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
          <span style={s.title}>
            {t("hidden.title_batch", { count: String(progress.total) })}
          </span>
        </PageHeader>
        <BatchBanner />
        <div style={layoutStyle}>
          <div style={s.left}>
            <div style={s.statusBox}>{t("hidden.batch_done")}</div>
            <div style={s.statusBox}>
              {t("hidden.batch_sanitized" as any, { count: String(succeeded) })}
            </div>
            <div style={s.statusBox}>
              {t("hidden.batch_skipped" as any, { count: String(skipped) })}
            </div>
            {progress.errors.length > 0 && (
              <div style={s.statusBox}>
                {t("hidden.batch_errors" as any, { count: String(progress.errors.length) })}
              </div>
            )}
            {mobile &&
              (mobileSaveError ? (
                <div style={s.statusBox}>{mobileSaveError}</div>
              ) : mobileSavedFiles ? (
                <>
                  <div style={s.statusBox}>
                    {t("mobile.save_done_summary_folder" as any, {
                      count: String(mobileSavedFiles.length),
                    })}
                  </div>
                  <div style={s.statusBox}>
                    {t("mobile.save_location" as any, {
                      path: androidUI
                        ? (androidFolder?.folderName ?? "")
                        : mobileOutputPreviewLabel(
                            mobileRelativeDir,
                            t("mobile.downloads_root" as any),
                          ),
                    })}
                  </div>
                </>
              ) : (
                <div style={s.statusBox}>{t("mobile.save_preview_pending" as any)}</div>
              ))}
            <button
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
        <span style={s.title}>
          {t("hidden.title_batch", { count: String(batchFiles.length) })}
        </span>
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
          <button style={s.thrToggle} onClick={() => setShowThr((v) => !v)}>
            ⚙ 閾値設定 {showThr ? "▲" : "▼"}
          </button>
          {showThr && <ThrPanel thr={thr} setThr={setThr} t={t} />}
          {/* Type3フォントの扱い */}
          {/*
          <div style={s.sec}>
            <div style={s.secTitle}>Type3</div>
            <label style={s.chkRow}>
              <input
                type="checkbox"
                checked={skipType3}
                onChange={(e) => setSkipType3(e.target.checked)}
              />
              {t("hidden.skip_type3" as any)}
            </label>
          </div>
	  */}
          {/* 出力先フォルダ */}
          <div style={s.sec}>
            <div style={s.secTitle}>出力先フォルダ</div>
            {mobile ? (
              androidUI ? (
                <>
                  <div style={s.statusBox}>
                    {androidFolder?.folderName || t("hidden.output_dir_empty")}
                  </div>
                  <button style={s.navBtn} onClick={() => pickAndroidFolder()}>
                    {t("hidden.output_dir_pick" as any)}
                  </button>
                </>
              ) : (
                <div style={s.statusBox}>
                  {t("mobile.save_preview" as any, {
                    path: mobileOutputPreviewLabel(
                      mobileRelativeDir,
                      t("mobile.downloads_root" as any),
                    ),
                  })}
                </div>
              )
            ) : (
              <>
                <div style={s.statusBox}>{outDir || t("hidden.output_dir_empty")}</div>
                <button style={s.navBtn} onClick={pickDir}>
                  {t("hidden.output_dir_pick" as any)}
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
                {t("hidden.batch_files_label" as any, { count: String(batchFiles.length) })}
              </div>
              {batchFiles.map((f, i) => (
                <div key={f.path} style={s.statusBox}>
                  {i + 1}. {f.filename} {f.pageCount}p
                </div>
              ))}
              {/* 実行ボタン */}
              <button
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
                  t("hidden.batch_run_btn" as any, { count: String(batchFiles.length) })
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
  const DETECT_TYPES = DETECT_TYPE_DEFS.map((d) => ({ ...d, label: t(d.labelKey as any) }));
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
  const [type3Sanitizing, setType3Sanitizing] = useState(false);
  const [status, setStatus] = useState("");
  const [imgSrc, setImgSrc] = useState("");
  const [imgNatW, setImgNatW] = useState(1);
  const [imgNatH, setImgNatH] = useState(1);
  const { pickSave, commitSave } = useSaveDialog();
  const { announceSuccess, announceError, announceKey } = useA11y();
  const [skipType3, setSkipType3] = useState(true);

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
  const rightStyle: React.CSSProperties = isNarrow ? { ...s.right, minHeight: 0 } : s.right;
  const groupListStyle: React.CSSProperties = isNarrow
    ? { ...s.groupList, height: 160 }
    : s.groupList;

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
                (await detectLowContrastText(filePath, p, thr.contrast)).hits,
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
        const grps = groupHits(all);
        setGroups(grps);
        const autoSel = new Set(grps.filter((g) => !g.isWs).map((g) => g.id));
        setSelectedIds(autoSel);
        setStatus(
          all.length === 0
            ? t("hidden.batch_no_detection")
            : effectiveAllPages
              ? `${grps.filter((g) => !g.isWs).length}件検出（${all.length}文字、全${pages.length}ページ）`
              : `${grps.filter((g) => !g.isWs).length}件検出（${all.length}文字）`,
        );
      } catch (e) {
        setStatus(`エラー: ${e}`);
      } finally {
        setRunning(false);
      }
    },
    [filePath, pageIndex, pageCount, enabled, thr, allPagesMode, t],
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
          })),
      );
    if (!targets.length) {
      setStatus(t("hidden.no_targets" as any));
      return;
    }

    const outPath = await pickSave(buildName(filePath, ["sanitized"]));
    if (!outPath) return;
    setSanitizing(true);
    setStatus(t("hidden.sanitize_btn", { chars: String(targets.length) }));
    try {
      await sanitizeHiddenText({ input: filePath, output: outPath, targets, tolerance: 1.5 });
      await commitSave(outPath);
      const doneName = outPath.split(/[/\\]/).pop() ?? "";
      setStatus(t("hidden.sanitize_done", { name: doneName }));
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
        {isNarrow ? (
          <button
            type="button"
            style={{ ...s.subFileBtn, ...s.subFile, maxWidth: 110 }}
            title={filePath}
            aria-label={`${filePath.split(/[/\\]/).pop()} — ${t("common.show_full_filename")}`}
            onClick={() => window.alert(filePath.split(/[/\\]/).pop() ?? "")}
          >
            {filePath.split(/[/\\]/).pop()}
          </button>
        ) : (
          <span style={s.subFile}>{filePath.split(/[/\\]/).pop()}</span>
        )}
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
          <div style={leftStyle}>
            <div style={s.sec}>
              <div style={s.secTitle}>ページ</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
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
                  isNarrow
                    ? { flex: 5, flexDirection: "row", display: "flex", overflow: "auto" }
                    : { flex: 1, flexDirection: "column", display: "flex", overflow: "auto" }
                }
              >
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
                    <span>{dt.icon}</span>
                    <span>{dt.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <button style={s.thrToggle} onClick={() => setShowThr((v) => !v)}>
              ⚙ 閾値設定 {showThr ? "▲" : "▼"}
            </button>
            {showThr && <ThrPanel thr={thr} setThr={setThr} t={t} />}

            {/*
          <div style={s.sec}>
            <div style={s.secTitle}>Type3</div>
            <label style={s.chkRow}>
              <input
                type="checkbox"
                checked={skipType3}
                onChange={(e) => setSkipType3(e.target.checked)}
              />
              {t("hidden.skip_type3" as any)}
            </label>
          </div>
	  */}

            <div style={s.sec}>
              <div style={s.secTitle}>実行</div>
              {status && <div style={s.statusBox}>{status}</div>}
            </div>
          </div>

          <div style={s.preview}>
            {imgSrc ? (
              <div style={{ position: "relative", display: "inline-block" }}>
                <img
                  src={imgSrc}
                  onLoad={(e) => {
                    setImgNatW(e.currentTarget.naturalWidth);
                    setImgNatH(e.currentTarget.naturalHeight);
                  }}
                  style={{ display: "block", maxWidth: "100%", maxHeight: "calc(100dvh - 240px)" }}
                  alt={`p${pageIndex + 1}`}
                />
                {groups.length > 0 && imgNatW > 1 && (
                  <svg
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
                    {displayGroups.map((g) =>
                      g.chars.map((c, ci) => {
                        const q = c.quad;
                        const pts = [
                          `${q[0] * scaleX},${q[1] * scaleY}`,
                          `${q[2] * scaleX},${q[3] * scaleY}`,
                          `${q[6] * scaleX},${q[7] * scaleY}`,
                          `${q[4] * scaleX},${q[5] * scaleY}`,
                        ].join(" ");
                        return (
                          <polygon
                            key={`${g.id}-${ci}`}
                            points={pts}
                            fill="none"
                            stroke={selectedIds.has(g.id) ? "#22c55e" : typeColor(g.type)}
                            strokeWidth={selectedIds.has(g.id) ? 3 : 2}
                          />
                        );
                      }),
                    )}
                  </svg>
                )}
              </div>
            ) : null}
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
                  const color = typeColor(g.type);
                  const icon = DETECT_TYPES.find((d) => d.id === g.type)?.icon ?? "";
                  return (
                    <div
                      key={g.id}
                      style={{
                        ...s.groupRow,
                        borderBottom: "1px solid var(--c-border)",
                        background: sel ? "var(--c-accentBg)" : undefined,
                      }}
                      role={g.isWs ? undefined : "button"}
                      tabIndex={g.isWs ? -1 : 0}
                      onClick={() => !g.isWs && toggleGroup(g.id)}
                      onKeyDown={(e) => {
                        if (!g.isWs && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          toggleGroup(g.id);
                        }
                      }}
                      aria-label={t("aria.hidden_group" as any, {
                        label: g.label.slice(0, 40),
                        reason: t((REASON_KEY[g.reason] ?? "hidden.reason_whitespace") as any),
                        count: String(g.chars.length),
                      })}
                      aria-pressed={g.isWs ? undefined : sel}
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
                      <span style={s.groupLabel}>{g.label}</span>
                      <span style={s.groupReason}>
                        {t((REASON_KEY[g.reason] ?? "hidden.reason_whitespace") as any)}
                      </span>
                      <span style={s.groupCount}>{g.chars.length}字</span>
                      <button
                        style={s.expandBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(g.id);
                        }}
                        aria-label={t("aria.hidden_expand" as any, { label: g.label.slice(0, 30) })}
                        aria-expanded={g.expanded}
                      >
                        {g.expanded ? "▲" : "▼"}
                      </button>
                      {g.expanded && (
                        <div style={s.charList}>
                          {g.chars.map((c, ci) => (
                            <div key={ci} style={s.charRow}>
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
            style={s.detectBtn}
            onClick={() => {
              setAllPagesMode(true);
              runDetect(true);
            }}
            disabled={running}
            aria-label={t("aria.hidden_detect_all_btn" as any)}
          >
            {running && allPagesMode ? <Spinner /> : t("hidden.detect_all_pages" as any)}
          </button>
        )}
        {groups.length > 0 && (
          <button style={s.sanBtn} onClick={runSanitize} disabled={sanitizing}>
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
  const sliders = [
    { key: "alpha", label: t("hidden.threshold_alpha"), min: 0, max: 255, step: 1 },
    { key: "contrast", label: t("hidden.threshold_contrast"), min: 1, max: 21, step: 0.1 },
    { key: "size", label: t("hidden.threshold_size"), min: 0.1, max: 10, step: 0.1 },
    { key: "cover", label: t("hidden.threshold_cover"), min: 0.1, max: 1, step: 0.05 },
  ] as const;

  return (
    <div style={s.thrPanel}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {t("hidden.preset_label")}:{" "}
        {PRESETS.map((p) => {
          const active = JSON.stringify(thr) === JSON.stringify(p.thr);
          return (
            <button
              key={p.id}
              style={{ ...s.smBtn, fontWeight: active ? 700 : 400 }}
              onClick={() => setThr(() => p.thr)}
            >
              {t(p.labelKey as any)}
            </button>
          );
        })}
        {lastThr && (
          <button style={s.smBtn} onClick={() => setThr(() => lastThr)}>
            ↩ {t("hidden.preset_last")}
          </button>
        )}
      </div>

      {sliders.map(({ key, label, min, max, step }) => (
        <label key={key} style={s.sec}>
          <div style={s.secTitle}>{label}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={(thr as any)[key]}
              onChange={(e) => setThr((prev) => ({ ...prev, [key]: Number(e.target.value) }))}
              style={{ width: "100%" }}
            />
            <span style={s.badge}>
              {key === "alpha"
                ? Math.round((thr as any)[key])
                : (thr as any)[key].toFixed(step < 0.1 ? 2 : 1)}
            </span>
          </div>
        </label>
      ))}
      <button style={s.resetBtn} onClick={() => setThr(() => DEFAULT_THR)}>
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
  subFile: {
    fontSize: FS.body,
    color: "var(--c-textSub)",
    maxWidth: 200,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    marginLeft: 8,
  },
  subFileBtn: {
    background: "transparent",
    border: "none",
    padding: 0,
    fontFamily: F,
    cursor: "pointer",
    textAlign: "left" as const,
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
  preview: {
    flex: 2,
    overflow: "auto",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    padding: 10,
    background: "var(--c-bgSub)",
    minHeight: "calc(100dvh - 240px)",
  },
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
  currentFileBtn: {
    background: "transparent",
    border: "none",
    fontFamily: F,
    cursor: "pointer",
    textAlign: "left" as const,
    display: "block",
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
