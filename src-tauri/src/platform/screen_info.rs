// src-tauri/src/platform/screen_info.rs

use serde::{Deserialize, Serialize};

// ── Display Server 種別 ──────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DisplayServer {
    X11,
    Wayland,
    WaylandWithXWayland, // XWayland も利用可能
    Headless,
    Unknown,
}

/// 現在の Display Server を環境変数から確実に検出する。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScreenInfo {
    pub display_server: DisplayServer,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}
