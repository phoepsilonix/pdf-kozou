// pdf-kozou-core/src/info.rs
// PDF メタ情報取得

use serde::{Deserialize, Serialize};
use crate::error::{CoreError, Result};

#[derive(Serialize, Deserialize)]
pub struct PageBounds {
    pub w: f32,
    pub h: f32,
}

#[derive(Serialize)]
pub struct InfoResponse {
    pub ok:          bool,
    pub page_count:  i32,
    pub file_size:   u64,
    pub pages:       Vec<PageBounds>,
}

pub fn info(path: &str) -> Result<InfoResponse> {
    let doc = mupdf::Document::open(path)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let page_count = doc.page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let mut pages = Vec::with_capacity(page_count as usize);
    for i in 0..page_count {
        let page = doc.load_page(i)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        let b = page.bounds()
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        pages.push(PageBounds {
            w: b.x1 - b.x0,
            h: b.y1 - b.y0,
        });
    }

    let file_size = std::fs::metadata(path)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(InfoResponse { ok: true, page_count, file_size, pages })
}
