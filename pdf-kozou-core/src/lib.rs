// pdf-kozou-core/src/lib.rs
// Tauri sidecar / 他クレートから呼べる公開 API

pub mod compress;
pub mod error;
pub mod info;
pub mod merge;
pub mod pixmap;
pub mod render;
pub mod rotate;
pub mod split;
pub mod trim;
// TODO: type3_filter は mupdf-sys + pdf_process_contents による
//       Type3 完全対応実装時に再追加する
#[allow(dead_code)]
mod sys_probe;

pub use error::{CoreError, Result};
