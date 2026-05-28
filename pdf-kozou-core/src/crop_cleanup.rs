// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// pdf-kozou-core/src/crop_cleanup.rs
//
// トリミング後に CropBox と全く重ならない XObject の Do 命令を削除し、
// 未参照になったオブジェクトを GC で除去することでファイルサイズを削減する。
//
// 2段階方式:
//   Phase 1: MuPDF (C層) で各ページの Form XObject の実際の
//            ページ座標上 bbox を収集し、CropBox 外のものを特定する。
//            MuPDF に CTM 計算・ネスト処理を任せることで正確性を確保。
//
//   Phase 2: lopdf で各ページのコンテンツストリームを解析し、
//            Phase 1 で特定した XObject 名の Do 命令を削除する。
//            その後 GC で未参照オブジェクトを除去する。

use lopdf::{Document, Object, ObjectId};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

/// クリーンアップの統計情報
#[derive(Debug, Default)]
pub struct CleanupStats {
    pub pages_processed: usize,
    pub do_ops_removed: usize,
    pub objects_gc: usize,
}

/// MuPDF から取得した XObject の情報
#[derive(Debug, Deserialize)]
struct XObjInfo {
    name: String,
    xref: i32,
    bbox: [f32; 4], // MuPDF デバイス座標 (Y下向き) [x0, y0, x1, y1]
}

/// MuPDF からの JSON レスポンス
#[derive(Debug, Deserialize)]
struct XObjBboxResponse {
    ok: bool,
    #[allow(dead_code)]
    page_h: f32,
    cropbox: [f32; 4], // MuPDF デバイス座標 [x0, y0, x1, y1]
    xobjs: Vec<XObjInfo>,
}

/// 矩形の交差判定
fn intersects(a: &[f32; 4], b: &[f32; 4]) -> bool {
    // [x0, y0, x1, y1] 形式
    a[2] > b[0] && a[0] < b[2] && a[3] > b[1] && a[1] < b[3]
}

/// トリミング後の PDF から CropBox 外の XObject Do 命令を削除する
pub fn remove_out_of_crop_resources(
    input: &str,
    output: &str,
    layout_w: f32,
    layout_h: f32,
    layout_em: f32,
) -> Result<CleanupStats, String> {
    use crate::ffi::{
        kozou_buffer_get_data, kozou_collect_xobj_bboxes, kozou_drop_buffer,
        kozou_new_context, FfiResult,
    };
    use std::ffi::CString;

    let mut stats = CleanupStats::default();

    // Phase 1: MuPDF で各ページの XObject bbox を収集
    let c_path = CString::new(input)
        .map_err(|_| "invalid path".to_string())?;

    // ページ数を取得
    let page_count = {
        let doc = lopdf::Document::load(input)
            .map_err(|e| format!("lopdf load: {e}"))?;
        doc.get_pages().len()
    };

    // ページごとに削除対象 XObject 名を収集
    // page_index → HashSet<xobj_name>
    let mut remove_map: HashMap<usize, HashSet<String>> = HashMap::new();

    for page_idx in 0..page_count {
        let json_str = unsafe {
            let ctx = kozou_new_context();
            if ctx.is_null() {
                return Err("kozou_new_context failed".into());
            }
            let buf = mupdf_sys::fz_new_buffer(ctx, 65536);
            if buf.is_null() {
                mupdf_sys::fz_drop_context(ctx);
                return Err("fz_new_buffer failed".into());
            }
            let out = mupdf_sys::fz_new_output_with_buffer(ctx, buf);
            if out.is_null() {
                mupdf_sys::fz_drop_buffer(ctx, buf);
                mupdf_sys::fz_drop_context(ctx);
                return Err("fz_new_output_with_buffer failed".into());
            }
            let mut res = FfiResult::default();

            kozou_collect_xobj_bboxes(
                ctx,
                c_path.as_ptr(),
                page_idx as i32,
                layout_w,
                layout_h,
                layout_em,
                out,
                &mut res,
            );

            mupdf_sys::fz_close_output(ctx, out);
            mupdf_sys::fz_drop_output(ctx, out);

            let mut data_ptr: *const u8 = std::ptr::null();
            let len = kozou_buffer_get_data(ctx, buf, &mut data_ptr);
            let s = if len > 0 && !data_ptr.is_null() {
                String::from_utf8_lossy(std::slice::from_raw_parts(data_ptr, len))
                    .into_owned()
            } else {
                String::new()
            };
            kozou_drop_buffer(ctx, buf);
            mupdf_sys::fz_drop_context(ctx);

            if res.ok == 0 {
                eprintln!("[crop_cleanup] page {page_idx}: MuPDF error, skipping");
                continue;
            }
            s
        };

        if json_str.is_empty() {
            continue;
        }

        let resp: XObjBboxResponse = match serde_json::from_str(&json_str) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[crop_cleanup] page {page_idx}: JSON parse error: {e}");
                continue;
            }
        };

        if !resp.ok {
            continue;
        }

        let crop = &resp.cropbox;
        let mut to_remove = HashSet::new();

        for xobj in &resp.xobjs {
            let bbox = &xobj.bbox;
            if !intersects(bbox, crop) {
                // CropBox と全く重ならない → 削除対象
                to_remove.insert(xobj.name.clone());
                eprintln!(
                    "[crop_cleanup] page {page_idx}: remove {} (xref={}) \
                     bbox=[{:.0},{:.0},{:.0},{:.0}] crop=[{:.0},{:.0},{:.0},{:.0}]",
                    xobj.name, xobj.xref,
                    bbox[0], bbox[1], bbox[2], bbox[3],
                    crop[0], crop[1], crop[2], crop[3]
                );
            }
        }

        if !to_remove.is_empty() {
            remove_map.insert(page_idx, to_remove);
        }
    }

    if remove_map.is_empty() {
        // 削除対象なし → input をそのまま output にコピー
        if input != output {
            std::fs::copy(input, output)
                .map_err(|e| format!("copy: {e}"))?;
        }
        return Ok(stats);
    }

    // Phase 2: lopdf で Do 命令を削除
    let mut doc = Document::load(input)
        .map_err(|e| format!("lopdf load: {e}"))?;

    let page_ids: Vec<ObjectId> = doc.page_iter().collect();

    for (page_idx, page_id) in page_ids.iter().enumerate() {
        let remove_names = match remove_map.get(&page_idx) {
            Some(s) => s,
            None => {
                stats.pages_processed += 1;
                continue;
            }
        };

        let removed = process_page_content(&mut doc, *page_id, remove_names)
            .unwrap_or_else(|e| {
                eprintln!("[crop_cleanup] page {page_idx}: {e}");
                0
            });
        stats.do_ops_removed += removed;
        stats.pages_processed += 1;
    }

    // GC
    let before = doc.objects.len();
    doc.delete_zero_length_streams();
    doc.prune_objects();
    let after = doc.objects.len();
    stats.objects_gc = before.saturating_sub(after);

    doc.save(output)
        .map_err(|e| format!("lopdf save: {e}"))?;

    Ok(stats)
}

/// 1ページのコンテンツストリームから指定 XObject 名の Do 命令を削除
fn process_page_content(
    doc: &mut Document,
    page_id: ObjectId,
    remove_names: &HashSet<String>,
) -> Result<usize, String> {
    // Contents を取得
    let contents_ref = {
        let page_dict = doc
            .get_object(page_id)
            .map_err(|e| format!("get page: {e}"))?
            .as_dict()
            .map_err(|e| format!("page dict: {e}"))?
            .clone();
        page_dict.get(b"Contents").ok().cloned()
    };
    let contents_ref = match contents_ref {
        Some(r) => r,
        None => return Ok(0),
    };

    // 全コンテンツストリームのデータを結合
    let mut all_bytes = Vec::new();
    collect_content_bytes(doc, &contents_ref, &mut all_bytes);
    if all_bytes.is_empty() {
        return Ok(0);
    }

    let content_str = String::from_utf8_lossy(&all_bytes).into_owned();

    // Do 命令を削除
    let (new_content, removed) = remove_do_ops(&content_str, remove_names);
    if removed == 0 {
        return Ok(0);
    }

    // 単一ストリームに統合して更新
    update_page_contents(doc, page_id, &contents_ref, new_content.into_bytes())?;

    Ok(removed)
}

fn collect_content_bytes(doc: &Document, obj: &Object, out: &mut Vec<u8>) {
    match obj {
        Object::Reference(id) => {
            if let Ok(resolved) = doc.get_object(*id) {
                collect_content_bytes(doc, resolved, out);
            }
        }
        Object::Array(arr) => {
            for item in arr {
                collect_content_bytes(doc, item, out);
                if !out.ends_with(b"\n") {
                    out.push(b'\n');
                }
            }
        }
        Object::Stream(stream) => {
            if let Ok(data) = stream.decompressed_content() {
                out.extend_from_slice(&data);
                if !out.ends_with(b"\n") {
                    out.push(b'\n');
                }
            }
        }
        _ => {}
    }
}

fn update_page_contents(
    doc: &mut Document,
    page_id: ObjectId,
    old_contents: &Object,
    new_bytes: Vec<u8>,
) -> Result<(), String> {
    use lopdf::{dictionary, Stream};

    match old_contents {
        Object::Reference(stream_id) => {
            // 単一ストリーム → 直接更新
            let obj = doc
                .get_object_mut(*stream_id)
                .map_err(|e| format!("get stream mut: {e}"))?;
            let stream = obj
                .as_stream_mut()
                .map_err(|e| format!("as stream mut: {e}"))?;
            stream.set_plain_content(new_bytes);
            stream.compress().map_err(|e| format!("compress: {e}"))?;
        }
        _ => {
            // 複数ストリームを1つに統合
            let mut new_stream = Stream::new(dictionary! {}, new_bytes);
            new_stream.compress().map_err(|e| format!("compress new: {e}"))?;
            let new_id = doc.add_object(Object::Stream(new_stream));

            let page_dict = doc
                .get_object_mut(page_id)
                .map_err(|e| format!("get page mut: {e}"))?
                .as_dict_mut()
                .map_err(|e| format!("page dict mut: {e}"))?;
            page_dict.set(b"Contents", Object::Reference(new_id));
        }
    }
    Ok(())
}

/// コンテンツストリームから指定 XObject 名の Do 命令を削除する
///
/// PDF のコンテンツストリームでの Do 命令の書き方:
///   /XObjName Do
/// 直前に /XObjName トークンがあり、その後 Do トークンが続く。
///
/// 削除方針:
///   トークン単位でスキャンし、Do トークンを見つけたら
///   直前の /Name トークンが削除対象かを確認する。
///   対象なら /Name と Do の両方を出力しない。
fn remove_do_ops(content: &str, remove_names: &HashSet<String>) -> (String, usize) {
    let mut result = String::with_capacity(content.len());
    let mut removed = 0;

    // 行単位で処理（PDF コンテンツストリームは改行区切り）
    let lines: Vec<&str> = content.lines().collect();
    let n = lines.len();
    let mut i = 0;

    while i < n {
        let line = lines[i].trim();

        // "Do" 単独トークンの行を探す
        if line == "Do" {
            // 直前の行が "/XObjName" の形式か確認
            let prev_idx = find_prev_nonempty(&lines, i);
            let should_remove = if let Some(pi) = prev_idx {
                let prev = lines[pi].trim();
                if prev.starts_with('/') {
                    let name = &prev[1..];
                    remove_names.contains(name)
                } else {
                    false
                }
            } else {
                false
            };

            if should_remove {
                // /Name 行と Do 行を出力しない
                // result から直前の /Name 行を削除
                remove_last_nonempty_line(&mut result);
                removed += 1;
                // Do 行もスキップ
                i += 1;
                continue;
            }
        }

        // そのまま出力
        result.push_str(lines[i]);
        result.push('\n');
        i += 1;
    }

    (result, removed)
}

/// lines[..i] の中で空行でない最後のインデックスを返す
fn find_prev_nonempty(lines: &[&str], i: usize) -> Option<usize> {
    if i == 0 {
        return None;
    }
    let mut j = i - 1;
    loop {
        if !lines[j].trim().is_empty() {
            return Some(j);
        }
        if j == 0 {
            return None;
        }
        j -= 1;
    }
}

/// result の末尾にある空行でない最後の行を削除する
fn remove_last_nonempty_line(s: &mut String) {
    // 末尾から非空行を見つけて削除
    while s.ends_with('\n') {
        s.pop();
    }
    // 最後の改行を見つけてそこで切る
    if let Some(last_nl) = s.rfind('\n') {
        s.truncate(last_nl + 1);
    } else {
        s.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_remove_do_ops_basic() {
        let content = "\
q\n\
1 0 0 1 0 697 cm\n\
/X11 Do\n\
Q\n\
q\n\
1 0 0 1 83 712 cm\n\
/X13 Do\n\
Q\n\
";
        let mut remove = HashSet::new();
        remove.insert("X11".to_string());

        let (result, removed) = remove_do_ops(content, &remove);
        assert_eq!(removed, 1);
        assert!(!result.contains("/X11"));
        assert!(!result.contains("Do\n"));
        // X13 は残る
        assert!(result.contains("/X13"));
        println!("result:\n{result}");
    }

    #[test]
    fn test_remove_do_ops_multiline() {
        // /Name と Do が別行の場合
        let content = "/X0\nDo\n/X1\nDo\n";
        let mut remove = HashSet::new();
        remove.insert("X0".to_string());

        let (result, removed) = remove_do_ops(content, &remove);
        assert_eq!(removed, 1);
        assert!(!result.contains("X0"));
        assert!(result.contains("X1"));
    }

    #[test]
    fn test_intersects() {
        // 完全に外側
        assert!(!intersects(&[0.0, 500.0, 595.0, 842.0], &[0.0, 0.0, 595.0, 400.0]));
        // 完全に内側
        assert!(intersects(&[0.0, 0.0, 595.0, 842.0], &[100.0, 100.0, 200.0, 200.0]));
        // 部分的に重なる
        assert!(intersects(&[0.0, 400.0, 595.0, 842.0], &[0.0, 0.0, 595.0, 500.0]));
    }
}
