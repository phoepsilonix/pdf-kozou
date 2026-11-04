// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/font_usage.rs
// フォントのサブセット化 (lopdf 実装) の前段: どの埋め込みフォントの、どの CID が使われているかを
// 文書全体から集める。
//
// サブセット化できるのは、次をすべて満たす「CID フォント」だけ (それ以外は `unsupported` に理由を
// 挙げる。MuPDF なら縮めるはずのものなので、呼び出し側は MuPDF へフォールバックする):
//   - Type0 フォントで、/Encoding が Identity-H / Identity-V (文字コード = CID、2 バイト)
//   - 子孫が 1 つで、間接参照の CIDFontType2 (TrueType のアウトライン)
//   - /FontDescriptor の /FontFile2 が、TrueType (sfnt マジック 00010000 / true) のストリーム
//     (OTTO = CFF、ttcf = コレクションは対象外)
//   - /CIDToGIDMap が Identity (または省略)、またはストリーム
//   - FontFile2・FontDescriptor・CIDFont が、このフォントからしか参照されていない
//     (共有していると、別のフォントの文字が消える)
//
// 使われている CID は、ページ・Form XObject・タイリングパターンの内容ストリームから、
// Tf で選んだフォントに対する Tj / TJ / ' / " の文字列 (2 バイトずつ) として集める。
// 描画状態 (q/Q) を追跡し、Form XObject には呼び出し時点のフォントを引き継ぐ。
// 不可視の文字 (Tr 3) も数える (検索・コピー用の OCR 文字層が使う)。
//
// 使われ方を確実に知れないフォントは、サブセット化の対象にしない (unsupported):
//   - 文字列の長さが奇数 (コードの区切りを決められない)
//   - AcroForm の /DR に載っているフォント (フォームの入力で、新しい文字が使われる)
//   - ExtGState の /Font で選ばれるフォント (Tf を経由しない)
//   - 内容ストリームを読めない・解析できない、/Resources の無い注釈の外観ストリームがある、
//     Type3 フォントの文字定義がフォントを使う、入れ子が深すぎる (文書全体を諦める)

use crate::content_filter::for_each_operation;
use crate::image_recompress::{content_stream_bytes, stream_bytes};
use crate::resource_prune::{dict_of, has_resourceless_annot_ap, lookup, page_resources};
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::collections::{BTreeSet, HashMap, HashSet};

/// CID から、フォントプログラム内のグリフ番号への対応
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CidToGid {
    /// CID = グリフ番号
    Identity,
    /// `map[cid]` がグリフ番号 (範囲外は 0 = .notdef)
    Map(Vec<u16>),
}

impl CidToGid {
    pub(crate) fn gid(&self, cid: u16) -> u16 {
        match self {
            CidToGid::Identity => cid,
            CidToGid::Map(m) => m.get(cid as usize).copied().unwrap_or(0),
        }
    }
}

/// サブセット化できる CID フォント 1 つ分
#[derive(Clone, Debug)]
pub(crate) struct CidFontInfo {
    /// /FontFile2 のストリーム
    pub font_file: ObjectId,
    /// 子孫の CIDFontType2 辞書 (/CIDToGIDMap を持つ)
    pub cid_font: ObjectId,
    pub cid_to_gid: CidToGid,
}

/// サブセット化の対象と、使われている CID
#[derive(Debug)]
pub(crate) struct CidFontUsage {
    pub info: CidFontInfo,
    pub cids: BTreeSet<u16>,
}

#[derive(Debug, Default)]
pub(crate) struct FontAnalysis {
    /// サブセット化してよいフォント (使われている CID が分かったもの)
    pub usable: Vec<CidFontUsage>,
    /// サブセット化できない埋め込みフォントの理由。ひとつでもあれば、呼び出し側は
    /// MuPDF にフォールバックする (MuPDF なら縮めるフォントを、残さないため)
    pub unsupported: Vec<String>,
}

// ---------------------------------------------------------------------
// 参照数・埋め込みフォントの列挙
// ---------------------------------------------------------------------

/// `o` の中 (配列・辞書・ストリーム辞書) の、すべての参照先の個数を数える
fn count_refs(o: &Object, counts: &mut HashMap<ObjectId, usize>) {
    match o {
        Object::Reference(id) => *counts.entry(*id).or_insert(0) += 1,
        Object::Array(a) => a.iter().for_each(|x| count_refs(x, counts)),
        Object::Dictionary(d) => d.iter().for_each(|(_, v)| count_refs(v, counts)),
        Object::Stream(s) => s.dict.iter().for_each(|(_, v)| count_refs(v, counts)),
        _ => {}
    }
}

fn ref_counts(doc: &Document) -> HashMap<ObjectId, usize> {
    let mut counts = HashMap::new();
    for o in doc.objects.values() {
        count_refs(o, &mut counts);
    }
    for (_, v) in doc.trailer.iter() {
        count_refs(v, &mut counts);
    }
    counts
}

/// `o` の中に現れる辞書を順にたどる (入れ子の直接辞書も含む)
fn for_each_dict(o: &Object, f: &mut dyn FnMut(&Dictionary)) {
    match o {
        Object::Dictionary(d) => {
            f(d);
            d.iter().for_each(|(_, v)| for_each_dict(v, f));
        }
        Object::Stream(s) => {
            f(&s.dict);
            s.dict.iter().for_each(|(_, v)| for_each_dict(v, f));
        }
        Object::Array(a) => a.iter().for_each(|x| for_each_dict(x, f)),
        _ => {}
    }
}

/// 文書内の、埋め込みフォントプログラム (/FontFile /FontFile2 /FontFile3) のストリーム
fn embedded_font_files(doc: &Document) -> HashMap<ObjectId, &'static str> {
    let mut out = HashMap::new();
    for o in doc.objects.values() {
        for_each_dict(o, &mut |d| {
            for key in ["FontFile", "FontFile2", "FontFile3"] {
                if let Ok(Object::Reference(id)) = d.get(key.as_bytes()) {
                    out.insert(*id, key);
                }
            }
        });
    }
    out
}

fn name_of<'a>(d: &'a Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    d.get(key).ok().and_then(|o| o.as_name().ok())
}

// ---------------------------------------------------------------------
// フォントの適格性
// ---------------------------------------------------------------------

/// サブセット化できる CID フォントか。できなければ (フォントファイルがあればその ID, 理由)。
fn cid_font_info(
    doc: &Document,
    type0: &Dictionary,
    refs: &HashMap<ObjectId, usize>,
) -> Result<CidFontInfo, (Option<ObjectId>, String)> {
    let no_file = |why: &str| (None, why.to_string());
    if name_of(type0, b"Subtype") != Some(b"Type0") {
        return Err(no_file("not a Type0 font"));
    }
    // 子孫と、そのフォントファイル (理由にファイルを添えるため、先に探す)
    let descendants = type0
        .get(b"DescendantFonts")
        .ok()
        .and_then(|d| doc.dereference(d).ok().map(|(_, o)| o.clone()));
    let Some(Object::Array(descendants)) = descendants else {
        return Err(no_file("no DescendantFonts"));
    };
    let [Object::Reference(cid_id)] = descendants.as_slice() else {
        return Err(no_file("DescendantFonts is not a single indirect CIDFont"));
    };
    let cid_id = *cid_id;
    let Ok(Object::Dictionary(cid)) = doc.get_object(cid_id) else {
        return Err(no_file("CIDFont is not a dictionary"));
    };
    let desc_obj = cid.get(b"FontDescriptor").ok().cloned();
    let (desc_id, desc) = match &desc_obj {
        Some(Object::Reference(id)) => (Some(*id), dict_of(doc, &Object::Reference(*id))),
        Some(Object::Dictionary(d)) => (None, Some(d.clone())),
        _ => (None, None),
    };
    let Some(desc) = desc else {
        return Err(no_file("no FontDescriptor"));
    };
    let Some(Object::Reference(ff)) = desc.get(b"FontFile2").ok().cloned() else {
        // FontFile2 が無い。FontFile3 (CFF) があれば、そのファイルが対象外の理由になる
        let file3 = match desc.get(b"FontFile3") {
            Ok(Object::Reference(id)) => Some(*id),
            _ => None,
        };
        return Err((
            file3,
            "CID font has no FontFile2 (CFF / not embedded)".to_string(),
        ));
    };
    let fail = |why: &str| (Some(ff), why.to_string());

    if name_of(type0, b"Encoding").is_none_or(|e| e != b"Identity-H" && e != b"Identity-V") {
        return Err(fail("Encoding is not Identity-H / Identity-V"));
    }
    if name_of(cid, b"Subtype") != Some(b"CIDFontType2") {
        return Err(fail("descendant is not a CIDFontType2"));
    }
    if desc.has(b"FontFile") || desc.has(b"FontFile3") {
        return Err(fail("FontDescriptor has several font files"));
    }
    // このフォントだけが使っているか
    if refs.get(&cid_id).copied().unwrap_or(0) != 1 {
        return Err(fail("CIDFont is shared"));
    }
    if desc_id.is_some_and(|id| refs.get(&id).copied().unwrap_or(0) != 1) {
        return Err(fail("FontDescriptor is shared"));
    }
    if refs.get(&ff).copied().unwrap_or(0) != 1 {
        return Err(fail("FontFile2 is shared"));
    }
    // TrueType のアウトラインか
    let Ok(Object::Stream(file)) = doc.get_object(ff) else {
        return Err(fail("FontFile2 is not a stream"));
    };
    let Ok(data) = stream_bytes(file) else {
        return Err(fail("FontFile2 cannot be decoded"));
    };
    match data.get(..4) {
        Some([0, 1, 0, 0]) | Some(b"true") => {}
        Some(b"OTTO") => return Err(fail("OpenType with CFF outlines")),
        Some(b"ttcf") => return Err(fail("TrueType collection")),
        _ => return Err(fail("not a TrueType font program")),
    }
    // CID → グリフ番号
    let cid_to_gid = match cid.get(b"CIDToGIDMap") {
        Err(_) => CidToGid::Identity,
        Ok(Object::Name(n)) if n == b"Identity" => CidToGid::Identity,
        Ok(o) => match doc.dereference(o) {
            Ok((_, Object::Stream(s))) => {
                let Ok(bytes) = stream_bytes(s) else {
                    return Err(fail("CIDToGIDMap cannot be decoded"));
                };
                if bytes.len() % 2 != 0 {
                    return Err(fail("CIDToGIDMap has an odd length"));
                }
                CidToGid::Map(
                    bytes
                        .chunks_exact(2)
                        .map(|c| u16::from_be_bytes([c[0], c[1]]))
                        .collect(),
                )
            }
            _ => return Err(fail("unsupported CIDToGIDMap")),
        },
    };
    Ok(CidFontInfo {
        font_file: ff,
        cid_font: cid_id,
        cid_to_gid,
    })
}

// ---------------------------------------------------------------------
// 使用 CID の収集
// ---------------------------------------------------------------------

/// いま選ばれているフォント
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Cur {
    /// 選ばれていない
    None,
    /// サブセット化の対象でないフォント
    Other,
    /// 対象のフォント (FontFile2 の ID)
    Cid(ObjectId),
}

struct Collector<'a> {
    doc: &'a Document,
    refs: &'a HashMap<ObjectId, usize>,
    /// Type0 フォント辞書の ID → 適格性 (フォントファイルを何度も読まないため)
    cache: HashMap<ObjectId, Result<CidFontInfo, (Option<ObjectId>, String)>>,
    /// 見つけた適格なフォント (FontFile2 の ID → 情報)
    infos: HashMap<ObjectId, CidFontInfo>,
    /// 適格でない理由 (FontFile の ID → 理由)
    reasons: HashMap<ObjectId, String>,
    cids: HashMap<ObjectId, BTreeSet<u16>>,
    /// 使われ方を確実に知れないフォント (FontFile2 の ID → 理由)
    unsafe_files: HashMap<ObjectId, String>,
    /// 文書全体を諦める理由
    give_up: Option<String>,
    /// 走査済みの (Form の ID, 呼び出し時のフォント)
    done: HashSet<(ObjectId, Cur)>,
}

impl Collector<'_> {
    /// フォント辞書 (`id` は間接参照ならその ID) の適格性
    fn classify(&mut self, id: Option<ObjectId>, dict: &Dictionary) -> Cur {
        if name_of(dict, b"Subtype") != Some(b"Type0") {
            return Cur::Other;
        }
        let result = match id {
            Some(id) => {
                if !self.cache.contains_key(&id) {
                    let r = cid_font_info(self.doc, dict, self.refs);
                    self.cache.insert(id, r);
                }
                self.cache[&id].clone()
            }
            None => cid_font_info(self.doc, dict, self.refs),
        };
        match result {
            Ok(info) => {
                let ff = info.font_file;
                self.infos.insert(ff, info);
                Cur::Cid(ff)
            }
            Err((file, why)) => {
                if let Some(f) = file {
                    self.reasons.entry(f).or_insert(why);
                }
                Cur::Other
            }
        }
    }

    fn mark_unsafe(&mut self, font: Cur, why: &str) {
        if let Cur::Cid(ff) = font {
            self.unsafe_files
                .entry(ff)
                .or_insert_with(|| why.to_string());
        }
    }

    fn show(&mut self, cur: Cur, s: &[u8]) {
        let Cur::Cid(ff) = cur else { return };
        if s.len() % 2 != 0 {
            self.mark_unsafe(cur, "a shown string has an odd length");
            return;
        }
        let set = self.cids.entry(ff).or_default();
        for c in s.chunks_exact(2) {
            set.insert(u16::from_be_bytes([c[0], c[1]]));
        }
    }

    /// 内容 `bytes` (リソースは `resources`) を調べる。`cur` は呼び出し時点のフォント。
    fn scan(&mut self, bytes: &[u8], resources: &Dictionary, cur: Cur, depth: u32) {
        if self.give_up.is_some() {
            return;
        }
        if depth > 12 {
            self.give_up = Some("Form XObjects are nested too deeply".into());
            return;
        }
        let mut cur = cur;
        let mut stack: Vec<Cur> = Vec::new();
        let result = for_each_operation(bytes, |op| {
            let args = &op.operands;
            match op.operator.as_str() {
                "q" => stack.push(cur),
                "Q" => {
                    if let Some(c) = stack.pop() {
                        cur = c;
                    }
                }
                "Tf" => {
                    cur = match args.first() {
                        Some(Object::Name(n)) => match lookup(self.doc, resources, b"Font", n) {
                            Some((id, d, false)) => self.classify(id, &d),
                            _ => Cur::Other,
                        },
                        _ => Cur::Other,
                    };
                }
                "Tj" | "'" => {
                    if let Some(Object::String(s, _)) = args.first() {
                        self.show(cur, s);
                    }
                }
                "\"" => {
                    if let Some(Object::String(s, _)) = args.get(2) {
                        self.show(cur, s);
                    }
                }
                "TJ" => {
                    if let Some(Object::Array(a)) = args.first() {
                        for item in a {
                            if let Object::String(s, _) = item {
                                self.show(cur, s);
                            }
                        }
                    }
                }
                "gs" => {
                    // ExtGState の /Font は、Tf を経由せずフォントを選ぶ
                    if let Some(Object::Name(n)) = args.first() {
                        if let Some((_, d, _)) = lookup(self.doc, resources, b"ExtGState", n) {
                            if let Ok(Object::Array(a)) = d.get(b"Font") {
                                if let Some(Object::Reference(fid)) = a.first() {
                                    if let Some(fd) = dict_of(self.doc, &Object::Reference(*fid)) {
                                        let c = self.classify(Some(*fid), &fd);
                                        self.mark_unsafe(c, "selected by an ExtGState /Font");
                                    }
                                }
                            }
                        }
                    }
                }
                "Do" => {
                    let Some(Object::Name(n)) = args.first() else {
                        return;
                    };
                    let Some((Some(id), d, true)) = lookup(self.doc, resources, b"XObject", n)
                    else {
                        return;
                    };
                    if name_of(&d, b"Subtype") != Some(b"Form") {
                        return;
                    }
                    let own = d.get(b"Resources").ok().and_then(|r| dict_of(self.doc, r));
                    // 自前のリソースを持つ Form は、(Form, フォント) の組ごとに 1 回だけ調べる
                    if own.is_some() && !self.done.insert((id, cur)) {
                        return;
                    }
                    let Some(Object::Stream(s)) = self.doc.objects.get(&id) else {
                        return;
                    };
                    match content_stream_bytes(s) {
                        Ok(inner) => {
                            let res = own.unwrap_or_else(|| resources.clone());
                            self.scan(&inner, &res, cur, depth + 1);
                        }
                        Err(e) => self.give_up = Some(format!("Form {id:?}: {e}")),
                    }
                }
                _ => {}
            }
        });
        if let Err(e) = result {
            self.give_up = Some(format!("content stream: {e}"));
        }
    }
}

/// ページの内容 (配列なら連結)。読めなければ Err
fn page_bytes(doc: &Document, page_id: ObjectId) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    for id in doc.get_page_contents(page_id) {
        if let Ok(Object::Stream(s)) = doc.get_object(id) {
            bytes.extend(content_stream_bytes(s).map_err(|e| format!("page {page_id:?}: {e}"))?);
            bytes.push(b'\n');
        }
    }
    Ok(bytes)
}

/// 文書のフォントを調べ、サブセット化してよい CID フォントと使用 CID、
/// サブセット化できない埋め込みフォントの理由を返す。
pub(crate) fn analyze_fonts(doc: &Document) -> FontAnalysis {
    let refs = ref_counts(doc);
    let embedded = embedded_font_files(doc);
    let mut c = Collector {
        doc,
        refs: &refs,
        cache: HashMap::new(),
        infos: HashMap::new(),
        reasons: HashMap::new(),
        cids: HashMap::new(),
        unsafe_files: HashMap::new(),
        give_up: None,
        done: HashSet::new(),
    };

    // すべての Type0 フォントの適格性 (使われていないフォントも、unsupported かどうかを決めるため)
    let type0s: Vec<(ObjectId, Dictionary)> = doc
        .objects
        .iter()
        .filter_map(|(id, o)| match o {
            Object::Dictionary(d) if name_of(d, b"Subtype") == Some(b"Type0") => {
                Some((*id, d.clone()))
            }
            _ => None,
        })
        .collect();
    for (id, d) in &type0s {
        c.classify(Some(*id), d);
    }

    // AcroForm の /DR のフォント: フォームの入力で、新しい文字が使われうる
    let acro = doc
        .catalog()
        .ok()
        .and_then(|cat| cat.get(b"AcroForm").ok())
        .and_then(|a| dict_of(doc, a));
    if let Some(dr_fonts) = acro
        .and_then(|a| a.get(b"DR").ok().and_then(|d| dict_of(doc, d)))
        .and_then(|dr| dr.get(b"Font").ok().and_then(|f| dict_of(doc, f)))
    {
        for (_, v) in dr_fonts.iter() {
            if let (Object::Reference(id), Some(fd)) = (v, dict_of(doc, v)) {
                let cur = c.classify(Some(*id), &fd);
                c.mark_unsafe(cur, "listed in the AcroForm /DR");
            }
        }
    }

    // Type3 の文字定義がフォントを使う
    for o in doc.objects.values() {
        if let Object::Dictionary(d) = o {
            if name_of(d, b"Subtype") == Some(b"Type3") {
                let procs = d.get(b"CharProcs").ok().and_then(|p| dict_of(doc, p));
                for (_, v) in procs.iter().flat_map(|p| p.iter()) {
                    if let Ok((_, Object::Stream(s))) = doc.dereference(v) {
                        let mut uses_font = false;
                        let ok = content_stream_bytes(s)
                            .and_then(|b| {
                                for_each_operation(&b, |op| uses_font |= op.operator == "Tf")
                            })
                            .is_ok();
                        if !ok || uses_font {
                            c.give_up = Some("a Type3 glyph description uses a font".into());
                        }
                    }
                }
            }
        }
    }

    // ページ
    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    for page_id in pages {
        if has_resourceless_annot_ap(doc, page_id) {
            c.give_up = Some("an annotation appearance stream has no /Resources".into());
            break;
        }
        match page_bytes(doc, page_id) {
            Ok(bytes) => {
                let res = page_resources(doc, page_id).unwrap_or_default();
                c.scan(&bytes, &res, Cur::None, 0);
            }
            Err(e) => c.give_up = Some(e),
        }
        if c.give_up.is_some() {
            break;
        }
    }

    // 自前のリソースを持つ Form XObject・タイリングパターン (ページから Do されなくても)
    let owners: Vec<(ObjectId, Dictionary)> = doc
        .objects
        .iter()
        .filter_map(|(id, o)| match o {
            Object::Stream(s) if s.dict.has(b"Resources") => {
                let form = name_of(&s.dict, b"Subtype") == Some(b"Form");
                let tiling = matches!(s.dict.get(b"PatternType"), Ok(Object::Integer(1)));
                (form || tiling).then(|| (*id, s.dict.clone()))
            }
            _ => None,
        })
        .collect();
    for (id, d) in owners {
        if c.give_up.is_some() {
            break;
        }
        if !c.done.insert((id, Cur::None)) {
            continue;
        }
        let Some(Object::Stream(s)) = doc.objects.get(&id) else {
            continue;
        };
        match content_stream_bytes(s) {
            Ok(bytes) => {
                let res = d.get(b"Resources").ok().and_then(|r| dict_of(doc, r));
                c.scan(&bytes, &res.unwrap_or_default(), Cur::None, 0);
            }
            Err(e) => c.give_up = Some(format!("stream {id:?}: {e}")),
        }
    }

    // まとめ
    let mut out = FontAnalysis::default();
    if let Some(why) = c.give_up.take() {
        out.unsupported.push(why);
        return out;
    }
    let mut files: Vec<ObjectId> = embedded.keys().copied().collect();
    files.sort();
    for ff in files {
        let key = embedded[&ff];
        match c.infos.get(&ff) {
            Some(info) => {
                if let Some(why) = c.unsafe_files.get(&ff) {
                    out.unsupported
                        .push(format!("{key} {ff:?}: usage cannot be determined ({why})"));
                } else if let Some(cids) = c.cids.get(&ff).filter(|s| !s.is_empty()) {
                    out.usable.push(CidFontUsage {
                        info: info.clone(),
                        cids: cids.clone(),
                    });
                }
                // 使われていない CID フォントは、そのままにする
            }
            None => {
                let why = c
                    .reasons
                    .get(&ff)
                    .cloned()
                    .unwrap_or_else(|| "not a Type0 / CIDFontType2 font".into());
                out.unsupported.push(format!("{key} {ff:?}: {why}"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{Stream, StringFormat, dictionary};

    /// TrueType 風のバイト列 (マジックだけ。解析では中身を読まない)
    fn ttf_stub() -> Vec<u8> {
        let mut v = vec![0, 1, 0, 0];
        v.extend([0u8; 60]);
        v
    }

    struct Font {
        type0: ObjectId,
        file: ObjectId,
        cid_font: ObjectId,
    }

    /// Type0 / CIDFontType2 のフォント。`encoding` と `magic` (フォントファイルの先頭 4 バイト)、
    /// `cid_to_gid` を変えて、適格でないフォントも作れる。
    fn cid_font(
        doc: &mut Document,
        encoding: Object,
        magic: [u8; 4],
        cid_to_gid: Option<Object>,
    ) -> Font {
        let mut data = ttf_stub();
        data[..4].copy_from_slice(&magic);
        let file = doc.add_object(Stream::new(dictionary! {}, data));
        let desc = doc
            .add_object(dictionary! {"Type"=>"FontDescriptor","FontName"=>"X","FontFile2"=>file});
        let mut cf = dictionary! {"Type"=>"Font","Subtype"=>"CIDFontType2","BaseFont"=>"X","FontDescriptor"=>desc};
        if let Some(m) = cid_to_gid {
            cf.set("CIDToGIDMap", m);
        }
        let cid_font = doc.add_object(cf);
        let type0 = doc.add_object(
            dictionary! {"Type"=>"Font","Subtype"=>"Type0","BaseFont"=>"X",
            "Encoding"=>encoding,"DescendantFonts"=>vec![cid_font.into()]},
        );
        Font {
            type0,
            file,
            cid_font,
        }
    }

    fn good_font(doc: &mut Document) -> Font {
        cid_font(doc, "Identity-H".into(), [0, 1, 0, 0], None)
    }

    /// ページを持つ文書。`res` は /Resources、`content` は内容 (Tj の文字列は 16 進で書く)
    fn doc_with_page(doc: &mut Document, res: Dictionary, content: &str) -> ObjectId {
        let pages_id = doc.new_object_id();
        let c = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
        let page = doc.add_object(dictionary! {
            "Type"=>"Page","Parent"=>pages_id,
            "MediaBox"=>vec![0.into(),0.into(),100.into(),100.into()],
            "Resources"=>res,"Contents"=>c,
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1}),
        );
        let cat = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages_id});
        doc.trailer.set("Root", cat);
        page
    }

    fn cids(a: &FontAnalysis, file: ObjectId) -> Vec<u16> {
        a.usable
            .iter()
            .find(|u| u.info.font_file == file)
            .map(|u| u.cids.iter().copied().collect())
            .unwrap_or_default()
    }

    #[test]
    fn collects_cids_from_all_text_showing_operators() {
        let mut doc = Document::with_version("1.5");
        let f = good_font(&mut doc);
        let res = dictionary! {"Font"=>dictionary!{"F1"=>f.type0}};
        doc_with_page(
            &mut doc,
            res,
            "BT /F1 12 Tf <00410042> Tj [<0043> -20 <0044>] TJ <0045> ' 1 2 <0046> \" ET",
        );
        let a = analyze_fonts(&doc);
        assert!(a.unsupported.is_empty(), "{:?}", a.unsupported);
        assert_eq!(cids(&a, f.file), [0x41, 0x42, 0x43, 0x44, 0x45, 0x46]);
        assert_eq!(a.usable[0].info.cid_font, f.cid_font);
        assert_eq!(a.usable[0].info.cid_to_gid, CidToGid::Identity);
    }

    #[test]
    fn invisible_text_counts_and_q_restores_the_font() {
        let mut doc = Document::with_version("1.5");
        let (f1, f2) = (good_font(&mut doc), good_font(&mut doc));
        let res = dictionary! {"Font"=>dictionary!{"F1"=>f1.type0,"F2"=>f2.type0}};
        doc_with_page(
            &mut doc,
            res,
            "BT /F1 12 Tf 3 Tr <0001> Tj q /F2 12 Tf <0002> Tj Q <0003> Tj ET",
        );
        let a = analyze_fonts(&doc);
        assert!(a.unsupported.is_empty(), "{:?}", a.unsupported);
        // Q で F1 に戻る: 0003 は F1 の文字
        assert_eq!(cids(&a, f1.file), [1, 3]);
        assert_eq!(cids(&a, f2.file), [2]);
    }

    #[test]
    fn forms_inherit_the_current_font() {
        let mut doc = Document::with_version("1.5");
        let (f1, f2) = (good_font(&mut doc), good_font(&mut doc));
        // Tf を持たない Form は、呼び出し時のフォントで文字を描く (自前のリソースなし)
        let inherit = doc.add_object(Stream::new(
            dictionary! {"Type"=>"XObject","Subtype"=>"Form","BBox"=>vec![0.into(),0.into(),1.into(),1.into()]},
            b"BT <0010> Tj ET".to_vec(),
        ));
        // 自前のリソースと Tf を持つ Form
        let own = doc.add_object(Stream::new(
            dictionary! {"Type"=>"XObject","Subtype"=>"Form","BBox"=>vec![0.into(),0.into(),1.into(),1.into()],
                "Resources"=>dictionary!{"Font"=>dictionary!{"G"=>f2.type0}}},
            b"BT /G 9 Tf <0020> Tj ET".to_vec(),
        ));
        // 自前のリソースだけを持ち、Tf を持たない Form: 呼び出し時のフォントを引き継ぐ
        let own_no_tf = doc.add_object(Stream::new(
            dictionary! {"Type"=>"XObject","Subtype"=>"Form","BBox"=>vec![0.into(),0.into(),1.into(),1.into()],
                "Resources"=>dictionary!{}},
            b"BT <0030> Tj ET".to_vec(),
        ));
        let res = dictionary! {
            "Font"=>dictionary!{"F1"=>f1.type0},
            "XObject"=>dictionary!{"Fi"=>inherit,"Fo"=>own,"Fn"=>own_no_tf},
        };
        doc_with_page(&mut doc, res, "BT /F1 12 Tf ET /Fi Do /Fo Do /Fn Do");
        // Do の前に Tf を実行する (BT ET の外でもテキスト状態は残る)
        let a = analyze_fonts(&doc);
        assert!(a.unsupported.is_empty(), "{:?}", a.unsupported);
        assert_eq!(cids(&a, f1.file), [0x10, 0x30]);
        assert_eq!(cids(&a, f2.file), [0x20]);
    }

    #[test]
    fn cid_to_gid_stream_is_read() {
        let mut doc = Document::with_version("1.5");
        let map = doc.add_object(Stream::new(
            dictionary! {},
            vec![0, 0, 0, 5, 0, 9], // CID0→0, CID1→5, CID2→9
        ));
        let f = cid_font(&mut doc, "Identity-V".into(), *b"true", Some(map.into()));
        let res = dictionary! {"Font"=>dictionary!{"F1"=>f.type0}};
        doc_with_page(&mut doc, res, "BT /F1 12 Tf <0001> Tj ET");
        let a = analyze_fonts(&doc);
        assert!(a.unsupported.is_empty(), "{:?}", a.unsupported);
        let g = &a.usable[0].info.cid_to_gid;
        assert_eq!((g.gid(1), g.gid(2), g.gid(99)), (5, 9, 0));
        assert_eq!(CidToGid::Identity.gid(77), 77);
    }

    /// 対象外のフォントは unsupported に理由を挙げる (MuPDF へフォールバックさせる)
    fn unsupported_for(build: impl FnOnce(&mut Document) -> Object) -> Vec<String> {
        let mut doc = Document::with_version("1.5");
        let font = build(&mut doc);
        let res = dictionary! {"Font"=>dictionary!{"F1"=>font}};
        doc_with_page(&mut doc, res, "BT /F1 12 Tf <0001> Tj ET");
        let a = analyze_fonts(&doc);
        assert!(a.usable.is_empty(), "{:?}", a.usable);
        a.unsupported
    }

    #[test]
    fn ineligible_fonts_are_reported() {
        // Identity 以外の Encoding
        let r = unsupported_for(|d| {
            cid_font(d, "UniJIS-UCS2-H".into(), [0, 1, 0, 0], None)
                .type0
                .into()
        });
        assert!(r[0].contains("Identity-H"), "{r:?}");
        // CFF のアウトライン (OTTO) / コレクション / 不明
        for (magic, word) in [
            (*b"OTTO", "CFF"),
            (*b"ttcf", "collection"),
            (*b"abcd", "not a TrueType"),
        ] {
            let r = unsupported_for(|d| cid_font(d, "Identity-H".into(), magic, None).type0.into());
            assert!(r[0].contains(word), "{r:?}");
        }
        // CIDToGIDMap が Identity 以外の名前
        let r = unsupported_for(|d| {
            cid_font(d, "Identity-H".into(), [0, 1, 0, 0], Some("Other".into()))
                .type0
                .into()
        });
        assert!(r[0].contains("CIDToGIDMap"), "{r:?}");
        // CFF の CID フォント (FontFile3)
        let r = unsupported_for(|d| {
            let ff = d.add_object(Stream::new(
                dictionary! {"Subtype"=>"CIDFontType0C"},
                vec![1, 0, 4, 1],
            ));
            let desc = d.add_object(dictionary! {"Type"=>"FontDescriptor","FontFile3"=>ff});
            let cf = d.add_object(
                dictionary! {"Type"=>"Font","Subtype"=>"CIDFontType0","FontDescriptor"=>desc},
            );
            d.add_object(
                dictionary! {"Type"=>"Font","Subtype"=>"Type0","Encoding"=>"Identity-H",
                "DescendantFonts"=>vec![cf.into()]},
            )
            .into()
        });
        assert!(r[0].contains("FontFile3"), "{r:?}");
        // 単純フォントの TrueType
        let r = unsupported_for(|d| {
            let ff = d.add_object(Stream::new(dictionary! {}, ttf_stub()));
            let desc = d.add_object(dictionary! {"Type"=>"FontDescriptor","FontFile2"=>ff});
            d.add_object(dictionary! {"Type"=>"Font","Subtype"=>"TrueType","FontDescriptor"=>desc})
                .into()
        });
        assert!(r[0].contains("FontFile2"), "{r:?}");
    }

    #[test]
    fn shared_font_files_are_reported() {
        // 2 つの CIDFont が同じ FontDescriptor (したがって同じ FontFile2) を使う
        let mut doc = Document::with_version("1.5");
        let f = good_font(&mut doc);
        let desc = doc
            .get_object(f.cid_font)
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"FontDescriptor")
            .unwrap()
            .clone();
        let cf2 = doc.add_object(
            dictionary! {"Type"=>"Font","Subtype"=>"CIDFontType2","FontDescriptor"=>desc},
        );
        let t2 = doc.add_object(
            dictionary! {"Type"=>"Font","Subtype"=>"Type0","Encoding"=>"Identity-H",
            "DescendantFonts"=>vec![cf2.into()]},
        );
        let res = dictionary! {"Font"=>dictionary!{"F1"=>f.type0,"F2"=>t2}};
        doc_with_page(&mut doc, res, "BT /F1 12 Tf <0001> Tj ET");
        let a = analyze_fonts(&doc);
        assert!(a.usable.is_empty());
        assert!(a.unsupported[0].contains("shared"), "{:?}", a.unsupported);
    }

    #[test]
    fn a_shared_font_file_or_cid_font_is_reported_separately() {
        // 別々の FontDescriptor が同じ FontFile2 を指す
        let mut doc = Document::with_version("1.5");
        let f = good_font(&mut doc);
        let desc2 = doc.add_object(dictionary! {"Type"=>"FontDescriptor","FontFile2"=>f.file});
        let cf2 = doc.add_object(
            dictionary! {"Type"=>"Font","Subtype"=>"CIDFontType2","FontDescriptor"=>desc2},
        );
        let t2 = doc.add_object(
            dictionary! {"Type"=>"Font","Subtype"=>"Type0","Encoding"=>"Identity-H",
            "DescendantFonts"=>vec![cf2.into()]},
        );
        let res = dictionary! {"Font"=>dictionary!{"F1"=>f.type0,"F2"=>t2}};
        doc_with_page(&mut doc, res, "BT /F1 12 Tf <0001> Tj ET");
        let a = analyze_fonts(&doc);
        assert!(a.usable.is_empty());
        assert!(
            a.unsupported[0].contains("FontFile2 is shared"),
            "{:?}",
            a.unsupported
        );

        // 2 つの Type0 が同じ CIDFont を指す
        let mut doc = Document::with_version("1.5");
        let f = good_font(&mut doc);
        let t2 = doc.add_object(
            dictionary! {"Type"=>"Font","Subtype"=>"Type0","Encoding"=>"Identity-H",
            "DescendantFonts"=>vec![f.cid_font.into()]},
        );
        let res = dictionary! {"Font"=>dictionary!{"F1"=>f.type0,"F2"=>t2}};
        doc_with_page(&mut doc, res, "BT /F1 12 Tf <0001> Tj ET");
        let a = analyze_fonts(&doc);
        assert!(a.usable.is_empty());
        assert!(
            a.unsupported[0].contains("CIDFont is shared"),
            "{:?}",
            a.unsupported
        );
    }

    #[test]
    fn fonts_whose_usage_is_unknown_are_reported() {
        // 奇数バイトの文字列
        let mut doc = Document::with_version("1.5");
        let f = good_font(&mut doc);
        let res = dictionary! {"Font"=>dictionary!{"F1"=>f.type0}};
        doc_with_page(&mut doc, res, "BT /F1 12 Tf <000102> Tj ET");
        let a = analyze_fonts(&doc);
        assert!(
            a.usable.is_empty() && a.unsupported[0].contains("odd length"),
            "{a:?}"
        );

        // AcroForm の /DR に載っているフォント
        let mut doc = Document::with_version("1.5");
        let f = good_font(&mut doc);
        let res = dictionary! {"Font"=>dictionary!{"F1"=>f.type0}};
        doc_with_page(&mut doc, res, "BT /F1 12 Tf <0001> Tj ET");
        let cat = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        if let Ok(Object::Dictionary(c)) = doc.get_object_mut(cat) {
            c.set(
                "AcroForm",
                dictionary! {"DR"=>dictionary!{"Font"=>dictionary!{"Helv"=>f.type0}}},
            );
        }
        let a = analyze_fonts(&doc);
        assert!(
            a.usable.is_empty() && a.unsupported[0].contains("AcroForm"),
            "{a:?}"
        );

        // ExtGState の /Font
        let mut doc = Document::with_version("1.5");
        let f = good_font(&mut doc);
        let res = dictionary! {"Font"=>dictionary!{"F1"=>f.type0},
        "ExtGState"=>dictionary!{"G"=>dictionary!{"Font"=>vec![f.type0.into(),10.into()]}}};
        doc_with_page(&mut doc, res, "/G gs BT /F1 12 Tf <0001> Tj ET");
        let a = analyze_fonts(&doc);
        assert!(
            a.usable.is_empty() && a.unsupported[0].contains("ExtGState"),
            "{a:?}"
        );
    }

    #[test]
    fn whole_document_is_given_up_when_content_cannot_be_trusted() {
        // 読めない (解析できない) 内容
        let mut doc = Document::with_version("1.5");
        let f = good_font(&mut doc);
        let res = dictionary! {"Font"=>dictionary!{"F1"=>f.type0}};
        doc_with_page(&mut doc, res, "BT /F1 12 Tf <0001> Tj ET @@@");
        let a = analyze_fonts(&doc);
        assert!(a.usable.is_empty() && !a.unsupported.is_empty(), "{a:?}");

        // /Resources の無い注釈の外観ストリーム
        let mut doc = Document::with_version("1.5");
        let f = good_font(&mut doc);
        let ap = doc.add_object(Stream::new(
            dictionary! {"Type"=>"XObject","Subtype"=>"Form","BBox"=>vec![0.into(),0.into(),1.into(),1.into()]},
            b"q Q".to_vec(),
        ));
        let annot = doc.add_object(dictionary! {"Type"=>"Annot","Subtype"=>"Widget",
        "Rect"=>vec![0.into(),0.into(),1.into(),1.into()],"AP"=>dictionary!{"N"=>ap}});
        let res = dictionary! {"Font"=>dictionary!{"F1"=>f.type0}};
        let page = doc_with_page(&mut doc, res, "BT /F1 12 Tf <0001> Tj ET");
        if let Ok(Object::Dictionary(p)) = doc.get_object_mut(page) {
            p.set("Annots", vec![Object::Reference(annot)]);
        }
        let a = analyze_fonts(&doc);
        assert!(
            a.usable.is_empty() && a.unsupported[0].contains("annotation"),
            "{a:?}"
        );

        // Type3 の文字定義がフォントを使う
        let mut doc = Document::with_version("1.5");
        let f = good_font(&mut doc);
        let cp = doc.add_object(Stream::new(
            dictionary! {},
            b"500 0 d0 BT /F1 1 Tf ET".to_vec(),
        ));
        let t3 = doc.add_object(dictionary! {"Type"=>"Font","Subtype"=>"Type3",
        "CharProcs"=>dictionary!{"a"=>cp}});
        let res = dictionary! {"Font"=>dictionary!{"F1"=>f.type0,"T3"=>t3}};
        doc_with_page(&mut doc, res, "BT /F1 12 Tf <0001> Tj ET");
        let a = analyze_fonts(&doc);
        assert!(
            a.usable.is_empty() && a.unsupported[0].contains("Type3"),
            "{a:?}"
        );
    }

    #[test]
    fn unused_cid_fonts_are_left_alone() {
        let mut doc = Document::with_version("1.5");
        let f = good_font(&mut doc);
        let res = dictionary! {"Font"=>dictionary!{"F1"=>f.type0}};
        doc_with_page(&mut doc, res, "q Q");
        let a = analyze_fonts(&doc);
        assert!(a.usable.is_empty() && a.unsupported.is_empty(), "{a:?}");
    }

    #[test]
    fn strings_in_hex_and_literal_forms_are_equivalent() {
        let mut doc = Document::with_version("1.5");
        let f = good_font(&mut doc);
        let res = dictionary! {"Font"=>dictionary!{"F1"=>f.type0}};
        doc_with_page(&mut doc, res, "BT /F1 12 Tf (\\000A) Tj <0042> Tj ET");
        let a = analyze_fonts(&doc);
        assert_eq!(cids(&a, f.file), [0x41, 0x42]);
        let _ = StringFormat::Literal;
    }
}
