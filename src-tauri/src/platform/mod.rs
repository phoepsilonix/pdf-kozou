// src-tauri/src/platform/mod.rs

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "linux")]
pub use linux::{
    log_display_environment,
    open_pdf_dialog, open_pdfs_dialog, save_pdf_dialog, save_pdf_dialog_in,
    pick_output_dir, setup_webkit_env, get_screen_info,
};

#[cfg(all(desktop, not(target_os = "linux")))]
pub async fn open_pdf_dialog() -> Option<std::path::PathBuf> {
    use rfd::AsyncFileDialog;
    AsyncFileDialog::new().add_filter("PDF", &["pdf"]).pick_file().await
        .map(|f| f.path().to_path_buf())
}
#[cfg(all(desktop, not(target_os = "linux")))]
pub async fn open_pdfs_dialog() -> Vec<std::path::PathBuf> {
    use rfd::AsyncFileDialog;
    AsyncFileDialog::new().add_filter("PDF", &["pdf"]).pick_files().await
        .map(|v| v.into_iter().map(|f| f.path().to_path_buf()).collect())
        .unwrap_or_default()
}
#[cfg(all(desktop, not(target_os = "linux")))]
pub async fn save_pdf_dialog(default_name: &str) -> Option<std::path::PathBuf> {
    use rfd::AsyncFileDialog;
    AsyncFileDialog::new().set_file_name(default_name).add_filter("PDF", &["pdf"])
        .save_file().await.map(|f| f.path().to_path_buf())
}
#[cfg(all(desktop, not(target_os = "linux")))]
pub async fn save_pdf_dialog_in(default_name: &str, initial_dir: Option<&str>) -> Option<std::path::PathBuf> {
    use rfd::AsyncFileDialog;
    let mut dlg = AsyncFileDialog::new().set_file_name(default_name).add_filter("PDF", &["pdf"]);
    if let Some(d) = initial_dir { dlg = dlg.set_directory(d); }
    dlg.save_file().await.map(|f| f.path().to_path_buf())
}
#[cfg(all(desktop, not(target_os = "linux")))]
pub async fn pick_output_dir() -> Option<std::path::PathBuf> {
    use rfd::AsyncFileDialog;
    AsyncFileDialog::new().pick_folder().await.map(|f| f.path().to_path_buf())
}
#[cfg(all(desktop, not(target_os = "linux")))]
pub fn setup_webkit_env() {}
#[cfg(all(desktop, not(target_os = "linux")))]
pub fn log_display_environment() {}

#[cfg(mobile)]
pub async fn open_pdf_dialog() -> Option<std::path::PathBuf> { None }
#[cfg(mobile)]
pub async fn open_pdfs_dialog() -> Vec<std::path::PathBuf> { vec![] }
#[cfg(mobile)]
pub async fn save_pdf_dialog(_: &str) -> Option<std::path::PathBuf> { None }
#[cfg(mobile)]
pub async fn save_pdf_dialog_in(_: &str, _: Option<&str>) -> Option<std::path::PathBuf> { None }
#[cfg(mobile)]
pub async fn pick_output_dir() -> Option<std::path::PathBuf> { None }
#[cfg(mobile)]
pub fn setup_webkit_env() {}
#[cfg(mobile)]
pub fn log_display_environment() {}

#[cfg(not(target_os = "linux"))]
pub fn get_screen_info() -> crate::commands::platform::ScreenInfo {
    crate::commands::platform::ScreenInfo {
        display_server: "native".to_string(),
        width:          1920,
        height:         1080,
        scale_factor:   1.0,
    }
}
