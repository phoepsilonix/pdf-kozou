// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/convert.rs
//
// 非 PDF ファイル（EPUB, XPS, HTML, CBZ, 画像等）を PDF に変換する。
// MuPDF の DocumentWriter を使って各ページを再描画し PDF として書き出す。
//
// 対応形式（mupdf features に依存）:
//   epub, xps, cbz, html, svg,
//   jpg/jpeg/png/bmp/gif/tiff/webp（img feature）

use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};

/// MuPDF が対応するファイル拡張子一覧
const MUPDF_EXTENSIONS: &[&str] = &[
    "pdf", "epub", "xps", "oxps", "cbz", "cbr", "html", "htm", "xhtml", "svg", "jpg", "jpeg",
    "png", "bmp", "gif", "tiff", "tif", "webp", "docx", "xlsx", "pptx",
];

/// MuPDF が対応するファイル形式かどうかを拡張子で判定する
///
/// 注意: 実際にファイルを開く処理は行わない。
/// Windows では Document::open がシステムフォントスキャンを走らせることがあり
/// フリーズの原因になるため、拡張子ベースの高速判定を使用する。
pub fn is_mupdf_supported(path: &str) -> bool {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    MUPDF_EXTENSIONS.contains(&ext.as_str())
}

/// ファイルが PDF かどうかを拡張子で判定する
pub fn is_pdf(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".pdf")
}

#[derive(Debug, Deserialize)]
pub struct ConvertRequest {
    pub input: String,
    pub output: String,
    /// リフロー可能文書のレイアウト幅 (pt)。省略時は 450pt（mutool デフォルト）
    #[serde(default)]
    pub layout_w: Option<f32>,
    /// リフロー可能文書のレイアウト高さ (pt)。省略時は 600pt（mutool デフォルト）
    #[serde(default)]
    pub layout_h: Option<f32>,
    /// リフロー可能文書のフォントサイズ (pt)。省略時は 12pt（mutool デフォルト）
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

/// 非 PDF ファイルを PDF に変換する
///
/// 優先: C FFI の kozou_convert_to_pdf（mutool convert 相当）
///   - fz_layout_document → pdf_page_write → fz_run_page → gc=4 保存
/// フォールバック: DocumentWriter + gc=4 後圧縮
pub fn convert_to_pdf(req: &ConvertRequest) -> Result<ConvertResponse> {
    use crate::ffi::{kozou_convert_to_pdf as ffi_convert, kozou_new_context, FfiResult};
    use std::ffi::CString;

    let c_input = CString::new(req.input.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid input path".into()))?;
    let c_output = CString::new(req.output.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid output path".into()))?;

    let ffi_ok = unsafe {
        let ctx = kozou_new_context();
        if ctx.is_null() {
            Err("kozou_new_context failed".to_string())
        } else {
            let mut res = FfiResult::default();
            ffi_convert(
                ctx,
                c_input.as_ptr(),
                c_output.as_ptr(),
                req.layout_w.unwrap_or(0.0),
                req.layout_h.unwrap_or(0.0),
                req.layout_em.unwrap_or(0.0),
                &mut res,
            );
            mupdf_sys::fz_drop_context(ctx);
            if res.ok != 0 {
                Ok(())
            } else {
                Err(format!("{res}"))
            }
        }
    };

    if let Err(e) = ffi_ok {
        eprintln!("[convert] C FFI failed ({e}), falling back to DocumentWriter");
        return convert_to_pdf_writer(req);
    }

    let metadata = crate::compress::collect_metadata(&req.input);
    if !metadata.is_empty() {
        crate::compress::copy_metadata_after_write(&req.output, &metadata);
    }

    let input_bytes = std::fs::metadata(&req.input).map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);
    let page_count = mupdf::pdf::PdfDocument::open(&req.output)
        .and_then(|d| d.page_count())
        .unwrap_or(0);

    Ok(ConvertResponse {
        ok: true,
        page_count,
        input_bytes,
        output_bytes,
    })
}

/// DocumentWriter + gc=4 後圧縮によるフォールバック変換
fn convert_to_pdf_writer(req: &ConvertRequest) -> Result<ConvertResponse> {
    use mupdf::{pdf::PdfWriteOptions, Document, DocumentWriter, Matrix};

    let mut doc =
        Document::open(&req.input).map_err(|e| CoreError::MuPdf(format!("open failed: {e}")))?;

    let is_reflowable = doc.is_reflowable().unwrap_or(false);
    if is_reflowable {
        let w = req.layout_w.unwrap_or(450.0);
        let h = req.layout_h.unwrap_or(600.0);
        let em = req.layout_em.unwrap_or(12.0);
        doc.layout(w, h, em)
            .map_err(|e| CoreError::MuPdf(format!("layout failed: {e}")))?;
    }

    let page_count = doc
        .page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    if page_count == 0 {
        return Err(CoreError::InvalidArg("document has no pages".into()));
    }

    let tmp = tempfile::Builder::new()
        .suffix(".pdf")
        .tempfile()
        .map_err(CoreError::Io)?;
    let tmp_path = tmp.path().to_string_lossy().to_string();

    {
        let mut writer = DocumentWriter::new(&tmp_path, "pdf", "compress=yes")
            .map_err(|e| CoreError::MuPdf(format!("writer create failed: {e}")))?;
        for i in 0..page_count {
            let page = doc
                .load_page(i)
                .map_err(|e| CoreError::MuPdf(e.to_string()))?;
            let bounds = page.bounds().map_err(|e| CoreError::MuPdf(e.to_string()))?;
            let dev = writer
                .begin_page(bounds)
                .map_err(|e| CoreError::MuPdf(e.to_string()))?;
            page.run(&dev, &Matrix::IDENTITY)
                .map_err(|e| CoreError::MuPdf(e.to_string()))?;
            writer
                .end_page(dev)
                .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        }
    }

    let compressed = (|| -> std::result::Result<(), String> {
        use mupdf::pdf::PdfDocument;
        let pdf = PdfDocument::open(&tmp_path).map_err(|e| format!("{e}"))?;
        let mut opts = PdfWriteOptions::default();
        opts.set_compress(true)
            .set_compress_images(true)
            .set_garbage_level(4)
            .set_clean(false);
        pdf.save_with_options(&req.output, opts)
            .map_err(|e| format!("{e}"))?;
        Ok(())
    })();
    if let Err(e) = compressed {
        eprintln!("[convert] gc=4 failed ({e}), copying raw");
        std::fs::copy(&tmp_path, &req.output).map_err(CoreError::Io)?;
    }
    drop(tmp);

    let metadata = crate::compress::collect_metadata(&req.input);
    if !metadata.is_empty() {
        crate::compress::copy_metadata_after_write(&req.output, &metadata);
    }

    let input_bytes = std::fs::metadata(&req.input).map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);
    Ok(ConvertResponse {
        ok: true,
        page_count,
        input_bytes,
        output_bytes,
    })
}
