// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/trim.rs
// CropBox によるトリミング

use crate::error::{CoreError, Result};
use serde::Deserializer;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Margins {
    pub left: f32,
    pub right: f32,
    pub bottom: f32,
    pub top: f32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PageSelection {
    All,
    Even,
    Odd,
    Range { pages: Vec<i32> },
    None,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrimRequest {
    pub input: String,
    pub output: String,
    pub margins: Margins,
    /// 余白の単位: "mm" (デフォルト) | "pt" | "cm" | "in"
    #[serde(default = "default_unit")]
    pub unit: String,
    /// どのページにトリミングを適用する対象ページ (None=全ページ)
    #[serde(deserialize_with = "deserialize_pages")]
    pub pages: Option<PageSelection>,
    /// 除外するページを指定 (1始まり, None=対象全ページ適用)
    #[serde(deserialize_with = "deserialize_pages")]
    pub exclude: Option<PageSelection>,
    /// 出力に残すページを指定 (1始まり, None=全ページ保持)
    #[serde(deserialize_with = "deserialize_pages")]
    pub extract: Option<PageSelection>,
    /// CropBox 外の XObject を削除してファイルサイズを削減する（試験的）
    #[serde(default)]
    pub crop_cleanup: bool,
}

fn default_unit() -> String {
    "mm".to_string()
}

fn deserialize_pages<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<PageSelection>, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Value::deserialize(deserializer)?;

    match v {
        Value::Null => Ok(Some(PageSelection::All)),
        Value::String(s) => {
            let s = s.trim().to_lowercase();
            if s.is_empty() || s.is_empty() || s.to_lowercase() == "none" {
                Ok(Some(PageSelection::None))
            } else if s.to_lowercase() == "all" {
                Ok(Some(PageSelection::All))
            } else if s.to_lowercase() == "even" {
                Ok(Some(PageSelection::Even))
            } else if s.to_lowercase() == "odd" {
                Ok(Some(PageSelection::Odd))
            } else {
                // "1,3,5-10" のような文字列を Range に変換
                let mut pages = Vec::new();
                for part in s.split(',') {
                    let part = part.trim();
                    if let Some((a, b)) = part.split_once('-') {
                        let start: i32 = a.trim().parse().map_err(serde::de::Error::custom)?;
                        let end: i32 = b.trim().parse().map_err(serde::de::Error::custom)?;
                        for p in start..=end {
                            pages.push(p);
                        }
                    } else {
                        let p: i32 = part.parse().map_err(serde::de::Error::custom)?;
                        pages.push(p);
                    }
                }
                Ok(Some(PageSelection::Range { pages }))
            }
        }
        Value::Object(obj) => {
            // すでに enum形式の場合（{ "type": "Ranges", "ranges": [[1,3]] }）
            if let Some(ty) = obj.get("type") {
                match ty.as_str() {
                    Some("All") => Ok(Some(PageSelection::All)),
                    Some("Even") => Ok(Some(PageSelection::Even)),
                    Some("Odd") => Ok(Some(PageSelection::Odd)),
                    Some("None") => Ok(Some(PageSelection::None)),
                    Some("Range") => {
                        if let Some(Value::Array(ranges)) = obj.get("ranges") {
                            let mut pages = Vec::new();
                            for r in ranges {
                                if let Value::Array(arr) = r
                                    && arr.len() == 2
                                    && let (Some(Value::Number(s)), Some(Value::Number(e))) =
                                        (arr.first(), arr.get(1))
                                    && let (Some(start), Some(end)) = (s.as_i64(), e.as_i64())
                                {
                                    for p in start..=end {
                                        pages.push((p - 1) as i32); // 1-based → 0-based
                                    }
                                }
                            }
                            Ok(Some(PageSelection::Range { pages }))
                        } else {
                            Err(serde::de::Error::custom("missing or invalid ranges"))
                        }
                    }
                    _ => Err(serde::de::Error::custom("unknown type")),
                }
            } else {
                Err(serde::de::Error::custom("missing type field"))
            }
        }
        _ => Err(serde::de::Error::custom("invalid pages format")),
    }
}

#[derive(Serialize)]
pub struct TrimResponse {
    pub ok: bool,
    pub input_bytes: u64,
    pub output_bytes: u64,
    pub crop_boxes: Vec<CropBoxInfo>,
}

#[derive(Serialize)]
pub struct CropBoxInfo {
    pub page: i32,
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    pub width: f32,
    pub height: f32,
}

/// f32 4値から PDF 配列オブジェクト [a b c d] をインラインで作成
fn make_rect(
    doc: &mupdf::pdf::PdfDocument,
    a: f32,
    b: f32,
    c: f32,
    d: f32,
) -> std::result::Result<mupdf::pdf::PdfObject, mupdf::Error> {
    let mut arr = doc.new_array()?;
    arr.array_push(doc.new_real(a)?)?;
    arr.array_push(doc.new_real(b)?)?;
    arr.array_push(doc.new_real(c)?)?;
    arr.array_push(doc.new_real(d)?)?;
    Ok(arr)
}

/// ページの Rotate 値を取得 (0/90/180/270)
fn get_page_rotate(page_obj: &mupdf::pdf::PdfObject) -> i32 {
    page_obj
        .get_dict("Rotate")
        .ok()
        .flatten()
        .and_then(|obj| obj.resolve().ok().flatten())
        .and_then(|obj| obj.as_int().ok())
        .map(|r| r.rem_euclid(360))
        .unwrap_or(0)
}

/// ページの MediaBox を取得 (Rotate適用前の生座標)
fn get_media_box(page_obj: &mupdf::pdf::PdfObject) -> Option<(f32, f32, f32, f32)> {
    let mb = page_obj.get_dict("MediaBox").ok()??;
    let mb = mb.resolve().ok().flatten().unwrap_or(mb);
    let x0 = mb
        .get_array(0)
        .ok()??
        .resolve()
        .ok()
        .flatten()?
        .as_float()
        .ok()?;
    let y0 = mb
        .get_array(1)
        .ok()??
        .resolve()
        .ok()
        .flatten()?
        .as_float()
        .ok()?;
    let x1 = mb
        .get_array(2)
        .ok()??
        .resolve()
        .ok()
        .flatten()?
        .as_float()
        .ok()?;
    let y1 = mb
        .get_array(3)
        .ok()??
        .resolve()
        .ok()
        .flatten()?
        .as_float()
        .ok()?;
    Some((x0, y0, x1, y1))
}

/// 回転を考慮してトリミング余白をPDF座標系に変換する
///
/// GUI では「視覚上の上/下/左/右」をユーザーが指定する。
/// PDF の CropBox は Rotate 適用前の座標系で指定するため、
/// Rotate 値に応じて余白の方向をマッピングする必要がある。
///
/// Rotate=0  (通常縦): 視覚 top=pdf top, left=pdf left  (変換不要)
/// Rotate=90 (右90°回転=視覚上部がPDF左):
///   視覚 top  → PDF left  (+left_pt)
///   視覚 bottom → PDF right (-right_pt)
///   視覚 left → PDF bottom (+bottom_pt)
///   視覚 right → PDF top  (-top_pt)
/// Rotate=180: left↔right, top↔bottom
/// Rotate=270 (左90°回転=視覚上部がPDF右):
///   視覚 top  → PDF right (-right_pt)
///   視覚 bottom → PDF left (+left_pt)
///   視覚 left → PDF top   (-top_pt)
///   視覚 right → PDF bottom (+bottom_pt)
fn calc_cropbox(
    mb_x0: f32,
    mb_y0: f32,
    mb_x1: f32,
    mb_y1: f32,
    margins: &Margins,
    rotate: i32,
) -> (f32, f32, f32, f32) {
    let l = margins.left;
    let r = margins.right;
    let t = margins.top;
    let b = margins.bottom;

    match rotate {
        90 => {
            // Rotate=90 (時計回り90度で表示): CTM=[0,-1,1,0,0,W]
            // Device-x = PDF-y    → 視覚left/right は PDF-y 方向
            // Device-y = W - PDF-x → 視覚top/bottom は PDF-x 方向(反転)
            //
            // 「視覚左を L削る」= Device-x > L → PDF-y > L → cy0 += L
            // 「視覚右を R削る」= Device-x < H_vis-R → PDF-y < H_vis-R → cy1 -= R
            //   (H_vis = 視覚高 = MB高さ = mb_y1-mb_y0)
            // 「視覚上を T削る」= Device-y < W_vis-T → W-PDF-x < W_vis-T
            //   → PDF-x > T → cx0 += T  (W_vis = 視覚幅 = MB幅 = mb_x1-mb_x0)
            //   Wait: W-PDF-x < W_vis-T → PDF-x > W-W_vis+T = T (mb_x0=0なら)
            //   → cx0 += T は間違い... PDF-x > T → cx0 += T は左端から
            //   実際: 視覚上端 = Device-y=0 = W-PDF-x=0 → PDF-x=W=mb_x1
            //   「視覚上を T削る」= Device-y > T → W-PDF-x > T → PDF-x < W-T → cx1 -= T
            // 「視覚下を B削る」= Device-y < W_vis-B → W-PDF-x < W-B → PDF-x > B → cx0 += B
            let cx0 = mb_x0 + b; // 視覚bottom → cx0 += B
            let cy0 = mb_y0 + l; // 視覚left   → cy0 += L  ← 修正
            let cx1 = mb_x1 - t; // 視覚top    → cx1 -= T
            let cy1 = mb_y1 - r; // 視覚right  → cy1 -= R  ← 修正
            (cx0, cy0, cx1, cy1)
        }
        180 => {
            // Rotate=180: CTM=[-1,0,0,-1,W,H]
            // Device-x = W - PDF-x → 視覚left/right が PDF-x 反転
            // Device-y = H - PDF-y → 視覚top/bottom が PDF-y 反転
            // 「視覚左を L削る」= PDF-x < W-L → cx1 -= L
            // 「視覚右を R削る」= PDF-x > R   → cx0 += R
            // 「視覚上を T削る」= PDF-y < H-T → cy1 -= T
            // 「視覚下を B削る」= PDF-y > B   → cy0 += B
            let cx0 = mb_x0 + r;
            let cy0 = mb_y0 + b; // 視覚bottom → cy0 += B  ← 修正
            let cx1 = mb_x1 - l;
            let cy1 = mb_y1 - t; // 視覚top    → cy1 -= T  ← 修正
            (cx0, cy0, cx1, cy1)
        }
        270 => {
            // Rotate=270 (反時計回り90度): CTM=[0,1,-1,0,H,0]
            // Device-x = H - PDF-y → 視覚left/right が PDF-y 反転
            // Device-y = PDF-x
            // 「視覚左を L削る」= H-PDF-y > L → PDF-y < H-L → cy1 -= L
            // 「視覚右を R削る」= H-PDF-y < H-R → PDF-y > R → cy0 += R
            // 「視覚上を T削る」= PDF-x < T... Wait: Device-y=PDF-x
            //   Device-y > T → PDF-x > T → cx0 += T
            // 「視覚下を B削る」= Device-y < H_vis-B → PDF-x < H_vis-B → cx1 -= B
            let cx0 = mb_x0 + t; // 視覚top    → cx0 += T  (Device-y=PDF-x増方向)
            let cy0 = mb_y0 + r; // 視覚right  → cy0 += R  ← 修正
            let cx1 = mb_x1 - b; // 視覚bottom → cx1 -= B
            let cy1 = mb_y1 - l; // 視覚left   → cy1 -= L  ← 修正
            (cx0, cy0, cx1, cy1)
        }
        _ => {
            // Rotate=0 (デフォルト): 変換不要
            let cx0 = mb_x0 + l;
            let cy0 = mb_y0 + b;
            let cx1 = mb_x1 - r;
            let cy1 = mb_y1 - t;
            (cx0, cy0, cx1, cy1)
        }
    }
}

/// ページ選択を 0始まりインデックスの Vec に変換するヘルパー
fn resolve_selection(sel: &PageSelection, page_count: i32) -> Vec<i32> {
    match sel {
        PageSelection::All => (0..page_count).collect(),
        PageSelection::Even => (0..page_count).filter(|&i| (i + 1) % 2 == 0).collect(),
        PageSelection::Odd => (0..page_count).filter(|&i| (i + 1) % 2 == 1).collect(),
        PageSelection::Range { pages } => pages.iter().map(|&p| p - 1).collect(),
        PageSelection::None => vec![],
    }
}

/// トリミングのエントリポイント。
///
/// まず lopdf 実装を試し、読み込み不能・パスワード付き暗号化など lopdf が扱えない入力
/// のときだけ従来の MuPDF 実装へフォールバックする（移行期間中の安全策）。
pub fn trim(req: &TrimRequest) -> Result<TrimResponse> {
    match trim_with_lopdf(req) {
        Ok(res) => Ok(res),
        Err(e @ CoreError::InvalidArg(_)) => Err(e),
        Err(e) => {
            eprintln!("[trim] lopdf path failed ({e}); falling back to MuPDF");
            trim_with_mupdf(req)
        }
    }
}

// ── lopdf 実装 ─────────────────────────────────────────────────────────────

type Rect4 = (f32, f32, f32, f32);

/// ページの箱（MediaBox / CropBox）。親 Pages ノードからの継承を見る。
/// 4 要素すべてが数値の配列だけを受け付け、(小,小,大,大) に正規化して返す。
fn lp_box(doc: &lopdf::Document, page_id: lopdf::ObjectId, key: &[u8]) -> Option<Rect4> {
    use lopdf::Object;
    let obj = crate::merge::inherited_attr(doc, page_id, key)?;
    let Object::Array(a) = crate::info::lp_resolve(doc, &obj)? else {
        return None;
    };
    if a.len() < 4 {
        return None;
    }
    let mut v = [0.0_f32; 4];
    for (i, slot) in v.iter_mut().enumerate() {
        *slot = crate::info::lp_num(doc, &a[i])? as f32;
    }
    Some((v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])))
}

/// ページの Rotate（継承あり。0〜359 に正規化するだけで、90 の倍数への丸めはしない）。
fn lp_rotate(doc: &lopdf::Document, page_id: lopdf::ObjectId) -> i32 {
    use lopdf::Object;
    let Some(obj) = crate::merge::inherited_attr(doc, page_id, b"Rotate") else {
        return 0;
    };
    match crate::info::lp_resolve(doc, &obj) {
        Some(Object::Integer(n)) => (*n as i32).rem_euclid(360),
        Some(Object::Real(f)) => (f.round() as i32).rem_euclid(360),
        _ => 0,
    }
}

fn rect_obj(r: Rect4) -> lopdf::Object {
    use lopdf::Object;
    Object::Array(vec![
        Object::Real(r.0),
        Object::Real(r.1),
        Object::Real(r.2),
        Object::Real(r.3),
    ])
}

/// ページ辞書の箱を書き換える。ArtBox / BleedBox / TrimBox はページ自身が持つ場合だけ
/// `follow` の値に揃える。
fn set_page_boxes(d: &mut lopdf::Dictionary, boxes: &[(&str, Rect4)], follow: Rect4) {
    for (key, r) in boxes {
        d.set(*key, rect_obj(*r));
    }
    for key in ["ArtBox", "BleedBox", "TrimBox"] {
        if d.has(key.as_bytes()) {
            d.set(key, rect_obj(follow));
        }
    }
}

fn trim_with_lopdf(req: &TrimRequest) -> Result<TrimResponse> {
    use lopdf::{Document, IncrementalDocument, Object, ObjectId};
    use std::collections::HashSet;

    // ── 単位 → pt 変換 ───────────────────────────────────────────────────
    let to_pt: f32 = match req.unit.to_lowercase().as_str() {
        "pt" => 1.0,
        "cm" => 28.3465,
        "in" | "inch" => 72.0,
        _ => 2.83465, // mm
    };
    let margins_pt = Margins {
        left: req.margins.left * to_pt,
        right: req.margins.right * to_pt,
        bottom: req.margins.bottom * to_pt,
        top: req.margins.top * to_pt,
    };

    let bytes = std::fs::read(&req.input).map_err(CoreError::Io)?;
    let mut doc = Document::load_mem(&bytes)
        .map_err(|e| CoreError::Parse(format!("{}: {e}", req.input)))?;
    if doc.is_encrypted() {
        return Err(CoreError::Parse(format!("{}: encrypted PDF", req.input)));
    }
    let page_ids: Vec<ObjectId> = doc.get_pages().into_values().collect();
    if page_ids.is_empty() {
        return Err(CoreError::Parse(format!("{}: no pages", req.input)));
    }
    let page_count = page_ids.len() as i32;

    // ── trim 対象ページ / 残すページ ────────────────────────────────────────
    let mut trim_target: Vec<i32> = resolve_selection(
        req.pages.as_ref().unwrap_or(&PageSelection::All),
        page_count,
    );
    if let Some(exclude) = req.exclude.as_ref() {
        let excl = resolve_selection(exclude, page_count);
        trim_target.retain(|p| !excl.contains(p));
    }
    let keep_pages: Vec<i32> = if let Some(extract) = req.extract.as_ref() {
        let mut kp = resolve_selection(extract, page_count);
        kp.sort_unstable();
        kp.dedup();
        kp
    } else {
        (0..page_count).collect()
    };
    if let Some(&bad) = keep_pages.iter().find(|&&p| p < 0 || p >= page_count) {
        return Err(CoreError::InvalidArg(format!(
            "page {} is out of range (1..={page_count})",
            bad + 1
        )));
    }

    // ── CropBox を計算する ────────────────────────────────────────────────
    let mut edits: Vec<(ObjectId, Rect4, Rect4)> = Vec::new(); // (ページ, MediaBox, CropBox)
    let mut crop_boxes: Vec<CropBoxInfo> = Vec::new();
    for &idx in &trim_target {
        if idx < 0 || idx >= page_count || !keep_pages.contains(&idx) {
            continue; // 範囲外、または extract で除外されるページ
        }
        let pid = page_ids[idx as usize];
        let rotate = lp_rotate(&doc, pid);
        let (mb_x0, mb_y0, mb_x1, mb_y1) =
            lp_box(&doc, pid, b"MediaBox").unwrap_or((0.0, 0.0, 595.0, 842.0));
        let (cx0, cy0, cx1, cy1) = calc_cropbox(mb_x0, mb_y0, mb_x1, mb_y1, &margins_pt, rotate);
        if cx1 <= cx0 || cy1 <= cy0 {
            return Err(CoreError::InvalidArg(format!(
                "page {}: margins too large — CropBox [{:.2} {:.2} {:.2} {:.2}] invalid \
                 (MediaBox [{:.2} {:.2} {:.2} {:.2}], Rotate={})",
                idx + 1,
                cx0,
                cy0,
                cx1,
                cy1,
                mb_x0,
                mb_y0,
                mb_x1,
                mb_y1,
                rotate,
            )));
        }
        edits.push((pid, (mb_x0, mb_y0, mb_x1, mb_y1), (cx0, cy0, cx1, cy1)));
        crop_boxes.push(CropBoxInfo {
            page: idx + 1,
            x0: cx0,
            y0: cy0,
            x1: cx1,
            y1: cy1,
            width: cx1 - cx0,
            height: cy1 - cy0,
        });
    }

    let has_extract = keep_pages.len() < page_count as usize;
    if has_extract {
        // 「残すページだけ」の新しい文書を作る。出力ごとに到達できるオブジェクトだけを
        // 複製するので、不要ページだけが使っていた画像等は残らない。
        crate::merge::flatten_inherited_attrs(&mut doc, &page_ids);
        for (pid, media, crop) in &edits {
            if let Some(Object::Dictionary(d)) = doc.objects.get_mut(pid) {
                set_page_boxes(d, &[("CropBox", *crop), ("MediaBox", *media)], *crop);
            }
        }
        let metadata = crate::compress::metadata_from_doc(&doc);
        let all_pages: HashSet<ObjectId> = page_ids.iter().copied().collect();
        let selected: Vec<ObjectId> = keep_pages.iter().map(|&i| page_ids[i as usize]).collect();
        let mut dst = crate::split::extract_pages(&doc, &all_pages, &selected);
        crate::compress::set_info_on_doc(&mut dst, &metadata);
        dst.prune_objects();
        dst.compress();
        dst.save(&req.output)
            .map_err(|e| CoreError::Parse(format!("{}: {e}", req.output)))?;
    } else if edits.is_empty() {
        std::fs::copy(&req.input, &req.output).map_err(CoreError::Io)?;
    } else {
        // ページ数が変わらない: 増分保存で、変更したページ辞書だけを追記する
        // （/Info・しおり・注釈などは元のバイト列のまま残る）
        let mut inc = IncrementalDocument::create_from(bytes, doc);
        for (pid, media, crop) in &edits {
            inc.opt_clone_object_to_new_document(*pid)
                .map_err(|e| CoreError::Parse(e.to_string()))?;
            if let Ok(Object::Dictionary(d)) = inc.new_document.get_object_mut(*pid) {
                set_page_boxes(d, &[("CropBox", *crop), ("MediaBox", *media)], *crop);
            }
        }
        inc.save(&req.output)
            .map_err(|e| CoreError::Parse(format!("{}: {e}", req.output)))?;
    }

    // CropBox 外リソース削除（試験的・オプション）
    if req.crop_cleanup {
        match crate::crop_cleanup::remove_out_of_crop_resources(
            &req.output,
            &req.output,
            0.0,
            0.0,
            0.0, // PDF は reflowable でないので layout 不要
        ) {
            Ok(s) => eprintln!(
                "[trim] crop_cleanup: {} Do ops removed, {} objects GCed",
                s.do_ops_removed, s.objects_gc,
            ),
            Err(e) => eprintln!("[trim] crop_cleanup warning (skipped): {e}"),
        }
        // GC 後にメタデータを再引き継ぎ
        let meta = crate::compress::collect_metadata(&req.input);
        if !meta.is_empty() {
            crate::compress::copy_metadata_after_write(&req.output, &meta);
        }
    }

    let input_bytes = std::fs::metadata(&req.input).map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);
    Ok(TrimResponse {
        ok: true,
        input_bytes,
        output_bytes,
        crop_boxes,
    })
}

/// 従来の MuPDF 実装（lopdf 実装が失敗したときのフォールバック）。
fn trim_with_mupdf(req: &TrimRequest) -> Result<TrimResponse> {
    use mupdf::pdf::{PdfDocument, PdfWriteOptions};

    // ── 単位 → pt 変換 ─────────────────────────────────────────────────────
    let to_pt: f32 = match req.unit.to_lowercase().as_str() {
        "pt" => 1.0,
        "cm" => 28.3465,
        "in" | "inch" => 72.0,
        _ => 2.83465, // mm
    };
    let margins_pt = Margins {
        left: req.margins.left * to_pt,
        right: req.margins.right * to_pt,
        bottom: req.margins.bottom * to_pt,
        top: req.margins.top * to_pt,
    };

    // ── 入力ファイルをコピーして作業ファイルを作る ──────────────────────────
    // コピー元の /Info・XMP などメタデータが全て保持される。
    // graft 方式（PdfDocument::new）と違い PDF バージョンも変わらない。
    let work_tmp = tempfile::Builder::new()
        .suffix(".pdf")
        .tempfile()
        .map_err(CoreError::Io)?;
    let work_path = work_tmp.path().to_string_lossy().to_string();
    std::fs::copy(&req.input, &work_path).map_err(CoreError::Io)?;

    // ── 作業ファイルを開いてページ情報を取得 ───────────────────────────────
    let doc = PdfDocument::open(&work_path).map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let page_count = doc
        .page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    // ── trim 対象ページを計算 ────────────────────────────────────────────────
    let mut trim_target: Vec<i32> = resolve_selection(
        req.pages.as_ref().unwrap_or(&PageSelection::All),
        page_count,
    );
    if let Some(exclude) = req.exclude.as_ref() {
        let excl = resolve_selection(exclude, page_count);
        trim_target.retain(|p| !excl.contains(p));
    }

    // ── 残すページを計算（extract 指定がなければ全ページ）────────────────────
    let keep_pages: Vec<i32> = if let Some(extract) = req.extract.as_ref() {
        let mut kp = resolve_selection(extract, page_count);
        kp.sort_unstable();
        kp.dedup();
        kp
    } else {
        (0..page_count).collect()
    };

    // ── CropBox を計算して書き込む ────────────────────────────────────────────
    let mut crop_boxes: Vec<CropBoxInfo> = Vec::new();

    for &idx in &trim_target {
        if idx < 0 || idx >= page_count {
            continue;
        }
        if !keep_pages.contains(&idx) {
            continue;
        } // extract で除外されるページは不要

        let mut page_obj = doc
            .find_page(idx)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

        let rotate = get_page_rotate(&page_obj);
        let (mb_x0, mb_y0, mb_x1, mb_y1) =
            get_media_box(&page_obj).unwrap_or((0.0, 0.0, 595.0, 842.0));

        let (cx0, cy0, cx1, cy1) = calc_cropbox(mb_x0, mb_y0, mb_x1, mb_y1, &margins_pt, rotate);

        if cx1 <= cx0 || cy1 <= cy0 {
            return Err(CoreError::InvalidArg(format!(
                "page {}: margins too large — CropBox [{:.2} {:.2} {:.2} {:.2}] invalid \
                 (MediaBox [{:.2} {:.2} {:.2} {:.2}], Rotate={})",
                idx + 1,
                cx0,
                cy0,
                cx1,
                cy1,
                mb_x0,
                mb_y0,
                mb_x1,
                mb_y1,
                rotate,
            )));
        }

        let crop_obj =
            make_rect(&doc, cx0, cy0, cx1, cy1).map_err(|e| CoreError::MuPdf(e.to_string()))?;
        let media_obj = make_rect(&doc, mb_x0, mb_y0, mb_x1, mb_y1)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        page_obj
            .dict_put("CropBox", crop_obj)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
        page_obj
            .dict_put("MediaBox", media_obj)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

        for key in &["ArtBox", "BleedBox", "TrimBox"] {
            if let Ok(Some(_)) = page_obj.get_dict(*key) {
                let obj = make_rect(&doc, cx0, cy0, cx1, cy1)
                    .map_err(|e| CoreError::MuPdf(e.to_string()))?;
                page_obj
                    .dict_put(*key, obj)
                    .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
            }
        }

        crop_boxes.push(CropBoxInfo {
            page: idx + 1,
            x0: cx0,
            y0: cy0,
            x1: cx1,
            y1: cy1,
            width: cx1 - cx0,
            height: cy1 - cy0,
        });
    }

    // ── extract あり: split.rs と同じ graft 方式で「残すページだけ」の新規文書を作る ──
    // delete_page() は不要ページをページツリーから外すだけで、そのページだけが
    // 使っていたはずの画像等が参照グラフ上「到達可能」なまま残ってしまう
    // ケースがあり (garbage_level を上げても解消しない)、抽出後のファイルが
    // 不必要に大きくなる不具合があった。split.rs の「新規 PdfDocument へ
    // graft_map でコピー」方式に統一する。
    let has_extract = keep_pages.len() < page_count as usize;
    if has_extract {
        let mut dst = PdfDocument::new();
        let mut graft = dst
            .new_graft_map()
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

        for &page_idx in &keep_pages {
            let src_page = doc
                .find_page(page_idx)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
            let dst_page = graft
                .graft_object(&src_page)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
            let at = dst
                .page_count()
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
            dst.insert_page(at, &dst_page)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
        }

        let mut opts = PdfWriteOptions::default();
        opts.set_incremental(false)
            .set_compress(true)
            .set_compress_fonts(true)
            .set_compress_images(true)
            .set_garbage_level(2)
            .set_sanitize(false)
            .set_clean(false);
        dst.save_with_options(&req.output, opts)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        // graft では /Info 等のメタデータが引き継がれないため書き戻す
        let metadata = crate::compress::collect_metadata(&req.input);
        crate::compress::copy_metadata_after_write(&req.output, &metadata);
    } else {
        // ── ページ数変わらず: インクリメンタル保存で /Info 完全保持 ────────────
        let mut opts = PdfWriteOptions::default();
        opts.set_incremental(true)
            .set_compress(true)
            .set_garbage_level(0)
            .set_clean(false);
        doc.save_with_options(&req.output, opts)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    }

    // 作業用一時ファイルを解放・削除
    drop(doc);
    drop(work_tmp);

    // CropBox 外リソース削除（試験的・オプション）
    if req.crop_cleanup {
        // MuPDF で bbox 収集 → lopdf で Do 命令削除 → GC
        match crate::crop_cleanup::remove_out_of_crop_resources(
            &req.output,
            &req.output,
            0.0,
            0.0,
            0.0, // PDF は reflowable でないので layout 不要
        ) {
            Ok(s) => eprintln!(
                "[trim] crop_cleanup: {} Do ops removed, {} objects GCed",
                s.do_ops_removed, s.objects_gc,
            ),
            Err(e) => eprintln!("[trim] crop_cleanup warning (skipped): {e}"),
        }
        // GC 後にメタデータを再引き継ぎ
        let meta = crate::compress::collect_metadata(&req.input);
        if !meta.is_empty() {
            crate::compress::copy_metadata_after_write(&req.output, &meta);
        }
    }

    let input_bytes = std::fs::metadata(&req.input).map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);

    Ok(TrimResponse {
        ok: true,
        input_bytes,
        output_bytes,
        crop_boxes,
    })
}

// ── トリミング後のサイズをページサイズにする（MediaBox ← CropBox）─────────────

/// MediaBox と CropBox の一致判定に使う許容誤差 (pt)
const BOX_EPS: f32 = 0.01;

#[derive(Debug, Serialize, Deserialize)]
pub struct CropToPageRequest {
    pub input: String,
    pub output: String,
}

#[derive(Serialize)]
pub struct CropToPageResponse {
    pub ok: bool,
    /// MediaBox を CropBox に揃えた（＝ページサイズが変わった）ページ数
    pub pages_resized: usize,
    pub input_bytes: u64,
    pub output_bytes: u64,
}

/// ページの CropBox を取得する（無ければ None）。
/// `get_media_box` と同じ読み方で、キーだけ CropBox にしたもの。
fn get_crop_box(page_obj: &mupdf::pdf::PdfObject) -> Option<(f32, f32, f32, f32)> {
    let cb = page_obj.get_dict("CropBox").ok()??;
    let cb = cb.resolve().ok().flatten().unwrap_or(cb);
    let mut v = [0.0_f32; 4];
    for (i, slot) in v.iter_mut().enumerate() {
        *slot = cb
            .get_array(i as i32)
            .ok()??
            .resolve()
            .ok()
            .flatten()?
            .as_float()
            .ok()?;
    }
    Some((v[0], v[1], v[2], v[3]))
}

/// ページサイズ化のエントリポイント。lopdf 実装を先に試し、失敗したら MuPDF 実装へ
/// フォールバックする（移行期間中の安全策）。
pub fn crop_to_page(req: &CropToPageRequest) -> Result<CropToPageResponse> {
    match crop_to_page_with_lopdf(req) {
        Ok(res) => Ok(res),
        Err(e @ CoreError::InvalidArg(_)) => Err(e),
        Err(e) => {
            eprintln!("[crop_to_page] lopdf path failed ({e}); falling back to MuPDF");
            crop_to_page_with_mupdf(req)
        }
    }
}

fn crop_to_page_with_lopdf(req: &CropToPageRequest) -> Result<CropToPageResponse> {
    use lopdf::{Document, IncrementalDocument, Object, ObjectId};

    let bytes = std::fs::read(&req.input).map_err(CoreError::Io)?;
    let doc = Document::load_mem(&bytes)
        .map_err(|e| CoreError::Parse(format!("{}: {e}", req.input)))?;
    if doc.is_encrypted() {
        return Err(CoreError::Parse(format!("{}: encrypted PDF", req.input)));
    }
    let page_ids: Vec<ObjectId> = doc.get_pages().into_values().collect();
    if page_ids.is_empty() {
        return Err(CoreError::Parse(format!("{}: no pages", req.input)));
    }

    let mut edits: Vec<(ObjectId, Rect4)> = Vec::new();
    for &pid in &page_ids {
        let Some((cx0, cy0, cx1, cy1)) = lp_box(&doc, pid, b"CropBox") else {
            continue;
        };
        let (mx0, my0, mx1, my1) = lp_box(&doc, pid, b"MediaBox").unwrap_or((0.0, 0.0, 595.0, 842.0));
        // CropBox は仕様上 MediaBox との交差で解釈される。範囲外にはみ出した
        // CropBox でページが広がらないよう、交差を新しいページ枠にする。
        let (nx0, ny0, nx1, ny1) = (cx0.max(mx0), cy0.max(my0), cx1.min(mx1), cy1.min(my1));
        if nx1 <= nx0 || ny1 <= ny0 {
            continue; // 不正な CropBox
        }
        let same = (nx0 - mx0).abs() < BOX_EPS
            && (ny0 - my0).abs() < BOX_EPS
            && (nx1 - mx1).abs() < BOX_EPS
            && (ny1 - my1).abs() < BOX_EPS;
        if same {
            continue; // トリミングされていないページ
        }
        edits.push((pid, (nx0, ny0, nx1, ny1)));
    }
    let pages_resized = edits.len();

    if edits.is_empty() {
        std::fs::copy(&req.input, &req.output).map_err(CoreError::Io)?;
    } else {
        // 増分保存（/Info 等のメタデータ・PDF バージョン・オブジェクトストリームを保持）
        let mut inc = IncrementalDocument::create_from(bytes, doc);
        for (pid, r) in &edits {
            inc.opt_clone_object_to_new_document(*pid)
                .map_err(|e| CoreError::Parse(e.to_string()))?;
            if let Ok(Object::Dictionary(d)) = inc.new_document.get_object_mut(*pid) {
                set_page_boxes(d, &[("MediaBox", *r), ("CropBox", *r)], *r);
            }
        }
        inc.save(&req.output)
            .map_err(|e| CoreError::Parse(format!("{}: {e}", req.output)))?;
    }

    let input_bytes = std::fs::metadata(&req.input).map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);
    Ok(CropToPageResponse {
        ok: true,
        pages_resized,
        input_bytes,
        output_bytes,
    })
}

/// 従来の MuPDF 実装（lopdf 実装が失敗したときのフォールバック）。
/// CropBox が MediaBox と異なるページについて、MediaBox を CropBox に揃える。
///
/// トリミング（`trim`）は CropBox を設定するだけでページサイズ(MediaBox)を
/// 変えない。本関数はその後段で呼び、「トリミング後の大きさ＝ページサイズ」に
/// する。コンテンツストリームの座標は変えず、ページ枠だけを CropBox に合わせる
/// ため、表示内容は変わらない（Rotate も座標系が MediaBox/CropBox 共通なので
/// 考慮不要）。
///
/// 注意: 枠外の内容そのものは消えない（見えなくなるだけ）。物理的に削除したい
/// 場合は、本関数の前に圧縮の redact_outside_crop を通すこと
/// （redact は CropBox ≠ MediaBox を前提に動くため、本関数の後では効かない）。
///
/// CropBox が無い・MediaBox と同一・不正なページには何もしない。
fn crop_to_page_with_mupdf(req: &CropToPageRequest) -> Result<CropToPageResponse> {
    use mupdf::pdf::{PdfDocument, PdfWriteOptions};

    // trim と同様、入力を作業ファイルへコピーして開き、インクリメンタル保存する
    // （/Info 等のメタデータ・PDF バージョン・オブジェクトストリームを保持）。
    let work_tmp = tempfile::Builder::new()
        .suffix(".pdf")
        .tempfile()
        .map_err(CoreError::Io)?;
    let work_path = work_tmp.path().to_string_lossy().to_string();
    std::fs::copy(&req.input, &work_path).map_err(CoreError::Io)?;

    let doc = PdfDocument::open(&work_path).map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let page_count = doc
        .page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let mut pages_resized = 0usize;
    for idx in 0..page_count {
        let mut page_obj = doc
            .find_page(idx)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

        let Some((cx0, cy0, cx1, cy1)) = get_crop_box(&page_obj) else {
            continue;
        };
        let (mx0, my0, mx1, my1) = get_media_box(&page_obj).unwrap_or((0.0, 0.0, 595.0, 842.0));

        // CropBox は仕様上 MediaBox との交差で解釈される。範囲外にはみ出した
        // CropBox でページが広がらないよう、交差を新しいページ枠にする。
        let (nx0, ny0, nx1, ny1) = (cx0.max(mx0), cy0.max(my0), cx1.min(mx1), cy1.min(my1));
        if nx1 <= nx0 || ny1 <= ny0 {
            continue; // 不正な CropBox
        }
        let same = (nx0 - mx0).abs() < BOX_EPS
            && (ny0 - my0).abs() < BOX_EPS
            && (nx1 - mx1).abs() < BOX_EPS
            && (ny1 - my1).abs() < BOX_EPS;
        if same {
            continue; // トリミングされていないページ
        }

        for key in &["MediaBox", "CropBox"] {
            let obj =
                make_rect(&doc, nx0, ny0, nx1, ny1).map_err(|e| CoreError::MuPdf(e.to_string()))?;
            page_obj
                .dict_put(*key, obj)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
        }
        for key in &["ArtBox", "BleedBox", "TrimBox"] {
            if let Ok(Some(_)) = page_obj.get_dict(*key) {
                let obj = make_rect(&doc, nx0, ny0, nx1, ny1)
                    .map_err(|e| CoreError::MuPdf(e.to_string()))?;
                page_obj
                    .dict_put(*key, obj)
                    .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
            }
        }
        pages_resized += 1;
    }

    let mut opts = PdfWriteOptions::default();
    opts.set_incremental(true)
        .set_compress(true)
        .set_garbage_level(0)
        .set_clean(false);
    doc.save_with_options(&req.output, opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    drop(doc);
    drop(work_tmp);

    let input_bytes = std::fs::metadata(&req.input).map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);
    Ok(CropToPageResponse {
        ok: true,
        pages_resized,
        input_bytes,
        output_bytes,
    })
}
