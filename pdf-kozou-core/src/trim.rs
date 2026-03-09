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
    /// どのページにトリミングを適用するか (None=全ページ)
    pub pages:   Option<PageSelection>,
    /// 出力に含めるページを指定 (1始まり, None=全ページを保持)
    #[serde(default)]
    pub extract_pages: Option<Vec<i32>>,
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

/// ページの Rotate 値を取得 (0/90/180/270)
fn get_page_rotate(page_obj: &mupdf::pdf::PdfObject) -> i32 {
    page_obj.get_dict("Rotate")
        .ok()
        .flatten()
        .and_then(|obj| obj.resolve().ok().flatten())
        .and_then(|obj| obj.as_int().ok())
        .map(|r| r.rem_euclid(360))
        .unwrap_or(0)
}

/// ページの MediaBox を取得 (Rotate適用前の生座標)
fn get_media_box(page_obj: &mupdf::pdf::PdfObject) -> Option<(f32, f32, f32, f32)> {
    let mb = page_obj.get_dict("MediaBox").ok()??;
    let mb = mb.resolve().ok().flatten().unwrap_or(mb);
    let x0 = mb.array_get(0).ok()?.resolve().ok().flatten()?.as_float().ok()?;
    let y0 = mb.array_get(1).ok()?.resolve().ok().flatten()?.as_float().ok()?;
    let x1 = mb.array_get(2).ok()?.resolve().ok().flatten()?.as_float().ok()?;
    let y1 = mb.array_get(3).ok()?.resolve().ok().flatten()?.as_float().ok()?;
    Some((x0, y0, x1, y1))
}

/// 回転を考慮してトリミング余白をPDF座標系に変換する
///
/// GUI では「視覚上の上/下/左/右」をユーザーが指定する。
/// PDF の CropBox は Rotate 適用前の座標系で指定するため、
/// Rotate 値に応じて余白の方向をマッピングする必要がある。
///
/// Rotate=0  (通常縦): 視覚 top=pdf top, left=pdf left  (変換不要)
/// Rotate=90 (右90°回転=視覚上部がPDF左):
///   視覚 top  → PDF left  (+left_pt)
///   視覚 bottom → PDF right (-right_pt)
///   視覚 left → PDF bottom (+bottom_pt)
///   視覚 right → PDF top  (-top_pt)
/// Rotate=180: left↔right, top↔bottom
/// Rotate=270 (左90°回転=視覚上部がPDF右):
///   視覚 top  → PDF right (-right_pt)
///   視覚 bottom → PDF left (+left_pt)
///   視覚 left → PDF top   (-top_pt)
///   視覚 right → PDF bottom (+bottom_pt)
fn calc_cropbox(
    mb_x0: f32, mb_y0: f32, mb_x1: f32, mb_y1: f32,
    margins: &Margins,
    rotate: i32,
) -> (f32, f32, f32, f32) {
    let l = margins.left;
    let r = margins.right;
    let t = margins.top;
    let b = margins.bottom;

    match rotate {
        90 => {
            // 視覚: top→pdf-left, bottom→pdf-right, left→pdf-bottom, right→pdf-top
            let cx0 = mb_x0 + b;   // pdf-left  削除 = 視覚bottom
            let cy0 = mb_y0 + r;   // pdf-bottom削除 = 視覚right
            let cx1 = mb_x1 - t;   // pdf-right 削除 = 視覚top
            let cy1 = mb_y1 - l;   // pdf-top   削除 = 視覚left
            (cx0, cy0, cx1, cy1)
        }
        180 => {
            // 全方向が反転
            let cx0 = mb_x0 + r;
            let cy0 = mb_y0 + t;
            let cx1 = mb_x1 - l;
            let cy1 = mb_y1 - b;
            (cx0, cy0, cx1, cy1)
        }
        270 => {
            // 視覚: top→pdf-right, bottom→pdf-left, left→pdf-top, right→pdf-bottom
            let cx0 = mb_x0 + t;   // pdf-left  削除 = 視覚top
            let cy0 = mb_y0 + l;   // pdf-bottom削除 = 視覚left
            let cx1 = mb_x1 - b;   // pdf-right 削除 = 視覚bottom
            let cy1 = mb_y1 - r;   // pdf-top   削除 = 視覚right
            (cx0, cy0, cx1, cy1)
        }
        _ => {
            // Rotate=0 (デフォルト): 変換不要
            let cx0 = mb_x0 + l;
            let cy0 = mb_y0 + b;
            let cx1 = mb_x1 - r;
            let cy1 = mb_y1 - t;
            (cx0, cy0, cx1, cy1)
        }
    }
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
    let margins_pt = Margins {
        left:   req.margins.left   * to_pt,
        right:  req.margins.right  * to_pt,
        bottom: req.margins.bottom * to_pt,
        top:    req.margins.top    * to_pt,
    };

    let page_count = {
        let tmp = PdfDocument::open(&req.input)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        tmp.page_count().map_err(|e| CoreError::MuPdf(e.to_string()))?
    };

    // ── ページ抽出 (extract_pages が指定されている場合) ────────────────────
    // 抽出先の中間PDFを作り、そこにトリミングを適用する
    let working_path: String;
    let working_tmp: Option<tempfile::NamedTempFile>;

    if let Some(ref ep) = req.extract_pages {
        if !ep.is_empty() {
            // 抽出先 tmp ファイル
            let tmp = tempfile::NamedTempFile::new()
                .map_err(|e| CoreError::Io(e))?;
            let tmp_path = tmp.path().to_string_lossy().to_string();

            let src = PdfDocument::open(&req.input)
                .map_err(|e| CoreError::MuPdf(e.to_string()))?;
            let mut dst = PdfDocument::new();
            let mut graft = dst.new_graft_map()
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

            for &page_1based in ep {
                let idx = page_1based - 1;
                if idx < 0 || idx >= page_count { continue; }
                let src_page = src.find_page(idx)
                    .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
                let dst_page = graft.graft_object(&src_page)
                    .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
                let at = dst.page_count()
                    .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
                dst.insert_page(at, &dst_page)
                    .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
            }

            let mut opts = mupdf::pdf::PdfWriteOptions::default();
            opts.set_compress(true).set_garbage_level(2);
            dst.save_with_options(&tmp_path, opts)
                .map_err(|e| CoreError::MuPdf(e.to_string()))?;

            working_path = tmp_path;
            working_tmp = Some(tmp);
        } else {
            working_path = req.input.clone();
            working_tmp = None;
        }
    } else {
        working_path = req.input.clone();
        working_tmp = None;
    }

    // ── トリミング適用 ─────────────────────────────────────────────────────
    let doc = PdfDocument::open(&working_path)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let working_page_count = doc.page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let target: Vec<i32> = match req.pages.as_ref().unwrap_or(&PageSelection::All) {
        PageSelection::All   => (0..working_page_count).collect(),
        PageSelection::Even  => (0..working_page_count).filter(|&i| (i+1) % 2 == 0).collect(),
        PageSelection::Odd   => (0..working_page_count).filter(|&i| (i+1) % 2 == 1).collect(),
        PageSelection::Range { pages } => pages.iter().map(|&p| p - 1).collect(),
    };

    let mut crop_boxes = Vec::new();

    for idx in &target {
        let idx = *idx;
        if idx < 0 || idx >= working_page_count { continue; }

        let mut page_obj = doc.find_page(idx)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

        let rotate = get_page_rotate(&page_obj);

        // MediaBox を取得 (page_obj から直接、または継承)
        let (mb_x0, mb_y0, mb_x1, mb_y1) = get_media_box(&page_obj)
            .unwrap_or((0.0, 0.0, 595.0, 842.0));

        let (cx0, cy0, cx1, cy1) = calc_cropbox(
            mb_x0, mb_y0, mb_x1, mb_y1, &margins_pt, rotate
        );

        if cx1 <= cx0 || cy1 <= cy0 {
            return Err(CoreError::InvalidArg(format!(
                "page {}: margins too large — CropBox [{:.2} {:.2} {:.2} {:.2}] invalid \
                 (MediaBox [{:.2} {:.2} {:.2} {:.2}], Rotate={})",
                idx + 1, cx0, cy0, cx1, cy1, mb_x0, mb_y0, mb_x1, mb_y1, rotate,
            )));
        }

        let crop_obj = make_rect(&doc, cx0, cy0, cx1, cy1)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        let media_obj = make_rect(&doc, mb_x0, mb_y0, mb_x1, mb_y1)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        page_obj.dict_put("CropBox", crop_obj)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
        page_obj.dict_put("MediaBox", media_obj)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

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

    let mut opts = mupdf::pdf::PdfWriteOptions::default();
    opts.set_compress(true)
        .set_compress_fonts(true)
        .set_garbage_level(2)
        .set_clean(false);

    doc.save_with_options(&req.output, opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    // tmp ファイルはここで drop (自動削除)
    drop(working_tmp);

    let input_bytes  = std::fs::metadata(&req.input) .map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);

    Ok(TrimResponse { ok: true, input_bytes, output_bytes, crop_boxes })
}
