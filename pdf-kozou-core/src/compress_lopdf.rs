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
//   clean           : 内容ストリームの連結・再構築、使われていないリソースの除去 (clean_lopdf)
//   sanitize        : clean に加えて、描画結果を変えない演算子の整理 (sanitize_ops)。
//                     MuPDF も、clean と sanitize のどちらでも内容を書き直す
//
// 次は lopdf では行えないので、指定されていたら Err (Unsupported) を返す。
// 呼び出し側 (backend) が MuPDF へフォールバックし、GUI へその旨を通知する。
//   subset          : TrueType の CID フォント (Identity-H/V) のサブセット化 (font_usage /
//                     font_subset_lopdf)。MuPDF が縮めるフォントを 1 つでも縮められないときは、
//                     Unsupported (MuPDF へフォールバック)
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

/// 内容ストリームの書き直しが失敗したときのエラー文言の先頭。呼び出し側
/// (compress::safe_compress_only) が、GUI への通知で「clean / sanitize が原因のフォールバック」
/// だと示すために使う。
const CLEAN_ERR_PREFIX: &str = "lopdf clean: ";
const SANITIZE_ERR_PREFIX: &str = "lopdf sanitize: ";
const SUBSET_ERR_PREFIX: &str = "lopdf subset: ";

/// `compress_with_lopdf` のエラーが、clean / sanitize / サブセット化の失敗 (内容ストリームを
/// 解析できない、サブセット化できないフォントがあるなど) なら、通知に使う処理名
/// ("compress_clean" / "compress_sanitize" / "compress_subset")。
/// merge_fonts の未対応や、暗号化・読み込み失敗は None。
pub(crate) fn content_rewrite_op(e: &CoreError) -> Option<&'static str> {
    match e {
        CoreError::Unsupported(m) if m.starts_with(CLEAN_ERR_PREFIX) => Some("compress_clean"),
        CoreError::Unsupported(m) if m.starts_with(SANITIZE_ERR_PREFIX) => {
            Some("compress_sanitize")
        }
        CoreError::Unsupported(m) if m.starts_with(SUBSET_ERR_PREFIX) => Some("compress_subset"),
        _ => None,
    }
}

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
    /// フォントのサブセット化 (TrueType の CID フォントだけ)
    pub font_subset: bool,
}

/// 処理の内訳 (ログ用)
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Stats {
    pub pruned_objects: usize,
    pub merged_streams: usize,
    pub compressed_streams: usize,
    /// clean で書き直した内容ストリーム (連結後のページ内容・Form XObject・パターン) の数
    pub cleaned_streams: usize,
    /// clean で、使われていないリソースを外したページ・Form・パターンの数
    pub cleaned_resources: usize,
    /// sanitize で取り除いた演算子の数
    pub sanitized_ops: usize,
    /// サブセット化したフォントの数
    pub subset_fonts: usize,
    /// サブセット化で減ったフォントプログラムのバイト数 (展開後)
    pub subset_bytes_saved: usize,
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
    if p.clean || p.sanitize {
        // 内容ストリームを書き直す (MuPDF も clean / sanitize のどちらでも書き直す)。
        // 解析できない内容があれば Err (MuPDF へフォールバック)。通知で原因のオプションが分かるよう、
        // clean を指定していなければ sanitize の失敗として返す
        let prefix = if p.clean {
            CLEAN_ERR_PREFIX
        } else {
            SANITIZE_ERR_PREFIX
        };
        let outcome = crate::clean_lopdf::clean_contents(&mut doc, p.sanitize)
            .map_err(|e| CoreError::Unsupported(format!("{prefix}{e}")))?;
        stats.cleaned_streams = outcome.streams;
        stats.cleaned_resources = outcome.resources;
        stats.sanitized_ops = outcome.ops_removed;
        if gc >= 1 {
            // 連結して要らなくなった内容ストリームを、圧縮する前に取り除く
            stats.pruned_objects += prune(&mut doc);
        }
    }
    if p.font_subset {
        // MuPDF が縮めるフォントを 1 つでも縮められないときは Err (MuPDF へフォールバック)。
        // clean / sanitize のあとに行う (使われないフォントを先に取り除いておく)
        let analysis = crate::font_usage::analyze_fonts(&doc);
        if !analysis.unsupported.is_empty() {
            return Err(CoreError::Unsupported(format!(
                "{SUBSET_ERR_PREFIX}{}",
                analysis.unsupported.join("; ")
            )));
        }
        let outcome = crate::font_subset_lopdf::subset_fonts(&mut doc, &analysis.usable)
            .map_err(|e| CoreError::Unsupported(format!("{SUBSET_ERR_PREFIX}{e}")))?;
        stats.subset_fonts = outcome.fonts;
        stats.subset_bytes_saved = outcome.bytes_saved;
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
            font_subset: false,
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

    /// 内容ストリームが 2 本に分かれたページを持つ PDF
    fn split_contents_sample(path: &std::path::Path) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let a = doc.add_object(Stream::new(dictionary! {}, b"q 1 0 0 1 10 10".to_vec()));
        let b = doc.add_object(Stream::new(dictionary! {}, b"cm 0 0 50 50 re f Q".to_vec()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Contents" => vec![a.into(), b.into()],
            "Resources" => dictionary! {},
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        doc.save(path).unwrap();
    }

    #[test]
    fn clean_merges_page_contents_and_drops_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.pdf");
        let dst = dir.path().join("out.pdf");
        split_contents_sample(&src);
        let mut p = params();
        p.clean = true;
        let stats = compress_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), &p).unwrap();
        assert_eq!(stats.cleaned_streams, 1, "{stats:?}");
        assert!(
            stats.pruned_objects >= 1,
            "split stream should be dropped: {stats:?}"
        );
        let doc = Document::load(&dst).unwrap();
        assert_eq!(doc.get_pages().len(), 1);
        let page_id = *doc.get_pages().get(&1).unwrap();
        assert_eq!(doc.get_page_contents(page_id).len(), 1);
        let ops: Vec<String> =
            lopdf::content::Content::decode_strict(&doc.get_page_content(page_id))
                .unwrap()
                .operations
                .into_iter()
                .map(|o| o.operator)
                .collect();
        assert_eq!(ops, ["q", "cm", "re", "f", "Q"]);
    }

    /// clean は、使われていないリソースを外し、それだけが参照していた画像をファイルから落とす。
    #[test]
    fn clean_drops_resources_only_the_unused_entries_referenced() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.pdf");
        let dst = dir.path().join("out.pdf");
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let img = |doc: &mut Document, byte: u8| {
            doc.add_object(Stream::new(
                dictionary! {"Type"=>"XObject","Subtype"=>"Image","Width"=>8,"Height"=>8,
                "ColorSpace"=>"DeviceGray","BitsPerComponent"=>8},
                vec![byte; 64],
            ))
        };
        let (used, unused) = (img(&mut doc, 1), img(&mut doc, 2));
        let c = doc.add_object(Stream::new(
            dictionary! {},
            b"q 10 0 0 10 0 0 cm /Used Do Q".to_vec(),
        ));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Contents" => c,
            "Resources" => dictionary! { "XObject" => dictionary! { "Used" => used, "Unused" => unused } },
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        doc.save(&src).unwrap();

        let count_images = |path: &std::path::Path| {
            let d = Document::load(path).unwrap();
            d.objects
                .values()
                .filter(|o| matches!(o, Object::Stream(s) if s.dict.get(b"Subtype").ok().and_then(|n| n.as_name().ok()) == Some(b"Image")))
                .count()
        };
        // clean 無しでは、使われていない画像も残る (参照されているため)
        compress_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), &params()).unwrap();
        assert_eq!(count_images(&dst), 2);
        // clean ありでは落ちる
        let mut p = params();
        p.clean = true;
        let stats = compress_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), &p).unwrap();
        assert_eq!(stats.cleaned_resources, 1, "{stats:?}");
        assert_eq!(count_images(&dst), 1);
    }

    /// 内容 (Tj の文字列) をそのまま取り出す
    fn page_text_ops(path: &std::path::Path) -> Vec<String> {
        let doc = Document::load(path).unwrap();
        let page_id = *doc.get_pages().get(&1).unwrap();
        lopdf::content::Content::decode_strict(&doc.get_page_content(page_id))
            .unwrap()
            .operations
            .into_iter()
            .map(|o| format!("{} {:?}", o.operator, o.operands))
            .collect()
    }

    /// TrueType の CID フォントのサブセット化: フォントが縮み、内容 (文字コード) は変わらず、
    /// 新しい /CIDToGIDMap が付く。object_stream でも保存できる。
    #[test]
    fn font_subset_shrinks_a_cid_font_and_keeps_the_text() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.pdf");
        let dst = dir.path().join("out.pdf");
        let (mut doc, _, _) = crate::font_subset_lopdf::pdf_with_mock_font(
            "BT /F1 20 Tf 10 10 Td <00010009001E> Tj ET",
            true,
        );
        doc.save(&src).unwrap();
        let before = page_text_ops(&src);

        // 出力は番号が振り直される。CIDFont は、種類で探す
        let cid_font = |d: &Document| -> Dictionary {
            d.objects
                .values()
                .filter_map(|o| o.as_dict().ok())
                .find(|x| {
                    x.get(b"Subtype").ok().and_then(|n| n.as_name().ok()) == Some(b"CIDFontType2")
                })
                .unwrap()
                .clone()
        };
        let font_len = |d: &Document| {
            let cf = cid_font(d);
            let desc = cf.get(b"FontDescriptor").unwrap().as_reference().unwrap();
            let ff = d
                .get_object(desc)
                .unwrap()
                .as_dict()
                .unwrap()
                .get(b"FontFile2")
                .unwrap()
                .as_reference()
                .unwrap();
            let s = d.get_object(ff).unwrap().as_stream().unwrap();
            s.decompressed_content().unwrap().len()
        };

        // font_subset なしでは、フォントはそのまま (全グリフ)
        compress_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), &params()).unwrap();
        let original_len = font_len(&Document::load(&dst).unwrap());
        assert_eq!(original_len, 3296);

        for object_stream in [false, true] {
            let mut p = params();
            p.font_subset = true;
            p.object_stream = object_stream;
            let stats =
                compress_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), &p).unwrap();
            assert_eq!(stats.subset_fonts, 1, "{stats:?}");
            assert!(stats.subset_bytes_saved > 1000, "{stats:?}");
            let out = Document::load(&dst).unwrap();
            assert!(font_len(&out) < original_len);
            // 内容 (文字コード) は変わらない
            assert_eq!(page_text_ops(&dst), before);
            // CIDToGIDMap はストリーム
            assert!(matches!(
                cid_font(&out).get(b"CIDToGIDMap"),
                Ok(Object::Reference(_))
            ));
        }
    }

    /// サブセット化できない埋め込みフォント (CFF など) が 1 つでもあれば Unsupported
    /// (MuPDF へフォールバックさせる)。通知の処理名は compress_subset。
    #[test]
    fn font_subset_with_an_unsupported_font_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.pdf");
        let dst = dir.path().join("out.pdf");
        let (mut doc, _, _) =
            crate::font_subset_lopdf::pdf_with_mock_font("BT /F1 20 Tf <0001> Tj ET", false);
        // CFF の CID フォントを 1 つ足す
        let ff = doc.add_object(Stream::new(
            dictionary! {"Subtype"=>"CIDFontType0C"},
            vec![1, 0, 4, 1],
        ));
        let desc = doc.add_object(dictionary! {"Type"=>"FontDescriptor","FontFile3"=>ff});
        let cf = doc.add_object(
            dictionary! {"Type"=>"Font","Subtype"=>"CIDFontType0","FontDescriptor"=>desc},
        );
        let cff = doc.add_object(
            dictionary! {"Type"=>"Font","Subtype"=>"Type0","Encoding"=>"Identity-H",
            "DescendantFonts"=>vec![cf.into()]},
        );
        // ページのリソースから参照する (参照されないフォントは、先に取り除かれる)
        let page = *doc.get_pages().get(&1).unwrap();
        if let Ok(Object::Dictionary(p)) = doc.get_object_mut(page) {
            if let Ok(Object::Dictionary(res)) = p.get_mut(b"Resources") {
                if let Ok(Object::Dictionary(fonts)) = res.get_mut(b"Font") {
                    fonts.set("F2", Object::Reference(cff));
                }
            }
        }
        doc.save(&src).unwrap();

        let mut p = params();
        p.font_subset = true;
        let e = compress_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), &p).unwrap_err();
        assert!(matches!(e, CoreError::Unsupported(_)), "{e}");
        assert_eq!(content_rewrite_op(&e), Some("compress_subset"), "{e}");
        assert!(!dst.exists());
    }

    /// 内容ストリームが壊れた Flate (lopdf は Err にせず、欠けた内容を返す) なら、欠けたまま
    /// 書き直さず、clean / sanitize の失敗として Unsupported (MuPDF へフォールバック) にする。
    #[test]
    fn clean_with_a_damaged_content_stream_falls_back() {
        for (kind, broken) in crate::image_recompress::broken_content_streams() {
            let dir = tempfile::tempdir().unwrap();
            let src = dir.path().join("in.pdf");
            let dst = dir.path().join("out.pdf");
            let mut doc = Document::with_version("1.5");
            let pages_id = doc.new_object_id();
            let c = doc.add_object(broken);
            let page_id = doc.add_object(dictionary! {
                "Type" => "Page", "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
                "Contents" => c, "Resources" => dictionary! {},
            });
            doc.objects.insert(
                pages_id,
                Object::Dictionary(dictionary! {
                    "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
                }),
            );
            let catalog_id =
                doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
            doc.trailer.set("Root", catalog_id);
            doc.save(&src).unwrap();

            for (clean, sanitize, op) in [
                (true, false, "compress_clean"),
                (false, true, "compress_sanitize"),
                (true, true, "compress_clean"),
            ] {
                let mut p = params();
                p.clean = clean;
                p.sanitize = sanitize;
                let e = compress_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), &p)
                    .unwrap_err();
                assert_eq!(content_rewrite_op(&e), Some(op), "{kind}: {e}");
                assert!(!dst.exists());
            }
        }
    }

    #[test]
    fn clean_off_keeps_split_contents() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.pdf");
        let dst = dir.path().join("out.pdf");
        split_contents_sample(&src);
        let stats =
            compress_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), &params()).unwrap();
        assert_eq!(stats.cleaned_streams, 0);
        let doc = Document::load(&dst).unwrap();
        let page_id = *doc.get_pages().get(&1).unwrap();
        assert_eq!(doc.get_page_contents(page_id).len(), 2);
    }

    #[test]
    fn clean_with_unparsable_content_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.pdf");
        let dst = dir.path().join("out.pdf");
        // sample() の内容ストリームを、閉じていない文字列に差し替える
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let c = doc.add_object(Stream::new(dictionary! {}, b"BT (abc Tj ET".to_vec()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Contents" => c, "Resources" => dictionary! {},
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        doc.save(&src).unwrap();
        let mut p = params();
        p.clean = true;
        let e = compress_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), &p).unwrap_err();
        assert!(matches!(e, CoreError::Unsupported(_)), "{e}");
        assert_eq!(
            content_rewrite_op(&e),
            Some("compress_clean"),
            "clean failure must be reported as such: {e}"
        );
        assert!(!dst.exists());
        // clean を指定せず sanitize だけのときは、sanitize の失敗として報告する
        let mut p = params();
        p.sanitize = true;
        let e = compress_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), &p).unwrap_err();
        assert_eq!(content_rewrite_op(&e), Some("compress_sanitize"), "{e}");
        // 両方のときは clean が先
        p.clean = true;
        let e = compress_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), &p).unwrap_err();
        assert_eq!(content_rewrite_op(&e), Some("compress_clean"), "{e}");
        assert!(!dst.exists());
    }

    /// 無駄な演算子を含むページを持つ PDF
    fn wasteful_sample(path: &std::path::Path) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let c = doc.add_object(Stream::new(
            dictionary! {},
            b"1 0 0 1 0 0 cm 1 w 2 w q 3 w Q q 0 0 10 10 re f 5 w Q BT ET".to_vec(),
        ));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Contents" => c, "Resources" => dictionary! {},
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        doc.save(path).unwrap();
    }

    fn page_ops(path: &std::path::Path) -> Vec<String> {
        let doc = Document::load(path).unwrap();
        let page_id = *doc.get_pages().get(&1).unwrap();
        lopdf::content::Content::decode_strict(&doc.get_page_content(page_id))
            .unwrap()
            .operations
            .into_iter()
            .map(|o| o.operator)
            .collect()
    }

    /// sanitize だけでも内容を書き直し (MuPDF と同じ)、無駄な演算子を取り除く。
    /// clean だけのときは演算子を取り除かない。
    #[test]
    fn sanitize_rewrites_content_and_drops_useless_ops() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.pdf");
        let dst = dir.path().join("out.pdf");
        wasteful_sample(&src);

        let mut p = params();
        p.sanitize = true;
        let stats = compress_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), &p).unwrap();
        assert_eq!(stats.cleaned_streams, 1, "{stats:?}");
        // cm(単位) / 上書きされる w / 空の q Q / q..w..Q の w / 空の BT ET
        assert_eq!(stats.sanitized_ops, 8, "{stats:?}");
        assert_eq!(page_ops(&dst), ["w", "q", "re", "f", "Q"]);

        let mut p = params();
        p.clean = true;
        let stats = compress_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), &p).unwrap();
        assert_eq!(stats.sanitized_ops, 0);
        assert_eq!(page_ops(&dst).len(), 13);
    }

    #[test]
    fn unsupported_options_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.pdf");
        let dst = dir.path().join("out.pdf");
        sample(&src);
        for tweak in [|p: &mut Params| p.merge_fonts = true] {
            let mut p = params();
            tweak(&mut p);
            let e =
                compress_with_lopdf(src.to_str().unwrap(), dst.to_str().unwrap(), &p).unwrap_err();
            assert!(matches!(e, CoreError::Unsupported(_)), "{e}");
            // merge_fonts の未対応は、clean / sanitize が原因ではない
            assert_eq!(content_rewrite_op(&e), None, "{e}");
        }
        assert!(!dst.exists());
    }
}
