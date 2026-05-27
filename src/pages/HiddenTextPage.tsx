// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// src/pages/HiddenTextPage.tsx — 隠しテキスト検出・無害化（試験的）

import { useState, useCallback, useEffect, useRef } from "react";
import {
  renderPage,
  detectTransparentText,
  detectLowContrastText,
  detectTinyText,
  detectBuriedText,
  detectControlChars,
  sanitizeHiddenText,
  type PdfInfo,
  type SanitizeOrigin,
} from "../lib/tauri";
import { Spinner } from "../components/common";
import { F } from "../lib/theme";
import { useSaveDialog } from "../hooks/useSaveDialog";

// ── 型定義 ────────────────────────────────────────────────────────────────

type DetectType = "transparent" | "low_contrast" | "tiny" | "buried" | "control_chars";

const DETECT_TYPES: { id: DetectType; label: string; icon: string; color: string }[] = [
  { id: "transparent", label: "透明テキスト", icon: "👻", color: "#8b5cf6" },
  { id: "low_contrast", label: "低コントラスト", icon: "🎨", color: "#f59e0b" },
  { id: "tiny", label: "極小フォント", icon: "🔬", color: "#10b981" },
  { id: "buried", label: "オブジェクト裏", icon: "🪦", color: "#ef4444" },
  { id: "control_chars", label: "制御文字", icon: "⚡", color: "#3b82f6" },
];

const REASON_LABEL: Record<string, string> = {
  invisible_mode: "Tr=3 完全不可視",
  clip_only_mode: "Tr=7 クリップのみ",
  transparent: "alpha=0",
  low_contrast: "低コントラスト",
  tiny_font: "極小フォント",
  buried: "オブジェクト裏",
  control_char: "制御文字",
  whitespace_only: "空白系文字",
};

const DEFAULT_THR = { alpha: 13, contrast: 1.5, size: 2.0, cover: 0.8 };

// 1文字のヒット情報
type AnyHit = {
  type: DetectType;
  char: string;
  reason: string;
  origin: [number, number];
  quad: [number, number, number, number, number, number, number, number];
  size: number;
  extra: string;
};

// 行グループ（複数文字をまとめたもの）
type HitGroup = {
  id: string; // ユニークID
  type: DetectType;
  reason: string;
  label: string; // 表示テキスト（文章 or コードポイント説明）
  chars: AnyHit[]; // グループ内の文字リスト
  y: number; // 代表y座標
  isWs: boolean; // whitespace_only グループか
  expanded: boolean; // 詳細展開中か
};

function toAnyHits(type: DetectType, hits: any[]): AnyHit[] {
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
  }));
}

// y座標の近傍判定（同じ行とみなす閾値）
const LINE_Y_TOL = 4;

/**
 * ヒット配列をグループ化する。
 * - 同じ type × reason × y座標近傍 → 同一行グループ
 * - 制御文字は category 別にグループ化
 */
function groupHits(hits: AnyHit[]): HitGroup[] {
  const groups: HitGroup[] = [];
  let gid = 0;

  for (const hit of hits) {
    // 制御文字は extra（category）もキーに使う
    const groupKey =
      hit.type === "control_chars"
        ? `${hit.type}::${hit.reason}::${hit.extra}`
        : `${hit.type}::${hit.reason}`;

    // 既存グループへの追加を試みる（y座標が近く同じキー）
    const existing = groups.find(
      (g) => g.id.startsWith(groupKey) && Math.abs(g.y - hit.origin[1]) <= LINE_Y_TOL,
    );

    if (existing) {
      existing.chars.push(hit);
      existing.label = buildLabel(existing.type, existing.reason, existing.chars);
    } else {
      const newGroup: HitGroup = {
        id: `${groupKey}::${gid++}::${hit.origin[1].toFixed(0)}`,
        type: hit.type,
        reason: hit.reason,
        label: buildLabel(hit.type, hit.reason, [hit]),
        chars: [hit],
        y: hit.origin[1],
        isWs: hit.reason === "whitespace_only",
        expanded: false,
      };
      groups.push(newGroup);
    }
  }

  // y座標順にソート
  groups.sort((a, b) => a.y - b.y);
  return groups;
}

/** グループラベルを生成する */
function buildLabel(type: DetectType, reason: string, chars: AnyHit[]): string {
  if (type === "control_chars") {
    // 制御文字: コードポイントと個数を表示
    const cp = chars[0].char; // "U+200B" 形式
    const cat = chars[0].extra;
    return `${cp} (${cat}) × ${chars.length}`;
  }
  // 通常テキスト: 文字を連結して表示
  const text = chars.map((c) => (c.char === " " ? "·" : c.char)).join("");
  if (text.length <= 60) return `"${text}"`;
  return `"${text.slice(0, 57)}…"`;
}

// ── HiddenTextPage ─────────────────────────────────────────────────────────

export function HiddenTextPage({ filePath, pdfInfo }: { filePath: string; pdfInfo: PdfInfo }) {
  const [pageIndex, setPageIndex] = useState(0);
  const [enabled, setEnabled] = useState<Set<DetectType>>(new Set(DETECT_TYPES.map((d) => d.id)));
  const [thr, setThr] = useState(DEFAULT_THR);
  const [showThr, setShowThr] = useState(false);
  const [running, setRunning] = useState(false);
  const [groups, setGroups] = useState<HitGroup[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sanitizing, setSanitizing] = useState(false);
  const [status, setStatus] = useState("");
  const [imgSrc, setImgSrc] = useState("");
  const [imgNatW, setImgNatW] = useState(1);
  const [imgNatH, setImgNatH] = useState(1);
  const { pickSave } = useSaveDialog();

  const pageCount = pdfInfo.page_count;
  const pageInfo = pdfInfo.pages?.[pageIndex];

  // ── レンダリング ────────────────────────────────────────────────────────
  const renderCurrent = useCallback(async () => {
    try {
      const b64 = await renderPage(filePath, pageIndex, 96);
      setImgSrc(`data:image/jpeg;base64,${b64}`);
    } catch (e) {
      console.error("render:", e);
    }
  }, [filePath, pageIndex]);

  useEffect(() => {
    renderCurrent();
  }, [renderCurrent]);

  // ── 検出 ─────────────────────────────────────────────────────────────────
  const runDetect = useCallback(async () => {
    setRunning(true);
    setGroups([]);
    setSelectedIds(new Set());
    setStatus("検出中...");
    const all: AnyHit[] = [];
    try {
      if (enabled.has("transparent"))
        all.push(
          ...toAnyHits(
            "transparent",
            (await detectTransparentText(filePath, pageIndex, thr.alpha)).hits,
          ),
        );
      if (enabled.has("low_contrast"))
        all.push(
          ...toAnyHits(
            "low_contrast",
            (await detectLowContrastText(filePath, pageIndex, thr.contrast)).hits,
          ),
        );
      if (enabled.has("tiny"))
        all.push(...toAnyHits("tiny", (await detectTinyText(filePath, pageIndex, thr.size)).hits));
      if (enabled.has("buried"))
        all.push(
          ...toAnyHits("buried", (await detectBuriedText(filePath, pageIndex, thr.cover)).hits),
        );
      if (enabled.has("control_chars"))
        all.push(
          ...toAnyHits("control_chars", (await detectControlChars(filePath, pageIndex)).hits),
        );

      const grps = groupHits(all);
      setGroups(grps);
      // whitespace_only 以外を自動選択
      const autoSel = new Set(grps.filter((g) => !g.isWs).map((g) => g.id));
      setSelectedIds(autoSel);

      const totalChars = all.length;
      const totalGroups = grps.filter((g) => !g.isWs).length;
      setStatus(totalChars === 0 ? "検出なし" : `${totalGroups}件検出（${totalChars}文字）`);
    } catch (e) {
      setStatus(`エラー: ${e}`);
    } finally {
      setRunning(false);
    }
  }, [filePath, pageIndex, enabled, thr]);

  // ── 無害化 ───────────────────────────────────────────────────────────────
  const runSanitize = useCallback(async () => {
    const targets: SanitizeOrigin[] = groups
      .filter((g) => selectedIds.has(g.id))
      .flatMap((g) => g.chars.map((c) => ({ x: c.origin[0], y: c.origin[1] })));

    if (!targets.length) {
      setStatus("対象が選択されていません");
      return;
    }

    const base = filePath.split(/[/\\]/).pop() ?? "output.pdf";
    const outPath = await pickSave(base.replace(/\.pdf$/i, "_sanitized.pdf"));
    if (!outPath) return;

    setSanitizing(true);
    setStatus("無害化処理中...");
    try {
      await sanitizeHiddenText({ input: filePath, output: outPath, targets, tolerance: 1.5 });
      setStatus(`完了: ${outPath.split(/[/\\]/).pop()}`);
    } catch (e) {
      setStatus(`エラー: ${e}`);
    } finally {
      setSanitizing(false);
    }
  }, [filePath, groups, selectedIds, pickSave]);

  // ── グループ選択トグル ────────────────────────────────────────────────────
  const toggleGroup = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  // ── グループ展開トグル ────────────────────────────────────────────────────
  const toggleExpand = useCallback((id: string) => {
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, expanded: !g.expanded } : g)));
  }, []);

  // ── ハイライト計算 ────────────────────────────────────────────────────────
  const scaleX = pageInfo ? imgNatW / pageInfo.w : 1;
  const scaleY = pageInfo ? imgNatH / pageInfo.h : 1;
  const typeColor = (t: DetectType) => DETECT_TYPES.find((d) => d.id === t)?.color ?? "#888";

  // タイプ別グループ集計
  const typeSummary = DETECT_TYPES.map((dt) => ({
    ...dt,
    groupCount: groups.filter((g) => g.type === dt.id && !g.isWs).length,
    charCount: groups
      .filter((g) => g.type === dt.id && !g.isWs)
      .reduce((s, g) => s + g.chars.length, 0),
  })).filter((dt) => dt.groupCount > 0);

  const selCount = selectedIds.size;
  const selCharCount = groups
    .filter((g) => selectedIds.has(g.id))
    .reduce((s, g) => s + g.chars.length, 0);

  return (
    <div style={s.root}>
      {/* 試験的機能バナー */}
      <div style={s.expBanner}>
        <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
        <div>
          <div style={s.expTitle}>試験的機能 — 隠しテキスト検出・無害化</div>
          <div style={s.expBody}>
            全ての隠しテキスト手法を網羅できる保証はありません。使用による損害について開発者は責任を負いません。
          </div>
        </div>
      </div>

      <div style={s.layout}>
        {/* ── 左パネル ── */}
        <div style={s.left}>
          {/* ページ選択 */}
          <div style={s.sec}>
            <div style={s.secTitle}>ページ</div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button
                style={s.navBtn}
                onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                disabled={pageIndex === 0}
              >
                ◀
              </button>
              <span style={s.pageLbl}>
                {pageIndex + 1} / {pageCount}
              </span>
              <button
                style={s.navBtn}
                onClick={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
                disabled={pageIndex >= pageCount - 1}
              >
                ▶
              </button>
            </div>
          </div>

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
                <span style={{ fontSize: 12 }}>{dt.label}</span>
              </label>
            ))}
          </div>

          {/* 閾値 */}
          <div style={s.sec}>
            <button style={s.thrToggle} onClick={() => setShowThr((v) => !v)}>
              ⚙ 閾値設定 {showThr ? "▲" : "▼"}
            </button>
            {showThr && (
              <div style={s.thrPanel}>
                {(
                  [
                    { key: "alpha", label: "透明度 (0-255)", min: 0, max: 255, step: 1 },
                    { key: "contrast", label: "コントラスト", min: 1, max: 21, step: 0.1 },
                    { key: "size", label: "フォントサイズ pt", min: 0.1, max: 10, step: 0.1 },
                    { key: "cover", label: "被覆率", min: 0.1, max: 1, step: 0.05 },
                  ] as const
                ).map(({ key, label, min, max, step }) => (
                  <div key={key} style={{ marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 10, color: "var(--c-textSub)" }}>{label}</span>
                      <span style={{ fontSize: 10, fontWeight: 600 }}>
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
                      onChange={(e) => setThr((t) => ({ ...t, [key]: Number(e.target.value) }))}
                      style={{ width: "100%" }}
                    />
                  </div>
                ))}
                <button style={s.resetBtn} onClick={() => setThr(DEFAULT_THR)}>
                  リセット
                </button>
              </div>
            )}
          </div>

          {/* 検出実行 */}
          <button
            style={{ ...s.detectBtn, ...(running ? s.btnDis : {}) }}
            onClick={runDetect}
            disabled={running}
          >
            {running ? <Spinner /> : "🔍 検出実行"}
          </button>

          {/* 結果サマリー */}
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
                    fontSize: 11,
                    padding: "1px 0",
                  }}
                >
                  <span style={{ color: dt.color }}>
                    {dt.icon} {dt.label}
                  </span>
                  <span style={s.badge}>
                    {dt.groupCount}行 / {dt.charCount}字
                  </span>
                </div>
              ))}
              {(() => {
                const wc = groups.filter((g) => g.isWs).reduce((s, g) => s + g.chars.length, 0);
                return wc > 0 ? (
                  <div style={{ fontSize: 10, color: "var(--c-textDim)", marginTop: 2 }}>
                    ℹ 空白系 {wc}字（対象外）
                  </div>
                ) : null;
              })()}
              {/* 一括選択 */}
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
                  style={{ fontSize: 10, color: "var(--c-textDim)", flex: 1, textAlign: "right" }}
                >
                  {selCount}行 / {selCharCount}字
                </span>
              </div>
            </div>
          )}

          {/* 無害化 */}
          {groups.length > 0 && (
            <button
              style={{ ...s.sanBtn, ...(sanitizing || !selCount ? s.btnDis : {}) }}
              onClick={runSanitize}
              disabled={sanitizing || !selCount}
            >
              {sanitizing ? <Spinner /> : `🧹 無害化 (${selCharCount}字)`}
            </button>
          )}

          {status && <div style={s.statusBox}>{status}</div>}
        </div>

        {/* ── 右パネル ── */}
        <div style={s.right}>
          {/* プレビュー */}
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
                {/* SVGハイライト */}
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
                    {groups.map((g) => {
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

          {/* グループリスト */}
          {groups.length > 0 && (
            <div style={s.groupList}>
              {groups.map((g) => {
                const sel = selectedIds.has(g.id);
                const color = typeColor(g.type);
                const icon = DETECT_TYPES.find((d) => d.id === g.type)?.icon ?? "";
                return (
                  <div key={g.id} style={{ borderBottom: "1px solid var(--c-border)" }}>
                    {/* グループヘッダー行 */}
                    <div
                      style={{
                        ...s.groupRow,
                        ...(sel
                          ? { background: color + "1a", borderLeft: `3px solid ${color}` }
                          : { borderLeft: "3px solid transparent" }),
                        ...(g.isWs ? { opacity: 0.5 } : {}),
                      }}
                      onClick={() => !g.isWs && toggleGroup(g.id)}
                    >
                      {/* チェック */}
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
                      {/* アイコン */}
                      <span style={{ color, fontSize: 13, flexShrink: 0 }}>{icon}</span>
                      {/* ラベル（検出されたテキスト） */}
                      <span style={s.groupLabel}>{g.label}</span>
                      {/* reason */}
                      <span style={s.groupReason}>{REASON_LABEL[g.reason] ?? g.reason}</span>
                      {/* 文字数 */}
                      <span style={s.groupCount}>{g.chars.length}字</span>
                      {/* 展開ボタン */}
                      <button
                        style={s.expandBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(g.id);
                        }}
                        title="詳細"
                      >
                        {g.expanded ? "▲" : "▼"}
                      </button>
                    </div>
                    {/* 展開: 1文字ずつ表示 */}
                    {g.expanded && (
                      <div style={s.charList}>
                        {g.chars.map((c, ci) => (
                          <div key={ci} style={s.charRow}>
                            <span style={s.charCell}>{c.char === " " ? "·" : c.char || "?"}</span>
                            <span
                              style={{
                                fontSize: 10,
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
                            <span style={{ fontSize: 10, color: "var(--c-textDim)" }}>
                              ({c.origin[0].toFixed(1)}, {c.origin[1].toFixed(1)})
                            </span>
                            {c.extra && (
                              <span style={{ fontSize: 10, color: "var(--c-textDim)" }}>
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
  expTitle: { fontSize: 11, fontWeight: 700, color: "#a78bfa", marginBottom: 1 },
  expBody: { fontSize: 10, color: "#c4b5fd", lineHeight: 1.5 },
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
    fontSize: 12,
  },
  groupLabel: {
    flex: 1,
    fontFamily: "monospace",
    fontSize: 12,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    color: "var(--c-text)",
  },
  groupReason: {
    fontSize: 10,
    color: "var(--c-textSub)",
    flexShrink: 0,
    whiteSpace: "nowrap" as const,
  },
  groupCount: {
    fontSize: 10,
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
    fontSize: 10,
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
  charRow: { display: "flex", gap: 8, alignItems: "center", fontSize: 11 },
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
    fontSize: 10,
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
    fontSize: 12,
  },
  pageLbl: {
    flex: 1,
    textAlign: "center" as const,
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
  },
  chkRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 12,
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
    fontSize: 11,
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
    fontSize: 10,
    color: "var(--c-textSub)",
    fontFamily: F,
  },
  detectBtn: {
    padding: "7px 8px",
    background: "var(--c-accentBg)",
    border: "1px solid var(--c-accentBd)",
    borderRadius: 6,
    color: "var(--c-accent)",
    fontWeight: 700,
    fontSize: 12,
    cursor: "pointer",
    fontFamily: F,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    width: "100%",
    boxSizing: "border-box" as const,
  },
  sanBtn: {
    padding: "7px 8px",
    background: "#7c3aed18",
    border: "1px solid #7c3aed55",
    borderRadius: 6,
    color: "#a78bfa",
    fontWeight: 700,
    fontSize: 12,
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
    fontSize: 10,
    fontWeight: 600,
  },
  smBtn: {
    padding: "2px 7px",
    background: "transparent",
    border: "1px solid var(--c-border)",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 10,
    color: "var(--c-textSub)",
    fontFamily: F,
  },
  statusBox: {
    fontSize: 11,
    color: "var(--c-textSub)",
    padding: "5px 7px",
    background: "var(--c-bgCard)",
    borderRadius: 4,
    wordBreak: "break-all" as const,
  },
};
