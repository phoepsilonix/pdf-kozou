// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/render.rs
// ページレンダリング (JPEG / PNG / SVG 対応)

use crate::error::{CoreError, Result};
use crate::pixmap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct RenderRequest {
    pub path: String,
    pub page_index: i32,
    pub dpi: u32,
    /// "jpeg" / "png" / "svg"
    pub format: Option<String>,
    pub quality: Option<u8>,
    pub output: Option<String>,
}

#[derive(Serialize)]
pub struct RenderResponse {
    pub ok: bool,
    pub image_b64: String,
    pub format: String,
    pub width_px: u32,
    pub height_px: u32,
    pub page_w_pt: f32,
    pub page_h_pt: f32,
    pub dpi: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

pub fn render(req: &RenderRequest) -> Result<RenderResponse> {
    let doc = mupdf::Document::open(&req.path).map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let page = doc
        .load_page(req.page_index)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let bounds = page.bounds().map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let format = req.format.as_deref().unwrap_or("jpeg");
    let quality = req.quality.unwrap_or(85);

    if format == "svg" {
        return render_svg(req, &page, &bounds);
    }

    let scale = req.dpi as f32 / 72.0;
    let matrix = mupdf::Matrix::new_scale(scale, scale);
    let pm = page
        .to_pixmap(&matrix, &mupdf::Colorspace::device_rgb(), false, false)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let image_bytes: Vec<u8> = match format {
        "png" => pixmap::pixmap_to_png(&pm)?,
        _ => pixmap::pixmap_to_jpeg(&pm, quality)?,
    };

    if let Some(out_path) = &req.output {
        std::fs::write(out_path, &image_bytes)?;
        return Ok(RenderResponse {
            ok: true,
            image_b64: String::new(),
            format: format.to_string(),
            width_px: pm.width(),
            height_px: pm.height(),
            page_w_pt: bounds.x1 - bounds.x0,
            page_h_pt: bounds.y1 - bounds.y0,
            dpi: req.dpi,
            output: Some(out_path.clone()),
        });
    }

    use base64::Engine as _;
    let image_b64 = base64::engine::general_purpose::STANDARD.encode(&image_bytes);
    Ok(RenderResponse {
        ok: true,
        image_b64,
        format: format.to_string(),
        width_px: pm.width(),
        height_px: pm.height(),
        page_w_pt: bounds.x1 - bounds.x0,
        page_h_pt: bounds.y1 - bounds.y0,
        dpi: req.dpi,
        output: None,
    })
}

/// SVG レンダリング — フォントアウトラインをベクターパスとして保持
fn render_svg(
    req: &RenderRequest,
    page: &mupdf::Page,
    bounds: &mupdf::Rect,
) -> Result<RenderResponse> {
    use mupdf::DocumentWriter;
    let page_w = bounds.x1 - bounds.x0;
    let page_h = bounds.y1 - bounds.y0;

    // tmp ファイルに書き出してから読む
    let tmp = format!("/tmp/kozou_svg_{}.svg", std::process::id());
    let actual_out = req.output.as_deref().unwrap_or(&tmp);

    // text-as-path=yes: フォントアウトラインを完全保持
    let mut writer = DocumentWriter::new(actual_out, "svg", "text-as-path=yes")
        .map_err(|e| CoreError::MuPdf(format!("svg writer: {e}")))?;
    let dev = writer
        .begin_page(*bounds)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    page.run(&dev, &mupdf::Matrix::IDENTITY)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    writer
        .end_page(dev)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    drop(writer);

    if req.output.is_some() {
        return Ok(RenderResponse {
            ok: true,
            image_b64: String::new(),
            format: "svg".into(),
            width_px: (page_w * req.dpi as f32 / 72.0) as u32,
            height_px: (page_h * req.dpi as f32 / 72.0) as u32,
            page_w_pt: page_w,
            page_h_pt: page_h,
            dpi: req.dpi,
            output: req.output.clone(),
        });
    }

    let svg_bytes = std::fs::read(&tmp).map_err(CoreError::Io)?;
    let _ = std::fs::remove_file(&tmp);
    use base64::Engine as _;
    Ok(RenderResponse {
        ok: true,
        image_b64: base64::engine::general_purpose::STANDARD.encode(&svg_bytes),
        format: "svg".into(),
        width_px: (page_w * req.dpi as f32 / 72.0) as u32,
        height_px: (page_h * req.dpi as f32 / 72.0) as u32,
        page_w_pt: page_w,
        page_h_pt: page_h,
        dpi: req.dpi,
        output: None,
    })
}
