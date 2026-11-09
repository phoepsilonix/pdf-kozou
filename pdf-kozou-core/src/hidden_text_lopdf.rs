// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/hidden_text_lopdf.rs
// 隠しテキスト (後から描かれた物の下に埋もれた文字) の検出と無害化の lopdf 実装。MuPDF を使わない。
//
// 画像変換 (テキスト保持版) の前処理 (compress::strip_fully_buried_text_for_keep_text) と、
// 部分的に隠れた文字があるページの判定 (compress::partially_covered_pages) 用。
// MuPDF 実装 (C の kozou_detect_buried_text + kozou_sanitize_hidden_text) は、検出が返す座標を
// 無害化が内容ストリームの中から探し直す 2 段構えだが、こちらは内容ストリームを 1 回走査して、
// 検出と書き換えを同じ場所で行う (座標の照合が要らない)。
//
// ── 検出 ──
// 内容ストリーム (ページと、Do で呼ばれる Form XObject の中) を描画順にたどり、
//   ・文字 (1 文字ごとの外接矩形。フォントの幅と Ascent/Descent から)
//   ・覆い (塗り・画像の外接矩形)
// を並べる。ある文字が、あとから描かれた「不透明な覆い」に覆われる割合が閾値以上なら、
// その文字を「埋もれている」とみなす。
//
// 覆いと認めるもの (すべて満たすとき):
//   ・単一の軸平行な矩形の塗り (re、または m l l l h の閉じた矩形)、または SMask / Mask の無い画像
//   ・塗りの不透明度 (ca) が 1、ブレンドモードが Normal、ソフトマスク無し、塗りがパターンでない
//   ・クリップが軸平行な矩形だけ (非矩形のクリップの下では、覆いの形が分からない)
//   ・不透明度の指定された透明グループの中でない
// 覆いと認めないもの (残す側に倒す): 曲線を含むパス、線 (S)、シェーディング、半透明のもの。
// 後から描かれた文字による覆いは数えない (同じ文字を重ねて太く見せる表現を壊さないため)。
//
// 検出する文字は、描画モードが塗り/線 (Tr 0〜2) で、不透明度が半分以上のものだけ。
// 不可視 (Tr 3) の文字は、OCR のテキスト層として残すべきものなので、対象にしない。
//
// ── 無害化 ──
// 埋もれていると判定した文字だけを、Tj / TJ の文字列から取り除く。取り除いた文字の送り幅は
// TJ の位置調整で同じだけ進めるので、続く文字の位置は変わらない (crop_redact_lopdf と同じ手法)。
// フォントも、他の文字も、他の演算子も変えない。
//
// Form XObject は、呼ばれるたびに CTM が違いうるので、呼び出しごとに判定して集計し、
// 「全ての呼び出しで埋もれている」文字だけを取り除く。さらに安全側に倒すため、次のときは
// Form の中の文字を取り除かない (ページの内容ストリームの文字だけを取り除く):
//   ・解析できないページ (インライン画像・読めない/壊れた内容ストリーム・深すぎる入れ子など) がある
//   ・その Form を指す参照が文書内に 1 つだけでない (注釈・パターンなど、走査していない所から
//     呼ばれている可能性がある)
//
// 解析できないページは、書き換えず、「部分的に隠れた文字があるかもしれない」ページとして扱う。
// 暗号化された入力は Err。呼び出し側が MuPDF 実装へフォールバックする。

use crate::crop_redact_lopdf::{
    FontInfo, IDENT, Mat, Rect, Widths, XKind, apply, deref, dict_of, inherited, load_font,
    load_xobject, mat_of, mul, num, num_deref, operand_nums, parse_box, sub_dict, transform_rect,
};
use crate::tounicode_lopdf::UniMap;
use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId, StringFormat};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Form XObject の中へ入る深さの上限
const MAX_FORM_DEPTH: usize = 8;
const CONTENT_LIMIT: usize = 512 * 1024 * 1024;
/// 1 ページで扱う文字・覆いの数の上限 (超えたら解析できないページとして扱う)
const MAX_GLYPHS: usize = 300_000;
const MAX_COVERS: usize = 100_000;
/// 文字と覆いの組み合わせの数の上限 (計算量の歯止め)
const MAX_PAIRS: u128 = 800_000_000;
/// 覆われ率の計算に使う覆いの数の上限 (超えた分は無視する = 覆われ率を低く見る = 残す側)
const MAX_COVERS_PER_GLYPH: usize = 96;
/// 外接矩形の比較の許容誤差 (pt)
const EPS: f64 = 0.01;
/// 部分的に隠れた文字の探索 (probe) で、塗りを覆いと数える最小の太さ (pt)。表の罫線のような
/// 細い塗りは数えない
const PROBE_MIN_THICKNESS: f64 = 1.0;
/// probe で、塗り・画像を覆いと数える最小の不透明度
const PROBE_MIN_ALPHA: f64 = 0.02;
/// 文字そのものの不透明度がこれ未満のものは「透明な文字」で、埋もれた文字とは別物 (残す)
const MIN_TEXT_ALPHA: f64 = 0.5;

// ── 結果 ──────────────────────────────────────────────────────────────────

/// 文字の位置: (内容ストリーム, 演算子の番号, その演算子の中での文字の番号)
type Key = (ObjectId, usize, usize);

/// 取り除く候補の文字ごとの集計
#[derive(Clone, Copy, Debug)]
struct Vote {
    /// 埋もれていると判定された呼び出しの数
    buried: u32,
    /// 判定した呼び出しの数
    total: u32,
    /// 取り除いたあとに送り幅を保つ TJ の位置調整の値
    adj: f64,
    /// 1 文字のバイト数 (1 または 2)
    code_len: u8,
    /// 呼び出しごとに adj / code_len が食い違った (取り除かない)
    inconsistent: bool,
}

/// 解析の結果
#[derive(Debug, Default)]
pub(crate) struct Analysis {
    /// 取り除く文字: 内容ストリーム → 演算子の番号 → (文字の番号 → (位置調整, 1 文字のバイト数))
    removals: BTreeMap<ObjectId, BTreeMap<usize, BTreeMap<usize, (f64, u8)>>>,
    /// 取り除く文字の数
    pub(crate) removed_glyphs: usize,
    /// 部分的に隠れた文字がある (probe_ratio 以上の割合で、あとから描かれた物に覆われる文字が
    /// ある)、または解析できなかったページ (1 ベース)
    pub(crate) probe_pages: Vec<i32>,
    /// 解析できなかったページと理由 (1 ベースのページ番号, 理由)
    pub(crate) unsupported: Vec<(i32, String)>,
}

impl Analysis {
    pub(crate) fn has_removals(&self) -> bool {
        self.removed_glyphs > 0
    }
}

// ── 幾何 ──────────────────────────────────────────────────────────────────

fn rect_area(r: &Rect) -> f64 {
    ((r.x1 - r.x0).max(0.0)) * ((r.y1 - r.y0).max(0.0))
}

fn intersect(a: &Rect, b: &Rect) -> Option<Rect> {
    let r = Rect {
        x0: a.x0.max(b.x0),
        y0: a.y0.max(b.y0),
        x1: a.x1.min(b.x1),
        y1: a.y1.min(b.y1),
    };
    (r.x1 > r.x0 && r.y1 > r.y0).then_some(r)
}

fn overlaps(a: &Rect, b: &Rect) -> bool {
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

/// `g` のうち、`covers` (のどれか) に覆われている面積の割合 (0.0〜1.0)
fn covered_fraction(g: &Rect, covers: &[Rect]) -> f64 {
    let ga = rect_area(g);
    if ga <= 0.0 || covers.is_empty() {
        return 0.0;
    }
    let mut parts: Vec<Rect> = Vec::new();
    for c in covers {
        if let Some(i) = intersect(g, c) {
            // 1 つで全体を覆う
            if i.x0 <= g.x0 + EPS && i.y0 <= g.y0 + EPS && i.x1 >= g.x1 - EPS && i.y1 >= g.y1 - EPS
            {
                return 1.0;
            }
            parts.push(i);
        }
    }
    if parts.is_empty() {
        return 0.0;
    }
    // x 方向の区間ごとに、y 方向の和集合の長さを足す
    let mut xs: Vec<f64> = parts.iter().flat_map(|r| [r.x0, r.x1]).collect();
    xs.sort_by(f64::total_cmp);
    xs.dedup();
    let mut area = 0.0;
    for w in xs.windows(2) {
        let (xa, xb) = (w[0], w[1]);
        if xb - xa <= 0.0 {
            continue;
        }
        let mut ys: Vec<(f64, f64)> = parts
            .iter()
            .filter(|r| r.x0 <= xa && r.x1 >= xb)
            .map(|r| (r.y0, r.y1))
            .collect();
        if ys.is_empty() {
            continue;
        }
        ys.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut len = 0.0;
        let (mut cs, mut ce) = ys[0];
        for &(s, e) in &ys[1..] {
            if s > ce {
                len += ce - cs;
                cs = s;
                ce = e;
            } else if e > ce {
                ce = e;
            }
        }
        len += ce - cs;
        area += len * (xb - xa);
    }
    (area / ga).clamp(0.0, 1.0)
}

/// 変換 `m` が軸に平行な矩形を軸平行な矩形に写すか (回転・せん断が無い。90 度刻みの回転は可)
fn is_axis_aligned(m: &Mat) -> bool {
    let tiny = |v: f64| v.abs() < 1e-6;
    (tiny(m[1]) && tiny(m[2])) || (tiny(m[0]) && tiny(m[3]))
}

// ── フォント ──────────────────────────────────────────────────────────────

struct HFont {
    info: FontInfo,
    /// 文字の外接矩形の上端・下端 (em 単位。下端は負または 0)
    asc: f64,
    desc: f64,
    /// 1 文字のバイト数 (Simple = 1, Cid = 2)
    code_len: u8,
    /// 文字コード → Unicode
    uni: UniMap,
    is_type3: bool,
}

/// FontDescriptor から (Ascent, Descent) を em 単位で読む。無い・不正なら既定値
fn descriptor_extent(doc: &Document, desc: Option<&Dictionary>) -> (f64, f64) {
    const DEF: (f64, f64) = (0.8, -0.2);
    let Some(d) = desc else { return DEF };
    let a = d
        .get(b"Ascent")
        .ok()
        .and_then(|o| num_deref(doc, o))
        .map(|v| v / 1000.0);
    let b = d
        .get(b"Descent")
        .ok()
        .and_then(|o| num_deref(doc, o))
        .map(|v| -(v.abs()) / 1000.0);
    match (a, b) {
        (Some(a), Some(b)) if (0.3..=1.6).contains(&a) && (-0.8..=0.0).contains(&b) => (a, b),
        _ => DEF,
    }
}

fn load_hfont(doc: &Document, font: &Dictionary) -> Option<HFont> {
    let subtype = font
        .get(b"Subtype")
        .ok()
        .and_then(|o| deref(doc, o).as_name().ok())?;
    if subtype == b"Type3" {
        // 幅は文字空間の値。FontMatrix の x 倍率で、1/1000 テキスト空間の単位に直す
        let fm: Vec<f64> = deref(doc, font.get(b"FontMatrix").ok()?)
            .as_array()
            .ok()?
            .iter()
            .map(|o| num_deref(doc, o))
            .collect::<Option<_>>()?;
        if fm.len() != 6 || fm[1].abs() > 1e-9 || fm[2].abs() > 1e-9 || fm[0] <= 0.0 {
            return None;
        }
        let first = num_deref(doc, font.get(b"FirstChar").ok()?)? as i64;
        let widths: Vec<f64> = deref(doc, font.get(b"Widths").ok()?)
            .as_array()
            .ok()?
            .iter()
            .map(|o| num_deref(doc, o).map(|w| w * fm[0] * 1000.0))
            .collect::<Option<_>>()?;
        let (mut asc, mut desc) = (0.8, -0.2);
        if let Some(bb) = font
            .get(b"FontBBox")
            .ok()
            .and_then(|o| deref(doc, o).as_array().ok())
        {
            let v: Vec<f64> = bb.iter().filter_map(|o| num_deref(doc, o)).collect();
            if v.len() == 4 && fm[3] > 0.0 {
                let top = v[1].max(v[3]) * fm[3];
                let bottom = v[1].min(v[3]) * fm[3];
                if (0.2..=2.0).contains(&top) && (-1.0..=0.0).contains(&bottom) {
                    asc = top;
                    desc = bottom;
                }
            }
        }
        return Some(HFont {
            info: FontInfo {
                widths: Widths::Simple {
                    first,
                    widths,
                    missing: 0.0,
                },
                glyph_em: 1.0,
            },
            asc,
            desc,
            code_len: 1,
            uni: crate::tounicode_lopdf::build(doc, font),
            is_type3: true,
        });
    }
    let info = load_font(doc, font)?;
    let desc_dict = if subtype == b"Type0" {
        deref(doc, font.get(b"DescendantFonts").ok()?)
            .as_array()
            .ok()
            .and_then(|a| a.first())
            .and_then(|o| dict_of(doc, o))
            .and_then(|cid| sub_dict(doc, cid, b"FontDescriptor"))
    } else {
        sub_dict(doc, font, b"FontDescriptor")
    };
    let (asc, desc) = descriptor_extent(doc, desc_dict);
    let code_len = match info.widths {
        Widths::Simple { .. } => 1,
        Widths::Cid { .. } => 2,
    };
    Some(HFont {
        info,
        asc,
        desc,
        code_len,
        uni: crate::tounicode_lopdf::build(doc, font),
        is_type3: false,
    })
}

/// 文字コード 1 つの幅 (1/1000 テキスト空間)
fn code_width(f: &FontInfo, code: u32) -> f64 {
    match &f.widths {
        Widths::Simple {
            first,
            widths,
            missing,
        } => {
            let idx = i64::from(code) - first;
            usize::try_from(idx)
                .ok()
                .and_then(|i| widths.get(i))
                .copied()
                .unwrap_or(*missing)
        }
        Widths::Cid { dw, w } => w.get(&code).copied().unwrap_or(*dw),
    }
}

// ── 走査 ──────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct St {
    ctm: Mat,
    font: Option<Vec<u8>>,
    size: f64,
    tc: f64,
    tw: f64,
    /// 水平スケール (Tz / 100)
    th: f64,
    tl: f64,
    trise: f64,
    tr: i64,
    /// 塗りの不透明度 (ca)
    ca: f64,
    /// ExtGState のソフトマスクが有効
    smask: bool,
    /// ブレンドモードが Normal
    bm_normal: bool,
    /// 塗りがパターン
    fill_pattern: bool,
    /// クリップの外接矩形 (None = 制限なし)
    clip: Option<Rect>,
    /// クリップが軸平行な矩形そのもの (外接矩形と一致する)
    clip_exact: bool,
    /// 不透明度の指定された透明グループの中でない (覆いを不透明と認められる)
    opaque_ok: bool,
    /// 塗りの色空間 (成分数が分かるものだけ)
    fill_cs: Cs,
    /// 塗りの色 (RGB)。分からなければ None
    fill_rgb: Option<[u8; 3]>,
}

/// 塗りの色空間
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Cs {
    Gray,
    Rgb,
    Cmyk,
    /// Indexed / Separation / DeviceN / Lab / Pattern など (色を RGB にできない)
    Other,
}

fn to_u8(v: f64) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// 色空間と成分から RGB を求める (CMYK は単純な換算)
fn rgb_of(cs: Cs, v: &[f64]) -> Option<[u8; 3]> {
    match (cs, v.len()) {
        (Cs::Gray, 1) => Some([to_u8(v[0]); 3]),
        (Cs::Rgb, 3) => Some([to_u8(v[0]), to_u8(v[1]), to_u8(v[2])]),
        (Cs::Cmyk, 4) => {
            let k = 1.0 - v[3].clamp(0.0, 1.0);
            Some([
                to_u8((1.0 - v[0].clamp(0.0, 1.0)) * k),
                to_u8((1.0 - v[1].clamp(0.0, 1.0)) * k),
                to_u8((1.0 - v[2].clamp(0.0, 1.0)) * k),
            ])
        }
        _ => None,
    }
}

/// `cs` 演算子の色空間名から、色空間と初期色を決める
fn resolve_cs(doc: &Document, cspaces: Option<&Dictionary>, name: &[u8]) -> (Cs, Option<[u8; 3]>) {
    let black = Some([0, 0, 0]);
    match name {
        b"DeviceGray" | b"G" | b"CalGray" => return (Cs::Gray, black),
        b"DeviceRGB" | b"RGB" | b"CalRGB" => return (Cs::Rgb, black),
        b"DeviceCMYK" | b"CMYK" => return (Cs::Cmyk, black),
        b"Pattern" => return (Cs::Other, None),
        _ => {}
    }
    let Some(obj) = cspaces.and_then(|c| c.get(name).ok()) else {
        return (Cs::Other, None);
    };
    match deref(doc, obj) {
        Object::Name(n) => match n.as_slice() {
            b"DeviceGray" | b"CalGray" => (Cs::Gray, black),
            b"DeviceRGB" | b"CalRGB" => (Cs::Rgb, black),
            b"DeviceCMYK" => (Cs::Cmyk, black),
            _ => (Cs::Other, None),
        },
        Object::Array(a) => match a.first().and_then(|o| deref(doc, o).as_name().ok()) {
            Some(b"CalGray") => (Cs::Gray, black),
            Some(b"CalRGB") => (Cs::Rgb, black),
            Some(b"ICCBased") => {
                let n = a
                    .get(1)
                    .and_then(|o| deref(doc, o).as_stream().ok())
                    .and_then(|s| s.dict.get(b"N").ok())
                    .and_then(|o| num_deref(doc, o))
                    .map(|v| v as i64);
                match n {
                    Some(1) => (Cs::Gray, black),
                    Some(3) => (Cs::Rgb, black),
                    Some(4) => (Cs::Cmyk, black),
                    _ => (Cs::Other, None),
                }
            }
            _ => (Cs::Other, None),
        },
        _ => (Cs::Other, None),
    }
}

impl St {
    fn new() -> Self {
        St {
            ctm: IDENT,
            font: None,
            size: 0.0,
            tc: 0.0,
            tw: 0.0,
            th: 1.0,
            tl: 0.0,
            trise: 0.0,
            tr: 0,
            ca: 1.0,
            smask: false,
            bm_normal: true,
            fill_pattern: false,
            clip: None,
            clip_exact: true,
            opaque_ok: true,
            fill_cs: Cs::Gray,
            fill_rgb: Some([0, 0, 0]),
        }
    }

    /// 新しい覆いを不透明と認められる状態か (形以外の条件)
    fn can_cover_opaque(&self) -> bool {
        self.ca >= 0.999
            && !self.smask
            && self.bm_normal
            && !self.fill_pattern
            && self.clip_exact
            && self.opaque_ok
    }
}

/// 構築中のパス (デバイス空間)
#[derive(Default)]
struct PathAcc {
    subpaths: Vec<Vec<(f64, f64)>>,
    cur: Vec<(f64, f64)>,
    curve: bool,
    bbox: Option<Rect>,
    clip: bool,
    started: bool,
}

impl PathAcc {
    fn add(&mut self, p: (f64, f64)) {
        let b = self.bbox.get_or_insert(Rect {
            x0: p.0,
            y0: p.1,
            x1: p.0,
            y1: p.1,
        });
        b.x0 = b.x0.min(p.0);
        b.y0 = b.y0.min(p.1);
        b.x1 = b.x1.max(p.0);
        b.y1 = b.y1.max(p.1);
        self.cur.push(p);
        self.started = true;
    }

    fn end_sub(&mut self) {
        if !self.cur.is_empty() {
            self.subpaths.push(std::mem::take(&mut self.cur));
        }
    }

    /// 軸平行な矩形 1 つだけのパスか
    fn is_exact_rect(&self) -> bool {
        if self.curve {
            return false;
        }
        let mut subs: Vec<&Vec<(f64, f64)>> = self.subpaths.iter().collect();
        if !self.cur.is_empty() {
            subs.push(&self.cur);
        }
        if subs.len() != 1 {
            return false;
        }
        let mut p = subs[0].clone();
        // 閉じる点 (先頭と同じ点) を落とす
        if p.len() == 5 && (p[4].0 - p[0].0).abs() < 1e-6 && (p[4].1 - p[0].1).abs() < 1e-6 {
            p.pop();
        }
        if p.len() != 4 {
            return false;
        }
        let horiz =
            |a: (f64, f64), b: (f64, f64)| (a.1 - b.1).abs() < 1e-6 && (a.0 - b.0).abs() > 1e-9;
        let vert =
            |a: (f64, f64), b: (f64, f64)| (a.0 - b.0).abs() < 1e-6 && (a.1 - b.1).abs() > 1e-9;
        let e: Vec<(bool, bool)> = (0..4)
            .map(|i| (horiz(p[i], p[(i + 1) % 4]), vert(p[i], p[(i + 1) % 4])))
            .collect();
        // 辺が水平・垂直を交互に繰り返す
        (e[0].0 && e[1].1 && e[2].0 && e[3].1) || (e[0].1 && e[1].0 && e[2].1 && e[3].0)
    }
}

enum Ev {
    Glyph {
        key: Key,
        rect: Rect,
        adj: f64,
        code_len: u8,
        /// 「埋もれた文字」の候補 (描画モードが塗り/線で、半分以上不透明)
        cand: bool,
        /// `Walker::glyphs` の番号 (記録しないときは usize::MAX)
        rec: usize,
    },
    Cover {
        rect: Rect,
        /// 不透明で、文字を完全に隠せる覆い
        opaque: bool,
        /// 塗りの色 (画像・色が分からないものは None)
        rgb: Option<[u8; 3]>,
    },
}

/// 文字 1 つの記録 (隠しテキストの検出用)。座標はデバイス座標 (MuPDF と同じ。
/// CropBox の左上が原点、y は下向き、/Rotate 適用後)
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub(crate) struct GlyphRec {
    /// 0 始まりのページ番号
    pub(crate) page: i32,
    /// 属する内容ストリーム
    pub(crate) sid: ObjectId,
    /// 0 = ページの内容、それ以外 = 属する Form XObject の番号
    pub(crate) xref: i32,
    /// そのストリームの中での、Tj/TJ/'/" の通し番号 (0 始まり)
    pub(crate) tj_seq: i32,
    /// ストリームの中での演算子の番号と、その演算子の中での文字の番号
    pub(crate) op: usize,
    pub(crate) gi: usize,
    pub(crate) code: u32,
    pub(crate) code_len: u8,
    /// Unicode (複数コードポイントになりうる)
    pub(crate) text: String,
    pub(crate) origin: (f64, f64),
    /// [ul.x, ul.y, ur.x, ur.y, ll.x, ll.y, lr.x, lr.y]
    pub(crate) quad: [f64; 8],
    pub(crate) rect: Rect,
    /// フォントサイズ (デバイス座標での pt)
    pub(crate) size: f64,
    pub(crate) rgb: Option<[u8; 3]>,
    /// 塗りの不透明度 (ca)
    pub(crate) ca: f64,
    /// 描画モード (Tr)
    pub(crate) tr: i64,
    pub(crate) is_type3: bool,
    /// 取り除いたあとに送り幅を保つ TJ の位置調整
    pub(crate) adj: f64,
    /// 「埋もれた文字」の候補か
    pub(crate) cand: bool,
    /// 後から描かれた不透明な覆いに覆われる割合 (候補のみ)
    pub(crate) cover: f64,
    /// 背景色の推定。None = 分からない (画像・曲線・半透明の上など)
    pub(crate) bg: Option<[u8; 3]>,
}

/// 1 つのストリームを走査できなかった理由
type Unwalkable = String;

struct Walker<'a> {
    doc: &'a Document,
    events: Vec<Ev>,
    n_glyphs: usize,
    n_covers: usize,
    /// 処理中の Form (循環参照の防止)
    stack: Vec<ObjectId>,
    /// 全文字を記録する (検出用)。false のときは候補の文字だけをイベントに積む
    want_glyphs: bool,
    glyphs: Vec<GlyphRec>,
    page_no: i32,
    /// ページ自身の内容ストリーム (xref = 0 の判定用)
    page_sid: ObjectId,
}

/// 内容ストリームのバイト列を、演算子の列にする。インライン画像を含む・解析しきれない場合は Err
fn decode_ops(bytes: &[u8]) -> Result<Vec<Operation>, Unwalkable> {
    let images = crate::content_filter::find_inline_images(bytes)
        .map_err(|e| format!("inline image scan: {e}"))?;
    if !images.is_empty() {
        return Err("content has inline image(s)".into());
    }
    let content = crate::content_filter::decode_content(bytes)
        .map_err(|e| format!("content does not parse strictly: {e}"))?;
    Ok(content.operations)
}

fn stream_bytes(doc: &Document, id: ObjectId) -> Result<Vec<u8>, Unwalkable> {
    let s = doc
        .get_object(id)
        .ok()
        .and_then(|o| o.as_stream().ok())
        .ok_or_else(|| "stream not found".to_string())?;
    // 壊れた・途中で切れた Flate は Err (欠けた内容から判定・書き換えをしない)
    crate::image_recompress::content_stream_bytes_with_limit(s, CONTENT_LIMIT)
        .map_err(|e| format!("stream decompress: {e}"))
}

fn ext_gstate<'a>(
    doc: &'a Document,
    ext: Option<&'a Dictionary>,
    op: &Operation,
) -> Option<&'a Dictionary> {
    let n = op.operands.first()?.as_name().ok()?;
    ext.and_then(|e| sub_dict(doc, e, n))
}

impl<'a> Walker<'a> {
    fn push_cover(
        &mut self,
        rect: Rect,
        opaque: bool,
        rgb: Option<[u8; 3]>,
    ) -> Result<(), Unwalkable> {
        self.n_covers += 1;
        if self.n_covers > MAX_COVERS {
            return Err("too many covering objects".into());
        }
        self.events.push(Ev::Cover { rect, opaque, rgb });
        Ok(())
    }

    /// ストリーム 1 本 (ページまたは Form の内容) を描画順にたどる。
    fn walk(
        &mut self,
        sid: ObjectId,
        ops: &[Operation],
        res: Option<&'a Dictionary>,
        init: St,
        depth: usize,
    ) -> Result<(), Unwalkable> {
        let doc = self.doc;
        let xobjs = res.and_then(|r| sub_dict(doc, r, b"XObject"));
        let fonts = res.and_then(|r| sub_dict(doc, r, b"Font"));
        let ext = res.and_then(|r| sub_dict(doc, r, b"ExtGState"));
        let cspaces = res.and_then(|r| sub_dict(doc, r, b"ColorSpace"));
        let mut fcache: HashMap<Vec<u8>, Option<HFont>> = HashMap::new();
        // 0 = ページの内容、それ以外 = Form XObject の番号
        let xref = if sid == self.page_sid {
            0
        } else {
            sid.0 as i32
        };
        // このストリームの中での、文字列表示演算子 (Tj/TJ/'/") の通し番号
        let mut tj_seq: i32 = 0;

        let mut st = init;
        let mut stack: Vec<St> = Vec::new();
        let mut tm = IDENT;
        let mut tlm = IDENT;
        // 幅の分からない文字列を表示したあとは、次の位置指定までテキスト位置が分からない
        let mut tm_valid = true;
        let mut path = PathAcc::default();

        for (opi, op) in ops.iter().enumerate() {
            let name = op.operator.as_str();
            match name {
                "q" => stack.push(st.clone()),
                "Q" => {
                    if let Some(g) = stack.pop() {
                        st = g;
                    }
                }
                "cm" => {
                    if let Some(m) = mat_of(op) {
                        st.ctm = mul(&m, &st.ctm);
                    }
                }
                "gs" => {
                    if let Some(d) = ext_gstate(doc, ext, op) {
                        if let Some(v) = d.get(b"ca").ok().and_then(|o| num_deref(doc, o)) {
                            st.ca = v.clamp(0.0, 1.0);
                        }
                        if let Ok(o) = d.get(b"SMask") {
                            st.smask = !matches!(deref(doc, o).as_name(), Ok(b"None"));
                        }
                        if let Ok(o) = d.get(b"BM") {
                            let bm = match deref(doc, o) {
                                Object::Name(n) => Some(n.as_slice()),
                                Object::Array(a) => {
                                    a.first().and_then(|x| deref(doc, x).as_name().ok())
                                }
                                _ => None,
                            };
                            st.bm_normal = matches!(bm, Some(b"Normal") | Some(b"Compatible"));
                        }
                    }
                }
                // ── 塗りの色 (パターンかどうかと、RGB にできる色) ──
                "g" | "rg" | "k" => {
                    st.fill_pattern = false;
                    st.fill_cs = match name {
                        "g" => Cs::Gray,
                        "rg" => Cs::Rgb,
                        _ => Cs::Cmyk,
                    };
                    st.fill_rgb = operand_nums(op).and_then(|v| rgb_of(st.fill_cs, &v));
                }
                "cs" => {
                    let n = op.operands.first().and_then(|o| o.as_name().ok());
                    st.fill_pattern = matches!(n, Some(b"Pattern"));
                    let (cs, rgb) = n.map_or((Cs::Other, None), |n| resolve_cs(doc, cspaces, n));
                    st.fill_cs = cs;
                    st.fill_rgb = rgb;
                }
                "sc" | "scn" => {
                    if matches!(op.operands.last(), Some(Object::Name(_))) {
                        st.fill_pattern = true;
                        st.fill_rgb = None;
                    } else {
                        st.fill_rgb = operand_nums(op).and_then(|v| rgb_of(st.fill_cs, &v));
                    }
                }
                // ── パス ──
                "m" => {
                    path.end_sub();
                    if let Some(v) = operand_nums(op).filter(|v| v.len() == 2) {
                        path.add(apply(&st.ctm, v[0], v[1]));
                    }
                }
                "l" => {
                    if let Some(v) = operand_nums(op).filter(|v| v.len() == 2) {
                        path.add(apply(&st.ctm, v[0], v[1]));
                    }
                }
                "c" | "v" | "y" => {
                    path.curve = true;
                    if let Some(v) = operand_nums(op) {
                        for p in v.chunks_exact(2) {
                            path.add(apply(&st.ctm, p[0], p[1]));
                        }
                    }
                }
                "re" => {
                    path.end_sub();
                    if let Some(v) = operand_nums(op).filter(|v| v.len() == 4) {
                        let (x, y, w, h) = (v[0], v[1], v[2], v[3]);
                        for (px, py) in [(x, y), (x + w, y), (x + w, y + h), (x, y + h)] {
                            path.add(apply(&st.ctm, px, py));
                        }
                        path.end_sub();
                    }
                }
                "h" => {}
                "W" | "W*" => path.clip = true,
                "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" | "n" => {
                    let fill = matches!(name, "f" | "F" | "f*" | "B" | "B*" | "b" | "b*");
                    if let Some(bb) = path.bbox.filter(|_| path.started) {
                        if fill {
                            if let Some(r) = st.clip.map_or(Some(bb), |c| intersect(&bb, &c)) {
                                let thick = (r.x1 - r.x0).min(r.y1 - r.y0);
                                let opaque = path.is_exact_rect() && st.can_cover_opaque();
                                let rgb = if st.fill_pattern { None } else { st.fill_rgb };
                                if opaque {
                                    self.push_cover(r, true, rgb)?;
                                } else if st.ca >= PROBE_MIN_ALPHA && thick >= PROBE_MIN_THICKNESS {
                                    self.push_cover(r, false, rgb)?;
                                }
                            }
                        }
                        // クリップは、塗りのあとに効く
                        if path.clip {
                            let exact = path.is_exact_rect() && st.clip_exact;
                            st.clip = match st.clip {
                                Some(c) => Some(intersect(&bb, &c).unwrap_or(Rect {
                                    x0: 0.0,
                                    y0: 0.0,
                                    x1: 0.0,
                                    y1: 0.0,
                                })),
                                None => Some(bb),
                            };
                            st.clip_exact = exact;
                        }
                    } else if path.clip {
                        // 空のクリップ: 何も描かれなくなる
                        st.clip = Some(Rect {
                            x0: 0.0,
                            y0: 0.0,
                            x1: 0.0,
                            y1: 0.0,
                        });
                        st.clip_exact = false;
                    }
                    path = PathAcc::default();
                }
                "sh" => {}
                // ── XObject ──
                "Do" => {
                    let Some(n) = op.operands.first().and_then(|o| o.as_name().ok()) else {
                        continue;
                    };
                    let Some(xo_ref) = xobjs.and_then(|x| x.get(n).ok()) else {
                        continue;
                    };
                    let Some(info) = load_xobject(doc, xo_ref) else {
                        continue;
                    };
                    match info.kind {
                        XKind::Image => {
                            let xs = deref(doc, xo_ref).as_stream().ok();
                            let (has_mask, is_stencil) = xs.map_or((true, true), |s| {
                                let d = &s.dict;
                                let stencil = d
                                    .get(b"ImageMask")
                                    .ok()
                                    .and_then(|o| deref(doc, o).as_bool().ok())
                                    .unwrap_or(false);
                                (d.has(b"SMask") || d.has(b"Mask"), stencil)
                            });
                            let bb = transform_rect(&st.ctm, [0.0, 0.0, 1.0, 1.0]);
                            if let Some(r) = st.clip.map_or(Some(bb), |c| intersect(&bb, &c)) {
                                let opaque = !has_mask
                                    && !is_stencil
                                    && is_axis_aligned(&st.ctm)
                                    && st.can_cover_opaque();
                                if opaque {
                                    self.push_cover(r, true, None)?;
                                } else if st.ca >= PROBE_MIN_ALPHA {
                                    self.push_cover(r, false, None)?;
                                }
                            }
                        }
                        XKind::Form { bbox, matrix } => {
                            let Object::Reference(fid) = xo_ref else {
                                return Err("form xobject is not an indirect object".into());
                            };
                            self.walk_form(*fid, &st, &matrix, &bbox, res, depth)?;
                        }
                    }
                }
                // ── テキスト ──
                "BT" => {
                    tm = IDENT;
                    tlm = IDENT;
                    tm_valid = true;
                }
                "Tf" => {
                    st.font = op
                        .operands
                        .first()
                        .and_then(|o| o.as_name().ok())
                        .map(<[u8]>::to_vec);
                    st.size = op.operands.get(1).and_then(num).unwrap_or(0.0);
                }
                "Tc" | "Tw" | "Tz" | "TL" | "Ts" | "Tr" => {
                    if let Some(v) = op.operands.first().and_then(num) {
                        match name {
                            "Tc" => st.tc = v,
                            "Tw" => st.tw = v,
                            "Tz" => st.th = v / 100.0,
                            "TL" => st.tl = v,
                            "Ts" => st.trise = v,
                            _ => st.tr = v as i64,
                        }
                    }
                }
                "Td" | "TD" => {
                    if let Some(v) = operand_nums(op).filter(|v| v.len() == 2) {
                        if name == "TD" {
                            st.tl = -v[1];
                        }
                        tlm = mul(&[1.0, 0.0, 0.0, 1.0, v[0], v[1]], &tlm);
                        tm = tlm;
                        tm_valid = true;
                    } else {
                        tm_valid = false;
                    }
                }
                "Tm" => match mat_of(op) {
                    Some(m) => {
                        tlm = m;
                        tm = m;
                        tm_valid = true;
                    }
                    None => tm_valid = false,
                },
                "T*" => {
                    tlm = mul(&[1.0, 0.0, 0.0, 1.0, 0.0, -st.tl], &tlm);
                    tm = tlm;
                    tm_valid = true;
                }
                "Tj" | "TJ" | "'" | "\"" => {
                    // ' と " は、次の行へ移ってから表示する。" は先に語間・字間を設定する
                    if name == "'" || name == "\"" {
                        if name == "\"" {
                            if let Some(aw) = op.operands.first().and_then(num) {
                                st.tw = aw;
                            }
                            if let Some(ac) = op.operands.get(1).and_then(num) {
                                st.tc = ac;
                            }
                        }
                        tlm = mul(&[1.0, 0.0, 0.0, 1.0, 0.0, -st.tl], &tlm);
                        tm = tlm;
                        tm_valid = true;
                    }
                    let this_seq = tj_seq;
                    tj_seq += 1;
                    let items = show_items(op);
                    let font = st.font.clone().and_then(|n| {
                        fcache
                            .entry(n.clone())
                            .or_insert_with(|| {
                                fonts
                                    .and_then(|f| sub_dict(doc, f, &n))
                                    .and_then(|d| load_hfont(doc, d))
                            })
                            .as_ref()
                    });
                    let Some(font) = font else {
                        tm_valid = false;
                        continue;
                    };
                    if !tm_valid {
                        continue;
                    }
                    if st.tr >= 4 {
                        // 文字でクリップする: 以降の覆いは形が分からない
                        st.clip_exact = false;
                    }
                    let candidate = matches!(name, "Tj" | "TJ")
                        && (0..=2).contains(&st.tr)
                        && st.ca >= MIN_TEXT_ALPHA
                        && !st.smask
                        && st.size.abs() > 1e-9;
                    let m = mul(&tm, &st.ctm);
                    // テキスト空間の 1 単位が、デバイス座標でどれだけの長さか (縦方向)
                    let scale_y = (m[2] * m[2] + m[3] * m[3]).sqrt();
                    let mut x = 0.0f64;
                    let mut gi = 0usize;
                    let mut ok = true;
                    for item in &items {
                        match item {
                            Item::Adj(n) => x -= n / 1000.0 * st.size * st.th,
                            Item::Str(s) => {
                                let cl = usize::from(font.code_len);
                                if s.len() % cl != 0 {
                                    ok = false;
                                    break;
                                }
                                for ch in s.chunks(cl) {
                                    let code =
                                        ch.iter().fold(0u32, |a, &b| (a << 8) | u32::from(b));
                                    let w = code_width(&font.info, code);
                                    let space = if cl == 1 && code == 32 { st.tw } else { 0.0 };
                                    let adv = (w / 1000.0 * st.size + st.tc + space) * st.th;
                                    let cand = candidate && w > 0.0;
                                    if cand || self.want_glyphs {
                                        let gw = w / 1000.0 * st.size * st.th;
                                        let y0 = st.trise + font.desc * st.size;
                                        let y1 = st.trise + font.asc * st.size;
                                        let bb = transform_rect(&m, [x, y0, x + gw, y1]);
                                        self.n_glyphs += 1;
                                        if self.n_glyphs > MAX_GLYPHS {
                                            return Err("too many glyphs".into());
                                        }
                                        // 取り除いたあとに送り幅を保つ TJ の位置調整
                                        let adj = if st.size.abs() > 1e-9 {
                                            -(w + (st.tc + space) * 1000.0 / st.size)
                                        } else {
                                            0.0
                                        };
                                        let mut rec = usize::MAX;
                                        if self.want_glyphs {
                                            let p = |px: f64, py: f64| apply(&m, px, py);
                                            let (ul, ur) = (p(x, y1), p(x + gw, y1));
                                            let (ll, lr) = (p(x, y0), p(x + gw, y0));
                                            rec = self.glyphs.len();
                                            self.glyphs.push(GlyphRec {
                                                page: self.page_no,
                                                sid,
                                                xref,
                                                tj_seq: this_seq,
                                                op: opi,
                                                gi,
                                                code,
                                                code_len: font.code_len,
                                                text: font.uni.get(code),
                                                origin: p(x, st.trise),
                                                quad: [
                                                    ul.0, ul.1, ur.0, ur.1, ll.0, ll.1, lr.0, lr.1,
                                                ],
                                                rect: bb,
                                                size: st.size.abs() * scale_y,
                                                rgb: if st.fill_pattern {
                                                    None
                                                } else {
                                                    st.fill_rgb
                                                },
                                                ca: st.ca,
                                                tr: st.tr,
                                                is_type3: font.is_type3,
                                                adj,
                                                cand,
                                                cover: 0.0,
                                                bg: None,
                                            });
                                        }
                                        self.events.push(Ev::Glyph {
                                            key: (sid, opi, gi),
                                            rect: bb,
                                            adj,
                                            code_len: font.code_len,
                                            cand,
                                            rec,
                                        });
                                    }
                                    gi += 1;
                                    x += adv;
                                }
                            }
                        }
                    }
                    if ok {
                        tm = mul(&[1.0, 0.0, 0.0, 1.0, x, 0.0], &tm);
                    } else {
                        tm_valid = false;
                    }
                }
                _ => {}
            }
            // パスの途中で、パスと無関係な命令が来たら、そのパスは追跡をやめる
            if path.started && !is_path_related(name) {
                path = PathAcc::default();
            }
        }
        Ok(())
    }

    fn walk_form(
        &mut self,
        fid: ObjectId,
        outer: &St,
        matrix: &Mat,
        bbox: &[f64; 4],
        outer_res: Option<&'a Dictionary>,
        depth: usize,
    ) -> Result<(), Unwalkable> {
        if depth + 1 > MAX_FORM_DEPTH {
            return Err("forms nested too deeply".into());
        }
        if self.stack.contains(&fid) {
            return Err("form xobject refers to itself".into());
        }
        let doc = self.doc;
        let s = doc
            .get_object(fid)
            .ok()
            .and_then(|o| o.as_stream().ok())
            .ok_or_else(|| "form xobject stream not found".to_string())?;
        let ops = decode_ops(&stream_bytes(doc, fid)?)?;
        let res = sub_dict(doc, &s.dict, b"Resources").or(outer_res);

        let mut init = outer.clone();
        init.ctm = mul(matrix, &outer.ctm);
        // Form の BBox でクリップされる
        let bb = transform_rect(&init.ctm, *bbox);
        let exact = is_axis_aligned(&init.ctm);
        init.clip = match init.clip {
            Some(c) => Some(intersect(&bb, &c).unwrap_or(Rect {
                x0: 0.0,
                y0: 0.0,
                x1: 0.0,
                y1: 0.0,
            })),
            None => Some(bb),
        };
        init.clip_exact = init.clip_exact && exact;
        // 不透明度が掛かった透明グループは、中の覆いを不透明と認めない
        let is_group = s.dict.has(b"Group");
        if is_group && (outer.ca < 0.999 || outer.smask || !outer.bm_normal) {
            init.opaque_ok = false;
        }

        self.stack.push(fid);
        let r = self.walk(fid, &ops, res, init, depth + 1);
        self.stack.pop();
        r
    }
}

fn is_path_related(name: &str) -> bool {
    matches!(
        name,
        "m" | "l"
            | "c"
            | "v"
            | "y"
            | "re"
            | "h"
            | "W"
            | "W*"
            | "S"
            | "s"
            | "f"
            | "F"
            | "f*"
            | "B"
            | "B*"
            | "b"
            | "b*"
            | "n"
    )
}

/// 文字列と TJ の位置調整
enum Item<'a> {
    Str(&'a [u8]),
    Adj(f64),
}

fn show_items(op: &Operation) -> Vec<Item<'_>> {
    let mut items = Vec::new();
    match op.operator.as_str() {
        "TJ" => {
            if let Some(Object::Array(a)) = op.operands.first() {
                for e in a {
                    match e {
                        Object::String(s, _) => items.push(Item::Str(s)),
                        other => {
                            if let Some(n) = num(other) {
                                items.push(Item::Adj(n));
                            }
                        }
                    }
                }
            }
        }
        _ => {
            if let Some(Object::String(s, _)) = op.operands.last() {
                items.push(Item::Str(s));
            }
        }
    }
    items
}

// ── 解析 (全ページ) ───────────────────────────────────────────────────────

/// 文書内の、各オブジェクトを指す参照の数
fn reference_counts(doc: &Document) -> HashMap<ObjectId, usize> {
    fn visit(o: &Object, counts: &mut HashMap<ObjectId, usize>) {
        match o {
            Object::Reference(id) => *counts.entry(*id).or_insert(0) += 1,
            Object::Array(a) => a.iter().for_each(|x| visit(x, counts)),
            Object::Dictionary(d) => d.iter().for_each(|(_, v)| visit(v, counts)),
            Object::Stream(s) => s.dict.iter().for_each(|(_, v)| visit(v, counts)),
            _ => {}
        }
    }
    let mut counts = HashMap::new();
    for o in doc.objects.values() {
        visit(o, &mut counts);
    }
    visit(&Object::Dictionary(doc.trailer.clone()), &mut counts);
    counts
}

/// ページ 1 枚の解析結果
struct PageScan {
    /// probe_ratio 以上の割合で覆われる文字がある
    probe: bool,
    /// 全文字の記録 (`ScanOpts::want_glyphs` のときだけ)
    glyphs: Vec<GlyphRec>,
}

struct ScanOpts {
    strip_ratio: f64,
    probe_ratio: f64,
    /// 全文字を記録する (隠しテキストの検出用)
    want_glyphs: bool,
    /// 0 始まりのページ番号
    page_no: i32,
}

/// ページ空間 → デバイス座標 (MuPDF と同じ: CropBox (MediaBox との共通部分) の左上が原点、
/// y は下向き、/Rotate を適用)。
fn page_device_matrix(doc: &Document, page_id: ObjectId) -> Mat {
    let boxof = |key: &[u8]| inherited(doc, page_id, key).and_then(|o| parse_box(doc, o));
    let media = boxof(b"MediaBox").unwrap_or([0.0, 0.0, 612.0, 792.0]);
    let crop = boxof(b"CropBox").map_or(media, |c| {
        let b = [
            c[0].max(media[0]),
            c[1].max(media[1]),
            c[2].min(media[2]),
            c[3].min(media[3]),
        ];
        if b[2] > b[0] && b[3] > b[1] { b } else { media }
    });
    let rot = inherited(doc, page_id, b"Rotate")
        .and_then(|o| num_deref(doc, o))
        .map_or(0, |v| (v as i64).rem_euclid(360));
    let (x0, y0, x1, y1) = (crop[0], crop[1], crop[2], crop[3]);
    match rot {
        90 => [0.0, 1.0, 1.0, 0.0, -y0, -x0],
        180 => [-1.0, 0.0, 0.0, 1.0, x1, -y0],
        270 => [0.0, -1.0, -1.0, 0.0, y1, x1],
        _ => [1.0, 0.0, 0.0, -1.0, -x0, y1],
    }
}

fn scan_page(
    doc: &Document,
    page_id: ObjectId,
    o: &ScanOpts,
    votes: &mut HashMap<Key, Vote>,
) -> Result<PageScan, Unwalkable> {
    let empty = || PageScan {
        probe: false,
        glyphs: Vec::new(),
    };
    // /Contents は、事前に 1 本へまとめてある (まとめられなかったページは Err)
    let streams: Vec<ObjectId> = doc
        .get_page_contents(page_id)
        .into_iter()
        .filter(|id| matches!(doc.objects.get(id), Some(Object::Stream(_))))
        .collect();
    let sid = match streams.as_slice() {
        [] => return Ok(empty()),
        [one] => *one,
        _ => return Err("page /Contents has several streams".into()),
    };
    let ops = decode_ops(&stream_bytes(doc, sid)?)?;
    if ops.is_empty() {
        return Ok(empty());
    }
    let res = inherited(doc, page_id, b"Resources").and_then(|o| dict_of(doc, o));
    let mut w = Walker {
        doc,
        events: Vec::new(),
        n_glyphs: 0,
        n_covers: 0,
        stack: Vec::new(),
        want_glyphs: o.want_glyphs,
        glyphs: Vec::new(),
        page_no: o.page_no,
        page_sid: sid,
    };
    let mut init = St::new();
    init.ctm = page_device_matrix(doc, page_id);
    w.walk(sid, &ops, res, init, 0)?;
    let (strip_ratio, probe_ratio) = (o.strip_ratio, o.probe_ratio);

    // 文字ごとに、あとから描かれた覆いに覆われる割合を求める
    let events = w.events;
    // (イベントの番号, 外接矩形, 不透明か, 塗りの色)
    let covers: Vec<(usize, Rect, bool, Option<[u8; 3]>)> = events
        .iter()
        .enumerate()
        .filter_map(|(i, e)| match e {
            Ev::Cover { rect, opaque, rgb } => Some((i, *rect, *opaque, *rgb)),
            _ => None,
        })
        .collect();
    if (w.n_glyphs as u128) * (covers.len() as u128) > MAX_PAIRS {
        return Err("too many glyph/cover combinations".into());
    }
    let mut probe = false;
    let mut opaque_list: Vec<Rect> = Vec::new();
    let mut any_list: Vec<Rect> = Vec::new();
    for (gi, e) in events.iter().enumerate() {
        let Ev::Glyph {
            key,
            rect,
            adj,
            code_len,
            cand,
            rec,
        } = e
        else {
            continue;
        };
        let first = covers.partition_point(|(ci, _, _, _)| *ci < gi);
        if *rec != usize::MAX {
            // 背景色の推定: 先に描かれた覆いのうち、文字を完全に含む不透明な塗りの色。
            // 一部だけ重なる物・不透明でない物 (画像・曲線・半透明) があれば分からない
            let mut bg: Option<Option<[u8; 3]>> = Some(Some([255, 255, 255]));
            for (_, c, opaque, rgb) in &covers[..first] {
                if !overlaps(rect, c) {
                    continue;
                }
                let contains = c.x0 <= rect.x0 + EPS
                    && c.y0 <= rect.y0 + EPS
                    && c.x1 >= rect.x1 - EPS
                    && c.y1 >= rect.y1 - EPS;
                bg = if *opaque && contains {
                    Some(*rgb)
                } else {
                    Some(None)
                };
            }
            w.glyphs[*rec].bg = bg.flatten();
        }
        if !*cand {
            continue;
        }
        opaque_list.clear();
        any_list.clear();
        for (_, c, opaque, _) in &covers[first..] {
            if !overlaps(rect, c) {
                continue;
            }
            if any_list.len() < MAX_COVERS_PER_GLYPH {
                any_list.push(*c);
            }
            if *opaque && opaque_list.len() < MAX_COVERS_PER_GLYPH {
                opaque_list.push(*c);
            }
        }
        let frac = if opaque_list.is_empty() {
            0.0
        } else {
            covered_fraction(rect, &opaque_list)
        };
        if *rec != usize::MAX {
            w.glyphs[*rec].cover = frac;
        }
        let buried = !opaque_list.is_empty() && frac >= strip_ratio - 1e-9;
        if !probe
            && probe_ratio.is_finite()
            && !any_list.is_empty()
            && covered_fraction(rect, &any_list) >= probe_ratio
        {
            probe = true;
        }
        let v = votes.entry(*key).or_insert(Vote {
            buried: 0,
            total: 0,
            adj: *adj,
            code_len: *code_len,
            inconsistent: false,
        });
        v.total += 1;
        if buried {
            v.buried += 1;
        }
        if (v.adj - *adj).abs() > 1e-3 || v.code_len != *code_len {
            v.inconsistent = true;
        }
    }
    Ok(PageScan {
        probe,
        glyphs: w.glyphs,
    })
}

/// 1 ページの全文字を記録して返す (隠しテキストの検出用)。`page` は 0 始まり。
/// 文字ごとに、覆われる割合 (`cover`) と背景色の推定 (`bg`) も求める。
/// `doc` は、ページの /Contents を 1 本にまとめる形に書き換わる (内容は変わらない)。
/// 暗号化・解析できないページは Err。
pub(crate) fn scan_glyphs(doc: &mut Document, page: i32) -> Result<Vec<GlyphRec>, String> {
    if doc.is_encrypted() || doc.was_encrypted() {
        return Err("encrypted".into());
    }
    let pages: Vec<(u32, ObjectId)> = doc.get_pages().into_iter().collect();
    let Some(&(_, page_id)) = usize::try_from(page).ok().and_then(|i| pages.get(i)) else {
        return Err(format!("page {page} out of range"));
    };
    let mut skipped: Vec<String> = Vec::new();
    crate::content_filter::merge_page_contents_with(doc, true, &mut skipped)?;
    let opts = ScanOpts {
        strip_ratio: f64::INFINITY,
        probe_ratio: f64::INFINITY,
        want_glyphs: true,
        page_no: page,
    };
    let mut votes = HashMap::new();
    scan_page(doc, page_id, &opts, &mut votes)
        .map(|s| s.glyphs)
        .map_err(|e| format!("page {}: {e}", page + 1))
}

/// 文書を解析して、取り除く文字と、部分的に隠れた文字があるページを求める。
///
/// - `strip_ratio`: この割合以上が不透明な覆いで隠れた文字を、取り除く対象にする
///   (取り除かない解析のときは `f64::INFINITY`)
/// - `probe_ratio`: この割合以上があとから描かれた物に重なる文字があるページを `probe_pages` に入れる
///
/// `doc` は、各ページの /Contents を 1 本にまとめる形に書き換わる (内容は変わらない)。
/// 暗号化された文書は Err。
pub(crate) fn analyze(
    doc: &mut Document,
    strip_ratio: f64,
    probe_ratio: f64,
) -> Result<Analysis, String> {
    if doc.is_encrypted() || doc.was_encrypted() {
        return Err("encrypted".into());
    }
    let mut skipped: Vec<String> = Vec::new();
    crate::content_filter::merge_page_contents_with(doc, true, &mut skipped)?;

    let pages: Vec<(u32, ObjectId)> = doc.get_pages().into_iter().collect();
    let mut votes: HashMap<Key, Vote> = HashMap::new();
    let mut out = Analysis::default();
    for (no, page_id) in pages {
        let no = no as i32;
        let opts = ScanOpts {
            strip_ratio,
            probe_ratio,
            want_glyphs: false,
            page_no: no - 1,
        };
        match scan_page(doc, page_id, &opts, &mut votes) {
            Ok(scan) => {
                if scan.probe {
                    out.probe_pages.push(no);
                }
            }
            Err(reason) => {
                // 解析できないページは、書き換えず、隠れた文字があるかもしれないページとして扱う
                out.unsupported.push((no, reason));
                out.probe_pages.push(no);
            }
        }
    }

    // 取り除く文字を決める
    let page_streams: HashSet<ObjectId> = doc
        .get_pages()
        .values()
        .flat_map(|&p| doc.get_page_contents(p))
        .collect();
    let all_walkable = out.unsupported.is_empty();
    let refs = reference_counts(doc);
    for (key, v) in votes {
        if v.inconsistent || v.total == 0 || v.buried != v.total {
            continue;
        }
        let (sid, opi, gi) = key;
        if !page_streams.contains(&sid) {
            // Form の中の文字: 全ページを走査できて、その Form を指す参照が 1 つのときだけ
            if !all_walkable || refs.get(&sid).copied().unwrap_or(0) != 1 {
                continue;
            }
        }
        out.removals
            .entry(sid)
            .or_default()
            .entry(opi)
            .or_default()
            .insert(gi, (v.adj, v.code_len));
        out.removed_glyphs += 1;
    }
    Ok(out)
}

// ── 無害化 (書き換え) ─────────────────────────────────────────────────────

/// Tj / TJ の 1 つの演算子から、`remove` の文字を取り除いた TJ を作る。
/// 取り除いた文字の送り幅は、TJ の位置調整で保つ。
fn rewrite_show(op: &Operation, remove: &BTreeMap<usize, (f64, u8)>) -> Option<Operation> {
    enum Out {
        Str(Vec<u8>, StringFormat),
        Adj(f64),
    }
    let mut out: Vec<Out> = Vec::new();
    let push_adj = |out: &mut Vec<Out>, n: f64| {
        if let Some(Out::Adj(prev)) = out.last_mut() {
            *prev += n;
        } else {
            out.push(Out::Adj(n));
        }
    };
    let mut gi = 0usize;
    let handle_str = |out: &mut Vec<Out>, s: &[u8], fmt: StringFormat, gi: &mut usize| -> bool {
        let cl = remove.values().next().map_or(1, |&(_, c)| usize::from(c));
        if cl == 0 || s.len() % cl != 0 {
            return false;
        }
        let mut keep: Vec<u8> = Vec::new();
        for ch in s.chunks(cl) {
            if let Some(&(adj, _)) = remove.get(gi) {
                if !keep.is_empty() {
                    out.push(Out::Str(std::mem::take(&mut keep), fmt.clone()));
                }
                push_adj(out, adj);
            } else {
                keep.extend_from_slice(ch);
            }
            *gi += 1;
        }
        if !keep.is_empty() {
            out.push(Out::Str(keep, fmt));
        }
        true
    };
    match op.operator.as_str() {
        "Tj" => {
            let Some(Object::String(s, fmt)) = op.operands.last() else {
                return None;
            };
            if !handle_str(&mut out, s, fmt.clone(), &mut gi) {
                return None;
            }
        }
        "TJ" => {
            let Some(Object::Array(a)) = op.operands.first() else {
                return None;
            };
            for e in a {
                match e {
                    Object::String(s, fmt) => {
                        if !handle_str(&mut out, s, fmt.clone(), &mut gi) {
                            return None;
                        }
                    }
                    other => {
                        let n = num(other)?;
                        push_adj(&mut out, n);
                    }
                }
            }
        }
        _ => return None,
    }
    // 対象の文字が全部この演算子に含まれていたか (番号が範囲外のものが残っていないか)
    if remove.keys().any(|&k| k >= gi) {
        return None;
    }
    let arr: Vec<Object> = out
        .into_iter()
        .map(|o| match o {
            Out::Str(b, f) => Object::String(b, f),
            Out::Adj(n) => Object::Real(n as f32),
        })
        .collect();
    Some(Operation::new("TJ", vec![Object::Array(arr)]))
}

/// 取り除く文字の記録から、`apply_removals` に渡す解析結果を作る (隠しテキストの無害化用)。
/// 同じ文字を重ねて指定しても、1 回だけ数える。
pub(crate) fn analysis_from_glyphs(glyphs: &[&GlyphRec]) -> Analysis {
    let mut a = Analysis::default();
    for g in glyphs {
        let fresh = a
            .removals
            .entry(g.sid)
            .or_default()
            .entry(g.op)
            .or_default()
            .insert(g.gi, (g.adj, g.code_len))
            .is_none();
        if fresh {
            a.removed_glyphs += 1;
        }
    }
    a
}

/// 解析結果に従って、文字を取り除く。取り除いた文字の数を返す。
/// 内容ストリームを読み直せない・書き換えられないときは、そのストリームを変えずに進める。
pub(crate) fn apply_removals(doc: &mut Document, analysis: &Analysis) -> usize {
    let mut removed = 0usize;
    for (&sid, ops_map) in &analysis.removals {
        let Ok(bytes) = stream_bytes(doc, sid) else {
            continue;
        };
        let Ok(mut ops) = decode_ops(&bytes) else {
            continue;
        };
        let mut n_here = 0usize;
        for (&opi, glyphs) in ops_map {
            let Some(op) = ops.get(opi) else { continue };
            if !matches!(op.operator.as_str(), "Tj" | "TJ") {
                continue;
            }
            if let Some(new_op) = rewrite_show(op, glyphs) {
                ops[opi] = new_op;
                n_here += glyphs.len();
            }
        }
        if n_here == 0 {
            continue;
        }
        let Ok(encoded) =
            crate::content_filter::encode_content_eol_safe(&Content { operations: ops })
        else {
            continue;
        };
        if let Ok(Object::Stream(st)) = doc.get_object_mut(sid) {
            st.set_plain_content(encoded);
            removed += n_here;
        }
    }
    removed
}

// ── 入口 ──────────────────────────────────────────────────────────────────

/// `input` から、`ratio` 以上が不透明な覆いに隠れた文字を取り除いた PDF を `output` へ書く。
/// 取り除く文字が無ければ、何も書かず Ok(None)。取り除いたときは Ok(Some(文字数))。
/// 暗号化・読めない入力は Err (呼び出し側が MuPDF 実装へフォールバックする)。
pub(crate) fn strip_buried_text_file(
    input: &str,
    output: &str,
    ratio: f64,
) -> crate::error::Result<Option<usize>> {
    let (mut doc, _bytes) = crate::safe_load::load_checked(input)?;
    let analysis = analyze(&mut doc, ratio, f64::INFINITY)
        .map_err(|e| crate::error::CoreError::Unsupported(format!("hidden text: {e}")))?;
    for (page, reason) in &analysis.unsupported {
        eprintln!("[keep-text] lopdf: page {page} left as is ({reason})");
    }
    if !analysis.has_removals() {
        return Ok(None);
    }
    let removed = apply_removals(&mut doc, &analysis);
    if removed == 0 {
        return Ok(None);
    }
    doc.save(output)
        .map_err(|e| crate::error::CoreError::Internal(format!("save: {e}")))?;
    Ok(Some(removed))
}

/// 部分的に隠れた文字があるページ (1 ベース、昇順) を返す。`pages` (1 ベース) があれば、
/// そのページだけを見る。解析できないページも含める (安全側)。読めない入力は Err。
#[cfg_attr(not(feature = "hayro"), allow(dead_code))]
pub(crate) fn partially_covered_pages_file(
    path: &str,
    pages: Option<&[i32]>,
    probe_ratio: f64,
) -> crate::error::Result<Vec<i32>> {
    let (mut doc, _bytes) = crate::safe_load::load_checked(path)?;
    let analysis = analyze(&mut doc, f64::INFINITY, probe_ratio)
        .map_err(|e| crate::error::CoreError::Unsupported(format!("hidden text: {e}")))?;
    let mut out: Vec<i32> = analysis
        .probe_pages
        .into_iter()
        .filter(|p| match pages {
            Some(list) if !list.is_empty() => list.contains(p),
            _ => true,
        })
        .collect();
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use lopdf::{Stream, dictionary};

    /// 全文字の幅が 500 の Helvetica (Ascent 800 / Descent -200) と、Identity-H の CID フォント
    fn add_fonts(doc: &mut Document) -> (ObjectId, ObjectId) {
        let desc = doc.add_object(dictionary! {
            "Type" => "FontDescriptor",
            "FontName" => "Test",
            "Flags" => 32,
            "Ascent" => 800,
            "Descent" => -200,
            "FontBBox" => vec![0.into(), (-200).into(), 1000.into(), 800.into()],
            "ItalicAngle" => 0,
            "CapHeight" => 700,
            "StemV" => 80,
        });
        let widths: Vec<Object> = (32..=126).map(|_| Object::Integer(500)).collect();
        let simple = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Test",
            "FirstChar" => 32,
            "LastChar" => 126,
            "Widths" => widths,
            "FontDescriptor" => desc,
        });
        let cid = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "CIDFontType2",
            "BaseFont" => "Test",
            "DW" => 1000,
            "CIDSystemInfo" => dictionary! {
                "Registry" => Object::string_literal("Adobe"),
                "Ordering" => Object::string_literal("Identity"),
                "Supplement" => 0,
            },
            "FontDescriptor" => desc,
        });
        let type0 = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type0",
            "BaseFont" => "Test",
            "Encoding" => "Identity-H",
            "DescendantFonts" => vec![Object::Reference(cid)],
        });
        (simple, type0)
    }

    /// 1 ページの PDF を作る。`forms` は (名前, 内容) の Form XObject (Resources はフォント F1 / F2)
    pub(crate) fn build(
        content: &str,
        forms: &[(&str, &str)],
        extra_res: Option<Dictionary>,
    ) -> Document {
        let mut doc = Document::with_version("1.5");
        let (f1, f2) = add_fonts(&mut doc);
        let fonts = dictionary! { "F1" => f1, "F2" => f2 };
        let mut xobjs = Dictionary::new();
        for (name, body) in forms {
            let form_res = dictionary! { "Font" => fonts.clone() };
            let form = Stream::new(
                dictionary! {
                    "Type" => "XObject",
                    "Subtype" => "Form",
                    "BBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
                    "Resources" => form_res,
                },
                body.as_bytes().to_vec(),
            );
            let id = doc.add_object(form);
            xobjs.set(*name, Object::Reference(id));
        }
        let mut res = dictionary! { "Font" => fonts, "XObject" => xobjs };
        if let Some(e) = extra_res {
            for (k, v) in e.iter() {
                res.set(k.clone(), v.clone());
            }
        }
        let cid = doc.add_object(Stream::new(Dictionary::new(), content.as_bytes().to_vec()));
        let pages_id = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
            "Contents" => cid,
            "Resources" => res,
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page)],
                "Count" => 1,
            }),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        doc
    }

    fn page_ops(doc: &Document) -> Vec<Operation> {
        let page = *doc.get_pages().values().next().unwrap();
        let id = doc.get_page_contents(page)[0];
        decode_ops(&stream_bytes(doc, id).unwrap()).unwrap()
    }

    /// 取り除いたあとの Tj/TJ の、(文字列を連結したもの, 位置調整の合計)
    fn shown(ops: &[Operation]) -> Vec<(String, f64)> {
        ops.iter()
            .filter(|o| matches!(o.operator.as_str(), "Tj" | "TJ"))
            .map(|o| {
                let mut s = String::new();
                let mut adj = 0.0;
                for it in show_items(o) {
                    match it {
                        Item::Str(b) => {
                            s.push_str(&b.iter().map(|&c| c as char).collect::<String>())
                        }
                        Item::Adj(n) => adj += n,
                    }
                }
                (s, adj)
            })
            .collect()
    }

    fn strip(doc: &mut Document, ratio: f64) -> Analysis {
        let a = analyze(doc, ratio, f64::INFINITY).unwrap();
        let n = apply_removals(doc, &a);
        assert_eq!(n, a.removed_glyphs);
        a
    }

    #[test]
    fn removes_text_hidden_by_a_later_opaque_rect() {
        let mut doc = build(
            "BT /F1 20 Tf 10 100 Td (ABC) Tj ET\n1 1 1 rg 0 90 100 40 re f\n",
            &[],
            None,
        );
        let a = strip(&mut doc, 0.999);
        assert_eq!(a.removed_glyphs, 3);
        let s = shown(&page_ops(&doc));
        // 文字は無く、送り幅 (500 x 3 = 1500) を位置調整で保つ
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].0, "");
        assert!((s[0].1 - (-1500.0)).abs() < 1e-3, "{s:?}");
    }

    #[test]
    fn keeps_text_drawn_after_the_cover() {
        let mut doc = build(
            "1 1 1 rg 0 90 100 40 re f\nBT /F1 20 Tf 10 100 Td (ABC) Tj ET\n",
            &[],
            None,
        );
        assert_eq!(strip(&mut doc, 0.999).removed_glyphs, 0);
    }

    #[test]
    fn removes_only_the_covered_glyphs_and_keeps_positions() {
        // A (x 10..20) は完全に、B (x 20..30) は半分、覆われる
        let mut doc = build(
            "BT /F1 20 Tf 10 100 Td (ABC) Tj ET\n0 90 25 40 re f\n",
            &[],
            None,
        );
        let a = strip(&mut doc, 0.999);
        assert_eq!(a.removed_glyphs, 1);
        let s = shown(&page_ops(&doc));
        assert_eq!(s[0].0, "BC");
        assert!((s[0].1 - (-500.0)).abs() < 1e-3, "{s:?}");
        // 閾値を 0.5 に下げると B も対象になる
        let mut doc = build(
            "BT /F1 20 Tf 10 100 Td (ABC) Tj ET\n0 90 25 40 re f\n",
            &[],
            None,
        );
        assert_eq!(strip(&mut doc, 0.5).removed_glyphs, 2);
    }

    #[test]
    fn adjustment_includes_char_and_word_spacing() {
        let mut doc = build(
            "BT /F1 20 Tf 2 Tc 4 Tw 10 100 Td (A B) Tj ET\n0 90 100 40 re f\n",
            &[],
            None,
        );
        let a = strip(&mut doc, 0.999);
        assert_eq!(a.removed_glyphs, 3);
        let s = shown(&page_ops(&doc));
        // A: 500 + 2*1000/20, スペース: 500 + (2+4)*1000/20, B: 500 + 2*1000/20
        let want = -((500.0 + 100.0) + (500.0 + 300.0) + (500.0 + 100.0));
        assert!((s[0].1 - want).abs() < 1e-3, "{s:?}");
    }

    #[test]
    fn keeps_invisible_and_translucent_text() {
        // Tr 3 (OCR の透明テキスト層) は残す
        let mut doc = build(
            "BT 3 Tr /F1 20 Tf 10 100 Td (ABC) Tj ET\n0 90 100 40 re f\n",
            &[],
            None,
        );
        assert_eq!(strip(&mut doc, 0.999).removed_glyphs, 0);
        // ca 0.2 の文字は透明な文字で、埋もれた文字とは別物
        let mut ext = Dictionary::new();
        ext.set(
            "ExtGState",
            dictionary! { "G" => dictionary! { "ca" => 0.2 } },
        );
        let mut doc = build(
            "/G gs BT /F1 20 Tf 10 100 Td (ABC) Tj ET\n/H gs 0 90 100 40 re f\n",
            &[],
            Some(ext),
        );
        assert_eq!(strip(&mut doc, 0.999).removed_glyphs, 0);
    }

    #[test]
    fn translucent_or_non_rect_covers_do_not_remove_but_probe() {
        let mut ext = Dictionary::new();
        ext.set(
            "ExtGState",
            dictionary! { "G" => dictionary! { "ca" => 0.5 } },
        );
        let content = "BT /F1 20 Tf 10 100 Td (ABC) Tj ET\n/G gs 0 90 100 40 re f\n";
        let mut doc = build(content, &[], Some(ext));
        let a = analyze(&mut doc, 0.999, 0.002).unwrap();
        assert_eq!(a.removed_glyphs, 0);
        assert_eq!(a.probe_pages, vec![1]);
        // 曲線を含む塗り (丸い図形) は、覆いとして数えない
        let mut doc = build(
            "BT /F1 20 Tf 10 100 Td (ABC) Tj ET\n0 90 m 100 90 l 100 130 100 130 50 130 c 0 130 l h f\n",
            &[],
            None,
        );
        let a = analyze(&mut doc, 0.999, 0.002).unwrap();
        assert_eq!(a.removed_glyphs, 0);
        assert_eq!(a.probe_pages, vec![1]);
        // 離れた場所の塗りは、probe にもならない
        let mut doc = build(
            "BT /F1 20 Tf 10 100 Td (ABC) Tj ET\n150 10 30 30 re f\n",
            &[],
            None,
        );
        let a = analyze(&mut doc, 0.999, 0.002).unwrap();
        assert!(a.probe_pages.is_empty());
    }

    #[test]
    fn closed_path_rectangle_counts_as_a_cover() {
        let mut doc = build(
            "BT /F1 20 Tf 10 100 Td (ABC) Tj ET\n0 90 m 100 90 l 100 130 l 0 130 l h f\n",
            &[],
            None,
        );
        assert_eq!(strip(&mut doc, 0.999).removed_glyphs, 3);
    }

    #[test]
    fn rotated_ctm_cover_is_not_opaque_rect() {
        let mut doc = build(
            "BT /F1 20 Tf 10 100 Td (ABC) Tj ET\nq 0.9 0.4 -0.4 0.9 0 0 cm 0 90 100 40 re f Q\n",
            &[],
            None,
        );
        assert_eq!(strip(&mut doc, 0.999).removed_glyphs, 0);
    }

    #[test]
    fn non_rect_clip_makes_cover_untrusted() {
        // 三角形のクリップの下の塗りは、形が分からないので覆いにしない
        let mut doc = build(
            "BT /F1 20 Tf 10 100 Td (ABC) Tj ET\nq 0 90 m 100 90 l 50 200 l h W n 0 90 100 40 re f Q\n",
            &[],
            None,
        );
        assert_eq!(strip(&mut doc, 0.999).removed_glyphs, 0);
        // 矩形のクリップなら、クリップの内側だけが覆いになる
        let mut doc = build(
            "BT /F1 20 Tf 10 100 Td (ABC) Tj ET\nq 0 0 25 200 re W n 0 90 100 40 re f Q\n",
            &[],
            None,
        );
        let a = strip(&mut doc, 0.999);
        assert_eq!(a.removed_glyphs, 1);
    }

    #[test]
    fn image_cover_needs_no_mask() {
        let mut doc = build(
            "BT /F1 20 Tf 10 100 Td (ABC) Tj ET\nq 100 0 0 40 0 90 cm /Im1 Do Q\n",
            &[],
            None,
        );
        let page = *doc.get_pages().values().next().unwrap();
        let img = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
                "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
            },
            vec![0u8],
        ));
        let masked = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
                "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "SMask" => img,
            },
            vec![0u8],
        ));
        let set = |doc: &mut Document, target: ObjectId| {
            let pd = doc.get_object_mut(page).unwrap().as_dict_mut().unwrap();
            let res = pd.get_mut(b"Resources").unwrap().as_dict_mut().unwrap();
            let xo = res.get_mut(b"XObject").unwrap().as_dict_mut().unwrap();
            xo.set("Im1", Object::Reference(target));
        };
        let mut d1 = doc.clone();
        set(&mut d1, img);
        assert_eq!(strip(&mut d1, 0.999).removed_glyphs, 3);
        // SMask 付き (透けうる画像) は覆いにしない
        set(&mut doc, masked);
        assert_eq!(strip(&mut doc, 0.999).removed_glyphs, 0);
    }

    #[test]
    fn two_byte_cid_text_is_removed_per_code() {
        // 幅 1000: 文字 x 10..30, 30..50, 50..70。最初の 2 つだけ覆う
        let mut doc = build(
            "BT /F2 20 Tf 10 100 Td <004100420043> Tj ET\n0 90 55 40 re f\n",
            &[],
            None,
        );
        let a = strip(&mut doc, 0.999);
        assert_eq!(a.removed_glyphs, 2);
        let ops = page_ops(&doc);
        let o = ops.iter().find(|o| o.operator == "TJ").unwrap();
        let items = show_items(o);
        match (&items[0], &items[1]) {
            (Item::Adj(n), Item::Str(s)) => {
                assert!((n - (-2000.0)).abs() < 1e-3);
                assert_eq!(*s, [0u8, 0x43]);
            }
            _ => panic!("unexpected items"),
        }
    }

    #[test]
    fn tj_array_with_adjustments_keeps_other_numbers() {
        let mut doc = build(
            "BT /F1 20 Tf 10 100 Td [(AB) -250 (CD)] TJ ET\n0 90 25 40 re f\n",
            &[],
            None,
        );
        // A (10..20) と B (20..30 の半分) → A のみ
        let a = strip(&mut doc, 0.999);
        assert_eq!(a.removed_glyphs, 1);
        let s = shown(&page_ops(&doc));
        assert_eq!(s[0].0, "BCD");
        assert!((s[0].1 - (-750.0)).abs() < 1e-3, "{s:?}");
    }

    #[test]
    fn form_text_is_voted_across_invocations() {
        // Form の中の文字: ページで 1 回だけ呼んで、後から覆う → 除去
        let form = "BT /F1 20 Tf 10 100 Td (ABC) Tj ET";
        let mut doc = build("/X1 Do\n0 90 100 40 re f\n", &[("X1", form)], None);
        let a = strip(&mut doc, 0.999);
        assert_eq!(a.removed_glyphs, 3);
        // 2 回呼び、1 回目だけ覆う → 2 回目では見えているので残す
        let mut doc = build(
            "/X1 Do\n0 90 100 40 re f\nq 1 0 0 1 0 -80 cm /X1 Do Q\n",
            &[("X1", form)],
            None,
        );
        assert_eq!(strip(&mut doc, 0.999).removed_glyphs, 0);
    }

    #[test]
    fn form_shared_by_two_references_is_left_alone() {
        let form = "BT /F1 20 Tf 10 100 Td (ABC) Tj ET";
        let mut doc = build("/X1 Do\n0 90 100 40 re f\n", &[("X1", form)], None);
        // 同じ Form を指す参照をもう 1 つ増やす (走査していない所から呼ばれうる)
        let page = *doc.get_pages().values().next().unwrap();
        let id = {
            let pd = doc.get_object(page).unwrap().as_dict().unwrap();
            let res = pd.get(b"Resources").unwrap().as_dict().unwrap();
            let xo = res.get(b"XObject").unwrap().as_dict().unwrap();
            xo.get(b"X1").unwrap().as_reference().unwrap()
        };
        let extra = doc.add_object(dictionary! { "Other" => id });
        let _ = extra;
        let a = analyze(&mut doc, 0.999, f64::INFINITY).unwrap();
        assert_eq!(a.removed_glyphs, 0);
    }

    #[test]
    fn unsupported_page_blocks_form_removal_and_is_probed() {
        // 2 ページ目にインライン画像: 解析できない → Form の中の除去はしない
        let form = "BT /F1 20 Tf 10 100 Td (ABC) Tj ET";
        let mut doc = build("/X1 Do\n0 90 100 40 re f\n", &[("X1", form)], None);
        // ページ内容にインライン画像を足す
        let page = *doc.get_pages().values().next().unwrap();
        let cid = doc.get_page_contents(page)[0];
        if let Ok(Object::Stream(s)) = doc.get_object_mut(cid) {
            s.set_plain_content(
                b"/X1 Do\n0 90 100 40 re f\nq 1 0 0 1 0 0 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \x00 EI Q\n"
                    .to_vec(),
            );
        }
        let a = analyze(&mut doc, 0.999, 0.002).unwrap();
        assert_eq!(a.removed_glyphs, 0);
        assert_eq!(a.probe_pages, vec![1]);
        assert_eq!(a.unsupported.len(), 1);
    }

    #[test]
    fn broken_flate_page_is_not_touched() {
        let mut doc = build(
            "BT /F1 20 Tf 10 100 Td (ABC) Tj ET\n0 90 100 40 re f\n",
            &[],
            None,
        );
        let page = *doc.get_pages().values().next().unwrap();
        let cid = doc.get_page_contents(page)[0];
        if let Ok(Object::Stream(s)) = doc.get_object_mut(cid) {
            s.dict.set("Filter", "FlateDecode");
            s.content = vec![0x78, 0x9c, 0xff, 0xff, 0xff];
        }
        let a = analyze(&mut doc, 0.999, 0.002).unwrap();
        assert_eq!(a.removed_glyphs, 0);
        assert_eq!(a.unsupported.len(), 1);
    }

    #[test]
    fn unknown_font_width_means_no_removal() {
        // /Widths の無いフォント (標準 14 など) は幅が分からないので、触らない
        let mut doc = build(
            "BT /F9 20 Tf 10 100 Td (ABC) Tj ET\n0 90 100 40 re f\n",
            &[],
            None,
        );
        let page = *doc.get_pages().values().next().unwrap();
        let f9 = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
        });
        {
            let pd = doc.get_object_mut(page).unwrap().as_dict_mut().unwrap();
            let res = pd.get_mut(b"Resources").unwrap().as_dict_mut().unwrap();
            let fonts = res.get_mut(b"Font").unwrap().as_dict_mut().unwrap();
            fonts.set("F9", Object::Reference(f9));
        }
        assert_eq!(strip(&mut doc, 0.999).removed_glyphs, 0);
    }

    #[test]
    fn rewritten_content_round_trips_through_save() {
        let mut doc = build(
            "BT /F1 20 Tf 10 100 Td (A\\(B) Tj 0 -30 Td (XYZ) Tj ET\n0 90 100 40 re f\n",
            &[],
            None,
        );
        let a = strip(&mut doc, 0.999);
        assert_eq!(a.removed_glyphs, 3);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        let doc2 = Document::load_mem(&buf).unwrap();
        let s = shown(&page_ops(&doc2));
        assert_eq!(s[0].0, "");
        assert_eq!(s[1].0, "XYZ");
    }

    #[test]
    fn page_count_and_encrypted_guard() {
        let mut doc = build("BT ET\n", &[], None);
        let a = analyze(&mut doc, 0.999, 0.002).unwrap();
        assert!(a.probe_pages.is_empty());
        assert!(!a.has_removals());
    }
}
