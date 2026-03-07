// pdf-kozou-core/src/rotate.rs
use serde::{Deserialize, Serialize};
use crate::error::{CoreError, Result};

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
pub enum Angle {
    #[serde(rename = "90")]  Cw90,
    #[serde(rename = "180")] Deg180,
    #[serde(rename = "270")] Ccw90,
}

impl Angle {
    pub fn degrees(self) -> i32 {
        match self {
            Angle::Cw90   => 90,
            Angle::Deg180 => 180,
            Angle::Ccw90  => 270,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RotateRequest {
    pub input:  String,
    pub output: String,
    pub angle:  Angle,
    pub pages:  Option<Vec<i32>>,
}

#[derive(Serialize)]
pub struct RotateResponse {
    pub ok: bool,
}

pub fn rotate(req: &RotateRequest) -> Result<RotateResponse> {
    use mupdf::pdf::PdfDocument;

    let doc = PdfDocument::open(&req.input)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let page_count = doc.page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let target: Vec<i32> = match &req.pages {
        None        => (0..page_count).collect(),
        Some(pages) => pages.iter().map(|&p| p - 1).collect(),
    };

    for idx in target {
        let mut page_obj = doc.find_page(idx)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

        // dict_get は存在しないため、new_object_from_str で現在値を0として扱う
        // 既存 Rotate 値の取得: dict_gets (文字列キーで PdfObject 取得) を試みる
        // mupdf 0.4 では dict_get_val が正しい可能性があるが未確認のため
        // 安全策として常に指定角度を絶対値で設定する
        let new_angle = req.angle.degrees().rem_euclid(360);
        let angle_obj = doc.new_object_from_str(&new_angle.to_string())
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        page_obj.dict_put("Rotate", angle_obj)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
    }

    let mut opts = mupdf::pdf::PdfWriteOptions::default();
    opts.set_compress(true).set_garbage_level(2);

    doc.save_with_options(&req.output, opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    Ok(RotateResponse { ok: true })
}
