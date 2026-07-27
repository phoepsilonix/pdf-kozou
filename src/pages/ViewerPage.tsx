// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------
// src/pages/ViewerPage.tsx — MuPDF ビューア（軽量版）
//
// 設計：
//   - レンダリング DPI=96 固定（軽量）、ズームは CSS transform のみ
//   - テキストは行単位の透明 div（DOM 軽量、文字ごとの span は廃止）
//   - 画像表示後に stext を遅延取得
//   - 前後1ページをプリフェッチ
export default ViewerPage;

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  renderPage,
  getPdfInfo,
  getPageText,
  searchPage,
  getPageLinks,
  type PdfInfo,
  type PdfMetadata,
  type STextBlock,
  type PageLink,
} from "../lib/tauri";
import { Spinner, PageHeader } from "../components/common";
import { usePageAnnouncer } from "../hooks/usePageAnnouncer";
import { type FileEntry, usePdfStore } from "../store/usePdfStore";
import { F } from "../lib/theme";
import { getUiScale } from "../lib/uiScale";
import { FS } from "../lib/typography";
import { useI18n } from "../lib/i18n";
import { MetadataEditModal, type PdfMeta } from "../components/MetadataEditModal";
import { useA11y } from "../hooks/useA11y";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useViewport } from "../hooks/useViewport";

// ── 定数 ─────────────────────────────────────────────────────────────────────
const THUMB_DPI = 52;
const RENDER_DPI = 96; // 固定。ズームは CSS transform で対応

// ── ユーティリティ ────────────────────────────────────────────────────────────
function pageAspect(info: PdfInfo | null, i: number): number {
  if (!info?.pages[i]) return 1 / 1.414;
  const p = info.pages[i];
  return (p as any).rotate === 90 || (p as any).rotate === 270 ? p.h / p.w : p.w / p.h;
}
function ptToMm(pt: number) {
  return ((pt * 25.4) / 72).toFixed(1);
}
function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(2)} MB`;
}
function formatDate(d: string): string {
  // PDF形式: D:YYYYMMDDHHmmSS+HH'MM'
  if (d.startsWith("D:")) {
    const s = d.slice(2);
    if (s.length >= 8) {
      const y = s.slice(0, 4),
        m = s.slice(4, 6),
        dd = s.slice(6, 8);
      if (s.length >= 14) return `${y}/${m}/${dd} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
      return `${y}/${m}/${dd}`;
    }
  }
  // EXIF形式: YYYY:MM:DD HH:MM:SS
  if (/^\d{4}:\d{2}:\d{2}/.test(d)) {
    const [datePart, timePart] = d.split(" ");
    const [y, m, dd] = datePart.split(":");
    if (timePart) return `${y}/${m}/${dd} ${timePart.slice(0, 5)}`;
    return `${y}/${m}/${dd}`;
  }
  // ISO8601形式: YYYY-MM-DDTHH:MM:SS
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) {
    const [datePart, timePart] = d.split("T");
    const [y, m, dd] = datePart.split("-");
    if (timePart) return `${y}/${m}/${dd} ${timePart.slice(0, 5)}`;
    return `${y}/${m}/${dd}`;
  }
  return d;
}

// Linux WebKitGTK かどうか（テキスト選択の実装切り替えに使用）
const IS_LINUX_WEBKIT =
  typeof navigator !== "undefined" &&
  navigator.userAgent.includes("Linux") &&
  navigator.userAgent.includes("WebKit") &&
  !navigator.userAgent.includes("Chrome"); // Chromium ベースを除外

// ── TextLayer ─────────────────────────────────────────────────────────────────
// カスタムテキスト選択（char.quad ベース）
// ::selection に依存せずハイライトも位置も正確に制御する。

interface SelChar {
  c: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  lineIdx: number;
  blockIdx: number;
}

interface TextLayerProps {
  blocks: STextBlock[];
  containerW: number;
  containerH: number;
  zoom: number;
  searchHits: GlobalHit[];
  currentHit?: GlobalHit | null;
}

function LinuxTextLayer({
  blocks,
  containerW,
  containerH,
  zoom,
  searchHits,
  currentHit,
}: TextLayerProps) {
  // 全文字フラットリスト（座標順ソート・一度だけ構築）
  const allChars = useMemo<SelChar[]>(() => {
    const list: SelChar[] = [];
    let lineIdx = 0;
    [...blocks]
      .filter((b) => b.type === "text")
      .sort((a, b) =>
        Math.abs(a.bbox.y0 - b.bbox.y0) > 5 ? a.bbox.y0 - b.bbox.y0 : a.bbox.x0 - b.bbox.x0,
      )
      .forEach((block, bi) => {
        [...block.lines]
          .sort((a, b) => a.bbox.y0 - b.bbox.y0)
          .forEach((line) => {
            [...line.chars]
              .sort((a, b) => a.quad[0] - b.quad[0])
              .forEach((ch) => {
                const [ulx, uly, urx, , , lly] = ch.quad;
                list.push({
                  c: ch.c,
                  x0: ulx * zoom,
                  y0: uly * zoom,
                  x1: urx * zoom,
                  y1: lly * zoom,
                  lineIdx,
                  blockIdx: bi,
                });
              });
            lineIdx++;
          });
      });
    return list;
  }, [blocks, zoom]);

  // 行インデックス（高速検索）
  const lineRanges = useMemo(() => {
    const map = new Map<number, { start: number; end: number; y0: number; y1: number }>();
    allChars.forEach((ch, i) => {
      const r = map.get(ch.lineIdx);
      if (!r) map.set(ch.lineIdx, { start: i, end: i, y0: ch.y0, y1: ch.y1 });
      else {
        r.end = i;
        r.y0 = Math.min(r.y0, ch.y0);
        r.y1 = Math.max(r.y1, ch.y1);
      }
    });
    return map;
  }, [allChars]);

  const [selStart, setSelStart] = useState<number | null>(null);
  const [selEnd, setSelEnd] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastMove = useRef(0);

  const charAtPoint = useCallback(
    (x: number, y: number): number | null => {
      if (!allChars.length) return null;

      // Step1: y が bbox 内に完全に収まる行を候補にする
      const inRow: number[] = [];
      lineRanges.forEach((r, li) => {
        if (y >= r.y0 && y <= r.y1) inRow.push(li);
      });

      // Step2: bbox 内の行がなければ y 距離が最小の行
      let hitLine = -1;
      if (inRow.length > 0) {
        // 複数行ヒットした場合は x 方向でも最近傍を選ぶ
        let bestDx = Infinity;
        for (const li of inRow) {
          const { start, end } = lineRanges.get(li)!;
          for (let i = start; i <= end; i++) {
            const dx = Math.abs(x - (allChars[i].x0 + allChars[i].x1) / 2);
            if (dx < bestDx) {
              bestDx = dx;
              hitLine = li;
            }
          }
        }
      } else {
        let bestDy = Infinity;
        lineRanges.forEach((r, li) => {
          const dy = Math.min(Math.abs(y - r.y0), Math.abs(y - r.y1));
          if (dy < bestDy) {
            bestDy = dy;
            hitLine = li;
          }
        });
      }

      if (hitLine < 0) return null;
      const { start, end } = lineRanges.get(hitLine)!;
      let best = start,
        bestDx = Infinity;
      for (let i = start; i <= end; i++) {
        const dx = Math.abs(x - (allChars[i].x0 + allChars[i].x1) / 2);
        if (dx < bestDx) {
          bestDx = dx;
          best = i;
        }
      }
      return best;
    },
    [allChars, lineRanges],
  );

  const relPos = useCallback((e: React.MouseEvent): [number, number] => {
    const r = containerRef.current!.getBoundingClientRect();
    // #root の zoom 下では rect / clientX とも視覚座標になるため、
    // zoom 倍率で割ってコンテナ内部座標（ズーム前 px）へ戻す。
    const z = getUiScale();
    return [(e.clientX - r.left) / z, (e.clientY - r.top) / z];
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      // クリック時にコンテナにフォーカスを移す（検索窓などからフォーカスを外す）
      containerRef.current?.focus();
      const [x, y] = relPos(e);
      const idx = charAtPoint(x, y);
      if (idx === null) return;
      if (e.detail === 2) {
        // ダブルクリック: 単語選択
        const isBound = (c: string) => /[\s　、。]/.test(c);
        let s = idx,
          en = idx;
        while (
          s > 0 &&
          allChars[s - 1].lineIdx === allChars[idx].lineIdx &&
          !isBound(allChars[s - 1].c)
        )
          s--;
        while (
          en < allChars.length - 1 &&
          allChars[en + 1].lineIdx === allChars[idx].lineIdx &&
          !isBound(allChars[en + 1].c)
        )
          en++;
        setSelStart(s);
        setSelEnd(en);
      } else if (e.detail === 3) {
        // トリプルクリック: 行選択
        const li = allChars[idx].lineIdx;
        const r = lineRanges.get(li);
        if (r) {
          setSelStart(r.start);
          setSelEnd(r.end);
        }
      } else if (e.detail >= 4) {
        // 4クリック: ブロック選択
        const bi = allChars[idx].blockIdx;
        const s = allChars.findIndex((c) => c.blockIdx === bi);
        let en = s;
        while (en < allChars.length - 1 && allChars[en + 1].blockIdx === bi) en++;
        setSelStart(s);
        setSelEnd(en);
      } else {
        setSelStart(idx);
        setSelEnd(idx);
        setIsDragging(true);
      }
      e.preventDefault();
    },
    [charAtPoint, relPos, allChars, lineRanges],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return;
      const now = e.timeStamp;
      if (now - lastMove.current < 32) return;
      lastMove.current = now;
      const [x, y] = relPos(e);
      const idx = charAtPoint(x, y);
      if (idx !== null) setSelEnd(idx);
    },
    [isDragging, charAtPoint, relPos],
  );

  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  // 選択テキスト
  const selectedText = useMemo(() => {
    if (selStart === null || selEnd === null) return "";
    const a = Math.min(selStart, selEnd),
      b = Math.max(selStart, selEnd);
    let text = "",
      prevLine = allChars[a]?.lineIdx,
      prevBlock = allChars[a]?.blockIdx;
    for (let i = a; i <= b; i++) {
      const ch = allChars[i];
      if (!ch) continue;
      if (ch.blockIdx !== prevBlock) {
        text += "\n\n";
        prevBlock = ch.blockIdx;
        prevLine = ch.lineIdx;
      } else if (ch.lineIdx !== prevLine) {
        text += "\n";
        prevLine = ch.lineIdx;
      }
      text += ch.c;
    }
    return text;
  }, [selStart, selEnd, allChars]);

  // selectedText を ref で保持（イベントハンドラから常に最新値を参照）
  const selectedTextRef = useRef("");
  selectedTextRef.current = selectedText; // render のたびに同期更新（useEffect 不要）

  // Ctrl+C / Ctrl+A（一度だけ登録）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      if (e.ctrlKey && e.key === "c") {
        const text = selectedTextRef.current;
        if (text) {
          navigator.clipboard.writeText(text).catch(() => {});
          e.preventDefault();
        }
      }
      if (e.ctrlKey && e.key === "a") {
        if (allChars.length > 0) {
          setSelStart(0);
          setSelEnd(allChars.length - 1);
          e.preventDefault();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [allChars]);

  // 選択ハイライト（行単位矩形）
  const selRects = useMemo(() => {
    if (selStart === null || selEnd === null) return [];
    const a = Math.min(selStart, selEnd),
      b = Math.max(selStart, selEnd);
    const lineMap = new Map<number, { x0: number; x1: number; y0: number; y1: number }>();
    for (let i = a; i <= b; i++) {
      const ch = allChars[i];
      if (!ch) continue;
      const r = lineMap.get(ch.lineIdx);
      if (!r) lineMap.set(ch.lineIdx, { x0: ch.x0, x1: ch.x1, y0: ch.y0, y1: ch.y1 });
      else {
        r.x0 = Math.min(r.x0, ch.x0);
        r.x1 = Math.max(r.x1, ch.x1);
        r.y0 = Math.min(r.y0, ch.y0);
        r.y1 = Math.max(r.y1, ch.y1);
      }
    }
    return Array.from(lineMap.values());
  }, [selStart, selEnd, allChars]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: containerW,
        height: containerH,
        overflow: "visible",
        cursor: "text",
        userSelect: "none",
      }}
      tabIndex={-1}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* 選択ハイライト（char.quad 座標で正確に描画） */}
      {selRects.map((r, i) => (
        <div
          key={`sel-${i}`}
          style={{
            position: "absolute",
            left: r.x0,
            top: r.y0,
            width: Math.max(1, r.x1 - r.x0),
            height: Math.max(1, r.y1 - r.y0),
            background: "rgba(100,160,255,0.4)",
            pointerEvents: "none",
          }}
        />
      ))}

      {/* 検索ハイライト */}
      {searchHits.map((hit, i) => {
        const [ulx, uly, urx, , , lly] = hit.quad;
        const isCurrent =
          currentHit &&
          hit.page === currentHit.page &&
          hit.quad[0] === currentHit.quad[0] &&
          hit.quad[1] === currentHit.quad[1];
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: ulx * zoom,
              top: uly * zoom,
              width: (urx - ulx) * zoom,
              height: (lly - uly) * zoom,
              background: isCurrent ? "rgba(255,160,0,0.65)" : "rgba(255,220,0,0.35)",
              border: isCurrent ? "2px solid rgba(255,120,0,0.8)" : "none",
              borderRadius: 2,
              pointerEvents: "none",
            }}
          />
        );
      })}
    </div>
  );
}

// ── Windows/Mac 用ネイティブ選択 TextLayer ───────────────────────────────────────
function NativeTextLayer({
  blocks,
  containerW,
  containerH,
  zoom,
  searchHits,
  currentHit,
}: TextLayerProps) {
  const measureCanvas = useMemo(
    () =>
      typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null,
    [],
  );
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: containerW,
        height: containerH,
        overflow: "visible",
      }}
    >
      {[...blocks]
        .filter((b) => b.type === "text")
        .sort((a, b) =>
          Math.abs(a.bbox.y0 - b.bbox.y0) > 5 ? a.bbox.y0 - b.bbox.y0 : a.bbox.x0 - b.bbox.x0,
        )
        .map((block, bi) => (
          <div
            key={`block-${bi}`}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: containerW,
              height: containerH,
              overflow: "visible",
              userSelect: "text",
              pointerEvents: "none",
            }}
          >
            {[...block.lines]
              .sort((a, b) => a.bbox.y0 - b.bbox.y0)
              .map((line, li) => {
                const text = [...line.chars]
                  .sort((a, b) => a.quad[0] - b.quad[0])
                  .map((c) => c.c)
                  .join("");
                if (!text.trim()) return null;
                const { x0, y0, x1, y1 } = line.bbox;
                const bboxW = Math.max(1, (x1 - x0) * zoom);
                const bboxH = Math.max(1, (y1 - y0) * zoom);
                const fs = bboxH;
                let renderedW = fs * 0.55 * text.length;
                if (measureCanvas) {
                  measureCanvas.font = `${fs}px sans-serif`;
                  const m = measureCanvas.measureText(text).width;
                  if (m > 1) renderedW = m;
                }
                return (
                  <div
                    key={`line-${li}`}
                    style={{
                      position: "absolute",
                      left: x0 * zoom,
                      top: y0 * zoom,
                      width: bboxW,
                      height: bboxH,
                      fontSize: bboxH,
                      lineHeight: `${bboxH}px`,
                      letterSpacing:
                        text.length > 1
                          ? `${(bboxW - renderedW) / Math.max(1, text.length - 1)}px`
                          : "normal",
                      cursor: "text",
                      userSelect: "text",
                      whiteSpace: "pre",
                      overflow: "hidden",
                      pointerEvents: "auto",
                      color: "transparent",
                    }}
                  >
                    {text}
                  </div>
                );
              })}
          </div>
        ))}
      {/* 検索ハイライト */}
      {searchHits.map((hit, i) => {
        const [ulx, uly, urx, , , lly] = hit.quad;
        const isCurrent =
          currentHit &&
          hit.page === currentHit.page &&
          hit.quad[0] === currentHit.quad[0] &&
          hit.quad[1] === currentHit.quad[1];
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: ulx * zoom,
              top: uly * zoom,
              width: (urx - ulx) * zoom,
              height: (lly - uly) * zoom,
              background: isCurrent ? "rgba(255,160,0,0.65)" : "rgba(255,220,0,0.35)",
              border: isCurrent ? "2px solid rgba(255,120,0,0.8)" : "none",
              borderRadius: 2,
              pointerEvents: "none",
            }}
          />
        );
      })}
    </div>
  );
}

// ── TextLayer: OS によって実装を切り替え ──────────────────────────────────────
function TextLayer(props: TextLayerProps) {
  return IS_LINUX_WEBKIT ? <LinuxTextLayer {...props} /> : <NativeTextLayer {...props} />;
}

// ── LinkLayer ─────────────────────────────────────────────────────────────────
function LinkLayer({
  links,
  onNavigate,
  zoom = 1,
}: {
  links: PageLink[];
  onNavigate: (p: number) => void;
  zoom?: number;
}) {
  return (
    <>
      {links.map((link, i) => {
        const { x0, y0, x1, y1 } = link.bbox;
        return (
          <a
            key={i}
            href={link.dest_page != null ? undefined : link.uri}
            target={link.dest_page != null ? undefined : "_blank"}
            rel="noopener noreferrer"
            onClick={
              link.dest_page != null
                ? (e) => {
                    e.preventDefault();
                    onNavigate(link.dest_page!);
                  }
                : undefined
            }
            style={{
              position: "absolute",
              left: x0 * zoom,
              top: y0 * zoom,
              width: (x1 - x0) * zoom,
              height: (y1 - y0) * zoom,
              cursor: "pointer",
              display: "block",
            }}
            title={link.uri}
          />
        );
      })}
    </>
  );
}

// ── MetaRow / InfoDrawer ──────────────────────────────────────────────────────
function MetaRow({ label, value }: { label: string; value?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div style={ds.row}>
      <span style={ds.label}>{label}</span>
      <span style={ds.value} title={value}>
        {value}
      </span>
      <button
        style={{ ...ds.copyBtn, ...(copied ? ds.copyBtnDone : {}) }}
        onClick={() =>
          navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "✓" : "⎘"}
      </button>
    </div>
  );
}

const IMAGE_EXTS_VIEWER = new Set(["jpg", "jpeg", "png", "svg"]);
function isImagePath(p: string) {
  return IMAGE_EXTS_VIEWER.has(p.split(".").pop()?.toLowerCase() ?? "");
}

function InfoDrawer({
  open,
  onClose,
  info,
  filePath,
  fileName,
  onMetaSaved,
}: {
  open: boolean;
  onClose: () => void;
  info: PdfInfo | null;
  filePath: string;
  fileName: string;
  onMetaSaved?: () => void;
}) {
  const { t } = useI18n();
  const { isNarrow } = useViewport();
  const [allCopied, setAllCopied] = useState(false);
  const [metaEditOpen, setMetaEditOpen] = useState(false);
  const meta: PdfMetadata = info?.metadata ?? {};

  const z = getUiScale();
  const innerW = window.innerWidth;
  const DrawerDvh = isNarrow ? 0.8 : 0.6;
  const baseWidth = innerW * DrawerDvh;
  const correctedWidth = Math.floor(baseWidth / (z > 1 ? z : 1));
  // 高さは position:absolute の top:0/bottom:0 に任せる（ViewerPage の root が
  // position:relative になったことで、実際に使えるコンテンツ領域
  // ＝ナビバーの高さ（フローティングメニューのオン/オフ・縦積み/横並び・
  // OSごとの違いを含めて実際にレイアウトされた高さ）を正しく除いた領域に
  // 自動で追従する。以前は window.innerHeight から固定の係数で高さを
  // 見積もっていたが、ナビの高さがフローティングメニューの状態や環境で
  // 変わるため、画面によって余ったり溢れたりしていた。

  // PdfMetadata → PdfMeta 変換（MetadataEditModal 用）
  const toPdfMeta = (): PdfMeta => ({
    title: meta.title,
    author: meta.author,
    subject: meta.subject,
    keywords: meta.keywords,
    creator: meta.creator,
    producer: meta.producer,
    creationDate: meta.creation_date,
    modDate: meta.mod_date,
  });
  const firstPage = info?.pages?.[0];
  const pageSize = firstPage ? `${ptToMm(firstPage.w)} × ${ptToMm(firstPage.h)} mm` : null;
  const hasAnyMeta = !!(
    meta.title ||
    meta.author ||
    meta.subject ||
    meta.keywords ||
    meta.creator ||
    meta.producer ||
    meta.creation_date ||
    meta.mod_date
  );

  const handleCopyAll = () => {
    const lines = [
      fileName && `${t("viewer.meta_filename")}: ${fileName}`,
      filePath && `${t("viewer.meta_path")}: ${filePath}`,
      info?.file_size && `${t("viewer.meta_size")}: ${formatBytes(info.file_size)}`,
      info?.page_count && `${t("viewer.meta_pages")}: ${info.page_count}`,
      meta.title && `タイトル: ${meta.title}`,
      meta.author && `${t("viewer.meta_author")}: ${meta.author}`,
      meta.subject && `${t("viewer.meta_subject")}: ${meta.subject}`,
      meta.keywords && `キーワード: ${meta.keywords}`,
      meta.creator && `アプリ: ${meta.creator}`,
      meta.producer && `${t("viewer.meta_producer")}: ${meta.producer}`,
      meta.creation_date && `${t("viewer.meta_created")}: ${formatDate(meta.creation_date)}`,
      meta.mod_date && `${t("viewer.meta_modified")}: ${formatDate(meta.mod_date)}`,
    ]
      .filter(Boolean)
      .join("\n");
    navigator.clipboard.writeText(lines).then(() => {
      setAllCopied(true);
      setTimeout(() => setAllCopied(false), 1800);
    });
  };

  return (
    <div
      style={{
        ...ds.drawer,
        width: correctedWidth,
        transform: open ? "translateX(0)" : "translateX(100%)",
        pointerEvents: open ? "auto" : "none",
      }}
    >
      <div style={ds.drawerHead}>
        <span style={ds.drawerTitle}>ℹ {t("viewer.info_title")}</span>
        <div style={{ flex: 1 }} />
        {(filePath.toLowerCase().endsWith(".pdf") || isImagePath(filePath)) && (
          <button
            style={{ ...ds.copyBtn, padding: "3px 10px", fontSize: FS.caption }}
            onClick={() => setMetaEditOpen(true)}
            title={t("meta_edit.title")}
            aria-label={t("meta_edit.title")}
          >
            ✏️
          </button>
        )}
        <button
          style={{ ...ds.copyBtn, padding: "3px 10px", fontSize: FS.caption }}
          onClick={handleCopyAll}
        >
          {allCopied ? t("viewer.copied") : t("viewer.copy_all")}
        </button>
        <button style={ds.closeBtn} onClick={onClose}>
          ✕
        </button>
      </div>
      <div style={ds.drawerBody}>
        <div style={ds.section}>{t("viewer.file_section")}</div>
        <div style={ds.row}>
          <span style={ds.label}>{t("viewer.meta_filename")}</span>
          <span style={{ ...ds.value, wordBreak: "break-all" }}>{fileName}</span>
          <button style={ds.copyBtn} onClick={() => navigator.clipboard.writeText(fileName)}>
            ⎘
          </button>
        </div>
        <div style={ds.row}>
          <span style={ds.label}>{t("viewer.meta_path")}</span>
          <span style={{ ...ds.value, wordBreak: "break-all", fontSize: FS.caption }}>
            {filePath}
          </span>
          <button style={ds.copyBtn} onClick={() => navigator.clipboard.writeText(filePath)}>
            ⎘
          </button>
        </div>
        {info?.file_size != null && (
          <div style={ds.row}>
            <span style={ds.label}>{t("viewer.meta_size")}</span>
            <span style={ds.value}>{formatBytes(info.file_size)}</span>
          </div>
        )}
        {info?.page_count != null && (
          <div style={ds.row}>
            <span style={ds.label}>{t("viewer.meta_pages")}</span>
            <span style={ds.value}>
              {info.page_count} {t("viewer.meta_pages")}
            </span>
          </div>
        )}
        {pageSize && (
          <div style={ds.row}>
            <span style={ds.label}>{t("viewer.meta_page_size")}</span>
            <span style={ds.value}>{pageSize}</span>
          </div>
        )}
        <div style={{ ...ds.section, marginTop: 14 }}>{t("viewer.meta_section")}</div>
        {hasAnyMeta ? (
          <>
            <MetaRow label={t("viewer.meta_title")} value={meta.title} />
            <MetaRow label={t("viewer.meta_author")} value={meta.author} />
            <MetaRow label={t("viewer.meta_subject")} value={meta.subject} />
            <MetaRow label={t("viewer.meta_keywords")} value={meta.keywords} />
            <MetaRow label={t("viewer.meta_creator")} value={meta.creator} />
            <MetaRow label={t("viewer.meta_producer")} value={meta.producer} />
            <MetaRow
              label={t("viewer.meta_created")}
              value={meta.creation_date ? formatDate(meta.creation_date) : undefined}
            />
            <MetaRow
              label={t("viewer.meta_modified")}
              value={meta.mod_date ? formatDate(meta.mod_date) : undefined}
            />
          </>
        ) : (
          <div
            style={{
              color: "var(--c-textDim)",
              fontSize: FS.caption,
              padding: "10px 0",
              textAlign: "center",
            }}
          >
            {t("viewer.no_meta")}
          </div>
        )}
      </div>
      {metaEditOpen && (
        <MetadataEditModal
          filePath={filePath}
          initialMeta={isImagePath(filePath) ? undefined : toPdfMeta()}
          onClose={() => setMetaEditOpen(false)}
          onSaved={() => {
            setMetaEditOpen(false);
            onMetaSaved?.();
          }}
        />
      )}
    </div>
  );
}

// ── SearchBar ────────────────────────────────────────────────────────────────
// 全ページ検索 + ヒット間ナビゲーション対応

interface GlobalHit {
  page: number;
  quad: [number, number, number, number, number, number, number, number];
}

interface SearchBarProps {
  path: string;
  totalPages: number;
  currentPage: number;
  onNavigate: (page: number, hit: GlobalHit) => void;
  onAllHits: (hits: GlobalHit[]) => void;
  onClose: () => void;
}

function SearchBar({
  path,
  totalPages,
  currentPage,
  onNavigate,
  onAllHits,
  onClose,
}: SearchBarProps) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [allHits, setAllHits] = useState<GlobalHit[]>([]);
  const [current, setCurrent] = useState(0);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<AbortController | null>(null);

  const doSearch = useCallback(
    async (needle: string) => {
      // 前の検索をキャンセル
      searchRef.current?.abort();
      if (!needle.trim()) {
        setAllHits([]);
        setCurrent(0);
        onAllHits([]);
        return;
      }

      setSearching(true);
      const controller = new AbortController();
      searchRef.current = controller;
      const hits: GlobalHit[] = [];
      const scale = RENDER_DPI / 72.0;

      try {
        // 全ページを検索（現在ページを優先して先に検索）
        const pages = [...Array.from({ length: totalPages }, (_, i) => i)].sort((a, b) => {
          // 現在ページを先頭に
          if (a === currentPage) return -1;
          if (b === currentPage) return 1;
          return a - b;
        });

        for (const p of pages) {
          if (controller.signal.aborted) break;
          try {
            const res = await searchPage(path, p, needle.trim(), scale);
            if (controller.signal.aborted) break;
            if (res.ok && res.hits.length > 0) {
              const pageHits = res.hits.map((h) => ({ page: p, quad: h.quad }));
              hits.push(...pageHits);
              hits.sort((a, b) => a.page - b.page);
              setAllHits([...hits]);
              // 親に全ヒットを通知（ページフィルタは親側で行う）
              onAllHits([...hits]);
            }
          } catch {
            /* ページエラーは無視 */
          }
        }
      } finally {
        setSearching(false);
        if (hits.length > 0) {
          const firstIdx = hits.findIndex((h) => h.page >= currentPage);
          const idx = firstIdx >= 0 ? firstIdx : 0;
          setCurrent(idx);
          onNavigate(hits[idx].page, hits[idx]);
          onAllHits([...hits]);
        }
      }
    },
    [path, totalPages, onNavigate, onAllHits],
  );

  const go = (delta: number) => {
    if (allHits.length === 0) return;
    const next = (current + delta + allHits.length) % allHits.length;
    setCurrent(next);
    const hit = allHits[next];
    onNavigate(hit.page, hit);
    onAllHits([...allHits]); // ページが変わっても全ヒットを保持
  };

  const inputRef = useRef<HTMLInputElement>(null);

  const handleClose = () => {
    setQ("");
    setAllHits([]);
    setCurrent(0);
    onAllHits([]);
    onClose();
  };

  return (
    <div style={ss.bar}>
      <input
        ref={inputRef}
        style={ss.input}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          doSearch(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") go(e.shiftKey ? -1 : 1);
          if (e.key === "Escape") handleClose();
          if (e.ctrlKey && (e.key === "f" || e.key === "F")) {
            e.preventDefault();
            inputRef.current?.focus();
            inputRef.current?.select();
          }
          // Ctrl+Z / Ctrl+Y: WebKitGTK でネイティブが効かない場合の fallback
          if (e.ctrlKey && (e.key === "z" || e.key === "Z")) {
            e.stopPropagation();
            document.execCommand("undo");
          }
          if (e.ctrlKey && (e.key === "y" || e.key === "Y")) {
            e.stopPropagation();
            document.execCommand("redo");
          }
        }}
        placeholder={t("viewer.search_placeholder")}
        className="search-input"
        autoFocus
      />
      {searching && (
        <span style={{ fontSize: FS.caption, color: "var(--c-textDim)" }}>
          {t("viewer.searching")}
        </span>
      )}
      {!searching && q && (
        <span style={ss.count}>
          {allHits.length === 0
            ? t("viewer.no_hits")
            : t("viewer.hit_count", {
                current: String(current + 1),
                total: String(allHits.length),
              })}
        </span>
      )}
      {allHits.length > 0 && (
        <>
          <button style={ss.navBtn} onClick={() => go(-1)} title={t("viewer.prev_hit")}>
            ◀
          </button>
          <button style={ss.navBtn} onClick={() => go(1)} title={t("viewer.next_hit")}>
            ▶
          </button>
        </>
      )}
      <button style={ss.close} onClick={handleClose}>
        ✕
      </button>
    </div>
  );
}

// ── メインコンポーネント ──────────────────────────────────────────────────────
interface Props {
  filePath?: string;
  pdfInfo?: PdfInfo;
  fileList?: FileEntry[];
}

export function ViewerPage({ filePath, pdfInfo, fileList = [] }: Props) {
  const isMulti = fileList.length > 1;
  const [activeIdx, setActiveIdx] = useState(0);
  // ファイル一覧／サムネイルパネルの折りたたみ状態。
  // 横長PDF表示時など画面が狭く感じる場合に手動で隠せるようにする。
  // 設定は端末に永続化し、次回起動時も維持する。
  const [filePaneCollapsed, setFilePaneCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("pdf-kozou-viewer-filepane-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const [thumbPaneCollapsed, setThumbPaneCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("pdf-kozou-viewer-thumbpane-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleFilePane = () => {
    setFilePaneCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("pdf-kozou-viewer-filepane-collapsed", next ? "1" : "0");
      } catch {}
      return next;
    });
  };
  const toggleThumbPane = () => {
    setThumbPaneCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("pdf-kozou-viewer-thumbpane-collapsed", next ? "1" : "0");
      } catch {}
      return next;
    });
  };
  const { announceScreen, announceKey, announce } = useA11y();
  const { t } = useI18n();
  const { isNarrow } = useViewport();

  // 画面表示時の読み上げ
  useEffect(() => {
    announceScreen("screen.viewer");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ショートカット（ビューワー固有）
  useKeyboardShortcuts({
    ArrowLeft: () => setViewPage((p) => Math.max(0, p - 1)),
    ArrowRight: () => setViewPage((p) => Math.min(total - 1, p + 1)),
    "Ctrl+F": () => {
      if (showSearch) {
        // すでに開いていれば検索窓にフォーカスを戻すだけ
        const input = document.querySelector<HTMLInputElement>(".search-input");
        input?.focus();
        input?.select();
      } else {
        setShowSearch(true);
      }
    },
    F1: () => announceKey("shortcut.viewer"),
  });
  const [activeInfo, setActiveInfo] = useState<PdfInfo | null>(pdfInfo ?? null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [viewPage, setViewPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [zoom, setZoom] = useState(isNarrow ? 0.5 : 1.0);
  // 左ペインで選択中ページが変わったら「何ページ目か」を読み上げる
  usePageAnnouncer(viewPage, total);

  // ホーム画面のレイアウト設定（リフロー可能文書用）
  const { convertLayoutW, convertLayoutH, convertLayoutEm } = usePdfStore();

  // メイン画像キャッシュ（path → page → b64）
  const imgCache = useRef<Map<string, Map<number, string>>>(new Map());

  // 表示中ページの状態
  const [mainImg, setMainImg] = useState<string>("");
  const [mainLoading, setMainLoading] = useState(false);
  const [imgNaturalW, setImgNaturalW] = useState(0);
  const [imgNaturalH, setImgNaturalH] = useState(0);

  // stext（遅延取得）
  const [textBlocks, setTextBlocks] = useState<STextBlock[]>([]);
  const [pageLinks, setPageLinks] = useState<PageLink[]>([]);
  // 検索: 全ヒット一覧（SearchBar が管理）+ カレントヒット
  const [allSearchHits, setAllSearchHits] = useState<GlobalHit[]>([]);
  const [currentHit, setCurrentHit] = useState<GlobalHit | null>(null);
  // viewPage から派生: 現在ページのヒットのみ（別ページのヒット混入を防ぐ）
  const pageSearchHits = allSearchHits.filter((h) => h.page === viewPage);

  // サムネイル
  const thumbCache = useRef<Map<string, (string | undefined)[]>>(new Map());
  const [thumbs, setThumbs] = useState<(string | undefined)[]>([]);
  const [fileCoverThumbs, setFileCoverThumbs] = useState<Map<string, string>>(new Map());

  // スクロールコンテナの ref（ヒット位置へのスクロール用）
  const scrollRef = useRef<HTMLDivElement>(null);
  // ページジャンプ後にスクロールすべきヒット座標
  const pendingScrollHit = useRef<GlobalHit | null>(null);

  // ヒット位置へスクロールする共通処理
  const scrollToHit = useCallback(
    (hit: GlobalHit) => {
      if (!scrollRef.current) return;
      const [ulx, uly, urx, , , lly] = hit.quad;
      const hitCenterX = ((ulx + urx) / 2) * zoom;
      const hitCenterY = ((uly + lly) / 2) * zoom;
      const container = scrollRef.current;
      container.scrollTo({
        left: hitCenterX - container.clientWidth / 2 + 24,
        top: hitCenterY - container.clientHeight / 2 + 24,
        behavior: "smooth",
      });
    },
    [zoom],
  );

  const activePath = isMulti
    ? fileList[activeIdx]?.path || ""
    : filePath || fileList[0]?.path || "";

  // currentHit が変わったとき（同ページ内移動）スクロール
  useEffect(() => {
    if (!currentHit || !scrollRef.current) return;
    // pendingScrollHit がある場合は onLoad 側で処理（別ページジャンプ直後）
    if (pendingScrollHit.current) return;
    scrollToHit(currentHit);
  }, [currentHit, zoom]);

  // ページジャンプ後、キャッシュ済み画像では onLoad が発火しない場合のフォールバック
  useEffect(() => {
    if (!pendingScrollHit.current) return;
    const hit = pendingScrollHit.current;
    if (hit.page !== viewPage) return;
    // 少し待ってから（レンダリング後）スクロール
    const timer = setTimeout(() => {
      if (pendingScrollHit.current === hit) {
        pendingScrollHit.current = null;
        scrollToHit(hit);
      }
    }, 80);
    return () => clearTimeout(timer);
  }, [viewPage]);

  // ── 1. ページ情報 ──────────────────────────────────────────────────────────
  // パスまたはレイアウトが変わったときのみ getPdfInfo を呼ぶ
  const lastInfoKey = useRef<string>("");

  useEffect(() => {
    const path = isMulti ? fileList[activeIdx]?.path || "" : activePath;

    if (!path) {
      if (pdfInfo) {
        setActiveInfo(pdfInfo);
        setTotal(pdfInfo.page_count);
      }
      return;
    }

    // パスとレイアウトの組み合わせが変わったときだけ再取得
    // lastInfoKey が "" の場合はメタデータ更新後の強制再取得なのでスキップしない
    const infoKey = `${path}::${convertLayoutW}x${convertLayoutH}em${convertLayoutEm}`;
    if (infoKey === lastInfoKey.current) return;
    lastInfoKey.current = infoKey;

    // PDF かつ pdfInfo が既に渡されていれば通常は再取得不要
    // ただし onMetaSaved で lastInfoKey を "" にリセットした場合は強制再取得
    // （infoKey !== "" なので再取得フローに入ってきているはず）
    const isPdf = path.toLowerCase().endsWith(".pdf");
    const forceRefresh = lastInfoKey.current === infoKey && infoKey !== "";
    if (isPdf && pdfInfo && !isMulti && !forceRefresh) {
      setActiveInfo(pdfInfo);
      setTotal(pdfInfo.page_count);
      return;
    }

    getPdfInfo(path, {
      layoutW: convertLayoutW,
      layoutH: convertLayoutH,
      layoutEm: convertLayoutEm,
    })
      .then((i) => {
        setActiveInfo(i);
        setTotal(i.page_count);
      })
      .catch(() => {
        if (pdfInfo) {
          setActiveInfo(pdfInfo);
          setTotal(pdfInfo.page_count);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, isMulti, activePath, convertLayoutW, convertLayoutH, convertLayoutEm]);

  // レイアウト変更時にレンダリングキャッシュをクリア（非 PDF 用）
  const lastLayoutKey = useRef(`${convertLayoutW}x${convertLayoutH}em${convertLayoutEm}`);
  useEffect(() => {
    const key = `${convertLayoutW}x${convertLayoutH}em${convertLayoutEm}`;
    if (key === lastLayoutKey.current) return;
    lastLayoutKey.current = key;
    // 非 PDF のキャッシュのみクリア（PDF はレイアウト不変）
    for (const path of [...imgCache.current.keys()]) {
      if (!path.toLowerCase().endsWith(".pdf")) {
        imgCache.current.delete(path);
        thumbCache.current.delete(path);
      }
    }
    // infoKey もリセットして再取得を促す
    lastInfoKey.current = "";
  }, [convertLayoutW, convertLayoutH, convertLayoutEm]);

  // 非 PDF ファイルの変換済みパスキャッシュ（変換は1回だけ）
  // ── 2. メイン画像レンダリング（キャッシュ付き）────────────────────────────
  const getOrRender = useCallback(
    async (path: string, page: number): Promise<string> => {
      if (!imgCache.current.has(path)) imgCache.current.set(path, new Map());
      const pageMap = imgCache.current.get(path)!;
      if (pageMap.has(page)) return pageMap.get(page)!;
      const b64 = await renderPage(path, page, RENDER_DPI, {
        layoutW: convertLayoutW,
        layoutH: convertLayoutH,
        layoutEm: convertLayoutEm,
      });
      pageMap.set(page, b64);
      return b64;
    },
    [convertLayoutW, convertLayoutH, convertLayoutEm],
  );

  // プリフェッチ（前後1ページ）
  const prefetch = useCallback(
    (path: string, page: number, max: number) => {
      [page - 1, page + 1]
        .filter((p) => p >= 0 && p < max)
        .forEach((p) => {
          getOrRender(path, p).catch(() => {});
        });
    },
    [getOrRender],
  );

  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;

    setTextBlocks([]);
    setPageLinks([]);
    // 検索ヒットはページが変わってもクリアしない（SearchBar が管理）

    // キャッシュがあれば即表示
    const cached = imgCache.current.get(activePath)?.get(viewPage);
    if (cached) {
      setMainImg(cached);
      setMainLoading(false);
    } else {
      setMainLoading(true);
    }

    (async () => {
      try {
        const b64 = await getOrRender(activePath, viewPage);
        if (cancelled) return;
        setMainImg(b64);
        setMainLoading(false);

        // 画像の実サイズを取得
        const img = new window.Image();
        img.onload = () => {
          if (!cancelled) {
            setImgNaturalW(img.naturalWidth);
            setImgNaturalH(img.naturalHeight);
          }
        };
        img.src = `data:image/jpeg;base64,${b64}`;

        // PDF のみ stext/links/prefetch を実行（非 PDF は変換のたびにプロセスが起動するため抑制）
        const isPdf = activePath.toLowerCase().endsWith(".pdf");
        if (isPdf) {
          // stext を遅延取得（非同期、失敗しても表示には影響なし）
          const scale = RENDER_DPI / 72.0;
          getPageText(activePath, viewPage, scale)
            .then((r) => {
              if (!cancelled && r.ok) setTextBlocks(r.blocks);
            })
            .catch(() => {});
          getPageLinks(activePath, viewPage, scale)
            .then((r) => {
              if (!cancelled && r.ok) setPageLinks(r.links);
            })
            .catch(() => {});

          // 前後プリフェッチ
          prefetch(activePath, viewPage, total);
        }
      } catch (e) {
        if (!cancelled) {
          console.error("[viewer] render failed:", e);
          setMainLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activePath, viewPage, getOrRender, prefetch, total]);

  // ── 4. サムネイル ──────────────────────────────────────────────────────────
  // ページ移動時に読み上げ
  useEffect(() => {
    if (total > 0) {
      announce(t("viewer.announce_page", { n: String(viewPage + 1) }), false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewPage]);

  useEffect(() => {
    if (!activePath || !activeInfo) {
      setThumbs([]);
      return;
    }
    const cached = thumbCache.current.get(activePath);
    if (cached) setThumbs([...cached]);
    else {
      const a = new Array(activeInfo.page_count).fill(undefined);
      thumbCache.current.set(activePath, a);
      setThumbs([]);
    }
    let cancelled = false;
    (async () => {
      const cur = thumbCache.current.get(activePath)!;
      for (let i = 0; i < activeInfo.page_count; i++) {
        if (cur[i]) continue;
        try {
          const b64 = await renderPage(activePath, i, THUMB_DPI, {
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          });
          if (cancelled) return;
          cur[i] = b64;
          setThumbs([...cur]);
        } catch {}
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePath, activeInfo]);

  // ── 5. ファイルカバー ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!fileList.length) return;
    (async () => {
      const m = new Map(fileCoverThumbs);
      let changed = false;
      for (const f of fileList) {
        if (!m.has(f.path)) {
          try {
            m.set(
              f.path,
              await renderPage(f.path, 0, THUMB_DPI, {
                layoutW: convertLayoutW,
                layoutH: convertLayoutH,
                layoutEm: convertLayoutEm,
              }),
            );
            changed = true;
          } catch {}
        }
      }
      if (changed) setFileCoverThumbs(new Map(m));
    })();
  }, [fileList]);

  // ── Ctrl+ホイール でズーム（non-passive で preventDefault を効かせる）──────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom((z) => +Math.min(4.0, Math.max(0.25, z + delta)).toFixed(2));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  if (!activeInfo && !mainLoading) return <Spinner label={t("viewer.loading")} />;
  const fname = activePath.split(/[/\\]/).pop() ?? "";
  const THUMB_W = isNarrow ? 72 : 104;

  // 狭い画面では「ファイル選択ペイン → ページ選択ペイン → 表示ペイン」を
  // 横並びではなく縦に積む。ファイル一覧・サムネイルは件数次第で際限なく
  // 長くなり得るため、Trim 等の設定フォームと違い外側の共通スクロールには
  // 委ねず、各ペイン自身に上限の高さを持たせて内部スクロールのままにする
  // (表示ペインへ辿り着くために毎回ファイル一覧全体を読み飛ばさずに済むように)。
  const bodyStyle: React.CSSProperties = isNarrow
    ? { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }
    : s.body;
  const filePaneStyle: React.CSSProperties = isNarrow
    ? {
        ...s.filePane,
        width: "100%",
        flexShrink: 0,
        maxHeight: 180,
        borderRight: "none",
        borderBottom: "1px solid var(--c-border)",
      }
    : s.filePane;
  const thumbPaneStyle: React.CSSProperties = isNarrow
    ? {
        flexShrink: 0,
        maxHeight: 128,
        borderRight: "none",
        borderBottom: "1px solid var(--c-border)",
        overflow: "hidden",
      }
    : s.thumbPane;
  // サムネイル一覧そのものは、狭幅では縦一列ではなく横スクロールの
  // フィルムストリップにする（ページ選択ペインは横幅いっぱいになるため）。
  const thumbListStyle: React.CSSProperties | undefined = isNarrow
    ? { display: "flex", flexDirection: "row", gap: 10, overflowX: "auto", padding: "10px" }
    : undefined;
  const thumbItemStyle: React.CSSProperties = isNarrow
    ? { ...s.thumbItem, marginBottom: 0, flexShrink: 0 }
    : s.thumbItem;
  const paneCollapsedBarStyle: React.CSSProperties = isNarrow
    ? {
        ...s.paneCollapsedBar,
        width: "100%",
        height: 26,
        borderRight: "none",
        borderBottom: "1px solid var(--c-border)",
      }
    : s.paneCollapsedBar;

  // 表示サイズ（zoom を直接サイズに反映して transform: scale を使わない）
  // → Linux WebKitGTK で transform: scale 内のテキスト選択座標がずれる問題を回避
  const displayW = Math.round(imgNaturalW * zoom);
  const displayH = Math.round(imgNaturalH * zoom);

  return (
    <div style={{ ...s.root, paddingBottom: "calc(var(--safe-bottom))" }}>
      <PageHeader>
        <span style={s.title}>{t("viewer.title_single")}</span>
        <span style={s.fileSub} title={activePath}>
          {fname}
        </span>
        <span style={s.pageBadge}>{t("common.pages", { count: String(total) })}</span>
        <div style={{ flex: 1 }} />
        <button
          style={{ ...s.zBtn, ...(showSearch ? s.btnOn : {}), marginRight: 4 }}
          onClick={() => setShowSearch((v) => !v)}
          title={t("viewer.search_btn")}
          aria-label={t("viewer.search_btn")}
          aria-expanded={showSearch}
        >
          🔍
        </button>
        <button
          style={{ ...s.zBtn, ...(infoOpen ? s.btnOn : {}), marginRight: 8 }}
          onClick={() => setInfoOpen((v) => !v)}
          title={t("viewer.info_btn")}
        >
          ℹ
        </button>
        {isNarrow || (
          <div style={s.zoomRow}>
            <button
              style={s.zBtn}
              onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.05).toFixed(2)))}
            >
              −
            </button>
            <span style={s.zVal}>{Math.round(zoom * 100)}%</span>
            <button
              style={s.zBtn}
              onClick={() => setZoom((z) => Math.min(4.0, +(z + 0.05).toFixed(2)))}
            >
              ＋
            </button>
            <button style={s.zBtnSm} onClick={() => setZoom(1.0)}>
              100%
            </button>
            <button style={s.zBtnSm} onClick={() => setZoom(1.5)}>
              150%
            </button>
          </div>
        )}
      </PageHeader>

      {showSearch && (
        <SearchBar
          path={activePath}
          totalPages={total}
          currentPage={viewPage}
          onNavigate={(page, hit) => {
            if (page !== viewPage) {
              // ページが変わる場合: onLoad 後にスクロールするため pending にセット
              pendingScrollHit.current = hit;
              setViewPage(page);
            }
            // currentHit を更新（同ページの場合は useEffect でスクロール）
            setCurrentHit(hit);
          }}
          onAllHits={(hits) => setAllSearchHits(hits)}
          onClose={() => {
            setShowSearch(false);
            setAllSearchHits([]);
            setCurrentHit(null);
            pendingScrollHit.current = null;
          }}
        />
      )}

      <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>
        <div style={bodyStyle}>
          {/* 左ペイン（ファイル一覧） */}
          {isMulti &&
            (filePaneCollapsed ? (
              <button
                style={paneCollapsedBarStyle}
                onClick={toggleFilePane}
                title={t("common.pane_files", { count: String(fileList.length) })}
                aria-label={t("common.pane_files", { count: String(fileList.length) })}
              >
                {isNarrow ? "▼" : "▶"}
              </button>
            ) : (
              <div style={filePaneStyle}>
                <div style={s.paneHead}>
                  <span style={{ flex: 1 }}>
                    {t("common.pane_files", { count: String(fileList.length) })}
                  </span>
                  <button
                    style={s.paneCollapseBtn}
                    onClick={toggleFilePane}
                    title={t("common.collapse_pane")}
                    aria-label={t("common.collapse_pane")}
                  >
                    {isNarrow ? "▲" : "◀"}
                  </button>
                </div>
                <div style={{ flex: 1, overflowY: "auto" }}>
                  {fileList.map((f, i) => {
                    const cover = fileCoverThumbs.get(f.path);
                    return (
                      <button
                        key={f.id}
                        style={{ ...s.filePaneItem, ...(i === activeIdx ? s.filePaneItemOn : {}) }}
                        onClick={() => {
                          setActiveIdx(i);
                          setViewPage(0);
                          setInfoOpen(false);
                        }}
                      >
                        <div style={s.filePaneThumbBox}>
                          {cover ? (
                            <img
                              src={`data:image/jpeg;base64,${cover}`}
                              style={s.filePaneThumbImg}
                              alt=""
                            />
                          ) : (
                            <span style={s.filePaneIcon}>📄</span>
                          )}
                        </div>
                        <div style={s.filePaneInfo}>
                          <div style={s.filePaneName} title={f.filename}>
                            {f.filename || t("viewer.untitled")}
                          </div>
                          <div style={s.filePaneMeta}>{f.pageCount}p</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

          {/* サムネイルペイン */}
          {isNarrow ||
            (thumbPaneCollapsed ? (
              <button
                style={paneCollapsedBarStyle}
                onClick={toggleThumbPane}
                title={`${viewPage + 1} / ${total}`}
                aria-label={t("common.expand_pane")}
              >
                {isNarrow ? "▼" : "▶"}
              </button>
            ) : (
              <div style={thumbPaneStyle}>
                <div style={s.paneHead}>
                  <span style={{ flex: 1 }}>
                    {viewPage + 1} / {total}
                  </span>
                  <button
                    style={s.paneCollapseBtn}
                    onClick={toggleThumbPane}
                    title={t("common.collapse_pane")}
                    aria-label={t("common.collapse_pane")}
                  >
                    {isNarrow ? "▲" : "◀"}
                  </button>
                </div>
                <div style={thumbListStyle}>
                  {Array.from({ length: total }, (_, i) => {
                    const th = Math.round(THUMB_W / pageAspect(activeInfo, i));
                    return (
                      <button
                        key={i}
                        style={{ ...thumbItemStyle, ...(i === viewPage ? s.thumbItemOn : {}) }}
                        onClick={() => setViewPage(i)}
                      >
                        <div
                          style={{
                            width: THUMB_W,
                            height: th,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            overflow: "hidden",
                            background: "var(--c-bg)",
                            borderRadius: 2,
                          }}
                        >
                          {thumbs[i] ? (
                            <img
                              src={`data:image/jpeg;base64,${thumbs[i]}`}
                              style={{ maxWidth: THUMB_W, maxHeight: th, objectFit: "contain" }}
                              alt=""
                            />
                          ) : (
                            <div
                              style={{ width: THUMB_W, height: th, background: "var(--c-border)" }}
                            />
                          )}
                        </div>
                        <span style={{ ...s.thumbN, ...(i === viewPage ? s.thumbNOn : {}) }}>
                          {i + 1}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

          {/* メインビュー + ドロワー */}
          <div style={s.mainView}>
            <div
              style={s.viewScroll}
              ref={scrollRef}
              tabIndex={0}
              onKeyDown={(e) => {
                if (!e.ctrlKey) return;
                if (e.key === "+" || e.key === "=") {
                  e.preventDefault();
                  setZoom((z) => +Math.min(4.0, z + 0.05).toFixed(2));
                } else if (e.key === "-") {
                  e.preventDefault();
                  setZoom((z) => +Math.max(0.25, z - 0.05).toFixed(2));
                } else if (e.key === "0") {
                  e.preventDefault();
                  setZoom(1.0);
                }
              }}
            >
              <div style={s.viewInner}>
                {mainLoading && !mainImg && (
                  <div style={s.viewCenter}>
                    <div style={s.viewSpinner} className="kozou-spinner" />
                  </div>
                )}
                {mainImg && (
                  <div
                    style={{
                      position: "relative",
                      display: "inline-block",
                      boxShadow: `0 4px ${Math.round(32 * zoom)}px rgba(0,0,0,0.7)`,
                    }}
                  >
                    <img
                      src={`data:image/jpeg;base64,${mainImg}`}
                      alt={t("viewer.page_alt", { n: String(viewPage + 1) })}
                      style={{ display: "block", width: displayW, height: displayH }}
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        setImgNaturalW(img.naturalWidth);
                        setImgNaturalH(img.naturalHeight);
                        // ページジャンプ後のヒット位置へスクロール
                        const hit = pendingScrollHit.current;
                        if (hit) {
                          pendingScrollHit.current = null;
                          scrollToHit(hit);
                        }
                      }}
                    />
                    {/* テキストオーバーレイ（stext 取得後に表示） */}
                    {textBlocks.length > 0 && displayW > 0 && (
                      <TextLayer
                        blocks={textBlocks}
                        containerW={displayW}
                        containerH={displayH}
                        zoom={zoom}
                        searchHits={pageSearchHits}
                        currentHit={currentHit}
                      />
                    )}
                    {/* リンクレイヤー */}
                    {pageLinks.length > 0 && displayW > 0 && (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: displayW,
                          height: displayH,
                        }}
                      >
                        <LinkLayer links={pageLinks} onNavigate={setViewPage} zoom={zoom} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ページナビ */}
            <div style={s.pageNav}>
              {isNarrow && (
                <div style={s.zoomRow}>
                  <button
                    style={s.zBtn}
                    onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.05).toFixed(2)))}
                  >
                    −
                  </button>
                  <span style={s.zVal}>{Math.round(zoom * 100)}%</span>
                  <button
                    style={s.zBtn}
                    onClick={() => setZoom((z) => Math.min(4.0, +(z + 0.05).toFixed(2)))}
                  >
                    ＋
                  </button>
                  <button style={s.zBtnSm} onClick={() => setZoom(1.0)}>
                    100%
                  </button>
                  <button style={s.zBtnSm} onClick={() => setZoom(1.5)}>
                    150%
                  </button>
                </div>
              )}
              <button
                style={s.navBtn}
                onClick={() => setViewPage((p) => Math.max(0, p - 1))}
                disabled={viewPage === 0}
              >
                ◀
              </button>
              <span style={s.pageInfo}>
                {viewPage + 1} / {total}
              </span>
              <button
                style={s.navBtn}
                onClick={() => setViewPage((p) => Math.min(total - 1, p + 1))}
                disabled={viewPage >= total - 1}
              >
                ▶
              </button>
            </div>
          </div>
          <div style={s.footer} />

          <InfoDrawer
            open={infoOpen}
            onClose={() => setInfoOpen(false)}
            info={activeInfo}
            filePath={activePath}
            fileName={fname}
            onMetaSaved={async () => {
              // 画像ファイルの場合: 元ファイルを書き換えるので getPdfInfo 再取得は不要
              if (isImagePath(activePath)) return;
              // PDF の場合: getPdfInfo を再取得して表示を更新
              try {
                const refreshed = await getPdfInfo(activePath, {
                  layoutW: convertLayoutW,
                  layoutH: convertLayoutH,
                  layoutEm: convertLayoutEm,
                });
                setActiveInfo(refreshed);
                lastInfoKey.current = "__meta_updated__";
              } catch {
                /* 更新失敗は無視 */
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ── スタイル ──────────────────────────────────────────────────────────────────
const ss: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 12px",
    background: "var(--c-bgSub)",
    borderBottom: "1px solid var(--c-border)",
  },
  input: {
    flex: 1,
    maxWidth: 320,
    padding: "4px 8px",
    borderRadius: 4,
    border: "1px solid var(--c-border)",
    background: "var(--c-bg)",
    color: "var(--c-text)",
    fontSize: FS.body,
  },
  count: {
    fontSize: FS.caption,
    color: "var(--c-textDim)",
    minWidth: 60,
    textAlign: "center" as const,
  },
  navBtn: {
    width: 26,
    height: 26,
    cursor: "pointer",
    borderRadius: 4,
    border: "1px solid var(--c-border)",
    background: "var(--c-bgSub)",
    color: "var(--c-text)",
    fontSize: FS.small,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  close: {
    background: "transparent",
    border: "none",
    color: "var(--c-textDim)",
    cursor: "pointer",
    fontSize: FS.label,
  },
};

const ds: Record<string, React.CSSProperties> = {
  drawer: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: "60dvw",
    background: "var(--c-bgCard)",
    borderLeft: "1px solid var(--c-border)",
    display: "flex",
    flexDirection: "column",
    zIndex: 20,
    transition: "transform 0.22s cubic-bezier(0.4, 0, 0.2, 1)",
    boxShadow: "-4px 0 24px rgba(0,0,0,0.4)",
  },
  drawerHead: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px",
    borderBottom: "1px solid var(--c-border)",
    position: "sticky",
    top: 0,
    background: "var(--c-bgCard)",
    zIndex: 1,
  },
  drawerTitle: { fontWeight: 700, fontSize: FS.body, color: "var(--c-text)" },
  drawerBody: { flex: 1, padding: "10px 12px", overflowY: "auto" },
  section: {
    fontSize: FS.caption,
    fontWeight: 700,
    letterSpacing: "0.08em",
    color: "var(--c-textDim)",
    marginBottom: 6,
    paddingBottom: 4,
    borderBottom: "1px solid var(--c-border)",
  },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: 6,
    padding: "5px 0",
    borderBottom: "1px solid var(--c-border)",
  },
  label: {
    flexShrink: 0,
    width: 72,
    fontSize: FS.caption,
    color: "var(--c-textDim)",
    paddingTop: 1,
  },
  value: {
    flex: 1,
    fontSize: FS.caption,
    color: "var(--c-text)",
    wordBreak: "break-word",
    lineHeight: 1.5,
    minWidth: 0,
  },
  copyBtn: {
    flexShrink: 0,
    background: "transparent",
    border: "1px solid var(--c-border)",
    borderRadius: 4,
    color: "var(--c-textDim)",
    fontSize: FS.caption,
    cursor: "pointer",
    padding: "1px 5px",
    lineHeight: 1.4,
  },
  copyBtnDone: {
    background: "var(--c-accent)",
    color: "var(--c-accentText)",
    borderColor: "transparent",
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: "var(--c-textDim)",
    fontSize: FS.label,
    cursor: "pointer",
    padding: "2px 6px",
  },
};

const s: Record<string, React.CSSProperties> = {
  root: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    background: "var(--c-bg)",
    position: "relative",
  },
  body: { flex: 1, display: "flex", overflow: "hidden" },
  thumbPane: {
    width: 140,
    borderRight: "1px solid var(--c-border)",
    overflowY: "auto",
    padding: "10px",
  },
  thumbItem: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    marginBottom: 15,
    background: "none",
    border: "2px solid transparent",
    cursor: "pointer",
  },
  thumbItemOn: { borderColor: "var(--c-accent)" },
  thumbN: { fontSize: FS.caption, marginTop: 4, color: "var(--c-textDim)" },
  thumbNOn: { color: "var(--c-accent)" },
  filePane: {
    width: 220,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    borderRight: "1px solid var(--c-border)",
    background: "var(--c-bgCard)",
  },
  filePaneItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 12px",
    width: "100%",
    background: "transparent",
    border: "none",
    borderBottom: "1px solid var(--c-border)",
    cursor: "pointer",
    overflow: "hidden",
  },
  filePaneItemOn: { background: "var(--c-accentBg)", borderLeft: "3px solid var(--c-accent)" },
  filePaneThumbBox: {
    width: 36,
    height: 48,
    flexShrink: 0,
    background: "var(--c-bgCard)",
    borderRadius: 2,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    boxShadow: "0 2px 4px rgba(0,0,0,0.3)",
  },
  filePaneThumbImg: { width: "100%", height: "100%", objectFit: "cover" },
  filePaneIcon: { fontSize: 18, opacity: 0.5 },
  filePaneInfo: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
    textAlign: "left",
  },
  filePaneName: {
    fontSize: FS.small,
    color: "var(--c-text)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontWeight: 500,
  },
  filePaneMeta: { fontSize: FS.caption, color: "var(--c-textDim)" },
  mainView: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "var(--c-bg)",
  },
  viewScroll: { flex: 1, overflow: "auto" },
  viewInner: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    minWidth: "100%",
    padding: "24px 24px 0",
  },
  viewCenter: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: 300 },
  viewSpinner: {
    width: 32,
    height: 32,
    borderRadius: "50%",
    border: "3px solid var(--c-border)",
    borderTopColor: "var(--c-accent)",
    /* animation は kozou-spinner クラスで付与 */
  },
  pageNav: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "4px",
    borderTop: "1px solid var(--c-border)",
    background: "var(--c-bgSub)",
    paddingBottom: "8px",
  },
  navBtn: {
    width: 32,
    height: 32,
    cursor: "pointer",
    borderRadius: 4,
    border: "1px solid var(--c-border)",
    background: "var(--c-bgSub)",
    color: "var(--c-text)",
    fontSize: FS.label,
  },
  pageInfo: { fontSize: FS.small, color: "var(--c-text)", minWidth: 40, textAlign: "center" },
  title: { fontWeight: 700, fontSize: FS.title, fontFamily: F },
  fileSub: {
    fontSize: FS.caption,
    color: "var(--c-textDim)",
    maxWidth: 200,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pageBadge: {
    fontSize: FS.caption,
    background: "var(--c-border)",
    padding: "2px 8px",
    borderRadius: 10,
    marginLeft: 8,
  },
  paneHead: {
    display: "flex",
    alignItems: "center",
    fontSize: FS.caption,
    fontWeight: 700,
    padding: "8px 8px 8px 12px",
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
  // 折りたたみ時に残す細い帯。クリックで再展開できる。
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
  zoomRow: { display: "flex", alignItems: "center", gap: 8 },
  zBtn: {
    width: 28,
    height: 28,
    cursor: "pointer",
    borderRadius: 4,
    border: "1px solid var(--c-border)",
    background: "var(--c-bgSub)",
    color: "var(--c-text)",
    fontSize: FS.label,
  },
  btnOn: { background: "var(--c-accent, #3a7a4a)", color: "#fff", borderColor: "transparent" },
  zBtnSm: {
    height: 24,
    padding: "0 8px",
    cursor: "pointer",
    fontSize: FS.caption,
    borderRadius: 4,
    border: "1px solid var(--c-border)",
    background: "var(--c-bgSub)",
    color: "var(--c-text)",
  },
  zVal: { fontSize: FS.small, minWidth: 40, textAlign: "center" },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    flexShrink: 0,
    paddingBottom: "calc(env(safe-area-inset-bottom))",
  },
};
