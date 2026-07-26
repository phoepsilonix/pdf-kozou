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
//   - 対象は次の2種類の画像のみ:
//       (a) Filter が単一の /DCTDecode (JPEG)
//       (b) Filter が単一の /FlateDecode (または無フィルタ) の生ビットマップで、
//           BitsPerComponent=8、ColorSpace が DeviceGray/DeviceRGB/DeviceCMYK
//           (または ICCBased の N=1/3/4 相当) のもの。
//           このケースは「表示サイズを超えているか」に関わらず、常に JPEG へ
//           変換する（Flate生ビットマップは元々ほぼ無圧縮に近く、JPEG化する
//           だけで大幅に縮小できるため）。
//     Indexed / 1bit・16bit / CCITTFaxDecode / JBIG2Decode / JPXDecode や
//     複合フィルタ (配列) はデコード経路が複雑なため安全側でスキップする
//     （元のまま保持）。
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

/// Object::as_dict() は Object::Dictionary にしかマッチせず、
/// Image/Form XObject のように実体が Object::Stream (かつ辞書を
/// stream.dict に持つ) ケースは Err になってしまう。
/// 画像・Form XObject はどちらも常に Stream なので、Do 呼び出し先の
/// XObject を扱う箇所では必ずこちらを使う。
fn as_dict_any(obj: &Object) -> Option<&Dictionary> {
    match obj {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&s.dict),
        _ => None,
    }
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
                let Some(xobj_dict_inner) = as_dict_any(xobj) else {
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

/// 対応している画像ソースの種類。
#[derive(Clone, Copy, Debug, PartialEq)]
enum SourceKind {
    /// Filter=/DCTDecode (JPEG)。表示サイズを超える場合のみ対象にする。
    Dct,
    /// Filter=/FlateDecode (または無フィルタ) の生ビットマップ。
    /// 常に JPEG へ変換する（元々ほぼ無圧縮なので DPI 未設定でも縮小効果が大きい）。
    RawGray8,
    RawRgb8,
    RawCmyk8,
}

impl SourceKind {
    fn is_raw(self) -> bool {
        !matches!(self, SourceKind::Dct)
    }
}

/// ColorSpace オブジェクトから (成分数, グレースケールか) を判定する。
/// 対応: DeviceGray/CalGray(1), DeviceRGB/CalRGB(3), DeviceCMYK(4),
///       ICCBased ([/ICCBased ref] で参照先ストリームの /N を見る)。
/// Indexed 等、上記以外は None (未対応)。
fn colorspace_components(doc: &Document, cs: &Object) -> Option<u8> {
    let (_, resolved) = doc.dereference(cs).ok()?;
    match resolved {
        Object::Name(n) => match n.as_slice() {
            b"DeviceGray" | b"CalGray" => Some(1),
            b"DeviceRGB" | b"CalRGB" => Some(3),
            b"DeviceCMYK" => Some(4),
            _ => None,
        },
        Object::Array(arr) => {
            let head = arr.first()?.as_name().ok()?;
            match head {
                b"ICCBased" => {
                    let stream_obj = arr.get(1)?;
                    let (_, resolved_stream) = doc.dereference(stream_obj).ok()?;
                    let stream = resolved_stream.as_stream().ok()?;
                    stream.dict.get(b"N").ok()?.as_i64().ok().map(|n| n as u8)
                }
                b"CalGray" => Some(1),
                b"CalRGB" => Some(3),
                _ => None, // Indexed / DeviceN / Separation / Lab 等は未対応
            }
        }
        _ => None,
    }
}

/// 画像辞書から SourceKind を判定する。未対応の場合は None。
fn classify_source(doc: &Document, dict: &Dictionary) -> Option<SourceKind> {
    let filter_name: Option<&[u8]> = match dict.get(b"Filter") {
        Ok(Object::Name(n)) => Some(n.as_slice()),
        Err(_) => None, // Filter 無し = 無圧縮の生データ
        _ => return None, // 配列 (複合フィルタ) は非対応
    };
    match filter_name {
        Some(b"DCTDecode") => return Some(SourceKind::Dct),
        Some(b"FlateDecode") | None => {} // 下で成分数を見て判定
        _ => return None, // CCITTFaxDecode / JBIG2Decode / JPXDecode 等は非対応
    }

    let bpc = dict.get(b"BitsPerComponent").ok()?.as_i64().ok()?;
    if bpc != 8 {
        return None; // 1bit線画 / 16bit 等は非対応
    }
    let cs = dict.get(b"ColorSpace").ok()?;
    match colorspace_components(doc, cs)? {
        1 => Some(SourceKind::RawGray8),
        3 => Some(SourceKind::RawRgb8),
        4 => Some(SourceKind::RawCmyk8),
        _ => None,
    }
}

fn image_native_size(dict: &Dictionary) -> Option<(i64, i64)> {
    let w = dict.get(b"Width").ok()?.as_i64().ok()?;
    let h = dict.get(b"Height").ok()?.as_i64().ok()?;
    Some((w, h))
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
    use image::{ColorType, DynamicImage, GrayImage, ImageEncoder, RgbImage};

    let (kind, raw_bytes, native_w, native_h, decode_inverted) = {
        let obj = doc
            .get_object(xref)
            .map_err(|e| format!("get image {xref:?}: {e}"))?;
        let stream = obj
            .as_stream()
            .map_err(|e| format!("image {xref:?} as_stream: {e}"))?;
        let dict = &stream.dict;
        let kind =
            classify_source(doc, dict).ok_or_else(|| format!("image {xref:?}: unsupported filter/colorspace"))?;
        let (native_w, native_h) = image_native_size(dict)
            .ok_or_else(|| format!("image {xref:?}: missing Width/Height"))?;
        // CMYK で /Decode が [1 0 1 0 1 0 1 0] のように反転指定されている場合を検出
        let decode_inverted = matches!(
            dict.get(b"Decode").ok().and_then(|o| o.as_array().ok()),
            Some(arr) if arr.len() >= 2 && obj_to_f32(&arr[0]) > obj_to_f32(&arr[1])
        );
        let raw_bytes = match kind {
            SourceKind::Dct => stream.content.clone(),
            _ => stream
                .decompressed_content()
                .map_err(|e| format!("image {xref:?} decompress: {e}"))?,
        };
        (kind, raw_bytes, native_w, native_h, decode_inverted)
    };

    let (decoded, grayscale) = match kind {
        SourceKind::Dct => {
            let img = image::load_from_memory_with_format(&raw_bytes, image::ImageFormat::Jpeg)
                .map_err(|e| format!("jpeg decode {xref:?}: {e}"))?;
            let gray = matches!(img.color(), image::ColorType::L8 | image::ColorType::L16);
            (img, gray)
        }
        SourceKind::RawGray8 => {
            let expected = (native_w * native_h) as usize;
            if raw_bytes.len() < expected {
                return Err(format!(
                    "image {xref:?}: raw gray buffer too short ({} < {expected})",
                    raw_bytes.len()
                ));
            }
            let buf = GrayImage::from_raw(native_w as u32, native_h as u32, raw_bytes[..expected].to_vec())
                .ok_or_else(|| format!("image {xref:?}: GrayImage::from_raw failed"))?;
            (DynamicImage::ImageLuma8(buf), true)
        }
        SourceKind::RawRgb8 => {
            let expected = (native_w * native_h * 3) as usize;
            if raw_bytes.len() < expected {
                return Err(format!(
                    "image {xref:?}: raw rgb buffer too short ({} < {expected})",
                    raw_bytes.len()
                ));
            }
            let buf = RgbImage::from_raw(native_w as u32, native_h as u32, raw_bytes[..expected].to_vec())
                .ok_or_else(|| format!("image {xref:?}: RgbImage::from_raw failed"))?;
            (DynamicImage::ImageRgb8(buf), false)
        }
        SourceKind::RawCmyk8 => {
            let expected = (native_w * native_h * 4) as usize;
            if raw_bytes.len() < expected {
                return Err(format!(
                    "image {xref:?}: raw cmyk buffer too short ({} < {expected})",
                    raw_bytes.len()
                ));
            }
            let mut rgb = Vec::with_capacity((native_w * native_h * 3) as usize);
            for px in raw_bytes[..expected].chunks_exact(4) {
                let (c, m, y, k) = if decode_inverted {
                    (255 - px[0], 255 - px[1], 255 - px[2], 255 - px[3])
                } else {
                    (px[0], px[1], px[2], px[3])
                };
                let kf = k as f32 / 255.0;
                let r = 255.0 * (1.0 - c as f32 / 255.0) * (1.0 - kf);
                let g = 255.0 * (1.0 - m as f32 / 255.0) * (1.0 - kf);
                let b = 255.0 * (1.0 - y as f32 / 255.0) * (1.0 - kf);
                rgb.push(r.round().clamp(0.0, 255.0) as u8);
                rgb.push(g.round().clamp(0.0, 255.0) as u8);
                rgb.push(b.round().clamp(0.0, 255.0) as u8);
            }
            let buf = RgbImage::from_raw(native_w as u32, native_h as u32, rgb)
                .ok_or_else(|| format!("image {xref:?}: RgbImage::from_raw (cmyk) failed"))?;
            (DynamicImage::ImageRgb8(buf), false)
        }
    };

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
    // set_plain_content() は Filter/DecodeParms を消し Length を再設定する
    // ため、必ず先に呼ぶ。後から Filter=DCTDecode 等を設定しないと、
    // JPEGバイト列なのに Filter 無し(=無圧縮の生データ)として解釈され、
    // ビューアで壊れた画像 (黒塗り/truncated 警告) になってしまう。
    stream.set_plain_content(out_buf);
    stream.dict.set("Width", Object::Integer(w as i64));
    stream.dict.set("Height", Object::Integer(h as i64));
    stream.dict.set("BitsPerComponent", Object::Integer(8));
    stream.dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
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

    Ok(())
}

/// 全ページの埋め込み画像を、実表示サイズから逆算した目標 DPI・JPEG 品質で
/// ダウンサンプル再圧縮する。対象は DCTDecode(JPEG) と、8bpc の
/// Gray/RGB/CMYK 生ビットマップ (FlateDecode/無フィルタ) のみ。
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
        let Some(kind) = classify_source(&doc, dict) else {
            stats.images_skipped_filter += 1;
            continue;
        };
        let Some((native_w, native_h)) = image_native_size(dict) else {
            continue;
        };
        if *disp_w_pt <= 0.0 || *disp_h_pt <= 0.0 {
            continue;
        }
        let needed_w = ((disp_w_pt / 72.0) * target_dpi).ceil().max(1.0) as i64;
        let needed_h = ((disp_h_pt / 72.0) * target_dpi).ceil().max(1.0) as i64;
        let tw = needed_w.clamp(8, native_w) as u32;
        let th = needed_h.clamp(8, native_h) as u32;

        if kind.is_raw() {
            // Flate等の生ビットマップは元々ほぼ無圧縮なので、ダウンサンプルが
            // 不要でも常に JPEG へ変換する（それだけで大幅に縮小できるため）。
            targets.push((*xref, tw, th));
        } else {
            // DCTDecode (既に JPEG) は、ネイティブ解像度が必要解像度を
            // 15% 以上上回る場合のみ縮小対象とする
            // (僅かな差ではリスクに見合わないため据え置く)
            if native_w > (needed_w * 115 / 100) && native_h > (needed_h * 115 / 100) {
                targets.push((*xref, tw, th));
            }
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
                            if classify_source(&doc, &smask_dict).is_some() {
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
