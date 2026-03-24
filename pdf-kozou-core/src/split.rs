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
        // ── 入力ファイルをコピーして作業ファイルを作る ──────────────────────────
        // コピー元の /Info・XMP などメタデータが全て保持される。
        // graft 方式（PdfDocument::new）と違い PDF バージョンも変わらない。
        let work_tmp = tempfile::Builder::new()
            .suffix(".pdf")
            .tempfile()
            .map_err(CoreError::Io)?;
        let work_path = work_tmp.path().to_string_lossy().to_string();
        std::fs::copy(&req.input, &work_path).map_err(CoreError::Io)?;

        // ── 作業ファイルを開いてページ情報を取得 ───────────────────────────────
        let mut doc = PdfDocument::open(&work_path).map_err(|e| CoreError::MuPdf(e.to_string()))?;

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
        eprintln!("{:?}", out_path);

        // コピーした作業ファイルから、page_indices以外のページを削除
        let mut delete_indices: Vec<i32> = (0..page_count)
            .filter(|p| !page_indices.contains(p))
            .collect();
        delete_indices.sort_unstable_by(|a, b| b.cmp(a)); // 降順
        for idx in delete_indices {
            doc.delete_page(idx)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
        }

        let mut opts = mupdf::pdf::PdfWriteOptions::default();
        // 入力 PDF のメタデータを各出力ファイルに引き継ぐ
        opts.set_incremental(false)
            .set_compress(true)
            .set_compress_fonts(true)
            .set_garbage_level(1)
            .set_clean(false);
        // 作業ファイルの中身をout_pathへ出力
        doc.save_with_options(out_path.to_str().unwrap(), opts)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        // delete_page で /Info が消えた場合に備えてメタデータを書き戻す
        // copy_metadata_after_writeは現状、うまく機能していない。修正まち
        crate::compress::copy_metadata_after_write(out_path.to_str().unwrap(), &metadata);
        files.push(out_path.to_string_lossy().to_string());
        // 作業用一時ファイルを解放・削除
        drop(doc);
        drop(work_tmp);
    }

    Ok(SplitResponse { ok: true, files })
}
