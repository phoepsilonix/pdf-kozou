// src/lib/tauri.ts
// Tauri バックエンドコマンドの TypeScript ラッパー

import { invoke } from "@tauri-apps/api/core";

// ── 共通型 ────────────────────────────────────────────────────────────────────

export interface PageBounds {
  x: number;   // ポイント (1pt = 1/72 inch)
  y: number;
  w: number;
  h: number;
  rotate: number;   // PDF Rotate値 (0/90/180/270)。w,h はRotate考慮済み
}

export interface PdfInfo {
  page_count:  number;
  pdf_version: string;
  encrypted:   boolean;
  linearized:  boolean;
  pages:       PageBounds[];
}

// ── トリミング型 ──────────────────────────────────────────────────────────────

/** PDF ポイント単位のトリミングマージン */
export interface TrimMargins {
  left:   number;  // pt
  right:  number;  // pt
  bottom: number;  // pt
  top:    number;  // pt
}

export type PageSelection =
  | { type: "All" }
  | { type: "Even" }
  | { type: "Odd" }
  | { type: "Range"; pages: number[] };

// ── ファイルダイアログ ────────────────────────────────────────────────────────

export async function pickOpenFile(): Promise<string | null> {
  return invoke<string | null>("pick_open_file");
}

export async function pickSaveFile(defaultName: string): Promise<string | null> {
  return invoke<string | null>("pick_save_file", { defaultName });
}

export async function pickOutputDir(): Promise<string | null> {
  return invoke<string | null>("pick_output_dir");
}

// ── PDF 情報取得 ──────────────────────────────────────────────────────────────

export async function getPdfInfo(path: string): Promise<PdfInfo> {
  return invoke<PdfInfo>("get_pdf_info", { path });
}

// ── ページレンダリング ────────────────────────────────────────────────────────
// core.rs: render_page(path: String, page: i32, dpi: u32, format, quality) -> Value
// レスポンス (RenderResponse): { ok, image_b64, format, width_px, height_px, ... }

export async function renderPage(
  path: string,
  page: number,   // 0-indexed
  dpi:  number,
): Promise<string> {  // base64 JPEG
  const resp = await invoke<{ image_b64: string }>("render_page", {
    path,
    page,
    dpi,
    format:  "jpeg",
    quality: 85,
  });
  return resp.image_b64;
}

// ── トリミング ────────────────────────────────────────────────────────────────
// core.rs: trim_pdf(request: Value) -> call_core_json("trim", request)
// TrimRequest: { input, output, margins: { left, right, bottom, top }, unit, pages }
// ★ margins は pt 単位で渡し、unit: "pt" を指定する

export async function trimPdf(
  inputPath:    string,
  outputPath:   string,
  margins:      TrimMargins,
  pages:        PageSelection,
  extractPages?: number[],    // 1始まりページ番号の配列 (undefined = 全ページ保持)
): Promise<void> {
  await invoke("trim_pdf", {
    request: {
      input:   inputPath,
      output:  outputPath,
      margins: margins,
      unit:  "pt",
      pages: pages,
      extract_pages: extractPages,
    },
  });
}

// ── スクリーン情報 ────────────────────────────────────────────────────────────

export interface ScreenInfo {
  display_server: string;
  width:          number;
  height:         number;
  scale_factor:   number;
}

export async function getScreenInfo(): Promise<ScreenInfo> {
  return invoke<ScreenInfo>("get_screen_info");
}

// ── 回転 ──────────────────────────────────────────────────────────────────────
// core.rs: rotate_pdf(request: Value) -> call_core_json("rotate", request)
// RotateRequest: { input, output, rotations: [{ page, angle }] }

export interface PageRotation {
  page:  number;  // 1始まり
  angle: number;  // 0 | 90 | 180 | 270
}

export async function rotatePdf(
  inputPath:  string,
  outputPath: string,
  rotations:  PageRotation[],
): Promise<void> {
  await invoke("rotate_pdf", {
    request: {
      input:     inputPath,
      output:    outputPath,
      rotations,
    },
  });
}

// ── 圧縮 ──────────────────────────────────────────────────────────────────────
// CompressRequest: { input, output, preset?, compress_images?, compress_fonts?,
//                   garbage_level?, clean?, sanitize? }
// CompressResponse: { ok, input_bytes, output_bytes, ratio, params_used, warning? }

export type CompressPreset = "light" | "standard" | "aggressive" | "maximum";

export interface CompressRequest {
  preset?:          CompressPreset;
  compress_images?: boolean;
  compress_fonts?:  boolean;
  garbage_level?:   number;
  clean?:           boolean;
  sanitize?:        boolean;
  /** フォントサブセット化 (pdf_subset_fonts FFI)。
   *  MuPDF 1.28 では CJK/多言語フォントで不安定なため、デフォルト無効。
   *  明示的に true を渡した場合のみ実行される。 */
  font_subset?:     boolean;
}

export interface CompressResponse {
  ok:           boolean;
  input_bytes:  number;
  output_bytes: number;
  ratio:        number;
  params_used:  {
    compress_images: boolean;
    compress_fonts:  boolean;
    garbage_level:   number;
    clean:           boolean;
    sanitize:        boolean;
    rewrite_fallback?: boolean;
  };
  warning?: string;
}

export async function compressPdf(
  inputPath:  string,
  outputPath: string,
  opts:       CompressRequest,
): Promise<CompressResponse> {
  return invoke<CompressResponse>("compress_pdf", {
    request: {
      input:  inputPath,
      output: outputPath,
      ...opts,
    },
  });
}

// ── ユーティリティ ────────────────────────────────────────────────────────────

export async function getDefaultSaveDir(): Promise<string> {
  return invoke<string>("get_default_save_dir");
}

export async function getTmpPath(filename: string): Promise<string> {
  return invoke<string>("get_tmp_path", { filename });
}

// ── 分割 ──────────────────────────────────────────────────────────────────────

export type SplitMode =
  | { type: "AllPages" }
  | { type: "EveryN"; n: number }
  | { type: "Ranges"; ranges: [number, number][] };

export interface SplitResponse {
  ok:    boolean;
  files: string[];
}

export async function splitPdf(
  inputPath: string,
  outDir:    string,
  mode:      SplitMode,
  prefix?:   string,
): Promise<SplitResponse> {
  return invoke<SplitResponse>("split_pdf", {
    request: { input: inputPath, out_dir: outDir, mode, prefix: prefix ?? null },
  });
}

// ── 結合 ──────────────────────────────────────────────────────────────────────

export interface MergeResponse {
  ok:           boolean;
  page_count:   number;
  output_bytes: number;
}

export async function mergePdf(
  inputs:     string[],
  outputPath: string,
): Promise<MergeResponse> {
  return invoke<MergeResponse>("merge_pdf", {
    request: { inputs, output: outputPath },
  });
}

// ── 画像変換 ──────────────────────────────────────────────────────────────────

export type ImageFormat = "jpeg" | "png" | "svg";

export interface ExportImagesResponse {
  ok:    boolean;
  files: string[];
}

export async function exportImages(
  path:        string,
  outDir:      string,
  format:      ImageFormat,
  dpi:         number,
  quality?:    number,
  namePrefix?: string,
  pages?:      string,  // "1-3,5" etc. undefined=全ページ
): Promise<ExportImagesResponse> {
  return invoke<ExportImagesResponse>("export_images", {
    path, outDir, format, dpi,
    quality:    quality    ?? null,
    namePrefix: namePrefix ?? null,
    pages:      pages      ?? null,
  });
}

// ── 回転 (tauri.ts 既存の rotatePdf は PageRotation[] 形式) ──────────────────
// rotate_pdf コマンドは invoke("rotate_pdf", { request: { input, output, angle?, rotations? } })

// ── ファイル操作ユーティリティ ──────────────────────────────────────────────

export async function moveFile(src: string, dst: string): Promise<void> {
  return invoke("move_file", { src, dst });
}

export async function copyFile(src: string, dst: string): Promise<void> {
  return invoke("copy_file", { src, dst });
}

export async function getTempPath(name: string): Promise<string> {
  return invoke<string>("get_temp_path", { name });
}
