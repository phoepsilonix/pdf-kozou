// src-tauri/src/commands/platform.rs
//
// フロントエンドから呼び出すファイルダイアログ・画面情報コマンド。
// すべて platform モジュール経由で xdg-desktop-portal を使わない実装を呼ぶ。

use serde::{Deserialize, Serialize};
use crate::platform;

/*
#[derive(Serialize, Deserialize)]
pub struct ScreenInfoDto {
    pub display_server: String,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}
*/
/// スクリーン情報を返す (フロントエンドが HiDPI 対応に使用)
use tauri::{Manager, Window};
use crate::platform::{ScreenInfo, DisplayServer};

#[tauri::command]
pub async fn get_screen_info(window: Window) -> Result<ScreenInfo, String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;

    let monitor = window
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("No primary monitor available".to_string())?;

    let size = monitor.size();

    // Linuxではネイティブ検出、それ以外はUnknown
    #[cfg(target_os = "linux")]
    let display_server = crate::platform::linux::detect_display_server();
    #[cfg(not(target_os = "linux"))]
    let display_server = DisplayServer::Unknown;

    Ok(ScreenInfo {
        display_server,
        width: size.width as u32,
        height: size.height as u32,
        scale_factor: scale,
    })
}

/// PDF を開くダイアログ (単一ファイル)
/// xdg-desktop-portal 不使用、GTK3 直接
#[tauri::command]
pub async fn pick_open_file() -> Result<Option<String>, String> {
    let path = platform::open_pdf_dialog().await;
    Ok(path.map(|p| p.display().to_string()))
}

/// PDF を開くダイアログ (複数ファイル)
#[tauri::command]
pub async fn pick_open_files() -> Result<Vec<String>, String> {
    let paths = platform::open_pdfs_dialog().await;
    Ok(paths.iter().map(|p| p.display().to_string()).collect())
}

/// 保存先ダイアログ (初期ディレクトリ指定付き)
#[tauri::command]
pub async fn pick_save_file_in(
    default_name: String,
    initial_dir:  Option<String>,
) -> Result<Option<String>, String> {
    let path = platform::save_pdf_dialog_in(&default_name, initial_dir.as_deref()).await;
    Ok(path.map(|p| p.display().to_string()))
}

/// 保存先ダイアログ
#[tauri::command]
pub async fn pick_save_file(default_name: String) -> Result<Option<String>, String> {
    let path = platform::save_pdf_dialog(&default_name).await;
    Ok(path.map(|p| p.display().to_string()))
}

/// 出力ディレクトリ選択ダイアログ
#[tauri::command]
pub async fn pick_output_dir() -> Result<Option<String>, String> {
    let path = platform::pick_output_dir().await;
    Ok(path.map(|p| p.display().to_string()))
}
