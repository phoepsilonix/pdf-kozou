// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/imposition.rs
// ベクター保持の面付け（n-up / 見開き製本 / ページサイズ変更）の lopdf 実装。
//
// 各元ページを Form XObject（/Contents をデコードして連結、/Resources は参照のまま共有、
// /BBox は CropBox（無ければ MediaBox））に変換し、出力シートに `q … cm /Xn Do Q` で並べる。
// 元の文書のオブジェクトをそのまま使うので、フォントや画像は複製されず、再エンコードもない。
// 配置の計算は、従来の MuPDF 実装（kozou_compose_imposition_pdf）と同じ式。

use crate::error::{CoreError, Result};
use crate::stext::ComposeImpositionPdfRequest;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use std::collections::HashMap;

/// 変換行列 [a b c d e f]。行ベクトル規約で、concat(A, B) は「A を先に、次に B」。
type Mat = [f32; 6];

fn concat(a: Mat, b: Mat) -> Mat {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

fn translate(x: f32, y: f32) -> Mat {
    [1.0, 0.0, 0.0, 1.0, x, y]
}

fn scale(sx: f32, sy: f32) -> Mat {
    [sx, 0.0, 0.0, sy, 0.0, 0.0]
}

/// ページの箱（継承あり）。配列でなければ None。足りない要素・数値でない要素は 0、
/// (小,小,大,大) に正規化する（MuPDF の pdf_to_rect と同じ）。
fn page_box(doc: &Document, pid: ObjectId, key: &[u8]) -> Option<[f32; 4]> {
    let obj = crate::merge::inherited_attr(doc, pid, key)?;
    let r = crate::info::lp_rect(doc, &obj)?;
    Some([r[0] as f32, r[1] as f32, r[2] as f32, r[3] as f32])
}

fn rect_is_empty(r: &[f32; 4]) -> bool {
    r[2] <= r[0] || r[3] <= r[1]
}

/// 継承された /Rotate を整数で返す（実数は四捨五入。無ければ 0）。
fn page_rotate_raw(doc: &Document, pid: ObjectId) -> i32 {
    let Some(obj) = crate::merge::inherited_attr(doc, pid, b"Rotate") else {
        return 0;
    };
    match crate::info::lp_resolve(doc, &obj) {
        Some(Object::Integer(n)) => *n as i32,
        Some(Object::Real(f)) => f.round() as i32,
        _ => 0,
    }
}

/// 元ページの /Contents（stream または stream の配列）をデコードして 1 つに連結する。
/// 配列のときは各ストリームの後ろに改行を足す（ストリーム境界の区切り）。
fn read_contents(doc: &Document, pid: ObjectId) -> Result<Vec<u8>> {
    let page = doc
        .get_dictionary(pid)
        .map_err(|e| CoreError::Parse(e.to_string()))?;
    let Ok(contents) = page.get(b"Contents") else {
        return Ok(Vec::new());
    };
    let resolved = crate::info::lp_resolve(doc, contents);
    let decode = |obj: &Object| -> Result<Vec<u8>> {
        match crate::info::lp_resolve(doc, obj) {
            Some(Object::Stream(s)) => s
                .decompressed_content()
                .map_err(|e| CoreError::Parse(format!("page contents: {e}"))),
            _ => Ok(Vec::new()),
        }
    };
    let mut out = Vec::new();
    match resolved {
        Some(Object::Array(a)) => {
            for item in a {
                out.extend(decode(item)?);
                out.push(b'\n');
            }
        }
        Some(Object::Stream(_)) => out.extend(decode(contents)?),
        _ => {}
    }
    Ok(out)
}

/// 元ページを Form XObject にして文書へ追加し、その ID と BBox を返す。
fn page_to_xobject(doc: &mut Document, pid: ObjectId) -> Result<(ObjectId, [f32; 4])> {
    // BBox は CropBox（配列なら）、無ければ MediaBox（配列なら）、どちらも無ければ A4。
    // MediaBox との交差は取らない（従来どおり）。
    let bbox = page_box(doc, pid, b"CropBox")
        .or_else(|| page_box(doc, pid, b"MediaBox"))
        .unwrap_or([0.0, 0.0, 595.0, 842.0]);

    // 元ページの /Resources は参照のまま共有する（直書きなら辞書をそのまま持つ）
    let resources = crate::merge::inherited_attr(doc, pid, b"Resources")
        .unwrap_or_else(|| Object::Dictionary(Dictionary::new()));
    let content = read_contents(doc, pid)?;

    let mut dict = Dictionary::new();
    dict.set("Type", "XObject");
    dict.set("Subtype", "Form");
    dict.set(
        "BBox",
        Object::Array(bbox.iter().map(|&v| Object::Real(v)).collect()),
    );
    dict.set("Resources", resources);
    let id = doc.add_object(Object::Stream(Stream::new(dict, content)));
    Ok((id, bbox))
}

/// ベクター保持の面付けを lopdf で行い、`req.output` に書き出す。
/// 読めない入力・暗号化は Parse エラー（呼び出し側で MuPDF 実装へフォールバック）。
pub(crate) fn compose_with_lopdf(req: &ComposeImpositionPdfRequest) -> Result<()> {
    let (mut doc, _) = crate::safe_load::load_checked(&req.input)?;
    if doc.is_encrypted() {
        return Err(CoreError::Parse(format!("{}: encrypted PDF", req.input)));
    }
    let page_ids: Vec<ObjectId> = doc.get_pages().into_values().collect();
    if page_ids.is_empty() {
        return Err(CoreError::Parse(format!("{}: no pages", req.input)));
    }
    let page_count = page_ids.len() as i32;

    let cols = req.cols.max(1);
    let rows = req.rows.max(1);
    let (target_w, target_h) = (req.target_w, req.target_h);
    let gutter = req.gutter.unwrap_or(0.0).max(0.0);
    let margin = req.margin.unwrap_or(0.0).max(0.0);
    let auto_orient = req.auto_orient.unwrap_or(false);
    let per = (cols * rows) as usize;

    // 入力のメタデータ(/Info)は出力に継承する
    let metadata = crate::compress::metadata_from_doc(&doc);

    // 新しい Pages ノードの ID を先に確保する（シートの /Parent に使う）
    let pages_id = doc.new_object_id();
    let mut xcache: HashMap<usize, (ObjectId, [f32; 4])> = HashMap::new();
    let mut sheet_ids: Vec<ObjectId> = Vec::new();

    for s in 0..req.n_sheets.max(0) as usize {
        // このシートの出力サイズ。auto_orient かつ 1 ページ面付けのときは、ページの
        // 表示上の向き（/Rotate 適用後）にシートの向きを合わせる。
        let (mut tw, mut th) = (target_w, target_h);
        if auto_orient && per == 1 {
            let pno0 = req.sheet_pages[s] - 1;
            if pno0 >= 0 && pno0 < page_count {
                let pid = page_ids[pno0 as usize];
                let mut pcb = page_box(&doc, pid, b"CropBox").unwrap_or([0.0; 4]);
                if rect_is_empty(&pcb) {
                    pcb = page_box(&doc, pid, b"MediaBox").unwrap_or([0.0; 4]);
                }
                let prot = page_rotate_raw(&doc, pid).rem_euclid(360);
                let (pw, ph) = (pcb[2] - pcb[0], pcb[3] - pcb[1]);
                let page_landscape = if prot == 90 || prot == 270 { ph > pw } else { pw > ph };
                let (big, small) = if tw > th { (tw, th) } else { (th, tw) };
                if page_landscape {
                    (tw, th) = (big, small);
                } else {
                    (tw, th) = (small, big);
                }
            }
        }
        let avail_w = tw - 2.0 * margin - (cols - 1) as f32 * gutter;
        let avail_h = th - 2.0 * margin - (rows - 1) as f32 * gutter;
        if avail_w <= 1.0 || avail_h <= 1.0 {
            return Err(CoreError::InvalidArg(
                "margins/gutter too large for target size".into(),
            ));
        }
        let cell_w = avail_w / cols as f32;
        let cell_h = avail_h / rows as f32;

        let mut content = String::new();
        let mut xdict = Dictionary::new();
        let mut placed = 0usize;
        for c in 0..per {
            let pno = req.sheet_pages[s * per + c] - 1; // 0 始まり, -1 = 空白
            if pno < 0 || pno >= page_count {
                continue;
            }
            let pno = pno as usize;
            let pid = page_ids[pno];
            let (xobj, bb) = match xcache.get(&pno) {
                Some(v) => *v,
                None => {
                    let v = page_to_xobject(&mut doc, pid)?;
                    xcache.insert(pno, v);
                    v
                }
            };
            let (bw, bh) = (bb[2] - bb[0], bb[3] - bb[1]);
            if bw <= 0.0 || bh <= 0.0 {
                continue;
            }

            // 元ページの /Rotate を表示向きとして行列に織り込む（直交以外は無視）
            let mut rot = page_rotate_raw(&doc, pid).rem_euclid(360);
            if rot % 90 != 0 {
                rot = 0;
            }
            // 表示上(回転後)の寸法。90/270 は縦横入れ替え。
            let (vw, vh) = if rot == 90 || rot == 270 { (bh, bw) } else { (bw, bh) };

            let (col, row) = ((c as i32 % cols) as f32, (c as i32 / cols) as f32);
            let cell_x = margin + col * (cell_w + gutter);
            // PDF は左下原点・Y 上向き。row 0 を上端に配置する。
            let cell_top_y = th - margin - row * (cell_h + gutter);
            let cell_bot_y = cell_top_y - cell_h;

            let (sx, sy) = (cell_w / vw, cell_h / vh);
            let sc = sx.min(sy);
            let (pw, ph) = (vw * sc, vh * sc);
            let off_x = cell_x + (cell_w - pw) * 0.5;
            let off_y = cell_bot_y + (cell_h - ph) * 0.5;

            // 未回転ボックス(原点シフト後 0..bw, 0..bh)を、原点起点・寸法 vw×vh の
            // 回転後ボックスへ写す行列。/Rotate は時計回り。
            let rotm: Mat = match rot {
                90 => [0.0, -1.0, 1.0, 0.0, 0.0, bw],
                180 => [-1.0, 0.0, 0.0, -1.0, bw, bh],
                270 => [0.0, 1.0, -1.0, 0.0, bh, 0.0],
                _ => [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            };
            // m = T(-bb.x0,-bb.y0) → rotm → S(scale) → T(offX,offY)
            let mut m = translate(-bb[0], -bb[1]);
            m = concat(m, rotm);
            m = concat(m, scale(sc, sc));
            m = concat(m, translate(off_x, off_y));

            let name = format!("X{placed}");
            xdict.set(name.as_str(), Object::Reference(xobj));
            content.push_str(&format!(
                "q {} {} {} {} {} {} cm /{} Do Q\n",
                m[0], m[1], m[2], m[3], m[4], m[5], name
            ));
            placed += 1;
        }

        let mut res = Dictionary::new();
        res.set("XObject", Object::Dictionary(xdict));
        let content_id = doc.add_object(Object::Stream(Stream::new(
            Dictionary::new(),
            content.into_bytes(),
        )));
        let mut page = Dictionary::new();
        page.set("Type", "Page");
        page.set("Parent", Object::Reference(pages_id));
        page.set(
            "MediaBox",
            Object::Array(vec![
                Object::Real(0.0),
                Object::Real(0.0),
                Object::Real(tw),
                Object::Real(th),
            ]),
        );
        page.set("Resources", Object::Dictionary(res));
        page.set("Contents", Object::Reference(content_id));
        sheet_ids.push(doc.add_object(Object::Dictionary(page)));
        eprintln!(
            "[compose] sheet {}/{}: placed {placed} cells (lopdf)",
            s + 1,
            req.n_sheets
        );
    }

    // 新しい文書: 元の文書のオブジェクトをそのまま引き継ぎ、ページツリーだけ作り直す。
    // 元のページ・しおり等は到達不能になるので prune で落ちる。
    let mut dst = Document::with_version(doc.version.clone());
    dst.objects = std::mem::take(&mut doc.objects);
    dst.max_id = doc.max_id;

    let kids: Vec<Object> = sheet_ids.iter().map(|&i| Object::Reference(i)).collect();
    let mut pages = Dictionary::new();
    pages.set("Type", "Pages");
    pages.set("Count", kids.len() as i64);
    pages.set("Kids", Object::Array(kids));
    dst.objects.insert(pages_id, Object::Dictionary(pages));
    let mut catalog = Dictionary::new();
    catalog.set("Type", "Catalog");
    catalog.set("Pages", Object::Reference(pages_id));
    let catalog_id = dst.add_object(Object::Dictionary(catalog));
    dst.trailer.set("Root", Object::Reference(catalog_id));
    crate::compress::set_info_on_doc(&mut dst, &metadata);

    dst.prune_objects();
    dst.compress();
    dst.save(&req.output)
        .map_err(|e| CoreError::Parse(format!("{}: {e}", req.output)))?;
    Ok(())
}
