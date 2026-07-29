// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// pdf-kozou-core/src/visible_crop.rs
//
// 埋め込み画像のうち「ページ上で実際に見えている範囲」だけを残して
// ピクセルデータを切り詰める。image_recompress.rs (DPI/JPEG品質による
// ダウンサンプル) とは独立した前処理として動作し、この処理の後に
// image_recompress の通常のパスを実行すると、正しく縮小された表示
// サイズ(pt)を基準に追加のダウンサンプルもかかるようになる。
//
// 手順:
//   1. コンテンツストリームを CTM に加えてクリップ矩形(軸平行のみ)も
//      追跡しながら walk し、各 Image XObject について:
//        - 配置矩形 (unit square を CTM で変換した AABB)
//        - 有効クリップ (q/Q ネストされた re...W/W* n と、再帰した Form の
//          /BBox の交差)
//      を求め、両者の交差 = 「実際に見えている範囲」を画像のローカル
//      UV [0,1]^2 に逆変換する。同一画像が複数箇所で使われる場合は、
//      見えている範囲の和集合を取る(どの使用箇所からも見える範囲は
//      決して失わないようにするため)。
//   2. 和集合の面積が十分小さい画像だけを対象に:
//        (a) 全く見えていない (面積 ~0) → 極小のプレースホルダ画像に
//            置換するだけ (どの配置からも見えないので Do 側は無編集でよい)
//        (b) 部分的に見えている → 見えている範囲だけピクセルを切り出し、
//            対応する全ての "Do" 呼び出し箇所の直前に、切り出し後でも
//            同じ見た目を再現するための補正 "cm" を1行だけ挿入する
//   3. 回転・スキューを含む配置 (CTM の b/c 成分が非ゼロ) は対象外
//      (安全側でスキップ、元のまま保持)。矩形以外の (複雑な形状の)
//      クリップパスは無視する = クリップを狭めないだけで、見えている
//      部分を誤って切り落とすことはない。

use crate::image_recompress::{SourceKind, classify_source, image_native_size};
use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Default)]
pub struct VisibleCropStats {
    pub images_scanned: usize,
    pub images_cropped: usize,
    pub images_stubbed: usize,
}

/// 見えている範囲がこの割合未満なら crop 対象にする (savings が小さすぎる
/// 場合はリスクに見合わないため据え置く)。
const CROP_AREA_THRESHOLD: f32 = 0.9;
/// この割合未満しか見えていなければ「実質不可視」としてプレースホルダに
/// 置換する。
const INVISIBLE_AREA_THRESHOLD: f32 = 0.02;
/// 切り出し矩形に足す安全マージン (px)。クリップ境界のアンチエイリアス等で
/// ぎりぎり見えている画素を誤って切り落とさないため。
const CROP_MARGIN_PX: i64 = 2;

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

    fn transform_point(&self, x: f32, y: f32) -> (f32, f32) {
        (
            self.a * x + self.c * y + self.e,
            self.b * x + self.d * y + self.f,
        )
    }

    fn unit_square_rect(&self) -> Rect {
        Rect::from_points(&[
            self.transform_point(0.0, 0.0),
            self.transform_point(1.0, 0.0),
            self.transform_point(0.0, 1.0),
            self.transform_point(1.0, 1.0),
        ])
    }

    fn rect_transform(&self, r: &Rect) -> Rect {
        Rect::from_points(&[
            self.transform_point(r.x0, r.y0),
            self.transform_point(r.x1, r.y0),
            self.transform_point(r.x0, r.y1),
            self.transform_point(r.x1, r.y1),
        ])
    }

    /// 回転・スキュー無し (軸平行の拡大縮小+平行移動のみ) かどうか。
    /// これが false の配置は crop 対象から除外する。
    fn is_axis_aligned(&self) -> bool {
        self.b.abs() < 1e-3 && self.c.abs() < 1e-3 && self.a.abs() > 1e-6 && self.d.abs() > 1e-6
    }
}

#[derive(Clone, Copy, Debug)]
struct Rect {
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
}

impl Rect {
    fn from_points(pts: &[(f32, f32)]) -> Rect {
        let mut x0 = f32::INFINITY;
        let mut y0 = f32::INFINITY;
        let mut x1 = f32::NEG_INFINITY;
        let mut y1 = f32::NEG_INFINITY;
        for &(x, y) in pts {
            if x < x0 {
                x0 = x;
            }
            if x > x1 {
                x1 = x;
            }
            if y < y0 {
                y0 = y;
            }
            if y > y1 {
                y1 = y;
            }
        }
        Rect { x0, y0, x1, y1 }
    }

    fn intersect(&self, o: &Rect) -> Option<Rect> {
        let x0 = self.x0.max(o.x0);
        let y0 = self.y0.max(o.y0);
        let x1 = self.x1.min(o.x1);
        let y1 = self.y1.min(o.y1);
        if x1 > x0 && y1 > y0 {
            Some(Rect { x0, y0, x1, y1 })
        } else {
            None
        }
    }

    fn union(&self, o: &Rect) -> Rect {
        Rect {
            x0: self.x0.min(o.x0),
            y0: self.y0.min(o.y0),
            x1: self.x1.max(o.x1),
            y1: self.y1.max(o.y1),
        }
    }

    fn area(&self) -> f32 {
        (self.x1 - self.x0).max(0.0) * (self.y1 - self.y0).max(0.0)
    }
}

fn obj_to_f32(o: &Object) -> f32 {
    match o {
        Object::Integer(i) => *i as f32,
        Object::Real(r) => *r,
        _ => 0.0,
    }
}

fn resolve_dict(doc: &Document, obj: &Object) -> Option<Dictionary> {
    let (_, resolved) = doc.dereference(obj).ok()?;
    resolved.as_dict().ok().cloned()
}

fn as_dict_any(obj: &Object) -> Option<&Dictionary> {
    match obj {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&s.dict),
        _ => None,
    }
}

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

#[derive(Debug, Default)]
struct CropAnalysis {
    /// 画像 xref ごとの「実際に見えている範囲」の和集合 (UV [0,1]^2)。
    /// エントリが無い = 見える箇所が一箇所も無かった (完全不可視)。
    uv_union: HashMap<ObjectId, Rect>,
    /// 回転/スキュー配置などで安全に解析できなかった xref (crop 対象外)。
    ineligible: HashSet<ObjectId>,
    /// 各画像 xref を実際に描画している全箇所: (それを含むストリームの
    /// ObjectId, そのストリーム自身の Content::operations 内でのインデックス)。
    do_sites: HashMap<ObjectId, HashSet<(ObjectId, usize)>>,
}

#[allow(clippy::too_many_arguments)]
fn walk(
    doc: &Document,
    stream_id: ObjectId,
    content_bytes: &[u8],
    resources: &Dictionary,
    ctm: Matrix,
    clip: Option<Rect>,
    depth: u32,
    visiting: &mut HashSet<ObjectId>,
    analysis: &mut CropAnalysis,
) {
    if depth > 12 {
        return;
    }
    let content = match Content::decode(content_bytes) {
        Ok(c) => c,
        Err(_) => return,
    };

    let mut mstack: Vec<Matrix> = Vec::new();
    let mut cstack: Vec<Option<Rect>> = Vec::new();
    let mut cur = ctm;
    let mut cur_clip = clip;

    // 現在構築中のパスが「単一の矩形 (re が一回だけ)」かどうかの追跡。
    // 矩形以外のパス構成命令が混じったら諦める (安全側 = クリップを
    // 狭めないだけで、見えている部分を誤って切り落とすことはない)。
    let mut path_ops: u32 = 0;
    let mut path_rect: Option<Rect> = None;

    let xobject_dict: Option<Dictionary> = resources
        .get(b"XObject")
        .ok()
        .and_then(|o| resolve_dict(doc, o));

    for (op_index, op) in content.operations.iter().enumerate() {
        match op.operator.as_str() {
            "q" => {
                mstack.push(cur);
                cstack.push(cur_clip);
            }
            "Q" => {
                if let Some(m) = mstack.pop() {
                    cur = m;
                }
                if let Some(c) = cstack.pop() {
                    cur_clip = c;
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
            "re" if op.operands.len() == 4 => {
                let x = obj_to_f32(&op.operands[0]);
                let y = obj_to_f32(&op.operands[1]);
                let w = obj_to_f32(&op.operands[2]);
                let h = obj_to_f32(&op.operands[3]);
                let local = Rect::from_points(&[(x, y), (x + w, y + h)]);
                let global = cur.rect_transform(&local);
                path_ops += 1;
                path_rect = if path_ops == 1 { Some(global) } else { None };
            }
            "m" | "l" | "c" | "v" | "y" | "h" => {
                path_ops += 1;
                path_rect = None;
            }
            "W" | "W*" => {
                if let Some(pr) = path_rect {
                    cur_clip = Some(match cur_clip {
                        Some(existing) => existing.intersect(&pr).unwrap_or(Rect {
                            x0: 0.0,
                            y0: 0.0,
                            x1: 0.0,
                            y1: 0.0,
                        }),
                        None => pr,
                    });
                }
            }
            "n" | "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" => {
                path_ops = 0;
                path_rect = None;
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
                        analysis
                            .do_sites
                            .entry(*xref)
                            .or_default()
                            .insert((stream_id, op_index));

                        if analysis.ineligible.contains(xref) {
                            continue;
                        }
                        if !cur.is_axis_aligned() {
                            analysis.ineligible.insert(*xref);
                            analysis.uv_union.remove(xref);
                            continue;
                        }
                        let placed = cur.unit_square_rect();
                        let visible = match cur_clip {
                            Some(c) => c.intersect(&placed),
                            None => Some(placed),
                        };
                        let Some(visible) = visible else {
                            continue; // このusageは完全に不可視 → 和集合に寄与しない
                        };
                        let u_a = (visible.x0 - cur.e) / cur.a;
                        let u_b = (visible.x1 - cur.e) / cur.a;
                        let v_a = (visible.y0 - cur.f) / cur.d;
                        let v_b = (visible.y1 - cur.f) / cur.d;
                        let uv = Rect {
                            x0: u_a.min(u_b).clamp(0.0, 1.0),
                            y0: v_a.min(v_b).clamp(0.0, 1.0),
                            x1: u_a.max(u_b).clamp(0.0, 1.0),
                            y1: v_a.max(v_b).clamp(0.0, 1.0),
                        };
                        let merged = match analysis.uv_union.get(xref) {
                            Some(existing) => existing.union(&uv),
                            None => uv,
                        };
                        analysis.uv_union.insert(*xref, merged);
                    }
                    Some(b"Form") => {
                        if visiting.contains(xref) {
                            continue;
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
                        let form_clip = xobj_dict_inner
                            .get(b"BBox")
                            .ok()
                            .and_then(|o| o.as_array().ok())
                            .filter(|a| a.len() == 4)
                            .map(|a| {
                                let bbox_local = Rect::from_points(&[
                                    (obj_to_f32(&a[0]), obj_to_f32(&a[1])),
                                    (obj_to_f32(&a[2]), obj_to_f32(&a[3])),
                                ]);
                                form_ctm.rect_transform(&bbox_local)
                            });
                        let new_clip = match (cur_clip, form_clip) {
                            (Some(c), Some(b)) => c.intersect(&b),
                            (Some(c), None) => Some(c),
                            (None, Some(b)) => Some(b),
                            (None, None) => None,
                        };
                        let form_bytes = if let Object::Stream(s) = xobj {
                            crate::image_recompress::stream_bytes(s).unwrap_or_default()
                        } else {
                            Vec::new()
                        };
                        visiting.insert(*xref);
                        walk(
                            doc,
                            *xref,
                            &form_bytes,
                            &form_resources,
                            form_ctm,
                            new_clip,
                            depth + 1,
                            visiting,
                            analysis,
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

fn analyze(doc: &Document) -> CropAnalysis {
    let mut analysis = CropAnalysis::default();
    for page_id in doc.page_iter() {
        let Some(resources) = resolve_resources(doc, page_id) else {
            continue;
        };
        let Ok(page_dict) = doc.get_object(page_id).and_then(|o| o.as_dict().cloned()) else {
            continue;
        };
        let Ok(contents) = page_dict.get(b"Contents") else {
            continue;
        };

        let mut visiting = HashSet::new();
        let mut walk_one = |id: ObjectId| {
            if let Ok(Object::Stream(s)) = doc.get_object(id) {
                if let Ok(bytes) = crate::image_recompress::stream_bytes(s) {
                    walk(
                        doc,
                        id,
                        &bytes,
                        &resources,
                        Matrix::IDENTITY,
                        None,
                        0,
                        &mut visiting,
                        &mut analysis,
                    );
                }
            }
        };
        match contents {
            Object::Reference(id) => walk_one(*id),
            Object::Array(arr) => {
                for item in arr {
                    if let Object::Reference(id) = item {
                        walk_one(*id);
                    }
                }
            }
            _ => {}
        }
    }
    analysis
}

/// ストリーム本体を Flate 圧縮して書き戻す。lopdf::Stream::compress() は
/// 「圧縮した方が小さい場合のみ」圧縮して Filter を設定する挙動のため、
/// 逆に伸びる場合は Filter キーが最後まで付かないままになり、後続の
/// stream_bytes()/decompressed_content() 呼び出し経路によっては扱いが
/// 分かれてしまう。ここでは常に Filter=FlateDecode を設定して統一する。
fn set_flate_content(stream: &mut lopdf::Stream, bytes: Vec<u8>) {
    use flate2::Compression;
    use flate2::write::ZlibEncoder;
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

/// 画像 xref のピクセルデータを uv (ローカル UV [0,1]^2) の範囲だけに
/// 切り出す。対応フォーマットは image_recompress::classify_source と同じ。
fn crop_image_pixels(
    doc: &mut Document,
    xref: ObjectId,
    uv: Rect,
    jpeg_quality: u8,
) -> Result<(), String> {
    use image::codecs::jpeg::JpegEncoder;
    use image::{ColorType, GenericImageView, ImageEncoder};

    let (kind, raw_bytes, native_w, native_h) = {
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
        let raw_bytes = match kind {
            SourceKind::Dct => stream.content.clone(),
            SourceKind::DctFlateWrapped => {
                use std::io::Read;
                let mut inflated = Vec::new();
                flate2::read::ZlibDecoder::new(stream.content.as_slice())
                    .read_to_end(&mut inflated)
                    .map_err(|e| format!("image {xref:?} inflate: {e}"))?;
                inflated
            }
            _ => crate::image_recompress::stream_bytes(stream)
                .map_err(|e| format!("image {xref:?} decompress: {e}"))?,
        };
        (kind, raw_bytes, native_w, native_h)
    };

    // UV [0,1]^2 (v=0 が下端、v=1 が上端の user-space 規約) をピクセル行/列に
    // 変換する。画像のラスタ行0は v=1 (上端) 側にあたる。
    let nw = native_w as f32;
    let nh = native_h as f32;
    let col0 = ((uv.x0 * nw).floor() as i64 - CROP_MARGIN_PX).clamp(0, native_w);
    let col1 = ((uv.x1 * nw).ceil() as i64 + CROP_MARGIN_PX).clamp(0, native_w);
    let row0 = (((1.0 - uv.y1) * nh).floor() as i64 - CROP_MARGIN_PX).clamp(0, native_h);
    let row1 = (((1.0 - uv.y0) * nh).ceil() as i64 + CROP_MARGIN_PX).clamp(0, native_h);
    let new_w = (col1 - col0).max(1) as u32;
    let new_h = (row1 - row0).max(1) as u32;

    if new_w as i64 >= native_w && new_h as i64 >= native_h {
        return Err("crop rect covers entire image, not worth it".to_string());
    }

    match kind {
        SourceKind::Dct | SourceKind::DctFlateWrapped => {
            let img = image::load_from_memory_with_format(&raw_bytes, image::ImageFormat::Jpeg)
                .map_err(|e| format!("jpeg decode {xref:?}: {e}"))?;
            let grayscale = matches!(img.color(), image::ColorType::L8 | image::ColorType::L16);
            let (iw, ih) = img.dimensions();
            let cx = (col0 as u32).min(iw.saturating_sub(1));
            let cy = (row0 as u32).min(ih.saturating_sub(1));
            let cw = new_w.min(iw - cx);
            let ch = new_h.min(ih - cy);
            let cropped = img.crop_imm(cx, cy, cw, ch);

            let mut out_buf: Vec<u8> = Vec::new();
            {
                // 呼び出し元から渡された jpeg_quality でエンコードする。
                // (image_dpi も併用された場合、この後段の DPI パスがさらに
                //  リサイズ+再エンコードすることがあるが、同じ品質値を使う
                //  ことで無意味な高品質→低品質の往復を避けている)
                let encoder = JpegEncoder::new_with_quality(&mut out_buf, jpeg_quality);
                if grayscale {
                    let luma = cropped.to_luma8();
                    encoder
                        .write_image(luma.as_raw(), cw, ch, ColorType::L8.into())
                        .map_err(|e| format!("jpeg encode {xref:?}: {e}"))?;
                } else {
                    let rgb = cropped.to_rgb8();
                    encoder
                        .write_image(rgb.as_raw(), cw, ch, ColorType::Rgb8.into())
                        .map_err(|e| format!("jpeg encode {xref:?}: {e}"))?;
                }
            }

            // 安全弁: ピクセル面積を削っても、再エンコードによる generational
            // loss や元エンコーダとの効率差で、かえってバイト数が増える
            // ケースがある (特に crop 幅が小さい場合)。その場合は crop を
            // 取りやめて元の画像をそのまま残す。
            if out_buf.len() >= raw_bytes.len() {
                return Err(format!(
                    "image {xref:?}: re-encoded crop ({}B) not smaller than original ({}B), skipping",
                    out_buf.len(),
                    raw_bytes.len()
                ));
            }

            let obj = doc
                .get_object_mut(xref)
                .map_err(|e| format!("get_mut image {xref:?}: {e}"))?;
            let stream = obj
                .as_stream_mut()
                .map_err(|e| format!("image {xref:?} as_stream_mut: {e}"))?;
            stream.set_plain_content(out_buf);
            stream.dict.set("Width", Object::Integer(cw as i64));
            stream.dict.set("Height", Object::Integer(ch as i64));
            stream.dict.set("BitsPerComponent", Object::Integer(8));
            stream
                .dict
                .set("Filter", Object::Name(b"DCTDecode".to_vec()));
            stream.dict.remove(b"Decode");
        }
        SourceKind::RawGray8 | SourceKind::RawRgb8 | SourceKind::RawCmyk8 => {
            let components: i64 = match kind {
                SourceKind::RawGray8 => 1,
                SourceKind::RawRgb8 => 3,
                SourceKind::RawCmyk8 => 4,
                _ => unreachable!(),
            };
            let row_stride = (native_w * components) as usize;
            let mut cropped_bytes =
                Vec::with_capacity((new_w as i64 * components) as usize * new_h as usize);
            for row in row0..row1 {
                let row_start = row as usize * row_stride + (col0 * components) as usize;
                let row_len = (new_w as i64 * components) as usize;
                let row_end = row_start + row_len;
                if row_end > raw_bytes.len() {
                    return Err(format!("image {xref:?}: crop rect exceeds raw buffer"));
                }
                cropped_bytes.extend_from_slice(&raw_bytes[row_start..row_end]);
            }
            let obj = doc
                .get_object_mut(xref)
                .map_err(|e| format!("get_mut image {xref:?}: {e}"))?;
            let stream = obj
                .as_stream_mut()
                .map_err(|e| format!("image {xref:?} as_stream_mut: {e}"))?;
            stream.dict.set("Width", Object::Integer(new_w as i64));
            stream.dict.set("Height", Object::Integer(new_h as i64));
            set_flate_content(stream, cropped_bytes);
        }
    }

    Ok(())
}

/// 指定した箇所の直前に、切り出し後の画像でも同じ見た目を再現するための
/// 補正 "cm" を挿入する。
fn insert_compensating_cm(
    doc: &mut Document,
    by_stream: &HashMap<ObjectId, HashMap<usize, Matrix>>,
) {
    for (stream_id, targets) in by_stream {
        let result: Result<(), String> = (|| {
            let obj = doc
                .get_object_mut(*stream_id)
                .map_err(|e| format!("get_mut stream {stream_id:?}: {e}"))?;
            let stream = obj
                .as_stream_mut()
                .map_err(|e| format!("stream {stream_id:?} as_stream_mut: {e}"))?;
            let bytes = crate::image_recompress::stream_bytes(stream)
                .map_err(|e| format!("stream {stream_id:?} decompress: {e}"))?;
            let content =
                Content::decode(&bytes).map_err(|e| format!("stream {stream_id:?} decode: {e}"))?;

            let mut new_ops: Vec<Operation> =
                Vec::with_capacity(content.operations.len() + targets.len());
            for (i, op) in content.operations.iter().enumerate() {
                if let Some(s) = targets.get(&i) {
                    new_ops.push(Operation::new(
                        "cm",
                        vec![
                            Object::Real(s.a),
                            Object::Real(s.b),
                            Object::Real(s.c),
                            Object::Real(s.d),
                            Object::Real(s.e),
                            Object::Real(s.f),
                        ],
                    ));
                }
                new_ops.push(op.clone());
            }
            let new_content = Content {
                operations: new_ops,
            };
            let encoded = new_content
                .encode()
                .map_err(|e| format!("stream {stream_id:?} encode: {e}"))?;
            set_flate_content(stream, encoded);
            Ok(())
        })();
        if let Err(e) = result {
            eprintln!(
                "[visible_crop] cm insert failed for stream {stream_id:?}: {e} (image left uncropped-consistent state may be broken; consider skipping crop for its images)"
            );
        }
    }
}

/// 画像を 1x1 の極小プレースホルダに置換する (どの配置からも見えない画像用)。
fn replace_with_placeholder(doc: &mut Document, xref: ObjectId) -> Result<(), String> {
    let obj = doc
        .get_object_mut(xref)
        .map_err(|e| format!("get_mut image {xref:?}: {e}"))?;
    let stream = obj
        .as_stream_mut()
        .map_err(|e| format!("image {xref:?} as_stream_mut: {e}"))?;
    // 1x1 の白ピクセル (無圧縮 8bit Gray) を積む。どの Do 箇所からも
    // 見えないと分かっているので、内容は何でもよい。
    stream.set_plain_content(vec![0xFFu8]);
    stream.dict.set("Width", Object::Integer(1));
    stream.dict.set("Height", Object::Integer(1));
    stream.dict.set("BitsPerComponent", Object::Integer(8));
    stream.dict.remove(b"Filter");
    stream.dict.remove(b"DecodeParms");
    stream.dict.remove(b"Decode");
    stream
        .dict
        .set("ColorSpace", Object::Name(b"DeviceGray".to_vec()));
    Ok(())
}

/// 全ページの埋め込み画像のうち、実際に見えている範囲だけを残して
/// ピクセルデータを切り詰める。image_recompress::recompress_images の
/// 前段として呼び出すことを想定 (この後で通常の DPI/品質パスを流すと、
/// 正しく縮小された表示サイズを基準に追加のダウンサンプルもかかる)。
pub fn crop_to_visible_area(doc: &mut Document, jpeg_quality: u8) -> VisibleCropStats {
    let analysis = analyze(doc);
    let mut stats = VisibleCropStats::default();

    let mut crop_plans: HashMap<ObjectId, Rect> = HashMap::new();
    let mut stub_targets: HashSet<ObjectId> = HashSet::new();

    for xref in analysis.do_sites.keys() {
        stats.images_scanned += 1;
        if analysis.ineligible.contains(xref) {
            continue;
        }
        match analysis.uv_union.get(xref) {
            None => {
                stub_targets.insert(*xref);
            }
            Some(r) => {
                let area = r.area();
                if area < INVISIBLE_AREA_THRESHOLD {
                    stub_targets.insert(*xref);
                } else if area < CROP_AREA_THRESHOLD {
                    crop_plans.insert(*xref, *r);
                }
            }
        }
    }

    for xref in &stub_targets {
        match replace_with_placeholder(doc, *xref) {
            Ok(()) => stats.images_stubbed += 1,
            Err(e) => eprintln!("[visible_crop] xref={xref:?}: {e} (skipped, kept original)"),
        }
    }

    let mut by_stream: HashMap<ObjectId, HashMap<usize, Matrix>> = HashMap::new();
    for (xref, uv) in &crop_plans {
        match crop_image_pixels(doc, *xref, *uv, jpeg_quality) {
            Ok(()) => {
                stats.images_cropped += 1;
                let s = Matrix {
                    a: uv.x1 - uv.x0,
                    b: 0.0,
                    c: 0.0,
                    d: uv.y1 - uv.y0,
                    e: uv.x0,
                    f: uv.y0,
                };
                if let Some(sites) = analysis.do_sites.get(xref) {
                    for (stream_id, op_index) in sites {
                        by_stream
                            .entry(*stream_id)
                            .or_default()
                            .insert(*op_index, s);
                    }
                }
            }
            Err(e) => eprintln!("[visible_crop] xref={xref:?}: {e} (skipped, kept original)"),
        }
    }

    insert_compensating_cm(doc, &by_stream);

    stats
}
