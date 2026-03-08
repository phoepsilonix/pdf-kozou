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
    pub ok:         bool,
    pub page_count: i32,
    pub file_size:  u64,
    pub pages:      Vec<PageBounds>,
    /// fonts は --fonts オプション指定時のみ Some
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fonts:      Option<Vec<FontInfo>>,
}

/// PDF に含まれるフォント情報 (pdffonts 互換)
#[derive(Serialize, Clone)]
pub struct FontInfo {
    /// フォント名 (/BaseFont または /FontName)
    pub name:      String,
    /// フォント種別: Type1 / TrueType / CIDFontType0 / CIDFontType2 / Type3 / Type0 など
    pub font_type: String,
    /// フォントデータが PDF 内に埋め込まれているか
    pub embedded:  bool,
    /// サブセット埋め込みか ("ABCDEF+FontName" 形式)
    pub subset:    bool,
    /// 使用されているページ番号一覧 (1始まり)
    pub pages:     Vec<i32>,
    /// PDF オブジェクト番号 (pdffonts の object ID に対応)
    pub object_id: i32,
}

pub fn info(path: &str) -> Result<InfoResponse> {
    info_impl(path, false)
}

pub fn info_with_fonts(path: &str) -> Result<InfoResponse> {
    info_impl(path, true)
}

fn info_impl(path: &str, include_fonts: bool) -> Result<InfoResponse> {
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
        pages.push(PageBounds { w: b.x1 - b.x0, h: b.y1 - b.y0 });
    }

    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    let fonts = if include_fonts {
        Some(collect_fonts(path, page_count)?)
    } else {
        None
    };

    Ok(InfoResponse { ok: true, page_count, file_size, pages, fonts })
}

/// PDF からフォント情報を収集する
/// object_id でユニーク化 (pdffonts と同様に同名でも別オブジェクトは別エントリ)
fn collect_fonts(path: &str, page_count: i32) -> Result<Vec<FontInfo>> {
    use mupdf::pdf::PdfDocument;
    use std::collections::HashMap;

    let pdf = PdfDocument::open(path)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    // object_id → FontInfo
    let mut font_map: HashMap<i32, FontInfo> = HashMap::new();

    for page_no in 0..page_count {
        let page_obj = pdf.find_page(page_no)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

        let resources_raw = page_obj.get_dict_inheritable("Resources")
            .or_else(|_| page_obj.get_dict("Resources"));
        let resources_raw = match resources_raw {
            Ok(Some(r)) => r,
            _ => continue,
        };
        let resources = resources_raw.resolve()
            .ok().flatten().unwrap_or(resources_raw);

        collect_fonts_from_resources(&resources, page_no + 1, &mut font_map);
    }

    // object_id でソート (pdffonts 風の出力順)
    let mut fonts: Vec<FontInfo> = font_map.into_values().collect();
    fonts.sort_by_key(|f| f.object_id);
    Ok(fonts)
}

/// /Resources オブジェクトからフォントを再帰収集
fn collect_fonts_from_resources(
    resources: &mupdf::pdf::PdfObject,
    page_1based: i32,
    font_map: &mut std::collections::HashMap<i32, FontInfo>,
) {
    // /Resources/Font
    if let Ok(Some(font_dict_raw)) = resources.get_dict("Font") {
        let font_dict = font_dict_raw.resolve().ok().flatten().unwrap_or(font_dict_raw);
        collect_fonts_from_dict(&font_dict, page_1based, font_map);
    }

    // /Resources/XObject → Form XObject を再帰処理
    if let Ok(Some(xobj_dict_raw)) = resources.get_dict("XObject") {
        let xobj_dict = xobj_dict_raw.resolve().ok().flatten().unwrap_or(xobj_dict_raw);
        let len = xobj_dict.dict_len().unwrap_or(0);
        for i in 0..len as i32 {
            let xobj_raw = match xobj_dict.get_dict_val(i).ok().flatten() {
                Some(o) => o,
                None => continue,
            };
            let xobj = xobj_raw.resolve().ok().flatten().unwrap_or(xobj_raw);

            let subtype = xobj.get_dict("Subtype").ok().flatten()
                .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                .and_then(|o| o.as_name().ok()
                    .map(|b| String::from_utf8_lossy(b).to_string()));

            if subtype.as_deref() == Some("Form") {
                if let Ok(Some(inner_res_raw)) = xobj.get_dict("Resources") {
                    let inner_res = inner_res_raw.resolve().ok().flatten().unwrap_or(inner_res_raw);
                    collect_fonts_from_resources(&inner_res, page_1based, font_map);
                }
            }
        }
    }
}

/// /Font 辞書からフォント情報を font_map (object_id キー) に追加
fn collect_fonts_from_dict(
    font_dict: &mupdf::pdf::PdfObject,
    page_1based: i32,
    font_map: &mut std::collections::HashMap<i32, FontInfo>,
) {
    let len = match font_dict.dict_len() {
        Ok(l) => l,
        Err(_) => return,
    };

    for i in 0..len as i32 {
        // 間接参照のまま object_id を取得してからresolve
        let font_ref = match font_dict.get_dict_val(i).ok().flatten() {
            Some(o) => o,
            None => continue,
        };

        // object_id: 間接参照なら as_indirect() で取得
        let object_id = font_ref.as_indirect().unwrap_or(-1);

        let font_obj = match font_ref.resolve() {
            Ok(Some(o)) => o,
            _ => continue,
        };

        // /Subtype
        let font_type = pdf_name_to_string(&font_obj, "Subtype")
            .unwrap_or_else(|| "Unknown".to_string());

        // /BaseFont (Type3 は持たない場合がある)
        let base_font = pdf_name_to_string(&font_obj, "BaseFont")
            .unwrap_or_default();

        let subset = is_subset_font(&base_font);

        // 埋め込み判定
        let embedded = if font_type == "Type3" {
            font_obj.get_dict("CharProcs").ok().flatten().is_some()
        } else {
            check_embedded(&font_obj)
        };

        // Type0 は DescendantFonts から実情報を取得
        let (name, embedded, font_type, oid) = if font_type == "Type0" {
            let cid_name     = get_cid_font_name(&font_obj).unwrap_or_else(|| base_font.clone());
            let cid_embedded = check_cid_embedded(&font_obj).unwrap_or(embedded);
            let cid_type     = get_cid_font_type(&font_obj).unwrap_or(font_type);
            // DescendantFonts[0] の object_id を使う
            let cid_oid      = get_cid_object_id(&font_obj).unwrap_or(object_id);
            (cid_name, cid_embedded, cid_type, cid_oid)
        } else if font_type == "Type3" {
            let t3_name = if !base_font.is_empty() {
                base_font
            } else {
                // /FontDescriptor/FontName を試みる
                get_font_descriptor_name(&font_obj)
                    .unwrap_or_else(|| "(Type3)".to_string())
            };
            (t3_name, embedded, font_type, object_id)
        } else {
            let name = if base_font.is_empty() { "(unknown)".to_string() } else { base_font };
            (name, embedded, font_type, object_id)
        };

        let entry = font_map.entry(oid).or_insert(FontInfo {
            name:      name.clone(),
            font_type: font_type.clone(),
            embedded,
            subset,
            pages:     Vec::new(),
            object_id: oid,
        });
        if !entry.pages.contains(&page_1based) {
            entry.pages.push(page_1based);
        }
    }
}

/// PdfObject のディクショナリから /Name 値を UTF-8 文字列として取得
fn pdf_name_to_string(obj: &mupdf::pdf::PdfObject, key: &str) -> Option<String> {
    let val = obj.get_dict(key).ok()??;
    let val = val.resolve().ok()??;
    if let Ok(bytes) = val.as_name() {
        return Some(String::from_utf8_lossy(bytes).to_string());
    }
    if let Ok(s) = val.as_string() {
        return Some(s.to_string());
    }
    None
}

/// フォント名がサブセット形式 ("ABCDEF+Name") かどうか判定
fn is_subset_font(name: &str) -> bool {
    if let Some((prefix, _)) = name.split_once('+') {
        prefix.len() == 6 && prefix.chars().all(|c| c.is_ascii_uppercase())
    } else {
        false
    }
}

/// /FontDescriptor に /FontFile* があれば埋め込みフォントと判定
fn check_embedded(font_obj: &mupdf::pdf::PdfObject) -> bool {
    let descriptor = match font_obj.get_dict("FontDescriptor") {
        Ok(Some(d)) => d,
        _ => return false,
    };
    let descriptor = match descriptor.resolve() {
        Ok(Some(d)) => d,
        _ => return false,
    };
    for key in &["FontFile", "FontFile2", "FontFile3"] {
        if let Ok(Some(_)) = descriptor.get_dict(*key) {
            return true;
        }
    }
    false
}

/// /FontDescriptor/FontName を取得
fn get_font_descriptor_name(font_obj: &mupdf::pdf::PdfObject) -> Option<String> {
    let desc = font_obj.get_dict("FontDescriptor").ok()??;
    let desc = desc.resolve().ok()??;
    pdf_name_to_string(&desc, "FontName")
}

/// Type0 の /DescendantFonts[0]/BaseFont を取得
fn get_cid_font_name(font_obj: &mupdf::pdf::PdfObject) -> Option<String> {
    let descendants = font_obj.get_dict("DescendantFonts").ok()??;
    let descendants = descendants.resolve().ok()??;
    let first = descendants.get_array(0).ok()??;
    let first = first.resolve().ok()??;
    pdf_name_to_string(&first, "BaseFont")
}

/// Type0 の DescendantFonts[0] の object_id を取得
fn get_cid_object_id(font_obj: &mupdf::pdf::PdfObject) -> Option<i32> {
    let descendants = font_obj.get_dict("DescendantFonts").ok()??;
    let descendants = descendants.resolve().ok()??;
    let first_ref = descendants.get_array(0).ok()??;
    first_ref.as_indirect().ok()
}

/// Type0 の DescendantFonts[0] から埋め込み状態を確認
fn check_cid_embedded(font_obj: &mupdf::pdf::PdfObject) -> Option<bool> {
    let descendants = font_obj.get_dict("DescendantFonts").ok()??;
    let descendants = descendants.resolve().ok()??;
    let first = descendants.get_array(0).ok()??;
    let first = first.resolve().ok()??;
    Some(check_embedded(&first))
}

/// Type0 の DescendantFonts[0] の /Subtype を取得
fn get_cid_font_type(font_obj: &mupdf::pdf::PdfObject) -> Option<String> {
    let descendants = font_obj.get_dict("DescendantFonts").ok()??;
    let descendants = descendants.resolve().ok()??;
    let first = descendants.get_array(0).ok()??;
    let first = first.resolve().ok()??;
    pdf_name_to_string(&first, "Subtype")
}
