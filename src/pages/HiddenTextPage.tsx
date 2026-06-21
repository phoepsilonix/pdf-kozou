// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// src/pages/HiddenTextPage.tsx — 隠しテキスト検出・無害化（試験的）
export default HiddenTextPage;

import { useState, useCallback, useEffect, useMemo } from "react";
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
  joinPath,
} from "../lib/tauri";
import { Spinner } from "../components/common";
import { useI18n } from "../lib/i18n";
import { buildName } from "../lib/filename";
import { useA11y } from "../hooks/useA11y";
import { F } from "../lib/theme";
import { useSaveDialog } from "../hooks/useSaveDialog";
import { type FileEntry } from "../store/usePdfStore";

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

function buildLabel(type: DetectType, reason: string, chars: AnyHit[]): string {
  if (type === "control_chars") {
    return `${chars[0].char} (${chars[0].extra}) × ${chars.length}`;
  }
  const text = chars.map((c) => (c.char === " " ? "·" : c.char)).join("");
  if (text.length <= 60) return `"${text}"`;
  return `"${text.slice(0, 57)}…"`;
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

  return isBatch ? (
    <BatchView batchFiles={batchFiles!} />
  ) : (
    <SingleView filePath={filePath} pdfInfo={pdfInfo} />
  );
}

// ── BatchView ──────────────────────────────────────────────────────────────

function BatchView({ batchFiles }: { batchFiles: FileEntry[] }) {
  const { t } = useI18n();
  const DETECT_TYPES = DETECT_TYPE_DEFS.map((d) => ({ ...d, label: t(d.labelKey as any) }));
  const [enabled, setEnabled] = useState<Set<DetectType>>(
    new Set(DETECT_TYPE_DEFS.map((d) => d.id)),
  );
  const [thr, setThr] = useState<Thr>(() => loadLastThr() ?? DEFAULT_THR);
  const [showThr, setShowThr] = useState(false);
  const [outDir, setOutDir] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [phase, setPhase] = useState<"edit" | "processing" | "result">("edit");
  const [skipType3, setSkipType3] = useState(false);

  const pickDir = useCallback(async (): Promise<string | null> => {
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
  }, [t]);

  const runBatch = useCallback(async () => {
    const resolvedDir = outDir || (await pickDir());
    if (!resolvedDir) return; // キャンセル
    setRunning(true);
    saveLastThr(thr); // 閾値を履歴保存
    setPhase("processing");
    const prog: BatchProgress = {
      current: 0,
      total: batchFiles.length,
      currentFile: "",
      done: [],
      errors: [],
    };
    setProgress({ ...prog });

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
        }
      } catch (e) {
        prog.errors.push({ file: f.filename, msg: String(e) });
      }
      setProgress({ ...prog });
    }
    setRunning(false);
    setPhase("result");
  }, [batchFiles, outDir, enabled, thr, pickDir, skipType3]);

  // ── 処理中画面 ────────────────────────────────────────────────────────────
  if (phase === "processing" && progress) {
    return (
      <div style={s.root}>
        <BatchBanner />
        <div style={s.layout}>
          {/* 左: 進捗情報 */}
          <div style={s.left}>
            <div style={s.sec}>
              <div style={s.secTitle}>{t("hidden.batch_processing")}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "var(--c-accent)" }}>
                {progress.current} / {progress.total}
              </div>
              <div
                style={{
                  background: "var(--c-bgCard)",
                  borderRadius: 6,
                  overflow: "hidden",
                  height: 6,
                }}
              >
                <div
                  style={{
                    background: "var(--c-accent)",
                    height: "100%",
                    width: `${(progress.current / progress.total) * 100}%`,
                    transition: "width 0.3s",
                  }}
                />
              </div>
              <div
                style={{ fontSize: 12, color: "var(--c-textSub)", wordBreak: "break-all" as const }}
              >
                {progress.currentFile}
              </div>
            </div>
          </div>
          {/* 右: ログ */}
          <div style={s.right}>
            <div style={{ padding: 12, overflowY: "auto", flex: 1 }}>
              {progress.done.map((d, i) => (
                <div key={i} style={s.logRow}>
                  <span style={{ color: "var(--c-accent)", flexShrink: 0 }}>✓</span>
                  <span style={s.logFile}>{d.file}</span>
                  <span style={s.logMeta}>
                    {d.hits === 0 ? t("hidden.batch_no_detection") : `${d.hits}字 → ${d.saved}`}
                  </span>
                </div>
              ))}
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
        <BatchBanner />
        <div style={s.layout}>
          {/* 左: サマリー */}
          <div style={s.left}>
            <div style={s.sec}>
              <div style={s.secTitle}>{t("hidden.batch_done")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
                <div style={{ color: "#10b981" }}>
                  {t("hidden.batch_sanitized" as any, { count: String(succeeded) })}
                </div>
                <div style={{ color: "var(--c-textDim)" }}>
                  {t("hidden.batch_skipped" as any, { count: String(skipped) })}
                </div>
                {progress.errors.length > 0 && (
                  <div style={{ color: "#ef4444" }}>
                    {t("hidden.batch_errors" as any, { count: String(progress.errors.length) })}
                  </div>
                )}
              </div>
            </div>
            <button
              style={{ ...s.detectBtn, marginTop: 8 }}
              onClick={() => {
                setPhase("edit");
                setProgress(null);
              }}
            >
              {t("hidden.batch_back")}
            </button>
          </div>
          {/* 右: 詳細リスト */}
          <div style={s.right}>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {progress.done.map((d, i) => (
                <div
                  key={i}
                  style={{
                    ...s.logRow,
                    borderBottom: "1px solid var(--c-border)",
                    padding: "6px 12px",
                  }}
                >
                  <span
                    style={{
                      color: d.hits > 0 ? "var(--c-accent)" : "var(--c-textDim)",
                      flexShrink: 0,
                    }}
                  >
                    {d.hits > 0 ? "✓" : "–"}
                  </span>
                  <span style={s.logFile}>{d.file}</span>
                  <span style={s.logMeta}>
                    {d.hits === 0
                      ? t("hidden.batch_no_detection")
                      : `${d.hits}字無害化 → ${d.saved}`}
                  </span>
                </div>
              ))}
              {progress.errors.map((e, i) => (
                <div
                  key={`e${i}`}
                  style={{
                    ...s.logRow,
                    color: "#ef4444",
                    borderBottom: "1px solid var(--c-border)",
                    padding: "6px 12px",
                  }}
                >
                  <span style={{ flexShrink: 0 }}>✗</span>
                  <span style={s.logFile}>{e.file}</span>
                  <span style={s.logMeta}>{e.msg.slice(0, 60)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── 設定画面 ──────────────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      <BatchBanner />
      <div style={s.layout}>
        {/* 左: 設定・実行 */}
        <div style={s.left}>
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
                <span style={{ fontSize: 13 }}>{dt.label}</span>
              </label>
            ))}
          </div>

          {/* 閾値 */}
          <div style={s.sec}>
            <button style={s.thrToggle} onClick={() => setShowThr((v) => !v)}>
              ⚙ 閾値設定 {showThr ? "▲" : "▼"}
            </button>
            {showThr && <ThrPanel thr={thr} setThr={setThr} t={t} />}
          </div>

          {/* Type3フォントの扱い */}
          {/*
          <div style={s.sec}>
            <label style={{ ...s.chkRow, alignItems: "flex-start" as const }}>
              <input
                type="checkbox"
                checked={skipType3}
                onChange={(e) => setSkipType3(e.target.checked)}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              <span>
                <span style={{ fontSize: 13 }}>{t("hidden.skip_type3" as any)}</span>
                <span
                  style={{
                    display: "block",
                    fontSize: 11,
                    color: "var(--c-textDim)",
                    lineHeight: 1.4,
                    marginTop: 2,
                  }}
                >
                  {t("hidden.type3_warning_body" as any)}
                </span>
              </span>
            </label>
          </div>
	  */}

          {/* 出力先フォルダ */}
          <div style={s.sec}>
            <div style={s.secTitle}>出力先フォルダ</div>
            <div
              style={{
                fontSize: 12,
                color: outDir ? "var(--c-text)" : "var(--c-textDim)",
                background: "var(--c-bgCard)",
                border: "1px solid var(--c-border)",
                borderRadius: 5,
                padding: "4px 7px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap" as const,
              }}
            >
              {outDir || t("hidden.output_dir_empty")}
            </div>
            <button style={s.navBtn} onClick={pickDir}>
              {t("hidden.output_dir_pick" as any)}
            </button>
            <div style={{ fontSize: 11, color: "var(--c-textDim)", lineHeight: 1.4 }}>
              {t("hidden.output_dir_note")}
            </div>
          </div>

          {/* 実行ボタン */}
          <button
            style={{ ...s.sanBtn, ...(running ? s.btnDis : {}) }}
            onClick={runBatch}
            disabled={running}
          >
            {running ? (
              <Spinner />
            ) : (
              t("hidden.batch_run_btn" as any, { count: String(batchFiles.length) })
            )}
          </button>

          {/* 注意書き */}
          <div
            style={{
              fontSize: 11,
              color: "#f59e0b",
              background: "#f59e0b18",
              border: "1px solid #f59e0b44",
              borderRadius: 5,
              padding: "6px 8px",
              lineHeight: 1.5,
            }}
          >
            {t("hidden.batch_warning")}
          </div>
        </div>

        {/* 右: ファイルリスト */}
        <div style={s.right}>
          <div
            style={{
              padding: "8px 12px",
              fontSize: 12,
              color: "var(--c-textDim)",
              borderBottom: "1px solid var(--c-border)",
              flexShrink: 0,
            }}
          >
            {t("hidden.batch_files_label" as any, { count: String(batchFiles.length) })}
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {batchFiles.map((f, i) => (
              <div
                key={f.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 12px",
                  borderBottom: "1px solid var(--c-border)",
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    color: "var(--c-textDim)",
                    minWidth: 28,
                    textAlign: "right" as const,
                    flexShrink: 0,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {i + 1}.
                </span>
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap" as const,
                    color: "var(--c-text)",
                  }}
                >
                  {f.filename}
                </span>
                <span style={{ color: "var(--c-textDim)", flexShrink: 0, fontSize: 12 }}>
                  {f.pageCount}p
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── SingleView ─────────────────────────────────────────────────────────────

function SingleView({ filePath, pdfInfo }: { filePath: string; pdfInfo: PdfInfo }) {
  const { t } = useI18n();
  const DETECT_TYPES = DETECT_TYPE_DEFS.map((d) => ({ ...d, label: t(d.labelKey as any) }));
  const [pageIndex, setPageIndex] = useState(0);
  const [allPagesMode, setAllPagesMode] = useState(false);
  const [enabled, setEnabled] = useState<Set<DetectType>>(
    new Set(DETECT_TYPE_DEFS.map((d) => d.id)),
  );
  const [thr, setThr] = useState<Thr>(() => loadLastThr() ?? DEFAULT_THR);
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
  const { pickSave } = useSaveDialog();
  const { announceSuccess, announceError } = useA11y();
  const [skipType3, setSkipType3] = useState(true);

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

  // 全ページモード時は現在ページのみ表示（useMemo で確実に再計算）
  // 常に現在ページの文字のみ表示（全ページ検出時も同様）
  const displayGroups = useMemo(
    () => groups.filter((g) => g.chars.length > 0 && g.chars[0].page === pageIndex),
    [groups, pageIndex],
  );

  const runDetect = useCallback(
    async (forceAllPages?: boolean) => {
      const effectiveAllPages = forceAllPages ?? allPagesMode;
      setRunning(true);
      setGroups([]);
      setSelectedIds(new Set());
      setStatus("検出中...");
      saveLastThr(thr); // 閾値を履歴保存
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
    [filePath, pageIndex, pageCount, enabled, thr, allPagesMode],
  );

  const runSanitize = useCallback(async () => {
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
            // 文字 identity(取り違え防止): 検出グリフの Unicode とサイズ
            codepoint: codepointOf(c.char),
            size: c.size ?? 0,
          })),
      );
    if (!targets.length) {
      setStatus(t("hidden.no_targets" as any));
      return;
    }
    /*
    const hasType3 =
      !skipType3 && groups.some((g) => selectedIds.has(g.id) && g.chars.some((c) => c.isType3));
    */
    const outPath = await pickSave(buildName(filePath, ["sanitized"]));
    if (!outPath) return;
    setSanitizing(true);
    setStatus(t("hidden.sanitize_btn", { chars: String(targets.length) }));
    try {
      // ① 通常の隠しテキスト無害化
      await sanitizeHiddenText({ input: filePath, output: outPath, targets, tolerance: 1.5 });
      // ② Type3フォントがあれば続けて Type3 無害化（出力ファイルを上書き）
      let type3Msg = "";
      /*
      if (hasType3) {
        setStatus(t("hidden.type3_sanitize_running" as any));
        const res = await sanitizeType3Text(outPath, outPath);
        if (res.removed > 0) type3Msg = ` +Type3(${res.removed})`;
      }
      */
      const doneName = outPath.split(/[/\\]/).pop() ?? "";
      //setStatus(t("hidden.sanitize_done", { name: doneName }) + type3Msg);
      setStatus(t("hidden.sanitize_done", { name: doneName }));
      announceSuccess("hidden.sanitize_done", { name: doneName });
    } catch (e) {
      const msg =
        typeof e === "string"
          ? e
          : e instanceof Error
            ? e.message
            : typeof e === "object" && e !== null && "message" in e
              ? String((e as any).message)
              : JSON.stringify(e);
      setStatus(t("hidden.sanitize_error", { msg }));
      announceError(msg);
    } finally {
      setSanitizing(false);
    }
  }, [filePath, groups, selectedIds, pickSave, t, skipType3]);

  /*
  const runType3Sanitize = useCallback(async () => {
    const outPath = await pickSave(buildName(filePath, ["type3sanitized"]));
    if (!outPath) return;
    setType3Sanitizing(true);
    setStatus(t("hidden.type3_sanitize_running" as any));
    try {
      const res = await sanitizeType3Text(filePath, outPath);
      const name = outPath.split(/[/\\]/).pop() ?? "";
      if (res.removed === 0) {
        setStatus(t("hidden.type3_sanitize_none" as any));
      } else {
        setStatus(
          t("hidden.type3_sanitize_done" as any, {
            removed: String(res.removed),
            name,
          }),
        );
      }
    } catch (e) {
      setStatus(t("hidden.type3_sanitize_error" as any, { msg: String(e) }));
    } finally {
      setType3Sanitizing(false);
    }
  }, [filePath, pickSave, t]);
  */

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
      <SingleBanner />
      <div style={s.layout}>
        {/* 左パネル */}
        <div style={s.left}>
          <div style={s.sec}>
            <div style={s.secTitle}>ページ</div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
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
              <span style={s.pageLbl}>
                {pageIndex + 1} / {pageCount}
              </span>
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
                <span style={{ fontSize: 13 }}>{dt.label}</span>
              </label>
            ))}
          </div>
          <div style={s.sec}>
            <button style={s.thrToggle} onClick={() => setShowThr((v) => !v)}>
              ⚙ 閾値設定 {showThr ? "▲" : "▼"}
            </button>
            {showThr && <ThrPanel thr={thr} setThr={setThr} t={t} />}
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              style={{
                ...s.detectBtn,
                flex: "0 0 auto",
                width: "auto",
                ...(running ? s.btnDis : {}),
              }}
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
                style={{ ...s.detectBtn, flex: 1, ...(running ? s.btnDis : {}) }}
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
          </div>
          {groups.length > 0 && (
            <div style={s.sec}>
              <div style={s.secTitle}>検出結果</div>
              {typeSummary.map((dt) => (
                <div
                  key={dt.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: 12,
                    padding: "1px 0",
                  }}
                >
                  <span style={{ color: dt.color }}>
                    {dt.icon} {dt.label}
                  </span>
                  <span style={s.badge}>
                    {dt.gc}行/{dt.cc}字
                  </span>
                </div>
              ))}
              {(() => {
                const wc = groups.filter((g) => g.isWs).reduce((s, g) => s + g.chars.length, 0);
                return wc > 0 ? (
                  <div style={{ fontSize: 11, color: "var(--c-textDim)", marginTop: 2 }}>
                    {t("hidden.whitespace_note", { count: String(wc) })}
                  </div>
                ) : null;
              })()}
              <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
                <button
                  style={s.smBtn}
                  onClick={() =>
                    setSelectedIds(new Set(groups.filter((g) => !g.isWs).map((g) => g.id)))
                  }
                >
                  全選択
                </button>
                <button style={s.smBtn} onClick={() => setSelectedIds(new Set())}>
                  全解除
                </button>
                <span
                  style={{ fontSize: 11, color: "var(--c-textDim)", flex: 1, textAlign: "right" }}
                >
                  {selectedIds.size}行/{selCharCount}字
                </span>
              </div>
            </div>
          )}
          {groups.length > 0 && (
            <button
              style={{ ...s.sanBtn, ...(sanitizing || !selectedIds.size ? s.btnDis : {}) }}
              onClick={runSanitize}
              disabled={sanitizing || !selectedIds.size}
              aria-label={t("aria.hidden_sanitize_btn" as any, { count: String(selCharCount) })}
            >
              {sanitizing ? <Spinner /> : `🧹 無害化 (${selCharCount}字)`}
            </button>
          )}
          {status && <div style={s.statusBox}>{status}</div>}
        </div>

        {/* 右パネル */}
        <div style={s.right}>
          <div style={s.preview}>
            {imgSrc ? (
              <div style={{ position: "relative", display: "inline-block" }}>
                <img
                  src={imgSrc}
                  onLoad={(e) => {
                    setImgNatW(e.currentTarget.naturalWidth);
                    setImgNatH(e.currentTarget.naturalHeight);
                  }}
                  style={{ display: "block", maxWidth: "100%", maxHeight: "calc(100vh - 260px)" }}
                  alt={`p${pageIndex + 1}`}
                />
                {groups.length > 0 && imgNatW > 1 && (
                  <svg
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: "100%",
                      pointerEvents: "none",
                    }}
                    viewBox={`0 0 ${imgNatW} ${imgNatH}`}
                    preserveAspectRatio="none"
                  >
                    {displayGroups.map((g) => {
                      const sel = selectedIds.has(g.id);
                      const color = typeColor(g.type);
                      return g.chars.map((c, ci) => {
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
                            fill={sel ? color + "44" : "transparent"}
                            stroke={g.isWs ? "#aaa" : color}
                            strokeWidth={sel ? 1.5 : 0.8}
                            strokeDasharray={g.isWs ? "3,2" : undefined}
                            opacity={0.9}
                          />
                        );
                      });
                    })}
                  </svg>
                )}
              </div>
            ) : (
              <div style={{ padding: 40 }}>
                <Spinner />
              </div>
            )}
          </div>
          {groups.length > 0 && (
            <div style={s.groupList}>
              {/* Type3フォント検出時の注記 */}
              {/*
		      groups.some((g) => g.chars.some((c) => c.isType3)) && (
                <div style={s.type3Note}>
                  <div>{t("hidden.type3_note" as any)}</div>
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
                  >
                    <input
                      type="checkbox"
                      checked={skipType3}
                      onChange={(e) => setSkipType3(e.target.checked)}
                    />
                    {t("hidden.skip_type3" as any)}
                  </label>
                </div>
              )
		      */}
              {groups.map((g) => {
                const sel = selectedIds.has(g.id);
                const color = typeColor(g.type);
                const icon = DETECT_TYPES.find((d) => d.id === g.type)?.icon ?? "";
                return (
                  <div key={g.id} style={{ borderBottom: "1px solid var(--c-border)" }}>
                    <div
                      style={{
                        ...s.groupRow,
                        ...(sel
                          ? { background: color + "1a", borderLeft: `3px solid ${color}` }
                          : { borderLeft: "3px solid transparent" }),
                        ...(g.isWs ? { opacity: 0.5 } : {}),
                      }}
                      role={g.isWs ? undefined : "button"}
                      tabIndex={g.isWs ? undefined : 0}
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
                        <span style={{ width: 13, flexShrink: 0 }} />
                      )}
                      <span style={{ color, fontSize: 14, flexShrink: 0 }}>{icon}</span>
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
                    </div>
                    {g.expanded && (
                      <div style={s.charList}>
                        {g.chars.map((c, ci) => (
                          <div key={ci} style={s.charRow}>
                            <span style={s.charCell}>{c.char === " " ? "·" : c.char || "?"}</span>
                            <span
                              style={{
                                fontSize: 11,
                                color: "var(--c-textDim)",
                                fontFamily: "monospace",
                              }}
                            >
                              U+
                              {(c.char.codePointAt(0) ?? 0)
                                .toString(16)
                                .toUpperCase()
                                .padStart(4, "0")}
                            </span>
                            <span style={{ fontSize: 11, color: "var(--c-textDim)" }}>
                              ({c.origin[0].toFixed(1)},{c.origin[1].toFixed(1)})
                            </span>
                            {c.extra && (
                              <span style={{ fontSize: 11, color: "var(--c-textDim)" }}>
                                {c.extra}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── バナー ────────────────────────────────────────────────────────────────────

function SingleBanner() {
  const { t } = useI18n();
  return (
    <div style={s.expBanner}>
      <span style={{ fontSize: 20, flexShrink: 0 }}>⚠️</span>
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
    <div style={{ ...s.expBanner, background: "#f59e0b18", borderColor: "#f59e0b55" }}>
      <span style={{ fontSize: 20, flexShrink: 0 }}>⚠️</span>
      <div>
        <div style={{ ...s.expTitle, color: "#fbbf24" }}>
          {t("hidden.experimental_batch_title")}
        </div>
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
      {/* プリセットボタン */}
      <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" as const }}>
        <span
          style={{ fontSize: 11, color: "var(--c-textDim)", alignSelf: "center", flexShrink: 0 }}
        >
          {t("hidden.preset_label")}:
        </span>
        {PRESETS.map((p) => {
          const active = JSON.stringify(thr) === JSON.stringify(p.thr);
          return (
            <button
              key={p.id}
              style={{
                padding: "2px 8px",
                borderRadius: 4,
                fontSize: 11,
                cursor: "pointer",
                fontFamily: "inherit",
                background: active ? "var(--c-accent)" : "var(--c-bgCard)",
                color: active ? "#fff" : "var(--c-textSub)",
                border: active ? "1px solid var(--c-accent)" : "1px solid var(--c-border)",
                fontWeight: active ? 700 : 400,
              }}
              onClick={() => setThr(() => p.thr)}
            >
              {t(p.labelKey as any)}
            </button>
          );
        })}
        {/* 前回の値 */}
        {lastThr && (
          <button
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              fontSize: 11,
              cursor: "pointer",
              fontFamily: "inherit",
              background: "var(--c-bgCard)",
              color: "var(--c-textSub)",
              border: "1px dashed var(--c-border)",
            }}
            title={`α=${lastThr.alpha} cr=${lastThr.contrast} sz=${lastThr.size} cv=${lastThr.cover}`}
            onClick={() => setThr(() => lastThr)}
          >
            ↩ {t("hidden.preset_last")}
          </button>
        )}
      </div>

      {/* スライダー */}
      {sliders.map(({ key, label, min, max, step }) => (
        <div key={key} style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 11, color: "var(--c-textSub)" }}>{label}</span>
            <span style={{ fontSize: 11, fontWeight: 600 }}>
              {key === "alpha"
                ? Math.round((thr as any)[key])
                : (thr as any)[key].toFixed(step < 0.1 ? 2 : 1)}
            </span>
          </div>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={(thr as any)[key]}
            onChange={(e) => setThr((prev) => ({ ...prev, [key]: Number(e.target.value) }))}
            style={{ width: "100%" }}
          />
        </div>
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
  expTitle: { fontSize: 12, fontWeight: 700, color: "#a78bfa", marginBottom: 1 },
  expBody: { fontSize: 11, color: "#c4b5fd", lineHeight: 1.5 },
  layout: { display: "flex", flex: 1, overflow: "hidden" },
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
  right: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  preview: {
    flex: 1,
    overflow: "auto",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    padding: 10,
    background: "var(--c-bgSub)",
    minHeight: 0,
  },
  groupList: {
    height: 220,
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
    userSelect: "none" as const,
    fontSize: 13,
  },
  groupLabel: {
    flex: 1,
    fontFamily: "monospace",
    fontSize: 13,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    color: "var(--c-text)",
  },
  groupReason: {
    fontSize: 11,
    color: "var(--c-textSub)",
    flexShrink: 0,
    whiteSpace: "nowrap" as const,
  },
  groupCount: {
    fontSize: 11,
    color: "var(--c-textDim)",
    flexShrink: 0,
    minWidth: 28,
    textAlign: "right" as const,
  },
  expandBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: "var(--c-textDim)",
    fontSize: 11,
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
  charRow: { display: "flex", gap: 8, alignItems: "center", fontSize: 12 },
  charCell: {
    fontFamily: "monospace",
    background: "var(--c-bg)",
    borderRadius: 2,
    padding: "0 4px",
    minWidth: 20,
    textAlign: "center" as const,
  },
  sec: { display: "flex", flexDirection: "column", gap: 4 },
  secTitle: {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--c-textDim)",
    textTransform: "uppercase" as const,
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
    fontSize: 13,
  },
  pageLbl: {
    flex: 1,
    textAlign: "center" as const,
    fontSize: 13,
    fontVariantNumeric: "tabular-nums",
  },
  chkRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 13,
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
    fontSize: 12,
    fontFamily: F,
    textAlign: "left" as const,
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
    fontSize: 11,
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
    fontSize: 13,
    cursor: "pointer",
    fontFamily: F,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    width: "100%",
    whiteSpace: "nowrap" as const,
    boxSizing: "border-box" as const,
  },
  sanBtn: {
    padding: "7px 8px",
    background: "#7c3aed18",
    border: "1px solid #7c3aed55",
    borderRadius: 6,
    color: "#a78bfa",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: F,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    width: "100%",
    boxSizing: "border-box" as const,
  },
  btnDis: { opacity: 0.4, cursor: "not-allowed" },
  badge: {
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-border)",
    borderRadius: 8,
    padding: "0 6px",
    fontSize: 11,
    fontWeight: 600,
  },
  smBtn: {
    padding: "2px 7px",
    background: "transparent",
    border: "1px solid var(--c-border)",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 11,
    color: "var(--c-textSub)",
    fontFamily: F,
  },
  statusBox: {
    fontSize: 12,
    color: "var(--c-textSub)",
    padding: "5px 7px",
    background: "var(--c-bgCard)",
    borderRadius: 4,
    wordBreak: "break-all" as const,
  },
  type3Note: {
    fontSize: 12,
    color: "#f59e0b",
    background: "#f59e0b12",
    borderBottom: "1px solid #f59e0b33",
    padding: "6px 10px",
    lineHeight: 1.8,
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  },
  type3Btn: {
    padding: "4px 10px",
    background: "#f59e0b22",
    border: "1px solid #f59e0b88",
    borderRadius: 4,
    color: "#f59e0b",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
    display: "flex",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start" as const,
  },
  logRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "4px 0" },
  logFile: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  logMeta: { fontSize: 12, color: "var(--c-textSub)", flexShrink: 0 },
};
