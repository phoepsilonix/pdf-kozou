// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/pixmap.rs
// MuPDF Pixmap → JPEG/PNG ユーティリティ (stride パディング除去込み)

use crate::error::{CoreError, Result};

/// Pixmap からパディングなしの RGB バッファを取得
pub fn pixmap_to_rgb_buf(pixmap: &mupdf::Pixmap) -> Vec<u8> {
    let w = pixmap.width() as usize;
    let h = pixmap.height() as usize;
    let n = pixmap.n() as usize;
    let stride = pixmap.stride() as usize;
    let row_bytes = w * n;
    let samples = pixmap.samples();

    if stride == row_bytes {
        samples.to_vec()
    } else {
        let mut buf = Vec::with_capacity(row_bytes * h);
        for row in 0..h {
            buf.extend_from_slice(&samples[row * stride..row * stride + row_bytes]);
        }
        buf
    }
}

/// Pixmap → JPEG bytes (quality 0-100)
pub fn pixmap_to_jpeg(pixmap: &mupdf::Pixmap, quality: u8) -> Result<Vec<u8>> {
    use image::codecs::jpeg::JpegEncoder;

    let w = pixmap.width();
    let h = pixmap.height();
    let buf = pixmap_to_rgb_buf(pixmap);

    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, quality)
        .encode(&buf, w, h, image::ExtendedColorType::Rgb8)
        .map_err(|e| CoreError::ImageEncode(e.to_string()))?;
    Ok(out)
}

/// Pixmap → JPEG base64 文字列
pub fn pixmap_to_jpeg_b64(pixmap: &mupdf::Pixmap, quality: u8) -> Result<String> {
    use base64::Engine as _;
    let jpeg = pixmap_to_jpeg(pixmap, quality)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&jpeg))
}

/// Pixmap → PNG bytes
pub fn pixmap_to_png(pixmap: &mupdf::Pixmap) -> Result<Vec<u8>> {
    use image::codecs::png::PngEncoder;
    use image::ImageEncoder;

    let w = pixmap.width();
    let h = pixmap.height();
    let buf = pixmap_to_rgb_buf(pixmap);

    let mut out = Vec::new();
    PngEncoder::new(&mut out)
        .write_image(&buf, w, h, image::ExtendedColorType::Rgb8)
        .map_err(|e| CoreError::ImageEncode(e.to_string()))?;
    Ok(out)
}
