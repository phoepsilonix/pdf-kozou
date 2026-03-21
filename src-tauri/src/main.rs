// src-tauri/src/main.rs
// ⚠️  環境変数のセットアップは tauri::Builder より前に必ず実行する

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Linux: X11/Wayland 環境変数を Tauri 初期化より前にセット
    // GTK_USE_PORTAL=0 等が有効になるのはプロセス起動直後のみ
    pdf_kozou_lib::setup_platform();
    pdf_kozou_lib::run();
}
