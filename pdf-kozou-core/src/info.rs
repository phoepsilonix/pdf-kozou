// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/info.rs
// PDF メタ情報取得
//
// 設計方針:
//   - mupdf::Document::open を使わない
//     → system-fonts feature の font_kit がフォントスキャンを行いメモリ・時間を浪費する
//   - PdfDocument::open のみ使用
//     → PDF オブジェクトを直接読み取るため高速・軽量
//   - フォント情報は --fonts オプション時のみ収集（GUI からは呼ばない）

use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct PageBounds {
    pub w: f32,
    pub h: f32,
    /// PDF の Rotate 値 (0/90/180/270)
    pub rotate: i32,
}

#[derive(Serialize, Clone, Default)]
pub struct PdfMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keywords: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub producer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mod_date: Option<String>,
}

#[derive(Serialize)]
pub struct InfoResponse {
    pub ok: bool,
    pub page_count: i32,
    pub file_size: u64,
    pub pages: Vec<PageBounds>,
    pub metadata: PdfMetadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fonts: Option<Vec<FontInfo>>,
}

#[derive(Serialize, Clone)]
pub struct FontInfo {
    pub name: String,
    pub font_type: String,
    pub embedded: bool,
    pub subset: bool,
    pub pages: Vec<i32>,
    pub object_id: i32,
}

pub fn info(path: &str) -> Result<InfoResponse> {
    info_impl(path, false)
}

pub fn info_with_fonts(path: &str) -> Result<InfoResponse> {
    info_impl(path, true)
}

/// メイン実装。PdfDocument のみを使用（mupdf::Document::open は使わない）。
///
/// mupdf::Document::open は system-fonts feature により Windows で
/// フォントスキャンが走りメモリ増大・タイムアウトの原因になる。
/// PdfDocument は PDF オブジェクトを直接操作するため高速・軽量。
///
/// 非 PDF（DOCX/EPUB 等）は一時 PDF に変換してから処理。
fn info_impl(path: &str, include_fonts: bool) -> Result<InfoResponse> {
    use crate::convert::{convert_to_pdf, is_mupdf_supported, is_pdf, ConvertRequest};
    use mupdf::pdf::PdfDocument;

    // 非 PDF は一時 PDF に変換してから処理
    let _tmp_file: Option<tempfile::NamedTempFile>;
    let tmp_path_str: Option<String>;

    if !is_pdf(path) {
        if !is_mupdf_supported(path) {
            return Ok(InfoResponse {
                ok: true,
                page_count: 0,
                file_size: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
                pages: vec![],
                metadata: PdfMetadata::default(),
                fonts: None,
            });
        }
        let kozou_tmp_dir = std::env::temp_dir().join("pdf-kozou");
        let _ = std::fs::create_dir_all(&kozou_tmp_dir);
        let tmp = tempfile::Builder::new()
            .prefix("info_convert_")
            .suffix(".pdf")
            .tempfile_in(&kozou_tmp_dir)
            .map_err(|e| CoreError::Internal(format!("tempfile: {e}")))?;
        let tmp_str = tmp.path().to_string_lossy().to_string();
        let req = ConvertRequest {
            input: path.to_string(),
            output: tmp_str.clone(),
            layout_w: None,
            layout_h: None,
            layout_em: None,
        };
        if convert_to_pdf(&req).is_err() {
            return Ok(InfoResponse {
                ok: true,
                page_count: 0,
                file_size: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
                pages: vec![],
                metadata: PdfMetadata::default(),
                fonts: None,
            });
        }
        _tmp_file = Some(tmp);
        tmp_path_str = Some(tmp_str);
    } else {
        _tmp_file = None;
        tmp_path_str = None;
    }

    let actual_path = tmp_path_str.as_deref().unwrap_or(path);
    let pdf = PdfDocument::open(actual_path).map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let page_count = pdf
        .page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    // ── ページ情報（MediaBox/CropBox + Rotate）─────────────────────────────
    // PDF オブジェクトを直接読み取る → fz_load_page 不要 → フォントスキャン発生しない
    let mut pages = Vec::with_capacity(page_count as usize);
    for i in 0..page_count {
        let (w, h, rotate) = page_bounds_from_obj(&pdf, i);
        pages.push(PageBounds { w, h, rotate });
    }

    // ── ファイルサイズ（OS の stat のみ）──────────────────────────────────
    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    // ── /Info メタデータ（PdfDocument から直接取得）──────────────────────
    let metadata = collect_metadata_from_pdf(&pdf);

    // ── フォント情報（オプション、GUI からは呼ばない）────────────────────
    let fonts = if include_fonts {
        Some(collect_fonts(&pdf, page_count)?)
    } else {
        None
    };

    Ok(InfoResponse {
        ok: true,
        page_count,
        file_size,
        pages,
        metadata,
        fonts,
    })
}

/// PDF オブジェクトからページのサイズと回転を取得する。
/// fz_load_page / fz_bound_page を使わずに済む。
fn page_bounds_from_obj(pdf: &mupdf::pdf::PdfDocument, page_no: i32) -> (f32, f32, i32) {
    let page_obj = match pdf.find_page(page_no) {
        Ok(p) => p,
        Err(_) => return (595.0, 842.0, 0), // A4 デフォルト
    };

    // CropBox > MediaBox の優先順位で取得
    let bbox = get_box(&page_obj, "CropBox")
        .or_else(|| get_box(&page_obj, "MediaBox"))
        .unwrap_or([0.0, 0.0, 595.0, 842.0]);

    let w = (bbox[2] - bbox[0]).abs();
    let h = (bbox[3] - bbox[1]).abs();

    // Rotate 値
    let rotate = page_obj
        .get_dict("Rotate")
        .ok()
        .flatten()
        .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
        .and_then(|o| o.as_int().ok())
        .map(|r: i32| r.rem_euclid(360))
        .unwrap_or(0);

    // Rotate=90/270 の場合、w と h を入れ替える（描画サイズに合わせる）
    if rotate == 90 || rotate == 270 {
        (h, w, rotate)
    } else {
        (w, h, rotate)
    }
}

/// ページオブジェクトから MediaBox/CropBox を [x0,y0,x1,y1] として取得。
/// 継承（親ページツリー）も考慮。
fn get_box(page_obj: &mupdf::pdf::PdfObject, key: &str) -> Option<[f32; 4]> {
    let arr = page_obj
        .get_dict_inheritable(key)
        .ok()
        .flatten()
        .or_else(|| page_obj.get_dict(key).ok().flatten())?;
    let arr = arr.resolve().ok().flatten().unwrap_or(arr);

    let x0 = arr.get_array(0).ok()??.resolve().ok()??.as_float().ok()?;
    let y0 = arr.get_array(1).ok()??.resolve().ok()??.as_float().ok()?;
    let x1 = arr.get_array(2).ok()??.resolve().ok()??.as_float().ok()?;
    let y1 = arr.get_array(3).ok()??.resolve().ok()??.as_float().ok()?;
    Some([x0, y0, x1, y1])
}

/// PdfDocument から /Info ディクショナリのメタデータを取得。
/// collect_metadata（mupdf::Document::open を使う）を呼ばない。
fn collect_metadata_from_pdf(pdf: &mupdf::pdf::PdfDocument) -> PdfMetadata {
    let mut meta = PdfMetadata::default();

    // pdf.trailer() → /Info 間接参照 → 辞書
    let trailer = match pdf.trailer() {
        Ok(t) => t,
        Err(_) => return meta,
    };
    let info_ref = match trailer.get_dict("Info").ok().flatten() {
        Some(r) => r,
        None => return meta,
    };
    let info_obj = match info_ref.resolve().ok().flatten() {
        Some(o) => o,
        None => return meta,
    };

    let read = |key: &str| -> Option<String> {
        let val = info_obj.get_dict(key).ok()??;
        let val = val.resolve().ok()??;
        // PDF 文字列は as_string() で UTF-8、または名前として
        if let Ok(s) = val.as_string() {
            return Some(s.to_string());
        }
        if let Ok(b) = val.as_name() {
            return Some(String::from_utf8_lossy(b).to_string());
        }
        None
    };

    meta.title = read("Title");
    meta.author = read("Author");
    meta.subject = read("Subject");
    meta.keywords = read("Keywords");
    meta.creator = read("Creator");
    meta.producer = read("Producer");
    meta.creation_date = read("CreationDate");
    meta.mod_date = read("ModDate");
    meta
}

// ── フォント情報収集（--fonts オプション時のみ）────────────────────────────

fn collect_fonts(pdf: &mupdf::pdf::PdfDocument, page_count: i32) -> Result<Vec<FontInfo>> {
    use std::collections::HashMap;
    let mut font_map: HashMap<i32, FontInfo> = HashMap::new();

    for page_no in 0..page_count {
        let page_obj = match pdf.find_page(page_no) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let resources_raw = page_obj
            .get_dict_inheritable("Resources")
            .or_else(|_| page_obj.get_dict("Resources"));
        let resources_raw = match resources_raw {
            Ok(Some(r)) => r,
            _ => continue,
        };
        let resources = resources_raw
            .resolve()
            .ok()
            .flatten()
            .unwrap_or(resources_raw);
        collect_fonts_from_resources(&resources, page_no + 1, &mut font_map);
    }

    let mut fonts: Vec<FontInfo> = font_map.into_values().collect();
    fonts.sort_by_key(|f| f.object_id);
    Ok(fonts)
}

fn collect_fonts_from_resources(
    resources: &mupdf::pdf::PdfObject,
    page_1based: i32,
    font_map: &mut std::collections::HashMap<i32, FontInfo>,
) {
    if let Ok(Some(font_dict_raw)) = resources.get_dict("Font") {
        let font_dict = font_dict_raw
            .resolve()
            .ok()
            .flatten()
            .unwrap_or(font_dict_raw);
        collect_fonts_from_dict(&font_dict, page_1based, font_map);
    }
    if let Ok(Some(xobj_dict_raw)) = resources.get_dict("XObject") {
        let xobj_dict = xobj_dict_raw
            .resolve()
            .ok()
            .flatten()
            .unwrap_or(xobj_dict_raw);
        let len = xobj_dict.dict_len().unwrap_or(0);
        for i in 0..len as i32 {
            let xobj_raw = match xobj_dict.get_dict_val(i).ok().flatten() {
                Some(o) => o,
                None => continue,
            };
            let xobj = xobj_raw.resolve().ok().flatten().unwrap_or(xobj_raw);
            let subtype = xobj
                .get_dict("Subtype")
                .ok()
                .flatten()
                .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                .and_then(|o| {
                    o.as_name()
                        .ok()
                        .map(|b| String::from_utf8_lossy(b).to_string())
                });
            if subtype.as_deref() == Some("Form") {
                if let Ok(Some(inner_res_raw)) = xobj.get_dict("Resources") {
                    let inner_res = inner_res_raw
                        .resolve()
                        .ok()
                        .flatten()
                        .unwrap_or(inner_res_raw);
                    collect_fonts_from_resources(&inner_res, page_1based, font_map);
                }
            }
        }
    }
}

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
        let font_ref = match font_dict.get_dict_val(i).ok().flatten() {
            Some(o) => o,
            None => continue,
        };
        let object_id = font_ref.as_indirect().unwrap_or(-1);
        let font_obj = match font_ref.resolve() {
            Ok(Some(o)) => o,
            _ => continue,
        };

        let font_type =
            pdf_name_to_string(&font_obj, "Subtype").unwrap_or_else(|| "Unknown".to_string());
        let base_font = pdf_name_to_string(&font_obj, "BaseFont").unwrap_or_default();
        let subset = is_subset_font(&base_font);
        let embedded = if font_type == "Type3" {
            font_obj.get_dict("CharProcs").ok().flatten().is_some()
        } else {
            check_embedded(&font_obj)
        };

        let (name, embedded, font_type, oid) = if font_type == "Type0" {
            let cid_name = get_cid_font_name(&font_obj).unwrap_or_else(|| base_font.clone());
            let cid_embedded = check_cid_embedded(&font_obj).unwrap_or(embedded);
            let cid_type = get_cid_font_type(&font_obj).unwrap_or(font_type);
            let cid_oid = get_cid_object_id(&font_obj).unwrap_or(object_id);
            (cid_name, cid_embedded, cid_type, cid_oid)
        } else if font_type == "Type3" {
            let t3_name = if !base_font.is_empty() {
                base_font
            } else {
                get_font_descriptor_name(&font_obj).unwrap_or_else(|| "(Type3)".to_string())
            };
            (t3_name, embedded, font_type, object_id)
        } else {
            let name = if base_font.is_empty() {
                "(unknown)".to_string()
            } else {
                base_font
            };
            (name, embedded, font_type, object_id)
        };

        let entry = font_map.entry(oid).or_insert(FontInfo {
            name: name.clone(),
            font_type: font_type.clone(),
            embedded,
            subset,
            pages: Vec::new(),
            object_id: oid,
        });
        if !entry.pages.contains(&page_1based) {
            entry.pages.push(page_1based);
        }
    }
}

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

fn is_subset_font(name: &str) -> bool {
    if let Some((prefix, _)) = name.split_once('+') {
        prefix.len() == 6 && prefix.chars().all(|c| c.is_ascii_uppercase())
    } else {
        false
    }
}

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

fn get_font_descriptor_name(font_obj: &mupdf::pdf::PdfObject) -> Option<String> {
    let desc = font_obj.get_dict("FontDescriptor").ok()??;
    let desc = desc.resolve().ok()??;
    pdf_name_to_string(&desc, "FontName")
}

fn get_cid_font_name(font_obj: &mupdf::pdf::PdfObject) -> Option<String> {
    let descendants = font_obj.get_dict("DescendantFonts").ok()??;
    let descendants = descendants.resolve().ok()??;
    let first = descendants.get_array(0).ok()??;
    let first = first.resolve().ok()??;
    pdf_name_to_string(&first, "BaseFont")
}

fn get_cid_object_id(font_obj: &mupdf::pdf::PdfObject) -> Option<i32> {
    let descendants = font_obj.get_dict("DescendantFonts").ok()??;
    let descendants = descendants.resolve().ok()??;
    let first_ref = descendants.get_array(0).ok()??;
    first_ref.as_indirect().ok()
}

fn check_cid_embedded(font_obj: &mupdf::pdf::PdfObject) -> Option<bool> {
    let descendants = font_obj.get_dict("DescendantFonts").ok()??;
    let descendants = descendants.resolve().ok()??;
    let first = descendants.get_array(0).ok()??;
    let first = first.resolve().ok()??;
    Some(check_embedded(&first))
}

fn get_cid_font_type(font_obj: &mupdf::pdf::PdfObject) -> Option<String> {
    let descendants = font_obj.get_dict("DescendantFonts").ok()??;
    let descendants = descendants.resolve().ok()??;
    let first = descendants.get_array(0).ok()??;
    let first = first.resolve().ok()??;
    pdf_name_to_string(&first, "Subtype")
}
