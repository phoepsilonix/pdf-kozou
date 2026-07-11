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
//     返す場所) にバッチ出力を書き込む。ただしこの一時ディレクトリは
//     アプリ起動中ずっと使い回される共有キャッシュであり、その回の
//     処理専用ではないため、本モジュールはディレクトリを丸ごと
//     列挙するのではなく、呼び出し側が指定した特定のファイルだけを
//     MediaStore.Downloads へコピーする「仕上げ」の役割を持つ。

use serde::{Deserialize, Serialize};
use tauri::{
    Manager,
    plugin::{Builder, PluginHandle, TauriPlugin},
};

// ⚠ 重要: Kotlin 側 (@InvokeArg / invoke.resolve の JSObject) は
// キーをキャメルケース (sourcePath, displayName 等) で送受信するのに対し、
// Rust の serde はデフォルトで構造体のフィールド名をそのまま
// (スネークケース) JSON キーとして扱う。#[serde(rename_all = "camelCase")]
// を付け忘れると、Kotlin 側が引数を正しく受け取れず(またはレスポンスの
// 対応するキーが見つからず)実行時に静かに失敗し、実際には
// 1件もファイルが保存されないまま「保存に失敗しました」というエラーだけ
// 返ってくる、という分かりにくい不具合になる。
// (tauri-plugin-fs 本体の models.rs でも同じ理由でこの属性が使われている)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveFileArgs<'a> {
    source_path: &'a str,
    file_name: &'a str,
    relative_dir: &'a str,
    mime_type: Option<&'a str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
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
            let handle =
                api.register_android_plugin("phoepsilonix.pdfkozou", "MediaStorePlugin")?;
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

/// `file_paths` に列挙された各ファイルだけを MediaStore.Downloads へ
/// コピーする。
///
/// ⚠ `temp_dir` (= `pick_output_dir` が返す一時ディレクトリ) はアプリ
/// 起動中ずっと使い回される共有のキャッシュフォルダであり、その回の
/// 処理専用の場所ではない。そのため、以前の実装のように `temp_dir` 以下を
/// 再帰的に列挙して「見つかったものを全部コピーする」方式だと、過去に
/// 別の機能(分割・画像変換など)が書き出して残っていたファイルまで
/// 一緒に保存されてしまい、使うたびに保存先に無関係なファイルが
/// 増え続けるという不具合になっていた。
///
/// 呼び出し側 (フロントエンド) は、その回の処理で実際に書き出した
/// ファイルの絶対パスを既に把握しているため、その一覧をそのまま
/// `file_paths` として渡してもらい、それだけをコピー対象にする。
///
/// 各ファイルの `temp_dir` からの相対パス(サブディレクトリ構造)は
/// `relative_dir` の下にそのまま保持する。例えば
/// `temp_dir/請求書/page01.png` (file_paths に含まれるファイル) は
/// `Download/{relative_dir}/請求書/page01.png` として保存される。
pub async fn finalize_files_to_downloads(
    app: &tauri::AppHandle,
    temp_dir: &std::path::Path,
    relative_dir: &str,
    file_paths: &[String],
) -> Result<Vec<SavedFileInfo>, String> {
    let state = app
        .try_state::<KozouMediaStore>()
        .ok_or_else(|| "MediaStore plugin is not registered".to_string())?;

    let mut results = Vec::new();
    for source_path in file_paths {
        let abs = std::path::Path::new(source_path);
        let rel = abs.strip_prefix(temp_dir).map_err(|_| {
            format!("{source_path} is not located under the expected temp directory")
        })?;
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

        let saved = state.save_file(source_path, &file_name, &target_relative_dir, mime)?;
        results.push(SavedFileInfo {
            uri: saved.uri,
            display_name: saved.display_name,
            relative_path: saved.relative_path,
            source_relative: rel.display().to_string().replace('\\', "/"),
        });
    }

    Ok(results)
}
