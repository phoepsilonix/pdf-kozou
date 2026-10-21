// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/safe_load.rs
// lopdf で読んだ文書が、元のファイルの内容を落としていないか確かめる。
//
// lopdf は、/Length が実際と合わないストリームや、パースできないオブジェクトを、
// エラーにせず黙って落とす（ストリームが「内容の無い辞書」になる、オブジェクトごと
// 消える）。その文書を保存し直すと、白紙のページがエラーなしで出力されてしまう。
// MuPDF はこうしたファイルを回復して読める。
//
// そこで、xref が指す生のバイト列と突き合わせて落ちたものを検出し、見つかったら Err を
// 返す。呼び出し側は Err を受けて MuPDF 実装へフォールバックする。
// 検出が誤って働く場合（生のバイト列に似た並びがあるなど）も、フォールバックするだけで
// 安全側に倒れる。

use crate::error::{CoreError, Result};
use lopdf::xref::XrefEntry;
use lopdf::{Document, Object};

/// 辞書の直後に `stream` が続く並び（`>>` 空白* `stream` 改行）を探す。
fn looks_like_stream_after_dict(region: &[u8]) -> bool {
    const KEY: &[u8] = b"stream";
    // 辞書は短いので、先頭の一部だけ見れば足りる
    let region = &region[..region.len().min(256 * 1024)];
    let mut from = 0;
    while let Some(pos) = region[from..].windows(KEY.len()).position(|w| w == KEY) {
        let at = from + pos;
        from = at + 1;
        // 直前（空白を飛ばして）が `>>` であること。`endstream` は直前が `d` なので除かれる
        let mut b = at;
        while b > 0 && region[b - 1].is_ascii_whitespace() {
            b -= 1;
        }
        let after_dict = b >= 2 && &region[b - 2..b] == b">>";
        let after_kw = matches!(region.get(at + KEY.len()), Some(b'\r') | Some(b'\n'));
        if after_dict && after_kw {
            return true;
        }
    }
    false
}

/// 「N G obj」で始まっているか（xref のオフセットが本当にオブジェクトを指しているか）。
fn starts_with_obj_header(region: &[u8]) -> bool {
    let mut i = 0;
    let digits = |i: &mut usize| {
        let s = *i;
        while *i < region.len() && region[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > s
    };
    let skip_ws = |i: &mut usize| {
        while *i < region.len() && region[*i].is_ascii_whitespace() {
            *i += 1;
        }
    };
    skip_ws(&mut i);
    if !digits(&mut i) {
        return false;
    }
    skip_ws(&mut i);
    if !digits(&mut i) {
        return false;
    }
    skip_ws(&mut i);
    region[i..].starts_with(b"obj")
}

/// 標準セキュリティハンドラの暗号化辞書（/Filter /Standard）か。
fn is_encryption_dict(region: &[u8]) -> bool {
    let head = &region[..region.len().min(4096)];
    let has = |needle: &[u8]| head.windows(needle.len()).any(|w| w == needle);
    has(b"/Filter") && has(b"/Standard") && has(b"/O") && has(b"/U")
}

/// 読み込んだ文書が、元のバイト列のオブジェクトを落としていないか確かめる。
pub(crate) fn check_no_lost_objects(doc: &Document, bytes: &[u8], label: &str) -> Result<()> {
    // /Length が無い・解決できないストリームは、内容が読み込まれないまま位置だけが残る
    // （start_position が Some のまま内容が空）。保存し直すと内容が消える。
    if let Some((id, _)) = doc
        .objects
        .iter()
        .find(|(_, o)| matches!(o, Object::Stream(s) if s.start_position.is_some()))
    {
        return Err(CoreError::Parse(format!(
            "{label}: stream {} was not loaded by lopdf (missing /Length?)",
            id.0
        )));
    }
    // xref の通常エントリ（オブジェクトストリーム内のものは対象外）を、オフセット順に
    let mut entries: Vec<(u32, u16, usize)> = doc
        .reference_table
        .entries
        .iter()
        .filter_map(|(&id, e)| match e {
            XrefEntry::Normal { offset, generation } if *offset > 0 => {
                Some((id, *generation, *offset as usize))
            }
            _ => None,
        })
        .filter(|&(_, _, off)| off < bytes.len())
        .collect();
    entries.sort_by_key(|&(_, _, off)| off);

    for (k, &(id, generation, off)) in entries.iter().enumerate() {
        let end = entries.get(k + 1).map(|e| e.2).unwrap_or(bytes.len());
        let region = &bytes[off..end];
        if !starts_with_obj_header(region) {
            continue; // xref が当てにならない（再構築された等）。ここでは判断しない
        }
        match doc.objects.get(&(id, generation)) {
            None if is_encryption_dict(region) => {
                // 暗号化辞書は、lopdf が復号のあとで取り除く
            }
            None => {
                return Err(CoreError::Parse(format!(
                    "{label}: object {id} could not be read by lopdf"
                )));
            }
            Some(Object::Dictionary(_)) if looks_like_stream_after_dict(region) => {
                return Err(CoreError::Parse(format!(
                    "{label}: object {id} has a stream that lopdf dropped (invalid /Length?)"
                )));
            }
            _ => {}
        }
    }
    Ok(())
}

/// ファイルを読み、lopdf で解析して、内容が落ちていないか確かめる。
/// バイト列も一緒に返す（増分保存などで再利用できる）。
pub(crate) fn load_checked(path: &str) -> Result<(Document, Vec<u8>)> {
    let bytes = std::fs::read(path).map_err(CoreError::Io)?;
    let doc = Document::load_mem(&bytes).map_err(|e| CoreError::Parse(format!("{path}: {e}")))?;
    check_no_lost_objects(&doc, &bytes, path)?;
    Ok((doc, bytes))
}
