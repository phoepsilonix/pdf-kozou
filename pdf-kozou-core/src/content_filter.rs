// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/content_filter.rs
// lopdf による内容ストリームの加工 (hayro 版「テキスト保持の画像化」の土台)。
//
// 現在の機能: テキスト描画命令の除去 (remove_text)
//   - ページ・Form XObject・タイリングパターン・SMask グループ・注釈の外観ストリームの
//     内容から、テキストを描く演算子 (Tj / TJ / ' / ") を取り除く。
//     ' と " は行送り (T*) の副作用だけ残す。BT/ET・Tf・Td 等の状態演算子はそのまま。
//   - Type3 フォントの文字も Tj で描かれるため、同じ処理で消える。
//   - 元のドキュメントは変更せず、加工済みの複製を返す (メモリ上)。
//   - 解析できない内容ストリームがあれば Err (呼び出し側は MuPDF にフォールバックする)。
//
// 既知の制限: テキストをクリップに使う描画モード (Tr 4〜7) は、文字が無くなる分だけ
// クリップの結果が変わる (実用上ほぼ現れない)。

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::collections::HashSet;

/// 加工結果の統計
#[derive(Debug, Default, Clone, Copy)]
pub struct Stats {
    /// 加工した内容ストリームの数
    pub streams: usize,
    /// 取り除いたテキスト描画命令の数
    pub removed_ops: usize,
}

/// `input` (PDF のバイト列) からテキスト描画命令を除いた PDF を作って返す。
pub fn remove_text_bytes(input: &[u8]) -> Result<(Vec<u8>, Stats), String> {
    let mut doc = Document::load_mem(input).map_err(|e| format!("lopdf load: {e}"))?;
    if doc.is_encrypted() {
        return Err("encrypted".into());
    }
    let stats = remove_text(&mut doc)?;
    let mut out = Vec::with_capacity(input.len());
    doc.save_to(&mut out).map_err(|e| format!("lopdf save: {e}"))?;
    Ok((out, stats))
}

/// 文書内のすべてのページ (とそこから辿れる部品) からテキスト描画命令を取り除く。
pub fn remove_text(doc: &mut Document) -> Result<Stats, String> {
    let mut stats = Stats::default();
    let mut visited: HashSet<ObjectId> = HashSet::new();
    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    for page_id in pages {
        // ページ自身の内容ストリーム
        for sid in doc.get_page_contents(page_id) {
            if visited.insert(sid) {
                filter_stream(doc, sid, &mut stats)?;
            }
        }
        // ページのリソースから辿れる部品 (継承されたリソースを含む)
        let (res_dict, res_ids) = doc
            .get_page_resources(page_id)
            .map_err(|e| format!("page resources: {e}"))?;
        let mut children = Vec::new();
        if let Some(d) = res_dict {
            collect_children(doc, d, &mut children);
        }
        for rid in res_ids {
            if let Ok(d) = doc.get_dictionary(rid) {
                collect_children(doc, d, &mut children);
            }
        }
        // 注釈の外観ストリーム
        collect_annotation_streams(doc, page_id, &mut children);
        for child in children {
            process_part(doc, child, &mut visited, &mut stats, 0)?;
        }
    }
    Ok(stats)
}

const MAX_DEPTH: usize = 32;

/// Form XObject / パターン等のストリーム 1 つ分を加工し、その中のリソースも再帰的に辿る。
fn process_part(
    doc: &mut Document,
    id: ObjectId,
    visited: &mut HashSet<ObjectId>,
    stats: &mut Stats,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_DEPTH || !visited.insert(id) {
        return Ok(());
    }
    filter_stream(doc, id, stats)?;
    // この部品自身の Resources から、さらに入れ子の部品を集める
    let mut children = Vec::new();
    if let Ok(Object::Stream(s)) = doc.get_object(id)
        && let Some(res) = resolve_dict(doc, s.dict.get(b"Resources").ok())
    {
        collect_children(doc, res, &mut children);
    }
    for child in children {
        process_part(doc, child, visited, stats, depth + 1)?;
    }
    Ok(())
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
fn collect_children(doc: &Document, res: &Dictionary, out: &mut Vec<ObjectId>) {
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

/// 1 つの内容ストリームからテキスト描画命令を取り除いて書き戻す
fn filter_stream(doc: &mut Document, id: ObjectId, stats: &mut Stats) -> Result<(), String> {
    let Ok(Object::Stream(stream)) = doc.get_object_mut(id) else {
        return Ok(()); // ストリームでなければ対象外
    };
    let bytes = match stream.decompressed_content() {
        Ok(b) => b,
        // Filter が無い (無圧縮) ストリームは content そのまま
        Err(_) if stream.dict.get(b"Filter").is_err() => stream.content.clone(),
        Err(e) => return Err(format!("stream {id:?} decompress: {e}")),
    };
    let (new_bytes, removed) = strip_text_ops(&bytes).map_err(|e| format!("stream {id:?}: {e}"))?;
    if removed > 0 {
        stream.set_plain_content(new_bytes);
        stats.streams += 1;
        stats.removed_ops += removed;
    }
    Ok(())
}

/// 内容ストリームのバイト列から、テキストを描く演算子を取り除く。
/// 戻り値: (加工後のバイト列, 取り除いた命令の数)。テキストが無ければ元のバイト列のまま。
/// lopdf の解析器はインライン画像 (BI ... ID ... EI) を扱えないため、画像部分を先に切り出し、
/// それ以外の部分だけを解析して、画像部分はそのまま連結し直す。
pub fn strip_text_ops(bytes: &[u8]) -> Result<(Vec<u8>, usize), String> {
    // 高速パス: テキスト描画の演算子が 1 つも無ければ解析しない
    if !bytes.windows(2).any(|w| w == b"Tj" || w == b"TJ") && !contains_quote_op(bytes) {
        return Ok((bytes.to_vec(), 0));
    }
    let images = find_inline_images(bytes)?;
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut removed = 0usize;
    let mut pos = 0usize;
    for (start, end) in images.iter().copied().chain(std::iter::once((bytes.len(), bytes.len()))) {
        if start > pos {
            let (chunk, n) = strip_chunk(&bytes[pos..start])?;
            removed += n;
            out.extend_from_slice(&chunk);
            out.push(b'\n');
        }
        if end > start {
            out.extend_from_slice(&bytes[start..end]); // インライン画像はそのまま
            out.push(b'\n');
        }
        pos = end;
    }
    if removed == 0 {
        return Ok((bytes.to_vec(), 0));
    }
    Ok((out, removed))
}

/// インライン画像を含まない部分を加工する
fn strip_chunk(chunk: &[u8]) -> Result<(Vec<u8>, usize), String> {
    let content = Content::decode(chunk).map_err(|e| format!("content decode: {e}"))?;
    let mut removed = 0usize;
    let mut ops: Vec<Operation> = Vec::with_capacity(content.operations.len());
    for op in content.operations {
        match op.operator.as_str() {
            "Tj" | "TJ" => removed += 1,
            // ' : T* して文字列を描く。行送りだけ残す
            "'" => {
                removed += 1;
                ops.push(Operation::new("T*", vec![]));
            }
            // " : aw ac string → Tw / Tc を設定し、T* して描く
            "\"" => {
                removed += 1;
                if op.operands.len() == 3 {
                    ops.push(Operation::new("Tw", vec![op.operands[0].clone()]));
                    ops.push(Operation::new("Tc", vec![op.operands[1].clone()]));
                }
                ops.push(Operation::new("T*", vec![]));
            }
            _ => ops.push(op),
        }
    }
    let out = Content { operations: ops }
        .encode()
        .map_err(|e| format!("content encode: {e}"))?;
    Ok((out, removed))
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

/// ' / " 演算子 (前後が空白・区切りのもの) が含まれていそうか
fn contains_quote_op(bytes: &[u8]) -> bool {
    bytes.iter().any(|&b| b == b'\'' || b == b'"')
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
}
