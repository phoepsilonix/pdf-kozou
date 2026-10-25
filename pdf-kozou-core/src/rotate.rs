// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/rotate.rs
//
// 設計方針:
//   Rotate エントリの書き換えのみ。
//   set_incremental(true) + gc=0 で保存することで、
//   /Info を含む全メタデータがそのまま保持される。
//   サイズ削減が必要な場合は連携圧縮機能を使う。

use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PageRotation {
    pub page: i32,
    pub angle: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RotateRequest {
    pub input: String,
    pub output: String,
    #[serde(default)]
    pub angle: Option<i32>,
    #[serde(default)]
    pub rotations: Option<Vec<PageRotation>>,
    #[serde(default)]
    pub pages: Option<Vec<i32>>,
}

#[derive(Serialize)]
pub struct RotateResponse {
    pub ok: bool,
}

fn validate_angle(deg: i32) -> Result<i32> {
    let n = deg.rem_euclid(360);
    match n {
        0 | 90 | 180 | 270 => Ok(n),
        _ => Err(CoreError::InvalidArg(format!(
            "angle must be 0, 90, 180, or 270 (got {})",
            deg
        ))),
    }
}

/// 回転のエントリポイント。
///
/// まず lopdf 実装を試し、読み込み不能など lopdf が扱えない入力のときだけ
/// 従来の MuPDF 実装へフォールバックする（移行期間中の安全策）。
pub fn rotate(req: &RotateRequest) -> Result<RotateResponse> {
    if crate::backend::try_lopdf("rotate") {
        match rotate_with_lopdf(req) {
            Ok(res) => return Ok(res),
            Err(e @ CoreError::InvalidArg(_)) => return Err(e),
            Err(e) => {
                if crate::backend::abort_on_lopdf_failure("rotate", &e) {
                    return Err(e);
                }
            }
        }
    }
    rotate_with_mupdf(req)
}

/// ページ(0始まり) -> 加える角度 の対応表を作る。
/// --angle(全ページ/指定ページ)の後に --rotations(ページ個別)で上書きする。
fn build_angle_map(
    req: &RotateRequest,
    page_count: i32,
) -> Result<std::collections::HashMap<i32, i32>> {
    let mut angle_map = std::collections::HashMap::new();
    if let Some(deg) = req.angle {
        let deg = validate_angle(deg)?;
        let targets: Vec<i32> = match &req.pages {
            None => (0..page_count).collect(),
            Some(pages) => pages.iter().map(|&p| p - 1).collect(),
        };
        for idx in targets {
            angle_map.insert(idx, deg);
        }
    }
    if let Some(rotations) = &req.rotations {
        for pr in rotations {
            let deg = validate_angle(pr.angle)?;
            angle_map.insert(pr.page - 1, deg);
        }
    }
    Ok(angle_map)
}

/// ページの現在の回転角。ページ自身に無ければ親 Pages ノードから継承し、
/// 間接参照・実数・範囲外の値も正規化して 0/90/180/270 にする。
fn current_rotation(doc: &lopdf::Document, page_id: lopdf::ObjectId) -> i32 {
    use lopdf::Object;
    let Some(mut obj) = crate::merge::inherited_attr(doc, page_id, b"Rotate") else {
        return 0;
    };
    for _ in 0..8 {
        match obj {
            Object::Reference(id) => match doc.get_object(id) {
                Ok(o) => obj = o.clone(),
                Err(_) => return 0,
            },
            Object::Integer(n) => return (n as i32).rem_euclid(360),
            Object::Real(f) => return (f as i32).rem_euclid(360),
            _ => return 0,
        }
    }
    0
}

/// lopdf による回転。
///
/// 従来どおり増分保存で、変更したページ辞書だけを末尾に追記する。元のバイト列は
/// そのまま残るので、/Info・しおり・フォーム・注釈などは一切触らない。
fn rotate_with_lopdf(req: &RotateRequest) -> Result<RotateResponse> {
    use lopdf::{IncrementalDocument, Object};

    let mut doc = IncrementalDocument::load(&req.input)
        .map_err(|e| CoreError::Parse(format!("{}: {e}", req.input)))?;
    let page_ids: Vec<lopdf::ObjectId> = doc.get_prev_documents().get_pages().into_values().collect();
    if page_ids.is_empty() {
        return Err(CoreError::Parse(format!("{}: no pages", req.input)));
    }
    let page_count = page_ids.len() as i32;
    let angle_map = build_angle_map(req, page_count)?;

    let mut changed = false;
    for (&idx, &add_deg) in &angle_map {
        if idx < 0 || idx >= page_count {
            continue;
        }
        let pid = page_ids[idx as usize];
        let new_angle = (current_rotation(doc.get_prev_documents(), pid) + add_deg).rem_euclid(360);
        doc.opt_clone_object_to_new_document(pid)
            .map_err(|e| CoreError::Parse(e.to_string()))?;
        if let Ok(Object::Dictionary(d)) = doc.new_document.get_object_mut(pid) {
            d.set("Rotate", Object::Integer(new_angle as i64));
            changed = true;
        }
    }

    if changed {
        doc.save(&req.output)
            .map_err(|e| CoreError::Parse(format!("{}: {e}", req.output)))?;
    } else {
        // 変更なし: そのままコピー（空の更新セクションを足さない）
        std::fs::copy(&req.input, &req.output)?;
    }
    Ok(RotateResponse { ok: true })
}

/// 従来の MuPDF 実装（lopdf 実装が失敗したときのフォールバック）。
fn rotate_with_mupdf(req: &RotateRequest) -> Result<RotateResponse> {
    use mupdf::pdf::{PdfDocument, PdfWriteOptions};
    use std::collections::HashMap;

    let doc = PdfDocument::open(&req.input).map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let page_count = doc
        .page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let mut angle_map: HashMap<i32, i32> = HashMap::new();

    if let Some(deg) = req.angle {
        let deg = validate_angle(deg)?;
        let targets: Vec<i32> = match &req.pages {
            None => (0..page_count).collect(),
            Some(pages) => pages.iter().map(|&p| p - 1).collect(),
        };
        for idx in targets {
            angle_map.insert(idx, deg);
        }
    }
    if let Some(rotations) = &req.rotations {
        for pr in rotations {
            let deg = validate_angle(pr.angle)?;
            angle_map.insert(pr.page - 1, deg);
        }
    }

    for (idx, add_deg) in &angle_map {
        let idx = *idx;
        if idx < 0 || idx >= page_count {
            continue;
        }
        let mut page_obj = doc
            .find_page(idx)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

        let current = page_obj
            .get_dict("Rotate")
            .ok()
            .flatten()
            .and_then(|obj| obj.resolve().ok().flatten())
            .and_then(|obj| obj.as_int().ok())
            .unwrap_or(0);

        let new_angle = (current + add_deg).rem_euclid(360);
        let angle_obj = doc
            .new_object_from_str(&new_angle.to_string())
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        page_obj
            .dict_put("Rotate", angle_obj)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
    }

    // インクリメンタル保存: Rotate 変更のみ追記、/Info 保持
    let mut opts = PdfWriteOptions::default();
    opts.set_incremental(true)
        .set_garbage_level(0) // gc 不要（構造変更なし）
        .set_compress(true)
        .set_clean(false);

    doc.save_with_options(&req.output, opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    Ok(RotateResponse { ok: true })
}
