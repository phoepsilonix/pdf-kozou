// pdf-kozou-core/src/merge.rs
use serde::{Deserialize, Serialize};
use crate::error::{CoreError, Result};

#[derive(Debug, Serialize, Deserialize)]
pub struct MergeRequest {
    pub inputs: Vec<String>,
    pub output: String,
}

#[derive(Serialize)]
pub struct MergeResponse {
    pub ok:           bool,
    pub page_count:   i32,
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

        let n = src.page_count()
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        // GraftMap でリソースを dst にコピーしながらページを移植
        let mut graft = dst.new_graft_map()
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

        for i in 0..n {
            let src_page = src.find_page(i)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

            // ページオブジェクトを graft して dst に追加
            let dst_page = graft.graft_object(&src_page)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

            dst.insert_page(-1, &dst_page)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
        }
        total_pages += n;
    }

    let mut opts = mupdf::pdf::PdfWriteOptions::default();
    opts.set_compress(true).set_garbage_level(4).set_linear(true);
    dst.save_with_options(&req.output, opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);
    Ok(MergeResponse { ok: true, page_count: total_pages, output_bytes })
}
