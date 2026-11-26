// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/lib.rs
// Tauri sidecar / 他クレートから呼べる公開 API

pub mod api;
pub mod backend;
mod clean_lopdf;
pub mod compress;
mod compress_lopdf;
pub mod content_filter;
pub mod convert;
pub mod cover_patch;
pub mod crop_cleanup;
mod crop_redact_lopdf;
pub mod engine_notice;
pub mod error;
pub mod ffi;
mod font_gidfix_lopdf;
pub mod font_subset;
mod font_subset_lopdf;
mod font_usage;
pub mod gid_fix;
mod hidden_scan_lopdf;
mod hidden_text_lopdf;
pub mod image_recompress;
pub mod imposition;
pub mod info;
pub mod jpeg_lossless;
#[cfg(feature = "jpeg-optimize")]
pub mod jpeg_optimize;
pub mod merge;
pub mod pixmap;
pub mod render;
#[cfg(feature = "hayro")]
pub mod render_hayro;
mod resource_prune;
pub mod rotate;
pub mod safe_load;
mod sanitize_ops;
pub mod split;
mod std14_widths;
pub mod stext;
mod tounicode_fix_lopdf;
mod tounicode_lopdf;
pub mod trim;
pub mod type3_sanitize;
pub mod visible_crop;

// 開発用: mupdf-sys シンボル探索（本実装前に削除予定）
#[allow(dead_code)]
mod sys_probe;

pub use error::{CoreError, Result};
