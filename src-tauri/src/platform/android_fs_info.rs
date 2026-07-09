// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/platform/android_fs_info.rs
//
// Android の SAF (content://) URI から、ContentResolver 経由で元の
// ファイル名 (OpenableColumns.DISPLAY_NAME) を取得するための最小限の
// ネイティブブリッジ。
//
// なぜ必要か:
//   content:// URI の末尾セグメント(ドキュメントID)は、プロバイダに
//   よっては元のファイル名を含まない不透明な ID になる
//   (例: MediaStore 由来のドキュメントプロバイダが返す
//   "msf:1000000123" のような ID)。この場合、URI をいくら
//   percent-decode してもファイル名は復元できず、ID の数字部分が
//   そのままファイル名として使われてしまう。
//   正しいファイル名は Android の ContentResolver.query() で
//   OpenableColumns.DISPLAY_NAME を問い合わせないと取得できない
//   (これは日本語を含む任意の Unicode ファイル名にも対応する)。
//
// Kotlin 側の実装は
//   gen/android/app/src/main/java/phoepsilonix/pdfkozou/FsInfoPlugin.kt
// にある。別クレート・別 Gradle モジュールに切り出さず、アプリ自身の
// パッケージに直接置いている。`register_android_plugin` はクラスを
// JNI 越しに直接ロードするだけなので、独立したプラグインクレートで
// ある必要はない。

use serde::{Deserialize, Serialize};
use tauri::{
    Manager,
    plugin::{Builder, PluginHandle, TauriPlugin},
};

#[derive(Serialize)]
struct GetDisplayNameArgs<'a> {
    uri: &'a str,
}

#[derive(Deserialize)]
struct GetDisplayNameResponse {
    name: Option<String>,
}

/// Kotlin 側の `FsInfoPlugin` へのハンドル。`tauri::AppHandle` の state
/// として管理する (`run()` の `.plugin(kozou_fs_info_plugin())` で登録)。
pub struct KozouFsInfo(PluginHandle<tauri::Wry>);

impl KozouFsInfo {
    /// content:// URI から ContentResolver.DISPLAY_NAME を取得する。
    /// 取得できない場合 (プロバイダ非対応・クエリ失敗・空文字列等) は None。
    /// この場合、呼び出し元は従来の URI ベースの推測にフォールバックする。
    pub fn get_display_name(&self, uri: &str) -> Option<String> {
        match self.0.run_mobile_plugin::<GetDisplayNameResponse>(
            "getDisplayName",
            GetDisplayNameArgs { uri },
        ) {
            Ok(resp) => resp.name.filter(|s| !s.trim().is_empty()),
            Err(_e) => {
                // プロバイダによっては DISPLAY_NAME を提供しない場合もある。
                // これはエラーではなく、フォールバックへの合図として扱う。
                None
            }
        }
    }
}

/// アプリのパッケージ (`gen/android/app/.../FsInfoPlugin.kt`) に置いた
/// `FsInfoPlugin` クラスをネイティブプラグインとして登録する。
pub fn kozou_fs_info_plugin() -> TauriPlugin<tauri::Wry> {
    Builder::new("kozou-fs-info")
        .setup(|app, api| {
            let handle = api.register_android_plugin("phoepsilonix.pdfkozou", "FsInfoPlugin")?;
            app.manage(KozouFsInfo(handle));
            Ok(())
        })
        .build()
}
