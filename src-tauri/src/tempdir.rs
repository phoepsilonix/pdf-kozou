// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/tempdir.rs
//
// PDF小僧専用の一時ディレクトリ管理
//
// システムの Temp フォルダ配下に "pdf-kozou" サブフォルダを作成し、
// アプリ終了時にフォルダごと削除する。
//
// ディレクトリ構造:
//   <system_temp>/pdf-kozou/<filename>
//
// Windows: %TEMP%\pdf-kozou\
// Linux:   /tmp/pdf-kozou/  or  $TMPDIR/pdf-kozou/
// macOS:   $TMPDIR/pdf-kozou/

use std::path::PathBuf;

/// PDF小僧専用の一時ディレクトリパスを返す。
/// ディレクトリが存在しなければ作成する。
/// 失敗した場合はシステムの temp dir 直下を返す (fallback)。
pub fn kozou_temp_dir() -> PathBuf {
    let base = std::env::temp_dir().join("pdf-kozou");
    if !base.exists() {
        let _ = std::fs::create_dir_all(&base);
    }
    base
}

/// PDF小僧専用 temp ディレクトリ内のファイルパスを返す。
/// `name` はファイル名 (パス区切りなし)。
pub fn kozou_temp_path(name: &str) -> PathBuf {
    kozou_temp_dir().join(name)
}

/// アプリ終了時クリーンアップ: pdf-kozou フォルダをまるごと削除。
/// エラーは無視 (best-effort)。
pub fn cleanup_kozou_temp() {
    let dir = std::env::temp_dir().join("pdf-kozou");
    if dir.exists() {
        let _ = std::fs::remove_dir_all(&dir);
    }
}
