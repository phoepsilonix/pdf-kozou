// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/clean_lopdf.rs
// 内容ストリームの clean (MuPDF の PdfWriteOptions の clean 相当) の lopdf 実装。
//
// 行うこと:
//   - ページの /Contents が配列のとき、分割されたストリームを 1 本に連結する
//     (仕様上、配列の各ストリームは字句の境目でしか分割されない。operand と演算子が
//      別のストリームに分かれることもあるので、連結してから解析する)
//   - 内容ストリームを解析して書き直す (演算子ごとに改行し、数値の書式を揃える)。
//     インライン画像はそのまま保つ。
//   - Form XObject とタイリングパターンの内容ストリームも同様に書き直す
//     (注釈の外観ストリームや SMask グループは Form XObject なので含まれる)。
//
// 行わないこと (sanitize の領域):
//   - 未使用リソースの除去、冗長な演算子の整理
//   - Type3 フォントの文字定義 (CharProcs) の書き直し
//
// 書き直したストリームのフィルタは外れる。Flate での再圧縮は、そのあとの
// compress_lopdf の圧縮段階が行う。連結して不要になったストリームは、未参照になるので
// garbage_level 1 以上で取り除かれる。
//
// 解析できない内容・デコードできないフィルタがあれば Err を返し、何も保証しない。
// 呼び出し側 (compress_lopdf) は Err を受けて MuPDF 実装へフォールバックする。

use crate::content_filter::reencode_bytes;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use std::collections::{HashMap, HashSet};

/// 文書内の内容ストリームを clean する。書き直したストリームの数を返す。
pub(crate) fn clean_contents(doc: &mut Document) -> Result<usize, String> {
    let mut cleaned = 0usize;
    let mut touched: HashSet<ObjectId> = HashSet::new();

    // ── ページの内容ストリーム ──
    // 各ページの /Contents を、実在するストリームの並びに直す
    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
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

    // ストリームが、(重複を除いた) いくつの並びに使われているか。
    // 他の並びと共有されているストリームは、書き換えず、新しいストリームに書く。
    let mut usage: HashMap<ObjectId, usize> = HashMap::new();
    let mut seen_sigs: HashSet<&Vec<ObjectId>> = HashSet::new();
    for (_, sig) in &page_streams {
        if !sig.is_empty() && seen_sigs.insert(sig) {
            for id in sig {
                *usage.entry(*id).or_insert(0) += 1;
            }
        }
    }

    // 同じ並びを持つページ (内容を共有するページ) は、同じ結果のストリームを指す
    let mut done: HashMap<Vec<ObjectId>, ObjectId> = HashMap::new();
    for (page_id, sig) in &page_streams {
        if sig.is_empty() {
            continue;
        }
        let target = match done.get(sig) {
            Some(t) => *t,
            None => {
                let mut joined: Vec<u8> = Vec::new();
                for id in sig {
                    let bytes = plain_content(doc, *id)?;
                    joined.extend_from_slice(&bytes);
                    joined.push(b'\n');
                }
                let new_bytes =
                    reencode_bytes(&joined).map_err(|e| format!("page {page_id:?}: {e}"))?;
                let exclusive = sig.iter().all(|id| usage.get(id) == Some(&1));
                let target = if exclusive {
                    set_content(doc, sig[0], new_bytes);
                    sig[0]
                } else {
                    doc.add_object(Stream::new(Dictionary::new(), new_bytes))
                };
                touched.extend(sig.iter().copied());
                touched.insert(target);
                done.insert(sig.clone(), target);
                cleaned += 1;
                target
            }
        };
        if let Ok(Object::Dictionary(page)) = doc.get_object_mut(*page_id) {
            page.set("Contents", Object::Reference(target));
        }
    }

    // ── Form XObject / タイリングパターン ──
    let parts: Vec<ObjectId> = doc
        .objects
        .iter()
        .filter_map(|(id, o)| match o {
            Object::Stream(s) if is_content_part(&s.dict) && !touched.contains(id) => Some(*id),
            _ => None,
        })
        .collect();
    for id in parts {
        let bytes = plain_content(doc, id)?;
        let new_bytes = reencode_bytes(&bytes).map_err(|e| format!("stream {id:?}: {e}"))?;
        set_content(doc, id, new_bytes);
        cleaned += 1;
    }
    Ok(cleaned)
}

/// 内容ストリームを持つ部品か (Form XObject / タイリングパターン)
fn is_content_part(d: &Dictionary) -> bool {
    let is_form = d.get(b"Subtype").ok().and_then(|o| o.as_name().ok()) == Some(b"Form");
    let is_tiling = matches!(d.get(b"PatternType"), Ok(Object::Integer(1)));
    is_form || is_tiling
}

/// ストリームのフィルタを外した内容。デコードできなければ Err
fn plain_content(doc: &Document, id: ObjectId) -> Result<Vec<u8>, String> {
    match doc.objects.get(&id) {
        Some(Object::Stream(s)) => s
            .get_plain_content()
            .map_err(|e| format!("stream {id:?} decompress: {e}")),
        _ => Err(format!("stream {id:?} is missing")),
    }
}

/// ストリームの内容を (フィルタ無しで) 置き換える
fn set_content(doc: &mut Document, id: ObjectId, bytes: Vec<u8>) {
    if let Some(Object::Stream(s)) = doc.objects.get_mut(&id) {
        s.set_plain_content(bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    /// ページ 1 枚の文書を作る。`contents` は /Contents に入れる値、`extra` は追加のオブジェクト。
    fn doc_with(build: impl FnOnce(&mut Document, ObjectId) -> Object) -> (Document, ObjectId) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let contents = build(&mut doc, pages_id);
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
            "Contents" => contents,
            "Resources" => dictionary! {},
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
            }),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        (doc, page_id)
    }

    fn page_bytes(doc: &Document, page_id: ObjectId) -> Vec<u8> {
        doc.get_page_content(page_id)
    }

    /// 内容ストリームを演算子の列に直す (書式の違いを無視して比べるため)
    fn ops(bytes: &[u8]) -> Vec<(String, Vec<String>)> {
        lopdf::content::Content::decode(bytes)
            .unwrap()
            .operations
            .into_iter()
            .map(|o| {
                (
                    o.operator,
                    o.operands.iter().map(|x| format!("{x:?}")).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn merges_split_contents_even_when_operands_are_split() {
        let (mut doc, page_id) = doc_with(|doc, _| {
            // 1 本目の末尾に operand、2 本目の先頭に演算子 (字句の境目での分割)
            let a = doc.add_object(Stream::new(dictionary! {}, b"q 1 0 0 1 10 10".to_vec()));
            let b = doc.add_object(Stream::new(dictionary! {}, b"cm 0 0 50 50 re f Q".to_vec()));
            Object::Array(vec![a.into(), b.into()])
        });
        let n = clean_contents(&mut doc).unwrap();
        assert_eq!(n, 1);
        // /Contents は 1 本のストリームへの参照
        let page = doc.get_dictionary(page_id).unwrap();
        let c = page.get(b"Contents").unwrap();
        assert!(matches!(c, Object::Reference(_)), "{c:?}");
        let got = ops(&page_bytes(&doc, page_id));
        let names: Vec<&str> = got.iter().map(|o| o.0.as_str()).collect();
        assert_eq!(names, ["q", "cm", "re", "f", "Q"]);
        assert_eq!(got[1].1.len(), 6);
    }

    #[test]
    fn keeps_inline_images_and_tricky_tokens() {
        let mut src: Vec<u8> = Vec::new();
        src.extend_from_slice(b"q 10 0 0 10 0 0 cm\n");
        // バイナリを含むインライン画像 (データに空白・改行・"BI" の文字を含む)
        src.extend_from_slice(b"BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\n\x42\x49 EI Q\n");
        src.extend_from_slice(
            b"BT /F1 12 Tf (a\\(b\\)c\\\\ \\101 BI x) Tj <48656C6C6F> Tj [(A) -120.5 (B)] TJ ET\n",
        );
        src.extend_from_slice(b"/OC /Name#20With#23 BDC EMC /P << /MCID 3 /K [1 2.5] >> BDC EMC\n");
        src.extend_from_slice(b"0.5 w .25 -.75 m 3. 4 l S\n");
        let (mut doc, page_id) = doc_with(|doc, _| {
            Object::Reference(doc.add_object(Stream::new(dictionary! {}, src.clone())))
        });
        clean_contents(&mut doc).unwrap();
        let out = page_bytes(&doc, page_id);
        // インライン画像のバイト列はそのまま残る
        let needle: &[u8] = b"BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\n\x42\x49 EI";
        assert!(
            out.windows(needle.len()).any(|w| w == needle),
            "inline image must be kept verbatim"
        );
        // 画像より後ろの部分は、演算子と operand が変わらない
        let tail_src = &src[src.windows(2).rposition(|w| w == b"EI").unwrap() + 2..];
        let tail_out = &out[out.windows(2).rposition(|w| w == b"EI").unwrap() + 2..];
        assert_eq!(ops(tail_src), ops(tail_out));
    }

    #[test]
    fn shared_contents_are_not_overwritten() {
        // 2 ページが 1 本目のストリームを共有し、片方だけ 2 本目を持つ
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let shared = doc.add_object(Stream::new(dictionary! {}, b"q 0 0 10 10 re f".to_vec()));
        let tail = doc.add_object(Stream::new(dictionary! {}, b"Q".to_vec()));
        let mk = |doc: &mut Document, c: Object| {
            doc.add_object(dictionary! {
                "Type" => "Page", "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
                "Contents" => c, "Resources" => dictionary! {},
            })
        };
        let p1 = mk(&mut doc, Object::Array(vec![shared.into(), tail.into()]));
        let p2 = mk(&mut doc, Object::Reference(shared));
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![p1.into(), p2.into()], "Count" => 2,
            }),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);

        clean_contents(&mut doc).unwrap();
        let b1 = ops(&page_bytes(&doc, p1));
        let b2 = ops(&page_bytes(&doc, p2));
        assert_eq!(
            b1.iter().map(|o| o.0.as_str()).collect::<Vec<_>>(),
            ["q", "re", "f", "Q"]
        );
        assert_eq!(
            b2.iter().map(|o| o.0.as_str()).collect::<Vec<_>>(),
            ["q", "re", "f"]
        );
    }

    #[test]
    fn identical_contents_lists_share_one_result() {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let a = doc.add_object(Stream::new(dictionary! {}, b"q 0 0 1 1 re".to_vec()));
        let b = doc.add_object(Stream::new(dictionary! {}, b"f Q".to_vec()));
        let mk = |doc: &mut Document| {
            doc.add_object(dictionary! {
                "Type" => "Page", "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
                "Contents" => Object::Array(vec![a.into(), b.into()]),
                "Resources" => dictionary! {},
            })
        };
        let p1 = mk(&mut doc);
        let p2 = mk(&mut doc);
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![p1.into(), p2.into()], "Count" => 2,
            }),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        let n = clean_contents(&mut doc).unwrap();
        assert_eq!(n, 1, "same /Contents list is cleaned once");
        let c1 = doc
            .get_dictionary(p1)
            .unwrap()
            .get(b"Contents")
            .unwrap()
            .clone();
        let c2 = doc
            .get_dictionary(p2)
            .unwrap()
            .get(b"Contents")
            .unwrap()
            .clone();
        assert_eq!(c1, c2);
        assert_eq!(ops(&page_bytes(&doc, p1)).len(), 4);
    }

    #[test]
    fn cleans_form_xobjects_and_tiling_patterns() {
        let (mut doc, _) = doc_with(|doc, _| {
            Object::Reference(doc.add_object(Stream::new(dictionary! {}, b"q Q".to_vec())))
        });
        let form = doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()] },
            b"0 0 1 1 re   f".to_vec(),
        ));
        let pat = doc.add_object(Stream::new(
            dictionary! { "Type" => "Pattern", "PatternType" => 1 },
            b"0 0 1 1 re   f".to_vec(),
        ));
        let img = doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Image" },
            b"0 0 1 1 re   f".to_vec(),
        ));
        let n = clean_contents(&mut doc).unwrap();
        assert_eq!(n, 3, "page + form + pattern");
        let text = |id: ObjectId| {
            doc.get_object(id)
                .unwrap()
                .as_stream()
                .unwrap()
                .content
                .clone()
        };
        assert_eq!(text(form), b"0 0 1 1 re\nf\n");
        assert_eq!(text(pat), b"0 0 1 1 re\nf\n");
        // 画像は触らない
        assert_eq!(text(img), b"0 0 1 1 re   f");
    }

    #[test]
    fn undecodable_content_is_an_error() {
        let (mut doc, _) = doc_with(|doc, _| {
            // 閉じていない文字列
            Object::Reference(
                doc.add_object(Stream::new(dictionary! {}, b"BT (abc Tj ET".to_vec())),
            )
        });
        assert!(clean_contents(&mut doc).is_err());
    }

    #[test]
    fn trailing_garbage_is_not_silently_dropped() {
        // lopdf の decode は、解析できない箇所から先を捨てる。clean は Err にしなければならない
        let (mut doc, page_id) = doc_with(|doc, _| {
            Object::Reference(doc.add_object(Stream::new(
                dictionary! {},
                b"q 0 0 1 1 re f Q @@@ 5 w".to_vec(),
            )))
        });
        let before = page_bytes(&doc, page_id);
        assert!(clean_contents(&mut doc).is_err());
        // Err のとき、ページの内容は変わっていない
        assert_eq!(page_bytes(&doc, page_id), before);
    }

    #[test]
    fn non_finite_numbers_are_an_error() {
        // f32 に収まらない実数 (書き出すと inf になる)
        let huge = format!("{}.5 0 0 1 0 0 cm", "1".repeat(60));
        let (mut doc, _) = doc_with(|doc, _| {
            Object::Reference(doc.add_object(Stream::new(dictionary! {}, huge.into_bytes())))
        });
        assert!(clean_contents(&mut doc).is_err());
        // 整数として大きすぎる値も、黙って欠けずに Err になる
        let huge_int = format!("{} 0 0 1 0 0 cm", "9".repeat(60));
        let (mut doc, _) = doc_with(|doc, _| {
            Object::Reference(doc.add_object(Stream::new(dictionary! {}, huge_int.into_bytes())))
        });
        assert!(clean_contents(&mut doc).is_err());
    }

    #[test]
    fn page_without_contents_is_skipped() {
        let (mut doc, page_id) = doc_with(|_, _| Object::Null);
        if let Ok(Object::Dictionary(p)) = doc.get_object_mut(page_id) {
            p.remove(b"Contents");
        }
        assert_eq!(clean_contents(&mut doc).unwrap(), 0);
    }
}
