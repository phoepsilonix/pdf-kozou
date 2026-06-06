// ── 標準ページサイズ定義 ──────────────────────────────────────────────────────
// 画像をPDF/画像に変換する際の「標準ページサイズ」を定義する。
// 画像はページサイズ情報を持たないため、ユーザーが選んだこのサイズに
// アスペクト比を保って収める（fit、余白白）。
// PDF入力など既にページサイズが確定しているものには適用しない。

/** ページサイズ識別子。"image" は従来動作（画像のピクセル寸法をそのまま使う）。 */
export type PageSizeId = "image" | "A3" | "A4" | "A5" | "B4" | "B5";

/** ページの向き。"auto" は画像の縦横比から自動判定。 */
export type PageOrientation = "auto" | "portrait" | "landscape";

/** 各サイズの寸法（pt = 1/72インチ）。縦向き（portrait）基準。 */
export const PAGE_SIZE_PT: Record<Exclude<PageSizeId, "image">, { w: number; h: number }> = {
  A3: { w: 841.89, h: 1190.55 }, // 297×420mm
  A4: { w: 595.28, h: 841.89 }, // 210×297mm
  A5: { w: 419.53, h: 595.28 }, // 148×210mm
  B4: { w: 728.5, h: 1031.81 }, // 257×364mm（JIS）
  B5: { w: 515.91, h: 728.5 }, // 182×257mm（JIS）
};

/** UIで表示する順序とラベルキー */
export const PAGE_SIZE_DEFS: { id: PageSizeId; labelKey: string }[] = [
  { id: "A4", labelKey: "pagesize.a4" },
  { id: "A3", labelKey: "pagesize.a3" },
  { id: "A5", labelKey: "pagesize.a5" },
  { id: "B4", labelKey: "pagesize.b4" },
  { id: "B5", labelKey: "pagesize.b5" },
  { id: "image", labelKey: "pagesize.image" },
];

export const PAGE_ORIENTATION_DEFS: { id: PageOrientation; labelKey: string }[] = [
  { id: "auto", labelKey: "pagesize.orient_auto" },
  { id: "portrait", labelKey: "pagesize.orient_portrait" },
  { id: "landscape", labelKey: "pagesize.orient_landscape" },
];

/**
 * 指定サイズ・向きの最終ページ寸法(pt)を返す。
 * "image" の場合は null（呼び出し側が画像ピクセル寸法を使う）。
 *
 * @param id          ページサイズ
 * @param orientation 向き
 * @param imgAspect   画像のアスペクト比 (w/h)。auto判定に使う。省略時は portrait 扱い。
 */
export function resolvePageSizePt(
  id: PageSizeId,
  orientation: PageOrientation,
  imgAspect?: number,
): { w: number; h: number } | null {
  if (id === "image") return null;
  const base = PAGE_SIZE_PT[id];
  let landscape: boolean;
  if (orientation === "auto") {
    // 画像が横長(aspect>1)なら横向き。情報がなければ縦向き。
    landscape = imgAspect !== undefined ? imgAspect > 1 : false;
  } else {
    landscape = orientation === "landscape";
  }
  return landscape ? { w: base.h, h: base.w } : { w: base.w, h: base.h };
}

/**
 * プレビュー用：枠のアスペクト比 (w/h) を返す。"image" のときは画像比をそのまま使う。
 */
export function pageFrameAspect(
  id: PageSizeId,
  orientation: PageOrientation,
  imgAspect?: number,
): number | undefined {
  const pt = resolvePageSizePt(id, orientation, imgAspect);
  if (!pt) return imgAspect; // image: 画像比
  return pt.w / pt.h;
}
