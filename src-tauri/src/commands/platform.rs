// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/commands/platform.rs
//
// フロントエンドから呼び出すファイルダイアログ・画面情報コマンド。
// すべて platform モジュール経由で xdg-desktop-portal を使わない実装を呼ぶ。

use crate::platform;

#[cfg(not(target_os = "linux"))]
use crate::platform::DisplayServer;

/*
#[derive(Serialize, Deserialize)]
pub struct ScreenInfoDto {
    pub display_server: String,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}
*/
use crate::platform::ScreenInfo;
/// スクリーン情報を返す (フロントエンドが HiDPI 対応に使用)
use tauri::Window;

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
        width: size.width,
        height: size.height,
        scale_factor: scale,
    })
}

/// フロントエンドがモバイル(Android/iOS)かどうかを判定するためのコマンド。
///
/// モバイルでは tauri-plugin-dialog にフォルダ選択 API が無く、
/// `pick_output_dir` はダイアログを出さずアプリ専用一時ディレクトリを返す
/// (SAFのツリーURI取得・書き込みは未対応のため)。そのため各ページは、
/// モバイルでは「フォルダを選んで複数ファイルを書き出す」フローではなく、
/// `pick_save_file` + `commit_saved_file` によるファイル単位の保存フローを
/// 使う必要がある。
#[tauri::command]
pub fn is_mobile() -> bool {
    cfg!(mobile)
}

/// PDF を開くダイアログ (単一ファイル)
/// デスクトップ: xdg-desktop-portal 不使用、GTK3 直接 (Linux) / rfd (macOS, Windows)
/// モバイル: tauri-plugin-dialog のネイティブピッカーを使用
#[tauri::command]
pub async fn pick_open_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(mobile)]
    let path = platform::open_pdf_dialog(&app).await?;
    #[cfg(not(mobile))]
    let path = {
        let _ = &app;
        platform::open_pdf_dialog().await
    };
    Ok(path.map(|p| p.display().to_string()))
}

/// PDF を開くダイアログ (複数ファイル)
#[tauri::command]
pub async fn pick_open_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    #[cfg(mobile)]
    let paths = platform::open_pdfs_dialog(&app).await?;
    #[cfg(not(mobile))]
    let paths = {
        let _ = &app;
        platform::open_pdfs_dialog().await
    };
    Ok(paths.iter().map(|p| p.display().to_string()).collect())
}

/// 保存先ダイアログ (初期ディレクトリ指定付き)
#[tauri::command]
pub async fn pick_save_file_in(
    app: tauri::AppHandle,
    default_name: String,
    _initial_dir: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(mobile)]
    let path = platform::save_pdf_dialog_in(&app, &default_name).await;
    #[cfg(not(mobile))]
    let path = {
        let _ = &app;
        platform::save_pdf_dialog_in(&default_name, _initial_dir.as_deref()).await
    };
    Ok(path.map(|p| p.display().to_string()))
}

/// 保存先ダイアログ
#[tauri::command]
pub async fn pick_save_file(
    app: tauri::AppHandle,
    default_name: String,
) -> Result<Option<String>, String> {
    #[cfg(mobile)]
    let path = platform::save_pdf_dialog(&app, &default_name).await;
    #[cfg(not(mobile))]
    let path = {
        let _ = &app;
        platform::save_pdf_dialog(&default_name).await
    };
    Ok(path.map(|p| p.display().to_string()))
}

/// `pick_save_file` / `pick_save_file_in` が返した一時パスへ core が書き込みを
/// 終えた後に呼ぶ。モバイルでユーザーが選んだ実際の保存先(content:// URI 等)
/// が登録されていれば、その中身をコピーしてから一時ファイルを削除する。
///
/// デスクトップでは何もしない(pick_save_file が返すのは既に実際の保存先の
/// パスそのものであり、core が直接そこへ書き込んでいるため)。
#[tauri::command]
pub async fn commit_saved_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(mobile)]
    {
        return platform::finalize_pending_save(&app, &path);
    }
    #[cfg(not(mobile))]
    {
        let _ = (&app, &path);
        Ok(())
    }
}

/// 出力ディレクトリ選択ダイアログ
#[tauri::command]
pub async fn pick_output_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(mobile)]
    let path = platform::pick_output_dir(&app).await;
    #[cfg(not(mobile))]
    let path = {
        let _ = &app;
        platform::pick_output_dir().await
    };
    Ok(path.map(|p| p.display().to_string()))
}

/// バッチ出力の1ファイル分の保存結果 (Android のみ有効)。
#[derive(serde::Serialize)]
pub struct SavedFileInfo {
    pub uri: String,
    pub display_name: String,
    pub relative_path: String,
    pub source_relative: String,
}

/// バッチ出力(複数ファイル書き出し)の後処理。
///
/// `temp_dir` (通常は `pick_output_dir` が返した一時ディレクトリ) 以下に
/// core が書き出したファイル群を、Android では
/// `ダウンロード/{relative_dir}/` 配下へ実際にコピーする。
/// Android にはモバイル向けのフォルダ選択ピッカーが無いため、
/// `relative_dir` はフロントエンド側で決め打ち生成した名前
/// (`buildMobileOutputSubfolder`) を渡す想定。
///
/// デスクトップおよび iOS (未対応) では何もせず空配列を返す
/// (デスクトップは `temp_dir` = 実際にユーザーが選んだ保存先そのもの
/// であり、追加の移動は不要)。
#[tauri::command]
pub async fn commit_saved_batch(
    app: tauri::AppHandle,
    temp_dir: String,
    relative_dir: String,
) -> Result<Vec<SavedFileInfo>, String> {
    #[cfg(target_os = "android")]
    {
        let results = platform::android_media_store::finalize_batch_to_downloads(
            &app,
            std::path::Path::new(&temp_dir),
            &relative_dir,
        )
        .await?;
        Ok(results
            .into_iter()
            .map(|r| SavedFileInfo {
                uri: r.uri,
                display_name: r.display_name,
                relative_path: r.relative_path,
                source_relative: r.source_relative,
            })
            .collect())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &temp_dir, &relative_dir);
        Ok(vec![])
    }
}
