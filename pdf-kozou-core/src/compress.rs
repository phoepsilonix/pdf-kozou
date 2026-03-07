// pdf-kozou-core/src/compress.rs
// MuPDF による PDF 圧縮・最適化

use serde::{Deserialize, Serialize};
use crate::error::{CoreError, Result};

#[derive(Debug, Serialize, Deserialize)]
pub struct CompressRequest {
    pub input:            String,
    pub output:           String,
    /// 画像を再圧縮するか (default: true)
    pub compress_images:  Option<bool>,
    /// フォントを圧縮するか (default: true)
    pub compress_fonts:   Option<bool>,
    /// ガベージコレクションレベル 0-4 (default: 4)
    pub garbage_level:    Option<i32>,
    /// 線形化 (Web最適化) (default: true)
    pub linearize:        Option<bool>,
}

#[derive(Serialize)]
pub struct CompressResponse {
    pub ok:            bool,
    pub input_bytes:   u64,
    pub output_bytes:  u64,
    /// 圧縮率 (0.0-1.0, 小さいほど圧縮効果大)
    pub ratio:         f64,
}

pub fn compress(req: &CompressRequest) -> Result<CompressResponse> {
    use mupdf::pdf::PdfDocument;

    let doc = PdfDocument::open(&req.input)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let mut opts = mupdf::pdf::PdfWriteOptions::default();
    opts.set_compress(true)
        .set_decompress(false)
        .set_compress_images(req.compress_images.unwrap_or(true))
        .set_compress_fonts(req.compress_fonts.unwrap_or(true))
        .set_garbage_level(req.garbage_level.unwrap_or(4))
        .set_linear(req.linearize.unwrap_or(true))
        .set_clean(true)
        .set_sanitize(true);

    doc.save_with_options(&req.output, opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let input_bytes  = std::fs::metadata(&req.input) .map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);
    let ratio = if input_bytes > 0 {
        output_bytes as f64 / input_bytes as f64
    } else {
        1.0
    };

    Ok(CompressResponse { ok: true, input_bytes, output_bytes, ratio })
}
