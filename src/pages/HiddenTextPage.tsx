// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------
// src/pages/HiddenTextPage.tsx — 隠しテキスト検出・無害化（試験的）

import { useState, useCallback, useRef, useEffect } from "react";
import {
  renderPage,
  getPdfInfo,
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

// ── 検出タイプ ─────────────────────────────────────────────────────────────

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

const DEFAULT_THR = { alpha: 13, contrast: 1.5, size: 2.0, cover: 0.8 }; // alpha: 0-255整数 (13≈5%)

type AnyHit = {
  type: DetectType;
  char: string;
  reason: string;
  origin: [number, number];
  quad: [number, number, number, number, number, number, number, number];
  size: number;
  extra: string;
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

// ── HiddenTextPage ─────────────────────────────────────────────────────────

export function HiddenTextPage({ filePath, pdfInfo }: { filePath: string; pdfInfo: PdfInfo }) {
  const [pageIndex, setPageIndex] = useState(0);
  const [enabled, setEnabled] = useState<Set<DetectType>>(new Set(DETECT_TYPES.map((d) => d.id)));
  const [thr, setThr] = useState(DEFAULT_THR);
  const [showThr, setShowThr] = useState(false);
  const [running, setRunning] = useState(false);
  const [hits, setHits] = useState<AnyHit[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [sanitizing, setSanitizing] = useState(false);
  const [status, setStatus] = useState("");
  const [imgSrc, setImgSrc] = useState("");
  const [imgNatW, setImgNatW] = useState(1);
  const [imgNatH, setImgNatH] = useState(1);
  const [filterType, setFilterType] = useState<DetectType | "all">("all");
  const imgRef = useRef<HTMLImageElement>(null);
  const { pickSave } = useSaveDialog();

  const pageCount = pdfInfo.page_count;
  const pageInfo = pdfInfo.pages?.[pageIndex];

  // ── ページレンダリング ──────────────────────────────────────────────────
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

  // 画像のネイティブサイズを取得
  const handleImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setImgNatW(img.naturalWidth);
    setImgNatH(img.naturalHeight);
  }, []);

  // ── 検出 ─────────────────────────────────────────────────────────────────
  const runDetect = useCallback(async () => {
    setRunning(true);
    setHits([]);
    setSelected(new Set());
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

      setHits(all);
      const autoSel = new Set(
        all.map((_, i) => i).filter((i) => all[i].reason !== "whitespace_only"),
      );
      setSelected(autoSel);
      setStatus(all.length === 0 ? "検出なし" : `${all.length}件検出（${autoSel.size}件自動選択）`);
    } catch (e) {
      setStatus(`エラー: ${e}`);
    } finally {
      setRunning(false);
    }
  }, [filePath, pageIndex, enabled, thr]);

  // ── 無害化 ───────────────────────────────────────────────────────────────
  const runSanitize = useCallback(async () => {
    const targets = hits
      .filter((_, i) => selected.has(i))
      .map((h) => ({ x: h.origin[0], y: h.origin[1] }) as SanitizeOrigin);
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
  }, [filePath, hits, selected, pickSave]);

  // ── ハイライト計算 ────────────────────────────────────────────────────────
  const displayHits = filterType === "all" ? hits : hits.filter((h) => h.type === filterType);

  // PDF座標→表示座標のスケール
  // pageInfo.w/h は pt 単位のページサイズ
  // imgNatW/H は96dpiでレンダリングされたピクセルサイズ
  const scaleX = pageInfo ? imgNatW / pageInfo.w : 1;
  const scaleY = pageInfo ? imgNatH / pageInfo.h : 1;

  const typeColor = (t: DetectType) => DETECT_TYPES.find((d) => d.id === t)?.color ?? "#888";

  // ── レンダリング ──────────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      {/* 試験的機能バナー */}
      <div style={s.expBanner}>
        <span style={s.expIcon}>⚠️</span>
        <div>
          <div style={s.expTitle}>試験的機能 — 隠しテキスト検出・無害化</div>
          <div style={s.expBody}>
            全ての隠しテキスト手法を網羅できる保証はありません。
            特殊なプロパティ・フォント・XObjectに潜む隠しテキストは検出できない場合があります。
            本機能の使用による損害について開発者は責任を負いません。
          </div>
        </div>
      </div>

      <div style={s.layout}>
        {/* ── 左パネル ── */}
        <div style={s.left}>
          {/* ページ選択 */}
          <div style={s.sec}>
            <div style={s.secTitle}>ページ</div>
            <div style={s.pageRow}>
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
                <span style={s.chkLabel}>{dt.label}</span>
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
                {[
                  { key: "alpha", label: "透明度閾値 (0-255)", min: 0, max: 255, step: 1 },
                  { key: "contrast", label: "コントラスト閾値", min: 1, max: 21, step: 0.1 },
                  { key: "size", label: "フォントサイズ閾値 pt", min: 0.1, max: 10, step: 0.1 },
                  { key: "cover", label: "被覆率閾値", min: 0.1, max: 1, step: 0.05 },
                ].map(({ key, label, min, max, step }) => (
                  <div key={key} style={{ marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={s.thrLabel}>{label}</span>
                      <span style={s.thrVal}>
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
          {hits.length > 0 && (
            <div style={s.sec}>
              <div style={s.secTitle}>検出結果 {hits.length}件</div>

              {/* タイプ別 */}
              {DETECT_TYPES.map((dt) => {
                const cnt = hits.filter((h) => h.type === dt.id).length;
                if (!cnt) return null;
                return (
                  <div key={dt.id} style={s.sumRow}>
                    <span style={{ color: dt.color }}>
                      {dt.icon} {dt.label}
                    </span>
                    <span style={s.badge}>{cnt}</span>
                  </div>
                );
              })}

              {/* whitespace_only 件数 */}
              {(() => {
                const wc = hits.filter((h) => h.reason === "whitespace_only").length;
                return wc > 0 ? (
                  <div style={{ fontSize: 11, color: "var(--c-textDim)", marginTop: 2 }}>
                    ℹ 空白系 {wc}件（無害化対象外）
                  </div>
                ) : null;
              })()}

              {/* フィルター */}
              <select
                style={s.filterSel}
                value={filterType}
                onChange={(e) => setFilterType(e.target.value as any)}
              >
                <option value="all">すべて</option>
                {DETECT_TYPES.filter((dt) => hits.some((h) => h.type === dt.id)).map((dt) => (
                  <option key={dt.id} value={dt.id}>
                    {dt.icon} {dt.label}
                  </option>
                ))}
              </select>

              {/* 選択操作 */}
              <div style={s.selRow}>
                <button
                  style={s.smBtn}
                  onClick={() =>
                    setSelected(
                      new Set(
                        hits.map((_, i) => i).filter((i) => hits[i].reason !== "whitespace_only"),
                      ),
                    )
                  }
                >
                  全選択
                </button>
                <button style={s.smBtn} onClick={() => setSelected(new Set())}>
                  全解除
                </button>
                <span style={s.selCnt}>{selected.size}件選択</span>
              </div>
            </div>
          )}

          {/* 無害化 */}
          {hits.length > 0 && (
            <button
              style={{ ...s.sanBtn, ...(sanitizing || !selected.size ? s.btnDis : {}) }}
              onClick={runSanitize}
              disabled={sanitizing || !selected.size}
            >
              {sanitizing ? <Spinner /> : `🧹 無害化 (${selected.size}件)`}
            </button>
          )}

          {/* ステータス */}
          {status && <div style={s.statusBox}>{status}</div>}
        </div>

        {/* ── 右パネル: プレビュー + ヒットリスト ── */}
        <div style={s.right}>
          {/* プレビュー */}
          <div style={s.preview}>
            {imgSrc ? (
              <div style={{ position: "relative", display: "inline-block" }}>
                <img
                  ref={imgRef}
                  src={imgSrc}
                  onLoad={handleImgLoad}
                  style={{ display: "block", maxWidth: "100%", maxHeight: "calc(100vh - 240px)" }}
                  alt={`p${pageIndex + 1}`}
                />
                {/* SVGハイライトオーバーレイ */}
                {hits.length > 0 && imgNatW > 1 && (
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
                    {displayHits.map((h, vi) => {
                      const origIdx = hits.indexOf(h);
                      const sel = selected.has(origIdx);
                      const color = typeColor(h.type);
                      const q = h.quad;
                      const pts = [
                        `${q[0] * scaleX},${q[1] * scaleY}`,
                        `${q[2] * scaleX},${q[3] * scaleY}`,
                        `${q[6] * scaleX},${q[7] * scaleY}`,
                        `${q[4] * scaleX},${q[5] * scaleY}`,
                      ].join(" ");
                      const isWs = h.reason === "whitespace_only";
                      return (
                        <polygon
                          key={vi}
                          points={pts}
                          fill={sel ? color + "44" : "transparent"}
                          stroke={isWs ? "#aaa" : color}
                          strokeWidth={sel ? 1.5 : 1}
                          strokeDasharray={isWs ? "3,2" : undefined}
                          opacity={0.9}
                        />
                      );
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

          {/* ヒットリスト */}
          {hits.length > 0 && (
            <div style={s.hitList}>
              {displayHits.map((h, vi) => {
                const origIdx = hits.indexOf(h);
                const sel = selected.has(origIdx);
                const color = typeColor(h.type);
                const isWs = h.reason === "whitespace_only";
                return (
                  <div
                    key={vi}
                    style={{
                      ...s.hitRow,
                      ...(sel ? { background: color + "22", borderColor: color } : {}),
                      ...(isWs ? { opacity: 0.55 } : {}),
                    }}
                    onClick={() => {
                      if (isWs) return;
                      const n = new Set(selected);
                      n.has(origIdx) ? n.delete(origIdx) : n.add(origIdx);
                      setSelected(n);
                    }}
                  >
                    <span style={{ color, fontSize: 13, flexShrink: 0 }}>
                      {DETECT_TYPES.find((d) => d.id === h.type)?.icon}
                    </span>
                    <span
                      style={s.hitChar}
                      title={`U+${(h.char.codePointAt(0) ?? 0).toString(16).toUpperCase()}`}
                    >
                      {h.char === " " ? "SP" : h.char || "?"}
                    </span>
                    <span style={s.hitReason}>{REASON_LABEL[h.reason] ?? h.reason}</span>
                    <span style={s.hitExtra}>{h.extra}</span>
                    <span style={s.hitOrig}>
                      ({h.origin[0].toFixed(0)},{h.origin[1].toFixed(0)})
                    </span>
                    {!isWs && (
                      <input
                        type="checkbox"
                        checked={sel}
                        onChange={() => {
                          const n = new Set(selected);
                          n.has(origIdx) ? n.delete(origIdx) : n.add(origIdx);
                          setSelected(n);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        style={{ flexShrink: 0 }}
                      />
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
    gap: 12,
    alignItems: "flex-start",
    background: "#7c3aed18",
    border: "1px solid #7c3aed55",
    borderRadius: 6,
    padding: "8px 14px",
    margin: "6px 10px",
    flexShrink: 0,
  },
  expIcon: { fontSize: 20, flexShrink: 0, lineHeight: 1.4 },
  expTitle: { fontSize: 12, fontWeight: 700, color: "#a78bfa", marginBottom: 2 },
  expBody: { fontSize: 11, color: "#c4b5fd", lineHeight: 1.5 },
  layout: { display: "flex", flex: 1, overflow: "hidden" },
  left: {
    width: 230,
    flexShrink: 0,
    overflowY: "auto",
    borderRight: "1px solid var(--c-border)",
    padding: "10px 8px",
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
  },
  hitList: {
    maxHeight: 180,
    overflowY: "auto",
    borderTop: "1px solid var(--c-border)",
    flexShrink: 0,
  },
  hitRow: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "3px 8px",
    borderBottom: "1px solid var(--c-border)",
    border: "1px solid transparent",
    borderRadius: 3,
    margin: "2px 4px",
    cursor: "pointer",
    fontSize: 11,
    userSelect: "none",
  },
  hitChar: {
    fontFamily: "monospace",
    background: "var(--c-bgCard)",
    borderRadius: 2,
    padding: "0 3px",
    minWidth: 20,
    textAlign: "center" as const,
    flexShrink: 0,
  },
  hitReason: { color: "var(--c-textSub)", flexShrink: 0, fontSize: 11 },
  hitExtra: { color: "var(--c-textDim)", flex: 1, fontSize: 10 },
  hitOrig: { color: "var(--c-textDim)", fontFamily: "monospace", fontSize: 10, flexShrink: 0 },
  sec: { display: "flex", flexDirection: "column", gap: 4 },
  secTitle: {
    fontSize: 10,
    fontWeight: 700,
    color: "var(--c-textDim)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
  },
  pageRow: { display: "flex", alignItems: "center", gap: 4 },
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
  chkLabel: { fontSize: 12 },
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
  thrLabel: { fontSize: 10, color: "var(--c-textSub)" },
  thrVal: { fontSize: 10, fontWeight: 600 },
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
  sumRow: { display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11 },
  badge: {
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-border)",
    borderRadius: 8,
    padding: "0 6px",
    fontSize: 10,
    fontWeight: 600,
  },
  filterSel: {
    width: "100%",
    padding: "3px 5px",
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-border)",
    borderRadius: 4,
    color: "var(--c-text)",
    fontSize: 11,
    fontFamily: F,
  },
  selRow: { display: "flex", alignItems: "center", gap: 4 },
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
  selCnt: { fontSize: 10, color: "var(--c-textDim)", flex: 1, textAlign: "right" as const },
  statusBox: {
    fontSize: 11,
    color: "var(--c-textSub)",
    padding: "5px 7px",
    background: "var(--c-bgCard)",
    borderRadius: 4,
    wordBreak: "break-all" as const,
  },
};
