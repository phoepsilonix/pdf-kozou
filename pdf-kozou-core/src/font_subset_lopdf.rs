// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/font_subset_lopdf.rs
// TrueType の CID フォント (font_usage が適格と判定したもの) を、使われているグリフだけに縮める。
//
// `subsetter` は PDF 向けで、グリフ番号を 0 から詰め直し (.notdef が 0)、cmap を含む不要な
// テーブルを取り除く。内容ストリームの文字コード (CID) は変えずに済むよう、旧 CID → 新グリフ番号の
// /CIDToGIDMap ストリームを付ける (CIDFontType2 の仕様どおり)。これにより、内容ストリーム、
// /W (幅)、/DW、ToUnicode は書き換えなくてよい。
//
// 書き換えるもの:
//   - /FontFile2 のストリーム: サブセット化したフォントプログラム (/Length1 も更新)
//   - CIDFont の /CIDToGIDMap: 新しいストリーム (元がストリームなら、古いものは未参照になる)
//   - FontDescriptor の /CIDSet (あれば): 使われている CID だけのビットマップに作り直す
// サブセット化したフォントが元より小さくならないときは、何も変えない。
//
// BaseFont の名前には、サブセット接頭辞 (ABCDEF+) を付けない (MuPDF のサブセット化と同じ)。

use crate::font_usage::{CidFontUsage, CidToGid};
use crate::image_recompress::stream_bytes;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use std::collections::BTreeSet;

/// サブセット化の結果
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct SubsetOutcome {
    /// サブセット化したフォントの数
    pub fonts: usize,
    /// 減ったフォントプログラムのバイト数 (展開後)
    pub bytes_saved: usize,
}

/// 1 つのフォントを縮めた結果
#[derive(Debug)]
pub(crate) struct SubsetFont {
    /// サブセット化したフォントプログラム
    pub font: Vec<u8>,
    /// 新しい /CIDToGIDMap のストリームの中身 (旧 CID → 新グリフ番号、2 バイトずつ)
    pub cid_to_gid: Vec<u8>,
}

/// sfnt の maxp テーブルのグリフ数
fn num_glyphs(font: &[u8]) -> Option<u16> {
    let num_tables = u16::from_be_bytes(font.get(4..6)?.try_into().ok()?) as usize;
    for i in 0..num_tables {
        let rec = font.get(12 + i * 16..12 + i * 16 + 16)?;
        if &rec[0..4] == b"maxp" {
            let offset = u32::from_be_bytes(rec[8..12].try_into().ok()?) as usize;
            return Some(u16::from_be_bytes(
                font.get(offset + 4..offset + 6)?.try_into().ok()?,
            ));
        }
    }
    None
}

/// `cids` で使われるグリフだけに、フォント `font` を縮める。
/// `map` は元の CID → グリフ番号。グリフ番号がフォントの範囲外の CID は、.notdef (0) に対応付ける。
pub(crate) fn subset_cid_font(
    font: &[u8],
    cids: &BTreeSet<u16>,
    map: &CidToGid,
) -> Result<SubsetFont, String> {
    let n = num_glyphs(font).ok_or("font has no maxp table")?;
    let mut remapper = subsetter::GlyphRemapper::new();
    let mut pairs: Vec<(u16, u16)> = Vec::with_capacity(cids.len());
    for &cid in cids {
        let old = map.gid(cid);
        let new = if old == 0 || old >= n {
            0
        } else {
            remapper.remap(old)
        };
        pairs.push((cid, new));
    }
    let font = subsetter::subset(font, 0, &remapper).map_err(|e| format!("subsetter: {e}"))?;

    let max_cid = cids.last().copied().unwrap_or(0) as usize;
    let mut cid_to_gid = vec![0u8; 2 * (max_cid + 1)];
    for (cid, new) in pairs {
        cid_to_gid[2 * cid as usize..2 * cid as usize + 2].copy_from_slice(&new.to_be_bytes());
    }
    Ok(SubsetFont { font, cid_to_gid })
}

/// /CIDSet のビットマップ (CID i は、先頭から i / 8 バイト目の上位 (i % 8) ビット目)。
/// CID 0 (.notdef) は常に含む。
fn cid_set_bitmap(cids: &BTreeSet<u16>) -> Vec<u8> {
    let max = cids.last().copied().unwrap_or(0) as usize;
    let mut bits = vec![0u8; max / 8 + 1];
    bits[0] |= 0x80;
    for &c in cids {
        bits[c as usize / 8] |= 0x80 >> (c % 8);
    }
    bits
}

/// CIDFont の FontDescriptor に /CIDSet があれば、使われている CID だけのものに作り直す。
fn rewrite_cid_set(doc: &mut Document, cid_font: ObjectId, cids: &BTreeSet<u16>) {
    let desc = match doc.get_object(cid_font) {
        Ok(Object::Dictionary(cf)) => cf.get(b"FontDescriptor").ok().cloned(),
        _ => None,
    };
    let has_cid_set = |d: &Dictionary| d.has(b"CIDSet");
    let bitmap = cid_set_bitmap(cids);
    match desc {
        Some(Object::Reference(id)) => {
            if matches!(doc.get_object(id), Ok(Object::Dictionary(d)) if has_cid_set(d)) {
                let new = doc.add_object(Stream::new(Dictionary::new(), bitmap));
                if let Ok(Object::Dictionary(d)) = doc.get_object_mut(id) {
                    d.set("CIDSet", Object::Reference(new));
                }
            }
        }
        Some(Object::Dictionary(d)) if has_cid_set(&d) => {
            let new = doc.add_object(Stream::new(Dictionary::new(), bitmap));
            if let Ok(Object::Dictionary(cf)) = doc.get_object_mut(cid_font) {
                if let Ok(Object::Dictionary(d)) = cf.get_mut(b"FontDescriptor") {
                    d.set("CIDSet", Object::Reference(new));
                }
            }
        }
        _ => {}
    }
}

/// `usages` のフォントを縮めて、文書に書き戻す。
pub(crate) fn subset_fonts(
    doc: &mut Document,
    usages: &[CidFontUsage],
) -> Result<SubsetOutcome, String> {
    let mut outcome = SubsetOutcome::default();
    for u in usages {
        let ff = u.info.font_file;
        let original = match doc.objects.get(&ff) {
            Some(Object::Stream(s)) => {
                stream_bytes(s).map_err(|e| format!("FontFile2 {ff:?}: {e}"))?
            }
            _ => continue,
        };
        let sub = subset_cid_font(&original, &u.cids, &u.info.cid_to_gid)
            .map_err(|e| format!("FontFile2 {ff:?}: {e}"))?;
        if sub.font.len() >= original.len() {
            continue; // 小さくならないので、そのままにする
        }
        outcome.bytes_saved += original.len() - sub.font.len();
        if let Some(Object::Stream(s)) = doc.objects.get_mut(&ff) {
            s.dict
                .set("Length1", Object::Integer(sub.font.len() as i64));
            s.set_plain_content(sub.font);
        }
        let map_id = doc.add_object(Stream::new(Dictionary::new(), sub.cid_to_gid));
        if let Ok(Object::Dictionary(cf)) = doc.get_object_mut(u.info.cid_font) {
            cf.set("CIDToGIDMap", Object::Reference(map_id));
        }
        rewrite_cid_set(doc, u.info.cid_font, &u.cids);
        outcome.fonts += 1;
    }
    Ok(outcome)
}

#[cfg(test)]
const MOCK: &[u8] = include_bytes!("test_data/mock_cid.ttf");

/// テスト用: モックフォントを埋め込んだ PDF (文書, FontFile2 の ID, CIDFont の ID)。
/// 内容は `content` (16 進文字列で CID を書く)。
#[cfg(test)]
pub(crate) fn pdf_with_mock_font(content: &str, cid_set: bool) -> (Document, ObjectId, ObjectId) {
    use lopdf::dictionary;
    let mut doc = Document::with_version("1.5");
    let file = doc.add_object(Stream::new(
        dictionary! {"Length1"=>MOCK.len() as i64},
        MOCK.to_vec(),
    ));
    let mut desc = dictionary! {"Type"=>"FontDescriptor","FontName"=>"MockCid","FontFile2"=>file,
    "Flags"=>4,"FontBBox"=>vec![0.into(),(-200).into(),1000.into(),800.into()],
    "ItalicAngle"=>0,"Ascent"=>800,"Descent"=>(-200),"CapHeight"=>700,"StemV"=>80};
    if cid_set {
        let all = doc.add_object(Stream::new(Dictionary::new(), vec![0xFF; 8]));
        desc.set("CIDSet", all);
    }
    let desc = doc.add_object(desc);
    let cid_font = doc.add_object(dictionary! {"Type"=>"Font","Subtype"=>"CIDFontType2",
    "BaseFont"=>"MockCid","FontDescriptor"=>desc,"CIDToGIDMap"=>"Identity","DW"=>500,
    "CIDSystemInfo"=>dictionary!{"Registry"=>Object::string_literal("Adobe"),
        "Ordering"=>Object::string_literal("Identity"),"Supplement"=>0}});
    let type0 = doc.add_object(
        dictionary! {"Type"=>"Font","Subtype"=>"Type0","BaseFont"=>"MockCid",
        "Encoding"=>"Identity-H","DescendantFonts"=>vec![cid_font.into()]},
    );
    let pages_id = doc.new_object_id();
    let c = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
    let page = doc.add_object(dictionary! {"Type"=>"Page","Parent"=>pages_id,
    "MediaBox"=>vec![0.into(),0.into(),200.into(),100.into()],
    "Resources"=>dictionary!{"Font"=>dictionary!{"F1"=>type0}},"Contents"=>c});
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1}),
    );
    let cat = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages_id});
    doc.trailer.set("Root", cat);
    (doc, file, cid_font)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::font_usage::analyze_fonts;
    use ttf_parser::{Face, GlyphId, OutlineBuilder};

    /// アウトラインを文字列に記録する
    #[derive(Default)]
    struct Rec(String);
    impl OutlineBuilder for Rec {
        fn move_to(&mut self, x: f32, y: f32) {
            self.0 += &format!("M{x},{y} ");
        }
        fn line_to(&mut self, x: f32, y: f32) {
            self.0 += &format!("L{x},{y} ");
        }
        fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
            self.0 += &format!("Q{x1},{y1},{x},{y} ");
        }
        fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
            self.0 += &format!("C{x1},{y1},{x2},{y2},{x},{y} ");
        }
        fn close(&mut self) {
            self.0 += "Z ";
        }
    }

    /// グリフの (アウトライン, 送り幅)
    fn glyph(face: &Face, gid: u16) -> (String, Option<u16>) {
        let mut rec = Rec::default();
        face.outline_glyph(GlyphId(gid), &mut rec);
        (rec.0, face.glyph_hor_advance(GlyphId(gid)))
    }

    fn new_gid(map: &[u8], cid: u16) -> u16 {
        let i = 2 * cid as usize;
        u16::from_be_bytes([map[i], map[i + 1]])
    }

    /// 元のフォントのグリフ `old_gid` と、サブセットのフォントの CID `cid` のグリフが同じか
    fn assert_same_glyph(orig: &Face, sub: &Face, map: &[u8], cid: u16, old_gid: u16) {
        let new = new_gid(map, cid);
        assert_ne!(new, 0, "cid {cid} must not map to .notdef");
        let (so, sa) = glyph(sub, new);
        let (oo, oa) = glyph(orig, old_gid);
        assert!(!oo.is_empty(), "the test glyph must have an outline");
        assert_eq!(so, oo, "outline of cid {cid}");
        assert_eq!(sa, oa, "advance of cid {cid}");
    }

    #[test]
    fn identity_map_keeps_outlines_and_advances() {
        let cids = BTreeSet::from([1u16, 9, 30]); // A、合成グリフ I (A と B を使う)、G30
        let sub = subset_cid_font(MOCK, &cids, &CidToGid::Identity).unwrap();
        let (orig, face) = (
            Face::parse(MOCK, 0).unwrap(),
            Face::parse(&sub.font, 0).unwrap(),
        );
        assert!(sub.font.len() < MOCK.len());
        // .notdef + A + I + G30 + I の部品 B
        assert_eq!(face.number_of_glyphs(), 5);
        for cid in [1u16, 9, 30] {
            assert_same_glyph(&orig, &face, &sub.cid_to_gid, cid, cid);
        }
        // 使われていない CID は .notdef
        assert_eq!(new_gid(&sub.cid_to_gid, 0), 0);
        assert_eq!(sub.cid_to_gid.len(), 2 * 31);
    }

    #[test]
    fn explicit_cid_to_gid_map_is_followed() {
        // CID 100 → D (gid 4)、CID 101 → I (gid 9)、CID 102 → 範囲外 (.notdef)
        let mut table = vec![0u16; 103];
        table[100] = 4;
        table[101] = 9;
        table[102] = 500;
        let cids = BTreeSet::from([100u16, 101, 102]);
        let sub = subset_cid_font(MOCK, &cids, &CidToGid::Map(table)).unwrap();
        let (orig, face) = (
            Face::parse(MOCK, 0).unwrap(),
            Face::parse(&sub.font, 0).unwrap(),
        );
        assert_same_glyph(&orig, &face, &sub.cid_to_gid, 100, 4);
        assert_same_glyph(&orig, &face, &sub.cid_to_gid, 101, 9);
        assert_eq!(new_gid(&sub.cid_to_gid, 102), 0);
    }

    #[test]
    fn cid_set_is_a_bitmap_of_the_used_cids() {
        let bits = cid_set_bitmap(&BTreeSet::from([1u16, 9]));
        // CID 0 (.notdef) と CID 1 は 1 バイト目、CID 9 は 2 バイト目の上位 2 ビット目
        assert_eq!(bits, [0b1100_0000, 0b0100_0000]);
    }

    #[test]
    fn subset_fonts_rewrites_the_font_file_the_map_and_the_cidset() {
        let (mut doc, file, cid_font) =
            pdf_with_mock_font("BT /F1 20 Tf 10 10 Td <0001000900 1E> Tj ET", true);
        let analysis = analyze_fonts(&doc);
        assert!(
            analysis.unsupported.is_empty(),
            "{:?}",
            analysis.unsupported
        );
        let out = subset_fonts(&mut doc, &analysis.usable).unwrap();
        assert_eq!(out.fonts, 1);
        assert!(out.bytes_saved > 1000, "{out:?}");

        // フォントファイル: 小さくなり、/Length1 が合い、フィルタは無い
        let Some(Object::Stream(f)) = doc.objects.get(&file) else {
            panic!()
        };
        assert!(f.content.len() < MOCK.len());
        assert_eq!(
            f.dict.get(b"Length1").unwrap().as_i64().unwrap() as usize,
            f.content.len()
        );
        assert!(!f.dict.has(b"Filter"));
        Face::parse(&f.content, 0).expect("subset font parses");

        // CIDToGIDMap はストリーム、CIDSet は使われている CID (0, 1, 9, 30) だけ
        let cf = doc.get_object(cid_font).unwrap().as_dict().unwrap();
        let Ok(Object::Reference(map)) = cf.get(b"CIDToGIDMap") else {
            panic!("not a stream ref")
        };
        let Some(Object::Stream(map)) = doc.objects.get(map) else {
            panic!()
        };
        assert_eq!(map.content.len(), 2 * 31);
        let desc = cf.get(b"FontDescriptor").unwrap().as_reference().unwrap();
        let d = doc.get_object(desc).unwrap().as_dict().unwrap();
        let Ok(Object::Reference(cs)) = d.get(b"CIDSet") else {
            panic!()
        };
        let Some(Object::Stream(cs)) = doc.objects.get(cs) else {
            panic!()
        };
        assert_eq!(cs.content, cid_set_bitmap(&BTreeSet::from([1u16, 9, 30])));
    }

    #[test]
    fn a_font_without_cidset_does_not_get_one() {
        let (mut doc, _, cid_font) = pdf_with_mock_font("BT /F1 20 Tf <0001> Tj ET", false);
        let analysis = analyze_fonts(&doc);
        subset_fonts(&mut doc, &analysis.usable).unwrap();
        let cf = doc.get_object(cid_font).unwrap().as_dict().unwrap();
        let desc = cf.get(b"FontDescriptor").unwrap().as_reference().unwrap();
        assert!(
            !doc.get_object(desc)
                .unwrap()
                .as_dict()
                .unwrap()
                .has(b"CIDSet")
        );
    }

    #[test]
    fn a_font_that_does_not_shrink_is_left_alone() {
        let (mut doc, file, cid_font) = pdf_with_mock_font("BT /F1 20 Tf <0001> Tj ET", false);
        // 縮めても小さくならない (すでにごく小さいフォント) 場合を、元の内容を差し替えて作る
        let tiny = {
            let cids = BTreeSet::from([1u16]);
            subset_cid_font(MOCK, &cids, &CidToGid::Identity)
                .unwrap()
                .font
        };
        if let Some(Object::Stream(s)) = doc.objects.get_mut(&file) {
            s.set_plain_content(tiny.clone());
        }
        let analysis = analyze_fonts(&doc);
        let out = subset_fonts(&mut doc, &analysis.usable).unwrap();
        assert_eq!(out, SubsetOutcome::default());
        let Some(Object::Stream(f)) = doc.objects.get(&file) else {
            panic!()
        };
        assert_eq!(f.content, tiny);
        let cf = doc.get_object(cid_font).unwrap().as_dict().unwrap();
        assert_eq!(
            cf.get(b"CIDToGIDMap").unwrap(),
            &Object::Name(b"Identity".to_vec())
        );
    }
}
