// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/platform/mod.rs

#[cfg(mobile)]
use tauri::Manager;

pub mod screen_info;
pub use screen_info::{DisplayServer, ScreenInfo};

#[cfg(target_os = "android")]
pub mod android_fs_info;

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
/// 復元する、最後の手段のフォールバック。
///
/// ⚠ これは常に正しいファイル名を復元できるわけではない。
/// Android の SAF (Storage Access Framework) が返す content:// URI の
/// 末尾セグメント(ドキュメントID)は、プロバイダによってフォーマットが
/// 異なる:
///   - ExternalStorageProvider 等、実パスに基づく ID を返すプロバイダの例:
///     `content://.../document/primary%3ADownload%2Fscan.pdf`
///       → decode → `primary:Download/scan.pdf` → basename → `scan.pdf`
///   - MediaStore 由来のドキュメントプロバイダ等、完全に不透明な ID を
///     返すプロバイダの例:
///     `content://.../document/msf%3A1000000123`
///       → decode しても `msf:1000000123` にしかならず、元のファイル名は
///         どこにも含まれていない。
///
/// 後者のケースでは URI をいくら percent-decode してもファイル名は
/// 復元できないため、Android では本関数を呼ぶ前に
/// `android_fs_info::KozouFsInfo::get_display_name` で
/// ContentResolver 経由の `OpenableColumns.DISPLAY_NAME` を問い合わせる
/// (これなら日本語等の Unicode ファイル名も含め、プロバイダに依らず
/// 正しい名前が取れる)。本関数はそれが失敗した場合のフォールバックとして
/// のみ使う。
///
/// なお、decode 前の生の URI パスをそのまま使うと、コピー先の一時ファイル名
/// に拡張子が付かず (`%2F` や `%3A` を含んだ不正なファイル名になり)、
/// フロントエンドの拡張子判定 (`isMupdfExtension`) に弾かれて
/// 「ファイルを選んでも何も追加されない」という症状になるため、必ず
/// percent-decode してから使う。
#[cfg(mobile)]
fn guess_file_name(file_path: &tauri_plugin_fs::FilePath) -> String {
    use std::path::Path;

    // 1. まず、ファイルパス自体からファイル名が取れるか試す。
    //    content:// URI の場合は生のパス文字列が percent-encode されて
    //    いるため、basename を取り出す前に必ず decode する
    //    (decode しないと拡張子付きの判定に失敗する)。
    let path_str = match file_path {
        tauri_plugin_fs::FilePath::Path(p) => Some(p.to_string_lossy().to_string()),
        tauri_plugin_fs::FilePath::Url(url) => {
            percent_decode(url.path()).or_else(|| Some(url.path().to_string()))
        }
    };

    if let Some(p) = path_str {
        let path = Path::new(&p);
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            // ここで中身を確認し、数字の羅列でなければそれを返す
            if !name.is_empty() && !name.chars().all(|c| c.is_ascii_digit()) {
                return name.to_string();
            }
        }
    }

    "picked_file".to_string()
}

/// 簡易 percent-decode (UTF-8 前提)。`url` クレートの `Url::path()` は
/// percent-encode されたままの文字列を返す (decode は行わない) ため、
/// ここで明示的に decode する。不正なバイト列だった場合は None を返す。
#[cfg(mobile)]
fn percent_decode(s: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(s.len());
    let mut chars = s.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next()?;
            let lo = chars.next()?;
            let byte = u8::from_str_radix(&format!("{}{}", hi as char, lo as char), 16).ok()?;
            bytes.push(byte);
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8(bytes).ok()
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

    // 名前(拡張子込み)を復元しておく。
    //
    // Android: URI から推測する前に、まず ContentResolver 経由で正式な
    // ファイル名 (OpenableColumns.DISPLAY_NAME) を問い合わせる。
    // これはプロバイダが URI に実ファイル名を含めない場合
    // (例: `content://.../document/msf%3A1000000123` のような不透明な
    // ドキュメントID)でも、日本語等の Unicode ファイル名を含め正しく
    // 取得できる。取得できなかった場合のみ、従来の URI ベースの推測
    // (`guess_file_name`) にフォールバックする。
    #[cfg(target_os = "android")]
    let guess_name = {
        use tauri::Manager;
        let from_resolver = match &file_path {
            tauri_plugin_fs::FilePath::Url(url) => app
                .try_state::<crate::platform::android_fs_info::KozouFsInfo>()
                .and_then(|state| state.get_display_name(url.as_str())),
            tauri_plugin_fs::FilePath::Path(_) => None,
        };
        from_resolver.unwrap_or_else(|| guess_file_name(&file_path))
    };
    #[cfg(not(target_os = "android"))]
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
pub struct PendingSaves(
    pub std::sync::Mutex<std::collections::HashMap<String, tauri_plugin_fs::FilePath>>,
);

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
    let output_dir = _app
        .path()
        .document_dir()
        .expect("Failed to get document dir");
    Some(output_dir)
}
