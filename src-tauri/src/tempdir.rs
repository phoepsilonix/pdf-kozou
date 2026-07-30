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

#[cfg(mobile)]
use std::sync::OnceLock;

/// モバイル(Android/iOS)でのみ使用する、アプリ専用の書き込み可能ディレクトリ。
/// `std::env::temp_dir()` は Android では `/data/local/tmp` を返すことが多く、
/// 通常のアプリからは書き込み権限が無いため使えない。
/// アプリ起動時 (lib.rs の setup 内) に `app.path().app_cache_dir()` を
/// 解決してここへ格納しておく。
#[cfg(mobile)]
pub static MOBILE_CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// PDF小僧専用の一時ディレクトリパスを返す。
/// ディレクトリが存在しなければ作成する。
/// 失敗した場合はシステムの temp dir 直下を返す (fallback)。
pub fn kozou_temp_dir() -> PathBuf {
    #[cfg(mobile)]
    let base = MOBILE_CACHE_DIR
        .get()
        .cloned()
        .unwrap_or_else(std::env::temp_dir)
        .join("pdf-kozou");
    #[cfg(not(mobile))]
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

/// UUID (v4) を付与し、ファイル名衝突を避けた一時ファイルパスを返す。
/// 生成されるファイル名は `{prefix}_{uuid}.{ext}` の形式。
///
/// 同名の固定ファイル名で一時ファイルを作ると、複数ウィンドウ/複数プロセス
/// を同時に開いている場合や、バッチ処理中に前回分の後始末が終わる前に次の
/// 処理が走った場合などに、書き込み中のファイルを別の処理が上書き/読み込み
/// してしまう衝突が起こり得る。新規に一時ファイルを作る箇所では、（同一
/// セッション内で意図的に使い回す作業用スロットのような場合を除き）基本的
/// にこちらを使う。
pub fn kozou_temp_unique_path(prefix: &str, ext: &str) -> PathBuf {
    kozou_temp_path(&format!("{prefix}_{}.{ext}", uuid::Uuid::new_v4()))
}

/// アプリ終了時クリーンアップ: pdf-kozou フォルダをまるごと削除。
/// エラーは無視 (best-effort)。
pub fn cleanup_kozou_temp() {
    #[cfg(mobile)]
    let dir = MOBILE_CACHE_DIR
        .get()
        .cloned()
        .unwrap_or_else(std::env::temp_dir)
        .join("pdf-kozou");
    #[cfg(not(mobile))]
    let dir = std::env::temp_dir().join("pdf-kozou");

    if dir.exists() {
        let _ = std::fs::remove_dir_all(&dir);
    }
}
