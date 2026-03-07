// pdf-kozou-core/src/trim.rs
// CropBox によるトリミング

use serde::{Deserialize, Serialize};
use crate::error::{CoreError, Result};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Margins {
    pub left:   f32,
    pub right:  f32,
    pub bottom: f32,
    pub top:    f32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PageSelection {
    All,
    Even,
    Odd,
    Range { pages: Vec<i32> },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrimRequest {
    pub input:   String,
    pub output:  String,
    pub margins: Margins,
    pub pages:   Option<PageSelection>,
}

#[derive(Serialize)]
pub struct TrimResponse {
    pub ok:           bool,
    pub input_bytes:  u64,
    pub output_bytes: u64,
}

pub fn trim(req: &TrimRequest) -> Result<TrimResponse> {
    use mupdf::pdf::PdfDocument;

    let doc = PdfDocument::open(&req.input)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let page_count = doc.page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let target: Vec<i32> = match req.pages.as_ref().unwrap_or(&PageSelection::All) {
        PageSelection::All   => (0..page_count).collect(),
        PageSelection::Even  => (0..page_count).filter(|&i| (i+1) % 2 == 0).collect(),
        PageSelection::Odd   => (0..page_count).filter(|&i| (i+1) % 2 == 1).collect(),
        PageSelection::Range { pages } => pages.iter().map(|&p| p - 1).collect(),
    };

    for idx in target {
        let mut page_obj = doc.find_page(idx)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

        let crop_str = format!(
            "[{} {} {} {}]",
            req.margins.left, req.margins.bottom,
            req.margins.right, req.margins.top,
        );
        let crop_obj = doc.new_object_from_str(&crop_str)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        page_obj.dict_put("CropBox", crop_obj)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
    }

    let mut opts = mupdf::pdf::PdfWriteOptions::default();
    opts.set_compress(true)
        .set_compress_images(true)
        .set_garbage_level(4)
        .set_linear(true)
        .set_clean(true);

    doc.save_with_options(&req.output, opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let input_bytes  = std::fs::metadata(&req.input) .map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);

    Ok(TrimResponse { ok: true, input_bytes, output_bytes })
}
