// src/lib/tauri.ts
// Tauri バックエンドコマンドの TypeScript ラッパー

import { invoke } from "@tauri-apps/api/core";

// ── 共通型 ────────────────────────────────────────────────────────────────────

export interface PageBounds {
  x: number; // ポイント (1pt = 1/72 inch)
  y: number;
  w: number;
  h: number;
  rotate: number; // PDF Rotate値 (0/90/180/270)。w,h はRotate考慮済み
}

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creation_date?: string;
  mod_date?: string;
}

export interface PdfInfo {
  page_count: number;
  pdf_version: string;
  encrypted: boolean;
  linearized: boolean;
  pages: PageBounds[];
  metadata: PdfMetadata;
  file_size?: number;
}

// ── stext (構造化テキスト) 型 ──────────────────────────────────────────────────

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface STextChar {
  c: string;
  quad: [number, number, number, number, number, number, number, number]; // ul,ur,ll,lr
  size: number;
  origin: [number, number];
}

export interface STextLine {
  bbox: BBox;
  wmode: number; // 0=横, 1=縦
  chars: STextChar[];
}

export interface STextBlock {
  type: "text" | "image";
  bbox: BBox;
  lines: STextLine[];
}

export interface PageTextResponse {
  ok: boolean;
  page: number;
  width_pt: number;
  height_pt: number;
  blocks: STextBlock[];
}

export interface SearchHit {
  page: number;
  quad: [number, number, number, number, number, number, number, number];
}

export interface SearchResponse {
  ok: boolean;
  hits: SearchHit[];
}

export interface PageLink {
  bbox: BBox;
  uri: string;
  dest_page?: number;
}

export interface PageLinksResponse {
  ok: boolean;
  links: PageLink[];
}

// ── stext コマンド ────────────────────────────────────────────────────────────

/** ページの構造化テキストを取得（テキスト選択オーバーレイ用） */
export async function getPageText(
  path: string,
  page: number,
  scale: number,
): Promise<PageTextResponse> {
  return invoke<PageTextResponse>("get_page_text", { path, page, scale });
}

/** ページ内テキスト検索 */
export async function searchPage(
  path: string,
  page: number,
  needle: string,
  scale: number,
): Promise<SearchResponse> {
  return invoke<SearchResponse>("search_page", { path, page, needle, scale });
}

/** ページのリンク一覧を取得 */
export async function getPageLinks(
  path: string,
  page: number,
  scale: number,
): Promise<PageLinksResponse> {
  return invoke<PageLinksResponse>("get_page_links", { path, page, scale });
}

// ── トリミング型 ──────────────────────────────────────────────────────────────

/** PDF ポイント単位のトリミングマージン */
export interface TrimMargins {
  left: number; //
  right: number; //
  bottom: number; //
  top: number; //
}

export type PageSelection =
  | { type: "All" }
  | { type: "Even" }
  | { type: "Odd" }
  | { type: "Range"; pages: number[] };

// ── 形式変換 ──────────────────────────────────────────────────────────────────

export interface ConvertResponse {
  ok: boolean;
  page_count: number;
  input_bytes: number;
  output_bytes: number;
}

/** リフロー可能文書（DOCX/EPUB/HTML）のレイアウト設定 */
export interface ConvertOptions {
  /** レイアウト幅 (pt)。省略時は 450pt（mutool デフォルト） */
  layoutW?: number;
  /** レイアウト高さ (pt)。省略時は 600pt */
  layoutH?: number;
  /** ベースフォントサイズ (pt)。省略時は 12pt */
  layoutEm?: number;
}

/** 非 PDF ファイル（EPUB, XPS, HTML, CBZ, DOCX, 画像等）を PDF に変換する */
export async function convertToPdf(
  input: string,
  output: string,
  options?: ConvertOptions,
): Promise<ConvertResponse> {
  return invoke<ConvertResponse>("convert_to_pdf", {
    input,
    output,
    layoutW: options?.layoutW ?? null,
    layoutH: options?.layoutH ?? null,
    layoutEm: options?.layoutEm ?? null,
  });
}

/** MuPDF がそのファイルを開けるか確認する */
export async function isMupdfSupported(path: string): Promise<boolean> {
  return invoke<boolean>("is_mupdf_supported", { path });
}

/** ファイルが PDF かどうかを確認する */
export async function isPdfFile(path: string): Promise<boolean> {
  return invoke<boolean>("is_pdf_file", { path });
}

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
  page: number, // 0-indexed
  dpi: number,
  options?: ConvertOptions,
): Promise<string> {
  // base64 JPEG
  const resp = await invoke<{ image_b64: string }>("render_page", {
    path,
    page,
    dpi,
    format: "jpeg",
    quality: 85,
    layoutW: options?.layoutW ?? null,
    layoutH: options?.layoutH ?? null,
    layoutEm: options?.layoutEm ?? null,
  });
  return resp.image_b64;
}

// ── トリミング ────────────────────────────────────────────────────────────────
// core.rs: trim_pdf(request: Value) -> call_core_json("trim", request)
// TrimRequest: { input, output, margins: { left, right, bottom, top }, unit, pages }
// ★ margins は pt 単位で渡し、unit: "pt" を指定する

export async function trimPdf(
  inputPath: string,
  outputPath: string,
  margins: TrimMargins,
  pages?: string,
  exclude?: string,
  extract?: string,
  layoutW?: number,
  layoutH?: number,
  layoutEm?: number,
): Promise<void> {
  await invoke("trim_pdf", {
    request: {
      input: inputPath,
      output: outputPath,
      margins: {
        left: margins.left,
        right: margins.right,
        bottom: margins.bottom,
        top: margins.top,
      },
      unit: "pt",
      pages,
      exclude,
      extract,
      layout_w: layoutW ?? null,
      layout_h: layoutH ?? null,
      layout_em: layoutEm ?? null,
    },
  });
}

// ── スクリーン情報 ────────────────────────────────────────────────────────────

export interface ScreenInfo {
  display_server: string;
  width: number;
  height: number;
  scale_factor: number;
}

export async function getScreenInfo(): Promise<ScreenInfo> {
  return invoke<ScreenInfo>("get_screen_info");
}

// ── 回転 ──────────────────────────────────────────────────────────────────────
// core.rs: rotate_pdf(request: Value) -> call_core_json("rotate", request)
// RotateRequest: { input, output, rotations: [{ page, angle }] }

export interface PageRotation {
  page: number; // 1始まり
  angle: number; // 0 | 90 | 180 | 270
}

export async function rotatePdf(
  inputPath: string,
  outputPath: string,
  rotations: PageRotation[],
  layoutW?: number,
  layoutH?: number,
  layoutEm?: number,
): Promise<void> {
  await invoke("rotate_pdf", {
    request: {
      input: inputPath,
      output: outputPath,
      rotations,
      layout_w: layoutW ?? null,
      layout_h: layoutH ?? null,
      layout_em: layoutEm ?? null,
    },
  });
}

// ── 圧縮 ──────────────────────────────────────────────────────────────────────
// CompressRequest: { input, output, preset?, compress_images?, compress_fonts?,
//                   garbage_level?, clean?, sanitize? }
// CompressResponse: { ok, input_bytes, output_bytes, ratio, params_used, warning? }

export type CompressPreset = "light" | "standard" | "aggressive" | "maximum";

export interface CompressRequest {
  preset?: CompressPreset;
  compress_images?: boolean;
  compress_fonts?: boolean;
  garbage_level?: number;
  clean?: boolean;
  sanitize?: boolean;
  object_stream?: boolean;
  merge_fonts?: boolean;
  /** リフロー文書変換レイアウト幅 (pt) */
  layout_w?: number;
  /** リフロー文書変換レイアウト高さ (pt) */
  layout_h?: number;
  /** リフロー文書変換フォントサイズ (pt) */
  layout_em?: number;
}

export interface CompressResponse {
  ok: boolean;
  input_bytes: number;
  output_bytes: number;
  ratio: number;
  params_used: {
    compress_images: boolean;
    compress_fonts: boolean;
    garbage_level: number;
    clean: boolean;
    sanitize: boolean;
    object_stream: boolean;
    merge_fonts: boolean;
    rewrite_fallback?: boolean;
  };
  warning?: string;
}

export async function compressPdf(
  inputPath: string,
  outputPath: string,
  opts: CompressRequest,
): Promise<CompressResponse> {
  console.log("compressPdf", inputPath, outputPath, opts);
  return invoke<CompressResponse>("compress_pdf", {
    request: {
      input: inputPath,
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
  ok: boolean;
  files: string[];
}

export async function splitPdf(
  inputPath: string,
  outDir: string,
  mode: SplitMode,
  prefix?: string,
  layoutW?: number,
  layoutH?: number,
  layoutEm?: number,
): Promise<SplitResponse> {
  return invoke<SplitResponse>("split_pdf", {
    request: {
      input: inputPath,
      out_dir: outDir,
      mode,
      prefix: prefix ?? null,
      layout_w: layoutW ?? null,
      layout_h: layoutH ?? null,
      layout_em: layoutEm ?? null,
    },
  });
}

// ── 結合 ──────────────────────────────────────────────────────────────────────

export interface MergeResponse {
  ok: boolean;
  page_count: number;
  output_bytes: number;
}

export async function mergePdf(
  inputs: string[],
  outputPath: string,
  layoutW?: number,
  layoutH?: number,
  layoutEm?: number,
): Promise<MergeResponse> {
  return invoke<MergeResponse>("merge_pdf", {
    request: {
      inputs,
      output: outputPath,
      layout_w: layoutW ?? null,
      layout_h: layoutH ?? null,
      layout_em: layoutEm ?? null,
    },
  });
}

// ── 画像変換 ──────────────────────────────────────────────────────────────────

export type ImageFormat = "jpeg" | "png" | "svg";

export interface ExportImagesResponse {
  ok: boolean;
  files: string[];
}

export async function exportImages(
  path: string,
  outDir: string,
  format: ImageFormat,
  dpi: number,
  quality?: number,
  namePrefix?: string,
  pages?: string, // "1-3,5" etc. undefined=全ページ
  options?: ConvertOptions,
): Promise<ExportImagesResponse> {
  console.log("ExportImages", path, outDir, format, dpi, quality, namePrefix, pages);
  try {
    const res = invoke<ExportImagesResponse>("export_images", {
      path,
      outDir,
      format,
      dpi,
      quality: quality ?? null,
      namePrefix: namePrefix ?? null,
      pages: pages ?? null,
      layoutW: options?.layoutW ?? null,
      layoutH: options?.layoutH ?? null,
      layoutEm: options?.layoutEm ?? null,
    });
    console.log("Res:ExportImages:", res);
    return res;
  } catch (e) {
    console.error("Err: ExportImages", path, outDir, format, dpi, quality, namePrefix, pages);
    throw e;
  }
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

export type GsLevel = "prepress" | "printer" | "ebook";

export async function checkGsInstalled(): Promise<boolean> {
  return await invoke<boolean>("check_ghostscript_installed");
}

export async function runGsOptimize(
  gs_path: string,
  input: string,
  output: string,
  level: GsLevel,
): Promise<void> {
  await invoke("run_gs_optimize", { gs_path, input, output, levelStr: level });
}

export async function runGsPreview(
  gs_path: string,
  input: string,
  output: string,
  level: GsLevel,
): Promise<void> {
  await invoke("run_gs_preview", { gs_path, input, output, levelStr: level });
}
