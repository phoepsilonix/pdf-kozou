// pdf-kozou-core/src/render.rs
// ページレンダリング

use serde::{Deserialize, Serialize};
use crate::error::{CoreError, Result};
use crate::pixmap;

#[derive(Debug, Serialize, Deserialize)]
pub struct RenderRequest {
    pub path:       String,
    pub page_index: i32,
    pub dpi:        u32,
    /// "jpeg" or "png"
    pub format:     Option<String>,
    /// JPEG quality 0-100 (default 85)
    pub quality:    Option<u8>,
}

#[derive(Serialize)]
pub struct RenderResponse {
    pub ok:        bool,
    /// base64 エンコードされた画像
    pub image_b64: String,
    pub format:    String,
    pub width_px:  u32,
    pub height_px: u32,
    /// ページサイズ (PDF ポイント単位)
    pub page_w_pt: f32,
    pub page_h_pt: f32,
    pub dpi:       u32,
}

pub fn render(req: &RenderRequest) -> Result<RenderResponse> {
    let doc = mupdf::Document::open(&req.path)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let page = doc.load_page(req.page_index)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let bounds = page.bounds()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let scale  = req.dpi as f32 / 72.0;
    let matrix = mupdf::Matrix::new_scale(scale, scale);

    let pm = page.to_pixmap(
        &matrix,
        &mupdf::Colorspace::device_rgb(),
        false, false,
    ).map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let format  = req.format.as_deref().unwrap_or("jpeg");
    let quality = req.quality.unwrap_or(85);

    let image_b64 = match format {
        "png"  => pixmap::pixmap_to_png(&pm).map(|b| {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode(&b)
        })?,
        _      => pixmap::pixmap_to_jpeg_b64(&pm, quality)?,
    };

    Ok(RenderResponse {
        ok:        true,
        image_b64,
        format:    format.to_string(),
        width_px:  pm.width()  as u32,
        height_px: pm.height() as u32,
        page_w_pt: bounds.x1 - bounds.x0,
        page_h_pt: bounds.y1 - bounds.y0,
        dpi:       req.dpi,
    })
}
