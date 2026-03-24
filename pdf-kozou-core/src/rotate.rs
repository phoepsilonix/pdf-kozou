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

pub fn rotate(req: &RotateRequest) -> Result<RotateResponse> {
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
