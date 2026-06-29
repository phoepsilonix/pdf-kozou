// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/lib.rs
mod commands;
mod error;
mod gs;
mod gs_detector;
mod platform;
pub mod tempdir;

use commands::{core, platform as platform_cmd};
use tauri::Emitter;

use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::Manager;

// パスを保持する静的な入れ物
static CORE_BIN_PATH: OnceLock<PathBuf> = OnceLock::new();

#[cfg(target_os = "linux")]
use crate::platform::linux::log_display_environment;
#[cfg(target_os = "linux")]
use crate::platform::linux::setup_webkit_env;

#[cfg(not(target_os = "linux"))]
use crate::platform::log_display_environment;
#[cfg(not(target_os = "linux"))]
use crate::platform::setup_webkit_env;

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub fn setup_platform() {
    setup_webkit_env();
    log_display_environment();
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub fn setup_platform() {}

fn get_core_bin_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    // 1. 環境変数優先
    if let Ok(p) = std::env::var("PDF_KOZOU_CORE") {
        return p.into();
    }

    // 2. Tauri Resolver (Linux パッケージ(deb,rpm) / AppImage 展開後用)
    if let Ok(resource_dir) = app.path().resource_dir() {
        let core_name = if cfg!(target_os = "windows") {
            "pdf-kozou-core.exe"
        } else {
            "pdf-kozou-core"
        };
        let path = resource_dir.join(core_name);
        if path.exists() {
            return path;
        }
    }

    // 3. 実行ファイル横 (MSI や 開発時用)
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.parent().unwrap_or(std::path::Path::new(".")).join(
            if cfg!(target_os = "windows") {
                "pdf-kozou-core.exe"
            } else {
                "pdf-kozou-core"
            },
        );
        if sibling.exists() {
            return sibling;
        }
    }

    std::path::PathBuf::from("pdf-kozou-core")
}

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
            gs_detector::check_ghostscript_installed,
            gs_detector::find_gs_executable,
            gs_detector::verify_gs_path,
            gs_detector::pick_gs_executable,
            gs_detector::find_gs_in_dir,
            gs_detector::suggest_gs_candidates,
            gs::run_gs_optimize,
        ])
        .setup(|app| {
            // ── メインウィンドウを生成（入口 index.html だけ Cache-Control: no-store）──
            // 目的: MSIX 更新後に WebView が旧フロントをキャッシュから読み続け、
            //   ショートカット等が更新されない問題を防ぐ。入口 HTML だけ no-store に
            //   すれば、ハッシュ化された JS/CSS は従来どおりキャッシュされ起動性能を
            //   維持しつつ、更新は確実に反映される（localStorage には無影響）。
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

            // pdf-kozou-coreのパス取得＆保存
            let path = get_core_bin_path(app.handle());
            let _ = CORE_BIN_PATH.set(path);

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
            kill_orphan_core_processes();
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

/// 残存する pdf-kozou-core プロセスを終了させる
fn kill_orphan_core_processes() {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "pdf-kozou-core.exe"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("pkill")
            .args(["-f", "pdf-kozou-core"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}
