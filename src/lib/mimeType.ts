// src/lib/mimeType.ts
// SAF (ACTION_OPEN_DOCUMENT_TREE) 経由でのファイル作成時、MIMEタイプを
// 省略すると "application/octet-stream" になり、ギャラリーアプリ等から
// 画像/PDFとして認識されない。拡張子から簡易的に推定する。

export function guessMimeTypeFromPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    default:
      return null;
  }
}
