// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/content_filter.rs
// lopdf による内容ストリームの加工 (hayro 版「テキスト保持の画像化」の土台)。
//
// 2 つのモード (Mode):
//   RemoveText: テキスト描画命令を除去する (テキストの無い背景ラスタ用)
//     - ページ・Form XObject・タイリングパターン・SMask グループ・注釈の外観ストリームの
//       内容から、テキストを描く演算子 (Tj / TJ / ' / ") を取り除く。
//       ' と " は行送り (T*) の副作用だけ残す。BT/ET・Tf・Td 等の状態演算子はそのまま。
//     - Type3 フォントの文字も Tj で描かれるため、同じ処理で消える。
//   TextOnly: テキストだけを残す (背景ラスタの上に重ねるテキスト層用)
//     - パスの塗り・線 (S s f F f* B B* b b*) は `n` (描画せずパスを捨てる) に置き換える。
//       クリップ (W / W* + n) の効果は保たれる。
//     - シェーディング (sh)、画像 (Do で呼ぶ Image XObject)、インライン画像は取り除く。
//     - Form XObject の Do は残し、その内容も再帰的に同じ加工をする。
//     - タイリングパターン・SMask グループ・Type3 の文字定義は、テキストの塗りや透明度を
//       決めるので加工しない。
//
// 共通:
//   - 元のドキュメントは変更せず、加工済みの複製を返す (メモリ上)。
//   - 解析できない内容ストリームや、結果が変わってしまう構造があれば Err を返し、
//     呼び出し側 (ページ単位または全体) が MuPDF へフォールバックする:
//       * テキストをクリップに使う描画モード (Tr 4〜7)
//       * TextOnly: 種類を判別できない XObject、外観ストリームを持つ注釈
//
// Tr 4〜7 が Err になる理由: 文字の形で画像や色を抜く表現 (7 Tr (CLIP) Tj ET の後に塗る) は、
// 文字を除くとクリップが消え、塗りがページ全体に広がってしまう。(MuPDF の「テキスト無し」
// ラスタライズも同じ結果になる。)

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::collections::{HashMap, HashSet};

/// 加工モード
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// テキスト描画命令を除去する
    RemoveText,
    /// テキストだけを残す (図形の塗り・画像・シェーディングを除去)
    TextOnly,
}

/// 加工結果の統計
#[derive(Debug, Default, Clone, Copy)]
pub struct Stats {
    /// 加工した内容ストリームの数
    pub streams: usize,
    /// 取り除いたテキスト描画命令の数 (RemoveText)
    pub removed_ops: usize,
    /// 描画しない `n` に置き換えたパス描画命令の数 (TextOnly)
    pub neutralized_paints: usize,
    /// 取り除いた画像・シェーディング・インライン画像の数 (TextOnly)
    pub removed_images: usize,
}

/// XObject の種類 (Do で何を描くかの判別用)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum XKind {
    Image,
    Form,
    Other,
}
type Kinds = HashMap<Vec<u8>, XKind>;

/// `input` (PDF のバイト列) からテキスト描画命令を除いた PDF を作って返す。
pub fn remove_text_bytes(input: &[u8]) -> Result<(Vec<u8>, Stats), String> {
    transform_bytes(input, Mode::RemoveText)
}

/// `input` (PDF のバイト列) からテキスト以外の描画を除いた PDF を作って返す。
pub fn text_only_bytes(input: &[u8]) -> Result<(Vec<u8>, Stats), String> {
    transform_bytes(input, Mode::TextOnly)
}

pub fn transform_bytes(input: &[u8], mode: Mode) -> Result<(Vec<u8>, Stats), String> {
    let mut doc = Document::load_mem(input).map_err(|e| format!("lopdf load: {e}"))?;
    if doc.is_encrypted() {
        return Err("encrypted".into());
    }
    let stats = transform(&mut doc, mode)?;
    if mode == Mode::TextOnly {
        // 画像を外したので、どこからも参照されなくなったオブジェクトを捨て、ストリームを圧縮する
        doc.prune_objects();
        doc.compress();
    }
    let mut out = Vec::with_capacity(input.len());
    doc.save_to(&mut out).map_err(|e| format!("lopdf save: {e}"))?;
    Ok((out, stats))
}

/// 文書内のすべてのページ (とそこから辿れる部品) からテキスト描画命令を取り除く。
pub fn remove_text(doc: &mut Document) -> Result<Stats, String> {
    transform(doc, Mode::RemoveText)
}

/// 文書内のすべてのページ (とそこから辿れる部品) を、モードに従って加工する。
pub fn transform(doc: &mut Document, mode: Mode) -> Result<Stats, String> {
    let mut stats = Stats::default();
    let mut visited: HashSet<ObjectId> = HashSet::new();
    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    for page_id in pages {
        if mode == Mode::TextOnly && page_has_annotation_appearance(doc, page_id) {
            return Err("page has annotation appearance streams".into());
        }
        // ページのリソース (継承を含む。最も近い祖先のものが有効) から、
        // XObject の種類表と、辿れる部品を集める
        let res = effective_resources(doc, page_id).unwrap_or_default();
        let mut kinds = Kinds::new();
        let mut children = Vec::new();
        collect_kinds(doc, &res, &mut kinds);
        collect_children(doc, &res, mode, &mut children);
        // ページ自身の内容ストリーム
        for sid in doc.get_page_contents(page_id) {
            if visited.insert(sid) {
                filter_stream(doc, sid, mode, &kinds, &mut stats)?;
            }
        }
        // 注釈の外観ストリーム (RemoveText のみ。TextOnly は外観を持つ注釈を Err にしている)
        if mode == Mode::RemoveText {
            collect_annotation_streams(doc, page_id, &mut children);
        }
        for child in children {
            process_part(doc, child, mode, &kinds, &mut visited, &mut stats, 0)?;
        }
        // TextOnly: 画像 XObject をリソースから外す (Do を除いたので参照されない)
        if mode == Mode::TextOnly {
            let filtered = without_images(doc, &res, &kinds);
            if let Ok(Object::Dictionary(page)) = doc.get_object_mut(page_id) {
                page.set("Resources", Object::Dictionary(filtered));
            }
        }
    }
    Ok(stats)
}

/// ページの実効リソース辞書 (Parent をたどり、最も近い /Resources を複製して返す)
fn effective_resources(doc: &Document, page_id: ObjectId) -> Option<Dictionary> {
    let mut node = page_id;
    for _ in 0..MAX_DEPTH {
        let d = doc.get_dictionary(node).ok()?;
        if let Some(r) = resolve_dict(doc, d.get(b"Resources").ok()) {
            return Some(r.clone());
        }
        node = d.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

/// リソース辞書の複製から、画像 XObject のエントリを除く
fn without_images(doc: &Document, res: &Dictionary, kinds: &Kinds) -> Dictionary {
    let mut out = res.clone();
    if let Some(xo) = resolve_dict(doc, res.get(b"XObject").ok()) {
        let mut nx = Dictionary::new();
        for (name, v) in xo.iter() {
            if kinds.get(name) != Some(&XKind::Image) {
                nx.set(name.clone(), v.clone());
            }
        }
        out.set("XObject", Object::Dictionary(nx));
    }
    out
}

const MAX_DEPTH: usize = 32;

/// Form XObject / パターン等のストリーム 1 つ分を加工し、その中のリソースも再帰的に辿る。
/// `parent_kinds`: 親のリソースの XObject 表 (この部品が /Resources を持たないときに使う)。
fn process_part(
    doc: &mut Document,
    id: ObjectId,
    mode: Mode,
    parent_kinds: &Kinds,
    visited: &mut HashSet<ObjectId>,
    stats: &mut Stats,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_DEPTH || !visited.insert(id) {
        return Ok(());
    }
    // この部品自身の Resources があればそれを、無ければ親のものを使う
    let mut kinds = Kinds::new();
    let mut children = Vec::new();
    let mut has_own = false;
    if let Ok(Object::Stream(s)) = doc.get_object(id)
        && let Some(res) = resolve_dict(doc, s.dict.get(b"Resources").ok())
    {
        has_own = true;
        collect_kinds(doc, res, &mut kinds);
        collect_children(doc, res, mode, &mut children);
    }
    let kinds = if has_own { kinds } else { parent_kinds.clone() };
    filter_stream(doc, id, mode, &kinds, stats)?;
    for child in children {
        process_part(doc, child, mode, &kinds, visited, stats, depth + 1)?;
    }
    if mode == Mode::TextOnly && has_own {
        let own = match doc.get_object(id) {
            Ok(Object::Stream(s)) => resolve_dict(doc, s.dict.get(b"Resources").ok()).cloned(),
            _ => None,
        };
        if let Some(own) = own {
            let filtered = without_images(doc, &own, &kinds);
            if let Ok(Object::Stream(s)) = doc.get_object_mut(id) {
                s.dict.set("Resources", Object::Dictionary(filtered));
            }
        }
    }
    Ok(())
}

/// リソース辞書の XObject から、名前 → 種類の表を作る
fn collect_kinds(doc: &Document, res: &Dictionary, out: &mut Kinds) {
    let Some(xo) = resolve_dict(doc, res.get(b"XObject").ok()) else {
        return;
    };
    for (name, v) in xo.iter() {
        let kind = match v {
            Object::Reference(id) => match doc.get_object(*id) {
                Ok(Object::Stream(s)) => {
                    match s.dict.get(b"Subtype").ok().and_then(|o| o.as_name().ok()) {
                        Some(b"Image") => XKind::Image,
                        Some(b"Form") => XKind::Form,
                        _ => XKind::Other,
                    }
                }
                _ => XKind::Other,
            },
            _ => XKind::Other,
        };
        out.insert(name.clone(), kind);
    }
}

/// ページに外観ストリーム (/AP) を持つ注釈があるか (リンク注釈などは対象外)
fn page_has_annotation_appearance(doc: &Document, page_id: ObjectId) -> bool {
    let mut ids = Vec::new();
    collect_annotation_streams(doc, page_id, &mut ids);
    !ids.is_empty()
}

/// 辞書または辞書への参照を辞書として解決する
fn resolve_dict<'a>(doc: &'a Document, obj: Option<&'a Object>) -> Option<&'a Dictionary> {
    match obj? {
        Object::Dictionary(d) => Some(d),
        Object::Reference(id) => doc.get_dictionary(*id).ok(),
        _ => None,
    }
}

/// リソース辞書から、内容ストリームを持つ部品 (Form XObject / タイリングパターン /
/// SMask グループ) の ObjectId を集める。
fn collect_children(doc: &Document, res: &Dictionary, mode: Mode, out: &mut Vec<ObjectId>) {
    // XObject: Subtype が Form のもの (画像は対象外)
    if let Some(xo) = resolve_dict(doc, res.get(b"XObject").ok()) {
        for (_, v) in xo.iter() {
            if let Object::Reference(id) = v
                && let Ok(Object::Stream(s)) = doc.get_object(*id)
                && s.dict.get(b"Subtype").ok().and_then(|o| o.as_name().ok()) == Some(b"Form")
            {
                out.push(*id);
            }
        }
    }
    // TextOnly では、タイリングパターンと SMask グループは塗り・透明度そのものなので加工しない
    if mode == Mode::TextOnly {
        return;
    }
    // Pattern: タイリングパターン (ストリーム)
    if let Some(pat) = resolve_dict(doc, res.get(b"Pattern").ok()) {
        for (_, v) in pat.iter() {
            if let Object::Reference(id) = v
                && let Ok(Object::Stream(_)) = doc.get_object(*id)
            {
                out.push(*id);
            }
        }
    }
    // ExtGState の SMask グループ (/SMask << /G form >>)
    if let Some(gs) = resolve_dict(doc, res.get(b"ExtGState").ok()) {
        for (_, v) in gs.iter() {
            let d = match v {
                Object::Reference(id) => doc.get_dictionary(*id).ok(),
                Object::Dictionary(d) => Some(d),
                _ => None,
            };
            if let Some(sm) = d.and_then(|d| resolve_dict(doc, d.get(b"SMask").ok()))
                && let Ok(Object::Reference(g)) = sm.get(b"G")
            {
                out.push(*g);
            }
        }
    }
}

/// 注釈の外観ストリーム (/AP /N、状態ごとの辞書も含む) を集める
fn collect_annotation_streams(doc: &Document, page_id: ObjectId, out: &mut Vec<ObjectId>) {
    let Ok(page) = doc.get_dictionary(page_id) else {
        return;
    };
    let annots: Vec<ObjectId> = match page.get(b"Annots").ok() {
        Some(Object::Array(a)) => a.iter().filter_map(|o| o.as_reference().ok()).collect(),
        Some(Object::Reference(id)) => match doc.get_object(*id) {
            Ok(Object::Array(a)) => a.iter().filter_map(|o| o.as_reference().ok()).collect(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    for aid in annots {
        let Ok(annot) = doc.get_dictionary(aid) else {
            continue;
        };
        let Some(ap) = resolve_dict(doc, annot.get(b"AP").ok()) else {
            continue;
        };
        match ap.get(b"N").ok() {
            Some(Object::Reference(id)) => match doc.get_object(*id) {
                Ok(Object::Stream(_)) => out.push(*id),
                Ok(Object::Dictionary(d)) => {
                    out.extend(d.iter().filter_map(|(_, v)| v.as_reference().ok()))
                }
                _ => {}
            },
            Some(Object::Dictionary(d)) => {
                out.extend(d.iter().filter_map(|(_, v)| v.as_reference().ok()))
            }
            _ => {}
        }
    }
}

/// 1 つの内容ストリームを加工して書き戻す
fn filter_stream(
    doc: &mut Document,
    id: ObjectId,
    mode: Mode,
    kinds: &Kinds,
    stats: &mut Stats,
) -> Result<(), String> {
    let Ok(Object::Stream(stream)) = doc.get_object_mut(id) else {
        return Ok(()); // ストリームでなければ対象外
    };
    let bytes = match stream.decompressed_content() {
        Ok(b) => b,
        // Filter が無い (無圧縮) ストリームは content そのまま
        Err(_) if stream.dict.get(b"Filter").is_err() => stream.content.clone(),
        Err(e) => return Err(format!("stream {id:?} decompress: {e}")),
    };
    let (new_bytes, c) =
        transform_content(&bytes, mode, kinds).map_err(|e| format!("stream {id:?}: {e}"))?;
    if c.changed() {
        stream.set_plain_content(new_bytes);
        stats.streams += 1;
        stats.removed_ops += c.text_ops;
        stats.neutralized_paints += c.paints;
        stats.removed_images += c.images;
    }
    Ok(())
}

/// 1 つの内容ストリームでの加工の内訳
#[derive(Debug, Default, Clone, Copy)]
struct Counts {
    text_ops: usize,
    paints: usize,
    images: usize,
}

impl Counts {
    fn changed(&self) -> bool {
        self.text_ops + self.paints + self.images > 0
    }
}

/// 内容ストリームのバイト列から、テキストを描く演算子を取り除く (RemoveText)。
/// 戻り値: (加工後のバイト列, 取り除いた命令の数)。テキストが無ければ元のバイト列のまま。
pub fn strip_text_ops(bytes: &[u8]) -> Result<(Vec<u8>, usize), String> {
    let (out, c) = transform_content(bytes, Mode::RemoveText, &Kinds::new())?;
    Ok((out, c.text_ops))
}

/// 内容ストリームを加工する。
/// lopdf の解析器はインライン画像 (BI ... ID ... EI) を扱えないため、画像部分を先に切り出し、
/// それ以外の部分だけを解析して、画像部分は (RemoveText ではそのまま、TextOnly では除いて)
/// 連結し直す。
fn transform_content(
    bytes: &[u8],
    mode: Mode,
    kinds: &Kinds,
) -> Result<(Vec<u8>, Counts), String> {
    // 高速パス (RemoveText のみ): テキスト描画の演算子が 1 つも無ければ解析しない
    if mode == Mode::RemoveText
        && !bytes.windows(2).any(|w| w == b"Tj" || w == b"TJ")
        && !contains_quote_op(bytes)
        && !contains_tr_op(bytes)
    {
        return Ok((bytes.to_vec(), Counts::default()));
    }
    let images = find_inline_images(bytes)?;
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut total = Counts::default();
    let mut pos = 0usize;
    for (start, end) in images
        .iter()
        .copied()
        .chain(std::iter::once((bytes.len(), bytes.len())))
    {
        if start > pos {
            let (chunk, c) = transform_chunk(&bytes[pos..start], mode, kinds)?;
            total.text_ops += c.text_ops;
            total.paints += c.paints;
            total.images += c.images;
            out.extend_from_slice(&chunk);
            out.push(b'\n');
        }
        if end > start {
            match mode {
                Mode::RemoveText => {
                    out.extend_from_slice(&bytes[start..end]); // インライン画像はそのまま
                    out.push(b'\n');
                }
                Mode::TextOnly => total.images += 1, // 背景ラスタに含まれるので除く
            }
        }
        pos = end;
    }
    if !total.changed() {
        return Ok((bytes.to_vec(), Counts::default()));
    }
    Ok((out, total))
}

/// 演算子 Tr の operand が 4〜7 (テキストをクリップに使う描画モード) か
fn is_clip_render_mode(op: &Operation) -> bool {
    if op.operator != "Tr" {
        return false;
    }
    let v = match op.operands.first() {
        Some(Object::Integer(i)) => *i as f64,
        Some(Object::Real(r)) => *r as f64,
        _ => return false,
    };
    (4.0..=7.0).contains(&v)
}

/// インライン画像を含まない部分を加工する
fn transform_chunk(chunk: &[u8], mode: Mode, kinds: &Kinds) -> Result<(Vec<u8>, Counts), String> {
    let content = Content::decode(chunk).map_err(|e| format!("content decode: {e}"))?;
    let mut c = Counts::default();
    let mut ops: Vec<Operation> = Vec::with_capacity(content.operations.len());
    for op in content.operations {
        // どちらのモードでも、文字の形によるクリップは再現できないので Err
        if is_clip_render_mode(&op) {
            return Err("text clipping render mode (Tr 4-7)".into());
        }
        match mode {
            Mode::RemoveText => match op.operator.as_str() {
                "Tj" | "TJ" => c.text_ops += 1,
                // ' : T* して文字列を描く。行送りだけ残す
                "'" => {
                    c.text_ops += 1;
                    ops.push(Operation::new("T*", vec![]));
                }
                // " : aw ac string → Tw / Tc を設定し、T* して描く
                "\"" => {
                    c.text_ops += 1;
                    if op.operands.len() == 3 {
                        ops.push(Operation::new("Tw", vec![op.operands[0].clone()]));
                        ops.push(Operation::new("Tc", vec![op.operands[1].clone()]));
                    }
                    ops.push(Operation::new("T*", vec![]));
                }
                _ => ops.push(op),
            },
            Mode::TextOnly => match op.operator.as_str() {
                // パスの塗り・線: 描かずにパスを捨てる (W による clip はそのまま効く)
                "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" => {
                    c.paints += 1;
                    ops.push(Operation::new("n", vec![]));
                }
                // シェーディング: 除去 (背景ラスタに含まれる)
                "sh" => c.images += 1,
                // XObject: 画像は除去、Form は残す (中身も別途加工する)。判別できなければ Err
                "Do" => {
                    let name = op.operands.first().and_then(|o| o.as_name().ok());
                    match name.and_then(|n| kinds.get(n)) {
                        Some(XKind::Image) => c.images += 1,
                        Some(XKind::Form) => ops.push(op),
                        _ => return Err("Do of an unknown XObject".into()),
                    }
                }
                _ => ops.push(op),
            },
        }
    }
    let out = Content { operations: ops }
        .encode()
        .map_err(|e| format!("content encode: {e}"))?;
    Ok((out, c))
}

/// Tr 演算子らしきものが含まれていそうか (高速パスを抜けるための粗い判定)
fn contains_tr_op(bytes: &[u8]) -> bool {
    bytes.windows(2).any(|w| w == b"Tr")
}

/// ' / " 演算子 (前後が空白・区切りのもの) が含まれていそうか
fn contains_quote_op(bytes: &[u8]) -> bool {
    bytes.iter().any(|&b| b == b'\'' || b == b'"')
}

fn is_ws(c: u8) -> bool {
    matches!(c, 0 | 9 | 10 | 12 | 13 | 32)
}

fn is_delim(c: u8) -> bool {
    matches!(c, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

/// 内容ストリーム中のインライン画像 (BI ... EI) の範囲 [開始, 終了) を列挙する。
/// 文字列・16 進文字列・コメント・名前の中の "BI" は無視する。
/// BI に対応する ID / EI が見つからないときは Err (呼び出し側はフォールバックする)。
fn find_inline_images(b: &[u8]) -> Result<Vec<(usize, usize)>, String> {
    let n = b.len();
    let mut spans = Vec::new();
    let mut i = 0usize;
    while i < n {
        let c = b[i];
        if is_ws(c) {
            i += 1;
        } else if c == b'%' {
            while i < n && b[i] != b'\n' && b[i] != b'\r' {
                i += 1;
            }
        } else if c == b'(' {
            let mut depth = 1;
            i += 1;
            while i < n && depth > 0 {
                match b[i] {
                    b'\\' => i += 2,
                    b'(' => {
                        depth += 1;
                        i += 1;
                    }
                    b')' => {
                        depth -= 1;
                        i += 1;
                    }
                    _ => i += 1,
                }
            }
        } else if c == b'<' {
            if i + 1 < n && b[i + 1] == b'<' {
                i += 2;
            } else {
                while i < n && b[i] != b'>' {
                    i += 1;
                }
                i += 1;
            }
        } else if c == b'/' {
            i += 1;
            while i < n && !is_ws(b[i]) && !is_delim(b[i]) {
                i += 1;
            }
        } else if is_delim(c) {
            i += 1;
        } else {
            let start = i;
            while i < n && !is_ws(b[i]) && !is_delim(b[i]) {
                i += 1;
            }
            if &b[start..i] == b"BI" {
                // 辞書部の後ろの "ID" (前後が空白) を探す
                let mut p = i;
                let id = loop {
                    if p + 2 > n {
                        return Err("inline image without ID".into());
                    }
                    if b[p] == b'I'
                        && b[p + 1] == b'D'
                        && p > 0
                        && is_ws(b[p - 1])
                        && (p + 2 >= n || is_ws(b[p + 2]))
                    {
                        break p;
                    }
                    p += 1;
                };
                let data_start = (id + 3).min(n); // ID の直後の空白 1 文字は区切り
                let mut k = data_start;
                let end = loop {
                    if k + 2 > n {
                        return Err("inline image without EI".into());
                    }
                    if b[k] == b'E'
                        && b[k + 1] == b'I'
                        && (k == data_start || is_ws(b[k - 1]))
                        && (k + 2 >= n || is_ws(b[k + 2]))
                    {
                        break k + 2;
                    }
                    k += 1;
                };
                spans.push((start, end));
                i = end;
            }
        }
    }
    Ok(spans)
}


#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    #[test]
    fn strips_show_operators_keeps_state() {
        let src = b"q 1 0 0 rg 10 10 50 50 re f Q BT /F1 12 Tf 20 700 Td (Hello) Tj [(A) 20 (B)] TJ 14 TL (x) ' 1 2 (y) \" ET";
        let (out, n) = strip_text_ops(src).unwrap();
        assert_eq!(n, 4);
        let ops = Content::decode(&out).unwrap().operations;
        let names: Vec<&str> = ops.iter().map(|o| o.operator.as_str()).collect();
        assert!(!names.contains(&"Tj") && !names.contains(&"TJ") && !names.contains(&"'") && !names.contains(&"\""));
        // 状態演算子と図形はそのまま
        for keep in ["q", "Q", "rg", "re", "f", "BT", "Tf", "Td", "TL", "ET"] {
            assert!(names.contains(&keep), "{keep} missing: {names:?}");
        }
        // ' と " は行送りが残る (2 回) + " の Tw/Tc
        assert_eq!(names.iter().filter(|n| **n == "T*").count(), 2);
        assert!(names.contains(&"Tw") && names.contains(&"Tc"));
    }

    #[test]
    fn untouched_without_text() {
        let src = b"q 0 0 1 rg 0 0 10 10 re f Q";
        let (out, n) = strip_text_ops(src).unwrap();
        assert_eq!(n, 0);
        assert_eq!(out, src);
    }

    #[test]
    fn inline_image_survives() {
        let src = b"q 10 0 0 10 0 0 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\x80\xff\x40 EI Q BT (t) Tj ET";
        let (out, n) = strip_text_ops(src).unwrap();
        assert_eq!(n, 1);
        // 画像のバイト列 (BI ... EI) がそのまま残っている
        let img = &src[src.windows(2).position(|w| w == b"BI").unwrap()..];
        let img = &img[..img.windows(2).position(|w| w == b"EI").unwrap() + 2];
        assert!(out.windows(img.len()).any(|w| w == img));
        assert!(!out.windows(2).any(|w| w == b"Tj"));
    }

    /// ページ + Form XObject (テキスト入り) を持つ最小 PDF を作り、両方から除去できること
    #[test]
    fn removes_text_in_form_xobjects() {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let form = lopdf::Stream::new(
            dictionary! {"Type"=>"XObject","Subtype"=>"Form","BBox"=>vec![0.into(),0.into(),100.into(),100.into()]},
            b"BT /F1 10 Tf (in form) Tj ET 0 0 20 20 re f".to_vec(),
        );
        let form_id = doc.add_object(form);
        let content_id = doc.add_object(lopdf::Stream::new(
            dictionary! {},
            b"BT /F1 12 Tf (on page) Tj ET /Fm1 Do".to_vec(),
        ));
        let page_id = doc.add_object(dictionary! {
            "Type"=>"Page","Parent"=>pages_id,
            "MediaBox"=>vec![0.into(),0.into(),200.into(),200.into()],
            "Resources"=>dictionary!{"XObject"=>dictionary!{"Fm1"=>form_id}},
            "Contents"=>content_id,
        });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! {
            "Type"=>"Pages","Kids"=>vec![page_id.into()],"Count"=>1,
        }));
        let cat = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages_id});
        doc.trailer.set("Root", cat);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();

        let (out, stats) = remove_text_bytes(&buf).unwrap();
        assert_eq!(stats.removed_ops, 2);
        let d2 = Document::load_mem(&out).unwrap();
        for (_, o) in d2.objects.iter() {
            if let Object::Stream(s) = o {
                let c = s.decompressed_content().unwrap_or_else(|_| s.content.clone());
                let t = String::from_utf8_lossy(&c);
                assert!(!t.contains("Tj"), "Tj remains: {t}");
            }
        }
    }
    #[test]
    fn clip_render_mode_is_an_error() {
        for tr in ["4", "5", "6", "7"] {
            let src = format!("BT /F1 12 Tf {tr} Tr (x) Tj ET");
            assert!(strip_text_ops(src.as_bytes()).is_err(), "Tr {tr} should fail");
        }
        // 通常の描画モード (0〜3) は問題ない
        for tr in ["0", "1", "2", "3"] {
            let src = format!("BT /F1 12 Tf {tr} Tr (x) Tj ET");
            assert!(strip_text_ops(src.as_bytes()).is_ok());
        }
    }

    fn kinds_for_test() -> Kinds {
        let mut k = Kinds::new();
        k.insert(b"Im1".to_vec(), XKind::Image);
        k.insert(b"Fm1".to_vec(), XKind::Form);
        k.insert(b"Weird".to_vec(), XKind::Other);
        k
    }

    #[test]
    fn text_only_neutralizes_paint_keeps_text_and_clip() {
        let src = b"q 0 0 1 rg 0 0 50 50 re f 10 10 30 30 re W n 1 0 0 RG 5 w 0 0 m 9 9 l S /Im1 Do /Fm1 Do 0 0 m 5 5 l 9 0 l b* /Sh1 sh BT /F1 12 Tf (keep) Tj ET Q";
        let (out, c) = transform_content(src, Mode::TextOnly, &kinds_for_test()).unwrap();
        assert_eq!(c.paints, 3); // f / S / b*
        assert_eq!(c.images, 2); // Im1 / sh
        let ops = Content::decode(&out).unwrap().operations;
        let names: Vec<&str> = ops.iter().map(|o| o.operator.as_str()).collect();
        for gone in ["f", "S", "b*", "sh"] {
            assert!(!names.contains(&gone), "{gone} remains: {names:?}");
        }
        // クリップ (re W n)・状態・テキスト・Form の Do は残る
        for keep in ["q", "Q", "W", "n", "rg", "RG", "w", "BT", "ET", "Tf", "Tj", "Do"] {
            assert!(names.contains(&keep), "{keep} missing: {names:?}");
        }
        assert_eq!(names.iter().filter(|n| **n == "Do").count(), 1); // Fm1 だけ
        assert_eq!(names.iter().filter(|n| **n == "n").count(), 4); // 元の n + 置換 3
    }

    #[test]
    fn text_only_unknown_xobject_is_an_error() {
        let src = b"/Weird Do BT (t) Tj ET";
        assert!(transform_content(src, Mode::TextOnly, &kinds_for_test()).is_err());
        let src = b"/Nope Do";
        assert!(transform_content(src, Mode::TextOnly, &kinds_for_test()).is_err());
    }

    #[test]
    fn text_only_drops_inline_images() {
        let src = b"q 10 0 0 10 0 0 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\x80\xff\x40 EI Q BT (t) Tj ET";
        let (out, c) = transform_content(src, Mode::TextOnly, &kinds_for_test()).unwrap();
        assert_eq!(c.images, 1);
        assert!(!out.windows(2).any(|w| w == b"BI"));
        assert!(out.windows(2).any(|w| w == b"Tj"));
    }

    /// TextOnly: Form XObject 内も加工され、タイリングパターンは加工されない
    #[test]
    fn text_only_form_recursion_and_untouched_patterns() {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let img = doc.add_object(lopdf::Stream::new(
            dictionary! {"Type"=>"XObject","Subtype"=>"Image","Width"=>1,"Height"=>1,"ColorSpace"=>"DeviceGray","BitsPerComponent"=>8},
            vec![0u8],
        ));
        let pattern = doc.add_object(lopdf::Stream::new(
            dictionary! {"Type"=>"Pattern","PatternType"=>1,"PaintType"=>1,"TilingType"=>1,
                "BBox"=>vec![0.into(),0.into(),5.into(),5.into()],"XStep"=>5,"YStep"=>5,
                "Resources"=>dictionary!{}},
            b"1 0 0 rg 0 0 5 5 re f".to_vec(),
        ));
        let form = doc.add_object(lopdf::Stream::new(
            dictionary! {"Type"=>"XObject","Subtype"=>"Form","BBox"=>vec![0.into(),0.into(),100.into(),100.into()],
                "Resources"=>dictionary!{"XObject"=>dictionary!{"Im1"=>img}}},
            b"0 0 20 20 re f /Im1 Do BT /F1 10 Tf (in form) Tj ET".to_vec(),
        ));
        let content_id = doc.add_object(lopdf::Stream::new(
            dictionary! {},
            b"0 0 100 100 re f /Fm1 Do /Pattern cs /P1 scn BT /F1 12 Tf (on page) Tj ET".to_vec(),
        ));
        let page_id = doc.add_object(dictionary! {
            "Type"=>"Page","Parent"=>pages_id,
            "MediaBox"=>vec![0.into(),0.into(),200.into(),200.into()],
            "Resources"=>dictionary!{"XObject"=>dictionary!{"Fm1"=>form},"Pattern"=>dictionary!{"P1"=>pattern}},
            "Contents"=>content_id,
        });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! {
            "Type"=>"Pages","Kids"=>vec![page_id.into()],"Count"=>1,
        }));
        let cat = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages_id});
        doc.trailer.set("Root", cat);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();

        let (out, stats) = text_only_bytes(&buf).unwrap();
        assert_eq!(stats.neutralized_paints, 2); // ページの f + Form の f
        assert_eq!(stats.removed_images, 1); // Form 内の Im1
        let d2 = Document::load_mem(&out).unwrap();
        let mut saw_pattern = false;
        for (_, o) in d2.objects.iter() {
            if let Object::Stream(st) = o {
                let c = st.decompressed_content().unwrap_or_else(|_| st.content.clone());
                let t = String::from_utf8_lossy(&c).to_string();
                if t.contains("1 0 0 rg") {
                    saw_pattern = t.contains(" f"); // パターンの塗りは残る
                } else if t.contains("Tj") {
                    assert!(t.contains(" n") || t.contains("\nn"), "paint not neutralized: {t}");
                    assert!(!t.contains(" f\n") && !t.ends_with(" f"), "fill remains: {t}");
                }
            }
        }
        assert!(saw_pattern, "tiling pattern must stay untouched");
    }
}
