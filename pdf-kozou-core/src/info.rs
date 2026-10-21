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
    use crate::ffi::{FfiResult, kozou_get_doc_info, kozou_new_context};
    use std::ffi::CString;
    use std::os::raw::c_int;

    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    // 非 PDF（DOCX/EPUB 等）は変換処理で扱うため
    // info では最低限の情報（ファイルサイズ・デフォルトページ数）だけ返す。
    // fz_open_document が Windows でフリーズする問題を回避するため
    // 非 PDF ファイルでは Document::open 系を一切呼ばない。
    if !is_pdf(path) {
        // 画像ファイル（JPEG/PNG/SVG）の場合は EXIF/PNG テキストからメタデータを取得
        let ext = std::path::Path::new(path)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let metadata = if matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "svg") {
            let pairs = crate::render::read_image_metadata(path);
            let mut m = PdfMetadata::default();
            for (key, val) in &pairs {
                match key.as_str() {
                    "Title" => m.title = Some(val.clone()),
                    "Author" => m.author = Some(val.clone()),
                    "Subject" => m.subject = Some(val.clone()),
                    "Keywords" => m.keywords = Some(val.clone()),
                    "Creator" => m.creator = Some(val.clone()),
                    "Producer" => m.producer = Some(val.clone()),
                    "CreationDate" => m.creation_date = Some(val.clone()),
                    "ModDate" => m.mod_date = Some(val.clone()),
                    _ => {}
                }
            }
            m
        } else {
            PdfMetadata::default()
        };
        return Ok(InfoResponse {
            ok: true,
            page_count: 1, // 変換前は不明なので 1 ページとして扱う
            file_size,
            pages: vec![PageBounds {
                w: 450.0,
                h: 600.0,
                rotate: 0,
            }],
            metadata,
            fonts: None,
        });
    }

    // PDF はまず lopdf で読み、読めない入力(破損・パスワード付き暗号化等)だけ
    // 従来の MuPDF 実装へフォールバックする（移行期間中の安全策）。
    match info_pdf_lopdf(path, include_fonts, file_size) {
        Ok(res) => return Ok(res),
        Err(e) => eprintln!("[info] lopdf path failed ({e}); falling back to MuPDF"),
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
    let metadata = pdf_metadata_from_pairs(meta_pairs);

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

fn pdf_metadata_from_pairs(pairs: Vec<(String, String)>) -> PdfMetadata {
    let mut metadata = PdfMetadata::default();
    for (key, value) in pairs {
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
    metadata
}

// ── lopdf 実装 ─────────────────────────────────────────────────────────────

use lopdf::{Dictionary, Document, Object, ObjectId};

/// 間接参照を最大 8 段まで解決する。
fn lp_resolve<'a>(doc: &'a Document, obj: &'a Object) -> Option<&'a Object> {
    let mut cur = obj;
    for _ in 0..8 {
        match cur {
            Object::Reference(id) => cur = doc.get_object(*id).ok()?,
            other => return Some(other),
        }
    }
    None
}

fn lp_dict<'a>(doc: &'a Document, obj: &'a Object) -> Option<&'a Dictionary> {
    match lp_resolve(doc, obj)? {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&s.dict),
        _ => None,
    }
}

fn lp_num(doc: &Document, obj: &Object) -> Option<f64> {
    match lp_resolve(doc, obj)? {
        Object::Integer(n) => Some(*n as f64),
        Object::Real(f) => Some(*f as f64),
        _ => None,
    }
}

/// [x0 y0 x1 y1] を (小,小,大,大) に正規化して返す。配列でなければ None。
/// MuPDF の pdf_to_rect と同様、足りない要素・数値でない要素は 0 として扱う。
fn lp_rect(doc: &Document, obj: &Object) -> Option<[f64; 4]> {
    let Object::Array(a) = lp_resolve(doc, obj)? else {
        return None;
    };
    let v: Vec<f64> = (0..4)
        .map(|i| a.get(i).and_then(|o| lp_num(doc, o)).unwrap_or(0.0))
        .collect();
    Some([v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])])
}

fn rect_is_empty(r: &[f64; 4]) -> bool {
    r[2] <= r[0] || r[3] <= r[1]
}

/// ページの実効的な回転角。継承・間接参照・実数・範囲外の値を、MuPDF と同じ規則で
/// 0/90/180/270 に丸める（負数や 360 以上は正規化し、最も近い 90 度に寄せる）。
fn lp_page_rotate(doc: &Document, page_id: ObjectId) -> i32 {
    let Some(obj) = crate::merge::inherited_attr(doc, page_id, b"Rotate") else {
        return 0;
    };
    let Some(mut r) = lp_num(doc, &obj).map(|f| f as i64) else {
        return 0;
    };
    if r < 0 {
        r = 360 - ((-r) % 360);
    }
    if r >= 360 {
        r %= 360;
    }
    let r = 90 * ((r + 45) / 90);
    if r >= 360 { 0 } else { r as i32 }
}

/// MuPDF の fz_bound_page 相当（MuPDF 1.28 の出力と突き合わせて確認した規則）:
/// - MediaBox と CropBox(あれば)の交差を取る。MediaBox が無い・空、交差が空なら 612x792
/// - UserUnit は継承せずページ自身の値だけを掛ける
/// - 回転が 90/270 なら縦横を入れ替える
fn lp_page_bounds(doc: &Document, page_id: ObjectId) -> PageBounds {
    let rotate = lp_page_rotate(doc, page_id);
    let Ok(page) = doc.get_dictionary(page_id) else {
        // 読めないページは従来どおり A4 とみなす
        return PageBounds { w: 595.0, h: 842.0, rotate: 0 };
    };
    let inh = |key: &[u8]| crate::merge::inherited_attr(doc, page_id, key);

    let media = inh(b"MediaBox")
        .and_then(|o| lp_rect(doc, &o))
        .unwrap_or([0.0; 4]);
    let mut real = media;
    if let Some(crop) = inh(b"CropBox").and_then(|o| lp_rect(doc, &o)) {
        real = if rect_is_empty(&media) || rect_is_empty(&crop) {
            [0.0; 4]
        } else {
            [
                media[0].max(crop[0]),
                media[1].max(crop[1]),
                media[2].min(crop[2]),
                media[3].min(crop[3]),
            ]
        };
    }
    if rect_is_empty(&real) {
        real = [0.0, 0.0, 612.0, 792.0];
    }
    let unit = page
        .get(b"UserUnit")
        .ok()
        .and_then(|o| lp_num(doc, o))
        .unwrap_or(1.0);
    let (mut w, mut h) = (
        ((real[2] - real[0]) * unit).abs(),
        ((real[3] - real[1]) * unit).abs(),
    );
    if rotate == 90 || rotate == 270 {
        std::mem::swap(&mut w, &mut h);
    }
    PageBounds { w: w as f32, h: h as f32, rotate: lp_rotate_field(doc, page) }
}

/// 出力の rotate フィールド。従来どおり「ページ自身の /Rotate の値」を 360 で正規化して返す
/// （継承は見ず、90 の倍数への丸めもしない）。w/h は継承・丸めを反映した値で、
/// 両者の意味が異なる点は従来のまま。
fn lp_rotate_field(doc: &Document, page: &Dictionary) -> i32 {
    let v = page.get(b"Rotate").ok().and_then(|o| match lp_resolve(doc, o)? {
        Object::Integer(n) => Some(*n as i32),
        Object::Real(f) => Some(f.round() as i32),
        _ => None,
    });
    v.unwrap_or(0).rem_euclid(360)
}

fn info_pdf_lopdf(
    path: &str,
    include_fonts: bool,
    file_size: u64,
) -> std::result::Result<InfoResponse, String> {
    let doc = Document::load(path).map_err(|e| e.to_string())?;
    if doc.is_encrypted() {
        return Err("encrypted PDF".into());
    }
    let page_ids: Vec<ObjectId> = doc.get_pages().into_values().collect();
    if page_ids.is_empty() {
        return Err("no pages".into());
    }
    let pages: Vec<PageBounds> = page_ids.iter().map(|&id| lp_page_bounds(&doc, id)).collect();
    let metadata = pdf_metadata_from_pairs(crate::compress::metadata_from_doc(&doc));
    let fonts = include_fonts.then(|| lp_collect_fonts(&doc, &page_ids));
    Ok(InfoResponse {
        ok: true,
        page_count: page_ids.len() as i32,
        file_size,
        pages,
        metadata,
        fonts,
    })
}

// ── フォント情報（lopdf 実装）──────────────────────────────────────────────

fn lp_name_str(doc: &Document, d: &Dictionary, key: &str) -> Option<String> {
    match lp_resolve(doc, d.get(key.as_bytes()).ok()?)? {
        Object::Name(n) => Some(String::from_utf8_lossy(n).into_owned()),
        Object::String(b, _) => Some(String::from_utf8_lossy(b).into_owned()),
        _ => None,
    }
}

fn lp_check_embedded(doc: &Document, font: &Dictionary) -> bool {
    let Some(desc) = font.get(b"FontDescriptor").ok().and_then(|o| lp_dict(doc, o)) else {
        return false;
    };
    ["FontFile", "FontFile2", "FontFile3"].iter().any(|k| desc.has(k.as_bytes()))
}

/// Type0 の最初の子孫フォント（辞書と、その間接参照の番号）。
fn lp_cid_first<'a>(doc: &'a Document, font: &'a Dictionary) -> Option<(&'a Dictionary, Option<i32>)> {
    let Object::Array(a) = lp_resolve(doc, font.get(b"DescendantFonts").ok()?)? else {
        return None;
    };
    let first = a.first()?;
    let oid = if let Object::Reference(id) = first { Some(id.0 as i32) } else { None };
    Some((lp_dict(doc, first)?, oid))
}

fn lp_collect_fonts(doc: &Document, page_ids: &[ObjectId]) -> Vec<FontInfo> {
    use std::collections::{HashMap, HashSet};
    let mut font_map: HashMap<String, FontInfo> = HashMap::new();
    for (i, &pid) in page_ids.iter().enumerate() {
        let Some(res) = crate::merge::inherited_attr(doc, pid, b"Resources") else {
            continue;
        };
        let mut visited: HashSet<ObjectId> = HashSet::new();
        lp_fonts_from_resources(doc, &res, i as i32 + 1, &mut font_map, &mut visited);
    }
    let mut fonts: Vec<FontInfo> = font_map.into_values().collect();
    fonts.sort_by(|a, b| a.object_id.cmp(&b.object_id).then_with(|| a.name.cmp(&b.name)));
    fonts
}

fn lp_fonts_from_resources(
    doc: &Document,
    resources: &Object,
    page_1based: i32,
    font_map: &mut std::collections::HashMap<String, FontInfo>,
    visited: &mut std::collections::HashSet<ObjectId>,
) {
    let Some(res) = lp_dict(doc, resources) else {
        return;
    };
    if let Some(fd) = res.get(b"Font").ok().and_then(|o| lp_dict(doc, o)) {
        for (_, v) in fd.iter() {
            lp_add_font(doc, v, page_1based, font_map);
        }
    }
    if let Some(xd) = res.get(b"XObject").ok().and_then(|o| lp_dict(doc, o)) {
        for (_, v) in xd.iter() {
            // Form XObject が自分自身を参照していても無限再帰しないようにする
            if let Object::Reference(id) = v {
                if !visited.insert(*id) {
                    continue;
                }
            }
            let Some(xo) = lp_dict(doc, v) else { continue };
            let is_form = matches!(
                xo.get(b"Subtype").ok().and_then(|o| lp_resolve(doc, o)),
                Some(Object::Name(n)) if n == b"Form"
            );
            if is_form {
                if let Ok(inner) = xo.get(b"Resources") {
                    lp_fonts_from_resources(doc, inner, page_1based, font_map, visited);
                }
            }
        }
    }
}

fn lp_add_font(
    doc: &Document,
    font_ref: &Object,
    page_1based: i32,
    font_map: &mut std::collections::HashMap<String, FontInfo>,
) {
    // 直書きのフォント辞書は番号を持たないので 0（従来の出力に合わせる）
    let oid = if let Object::Reference(id) = font_ref { id.0 as i32 } else { 0 };
    let Some(font) = lp_dict(doc, font_ref) else {
        return;
    };
    let font_type = lp_name_str(doc, font, "Subtype").unwrap_or_else(|| "Unknown".into());
    let base_font = lp_name_str(doc, font, "BaseFont").unwrap_or_default();
    let subset = base_font
        .split_once('+')
        .map(|(p, _)| p.len() == 6 && p.chars().all(|c| c.is_ascii_uppercase()))
        .unwrap_or(false);
    let embedded = if font_type == "Type3" {
        font.has(b"CharProcs")
    } else {
        lp_check_embedded(doc, font)
    };
    let (name, emb, ft, id) = if font_type == "Type0" {
        match lp_cid_first(doc, font) {
            Some((cf, cid_oid)) => (
                lp_name_str(doc, cf, "BaseFont").unwrap_or(base_font.clone()),
                lp_check_embedded(doc, cf),
                lp_name_str(doc, cf, "Subtype").unwrap_or(font_type),
                cid_oid.unwrap_or(oid),
            ),
            None => (base_font.clone(), embedded, font_type, oid),
        }
    } else if font_type == "Type3" {
        let n = if !base_font.is_empty() {
            base_font
        } else {
            font.get(b"FontDescriptor")
                .ok()
                .and_then(|o| lp_dict(doc, o))
                .and_then(|d| lp_name_str(doc, d, "FontName"))
                .unwrap_or_else(|| "(Type3)".into())
        };
        (n, embedded, font_type, oid)
    } else {
        (
            if base_font.is_empty() { "(unknown)".into() } else { base_font },
            embedded,
            font_type,
            oid,
        )
    };
    // 番号を持つフォントは番号で、直書きのものは種類と名前で同一視する
    // （従来は直書きのフォントがすべて 1 件にまとまっていた）
    let key = if id > 0 { format!("o{id}") } else { format!("d:{ft}:{name}") };
    let e = font_map.entry(key).or_insert(FontInfo {
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
                        .as_ref()
                        .map(|b| String::from_utf8_lossy(b).to_string())
                });
            if sub.as_deref() == Some("Form")
                && let Ok(Some(ir_raw)) = xo.get_dict("Resources")
            {
                let ir = ir_raw.resolve().ok().flatten().unwrap_or(ir_raw);
                collect_fonts_from_resources(&ir, page_1based, font_map);
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
        return Some(String::from_utf8_lossy(&b).into());
    }
    if let Ok(s) = v.as_string() {
        return Some(s);
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
