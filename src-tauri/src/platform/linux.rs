// src-tauri/src/platform/linux.rs
//
// Linux プラットフォーム固有の処理
//   - Display Server 検出 (X11 / Wayland / headless)
//   - ネイティブファイルダイアログ (xdg-desktop-portal 不使用)
//   - ウィンドウ環境情報取得

use std::path::PathBuf;
use crate::platform::DisplayServer;
                                                
///
/// 検出順序:
///   1. WAYLAND_DISPLAY → Wayland (DISPLAY もあれば XWayland も利用可能)
///   2. DISPLAY         → X11
///   3. それ以外        → Headless / Unknown
pub fn detect_display_server() -> DisplayServer {
    let wayland = std::env::var("WAYLAND_DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    let x11 = std::env::var("DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false);

    match (wayland, x11) {
        (true, true)  => DisplayServer::WaylandWithXWayland,
        (true, false) => DisplayServer::Wayland,
        (false, true) => DisplayServer::X11,
        (false, false) => {
            // /tmp/.X11-unix 以下にソケットがあれば X11 が動いている可能性
            if std::path::Path::new("/tmp/.X11-unix").exists() {
                DisplayServer::X11
            } else {
                DisplayServer::Headless
            }
        }
    }
}

/// アプリ起動時にディスプレイ環境をログ出力する
pub fn log_display_environment() {
    let ds = detect_display_server();
    tracing::info!("Display server: {:?}", ds);
    tracing::info!(
        "WAYLAND_DISPLAY={:?}  DISPLAY={:?}  XDG_SESSION_TYPE={:?}",
        std::env::var("WAYLAND_DISPLAY").unwrap_or_default(),
        std::env::var("DISPLAY").unwrap_or_default(),
        std::env::var("XDG_SESSION_TYPE").unwrap_or_default(),
    );
    if ds == DisplayServer::Headless {
        tracing::warn!(
            "No display server detected. \
             GUI will not be available. \
             Set DISPLAY=:0 (X11) or WAYLAND_DISPLAY=wayland-0 (Wayland) \
             before launching."
        );
    }
}

// ── ネイティブファイルダイアログ ─────────────────────────────────────────────
//
// rfd (Rust File Dialog) の GTK3 バックエンドを直接使用。
// xdg-desktop-portal / xdg-open を一切呼び出さない。
//
// GTK3 バックエンドは:
//   X11   → GtkFileChooserDialog (libgtk-3 経由)
//   Wayland → 同上 (GTK3 は Wayland ネイティブで動作)
//   どちらも xdg-desktop-portal 不要

/// ファイルを開くダイアログ (単一ファイル)
/// xdg-desktop-portal を使わず GTK3 で直接表示
pub async fn open_pdf_dialog() -> Option<PathBuf> {
    use rfd::AsyncFileDialog;

    AsyncFileDialog::new()
        .set_title("PDFファイルを開く")
        .add_filter("PDF", &["pdf"])
        .add_filter("すべてのファイル", &["*"])
        .pick_file()
        .await
        .map(|f| f.path().to_path_buf())
}

/// 複数ファイルを開くダイアログ
pub async fn open_pdfs_dialog() -> Vec<PathBuf> {
    use rfd::AsyncFileDialog;

    AsyncFileDialog::new()
        .set_title("PDFファイルを開く（複数選択可）")
        .add_filter("PDF", &["pdf"])
        .pick_files()
        .await
        .map(|files| files.into_iter().map(|f| f.path().to_path_buf()).collect())
        .unwrap_or_default()
}

/// 保存先ダイアログ
pub async fn save_pdf_dialog(default_name: &str) -> Option<PathBuf> {
    use rfd::AsyncFileDialog;
    AsyncFileDialog::new()
        .set_title("保存先を選択")
        .set_file_name(default_name)
        .add_filter("PDF", &["pdf"])
        .save_file().await
        .map(|f| f.path().to_path_buf())
}

pub async fn save_pdf_dialog_in(default_name: &str, initial_dir: Option<&str>) -> Option<PathBuf> {
    use rfd::AsyncFileDialog;
    let mut dlg = AsyncFileDialog::new()
        .set_title("保存先を選択")
        .set_file_name(default_name)
        .add_filter("PDF", &["pdf"]);
    if let Some(dir) = initial_dir {
        dlg = dlg.set_directory(dir);
    }
    dlg.save_file().await.map(|f| f.path().to_path_buf())
}

/// 出力ディレクトリ選択ダイアログ
pub async fn pick_output_dir() -> Option<PathBuf> {
    use rfd::AsyncFileDialog;

    AsyncFileDialog::new()
        .set_title("出力フォルダを選択")
        .pick_folder()
        .await
        .map(|f| f.path().to_path_buf())
}

// ── WebKitGTK 環境変数セットアップ ───────────────────────────────────────────
//
// Tauri の WebKitGTK は xdg-desktop-portal が存在しない環境で
// 一部機能（ファイルダイアログなど）が失敗する場合がある。
// 以下の環境変数を事前にセットすることで回避する。

pub fn setup_webkit_env() {
    let ds = detect_display_server();

    // WebKitGTK: サンドボックスを無効化（ポータル不要環境向け）
    // WEBKIT_DISABLE_COMPOSITING_MODE: ソフトウェアレンダリング fallback
    if ds == DisplayServer::X11 || ds == DisplayServer::WaylandWithXWayland {
        // X11 環境: XComposite が利用可能か確認
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    // Wayland 環境: GDK バックエンドを明示指定
    if ds == DisplayServer::Wayland || ds == DisplayServer::WaylandWithXWayland {
        // GDK_BACKEND が未設定の場合のみセット
        if std::env::var("GDK_BACKEND").is_err() {
            std::env::set_var("GDK_BACKEND", "wayland,x11");
        }
        // wl-display ソケットが存在するか確認
        let wayland_display = std::env::var("WAYLAND_DISPLAY")
            .unwrap_or_else(|_| "wayland-0".to_string());
        let runtime_dir = std::env::var("XDG_RUNTIME_DIR")
            .unwrap_or_else(|_| {
                // std のみで UID 取得 (/proc/self/status)、失敗時は 1000
                let uid = std::fs::read_to_string("/proc/self/status")
                    .ok()
                    .and_then(|s| {
                        s.lines()
                            .find(|l| l.starts_with("Uid:"))
                            .and_then(|l| l.split_whitespace().nth(1))
                            .and_then(|v| v.parse::<u32>().ok())
                    })
                    .unwrap_or(1000);
                format!("/run/user/{}", uid)
            });
        let socket = std::path::PathBuf::from(&runtime_dir).join(&wayland_display);
        if !socket.exists() {
            tracing::warn!(
                "Wayland socket not found at {}. Falling back to X11.",
                socket.display()
            );
            std::env::set_var("GDK_BACKEND", "x11");
        }
    }

    // GTK IM モジュール: fcitx / ibus との競合回避
    if std::env::var("GTK_IM_MODULE").is_err() {
        // 空文字でリセット（xim fallback）
        std::env::set_var("GTK_IM_MODULE", "");
    }

    // xdg-desktop-portal を無効化
    // GTK_USE_PORTAL=0 で GTK が portal を使わないようにする
    std::env::set_var("GTK_USE_PORTAL", "0");
}

// ── スクリーン情報 ────────────────────────────────────────────────────────────
/*
/// 現在のスクリーン解像度を取得
pub fn get_screen_info() -> ScreenInfo {
    let ds = detect_display_server();
    let (w, h, scale) = match &ds {
        DisplayServer::X11 | DisplayServer::WaylandWithXWayland => {
            get_x11_screen_size().unwrap_or((1920, 1080, 1.0))
        }
        DisplayServer::Wayland => {
            get_wayland_screen_size().unwrap_or((1920, 1080, 1.0))
        }
        _ => (1920, 1080, 1.0),
    };
    ScreenInfo { display_server: ds, width: w, height: h, scale_factor: scale }
}

fn get_x11_screen_size() -> Option<(u32, u32, f64)> {
    use x11rb::connection::Connection;
    use x11rb::rust_connection::RustConnection;

    let (conn, screen_num) = RustConnection::connect(None).ok()?;
    let screen = &conn.setup().roots[screen_num];
    let w = screen.width_in_pixels as u32;
    let h = screen.height_in_pixels as u32;
    // DPI から scale factor を推定 (96 DPI = 1.0)
    let dpi = screen.width_in_pixels as f64 / (screen.width_in_millimeters as f64 / 25.4);
    let scale = (dpi / 96.0).max(1.0);
    Some((w, h, scale))
}

fn get_wayland_screen_size() -> Option<(u32, u32, f64)> {
    // Wayland では wl_output の geometry / mode イベントから取得
    // 簡易実装: 環境変数 QT_SCALE_FACTOR / GDK_SCALE を参照
    let scale = std::env::var("GDK_SCALE")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(1.0);
    // Wayland で解像度を取得するには wayland-client のイベントループが必要
    // ここでは fallback として 1920x1080 を返す
    // TODO: wayland-client を使った完全実装
    Some((1920, 1080, scale))
}
*/
