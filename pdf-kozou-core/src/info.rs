// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/info.rs
// PDF・対応ファイルのメタ情報取得
//
// 設計方針:
//   - ページ数・サイズは C FFI (kozou_get_doc_info) で取得
//     → mupdf::Document::open（Rust バインディング）は使わない
//     → Windows での font_kit フリーズを回避
//   - Rotate 値は PdfDocument で取得（PDF のみ・フォント触らない）
//   - フォント情報は --fonts オプション時のみ収集（GUI からは呼ばない）

use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};

const MAX_PAGES: usize = 65536;

#[derive(Serialize, Deserialize)]
pub struct PageBounds {
    pub w: f32,
    pub h: f32,
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

fn info_impl(path: &str, include_fonts: bool) -> Result<InfoResponse> {
    use crate::convert::is_pdf;
    use crate::ffi::{kozou_get_doc_info, kozou_new_context, FfiResult};
    use std::ffi::CString;
    use std::os::raw::c_int;

    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    // 非 PDF（DOCX/EPUB 等）は変換処理で扱うため
    // info では最低限の情報（ファイルサイズ・デフォルトページ数）だけ返す。
    // fz_open_document が Windows でフリーズする問題を回避するため
    // 非 PDF ファイルでは Document::open 系を一切呼ばない。
    if !is_pdf(path) {
        return Ok(InfoResponse {
            ok: true,
            page_count: 1, // 変換前は不明なので 1 ページとして扱う
            file_size,
            pages: vec![PageBounds {
                w: 450.0,
                h: 600.0,
                rotate: 0,
            }],
            metadata: PdfMetadata::default(),
            fonts: None,
        });
    }

    let c_path = CString::new(path).map_err(|_| CoreError::InvalidArg("invalid path".into()))?;

    // C FFI でページ数・サイズを取得
    // Rust バインディング (mupdf::Document::open) は使わない
    let mut page_rects = vec![0.0f32; MAX_PAGES * 4];
    let mut page_count: c_int = 0;
    let mut ffi_result = FfiResult::default();

    unsafe {
        let ctx = kozou_new_context();
        if ctx.is_null() {
            return Err(CoreError::MuPdf("kozou_new_context failed".into()));
        }
        kozou_get_doc_info(
            ctx,
            c_path.as_ptr(),
            0.0,
            0.0,
            0.0, // デフォルトレイアウト (450x600 em=12)
            page_rects.as_mut_ptr(),
            &mut page_count,
            MAX_PAGES as c_int,
            &mut ffi_result,
        );
        mupdf_sys::fz_drop_context(ctx);
    }

    if ffi_result.ok == 0 {
        return Err(CoreError::MuPdf(format!("{ffi_result}")));
    }

    let n = page_count as usize;

    // PDF の場合のみ Rotate 値を PdfDocument から取得
    // PdfDocument::open は pdf_open_document を使いフォントスキャンしない
    let pdf_opt = mupdf::pdf::PdfDocument::open(path).ok();

    let mut pages = Vec::with_capacity(n);
    for i in 0..n {
        let x0 = page_rects[i * 4];
        let y0 = page_rects[i * 4 + 1];
        let x1 = page_rects[i * 4 + 2];
        let y1 = page_rects[i * 4 + 3];
        let w = (x1 - x0).abs();
        let h = (y1 - y0).abs();

        let rotate = pdf_opt
            .as_ref()
            .and_then(|pdf| pdf.find_page(i as i32).ok())
            .and_then(|pg| {
                pg.get_dict("Rotate")
                    .ok()?
                    .and_then(|o| o.resolve().ok()?.and_then(|r| r.as_int().ok()))
            })
            .map(|r: i32| r.rem_euclid(360))
            .unwrap_or(0);

        // Rotate=90/270 の場合、kozou_get_doc_info の bounds はすでに回転済みなので
        // rotate 値だけ記録する（w/h はそのまま）
        pages.push(PageBounds { w, h, rotate });
    }

    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    // メタデータ（collect_metadata は PdfDocument 経由）
    let meta_pairs = crate::compress::collect_metadata(path);
    let mut metadata = PdfMetadata::default();
    for (key, value) in meta_pairs {
        match key.as_str() {
            "Title" => metadata.title = Some(value),
            "Author" => metadata.author = Some(value),
            "Subject" => metadata.subject = Some(value),
            "Keywords" => metadata.keywords = Some(value),
            "Creator" => metadata.creator = Some(value),
            "Producer" => metadata.producer = Some(value),
            "CreationDate" => metadata.creation_date = Some(value),
            "ModDate" => metadata.mod_date = Some(value),
            _ => {}
        }
    }

    let fonts = if include_fonts {
        pdf_opt
            .as_ref()
            .map(|pdf| collect_fonts(pdf, page_count))
            .transpose()?
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
    if let Ok(Some(fd_raw)) = resources.get_dict("Font") {
        let fd = fd_raw.resolve().ok().flatten().unwrap_or(fd_raw);
        collect_fonts_from_dict(&fd, page_1based, font_map);
    }
    if let Ok(Some(xd_raw)) = resources.get_dict("XObject") {
        let xd = xd_raw.resolve().ok().flatten().unwrap_or(xd_raw);
        let len = xd.dict_len().unwrap_or(0);
        for i in 0..len as i32 {
            let xo_raw = match xd.get_dict_val(i).ok().flatten() {
                Some(o) => o,
                None => continue,
            };
            let xo = xo_raw.resolve().ok().flatten().unwrap_or(xo_raw);
            let sub = xo
                .get_dict("Subtype")
                .ok()
                .flatten()
                .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                .and_then(|o| {
                    o.as_name()
                        .ok()
                        .map(|b| String::from_utf8_lossy(b).to_string())
                });
            if sub.as_deref() == Some("Form") {
                if let Ok(Some(ir_raw)) = xo.get_dict("Resources") {
                    let ir = ir_raw.resolve().ok().flatten().unwrap_or(ir_raw);
                    collect_fonts_from_resources(&ir, page_1based, font_map);
                }
            }
        }
    }
}

fn collect_fonts_from_dict(
    fd: &mupdf::pdf::PdfObject,
    page_1based: i32,
    font_map: &mut std::collections::HashMap<i32, FontInfo>,
) {
    let len = match fd.dict_len() {
        Ok(l) => l,
        Err(_) => return,
    };
    for i in 0..len as i32 {
        let font_ref = match fd.get_dict_val(i).ok().flatten() {
            Some(o) => o,
            None => continue,
        };
        let oid = font_ref.as_indirect().unwrap_or(-1);
        let font_obj = match font_ref.resolve() {
            Ok(Some(o)) => o,
            _ => continue,
        };
        let font_type = pdf_name_str(&font_obj, "Subtype").unwrap_or_else(|| "Unknown".into());
        let base_font = pdf_name_str(&font_obj, "BaseFont").unwrap_or_default();
        let subset = base_font
            .split_once('+')
            .map(|(p, _)| p.len() == 6 && p.chars().all(|c| c.is_ascii_uppercase()))
            .unwrap_or(false);
        let embedded = if font_type == "Type3" {
            font_obj.get_dict("CharProcs").ok().flatten().is_some()
        } else {
            check_embedded(&font_obj)
        };
        let (name, emb, ft, id) = if font_type == "Type0" {
            (
                cid_name(&font_obj).unwrap_or(base_font.clone()),
                cid_embedded(&font_obj).unwrap_or(embedded),
                cid_type(&font_obj).unwrap_or(font_type),
                cid_oid(&font_obj).unwrap_or(oid),
            )
        } else if font_type == "Type3" {
            let n = if !base_font.is_empty() {
                base_font
            } else {
                desc_name(&font_obj).unwrap_or_else(|| "(Type3)".into())
            };
            (n, embedded, font_type, oid)
        } else {
            (
                if base_font.is_empty() {
                    "(unknown)".into()
                } else {
                    base_font
                },
                embedded,
                font_type,
                oid,
            )
        };
        let e = font_map.entry(id).or_insert(FontInfo {
            name,
            font_type: ft,
            embedded: emb,
            subset,
            pages: vec![],
            object_id: id,
        });
        if !e.pages.contains(&page_1based) {
            e.pages.push(page_1based);
        }
    }
}

fn pdf_name_str(o: &mupdf::pdf::PdfObject, k: &str) -> Option<String> {
    let v = o.get_dict(k).ok()??;
    let v = v.resolve().ok()??;
    if let Ok(b) = v.as_name() {
        return Some(String::from_utf8_lossy(b).into());
    }
    if let Ok(s) = v.as_string() {
        return Some(s.into());
    }
    None
}
fn check_embedded(o: &mupdf::pdf::PdfObject) -> bool {
    let d = match o.get_dict("FontDescriptor").ok().flatten() {
        Some(d) => d,
        None => return false,
    };
    let d = match d.resolve().ok().flatten() {
        Some(d) => d,
        None => return false,
    };
    ["FontFile", "FontFile2", "FontFile3"]
        .iter()
        .any(|k| d.get_dict(*k).ok().flatten().is_some())
}
fn desc_name(o: &mupdf::pdf::PdfObject) -> Option<String> {
    let d = o.get_dict("FontDescriptor").ok()??;
    let d = d.resolve().ok()??;
    pdf_name_str(&d, "FontName")
}
fn cid_first(o: &mupdf::pdf::PdfObject) -> Option<mupdf::pdf::PdfObject> {
    let d = o.get_dict("DescendantFonts").ok()??;
    let d = d.resolve().ok()??;
    let f = d.get_array(0).ok()??;
    f.resolve().ok()?
}
fn cid_name(o: &mupdf::pdf::PdfObject) -> Option<String> {
    pdf_name_str(&cid_first(o)?, "BaseFont")
}
fn cid_oid(o: &mupdf::pdf::PdfObject) -> Option<i32> {
    let d = o.get_dict("DescendantFonts").ok()??;
    let d = d.resolve().ok()??;
    d.get_array(0).ok()??.as_indirect().ok()
}
fn cid_embedded(o: &mupdf::pdf::PdfObject) -> Option<bool> {
    Some(check_embedded(&cid_first(o)?))
}
fn cid_type(o: &mupdf::pdf::PdfObject) -> Option<String> {
    pdf_name_str(&cid_first(o)?, "Subtype")
}
