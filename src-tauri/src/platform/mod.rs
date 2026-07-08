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
#[cfg(all(desktop, target_os = "windows"))]
pub fn setup_webkit_env() {}
#[cfg(all(desktop, target_os = "windows"))]
pub fn log_display_environment() {}

// ── モバイル (Android/iOS) ────────────────────────────────────────────────
//
// rfd はデスクトップ専用のため使えない。tauri-plugin-dialog のネイティブ
// ピッカーを使う。ただしピッカーが返すのは `file://` パスとは限らず、
// Android では `content://` URI であることが多く、そのままでは
// std::fs / MuPDF から読めない。tauri-plugin-fs の Fs::read()
// (ContentResolver 経由で content:// も読める) でバイト列を取得し、
// アプリの一時ディレクトリにコピーしてから、そのローカルパスを返す。

/// content:// / file:// の URL 末尾セグメントから元のファイル名(拡張子込み)を
/// 復元する。
///
/// Android の SAF (Storage Access Framework) が返す content:// URI は
/// 末尾セグメントが percent-encode された「ドキュメントID」になっている。
/// 例: `content://.../document/primary%3ADownload%2Fscan.pdf`
///     → decode → `primary:Download/scan.pdf` → basename → `scan.pdf`
///
/// これを percent-decode せずに使うと、コピー先の一時ファイル名に
/// 拡張子が付かず (`%2F` や `%3A` を含んだ不正なファイル名になり)、
/// フロントエンドの拡張子判定 (`isMupdfExtension`) に弾かれて
/// 「ファイルを選んでも何も追加されない」という症状になる。
#[cfg(mobile)]
fn guess_file_name(file_path: &tauri_plugin_fs::FilePath) -> String {
    use percent_encoding::percent_decode_str;

    let raw_last_segment = match file_path {
        tauri_plugin_fs::FilePath::Url(url) => url
            .path_segments()
            .and_then(|mut s| s.next_back())
            .map(str::to_string),
        _ => None,
    };

    let Some(raw) = raw_last_segment else {
        return "picked_file".to_string();
    };

    // percent-decode してから、プロバイダ固有の区切り (`/`, `:`) の
    // 最後の要素だけを取り出す。
    let decoded = percent_decode_str(&raw).decode_utf8_lossy().into_owned();
    let base = decoded
        .rsplit(['/', ':'])
        .next()
        .unwrap_or(decoded.as_str())
        .trim();

    // ファイルシステムに書き込めない文字を除去しておく
    let sanitized: String = base
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '"' | '<' | '>' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();

    if sanitized.is_empty() {
        "picked_file".to_string()
    } else {
        sanitized
    }
}

#[cfg(mobile)]
async fn filepath_to_local(
    app: &tauri::AppHandle,
    file_path: tauri_plugin_fs::FilePath,
) -> Result<std::path::PathBuf, String> {
    use tauri_plugin_fs::FsExt;

    // すでに実ファイルパスならそのまま使う
    if let Some(p) = file_path.as_path() {
        return Ok(p.to_path_buf());
    }

    // 名前(拡張子込み)を復元しておく
    let name = guess_file_name(&file_path);

    let app_clone = app.clone();
    let fp = file_path.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || app_clone.fs().read(fp))
        .await
        .map_err(|e| format!("failed to join read task: {e}"))?
        .map_err(|e| format!("failed to read picked file ({file_path:?}): {e}"))?;

    let dest = crate::tempdir::kozou_temp_path(&format!(
        "{}_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        name
    ));
    std::fs::write(&dest, bytes)
        .map_err(|e| format!("failed to write temp file {}: {e}", dest.display()))?;
    Ok(dest)
}

#[cfg(mobile)]
const PDF_PICKER_EXTENSIONS: &[&str] = &[
    "pdf", "epub", "docx", "xlsx", "pptx", "xps", "oxps", "cbz", "cbr", "html", "htm", "xhtml",
    "svg", "jpg", "jpeg", "png", "bmp", "gif", "tiff", "tif", "webp",
];

#[cfg(mobile)]
pub async fn open_pdf_dialog(app: &tauri::AppHandle) -> Result<Option<std::path::PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("PDF・対応ファイル", PDF_PICKER_EXTENSIONS)
        .pick_file(move |result| {
            let _ = tx.send(result);
        });

    let Some(picked) = rx
        .await
        .map_err(|e| format!("picker channel closed: {e}"))?
        .into()
        .flatten()
    else {
        // ユーザーがキャンセルした場合。エラーではない。
        return Ok(None);
    };
    filepath_to_local(app, picked).await.map(Some)
}

#[cfg(mobile)]
pub async fn open_pdfs_dialog(app: &tauri::AppHandle) -> Result<Vec<std::path::PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("PDF・対応ファイル", PDF_PICKER_EXTENSIONS)
        .pick_files(move |result| {
            let _ = tx.send(result);
        });

    let Some(picked) = rx
        .await
        .map_err(|e| format!("picker channel closed: {e}"))?
        .into()
        .flatten()
    else {
        // ユーザーがキャンセルした場合。エラーではない。
        return Ok(vec![]);
    };

    let mut out = Vec::with_capacity(picked.len());
    // 1件でも読み込みに失敗したら、無視して黙って続けるのではなく
    // まとめてエラーを返す (原因がフロントエンドで見えるように)。
    for fp in picked {
        out.push(filepath_to_local(app, fp).await?);
    }
    Ok(out)
}

/// モバイルでは「保存先フォルダを自由に選ぶ」SAF書き込みには未対応。
/// アプリ専用の書き込み可能ディレクトリに自動的に保存する(暫定対応)。
/// 端末の他の場所へ持ち出す場合は、共有(share)機能を別途使う想定。
#[cfg(mobile)]
pub async fn save_pdf_dialog(
    _app: &tauri::AppHandle,
    default_name: &str,
) -> Option<std::path::PathBuf> {
    Some(crate::tempdir::kozou_temp_path(default_name))
}
#[cfg(mobile)]
pub async fn save_pdf_dialog_in(
    _app: &tauri::AppHandle,
    default_name: &str,
) -> Option<std::path::PathBuf> {
    Some(crate::tempdir::kozou_temp_path(default_name))
}
#[cfg(mobile)]
pub async fn pick_output_dir(_app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    Some(crate::tempdir::kozou_temp_dir())
}
#[cfg(mobile)]
pub fn setup_webkit_env() {}
#[cfg(mobile)]
pub fn log_display_environment() {}
