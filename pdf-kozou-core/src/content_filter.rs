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
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use std::collections::{HashMap, HashSet};

/// `Content::encode()` の出力を、行単位で内容ストリームを読む処理 (MuPDF 側の隠しテキスト
/// 無害化など) が壊さない形にして返す。
///
/// lopdf の `Content::encode()` はリテラル文字列の中の改行 (0x0A) をエスケープせず、そのまま
/// 書き出す。例えば文字コード `0A 24` の文字列が `(<LF>$)` になる (元の PDF では `(\n$)`)。
/// PDF としては正しいが、行ごとに読む処理は文字列の途中で行を割ってしまい、閉じ括弧のない `(`
/// を作る。以降のトークン解析は、その `(` からストリームの終わりまでを 1 つの文字列として
/// 飲み込み、除去処理とフォント収集が途中で止まる。
///
/// そこで、制御文字 (LF / CR) を含むリテラル文字列は 16 進文字列 (`<0A24>`) に置き換えてから
/// エンコードする。16 進文字列は意味が同じで、改行を含まない。
pub(crate) fn encode_content_eol_safe(content: &Content) -> Result<Vec<u8>, lopdf::Error> {
    fn fix(obj: &mut Object) {
        match obj {
            Object::String(bytes, fmt) => {
                if matches!(fmt, lopdf::StringFormat::Literal)
                    && bytes.iter().any(|&b| b == b'\n' || b == b'\r')
                {
                    *fmt = lopdf::StringFormat::Hexadecimal;
                }
            }
            Object::Array(items) => items.iter_mut().for_each(fix),
            Object::Dictionary(d) => d.iter_mut().for_each(|(_, v)| fix(v)),
            _ => {}
        }
    }
    if !content
        .operations
        .iter()
        .any(|op| op.operands.iter().any(needs_eol_fix))
    {
        return content.encode();
    }
    let mut c = content.clone();
    for op in &mut c.operations {
        op.operands.iter_mut().for_each(fix);
    }
    c.encode()
}

fn needs_eol_fix(obj: &Object) -> bool {
    match obj {
        Object::String(bytes, lopdf::StringFormat::Literal) => {
            bytes.iter().any(|&b| b == b'\n' || b == b'\r')
        }
        Object::Array(items) => items.iter().any(needs_eol_fix),
        Object::Dictionary(d) => d.iter().any(|(_, v)| needs_eol_fix(v)),
        _ => false,
    }
}

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
    /// 覆いとして扱う Form XObject (`find_cover_forms` が選んだもの)。
    /// TextOnly では (中身も含めて) そのまま残し、RemoveText では `Do` を取り除く。
    Cover,
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

/// 内容ストリームの識別子。覆いの命令を、ストリーム内の塗り命令の通し番号で指すために使う。
/// ページの内容ストリームは複数本に分かれていることがあるので、ページ単位で指す
/// (加工前に 1 本にまとめるのと同じ順序で数える)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StreamKey {
    Page(ObjectId),
    Form(ObjectId),
}

/// 覆い 1 つの指定
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CoverKey {
    /// 画像 XObject / Form XObject (描かれる場所すべて)
    Obj(ObjectId),
    /// ストリーム内の `ord` 番目 (0 始まり) の、パスの塗り・線の命令 (`S s f F f* B B* b b*`)
    Op(StreamKey, usize),
}

/// 覆いの集合
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Covers {
    pub objs: HashSet<ObjectId>,
    pub ops: HashSet<(StreamKey, usize)>,
}

impl Covers {
    pub fn is_empty(&self) -> bool {
        self.objs.is_empty() && self.ops.is_empty()
    }

    pub fn len(&self) -> usize {
        self.objs.len() + self.ops.len()
    }

    pub fn insert(&mut self, k: CoverKey) {
        match k {
            CoverKey::Obj(id) => {
                self.objs.insert(id);
            }
            CoverKey::Op(s, i) => {
                self.ops.insert((s, i));
            }
        }
    }

    pub fn contains(&self, k: &CoverKey) -> bool {
        match k {
            CoverKey::Obj(id) => self.objs.contains(id),
            CoverKey::Op(s, i) => self.ops.contains(&(*s, *i)),
        }
    }

    pub fn from_keys<I: IntoIterator<Item = CoverKey>>(it: I) -> Covers {
        let mut c = Covers::default();
        for k in it {
            c.insert(k);
        }
        c
    }
}

/// 1 本のストリームを加工するときの、塗り命令の通し番号の数え方と、残す命令の指定
struct OpCtx<'a> {
    /// (残す命令の集合, このストリームの識別子)。None なら何も残さない
    keep: Option<(&'a HashSet<(StreamKey, usize)>, StreamKey)>,
    /// 次の塗り命令の通し番号
    ord: usize,
}

impl<'a> OpCtx<'a> {
    fn none() -> OpCtx<'a> {
        OpCtx { keep: None, ord: 0 }
    }

    fn for_stream(covers: &'a Covers, key: StreamKey) -> OpCtx<'a> {
        OpCtx {
            keep: Some((&covers.ops, key)),
            ord: 0,
        }
    }

    /// このストリームに、残す命令があるか
    fn active(&self) -> bool {
        self.keep
            .is_some_and(|(set, key)| set.iter().any(|(k, _)| *k == key))
    }

    /// 塗り命令を 1 つ数え、それが残す命令かを返す
    fn next_paint_kept(&mut self) -> bool {
        let i = self.ord;
        self.ord += 1;
        self.keep
            .is_some_and(|(set, key)| set.contains(&(key, i)))
    }
}

pub fn transform_bytes(input: &[u8], mode: Mode) -> Result<(Vec<u8>, Stats), String> {
    transform_bytes_covers(input, mode, &Covers::default())
}

/// `remove_text_bytes` に、覆い (`find_cover_forms` が選んだ Form XObject) の `Do` を取り除く
/// 指定を加えたもの。覆いを除いた「文字の下層」の背景を描くために使う。
pub fn remove_text_bytes_covers(
    input: &[u8],
    covers: &Covers,
) -> Result<(Vec<u8>, Stats), String> {
    transform_bytes_covers(input, Mode::RemoveText, covers)
}

fn transform_bytes_covers(
    input: &[u8],
    mode: Mode,
    covers: &Covers,
) -> Result<(Vec<u8>, Stats), String> {
    let mut doc = Document::load_mem(input).map_err(|e| format!("lopdf load: {e}"))?;
    if doc.is_encrypted() {
        return Err("encrypted".into());
    }
    let stats = transform_covers(&mut doc, mode, covers)?;
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
    transform_covers(doc, mode, &Covers::default())
}

/// `transform` に、覆い (`find_cover_forms` が選んだ Form XObject) の扱いを加えたもの。
/// - TextOnly: 覆いは加工せず、`Do` も残す (文字との描画順を保ったまま、ベクターで重ねる)。
/// - RemoveText: 覆いの `Do` を取り除く (背景ラスタは、覆いを除いた文字の下層になる)。
pub fn transform_covers(
    doc: &mut Document,
    mode: Mode,
    covers: &Covers,
) -> Result<Stats, String> {
    // /Contents が配列のページは、先に 1 本にまとめる。operand と演算子が別のストリームに
    // 分かれていることがあり (仕様上は合法)、ストリームごとに解析すると壊れるため。
    merge_page_contents(doc)?;
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
        collect_kinds(doc, &res, &mut kinds, covers);
        collect_children(doc, &res, mode, &mut children);
        // ページ自身の内容ストリーム
        for sid in doc.get_page_contents(page_id) {
            if visited.insert(sid) {
                filter_stream(doc, sid, mode, &kinds, covers, StreamKey::Page(page_id), &mut stats)?;
            }
        }
        // 注釈の外観ストリーム (RemoveText のみ。TextOnly は外観を持つ注釈を Err にしている)
        if mode == Mode::RemoveText {
            collect_annotation_streams(doc, page_id, &mut children);
        }
        for child in children {
            process_part(doc, child, mode, &kinds, covers, &mut visited, &mut stats, 0)?;
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
#[allow(clippy::too_many_arguments)]
fn process_part(
    doc: &mut Document,
    id: ObjectId,
    mode: Mode,
    parent_kinds: &Kinds,
    covers: &Covers,
    visited: &mut HashSet<ObjectId>,
    stats: &mut Stats,
    depth: usize,
) -> Result<(), String> {
    // 覆いは加工しない (ベクターのまま残す / `Do` ごと取り除くので中身は使われない)
    if covers.objs.contains(&id) {
        return Ok(());
    }
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
        collect_kinds(doc, res, &mut kinds, covers);
        collect_children(doc, res, mode, &mut children);
    }
    let kinds = if has_own { kinds } else { parent_kinds.clone() };
    filter_stream(doc, id, mode, &kinds, covers, StreamKey::Form(id), stats)?;
    for child in children {
        process_part(doc, child, mode, &kinds, covers, visited, stats, depth + 1)?;
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
fn collect_kinds(doc: &Document, res: &Dictionary, out: &mut Kinds, covers: &Covers) {
    let Some(xo) = resolve_dict(doc, res.get(b"XObject").ok()) else {
        return;
    };
    for (name, v) in xo.iter() {
        let kind = match v {
            Object::Reference(id) => match doc.get_object(*id) {
                Ok(Object::Stream(s)) => {
                    match s.dict.get(b"Subtype").ok().and_then(|o| o.as_name().ok()) {
                        Some(b"Image") if covers.objs.contains(id) => XKind::Cover,
                        Some(b"Image") => XKind::Image,
                        Some(b"Form") if covers.objs.contains(id) => XKind::Cover,
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
    covers: &Covers,
    key: StreamKey,
    stats: &mut Stats,
) -> Result<(), String> {
    let Ok(Object::Stream(stream)) = doc.get_object_mut(id) else {
        return Ok(()); // ストリームでなければ対象外
    };
    // Filter が無い (無圧縮) ストリームは content そのまま。Flate が壊れている・途中で切れていて
    // 内容が欠けるものは Err (欠けたまま書き戻すと、残りの描画が失われる)
    let bytes = crate::image_recompress::content_stream_bytes(stream)
        .map_err(|e| format!("stream {id:?} decompress: {e}"))?;
    let mut ctx = OpCtx::for_stream(covers, key);
    let (new_bytes, c) = transform_content_ops(&bytes, mode, kinds, &mut ctx)
        .map_err(|e| format!("stream {id:?}: {e}"))?;
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
    transform_content_ops(bytes, mode, kinds, &mut OpCtx::none())
}

fn transform_content_ops(
    bytes: &[u8],
    mode: Mode,
    kinds: &Kinds,
    ctx: &mut OpCtx,
) -> Result<(Vec<u8>, Counts), String> {
    // 高速パス (RemoveText のみ): テキスト描画の演算子が 1 つも無ければ解析しない
    if mode == Mode::RemoveText
        && !ctx.active()
        && !kinds.values().any(|k| *k == XKind::Cover)
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
            let (chunk, c) = transform_chunk(&bytes[pos..start], mode, kinds, ctx)?;
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

/// 内容ストリームを最後まで解析する (`Content::decode_strict`)。ただし、末尾の空白・NUL・
/// 改ページは無視する。
///
/// `Content::decode` は、解析できないトークンに当たるとそこから先を黙って捨てる (内容が欠ける)。
/// 一方 `decode_strict` は、全体を解析しきれなければ Err にするが、lopdf のパーサは空白を
/// " \t\r\n" としか認めないので、末尾に NUL や改ページが付いただけの実害のないストリームも
/// 弾いてしまう。そうしたストリームは decode でも欠けずに読めるので、末尾だけは許容する。
/// 途中の NUL や不正なトークンは許容しない (decode はそこで打ち切ってしまう)。
pub(crate) fn decode_content(bytes: &[u8]) -> Result<Content, lopdf::Error> {
    let end = bytes
        .iter()
        .rposition(|b| !matches!(b, b' ' | b'\t' | b'\r' | b'\n' | 0 | 0x0c))
        .map_or(0, |i| i + 1);
    Content::decode_strict(&bytes[..end])
}

/// 各ページの /Contents を 1 本のストリームにまとめる (中身は書き換えず、連結するだけ)。
/// 仕様上、/Contents の配列は字句の境目でしか分割されないが、operand と演算子が別の
/// ストリームに分かれることはある。連結してからでないと正しく解析できない。
///
/// - 他のページと共有されているストリームは書き換えず、新しいストリームに書く。
///   (共有していないときは、先頭のストリームに書く。残りは未参照になる。)
/// - 同じ並びの /Contents を持つページは、同じ 1 本のストリームを指す。
/// - ストリームを 1 本しか持たないページは何も変えない。
///
/// 戻り値: 各ページの内容ストリーム (重複なし、ページ順)。
/// フィルタをデコードできないストリームがあれば Err。
pub(crate) fn merge_page_contents(doc: &mut Document) -> Result<Vec<ObjectId>, String> {
    merge_page_contents_with(doc, false, &mut Vec::new())
}

/// `merge_page_contents` の本体。`lenient` のとき、連結できない (内容が欠ける・デコードできない
/// ストリームを含む) ページは /Contents をそのままにして、理由を `skipped` へ積み、
/// 他のページの処理を続ける。strict (`lenient` が false) のときは、最初の失敗で Err。
pub(crate) fn merge_page_contents_with(
    doc: &mut Document,
    lenient: bool,
    skipped: &mut Vec<String>,
) -> Result<Vec<ObjectId>, String> {
    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    // 各ページの /Contents を、実在するストリームの並びに直す
    let page_streams: Vec<(ObjectId, Vec<ObjectId>)> = pages
        .iter()
        .map(|&page_id| {
            let sig: Vec<ObjectId> = doc
                .get_page_contents(page_id)
                .into_iter()
                .filter(|id| matches!(doc.objects.get(id), Some(Object::Stream(_))))
                .collect();
            (page_id, sig)
        })
        .collect();

    // ストリームが、(重複を除いた) いくつの並びに使われているか
    let mut usage: HashMap<ObjectId, usize> = HashMap::new();
    let mut seen_sigs: HashSet<&Vec<ObjectId>> = HashSet::new();
    for (_, sig) in &page_streams {
        if !sig.is_empty() && seen_sigs.insert(sig) {
            for id in sig {
                *usage.entry(*id).or_insert(0) += 1;
            }
        }
    }

    let mut result: Vec<ObjectId> = Vec::new();
    let mut result_seen: HashSet<ObjectId> = HashSet::new();
    let mut done: HashMap<Vec<ObjectId>, ObjectId> = HashMap::new();
    // lenient で連結を諦めた並び (同じ並びを使う他のページも、そのままにする)
    let mut gave_up: HashSet<Vec<ObjectId>> = HashSet::new();
    for (page_id, sig) in &page_streams {
        let target = match sig.len() {
            0 => continue,
            1 => sig[0],
            _ => {
                if gave_up.contains(sig) {
                    continue;
                }
                let target = match done.get(sig) {
                    Some(t) => *t,
                    None => {
                        let mut joined: Vec<u8> = Vec::new();
                        let mut failure: Option<String> = None;
                        for id in sig {
                            let Some(Object::Stream(st)) = doc.objects.get(id) else {
                                continue;
                            };
                            // 内容が欠けるもの (壊れた・途中で切れた Flate) は Err
                            match crate::image_recompress::content_stream_bytes(st) {
                                Ok(bytes) => {
                                    joined.extend_from_slice(&bytes);
                                    joined.push(b'\n');
                                }
                                Err(e) => {
                                    failure = Some(format!("stream {id:?} decompress: {e}"));
                                    break;
                                }
                            }
                        }
                        if let Some(msg) = failure {
                            if !lenient {
                                return Err(msg);
                            }
                            skipped.push(format!("page {page_id:?} /Contents kept as is ({msg})"));
                            gave_up.insert(sig.clone());
                            continue;
                        }
                        let exclusive = sig.iter().all(|id| usage.get(id) == Some(&1));
                        let target = if exclusive {
                            if let Some(Object::Stream(st)) = doc.objects.get_mut(&sig[0]) {
                                st.set_plain_content(joined);
                            }
                            sig[0]
                        } else {
                            doc.add_object(Stream::new(Dictionary::new(), joined))
                        };
                        done.insert(sig.clone(), target);
                        target
                    }
                };
                if let Ok(Object::Dictionary(page)) = doc.get_object_mut(*page_id) {
                    page.set("Contents", Object::Reference(target));
                }
                target
            }
        };
        if result_seen.insert(target) {
            result.push(target);
        }
    }
    Ok(result)
}

/// 内容ストリームの演算子を順に `f` へ渡す。インライン画像 (BI ... EI) は読み飛ばす。
/// 最後まで解析できなければ Err (decode_content と同じ基準)。
pub(crate) fn for_each_operation(
    bytes: &[u8],
    mut f: impl FnMut(&lopdf::content::Operation),
) -> Result<(), String> {
    let images = find_inline_images(bytes)?;
    let mut pos = 0usize;
    for (start, end) in images
        .iter()
        .copied()
        .chain(std::iter::once((bytes.len(), bytes.len())))
    {
        if start > pos {
            let content =
                decode_content(&bytes[pos..start]).map_err(|e| format!("content decode: {e}"))?;
            content.operations.iter().for_each(&mut f);
        }
        pos = end;
    }
    Ok(())
}

/// 内容ストリームを解析して書き直す。演算子と operand は変えず、空白・改行・数値の書式だけが
/// 変わる (演算子ごとに改行する)。インライン画像 (BI ... EI) はそのまま保つ。
/// `sanitize` なら、演算子列の整理 (sanitize_ops) も行い、取り除いた演算子の数を返す
/// (整理は、インライン画像で区切られた部分ごとに行い、画像をまたがない)。
/// 解析できない内容や、書き直すと壊れる値 (有限でない実数) があれば Err。
/// 呼び出し側 (clean) は Err を受けて MuPDF 実装へフォールバックする。
pub(crate) fn reencode_with(bytes: &[u8], sanitize: bool) -> Result<(Vec<u8>, usize), String> {
    let mut removed = 0usize;
    let images = find_inline_images(bytes)?;
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut pos = 0usize;
    for (start, end) in images
        .iter()
        .copied()
        .chain(std::iter::once((bytes.len(), bytes.len())))
    {
        if start > pos {
            // decode は、解析できない箇所から先を黙って捨てる (内容が欠ける) ので、
            // 全体を解析しきれたかを確かめる (末尾の空白・NUL だけは許容する)
            let mut content =
                decode_content(&bytes[pos..start]).map_err(|e| format!("content decode: {e}"))?;
            if content
                .operations
                .iter()
                .any(|op| op.operands.iter().any(has_non_finite))
            {
                return Err("content has a non-finite number".into());
            }
            if sanitize {
                let (ops, n) = crate::sanitize_ops::sanitize_operations(content.operations);
                content.operations = ops;
                removed += n;
            }
            let chunk = encode_content_eol_safe(&content)
                .map_err(|e| format!("content encode: {e}"))?;
            if !chunk.is_empty() {
                out.extend_from_slice(&chunk);
                out.push(b'\n');
            }
        }
        if end > start {
            out.extend_from_slice(&bytes[start..end]);
            out.push(b'\n');
        }
        pos = end;
    }
    Ok((out, removed))
}

/// operand (配列・辞書の中を含む) に、有限でない実数 (f32 に収まらない値) があるか。
/// lopdf の実数は f32 なので、極端に大きな数は inf になり、書き出すと壊れる。
fn has_non_finite(o: &Object) -> bool {
    match o {
        Object::Real(r) => !r.is_finite(),
        Object::Array(a) => a.iter().any(has_non_finite),
        Object::Dictionary(d) => d.iter().any(|(_, v)| has_non_finite(v)),
        _ => false,
    }
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
fn transform_chunk(
    chunk: &[u8],
    mode: Mode,
    kinds: &Kinds,
    ctx: &mut OpCtx,
) -> Result<(Vec<u8>, Counts), String> {
    // decode は、解析できない箇所から先を黙って捨てる (内容が欠ける) ので、
    // 全体を解析しきれたかを確かめる (末尾の空白・NUL だけは許容する)。解析できなければ Err (MuPDF へ)
    let content = decode_content(chunk).map_err(|e| format!("content decode: {e}"))?;
    let mut c = Counts::default();
    let mut ops: Vec<Operation> = Vec::with_capacity(content.operations.len());
    // TextOnly: 組み立て中のパス (m l c v y h re) と、そのパスに付いた W / W*。
    // 塗り・線を捨てるとき、クリップに使われないパスは座標ごと捨てる
    // (イラストの曲線が全部残ると、内容ストリームが数十倍に膨らむ)。
    let mut path_buf: Vec<Operation> = Vec::new();
    let mut pending_clip: Option<Operation> = None;
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
                // 覆いにしたパスの塗り・線: 背景ラスタ (文字の下層) からは除く (パスは `n` で捨てる)
                "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" => {
                    if ctx.next_paint_kept() {
                        ops.push(Operation::new("n", vec![]));
                        c.images += 1;
                    } else {
                        ops.push(op);
                    }
                }
                // 覆い: 背景ラスタ (文字の下層) からは除く
                "Do" if op
                    .operands
                    .first()
                    .and_then(|o| o.as_name().ok())
                    .and_then(|n| kinds.get(n))
                    == Some(&XKind::Cover) =>
                {
                    c.images += 1;
                }
                _ => ops.push(op),
            },
            Mode::TextOnly => match op.operator.as_str() {
                // パスの構築: いったん溜めて、終わり方で残すか捨てるか決める
                "m" | "l" | "c" | "v" | "y" | "h" | "re" => path_buf.push(op),
                // クリップの指定: パスの終わりまで保留する
                "W" | "W*" => pending_clip = Some(op),
                // パスの塗り・線・終端: 描かない。クリップに使うパスだけ「パス W n」で残す
                "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" | "n" => {
                    // 覆いにしたパスの塗り・線は、そのまま残す (文字との描画順を保つ)
                    if op.operator != "n" && ctx.next_paint_kept() {
                        ops.append(&mut path_buf);
                        if let Some(clip) = pending_clip.take() {
                            ops.push(clip);
                        }
                        ops.push(op);
                    } else {
                        if op.operator != "n" {
                            c.paints += 1;
                        }
                        if let Some(clip) = pending_clip.take() {
                            ops.append(&mut path_buf);
                            ops.push(clip);
                            ops.push(Operation::new("n", vec![]));
                        } else {
                            path_buf.clear();
                        }
                    }
                }
                // シェーディング: 除去 (背景ラスタに含まれる)
                "sh" => c.images += 1,
                // XObject: 画像は除去、Form は残す (中身も別途加工する)。判別できなければ Err
                "Do" => {
                    let name = op.operands.first().and_then(|o| o.as_name().ok());
                    match name.and_then(|n| kinds.get(n)) {
                        Some(XKind::Image) => c.images += 1,
                        Some(XKind::Form) | Some(XKind::Cover) => ops.push(op),
                        _ => return Err("Do of an unknown XObject".into()),
                    }
                }
                _ => ops.push(op),
            },
        }
    }
    let out = encode_content_eol_safe(&Content { operations: ops })
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
pub(crate) fn find_inline_images(b: &[u8]) -> Result<Vec<(usize, usize)>, String> {
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


// ── 覆い (文字に重なる、元のオブジェクト) の検出 ───────────────────────────────
//
// キープテキストの画像化は、非テキストを 1 枚の背景に焼き込み、文字をその上に重ねる。
// 元の PDF が「文字 → 半透明の帯・縁取り・飾り (文字に重なる)」の順に描いていると、背景に図形が
// 入った上に文字が最前面に来るので、見え方が変わる。ラスターのパッチで直すと、文字が
// 背景の解像度で焼き込まれてジャギーになる。
//
// そこで、文字より後に描かれる、文字を含まない次のオブジェクト (= 覆い) は、背景に焼かず、
// 元のオブジェクトのまま文字層に残す (合成しない)。文字層では文字と覆いが元の描画順のままなので、
// 文字はベクターのまま、元と同じ順に、ビューアーが合成する。
//   - ベクターの Form: 不透明度 (ca) が 1 未満、または曲線・線を含む (縁取り・影・輪郭・飾り)。
//     矩形の塗りだけの不透明な帯は対象外
//   - 画像 XObject / 画像を含む Form: ソフトマスク (透明マスク)・色抜きマスクを持つ、または
//     不透明度が 1 未満。画像はそのまま (再ラスタライズせず) 重ねる
//   - シェーディング・パターン・ソフトマスクの ExtGState・インライン画像を含む Form は対象外
// 覆いを背景から外しても元と同じになるか (後から描かれる画像・図形が覆いの下に回らないか) と、
// 覆いが文字に掛かっているかは、呼び出し側が画素で検証する (cover_patch::check_layering)。

/// 覆いの候補
#[derive(Debug, Clone, PartialEq)]
pub struct CoverCandidate {
    pub key: CoverKey,
    /// ページ座標 (ユーザー空間) の外接矩形 `[x0, y0, x1, y1]`。求められなければ None。
    /// 同じオブジェクトを複数回描いていれば、その和。
    pub bbox: Option<[f64; 4]>,
}

type Mat = [f64; 6];
const IDENTITY: Mat = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `m` のあとに `n` を適用する合成 (PDF の行ベクトル規約: p' = p · m · n)
fn mat_mul(m: &Mat, n: &Mat) -> Mat {
    [
        m[0] * n[0] + m[1] * n[2],
        m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2],
        m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4],
        m[4] * n[1] + m[5] * n[3] + n[5],
    ]
}

/// 矩形 `r = [x0, y0, x1, y1]` を `m` で変換した外接矩形
fn mat_bbox(m: &Mat, r: [f64; 4]) -> [f64; 4] {
    let pts = [(r[0], r[1]), (r[2], r[1]), (r[0], r[3]), (r[2], r[3])];
    let mut out = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for (x, y) in pts {
        let (px, py) = (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
        out[0] = out[0].min(px);
        out[1] = out[1].min(py);
        out[2] = out[2].max(px);
        out[3] = out[3].max(py);
    }
    out
}

fn bbox_union(a: Option<[f64; 4]>, b: Option<[f64; 4]>) -> Option<[f64; 4]> {
    match (a, b) {
        (Some(a), Some(b)) => Some([a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]),
        _ => None,
    }
}

fn numbers(doc: &Document, o: Option<&Object>, n: usize) -> Option<Vec<f64>> {
    let o = match o? {
        Object::Reference(id) => doc.get_object(*id).ok()?,
        o => o,
    };
    let arr = o.as_array().ok()?;
    if arr.len() != n {
        return None;
    }
    arr.iter()
        .map(|v| match v {
            Object::Reference(id) => doc.get_object(*id).ok()?.as_float().ok().map(f64::from),
            v => v.as_float().ok().map(f64::from),
        })
        .collect()
}

/// ページの描画領域 `[x0, y0, x1, y1]` (CropBox、無ければ MediaBox。親ノードの継承も見る)。
/// 回転しているページは None (座標の対応づけを行わない)。
pub fn page_geom(doc: &Document, page_id: ObjectId) -> Option<[f64; 4]> {
    let mut node = page_id;
    let (mut crop, mut media, mut rotate): (Option<[f64; 4]>, Option<[f64; 4]>, Option<i64>) =
        (None, None, None);
    for _ in 0..MAX_DEPTH {
        let d = doc.get_dictionary(node).ok()?;
        if crop.is_none() {
            crop = numbers(doc, d.get(b"CropBox").ok(), 4).map(|v| [v[0], v[1], v[2], v[3]]);
        }
        if media.is_none() {
            media = numbers(doc, d.get(b"MediaBox").ok(), 4).map(|v| [v[0], v[1], v[2], v[3]]);
        }
        if rotate.is_none() {
            rotate = d.get(b"Rotate").ok().and_then(|o| o.as_i64().ok());
        }
        match d.get(b"Parent").ok().and_then(|o| o.as_reference().ok()) {
            Some(p) => node = p,
            None => break,
        }
    }
    if rotate.unwrap_or(0).rem_euclid(360) != 0 {
        return None;
    }
    let b = crop.or(media)?;
    let (x0, x1) = (b[0].min(b[2]), b[0].max(b[2]));
    let (y0, y1) = (b[1].min(b[3]), b[1].max(b[3]));
    (x1 > x0 && y1 > y0).then_some([x0, y0, x1, y1])
}

/// 覆いの候補を、描画順に返す (重複なし)。解析できないページは空を返す。
pub fn find_cover_candidates(doc: &Document, page_id: ObjectId) -> Vec<CoverCandidate> {
    let mut bytes: Vec<u8> = Vec::new();
    for sid in doc.get_page_contents(page_id) {
        if let Ok(Object::Stream(st)) = doc.get_object(sid) {
            match crate::image_recompress::content_stream_bytes(st) {
                Ok(b) => {
                    bytes.extend_from_slice(&b);
                    bytes.push(b'\n');
                }
                Err(_) => return Vec::new(),
            }
        }
    }
    let res = effective_resources(doc, page_id).unwrap_or_default();
    let mut w = CoverWalk {
        doc,
        clock: 0,
        first_text: None,
        cands: Vec::new(),
    };
    w.walk(&bytes, &res, 1.0, IDENTITY, StreamKey::Page(page_id), 0);
    let mut out: Vec<CoverCandidate> = Vec::new();
    let Some(first) = w.first_text else {
        return out;
    };
    for c in w.cands.iter().filter(|c| c.at > first) {
        match out.iter_mut().find(|o| o.key == c.key) {
            Some(o) => o.bbox = bbox_union(o.bbox, c.bbox),
            None => out.push(CoverCandidate {
                key: c.key,
                bbox: c.bbox,
            }),
        }
    }
    out
}

/// `find_cover_candidates` の、画像・Form (オブジェクト) の候補の ID だけ版
pub fn find_cover_forms(doc: &Document, page_id: ObjectId) -> Vec<ObjectId> {
    find_cover_candidates(doc, page_id)
        .into_iter()
        .filter_map(|c| match c.key {
            CoverKey::Obj(id) => Some(id),
            CoverKey::Op(..) => None,
        })
        .collect()
}

struct RawCand {
    key: CoverKey,
    bbox: Option<[f64; 4]>,
    /// 描画順の時刻 (文字の描画・覆いの描画ごとに進む)
    at: usize,
}

struct CoverWalk<'a> {
    doc: &'a Document,
    clock: usize,
    first_text: Option<usize>,
    cands: Vec<RawCand>,
}

impl CoverWalk<'_> {
    /// 内容ストリームを描画順にたどる。`alpha0`: 呼び出し時点の塗りの不透明度 (ca)、
    /// `ctm0`: 呼び出し時点の変換行列 (ページのユーザー空間への)、
    /// `key`: このストリームの識別子 (パスの塗り命令の通し番号を指すため)
    fn walk(
        &mut self,
        bytes: &[u8],
        res: &Dictionary,
        alpha0: f32,
        ctm0: Mat,
        key: StreamKey,
        depth: usize,
    ) {
        if depth > 8 {
            return;
        }
        let doc = self.doc;
        let gs_tbl = resolve_dict(doc, res.get(b"ExtGState").ok());
        let xo_tbl = resolve_dict(doc, res.get(b"XObject").ok());
        let mut stack: Vec<(f32, Mat)> = Vec::new();
        let (mut cur, mut ctm) = (alpha0, ctm0);
        // 組み立て中のパス: 頂点 (ページ座標)、曲線・折れ線 (m l c v y) の有無
        let mut path = PathAcc::default();
        // このストリームの、パスの塗り・線の命令の通し番号
        let mut ord = 0usize;
        let _ = for_each_operation(bytes, |op| match op.operator.as_str() {
            "q" => stack.push((cur, ctm)),
            "Q" => {
                if let Some((a, m)) = stack.pop() {
                    cur = a;
                    ctm = m;
                }
            }
            "cm" => {
                let v: Vec<f64> = op
                    .operands
                    .iter()
                    .filter_map(|o| o.as_float().ok().map(f64::from))
                    .collect();
                if v.len() == 6 {
                    ctm = mat_mul(&[v[0], v[1], v[2], v[3], v[4], v[5]], &ctm);
                }
            }
            "gs" => {
                let d = op
                    .operands
                    .first()
                    .and_then(|o| o.as_name().ok())
                    .and_then(|n| gs_tbl.and_then(|t| t.get(n).ok()))
                    .and_then(|o| resolve_dict(doc, Some(o)));
                if let Some(ca) = d
                    .and_then(|d| d.get(b"ca").ok())
                    .and_then(|o| o.as_float().ok())
                {
                    cur = ca;
                }
            }
            "Tj" | "TJ" | "'" | "\"" => {
                self.clock += 1;
                self.first_text.get_or_insert(self.clock);
            }
            // パスの構築
            "m" | "l" | "c" | "v" | "y" | "re" => {
                let v: Vec<f64> = op
                    .operands
                    .iter()
                    .filter_map(|o| o.as_float().ok().map(f64::from))
                    .collect();
                path.add(op.operator.as_str(), &v, &ctm);
            }
            "n" => path.clear(),
            // パスの塗り・線: 文字より後なら、覆いの候補
            "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" => {
                let i = ord;
                ord += 1;
                if self.first_text.is_some() && path.eligible(cur) {
                    self.clock += 1;
                    self.cands.push(RawCand {
                        key: CoverKey::Op(key, i),
                        // 線の太さ・アンチエイリアスの分だけ広げる
                        bbox: path.bbox().map(|b| [b[0] - 1.0, b[1] - 1.0, b[2] + 1.0, b[3] + 1.0]),
                        at: self.clock,
                    });
                }
                path.clear();
            }
            "Do" => {
                let id = op
                    .operands
                    .first()
                    .and_then(|o| o.as_name().ok())
                    .and_then(|n| xo_tbl.and_then(|t| t.get(n).ok()))
                    .and_then(|o| o.as_reference().ok());
                let Some(id) = id else { return };
                let Ok(Object::Stream(st)) = doc.get_object(id) else {
                    return;
                };
                match st.dict.get(b"Subtype").ok().and_then(|o| o.as_name().ok()) {
                    Some(b"Image") => {
                        if cur < 0.999 || image_has_mask(st) {
                            self.clock += 1;
                            self.cands.push(RawCand {
                                key: CoverKey::Obj(id),
                                bbox: Some(mat_bbox(&ctm, [0.0, 0.0, 1.0, 1.0])),
                                at: self.clock,
                            });
                        }
                    }
                    Some(b"Form") => {
                        let fm = numbers(doc, st.dict.get(b"Matrix").ok(), 6)
                            .map(|v| [v[0], v[1], v[2], v[3], v[4], v[5]])
                            .unwrap_or(IDENTITY);
                        let fctm = mat_mul(&fm, &ctm);
                        let info = form_info(doc, id, 0);
                        if !info.text && !info.unsupported && (cur < 0.999 || info.mask_image || info.curves)
                        {
                            self.clock += 1;
                            let bbox = numbers(doc, st.dict.get(b"BBox").ok(), 4)
                                .map(|v| mat_bbox(&fctm, [v[0], v[1], v[2], v[3]]));
                            self.cands.push(RawCand {
                                key: CoverKey::Obj(id),
                                bbox,
                                at: self.clock,
                            });
                            return;
                        }
                        // 覆いでない Form は、中の描画順をたどる (自身のリソースが無ければ親のもの)
                        let Ok(fbytes) = crate::image_recompress::content_stream_bytes(st) else {
                            return;
                        };
                        let fres = resolve_dict(doc, st.dict.get(b"Resources").ok())
                            .unwrap_or(res)
                            .clone();
                        self.walk(&fbytes, &fres, cur, fctm, StreamKey::Form(id), depth + 1);
                    }
                    _ => {}
                }
            }
            _ => {}
        });
    }
}

/// 組み立て中のパス (頂点と、種類)
#[derive(Default)]
struct PathAcc {
    pts: Vec<(f64, f64)>,
    /// 曲線 (c v y) を含む
    curve: bool,
    /// 折れ線 (m l) を含む。矩形 (re) だけのパスは含まない
    poly: bool,
}

impl PathAcc {
    fn clear(&mut self) {
        self.pts.clear();
        self.curve = false;
        self.poly = false;
    }

    /// パス構築演算子 `op` (引数 `v`) を、変換行列 `m` のもとで加える
    fn add(&mut self, op: &str, v: &[f64], m: &Mat) {
        let tf = |x: f64, y: f64| (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
        match (op, v.len()) {
            ("m" | "l", 2) => {
                self.poly = true;
                self.pts.push(tf(v[0], v[1]));
            }
            ("c", 6) => {
                self.curve = true;
                for k in 0..3 {
                    self.pts.push(tf(v[k * 2], v[k * 2 + 1]));
                }
            }
            ("v" | "y", 4) => {
                self.curve = true;
                for k in 0..2 {
                    self.pts.push(tf(v[k * 2], v[k * 2 + 1]));
                }
            }
            ("re", 4) => {
                let (x, y, w, h) = (v[0], v[1], v[2], v[3]);
                for (px, py) in [(x, y), (x + w, y), (x, y + h), (x + w, y + h)] {
                    self.pts.push(tf(px, py));
                }
            }
            _ => {}
        }
    }

    /// 外接矩形 `[x0, y0, x1, y1]`
    fn bbox(&self) -> Option<[f64; 4]> {
        let first = *self.pts.first()?;
        let mut b = [first.0, first.1, first.0, first.1];
        for &(x, y) in &self.pts {
            b[0] = b[0].min(x);
            b[1] = b[1].min(y);
            b[2] = b[2].max(x);
            b[3] = b[3].max(y);
        }
        Some(b)
    }

    /// 覆いの候補にしてよいパスか: 半透明、または曲線・折れ線を含む
    /// (矩形の塗りだけの不透明なパスは、背景・帯なので対象外)
    fn eligible(&self, alpha: f32) -> bool {
        !self.pts.is_empty() && (alpha < 0.999 || self.curve || self.poly)
    }
}

/// 画像 XObject が、ソフトマスク・色抜きマスク・ステンシルマスクを持つか
fn image_has_mask(st: &Stream) -> bool {
    st.dict.has(b"SMask")
        || st.dict.has(b"Mask")
        || st
            .dict
            .get(b"ImageMask")
            .ok()
            .and_then(|o| o.as_bool().ok())
            .unwrap_or(false)
}

/// Form XObject の中身の概要
#[derive(Debug, Default, Clone, Copy)]
struct FormInfo {
    /// 文字を描く命令を含む
    text: bool,
    /// マスクを持つ画像を含む
    mask_image: bool,
    /// 曲線か線を含む (縁取り・影・輪郭・飾りのような形。矩形の塗りだけの帯は含まない)
    curves: bool,
    /// シェーディング・パターン・ソフトマスクの ExtGState・インライン画像を含む、または解析できない
    unsupported: bool,
}

impl FormInfo {
    fn merge(&mut self, o: FormInfo) {
        self.text |= o.text;
        self.mask_image |= o.mask_image;
        self.curves |= o.curves;
        self.unsupported |= o.unsupported;
    }
}

/// Form XObject の中身 (入れ子の Form・画像も含む) の概要を調べる。
fn form_info(doc: &Document, id: ObjectId, depth: usize) -> FormInfo {
    let bad = FormInfo {
        unsupported: true,
        ..Default::default()
    };
    if depth > 4 {
        return bad;
    }
    let Ok(Object::Stream(st)) = doc.get_object(id) else {
        return bad;
    };
    let empty = Dictionary::new();
    let res = resolve_dict(doc, st.dict.get(b"Resources").ok()).unwrap_or(&empty);
    if res.has(b"Pattern") || res.has(b"Shading") {
        return bad;
    }
    if let Some(gs) = resolve_dict(doc, res.get(b"ExtGState").ok()) {
        for (_, v) in gs.iter() {
            let Some(d) = resolve_dict(doc, Some(v)) else {
                continue;
            };
            if let Ok(sm) = d.get(b"SMask")
                && !matches!(sm, Object::Name(n) if n == b"None")
            {
                return bad;
            }
        }
    }
    let mut info = FormInfo::default();
    if let Some(xo) = resolve_dict(doc, res.get(b"XObject").ok()) {
        for (_, v) in xo.iter() {
            let Object::Reference(child) = v else {
                return bad;
            };
            match doc.get_object(*child) {
                Ok(Object::Stream(cs)) => {
                    match cs.dict.get(b"Subtype").ok().and_then(|o| o.as_name().ok()) {
                        Some(b"Form") => info.merge(form_info(doc, *child, depth + 1)),
                        Some(b"Image") => info.mask_image |= image_has_mask(cs),
                        _ => return bad,
                    }
                }
                _ => return bad,
            }
        }
    }
    let Ok(bytes) = crate::image_recompress::content_stream_bytes(st) else {
        return bad;
    };
    match find_inline_images(&bytes) {
        Ok(v) if v.is_empty() => {}
        _ => return bad,
    }
    let parsed = for_each_operation(&bytes, |op| match op.operator.as_str() {
        "Tj" | "TJ" | "'" | "\"" => info.text = true,
        "sh" | "BI" => info.unsupported = true,
        "c" | "v" | "y" | "S" | "s" | "B" | "B*" | "b" | "b*" => info.curves = true,
        _ => {}
    });
    if parsed.is_err() {
        return bad;
    }
    info
}

/// 覆いだけを描く複製 (文字と、覆い以外の描画を取り除いたもの) を返す。
/// 覆いの色とアルファを、白地と黒地の 2 回の描画から復元するために使う。
/// `black_backdrop`: ページの先頭に黒の全面塗りを置く (黒地に描くため)。
pub fn covers_only_bytes(
    input: &[u8],
    covers: &Covers,
    black_backdrop: bool,
) -> Result<Vec<u8>, String> {
    let mut doc = Document::load_mem(input).map_err(|e| format!("lopdf load: {e}"))?;
    if doc.is_encrypted() {
        return Err("encrypted".into());
    }
    // 覆い以外の描画を除き (文字は残る)、続けて文字を除く
    transform_covers(&mut doc, Mode::TextOnly, covers)?;
    transform_covers(&mut doc, Mode::RemoveText, &Covers::default())?;
    if black_backdrop {
        let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
        for page_id in pages {
            let Some(sid) = doc.get_page_contents(page_id).first().copied() else {
                continue;
            };
            if let Ok(Object::Stream(st)) = doc.get_object_mut(sid) {
                let old = crate::image_recompress::content_stream_bytes(st)
                    .map_err(|e| format!("stream {sid:?} decompress: {e}"))?;
                let mut nb = b"q 0 g -100000 -100000 200000 200000 re f Q\n".to_vec();
                nb.extend_from_slice(&old);
                st.set_plain_content(nb);
            }
        }
    }
    let mut out = Vec::with_capacity(input.len());
    doc.save_to(&mut out).map_err(|e| format!("lopdf save: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    /// ページ 1 枚の PDF を作る。`contents` は /Contents に入れる値を作る関数
    fn page_doc(build: impl FnOnce(&mut Document) -> Object) -> (Document, ObjectId) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let contents = build(&mut doc);
        let page_id = doc.add_object(dictionary! {
            "Type"=>"Page","Parent"=>pages_id,
            "MediaBox"=>vec![0.into(),0.into(),200.into(),200.into()],
            "Resources"=>dictionary!{},
            "Contents"=>contents,
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type"=>"Pages","Kids"=>vec![page_id.into()],"Count"=>1,
            }),
        );
        let cat = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages_id});
        doc.trailer.set("Root", cat);
        (doc, page_id)
    }

    /// 壊れた・途中で切れた Flate (lopdf は Err にせず、空か途中までの内容を返す) や、未対応の
    /// フィルタの内容ストリームは、欠けたまま書き戻さず Err にする (MuPDF へフォールバックさせる)。
    #[test]
    fn text_removal_rejects_content_streams_that_cannot_be_read_completely() {
        for (kind, broken) in crate::image_recompress::broken_content_streams() {
            for mode in [Mode::RemoveText, Mode::TextOnly] {
                let (mut doc, page_id) =
                    page_doc(|doc| Object::Reference(doc.add_object(broken.clone())));
                let before = doc
                    .get_object(doc.get_page_contents(page_id)[0])
                    .unwrap()
                    .clone();
                assert!(transform(&mut doc, mode).is_err(), "{kind} {mode:?}");
                // Err のとき、内容ストリームは変わっていない
                assert_eq!(
                    doc.get_object(doc.get_page_contents(page_id)[0]).unwrap(),
                    &before,
                    "{kind} {mode:?}"
                );
            }
        }
    }

    #[test]
    fn merging_split_contents_rejects_streams_that_cannot_be_read_completely() {
        for (kind, broken) in crate::image_recompress::broken_content_streams() {
            let (mut doc, page_id) = page_doc(|doc| {
                let ok = doc.add_object(lopdf::Stream::new(
                    dictionary! {},
                    b"q 0 0 5 5 re f".to_vec(),
                ));
                let bad = doc.add_object(broken.clone());
                Object::Array(vec![ok.into(), bad.into()])
            });
            assert!(merge_page_contents(&mut doc).is_err(), "{kind}");
            // Err のとき、ページの /Contents は 2 本のまま
            assert_eq!(doc.get_page_contents(page_id).len(), 2, "{kind}");
        }
    }

    /// 正しく圧縮された内容は、これまでどおり処理できる。zlib のチェックサム (adler32) だけが
    /// 合わないものも、内容は欠けていないので、処理できる。
    #[test]
    fn valid_and_checksum_only_damaged_flate_content_is_still_processed() {
        for damage_checksum in [false, true] {
            let (mut doc, page_id) = page_doc(|doc| {
                let mut s = lopdf::Stream::new(
                    dictionary! {},
                    b"BT /F1 12 Tf (a) Tj ET 0 0 5 5 re f".repeat(20),
                );
                s.compress().unwrap();
                assert!(s.dict.has(b"Filter"));
                if damage_checksum {
                    *s.content.last_mut().unwrap() ^= 0xff;
                }
                Object::Reference(doc.add_object(s))
            });
            let stats = transform(&mut doc, Mode::RemoveText).unwrap();
            assert_eq!(stats.removed_ops, 20, "damage_checksum={damage_checksum}");
            let ops = Content::decode_strict(&doc.get_page_content(page_id))
                .unwrap()
                .operations;
            assert_eq!(ops.iter().filter(|o| o.operator == "re").count(), 20);
        }
    }

    #[test]
    fn decode_content_tolerates_only_trailing_junk() {
        // 末尾の空白・NUL・改ページだけは許容する (decode でも欠けずに読めるため)
        for ok in [
            &b"q 0 0 1 1 re f Q\0"[..],
            b"q 0 0 1 1 re f Q\x0c\x0c",
            b"q 0 0 1 1 re f Q \r\n\0\0",
            b"",
        ] {
            assert!(decode_content(ok).is_ok(), "{ok:?}");
        }
        assert_eq!(
            decode_content(b"q 0 0 1 1 re f Q\0")
                .unwrap()
                .operations
                .len(),
            4
        );
        // 途中の NUL や不正なトークンは許容しない (decode はそこで打ち切ってしまう)
        for bad in [
            &b"q\0 0 0 1 1 re f Q"[..],
            b"q 0 0 1 1 re f Q @@@",
            b"BT (abc Tj ET",
        ] {
            assert!(decode_content(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn trailing_nul_does_not_block_text_removal() {
        let (mut doc, page_id) = page_doc(|doc| {
            Object::Reference(doc.add_object(lopdf::Stream::new(
                dictionary! {},
                b"BT /F1 12 Tf (a) Tj ET 0 0 5 5 re f\n\0\0".to_vec(),
            )))
        });
        let stats = transform(&mut doc, Mode::RemoveText).unwrap();
        assert_eq!(stats.removed_ops, 1);
        let ops = Content::decode_strict(&doc.get_page_content(page_id))
            .unwrap()
            .operations;
        assert!(ops.iter().all(|o| o.operator != "Tj"));
    }

    #[test]
    fn operands_split_across_content_streams_are_joined_first() {
        // 1 本目の末尾に operand (10 20)、2 本目の先頭に演算子 (Td)。
        // ストリームごとに解析すると operand が落ち、Td が operand 無しで残ってしまう
        let (mut doc, page_id) = page_doc(|doc| {
            let a = doc.add_object(lopdf::Stream::new(
                dictionary! {},
                b"BT /F1 12 Tf 10 20".to_vec(),
            ));
            let b = doc.add_object(lopdf::Stream::new(
                dictionary! {},
                b"Td (hello) Tj ET 0 0 5 5 re f".to_vec(),
            ));
            Object::Array(vec![a.into(), b.into()])
        });
        let stats = transform(&mut doc, Mode::RemoveText).unwrap();
        assert_eq!(stats.removed_ops, 1);
        assert_eq!(doc.get_page_contents(page_id).len(), 1);
        let ops = Content::decode_strict(&doc.get_page_content(page_id))
            .unwrap()
            .operations;
        let names: Vec<&str> = ops.iter().map(|o| o.operator.as_str()).collect();
        assert_eq!(names, ["BT", "Tf", "Td", "ET", "re", "f"]);
        let td = ops.iter().find(|o| o.operator == "Td").unwrap();
        assert_eq!(td.operands.len(), 2, "Td keeps its operands");
    }

    #[test]
    fn unparsable_content_is_an_error_not_a_truncation() {
        // decode は "@@@" から先を黙って捨てる。strict なので Err になる
        let (mut doc, page_id) = page_doc(|doc| {
            Object::Reference(doc.add_object(lopdf::Stream::new(
                dictionary! {},
                b"BT (a) Tj ET @@@ 0 0 1 1 re f".to_vec(),
            )))
        });
        let before = doc.get_page_content(page_id);
        assert!(transform(&mut doc, Mode::RemoveText).is_err());
        assert!(transform(&mut doc, Mode::TextOnly).is_err());
        assert_eq!(doc.get_page_content(page_id), before);
    }

    #[test]
    fn merge_page_contents_leaves_shared_streams_alone() {
        // 2 ページが 1 本目を共有し、片方だけ 2 本目を持つ
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let shared = doc.add_object(lopdf::Stream::new(
            dictionary! {},
            b"q 0 0 1 1 re f".to_vec(),
        ));
        let tail = doc.add_object(lopdf::Stream::new(dictionary! {}, b"Q".to_vec()));
        let mk = |doc: &mut Document, c: Object| {
            doc.add_object(dictionary! {
                "Type"=>"Page","Parent"=>pages_id,
                "MediaBox"=>vec![0.into(),0.into(),10.into(),10.into()],
                "Resources"=>dictionary!{}, "Contents"=>c,
            })
        };
        let p1 = mk(&mut doc, Object::Array(vec![shared.into(), tail.into()]));
        let p2 = mk(&mut doc, Object::Reference(shared));
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type"=>"Pages","Kids"=>vec![p1.into(), p2.into()],"Count"=>2,
            }),
        );
        let cat = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages_id});
        doc.trailer.set("Root", cat);

        let ids = merge_page_contents(&mut doc).unwrap();
        assert_eq!(ids.len(), 2, "merged stream for p1 + the shared one for p2");
        assert_eq!(doc.get_page_contents(p1).len(), 1);
        // 共有されていた 1 本目はそのまま、p2 はそれを指し続ける
        assert_eq!(doc.get_page_contents(p2), vec![shared]);
        let kept = doc.get_object(shared).unwrap().as_stream().unwrap();
        assert_eq!(kept.content, b"q 0 0 1 1 re f");
        let joined = String::from_utf8(doc.get_page_content(p1)).unwrap();
        assert_eq!(
            joined.split_whitespace().collect::<Vec<_>>().join(" "),
            "q 0 0 1 1 re f Q"
        );
    }

    #[test]
    fn strips_show_operators_keeps_state() {
        let src = b"q 1 0 0 rg 10 10 50 50 re f Q BT /F1 12 Tf 20 700 Td (Hello) Tj [(A) 20 (B)] TJ 14 TL (x) ' 1 2 (y) \" ET";
        let (out, n) = strip_text_ops(src).unwrap();
        assert_eq!(n, 4);
        let ops = Content::decode_strict(&out).unwrap().operations;
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
            dictionary! {"Type"=>"XObject","Subtype"=>"Form","BBox"=>vec![Object::Integer(0),Object::Integer(0),Object::Integer(100),Object::Integer(100)]},
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

    fn cover_doc(form_body: &str, page_body: &str) -> (Document, ObjectId) {
        use lopdf::dictionary;
        let mut doc = Document::with_version("1.5");
        let form = doc.add_object(Stream::new(
            dictionary! {"Type"=>"XObject","Subtype"=>"Form","BBox"=>vec![Object::Integer(0),Object::Integer(0),Object::Integer(100),Object::Integer(100)]},
            form_body.as_bytes().to_vec(),
        ));
        let gs = doc.add_object(dictionary! {"Type"=>"ExtGState","ca"=>Object::Real(0.22)});
        let content = doc.add_object(Stream::new(dictionary! {}, page_body.as_bytes().to_vec()));
        let pages_id = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type"=>"Page","Parent"=>pages_id,"Contents"=>content,
            "MediaBox"=>vec![Object::Integer(0),Object::Integer(0),Object::Integer(100),Object::Integer(100)],
            "Resources"=>dictionary!{
                "ExtGState"=>dictionary!{"G1"=>gs},
                "XObject"=>dictionary!{"Fm1"=>form},
            },
        });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! {
            "Type"=>"Pages","Kids"=>vec![Object::Reference(page)],"Count"=>Object::Integer(1),
        }));
        let cat = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages_id});
        doc.trailer.set("Root", cat);
        (doc, page)
    }

    #[test]
    fn cover_form_after_text_is_found() {
        let (doc, page) = cover_doc(
            "1 0 0 rg 0 0 50 50 re f",
            "BT /F1 12 Tf (a) Tj ET q /G1 gs /Fm1 Do Q",
        );
        assert_eq!(find_cover_forms(&doc, page).len(), 1);
    }

    #[test]
    fn cover_form_before_text_is_not_found() {
        let (doc, page) = cover_doc(
            "1 0 0 rg 0 0 50 50 re f",
            "q /G1 gs /Fm1 Do Q BT /F1 12 Tf (a) Tj ET",
        );
        assert!(find_cover_forms(&doc, page).is_empty());
    }

    #[test]
    fn opaque_form_after_text_is_not_a_cover() {
        let (doc, page) = cover_doc(
            "1 0 0 rg 0 0 50 50 re f",
            "BT /F1 12 Tf (a) Tj ET /Fm1 Do",
        );
        assert!(find_cover_forms(&doc, page).is_empty());
    }

    #[test]
    fn form_with_text_or_shading_is_not_a_cover() {
        let (doc, page) = cover_doc(
            "BT /F1 12 Tf (b) Tj ET",
            "BT /F1 12 Tf (a) Tj ET q /G1 gs /Fm1 Do Q",
        );
        assert!(find_cover_forms(&doc, page).is_empty());
        let (doc, page) = cover_doc("/Sh1 sh", "BT /F1 12 Tf (a) Tj ET q /G1 gs /Fm1 Do Q");
        assert!(find_cover_forms(&doc, page).is_empty());
    }

    #[test]
    fn opaque_outline_after_text_is_a_cover_but_plain_band_is_not() {
        // 文字 → 縁取り (線) → 文字: 対象
        let (doc, page) = cover_doc(
            "1 0 0 RG 2 w 0 0 m 50 50 l S",
            "BT /F1 12 Tf (a) Tj ET /Fm1 Do BT /F1 12 Tf (b) Tj ET",
        );
        assert_eq!(find_cover_forms(&doc, page).len(), 1);
        // 文字 → 矩形の塗りだけの不透明な帯 → 文字: 対象外
        let (doc, page) = cover_doc(
            "1 0 0 rg 0 0 50 50 re f",
            "BT /F1 12 Tf (a) Tj ET /Fm1 Do BT /F1 12 Tf (b) Tj ET",
        );
        assert!(find_cover_forms(&doc, page).is_empty());
        // 縁取りは、全文字の後 (影・輪郭を最後に描く) でも対象
        let (doc, page) = cover_doc(
            "1 0 0 RG 2 w 0 0 m 50 50 l S",
            "BT /F1 12 Tf (a) Tj ET /Fm1 Do",
        );
        assert_eq!(find_cover_forms(&doc, page).len(), 1);
        // 文字より前に描かれる縁取りは対象外 (文字の下)
        let (doc, page) = cover_doc(
            "1 0 0 RG 2 w 0 0 m 50 50 l S",
            "/Fm1 Do BT /F1 12 Tf (a) Tj ET",
        );
        assert!(find_cover_forms(&doc, page).is_empty());
    }

    #[test]
    fn covers_only_keeps_nothing_but_the_cover() {
        let (doc, page) = cover_doc(
            "1 0 0 rg 0 0 50 50 re f",
            "0 0 1 rg 0 0 9 9 re f BT /F1 12 Tf (a) Tj ET q /G1 gs /Fm1 Do Q",
        );
        let covers = Covers {
            objs: find_cover_forms(&doc, page).into_iter().collect(),
            ..Default::default()
        };
        assert_eq!(covers.len(), 1);
        let mut buf = Vec::new();
        doc.clone().save_to(&mut buf).unwrap();
        let out = covers_only_bytes(&buf, &covers, true).unwrap();
        let d2 = Document::load_mem(&out).unwrap();
        let pid = *d2.get_pages().values().next().unwrap();
        let sid = d2.get_page_contents(pid)[0];
        let Ok(Object::Stream(st)) = d2.get_object(sid) else { panic!() };
        let txt = String::from_utf8_lossy(&st.decompressed_content().unwrap_or(st.content.clone())).to_string();
        assert!(txt.contains("-100000"), "{txt}");
        assert!(txt.contains("Do"), "{txt}");
        assert!(!txt.contains("Tj"), "{txt}");
        assert!(!txt.contains("0 0 9 9 re f"), "{txt}");
    }

    #[test]
    fn candidate_bbox_follows_ctm_and_form_matrix() {
        let (doc, page) = cover_doc(
            "1 0 0 rg 0 0 10 20 re f",
            "BT /F1 12 Tf (a) Tj ET q 2 0 0 3 5 6 cm /G1 gs /Fm1 Do Q",
        );
        let c = find_cover_candidates(&doc, page);
        assert_eq!(c.len(), 1);
        assert!(matches!(c[0].key, CoverKey::Obj(_)));
        // BBox [0 0 100 100] を 2 0 0 3 5 6 cm で変換
        assert_eq!(c[0].bbox, Some([5.0, 6.0, 205.0, 306.0]));
    }

    #[test]
    fn page_geom_uses_cropbox_or_mediabox_and_skips_rotated() {
        let (doc, page) = cover_doc("1 0 0 rg 0 0 1 1 re f", "");
        assert_eq!(page_geom(&doc, page), Some([0.0, 0.0, 100.0, 100.0]));
        let mut d2 = doc.clone();
        if let Ok(Object::Dictionary(d)) = d2.get_object_mut(page) {
            d.set("Rotate", Object::Integer(90));
        }
        assert_eq!(page_geom(&d2, page), None);
    }

    #[test]
    fn masked_image_after_text_is_a_candidate_but_opaque_one_is_not() {
        use lopdf::dictionary;
        for (with_mask, expect) in [(true, 1usize), (false, 0usize)] {
            let (mut doc, page) = cover_doc("1 0 0 rg 0 0 1 1 re f", "");
            let mut d = dictionary! {
                "Type"=>"XObject","Subtype"=>"Image",
                "Width"=>Object::Integer(1),"Height"=>Object::Integer(1),
                "ColorSpace"=>"DeviceGray","BitsPerComponent"=>Object::Integer(8)
            };
            if with_mask {
                d.set("SMask", Object::Reference((9999, 0)));
            }
            let img = doc.add_object(Stream::new(d, vec![0u8]));
            let content = doc.add_object(Stream::new(
                dictionary! {},
                b"BT /F1 12 Tf (a) Tj ET q 10 0 0 20 5 6 cm /Im1 Do Q".to_vec(),
            ));
            if let Ok(Object::Dictionary(p)) = doc.get_object_mut(page) {
                p.set("Contents", content);
                p.set(
                    "Resources",
                    dictionary! {"XObject"=>dictionary!{"Im1"=>img}},
                );
            }
            let c = find_cover_candidates(&doc, page);
            assert_eq!(c.len(), expect, "with_mask={with_mask}");
            if expect == 1 {
                assert_eq!(c[0].bbox, Some([5.0, 6.0, 15.0, 26.0]));
            }
        }
    }

    fn path_doc(body: &str) -> (Document, ObjectId) {
        use lopdf::dictionary;
        let mut doc = Document::with_version("1.5");
        let content = doc.add_object(Stream::new(dictionary! {}, body.as_bytes().to_vec()));
        let pages_id = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type"=>"Page","Parent"=>pages_id,"Contents"=>content,
            "MediaBox"=>vec![Object::Integer(0),Object::Integer(0),Object::Integer(100),Object::Integer(100)],
            "Resources"=>dictionary!{},
        });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! {
            "Type"=>"Pages","Kids"=>vec![Object::Reference(page)],"Count"=>Object::Integer(1),
        }));
        let cat = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages_id});
        doc.trailer.set("Root", cat);
        (doc, page)
    }

    fn page_text(doc: &Document, page: ObjectId) -> String {
        let sid = doc.get_page_contents(page)[0];
        let Ok(Object::Stream(st)) = doc.get_object(sid) else { panic!() };
        String::from_utf8_lossy(&st.content).to_string()
    }

    #[test]
    fn path_fill_after_text_is_a_candidate_with_ordinal_and_bbox() {
        let (doc, page) = path_doc(
            "0 0 0 rg 0 0 5 5 re f BT /F1 12 Tf (a) Tj ET 1 0 0 rg 0 0 m 10 0 l 5 9 l h f 0 0 5 5 re f",
        );
        let c = find_cover_candidates(&doc, page);
        // 文字より前の `re f` (通し番号 0) と、矩形だけの塗り (通し番号 2) は対象外。三角形 (通し番号 1) だけ
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].key, CoverKey::Op(StreamKey::Page(page), 1));
        assert_eq!(c[0].bbox, Some([-1.0, -1.0, 11.0, 10.0]));
    }

    #[test]
    fn path_cover_is_kept_in_text_only_and_dropped_in_remove_text() {
        let body = "BT /F1 12 Tf (a) Tj ET 1 0 0 rg 0 0 m 10 0 l 5 9 l h f 0 1 0 rg 20 20 5 5 re f";
        let (doc, page) = path_doc(body);
        let covers = Covers::from_keys([CoverKey::Op(StreamKey::Page(page), 0)]);
        // TextOnly: 文字と、覆いの塗りだけが残る (もう一方の `re f` は捨てる)
        let mut a = doc.clone();
        transform_covers(&mut a, Mode::TextOnly, &covers).unwrap();
        let t = page_text(&a, page);
        assert!(t.contains("Tj"), "{t}");
        assert!(t.lines().any(|l| l.trim() == "f"), "{t}");
        assert!(t.contains("5 9 l"), "{t}");
        assert!(!t.contains("20 20"), "{t}");
        // RemoveText: 文字と覆いの塗りが除かれ、覆いでない塗りは残る
        let mut b = doc.clone();
        transform_covers(&mut b, Mode::RemoveText, &covers).unwrap();
        let t = page_text(&b, page);
        assert!(!t.contains("Tj"), "{t}");
        assert_eq!(t.lines().filter(|l| l.trim() == "f").count(), 1, "{t}");
        assert!(t.lines().any(|l| l.trim() == "n"), "{t}");
        assert!(t.contains("20"), "{t}");
    }

    #[test]
    fn cover_is_kept_in_text_only_and_dropped_in_remove_text() {
        let (mut doc, page) = cover_doc(
            "1 0 0 rg 0 0 50 50 re f",
            "BT /F1 12 Tf (a) Tj ET q /G1 gs /Fm1 Do Q",
        );
        let covers = Covers {
            objs: find_cover_forms(&doc, page).into_iter().collect(),
            ..Default::default()
        };
        assert_eq!(covers.len(), 1);
        let mut a = doc.clone();
        transform_covers(&mut a, Mode::RemoveText, &covers).unwrap();
        let sid = a.get_page_contents(page)[0];
        let Ok(Object::Stream(st)) = a.get_object(sid) else { panic!() };
        let txt = String::from_utf8_lossy(&st.content).to_string();
        assert!(!txt.contains("Do"), "{txt}");
        assert!(!txt.contains("Tj"), "{txt}");
        transform_covers(&mut doc, Mode::TextOnly, &covers).unwrap();
        let sid = doc.get_page_contents(page)[0];
        let Ok(Object::Stream(st)) = doc.get_object(sid) else { panic!() };
        let txt = String::from_utf8_lossy(&st.content).to_string();
        assert!(txt.contains("Do") && txt.contains("Tj"), "{txt}");
        // 覆いの中身は加工されない (塗りが残る)
        let fid = *covers.objs.iter().next().unwrap();
        let Ok(Object::Stream(f)) = doc.get_object(fid) else { panic!() };
        assert!(String::from_utf8_lossy(&f.content).contains(" f"));
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
        let ops = Content::decode_strict(&out).unwrap().operations;
        let names: Vec<&str> = ops.iter().map(|o| o.operator.as_str()).collect();
        for gone in ["f", "S", "b*", "sh"] {
            assert!(!names.contains(&gone), "{gone} remains: {names:?}");
        }
        // クリップ (re W n)・状態・テキスト・Form の Do は残る
        for keep in ["q", "Q", "W", "n", "rg", "RG", "w", "BT", "ET", "Tf", "Tj", "Do"] {
            assert!(names.contains(&keep), "{keep} missing: {names:?}");
        }
        assert_eq!(names.iter().filter(|n| **n == "Do").count(), 1); // Fm1 だけ
        // クリップに使うパス (re W n) だけが残り、塗り・線のパスは座標ごと消える
        assert_eq!(names.iter().filter(|n| **n == "n").count(), 1);
        assert_eq!(names.iter().filter(|n| **n == "re").count(), 1);
        assert!(!names.contains(&"m") && !names.contains(&"l"));
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
            dictionary! {"Type"=>"XObject","Subtype"=>"Form","BBox"=>vec![Object::Integer(0),Object::Integer(0),Object::Integer(100),Object::Integer(100)],
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
                    // 塗りも、そのパスの座標 (re) も消えている (クリップに使われていないため)
                    assert!(!t.contains(" re"), "path remains: {t}");
                    assert!(!t.contains(" f\n") && !t.ends_with(" f"), "fill remains: {t}");
                }
            }
        }
        assert!(saw_pattern, "tiling pattern must stay untouched");
    }
    /// lopdf の encode はリテラル文字列中の LF をそのまま書く。行単位で読む処理が文字列を
    /// 割らないよう、LF / CR を含む文字列は 16 進文字列で書き出し、値は変わらないこと。
    #[test]
    fn encode_eol_safe_hexes_strings_with_line_breaks() {
        let ops = vec![
            Operation::new(
                "Tj",
                vec![Object::String(vec![0x0a, 0x24], lopdf::StringFormat::Literal)],
            ),
            Operation::new(
                "TJ",
                vec![Object::Array(vec![
                    Object::String(b"ab".to_vec(), lopdf::StringFormat::Literal),
                    Object::Integer(-10),
                    Object::String(vec![0x0d, 0x41], lopdf::StringFormat::Literal),
                ])],
            ),
            Operation::new(
                "Tj",
                vec![Object::String(b"plain (ok)".to_vec(), lopdf::StringFormat::Literal)],
            ),
        ];
        let out = encode_content_eol_safe(&Content { operations: ops }).unwrap();
        // 文字列の外側以外に生の LF が現れるのは演算子の区切りだけ。括弧の中には無い。
        let text = String::from_utf8_lossy(&out).to_string();
        for line in text.lines() {
            let opens = line.matches('(').count();
            let closes = line.matches(')').count();
            assert_eq!(opens, closes, "unbalanced parentheses in line: {line:?}");
        }
        let back = Content::decode_strict(&out).unwrap().operations;
        assert_eq!(back.len(), 3);
        assert_eq!(
            back[0].operands[0].as_str().unwrap(),
            &[0x0a, 0x24][..]
        );
        match &back[1].operands[0] {
            Object::Array(a) => {
                assert_eq!(a[2].as_str().unwrap(), &[0x0d, 0x41][..]);
            }
            o => panic!("unexpected {o:?}"),
        }
        assert_eq!(back[2].operands[0].as_str().unwrap(), b"plain (ok)");
    }
}
