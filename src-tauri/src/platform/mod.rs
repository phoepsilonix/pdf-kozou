// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/platform/mod.rs

pub mod screen_info;
pub use screen_info::{DisplayServer, ScreenInfo};

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "linux")]
pub use linux::{
    open_pdf_dialog, open_pdfs_dialog, pick_output_dir, save_pdf_dialog, save_pdf_dialog_in,
};

#[cfg(all(desktop, not(target_os = "linux")))]
pub async fn open_pdf_dialog() -> Option<std::path::PathBuf> {
    use rfd::AsyncFileDialog;
    AsyncFileDialog::new()
        .add_filter(
            "PDF・対応ファイル",
            &[
                "pdf", "epub", "docx", "xlsx", "pptx", "xps", "oxps", "cbz", "cbr", "html", "htm",
                "xhtml", "svg", "jpg", "jpeg", "png", "bmp", "gif", "tiff", "tif", "webp",
            ],
        )
        .add_filter("PDF", &["pdf"])
        .add_filter("EPUB", &["epub"])
        .add_filter("Office文書", &["docx", "xlsx", "pptx"])
        .add_filter("XPS", &["xps", "oxps"])
        .add_filter("コミック", &["cbz", "cbr"])
        .add_filter("HTML", &["html", "htm", "xhtml"])
        .add_filter(
            "画像",
            &["jpg", "jpeg", "png", "bmp", "gif", "tiff", "tif", "webp"],
        )
        .pick_file()
        .await
        .map(|f| f.path().to_path_buf())
}
#[cfg(all(desktop, not(target_os = "linux")))]
pub async fn open_pdfs_dialog() -> Vec<std::path::PathBuf> {
    use rfd::AsyncFileDialog;
    AsyncFileDialog::new()
        .add_filter(
            "PDF・対応ファイル",
            &[
                "pdf", "epub", "docx", "xlsx", "pptx", "xps", "oxps", "cbz", "cbr", "html", "htm",
                "xhtml", "svg", "jpg", "jpeg", "png", "bmp", "gif", "tiff", "tif", "webp",
            ],
        )
        .add_filter("PDF", &["pdf"])
        .add_filter("EPUB", &["epub"])
        .add_filter("Office文書", &["docx", "xlsx", "pptx"])
        .add_filter("XPS", &["xps", "oxps"])
        .add_filter("コミック", &["cbz", "cbr"])
        .add_filter("HTML", &["html", "htm", "xhtml"])
        .add_filter(
            "画像",
            &["jpg", "jpeg", "png", "bmp", "gif", "tiff", "tif", "webp"],
        )
        .pick_files()
        .await
        .map(|v| v.into_iter().map(|f| f.path().to_path_buf()).collect())
        .unwrap_or_default()
}
#[cfg(all(desktop, not(target_os = "linux")))]
pub async fn save_pdf_dialog(default_name: &str) -> Option<std::path::PathBuf> {
    use rfd::AsyncFileDialog;
    AsyncFileDialog::new()
        .set_file_name(default_name)
        .add_filter("PDF", &["pdf"])
        .save_file()
        .await
        .map(|f| f.path().to_path_buf())
}
#[cfg(all(desktop, not(target_os = "linux")))]
pub async fn save_pdf_dialog_in(
    default_name: &str,
    initial_dir: Option<&str>,
) -> Option<std::path::PathBuf> {
    use rfd::AsyncFileDialog;
    let mut dlg = AsyncFileDialog::new()
        .set_file_name(default_name)
        .add_filter("PDF", &["pdf"]);
    if let Some(d) = initial_dir {
        dlg = dlg.set_directory(d);
    }
    dlg.save_file().await.map(|f| f.path().to_path_buf())
}
#[cfg(all(desktop, not(target_os = "linux")))]
pub async fn pick_output_dir() -> Option<std::path::PathBuf> {
    use rfd::AsyncFileDialog;
    AsyncFileDialog::new()
        .pick_folder()
        .await
        .map(|f| f.path().to_path_buf())
}
#[cfg(all(desktop, (target_os = "windows")))]
pub fn setup_webkit_env() {}
#[cfg(all(desktop, (target_os = "windows")))]
pub fn log_display_environment() {}

#[cfg(mobile)]
pub async fn open_pdf_dialog() -> Option<std::path::PathBuf> {
    None
}
#[cfg(mobile)]
pub async fn open_pdfs_dialog() -> Vec<std::path::PathBuf> {
    vec![]
}
#[cfg(mobile)]
pub async fn save_pdf_dialog(_: &str) -> Option<std::path::PathBuf> {
    None
}
#[cfg(mobile)]
pub async fn save_pdf_dialog_in(_: &str, _: Option<&str>) -> Option<std::path::PathBuf> {
    None
}
#[cfg(mobile)]
pub async fn pick_output_dir() -> Option<std::path::PathBuf> {
    None
}
#[cfg(mobile)]
pub fn setup_webkit_env() {}
#[cfg(mobile)]
pub fn log_display_environment() {}
