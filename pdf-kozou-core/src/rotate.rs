// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/rotate.rs
use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};

/// ページごとの回転指定
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PageRotation {
    /// ページ番号 (1始まり)
    pub page: i32,
    /// 回転角度 (絶対値): 0 | 90 | 180 | 270
    pub angle: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RotateRequest {
    pub input: String,
    pub output: String,
    /// 全ページ共通の回転角度 (0 | 90 | 180 | 270)
    #[serde(default)]
    pub angle: Option<i32>,
    /// ページ個別の回転角度リスト (angle より優先)
    #[serde(default)]
    pub rotations: Option<Vec<PageRotation>>,
    /// angle 適用対象ページ (1始まり)。省略時は全ページ
    #[serde(default)]
    pub pages: Option<Vec<i32>>,
}

#[derive(Serialize)]
pub struct RotateResponse {
    pub ok: bool,
}

fn validate_angle(deg: i32) -> crate::error::Result<i32> {
    let n = deg.rem_euclid(360);
    match n {
        0 | 90 | 180 | 270 => Ok(n),
        _ => Err(CoreError::InvalidArg(format!(
            "angle must be 0, 90, 180, or 270 (got {})",
            deg
        ))),
    }
}

pub fn rotate(req: &RotateRequest) -> Result<RotateResponse> {
    use mupdf::pdf::PdfDocument;
    use std::collections::HashMap;

    // メタデータを最初に収集（save 前に入力から取得しておく）
    let metadata = crate::compress::collect_metadata(&req.input);

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

        // 既存の Rotate 値を取得して累積
        let current = page_obj
            .get_dict("Rotate")
            .ok()
            .flatten()
            .and_then(|obj| obj.resolve().ok().flatten())
            .and_then(|obj| obj.as_int().ok())
            .unwrap_or(0);

        let new_angle = (current + add_deg).rem_euclid(360);

        // 整数リテラルは直接オブジェクト — 循環参照は起きない
        let angle_obj = doc
            .new_object_from_str(&new_angle.to_string())
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        page_obj
            .dict_put("Rotate", angle_obj)
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
    }

    let mut opts = mupdf::pdf::PdfWriteOptions::default();
    // gc=2 + clean=true だとレイアウト崩れが起きることが確認済み
    // 安全設定: gc=2, clean=false
    opts.set_compress(true)
        .set_compress_fonts(true)
        .set_garbage_level(2)
        .set_clean(false);

    doc.save_with_options(&req.output, opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    // メタデータを書き戻す（gc=2 で /Info が消えた場合に復元）
    crate::compress::copy_metadata_after_write(&req.output, &metadata);

    Ok(RotateResponse { ok: true })
}
