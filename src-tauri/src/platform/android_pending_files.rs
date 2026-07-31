// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/platform/android_pending_files.rs
//
// Android で「共有(Share)」または「アプリで開く(Open with)」経由で
// PDF小僧に渡されたファイルの URI (content:// / file://) を受け取るための
// ネイティブブリッジ。
//
// なぜ必要か:
//   Android の Intent (ACTION_VIEW / ACTION_SEND / ACTION_SEND_MULTIPLE) は
//   Kotlin (MainActivity) 側にしか届かない。フロントエンドの起動タイミング
//   (コールドスタートで JS がまだリスナー登録前) や、すでにアプリが起動中
//   ("singleTask" のため onNewIntent 経由で通知される場合) のどちらでも
//   取りこぼさないよう、Kotlin 側 (`PendingFilesPlugin.kt`) が URI を
//   静的キューに溜めておき、こちら側は `getPendingFiles` でそれを取り出す
//   だけのシンプルな設計にしている(プッシュ通知は行わない)。
//
//   フロントエンドは起動時、および (Android で共有→アプリへ復帰した際に
//   発生する) ウィンドウフォーカス時に `get_pending_open_files` コマンド
//   (commands/platform.rs) を呼び出してこのキューをドレインする。
//
// Kotlin 側の実装は
//   gen/android/app/src/main/java/phoepsilonix/pdfkozou/PendingFilesPlugin.kt
// にある。

use serde::Deserialize;
use tauri::{
    Manager,
    plugin::{Builder, PluginHandle, TauriPlugin},
};

#[derive(Deserialize)]
struct GetPendingFilesResponse {
    paths: Vec<String>,
}

/// Kotlin 側の `PendingFilesPlugin` へのハンドル。`tauri::AppHandle` の
/// state として管理する (`run()` の
/// `.plugin(kozou_pending_files_plugin())` で登録)。
pub struct KozouPendingFiles(PluginHandle<tauri::Wry>);

impl KozouPendingFiles {
    /// キューに溜まっている URI 文字列 (content:// / file://) を取り出す。
    /// 呼び出すたびにキューは空になる (同じファイルが二重に返ることはない)。
    /// 取得に失敗した場合 (プラグイン未登録・呼び出しエラー等) は空配列。
    pub fn get_pending_files(&self) -> Vec<String> {
        match self
            .0
            .run_mobile_plugin::<GetPendingFilesResponse>("getPendingFiles", ())
        {
            Ok(resp) => resp.paths,
            Err(_e) => Vec::new(),
        }
    }
}

/// アプリのパッケージ (`gen/android/app/.../PendingFilesPlugin.kt`) に置いた
/// `PendingFilesPlugin` クラスをネイティブプラグインとして登録する。
pub fn kozou_pending_files_plugin() -> TauriPlugin<tauri::Wry> {
    Builder::new("kozou-pending-files")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("phoepsilonix.pdfkozou", "PendingFilesPlugin")?;
            app.manage(KozouPendingFiles(handle));
            Ok(())
        })
        .build()
}
