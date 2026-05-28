// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/lib.rs
// Tauri sidecar / 他クレートから呼べる公開 API

pub mod compress;
pub mod convert;
pub mod error;
pub mod ffi;
pub mod font_subset;
pub mod info;
pub mod merge;
pub mod pixmap;
pub mod render;
pub mod type3_sanitize;
pub mod rotate;
pub mod split;
pub mod stext;
pub mod trim;

// 開発用: mupdf-sys シンボル探索（本実装前に削除予定）
#[allow(dead_code)]
mod sys_probe;

pub use error::{CoreError, Result};
