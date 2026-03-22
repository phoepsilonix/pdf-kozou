// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------


// src/components/trim/TrimCanvas.tsx
//
// PDF ページ上でトリミング余白をマウスドラッグで指定する Canvas コンポーネント
//
// 座標系:
//   - margin は「各辺から削る量」(pt単位) : left=左余白, right=右余白, top=上余白, bottom=下余白
//   - Canvas は左上原点・Y軸下向き
//   - PDF は左下原点・Y軸上向き → top/bottom は視覚的に反転しない (top=画面上側の余白)

//import { useRef, useEffect, useCallback, useState } from "react";
import { useRef, useEffect, useCallback } from "react";
import type { TrimMargins } from "../../lib/tauri";

interface Props {
  pageImageB64: string;
  pageWidthPt: number;
  pageHeightPt: number;
  margins: TrimMargins; // pt単位の余白幅
  onChange: (m: TrimMargins) => void;
  displayWidth: number;
}

type DragTarget =
  | "move"
  | "edge-left"
  | "edge-right"
  | "edge-top"
  | "edge-bottom"
  | "corner-nw"
  | "corner-ne"
  | "corner-sw"
  | "corner-se"
  | null;

const HANDLE_R = 6; // ハンドル半径px
const MIN_PT = 0; // 最小余白 (pt) - スナップ時は0も許可
const EDGE_HIT = 10; // エッジ判定幅px
const SNAP_PX = 10; // スナップ閾値 (px) — ページ端に近づいたら吸着
//const SNAP_ZERO  = 0;    // スナップ先: 余白0 (ページ端)

export function TrimCanvas({
  pageImageB64,
  pageWidthPt,
  pageHeightPt,
  margins,
  onChange,
  displayWidth,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragging = useRef<DragTarget>(null);
  const dragStart = useRef({ x: 0, y: 0, margins: margins });

  const scale = displayWidth / pageWidthPt;
  const displayHeight = Math.round(pageHeightPt * scale);

  // pt → px
  const toPx = (pt: number) => pt * scale;
  // px → pt (clamp >= MIN_PT)
  //const toPt = (px: number) => Math.max(MIN_PT, px / scale);
  // スナップ: 0に近ければ0にスナップ (ページ端吸着)
  const snapPt = (pt: number, maxPt: number) => {
    if (pt < SNAP_PX / scale) return 0; // ページ端へスナップ
    if (pt > maxPt - SNAP_PX / scale) return maxPt; // もう一方の端
    return pt;
  };

  // margins → canvas上の矩形 (クロップ領域)
  const getRect = (m: TrimMargins) => ({
    x: toPx(m.left),
    y: toPx(m.top),
    x2: displayWidth - toPx(m.right),
    y2: displayHeight - toPx(m.bottom),
  });

  // ── 描画 ──────────────────────────────────────────────────────────────────
  const draw = useCallback(
    (m: TrimMargins) => {
      const canvas = canvasRef.current;
      const img = imgRef.current;
      if (!canvas || !img) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, displayWidth, displayHeight);

      // 背景画像
      ctx.drawImage(img, 0, 0, displayWidth, displayHeight);

      const { x, y, x2, y2 } = getRect(m);
      const w = x2 - x,
        h = y2 - y;

      // 暗幕 (削除される領域)
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, displayWidth, y); // 上
      ctx.fillRect(0, y2, displayWidth, displayHeight - y2); // 下
      ctx.fillRect(0, y, x, h); // 左
      ctx.fillRect(x2, y, displayWidth - x2, h); // 右

      // 保持領域の枠
      ctx.strokeStyle = "#4f9eff";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);

      // グリッド線 (三分割)
      ctx.strokeStyle = "rgba(79,158,255,0.25)";
      ctx.lineWidth = 1;
      for (let i = 1; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(x + (w * i) / 3, y);
        ctx.lineTo(x + (w * i) / 3, y2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y + (h * i) / 3);
        ctx.lineTo(x2, y + (h * i) / 3);
        ctx.stroke();
      }

      // コーナーハンドル
      const corners = [
        { cx: x, cy: y },
        { cx: x2, cy: y },
        { cx: x, cy: y2 },
        { cx: x2, cy: y2 },
      ];
      corners.forEach(({ cx, cy }) => {
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#4f9eff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, HANDLE_R, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });

      // 辺中央ハンドル
      const mids = [
        { cx: x + w / 2, cy: y },
        { cx: x + w / 2, cy: y2 },
        { cx: x, cy: y + h / 2 },
        { cx: x2, cy: y + h / 2 },
      ];
      mids.forEach(({ cx, cy }) => {
        ctx.fillStyle = "#4f9eff";
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, HANDLE_R - 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });

      // 余白寸法表示 (mm)
      const ptToMm = (pt: number) => (pt / 2.8346).toFixed(1);
      ctx.font = "11px 'JetBrains Mono', monospace";
      ctx.fillStyle = "rgba(79,158,255,0.9)";
      ctx.textAlign = "center";
      if (m.top > 3) ctx.fillText(`↕ ${ptToMm(m.top)}mm`, displayWidth / 2, y / 2 + 4);
      if (m.bottom > 3)
        ctx.fillText(
          `↕ ${ptToMm(m.bottom)}mm`,
          displayWidth / 2,
          y2 + (displayHeight - y2) / 2 + 4,
        );
      ctx.textAlign = "left";
      if (m.left > 3) ctx.fillText(`${ptToMm(m.left)}mm`, 4, y + h / 2 + 4);
      if (m.right > 3) ctx.fillText(`${ptToMm(m.right)}mm`, x2 + 4, y + h / 2 + 4);
    },
    [displayWidth, displayHeight, scale],
  ); // eslint-disable-line

  // 画像ロード
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      draw(margins);
    };
    img.src = `data:image/jpeg;base64,${pageImageB64}`;
  }, [pageImageB64]); // eslint-disable-line

  // margins 変更時に再描画
  useEffect(() => {
    draw(margins);
  }, [margins, draw]);

  // ── ヒットテスト ─────────────────────────────────────────────────────────
  const hitTest = useCallback(
    (px: number, py: number, m: TrimMargins): DragTarget => {
      const { x, y, x2, y2 } = getRect(m);
      const near = (a: number, b: number) => Math.abs(a - b) <= EDGE_HIT;

      // コーナー優先
      if (near(px, x) && near(py, y)) return "corner-nw";
      if (near(px, x2) && near(py, y)) return "corner-ne";
      if (near(px, x) && near(py, y2)) return "corner-sw";
      if (near(px, x2) && near(py, y2)) return "corner-se";

      // 辺
      if (near(py, y) && px >= x - EDGE_HIT && px <= x2 + EDGE_HIT) return "edge-top";
      if (near(py, y2) && px >= x - EDGE_HIT && px <= x2 + EDGE_HIT) return "edge-bottom";
      if (near(px, x) && py >= y - EDGE_HIT && py <= y2 + EDGE_HIT) return "edge-left";
      if (near(px, x2) && py >= y - EDGE_HIT && py <= y2 + EDGE_HIT) return "edge-right";

      // 内部 → move
      if (px > x && px < x2 && py > y && py < y2) return "move";
      return null;
    },
    [scale, displayWidth, displayHeight],
  ); // eslint-disable-line

  // ── カーソル ──────────────────────────────────────────────────────────────
  const getCursor = (t: DragTarget): string => {
    switch (t) {
      case "corner-nw":
      case "corner-se":
        return "nwse-resize";
      case "corner-ne":
      case "corner-sw":
        return "nesw-resize";
      case "edge-left":
      case "edge-right":
        return "ew-resize";
      case "edge-top":
      case "edge-bottom":
        return "ns-resize";
      case "move":
        return "move";
      default:
        return "crosshair";
    }
  };

  // ── マウスイベント ────────────────────────────────────────────────────────
  const getPos = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const { x, y } = getPos(e);
      const target = hitTest(x, y, margins);
      dragging.current = target;
      dragStart.current = { x, y, margins: { ...margins } };
    },
    [margins, hitTest],
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const { x, y } = getPos(e);
      const canvas = canvasRef.current;
      if (!canvas) return;

      if (!dragging.current) {
        canvas.style.cursor = getCursor(hitTest(x, y, margins));
        return;
      }

      const dx = x - dragStart.current.x;
      const dy = y - dragStart.current.y;
      const sm = dragStart.current.margins;
      const dxPt = dx / scale;
      const dyPt = dy / scale;

      const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
      const maxL = pageWidthPt - MIN_PT - sm.right;
      const maxR = pageWidthPt - MIN_PT - sm.left;
      const maxT = pageHeightPt - MIN_PT - sm.bottom;
      const maxB = pageHeightPt - MIN_PT - sm.top;

      let nm = { ...sm };
      const t = dragging.current;

      if (t === "move") {
        const moveL = clamp(sm.left + dxPt, 0, pageWidthPt - sm.right - MIN_PT);
        const moveT = clamp(sm.top + dyPt, 0, pageHeightPt - sm.bottom - MIN_PT);
        nm = {
          left: moveL,
          right: sm.right + (sm.left - moveL),
          top: moveT,
          bottom: sm.bottom + (sm.top - moveT),
        };
      } else {
        if (t === "edge-left" || t === "corner-nw" || t === "corner-sw")
          nm.left = clamp(sm.left + dxPt, 0, maxL);
        if (t === "edge-right" || t === "corner-ne" || t === "corner-se")
          nm.right = clamp(sm.right - dxPt, 0, maxR);
        if (t === "edge-top" || t === "corner-nw" || t === "corner-ne")
          nm.top = clamp(sm.top + dyPt, 0, maxT);
        if (t === "edge-bottom" || t === "corner-sw" || t === "corner-se")
          nm.bottom = clamp(sm.bottom - dyPt, 0, maxB);
      }

      draw(nm);
      onChange(nm);
    },
    [margins, scale, pageWidthPt, pageHeightPt, hitTest, draw, onChange],
  );

  const onMouseUp = useCallback(() => {
    // マウスアップ時にスナップ適用
    if (dragging.current) {
      const m = { ...margins };
      const pw = pageWidthPt,
        ph = pageHeightPt;
      const snapped: typeof m = {
        left: snapPt(m.left, pw - m.right),
        right: snapPt(m.right, pw - m.left),
        top: snapPt(m.top, ph - m.bottom),
        bottom: snapPt(m.bottom, ph - m.top),
      };
      if (
        snapped.left !== m.left ||
        snapped.right !== m.right ||
        snapped.top !== m.top ||
        snapped.bottom !== m.bottom
      ) {
        draw(snapped);
        onChange(snapped);
      }
    }
    dragging.current = null;
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={displayWidth}
      height={displayHeight}
      style={{ display: "block", touchAction: "none", userSelect: "none" }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    />
  );
}
