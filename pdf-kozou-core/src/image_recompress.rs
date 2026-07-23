// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// pdf-kozou-core/src/image_recompress.rs
//
// 埋め込み画像を「ページ上での実表示サイズ」から逆算した必要ピクセル数まで
// ダウンサンプルし、指定 JPEG 品質で再圧縮する。
//
// 手順:
//   1. lopdf でコンテンツストリームを解析し、cm/q/Q で CTM を追跡しながら
//      Do (Form 再帰含む) で描画される Image XObject ごとに、ページ座標上での
//      表示サイズ（pt）の最大値を集計する。
//   2. 表示サイズ(pt) と目標 DPI から必要ピクセル数を求め、画像のネイティブ
//      ピクセル数がそれを一定以上上回る場合のみ、image crate でデコード→
//      リサイズ→指定品質で JPEG 再エンコードし、同じ xref のストリームを
//      その場で置き換える（参照側の Resources 辞書は一切変更不要）。
//
// 制限事項:
//   - 対象は Filter が単一の /DCTDecode (JPEG) である画像のみ。
//     Flate/CCITT/JPX や複合フィルタ (配列) はデコード経路が複雑なため
//     安全側でスキップする（元のまま保持）。
//   - インライン画像 (BI...EI) は対象外。
//   - /SMask (アルファ) が同じ画像に付随する場合は、本体と同じ目標サイズに
//     合わせて縮小する（アスペクトのズレ防止）。

use lopdf::content::Content;
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Default)]
pub struct ImageRecompressStats {
    pub images_scanned: usize,
    pub images_recompressed: usize,
    pub images_skipped_filter: usize,
}

#[derive(Clone, Copy, Debug)]
struct Matrix {
    a: f32,
    b: f32,
    c: f32,
    d: f32,
    e: f32,
    f: f32,
}

impl Matrix {
    const IDENTITY: Matrix = Matrix {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    /// PDF 仕様 8.3.4 の行列連結: self を先に適用し、続けて other を適用する
    /// (= 新しい CTM は「self × other」)
    fn concat(&self, other: &Matrix) -> Matrix {
        Matrix {
            a: self.a * other.a + self.b * other.c,
            b: self.a * other.b + self.b * other.d,
            c: self.c * other.a + self.d * other.c,
            d: self.c * other.b + self.d * other.d,
            e: self.e * other.a + self.f * other.c + other.e,
            f: self.e * other.b + self.f * other.d + other.f,
        }
    }

    /// 単位正方形の辺 (1,0), (0,1) を変換した際の長さ = ページ上の表示サイズ(pt)
    fn displayed_size(&self) -> (f32, f32) {
        let wx = self.a;
        let wy = self.b;
        let hx = self.c;
        let hy = self.d;
        let w = (wx * wx + wy * wy).sqrt();
        let h = (hx * hx + hy * hy).sqrt();
        (w, h)
    }
}

fn obj_to_f32(o: &Object) -> f32 {
    match o {
        Object::Integer(i) => *i as f32,
        Object::Real(r) => *r,
        _ => 0.0,
    }
}

/// obj が Dictionary そのもの、または Dictionary への参照であれば解決して返す
fn resolve_dict(doc: &Document, obj: &Object) -> Option<Dictionary> {
    let (_, resolved) = doc.dereference(obj).ok()?;
    resolved.as_dict().ok().cloned()
}

/// ページ (または Form) の /Resources を辞書として解決する。
/// ページ自身に無ければ /Parent を辿って継承分を探す（PDF の仕様どおり）。
fn resolve_resources(doc: &Document, obj_id: ObjectId) -> Option<Dictionary> {
    let mut current = obj_id;
    loop {
        let dict = doc.get_object(current).ok()?.as_dict().ok()?;
        if let Ok(res) = dict.get(b"Resources") {
            if let Some(res_dict) = resolve_dict(doc, res) {
                return Some(res_dict);
            }
        }
        match dict.get(b"Parent") {
            Ok(Object::Reference(p)) => current = *p,
            _ => return None,
        }
    }
}

fn get_content_bytes(doc: &Document, obj: &Object) -> Vec<u8> {
    let mut out = Vec::new();
    match obj {
        Object::Reference(id) => {
            if let Ok(resolved) = doc.get_object(*id) {
                out.extend(get_content_bytes(doc, resolved));
            }
        }
        Object::Array(arr) => {
            for item in arr {
                out.extend(get_content_bytes(doc, item));
                if !out.ends_with(b"\n") {
                    out.push(b'\n');
                }
            }
        }
        Object::Stream(s) => {
            if let Ok(data) = s.decompressed_content() {
                out.extend(data);
            }
        }
        _ => {}
    }
    out
}

/// 1 つの XObject 辞書 (/Image or /Form) を CTM 付きで走査し、
/// 画像の表示サイズ最大値を `needed` に集計する。
#[allow(clippy::too_many_arguments)]
fn walk_content(
    doc: &Document,
    content_bytes: &[u8],
    resources: &Dictionary,
    ctm: Matrix,
    depth: u32,
    visiting: &mut HashSet<ObjectId>,
    needed: &mut HashMap<ObjectId, (f32, f32)>,
) {
    if depth > 12 {
        return;
    }
    let content = match Content::decode(content_bytes) {
        Ok(c) => c,
        Err(_) => return,
    };

    let mut stack: Vec<Matrix> = Vec::new();
    let mut cur = ctm;

    let xobject_dict: Option<Dictionary> = resources
        .get(b"XObject")
        .ok()
        .and_then(|o| resolve_dict(doc, o));

    for op in &content.operations {
        match op.operator.as_str() {
            "q" => stack.push(cur),
            "Q" => {
                if let Some(m) = stack.pop() {
                    cur = m;
                }
            }
            "cm" if op.operands.len() == 6 => {
                let m = Matrix {
                    a: obj_to_f32(&op.operands[0]),
                    b: obj_to_f32(&op.operands[1]),
                    c: obj_to_f32(&op.operands[2]),
                    d: obj_to_f32(&op.operands[3]),
                    e: obj_to_f32(&op.operands[4]),
                    f: obj_to_f32(&op.operands[5]),
                };
                cur = m.concat(&cur);
            }
            "Do" if op.operands.len() == 1 => {
                let name = match &op.operands[0] {
                    Object::Name(n) => n.clone(),
                    _ => continue,
                };
                let Some(xobj_dict) = &xobject_dict else {
                    continue;
                };
                let Ok(entry) = xobj_dict.get(&name) else {
                    continue;
                };
                let Object::Reference(xref) = entry else {
                    continue;
                };
                let Ok(xobj) = doc.get_object(*xref) else {
                    continue;
                };
                let Ok(xobj_dict_inner) = xobj.as_dict() else {
                    continue;
                };
                let subtype = xobj_dict_inner
                    .get(b"Subtype")
                    .ok()
                    .and_then(|o| o.as_name().ok())
                    .map(|s| s.to_vec());

                match subtype.as_deref() {
                    Some(b"Image") => {
                        let (w, h) = cur.displayed_size();
                        let e = needed.entry(*xref).or_insert((0.0, 0.0));
                        if w > e.0 {
                            e.0 = w;
                        }
                        if h > e.1 {
                            e.1 = h;
                        }
                    }
                    Some(b"Form") => {
                        if visiting.contains(xref) {
                            continue; // 循環参照防止
                        }
                        let form_matrix = xobj_dict_inner
                            .get(b"Matrix")
                            .ok()
                            .and_then(|o| o.as_array().ok())
                            .filter(|a| a.len() == 6)
                            .map(|a| Matrix {
                                a: obj_to_f32(&a[0]),
                                b: obj_to_f32(&a[1]),
                                c: obj_to_f32(&a[2]),
                                d: obj_to_f32(&a[3]),
                                e: obj_to_f32(&a[4]),
                                f: obj_to_f32(&a[5]),
                            })
                            .unwrap_or(Matrix::IDENTITY);
                        let form_ctm = form_matrix.concat(&cur);
                        let form_resources = xobj_dict_inner
                            .get(b"Resources")
                            .ok()
                            .and_then(|o| resolve_dict(doc, o))
                            .unwrap_or_else(|| resources.clone());
                        let form_bytes = if let Object::Stream(s) = xobj {
                            s.decompressed_content().unwrap_or_default()
                        } else {
                            Vec::new()
                        };
                        visiting.insert(*xref);
                        walk_content(
                            doc,
                            &form_bytes,
                            &form_resources,
                            form_ctm,
                            depth + 1,
                            visiting,
                            needed,
                        );
                        visiting.remove(xref);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

/// フィルタが「単一の /DCTDecode」であるかどうか
fn is_plain_dct(dict: &Dictionary) -> bool {
    match dict.get(b"Filter") {
        Ok(Object::Name(n)) => n.as_slice() == b"DCTDecode",
        _ => false,
    }
}

fn image_native_size(dict: &Dictionary) -> Option<(i64, i64)> {
    let w = dict.get(b"Width").ok()?.as_i64().ok()?;
    let h = dict.get(b"Height").ok()?.as_i64().ok()?;
    Some((w, h))
}

fn is_grayscale(dict: &Dictionary) -> bool {
    match dict.get(b"ColorSpace") {
        Ok(Object::Name(n)) => n.as_slice() == b"DeviceGray" || n.as_slice() == b"CalGray",
        _ => false,
    }
}

/// 1 枚の画像ストリームを target_w x target_h にダウンサンプルし、
/// 指定 JPEG 品質で再エンコードして in-place で置き換える。
fn recompress_one(
    doc: &mut Document,
    xref: ObjectId,
    target_w: u32,
    target_h: u32,
    quality: u8,
) -> Result<(), String> {
    use image::codecs::jpeg::JpegEncoder;
    use image::{ColorType, ImageEncoder};

    let (raw_bytes, grayscale) = {
        let obj = doc
            .get_object(xref)
            .map_err(|e| format!("get image {xref:?}: {e}"))?;
        let stream = obj
            .as_stream()
            .map_err(|e| format!("image {xref:?} as_stream: {e}"))?;
        (stream.content.clone(), is_grayscale(&stream.dict))
    };

    let decoded = image::load_from_memory_with_format(&raw_bytes, image::ImageFormat::Jpeg)
        .map_err(|e| format!("jpeg decode {xref:?}: {e}"))?;

    let resized = decoded.resize_exact(
        target_w.max(1),
        target_h.max(1),
        image::imageops::FilterType::Lanczos3,
    );

    let mut out_buf: Vec<u8> = Vec::new();
    let (w, h) = (resized.width(), resized.height());
    {
        let encoder = JpegEncoder::new_with_quality(&mut out_buf, quality);
        if grayscale {
            let luma = resized.to_luma8();
            encoder
                .write_image(luma.as_raw(), w, h, ColorType::L8.into())
                .map_err(|e| format!("jpeg encode {xref:?}: {e}"))?;
        } else {
            let rgb = resized.to_rgb8();
            encoder
                .write_image(rgb.as_raw(), w, h, ColorType::Rgb8.into())
                .map_err(|e| format!("jpeg encode {xref:?}: {e}"))?;
        }
    }

    let obj = doc
        .get_object_mut(xref)
        .map_err(|e| format!("get_mut image {xref:?}: {e}"))?;
    let stream = obj
        .as_stream_mut()
        .map_err(|e| format!("image {xref:?} as_stream_mut: {e}"))?;
    stream.dict.set("Width", Object::Integer(w as i64));
    stream.dict.set("Height", Object::Integer(h as i64));
    stream.dict.set("BitsPerComponent", Object::Integer(8));
    stream.dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
    stream.dict.remove(b"DecodeParms");
    stream.dict.remove(b"Decode");
    if grayscale {
        stream
            .dict
            .set("ColorSpace", Object::Name(b"DeviceGray".to_vec()));
    } else {
        stream
            .dict
            .set("ColorSpace", Object::Name(b"DeviceRGB".to_vec()));
    }
    stream.set_plain_content(out_buf);

    Ok(())
}

/// 全ページの埋め込み画像を、実表示サイズから逆算した目標 DPI・JPEG 品質で
/// ダウンサンプル再圧縮する。対象は Filter=/DCTDecode の画像のみ。
pub fn recompress_images(
    input: &str,
    output: &str,
    target_dpi: f32,
    jpeg_quality: u8,
) -> Result<ImageRecompressStats, String> {
    let mut stats = ImageRecompressStats::default();
    if target_dpi <= 0.0 {
        if input != output {
            std::fs::copy(input, output).map_err(|e| format!("copy: {e}"))?;
        }
        return Ok(stats);
    }

    let doc = Document::load(input).map_err(|e| format!("lopdf load: {e}"))?;

    // 1. 表示サイズ集計
    let mut needed: HashMap<ObjectId, (f32, f32)> = HashMap::new();
    for page_id in doc.page_iter() {
        let Some(resources) = resolve_resources(&doc, page_id) else {
            continue;
        };
        let Ok(page_dict) = doc.get_object(page_id).and_then(|o| o.as_dict().cloned()) else {
            continue;
        };
        let Ok(contents) = page_dict.get(b"Contents") else {
            continue;
        };
        let content_bytes = get_content_bytes(&doc, contents);
        if content_bytes.is_empty() {
            continue;
        }
        let mut visiting = HashSet::new();
        walk_content(
            &doc,
            &content_bytes,
            &resources,
            Matrix::IDENTITY,
            0,
            &mut visiting,
            &mut needed,
        );
    }

    if needed.is_empty() {
        if input != output {
            std::fs::copy(input, output).map_err(|e| format!("copy: {e}"))?;
        }
        return Ok(stats);
    }

    // 2. 判定 + ダウンサンプル対象を確定
    // (xref, target_w, target_h)
    let mut targets: Vec<(ObjectId, u32, u32)> = Vec::new();
    for (xref, (disp_w_pt, disp_h_pt)) in &needed {
        stats.images_scanned += 1;
        let Ok(obj) = doc.get_object(*xref) else {
            continue;
        };
        let Ok(dict) = obj.as_stream().map(|s| &s.dict) else {
            continue;
        };
        if !is_plain_dct(dict) {
            stats.images_skipped_filter += 1;
            continue;
        }
        let Some((native_w, native_h)) = image_native_size(dict) else {
            continue;
        };
        if *disp_w_pt <= 0.0 || *disp_h_pt <= 0.0 {
            continue;
        }
        let needed_w = ((disp_w_pt / 72.0) * target_dpi).ceil().max(1.0) as i64;
        let needed_h = ((disp_h_pt / 72.0) * target_dpi).ceil().max(1.0) as i64;

        // ネイティブ解像度が必要解像度を 15% 以上上回る場合のみ縮小対象とする
        // (僅かな差ではリスクに見合わないため据え置く)
        if native_w > (needed_w * 115 / 100) && native_h > (needed_h * 115 / 100) {
            let tw = needed_w.clamp(8, native_w) as u32;
            let th = needed_h.clamp(8, native_h) as u32;
            targets.push((*xref, tw, th));
        }
    }

    if targets.is_empty() {
        if input != output {
            std::fs::copy(input, output).map_err(|e| format!("copy: {e}"))?;
        }
        return Ok(stats);
    }

    // 3. 実際の再圧縮 (可変借用のため doc を作り直す)
    let mut doc = doc;
    for (xref, tw, th) in &targets {
        match recompress_one(&mut doc, *xref, *tw, *th, jpeg_quality) {
            Ok(()) => stats.images_recompressed += 1,
            Err(e) => {
                eprintln!("[image_recompress] xref={xref:?}: {e} (skipped, kept original)");
            }
        }

        // 付随する /SMask も同じ寸法に合わせて縮小する（対象になる場合のみ）
        if let Ok(obj) = doc.get_object(*xref) {
            if let Ok(dict) = obj.as_stream().map(|s| s.dict.clone()) {
                if let Ok(Object::Reference(smask_ref)) = dict.get(b"SMask") {
                    let smask_ref = *smask_ref;
                    if let Ok(smask_obj) = doc.get_object(smask_ref) {
                        if let Ok(smask_dict) = smask_obj.as_stream().map(|s| s.dict.clone()) {
                            if is_plain_dct(&smask_dict) {
                                if let Err(e) =
                                    recompress_one(&mut doc, smask_ref, *tw, *th, jpeg_quality)
                                {
                                    eprintln!(
                                        "[image_recompress] smask xref={smask_ref:?}: {e} (skipped)"
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    doc.save(output).map_err(|e| format!("lopdf save: {e}"))?;
    Ok(stats)
}
