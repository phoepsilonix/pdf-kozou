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
    _initial_dir: Option<&str>,
) -> Option<std::path::PathBuf> {
    use rfd::AsyncFileDialog;
    let mut dlg = AsyncFileDialog::new()
        .set_file_name(default_name)
        .add_filter("PDF", &["pdf"]);
    if let Some(d) = _initial_dir {
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

    // 1. すでに実パスならそのまま返す (デスクトップ等)
    if let Some(p) = file_path.as_path() {
        return Ok(p.to_path_buf());
    }

    // 名前(拡張子込み)を復元しておく
    let guess_name = guess_file_name(&file_path);

    // 2. モバイル環境: 一度全バイト読み込む
    // app.fs() は非同期環境で呼ぶ必要があるため spawn_blocking を使用
    let bytes = app
        .fs()
        .read(file_path.clone())
        .map_err(|e| format!("Read error: {e}"))?;

    // 3. 一時ディレクトリへのパス生成
    //
    // 以前はファイル名の先頭にミリ秒タイムスタンプを付与し、さらに
    // 拡張子の有無に関わらず無条件で ".pdf" を付け足していた
    // (例: "scan.pdf" → "1720000000000_scan.pdf.pdf",
    //      "photo.jpg" → "1720000000000_photo.jpg.pdf")。
    // これだと:
    //   - ホーム画面のファイル一覧が数字だらけの名前になり、
    //     自分が追加したファイルなのか分からず混乱を招く
    //     (複数ファイル追加時・バッチモードで特に顕著)。
    //   - 非PDFファイル(jpg/epub/docx等)にまで ".pdf" 拡張子が付き、
    //     拡張子ベースの判定と実データが食い違う。
    //
    // 一意性が必要なのはコピー先のパスであってファイル名そのものではない
    // ため、タイムスタンプ+連番はファイル名ではなく専用の一時サブ
    // ディレクトリ名に付け、ファイル名は(拡張子が既にあれば)元のまま
    // 保持する。
    static IMPORT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = IMPORT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();

    let file_name = if std::path::Path::new(&guess_name).extension().is_some() {
        guess_name
    } else {
        // 拡張子を復元できなかった場合のみ、フロントエンドの拡張子判定
        // (isMupdfExtension 等)に弾かれないよう ".pdf" を補う。
        format!("{guess_name}.pdf")
    };

    let import_dir = crate::tempdir::kozou_temp_dir().join(format!("import_{millis}_{seq}"));
    std::fs::create_dir_all(&import_dir).map_err(|e| format!("mkdir error: {e}"))?;
    let dest = import_dir.join(&file_name);

    // 4. 実ファイルとして保存
    std::fs::write(&dest, bytes).map_err(|e| format!("Write error: {e}"))?;

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

    let picked = match rx
        .await
        .map_err(|e| format!("picker channel closed: {e}"))?
    {
        Some(p) => p,
        None => return Ok(None), // ユーザーがキャンセルした場合。エラーではない。
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

    let result = rx
        .await
        .map_err(|e| format!("picker channel closed: {e}"))?;
    let picked = match result {
        Some(files) => files,
        None => return Ok(vec![]), // ユーザーがキャンセルした場合。エラーではない。空配列を返す。
    };

    let mut out = Vec::with_capacity(picked.len());
    // 1件でも読み込みに失敗したら、無視して黙って続けるのではなく
    // まとめてエラーを返す (原因がフロントエンドで見えるように)。
    for fp in picked {
        out.push(filepath_to_local(app, fp).await?);
    }
    Ok(out)
}

/// モバイル(Android/iOS)で「このアプリの一時パス → ユーザーが選んだ保存先」の
/// 対応を覚えておくための状態。
///
/// モバイルでは MuPDF/pdf-kozou-core が `output` に書き込む際、実ファイルパス
/// (fopen できるパス) が必要で、SAF (Storage Access Framework) が返す
/// `content://` URI へは直接書き込めない。そのため:
///   1. `save_pdf_dialog` でネイティブの保存ダイアログを表示し、ユーザーが
///      選んだ保存先 (content:// URI であることが多い) を取得する。
///   2. core への `output` にはアプリ専用一時ディレクトリの実パスを渡す。
///   3. 処理が終わったら `finalize_pending_save` で、一時ファイルの中身を
///      ユーザーが選んだ保存先へコピーする (tauri-plugin-fs 経由。
///      content:// でも ContentResolver 経由の書き込みに対応している)。
#[cfg(mobile)]
#[derive(Default)]
pub struct PendingSaves(pub std::sync::Mutex<std::collections::HashMap<String, tauri_plugin_fs::FilePath>>);

/// 保存ダイアログを表示し、ユーザーが選んだ保存先を覚えておいた上で、
/// core が実際に書き込む先(アプリ専用一時ディレクトリの実パス)を返す。
/// ユーザーがキャンセルした場合は None を返す(デスクトップ版と同じ挙動)。
#[cfg(mobile)]
async fn mobile_save_dialog_impl(
    app: &tauri::AppHandle,
    default_name: &str,
) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(default_name)
        .add_filter("PDF", &["pdf"])
        .save_file(move |result| {
            let _ = tx.send(result);
        });

    // ユーザーがキャンセルした場合は Ok(None) が来る。チャンネルが閉じた
    // (何らかの異常)場合も、キャンセル扱いにして呼び出し元へ None を返す。
    let dest = rx.await.ok().flatten()?;

    let temp_path = crate::tempdir::kozou_temp_path(default_name);
    let key = temp_path.display().to_string();

    if let Some(state) = app.try_state::<PendingSaves>() {
        state.0.lock().unwrap().insert(key, dest);
    }

    Some(temp_path)
}

#[cfg(mobile)]
pub async fn save_pdf_dialog(
    app: &tauri::AppHandle,
    default_name: &str,
) -> Option<std::path::PathBuf> {
    mobile_save_dialog_impl(app, default_name).await
}
#[cfg(mobile)]
pub async fn save_pdf_dialog_in(
    app: &tauri::AppHandle,
    default_name: &str,
) -> Option<std::path::PathBuf> {
    // Android の ACTION_CREATE_DOCUMENT は初期ディレクトリの指定に対応しない
    // ため、_initial_dir 相当の引数は無い(呼び出し元の pick_save_file_in も
    // モバイルでは初期ディレクトリを無視する)。
    mobile_save_dialog_impl(app, default_name).await
}

/// `output_path` がユーザーが選んだ保存先に紐づく一時ファイルであれば、
/// その中身を実際の保存先へコピーして一時ファイルを削除する。
/// 紐づきが無い場合(デスクトップ相当のパスや、保存を伴わない処理)は何もしない。
#[cfg(mobile)]
pub fn finalize_pending_save(app: &tauri::AppHandle, output_path: &str) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_fs::{FsExt, OpenOptions};

    let Some(state) = app.try_state::<PendingSaves>() else {
        return Ok(());
    };

    let dest = { state.0.lock().unwrap().remove(output_path) };
    let Some(dest) = dest else {
        return Ok(());
    };

    let bytes = std::fs::read(output_path)
        .map_err(|e| format!("一時ファイルの読み込みに失敗しました: {e}"))?;

    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);

    let mut file = app
        .fs()
        .open(dest, opts)
        .map_err(|e| format!("保存先への書き込みに失敗しました: {e}"))?;

    use std::io::Write;
    file.write_all(&bytes)
        .map_err(|e| format!("保存先への書き込みに失敗しました: {e}"))?;

    let _ = std::fs::remove_file(output_path);

    Ok(())
}
#[cfg(mobile)]
pub async fn pick_output_dir(_app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    Some(crate::tempdir::kozou_temp_dir())
}
#[cfg(mobile)]
pub fn setup_webkit_env() {}
#[cfg(mobile)]
pub fn log_display_environment() {}
