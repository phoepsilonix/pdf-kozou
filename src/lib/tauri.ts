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

// ── 隠しテキスト検出 ────────────────────────────────────────────────────────────

/** 透明テキスト検出の1文字分の結果 */
export interface TransparentChar {
  /** Unicode 文字 */
  char: string;
  /** アルファ値 0-255（0=完全透明） */
  alpha: number;
  /** RGB 色 [R, G, B] 各 0-255 */
  color_rgb: [number, number, number];
  /**
   * fz_stext_char.flags
   * FZ_STEXT_FILLED=16, FZ_STEXT_STROKED=32
   * flags=0  → Tr=3/7 由来の invisible（描画モードなし）
   * flags=16 → 通常描画だが alpha=0（ExtGState ca=0 による透明）
   */
  flags: number;
  /**
   * 検出理由
   * "invisible_mode" → Tr=3: 完全不可視（描画なし）
   * "clip_only_mode" → Tr=7: クリップパスのみ（塗りなし）
   * "transparent"    → ExtGState の fill alpha=0 による透明
   */
  reason: "invisible_mode" | "clip_only_mode" | "transparent" | "sanitized" | "whitespace_only";
  /** 文字の原点座標 [x, y] pt 単位 */
  origin: [number, number];
  /** 文字の四隅座標 [ul.x,ul.y, ur.x,ur.y, ll.x,ll.y, lr.x,lr.y] */
  quad: [number, number, number, number, number, number, number, number];
  /** フォントサイズ pt */
  size: number;
}

export interface DetectTransparentResponse {
  ok: boolean;
  page: number;
  hits: TransparentChar[];
}

/**
 * ページ内の透明テキストを検出する。
 * @param alphaThreshold この値以下の alpha を透明と見なす（0-255）。
 *   0 = 完全透明のみ（デフォルト）
 *  25 = alpha < 10% も検出
 */
export async function detectTransparentText(
  path: string,
  page: number,
  alphaThreshold?: number,
  options?: ConvertOptions,
): Promise<DetectTransparentResponse> {
  return invoke<DetectTransparentResponse>("detect_transparent_text", {
    path,
    page,
    alphaThreshold: alphaThreshold ?? null,
    layoutW: options?.layoutW ?? null,
    layoutH: options?.layoutH ?? null,
    layoutEm: options?.layoutEm ?? null,
  });
}

// ── 隠しテキスト置き換え（試験的） ────────────────────────────────────────────

/**
 * ⚠ 試験的機能
 * 全ての隠しテキスト手法を網羅できる保証はありません。
 * 本機能の使用による損害について開発者は責任を負いません。
 * 特殊なプロパティ・要素・フォントに潜ませたテキストは検出・置換できない場合があります。
 */
export interface SanitizeOrigin {
  x: number;
  y: number;
}

export interface SanitizeResponse {
  ok: boolean;
  /** 置き換えを試みた文字数 */
  replaced: number;
  warning?: string;
}

export interface SanitizeRequest {
  input: string;
  output: string;
  /** detect_* の hits から収集した origin 座標リスト */
  targets: SanitizeOrigin[];
  /** 座標照合の許容距離 pt (デフォルト 1.0) */
  tolerance?: number;
  layoutW?: number;
  layoutH?: number;
  layoutEm?: number;
}

/**
 * 隠しテキストの文字コードをスペースに置き換える（試験的）。
 *
 * detect_* 関数が返した hits の origin をそのまま targets に渡すことで、
 * 検出タイプごとに選択的に置き換えができる。
 * グリフ幅は TJ カーニングで補正するのでレイアウトは維持される。
 *
 * ⚠ 試験的機能。使用による損害について開発者は責任を負いません。
 */
export async function sanitizeHiddenText(req: SanitizeRequest): Promise<SanitizeResponse> {
  return invoke<SanitizeResponse>("sanitize_hidden_text", {
    request: {
      input: req.input,
      output: req.output,
      targets: req.targets,
      tolerance: req.tolerance ?? null,
      layout_w: req.layoutW ?? null,
      layout_h: req.layoutH ?? null,
      layout_em: req.layoutEm ?? null,
    },
  });
}

/** 埋没テキスト検出の1文字分の結果 */
export interface BuriedChar {
  char: string;
  color_rgb: [number, number, number];
  size: number;
  /** "buried" | "sanitized" | "whitespace_only" */
  reason: string;
  origin: [number, number];
  quad: [number, number, number, number, number, number, number, number];
}

export interface DetectBuriedResponse {
  ok: boolean;
  page: number;
  hits: BuriedChar[];
}

/**
 * 後から描画された不透明オブジェクト（矩形・画像）に
 * 覆われたテキストを検出する。
 * @param coverRatio 覆われ率の閾値 0.0〜1.0 (デフォルト 0.8)
 *   文字bboxの80%以上が後続オブジェクトに覆われていれば隠蔽と判定。
 */
export async function detectBuriedText(
  path: string,
  page: number,
  coverRatio?: number,
  options?: ConvertOptions,
): Promise<DetectBuriedResponse> {
  return invoke<DetectBuriedResponse>("detect_buried_text", {
    path,
    page,
    coverRatio: coverRatio ?? null,
    layoutW: options?.layoutW ?? null,
    layoutH: options?.layoutH ?? null,
    layoutEm: options?.layoutEm ?? null,
  });
}

/** 極小フォント検出の1文字分の結果 */
export interface TinyChar {
  char: string;
  size: number;
  color_rgb: [number, number, number];
  /** "tiny_font" | "sanitized" | "whitespace_only" */
  reason: string;
  origin: [number, number];
  quad: [number, number, number, number, number, number, number, number];
}

export interface DetectTinyResponse {
  ok: boolean;
  page: number;
  hits: TinyChar[];
}

/**
 * 極小フォントの文字を検出する。
 * @param sizeThreshold フォントサイズの閾値 pt (デフォルト 2.0)
 *   この値以下のサイズを持つ文字を検出する。
 *   0.1 = ほぼ不可視なものだけ
 *   2.0 = 人間が読めないサイズ以下（デフォルト推奨）
 *   5.0 = 読みにくいサイズも含む
 */
export async function detectTinyText(
  path: string,
  page: number,
  sizeThreshold?: number,
  options?: ConvertOptions,
): Promise<DetectTinyResponse> {
  return invoke<DetectTinyResponse>("detect_tiny_text", {
    path,
    page,
    sizeThreshold: sizeThreshold ?? null,
    layoutW: options?.layoutW ?? null,
    layoutH: options?.layoutH ?? null,
    layoutEm: options?.layoutEm ?? null,
  });
}

/** 低コントラストテキスト検出の1文字分の結果 */
export interface LowContrastChar {
  char: string;
  color_rgb: [number, number, number];
  bg_color_rgb: [number, number, number];
  contrast: number;
  /** "low_contrast" | "sanitized" | "whitespace_only" */
  reason: string;
  origin: [number, number];
  quad: [number, number, number, number, number, number, number, number];
  size: number;
}

export interface DetectLowContrastResponse {
  ok: boolean;
  page: number;
  hits: LowContrastChar[];
}

/**
 * 文字色と背景色のコントラスト比が低い文字を検出する。
 * @param contrastThreshold 1.0〜21.0 (デフォルト 1.5 = ほぼ同色のみ)
 *   白地白文字・黒地黒文字・任意の同色系を検出。
 *   3.0 にするとかなり見えにくいものも検出。
 */
export async function detectLowContrastText(
  path: string,
  page: number,
  contrastThreshold?: number,
  options?: ConvertOptions,
): Promise<DetectLowContrastResponse> {
  return invoke<DetectLowContrastResponse>("detect_low_contrast_text", {
    path,
    page,
    contrastThreshold: contrastThreshold ?? null,
    layoutW: options?.layoutW ?? null,
    layoutH: options?.layoutH ?? null,
    layoutEm: options?.layoutEm ?? null,
  });
}

/** 特殊制御文字検出の1文字分の結果 */
export interface ControlChar {
  /** コードポイント表記 (例: "U+200B") */
  char: string;
  /** コードポイント十進数 */
  codepoint: number;
  /**
   * 分類
   * - "zero_width"     : U+200B〜200F ゼロ幅文字
   * - "bidi_control"   : U+202A〜202E 双方向制御文字
   * - "line_separator" : U+2028/2029 行/段落区切り
   * - "bom_zwnbsp"     : U+FEFF BOM/ゼロ幅ノーブレークスペース
   * - "tag_char"       : U+E0000〜E007F Unicode タグ文字
   */
  category: "zero_width" | "bidi_control" | "line_separator" | "bom_zwnbsp" | "tag_char";
  /** "control_char" | "sanitized" */
  reason: string;
  origin: [number, number];
  quad: [number, number, number, number, number, number, number, number];
  size: number;
}

export interface DetectControlCharsResponse {
  ok: boolean;
  page: number;
  hits: ControlChar[];
}

/**
 * 特殊制御文字を検出する。
 * AIへの悪意ある注入に使われるゼロ幅文字・双方向制御文字・タグ文字等を検出。
 * 改行(LF/CR)・タブ(TAB)は正常用途が多いため除外。
 */
export async function detectControlChars(
  path: string,
  page: number,
  options?: ConvertOptions,
): Promise<DetectControlCharsResponse> {
  return invoke<DetectControlCharsResponse>("detect_control_chars", {
    path,
    page,
    layoutW: options?.layoutW ?? null,
    layoutH: options?.layoutH ?? null,
    layoutEm: options?.layoutEm ?? null,
  });
}

// ── N-up / 製本 面付けレンダリング ────────────────────────────────────────────

export interface RenderImpositionRequest {
  path: string;
  /** cols × rows 個の配置ページ番号（1始まり、0=空白セル） */
  pageNums: number[];
  cols: number;
  rows: number;
  /** 出力DPI（1セル分の解像度基準） */
  dpi: number;
  /** "jpeg" | "png" */
  format?: string;
  /** JPEG品質 1-100 */
  quality?: number;
  /** セル間ギャップ px（出力解像度基準） */
  gapPx?: number;
  layoutW?: number;
  layoutH?: number;
  layoutEm?: number;
}

export interface RenderImpositionResponse {
  ok: boolean;
  /** base64エンコードされた画像データ */
  image_b64: string;
  format: string;
}

/**
 * N-up / 製本 面付けレンダリング。
 * 複数ページを1枚のpixmapに直接レンダリングして返す。
 * JPEG/PNG圧縮は1回のみのため画質劣化が最小。
 *
 * @example 2-up（p1左・p2右）
 * renderImposition({ path, pageNums: [1, 2], cols: 2, rows: 1, dpi: 300 })
 *
 * @example 製本見開き（p4右・p1左）
 * renderImposition({ path, pageNums: [4, 1], cols: 2, rows: 1, dpi: 300 })
 */
export async function renderImposition(
  req: RenderImpositionRequest,
): Promise<RenderImpositionResponse> {
  return invoke<RenderImpositionResponse>("render_imposition", {
    request: {
      path: req.path,
      page_nums: req.pageNums,
      cols: req.cols,
      rows: req.rows,
      dpi: req.dpi,
      format: req.format ?? null,
      quality: req.quality ?? null,
      gap_px: req.gapPx ?? null,
      layout_w: req.layoutW ?? null,
      layout_h: req.layoutH ?? null,
      layout_em: req.layoutEm ?? null,
    },
  });
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

export async function getPdfInfo(path: string, options?: ConvertOptions): Promise<PdfInfo> {
  return invoke<PdfInfo>("get_pdf_info", {
    path,
    layoutW: options?.layoutW ?? null,
    layoutH: options?.layoutH ?? null,
    layoutEm: options?.layoutEm ?? null,
  });
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

// ── パスの同一性チェック ──────────────────────────────────────────────────────

export async function checkPathConflict(params: {
  inputPath: string;
  outDir: string;
  pdfName?: string;
  isBatch: boolean;
  batchFiles?: Array<[string, string]> | null;
}): Promise<string[]> {
  return await invoke("check_path_conflict", params);
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

/** 分割前に編集したメタデータ。key は PDF /Info キー名（"Title", "Author" 等）。*/
export interface OverrideMeta {
  key: string;
  value: string;
}

export async function splitPdf(
  inputPath: string,
  outDir: string,
  mode: SplitMode,
  prefix?: string,
  layoutW?: number,
  layoutH?: number,
  layoutEm?: number,
  overrideMetadata?: OverrideMeta[],
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
      override_metadata: overrideMetadata ? overrideMetadata.map((m) => [m.key, m.value]) : null,
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

export interface ExportImagePdfResponse {
  ok: boolean;
  output_bytes: number;
  warning?: string;
}

/// 指定ページを DPI でラスタライズして 1 つの画像 PDF に書き出す。
/// pages: "1-3,5" 形式の 1 ベース指定。undefined で全ページ。
/// outPath: 出力先フルパス (.pdf)
export async function exportImagePdf(
  path: string,
  outPath: string,
  dpi: number,
  quality: number,
  usePng: boolean,
  pages?: string,
  options?: ConvertOptions,
): Promise<ExportImagePdfResponse> {
  return invoke<ExportImagePdfResponse>("export_image_pdf", {
    path,
    outPath,
    dpi,
    quality,
    usePng,
    pages: pages ?? null,
    layoutW: options?.layoutW ?? null,
    layoutH: options?.layoutH ?? null,
    layoutEm: options?.layoutEm ?? null,
  });
}

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

// ── メタデータ編集 ────────────────────────────────────────────────────────────

export interface MetadataField {
  key: string;
  value: string;
}

/** PDF のメタデータを上書き保存する。value が空文字列のフィールドは削除。 */
export async function setPdfMetadata(path: string, metadata: MetadataField[]): Promise<void> {
  await invoke("set_pdf_metadata", { path, metadata });
}

// ── GS パス管理 ───────────────────────────────────────────────────────────────

/** 指定パスが有効な GS か検証し、バージョン文字列を返す */
export async function verifyGsPath(path: string): Promise<string> {
  return invoke<string>("verify_gs_path", { path });
}

/** ファイル選択ダイアログで GS 実行ファイルを選択する */
export async function pickGsExecutable(): Promise<string | null> {
  return invoke<string | null>("pick_gs_executable");
}

/** カスタムパスを含めて GS を検索する */
export async function findGsExecutable(customGsPath?: string): Promise<string | null> {
  return invoke<string | null>("find_gs_executable", {
    // Tauri は camelCase → snake_case に変換: customGsPath → custom_gs_path
    customGsPath: customGsPath || null, // 空文字は null として扱う
  });
}

/** 指定フォルダ以下で GS を自動検索する */
export async function findGsInDir(dir: string): Promise<string | null> {
  return invoke<string | null>("find_gs_in_dir", { dir });
}

/** OS のデフォルトインストール先から GS 候補を返す */
export async function suggestGsCandidates(): Promise<string[]> {
  return invoke<string[]>("suggest_gs_candidates");
}

// ── 画像メタデータ ────────────────────────────────────────────────────────

/** 画像ファイル（JPEG/PNG/SVG）のメタデータを読み込む */
export async function getImageMetadata(path: string): Promise<MetadataField[]> {
  const res = await invoke<{ metadata: { key: string; value: string }[] }>("get_image_metadata", {
    path,
  });
  return res.metadata.map(({ key, value }) => ({ key, value }));
}

/** 画像ファイル（JPEG/PNG/SVG）のメタデータを上書き保存する */
export async function setImageMetadata(path: string, metadata: MetadataField[]): Promise<void> {
  await invoke("set_image_metadata", { path, metadata });
}
