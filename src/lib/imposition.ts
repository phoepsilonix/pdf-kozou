// src/lib/imposition.ts — 面付け（N-up / 製本）ユーティリティ
// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 面付けモード
 * - "1up"     : 通常（1ページ/枚）
 * - "2up"     : 2ページ横並び（順番通り）
 * - "4up"     : 4ページ 2×2 格子（順番通り）
 * - "booklet" : 製本見開き（折り丁順序）
 */
export type ImpositionMode = "1up" | "2up" | "4up" | "booklet";

export interface Sheet {
  /** 左上から右下順に並んだページ番号（1始まり、0=空白ページ） */
  pages: number[];
  /** このシートのラベル（例: "シート1 表"） */
  label: string;
}

/**
 * 製本見開きのページ順序を計算する。
 * ページ数が4の倍数でない場合は空白ページを末尾に補う。
 *
 * 出力されるシートの順序は印刷後に重ねて二つ折りにした時に
 * 正しい製本になる順序。
 *
 * 例: 4ページ →
 *   シート1 表: [4, 1]  (右綴じ: 右=p4, 左=p1)
 *   シート1 裏: [2, 3]
 */
export function calcBookletSheets(totalPages: number): Sheet[] {
  // 4の倍数に切り上げ
  const n = totalPages % 4 === 0 ? totalPages : totalPages + (4 - (totalPages % 4));

  const sheets: Sheet[] = [];
  let lo = 1; // 先頭側
  let hi = n; // 末尾側
  let sheetIdx = 1;

  while (lo < hi) {
    // 表: 右=hi, 左=lo
    sheets.push({
      pages: [hi, lo],
      label: `シート${sheetIdx} 表`,
    });
    lo++;
    hi--;

    // 裏: 左=lo, 右=hi
    sheets.push({
      pages: [lo, hi],
      label: `シート${sheetIdx} 裏`,
    });
    lo++;
    hi--;
    sheetIdx++;
  }

  return sheets;
}

/**
 * 2-up Sequential のシート順序を計算する。
 * [1,2], [3,4], [5,6], ...
 */
export function calc2upSheets(totalPages: number): Sheet[] {
  const sheets: Sheet[] = [];
  for (let i = 1; i <= totalPages; i += 2) {
    const p2 = i + 1 <= totalPages ? i + 1 : 0;
    sheets.push({
      pages: [i, p2],
      label: `${i}–${p2 || "空白"}`,
    });
  }
  return sheets;
}

/**
 * 4-up Sequential のシート順序を計算する。
 * [1,2,3,4], [5,6,7,8], ...
 */
export function calc4upSheets(totalPages: number): Sheet[] {
  const sheets: Sheet[] = [];
  for (let i = 1; i <= totalPages; i += 4) {
    const ps = [i, i + 1, i + 2, i + 3].map((p) => (p <= totalPages ? p : 0));
    sheets.push({
      pages: ps,
      label: `${i}–${Math.min(i + 3, totalPages)}`,
    });
  }
  return sheets;
}

/**
 * モードに応じたシートリストを返す。
 */
export function calcSheets(mode: ImpositionMode, totalPages: number): Sheet[] {
  if (mode === "1up") {
    return Array.from({ length: totalPages }, (_, i) => ({
      pages: [i + 1],
      label: `${i + 1}`,
    }));
  }
  if (mode === "2up") return calc2upSheets(totalPages);
  if (mode === "4up") return calc4upSheets(totalPages);
  if (mode === "booklet") return calcBookletSheets(totalPages);
  return [];
}

/**
 * ページ画像（base64 PNG/JPEG）の配列と配置設定から
 * 合成した Canvas の dataURL を返す。
 *
 * @param pageImages  各ページの画像 (src="data:image/...;base64,...")。
 *                    インデックスは 0始まりのページ番号。空白ページは undefined。
 * @param sheet       合成するシート
 * @param cols        列数（2-up/booklet=2, 4-up=2）
 * @param rows        行数（2-up/booklet=1, 4-up=2）
 * @param pageW       各ページの表示幅 px
 * @param pageH       各ページの表示高さ px
 * @param gap         ページ間のギャップ px
 * @param format      "image/jpeg" | "image/png"
 * @param quality     JPEG品質 0-1
 */
export async function compositeSheet(
  pageImages: (string | undefined)[],
  sheet: Sheet,
  cols: number,
  rows: number,
  pageW: number,
  pageH: number,
  gap: number,
  format: string,
  quality: number,
): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = cols * pageW + (cols + 1) * gap;
  canvas.height = rows * pageH + (rows + 1) * gap;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas context unavailable");

  // 背景を白で塗りつぶす
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const loadImage = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });

  for (let i = 0; i < sheet.pages.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = gap + col * (pageW + gap);
    const y = gap + row * (pageH + gap);

    const pageNo = sheet.pages[i]; // 1始まり、0=空白
    if (!pageNo) {
      // 空白ページ: 薄いグレー枠のみ
      ctx.fillStyle = "#f0f0f0";
      ctx.fillRect(x, y, pageW, pageH);
      ctx.strokeStyle = "#cccccc";
      ctx.strokeRect(x, y, pageW, pageH);
      // "空白" テキスト
      ctx.fillStyle = "#aaaaaa";
      ctx.font = `${Math.min(pageW, pageH) * 0.08}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("空白", x + pageW / 2, y + pageH / 2);
      continue;
    }

    const src = pageImages[pageNo - 1]; // 0始まりのインデックス
    if (!src) continue;

    try {
      const img = await loadImage(src);
      // アスペクト比を維持してフィット
      const scale = Math.min(pageW / img.width, pageH / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const dx = x + (pageW - w) / 2;
      const dy = y + (pageH - h) / 2;
      ctx.drawImage(img, dx, dy, w, h);
    } catch {
      // 画像読み込み失敗は空白で代替
      ctx.fillStyle = "#ffe0e0";
      ctx.fillRect(x, y, pageW, pageH);
    }

    // ページ番号を右下に小さく表示
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.font = `${Math.min(pageW, pageH) * 0.05}px sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText(String(pageNo), x + pageW - 4, y + pageH - 4);
  }

  // 中央の折り線（booklet / 2-up の場合）
  if (cols >= 2) {
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "rgba(100,100,100,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const midX = canvas.width / 2;
    ctx.moveTo(midX, 0);
    ctx.lineTo(midX, canvas.height);
    ctx.stroke();
    ctx.restore();
  }

  return canvas.toDataURL(format, quality);
}

/**
 * dataURL を Blob に変換してダウンロードリンクを生成する。
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, data] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)?.[1] ?? "image/png";
  const binary = atob(data);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/**
 * モード設定の表示情報
 */
export const IMPOSITION_MODES: {
  id: ImpositionMode;
  label: string;
  desc: string;
  cols: number;
  rows: number;
  icon: string;
}[] = [
  { id: "1up", label: "1ページ/枚", desc: "通常（1ページを1枚に）", cols: 1, rows: 1, icon: "📄" },
  {
    id: "2up",
    label: "2ページ並び",
    desc: "2ページを横並びに（順番通り）",
    cols: 2,
    rows: 1,
    icon: "📰",
  },
  {
    id: "booklet",
    label: "製本見開き",
    desc: "折って綴じる製本用（A4×2→A3等）",
    cols: 2,
    rows: 1,
    icon: "📖",
  },
  { id: "4up", label: "4ページ格子", desc: "4ページを2×2に並べる", cols: 2, rows: 2, icon: "⊞" },
];
