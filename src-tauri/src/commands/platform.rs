// src-tauri/src/commands/platform.rs
//
// フロントエンドから呼び出すファイルダイアログ・画面情報コマンド。
// すべて platform モジュール経由で xdg-desktop-portal を使わない実装を呼ぶ。

use serde::{Deserialize, Serialize};
use crate::platform:ScreenInfo;

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
#[tauri::command]
pub async fn get_screen_info() -> Result<ScreenInfo, String> {
    #[cfg(target_os = "linux")]
    {
        let info = platform::get_screen_info();
        Ok(ScreenInfo {
            display_server: format!("{:?}", info.display_server),
            width: info.width,
            height: info.height,
            scale_factor: info.scale_factor,
        })
    }
    #[cfg(not(target_os = "linux"))]
    Ok(ScreenInfo {
        display_server: "Native".to_string(),
        width: 1920,
        height: 1080,
        scale_factor: 1.0,
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
