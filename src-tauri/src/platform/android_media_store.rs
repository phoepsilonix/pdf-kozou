// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/platform/android_media_store.rs
//
// バッチ出力(複数ファイル書き出し)の結果を、ContentResolver 経由で
// MediaStore の Downloads コレクションへコピーするためのブリッジ。
//
// 背景・設計方針は
//   gen/android/app/src/main/java/phoepsilonix/pdfkozou/MediaStorePlugin.kt
// のコメントを参照。要点だけ書くと:
//   - Android にはモバイル向けの「フォルダ選択ダイアログ」が
//     (tauri-plugin-dialog 経由では)存在しないため、決め打ちの
//     サブフォルダ名を使い、ピッカー無しで「ダウンロード」フォルダ
//     配下へ直接保存する。
//   - core (Rust) は今まで通り一時ディレクトリ (`pick_output_dir` が
//     返す場所) にバッチ出力を書き込む。本モジュールは、その一時
//     ディレクトリの中身を後から MediaStore.Downloads へ移す
//     「仕上げ」の役割のみを持つ。

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager,
};

#[derive(Serialize)]
struct SaveFileArgs<'a> {
    source_path: &'a str,
    file_name: &'a str,
    relative_dir: &'a str,
    mime_type: Option<&'a str>,
}

#[derive(Deserialize)]
struct SaveFileResponse {
    uri: String,
    display_name: String,
    relative_path: String,
}

/// `finalize_batch_to_downloads` が返す、保存済み1ファイル分の情報。
/// (`commands/platform.rs` の `SavedFileInfo` へマップして
/// フロントエンドに返す)
#[derive(Clone)]
pub struct SavedFileInfo {
    pub uri: String,
    pub display_name: String,
    pub relative_path: String,
    /// 一時ディレクトリを起点とした相対パス (UI で「どのファイルの
    /// 結果か」を紐付けるために使う。例: "請求書/page01.png")
    pub source_relative: String,
}

/// Kotlin 側の `MediaStorePlugin` へのハンドル。
pub struct KozouMediaStore(PluginHandle<tauri::Wry>);

impl KozouMediaStore {
    fn save_file(
        &self,
        source_path: &str,
        file_name: &str,
        relative_dir: &str,
        mime_type: Option<&str>,
    ) -> Result<SaveFileResponse, String> {
        self.0
            .run_mobile_plugin::<SaveFileResponse>(
                "saveFile",
                SaveFileArgs {
                    source_path,
                    file_name,
                    relative_dir,
                    mime_type,
                },
            )
            .map_err(|e| e.to_string())
    }
}

/// アプリのパッケージに置いた `MediaStorePlugin` クラスをネイティブ
/// プラグインとして登録する。
pub fn kozou_media_store_plugin() -> TauriPlugin<tauri::Wry> {
    Builder::new("kozou-media-store")
        .setup(|app, api| {
            let handle = api.register_android_plugin("phoepsilonix.pdfkozou", "MediaStorePlugin")?;
            app.manage(KozouMediaStore(handle));
            Ok(())
        })
        .build()
}

/// 拡張子から MIME タイプを推測する。依存クレートを増やさないための
/// 簡易実装で、このアプリが実際に書き出す形式のみカバーする。
fn guess_mime(file_name: &str) -> Option<&'static str> {
    let ext = std::path::Path::new(file_name)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    Some(match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        _ => return None,
    })
}

/// `temp_dir` 以下のファイルを再帰的に列挙し、それぞれ
/// `relative_dir` (Download/ より下のパス) の同じサブディレクトリ構造の
/// 下へコピーする。
///
/// 例えば `temp_dir/請求書/page01.png` は
/// `Download/{relative_dir}/請求書/page01.png` として保存される。
pub async fn finalize_batch_to_downloads(
    app: &tauri::AppHandle,
    temp_dir: &std::path::Path,
    relative_dir: &str,
) -> Result<Vec<SavedFileInfo>, String> {
    let state = app
        .try_state::<KozouMediaStore>()
        .ok_or_else(|| "MediaStore plugin is not registered".to_string())?;

    let mut relatives = Vec::new();
    collect_files(temp_dir, temp_dir, &mut relatives)?;
    relatives.sort();

    let mut results = Vec::new();
    for rel in relatives {
        let abs = temp_dir.join(&rel);
        let source_path = abs.display().to_string();
        let file_name = rel
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        let sub_dir = rel
            .parent()
            .map(|p| p.display().to_string().replace('\\', "/"))
            .unwrap_or_default();
        let target_relative_dir = if sub_dir.is_empty() {
            relative_dir.to_string()
        } else {
            format!("{relative_dir}/{sub_dir}")
        };
        let mime = guess_mime(&file_name);

        let saved = state.save_file(&source_path, &file_name, &target_relative_dir, mime)?;
        results.push(SavedFileInfo {
            uri: saved.uri,
            display_name: saved.display_name,
            relative_path: saved.relative_path,
            source_relative: rel.display().to_string().replace('\\', "/"),
        });
    }

    Ok(results)
}

/// `dir` 以下のファイルを再帰的に集め、`root` からの相対パスを `out` に積む。
fn collect_files(
    root: &std::path::Path,
    dir: &std::path::Path,
    out: &mut Vec<std::path::PathBuf>,
) -> Result<(), String> {
    let read_dir = std::fs::read_dir(dir).map_err(|e| format!("read_dir error: {e}"))?;
    for entry in read_dir {
        let entry = entry.map_err(|e| format!("read_dir entry error: {e}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, out)?;
        } else if path.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_path_buf());
            }
        }
    }
    Ok(())
}
