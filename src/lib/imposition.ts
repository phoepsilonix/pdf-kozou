// src/lib/imposition.ts — 面付け（N-up / 製本）ユーティリティ
// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 面付けモード
 * - "1up"         : 通常（1ページ/枚）
 * - "2up"         : 2ページ横並び（順番通り）
 * - "4up"         : 4ページ 2×2 格子（順番通り）
 * - "booklet"     : 左綴じ・右開き製本（横書き・洋書向け）折り丁順序
 * - "booklet-rtl" : 右綴じ・左開き製本（縦書き・和書向け）折り丁順序
 */
export type ImpositionMode = "1up" | "2up" | "4up" | "booklet" | "booklet-rtl";

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
 * ltr（左綴じ・右開き / 横書き）例: 4ページ →
 *   シート1 表: [4, 1]  (左=p4, 右=p1) ← 右側が表紙
 *   シート1 裏: [2, 3]
 *
 * rtl（右綴じ・左開き / 縦書き）例: 4ページ →
 *   シート1 表: [1, 4]  (左=p1, 右=p4) ← 左側が表紙
 *   シート1 裏: [3, 2]
 */
export function calcBookletSheets(
  totalPages: number,
  blankLabel = "Blank",
  frontLabel = (n: number) => `Sheet ${n} Front`,
  backLabel = (n: number) => `Sheet ${n} Back`,
  rtl = false,
): Sheet[] {
  // 4の倍数に切り上げ
  const n = totalPages % 4 === 0 ? totalPages : totalPages + (4 - (totalPages % 4));

  const sheets: Sheet[] = [];
  let lo = 1; // 先頭側
  let hi = n; // 末尾側
  let sheetIdx = 1;

  while (lo < hi) {
    if (rtl) {
      // 右綴じ・左開き: 左=lo(表紙側), 右=hi
      sheets.push({ pages: [lo, hi], label: frontLabel(sheetIdx) });
      lo++;
      hi--;
      sheets.push({ pages: [hi, lo], label: backLabel(sheetIdx) });
    } else {
      // 左綴じ・右開き: 右=lo(表紙側), 左=hi
      sheets.push({ pages: [hi, lo], label: frontLabel(sheetIdx) });
      lo++;
      hi--;
      sheets.push({ pages: [lo, hi], label: backLabel(sheetIdx) });
    }
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
export function calc2upSheets(totalPages: number, blankLabel = "Blank"): Sheet[] {
  const sheets: Sheet[] = [];
  for (let i = 1; i <= totalPages; i += 2) {
    const p2 = i + 1 <= totalPages ? i + 1 : 0;
    sheets.push({
      pages: [i, p2],
      label: `${i}–${p2 || blankLabel}`,
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

/** 面付け結合のレイアウト（cols/rows とシートのセル割り当て） */
export interface ComposeLayout {
  cols: number;
  rows: number;
  sheets: Sheet[];
}

/**
 * モードと元ページ数から、結合(compose)用のレイアウトを計算する。
 * - "1up"     : 1×1（ページサイズ変更のみ。各元ページが1出力ページ）
 * - "2up"     : 2×1（横並び。順番通り）
 * - "4up"     : 2×2（順番通り）
 * - "booklet" : 2×1（折り丁順序。4の倍数に空白補完）
 */
export function calcComposeLayout(mode: ImpositionMode, totalPages: number): ComposeLayout {
  switch (mode) {
    case "1up":
      return {
        cols: 1,
        rows: 1,
        sheets: Array.from({ length: totalPages }, (_, i) => ({
          pages: [i + 1],
          label: `${i + 1}`,
        })),
      };
    case "2up":
      return { cols: 2, rows: 1, sheets: calc2upSheets(totalPages) };
    case "4up":
      return { cols: 2, rows: 2, sheets: calc4upSheets(totalPages) };
    case "booklet":
      return { cols: 2, rows: 1, sheets: calcBookletSheets(totalPages) };
    case "booklet-rtl":
      return {
        cols: 2,
        rows: 1,
        sheets: calcBookletSheets(totalPages, "Blank", undefined, undefined, true),
      };
  }
}

/**
 * ComposeLayout を compose_imposition_pdf 用のフラットなセル配列に変換する。
 * 各シートは必ず cols*rows 要素（不足は 0=空白で埋める）。
 */
export function flattenComposeSheets(layout: ComposeLayout): {
  sheetPages: number[];
  nSheets: number;
} {
  const per = layout.cols * layout.rows;
  const sheetPages: number[] = [];
  for (const sh of layout.sheets) {
    for (let c = 0; c < per; c++) {
      sheetPages.push(sh.pages[c] ?? 0);
    }
  }
  return { sheetPages, nSheets: layout.sheets.length };
}

/**
 * モードに応じたシートリストを返す。
 */
export function calcSheets(
  mode: ImpositionMode,
  totalPages: number,
  blankLabel = "Blank",
  frontLabel?: (n: number) => string,
  backLabel?: (n: number) => string,
): Sheet[] {
  if (mode === "1up") {
    return Array.from({ length: totalPages }, (_, i) => ({
      pages: [i + 1],
      label: `${i + 1}`,
    }));
  }
  if (mode === "2up") return calc2upSheets(totalPages, blankLabel);
  if (mode === "4up") return calc4upSheets(totalPages);
  if (mode === "booklet") return calcBookletSheets(totalPages, blankLabel, frontLabel, backLabel);
  if (mode === "booklet-rtl")
    return calcBookletSheets(totalPages, blankLabel, frontLabel, backLabel, true);
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
export const IMPOSITION_MODE_DEFS: {
  id: ImpositionMode;
  labelKey: string;
  descKey: string;
  cols: number;
  rows: number;
  icon: string;
}[] = [
  {
    id: "1up",
    labelKey: "image.imposition_1up",
    descKey: "image.imposition_1up_desc",
    cols: 1,
    rows: 1,
    icon: "📄",
  },
  {
    id: "2up",
    labelKey: "image.imposition_2up",
    descKey: "image.imposition_2up_desc",
    cols: 2,
    rows: 1,
    icon: "📰",
  },
  {
    id: "booklet",
    labelKey: "image.imposition_booklet",
    descKey: "image.imposition_booklet_desc",
    cols: 2,
    rows: 1,
    icon: "📖",
  },
  {
    id: "booklet-rtl",
    labelKey: "image.imposition_booklet_rtl",
    descKey: "image.imposition_booklet_rtl_desc",
    cols: 2,
    rows: 1,
    icon: "📗",
  },
  {
    id: "4up",
    labelKey: "image.imposition_4up",
    descKey: "image.imposition_4up_desc",
    cols: 2,
    rows: 2,
    icon: "⊞",
  },
];

/** 後方互換用エイリアス（label/descはキーのまま） */
export const IMPOSITION_MODES = IMPOSITION_MODE_DEFS;

// ── 面付け解除（split / de-imposition）────────────────────────────────────────

/**
 * 面付け解除の並べ替えモード
 * - "sequential"  : 単純分割（物理順そのまま。2-up/4-up の解除）
 * - "booklet"     : 左綴じ製本解除（折り丁順を読み順に戻す）
 * - "booklet-rtl" : 右綴じ製本解除（RTL折り丁順を読み順に戻す）
 */
export type DeImpositionMode = "sequential" | "booklet" | "booklet-rtl";

/** 出力1ページ分のセル指定 */
export interface SplitCell {
  /** 入力PDFのページ番号（1始まり） */
  page: number;
  /** セルの行（0始まり） */
  row: number;
  /** セルの列（0始まり） */
  col: number;
  /**  面付け解除時のページ番号 */
  outPage?: number;
}

/**
 * 面付け解除のセル割り当てを計算する。
 *
 * 入力 sheetCount 枚のシートを cols×rows のセルに分割し、
 * 各セルを1ページとして取り出す。物理順は「シート順 × セル順(行優先)」。
 * モードに応じて出力順を並べ替える。
 *
 * @param sheetCount 入力シート（A3など）の枚数
 * @param cols       横分割数（2-up/booklet=2, 4-up=2）
 * @param rows       縦分割数（2-up/booklet=1, 4-up=2）
 * @param mode       "sequential" | "booklet"
 * @returns 出力順に並んだセル指定の配列
 */
export function calcSplitCells(
  sheetCount: number,
  cols: number,
  rows: number,
  mode: DeImpositionMode,
): SplitCell[] {
  const cells = cols * rows;

  const physical: SplitCell[] = [];
  for (let s = 0; s < sheetCount; s++) {
    for (let i = 0; i < cells; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      physical.push({ page: s + 1, row, col });
    }
  }

  if (mode === "sequential") {
    return physical;
  }

  // booklet解除
  const rawTotal = sheetCount * cells;
  const total = rawTotal % 4 === 0 ? rawTotal : rawTotal + (4 - (rawTotal % 4));
  const isRtl = mode === "booklet-rtl";

  const sheets = calcBookletSheets(total, "Blank", undefined, undefined, isRtl);

  const flat: number[] = [];
  for (const sh of sheets) {
    for (let c = 0; c < cells; c++) {
      flat.push(sh.pages[c] ?? 0);
    }
  }

  const pageToPhys = new Map<number, number>();
  flat.forEach((p, i) => {
    //if (p !== 0) pageToPhys.set(p, i);
    pageToPhys.set(p, i);
  });

  const out: SplitCell[] = [];
  for (let p = 1; p <= total; p++) {
    const physIdx = pageToPhys.get(p);

    // ここで flat[p-1] を参照して outPage に設定する
    const outPageNum = p; // flat の並び順そのものが「出力されるべきページ順(1始まり)」

    if (physIdx === undefined || physIdx >= physical.length) {
      // ダミーページの場合、座標もここで適切に計算してセット
      const cellsPerSheet = cols * rows;
      const indexInSheet = (p - 1) % cellsPerSheet;
      out.push({
        page: 0,
        row: Math.floor(indexInSheet / cols),
        col: isRtl ? indexInSheet % cols : (indexInSheet + 1) % cols,
        outPage: outPageNum,
      });
    } else {
      const cell = { ...physical[physIdx], outPage: outPageNum };
      out.push(cell);
    }
  }
  return out;
}

/**
 * 面付け解除モードの表示情報
 */
export const DE_IMPOSITION_MODE_DEFS: {
  id: DeImpositionMode;
  /** 対応する cols/rows（UIの選択肢として） */
  cols: number;
  rows: number;
  labelKey: string;
  descKey: string;
  icon: string;
}[] = [
  {
    id: "sequential",
    cols: 2,
    rows: 1,
    labelKey: "image.deimp_2up",
    descKey: "image.deimp_2up_desc",
    icon: "📰",
  },
  {
    id: "booklet",
    cols: 2,
    rows: 1,
    labelKey: "image.deimp_booklet",
    descKey: "image.deimp_booklet_desc",
    icon: "📖",
  },
  {
    id: "booklet-rtl",
    cols: 2,
    rows: 1,
    labelKey: "image.deimp_booklet_rtl",
    descKey: "image.deimp_booklet_rtl_desc",
    icon: "📗",
  },
  {
    id: "sequential",
    cols: 2,
    rows: 2,
    labelKey: "image.deimp_4up",
    descKey: "image.deimp_4up_desc",
    icon: "⊞",
  },
];
