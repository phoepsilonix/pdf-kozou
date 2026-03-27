// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/main.rs
// ⚠️  環境変数のセットアップは tauri::Builder より前に必ず実行する

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Linux: X11/Wayland 環境変数を Tauri 初期化より前にセット
    // GTK_USE_PORTAL=0 等が有効になるのはプロセス起動直後のみ
    #[cfg(target_os = "linux")]
    {
        // プロセス全体で WebKit のコンポジットモードを調整（真っ黒画面対策）
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }

    pdf_kozou_lib::setup_platform();
    pdf_kozou_lib::run();
}
