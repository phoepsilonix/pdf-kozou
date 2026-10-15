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
//   - 対象は次の3種類の画像のみ:
//       (a) Filter が単一の /DCTDecode (JPEG)
//       (b) Filter が単一の /FlateDecode (または無フィルタ) の生ビットマップで、
//           BitsPerComponent=8、ColorSpace が DeviceGray/DeviceRGB/DeviceCMYK
//           (または ICCBased の N=1/3/4 相当) のもの。
//           このケースは「表示サイズを超えているか」に関わらず、常に JPEG へ
//           変換する（Flate生ビットマップは元々ほぼ無圧縮に近く、JPEG化する
//           だけで大幅に縮小できるため）。
//       (c) Filter が [/FlateDecode /DCTDecode] の2要素配列 (JPEG バイト列を
//           さらに Flate で包んだもの。Canva 等一部の生成ツールが出力する)。
//           Flate を展開した結果を JPEG として (a) と同じ経路で扱う。
//     Indexed / 1bit・16bit / CCITTFaxDecode / JBIG2Decode / JPXDecode や、
//     上記以外の複合フィルタはデコード経路が複雑なため安全側でスキップする
//     （元のまま保持）。
//   - インライン画像 (BI...EI) は対象外。
//   - /SMask (アルファ) は本体とは独立に扱う。マスクは JPEG にせず、
//     必要なら表示サイズから決めた寸法へロスレス (Flate) のまま縮小する。
//     他の画像のマスクとして使われている画像は、本体側の JPEG 変換の
//     対象から外す。

use lopdf::content::Content;
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Default)]
pub struct ImageRecompressStats {
    pub images_scanned: usize,
    pub images_recompressed: usize,
    pub images_skipped_filter: usize,
    pub images_cropped: usize,
    pub images_stubbed: usize,
}

#[derive(Clone, Copy, Debug)]
struct Matrix {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
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
    fn displayed_size(&self) -> (f64, f64) {
        let wx = self.a;
        let wy = self.b;
        let hx = self.c;
        let hy = self.d;
        let w = (wx * wx + wy * wy).sqrt();
        let h = (hx * hx + hy * hy).sqrt();
        (w, h)
    }
}

fn obj_to_f64(o: &Object) -> f64 {
    match o {
        Object::Integer(i) => *i as f64,
        Object::Real(r) => *r as f64,
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
            if let Ok(data) = stream_bytes(s) {
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
    needed: &mut HashMap<ObjectId, (f64, f64)>,
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
                    a: obj_to_f64(&op.operands[0]),
                    b: obj_to_f64(&op.operands[1]),
                    c: obj_to_f64(&op.operands[2]),
                    d: obj_to_f64(&op.operands[3]),
                    e: obj_to_f64(&op.operands[4]),
                    f: obj_to_f64(&op.operands[5]),
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
                                a: obj_to_f64(&a[0]),
                                b: obj_to_f64(&a[1]),
                                c: obj_to_f64(&a[2]),
                                d: obj_to_f64(&a[3]),
                                e: obj_to_f64(&a[4]),
                                f: obj_to_f64(&a[5]),
                            })
                            .unwrap_or(Matrix::IDENTITY);
                        let form_ctm = form_matrix.concat(&cur);
                        let form_resources = xobj_dict_inner
                            .get(b"Resources")
                            .ok()
                            .and_then(|o| resolve_dict(doc, o))
                            .unwrap_or_else(|| resources.clone());
                        let form_bytes = if let Object::Stream(s) = xobj {
                            stream_bytes(s).unwrap_or_default()
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
pub(crate) enum SourceKind {
    /// Filter=/DCTDecode (JPEG)。表示サイズを超える場合のみ対象にする。
    Dct,
    /// Filter=[/FlateDecode /DCTDecode]。Flate を展開すれば JPEG バイト列に
    /// なる複合フィルタ。扱いは Dct と同じ (表示サイズを超える場合のみ対象)。
    DctFlateWrapped,
    /// Filter=/FlateDecode (または無フィルタ) の生ビットマップ。
    /// 常に JPEG へ変換する（元々ほぼ無圧縮なので DPI 未設定でも縮小効果が大きい）。
    RawGray8,
    RawRgb8,
    RawCmyk8,
}

impl SourceKind {
    fn is_raw(self) -> bool {
        !matches!(self, SourceKind::Dct | SourceKind::DctFlateWrapped)
    }
}

/// ColorSpace オブジェクトから (成分数, グレースケールか) を判定する。
/// 対応: DeviceGray/CalGray(1), DeviceRGB/CalRGB(3), DeviceCMYK(4),
///       ICCBased ([/ICCBased ref] で参照先ストリームの /N を見る)。
/// Indexed 等、上記以外は None (未対応)。
pub(crate) fn colorspace_components(doc: &Document, cs: &Object) -> Option<u8> {
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
/// `lopdf::Stream::decompressed_content()` は Filter キーが一つも無い
/// ストリーム(PDF仕様上は「フィルタ無しの生データ」として正当)に対して
/// `filters()` の実装上 `Err` を返してしまう(`self.dict.get(b"Filter")?`
/// が素通しで失敗するため)。本来は生バイト列をそのまま返すのが正しい
/// 挙動なので、その分だけこちらで肩代わりする。
/// (`set_plain_content()` は Filter キーを削除するため、切り出し・
/// クロップ後の書き戻しストリームでは特に必須。)
pub(crate) fn stream_bytes(stream: &lopdf::Stream) -> Result<Vec<u8>, lopdf::Error> {
    if stream.dict.get(b"Filter").is_err() {
        Ok(stream.content.clone())
    } else {
        stream.decompressed_content()
    }
}

/// /Decode が無い、または各成分が恒等 ([0 1 0 1 ...]) かどうか。
/// 再エンコード時に /Decode を落とすため、反転指定があると色が変わる。
pub(crate) fn decode_is_default(dict: &Dictionary) -> bool {
    match dict.get(b"Decode") {
        Err(_) => true,
        Ok(o) => match o.as_array() {
            Ok(arr) => {
                arr.len() % 2 == 0
                    && arr
                        .chunks(2)
                        .all(|p| obj_to_f64(&p[0]) == 0.0 && obj_to_f64(&p[1]) == 1.0)
            }
            Err(_) => false,
        },
    }
}

/// DCT (JPEG) 画像を image クレートで RGB/Gray として再エンコードしても
/// 色が変わらないか。ColorSpace が Gray/RGB 相当 (成分数 1 か 3) で、
/// /Decode が恒等の場合のみ true。CMYK/YCCK JPEG は RGB 化すると色が
/// 変わる (ColorSpace を書き換えない実装のため) ので対象外にする。
fn dct_is_safely_reencodable(doc: &Document, dict: &Dictionary) -> bool {
    let comps = dict
        .get(b"ColorSpace")
        .ok()
        .and_then(|cs| colorspace_components(doc, cs));
    matches!(comps, Some(1) | Some(3)) && decode_is_default(dict)
}

pub(crate) fn classify_source(doc: &Document, dict: &Dictionary) -> Option<SourceKind> {
    let filter_name: Option<&[u8]> = match dict.get(b"Filter") {
        Ok(Object::Name(n)) => Some(n.as_slice()),
        Err(_) => None, // Filter 無し = 無圧縮の生データ
        Ok(Object::Array(arr)) => {
            // [/FlateDecode /DCTDecode] のみ対応 (Flate展開後がJPEGバイト列になる形)。
            // それ以外の配列 (ASCII85+LZW 等) は非対応。
            let names: Option<Vec<&[u8]>> = arr.iter().map(|o| o.as_name().ok()).collect();
            return match names.as_deref() {
                Some([b"FlateDecode", b"DCTDecode"]) => {
                    dct_is_safely_reencodable(doc, dict).then_some(SourceKind::DctFlateWrapped)
                }
                _ => None,
            };
        }
        _ => return None,
    };
    match filter_name {
        Some(b"DCTDecode") => {
            return dct_is_safely_reencodable(doc, dict).then_some(SourceKind::Dct);
        }
        Some(b"FlateDecode") | None => {} // 下で成分数を見て判定
        _ => return None,                 // CCITTFaxDecode / JBIG2Decode / JPXDecode 等は非対応
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

pub(crate) fn image_native_size(dict: &Dictionary) -> Option<(i64, i64)> {
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
        let kind = classify_source(doc, dict)
            .ok_or_else(|| format!("image {xref:?}: unsupported filter/colorspace"))?;
        let (native_w, native_h) = image_native_size(dict)
            .ok_or_else(|| format!("image {xref:?}: missing Width/Height"))?;
        // CMYK で /Decode が [1 0 1 0 1 0 1 0] のように反転指定されている場合を検出
        let decode_inverted = matches!(
            dict.get(b"Decode").ok().and_then(|o| o.as_array().ok()),
            Some(arr) if arr.len() >= 2 && obj_to_f64(&arr[0]) > obj_to_f64(&arr[1])
        );
        let raw_bytes = match kind {
            SourceKind::Dct => stream.content.clone(),
            SourceKind::DctFlateWrapped => {
                use std::io::Read;
                let mut inflated = Vec::new();
                flate2::read::ZlibDecoder::new(stream.content.as_slice())
                    .read_to_end(&mut inflated)
                    .map_err(|e| format!("image {xref:?} inflate (Flate+DCT): {e}"))?;
                inflated
            }
            _ => stream_bytes(stream).map_err(|e| format!("image {xref:?} decompress: {e}"))?,
        };
        (kind, raw_bytes, native_w, native_h, decode_inverted)
    };

    let (decoded, grayscale) = match kind {
        SourceKind::Dct | SourceKind::DctFlateWrapped => {
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
            let buf = GrayImage::from_raw(
                native_w as u32,
                native_h as u32,
                raw_bytes[..expected].to_vec(),
            )
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
            let buf = RgbImage::from_raw(
                native_w as u32,
                native_h as u32,
                raw_bytes[..expected].to_vec(),
            )
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
                let kf = k as f64 / 255.0;
                let r = 255.0 * (1.0 - c as f64 / 255.0) * (1.0 - kf);
                let g = 255.0 * (1.0 - m as f64 / 255.0) * (1.0 - kf);
                let b = 255.0 * (1.0 - y as f64 / 255.0) * (1.0 - kf);
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
    stream
        .dict
        .set("Filter", Object::Name(b"DCTDecode".to_vec()));
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

/// ストリーム本体を Flate 圧縮して書き戻す。lopdf::Stream::compress() は
/// 「圧縮した方が小さい場合のみ」圧縮して Filter を設定する挙動のため、
/// 逆に伸びる場合は Filter キーが最後まで付かないままになり、後続の
/// stream_bytes()/decompressed_content() 呼び出し経路によっては扱いが
/// 分かれてしまう。ここでは常に Filter=FlateDecode を設定して統一する。
pub(crate) fn set_flate_content(stream: &mut lopdf::Stream, bytes: Vec<u8>) {
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write;
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
    let compressed = match encoder.write_all(&bytes).and_then(|_| encoder.finish()) {
        Ok(c) => c,
        Err(_) => {
            // 圧縮に失敗したら無圧縮のまま (stream_bytes() が Filter 無しを
            // 正しく生データとして扱うので安全)。
            stream.set_plain_content(bytes);
            return;
        }
    };
    stream.set_plain_content(compressed);
    stream
        .dict
        .set("Filter", Object::Name(b"FlateDecode".to_vec()));
}

/// 文書内で他の画像のマスク (/SMask, /Mask のストリーム) として使われている
/// 画像オブジェクトの集合。マスクは透過の輪郭そのものなので、JPEG のような
/// 非可逆圧縮にかけてはならない (輪郭に滲み・リンギングが出る)。
pub(crate) fn collect_mask_ids(doc: &Document) -> HashSet<ObjectId> {
    let mut out = HashSet::new();
    for obj in doc.objects.values() {
        let Object::Stream(s) = obj else { continue };
        if !matches!(
            s.dict.get(b"Subtype").ok().and_then(|o| o.as_name().ok()),
            Some(b"Image")
        ) {
            continue;
        }
        for key in [&b"SMask"[..], b"Mask"] {
            if let Ok(Object::Reference(id)) = s.dict.get(key) {
                out.insert(*id);
            }
        }
    }
    out
}

/// 8bit グレースケールのマスクを、ロスレス (Flate) のまま書き直す。
/// `target` を渡すとその寸法へ縮小する (拡大はしない)。透過の輪郭を
/// なまらせないよう、縮小は平均化系のフィルタで行い、JPEG には変換しない。
fn rewrite_mask_lossless(
    doc: &mut Document,
    id: ObjectId,
    target: Option<(u32, u32)>,
) -> Result<(), String> {
    use image::GrayImage;
    let (gray, w, h) = {
        let obj = doc
            .get_object(id)
            .map_err(|e| format!("get mask {id:?}: {e}"))?;
        let s = obj
            .as_stream()
            .map_err(|e| format!("mask {id:?} as_stream: {e}"))?;
        if s.dict.has(b"Matte") {
            return Err(format!("mask {id:?}: has /Matte, left as is"));
        }
        let kind = classify_source(doc, &s.dict)
            .ok_or_else(|| format!("mask {id:?}: unsupported filter/colorspace"))?;
        let (w, h) =
            image_native_size(&s.dict).ok_or_else(|| format!("mask {id:?}: missing size"))?;
        let (w, h) = (w as u32, h as u32);
        let bytes = match kind {
            SourceKind::RawGray8 => {
                let b = stream_bytes(s).map_err(|e| format!("mask {id:?} decompress: {e}"))?;
                let expected = w as usize * h as usize;
                if b.len() < expected {
                    return Err(format!("mask {id:?}: buffer too short"));
                }
                b[..expected].to_vec()
            }
            SourceKind::Dct | SourceKind::DctFlateWrapped => {
                let raw = if matches!(kind, SourceKind::Dct) {
                    s.content.clone()
                } else {
                    use std::io::Read;
                    let mut v = Vec::new();
                    flate2::read::ZlibDecoder::new(s.content.as_slice())
                        .read_to_end(&mut v)
                        .map_err(|e| format!("mask {id:?} inflate: {e}"))?;
                    v
                };
                let l = image::load_from_memory_with_format(&raw, image::ImageFormat::Jpeg)
                    .map_err(|e| format!("mask {id:?} jpeg decode: {e}"))?
                    .to_luma8();
                if l.width() != w || l.height() != h {
                    return Err(format!("mask {id:?}: JPEG size differs from dictionary"));
                }
                l.into_raw()
            }
            _ => return Err(format!("mask {id:?}: not 8bit gray")),
        };
        let g =
            GrayImage::from_raw(w, h, bytes).ok_or_else(|| format!("mask {id:?}: bad buffer"))?;
        (g, w, h)
    };
    let (out, ow, oh) = match target {
        Some((tw, th)) if tw < w || th < h => {
            let (tw, th) = (tw.clamp(1, w), th.clamp(1, h));
            let r = image::imageops::resize(&gray, tw, th, image::imageops::FilterType::Triangle);
            (r.into_raw(), tw, th)
        }
        _ => (gray.into_raw(), w, h),
    };
    let obj = doc
        .get_object_mut(id)
        .map_err(|e| format!("get_mut mask {id:?}: {e}"))?;
    let s = obj
        .as_stream_mut()
        .map_err(|e| format!("mask {id:?} as_stream_mut: {e}"))?;
    s.dict.set("Width", Object::Integer(ow as i64));
    s.dict.set("Height", Object::Integer(oh as i64));
    s.dict.set("BitsPerComponent", Object::Integer(8));
    s.dict
        .set("ColorSpace", Object::Name(b"DeviceGray".to_vec()));
    set_flate_content(s, out);
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
    crop_to_visible: bool,
) -> Result<ImageRecompressStats, String> {
    // 公開 API は f32 のまま。内部の幾何計算は f64 で行う (単位換算での誤差を抑える)。
    let target_dpi = target_dpi as f64;
    let mut stats = ImageRecompressStats::default();
    if target_dpi <= 0.0 && !crop_to_visible {
        if input != output {
            std::fs::copy(input, output).map_err(|e| format!("copy: {e}"))?;
        }
        return Ok(stats);
    }

    let mut doc = Document::load(input).map_err(|e| format!("lopdf load: {e}"))?;

    // 0. (オプション) 実際に見えている範囲だけへの画像クロップ。
    //    表示サイズ(pt) 集計より前に行うことで、この後の DPI 判定が
    //    正しく縮小された表示サイズを基準にできるようにする。
    if crop_to_visible {
        let crop_stats = crate::visible_crop::crop_to_visible_area(&mut doc, jpeg_quality);
        stats.images_cropped = crop_stats.images_cropped;
        stats.images_stubbed = crop_stats.images_stubbed;
    }

    if target_dpi <= 0.0 {
        doc.save(output).map_err(|e| format!("lopdf save: {e}"))?;
        return Ok(stats);
    }

    // 1. 表示サイズ集計
    let mut needed: HashMap<ObjectId, (f64, f64)> = HashMap::new();
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
        doc.save(output).map_err(|e| format!("lopdf save: {e}"))?;
        return Ok(stats);
    }

    // 2. 判定 + ダウンサンプル対象を確定
    let mask_ids = collect_mask_ids(&doc);
    // (xref, target_w, target_h)
    let mut targets: Vec<(ObjectId, u32, u32)> = Vec::new();
    for (xref, (disp_w_pt, disp_h_pt)) in &needed {
        stats.images_scanned += 1;
        if mask_ids.contains(xref) {
            continue; // マスクは下で別扱い (非可逆圧縮にしない)
        }
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
        // 下限 8px を狙うが、ネイティブ解像度がそれより小さい場合は
        // native_w/h 自体を下限にする (visible_crop の 1x1 プレースホルダ等、
        // native が 8px 未満のケースで clamp(8, native) が min>max になり
        // panic するのを防ぐ)。
        let floor_w = 8i64.min(native_w.max(1));
        let floor_h = 8i64.min(native_h.max(1));
        let tw = needed_w.clamp(floor_w, native_w.max(1)) as u32;
        let th = needed_h.clamp(floor_h, native_h.max(1)) as u32;

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

    // マスク (/SMask) は本体とは独立に扱う。マスクは単位正方形に対して
    // 解像度に依存せず貼られるので、本体と同じ寸法にそろえる必要はなく、
    // 必要画素数は「そのマスクを使う画像の表示サイズ」から決める
    // (複数の画像が共有していれば最大値)。縮小するときも、生のグレー
    // マスクを JPEG にせず、ロスレス (Flate) のまま書き直す。
    let mut mask_needed: HashMap<ObjectId, (i64, i64)> = HashMap::new();
    for (xref, (disp_w_pt, disp_h_pt)) in &needed {
        let Ok(obj) = doc.get_object(*xref) else {
            continue;
        };
        let Some(Object::Reference(mid)) =
            obj.as_stream().ok().and_then(|s| s.dict.get(b"SMask").ok())
        else {
            continue;
        };
        let nw = ((disp_w_pt / 72.0) * target_dpi).ceil().max(1.0) as i64;
        let nh = ((disp_h_pt / 72.0) * target_dpi).ceil().max(1.0) as i64;
        let e = mask_needed.entry(*mid).or_insert((nw, nh));
        e.0 = e.0.max(nw);
        e.1 = e.1.max(nh);
    }
    let mut mask_targets: Vec<(ObjectId, Option<(u32, u32)>)> = Vec::new();
    for (mid, (nw, nh)) in &mask_needed {
        let Ok(obj) = doc.get_object(*mid) else {
            continue;
        };
        let Ok(dict) = obj.as_stream().map(|s| &s.dict) else {
            continue;
        };
        let Some((mw, mh)) = image_native_size(dict) else {
            continue;
        };
        let shrink = mw > nw * 115 / 100 && mh > nh * 115 / 100;
        let uncompressed = dict.get(b"Filter").is_err();
        if !shrink && !uncompressed {
            continue;
        }
        let target = shrink.then(|| {
            (
                (*nw).clamp(8.min(mw.max(1)), mw.max(1)) as u32,
                (*nh).clamp(8.min(mh.max(1)), mh.max(1)) as u32,
            )
        });
        mask_targets.push((*mid, target));
    }

    if targets.is_empty() && mask_targets.is_empty() {
        doc.save(output).map_err(|e| format!("lopdf save: {e}"))?;
        return Ok(stats);
    }

    // 3. 実際の再圧縮
    for (xref, tw, th) in &targets {
        match recompress_one(&mut doc, *xref, *tw, *th, jpeg_quality) {
            Ok(()) => stats.images_recompressed += 1,
            Err(e) => {
                eprintln!("[image_recompress] xref={xref:?}: {e} (skipped, kept original)");
            }
        }
    }
    for (mid, target) in &mask_targets {
        if let Err(e) = rewrite_mask_lossless(&mut doc, *mid, *target) {
            eprintln!("[image_recompress] smask xref={mid:?}: {e} (skipped, kept original)");
        }
    }

    doc.save(output).map_err(|e| format!("lopdf save: {e}"))?;
    Ok(stats)
}

/// `redact_outside_crop` (MuPDF の pixel 方式 redaction) 等が生成した
/// 「生ピクセル画像 (Flate/無フィルタの未圧縮ビットマップ)」だけを対象に、
/// ダウンサンプルはせずネイティブ解像度のまま JPEG へ再圧縮する軽量パス。
///
/// `recompress_images()` と違い、ページ上の表示サイズ集計 (content stream
/// 解析) を行わない — 文書内の全 Image XObject を直接スキャンし、生
/// ビットマップだけを対象にする。DCTDecode (既に JPEG) の画像には触れない。
pub fn recompress_raw_images_native(
    input: &str,
    output: &str,
    jpeg_quality: u8,
) -> Result<ImageRecompressStats, String> {
    let mut stats = ImageRecompressStats::default();
    let mut doc = Document::load(input).map_err(|e| format!("lopdf load: {e}"))?;

    let mut targets: Vec<(ObjectId, u32, u32)> = Vec::new();
    let mask_ids = collect_mask_ids(&doc);
    let mut mask_rewrites: Vec<ObjectId> = Vec::new();
    let object_ids: Vec<ObjectId> = doc.objects.keys().copied().collect();
    for xref in object_ids {
        let Ok(obj) = doc.get_object(xref) else {
            continue;
        };
        let Ok(stream) = obj.as_stream() else {
            continue;
        };
        let dict = &stream.dict;
        let is_image = matches!(
            dict.get(b"Subtype").ok().and_then(|o| o.as_name().ok()),
            Some(b"Image")
        );
        if !is_image {
            continue;
        }
        let Some(kind) = classify_source(&doc, dict) else {
            continue;
        };
        if !kind.is_raw() {
            continue; // 既に JPEG (DCTDecode) の画像はそのまま
        }
        let Some((native_w, native_h)) = image_native_size(dict) else {
            continue;
        };
        stats.images_scanned += 1;
        if mask_ids.contains(&xref) {
            // マスクは JPEG にしない。無圧縮のものだけロスレスに圧縮し直す。
            if dict.get(b"Filter").is_err() {
                mask_rewrites.push(xref);
            }
            continue;
        }
        targets.push((xref, native_w.max(1) as u32, native_h.max(1) as u32));
    }

    if targets.is_empty() && mask_rewrites.is_empty() {
        if input != output {
            std::fs::copy(input, output).map_err(|e| format!("copy: {e}"))?;
        }
        return Ok(stats);
    }

    for (xref, tw, th) in &targets {
        match recompress_one(&mut doc, *xref, *tw, *th, jpeg_quality) {
            Ok(()) => stats.images_recompressed += 1,
            Err(e) => {
                eprintln!(
                    "[image_recompress] raw-native xref={xref:?}: {e} (skipped, kept original)"
                );
            }
        }
    }
    for mid in &mask_rewrites {
        if let Err(e) = rewrite_mask_lossless(&mut doc, *mid, None) {
            eprintln!("[image_recompress] raw-native smask xref={mid:?}: {e} (skipped)");
        }
    }

    doc.save(output).map_err(|e| format!("lopdf save: {e}"))?;
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    /// 100x100pt に表示される 400x400 の生 RGB 画像と、それに付く 400x400 の
    /// 無圧縮グレーマスクを持つ 1 ページの文書を保存する。
    /// `second` を true にすると、同じマスクを共有する 200x200pt 表示の
    /// 画像をもう 1 枚置く。
    fn write_doc(path: &std::path::Path, second: bool) -> (ObjectId, ObjectId) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mask = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => 400, "Height" => 400,
                "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
            },
            (0..400 * 400).map(|i| ((i / 400) % 256) as u8).collect(),
        ));
        let mut mk = |doc: &mut Document| {
            doc.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image", "Width" => 400, "Height" => 400,
                    "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
                    "SMask" => Object::Reference(mask),
                },
                (0..400 * 400 * 3).map(|i| (i % 251) as u8).collect(),
            ))
        };
        let im0 = mk(&mut doc);
        let im1 = mk(&mut doc);
        let mut content = String::from("q 100 0 0 100 10 10 cm /Im0 Do Q\n");
        let mut xo = dictionary! { "Im0" => im0 };
        if second {
            content.push_str("q 200 0 0 200 10 300 cm /Im1 Do Q\n");
            xo.set("Im1", Object::Reference(im1));
        }
        let cid = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 600.into(), 800.into()],
            "Contents" => cid,
            "Resources" => dictionary! { "XObject" => xo },
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1,
            }),
        );
        let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", Object::Reference(cat));
        doc.save(path).unwrap();
        (im0, mask)
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("kozou_recompress_{}_{name}", std::process::id()))
    }

    fn dict_of(doc: &Document, id: ObjectId) -> Dictionary {
        doc.get_object(id)
            .unwrap()
            .as_stream()
            .unwrap()
            .dict
            .clone()
    }

    /// マスクは JPEG にならず、ロスレス (Flate) のまま表示サイズへ縮小される。
    #[test]
    fn smask_stays_lossless_and_is_sized_from_display() {
        let (i, o) = (tmp("a.pdf"), tmp("a_out.pdf"));
        let (_, mask) = write_doc(&i, false);
        recompress_images(i.to_str().unwrap(), o.to_str().unwrap(), 72.0, 80, false).unwrap();
        let doc = Document::load(&o).unwrap();
        let d = dict_of(&doc, mask);
        assert_eq!(d.get(b"Filter").unwrap().as_name().unwrap(), b"FlateDecode");
        assert_eq!(
            d.get(b"ColorSpace").unwrap().as_name().unwrap(),
            b"DeviceGray"
        );
        // 100pt を 72dpi で表示 → 100 画素
        assert_eq!(d.get(b"Width").unwrap().as_i64().unwrap(), 100);
        assert_eq!(d.get(b"Height").unwrap().as_i64().unwrap(), 100);
        let s = doc.get_object(mask).unwrap().as_stream().unwrap();
        assert_eq!(stream_bytes(s).unwrap().len(), 100 * 100);
        let _ = (std::fs::remove_file(i), std::fs::remove_file(o));
    }

    /// 同じマスクを共有する画像が複数あれば、表示サイズが最大の画像に合わせる。
    #[test]
    fn shared_smask_uses_largest_display_size() {
        let (i, o) = (tmp("b.pdf"), tmp("b_out.pdf"));
        let (_, mask) = write_doc(&i, true);
        recompress_images(i.to_str().unwrap(), o.to_str().unwrap(), 72.0, 80, false).unwrap();
        let doc = Document::load(&o).unwrap();
        let d = dict_of(&doc, mask);
        assert_eq!(d.get(b"Width").unwrap().as_i64().unwrap(), 200);
        assert_eq!(d.get(b"Height").unwrap().as_i64().unwrap(), 200);
        let _ = (std::fs::remove_file(i), std::fs::remove_file(o));
    }

    /// 生ビットマップだけを JPEG 化する軽量パスでも、マスクは JPEG にしない。
    #[test]
    fn raw_native_pass_does_not_jpeg_the_mask() {
        let (i, o) = (tmp("c.pdf"), tmp("c_out.pdf"));
        let (im0, mask) = write_doc(&i, false);
        recompress_raw_images_native(i.to_str().unwrap(), o.to_str().unwrap(), 80).unwrap();
        let doc = Document::load(&o).unwrap();
        let md = dict_of(&doc, mask);
        assert_eq!(
            md.get(b"Filter").unwrap().as_name().unwrap(),
            b"FlateDecode"
        );
        assert_eq!(md.get(b"Width").unwrap().as_i64().unwrap(), 400);
        let bd = dict_of(&doc, im0);
        assert_eq!(bd.get(b"Filter").unwrap().as_name().unwrap(), b"DCTDecode");
        let _ = (std::fs::remove_file(i), std::fs::remove_file(o));
    }

    /// CMYK JPEG や /Decode が反転した JPEG は、色が変わるため対象にしない。
    #[test]
    fn unsafe_dct_is_not_classified() {
        let doc = Document::with_version("1.5");
        let cmyk = dictionary! {
            "Filter" => "DCTDecode", "ColorSpace" => "DeviceCMYK", "BitsPerComponent" => 8,
        };
        assert!(classify_source(&doc, &cmyk).is_none());
        let inverted = dictionary! {
            "Filter" => "DCTDecode", "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
            "Decode" => vec![1.into(), 0.into(), 1.into(), 0.into(), 1.into(), 0.into()],
        };
        assert!(classify_source(&doc, &inverted).is_none());
        let ok = dictionary! {
            "Filter" => "DCTDecode", "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
        };
        assert!(matches!(classify_source(&doc, &ok), Some(SourceKind::Dct)));
    }
}
