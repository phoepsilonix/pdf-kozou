// src/lib/tauri.ts
// Tauri バックエンドコマンドの TypeScript 型定義

import { invoke } from "@tauri-apps/api/core";

// ── 共通型 ────────────────────────────────────────────────────────────────────

export interface PageBounds {
  x: number;   // ポイント (1pt = 1/72 inch)
  y: number;
  w: number;
  h: number;
}

export interface PdfInfo {
  page_count:  number;
  pdf_version: string;
  encrypted:   boolean;
  linearized:  boolean;
  pages:       PageBounds[];  // 全ページのサイズ
}

// ── トリミング ────────────────────────────────────────────────────────────────

/** PDF ポイント単位のトリミングマージン */
export interface TrimMargins {
  left:   number;
  right:  number;  // 右端の絶対座標 (pt)
  bottom: number;
  top:    number;  // 上端の絶対座標 (pt)
}

export type PageSelection =
  | { type: "All" }
  | { type: "Even" }
  | { type: "Odd" }
  | { type: "Range"; pages: number[] };

export interface TrimPreviewResult {
  /** base64 エンコードされた JPEG 画像 */
  image_b64: string;
  width_px:  number;
  height_px: number;
  /** プレビュー画像上でのトリミング矩形 (ピクセル) */
  crop_rect: { x: number; y: number; w: number; h: number };
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

// ── ページレンダリング (プレビュー用) ─────────────────────────────────────────

export async function renderPage(
  path: string,
  pageIndex: number,
  dpi: number,
): Promise<string> {  // base64 JPEG
  return invoke<string>("render_page", { path, pageIndex, dpi });
}

// ── トリミング ────────────────────────────────────────────────────────────────

export async function trimPreview(
  path:      string,
  pageIndex: number,
  margins:   TrimMargins,
  dpi:       number,
): Promise<TrimPreviewResult> {
  return invoke<TrimPreviewResult>("trim_preview", { path, pageIndex, margins, dpi });
}

export async function trimPdf(
  inputPath:  string,
  outputPath: string,
  margins:    TrimMargins,
  pages:      PageSelection,
): Promise<void> {
  return invoke<void>("trim_pdf", { inputPath, outputPath, margins, pages });
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
