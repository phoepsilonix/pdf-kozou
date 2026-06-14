// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// pdf-kozou-core/src/type3_sanitize.rs
//
// lopdf を使って Type3 フォントを参照する BT...ET ブロックを
// コンテンツストリームから選択的に削除する。
//
// 戦略:
//   1. PDF 内のすべてのページおよび Form XObject を対象にする
//   2. /Resources /Font 辞書で /Subtype /Type3 のフォントリソース名を収集
//   3. コンテンツストリームの BT...ET ブロックを走査し、
//      Type3 フォントを参照する Tf 命令があるブロックを削除
//   4. 変更後の PDF を保存

use lopdf::{Document, Object, ObjectId};
use std::collections::HashSet;

/// Type3 フォントを使う BT...ET ブロックを削除する
/// input: 入力 PDF パス
/// output: 出力 PDF パス
/// 戻り値: 削除した BT ブロック数
pub fn sanitize_type3_blocks(input: &str, output: &str) -> Result<usize, String> {
    let mut doc = Document::load(input)
        .map_err(|e| format!("lopdf load error: {e}"))?;

    let mut total_removed = 0;

    // ページと Form XObject の両方を処理
    // まずページIDリストを収集
    let page_ids: Vec<ObjectId> = doc.page_iter().collect();

    // 処理対象のストリームIDを収集
    // ページのコンテンツと、参照される Form XObject を収集
    let stream_ids = collect_content_stream_ids(&doc, &page_ids);

    for stream_id in stream_ids {
        let removed = process_content_stream(&mut doc, stream_id)?;
        total_removed += removed;
    }

    doc.save(output)
        .map_err(|e| format!("lopdf save error: {e}"))?;

    Ok(total_removed)
}

/// ページおよび Form XObject のコンテンツストリームIDを収集する
fn collect_content_stream_ids(doc: &Document, page_ids: &[ObjectId]) -> Vec<ObjectId> {
    let mut ids: Vec<ObjectId> = Vec::new();
    let mut visited: HashSet<ObjectId> = HashSet::new();

    for &page_id in page_ids {
        collect_from_page(doc, page_id, &mut ids, &mut visited);
    }

    ids
}

fn collect_from_page(
    doc: &Document,
    page_id: ObjectId,
    ids: &mut Vec<ObjectId>,
    visited: &mut HashSet<ObjectId>,
) {
    if visited.contains(&page_id) {
        return;
    }
    visited.insert(page_id);

    let page_dict = match doc.get_object(page_id).ok()
        .and_then(|o| o.as_dict().ok()) 
    {
        Some(d) => d.clone(),
        None => return,
    };

    // /Contents
    if let Ok(contents) = page_dict.get(b"Contents") {
        collect_content_refs(doc, contents, ids, visited);
    }

    // /Resources /XObject 内の Form XObject も再帰的に処理
    if let Ok(resources) = page_dict.get(b"Resources") {
        collect_form_xobjects(doc, resources, ids, visited);
    }
}

fn collect_content_refs(
    _doc: &Document,
    obj: &Object,
    ids: &mut Vec<ObjectId>,
    visited: &mut HashSet<ObjectId>,
) {
    match obj {
        Object::Reference(id) => {
            if !visited.contains(id) {
                visited.insert(*id);
                ids.push(*id);
            }
        }
        Object::Array(arr) => {
            for item in arr {
                collect_content_refs(_doc, item, ids, visited);
            }
        }
        _ => {}
    }
}

fn collect_form_xobjects(
    doc: &Document,
    resources_obj: &Object,
    ids: &mut Vec<ObjectId>,
    visited: &mut HashSet<ObjectId>,
) {
    // resources_obj が Reference なら解決
    let resources = match resources_obj {
        Object::Reference(id) => {
            match doc.get_object(*id).ok() {
                Some(o) => o.clone(),
                None => return,
            }
        }
        other => other.clone(),
    };

    let res_dict = match resources.as_dict() {
        Ok(d) => d.clone(),
        Err(_) => return,
    };

    let xobject_dict = match res_dict.get(b"XObject").ok() {
        Some(obj) => {
            let resolved = match obj {
                Object::Reference(id) => match doc.get_object(*id).ok() {
                    Some(o) => o.clone(),
                    None => return,
                },
                other => other.clone(),
            };
            match resolved.as_dict() {
                Ok(d) => d.clone(),
                Err(_) => return,
            }
        }
        None => return,
    };

    for (_, xobj_ref) in xobject_dict.iter() {
        let xobj_id = match xobj_ref {
            Object::Reference(id) => *id,
            _ => continue,
        };

        if visited.contains(&xobj_id) {
            continue;
        }

        // Form XObject かどうか確認
        let xobj = match doc.get_object(xobj_id).ok() {
            Some(o) => o.clone(),
            None => continue,
        };
        let stream = match xobj.as_stream() {
            Ok(s) => s.clone(),
            Err(_) => continue,
        };
        let subtype = stream.dict.get(b"Subtype").ok()
            .and_then(|o| o.as_name().ok().map(|n| n.to_vec()));
        if subtype.as_deref() != Some(b"Form") {
            continue;
        }

        visited.insert(xobj_id);
        ids.push(xobj_id);

        // Form XObject 内の /Resources も再帰処理
        if let Ok(res) = stream.dict.get(b"Resources") {
            collect_form_xobjects(doc, res, ids, visited);
        }
    }
}

/// 1つのコンテンツストリームを処理して Type3 BTブロックを削除する
fn process_content_stream(doc: &mut Document, stream_id: ObjectId) -> Result<usize, String> {
    // ストリームの Resources から Type3 フォント名を収集
    let type3_font_names = collect_type3_font_names(doc, stream_id);

    if type3_font_names.is_empty() {
        return Ok(0);
    }

    // ストリームデータを取得
    let stream_data = {
        let obj = doc.get_object(stream_id)
            .map_err(|e| format!("get stream {stream_id:?}: {e}"))?;
        let stream = obj.as_stream()
            .map_err(|e| format!("as_stream {stream_id:?}: {e}"))?;
        stream.decompressed_content()
            .map_err(|e| format!("decompress {stream_id:?}: {e}"))?
    };

    let content_str = String::from_utf8_lossy(&stream_data).into_owned();

    // BT...ET ブロックを処理して Type3 を使うものを削除
    let (new_content, removed) = remove_type3_bt_blocks(&content_str, &type3_font_names);

    if removed == 0 {
        return Ok(0);
    }

    // ストリームを更新
    let obj = doc.get_object_mut(stream_id)
        .map_err(|e| format!("get_mut {stream_id:?}: {e}"))?;
    let stream = obj.as_stream_mut()
        .map_err(|e| format!("as_stream_mut {stream_id:?}: {e}"))?;

    stream.set_plain_content(new_content.into_bytes());
    stream.compress()
        .map_err(|e| format!("compress: {e}"))?;

    Ok(removed)
}

/// ストリームの Resources から Type3 フォントのリソース名（例: "F32"）を収集する
fn collect_type3_font_names(doc: &Document, stream_id: ObjectId) -> HashSet<String> {
    let mut type3_names = HashSet::new();

    let obj = match doc.get_object(stream_id).ok() {
        Some(o) => o.clone(),
        None => return type3_names,
    };

    let stream = match obj.as_stream() {
        Ok(s) => s.clone(),
        Err(_) => return type3_names,
    };

    // /Resources /Font 辞書を取得
    let resources_obj = match stream.dict.get(b"Resources").ok() {
        Some(r) => r.clone(),
        None => return type3_names,
    };

    let resources = match &resources_obj {
        Object::Reference(id) => match doc.get_object(*id).ok() {
            Some(o) => o.clone(),
            None => return type3_names,
        },
        other => other.clone(),
    };

    let res_dict = match resources.as_dict() {
        Ok(d) => d.clone(),
        Err(_) => return type3_names,
    };

    let font_obj = match res_dict.get(b"Font").ok() {
        Some(f) => f.clone(),
        None => return type3_names,
    };

    let font_dict = {
        let resolved = match &font_obj {
            Object::Reference(id) => match doc.get_object(*id).ok() {
                Some(o) => o.clone(),
                None => return type3_names,
            },
            other => other.clone(),
        };
        match resolved.as_dict() {
            Ok(d) => d.clone(),
            Err(_) => return type3_names,
        }
    };

    // 各フォントエントリの /Subtype を確認
    for (font_name_bytes, font_ref) in font_dict.iter() {
        let font_id = match font_ref {
            Object::Reference(id) => *id,
            _ => continue,
        };

        let font_obj = match doc.get_object(font_id).ok() {
            Some(o) => o.clone(),
            None => continue,
        };

        let font_dict = match font_obj.as_dict() {
            Ok(d) => d.clone(),
            Err(_) => continue,
        };

        let subtype = font_dict.get(b"Subtype").ok()
            .and_then(|o| o.as_name().ok().map(|n| n.to_vec()));

        if subtype.as_deref() == Some(b"Type3")
            && let Ok(name) = std::str::from_utf8(font_name_bytes) {
                type3_names.insert(name.to_string());
            }
    }

    type3_names
}

/// コンテンツストリームから Type3 フォントを使う BT...ET ブロックを削除する
fn remove_type3_bt_blocks(content: &str, type3_fonts: &HashSet<String>) -> (String, usize) {
    let mut result = String::with_capacity(content.len());
    let mut removed = 0;

    // BT...ET ブロックを正規表現で分割せず、手動でパース
    // BT と ET はそれぞれ独立したトークンとして出現する
    let mut pos = 0;
    let bytes = content.as_bytes();
    let len = bytes.len();

    while pos < len {
        // "BT" トークンを探す（前後が区切り文字）
        if let Some(bt_start) = find_token(bytes, pos, b"BT") {
            // BT より前の部分を出力
            result.push_str(&content[pos..bt_start]);

            // ET トークンを探す
            if let Some(et_end) = find_token_end(bytes, bt_start + 2, b"ET") {
                let block = &content[bt_start..et_end];

                // このブロック内に Type3 フォントの Tf 命令があるか確認
                if uses_type3_font(block, type3_fonts) {
                    // 削除: 出力しない
                    // 改行は保持して行番号がずれないようにする
                    let newlines: String = block.chars()
                        .filter(|&c| c == '\n')
                        .collect();
                    result.push_str(&newlines);
                    removed += 1;
                } else {
                    result.push_str(block);
                }

                pos = et_end;
            } else {
                // ET が見つからない（不正なストリーム）→ そのまま出力
                result.push_str(&content[bt_start..]);
                pos = len;
            }
        } else {
            // BT が見つからない → 残りをそのまま出力
            result.push_str(&content[pos..]);
            pos = len;
        }
    }

    (result, removed)
}

/// content 内に type3_fonts に含まれるフォント名の Tf 命令があるか確認
/// 例: "/F32 90.66 Tf" の F32 が type3_fonts に含まれるか
fn uses_type3_font(block: &str, type3_fonts: &HashSet<String>) -> bool {
    // "/FontName size Tf" パターンを探す
    let bytes = block.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'/' {
            // フォント名の開始
            let name_start = i + 1;
            let mut name_end = name_start;
            while name_end < bytes.len() && !bytes[name_end].is_ascii_whitespace() {
                name_end += 1;
            }
            if let Ok(name) = std::str::from_utf8(&bytes[name_start..name_end]) {
                // 後続に数値と Tf があるか確認
                let rest = &block[name_end..];
                let trimmed = rest.trim_start();
                // 数値 Tf パターン
                if is_tf_instruction(trimmed) && type3_fonts.contains(name) {
                    return true;
                }
            }
        }
        i += 1;
    }
    false
}

/// 文字列が "数値 Tf" または "数値 数値 Tf" で始まるか確認
fn is_tf_instruction(s: &str) -> bool {
    let mut rest = s.trim_start();
    // 数値をスキップ
    let mut num_count = 0;
    loop {
        let trimmed = rest.trim_start();
        if let Some(after) = trimmed.strip_prefix("Tf") {
            return after.is_empty() || after.starts_with(|c: char| c.is_ascii_whitespace());
        }
        // 数値部分をスキップ
        let num_end = trimmed.find(|c: char| !c.is_ascii_digit() && c != '.' && c != '-');
        match num_end {
            Some(0) => return false, // 数値でも Tf でもない
            Some(n) => {
                rest = &trimmed[n..];
                num_count += 1;
                if num_count > 3 {
                    return false;
                }
            }
            None => return false,
        }
    }
}

/// bytes[start..] から "token" をトークンとして探し、開始位置を返す
/// トークンの前後は ASCII 空白または開始/終端
fn find_token(bytes: &[u8], start: usize, token: &[u8]) -> Option<usize> {
    let tlen = token.len();
    let mut i = start;
    while i + tlen <= bytes.len() {
        if &bytes[i..i + tlen] == token {
            let before_ok = i == 0 || bytes[i - 1].is_ascii_whitespace();
            let after_ok = i + tlen >= bytes.len()
                || bytes[i + tlen].is_ascii_whitespace()
                || bytes[i + tlen] == b'%'; // コメント
            if before_ok && after_ok {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// bytes[start..] から "ET" を探し、ET の直後の位置（次の行頭相当）を返す
fn find_token_end(bytes: &[u8], start: usize, token: &[u8]) -> Option<usize> {
    let pos = find_token(bytes, start, token)?;
    let end = pos + token.len();
    // ET の後の空白・改行もスキップして次のトークンの先頭に
    let mut e = end;
    while e < bytes.len() && bytes[e] != b'\n' {
        e += 1;
    }
    if e < bytes.len() {
        e += 1; // '\n' を含める
    }
    Some(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_uses_type3_font() {
        let mut type3 = HashSet::new();
        type3.insert("F32".to_string());

        let block_with = "BT\n/F32 90.66 Tf\n1 0 0 -1 13 97 Tm\n(&) Tj\nET";
        let block_without = "BT\n/F10 13.33 Tf\n1 0 0 -1 3 11 Tm\n<0057> Tj\nET";

        assert!(uses_type3_font(block_with, &type3));
        assert!(!uses_type3_font(block_without, &type3));
    }

    #[test]
    fn test_remove_type3_bt_blocks() {
        let mut type3 = HashSet::new();
        type3.insert("F32".to_string());

        let content = concat!(
            "BT\n/F10 13.33 Tf\n<0057> Tj\nET\n",
            "BT\n/F32 90.66 Tf\n(&) Tj\nET\n",
            "BT\n/F33 90.66 Tf\n(&) Tj\nET\n",
        );

        let (result, removed) = remove_type3_bt_blocks(content, &type3);
        assert_eq!(removed, 1);
        assert!(result.contains("/F10"));
        assert!(!result.contains("/F32"));
        assert!(result.contains("/F33"));
    }
}
