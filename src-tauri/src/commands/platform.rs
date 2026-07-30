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

/// 単一ファイル保存のB方式(`ACTION_OPEN_DOCUMENT_TREE` によるフォルダ単位
/// アクセス、`pick_save_folder`/`check_save_name_exists`/`begin_folder_save`)
/// は現状 Android にのみ実装されている。iOS では引き続き従来の
/// `pick_save_file`(A方式)を使うため、フロントエンドはこのコマンドで
/// Android かどうかを判定してから分岐する。
#[tauri::command]
pub fn is_android() -> bool {
    cfg!(target_os = "android")
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

/// 結果画面を離れる際などに呼ぶ。`pick_save_file`/`pick_save_file_in` が
/// 返した一時パスと、対応するSAF保存先の紐付け、および一時ファイルを破棄する。
/// (モバイルでのみ意味を持つ。デスクトップでは no-op)
/// これを呼んだ後は、同じ `path` に対して `commit_saved_file` を呼んでも
/// 何も起きない。
#[tauri::command]
pub async fn discard_pending_save(app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(mobile)]
    {
        return platform::discard_pending_save(&app, &path);
    }
    #[cfg(not(mobile))]
    {
        let _ = (&app, &path);
        Ok(())
    }
}

/// 単一ファイル保存(モバイルのみ)向け: `ACTION_OPEN_DOCUMENT_TREE` で
/// 保存先フォルダを選ばせる。デスクトップでは呼ばれない想定
/// (デスクトップは `pick_save_file` のネイティブ保存ダイアログのみ使う)。
///
/// ユーザーがキャンセルした場合は `Ok(None)`。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFolderDto {
    pub tree_uri: String,
    pub folder_name: String,
}

#[tauri::command]
pub async fn pick_save_folder(app: tauri::AppHandle) -> Result<Option<PickedFolderDto>, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let state = app
            .try_state::<platform::android_saf_folder::KozouSafFolder>()
            .ok_or("SafFolderPlugin is not registered")?;
        let picked = state.pick_folder()?;
        Ok(picked.map(|p| PickedFolderDto {
            tree_uri: p.tree_uri,
            folder_name: p.folder_name,
        }))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        Err("pick_save_folder is only available on Android".to_string())
    }
}

/// 指定フォルダ内に `file_name` と同名のファイルが既に存在するかどうか。
#[tauri::command]
pub async fn check_save_name_exists(
    app: tauri::AppHandle,
    tree_uri: String,
    file_name: String,
) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let state = app
            .try_state::<platform::android_saf_folder::KozouSafFolder>()
            .ok_or("SafFolderPlugin is not registered")?;
        Ok(state.find_file(&tree_uri, &file_name)?.is_some())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &tree_uri, &file_name);
        Err("check_save_name_exists is only available on Android".to_string())
    }
}

/// 指定フォルダ直下のファイル名一覧を返す(バッチ出力の事前衝突判定用)。
/// 出力ファイル数だけ `check_save_name_exists` を呼ぶと
/// `O(出力件数 × フォルダ内ファイル数)` になってしまうため、一度だけ
/// 列挙してフロント側でまとめて突き合わせる。
#[tauri::command]
pub async fn list_folder_names(
    app: tauri::AppHandle,
    tree_uri: String,
) -> Result<Vec<String>, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let state = app
            .try_state::<platform::android_saf_folder::KozouSafFolder>()
            .ok_or("SafFolderPlugin is not registered")?;
        state.list_folder_names(&tree_uri)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &tree_uri);
        Err("list_folder_names is only available on Android".to_string())
    }
}

/// デスクトップ版のバッチ画像出力(入力PDFごとのサブフォルダ)を
/// SAF側でも再現するための、子ディレクトリの取得(無ければ作成)コマンド。
#[tauri::command]
pub async fn get_or_create_subfolder(
    app: tauri::AppHandle,
    tree_uri: String,
    name: String,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let state = app
            .try_state::<platform::android_saf_folder::KozouSafFolder>()
            .ok_or("SafFolderPlugin is not registered")?;
        state.get_or_create_subfolder(&tree_uri, &name)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &tree_uri, &name);
        Err("get_or_create_subfolder is only available on Android".to_string())
    }
}

/// 選択済みフォルダ内へ保存を開始する。`overwrite = true` なら既存の
/// 同名ファイルを、`false` なら(呼び出し側が一意であると確認済みの)
/// 新しい名前でファイルを用意し、その実体(content:// URI)と
/// 一時パスの紐付けを `PendingSaves` に登録して一時パスを返す。
///
/// 戻り値の一時パスに core が処理結果を書き込んだ後、通常通り
/// `commit_saved_file` を呼べば実体へコピーされる(`discard_pending_save`
/// / メタデータ編集後の再コミットも既存の仕組みがそのまま使える)。
#[tauri::command]
pub async fn begin_folder_save(
    app: tauri::AppHandle,
    tree_uri: String,
    file_name: String,
    mime_type: Option<String>,
    overwrite: bool,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let state = app
            .try_state::<platform::android_saf_folder::KozouSafFolder>()
            .ok_or("SafFolderPlugin is not registered")?;

        let uri = if overwrite {
            state
                .find_file(&tree_uri, &file_name)?
                .ok_or_else(|| format!("上書き対象のファイルが見つかりません: {file_name}"))?
        } else {
            state
                .create_file(&tree_uri, &file_name, mime_type.as_deref())?
                .uri
        };

        let dest = url::Url::parse(&uri)
            .map(tauri_plugin_fs::FilePath::Url)
            .map_err(|e| format!("保存先URIの解析に失敗しました: {e}"))?;

        // file_name をそのまま一時ファイル名に使うと、同名ファイルを別々の
        // フォルダへ同時に保存するケース(バッチ保存など)で一時パスが衝突し、
        // PendingSaves のエントリや書き込み中の実体を取り違えてしまう恐れが
        // あるため、UUIDで一意化する(拡張子・ベース名は識別しやすさのため
        // prefixとして残す)。
        let stem = std::path::Path::new(&file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("saf_save");
        let ext = std::path::Path::new(&file_name)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("bin");
        let temp_path = crate::tempdir::kozou_temp_unique_path(stem, ext);
        if let Some(pending) = app.try_state::<platform::PendingSaves>() {
            pending
                .0
                .lock()
                .unwrap()
                .insert(temp_path.display().to_string(), dest);
        }
        Ok(temp_path.display().to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &tree_uri, &file_name, &mime_type, overwrite);
        Err("begin_folder_save is only available on Android".to_string())
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
///
/// フロントエンド (TypeScript) はキーをキャメルケースで期待するため、
/// `#[serde(rename_all = "camelCase")]` が必須(付け忘れると
/// `displayName`/`relativePath`/`sourceRelative` が undefined になる)。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFileInfo {
    pub uri: String,
    pub display_name: String,
    pub relative_path: String,
    pub source_relative: String,
}

/// バッチ出力(複数ファイル書き出し)の後処理。
///
/// `file_paths` に列挙されたファイルだけを、Android では
/// `ダウンロード/{relative_dir}/` 配下へ実際にコピーする。
/// Android にはモバイル向けのフォルダ選択ピッカーが無いため、
/// `relative_dir` はフロントエンド側で決め打ち生成した名前
/// (`buildMobileOutputSubfolder`) を渡す想定。
///
/// ⚠ `temp_dir` (通常は `pick_output_dir` が返した一時ディレクトリ) は
/// アプリ起動中ずっと使い回される共有キャッシュフォルダであり、その回の
/// 処理専用の場所ではない。そのため `temp_dir` 以下を丸ごと列挙して
/// コピーするのではなく、必ず `file_paths` で対象を明示すること
/// (そうしないと、過去の別処理が残した無関係なファイルまで
/// 一緒に保存されてしまう)。`file_paths` の各要素は `temp_dir` 配下の
/// 絶対パスであること。
///
/// デスクトップおよび iOS (未対応) では何もせず空配列を返す
/// (デスクトップは `temp_dir` = 実際にユーザーが選んだ保存先そのもの
/// であり、追加の移動は不要)。
#[tauri::command]
pub async fn commit_saved_batch(
    app: tauri::AppHandle,
    temp_dir: String,
    relative_dir: String,
    file_paths: Vec<String>,
) -> Result<Vec<SavedFileInfo>, String> {
    #[cfg(target_os = "android")]
    {
        let results = platform::android_media_store::finalize_files_to_downloads(
            &app,
            std::path::Path::new(&temp_dir),
            &relative_dir,
            &file_paths,
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
        let _ = (&app, &temp_dir, &relative_dir, &file_paths);
        Ok(vec![])
    }
}

/// `commit_batch_to_folder` 1件分の書き込み指示。
///
/// `target_name`/`overwrite` はフロントエンド側で
/// (`list_folder_names` の結果を使った)事前の衝突解決が済んでいる前提
/// ―― つまり `overwrite == false` の場合、`target_name` は選択フォルダ内で
/// 一意であることをフロント側が保証していること。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFolderEntry {
    /// core が実際に書き出したローカルの一時ファイルパス
    pub source_path: String,
    /// 選択フォルダ内での最終的なファイル名(衝突解決済み)
    pub target_name: String,
    /// true: 同名の既存ファイルを上書き / false: 新規作成
    pub overwrite: bool,
    pub mime_type: Option<String>,
}

/// ユーザーが `pick_save_folder` で選んだフォルダへ、複数ファイルを
/// まとめて書き込む(画像ファイル出力・バッチ画像PDF出力向け)。
///
/// 単一ファイル保存の `begin_folder_save` と同じ技法
/// (`find_file`/`create_file` で `content://` URI を取得し、
/// `tauri_plugin_fs` 経由で直接書き込む)をループで適用するだけで、
/// Kotlin側の追加実装は不要。`PendingSaves` には登録しない
/// (バッチ出力の個々のファイルは、単一ファイル保存のようにその場で
/// メタデータ編集→再コミットする対象ではないため)。
#[tauri::command]
pub async fn commit_batch_to_folder(
    app: tauri::AppHandle,
    tree_uri: String,
    entries: Vec<BatchFolderEntry>,
) -> Result<Vec<SavedFileInfo>, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        use tauri_plugin_fs::{FsExt, OpenOptions};

        let state = app
            .try_state::<platform::android_saf_folder::KozouSafFolder>()
            .ok_or("SafFolderPlugin is not registered")?;

        let mut results = Vec::with_capacity(entries.len());
        for entry in entries {
            let uri = if entry.overwrite {
                state
                    .find_file(&tree_uri, &entry.target_name)?
                    .ok_or_else(|| {
                        format!(
                            "上書き対象のファイルが見つかりません: {}",
                            entry.target_name
                        )
                    })?
            } else {
                state
                    .create_file(&tree_uri, &entry.target_name, entry.mime_type.as_deref())?
                    .uri
            };

            let dest = url::Url::parse(&uri)
                .map(tauri_plugin_fs::FilePath::Url)
                .map_err(|e| format!("保存先URIの解析に失敗しました: {e}"))?;

            let bytes = std::fs::read(&entry.source_path).map_err(|e| {
                format!(
                    "一時ファイルの読み込みに失敗しました ({}): {e}",
                    entry.source_path
                )
            })?;

            let mut opts = OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            let mut file = app
                .fs()
                .open(dest, opts)
                .map_err(|e| format!("保存先への書き込みに失敗しました: {e}"))?;
            use std::io::Write;
            file.write_all(&bytes)
                .map_err(|e| format!("保存先への書き込みに失敗しました: {e}"))?;

            results.push(SavedFileInfo {
                uri,
                display_name: entry.target_name.clone(),
                relative_path: String::new(),
                source_relative: entry.source_path.clone(),
            });
        }
        Ok(results)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &tree_uri, &entries);
        Ok(vec![])
    }
}
