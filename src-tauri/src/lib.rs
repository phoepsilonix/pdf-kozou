// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/lib.rs
mod commands;
mod error;
// Ghostscript 検出・実行は「システムにインストール済みの外部バイナリを探して
// spawn する」機能のため、Android/iOS には存在しない（そもそも spawn 自体が
// 許可されない）。デスクトップ限定でコンパイルする。
#[cfg(desktop)]
mod gs;
#[cfg(desktop)]
mod gs_detector;
mod platform;
pub mod tempdir;

use commands::{core, platform as platform_cmd};
use tauri::Emitter;

#[cfg(mobile)]
use tauri::Manager;

#[cfg(target_os = "linux")]
use crate::platform::linux::log_display_environment;
#[cfg(target_os = "linux")]
use crate::platform::linux::setup_webkit_env;

#[cfg(target_os = "windows")]
use crate::platform::log_display_environment;
#[cfg(target_os = "windows")]
use crate::platform::setup_webkit_env;

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub fn setup_platform() {
    setup_webkit_env();
    log_display_environment();
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
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

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            core::get_pdf_info,
            core::render_page,
            core::get_tmp_path,
            core::get_file_stat,
            core::get_default_save_dir,
            core::trim_pdf,
            core::compress_pdf,
            core::split_pdf,
            core::merge_pdf,
            core::rotate_pdf,
            core::export_images,
            core::export_image_pdf,
            core::get_temp_path,
            core::move_file,
            core::copy_file,
            core::remove_file,
            core::sanitize_hidden_text,
            core::sanitize_type3_text,
            core::save_base64_image,
            core::render_imposition,
            core::rasterize_imposition,
            core::split_imposition_pdf,
            core::compose_imposition_pdf,
            core::split_cell_render,
            core::detect_control_chars,
            core::detect_buried_text,
            core::detect_tiny_text,
            core::detect_low_contrast_text,
            core::detect_transparent_text,
            core::get_page_text,
            core::search_page,
            core::get_page_links,
            core::convert_to_pdf,
            core::set_pdf_metadata,
            core::get_image_metadata,
            core::set_image_metadata,
            core::is_mupdf_supported,
            core::is_pdf_file,
            core::check_path_conflict,
            platform_cmd::get_screen_info,
            platform_cmd::pick_open_file,
            platform_cmd::pick_open_files,
            platform_cmd::pick_save_file,
            platform_cmd::pick_save_file_in,
            platform_cmd::pick_output_dir,
            #[cfg(desktop)]
            gs_detector::check_ghostscript_installed,
            #[cfg(desktop)]
            gs_detector::find_gs_executable,
            #[cfg(desktop)]
            gs_detector::verify_gs_path,
            #[cfg(desktop)]
            gs_detector::pick_gs_executable,
            #[cfg(desktop)]
            gs_detector::find_gs_in_dir,
            #[cfg(desktop)]
            gs_detector::suggest_gs_candidates,
            #[cfg(desktop)]
            gs::run_gs_optimize,
        ])
        .setup(|app| {
            // Android/iOS: 書き込み可能なアプリ専用キャッシュディレクトリを解決し、
            // tempdir モジュールから使えるよう保存しておく
            // (std::env::temp_dir() は Android では書き込み不可のため)。
            #[cfg(mobile)]
            {
                if let Ok(cache_dir) = app.path().app_cache_dir() {
                    let _ = crate::tempdir::MOBILE_CACHE_DIR.set(cache_dir);
                }
            }

            // ── メインウィンドウを生成(入口 index.html だけ Cache-Control: no-store)──
            // 目的: MSIX 更新後に WebView が旧フロントをキャッシュから読み続け、
            //   ショートカット等が更新されない問題を防ぐ。入口 HTML だけ no-store に
            //   すれば、ハッシュ化された JS/CSS は従来どおりキャッシュされ起動性能を
            //   維持しつつ、更新は確実に反映される(localStorage には無影響)。
            //   tauri.conf.json 側は create:false で自動生成を止め、ここで同じ設定
            //   (from_config) ＋ ヘッダ注入で生成する。
            if let Some(win_cfg) = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
            {
                tauri::WebviewWindowBuilder::from_config(app.handle(), &win_cfg)?
                    .on_web_resource_request(|request, response| {
                        let uri = request.uri();
                        // アプリ自身の配信元のみ
                        //   Linux/macOS: tauri://localhost、Windows: http://tauri.localhost
                        let is_app = uri.scheme_str() == Some("tauri")
                            || uri.host() == Some("tauri.localhost");
                        // 入口 HTML（"/" もしくは *.html）だけ no-store。ハッシュ済み資産は据え置き。
                        let path = uri.path();
                        let is_entry =
                            path == "/" || path == "/index.html" || path.ends_with(".html");
                        if is_app && is_entry {
                            response.headers_mut().insert(
                                tauri::http::header::CACHE_CONTROL,
                                tauri::http::HeaderValue::from_static("no-store"),
                            );
                        }
                    })
                    .build()?;
            }

            // ── 起動時引数からPDFファイルパスを取得してフロントに渡す ──────────
            let pdf_paths: Vec<String> = std::env::args()
                .skip(1)
                .filter(|a| {
                    let p = std::path::Path::new(a);
                    p.exists()
                        && p.extension()
                            .map(|e| {
                                let ext = e.to_string_lossy().to_lowercase();
                                matches!(
                                    ext.as_str(),
                                    "pdf"
                                        | "epub"
                                        | "docx"
                                        | "xlsx"
                                        | "pptx"
                                        | "xps"
                                        | "oxps"
                                        | "cbz"
                                        | "cbr"
                                        | "html"
                                        | "htm"
                                        | "xhtml"
                                        | "svg"
                                        | "jpg"
                                        | "jpeg"
                                        | "png"
                                        | "bmp"
                                        | "gif"
                                        | "tiff"
                                        | "tif"
                                        | "webp"
                                )
                            })
                            .unwrap_or(false)
                })
                .collect();

            if !pdf_paths.is_empty() {
                let handle = app.handle().clone();
                let paths = pdf_paths.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    let _ = handle.emit("open-pdf-files", paths);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building PDF小僧");

    // ── アプリのイベントループ実行（終了時クリーンアップ付き） ────────────
    // Tauri v2: Builder::run() の代わりに build() + App::run() を使うことで
    // RunEvent::Exit を捕捉し、pdf-kozou 一時フォルダを削除できる。
    app.run(|app_handle, event| match event {
        tauri::RunEvent::Exit => {
            crate::tempdir::cleanup_kozou_temp();
        }
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } => {
            app_handle.exit(0);
        }
        _ => {}
    });
}
