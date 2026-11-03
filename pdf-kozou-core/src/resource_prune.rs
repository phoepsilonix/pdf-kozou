// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/resource_prune.rs
// 内容ストリームが実際に使っているリソースだけを残して、/Resources を作り直す。
// MuPDF の clean / sanitize (内容ストリームを解釈し直して書き出す処理) は、リソースを
// 「使われたものだけ」で作り直すので、その lopdf 実装。
//
// 対象 (「持ち主」) は、ページ、自前の /Resources を持つ Form XObject、タイリングパターン。
// 持ち主ごとに、内容ストリームの演算子から使われている名前を集める:
//   Tf → Font / Do → XObject / gs → ExtGState / sh → Shading / cs, CS → ColorSpace /
//   scn, SCN の最後の名前 → Pattern / BDC, DP の 2 番目の名前 → Properties
// 使われていない名前を /Resources から外す。ページ間で共有されていた /Resources は、ページごとの
// 新しい辞書に分かれる (共有しているオブジェクトそのものは書き換えない)。外すものが無い持ち主は
// 何も変えない (共有のまま)。外した結果、どこからも参照されなくなったオブジェクト (使われない画像・
// フォントなど) は、そのあとの prune で取り除かれる。
//
// 名前を確実に集められない持ち主は、何も外さない (安全側):
//   - 内容ストリームを最後まで読めない・解析できない
//   - 自前の /Resources を持たない Form XObject を使っている場合は、その中の名前も使用とみなす
//     (呼び出し側のリソースを引き継ぐため)。深すぎる入れ子は諦める
//   - /Resources を持たない Type3 フォント・タイリングパターン・SMask グループを使っている
//     (文字定義や描画が、呼び出し側のリソースを引き継ぐ)
//   - /AP に /Resources を持たない外観ストリームがある注釈を持つページ
//   - 名前だけで ColorSpace を指す画像 (非デバイスの色空間名)・インライン画像がある場合は、
//     ColorSpace だけは外さない。DefaultGray / DefaultRGB / DefaultCMYK は常に残す。
//   - Properties 以外の未知のカテゴリ (ProcSet など) は、そのまま残す

use crate::content_filter::{decode_content, find_inline_images};
use crate::image_recompress::content_stream_bytes;
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::collections::HashSet;

/// 名前で参照されるカテゴリ (ColorSpace は条件付きなので別に扱う)
const NAMED_CATEGORIES: [&[u8]; 6] = [
    b"Font",
    b"XObject",
    b"ExtGState",
    b"Pattern",
    b"Shading",
    b"Properties",
];

#[derive(Default)]
struct Used {
    font: HashSet<Vec<u8>>,
    xobject: HashSet<Vec<u8>>,
    extgstate: HashSet<Vec<u8>>,
    colorspace: HashSet<Vec<u8>>,
    pattern: HashSet<Vec<u8>>,
    shading: HashSet<Vec<u8>>,
    properties: HashSet<Vec<u8>>,
    /// インライン画像がある (色空間を名前で指しうる)
    inline_image: bool,
    /// 名前で色空間を指す画像 XObject を使っている
    named_cs_image: bool,
    /// 名前を確実に集められなかった (何も外さない)
    unprunable: bool,
}

impl Used {
    fn set(&self, category: &[u8]) -> Option<&HashSet<Vec<u8>>> {
        Some(match category {
            b"Font" => &self.font,
            b"XObject" => &self.xobject,
            b"ExtGState" => &self.extgstate,
            b"ColorSpace" => &self.colorspace,
            b"Pattern" => &self.pattern,
            b"Shading" => &self.shading,
            b"Properties" => &self.properties,
            _ => return None,
        })
    }
}

/// 内容ストリームの演算子から、使われている名前を集める。
fn collect(bytes: &[u8], used: &mut Used) -> Result<(), String> {
    let images = find_inline_images(bytes)?;
    let mut pos = 0usize;
    for (start, end) in images
        .iter()
        .copied()
        .chain(std::iter::once((bytes.len(), bytes.len())))
    {
        if start > pos {
            let content = decode_content(&bytes[pos..start]).map_err(|e| e.to_string())?;
            for op in &content.operations {
                let name = |i: usize| match op.operands.get(i) {
                    Some(Object::Name(n)) => Some(n.clone()),
                    _ => None,
                };
                match op.operator.as_str() {
                    "Tf" => used.font.extend(name(0)),
                    "Do" => used.xobject.extend(name(0)),
                    "gs" => used.extgstate.extend(name(0)),
                    "sh" => used.shading.extend(name(0)),
                    "cs" | "CS" => used.colorspace.extend(name(0)),
                    "scn" | "SCN" => {
                        if let Some(Object::Name(n)) = op.operands.last() {
                            used.pattern.insert(n.clone());
                        }
                    }
                    "BDC" | "DP" => used.properties.extend(name(1)),
                    _ => {}
                }
            }
        }
        if end > start {
            used.inline_image = true;
        }
        pos = end;
    }
    Ok(())
}

fn dict_of(doc: &Document, obj: &Object) -> Option<Dictionary> {
    let (_, o) = doc.dereference(obj).ok()?;
    match o {
        Object::Dictionary(d) => Some(d.clone()),
        Object::Stream(s) => Some(s.dict.clone()),
        _ => None,
    }
}

/// `resources` の `category` 辞書から `name` が指すオブジェクトの (参照先の ID, 辞書, ストリームか)。
/// ストリームの中身 (画像データなど) は複製しない。
fn lookup(
    doc: &Document,
    resources: &Dictionary,
    category: &[u8],
    name: &[u8],
) -> Option<(Option<ObjectId>, Dictionary, bool)> {
    let cat = dict_of(doc, resources.get(category).ok()?)?;
    let value = cat.get(name).ok()?;
    let id = match value {
        Object::Reference(id) => Some(*id),
        _ => None,
    };
    let (_, o) = doc.dereference(value).ok()?;
    match o {
        Object::Dictionary(d) => Some((id, d.clone(), false)),
        Object::Stream(s) => Some((id, s.dict.clone(), true)),
        _ => None,
    }
}

fn is_device_cs_name(n: &[u8]) -> bool {
    matches!(
        n,
        b"DeviceGray" | b"DeviceRGB" | b"DeviceCMYK" | b"Pattern" | b"G" | b"RGB" | b"CMYK"
    )
}

/// `bytes` (`resources` の下で描かれる内容) が使っている名前を `used` に集める。
/// 自前の /Resources を持たない Form XObject は呼び出し側のリソースを引き継ぐので、
/// その内容も同じ `resources` で集める。
fn scan(
    doc: &Document,
    bytes: &[u8],
    resources: &Dictionary,
    used: &mut Used,
    visiting: &mut HashSet<ObjectId>,
    depth: u32,
) {
    if depth > 12 {
        used.unprunable = true;
        return;
    }
    let mut local = Used::default();
    if collect(bytes, &mut local).is_err() {
        used.unprunable = true;
        return;
    }
    used.inline_image |= local.inline_image;

    // フォント: /Resources を持たない Type3 は、文字定義が呼び出し側のリソースを引き継ぐ
    for name in &local.font {
        if let Some((_, d, _)) = lookup(doc, resources, b"Font", name) {
            let type3 = d.get(b"Subtype").ok().and_then(|x| x.as_name().ok()) == Some(b"Type3");
            if type3 && !d.has(b"Resources") {
                used.unprunable = true;
            }
        }
    }
    // パターン: /Resources を持たないタイリングパターンは、呼び出し側のリソースを引き継ぐ
    for name in &local.pattern {
        if let Some((_, d, true)) = lookup(doc, resources, b"Pattern", name) {
            if !d.has(b"Resources") {
                used.unprunable = true;
            }
        }
    }
    // ExtGState: /Resources を持たない SMask グループも同様
    for name in &local.extgstate {
        if let Some((_, d, _)) = lookup(doc, resources, b"ExtGState", name) {
            let group = d
                .get(b"SMask")
                .ok()
                .and_then(|m| dict_of(doc, m))
                .and_then(|m| m.get(b"G").ok().cloned());
            if let Some(g) = group {
                if let Ok((_, Object::Stream(gs))) = doc.dereference(&g) {
                    if !gs.dict.has(b"Resources") {
                        used.unprunable = true;
                    }
                }
            }
        }
    }
    // XObject: 名前で色空間を指す画像がないか。自前の /Resources を持たない Form は中も調べる
    for name in &local.xobject {
        let Some((id, d, true)) = lookup(doc, resources, b"XObject", name) else {
            continue;
        };
        let subtype = d.get(b"Subtype").ok().and_then(|o| o.as_name().ok());
        if subtype == Some(b"Image") {
            if let Ok(Object::Name(n)) = d.get(b"ColorSpace") {
                if !is_device_cs_name(n) {
                    used.named_cs_image = true;
                }
            }
        } else if subtype == Some(b"Form") && !d.has(b"Resources") {
            // 呼び出し側のリソースを引き継ぐ Form。中で使われる名前も、この持ち主の使用とみなす
            let Some(id) = id else {
                used.unprunable = true;
                continue;
            };
            if !visiting.insert(id) {
                continue;
            }
            match doc.objects.get(&id) {
                Some(Object::Stream(s)) => match content_stream_bytes(s) {
                    Ok(inner) => scan(doc, &inner, resources, used, visiting, depth + 1),
                    Err(_) => used.unprunable = true,
                },
                _ => used.unprunable = true,
            }
            visiting.remove(&id);
        }
    }

    used.font.extend(local.font);
    used.xobject.extend(local.xobject);
    used.extgstate.extend(local.extgstate);
    used.colorspace.extend(local.colorspace);
    used.pattern.extend(local.pattern);
    used.shading.extend(local.shading);
    used.properties.extend(local.properties);
}

/// 使われていないエントリを外した /Resources。外すものが無ければ None。
fn pruned(doc: &Document, resources: &Dictionary, used: &Used) -> Option<Dictionary> {
    if used.unprunable {
        return None;
    }
    let prune_colorspace = !used.inline_image && !used.named_cs_image;
    let mut out = Dictionary::new();
    let mut changed = false;
    for (key, value) in resources.iter() {
        let is_named = NAMED_CATEGORIES.contains(&key.as_slice());
        let is_cs = key.as_slice() == b"ColorSpace";
        if !(is_named || (is_cs && prune_colorspace)) {
            out.set(key.clone(), value.clone());
            continue;
        }
        let (Some(sub), Some(set)) = (dict_of(doc, value), used.set(key)) else {
            out.set(key.clone(), value.clone());
            continue;
        };
        let mut kept = Dictionary::new();
        for (name, v) in sub.iter() {
            let default_cs = is_cs
                && matches!(
                    name.as_slice(),
                    b"DefaultGray" | b"DefaultRGB" | b"DefaultCMYK"
                );
            if set.contains(name.as_slice()) || default_cs {
                kept.set(name.clone(), v.clone());
            }
        }
        if kept.len() == sub.len() {
            // 何も外さない。共有のまま (参照を保つ)
            out.set(key.clone(), value.clone());
        } else {
            changed = true;
            if !kept.is_empty() {
                out.set(key.clone(), Object::Dictionary(kept));
            }
        }
    }
    changed.then_some(out)
}

/// 効くリソース (ページ自身、なければ /Parent をたどって継承)
fn page_resources(doc: &Document, page_id: ObjectId) -> Option<Dictionary> {
    let mut current = page_id;
    for _ in 0..64 {
        let d = doc.get_object(current).ok()?.as_dict().ok()?;
        if let Ok(res) = d.get(b"Resources") {
            if let Some(r) = dict_of(doc, res) {
                return Some(r);
            }
        }
        match d.get(b"Parent") {
            Ok(Object::Reference(p)) => current = *p,
            _ => return None,
        }
    }
    None
}

/// /AP に /Resources を持たない外観ストリームがある注釈を持つページか。
/// そうした外観は、ページのリソースを使っているかもしれない。
fn has_resourceless_annot_ap(doc: &Document, page_id: ObjectId) -> bool {
    let Ok(page) = doc.get_object(page_id).and_then(|o| o.as_dict()) else {
        return false;
    };
    let Some(Object::Array(annots)) = page
        .get(b"Annots")
        .ok()
        .and_then(|a| doc.dereference(a).ok().map(|(_, o)| o.clone()))
    else {
        return false;
    };
    fn streams_without_resources(doc: &Document, o: &Object, depth: u32) -> bool {
        if depth > 3 {
            return false;
        }
        match doc.dereference(o) {
            Ok((_, Object::Stream(s))) => !s.dict.has(b"Resources"),
            Ok((_, Object::Dictionary(d))) => d
                .iter()
                .any(|(_, v)| streams_without_resources(doc, v, depth + 1)),
            _ => false,
        }
    }
    annots.iter().any(|a| {
        dict_of(doc, a)
            .and_then(|ad| ad.get(b"AP").ok().cloned())
            .is_some_and(|ap| streams_without_resources(doc, &ap, 0))
    })
}

/// 文書内の持ち主 (ページ、Form XObject、タイリングパターン) の /Resources から、使われていない
/// 名前を外す。外した持ち主の数を返す。名前を確実に集められない持ち主は何も変えない。
pub(crate) fn prune_unused_resources(doc: &mut Document) -> usize {
    let mut changed = 0usize;

    // ── ページ ──
    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    for page_id in pages {
        if has_resourceless_annot_ap(doc, page_id) {
            continue;
        }
        let Some(resources) = page_resources(doc, page_id) else {
            continue;
        };
        // 内容 (配列なら連結)。読めない・解析できないページは何も変えない
        let mut bytes: Vec<u8> = Vec::new();
        let mut readable = true;
        for id in doc.get_page_contents(page_id) {
            match doc.get_object(id) {
                Ok(Object::Stream(s)) => match content_stream_bytes(s) {
                    Ok(b) => {
                        bytes.extend(b);
                        bytes.push(b'\n');
                    }
                    Err(_) => readable = false,
                },
                _ => {}
            }
        }
        if !readable {
            continue;
        }
        let mut used = Used::default();
        scan(doc, &bytes, &resources, &mut used, &mut HashSet::new(), 0);
        if let Some(new_res) = pruned(doc, &resources, &used) {
            if let Ok(Object::Dictionary(p)) = doc.get_object_mut(page_id) {
                p.set("Resources", Object::Dictionary(new_res));
                changed += 1;
            }
        }
    }

    // ── 自前の /Resources を持つ Form XObject・タイリングパターン ──
    let owners: Vec<ObjectId> = doc
        .objects
        .iter()
        .filter_map(|(id, o)| match o {
            Object::Stream(s) if s.dict.has(b"Resources") => {
                let form =
                    s.dict.get(b"Subtype").ok().and_then(|x| x.as_name().ok()) == Some(b"Form");
                let tiling = matches!(s.dict.get(b"PatternType"), Ok(Object::Integer(1)));
                (form || tiling).then_some(*id)
            }
            _ => None,
        })
        .collect();
    for id in owners {
        let (bytes, resources) = match doc.objects.get(&id) {
            Some(Object::Stream(s)) => {
                let Ok(bytes) = content_stream_bytes(s) else {
                    continue;
                };
                let Some(res) = s.dict.get(b"Resources").ok().and_then(|r| dict_of(doc, r)) else {
                    continue;
                };
                (bytes, res)
            }
            _ => continue,
        };
        let mut used = Used::default();
        scan(
            doc,
            &bytes,
            &resources,
            &mut used,
            &mut HashSet::from([id]),
            0,
        );
        if let Some(new_res) = pruned(doc, &resources, &used) {
            if let Some(Object::Stream(s)) = doc.objects.get_mut(&id) {
                s.dict.set("Resources", Object::Dictionary(new_res));
                changed += 1;
            }
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{Stream, dictionary};

    fn font(doc: &mut Document, name: &str) -> ObjectId {
        doc.add_object(dictionary! {"Type"=>"Font","Subtype"=>"Type1","BaseFont"=>name})
    }

    fn image(doc: &mut Document, cs: Object) -> ObjectId {
        doc.add_object(Stream::new(
            dictionary! {"Type"=>"XObject","Subtype"=>"Image","Width"=>1,"Height"=>1,
            "ColorSpace"=>cs,"BitsPerComponent"=>8},
            vec![0],
        ))
    }

    /// (Resources, 内容) の並びから、ページを持つ文書を作る
    fn make(doc: &mut Document, pages: Vec<(Object, &str)>) -> Vec<ObjectId> {
        let pages_id = doc.new_object_id();
        let mut ids = Vec::new();
        for (res, content) in pages {
            let c = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
            ids.push(doc.add_object(dictionary! {
                "Type"=>"Page","Parent"=>pages_id,
                "MediaBox"=>vec![0.into(),0.into(),100.into(),100.into()],
                "Resources"=>res,"Contents"=>c,
            }));
        }
        let kids: Vec<Object> = ids.iter().map(|i| (*i).into()).collect();
        doc.objects.insert(
            pages_id,
            Object::Dictionary(
                dictionary! {"Type"=>"Pages","Kids"=>kids,"Count"=>ids.len() as i64},
            ),
        );
        let cat = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages_id});
        doc.trailer.set("Root", cat);
        ids
    }

    /// category の中の名前 (整列)
    fn names(doc: &Document, page: ObjectId, category: &str) -> Vec<String> {
        let res = page_resources(doc, page).unwrap();
        let mut v: Vec<String> = res
            .get(category.as_bytes())
            .ok()
            .and_then(|c| dict_of(doc, c))
            .map(|d| {
                d.iter()
                    .map(|(k, _)| String::from_utf8_lossy(k).into_owned())
                    .collect()
            })
            .unwrap_or_default();
        v.sort();
        v
    }

    #[test]
    fn shared_resources_are_split_per_page_without_touching_the_shared_dict() {
        let mut doc = Document::with_version("1.5");
        let (f1, f2, f3) = (
            font(&mut doc, "A"),
            font(&mut doc, "B"),
            font(&mut doc, "C"),
        );
        let (i1, i2) = (
            image(&mut doc, "DeviceGray".into()),
            image(&mut doc, "DeviceGray".into()),
        );
        let shared = doc.add_object(dictionary! {
            "Font"=>dictionary!{"F1"=>f1,"F2"=>f2,"F3"=>f3},
            "XObject"=>dictionary!{"Im1"=>i1,"Im2"=>i2},
            "ProcSet"=>vec!["PDF".into(),"Text".into()],
        });
        let pages = make(
            &mut doc,
            vec![
                (shared.into(), "BT /F1 12 Tf ET /Im1 Do"),
                (shared.into(), "BT /F2 12 Tf ET"),
            ],
        );
        assert_eq!(prune_unused_resources(&mut doc), 2);
        assert_eq!(names(&doc, pages[0], "Font"), ["F1"]);
        assert_eq!(names(&doc, pages[0], "XObject"), ["Im1"]);
        assert_eq!(names(&doc, pages[1], "Font"), ["F2"]);
        assert!(names(&doc, pages[1], "XObject").is_empty());
        // ProcSet など名前で参照しないカテゴリは残す
        assert!(page_resources(&doc, pages[0]).unwrap().has(b"ProcSet"));
        // 共有していた辞書そのものは書き換えない
        let orig = dict_of(&doc, &Object::Reference(shared)).unwrap();
        assert_eq!(dict_of(&doc, orig.get(b"Font").unwrap()).unwrap().len(), 3);
    }

    #[test]
    fn nothing_to_remove_keeps_the_shared_reference() {
        let mut doc = Document::with_version("1.5");
        let f1 = font(&mut doc, "A");
        let shared = doc.add_object(dictionary! {"Font"=>dictionary!{"F1"=>f1}});
        let pages = make(&mut doc, vec![(shared.into(), "BT /F1 12 Tf ET")]);
        assert_eq!(prune_unused_resources(&mut doc), 0);
        let page = doc.get_dictionary(pages[0]).unwrap();
        assert_eq!(page.get(b"Resources").unwrap(), &Object::Reference(shared));
    }

    #[test]
    fn form_without_resources_uses_the_callers_names() {
        let mut doc = Document::with_version("1.5");
        let (f1, f2) = (font(&mut doc, "A"), font(&mut doc, "B"));
        let form = doc.add_object(Stream::new(
            dictionary! {"Type"=>"XObject","Subtype"=>"Form","BBox"=>vec![0.into(),0.into(),1.into(),1.into()]},
            b"BT /F1 12 Tf ET".to_vec(),
        ));
        let res =
            dictionary! {"Font"=>dictionary!{"F1"=>f1,"F2"=>f2},"XObject"=>dictionary!{"Fm"=>form}};
        let pages = make(&mut doc, vec![(res.into(), "/Fm Do")]);
        assert_eq!(prune_unused_resources(&mut doc), 1);
        assert_eq!(names(&doc, pages[0], "Font"), ["F1"]);
        assert_eq!(names(&doc, pages[0], "XObject"), ["Fm"]);
    }

    #[test]
    fn form_with_own_resources_is_pruned_separately() {
        let mut doc = Document::with_version("1.5");
        let (f1, f2) = (font(&mut doc, "A"), font(&mut doc, "B"));
        let form = doc.add_object(Stream::new(
            dictionary! {"Type"=>"XObject","Subtype"=>"Form","BBox"=>vec![0.into(),0.into(),1.into(),1.into()],
                "Resources"=>dictionary!{"Font"=>dictionary!{"A"=>f1,"B"=>f2}}},
            b"BT /A 12 Tf ET".to_vec(),
        ));
        let res = dictionary! {"XObject"=>dictionary!{"Fm"=>form}};
        make(&mut doc, vec![(res.into(), "/Fm Do")]);
        assert_eq!(prune_unused_resources(&mut doc), 1);
        let Some(Object::Stream(s)) = doc.objects.get(&form) else {
            panic!()
        };
        let r = s.dict.get(b"Resources").unwrap().as_dict().unwrap();
        let fonts = r.get(b"Font").unwrap().as_dict().unwrap();
        assert!(fonts.has(b"A") && !fonts.has(b"B"));
    }

    #[test]
    fn type3_without_resources_blocks_pruning() {
        let mut doc = Document::with_version("1.5");
        let t3 = doc.add_object(dictionary! {"Type"=>"Font","Subtype"=>"Type3"});
        let f2 = font(&mut doc, "B");
        let res = dictionary! {"Font"=>dictionary!{"T3"=>t3,"F2"=>f2}};
        let pages = make(&mut doc, vec![(res.into(), "BT /T3 12 Tf ET")]);
        assert_eq!(prune_unused_resources(&mut doc), 0);
        assert_eq!(names(&doc, pages[0], "Font"), ["F2", "T3"]);
    }

    #[test]
    fn pattern_properties_extgstate_and_shading_names_are_found() {
        let mut doc = Document::with_version("1.5");
        let pat = |doc: &mut Document| {
            doc.add_object(Stream::new(
                dictionary! {"PatternType"=>1,"PaintType"=>1,"TilingType"=>1,
                "BBox"=>vec![0.into(),0.into(),1.into(),1.into()],"XStep"=>1,"YStep"=>1,
                "Resources"=>dictionary!{}},
                b"0 0 1 1 re f".to_vec(),
            ))
        };
        let (p1, p2) = (pat(&mut doc), pat(&mut doc));
        let res = dictionary! {
            "Pattern"=>dictionary!{"P1"=>p1,"P2"=>p2},
            "Properties"=>dictionary!{"Pr1"=>dictionary!{},"Pr2"=>dictionary!{}},
            "ExtGState"=>dictionary!{"G1"=>dictionary!{"CA"=>1},"G2"=>dictionary!{"CA"=>0.5}},
            "Shading"=>dictionary!{"S1"=>dictionary!{},"S2"=>dictionary!{}},
        };
        let pages = make(
            &mut doc,
            vec![(
                res.into(),
                "/Pattern cs /P1 scn 0 0 5 5 re f /OC /Pr1 BDC EMC /G1 gs /S1 sh",
            )],
        );
        assert_eq!(prune_unused_resources(&mut doc), 1);
        assert_eq!(names(&doc, pages[0], "Pattern"), ["P1"]);
        assert_eq!(names(&doc, pages[0], "Properties"), ["Pr1"]);
        assert_eq!(names(&doc, pages[0], "ExtGState"), ["G1"]);
        assert_eq!(names(&doc, pages[0], "Shading"), ["S1"]);
    }

    #[test]
    fn colorspace_is_pruned_only_when_names_cannot_hide() {
        let cs = || {
            dictionary! {"ColorSpace"=>dictionary!{
            "Cs1"=>vec!["ICCBased".into()],"Cs2"=>vec!["ICCBased".into()],"DefaultRGB"=>vec!["ICCBased".into()]}}
        };
        // 通常: 使われていない Cs2 は外し、DefaultRGB は残す
        let mut doc = Document::with_version("1.5");
        let pages = make(&mut doc, vec![(cs().into(), "/Cs1 cs 1 scn 0 0 1 1 re f")]);
        assert_eq!(prune_unused_resources(&mut doc), 1);
        assert_eq!(names(&doc, pages[0], "ColorSpace"), ["Cs1", "DefaultRGB"]);
        // インライン画像は色空間を名前で指しうるので、外さない
        let mut doc = Document::with_version("1.5");
        let content = "/Cs1 cs 1 scn BI /W 1 /H 1 /BPC 8 /CS /Cs2 ID \x00 EI";
        let pages = make(&mut doc, vec![(cs().into(), content)]);
        assert_eq!(prune_unused_resources(&mut doc), 0);
        assert_eq!(names(&doc, pages[0], "ColorSpace").len(), 3);
        // 名前で色空間を指す画像 XObject も同様
        let mut doc = Document::with_version("1.5");
        let im = image(&mut doc, "Cs2".into());
        let mut res = cs();
        res.set("XObject", dictionary! {"Im"=>im});
        let pages = make(&mut doc, vec![(res.into(), "/Cs1 cs /Im Do")]);
        assert_eq!(prune_unused_resources(&mut doc), 0);
        assert_eq!(names(&doc, pages[0], "ColorSpace").len(), 3);
    }

    #[test]
    fn unreadable_content_prunes_nothing() {
        let mut doc = Document::with_version("1.5");
        let (f1, f2) = (font(&mut doc, "A"), font(&mut doc, "B"));
        let res = dictionary! {"Font"=>dictionary!{"F1"=>f1,"F2"=>f2}};
        let pages = make(&mut doc, vec![(res.into(), "@@@ BT /F1 12 Tf ET")]);
        assert_eq!(prune_unused_resources(&mut doc), 0);
        assert_eq!(names(&doc, pages[0], "Font"), ["F1", "F2"]);
    }

    #[test]
    fn annotation_appearance_without_resources_blocks_the_page() {
        let mut doc = Document::with_version("1.5");
        let (f1, f2) = (font(&mut doc, "A"), font(&mut doc, "B"));
        let ap = doc.add_object(Stream::new(
            dictionary! {"Type"=>"XObject","Subtype"=>"Form","BBox"=>vec![0.into(),0.into(),1.into(),1.into()]},
            b"BT /F2 12 Tf ET".to_vec(),
        ));
        let annot = doc.add_object(dictionary! {"Type"=>"Annot","Subtype"=>"Widget",
        "Rect"=>vec![0.into(),0.into(),1.into(),1.into()],"AP"=>dictionary!{"N"=>ap}});
        let res = dictionary! {"Font"=>dictionary!{"F1"=>f1,"F2"=>f2}};
        let pages = make(&mut doc, vec![(res.into(), "BT /F1 12 Tf ET")]);
        if let Ok(Object::Dictionary(p)) = doc.get_object_mut(pages[0]) {
            p.set("Annots", vec![Object::Reference(annot)]);
        }
        assert_eq!(prune_unused_resources(&mut doc), 0);
        assert_eq!(names(&doc, pages[0], "Font"), ["F1", "F2"]);
    }

    #[test]
    fn inherited_page_resources_are_made_explicit_only_when_pruned() {
        let mut doc = Document::with_version("1.5");
        let (f1, f2) = (font(&mut doc, "A"), font(&mut doc, "B"));
        let pages = make(&mut doc, vec![(Object::Null, "BT /F1 12 Tf ET")]);
        // ページ自身の /Resources を外し、親 (Pages) に持たせる
        let parent = doc
            .get_dictionary(pages[0])
            .unwrap()
            .get(b"Parent")
            .unwrap()
            .as_reference()
            .unwrap();
        if let Ok(Object::Dictionary(p)) = doc.get_object_mut(pages[0]) {
            p.remove(b"Resources");
        }
        if let Ok(Object::Dictionary(p)) = doc.get_object_mut(parent) {
            p.set(
                "Resources",
                dictionary! {"Font"=>dictionary!{"F1"=>f1,"F2"=>f2}},
            );
        }
        assert_eq!(prune_unused_resources(&mut doc), 1);
        assert_eq!(names(&doc, pages[0], "Font"), ["F1"]);
        // 親の辞書は書き換えない
        let pr = doc
            .get_dictionary(parent)
            .unwrap()
            .get(b"Resources")
            .unwrap()
            .as_dict()
            .unwrap();
        assert_eq!(pr.get(b"Font").unwrap().as_dict().unwrap().len(), 2);
    }
}
