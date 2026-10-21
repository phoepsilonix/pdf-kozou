// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/merge.rs
use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct MergeRequest {
    pub inputs: Vec<String>,
    pub output: String,
}

#[derive(Serialize)]
pub struct MergeResponse {
    pub ok: bool,
    pub page_count: i32,
    pub output_bytes: u64,
}

/// 結合のエントリポイント。
///
/// まず lopdf 実装を試し、読み込み不能・暗号化など lopdf が扱えない入力のときだけ
/// 従来の MuPDF 実装へフォールバックする（移行期間中の安全策）。
pub fn merge(req: &MergeRequest) -> Result<MergeResponse> {
    if req.inputs.is_empty() {
        return Err(CoreError::InvalidArg("inputs is empty".into()));
    }
    match merge_with_lopdf(req) {
        Ok(res) => Ok(res),
        Err(e) => {
            eprintln!("[merge] lopdf path failed ({e}); falling back to MuPDF");
            merge_with_mupdf(req)
        }
    }
}

/// ページツリーの親をたどって継承属性 (Resources / MediaBox / CropBox / Rotate) を探す。
pub(crate) fn inherited_attr(doc: &lopdf::Document, page_id: lopdf::ObjectId, key: &[u8]) -> Option<lopdf::Object> {
    let mut cur = page_id;
    // 循環参照対策で深さを制限する
    for _ in 0..64 {
        let dict = doc.get_dictionary(cur).ok()?;
        if let Ok(v) = dict.get(key) {
            return Some(v.clone());
        }
        cur = dict.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

/// 継承属性 (Resources / MediaBox / CropBox / Rotate) を各ページ自身の辞書へ展開する。
/// ページを別ドキュメントへ移す前に呼ぶ（親 Pages ノードを持ち越さないため）。
pub(crate) fn flatten_inherited_attrs(doc: &mut lopdf::Document, page_ids: &[lopdf::ObjectId]) {
    use lopdf::Object;
    for &pid in page_ids {
        for key in [&b"Resources"[..], b"MediaBox", b"CropBox", b"Rotate"] {
            let has = doc.get_dictionary(pid).map(|d| d.has(key)).unwrap_or(false);
            if !has {
                if let Some(v) = inherited_attr(doc, pid, key) {
                    if let Ok(Object::Dictionary(d)) = doc.get_object_mut(pid) {
                        d.set(key.to_vec(), v);
                    }
                }
            }
        }
    }
}

/// オブジェクト内の間接参照の番号を一律にずらす（結合時の番号衝突回避）。
fn shift_refs(obj: &mut lopdf::Object, off: u32) {
    use lopdf::Object;
    match obj {
        Object::Reference(id) => id.0 += off,
        Object::Array(a) => a.iter_mut().for_each(|o| shift_refs(o, off)),
        Object::Dictionary(d) => d.iter_mut().for_each(|(_, v)| shift_refs(v, off)),
        Object::Stream(s) => s.dict.iter_mut().for_each(|(_, v)| shift_refs(v, off)),
        _ => {}
    }
}

/// lopdf による結合。
///
/// - 各入力の全オブジェクトを番号をずらして取り込み、ページツリーだけ作り直す。
///   （フォント等のリソースは入力内の共有関係のまま保たれ、ページ数分に複製されない）
/// - 親 Pages ノードから継承される属性は、取り込む前に各ページへ展開する。
/// - 旧カタログ・旧ページツリー・しおり等は到達不能になるので prune で落とす。
///   （しおりは従来から未対応）
/// - メタデータは先頭ファイルの /Info を読み込み済みの文書から取り、保存前に新しい文書へ設定する。
fn merge_with_lopdf(req: &MergeRequest) -> Result<MergeResponse> {
    use lopdf::{Dictionary, Document, Object};

    let mut metadata: Vec<(String, String)> = Vec::new();

    let mut dst = Document::with_version("1.5");
    let pages_id = dst.new_object_id();
    let mut kids: Vec<Object> = Vec::new();

    for (input_index, input_path) in req.inputs.iter().enumerate() {
        let (mut src, _) = crate::safe_load::load_checked(input_path)?;
        if src.is_encrypted() {
            return Err(CoreError::Parse(format!("{input_path}: encrypted PDF")));
        }
        if input_index == 0 {
            // 先頭ファイルのメタデータを引き継ぐ（読み込み済みの文書から取る）
            metadata = crate::compress::metadata_from_doc(&src);
        }
        if src.version.as_str() > dst.version.as_str() {
            dst.version = src.version.clone();
        }

        // 継承属性を各ページへ展開（番号をずらす前の src 上で行う）
        let page_ids: Vec<_> = src.get_pages().into_values().collect();
        if page_ids.is_empty() {
            return Err(CoreError::Parse(format!("{input_path}: no pages")));
        }
        flatten_inherited_attrs(&mut src, &page_ids);

        // 番号をずらして dst へ取り込む
        let off = dst.max_id;
        for (id, mut obj) in std::mem::take(&mut src.objects) {
            shift_refs(&mut obj, off);
            dst.objects.insert((id.0 + off, id.1), obj);
        }
        dst.max_id = off + src.max_id;

        for pid in page_ids {
            let new_id = (pid.0 + off, pid.1);
            if let Ok(Object::Dictionary(d)) = dst.get_object_mut(new_id) {
                d.set("Parent", Object::Reference(pages_id));
            }
            kids.push(Object::Reference(new_id));
        }
    }

    let total_pages = kids.len() as i32;
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

    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);
    Ok(MergeResponse {
        ok: true,
        page_count: total_pages,
        output_bytes,
    })
}


/// 従来の MuPDF 実装（lopdf 実装が失敗したときのフォールバック）。
fn merge_with_mupdf(req: &MergeRequest) -> Result<MergeResponse> {
    use mupdf::pdf::PdfDocument;

    if req.inputs.is_empty() {
        return Err(CoreError::InvalidArg("inputs is empty".into()));
    }

    // 最初の入力ファイルのメタデータを出力に引き継ぐ（主ファイル優先）
    let metadata = crate::compress::collect_metadata(&req.inputs[0]);

    let mut dst = PdfDocument::new();
    let mut total_pages = 0i32;

    for input_path in &req.inputs {
        let src = PdfDocument::open(input_path)
            .map_err(|e| CoreError::MuPdf(format!("{}: {}", input_path, e)))?;

        let n = src
            .page_count()
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        // GraftMap でリソースを dst にコピーしながらページを移植
        let mut graft = dst
            .new_graft_map()
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

        for i in 0..n {
            let src_page = src
                .find_page(i)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

            // ページオブジェクトを graft して dst に追加
            let dst_page = graft
                .graft_object(&src_page)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

            // mupdf 0.6: -1 は無効。現在のページ数 = 末尾に追加
            let at = dst
                .page_count()
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
            dst.insert_page(at, &dst_page)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
        }
        total_pages += n;
    }

    let mut opts = mupdf::pdf::PdfWriteOptions::default();
    // gc=1: 未参照オブジェクト除去のみ。サイズ削減は連携圧縮機能で。
    opts.set_compress(true).set_garbage_level(1);
    dst.save_with_options(&req.output, opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    // 最初の入力ファイルのメタデータを出力に引き継ぐ
    crate::compress::copy_metadata_after_write(&req.output, &metadata);

    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);
    Ok(MergeResponse {
        ok: true,
        page_count: total_pages,
        output_bytes,
    })
}
