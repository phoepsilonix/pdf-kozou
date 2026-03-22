// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/merge.rs
use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct MergeRequest {
    pub inputs: Vec<String>,
    pub output: String,
}

#[derive(Serialize)]
pub struct MergeResponse {
    pub ok: bool,
    pub page_count: i32,
    pub output_bytes: u64,
}

pub fn merge(req: &MergeRequest) -> Result<MergeResponse> {
    use mupdf::pdf::PdfDocument;

    if req.inputs.is_empty() {
        return Err(CoreError::InvalidArg("inputs is empty".into()));
    }

    let mut dst = PdfDocument::new();
    let mut total_pages = 0i32;

    for input_path in &req.inputs {
        let src = PdfDocument::open(input_path)
            .map_err(|e| CoreError::MuPdf(format!("{}: {}", input_path, e)))?;

        let n = src
            .page_count()
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        // GraftMap でリソースを dst にコピーしながらページを移植
        let mut graft = dst
            .new_graft_map()
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

        for i in 0..n {
            let src_page = src
                .find_page(i)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

            // ページオブジェクトを graft して dst に追加
            let dst_page = graft
                .graft_object(&src_page)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

            // mupdf 0.6: -1 は無効。現在のページ数 = 末尾に追加
            let at = dst
                .page_count()
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
            dst.insert_page(at, &dst_page)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
        }
        total_pages += n;
    }

    let mut opts = mupdf::pdf::PdfWriteOptions::default();
    // フォント保護: clean=false, sanitize=false (デフォルト), gc=2
    // MuPDF 1.28: set_compress_fonts は廃止 (compress=true で自動的にフォントも圧縮)
    opts.set_compress(true).set_garbage_level(2);
    dst.save_with_options(&req.output, opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);
    Ok(MergeResponse {
        ok: true,
        page_count: total_pages,
        output_bytes,
    })
}
