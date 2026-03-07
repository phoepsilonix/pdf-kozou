// src/components/trim/TrimCanvas.tsx
//
// トリミング Canvas コンポーネント
//
// 機能:
//   - PDF ページを背景画像として表示
//   - ドラッグ可能なトリミング矩形 (Konva.js)
//   - 矩形の8ハンドル (四隅 + 辺中央) でリサイズ
//   - Canvas ↔ 数値入力の双方向同期 (500ms debounce)
//   - モバイル対応 (touch イベント)

import { useEffect, useRef, useCallback, useState } from "react";
import Konva from "konva";
import type { TrimMargins } from "../../lib/tauri";

interface Props {
  /** base64 JPEG のページ画像 */
  pageImageB64: string;
  /** 画像が表すページサイズ (PDF ポイント単位) */
  pageWidthPt:  number;
  pageHeightPt: number;
  /** 現在のトリミングマージン (PDF ポイント単位) */
  margins: TrimMargins;
  /** マージンが変わったときに呼ばれる (debounce 済み) */
  onChange: (m: TrimMargins) => void;
  /** Canvas の表示幅 (px) */
  displayWidth?: number;
}

// ── ハンドルの定義 ────────────────────────────────────────────────────────────
type HandleId =
  | "nw" | "n" | "ne"
  | "w"         | "e"
  | "sw" | "s" | "se";

interface Handle {
  id:    HandleId;
  getCx: (r: DOMRect) => number;  // 矩形からハンドル中心X
  getCy: (r: DOMRect) => number;
  cursor: string;
}

const HANDLES: Handle[] = [
  { id: "nw", getCx: r => r.x,            getCy: r => r.y,            cursor: "nwse-resize" },
  { id: "n",  getCx: r => r.x + r.width/2, getCy: r => r.y,            cursor: "ns-resize"   },
  { id: "ne", getCx: r => r.x + r.width,   getCy: r => r.y,            cursor: "nesw-resize" },
  { id: "w",  getCx: r => r.x,            getCy: r => r.y + r.height/2, cursor: "ew-resize"   },
  { id: "e",  getCx: r => r.x + r.width,   getCy: r => r.y + r.height/2, cursor: "ew-resize"   },
  { id: "sw", getCx: r => r.x,            getCy: r => r.y + r.height,   cursor: "nesw-resize" },
  { id: "s",  getCx: r => r.x + r.width/2, getCy: r => r.y + r.height,   cursor: "ns-resize"   },
  { id: "se", getCx: r => r.x + r.width,   getCy: r => r.y + r.height,   cursor: "nwse-resize" },
];

const HANDLE_SIZE = 10;
const HANDLE_COLOR = "#4f9eff";
const OVERLAY_COLOR = "rgba(0,0,0,0.45)";
const BORDER_COLOR = "#4f9eff";
const MIN_SIZE_PX = 20;

// ── ポイント ↔ ピクセル変換 ───────────────────────────────────────────────────

function ptToPx(pt: number, scale: number) { return pt * scale; }
function pxToPt(px: number, scale: number) { return px / scale; }

// ── コンポーネント ────────────────────────────────────────────────────────────

export function TrimCanvas({
  pageImageB64,
  pageWidthPt,
  pageHeightPt,
  margins,
  onChange,
  displayWidth = 600,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef     = useRef<Konva.Stage | null>(null);
  const layerRef     = useRef<Konva.Layer | null>(null);

  // scale: PT → PX の倍率
  const scale = displayWidth / pageWidthPt;
  const displayHeight = pageHeightPt * scale;

  // 内部状態: ピクセル単位の矩形 (Canvas 座標系、Y軸下向き)
  // PDF座標系: 左下原点 → Canvas座標系: 左上原点
  const [rect, setRect] = useState(() => ({
    x: ptToPx(margins.left,                  scale),
    y: ptToPx(pageHeightPt - margins.top,    scale), // PDF→Canvas Y反転
    w: ptToPx(margins.right - margins.left,  scale),
    h: ptToPx(margins.top   - margins.bottom,scale),
  }));

  // margins が外部から変わったら rect を更新
  useEffect(() => {
    setRect({
      x: ptToPx(margins.left,                   scale),
      y: ptToPx(pageHeightPt - margins.top,     scale),
      w: ptToPx(margins.right - margins.left,   scale),
      h: ptToPx(margins.top   - margins.bottom, scale),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [margins.left, margins.right, margins.top, margins.bottom, scale]);

  // rect → TrimMargins 変換 (PDF 座標系へ戻す)
  const rectToMargins = useCallback((r: typeof rect): TrimMargins => ({
    left:   pxToPt(r.x,       scale),
    right:  pxToPt(r.x + r.w, scale),
    bottom: pxToPt(pageHeightPt * scale - (r.y + r.h), scale),
    top:    pxToPt(pageHeightPt * scale - r.y,          scale),
  }), [scale, pageHeightPt]);

  // debounce タイマー
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emitChange  = useCallback((r: typeof rect) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onChange(rectToMargins(r));
    }, 500);
  }, [onChange, rectToMargins]);

  // ── Konva ステージ初期化 ───────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const stage = new Konva.Stage({
      container: containerRef.current,
      width:  displayWidth,
      height: displayHeight,
    });
    const layer = new Konva.Layer();
    stage.add(layer);
    stageRef.current = stage;
    layerRef.current = layer;

    return () => { stage.destroy(); };
  // 初回のみ
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 描画 ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const layer = layerRef.current;
    const stage = stageRef.current;
    if (!layer || !stage) return;

    layer.destroyChildren();

    // ── 背景画像 ─────────────────────────────────────────────────────────────
    const img = new window.Image();
    img.src = `data:image/jpeg;base64,${pageImageB64}`;
    img.onload = () => {
      const bgImage = new Konva.Image({
        x: 0, y: 0,
        image: img,
        width:  displayWidth,
        height: displayHeight,
      });
      layer.add(bgImage);
      drawOverlayAndHandles(layer, stage, rect);
      layer.draw();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageImageB64, displayWidth, displayHeight]);

  // rect が変わったら overlay と handle だけ再描画
  useEffect(() => {
    const layer = layerRef.current;
    const stage = stageRef.current;
    if (!layer || !stage) return;
    // bgImage 以外を削除して再描画
    const children = layer.getChildren();
    for (let i = children.length - 1; i >= 1; i--) {
      children[i].destroy();
    }
    drawOverlayAndHandles(layer, stage, rect);
    layer.draw();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect]);

  // ── オーバーレイ + ハンドル描画 ───────────────────────────────────────────
  function drawOverlayAndHandles(
    layer: Konva.Layer,
    stage: Konva.Stage,
    r: typeof rect,
  ) {
    const stageW = stage.width();
    const stageH = stage.height();

    // 暗幕 (4枚の矩形でトリム領域外を覆う)
    const overlayRects = [
      { x: 0,       y: 0,       width: stageW,  height: r.y          }, // 上
      { x: 0,       y: r.y+r.h, width: stageW,  height: stageH-r.y-r.h }, // 下
      { x: 0,       y: r.y,     width: r.x,      height: r.h          }, // 左
      { x: r.x+r.w, y: r.y,     width: stageW-r.x-r.w, height: r.h   }, // 右
    ];
    overlayRects.forEach(o => {
      layer.add(new Konva.Rect({ ...o, fill: OVERLAY_COLOR, listening: false }));
    });

    // トリム枠の境界線
    const border = new Konva.Rect({
      x: r.x, y: r.y, width: r.w, height: r.h,
      stroke: BORDER_COLOR, strokeWidth: 1.5,
      dash: [6, 3],
      listening: false,
    });
    layer.add(border);

    // グリッド線 (三分割)
    for (let i = 1; i <= 2; i++) {
      layer.add(new Konva.Line({
        points: [r.x + r.w*i/3, r.y, r.x + r.w*i/3, r.y+r.h],
        stroke: "rgba(79,158,255,0.3)", strokeWidth: 1, listening: false,
      }));
      layer.add(new Konva.Line({
        points: [r.x, r.y + r.h*i/3, r.x+r.w, r.y + r.h*i/3],
        stroke: "rgba(79,158,255,0.3)", strokeWidth: 1, listening: false,
      }));
    }

    // ドラッグ可能な本体矩形 (中央部: move カーソル)
    const mover = new Konva.Rect({
      x: r.x + 12, y: r.y + 12,
      width:  Math.max(r.w - 24, 1),
      height: Math.max(r.h - 24, 1),
      fill: "transparent",
      draggable: true,
      cursor: "move",
    });
    mover.on("dragmove", () => {
      const dx = mover.x() - (r.x + 12);
      const dy = mover.y() - (r.y + 12);
      const newR = {
        x: Math.max(0, Math.min(r.x + dx, stageW - r.w)),
        y: Math.max(0, Math.min(r.y + dy, stageH - r.h)),
        w: r.w, h: r.h,
      };
      setRect(newR);
      emitChange(newR);
    });
    layer.add(mover);

    // ハンドル
    const domRect: DOMRect = {
      x: r.x, y: r.y, width: r.w, height: r.h,
      top: r.y, left: r.x, right: r.x+r.w, bottom: r.y+r.h,
      toJSON: () => ({}),
    };

    HANDLES.forEach(handle => {
      const cx = handle.getCx(domRect);
      const cy = handle.getCy(domRect);
      const hs = HANDLE_SIZE / 2;

      const knob = new Konva.Rect({
        x: cx - hs, y: cy - hs,
        width: HANDLE_SIZE, height: HANDLE_SIZE,
        fill: "white", stroke: HANDLE_COLOR, strokeWidth: 1.5,
        cornerRadius: 2,
        draggable: true,
        cursor: handle.cursor,
      });

      knob.on("dragmove", () => {
        const kx = knob.x() + hs;
        const ky = knob.y() + hs;
        const id = handle.id;

        let { x: nx, y: ny, w: nw, h: nh } = r;

        if (id.includes("w")) { const d = kx - nx; nx = Math.min(kx, nx+nw-MIN_SIZE_PX); nw -= (nx - r.x); }
        if (id.includes("e")) { nw = Math.max(MIN_SIZE_PX, kx - nx); }
        if (id.includes("n")) { const d = ky - ny; ny = Math.min(ky, ny+nh-MIN_SIZE_PX); nh -= (ny - r.y); }
        if (id.includes("s")) { nh = Math.max(MIN_SIZE_PX, ky - ny); }

        // ステージ境界クランプ
        nx = Math.max(0, nx); ny = Math.max(0, ny);
        nw = Math.min(nw, stageW - nx);
        nh = Math.min(nh, stageH - ny);

        const newR = { x: nx, y: ny, w: nw, h: nh };
        setRect(newR);
        emitChange(newR);
      });

      layer.add(knob);
    });
  }

  return (
    <div
      ref={containerRef}
      style={{
        width:  displayWidth,
        height: displayHeight,
        cursor: "crosshair",
        touchAction: "none",
        userSelect: "none",
      }}
    />
  );
}
