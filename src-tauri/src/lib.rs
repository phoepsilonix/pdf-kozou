// src-tauri/src/lib.rs
mod commands;
mod error;
mod platform;

use commands::{core, platform as platform_cmd};

#[cfg(desktop)]
pub fn setup_platform() {
    platform::setup_webkit_env();
    platform::log_display_environment();
}

#[cfg(mobile)]
pub fn setup_platform() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(mobile))]
    {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::from_default_env()
                    .add_directive("pdf_kozou=debug".parse().unwrap()),
            )
            .try_init();
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            core::get_pdf_info,
            core::render_page,
            core::trim_pdf,
            core::compress_pdf,
            core::split_pdf,
            core::merge_pdf,
            core::rotate_pdf,
            platform_cmd::get_screen_info,
            platform_cmd::pick_open_file,
            platform_cmd::pick_open_files,
            platform_cmd::pick_save_file,
            platform_cmd::pick_output_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PDF小僧");
}
