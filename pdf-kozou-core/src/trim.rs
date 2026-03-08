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
    /// 余白の単位: "mm" (デフォルト) | "pt" | "cm" | "in"
    #[serde(default = "default_unit")]
    pub unit:    String,
    pub pages:   Option<PageSelection>,
}

fn default_unit() -> String { "mm".to_string() }

#[derive(Serialize)]
pub struct TrimResponse {
    pub ok:           bool,
    pub input_bytes:  u64,
    pub output_bytes: u64,
    pub crop_boxes:   Vec<CropBoxInfo>,
}

#[derive(Serialize)]
pub struct CropBoxInfo {
    pub page:   i32,
    pub x0:     f32,
    pub y0:     f32,
    pub x1:     f32,
    pub y1:     f32,
    pub width:  f32,
    pub height: f32,
}

/// f32 4値から PDF 配列オブジェクト [a b c d] をインラインで作成
fn make_rect(doc: &mupdf::pdf::PdfDocument, a: f32, b: f32, c: f32, d: f32)
    -> std::result::Result<mupdf::pdf::PdfObject, mupdf::Error>
{
    let mut arr = doc.new_array()?;
    arr.array_push(doc.new_real(a)?)?;
    arr.array_push(doc.new_real(b)?)?;
    arr.array_push(doc.new_real(c)?)?;
    arr.array_push(doc.new_real(d)?)?;
    Ok(arr)
}

pub fn trim(req: &TrimRequest) -> Result<TrimResponse> {
    use mupdf::pdf::PdfDocument;

    // 単位 → pt 変換
    let to_pt: f32 = match req.unit.to_lowercase().as_str() {
        "pt"          => 1.0,
        "cm"          => 28.3465,
        "in" | "inch" => 72.0,
        _             => 2.83465,  // mm
    };
    let left_pt   = req.margins.left   * to_pt;
    let right_pt  = req.margins.right  * to_pt;
    let bottom_pt = req.margins.bottom * to_pt;
    let top_pt    = req.margins.top    * to_pt;

    let base_doc = mupdf::Document::open(&req.input)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let page_count = base_doc.page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let target: Vec<i32> = match req.pages.as_ref().unwrap_or(&PageSelection::All) {
        PageSelection::All   => (0..page_count).collect(),
        PageSelection::Even  => (0..page_count).filter(|&i| (i+1) % 2 == 0).collect(),
        PageSelection::Odd   => (0..page_count).filter(|&i| (i+1) % 2 == 1).collect(),
        PageSelection::Range { pages } => pages.iter().map(|&p| p - 1).collect(),
    };

    let doc = PdfDocument::open(&req.input)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let mut crop_boxes = Vec::new();

    for idx in &target {
        let idx = *idx;

        let page = base_doc.load_page(idx)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        let bounds = page.bounds()
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        let mb_x0 = bounds.x0;
        let mb_y0 = bounds.y0;
        let mb_x1 = bounds.x1;
        let mb_y1 = bounds.y1;

        let cx0 = mb_x0 + left_pt;
        let cy0 = mb_y0 + bottom_pt;
        let cx1 = mb_x1 - right_pt;
        let cy1 = mb_y1 - top_pt;

        if cx1 <= cx0 || cy1 <= cy0 {
            return Err(CoreError::InvalidArg(format!(
                "page {}: margins too large — CropBox [{:.2} {:.2} {:.2} {:.2}] invalid \
                 (MediaBox [{:.2} {:.2} {:.2} {:.2}])",
                idx + 1, cx0, cy0, cx1, cy1, mb_x0, mb_y0, mb_x1, mb_y1,
            )));
        }

        // find_page は実体 PdfObject を返す (resolve 不要)
        let mut page_obj = doc.find_page(idx)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

        // new_array() + array_push() でインライン配列を作成
        // new_object_from_str は間接オブジェクトを生成して循環参照の原因になるため使わない
        let crop_obj = make_rect(&doc, cx0, cy0, cx1, cy1)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        let media_obj = make_rect(&doc, mb_x0, mb_y0, mb_x1, mb_y1)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        page_obj.dict_put("CropBox", crop_obj)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
        page_obj.dict_put("MediaBox", media_obj)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

        // ArtBox / BleedBox / TrimBox も CropBox に揃える
        for key in &["ArtBox", "BleedBox", "TrimBox"] {
            if let Ok(Some(_)) = page_obj.get_dict(*key) {
                let obj = make_rect(&doc, cx0, cy0, cx1, cy1)
                    .map_err(|e| CoreError::MuPdf(e.to_string()))?;
                page_obj.dict_put(*key, obj)
                    .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
            }
        }

        crop_boxes.push(CropBoxInfo {
            page: idx + 1,
            x0: cx0, y0: cy0, x1: cx1, y1: cy1,
            width: cx1 - cx0, height: cy1 - cy0,
        });
    }

    // gc=4 + sanitize=true:
    //   - gc=4 で未参照オブジェクトを削除（CropBox外コンテンツの間接参照を除去）
    //   - sanitize でコンテンツストリームを再構築
    //   - フォントリソース自体は /Resources に参照が残るため保持される
    let mut opts = mupdf::pdf::PdfWriteOptions::default();
    // gc=2 + clean=false が安全設定
    // trim は CropBox 設定のみ — 高gc/sanitize による圧縮効果はほぼなし
    opts.set_compress(true)
        .set_compress_fonts(true)
        .set_garbage_level(2)
        .set_clean(false);

    doc.save_with_options(&req.output, opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let input_bytes  = std::fs::metadata(&req.input) .map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);

    Ok(TrimResponse { ok: true, input_bytes, output_bytes, crop_boxes })
}
