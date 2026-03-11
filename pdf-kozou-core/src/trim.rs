// pdf-kozou-core/src/trim.rs
// CropBox によるトリミング

use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::error::{CoreError, Result};
use serde::Deserializer;


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
    None,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrimRequest {
    pub input:   String,
    pub output:  String,
    pub margins: Margins,
    /// 余白の単位: "mm" (デフォルト) | "pt" | "cm" | "in"
    #[serde(default = "default_unit")]
    pub unit:    String,
    /// どのページにトリミングを適用する対象ページ (None=全ページ)
    #[serde(deserialize_with = "deserialize_pages")]
    pub pages:   Option<PageSelection>,
    /// 除外するページを指定 (1始まり, None=対象全ページ適用)
    #[serde(deserialize_with = "deserialize_pages")]
    pub exclude: Option<PageSelection>,
    /// 出力に残すページを指定 (1始まり, None=全ページ保持)
    #[serde(deserialize_with = "deserialize_pages")]
    pub extract: Option<PageSelection>,
}

fn default_unit() -> String { "mm".to_string() }

fn deserialize_pages<'de, D>(deserializer: D) -> std::result::Result<Option<PageSelection>, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Value::deserialize(deserializer)?;

    match v {
        Value::Null => Ok(Some(PageSelection::All)),
        Value::String(s) => {
            let s = s.trim().to_lowercase();
            if s.is_empty() || s == "" {
                Ok(Some(PageSelection::None))
            } else if s == "all" {
                Ok(Some(PageSelection::All))
            } else if s == "even" {
                Ok(Some(PageSelection::Even))
            } else if s == "odd" {
                Ok(Some(PageSelection::Odd))
            } else {
                // "1,3,5-10" のような文字列を Range に変換
                let mut pages = Vec::new();
                for part in s.split(',') {
                    let part = part.trim();
                    if let Some((a, b)) = part.split_once('-') {
                        let start: i32 = a.trim().parse().map_err(serde::de::Error::custom)?;
                        let end:   i32 = b.trim().parse().map_err(serde::de::Error::custom)?;
                        for p in start..=end {
                            pages.push(p);
                        }
                    } else {
                        let p: i32 = part.parse().map_err(serde::de::Error::custom)?;
                        pages.push(p);
                    }
                }
                Ok(Some(PageSelection::Range { pages }))
            }
        }
        Value::Object(mut obj) => {
            // すでに enum形式の場合（{ "type": "Ranges", "ranges": [[1,3]] }）
            if let Some(ty) = obj.get("type") {
                match ty.as_str() {
                    Some("All") => Ok(Some(PageSelection::All)),
                    Some("Even") => Ok(Some(PageSelection::Even)),
                    Some("Odd") => Ok(Some(PageSelection::Odd)),
                    Some("Range") => {
                        if let Some(Value::Array(ranges)) = obj.get("ranges") {
                            let mut pages = Vec::new();
                            for r in ranges {
                                if let Value::Array(arr) = r {
                                    if arr.len() == 2 {
                                        if let (Some(Value::Number(s)), Some(Value::Number(e))) = (arr.get(0), arr.get(1)) {
                                            if let (Some(start), Some(end)) = (s.as_i64(), e.as_i64()) {
                                                for p in start..=end {
                                                    pages.push((p - 1) as i32); // 1-based → 0-based
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            Ok(Some(PageSelection::Range { pages }))
                        } else {
                            Err(serde::de::Error::custom("missing or invalid ranges"))
                        }
                    }
                    _ => Err(serde::de::Error::custom("unknown type")),
                }
            } else {
                Err(serde::de::Error::custom("missing type field"))
            }
        }
        _ => Err(serde::de::Error::custom("invalid pages format")),
    }
}

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
    let x0 = mb.get_array(0).ok()??.resolve().ok().flatten()?.as_float().ok()?;
    let y0 = mb.get_array(1).ok()??.resolve().ok().flatten()?.as_float().ok()?;
    let x1 = mb.get_array(2).ok()??.resolve().ok().flatten()?.as_float().ok()?;
    let y1 = mb.get_array(3).ok()??.resolve().ok().flatten()?.as_float().ok()?;
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
            // Rotate=90 (時計回り90度で表示): CTM=[0,-1,1,0,0,W]
            // Device-x = PDF-y    → 視覚left/right は PDF-y 方向
            // Device-y = W - PDF-x → 視覚top/bottom は PDF-x 方向(反転)
            //
            // 「視覚左を L削る」= Device-x > L → PDF-y > L → cy0 += L
            // 「視覚右を R削る」= Device-x < H_vis-R → PDF-y < H_vis-R → cy1 -= R
            //   (H_vis = 視覚高 = MB高さ = mb_y1-mb_y0)
            // 「視覚上を T削る」= Device-y < W_vis-T → W-PDF-x < W_vis-T
            //   → PDF-x > T → cx0 += T  (W_vis = 視覚幅 = MB幅 = mb_x1-mb_x0)
            //   Wait: W-PDF-x < W_vis-T → PDF-x > W-W_vis+T = T (mb_x0=0なら)
            //   → cx0 += T は間違い... PDF-x > T → cx0 += T は左端から
            //   実際: 視覚上端 = Device-y=0 = W-PDF-x=0 → PDF-x=W=mb_x1
            //   「視覚上を T削る」= Device-y > T → W-PDF-x > T → PDF-x < W-T → cx1 -= T
            // 「視覚下を B削る」= Device-y < W_vis-B → W-PDF-x < W-B → PDF-x > B → cx0 += B
            let cx0 = mb_x0 + b;   // 視覚bottom → cx0 += B
            let cy0 = mb_y0 + l;   // 視覚left   → cy0 += L  ← 修正
            let cx1 = mb_x1 - t;   // 視覚top    → cx1 -= T
            let cy1 = mb_y1 - r;   // 視覚right  → cy1 -= R  ← 修正
            (cx0, cy0, cx1, cy1)
        }
        180 => {
            // Rotate=180: CTM=[-1,0,0,-1,W,H]
            // Device-x = W - PDF-x → 視覚left/right が PDF-x 反転
            // Device-y = H - PDF-y → 視覚top/bottom が PDF-y 反転
            // 「視覚左を L削る」= PDF-x < W-L → cx1 -= L
            // 「視覚右を R削る」= PDF-x > R   → cx0 += R
            // 「視覚上を T削る」= PDF-y < H-T → cy1 -= T
            // 「視覚下を B削る」= PDF-y > B   → cy0 += B
            let cx0 = mb_x0 + r;
            let cy0 = mb_y0 + b;   // 視覚bottom → cy0 += B  ← 修正
            let cx1 = mb_x1 - l;
            let cy1 = mb_y1 - t;   // 視覚top    → cy1 -= T  ← 修正
            (cx0, cy0, cx1, cy1)
        }
        270 => {
            // Rotate=270 (反時計回り90度): CTM=[0,1,-1,0,H,0]
            // Device-x = H - PDF-y → 視覚left/right が PDF-y 反転
            // Device-y = PDF-x
            // 「視覚左を L削る」= H-PDF-y > L → PDF-y < H-L → cy1 -= L
            // 「視覚右を R削る」= H-PDF-y < H-R → PDF-y > R → cy0 += R
            // 「視覚上を T削る」= PDF-x < T... Wait: Device-y=PDF-x
            //   Device-y > T → PDF-x > T → cx0 += T
            // 「視覚下を B削る」= Device-y < H_vis-B → PDF-x < H_vis-B → cx1 -= B
            let cx0 = mb_x0 + t;   // 視覚top    → cx0 += T  (Device-y=PDF-x増方向)
            let cy0 = mb_y0 + r;   // 視覚right  → cy0 += R  ← 修正
            let cx1 = mb_x1 - b;   // 視覚bottom → cx1 -= B
            let cy1 = mb_y1 - l;   // 視覚left   → cy1 -= L  ← 修正
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

    //let mut working_path: String = req.input.clone();
    let mut working_path: String;
    let mut working_tmp: Option<tempfile::NamedTempFile>;

    let page_count = {
        let tmp = PdfDocument::open(&req.input)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        tmp.page_count().map_err(|e| CoreError::MuPdf(e.to_string()))?
    };

    // # 全ページ
    let all_pages: Vec<i32> = (0..page_count).collect();
    
    // trim_target（適用ページ）の計算（既存部分）
    let mut trim_target: Vec<i32> = match req.pages.as_ref().unwrap_or(&PageSelection::All) {
        PageSelection::All   => (0..page_count).collect(),
        PageSelection::Even  => (0..page_count).filter(|&i| (i+1) % 2 == 0).collect(),
        PageSelection::Odd   => (0..page_count).filter(|&i| (i+1) % 2 == 1).collect(),
        PageSelection::Range { pages } => pages.iter().map(|&p| p - 1).collect(),
        PageSelection::None  => (0..page_count).collect(),
    };
    // トリミング適用ページ
    let trim_pages: Vec<i32> = trim_target.clone();
    // 最終的な書き込みページ（抽出ページ。残すページ。）
    let mut write_target: Vec<i32> = all_pages.clone();

    // Trim除外ページ
    if let Some(exclude) = req.exclude.as_ref() {
        let exclude_indices: Vec<i32> = match exclude {
            PageSelection::All   => (0..page_count).collect(),
            PageSelection::Even  => (0..page_count).filter(|&i| (i+1) % 2 == 0).collect(),
            PageSelection::Odd   => (0..page_count).filter(|&i| (i+1) % 2 == 1).collect(),
            PageSelection::Range { pages } => pages.iter().map(|&p| p - 1).collect(),
            PageSelection::None  => [].to_vec(),
        };
        // target から除外ページを削除
        trim_target.retain(|&p| !exclude_indices.contains(&p));
    }

    // ── トリミング適用 ─────────────────────────────────────────────────────
    let doc = PdfDocument::open(&req.input)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let mut crop_boxes = Vec::new();

    for idx in &all_pages {
        if ! trim_target.contains(idx) { continue; }
        let idx = *idx;
        if idx < 0 || idx >= page_count { continue; }

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
    // ── ページ抽出 (extract_pages が指定されている場合) ────────────────────
    // 抽出先の中間PDFを作り、対象ページのみコピーする

    let mut extract_indices: Vec<i32> = (0..page_count).collect();
    if let Some(extract) = req.extract.as_ref() {
        extract_indices = match extract {
            PageSelection::All   => (0..page_count).collect(),
            PageSelection::Even  => (0..page_count).filter(|&i| (i+1) % 2 == 0).collect(),
            PageSelection::Odd   => (0..page_count).filter(|&i| (i+1) % 2 == 1).collect(),
            PageSelection::Range { pages } => pages.iter().map(|&p| p - 1).collect(),
            PageSelection::None  => (0..page_count).collect(),
        };
        // src target から抽出ページのみにする
        write_target.retain(|&p| extract_indices.contains(&p));
    };
    // 抽出適用後のログ（デバッグ用）

    if let write_page = write_target.iter().map(|&i| i+1).collect::<Vec<_>>() {
        if !write_page.is_empty() {
            // 抽出先 tmp ファイル
            let tmp = tempfile::NamedTempFile::new()
                .map_err(|e| CoreError::Io(e))?;
            let tmp_path = tmp.path().to_string_lossy().to_string();

                //PdfDocument::open(&req.input) .map_err(|e| CoreError::MuPdf(e.to_string()))?;
            let src = doc;
            let mut dst = PdfDocument::new();
            let mut graft = dst.new_graft_map()
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
        
            for page_1based in write_page {
                let idx = page_1based - 1;
                if idx < 0 || idx >= page_count { continue; }
                if ! write_target.contains(&idx) { continue; }
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

    let doc = PdfDocument::open(&working_path)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let working_page_count = doc.page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

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
