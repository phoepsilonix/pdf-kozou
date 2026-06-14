// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// pdf-kozou-core/src/crop_cleanup.rs
//
// トリミング後に CropBox と全く重ならない XObject の Do 命令を削除し、
// 未参照になったオブジェクトを GC で除去することでファイルサイズを削減する。
//
// 2段階方式:
//   Phase 1: MuPDF C層で全 Form XObject（ネスト含む）のページ座標上 bbox を再帰収集。
//            container_xref（Do 命令を含む XObject の xref）と
//            xobj_name（/Name）のペアも返す。
//   Phase 2: lopdf でコンテナ XObject のストリームを編集して
//            CropBox 外の Do 命令を削除 + GC。

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

/// MuPDF から取得した 1 エントリ
#[derive(Debug, Deserialize)]
struct XObjEntry {
    container_xref: i32,  // 0 = ページのコンテンツストリーム
    xobj_name: String,
    xobj_xref: i32,
    bbox: [f32; 4],        // MuPDF デバイス座標 [x0,y0,x1,y1]
}

/// MuPDF からの JSON レスポンス
#[derive(Debug, Deserialize)]
struct XObjBboxResponse {
    ok: bool,
    #[allow(dead_code)]
    page_h: f32,
    cropbox: [f32; 4],
    entries: Vec<XObjEntry>,
}

/// 矩形の交差判定（完全に外側 → false で「削除可能」）
fn intersects(a: &[f32; 4], b: &[f32; 4]) -> bool {
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

    let c_path = CString::new(input).map_err(|_| "invalid path".to_string())?;

    let page_count = {
        let doc = lopdf::Document::load(input)
            .map_err(|e| format!("lopdf load: {e}"))?;
        doc.get_pages().len()
    };

    // container_xref → 削除すべき xobj_name のセット
    // (0 = ページのコンテンツストリーム)
    // ページごとに収集
    let mut page_remove_maps: Vec<HashMap<i32, HashSet<String>>> =
        vec![HashMap::new(); page_count];

    for (page_idx, remove_map) in page_remove_maps.iter_mut().enumerate() {
        let json_str = unsafe {
            let ctx = kozou_new_context();
            if ctx.is_null() {
                return Err("kozou_new_context failed".into());
            }
            let buf = mupdf_sys::fz_new_buffer(ctx, 4096);
            if buf.is_null() {
                mupdf_sys::fz_drop_context(ctx);
                continue;
            }
            let out = mupdf_sys::fz_new_output_with_buffer(ctx, buf);
            if out.is_null() {
                mupdf_sys::fz_drop_buffer(ctx, buf);
                mupdf_sys::fz_drop_context(ctx);
                continue;
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
                eprintln!("[crop_cleanup] page {page_idx}: JSON parse: {e}");
                continue;
            }
        };

        if !resp.ok {
            continue;
        }

        let crop = &resp.cropbox;

        for entry in &resp.entries {
            if !intersects(&entry.bbox, crop) {
                // CropBox と全く重ならない → 削除対象
                remove_map
                    .entry(entry.container_xref)
                    .or_default()
                    .insert(entry.xobj_name.clone());
                eprintln!(
                    "[crop_cleanup] page {page_idx}: remove /{} (xref={}) \
                     in container={} bbox=[{:.0},{:.0},{:.0},{:.0}]",
                    entry.xobj_name, entry.xobj_xref, entry.container_xref,
                    entry.bbox[0], entry.bbox[1], entry.bbox[2], entry.bbox[3],
                );
            }
        }
    }

    // 全ページで削除対象がなければコピーして終了
    let has_any = page_remove_maps.iter().any(|m| !m.is_empty());
    if !has_any {
        if input != output {
            std::fs::copy(input, output).map_err(|e| format!("copy: {e}"))?;
        }
        return Ok(stats);
    }

    // Phase 2: lopdf で Do 命令を削除
    let mut doc = Document::load(input)
        .map_err(|e| format!("lopdf load: {e}"))?;

    let page_ids: Vec<ObjectId> = doc.page_iter().collect();

    for (page_idx, page_id) in page_ids.iter().enumerate() {
        let remove_map = &page_remove_maps[page_idx];
        if remove_map.is_empty() {
            stats.pages_processed += 1;
            continue;
        }

        // container_xref=0 → ページのコンテンツストリームを編集
        if let Some(names) = remove_map.get(&0) {
            let removed = edit_page_content(&mut doc, *page_id, names)
                .unwrap_or_else(|e| {
                    eprintln!("[crop_cleanup] page {page_idx} content: {e}");
                    0
                });
            stats.do_ops_removed += removed;
        }

        // container_xref != 0 → 対応する XObject ストリームを編集
        for (container_xref, names) in remove_map.iter() {
            if *container_xref == 0 {
                continue;
            }
            let xref = *container_xref as u32;
            let removed = edit_xobj_stream(&mut doc, xref, names)
                .unwrap_or_else(|e| {
                    eprintln!("[crop_cleanup] xref={container_xref}: {e}");
                    0
                });
            stats.do_ops_removed += removed;
        }

        stats.pages_processed += 1;
    }

    // GC
    let before = doc.objects.len();
    doc.delete_zero_length_streams();
    doc.prune_objects();
    let after = doc.objects.len();
    stats.objects_gc = before.saturating_sub(after);

    doc.save(output).map_err(|e| format!("lopdf save: {e}"))?;

    Ok(stats)
}

/// ページのコンテンツストリームから指定名の Do 命令を削除
fn edit_page_content(
    doc: &mut Document,
    page_id: ObjectId,
    remove_names: &HashSet<String>,
) -> Result<usize, String> {
    let contents_ref = {
        let page_dict = doc
            .get_object(page_id)
            .map_err(|e| format!("get page: {e}"))?
            .as_dict()
            .map_err(|e| format!("page dict: {e}"))?
            .clone();
        match page_dict.get(b"Contents").ok().cloned() {
            Some(r) => r,
            None => return Ok(0),
        }
    };

    let mut all_bytes = Vec::new();
    collect_content_bytes(doc, &contents_ref, &mut all_bytes);
    if all_bytes.is_empty() {
        return Ok(0);
    }

    let content_str = String::from_utf8_lossy(&all_bytes).into_owned();
    let (new_content, removed) = remove_do_ops(&content_str, remove_names);
    if removed == 0 {
        return Ok(0);
    }

    update_page_contents(doc, page_id, &contents_ref, new_content.into_bytes())?;
    Ok(removed)
}

/// XObject のストリームから指定名の Do 命令を削除
fn edit_xobj_stream(
    doc: &mut Document,
    xref: u32,
    remove_names: &HashSet<String>,
) -> Result<usize, String> {
    let xobj_id: ObjectId = (xref, 0);

    // ストリームデータを取得
    let bytes = {
        let obj = doc.get_object(xobj_id)
            .map_err(|e| format!("get xobj {xref}: {e}"))?;
        let stream = obj.as_stream()
            .map_err(|e| format!("xobj {xref} as_stream: {e}"))?;
        stream.decompressed_content()
            .map_err(|e| format!("xobj {xref} decompress: {e}"))?
    };

    let content_str = String::from_utf8_lossy(&bytes).into_owned();
    let (new_content, removed) = remove_do_ops(&content_str, remove_names);
    if removed == 0 {
        return Ok(0);
    }

    // 更新
    let obj = doc.get_object_mut(xobj_id)
        .map_err(|e| format!("get xobj mut {xref}: {e}"))?;
    let stream = obj.as_stream_mut()
        .map_err(|e| format!("xobj {xref} as_stream_mut: {e}"))?;
    stream.set_plain_content(new_content.into_bytes());
    stream.compress().map_err(|e| format!("compress {xref}: {e}"))?;

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
fn remove_do_ops(content: &str, remove_names: &HashSet<String>) -> (String, usize) {
    let mut result = String::with_capacity(content.len());
    let mut removed = 0;
    let lines: Vec<&str> = content.lines().collect();
    let n = lines.len();
    let mut i = 0;

    while i < n {
        let line = lines[i].trim();

        if line == "Do" {
            let prev_idx = find_prev_nonempty(&lines, i);
            let should_remove = if let Some(pi) = prev_idx {
                let prev = lines[pi].trim();
                if let Some(stripped) = prev.strip_prefix('/') {
                    remove_names.contains(stripped)
                } else {
                    false
                }
            } else {
                false
            };

            if should_remove {
                remove_last_nonempty_line(&mut result);
                removed += 1;
                i += 1;
                continue;
            }
        }

        result.push_str(lines[i]);
        result.push('\n');
        i += 1;
    }

    (result, removed)
}

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

fn remove_last_nonempty_line(s: &mut String) {
    while s.ends_with('\n') {
        s.pop();
    }
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
    fn test_remove_do_ops() {
        let content = "/X11\nDo\n/X13\nDo\n/X14\nDo\n";
        let mut names = HashSet::new();
        names.insert("X11".to_string());
        names.insert("X13".to_string());

        let (result, removed) = remove_do_ops(content, &names);
        assert_eq!(removed, 2);
        assert!(!result.contains("X11"));
        assert!(!result.contains("X13"));
        assert!(result.contains("/X14"));
        assert!(result.contains("Do"));
    }

    #[test]
    fn test_intersects() {
        // 完全に外側（CropBoxの上）
        assert!(!intersects(&[0.0, 0.0, 595.0, 400.0], &[0.0, 421.0, 595.0, 842.0]));
        // 重なる
        assert!(intersects(&[0.0, 0.0, 595.0, 500.0], &[0.0, 421.0, 595.0, 842.0]));
        // 完全に内側
        assert!(intersects(&[100.0, 500.0, 200.0, 600.0], &[0.0, 421.0, 595.0, 842.0]));
    }
}
