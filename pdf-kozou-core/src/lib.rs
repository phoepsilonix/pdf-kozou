// pdf-kozou-core/src/lib.rs
// Tauri sidecar / 他クレートから呼べる公開 API

pub mod compress;
pub mod error;
pub mod font_subset;
pub mod info;
pub mod merge;
pub mod pixmap;
pub mod render;
pub mod rotate;
pub mod split;
pub mod trim;

// 開発用: mupdf-sys シンボル探索（本実装前に削除予定）
#[allow(dead_code)]
mod sys_probe;

pub use error::{CoreError, Result};
