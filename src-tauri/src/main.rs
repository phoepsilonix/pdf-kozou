// src-tauri/src/main.rs
// ⚠️  環境変数のセットアップは tauri::Builder より前に必ず実行する

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Linux: X11/Wayland 環境変数を Tauri 初期化より前にセット
    // GTK_USE_PORTAL=0 等が有効になるのはプロセス起動直後のみ
    pdf_kozou_lib::setup_platform();
    pdf_kozou_lib::run();
}

#[tauri::command]
async fn run_gs_optimize(
    input: String,
    output: String,
    level_str: String,
) -> Result<String, String> {
    let gs_path = pdf_kozou_core::gs_detector::find_gs_executable()
        .ok_or("Ghostscriptが見つかりません。インストールしてください。")?;

    let level = match level_str.as_str() {
        "prepress" => GsCompressionLevel::Prepress,
        "printer" => GsCompressionLevel::Printer,
        _ => GsCompressionLevel::Ebook,
    };

    pdf_kozou_core::gs::optimize_with_gs(&gs_path, &input, &output, level)
        .map_err(|e| e.to_string())?;

    Ok("圧縮が完了しました".into())
}
