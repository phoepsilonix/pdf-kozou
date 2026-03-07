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

pub use error::{CoreError, Result};
