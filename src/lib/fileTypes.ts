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
