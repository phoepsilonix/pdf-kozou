// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/compress_lopdf.rs
// 通常の圧縮 (compress::safe_compress_only) の lopdf 実装。MuPDF を使わない。
//
// MuPDF 実装の PdfWriteOptions のうち、次を lopdf で行う。
//   garbage_level 0 : 何も取り除かない
//                 1 : どこからも参照されないオブジェクトを取り除く
//                 2 : さらにオブジェクト番号を振り直す (世代番号は 0 に揃える)
//                 3 以上 : さらに、内容が同じストリームを 1 つにまとめる
//                         (MuPDF は 4 でストリームをまとめるが、ここでは 3 から行う。
//                          辞書は共有すると意味が変わりうるのでまとめない)
//   compress        : フィルタの無いストリームを Flate で圧縮する
//   compress_images : false のとき、画像 XObject は圧縮しない
//   compress_fonts  : false のとき、埋め込みフォント (FontFile*) は圧縮しない
//   object_stream   : オブジェクトストリームと xref ストリームで保存する
//
// 次は lopdf では行えないので、指定されていたら Err (Unsupported) を返す。
// 呼び出し側 (backend) が MuPDF へフォールバックし、GUI へその旨を通知する。
//   clean / sanitize : コンテンツストリームの再解釈・再構築
//   merge_fonts      : 重複フォントの統合
//
// 暗号化された入力、lopdf が内容を落とす入力 (safe_load の検出) も Err にする。
// 保存したあとに読み直してページ数を確かめ、食い違えば Err にする。

use crate::error::{CoreError, Result};
use lopdf::xref::XrefType;
use lopdf::{Dictionary, Document, Object, ObjectId, SaveOptions};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::io::Write;

/// 圧縮の指定 (MuPDF 実装 safe_compress_only の引数と同じ)
#[derive(Debug, Clone, Copy)]
pub(crate) struct Params {
    pub compress_images: bool,
    pub compress_fonts: bool,
    pub garbage_level: i32,
    pub clean: bool,
    pub sanitize: bool,
    pub merge_fonts: bool,
    pub object_stream: bool,
}

/// 処理の内訳 (ログ用)
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Stats {
    pub pruned_objects: usize,
    pub merged_streams: usize,
    pub compressed_streams: usize,
}

// ── 参照の走査・付け替え ──────────────────────────────────────────────────

fn collect_refs(obj: &Object, out: &mut Vec<ObjectId>) {
    match obj {
        Object::Reference(id) => out.push(*id),
        Object::Array(a) => a.iter().for_each(|o| collect_refs(o, out)),
        Object::Dictionary(d) => d.iter().for_each(|(_, v)| collect_refs(v, out)),
        Object::Stream(s) => s.dict.iter().for_each(|(_, v)| collect_refs(v, out)),
        _ => {}
    }
}

/// 参照を `map` に従って付け替える。`null_missing` が真のとき、`map` に無い参照
/// (存在しないオブジェクトを指す宙ぶらりんの参照) は null にする。番号の振り直しで、
/// 宙ぶらりんだった番号が別のオブジェクトを指してしまうのを防ぐ。
fn remap_refs(obj: &mut Object, map: &HashMap<ObjectId, ObjectId>, null_missing: bool) {
    match obj {
        Object::Reference(id) => match map.get(id) {
            Some(n) => *id = *n,
            None if null_missing => *obj = Object::Null,
            None => {}
        },
        Object::Array(a) => a.iter_mut().for_each(|o| remap_refs(o, map, null_missing)),
        Object::Dictionary(d) => d
            .iter_mut()
            .for_each(|(_, v)| remap_refs(v, map, null_missing)),
        Object::Stream(s) => s
            .dict
            .iter_mut()
            .for_each(|(_, v)| remap_refs(v, map, null_missing)),
        _ => {}
    }
}

fn remap_doc(doc: &mut Document, map: &HashMap<ObjectId, ObjectId>, null_missing: bool) {
    doc.objects
        .values_mut()
        .for_each(|o| remap_refs(o, map, null_missing));
    doc.trailer
        .iter_mut()
        .for_each(|(_, v)| remap_refs(v, map, null_missing));
}

// ── 各段階 ────────────────────────────────────────────────────────────────

/// trailer を Root / Info / ID だけにする。xref ストリームから読んだ文書の trailer には
/// Type / W / Index / Filter / Length などが混ざり、そのまま xref テーブルで保存すると
/// 余計なキーが残る。Size などは保存時に lopdf が付け直す。
pub(crate) fn clean_trailer(doc: &mut Document) {
    let mut t = Dictionary::new();
    for key in [b"Root".as_slice(), b"Info".as_slice(), b"ID".as_slice()] {
        if let Ok(v) = doc.trailer.get(key) {
            t.set(key.to_vec(), v.clone());
        }
    }
    doc.trailer = t;
}

/// trailer から辿れないオブジェクトを取り除く。取り除いた数を返す。
/// (lopdf の prune_objects は参照の探索が Vec::contains で二乗時間になるため使わない)
pub(crate) fn prune(doc: &mut Document) -> usize {
    let mut seen: HashSet<ObjectId> = HashSet::new();
    let mut stack: Vec<ObjectId> = Vec::new();
    doc.trailer
        .iter()
        .for_each(|(_, v)| collect_refs(v, &mut stack));
    while let Some(id) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        if let Some(o) = doc.objects.get(&id) {
            collect_refs(o, &mut stack);
        }
    }
    let before = doc.objects.len();
    doc.objects.retain(|id, _| seen.contains(id));
    before - doc.objects.len()
}

/// オブジェクト番号を 1 から詰めて振り直し、世代番号を 0 に揃える。
/// 存在しないオブジェクトへの参照は null にする。
fn renumber(doc: &mut Document) {
    let mut map: HashMap<ObjectId, ObjectId> = HashMap::with_capacity(doc.objects.len());
    let mut next: u32 = 1;
    for id in doc.objects.keys() {
        map.insert(*id, (next, 0));
        next += 1;
    }
    let old = std::mem::take(&mut doc.objects);
    for (id, obj) in old {
        doc.objects.insert(map[&id], obj);
    }
    remap_doc(doc, &map, true);
    doc.max_id = next - 1;
}

fn hash_dict(d: &Dictionary, h: &mut DefaultHasher) {
    7u8.hash(h);
    // 辞書のキーの並び順は意味を持たないので、並べ替えてから混ぜる
    let mut items: Vec<(&Vec<u8>, &Object)> = d.iter().collect();
    items.sort_by(|a, b| a.0.cmp(b.0));
    for (k, v) in items {
        k.hash(h);
        hash_object(v, h);
    }
}

fn hash_object(o: &Object, h: &mut DefaultHasher) {
    match o {
        Object::Null => 0u8.hash(h),
        Object::Boolean(b) => {
            1u8.hash(h);
            b.hash(h);
        }
        Object::Integer(i) => {
            2u8.hash(h);
            i.hash(h);
        }
        Object::Real(f) => {
            3u8.hash(h);
            f.to_bits().hash(h);
        }
        Object::Name(n) => {
            4u8.hash(h);
            n.hash(h);
        }
        Object::String(s, _) => {
            5u8.hash(h);
            s.hash(h);
        }
        Object::Array(a) => {
            6u8.hash(h);
            a.len().hash(h);
            a.iter().for_each(|x| hash_object(x, h));
        }
        Object::Dictionary(d) => hash_dict(d, h),
        Object::Stream(s) => {
            8u8.hash(h);
            hash_dict(&s.dict, h);
            s.content.hash(h);
        }
        Object::Reference(id) => {
            9u8.hash(h);
            id.hash(h);
        }
    }
}

/// 辞書と中身が同じストリームを 1 つにまとめる。まとめた数を返す。
/// 画像とその SMask のように、下位のストリームが同じになって初めて上位も同じに見える
/// ものがあるので、まとまるものが無くなるまで (最大 8 回) 繰り返す。
fn dedupe_streams(doc: &mut Document) -> usize {
    let mut total = 0;
    for _ in 0..8 {
        let mut buckets: HashMap<u64, Vec<ObjectId>> = HashMap::new();
        for (id, o) in &doc.objects {
            if let Object::Stream(_) = o {
                let mut h = DefaultHasher::new();
                hash_object(o, &mut h);
                buckets.entry(h.finish()).or_default().push(*id);
            }
        }
        // objects は番号順なので、各バケットの先頭 (番号の小さい方) を残す側にする
        let mut map: HashMap<ObjectId, ObjectId> = HashMap::new();
        for ids in buckets.values().filter(|v| v.len() > 1) {
            let mut kept: Vec<ObjectId> = Vec::new();
            for id in ids {
                let dup_of = kept
                    .iter()
                    .find(|k| doc.objects.get(k) == doc.objects.get(id))
                    .copied();
                match dup_of {
                    Some(k) => {
                        map.insert(*id, k);
                    }
                    None => kept.push(*id),
                }
            }
        }
        if map.is_empty() {
            break;
        }
        total += map.len();
        remap_doc(doc, &map, false);
        prune(doc);
    }
    total
}

/// フォントファイル (FontFile / FontFile2 / FontFile3) のストリームの番号
fn font_stream_ids(doc: &Document) -> HashSet<ObjectId> {
    let mut set = HashSet::new();
    for o in doc.objects.values() {
        if let Object::Dictionary(d) = o {
            for key in [
                b"FontFile".as_slice(),
                b"FontFile2".as_slice(),
                b"FontFile3".as_slice(),
            ] {
                if let Ok(Object::Reference(id)) = d.get(key) {
                    set.insert(*id);
                }
            }
        }
    }
    set
}

/// フィルタの無いストリームを Flate で圧縮する。圧縮した数を返す。
/// 圧縮して小さくならないものは lopdf が元のまま残す。
fn compress_streams(doc: &mut Document, p: &Params) -> usize {
    let fonts = font_stream_ids(doc);
    let mut n = 0;
    for (id, o) in doc.objects.iter_mut() {
        let Object::Stream(s) = o else { continue };
        if !s.allows_compression || s.dict.get(b"Filter").is_ok() {
            continue;
        }
        let ty = s.dict.get(b"Type").ok().and_then(|t| t.as_name().ok());
        // xref / オブジェクトストリームは保存時に作り直される。XMP メタデータは、
        // 非対応のツールでも読めるよう圧縮しない。
        if matches!(ty, Some(b"XRef") | Some(b"ObjStm") | Some(b"Metadata")) {
            continue;
        }
        let is_image = s.dict.get(b"Subtype").ok().and_then(|t| t.as_name().ok()) == Some(b"Image");
        if (is_image && !p.compress_images) || (fonts.contains(id) && !p.compress_fonts) {
            continue;
        }
        let _ = s.compress();
        if s.dict.get(b"Filter").is_ok() {
            n += 1;
        }
    }
    n
}

// ── 入口 ──────────────────────────────────────────────────────────────────

/// `input` を lopdf だけで圧縮して `output` へ書く。
/// 失敗や未対応の指定は Err。呼び出し側が MuPDF 実装へフォールバックする。
pub(crate) fn compress_with_lopdf(input: &str, output: &str, p: &Params) -> Result<Stats> {
    let mut unsupported: Vec<&str> = Vec::new();
    if p.clean {
        unsupported.push("clean");
    }
    if p.sanitize {
        unsupported.push("sanitize");
    }
    if p.merge_fonts {
        unsupported.push("merge_fonts");
    }
    if !unsupported.is_empty() {
        return Err(CoreError::Unsupported(format!(
            "lopdf compression does not support {}",
            unsupported.join(", ")
        )));
    }

    let (mut doc, _bytes) = crate::safe_load::load_checked(input)?;
    if doc.is_encrypted() || doc.was_encrypted() {
        return Err(CoreError::Unsupported(
            "lopdf compression does not support encrypted PDFs".into(),
        ));
    }
    let page_count = doc.get_pages().len();
    if page_count == 0 {
        return Err(CoreError::Parse(format!("{input}: no pages")));
    }

    let gc = p.garbage_level;
    let mut stats = Stats::default();

    clean_trailer(&mut doc);
    if gc >= 1 {
        stats.pruned_objects += prune(&mut doc);
    }
    stats.compressed_streams = compress_streams(&mut doc, p);
    if gc >= 1 {
        // 圧縮で直接の /Length に置き換わった、間接オブジェクトの /Length などを取り除く
        stats.pruned_objects += prune(&mut doc);
    }
    if gc >= 3 {
        stats.merged_streams = dedupe_streams(&mut doc);
    }
    if gc >= 2 {
        renumber(&mut doc);
    } else {
        // 取り除いたオブジェクトの分だけ /Size が大き過ぎないよう、最大番号に合わせる
        doc.max_id = doc.objects.keys().map(|k| k.0).max().unwrap_or(0);
    }

    save_checked(&mut doc, output, p.object_stream, page_count)?;
    Ok(stats)
}

/// 保存し、書いたものを読み直してページ数が `page_count` のままであることを確かめる。
/// 失敗したら `output` を消して Err。
pub(crate) fn save_checked(
    doc: &mut Document,
    output: &str,
    object_stream: bool,
    page_count: usize,
) -> Result<()> {
    if let Err(e) = save(doc, output, object_stream) {
        let _ = std::fs::remove_file(output);
        return Err(e);
    }
    let written = Document::load(output)
        .map_err(|e| CoreError::Parse(format!("{output}: written file does not load: {e}")))?;
    let written_pages = written.get_pages().len();
    if written_pages != page_count {
        let _ = std::fs::remove_file(output);
        return Err(CoreError::Parse(format!(
            "{output}: page count changed ({page_count} -> {written_pages})"
        )));
    }
    Ok(())
}

fn save(doc: &mut Document, output: &str, object_stream: bool) -> Result<()> {
    let file = std::fs::File::create(output)?;
    let mut w = std::io::BufWriter::new(file);
    let wrote = if object_stream {
        let opts = SaveOptions::builder()
            .use_object_streams(true)
            .use_xref_streams(true)
            .build();
        doc.save_with_options(&mut w, opts)
    } else {
        // 読んだ文書が xref ストリームでも、オブジェクトストリームを使わないときは
        // 従来の xref テーブルで書く (MuPDF の出力に合わせる)
        doc.reference_table.cross_reference_type = XrefType::CrossReferenceTable;
        doc.save_to(&mut w)
    };
    wrote.map_err(|e| CoreError::Parse(format!("{output}: lopdf save: {e}")))?;
    w.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{Stream, dictionary};

    fn params() -> Params {
        Params {
            compress_images: true,
            compress_fonts: true,
            garbage_level: 2,
            clean: false,
            sanitize: false,
            merge_fonts: false,
            object_stream: false,
        }
    }

    /// 1 ページの PDF。圧縮前の内容ストリーム、同じ内容の画像 2 つ、
    /// どこからも参照されないオブジェクト、宙ぶらりんの参照を持つ。
    fn sample(path: &std::path::Path) -> (ObjectId, ObjectId) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let text =
            "BT /F1 12 Tf 72 720 Td (Hello Hello Hello Hello Hello Hello) Tj ET\n".repeat(50);
        let content_id = doc.add_object(Stream::new(dictionary! {}, text.into_bytes()));
        let raw = vec![0x80u8; 4096];
        let img_dict = dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => 64, "Height" => 64,
            "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
        };
        let img1 = doc.add_object(Stream::new(img_dict.clone(), raw.clone()));
        let img2 = doc.add_object(Stream::new(img_dict, raw));
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
        });
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Contents" => content_id,
            "Resources" => dictionary! {
                "Font" => dictionary! { "F1" => font_id },
                "XObject" => dictionary! { "I1" => img1, "I2" => img2, "Dangling" => Object::Reference((9999, 0)) },
            },
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        let info_id = doc.add_object(dictionary! { "Title" => Object::string_literal("T") });
        let orphan = doc.add_object(Stream::new(dictionary! {}, vec![1u8; 2000]));
        doc.trailer.set("Root", catalog_id);
        doc.trailer.set("Info", info_id);
        doc.save(path).unwrap();
        (orphan, content_id)
    }

    fn run(p: &Params) -> (Stats, Document, u64, u64) {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.pdf");
        let dst = dir.path().join("out.pdf");
        sample(&src);
        let stats = compress_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), p).unwrap();
        let doc = Document::load(&dst).unwrap();
        let ib = std::fs::metadata(&src).unwrap().len();
        let ob = std::fs::metadata(&dst).unwrap().len();
        (stats, doc, ib, ob)
    }

    fn stream_count(doc: &Document) -> usize {
        doc.objects
            .values()
            .filter(|o| matches!(o, Object::Stream(_)))
            .count()
    }

    #[test]
    fn standard_prunes_compresses_and_renumbers() {
        let (stats, doc, ib, ob) = run(&params());
        assert!(
            stats.pruned_objects >= 1,
            "orphan stream should be dropped: {stats:?}"
        );
        assert!(stats.compressed_streams >= 2, "{stats:?}");
        assert_eq!(stats.merged_streams, 0, "gc=2 does not merge streams");
        assert!(ob < ib, "output {ob} should be smaller than input {ib}");
        assert_eq!(doc.get_pages().len(), 1);
        // 番号は 1 から詰まっている
        let ids: Vec<u32> = doc.objects.keys().map(|k| k.0).collect();
        assert_eq!(ids, (1..=ids.len() as u32).collect::<Vec<_>>());
        assert!(doc.objects.keys().all(|k| k.1 == 0));
        // Info は残る
        assert!(doc.trailer.get(b"Info").is_ok());
    }

    #[test]
    fn dangling_reference_becomes_null() {
        let (_, doc, _, _) = run(&params());
        let page_id = *doc.get_pages().get(&1).unwrap();
        let res = doc
            .get_dictionary(page_id)
            .unwrap()
            .get(b"Resources")
            .unwrap()
            .as_dict()
            .unwrap();
        let xo = res.get(b"XObject").unwrap().as_dict().unwrap();
        assert!(matches!(xo.get(b"Dangling").unwrap(), Object::Null));
    }

    #[test]
    fn gc1_keeps_numbers_gc3_merges_duplicate_images() {
        let mut p = params();
        p.garbage_level = 1;
        let (s1, d1, _, _) = run(&p);
        assert_eq!(s1.merged_streams, 0);
        // /Size は最大のオブジェクト番号 + 1
        let highest = d1.objects.keys().map(|k| k.0).max().unwrap();
        assert_eq!(
            d1.trailer.get(b"Size").unwrap().as_i64().unwrap(),
            i64::from(highest) + 1
        );
        let n1 = stream_count(&d1);

        p.garbage_level = 3;
        let (s3, d3, _, _) = run(&p);
        assert_eq!(s3.merged_streams, 1, "{s3:?}");
        assert_eq!(stream_count(&d3), n1 - 1);
        // 両方の名前が同じ画像を指す
        let page_id = *d3.get_pages().get(&1).unwrap();
        let res = d3
            .get_dictionary(page_id)
            .unwrap()
            .get(b"Resources")
            .unwrap()
            .as_dict()
            .unwrap();
        let xo = res.get(b"XObject").unwrap().as_dict().unwrap();
        assert_eq!(xo.get(b"I1").unwrap(), xo.get(b"I2").unwrap());
    }

    #[test]
    fn gc0_keeps_orphans() {
        let mut p = params();
        p.garbage_level = 0;
        let (stats, _, _, _) = run(&p);
        assert_eq!(stats.pruned_objects, 0);
    }

    #[test]
    fn compress_images_false_leaves_images_raw() {
        let mut p = params();
        p.compress_images = false;
        let (_, doc, _, _) = run(&p);
        let raw_images = doc
            .objects
            .values()
            .filter_map(|o| o.as_stream().ok())
            .filter(|s| {
                s.dict.get(b"Subtype").ok().and_then(|t| t.as_name().ok()) == Some(b"Image")
            })
            .filter(|s| s.dict.get(b"Filter").is_err())
            .count();
        assert_eq!(raw_images, 2);
    }

    #[test]
    fn object_stream_output_loads() {
        let mut p = params();
        p.object_stream = true;
        let (_, doc, _, _) = run(&p);
        assert_eq!(doc.get_pages().len(), 1);
        assert!(
            doc.reference_table
                .entries
                .values()
                .any(|e| matches!(e, lopdf::xref::XrefEntry::Compressed { .. }))
        );
    }

    #[test]
    fn unsupported_options_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.pdf");
        let dst = dir.path().join("out.pdf");
        sample(&src);
        for tweak in [
            |p: &mut Params| p.clean = true,
            |p: &mut Params| p.sanitize = true,
            |p: &mut Params| p.merge_fonts = true,
        ] {
            let mut p = params();
            tweak(&mut p);
            let e =
                compress_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), &p).unwrap_err();
            assert!(matches!(e, CoreError::Unsupported(_)), "{e}");
        }
        assert!(!dst.exists());
    }
}
