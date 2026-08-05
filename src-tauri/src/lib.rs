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
use tauri::{Emitter, Manager};

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

/// 引数(コマンドライン引数、または `tauri-plugin-single-instance` が
/// 2回目以降の起動から転送してきた argv)のうち、実在しMuPDF対応拡張子を
/// 持つものだけを抜き出す。デスクトップの「PDFファイルを引数に渡されて
/// 起動/2重起動」の両方の入口から使う共通ロジック。
#[cfg(any(desktop, target_os = "ios"))]
fn extract_supported_paths<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
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
        .collect()
}

/// `open-pdf-files` イベントを送る。起動直後はフロントエンドの
/// `listen()` 登録がまだ間に合っていない可能性があるため、少し待ってから
/// emit する(既存の起動時引数処理から使っていたのと同じタイミング)。
fn emit_pdf_paths_delayed(handle: tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = handle.emit("open-pdf-files", paths);
    });
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

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // デスクトップの2重起動対策 + 「起動中に別のPDFファイルを開く/渡される」
    // 対応: すでにPDF小僧が起動している状態でファイル関連付け経由などから
    // 新しいプロセスが起動しようとした場合、その2回目のプロセスはすぐに
    // 終了し、渡された引数(argv)がこのコールバック経由で既存のインスタンス
    // へ転送される。ここで PDF ファイルの引数だけ抜き出し、新しいウィンドウ
    // を作らず既存のウィンドウのファイル一覧へ追加する(+ ウィンドウを前面へ)。
    // ドキュメントに従い、他のプラグインより先に登録する必要がある。
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths = extract_supported_paths(argv.into_iter().skip(1));
            if !paths.is_empty() {
                let _ = app.emit("open-pdf-files", paths);
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }));
    }

    builder = builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init());

    // Android: content:// URI から元のファイル名 (Unicode/日本語含む) を
    // ContentResolver 経由で取得するためのネイティブブリッジを登録する。
    // (詳細は src/platform/android_fs_info.rs を参照)
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(crate::platform::android_fs_info::kozou_fs_info_plugin());
        builder = builder.plugin(crate::platform::android_media_store::kozou_media_store_plugin());
        builder = builder.plugin(crate::platform::android_saf_folder::kozou_saf_folder_plugin());
        // Android: 共有(Share)/「アプリで開く(Open with)」で渡された
        // ファイルの URI を受け取るキュー。(詳細は
        // src/platform/android_pending_files.rs を参照)
        builder =
            builder.plugin(crate::platform::android_pending_files::kozou_pending_files_plugin());
    }

    let app = builder
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
            core::get_unique_temp_path,
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
            platform_cmd::is_mobile,
            platform_cmd::is_android,
            platform_cmd::pick_open_file,
            platform_cmd::pick_open_files,
            platform_cmd::pick_save_file,
            platform_cmd::pick_save_file_in,
            platform_cmd::commit_saved_file,
            platform_cmd::discard_pending_save,
            platform_cmd::pick_save_folder,
            platform_cmd::check_save_name_exists,
            platform_cmd::begin_folder_save,
            platform_cmd::pick_output_dir,
            platform_cmd::commit_saved_batch,
            platform_cmd::list_folder_names,
            platform_cmd::get_or_create_subfolder,
            platform_cmd::commit_batch_to_folder,
            platform_cmd::get_pending_open_files,
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
                app.manage(crate::platform::PendingSaves::default());
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
            #[cfg(desktop)]
            let pdf_paths: Vec<String> = extract_supported_paths(std::env::args().skip(1));
            #[cfg(not(desktop))]
            let pdf_paths: Vec<String> = Vec::new();

            emit_pdf_paths_delayed(app.handle().clone(), pdf_paths);

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
        // macOS/iOS: Finder の「このアプリケーションから開く」、Dock への
        // ドラッグ&ドロップ、iOSの「他のAppで開く」等は argv ではなく
        // AppKit/UIKit の openURLs 経由で通知され、Tauri はこれを
        // `RunEvent::Opened` として渡す(Windows/Linux の起動時引数とは
        // 別経路であり、アプリ起動中でも発火する)。file:// URL のみ
        // ローカルパスへ変換し、対応拡張子のものだけファイル一覧へ追加する。
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        tauri::RunEvent::Opened { urls } => {
            let paths: Vec<String> = urls
                .into_iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.display().to_string())
                .collect();
            let paths = extract_supported_paths(paths);
            emit_pdf_paths_delayed(app_handle.clone(), paths);
            if let Some(win) = app_handle.get_webview_window("main") {
                let _ = win.set_focus();
            }
        }
        _ => {}
    });
}
