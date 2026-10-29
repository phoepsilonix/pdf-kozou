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
//            対応する全ての "Do" 呼び出し箇所を `q <補正cm> Do Q` に
//            置き換えて、切り出し後でも同じ見た目を再現する。補正行列は
//            切り出した整数画素矩形から直接組み立てる (UV を経由した
//            丸め誤差を持ち込まない)。/SMask 付きの画像は、本体と同じ UV
//            窓でマスクも切り出す (マスクだけが引き伸ばされるのを防ぐ)。
//            /Mask (色キー・ステンシル) や ImageMask など、マスクを同じ窓で
//            切り出せない画像は切り詰めない。
//        (c) 反映は「計画 → 内容ストリームの書き換えをメモリ上で確定 →
//            一括書き込み」の順で行う。補正 cm の挿入に失敗した画像は
//            元のまま残す (画像だけが切り詰められた状態を作らない)。
//        (d) 注釈の外観・パターン・Type3・ソフトマスクグループなど、解析が
//            辿らない場所からも使われる画像は対象外 (使用箇所に補正を
//            入れられないため)。
//   3. 回転・スキューを含む配置 (CTM の b/c 成分が非ゼロ) は対象外
//      (安全側でスキップ、元のまま保持)。矩形以外の (複雑な形状の)
//      クリップパスは無視する = クリップを狭めないだけで、見えている
//      部分を誤って切り落とすことはない。

use crate::image_recompress::{
    SourceKind, classify_source, image_native_size, set_flate_content,
};
use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Default)]
pub struct VisibleCropStats {
    pub images_scanned: usize,
    pub images_cropped: usize,
    pub images_stubbed: usize,
    /// 使われていない /XObject リソース参照 (画像・Form) を外した数。
    pub xobjects_pruned: usize,
}

/// 見えている範囲がこの割合未満なら crop 対象にする (savings が小さすぎる
/// 場合はリスクに見合わないため据え置く)。
const CROP_AREA_THRESHOLD: f64 = 0.9;
/// この割合未満しか見えていなければ「実質不可視」としてプレースホルダに
/// 置換する。
///
/// 面積比だけで判定するため、ごく小さい値にとどめる。以前は 0.02 (2%) だったが、
/// 「幅は 2% しか見えていないが、縦はほぼ全面が見えている」ような細長い帯
/// (ページ端からはみ出して置かれた背景画像の端、例えばページ左端の枠色の帯)
/// まで不可視と見なして 1x1 に置換してしまい、その帯が消えていた。
/// 細い帯でも実際に見えている画像は、プレースホルダではなく通常の切り詰め
/// (見えている範囲だけを残す) に回す。
const INVISIBLE_AREA_THRESHOLD: f64 = 1e-5;
/// 切り出し矩形に足す安全マージン (px)。クリップ境界のアンチエイリアス等で
/// ぎりぎり見えている画素を誤って切り落とさないため。
const CROP_MARGIN_PX: i64 = 2;
/// 切り詰める辺ごとの最小の削減量 (px)。これより小さい辺は切らずに、原本の辺の
/// まま残す。わずかな削減では容量がほとんど減らないのに、画像の貼り付け先の
/// 辺が新しくなり、ビューアの画素格子への丸めの違い (最大 1 デバイス画素) が
/// 見えるリスクだけが増えるため。実際の閾値は max(この値, 辺の長さ×MIN_EDGE_TRIM_RATIO)。
const MIN_EDGE_TRIM_PX: i64 = 16;
const MIN_EDGE_TRIM_RATIO: f64 = 0.02;
/// 辺ごとの判定のあとに残る面積が、元の面積のこの割合以上なら切り詰めない
/// (節約が小さすぎるため)。
const KEEP_AREA_SKIP_RATIO: f64 = 0.97;

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

    fn transform_point(&self, x: f64, y: f64) -> (f64, f64) {
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
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

impl Rect {
    fn from_points(pts: &[(f64, f64)]) -> Rect {
        let mut x0 = f64::INFINITY;
        let mut y0 = f64::INFINITY;
        let mut x1 = f64::NEG_INFINITY;
        let mut y1 = f64::NEG_INFINITY;
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

    fn area(&self) -> f64 {
        (self.x1 - self.x0).max(0.0) * (self.y1 - self.y0).max(0.0)
    }
}

fn obj_to_f64(o: &Object) -> f64 {
    match o {
        Object::Integer(i) => *i as f64,
        Object::Real(r) => *r as f64,
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
                    a: obj_to_f64(&op.operands[0]),
                    b: obj_to_f64(&op.operands[1]),
                    c: obj_to_f64(&op.operands[2]),
                    d: obj_to_f64(&op.operands[3]),
                    e: obj_to_f64(&op.operands[4]),
                    f: obj_to_f64(&op.operands[5]),
                };
                cur = m.concat(&cur);
            }
            "re" if op.operands.len() == 4 => {
                let x = obj_to_f64(&op.operands[0]);
                let y = obj_to_f64(&op.operands[1]);
                let w = obj_to_f64(&op.operands[2]);
                let h = obj_to_f64(&op.operands[3]);
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
                        let form_clip = xobj_dict_inner
                            .get(b"BBox")
                            .ok()
                            .and_then(|o| o.as_array().ok())
                            .filter(|a| a.len() == 4)
                            .map(|a| {
                                let bbox_local = Rect::from_points(&[
                                    (obj_to_f64(&a[0]), obj_to_f64(&a[1])),
                                    (obj_to_f64(&a[2]), obj_to_f64(&a[3])),
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

// ---------------------------------------------------------------------
// マスク (SMask) の扱い
//
// SMask は本体画像と「同じ単位正方形」にぴったり重ねて使われる。本体だけ
// 切り詰めてマスクを元の範囲のまま残すと、マスクが切り詰め後の画像全面に
// 引き伸ばされて透過の輪郭・大きさが狂う。したがって SMask 付き画像を
// 切り詰める場合は、必ず本体と「同じ UV 範囲」でマスクも切り詰める。
// 対応できないマスク (/Mask, ImageMask 等) 付きの画像は切り詰めない。
// ---------------------------------------------------------------------

enum MaskInfo {
    None,
    SMask(ObjectId),
    Unsupported,
}

fn image_mask_info(doc: &Document, dict: &Dictionary) -> MaskInfo {
    if matches!(dict.get(b"ImageMask"), Ok(Object::Boolean(true))) {
        return MaskInfo::Unsupported;
    }
    if dict.has(b"Mask") {
        return MaskInfo::Unsupported;
    }
    match dict.get(b"SMask") {
        Err(_) => MaskInfo::None,
        Ok(Object::Name(_)) => MaskInfo::None,
        Ok(Object::Reference(id)) => {
            let Ok(obj) = doc.get_object(*id) else {
                return MaskInfo::Unsupported;
            };
            let Ok(s) = obj.as_stream() else {
                return MaskInfo::Unsupported;
            };
            if s.dict.has(b"SMask") || s.dict.has(b"Mask") || image_native_size(&s.dict).is_none() {
                return MaskInfo::Unsupported;
            }
            match classify_source(doc, &s.dict) {
                Some(SourceKind::RawGray8 | SourceKind::Dct | SourceKind::DctFlateWrapped) => {
                    MaskInfo::SMask(*id)
                }
                _ => MaskInfo::Unsupported,
            }
        }
        Ok(_) => MaskInfo::Unsupported,
    }
}

/// 画像ストリームから (Flate 展開済みの) 本体バイト列を取り出す。
/// DCT 系は JPEG バイト列そのもの、それ以外は生ビットマップ。
fn source_bytes(stream: &lopdf::Stream, kind: SourceKind) -> Result<Vec<u8>, String> {
    match kind {
        SourceKind::Dct => Ok(stream.content.clone()),
        SourceKind::DctFlateWrapped => {
            use std::io::Read;
            let mut inflated = Vec::new();
            flate2::read::ZlibDecoder::new(stream.content.as_slice())
                .read_to_end(&mut inflated)
                .map_err(|e| format!("inflate: {e}"))?;
            Ok(inflated)
        }
        _ => crate::image_recompress::stream_bytes(stream).map_err(|e| format!("decompress: {e}")),
    }
}

/// SMask を 8bit グレースケールの生バイト列として読み出す。
fn read_mask_gray(
    doc: &Document,
    id: ObjectId,
) -> Result<(lopdf::Stream, Vec<u8>, usize, usize), String> {
    let obj = doc
        .get_object(id)
        .map_err(|e| format!("get smask {id:?}: {e}"))?;
    let s = obj
        .as_stream()
        .map_err(|e| format!("smask {id:?} as_stream: {e}"))?;
    let kind = classify_source(doc, &s.dict).ok_or_else(|| format!("smask {id:?}: unsupported"))?;
    let (w, h) = image_native_size(&s.dict).ok_or_else(|| format!("smask {id:?}: no size"))?;
    let (w, h) = (w as usize, h as usize);
    let bytes = match kind {
        SourceKind::RawGray8 => {
            let b = source_bytes(s, kind).map_err(|e| format!("smask {id:?} {e}"))?;
            if b.len() < w * h {
                return Err(format!("smask {id:?}: buffer too short"));
            }
            b[..w * h].to_vec()
        }
        SourceKind::Dct | SourceKind::DctFlateWrapped => {
            let raw = source_bytes(s, kind).map_err(|e| format!("smask {id:?} {e}"))?;
            let luma = image::load_from_memory_with_format(&raw, image::ImageFormat::Jpeg)
                .map_err(|e| format!("smask {id:?} jpeg decode: {e}"))?
                .to_luma8();
            if luma.width() as usize != w || luma.height() as usize != h {
                return Err(format!("smask {id:?}: JPEG size differs from dictionary"));
            }
            luma.into_raw()
        }
        _ => return Err(format!("smask {id:?}: unsupported kind")),
    };
    Ok((s.clone(), bytes, w, h))
}

/// 切り出した画素矩形 (半開区間)。
#[derive(Clone, Copy, Debug)]
struct PixRect {
    col0: i64,
    row0: i64,
    col1: i64,
    row1: i64,
}

/// 8bit グレー画像から、画像ローカル UV 窓 `uv` (行0 = v=1 の上端) に
/// 対応する範囲を切り出す。
///
/// - マスクの画素格子が本体と同じ寸法なら、本体と同じ画素矩形を
///   そのまま切り出す (誤差なし)。
/// - 寸法が違う場合は、窓をサブピクセル精度で双線形サンプリングして
///   「窓の両端がちょうど切り出し後の両端に一致する」ように取り直す。
///   窓の大きさを丸めた分の誤差は窓内で一様に配られ、端はずれない。
fn crop_gray_window(
    src: &[u8],
    sw: usize,
    sh: usize,
    base_w: i64,
    base_h: i64,
    px: &PixRect,
    uv: &Rect,
) -> (Vec<u8>, usize, usize) {
    if sw as i64 == base_w && sh as i64 == base_h {
        let cw = (px.col1 - px.col0) as usize;
        let ch = (px.row1 - px.row0) as usize;
        let mut out = Vec::with_capacity(cw * ch);
        for row in px.row0 as usize..px.row1 as usize {
            let start = row * sw + px.col0 as usize;
            out.extend_from_slice(&src[start..start + cw]);
        }
        return (out, cw, ch);
    }
    let x0 = uv.x0 * sw as f64;
    let x1 = uv.x1 * sw as f64;
    let y0 = (1.0 - uv.y1) * sh as f64;
    let y1 = (1.0 - uv.y0) * sh as f64;
    let ow = ((x1 - x0).round() as usize).max(1);
    let oh = ((y1 - y0).round() as usize).max(1);
    let (fx, fy) = ((x1 - x0) / ow as f64, (y1 - y0) / oh as f64);
    let max_x = (sw - 1) as f64;
    let max_y = (sh - 1) as f64;
    let mut out = Vec::with_capacity(ow * oh);
    for j in 0..oh {
        let sy = (y0 + (j as f64 + 0.5) * fy - 0.5).clamp(0.0, max_y);
        let iy = sy.floor() as usize;
        let iy1 = (iy + 1).min(sh - 1);
        let ty = sy - iy as f64;
        for i in 0..ow {
            let sx = (x0 + (i as f64 + 0.5) * fx - 0.5).clamp(0.0, max_x);
            let ix = sx.floor() as usize;
            let ix1 = (ix + 1).min(sw - 1);
            let tx = sx - ix as f64;
            let p = |x: usize, y: usize| src[y * sw + x] as f64;
            let top = p(ix, iy) * (1.0 - tx) + p(ix1, iy) * tx;
            let bot = p(ix, iy1) * (1.0 - tx) + p(ix1, iy1) * tx;
            out.push((top * (1.0 - ty) + bot * ty).round().clamp(0.0, 255.0) as u8);
        }
    }
    (out, ow, oh)
}

// ---------------------------------------------------------------------
// 切り詰め計画 (まだ文書には書き込まない)
// ---------------------------------------------------------------------

/// 1 枚の画像の切り詰め結果。補正 "cm" の挿入がすべて成功することが
/// 確定してから `commit_crop` で初めて文書へ反映する (反映の順序を
/// 逆にすると、cm の挿入に失敗した場合に画像だけが切り詰められたまま
/// 残り、画面上で引き伸ばされて見える)。
struct PendingCrop {
    new_image: lopdf::Stream,
    new_mask: Option<lopdf::Stream>,
    /// 切り出し後の単位正方形 → 元画像の単位正方形 への補正行列。
    comp: Matrix,
}

/// JPEG の無劣化トリミングの使い方 (環境変数 KOZOU_CROP_LOSSLESS)。
/// ダウンサンプリング・再圧縮は image_dpi / jpeg_quality の別オプションで行うので、
/// 切り詰めそのものは画質を変えない無劣化を標準にする。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LosslessMode {
    /// 無劣化にできる場合でも使わず、常に復号→指定品質で再エンコードする ("0")。
    Never,
    /// 無劣化にできるなら常に使う (既定、"1" も同じ)。画質は落ちない。元のJPEGの
    /// 品質が指定品質より高いと、再エンコードより大きくなることがある。
    Force,
    /// 無劣化の結果が、再エンコードの結果以下の大きさのときだけ使う ("auto")。
    /// 元のJPEGが指定品質以下で圧縮済みなら、無劣化のほうが小さく画質も落ちない。
    Auto,
}

#[cfg(test)]
thread_local! {
    /// テスト用: 環境変数を使わずに、スレッドごとにモードを上書きする。
    static MODE_OVERRIDE: std::cell::Cell<Option<LosslessMode>> = const { std::cell::Cell::new(None) };
}

fn lossless_crop_mode() -> LosslessMode {
    #[cfg(test)]
    if let Some(m) = MODE_OVERRIDE.with(|c| c.get()) {
        return m;
    }
    match std::env::var("KOZOU_CROP_LOSSLESS").as_deref() {
        Ok("0") => LosslessMode::Never,
        Ok("auto") => LosslessMode::Auto,
        _ => LosslessMode::Force,
    }
}

/// JPEG を復号して `px` の範囲を切り出し、指定品質で再エンコードする。
fn reencode_jpeg_crop(
    raw: &[u8],
    native_w: i64,
    native_h: i64,
    px: &PixRect,
    jpeg_quality: u8,
) -> Result<Vec<u8>, String> {
    use image::codecs::jpeg::JpegEncoder;
    use image::{ColorType, GenericImageView, ImageEncoder};
    let img = image::load_from_memory_with_format(raw, image::ImageFormat::Jpeg)
        .map_err(|e| format!("jpeg decode: {e}"))?;
    let grayscale = matches!(img.color(), image::ColorType::L8 | image::ColorType::L16);
    let (iw, ih) = img.dimensions();
    // 辞書の Width/Height と JPEG の実寸が食い違うと、UV→画素の変換がずれて
    // 補正が合わなくなる。安全側で切り詰めない。
    if iw as i64 != native_w || ih as i64 != native_h {
        return Err(format!(
            "JPEG size {iw}x{ih} differs from dictionary {native_w}x{native_h}"
        ));
    }
    let (cw, ch) = ((px.col1 - px.col0) as u32, (px.row1 - px.row0) as u32);
    let cropped = img.crop_imm(px.col0 as u32, px.row0 as u32, cw, ch);
    let mut out_buf: Vec<u8> = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut out_buf, jpeg_quality);
    if grayscale {
        let luma = cropped.to_luma8();
        encoder
            .write_image(luma.as_raw(), cw, ch, ColorType::L8.into())
            .map_err(|e| format!("jpeg encode: {e}"))?;
    } else {
        let rgb = cropped.to_rgb8();
        encoder
            .write_image(rgb.as_raw(), cw, ch, ColorType::Rgb8.into())
            .map_err(|e| format!("jpeg encode: {e}"))?;
    }
    Ok(out_buf)
}

/// 画素矩形 `px` を JPEG の MCU 格子に外側へ揃え、無劣化で切り出す。
/// 揃えた後の矩形 (元画像全体と同じになる場合は None) と、切り出した JPEG を返す。
/// 外側へ揃えるので、必要な範囲は必ず含まれる。
fn lossless_align_and_crop(
    raw: &[u8],
    native_w: i64,
    native_h: i64,
    px: &PixRect,
) -> Option<(PixRect, Vec<u8>)> {
    let g = crate::jpeg_lossless::jpeg_geometry(raw)?;
    if g.width as i64 != native_w || g.height as i64 != native_h {
        return None;
    }
    let (mw, mh) = (g.mcu_w as i64, g.mcu_h as i64);
    let down = |v: i64, m: i64| v / m * m;
    let up = |v: i64, m: i64, max: i64| if v >= max { max } else { ((v + m - 1) / m * m).min(max) };
    let apx = PixRect {
        col0: down(px.col0, mw),
        row0: down(px.row0, mh),
        col1: up(px.col1, mw, native_w),
        row1: up(px.row1, mh, native_h),
    };
    let (aw, ah) = (apx.col1 - apx.col0, apx.row1 - apx.row0);
    if aw >= native_w && ah >= native_h {
        return None;
    }
    let out = crate::jpeg_lossless::crop_jpeg_lossless(
        raw,
        apx.col0 as u32,
        apx.row0 as u32,
        aw as u32,
        ah as u32,
    )
    .ok()?;
    Some((apx, out))
}

/// 画像 xref のピクセルデータを uv (ローカル UV [0,1]^2) の範囲だけに
/// 切り出した結果を組み立てる。対応フォーマットは
/// image_recompress::classify_source と同じ。SMask 付きの場合は本体と
/// 同じ範囲でマスクも切り出す。
///
/// 補正行列は、マージン・クランプ後に「実際に切り出した整数画素矩形」
/// から直接組み立てる (引数 `uv` は使わない)。引数 `uv` を使うと、
/// マージン分だけ多く残った画素が小さい矩形に押し込められて表示され、
/// 画像が微妙に縮小・位置ずれして見える。
fn plan_crop(
    doc: &Document,
    xref: ObjectId,
    uv: Rect,
    jpeg_quality: u8,
) -> Result<PendingCrop, String> {
    let obj = doc
        .get_object(xref)
        .map_err(|e| format!("get image {xref:?}: {e}"))?;
    let stream = obj
        .as_stream()
        .map_err(|e| format!("image {xref:?} as_stream: {e}"))?;
    let kind = classify_source(doc, &stream.dict)
        .ok_or_else(|| format!("image {xref:?}: unsupported filter/colorspace"))?;
    let (native_w, native_h) = image_native_size(&stream.dict)
        .ok_or_else(|| format!("image {xref:?}: missing Width/Height"))?;
    if native_w <= 0 || native_h <= 0 {
        return Err(format!("image {xref:?}: invalid size"));
    }
    let mask = image_mask_info(doc, &stream.dict);
    if matches!(mask, MaskInfo::Unsupported) {
        return Err(format!("image {xref:?}: unsupported mask, left as is"));
    }
    let raw_bytes = source_bytes(stream, kind).map_err(|e| format!("image {xref:?} {e}"))?;

    // UV [0,1]^2 (v=0 が下端、v=1 が上端の user-space 規約) をピクセル行/列に
    // 変換する。画像のラスタ行0は v=1 (上端) 側にあたる。
    let nw = native_w as f64;
    let nh = native_h as f64;
    let px = PixRect {
        col0: ((uv.x0 * nw).floor() as i64 - CROP_MARGIN_PX).clamp(0, native_w),
        col1: ((uv.x1 * nw).ceil() as i64 + CROP_MARGIN_PX).clamp(0, native_w),
        row0: (((1.0 - uv.y1) * nh).floor() as i64 - CROP_MARGIN_PX).clamp(0, native_h),
        row1: (((1.0 - uv.y0) * nh).ceil() as i64 + CROP_MARGIN_PX).clamp(0, native_h),
    };
    // 削減量が小さい辺は切らない (原本の辺を残す)。
    let min_x = MIN_EDGE_TRIM_PX.max((nw * MIN_EDGE_TRIM_RATIO).ceil() as i64);
    let min_y = MIN_EDGE_TRIM_PX.max((nh * MIN_EDGE_TRIM_RATIO).ceil() as i64);
    let px = PixRect {
        col0: if px.col0 < min_x { 0 } else { px.col0 },
        col1: if native_w - px.col1 < min_x { native_w } else { px.col1 },
        row0: if px.row0 < min_y { 0 } else { px.row0 },
        row1: if native_h - px.row1 < min_y { native_h } else { px.row1 },
    };
    let new_w = (px.col1 - px.col0).max(1);
    let new_h = (px.row1 - px.row0).max(1);
    if new_w >= native_w && new_h >= native_h {
        return Err("crop rect covers entire image, not worth it".to_string());
    }
    if (new_w * new_h) as f64 >= KEEP_AREA_SKIP_RATIO * (native_w * native_h) as f64 {
        return Err("crop saves too little, not worth it".to_string());
    }
    let px = PixRect {
        col1: px.col0 + new_w,
        row1: px.row0 + new_h,
        ..px
    };

    // JPEG は、MCU 格子に外側へ揃えた矩形なら、DCT 係数のまま無劣化で切り出せる
    // (jpeg_lossless)。ただし元の品質が指定品質より高いと、再エンコードより大きく
    // なることが多い。ダウンサンプリング・再圧縮は別オプション (image_dpi /
    // jpeg_quality) で行うので、切り詰めは無劣化を標準にする (Force)。"auto" なら、
    // 無劣化の結果が再エンコード以下の大きさのときだけ採用する。無劣化にできない
    // JPEG (プログレッシブなど) や、結果が元より小さくならない場合は、従来どおり
    // (再エンコード)。
    let mut jpeg_out: Option<Vec<u8>> = None;
    let px = if matches!(kind, SourceKind::Dct | SourceKind::DctFlateWrapped) {
        let mode = lossless_crop_mode();
        let cand = if mode == LosslessMode::Never {
            None
        } else {
            lossless_align_and_crop(&raw_bytes, native_w, native_h, &px)
        };
        match cand {
            Some((apx, out)) if out.len() < raw_bytes.len() => {
                if mode == LosslessMode::Force {
                    jpeg_out = Some(out);
                    apx
                } else {
                    match reencode_jpeg_crop(&raw_bytes, native_w, native_h, &px, jpeg_quality) {
                        Ok(re) if re.len() < out.len() => {
                            jpeg_out = Some(re);
                            px
                        }
                        _ => {
                            jpeg_out = Some(out);
                            apx
                        }
                    }
                }
            }
            _ => px,
        }
    } else {
        px
    };
    let new_w = (px.col1 - px.col0).max(1);
    let new_h = (px.row1 - px.row0).max(1);

    // 実際に切り出す画素矩形から UV 窓と補正行列を作る。
    // 補正行列は「切り出し後の単位正方形」を「元の単位正方形のうちの
    // 切り出した窓」へ写す: u = a*u' + e, v = d*v' + f
    let actual_uv = Rect {
        x0: px.col0 as f64 / nw,
        x1: px.col1 as f64 / nw,
        y0: 1.0 - (px.row1 as f64 / nh),
        y1: 1.0 - (px.row0 as f64 / nh),
    };
    let comp = Matrix {
        a: new_w as f64 / nw,
        b: 0.0,
        c: 0.0,
        d: new_h as f64 / nh,
        e: px.col0 as f64 / nw,
        f: 1.0 - (px.row1 as f64 / nh),
    };

    let mut new_image = stream.clone();
    match kind {
        SourceKind::Dct | SourceKind::DctFlateWrapped => {
            let out_buf = match jpeg_out.take() {
                Some(b) => b,
                None => reencode_jpeg_crop(&raw_bytes, native_w, native_h, &px, jpeg_quality)
                    .map_err(|e| format!("image {xref:?}: {e}"))?,
            };
            // 安全弁: 切り出しで逆にバイト数が増える場合は取りやめる。
            if out_buf.len() >= raw_bytes.len() {
                return Err(format!(
                    "image {xref:?}: cropped JPEG ({}B) not smaller than original ({}B), skipping",
                    out_buf.len(),
                    raw_bytes.len()
                ));
            }
            new_image.set_plain_content(out_buf);
            new_image.dict.set("Width", Object::Integer(new_w));
            new_image.dict.set("Height", Object::Integer(new_h));
            new_image.dict.set("BitsPerComponent", Object::Integer(8));
            new_image
                .dict
                .set("Filter", Object::Name(b"DCTDecode".to_vec()));
            new_image.dict.remove(b"Decode");
        }
        SourceKind::RawGray8 | SourceKind::RawRgb8 | SourceKind::RawCmyk8 => {
            let components: i64 = match kind {
                SourceKind::RawGray8 => 1,
                SourceKind::RawRgb8 => 3,
                _ => 4,
            };
            let row_stride = (native_w * components) as usize;
            let row_len = (new_w * components) as usize;
            let mut cropped_bytes = Vec::with_capacity(row_len * new_h as usize);
            for row in px.row0..px.row1 {
                let start = row as usize * row_stride + (px.col0 * components) as usize;
                let end = start + row_len;
                if end > raw_bytes.len() {
                    return Err(format!("image {xref:?}: crop rect exceeds raw buffer"));
                }
                cropped_bytes.extend_from_slice(&raw_bytes[start..end]);
            }
            new_image.dict.set("Width", Object::Integer(new_w));
            new_image.dict.set("Height", Object::Integer(new_h));
            set_flate_content(&mut new_image, cropped_bytes);
        }
    }

    // SMask は本体と同じ UV 窓で切り出す。
    let new_mask = if let MaskInfo::SMask(mask_id) = mask {
        let (mask_stream, mask_bytes, mw, mh) = read_mask_gray(doc, mask_id)?;
        let (bytes, ow, oh) =
            crop_gray_window(&mask_bytes, mw, mh, native_w, native_h, &px, &actual_uv);
        let mut ms = mask_stream;
        ms.dict.set("Width", Object::Integer(ow as i64));
        ms.dict.set("Height", Object::Integer(oh as i64));
        ms.dict.set("BitsPerComponent", Object::Integer(8));
        ms.dict
            .set("ColorSpace", Object::Name(b"DeviceGray".to_vec()));
        set_flate_content(&mut ms, bytes);
        Some(ms)
    } else {
        None
    };

    Ok(PendingCrop {
        new_image,
        new_mask,
        comp,
    })
}

/// 計画した切り詰めを文書へ反映する。マスクは常に新しいオブジェクトとして
/// 追加する (同じ SMask を別の画像が共有していても、そちらは影響を受けない)。
fn commit_crop(doc: &mut Document, xref: ObjectId, pending: PendingCrop) -> Result<(), String> {
    let mut image = pending.new_image;
    if let Some(mask) = pending.new_mask {
        let id = doc.add_object(Object::Stream(mask));
        image.dict.set("SMask", Object::Reference(id));
    }
    let slot = doc
        .get_object_mut(xref)
        .map_err(|e| format!("get_mut image {xref:?}: {e}"))?;
    *slot = Object::Stream(image);
    Ok(())
}

// ---------------------------------------------------------------------
// 補正 "cm" の挿入
// ---------------------------------------------------------------------

/// 指定した箇所の `Do` を `q <補正cm> Do Q` に置き換えた内容ストリームを
/// 作る (文書にはまだ書き込まない)。
///
/// 補正 cm を `q ... Q` で囲まないと、`Do` が自前の q/Q の中に無い PDF では
/// 以降の描画すべてに補正が掛かり続けてしまう。
fn rewrite_stream(
    doc: &Document,
    stream_id: ObjectId,
    targets: &HashMap<usize, Matrix>,
) -> Result<Vec<u8>, String> {
    let obj = doc
        .get_object(stream_id)
        .map_err(|e| format!("get stream {stream_id:?}: {e}"))?;
    let stream = obj
        .as_stream()
        .map_err(|e| format!("stream {stream_id:?} as_stream: {e}"))?;
    let bytes = crate::image_recompress::stream_bytes(stream)
        .map_err(|e| format!("stream {stream_id:?} decompress: {e}"))?;
    let content =
        Content::decode(&bytes).map_err(|e| format!("stream {stream_id:?} decode: {e}"))?;

    let mut new_ops: Vec<Operation> =
        Vec::with_capacity(content.operations.len() + targets.len() * 3);
    for (i, op) in content.operations.iter().enumerate() {
        if let Some(s) = targets.get(&i) {
            new_ops.push(Operation::new("q", vec![]));
            new_ops.push(Operation::new(
                "cm",
                vec![
                    Object::Real(s.a as f32),
                    Object::Real(s.b as f32),
                    Object::Real(s.c as f32),
                    Object::Real(s.d as f32),
                    Object::Real(s.e as f32),
                    Object::Real(s.f as f32),
                ],
            ));
            new_ops.push(op.clone());
            new_ops.push(Operation::new("Q", vec![]));
        } else {
            new_ops.push(op.clone());
        }
    }
    Content {
        operations: new_ops,
    }
    .encode()
    .map_err(|e| format!("stream {stream_id:?} encode: {e}"))
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
    stream.dict.remove(b"Decode");
    // マスク類は 1x1 の本体とは無関係になるので外す (大きなマスクが残ると
    // ファイルが縮まない上、ImageMask と BitsPerComponent=8 の併存は不正)。
    for key in [
        &b"SMask"[..],
        b"Mask",
        b"ImageMask",
        b"Matte",
        b"SMaskInData",
    ] {
        stream.dict.remove(key);
    }
    stream
        .dict
        .set("ColorSpace", Object::Name(b"DeviceGray".to_vec()));
    Ok(())
}

// ---------------------------------------------------------------------
// 解析が辿らない場所から使われている画像の保護
// ---------------------------------------------------------------------

/// `analyze` / `walk` は「ページの内容ストリーム → Do → Form」の連鎖しか
/// 辿らない。注釈の外観 (/AP)、タイリングパターン、Type3 フォント、
/// 描画状態のソフトマスク (/SMask の /G グループ) から使われている画像は
/// 使用箇所を把握できていないため、そこに現れる画像は切り詰めも
/// プレースホルダ化もしない (補正 cm を挿入できない箇所で画像だけが
/// 切り詰められると、その箇所で引き伸ばされて見える)。
fn shielded_images(doc: &Document) -> HashSet<ObjectId> {
    const SKIP_KEYS: [&[u8]; 9] = [
        b"Parent", b"P", b"Prev", b"Next", b"Dest", b"A", b"Popup", b"Pg", b"Annots",
    ];

    let mut roots: Vec<Object> = Vec::new();
    for (id, obj) in doc.objects.iter() {
        let Some(d) = as_dict_any(obj) else {
            continue;
        };
        if let Ok(ap) = d.get(b"AP") {
            roots.push(ap.clone());
        }
        if d.has(b"PatternType") {
            roots.push(Object::Reference(*id));
        }
        if matches!(
            d.get(b"Subtype").ok().and_then(|o| o.as_name().ok()),
            Some(b"Type3")
        ) {
            roots.push(Object::Reference(*id));
        }
        if let Ok(sm) = d.get(b"SMask") {
            if let Some(smd) = resolve_dict(doc, sm) {
                if let Ok(g) = smd.get(b"G") {
                    roots.push(g.clone());
                }
            }
        }
    }

    let mut found: HashSet<ObjectId> = HashSet::new();
    let mut visited: HashSet<ObjectId> = HashSet::new();
    let mut stack: Vec<Object> = roots;
    while let Some(o) = stack.pop() {
        match o {
            Object::Reference(r) => {
                if !visited.insert(r) {
                    continue;
                }
                let Ok(target) = doc.get_object(r) else {
                    continue;
                };
                let is_image = as_dict_any(target)
                    .and_then(|d| d.get(b"Subtype").ok())
                    .and_then(|s| s.as_name().ok())
                    == Some(b"Image".as_slice());
                if is_image {
                    found.insert(r);
                } else {
                    stack.push(target.clone());
                }
            }
            Object::Dictionary(d) => {
                for (k, v) in d.iter() {
                    if !SKIP_KEYS.contains(&k.as_slice()) {
                        stack.push(v.clone());
                    }
                }
            }
            Object::Stream(s) => {
                for (k, v) in s.dict.iter() {
                    if !SKIP_KEYS.contains(&k.as_slice()) {
                        stack.push(v.clone());
                    }
                }
            }
            Object::Array(a) => stack.extend(a),
            _ => {}
        }
    }
    found
}

// ---------------------------------------------------------------------
// 未使用の XObject リソース参照の整理
//
// キープテキスト版などでは、ページの描画命令 (Do) だけが取り除かれ、
// /Resources /XObject の参照は元のまま残ることがある。参照が残っていると
// 画像は「到達可能」なまま扱われ、ガベージコレクションでも消えず、
// 描画に使われない元画像がファイルの大半を占めることがある。
// どの内容ストリームからも Do されない名前の参照だけを外す。
// ---------------------------------------------------------------------

/// XObject 辞書の置き場所。
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum XoSlot {
    /// /XObject が独立した辞書オブジェクト (`/XObject 12 0 R`)
    Obj(ObjectId),
    /// /Resources が独立した辞書オブジェクトで、/XObject はその中にインライン
    InResObj(ObjectId),
    /// /Resources も /XObject も、持ち主 (ページ・Pages・Form 等) の辞書の中
    InHolder(ObjectId),
}

/// `start` の /Resources から XObject 辞書の置き場所を引く。`climb` が true なら
/// /Parent を辿って継承されたリソースも探す (ページ用)。
/// 戻り値: (置き場所, その辞書を指しているオブジェクト)。`InHolder` では
/// 後者は持ち主自身。
fn find_xo_slot(doc: &Document, start: ObjectId, climb: bool) -> Option<(XoSlot, ObjectId)> {
    let mut current = start;
    for _ in 0..64 {
        let dict = as_dict_any(doc.get_object(current).ok()?)?;
        if let Ok(res) = dict.get(b"Resources") {
            return match res {
                Object::Reference(r) => {
                    let rd = as_dict_any(doc.get_object(*r).ok()?)?;
                    match rd.get(b"XObject") {
                        Ok(Object::Reference(x)) => Some((XoSlot::Obj(*x), *r)),
                        Ok(Object::Dictionary(_)) => Some((XoSlot::InResObj(*r), current)),
                        _ => None,
                    }
                }
                Object::Dictionary(rd) => match rd.get(b"XObject") {
                    Ok(Object::Reference(x)) => Some((XoSlot::Obj(*x), current)),
                    Ok(Object::Dictionary(_)) => Some((XoSlot::InHolder(current), current)),
                    _ => None,
                },
                _ => None,
            };
        }
        if !climb {
            return None;
        }
        match dict.get(b"Parent") {
            Ok(Object::Reference(p)) => current = *p,
            _ => return None,
        }
    }
    None
}

/// 内容ストリームのバイト列から `Do` の名前を集める。解釈できなければ None。
fn content_do_names(bytes: &[u8]) -> Option<HashSet<Vec<u8>>> {
    let content = Content::decode(bytes).ok()?;
    let mut names = HashSet::new();
    for op in &content.operations {
        if op.operator == "Do" {
            if let Some(Object::Name(n)) = op.operands.first() {
                names.insert(n.clone());
            }
        }
    }
    Some(names)
}

fn stream_do_names(stream: &lopdf::Stream) -> Option<HashSet<Vec<u8>>> {
    content_do_names(&crate::image_recompress::stream_bytes(stream).ok()?)
}

/// ページの /Contents (単一ストリームまたはその配列) の Do 名を集める。
fn page_do_names(doc: &Document, page: &Dictionary) -> Option<HashSet<Vec<u8>>> {
    let mut names = HashSet::new();
    let ids: Vec<ObjectId> = match page.get(b"Contents") {
        Err(_) => return Some(names), // 内容なしのページ
        Ok(Object::Reference(id)) => match doc.get_object(*id).ok()? {
            Object::Array(arr) => arr
                .iter()
                .map(|o| o.as_reference().ok())
                .collect::<Option<Vec<_>>>()?,
            _ => vec![*id],
        },
        Ok(Object::Array(arr)) => arr
            .iter()
            .map(|o| o.as_reference().ok())
            .collect::<Option<Vec<_>>>()?,
        Ok(_) => return None,
    };
    for id in ids {
        let Object::Stream(s) = doc.get_object(id).ok()? else {
            return None;
        };
        names.extend(stream_do_names(s)?);
    }
    Some(names)
}

/// 文書内の参照の出現回数 (オブジェクト ID ごと)。
fn count_references(doc: &Document) -> HashMap<ObjectId, usize> {
    fn visit(o: &Object, counts: &mut HashMap<ObjectId, usize>) {
        match o {
            Object::Reference(r) => *counts.entry(*r).or_default() += 1,
            Object::Array(a) => a.iter().for_each(|v| visit(v, counts)),
            Object::Dictionary(d) => d.iter().for_each(|(_, v)| visit(v, counts)),
            Object::Stream(s) => s.dict.iter().for_each(|(_, v)| visit(v, counts)),
            _ => {}
        }
    }
    let mut counts = HashMap::new();
    for o in doc.objects.values() {
        visit(o, &mut counts);
    }
    for (_, v) in doc.trailer.iter() {
        visit(v, &mut counts);
    }
    counts
}

fn dict_mut_of(obj: &mut Object) -> Option<&mut Dictionary> {
    match obj {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&mut s.dict),
        _ => None,
    }
}

/// 置き場所の XObject 辞書を可変で取り出す。
fn xo_dict_mut(doc: &mut Document, slot: XoSlot) -> Option<&mut Dictionary> {
    match slot {
        XoSlot::Obj(x) => dict_mut_of(doc.get_object_mut(x).ok()?),
        XoSlot::InResObj(r) => dict_mut_of(doc.get_object_mut(r).ok()?)?
            .get_mut(b"XObject")
            .ok()?
            .as_dict_mut()
            .ok(),
        XoSlot::InHolder(h) => dict_mut_of(doc.get_object_mut(h).ok()?)?
            .get_mut(b"Resources")
            .ok()?
            .as_dict_mut()
            .ok()?
            .get_mut(b"XObject")
            .ok()?
            .as_dict_mut()
            .ok(),
    }
}

/// どの内容ストリームからも `Do` されない /XObject 参照を外す。外した数を返す。
///
/// 安全のため、次の場合は触らない:
/// - 内容ストリームを解釈できない文脈がある置き場所
///   (使われている名前を確定できないため)。解釈できないストリームが
///   「自前のリソースを持たない Form」の場合は、文書全体で何もしない
/// - 解析の文脈 (ページ・Form・パターン) 以外から参照されている辞書
///   (注釈の外観など、使用名を把握できない利用者がいるかもしれないため)
/// - 自前の /XObject を持たない Form、Type3 の CharProcs が Do している名前は、
///   継承されたリソースを使う可能性があるので、どの置き場所でも残す
pub fn prune_unused_xobjects(doc: &mut Document) -> usize {
    let refs = count_references(doc);
    let mut used: HashMap<XoSlot, HashSet<Vec<u8>>> = HashMap::new();
    let mut referrers: HashMap<XoSlot, HashSet<ObjectId>> = HashMap::new();
    let mut tainted: HashSet<XoSlot> = HashSet::new();
    let mut inherited: HashSet<Vec<u8>> = HashSet::new();

    // 1. ページ
    let page_ids: Vec<ObjectId> = doc.page_iter().collect();
    for page_id in page_ids {
        let Ok(page) = doc.get_object(page_id).and_then(|o| o.as_dict()) else {
            continue;
        };
        let names = page_do_names(doc, page);
        match (find_xo_slot(doc, page_id, true), names) {
            (Some((slot, referrer)), Some(n)) => {
                used.entry(slot).or_default().extend(n);
                referrers.entry(slot).or_default().insert(referrer);
            }
            (Some((slot, referrer)), None) => {
                tainted.insert(slot);
                referrers.entry(slot).or_default().insert(referrer);
            }
            (None, Some(n)) => inherited.extend(n),
            (None, None) => {}
        }
    }

    // 2. Form / タイリングパターン / Type3 の CharProcs
    for (id, obj) in doc.objects.iter() {
        match obj {
            Object::Stream(s)
                if matches!(
                    s.dict.get(b"Subtype").ok().and_then(|o| o.as_name().ok()),
                    Some(b"Form")
                ) || s.dict.has(b"PatternType") =>
            {
                let names = stream_do_names(s);
                match (find_xo_slot(doc, *id, false), names) {
                    (Some((slot, referrer)), Some(n)) => {
                        used.entry(slot).or_default().extend(n);
                        referrers.entry(slot).or_default().insert(referrer);
                    }
                    (Some((slot, referrer)), None) => {
                        tainted.insert(slot);
                        referrers.entry(slot).or_default().insert(referrer);
                    }
                    (None, Some(n)) => inherited.extend(n),
                    // 内容が読めず、自前の XObject 辞書も無い: どの名前を
                    // 継承して使うか分からないので、何もしない。
                    (None, None) => return 0,
                }
            }
            Object::Dictionary(d)
                if matches!(
                    d.get(b"Subtype").ok().and_then(|o| o.as_name().ok()),
                    Some(b"Type3")
                ) =>
            {
                let Ok(procs) = d.get(b"CharProcs").map(|o| resolve_dict(doc, o)) else {
                    continue;
                };
                let Some(procs) = procs else { return 0 };
                for (_, v) in procs.iter() {
                    let Ok((_, Object::Stream(s))) = doc.dereference(v) else {
                        return 0;
                    };
                    match stream_do_names(s) {
                        Some(n) => inherited.extend(n),
                        None => return 0,
                    }
                }
            }
            _ => {}
        }
    }

    // 3. 外す対象を決める (まだ書き換えない)
    let mut removals: Vec<(XoSlot, Vec<Vec<u8>>)> = Vec::new();
    for (slot, names) in &used {
        if tainted.contains(slot) {
            continue;
        }
        // 独立した辞書は、把握している持ち主以外から参照されていないこと。
        let shared_ok = match slot {
            XoSlot::Obj(id) | XoSlot::InResObj(id) => {
                let known = referrers.get(slot).map_or(0, |s| s.len());
                refs.get(id).copied().unwrap_or(0) == known
            }
            XoSlot::InHolder(_) => true,
        };
        if !shared_ok {
            continue;
        }
        let dict = match slot {
            XoSlot::Obj(x) => doc.get_object(*x).ok().and_then(as_dict_any),
            XoSlot::InResObj(r) => doc
                .get_object(*r)
                .ok()
                .and_then(as_dict_any)
                .and_then(|d| d.get(b"XObject").ok())
                .and_then(|o| o.as_dict().ok()),
            XoSlot::InHolder(h) => doc
                .get_object(*h)
                .ok()
                .and_then(as_dict_any)
                .and_then(|d| d.get(b"Resources").ok())
                .and_then(|o| o.as_dict().ok())
                .and_then(|d| d.get(b"XObject").ok())
                .and_then(|o| o.as_dict().ok()),
        };
        let Some(dict) = dict else { continue };
        let unused: Vec<Vec<u8>> = dict
            .iter()
            .filter(|(k, v)| {
                matches!(v, Object::Reference(_)) && !names.contains(*k) && !inherited.contains(*k)
            })
            .map(|(k, _)| k.clone())
            .collect();
        if !unused.is_empty() {
            removals.push((*slot, unused));
        }
    }

    // 4. 反映
    let mut removed = 0;
    for (slot, keys) in removals {
        if let Some(dict) = xo_dict_mut(doc, slot) {
            for k in keys {
                if dict.remove(&k).is_some() {
                    removed += 1;
                }
            }
        }
    }
    if removed > 0 {
        // 参照されなくなった画像などを文書から取り除く。
        doc.prune_objects();
    }
    removed
}

/// 全ページの埋め込み画像のうち、実際に見えている範囲だけを残して
/// ピクセルデータを切り詰める。image_recompress::recompress_images の
/// 前段として呼び出すことを想定 (この後で通常の DPI/品質パスを流すと、
/// 正しく縮小された表示サイズを基準に追加のダウンサンプルもかかる)。
///
/// 反映は 3 段階で行い、途中で失敗した画像は元のまま残す:
///   1. 各画像の切り詰め結果を計画する (文書は変更しない)
///   2. 補正 cm を挿入した内容ストリームをすべてメモリ上で作る。失敗した
///      ストリームに使用箇所を持つ画像は計画から外す
///   3. 内容ストリームと画像 (SMask 含む) を一括で書き込む
pub fn crop_to_visible_area(doc: &mut Document, jpeg_quality: u8) -> VisibleCropStats {
    let mut stats = VisibleCropStats::default();
    // 描画に使われない XObject 参照を先に外す (以降の解析対象から無駄な
    // 画像が消え、ファイルにも残らない)。
    stats.xobjects_pruned = prune_unused_xobjects(doc);
    let analysis = analyze(doc);
    let shielded = shielded_images(doc);

    let mut crop_plans: HashMap<ObjectId, Rect> = HashMap::new();
    let mut stub_targets: HashSet<ObjectId> = HashSet::new();

    for xref in analysis.do_sites.keys() {
        stats.images_scanned += 1;
        if analysis.ineligible.contains(xref) || shielded.contains(xref) {
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

    // 1. 計画
    let mut pending: HashMap<ObjectId, PendingCrop> = HashMap::new();
    for (xref, uv) in &crop_plans {
        match plan_crop(doc, *xref, *uv, jpeg_quality) {
            Ok(p) => {
                pending.insert(*xref, p);
            }
            Err(e) => eprintln!("[visible_crop] xref={xref:?}: {e} (skipped, kept original)"),
        }
    }

    // 2. 内容ストリームの書き換えをメモリ上で確定させる。
    let mut rewritten: HashMap<ObjectId, Vec<u8>>;
    loop {
        let mut by_stream: HashMap<ObjectId, HashMap<usize, Matrix>> = HashMap::new();
        for (xref, p) in &pending {
            if let Some(sites) = analysis.do_sites.get(xref) {
                for (stream_id, op_index) in sites {
                    by_stream
                        .entry(*stream_id)
                        .or_default()
                        .insert(*op_index, p.comp);
                }
            }
        }
        rewritten = HashMap::new();
        let mut failed: HashSet<ObjectId> = HashSet::new();
        for (stream_id, targets) in &by_stream {
            match rewrite_stream(doc, *stream_id, targets) {
                Ok(bytes) => {
                    rewritten.insert(*stream_id, bytes);
                }
                Err(e) => {
                    eprintln!("[visible_crop] cm insert failed for stream {stream_id:?}: {e}");
                    failed.insert(*stream_id);
                }
            }
        }
        if failed.is_empty() {
            break;
        }
        pending.retain(|xref, _| {
            !analysis
                .do_sites
                .get(xref)
                .is_some_and(|sites| sites.iter().any(|(sid, _)| failed.contains(sid)))
        });
    }

    // 3. 反映
    for (stream_id, bytes) in rewritten {
        if let Ok(Object::Stream(stream)) = doc.get_object_mut(stream_id) {
            set_flate_content(stream, bytes);
        }
    }
    for (xref, p) in pending {
        match commit_crop(doc, xref, p) {
            Ok(()) => stats.images_cropped += 1,
            Err(e) => eprintln!("[visible_crop] xref={xref:?}: {e}"),
        }
    }

    stats
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    fn raw_rgb(w: usize, h: usize) -> Vec<u8> {
        (0..w * h * 3).map(|i| (i % 251) as u8).collect()
    }

    fn raw_gray(w: usize, h: usize) -> Vec<u8> {
        (0..w * h).map(|i| ((i * 7) % 256) as u8).collect()
    }

    struct Built {
        doc: Document,
        image: ObjectId,
        content: ObjectId,
    }

    /// 1 ページの最小文書を組み立てる。`image_extra` は画像辞書に足すエントリ、
    /// `smask` は (幅, 高さ) を渡すとその寸法の SMask を付ける。
    fn build(
        content: &str,
        (iw, ih): (i64, i64),
        smask: Option<(i64, i64)>,
        image_extra: Vec<(&str, Object)>,
        annot_uses_image: bool,
    ) -> Built {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut img_dict = dictionary! {
            "Type" => "XObject", "Subtype" => "Image",
            "Width" => iw, "Height" => ih,
            "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
        };
        if let Some((mw, mh)) = smask {
            let mask = doc.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image",
                    "Width" => mw, "Height" => mh,
                    "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
                },
                raw_gray(mw as usize, mh as usize),
            ));
            img_dict.set("SMask", Object::Reference(mask));
        }
        for (k, v) in image_extra {
            img_dict.set(k, v);
        }
        let image = doc.add_object(Stream::new(img_dict, raw_rgb(iw as usize, ih as usize)));
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
        let resources = dictionary! { "XObject" => dictionary! { "Im0" => image } };
        let mut page = dictionary! {
            "Type" => "Page", "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 600.into(), 800.into()],
            "Contents" => content_id, "Resources" => resources,
        };
        if annot_uses_image {
            let ap = doc.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Form",
                    "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
                    "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image } },
                },
                b"q 10 0 0 10 0 0 cm /Im0 Do Q".to_vec(),
            ));
            let annot = doc.add_object(dictionary! {
                "Type" => "Annot", "Subtype" => "Stamp",
                "Rect" => vec![0.into(), 0.into(), 10.into(), 10.into()],
                "AP" => dictionary! { "N" => ap },
            });
            page.set("Annots", vec![Object::Reference(annot)]);
        }
        let page_id = doc.add_object(page);
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1,
            }),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", Object::Reference(catalog));
        Built {
            doc,
            image,
            content: content_id,
        }
    }

    fn ops(doc: &Document, content: ObjectId) -> Vec<Operation> {
        let s = doc.get_object(content).unwrap().as_stream().unwrap();
        let bytes = crate::image_recompress::stream_bytes(s).unwrap();
        Content::decode(&bytes).unwrap().operations
    }

    fn image_wh(doc: &Document, id: ObjectId) -> (i64, i64) {
        let d = &doc.get_object(id).unwrap().as_stream().unwrap().dict;
        (
            d.get(b"Width").unwrap().as_i64().unwrap(),
            d.get(b"Height").unwrap().as_i64().unwrap(),
        )
    }

    const CLIPPED: &str = "q 100 200 300 250 re W* n q 600 0 0 800 0 0 cm /Im0 Do Q Q";

    /// 補正行列は、切り出した整数画素矩形とぴったり対応する
    /// (a*W, d*H, 左端・上端の画素位置がすべて整数になる)。
    #[test]
    fn compensation_matches_integer_pixel_rect() {
        let mut b = build(CLIPPED, (605, 807), None, vec![], false);
        let st = crop_to_visible_area(&mut b.doc, 90);
        assert_eq!(st.images_cropped, 1);
        let (w, h) = image_wh(&b.doc, b.image);
        let o = ops(&b.doc, b.content);
        let i = o.iter().position(|op| op.operator == "Do").unwrap();
        assert_eq!(o[i - 2].operator, "q");
        assert_eq!(o[i - 1].operator, "cm");
        assert_eq!(o[i + 1].operator, "Q");
        let m: Vec<f64> = o[i - 1].operands.iter().map(obj_to_f64).collect();
        let (nw, nh) = (605.0, 807.0);
        let near_int = |x: f64| (x - x.round()).abs() < 1e-4;
        assert!(near_int(m[0] * nw) && (m[0] * nw - w as f64).abs() < 1e-4);
        assert!(near_int(m[3] * nh) && (m[3] * nh - h as f64).abs() < 1e-4);
        assert!(
            near_int(m[4] * nw),
            "left edge not on pixel grid: {}",
            m[4] * nw
        );
        let row0 = (1.0 - m[5] - m[3]) * nh;
        assert!(near_int(row0), "top edge not on pixel grid: {row0}");
        assert!(m[1] == 0.0 && m[2] == 0.0);
    }

    /// Do が自前の q/Q の外にあっても、補正が後続の描画に漏れない。
    #[test]
    fn compensation_does_not_leak_without_own_q() {
        let c = "q 100 200 300 250 re W* n 600 0 0 800 0 0 cm /Im0 Do 0 0 1 rg 1 1 5 5 re f Q";
        let mut b = build(c, (605, 807), None, vec![], false);
        assert_eq!(crop_to_visible_area(&mut b.doc, 90).images_cropped, 1);
        let o = ops(&b.doc, b.content);
        let i = o.iter().position(|op| op.operator == "Do").unwrap();
        assert_eq!(o[i - 2].operator, "q");
        assert_eq!(o[i + 1].operator, "Q");
        let depth = o.iter().fold(0i32, |d, op| match op.operator.as_str() {
            "q" => d + 1,
            "Q" => d - 1,
            _ => d,
        });
        assert_eq!(depth, 0, "q/Q must stay balanced");
    }

    /// SMask は本体と同じ窓で切り出される (同じ画素格子の場合は画素単位で一致)。
    #[test]
    fn smask_same_grid_is_cropped_pixel_exact() {
        let mut b = build(CLIPPED, (605, 807), Some((605, 807)), vec![], false);
        let before_mask = {
            let d = &b.doc.get_object(b.image).unwrap().as_stream().unwrap().dict;
            d.get(b"SMask").unwrap().as_reference().unwrap()
        };
        assert_eq!(crop_to_visible_area(&mut b.doc, 90).images_cropped, 1);
        let (w, h) = image_wh(&b.doc, b.image);
        let d = &b.doc.get_object(b.image).unwrap().as_stream().unwrap().dict;
        let new_mask = d.get(b"SMask").unwrap().as_reference().unwrap();
        assert_ne!(new_mask, before_mask, "mask must be a new object");
        assert_eq!(image_wh(&b.doc, new_mask), (w, h));
        // 元のマスクは共有者のために無傷で残る
        assert_eq!(image_wh(&b.doc, before_mask), (605, 807));
        // 画素の対応を確認: 新マスク(i,j) == 元マスク(i+col0, j+row0)
        let o = ops(&b.doc, b.content);
        let i = o.iter().position(|op| op.operator == "Do").unwrap();
        let m: Vec<f64> = o[i - 1].operands.iter().map(obj_to_f64).collect();
        let col0 = (m[4] * 605.0).round() as usize;
        let row0 = ((1.0 - m[5] - m[3]) * 807.0).round() as usize;
        let src = raw_gray(605, 807);
        let ms = b.doc.get_object(new_mask).unwrap().as_stream().unwrap();
        let got = crate::image_recompress::stream_bytes(ms).unwrap();
        for (x, y) in [(0usize, 0usize), (3, 5), (w as usize - 1, h as usize - 1)] {
            assert_eq!(got[y * w as usize + x], src[(y + row0) * 605 + x + col0]);
        }
    }

    /// 画素格子が違うマスクは、窓の両端が本体と一致するように取り直される。
    #[test]
    fn smask_different_grid_spans_same_window() {
        let mut b = build(CLIPPED, (605, 807), Some((321, 321)), vec![], false);
        assert_eq!(crop_to_visible_area(&mut b.doc, 90).images_cropped, 1);
        let d = &b.doc.get_object(b.image).unwrap().as_stream().unwrap().dict;
        let new_mask = d.get(b"SMask").unwrap().as_reference().unwrap();
        let (mw, mh) = image_wh(&b.doc, new_mask);
        let (w, h) = image_wh(&b.doc, b.image);
        // 本体が窓の W/605 を占めるなら、マスクは約 (W/605)*321 画素になる
        let exp_w = w as f64 / 605.0 * 321.0;
        let exp_h = h as f64 / 807.0 * 321.0;
        assert!((mw as f64 - exp_w).abs() <= 0.51, "{mw} vs {exp_w}");
        assert!((mh as f64 - exp_h).abs() <= 0.51, "{mh} vs {exp_h}");
    }

    /// 対応できないマスク (/Mask) 付きの画像は切り詰めない。
    #[test]
    fn unsupported_mask_is_left_alone() {
        let mut b = build(
            CLIPPED,
            (605, 807),
            None,
            vec![(
                "Mask",
                Object::Array(vec![
                    0.into(),
                    0.into(),
                    0.into(),
                    0.into(),
                    0.into(),
                    0.into(),
                ]),
            )],
            false,
        );
        let before = ops(&b.doc, b.content).len();
        assert_eq!(crop_to_visible_area(&mut b.doc, 90).images_cropped, 0);
        assert_eq!(image_wh(&b.doc, b.image), (605, 807));
        assert_eq!(ops(&b.doc, b.content).len(), before);
    }

    /// 削減量が小さい辺 (ここでは左端の約 5px) は切らず、原本の辺のまま残す。
    /// 大きく削れる辺 (上下) だけが新しい辺になる。
    #[test]
    fn small_edge_trim_keeps_original_edge() {
        let c = "q 5 200 595 250 re W* n q 600 0 0 800 0 0 cm /Im0 Do Q Q";
        let mut b = build(c, (605, 807), None, vec![], false);
        assert_eq!(crop_to_visible_area(&mut b.doc, 90).images_cropped, 1);
        let (w, h) = image_wh(&b.doc, b.image);
        assert_eq!(w, 605, "left/right trims are tiny, so the width stays");
        assert!(h < 807 / 2, "rows are cut a lot: {h}");
        let o = ops(&b.doc, b.content);
        let i = o.iter().position(|op| op.operator == "Do").unwrap();
        let m: Vec<f64> = o[i - 1].operands.iter().map(obj_to_f64).collect();
        assert_eq!(m[4], 0.0, "left edge is the original edge");
        assert!((m[0] - 1.0).abs() < 1e-9);
    }

    /// 削減がごく僅かなら、何も切らない。
    #[test]
    fn tiny_overall_saving_is_skipped() {
        let c = "q 3 3 594 794 re W* n q 600 0 0 800 0 0 cm /Im0 Do Q Q";
        let mut b = build(c, (605, 807), None, vec![], false);
        assert_eq!(crop_to_visible_area(&mut b.doc, 90).images_cropped, 0);
        assert_eq!(image_wh(&b.doc, b.image), (605, 807));
    }

    /// JPEG は、MCU 格子に外側へ揃えて無劣化で切り出される: 切り出し後の画素は
    /// 元画像の同じ位置の画素と完全に一致する (再エンコードの劣化がない)。
    #[test]
    fn jpeg_is_cropped_losslessly_on_mcu_grid() {
        use image::codecs::jpeg::JpegEncoder;
        use image::{ColorType, ImageEncoder};
        let (iw, ih) = (605usize, 807usize);
        let rgb = raw_rgb(iw, ih);
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 88)
            .write_image(&rgb, iw as u32, ih as u32, ColorType::Rgb8.into())
            .unwrap();
        let geo = crate::jpeg_lossless::jpeg_geometry(&jpeg).unwrap();
        let mut b = build(CLIPPED, (iw as i64, ih as i64), None, vec![], false);
        b.doc.objects.insert(
            b.image,
            Object::Stream(Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image",
                    "Width" => iw as i64, "Height" => ih as i64,
                    "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
                    "Filter" => "DCTDecode",
                },
                jpeg.clone(),
            )),
        );
        // 既定 (Force) では無劣化が選ばれる (目標品質 95 は元 (88) より高いので、
        // "auto" でも無劣化のほうが小さい)。
        assert_eq!(crop_to_visible_area(&mut b.doc, 95).images_cropped, 1);
        let (w, h) = image_wh(&b.doc, b.image);
        let o = ops(&b.doc, b.content);
        let i = o.iter().position(|op| op.operator == "Do").unwrap();
        let m: Vec<f64> = o[i - 1].operands.iter().map(obj_to_f64).collect();
        let col0 = (m[4] * iw as f64).round() as u32;
        let row0 = ((1.0 - m[5] - m[3]) * ih as f64).round() as u32;
        assert_eq!(col0 % geo.mcu_w, 0, "left edge is on the MCU grid");
        assert_eq!(row0 % geo.mcu_h, 0, "top edge is on the MCU grid");
        let st = b.doc.get_object(b.image).unwrap().as_stream().unwrap();
        let before = image::load_from_memory_with_format(&jpeg, image::ImageFormat::Jpeg)
            .unwrap()
            .to_rgb8();
        let after = image::load_from_memory_with_format(&st.content, image::ImageFormat::Jpeg)
            .unwrap()
            .to_rgb8();
        assert_eq!((after.width() as i64, after.height() as i64), (w, h));
        for (x, y) in [(0u32, 0u32), (7, 9), (w as u32 - 1, h as u32 - 1), (w as u32 / 2, h as u32 / 2)] {
            assert_eq!(after.get_pixel(x, y), before.get_pixel(x + col0, y + row0), "px {x},{y}");
        }
    }

    /// 高品質 (98) の JPEG を目標品質 40 で切り詰め、切り出し開始列と MCU 幅を返す。
    /// 再エンコードのほうが小さくなる条件 (元が高品質で、目標品質が低い)。
    fn crop_hq_jpeg_with_low_target() -> (u32, u32) {
        use image::codecs::jpeg::JpegEncoder;
        use image::{ColorType, ImageEncoder};
        let (iw, ih) = (605usize, 807usize);
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 98)
            .write_image(&raw_rgb(iw, ih), iw as u32, ih as u32, ColorType::Rgb8.into())
            .unwrap();
        let geo = crate::jpeg_lossless::jpeg_geometry(&jpeg).unwrap();
        let mut b = build(CLIPPED, (iw as i64, ih as i64), None, vec![], false);
        b.doc.objects.insert(
            b.image,
            Object::Stream(Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image",
                    "Width" => iw as i64, "Height" => ih as i64,
                    "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
                    "Filter" => "DCTDecode",
                },
                jpeg,
            )),
        );
        assert_eq!(crop_to_visible_area(&mut b.doc, 40).images_cropped, 1);
        let o = ops(&b.doc, b.content);
        let i = o.iter().position(|op| op.operator == "Do").unwrap();
        let m: Vec<f64> = o[i - 1].operands.iter().map(obj_to_f64).collect();
        ((m[4] * iw as f64).round() as u32, geo.mcu_w)
    }

    /// 既定は無劣化: 再エンコードのほうが小さくなる条件でも、MCU 格子に揃えて
    /// 無劣化で切り出す (ダウンサンプリング・再圧縮は別オプション)。
    #[test]
    fn default_is_lossless_even_when_reencode_is_smaller() {
        let (col0, mcu_w) = crop_hq_jpeg_with_low_target();
        assert_eq!(col0 % mcu_w, 0, "lossless start column is on the MCU grid: {col0}");
    }

    /// "auto" では、再エンコードのほうが小さければそちらを選ぶ (切り出し位置は
    /// MCU 格子に揃えず、従来どおりの画素矩形)。
    #[test]
    fn auto_prefers_reencode_when_it_is_smaller() {
        MODE_OVERRIDE.with(|c| c.set(Some(LosslessMode::Auto)));
        let (col0, mcu_w) = crop_hq_jpeg_with_low_target();
        assert_ne!(col0 % mcu_w, 0, "re-encode keeps the plain pixel rect: {col0}");
    }

    /// "0" では、無劣化にできる JPEG でも常に再エンコードする。
    #[test]
    fn never_always_reencodes() {
        MODE_OVERRIDE.with(|c| c.set(Some(LosslessMode::Never)));
        let (col0, mcu_w) = crop_hq_jpeg_with_low_target();
        assert_ne!(col0 % mcu_w, 0, "re-encode keeps the plain pixel rect: {col0}");
    }

    /// 注釈の外観など、解析が辿らない場所からも使われる画像は切り詰めない。
    #[test]
    fn image_used_outside_walked_content_is_shielded() {
        let mut b = build(CLIPPED, (605, 807), None, vec![], true);
        assert_eq!(crop_to_visible_area(&mut b.doc, 90).images_cropped, 0);
        assert_eq!(image_wh(&b.doc, b.image), (605, 807));
    }

    /// 完全に不可視の画像はプレースホルダになり、マスクも外れる。
    #[test]
    fn invisible_image_stub_drops_masks() {
        let c = "q 0 0 10 10 re W* n q 100 0 0 100 300 300 cm /Im0 Do Q Q";
        let mut b = build(c, (200, 200), Some((200, 200)), vec![], false);
        let st = crop_to_visible_area(&mut b.doc, 90);
        assert_eq!(st.images_stubbed, 1);
        let d = &b.doc.get_object(b.image).unwrap().as_stream().unwrap().dict;
        assert!(!d.has(b"SMask") && !d.has(b"Mask"));
        assert_eq!(image_wh(&b.doc, b.image), (1, 1));
    }

    /// ページ端からはみ出して置かれた画像の、細い帯だけが見えている場合は、
    /// 不可視扱いでプレースホルダにせず、その帯を残して切り詰める
    /// (面積比は 2% 未満でも、帯の縦方向は全面が見えている)。
    #[test]
    fn thin_visible_strip_is_cropped_not_stubbed() {
        // 画像は x=-1160..25 に置かれ、クリップ (x=0..600) から見えるのは右端約 2% のみ。
        let c = "q 0 0 600 800 re W* n q 1185 0 0 1185 -1160 100 cm /Im0 Do Q Q";
        let mut b = build(c, (800, 800), Some((800, 800)), vec![], false);
        let st = crop_to_visible_area(&mut b.doc, 90);
        assert_eq!(st.images_stubbed, 0, "visible strip must not become a 1x1 stub");
        assert_eq!(st.images_cropped, 1);
        let (w, h) = image_wh(&b.doc, b.image);
        assert!(w >= 17 && w < 800, "strip width kept: {w}");
        assert!(h > 1, "strip height kept: {h}");
        // SMask も同じ窓で切り出され、本体と同じ寸法になる。
        let d = &b.doc.get_object(b.image).unwrap().as_stream().unwrap().dict;
        let mask = d.get(b"SMask").unwrap().as_reference().unwrap();
        assert_eq!(image_wh(&b.doc, mask), (w, h));
    }

    /// 上下反転した配置 (d < 0) でも、切り詰め後に同じ範囲が見える。
    #[test]
    fn flipped_placement_keeps_visible_window() {
        let c = "q 100 200 300 250 re W* n q 600 0 0 -800 0 800 cm /Im0 Do Q Q";
        let mut b = build(c, (605, 807), None, vec![], false);
        assert_eq!(crop_to_visible_area(&mut b.doc, 90).images_cropped, 1);
        let o = ops(&b.doc, b.content);
        let i = o.iter().position(|op| op.operator == "Do").unwrap();
        let m: Vec<f64> = o[i - 1].operands.iter().map(obj_to_f64).collect();
        // 補正後の画像が占めるローカル UV 窓が、可視範囲 (クリップ矩形) を
        // 少なくとも覆う。y は d<0 なので v = (800 - y) / 800。
        let (u0, u1) = (m[4], m[4] + m[0]);
        let (v0, v1) = (m[5], m[5] + m[3]);
        assert!(u0 <= 100.0 / 600.0 && u1 >= 400.0 / 600.0, "u {u0}..{u1}");
        assert!(
            v0 <= (800.0 - 450.0) / 800.0 && v1 >= (800.0 - 200.0) / 800.0,
            "v {v0}..{v1}"
        );
    }

    // ---- 未使用 XObject 参照の整理 ----

    struct PruneDoc {
        doc: Document,
        im0: ObjectId,
        im1: ObjectId,
    }

    /// 画像 Im0/Im1 (と、`form_content` があれば自前のリソースを持たない
    /// Form Fm0) を /XObject に並べたページを作る。
    fn build_prune(
        content: &str,
        form_content: Option<&str>,
        indirect_res: bool,
        annot_shares_res: bool,
    ) -> PruneDoc {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let img = |doc: &mut Document| {
            doc.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image", "Width" => 10, "Height" => 10,
                    "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
                },
                vec![0u8; 100],
            ))
        };
        let im0 = img(&mut doc);
        let im1 = img(&mut doc);
        let mut xo = dictionary! { "Im0" => im0, "Im1" => im1 };
        if let Some(fc) = form_content {
            let fm = doc.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Form",
                    "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
                },
                fc.as_bytes().to_vec(),
            ));
            xo.set("Fm0", Object::Reference(fm));
        }
        let resources = dictionary! { "XObject" => xo };
        let cid = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
        let mut page = dictionary! {
            "Type" => "Page", "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 600.into(), 800.into()],
            "Contents" => cid,
        };
        let res_ref = if indirect_res {
            let r = doc.add_object(resources.clone());
            page.set("Resources", Object::Reference(r));
            Some(r)
        } else {
            page.set("Resources", resources);
            None
        };
        if annot_shares_res {
            let r = res_ref.expect("annot sharing needs indirect resources");
            let ap = doc.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Form",
                    "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
                    "Resources" => Object::Reference(r),
                },
                b"q /Im1 Do Q".to_vec(),
            ));
            let annot = doc.add_object(dictionary! {
                "Type" => "Annot", "Subtype" => "Stamp",
                "Rect" => vec![0.into(), 0.into(), 10.into(), 10.into()],
                "AP" => dictionary! { "N" => ap },
            });
            page.set("Annots", vec![Object::Reference(annot)]);
        }
        let page_id = doc.add_object(page);
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1,
            }),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", Object::Reference(catalog));
        PruneDoc { doc, im0, im1 }
    }

    fn xobject_names(doc: &Document) -> Vec<String> {
        let pid = doc.page_iter().next().unwrap();
        let res = resolve_resources(doc, pid).unwrap();
        let xo = resolve_dict(doc, res.get(b"XObject").unwrap()).unwrap();
        let mut v: Vec<String> = xo
            .iter()
            .map(|(k, _)| String::from_utf8_lossy(k).into_owned())
            .collect();
        v.sort();
        v
    }

    /// Do されない参照だけが外れ、画像オブジェクトも文書から消える。
    #[test]
    fn prune_removes_only_unused_entries() {
        let mut b = build_prune("q 10 0 0 10 0 0 cm /Im0 Do Q", None, false, false);
        assert_eq!(prune_unused_xobjects(&mut b.doc), 1);
        assert_eq!(xobject_names(&b.doc), vec!["Im0"]);
        assert!(b.doc.get_object(b.im0).is_ok());
        assert!(
            b.doc.get_object(b.im1).is_err(),
            "unused image must be dropped"
        );
    }

    /// 独立した Resources でも同じ (Resources を指すのがページだけの場合)。
    #[test]
    fn prune_works_with_indirect_resources() {
        let mut b = build_prune("q /Im1 Do Q", None, true, false);
        assert_eq!(prune_unused_xobjects(&mut b.doc), 1);
        assert_eq!(xobject_names(&b.doc), vec!["Im1"]);
    }

    /// 注釈の外観など、ページ以外からも参照されている辞書には触らない。
    #[test]
    fn prune_skips_resources_shared_with_other_objects() {
        let mut b = build_prune("q /Im0 Do Q", None, true, true);
        assert_eq!(prune_unused_xobjects(&mut b.doc), 0);
        assert_eq!(xobject_names(&b.doc), vec!["Im0", "Im1"]);
        assert!(b.doc.get_object(b.im1).is_ok());
    }

    /// 自前のリソースを持たない Form が Do する名前は、継承されたリソースを
    /// 使う可能性があるので残す。
    #[test]
    fn prune_keeps_names_used_by_forms_without_resources() {
        let mut b = build_prune("q /Fm0 Do Q", Some("q /Im1 Do Q"), false, false);
        assert_eq!(prune_unused_xobjects(&mut b.doc), 1);
        assert_eq!(xobject_names(&b.doc), vec!["Fm0", "Im1"]);
        assert!(b.doc.get_object(b.im0).is_err());
        assert!(b.doc.get_object(b.im1).is_ok());
    }

    /// crop_to_visible_area の一部として実行され、統計に反映される。
    #[test]
    fn crop_to_visible_area_reports_pruned_entries() {
        let mut b = build_prune("q 10 0 0 10 0 0 cm /Im0 Do Q", None, false, false);
        let st = crop_to_visible_area(&mut b.doc, 90);
        assert_eq!(st.xobjects_pruned, 1);
    }
}
