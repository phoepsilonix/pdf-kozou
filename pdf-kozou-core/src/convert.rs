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
/// C FFI (kozou_convert_to_pdf) を使用する。
/// mupdf::Document::open は Windows でのフリーズを防ぐため使用しない。
pub fn convert_to_pdf(req: &ConvertRequest) -> Result<ConvertResponse> {
    use crate::ffi::{kozou_convert_to_pdf as ffi_convert, kozou_new_context, FfiResult};
    use std::ffi::CString;

    eprintln!("[convert] start: {}", req.input);

    let c_input = CString::new(req.input.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid input path".into()))?;
    let c_output = CString::new(req.output.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid output path".into()))?;

    let lw = req.layout_w.unwrap_or(450.0);
    let lh = req.layout_h.unwrap_or(600.0);
    let lem = req.layout_em.unwrap_or(12.0);

    eprintln!("[convert] calling C FFI: layout={lw}x{lh} em={lem}");

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
            &mut res,
        );
        mupdf_sys::fz_drop_context(ctx);
        if res.ok == 0 {
            eprintln!("[convert] C FFI failed: {res}");
            return Err(CoreError::MuPdf(format!("{res}")));
        }
    }

    eprintln!("[convert] C FFI succeeded");

    // メタデータを引き継ぐ（非 PDF の入力は collect_metadata が空を返すので安全）
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
