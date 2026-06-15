// src/lib/fileTypes.ts
// MuPDF が対応するファイル形式の定義

/** MuPDF が対応するファイル拡張子（小文字） */
export const MUPDF_EXTENSIONS = [
  "pdf",
  "epub",
  "xps",
  "oxps",
  "cbz",
  "cbr",
  "html",
  "htm",
  "xhtml",
  "svg",
  "jpg",
  "jpeg",
  "png",
  "bmp",
  "gif",
  "tiff",
  "tif",
  "webp",
  "docx",
  "xlsx",
  "pptx", // MuPDF 1.28 以降
] as const;

/** 拡張子文字列から MuPDF 対応ファイルかどうかを判定する */
export function isMupdfExtension(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return (MUPDF_EXTENSIONS as readonly string[]).includes(ext);
}

/** ファイルパスから拡張子を除いたステム部分を返す */
export function stemName(filename: string): string {
  return filename.replace(/\.[^/.]+$/, "");
}

/** ファイルリストに非 PDF（変換が必要な）ファイルが含まれるか判定 */
export function hasNonPdf(filenames: string[]): boolean {
  return filenames.some((f) => {
    const ext = f.split(".").pop()?.toLowerCase() ?? "";
    return ext !== "pdf";
  });
}

/**
 * リフロー（レイアウト依存）変換が意味を持つ文書形式。
 * EPUB/HTML/DOCX 等はビューポート幅で本文がリフローするためレイアウト設定が効く。
 * 画像・PDF・固定レイアウト（xps/oxps/cbz/cbr）はリフローしないため含めない。
 */
export const REFLOWABLE_EXTENSIONS = ["epub", "html", "htm", "xhtml", "docx", "xlsx", "pptx"];

/** ファイルリストにリフロー文書（レイアウト設定が有効なもの）が含まれるか判定 */
export function hasReflowable(filenames: string[]): boolean {
  return filenames.some((f) => {
    const ext = f.split(".").pop()?.toLowerCase() ?? "";
    return REFLOWABLE_EXTENSIONS.includes(ext);
  });
}

/** 画像ファイル拡張子（MuPDFが画像として読み込むもの） */
export const IMAGE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "svg",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "webp",
  "pnm",
  "pgm",
  "ppm",
  "pbm",
];

/** ファイル名リストに画像ファイルが含まれるか */
export function hasImage(filenames: string[]): boolean {
  return filenames.some((f) => {
    const ext = f.split(".").pop()?.toLowerCase() ?? "";
    return IMAGE_EXTENSIONS.includes(ext);
  });
}
