// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/crop_redact_lopdf.rs
// CropBox 外の除去 (crop_cleanup::redact_outside_cropbox) の lopdf 実装。MuPDF を使わない。
//
// MuPDF 実装は redaction (CropBox 外の 4 本の帯) で、境界をまたぐ文字・パス・画像も
// 境界で切り取る。こちらは内容ストリームを解釈して、CropBox (+ 余白) に「完全に」
// 外れているものだけを削除する。境界をまたぐものは残すので、CropBox 内の見た目は
// 変わらない (その分、境界付近は MuPDF 実装より多く残る)。
//
// 削除するもの (いずれも、外接矩形が CropBox + 余白 の外にあるときだけ):
//   - パスの描画 (構築 + 塗り/線)。クリップ (W / W*) を伴うパスは残す
//   - XObject の Do (画像と Form)。Form の中までは入らない
//   - テキストの表示 (Tj / TJ)。幅が分かるフォントだけ。削除した文字列の送り幅は
//     TJ の位置調整で再現し、後続のテキストの位置がずれないようにする
// 削除で参照されなくなった XObject は、そのページのリソースから外す (リソース辞書は
// ページごとの複製にするので、他のページと共有している辞書は書き換えない)。
// オブジェクトの実体は、保存前の prune で落ちる。
//
// 残す・触らないもの:
//   - インライン画像 (BI) を含むページ、内容ストリームが読めない/不完全なページ
//   - 幅が分からないフォント (標準 14 フォントの /Widths 無し、Type3、縦書き、
//     Identity 以外の CMap)、描画モードがクリップを含むテキスト (Tr 4〜7)
//   - 注釈、Form の内部
//
// 暗号化された入力は Err (Unsupported)。呼び出し側が MuPDF 実装へフォールバックする。

use crate::compress_lopdf::{clean_trailer, prune, save_checked};
use crate::crop_cleanup::{CROPBOX_EPS, DEFAULT_REDACT_MARGIN_PT, RedactMargins, RedactStats};
use crate::error::{CoreError, Result};
use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use std::collections::{HashMap, HashSet};

// ── 幾何 ──────────────────────────────────────────────────────────────────

/// PDF の変換行列 [a b c d e f]。点は行ベクトルで、`mul(m, n)` は「m の後に n」。
type Mat = [f64; 6];
const IDENT: Mat = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

fn mul(m: &Mat, n: &Mat) -> Mat {
    [
        m[0] * n[0] + m[1] * n[2],
        m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2],
        m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4],
        m[4] * n[1] + m[5] * n[3] + n[5],
    ]
}

fn apply(m: &Mat, x: f64, y: f64) -> (f64, f64) {
    (x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5])
}

#[derive(Clone, Copy, Debug)]
struct Rect {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

impl Rect {
    fn grow(self, d: f64) -> Rect {
        Rect {
            x0: self.x0 - d,
            y0: self.y0 - d,
            x1: self.x1 + d,
            y1: self.y1 + d,
        }
    }

    /// `other` と一切重ならない (接してもいない)
    fn is_outside(&self, other: &Rect) -> bool {
        self.x1 < other.x0 || self.x0 > other.x1 || self.y1 < other.y0 || self.y0 > other.y1
    }
}

/// 矩形 [x0 y0 x1 y1] を `m` で変換した、外接矩形
fn transform_rect(m: &Mat, r: [f64; 4]) -> Rect {
    let pts = [
        apply(m, r[0], r[1]),
        apply(m, r[2], r[1]),
        apply(m, r[2], r[3]),
        apply(m, r[0], r[3]),
    ];
    let mut out = Rect {
        x0: f64::MAX,
        y0: f64::MAX,
        x1: f64::MIN,
        y1: f64::MIN,
    };
    for (x, y) in pts {
        out.x0 = out.x0.min(x);
        out.y0 = out.y0.min(y);
        out.x1 = out.x1.max(x);
        out.y1 = out.y1.max(y);
    }
    out
}

// ── オブジェクトの読み取り ────────────────────────────────────────────────

static NULL: Object = Object::Null;

/// 間接参照をたどる (深さ 16 まで)。無ければ null
fn deref<'a>(doc: &'a Document, o: &'a Object) -> &'a Object {
    let mut cur = o;
    for _ in 0..16 {
        match cur {
            Object::Reference(id) => match doc.objects.get(id) {
                Some(next) => cur = next,
                None => return &NULL,
            },
            _ => return cur,
        }
    }
    &NULL
}

fn num(o: &Object) -> Option<f64> {
    match o {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(f64::from(*r)),
        _ => None,
    }
}

fn num_deref(doc: &Document, o: &Object) -> Option<f64> {
    num(deref(doc, o))
}

fn dict_of<'a>(doc: &'a Document, o: &'a Object) -> Option<&'a Dictionary> {
    match deref(doc, o) {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&s.dict),
        _ => None,
    }
}

fn sub_dict<'a>(doc: &'a Document, d: &'a Dictionary, key: &[u8]) -> Option<&'a Dictionary> {
    d.get(key).ok().and_then(|o| dict_of(doc, o))
}

/// ページ → 親の順で、属性を探す (MediaBox / CropBox / Resources の継承)
fn inherited<'a>(doc: &'a Document, page_id: ObjectId, key: &[u8]) -> Option<&'a Object> {
    let mut id = page_id;
    for _ in 0..32 {
        let d = doc.get_dictionary(id).ok()?;
        if let Ok(v) = d.get(key) {
            return Some(v);
        }
        match d.get(b"Parent") {
            Ok(Object::Reference(p)) => id = *p,
            _ => return None,
        }
    }
    None
}

/// [x0 y0 x1 y1] を読む。x0 < x1、y0 < y1 に直す
fn parse_box(doc: &Document, o: &Object) -> Option<[f64; 4]> {
    let arr = deref(doc, o).as_array().ok()?;
    if arr.len() < 4 {
        return None;
    }
    let v: Vec<f64> = arr
        .iter()
        .take(4)
        .map(|x| num_deref(doc, x))
        .collect::<Option<_>>()?;
    Some([
        v[0].min(v[2]),
        v[1].min(v[3]),
        v[0].max(v[2]),
        v[1].max(v[3]),
    ])
}

/// ページの内容ストリームを連結して返す。デコードできないストリームがあれば None
fn page_content(doc: &Document, page_id: ObjectId) -> Option<Vec<u8>> {
    const LIMIT: usize = 512 * 1024 * 1024;
    let mut out = Vec::new();
    for id in doc.get_page_contents(page_id) {
        let s = doc.get_object(id).ok()?.as_stream().ok()?;
        let remaining = LIMIT.saturating_sub(out.len());
        let data = s.decompressed_content_with_limit(remaining).ok()?;
        out.extend_from_slice(&data);
        out.push(b'\n');
    }
    Some(out)
}

// ── フォントの幅 ──────────────────────────────────────────────────────────

enum Widths {
    /// 1 バイト 1 文字。code - first の位置の幅 (範囲外は missing)
    Simple {
        first: i64,
        widths: Vec<f64>,
        missing: f64,
    },
    /// Identity-H の 2 バイト 1 文字。CID ごとの幅 (無ければ dw)
    Cid { dw: f64, w: HashMap<u32, f64> },
}

struct FontInfo {
    widths: Widths,
    /// グリフが原点から広がる範囲の上限 (em 単位)。FontBBox が無ければ大きめの値
    glyph_em: f64,
}

fn font_bbox_em(doc: &Document, desc: Option<&Dictionary>) -> f64 {
    let bbox = desc
        .and_then(|d| d.get(b"FontBBox").ok())
        .and_then(|o| deref(doc, o).as_array().ok())
        .map(|a| {
            a.iter()
                .filter_map(|x| num_deref(doc, x))
                .collect::<Vec<_>>()
        });
    match bbox {
        Some(v) if v.len() == 4 => {
            let m = v.iter().fold(0.0f64, |acc, x| acc.max(x.abs()));
            (m / 1000.0).max(1.0) * 1.25
        }
        _ => 3.0,
    }
}

/// CIDFont の /W を読む: `c [w1 w2 ...]` と `c_first c_last w` の 2 形式
fn parse_cid_widths(doc: &Document, arr: &[Object]) -> HashMap<u32, f64> {
    let mut map = HashMap::new();
    let mut i = 0;
    while i < arr.len() {
        let Some(first) = num_deref(doc, &arr[i]) else {
            break;
        };
        let Some(next) = arr.get(i + 1) else { break };
        match deref(doc, next) {
            Object::Array(list) => {
                for (k, w) in list.iter().enumerate() {
                    if let Some(w) = num_deref(doc, w) {
                        map.insert(first as u32 + k as u32, w);
                    }
                }
                i += 2;
            }
            other => {
                let (Some(last), Some(w)) =
                    (num(other), arr.get(i + 2).and_then(|x| num_deref(doc, x)))
                else {
                    break;
                };
                // 範囲が極端に大きい指定は無視する (メモリを食わないため)
                if last >= first && last - first <= 70000.0 {
                    for c in first as u32..=last as u32 {
                        map.insert(c, w);
                    }
                }
                i += 3;
            }
        }
    }
    map
}

fn load_font(doc: &Document, font: &Dictionary) -> Option<FontInfo> {
    let subtype = font
        .get(b"Subtype")
        .ok()
        .and_then(|o| deref(doc, o).as_name().ok())?;
    match subtype {
        b"Type1" | b"MMType1" | b"TrueType" => {
            let first = num_deref(doc, font.get(b"FirstChar").ok()?)? as i64;
            let arr = deref(doc, font.get(b"Widths").ok()?).as_array().ok()?;
            let widths: Vec<f64> = arr
                .iter()
                .map(|x| num_deref(doc, x))
                .collect::<Option<_>>()?;
            let desc = sub_dict(doc, font, b"FontDescriptor");
            let missing = desc
                .and_then(|d| d.get(b"MissingWidth").ok())
                .and_then(|o| num_deref(doc, o))
                .unwrap_or(0.0);
            Some(FontInfo {
                widths: Widths::Simple {
                    first,
                    widths,
                    missing,
                },
                glyph_em: font_bbox_em(doc, desc),
            })
        }
        b"Type0" => {
            // 2 バイト固定の Identity-H だけ扱う (縦書きや他の CMap は文字コードの切り方が違う)
            let enc = deref(doc, font.get(b"Encoding").ok()?).as_name().ok()?;
            if enc != b"Identity-H" {
                return None;
            }
            let desc_fonts = deref(doc, font.get(b"DescendantFonts").ok()?)
                .as_array()
                .ok()?;
            let cid = dict_of(doc, desc_fonts.first()?)?;
            let dw = cid
                .get(b"DW")
                .ok()
                .and_then(|o| num_deref(doc, o))
                .unwrap_or(1000.0);
            let w = cid
                .get(b"W")
                .ok()
                .and_then(|o| deref(doc, o).as_array().ok())
                .map(|a| parse_cid_widths(doc, a))
                .unwrap_or_default();
            let desc = sub_dict(doc, cid, b"FontDescriptor");
            Some(FontInfo {
                widths: Widths::Cid { dw, w },
                glyph_em: font_bbox_em(doc, desc),
            })
        }
        _ => None, // Type3 など
    }
}

// ── XObject ───────────────────────────────────────────────────────────────

enum XKind {
    Image,
    Form { bbox: [f64; 4], matrix: Mat },
}

struct XInfo {
    kind: XKind,
    /// Form が自前の /Resources を持つか (持たないと、ページのリソースを使う)
    own_resources: bool,
}

fn load_xobject(doc: &Document, o: &Object) -> Option<XInfo> {
    let s = deref(doc, o).as_stream().ok()?;
    let subtype = s
        .dict
        .get(b"Subtype")
        .ok()
        .and_then(|o| deref(doc, o).as_name().ok())?;
    match subtype {
        b"Image" => Some(XInfo {
            kind: XKind::Image,
            own_resources: true,
        }),
        b"Form" => {
            let bbox = parse_box(doc, s.dict.get(b"BBox").ok()?)?;
            let matrix = s
                .dict
                .get(b"Matrix")
                .ok()
                .and_then(|o| deref(doc, o).as_array().ok())
                .and_then(|a| {
                    let v: Vec<f64> = a
                        .iter()
                        .take(6)
                        .map(|x| num_deref(doc, x))
                        .collect::<Option<_>>()?;
                    (v.len() == 6).then(|| [v[0], v[1], v[2], v[3], v[4], v[5]])
                })
                .unwrap_or(IDENT);
            Some(XInfo {
                kind: XKind::Form { bbox, matrix },
                own_resources: s.dict.get(b"Resources").is_ok(),
            })
        }
        _ => None,
    }
}

// ── グラフィックス状態 ────────────────────────────────────────────────────

#[derive(Clone)]
struct Gs {
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
    lw: f64,
    miter: f64,
}

impl Default for Gs {
    fn default() -> Self {
        Gs {
            ctm: IDENT,
            font: None,
            size: 0.0,
            tc: 0.0,
            tw: 0.0,
            th: 1.0,
            tl: 0.0,
            trise: 0.0,
            tr: 0,
            lw: 1.0,
            miter: 10.0,
        }
    }
}

#[derive(Default)]
struct PathAcc {
    /// 出力 `out` の中で、このパスの最初の構築命令の位置
    start: Option<usize>,
    bbox: Option<Rect>,
    clip: bool,
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
    }
}

fn operand_nums(op: &Operation) -> Option<Vec<f64>> {
    op.operands.iter().map(num).collect()
}

fn mat_of(op: &Operation) -> Option<Mat> {
    let v = operand_nums(op)?;
    (v.len() == 6).then(|| [v[0], v[1], v[2], v[3], v[4], v[5]])
}

fn is_path_op(name: &str) -> bool {
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

/// 文字列を表示したときの (最小 x, 最大 x, 送り幅)。テキスト空間の単位。
/// 幅が分からなければ None。
fn measure(gs: &Gs, font: &FontInfo, items: &[Item]) -> Option<(f64, f64, f64)> {
    let mut x = 0.0f64;
    let (mut lo, mut hi) = (0.0f64, 0.0f64);
    for item in items {
        match item {
            Item::Adj(n) => x -= n / 1000.0 * gs.size * gs.th,
            Item::Str(s) => match &font.widths {
                Widths::Simple {
                    first,
                    widths,
                    missing,
                } => {
                    for &b in *s {
                        let idx = i64::from(b) - first;
                        let w = usize::try_from(idx)
                            .ok()
                            .and_then(|i| widths.get(i))
                            .copied()
                            .unwrap_or(*missing);
                        let tw = if b == 32 { gs.tw } else { 0.0 };
                        x += (w / 1000.0 * gs.size + gs.tc + tw) * gs.th;
                        lo = lo.min(x);
                        hi = hi.max(x);
                    }
                }
                Widths::Cid { dw, w } => {
                    if s.len() % 2 != 0 {
                        return None;
                    }
                    for ch in s.chunks(2) {
                        let code = u32::from(ch[0]) << 8 | u32::from(ch[1]);
                        let wd = w.get(&code).copied().unwrap_or(*dw);
                        x += (wd / 1000.0 * gs.size + gs.tc) * gs.th;
                        lo = lo.min(x);
                        hi = hi.max(x);
                    }
                }
            },
        }
        lo = lo.min(x);
        hi = hi.max(x);
    }
    Some((lo, hi, x))
}

// ── ページの処理 ──────────────────────────────────────────────────────────

#[derive(Default, Debug, Clone, Copy)]
struct Counts {
    paths: usize,
    xobjects: usize,
    texts: usize,
}

impl Counts {
    fn total(&self) -> usize {
        self.paths + self.xobjects + self.texts
    }
}

struct PageEdit {
    content: Vec<u8>,
    counts: Counts,
    /// 差し替える Resources (削除した XObject を外したもの)。None = 変更しない
    resources: Option<Dictionary>,
}

/// ページの内容から、`keep` に完全に外れているものを取り除く。
/// 何も取り除けない・安全に扱えないページは None。
fn process_page(doc: &Document, page_id: ObjectId, keep: &Rect) -> Option<PageEdit> {
    let bytes = page_content(doc, page_id)?;
    let content = Content::decode_strict(&bytes).ok()?;
    let ops = content.operations;
    if ops.is_empty()
        || ops
            .iter()
            .any(|o| matches!(o.operator.as_str(), "BI" | "ID" | "EI"))
    {
        return None;
    }

    let res = inherited(doc, page_id, b"Resources").and_then(|o| dict_of(doc, o));
    let xobjs = res.and_then(|r| sub_dict(doc, r, b"XObject"));
    let fonts = res.and_then(|r| sub_dict(doc, r, b"Font"));
    let ext = res.and_then(|r| sub_dict(doc, r, b"ExtGState"));

    let mut xcache: HashMap<Vec<u8>, Option<XInfo>> = HashMap::new();
    let mut fcache: HashMap<Vec<u8>, Option<FontInfo>> = HashMap::new();

    let mut out: Vec<Operation> = Vec::with_capacity(ops.len());
    let mut counts = Counts::default();
    let mut gs = Gs::default();
    let mut stack: Vec<Gs> = Vec::new();
    let mut tm = IDENT;
    let mut tlm = IDENT;
    // 幅の分からない文字列を表示したあとは、次の位置指定までテキスト位置が分からない
    let mut tm_valid = true;
    let mut path = PathAcc::default();

    for op in ops {
        let name = op.operator.clone();
        let name = name.as_str();
        // パスの途中で、パスと無関係な命令が来たら、そのパスは追跡をやめる (残す)
        if path.start.is_some() && !is_path_op(name) {
            path = PathAcc::default();
        }
        match name {
            "q" => {
                stack.push(gs.clone());
                out.push(op);
            }
            "Q" => {
                if let Some(g) = stack.pop() {
                    gs = g;
                }
                out.push(op);
            }
            "cm" => {
                if let Some(m) = mat_of(&op) {
                    gs.ctm = mul(&m, &gs.ctm);
                }
                out.push(op);
            }
            "w" => {
                if let Some(v) = op.operands.first().and_then(num) {
                    gs.lw = v.abs();
                }
                out.push(op);
            }
            "M" => {
                if let Some(v) = op.operands.first().and_then(num) {
                    gs.miter = v.abs();
                }
                out.push(op);
            }
            "gs" => {
                let d = op
                    .operands
                    .first()
                    .and_then(|o| o.as_name().ok())
                    .and_then(|n| ext.and_then(|e| sub_dict(doc, e, n)));
                if let Some(d) = d {
                    if let Some(v) = d.get(b"LW").ok().and_then(|o| num_deref(doc, o)) {
                        gs.lw = v.abs();
                    }
                    if let Some(v) = d.get(b"ML").ok().and_then(|o| num_deref(doc, o)) {
                        gs.miter = v.abs();
                    }
                }
                out.push(op);
            }
            // ── パス ──
            "m" | "l" | "c" | "v" | "y" | "re" | "h" => {
                if path.start.is_none() {
                    path.start = Some(out.len());
                }
                if let Some(v) = operand_nums(&op) {
                    if name == "re" && v.len() == 4 {
                        let r = transform_rect(&gs.ctm, [v[0], v[1], v[0] + v[2], v[1] + v[3]]);
                        path.add((r.x0, r.y0));
                        path.add((r.x1, r.y1));
                    } else {
                        for p in v.chunks_exact(2) {
                            path.add(apply(&gs.ctm, p[0], p[1]));
                        }
                    }
                }
                out.push(op);
            }
            "W" | "W*" => {
                path.clip = true;
                out.push(op);
            }
            "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" | "n" => {
                let stroke = matches!(name, "S" | "s" | "B" | "B*" | "b" | "b*");
                let removable = name != "n" && !path.clip && path.start.is_some() && {
                    match path.bbox {
                        Some(b) => {
                            let m = &gs.ctm;
                            // 線の太さ・ミター・キャップで広がる分 (CTM のノルムの上限で見積もる)
                            let scale =
                                (m[0] * m[0] + m[1] * m[1] + m[2] * m[2] + m[3] * m[3]).sqrt();
                            let grow = if stroke {
                                (gs.lw * scale * gs.miter.max(1.5)).max(2.0)
                            } else {
                                0.0
                            };
                            b.grow(grow).is_outside(keep)
                        }
                        None => false,
                    }
                };
                if removable {
                    if let Some(start) = path.start {
                        out.truncate(start);
                    }
                    counts.paths += 1;
                } else {
                    out.push(op);
                }
                path = PathAcc::default();
            }
            // ── XObject ──
            "Do" => {
                let nm = op.operands.first().and_then(|o| o.as_name().ok());
                let remove = nm.is_some_and(|n| {
                    let info = xcache.entry(n.to_vec()).or_insert_with(|| {
                        xobjs
                            .and_then(|x| x.get(n).ok())
                            .and_then(|o| load_xobject(doc, o))
                    });
                    match info.as_ref().map(|i| &i.kind) {
                        Some(XKind::Image) => {
                            transform_rect(&gs.ctm, [0.0, 0.0, 1.0, 1.0]).is_outside(keep)
                        }
                        Some(XKind::Form { bbox, matrix }) => {
                            transform_rect(&mul(matrix, &gs.ctm), *bbox).is_outside(keep)
                        }
                        None => false,
                    }
                });
                if remove {
                    counts.xobjects += 1;
                } else {
                    out.push(op);
                }
            }
            // ── テキスト ──
            "BT" => {
                tm = IDENT;
                tlm = IDENT;
                tm_valid = true;
                out.push(op);
            }
            "Tf" => {
                gs.font = op
                    .operands
                    .first()
                    .and_then(|o| o.as_name().ok())
                    .map(<[u8]>::to_vec);
                gs.size = op.operands.get(1).and_then(num).unwrap_or(0.0);
                out.push(op);
            }
            "Tc" | "Tw" | "Tz" | "TL" | "Ts" | "Tr" => {
                if let Some(v) = op.operands.first().and_then(num) {
                    match name {
                        "Tc" => gs.tc = v,
                        "Tw" => gs.tw = v,
                        "Tz" => gs.th = v / 100.0,
                        "TL" => gs.tl = v,
                        "Ts" => gs.trise = v,
                        _ => gs.tr = v as i64,
                    }
                }
                out.push(op);
            }
            "Td" | "TD" => {
                if let Some(v) = operand_nums(&op).filter(|v| v.len() == 2) {
                    if name == "TD" {
                        gs.tl = -v[1];
                    }
                    tlm = mul(&[1.0, 0.0, 0.0, 1.0, v[0], v[1]], &tlm);
                    tm = tlm;
                    tm_valid = true;
                } else {
                    tm_valid = false;
                }
                out.push(op);
            }
            "Tm" => {
                match mat_of(&op) {
                    Some(m) => {
                        tlm = m;
                        tm = m;
                        tm_valid = true;
                    }
                    None => tm_valid = false,
                }
                out.push(op);
            }
            "T*" => {
                tlm = mul(&[1.0, 0.0, 0.0, 1.0, 0.0, -gs.tl], &tlm);
                tm = tlm;
                tm_valid = true;
                out.push(op);
            }
            "Tj" | "TJ" | "'" | "\"" => {
                // ' と " は、次の行へ移ってから表示する。" は先に語間・字間を設定する
                if name == "'" || name == "\"" {
                    if name == "\"" {
                        if let Some(aw) = op.operands.first().and_then(num) {
                            gs.tw = aw;
                        }
                        if let Some(ac) = op.operands.get(1).and_then(num) {
                            gs.tc = ac;
                        }
                    }
                    tlm = mul(&[1.0, 0.0, 0.0, 1.0, 0.0, -gs.tl], &tlm);
                    tm = tlm;
                    tm_valid = true;
                }
                let mut items: Vec<Item> = Vec::new();
                match name {
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

                let font = gs.font.clone().and_then(|n| {
                    fcache
                        .entry(n.clone())
                        .or_insert_with(|| {
                            fonts
                                .and_then(|f| sub_dict(doc, f, &n))
                                .and_then(|d| load_font(doc, d))
                        })
                        .as_ref()
                        .map(|f| (f.glyph_em, measure(&gs, f, &items)))
                });
                match font {
                    Some((glyph_em, Some((lo, hi, adv)))) => {
                        let step = gs.size * gs.th;
                        let removable = matches!(name, "Tj" | "TJ")
                            && tm_valid
                            && gs.tr < 4
                            && step.abs() > 1e-9
                            && {
                                let gy = glyph_em * gs.size.abs();
                                let gx = gy * gs.th.abs().max(1.0);
                                let m = mul(&tm, &gs.ctm);
                                transform_rect(&m, [lo - gx, gs.trise - gy, hi + gx, gs.trise + gy])
                                    .is_outside(keep)
                            };
                        if removable {
                            counts.texts += 1;
                            // 文字列を消す代わりに、同じ送り幅だけ位置を進める
                            if adv.abs() > 1e-9 {
                                let n = (-adv * 1000.0 / step) as f32;
                                out.push(Operation::new(
                                    "TJ",
                                    vec![Object::Array(vec![Object::Real(n)])],
                                ));
                            }
                        } else {
                            out.push(op);
                        }
                        if tm_valid {
                            tm = mul(&[1.0, 0.0, 0.0, 1.0, adv, 0.0], &tm);
                        }
                    }
                    _ => {
                        tm_valid = false;
                        out.push(op);
                    }
                }
            }
            _ => out.push(op),
        }
    }

    if counts.total() == 0 {
        return None;
    }

    // 削除した Do が参照していた XObject をリソースから外す。
    // ページのリソースを使う Form (自前の /Resources が無いもの) が残っていると、
    // その中でどの名前が使われるか分からないので、外さない。
    let mut resources = None;
    if counts.xobjects > 0 {
        if let (Some(res), Some(xo)) = (res, xobjs) {
            let used: HashSet<Vec<u8>> = out
                .iter()
                .filter(|o| o.operator == "Do")
                .filter_map(|o| o.operands.first().and_then(|x| x.as_name().ok()))
                .map(<[u8]>::to_vec)
                .collect();
            let needs_page_resources = used.iter().any(|n| {
                xo.get(n)
                    .ok()
                    .and_then(|o| load_xobject(doc, o))
                    .is_some_and(|i| matches!(i.kind, XKind::Form { .. }) && !i.own_resources)
            });
            if !needs_page_resources {
                let mut nx = Dictionary::new();
                for (k, v) in xo.iter() {
                    if used.contains(k) {
                        nx.set(k.clone(), v.clone());
                    }
                }
                let mut new_res = res.clone();
                new_res.set("XObject", Object::Dictionary(nx));
                resources = Some(new_res);
            }
        }
    }

    let content = Content { operations: out }.encode().ok()?;
    Some(PageEdit {
        content,
        counts,
        resources,
    })
}

// ── 入口 ──────────────────────────────────────────────────────────────────

/// 全ページの CropBox 外側を、内容ストリームの解釈で取り除く。
/// 失敗や未対応の入力は Err。呼び出し側が MuPDF 実装へフォールバックする。
pub(crate) fn redact_with_lopdf(
    input: &str,
    output: &str,
    margins: Option<RedactMargins>,
) -> Result<RedactStats> {
    let (mut doc, _bytes) = crate::safe_load::load_checked(input)?;
    if doc.is_encrypted() || doc.was_encrypted() {
        return Err(CoreError::Unsupported(
            "lopdf crop redaction does not support encrypted PDFs".into(),
        ));
    }
    let m = margins
        .unwrap_or(RedactMargins::uniform(DEFAULT_REDACT_MARGIN_PT))
        .clamped();
    let pages: Vec<(u32, ObjectId)> = doc.get_pages().into_iter().collect();
    let page_count = pages.len();
    if page_count == 0 {
        return Err(CoreError::Parse(format!("{input}: no pages")));
    }
    let mut stats = RedactStats {
        pages_total: page_count,
        pages_redacted: 0,
    };

    for (page_no, page_id) in pages {
        let idx = page_no.saturating_sub(1);
        let Some(media) = inherited(&doc, page_id, b"MediaBox").and_then(|o| parse_box(&doc, o))
        else {
            continue;
        };
        let crop = inherited(&doc, page_id, b"CropBox")
            .and_then(|o| parse_box(&doc, o))
            .unwrap_or(media);
        // CropBox は必ず MediaBox の内側に収める (不正な CropBox 対策)
        let (cx0, cy0, cx1, cy1) = (
            crop[0].max(media[0]),
            crop[1].max(media[1]),
            crop[2].min(media[2]),
            crop[3].min(media[3]),
        );
        if cx1 <= cx0 || cy1 <= cy0 {
            continue; // 不正な CropBox → スキップ
        }
        let eps = f64::from(CROPBOX_EPS);
        let is_uncropped = (cx0 - media[0]).abs() < eps
            && (cy0 - media[1]).abs() < eps
            && (cx1 - media[2]).abs() < eps
            && (cy1 - media[3]).abs() < eps;
        if is_uncropped {
            continue;
        }
        // CropBox を、上下左右の余裕の分だけ広げた範囲。ここに触れるものは残す
        let keep = Rect {
            x0: cx0 - f64::from(m.left),
            y0: cy0 - f64::from(m.bottom),
            x1: cx1 + f64::from(m.right),
            y1: cy1 + f64::from(m.top),
        };

        let Some(edit) = process_page(&doc, page_id, &keep) else {
            continue;
        };
        let mut stream = Stream::new(Dictionary::new(), edit.content);
        let _ = stream.compress();
        let new_id = doc.add_object(stream);
        if let Ok(Object::Dictionary(d)) = doc.get_object_mut(page_id) {
            d.set("Contents", Object::Reference(new_id));
            if let Some(r) = edit.resources {
                d.set("Resources", Object::Dictionary(r));
            }
        }
        stats.pages_redacted += 1;
        eprintln!(
            "[redact_crop] page {idx}: lopdf removed {} path(s), {} xobject(s), {} text run(s) outside CropBox \
             [{cx0:.1},{cy0:.1},{cx1:.1},{cy1:.1}]",
            edit.counts.paths, edit.counts.xobjects, edit.counts.texts
        );
    }

    if stats.pages_redacted == 0 {
        if input != output {
            std::fs::copy(input, output)?;
        }
        return Ok(stats);
    }

    clean_trailer(&mut doc);
    prune(&mut doc);
    doc.max_id = doc.objects.keys().map(|k| k.0).max().unwrap_or(0);
    save_checked(&mut doc, output, false, page_count)?;
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{Stream, dictionary};

    const CROP_LEFT: [i64; 4] = [0, 0, 300, 800];
    const CROP_RIGHT: [i64; 4] = [300, 0, 600, 800];

    /// 2 ページの PDF。1 ページ目だけ CropBox を持つ。2 ページ目は同じリソースを共有し、
    /// 外側の画像 (Width=7) をそのまま使う。
    fn build(path: &std::path::Path, crop: [i64; 4], page1: &str) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let img = |w: i64| {
            Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image", "Width" => w, "Height" => 2,
                    "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
                },
                vec![0u8; (w * 2) as usize],
            )
        };
        let im_out = doc.add_object(img(7));
        let im_in = doc.add_object(img(5));
        let form = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), 50.into(), 50.into()],
                "Resources" => dictionary! {},
            },
            b"0 0 50 50 re f".to_vec(),
        ));
        let desc = doc.add_object(dictionary! {
            "Type" => "FontDescriptor", "FontName" => "Helvetica", "Flags" => 32,
            "FontBBox" => vec![0.into(), 0.into(), 1000.into(), 1000.into()],
        });
        let font = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
            "FirstChar" => 32, "LastChar" => 126,
            "Widths" => vec![Object::Integer(600); 95],
            "FontDescriptor" => desc,
        });
        let res = doc.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font },
            "XObject" => dictionary! { "ImOut" => im_out, "ImIn" => im_in, "Fm1" => form },
        });
        let c1 = doc.add_object(Stream::new(dictionary! {}, page1.as_bytes().to_vec()));
        let c2 = doc.add_object(Stream::new(
            dictionary! {},
            b"q 100 0 0 100 450 300 cm /ImOut Do Q".to_vec(),
        ));
        let mb = || vec![0.into(), 0.into(), 600.into(), 800.into()];
        let p1 = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => mb(),
            "CropBox" => crop.iter().map(|v| Object::Integer(*v)).collect::<Vec<_>>(),
            "Resources" => res, "Contents" => c1,
        });
        let p2 = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => mb(),
            "Resources" => res, "Contents" => c2,
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![p1.into(), p2.into()], "Count" => 2,
            }),
        );
        let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", cat);
        doc.save(path).unwrap();
    }

    fn run(crop: [i64; 4], page1: &str) -> (RedactStats, Document, Vec<Operation>) {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.pdf");
        let dst = dir.path().join("out.pdf");
        build(&src, crop, page1);
        let stats = redact_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), None).unwrap();
        let doc = Document::load(&dst).unwrap();
        let first = *doc.get_pages().get(&1).unwrap();
        let ops = doc.get_and_decode_page_content(first).unwrap().operations;
        (stats, doc, ops)
    }

    fn count(ops: &[Operation], name: &str) -> usize {
        ops.iter().filter(|o| o.operator == name).count()
    }

    fn has_image_width(doc: &Document, w: i64) -> bool {
        doc.objects.values().any(|o| {
            o.as_stream()
                .ok()
                .and_then(|s| s.dict.get(b"Width").ok())
                .and_then(|v| v.as_i64().ok())
                == Some(w)
        })
    }

    #[test]
    fn removes_outside_paths_images_forms_and_keeps_the_rest() {
        let content = "\
q 1 0 0 rg 50 50 100 100 re f Q
q 0 0 1 rg 450 50 100 100 re f Q
q 0 1 0 rg 250 300 100 100 re f Q
q 100 0 0 100 50 300 cm /ImIn Do Q
q 100 0 0 100 450 300 cm /ImOut Do Q
q 1 0 0 1 500 500 cm /Fm1 Do Q";
        let (stats, doc, ops) = run(CROP_LEFT, content);
        assert_eq!(stats.pages_redacted, 1);
        // 内側と、境界をまたぐものは残る (外側の青い矩形だけ消える)
        assert_eq!(count(&ops, "re"), 2);
        assert_eq!(count(&ops, "Do"), 1);
        // 参照されなくなった外側の画像は、実体ごと消える。2 ページ目が使うので共有リソース側には残る
        assert!(
            has_image_width(&doc, 7),
            "page 2 still uses the outside image"
        );
        // 1 ページ目のリソースは複製され、使われている XObject だけになる
        let p1 = *doc.get_pages().get(&1).unwrap();
        let res = doc
            .get_dictionary(p1)
            .unwrap()
            .get(b"Resources")
            .unwrap()
            .as_dict()
            .unwrap();
        let xo = res.get(b"XObject").unwrap().as_dict().unwrap();
        assert!(xo.get(b"ImIn").is_ok());
        assert!(xo.get(b"ImOut").is_err());
        assert!(xo.get(b"Fm1").is_err());
        // 2 ページ目のリソースは共有のまま変わらない
        let p2 = *doc.get_pages().get(&2).unwrap();
        let res2 = doc.get_dictionary(p2).unwrap().get(b"Resources").unwrap();
        let res2 = doc.dereference(res2).unwrap().1.as_dict().unwrap();
        assert!(
            res2.get(b"XObject")
                .unwrap()
                .as_dict()
                .unwrap()
                .get(b"ImOut")
                .is_ok()
        );
    }

    #[test]
    fn unused_outside_image_is_dropped_when_no_other_page_uses_it() {
        // 2 ページ目も同じ画像を使うので、ここでは 1 ページ文書にして確かめる
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.pdf");
        let dst = dir.path().join("out.pdf");
        build(
            &src,
            CROP_LEFT,
            "q 100 0 0 100 450 300 cm /ImOut Do Q q 100 0 0 100 50 300 cm /ImIn Do Q",
        );
        let mut doc = Document::load(&src).unwrap();
        doc.delete_pages(&[2]);
        doc.save(&src).unwrap();
        redact_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), None).unwrap();
        let out = Document::load(&dst).unwrap();
        assert!(!has_image_width(&out, 7));
        assert!(has_image_width(&out, 5));
    }

    #[test]
    fn removed_text_keeps_the_advance_for_following_text() {
        // 600/1000 * 10pt * 4 文字 = 24pt。最初の Tj は CropBox の外 (x=100..124)。
        // 次の TJ は、その続きから 200pt 進んだ x=324 に X を出す (CropBox の中)。
        let content = "BT /F1 10 Tf 100 700 Td (AAAA) Tj [-20000 (X)] TJ ET";
        let (stats, _doc, ops) = run(CROP_RIGHT, content);
        assert_eq!(stats.pages_redacted, 1);
        assert_eq!(count(&ops, "Tj"), 0, "outside Tj is replaced");
        let tjs: Vec<&Operation> = ops.iter().filter(|o| o.operator == "TJ").collect();
        assert_eq!(tjs.len(), 2);
        let adv = tjs[0].operands[0].as_array().unwrap()[0]
            .as_float()
            .unwrap();
        assert!(
            (adv + 2400.0).abs() < 0.01,
            "advance as TJ adjustment: {adv}"
        );
        // 残した側は元のまま
        assert!(
            matches!(&tjs[1].operands[0].as_array().unwrap()[1], Object::String(s, _) if s == b"X")
        );
    }

    #[test]
    fn text_inside_or_straddling_is_kept() {
        let content =
            "BT /F1 10 Tf 50 700 Td (Hello) Tj ET BT /F1 10 Tf 290 600 Td (Straddle) Tj ET";
        let (stats, _doc, ops) = run(CROP_LEFT, content);
        assert_eq!(stats.pages_redacted, 0);
        assert_eq!(count(&ops, "Tj"), 2);
    }

    #[test]
    fn unknown_width_font_text_is_kept() {
        // /F2 は存在しない → 幅が分からないので、外側でも消さない
        let content = "BT /F2 10 Tf 450 700 Td (Outside) Tj ET";
        let (stats, _doc, ops) = run(CROP_LEFT, content);
        assert_eq!(stats.pages_redacted, 0);
        assert_eq!(count(&ops, "Tj"), 1);
    }

    #[test]
    fn clip_paths_are_never_removed() {
        let content = "q 450 50 100 100 re W n 0 0 1 rg 0 0 600 800 re f Q";
        let (stats, _doc, ops) = run(CROP_LEFT, content);
        assert_eq!(stats.pages_redacted, 0);
        assert_eq!(count(&ops, "W"), 1);
        assert_eq!(count(&ops, "re"), 2);
    }

    #[test]
    fn thick_stroke_near_the_edge_is_kept() {
        // 線の中心は CropBox + 余白 の外 (x=330) でも、太さ 40 の線は中へはみ出す
        let near = "q 40 w 330 100 m 330 500 l S Q";
        let (s1, _, o1) = run(CROP_LEFT, near);
        assert_eq!(s1.pages_redacted, 0);
        assert_eq!(count(&o1, "S"), 1);
        let far = "q 1 w 500 100 m 500 500 l S Q";
        let (s2, _, o2) = run(CROP_LEFT, far);
        assert_eq!(s2.pages_redacted, 1);
        assert_eq!(count(&o2, "S"), 0);
    }

    #[test]
    fn uncropped_page_is_untouched_and_copied() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.pdf");
        let dst = dir.path().join("out.pdf");
        build(&src, [0, 0, 600, 800], "q 450 50 100 100 re f Q");
        let stats = redact_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), None).unwrap();
        assert_eq!(stats.pages_redacted, 0);
        assert_eq!(std::fs::read(&src).unwrap(), std::fs::read(&dst).unwrap());
    }

    #[test]
    fn inline_images_make_the_page_untouched() {
        let content =
            "q 450 50 100 100 re f Q q 10 0 0 10 0 0 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \u{0} EI Q";
        let (stats, _doc, _ops) = run(CROP_LEFT, content);
        assert_eq!(stats.pages_redacted, 0);
    }

    #[test]
    fn cid_width_array_forms() {
        let doc = Document::new();
        let arr = vec![
            Object::Integer(1),
            Object::Array(vec![Object::Integer(500), Object::Integer(600)]),
            Object::Integer(10),
            Object::Integer(12),
            Object::Integer(700),
        ];
        let m = parse_cid_widths(&doc, &arr);
        assert_eq!(m.get(&1), Some(&500.0));
        assert_eq!(m.get(&2), Some(&600.0));
        assert_eq!(m.get(&11), Some(&700.0));
        assert_eq!(m.get(&13), None);
    }
}
