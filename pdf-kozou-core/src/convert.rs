// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/convert.rs
//
// 非 PDF ファイル（EPUB, DOCX, XPS, HTML, CBZ, 画像等）を PDF に変換する。
//
// 設計方針:
//   - mupdf::Document::open（Rust バインディング）を使わない
//     → system-fonts feature の font_kit が Windows でフォントスキャンし
//       フリーズ・メモリ増大の原因になる
//   - C FFI (kozou_convert_to_pdf) のみ使用
//     → fz_open_document + fz_layout_document + pdf_page_write で変換
//     → フォントスキャンは行われない

use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};

const MUPDF_EXTENSIONS: &[&str] = &[
    "pdf", "epub", "xps", "oxps", "cbz", "cbr", "html", "htm", "xhtml", "svg", "jpg", "jpeg",
    "png", "bmp", "gif", "tiff", "tif", "webp", "docx", "xlsx", "pptx",
];

pub fn is_mupdf_supported(path: &str) -> bool {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    MUPDF_EXTENSIONS.contains(&ext.as_str())
}

pub fn is_pdf(path: &str) -> bool {
    path.to_lowercase().ends_with(".pdf")
}

#[derive(Debug, Deserialize)]
pub struct ConvertRequest {
    pub input: String,
    pub output: String,
    #[serde(default)]
    pub layout_w: Option<f32>,
    #[serde(default)]
    pub layout_h: Option<f32>,
    #[serde(default)]
    pub layout_em: Option<f32>,
    /// 画像入力時に出力ページを固定する目標サイズ(pt)。
    /// 0/未指定なら従来動作（元の寸法をそのまま使う）。
    #[serde(default)]
    pub page_w_pt: Option<f32>,
    #[serde(default)]
    pub page_h_pt: Option<f32>,
    /// 1/true: ページごとに画像の縦横比で向きを自動選択する。
    /// 明示指定（縦/横）のときは false。
    #[serde(default)]
    pub auto_orient: Option<bool>,
}

#[derive(Serialize)]
pub struct ConvertResponse {
    pub ok: bool,
    pub page_count: i32,
    pub input_bytes: u64,
    pub output_bytes: u64,
}

/// 非 PDF ファイルを PDF に変換する。
///
/// - SVG: svg2pdf でソフトマスク保持の PDF に変換し、その出力を **そのまま** 使う。
/// - それ以外: C FFI (kozou_convert_to_pdf) で MuPDF 変換（フォントスキャン回避のため
///   Rust バインディング mupdf::Document::open は使わない）。
pub fn convert_to_pdf(req: &ConvertRequest) -> Result<ConvertResponse> {
    use crate::ffi::{FfiResult, kozou_convert_to_pdf as ffi_convert, kozou_new_context};
    use std::ffi::CString;

    eprintln!("[convert] start: {}", req.input);

    if is_svg(&req.input) {
        // SVG は svg2pdf の生 PDF をそのまま出力に書き出す。
        //
        // 重要: ここで MuPDF の PDF->PDF 再変換（kozou_convert_to_pdf）を通してはいけない。
        // kozou_convert_to_pdf は fz_run_page -> pdf 出力デバイスでページを「再emit」するが、
        // MuPDF はこの再emit時に svg2pdf が生成するグラフィックス状態ソフトマスク
        // (ExtGState /SMask グループ) を正しく出力できず、透過喪失・背景画像欠落を起こす
        // （Firefox / mutool / MuPDF いずれのビューワーでも確認）。
        // svg2pdf の生 PDF はどのビューワーでも正しいため、再変換せず直接書き出す。
        //
        // 後段のメタデータ書き込み (copy_metadata_after_write) は incremental 追記、または
        // clean=false のロスレス再シリアライズで、ページを再emitしないためソフトマスクを壊さない。
        //
        // ページサイズ fit / auto_orient:
        // page_w_pt/page_h_pt が指定されているときは、svg2pdf::to_chunk で SVG を
        // Form XObject 化し、目標サイズの台紙にアスペクト維持でフィット配置する。
        // to_chunk は pdf-writer で組み立てるだけで MuPDF 再emit を通らないため、
        // ソフトマスク（透過）は保持される。未指定（「元サイズ」）のときは従来どおり
        // svg2pdf::to_pdf の自然サイズ出力をそのまま使う。
        let pw = req.page_w_pt.unwrap_or(0.0);
        let ph = req.page_h_pt.unwrap_or(0.0);
        if pw > 0.0 && ph > 0.0 {
            svg_to_pdf_sized(
                &req.input,
                &req.output,
                pw,
                ph,
                req.auto_orient.unwrap_or(false),
            )?;
        } else {
            svg_to_pdf(&req.input, &req.output)?;
        }
    } else {
        // 非 SVG: 従来どおり C FFI (MuPDF) で変換。
        let c_input = CString::new(req.input.as_str())
            .map_err(|_| CoreError::InvalidArg("invalid input path".into()))?;
        let c_output = CString::new(req.output.as_str())
            .map_err(|_| CoreError::InvalidArg("invalid output path".into()))?;

        let lw = req.layout_w.unwrap_or(450.0);
        let lh = req.layout_h.unwrap_or(600.0);
        let lem = req.layout_em.unwrap_or(12.0);
        let pw = req.page_w_pt.unwrap_or(0.0);
        let ph = req.page_h_pt.unwrap_or(0.0);
        let auto_orient = if req.auto_orient.unwrap_or(false) {
            1
        } else {
            0
        };

        eprintln!(
            "[convert] calling C FFI: layout={lw}x{lh} em={lem} page={pw}x{ph} auto_orient={auto_orient}"
        );

        unsafe {
            let ctx = kozou_new_context();
            if ctx.is_null() {
                return Err(CoreError::MuPdf("kozou_new_context failed".into()));
            }
            let mut res = FfiResult::default();
            ffi_convert(
                ctx,
                c_input.as_ptr(),
                c_output.as_ptr(),
                lw,
                lh,
                lem,
                pw,
                ph,
                auto_orient,
                &mut res,
            );
            mupdf_sys::fz_drop_context(ctx);
            if res.ok == 0 {
                eprintln!("[convert] C FFI failed: {res}");
                return Err(CoreError::MuPdf(format!("{res}")));
            }
        }

        eprintln!("[convert] C FFI succeeded");
    }

    // メタデータを引き継ぐ（タグ / 画像 EXIF など）。
    // collect_metadata は入力種別に応じて値を返す。書き込みは incremental 追記か
    // clean=false の再シリアライズで行われ、ページ内容を再emitしないため
    // svg2pdf 出力のソフトマスク（透過）は保たれる。
    eprintln!("[convert] collecting metadata from input...");
    let metadata = crate::compress::collect_metadata(&req.input);
    eprintln!("[convert] metadata collected: {} keys", metadata.len());
    if !metadata.is_empty() {
        eprintln!("[convert] writing metadata to output...");
        crate::compress::copy_metadata_after_write(&req.output, &metadata);
        eprintln!("[convert] metadata written");
    }

    let input_bytes = std::fs::metadata(&req.input).map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);

    eprintln!("[convert] getting page_count from output PDF...");
    let page_count = mupdf::pdf::PdfDocument::open(&req.output)
        .and_then(|d| d.page_count())
        .unwrap_or(0);

    eprintln!("[convert] done: {page_count} pages, {input_bytes}→{output_bytes} bytes");

    Ok(ConvertResponse {
        ok: true,
        page_count,
        input_bytes,
        output_bytes,
    })
}

/// 拡張子が svg かどうか（大文字小文字を無視）。
pub fn is_svg(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("svg"))
        .unwrap_or(false)
}

/// SVG を svg2pdf でベクタ PDF に変換する。
///
/// MuPDF の SVG リーダは画像を luminance マスクとして使う `<mask>`（元 PDF の
/// ソフトマスク = SMask 由来）を解釈できず、透明部分が脱落して黒い矩形になる。
/// usvg/svg2pdf はこれを正しい PDF ソフトマスクとして出力するため、変換後の
/// PDF は MuPDF でも（プレビュー・再エクスポートを含め）正しく描画される。
/// テキストは usvg がフォントを解決してアウトライン化する（システムフォント使用）。
fn svg_to_pdf(input: &str, output: &str) -> Result<()> {
    let svg = std::fs::read_to_string(input)?;

    // usvg は svg2pdf が再エクスポートするものを使う（別 crate として宣言すると
    // バージョン二重化で svg2pdf::to_pdf に渡す Tree の型が一致しなくなる）。
    let mut options = svg2pdf::usvg::Options::default();
    options.fontdb_mut().load_system_fonts();

    let tree = svg2pdf::usvg::Tree::from_str(&svg, &options)
        .map_err(|e| CoreError::Parse(format!("usvg parse failed: {e}")))?;

    let pdf = svg2pdf::to_pdf(
        &tree,
        svg2pdf::ConversionOptions::default(),
        svg2pdf::PageOptions::default(),
    );

    std::fs::write(output, pdf)?;
    Ok(())
}

/// SVG を指定ページサイズ(pt)の台紙に、アスペクト維持でフィット配置した PDF を生成する。
///
/// svg2pdf::to_chunk で SVG を Form XObject（1×1 ポイントの単位）に変換し、pdf-writer で
/// 目標サイズのページに content transform で配置する。to_pdf と異なり MuPDF も介さず
/// pdf-writer のみで組み立てるため、svg2pdf が生成するソフトマスク（透過）を壊さない。
///
/// auto_orient=true のときは SVG の縦横比に合わせて台紙の向き（縦/横）を選ぶ。
/// SVG サイズが取得できない等の場合は自然サイズ（svg_to_pdf）にフォールバックする。
fn svg_to_pdf_sized(
    input: &str,
    output: &str,
    page_w_pt: f32,
    page_h_pt: f32,
    auto_orient: bool,
) -> Result<()> {
    use pdf_writer::{Content, Finish, Name, Pdf, Rect, Ref};
    use std::collections::HashMap;

    let svg = std::fs::read_to_string(input)?;
    let mut options = svg2pdf::usvg::Options::default();
    options.fontdb_mut().load_system_fonts();
    let tree = svg2pdf::usvg::Tree::from_str(&svg, &options)
        .map_err(|e| CoreError::Parse(format!("usvg parse failed: {e}")))?;

    // SVG 固有サイズ（pt）。取得できなければ自然サイズにフォールバック。
    let svg_w = tree.size().width();
    let svg_h = tree.size().height();
    if !(svg_w > 0.0 && svg_h > 0.0) {
        return svg_to_pdf(input, output);
    }

    // auto_orient: SVG の向き（横長/縦長）に合わせて台紙の縦横を選ぶ。
    let (tw, th) = if auto_orient {
        let long = page_w_pt.max(page_h_pt);
        let short = page_w_pt.min(page_h_pt);
        if svg_w > svg_h {
            (long, short)
        } else {
            (short, long)
        }
    } else {
        (page_w_pt, page_h_pt)
    };

    // アスペクト維持フィット（レターボックス・中央寄せ）。
    let scale = (tw / svg_w).min(th / svg_h);
    let draw_w = svg_w * scale;
    let draw_h = svg_h * scale;
    let off_x = (tw - draw_w) / 2.0;
    let off_y = (th - draw_h) / 2.0;

    // SVG を独立 chunk（XObject）へ変換。XObject は 1×1 ポイントの単位。
    let (svg_chunk, svg_ref) = svg2pdf::to_chunk(&tree, svg2pdf::ConversionOptions::default());

    // 本体側の ID を採番。
    let mut alloc = Ref::new(1);
    let catalog_id = alloc.bump();
    let page_tree_id = alloc.bump();
    let page_id = alloc.bump();
    let content_id = alloc.bump();
    let svg_name = Name(b"S1");

    // chunk を本体の採番空間へ振り直し、root XObject の参照も更新。
    let mut map: HashMap<Ref, Ref> = HashMap::new();
    let svg_chunk = svg_chunk.renumber(|old| *map.entry(old).or_insert_with(|| alloc.bump()));
    let svg_id = *map
        .get(&svg_ref)
        .ok_or_else(|| CoreError::Parse("svg root ref not remapped".into()))?;

    let mut pdf = Pdf::new();
    pdf.catalog(catalog_id).pages(page_tree_id);
    pdf.pages(page_tree_id).kids([page_id]).count(1);

    let mut page = pdf.page(page_id);
    page.media_box(Rect::new(0.0, 0.0, tw, th));
    page.parent(page_tree_id);
    page.contents(content_id);
    let mut resources = page.resources();
    resources.x_objects().pair(svg_name, svg_id);
    resources.finish();
    page.finish();

    // 単位正方形を draw_w×draw_h に拡大し (off_x,off_y) へ配置。
    let mut content = Content::new();
    content
        .transform([draw_w, 0.0, 0.0, draw_h, off_x, off_y])
        .x_object(svg_name);
    pdf.stream(content_id, &content.finish());

    // SVG の chunk を本体に取り込む。
    pdf.extend(&svg_chunk);

    std::fs::write(output, pdf.finish())?;
    Ok(())
}
