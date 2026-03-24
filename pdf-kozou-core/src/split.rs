// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/split.rs
use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SplitMode {
    AllPages,
    Ranges { ranges: Vec<[i32; 2]> },
    EveryN { n: i32 },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SplitRequest {
    pub input: String,
    pub out_dir: String,
    pub prefix: Option<String>,
    pub mode: SplitMode,
}

#[derive(Serialize)]
pub struct SplitResponse {
    pub ok: bool,
    pub files: Vec<String>,
}

pub fn split(req: &SplitRequest) -> Result<SplitResponse> {
    use mupdf::pdf::PdfDocument;

    let src = PdfDocument::open(&req.input).map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let page_count = src
        .page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let prefix = req.prefix.as_deref().unwrap_or("page");
    let out_dir = std::path::Path::new(&req.out_dir);
    std::fs::create_dir_all(out_dir)?;

    // 入力 PDF のメタデータを一度だけ収集し、各出力ファイルに引き継ぐ
    let metadata = crate::compress::collect_metadata(&req.input);

    let ranges: Vec<Vec<i32>> = match &req.mode {
        SplitMode::AllPages => (0..page_count).map(|i| vec![i]).collect(),
        SplitMode::Ranges { ranges } => ranges
            .iter()
            .map(|r| {
                let start = (r[0] - 1).max(0);
                let end = (r[1] - 1).min(page_count - 1);
                (start..=end).collect()
            })
            .collect(),
        SplitMode::EveryN { n } => (0..page_count)
            .step_by(*n as usize)
            .map(|start| {
                let end = (start + n).min(page_count);
                (start..end).collect()
            })
            .collect(),
    };

    let mut files = Vec::new();

    for page_indices in &ranges {
        let fname = if page_indices.len() == 1 {
            format!("{prefix}_{:04}.pdf", page_indices[0] + 1)
        } else {
            format!(
                "{prefix}_{:04}-{:04}.pdf",
                page_indices[0] + 1,
                page_indices.last().unwrap() + 1
            )
        };
        let out_path = out_dir.join(&fname);

        let mut dst = PdfDocument::new();
        let mut graft = dst
            .new_graft_map()
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

        for &page_idx in page_indices {
            let src_page = src
                .find_page(page_idx)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
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

        let mut opts = mupdf::pdf::PdfWriteOptions::default();
        // フォント保護: clean=false, sanitize=false (デフォルト), gc=2
        opts.set_compress(true)
            .set_compress_fonts(true)
            .set_garbage_level(2);
        dst.save_with_options(out_path.to_str().unwrap(), opts)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        // 入力 PDF のメタデータを各出力ファイルに引き継ぐ
        crate::compress::copy_metadata_after_write(out_path.to_str().unwrap(), &metadata);

        files.push(out_path.to_string_lossy().to_string());
    }

    Ok(SplitResponse { ok: true, files })
}
