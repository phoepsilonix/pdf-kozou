// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/gs_detector.rs

#[cfg(target_os = "windows")]
use std::path::Path;
use std::path::PathBuf;

#[tauri::command]
pub async fn check_ghostscript_installed(custom_gs_path: Option<String>) -> bool {
    find_gs_executable(custom_gs_path).await.is_some()
}

/// GS 実行ファイルを優先順位に従って検索する。
///
/// 優先順位:
///   1. ユーザーが明示指定したパス（custom_gs_path）
///   2. 環境変数 PDF_KOZOU_GS_HOME / GHOSTSCRIPTHOME 配下の bin/
///   3. PATH 上の gs / gswin64c
///   4. Windows レジストリ（Windows のみ）
#[tauri::command]
pub async fn find_gs_executable(custom_gs_path: Option<String>) -> Option<String> {
    #[cfg(not(target_os = "windows"))]
    let bins = vec!["gs"];
    #[cfg(target_os = "windows")]
    let bins = vec!["gswin64c", "gswin32c", "gs"];

    // 1. ユーザーが明示指定したパスを最優先
    //    - 設定されていて有効なら → それを使う（終了）
    //    - 設定されていても無効（ファイルなし等）→ 自動検索へフォールスルー
    //    - 設定なし（None / 空文字）→ 自動検索へフォールスルー
    if let Some(ref custom) = custom_gs_path {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            let p = std::path::Path::new(trimmed);
            if p.exists() && p.is_file() && verify_gs(trimmed) {
                // 有効なパス → 使用する
                return Some(trimmed.to_string());
            }
            // 無効なパスは無視して自動検索へ続行
        }
    }

    // 2. 環境変数 PDF_KOZOU_GS_HOME / GHOSTSCRIPTHOME 配下の bin/
    let envs = ["PDF_KOZOU_GS_HOME", "GHOSTSCRIPTHOME"];
    for env_key in &envs {
        if let Ok(env_val) = std::env::var(env_key) {
            for bin in &bins {
                let exe_name = if cfg!(target_os = "windows") {
                    format!("{bin}.exe")
                } else {
                    bin.to_string()
                };
                let exe_path = PathBuf::from(env_val.clone()).join("bin").join(&exe_name);
                if exe_path.exists() {
                    return Some(exe_path.to_string_lossy().into_owned());
                }
            }
        }
    }

    // 3. PATH 上を探す
    for bin in &bins {
        if let Ok(path) = which::which(bin) {
            return Some(path.to_string_lossy().into_owned());
        }
    }

    // 4. Windows レジストリ
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let roots = [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER];
        let vendors = ["SOFTWARE\\GPL Ghostscript", "SOFTWARE\\Artifex Ghostscript"];

        for root in roots {
            let base_key = RegKey::predef(root);
            for vendor in vendors {
                if let Ok(gs_key) = base_key.open_subkey(vendor) {
                    for version in gs_key.enum_keys().map(|x| x.unwrap_or_default()) {
                        if let Ok(ver_key) = gs_key.open_subkey(&version) {
                            if let Ok(dll_path) = ver_key.get_value::<String, _>("GS_DLL") {
                                let exe_path = dll_path
                                    .to_lowercase()
                                    .replace("gsdll64.dll", "gswin64c.exe")
                                    .replace("gsdll32.dll", "gswin32c.exe");
                                if Path::new(&exe_path).exists() {
                                    return Some(exe_path);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

/// GS として有効か検証する（--version が通るか）
/// Windows GUI サブシステムアプリから呼ぶ場合、stdin/stdout/stderr を
/// すべて明示しないと INVALID_HANDLE_VALUE が渡されてクラッシュする可能性がある。
fn verify_gs(path: &str) -> bool {
    let mut cmd = std::process::Command::new(path);
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// 指定したパスが有効な GS かどうか検証し、バージョン文字列を返す
#[tauri::command]
pub async fn verify_gs_path(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("パスが空です".to_string());
    }
    let p = std::path::Path::new(trimmed);
    if !p.exists() {
        return Err(format!("ファイルが見つかりません: {trimmed}"));
    }
    if !p.is_file() {
        return Err(format!("ファイルではありません: {trimmed}"));
    }

    let mut cmd = std::process::Command::new(p);
    // stdin/stdout/stderr をすべて明示する
    // Windows GUI サブシステムでは未指定だと INVALID_HANDLE_VALUE が渡される
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: コンソールウィンドウを表示しない
        cmd.creation_flags(0x08000000);
    }

    let out = cmd.output().map_err(|e| format!("GS の実行に失敗: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!(
            "GS の応答が不正: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// ファイル選択ダイアログで GS 実行ファイルを選ぶ
#[tauri::command]
pub async fn pick_gs_executable(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    // Windows のみ .exe フィルターを適用する
    // Linux/macOS は実行ファイルに拡張子がないため add_filter しない（全ファイル表示）
    #[cfg(target_os = "windows")]
    let path = app
        .dialog()
        .file()
        .set_title("GS 実行ファイルを選択 (gswin64c.exe)")
        .add_filter("Ghostscript executable", &["exe"])
        .blocking_pick_file();

    #[cfg(not(target_os = "windows"))]
    let path = app
        .dialog()
        .file()
        .set_title("GS 実行ファイルを選択 (gs / gswin64c)")
        .blocking_pick_file();

    Ok(path.map(|p| p.to_string()))
}

/// 指定フォルダ以下で GS 実行ファイルを自動検索する
/// フォルダ選択 → この関数で GS を探す、という UX のために使用
#[tauri::command]
pub async fn find_gs_in_dir(dir: String) -> Option<String> {
    let base = std::path::Path::new(&dir);
    if !base.is_dir() {
        return None;
    }

    #[cfg(target_os = "windows")]
    let candidates = vec![
        base.join("bin").join("gswin64c.exe"),
        base.join("bin").join("gswin32c.exe"),
        base.join("gswin64c.exe"),
        base.join("gswin32c.exe"),
    ];
    #[cfg(not(target_os = "windows"))]
    let candidates = vec![base.join("bin").join("gs"), base.join("gs")];

    for p in &candidates {
        if p.exists() && p.is_file() && verify_gs(&p.to_string_lossy()) {
            return Some(p.to_string_lossy().into_owned());
        }
    }

    // 1段階だけ深く探す（例: gs10.07.0/bin/gswin64c.exe）
    if let Ok(entries) = std::fs::read_dir(base) {
        for entry in entries.flatten() {
            let sub = entry.path();
            if !sub.is_dir() {
                continue;
            }

            #[cfg(target_os = "windows")]
            let sub_candidates = vec![
                sub.join("bin").join("gswin64c.exe"),
                sub.join("bin").join("gswin32c.exe"),
                sub.join("gswin64c.exe"),
            ];
            #[cfg(not(target_os = "windows"))]
            let sub_candidates = vec![sub.join("bin").join("gs"), sub.join("gs")];

            for p in &sub_candidates {
                if p.exists() && p.is_file() && verify_gs(&p.to_string_lossy()) {
                    return Some(p.to_string_lossy().into_owned());
                }
            }
        }
    }

    None
}

/// OS のデフォルトインストール先から GS 候補パスを返す
#[tauri::command]
pub async fn suggest_gs_candidates() -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        // C:\Program Files\gs\ 以下のバージョンフォルダを探す
        let base_dirs = [r"C:\Program Files\gs", r"C:\Program Files (x86)\gs"];
        for base in &base_dirs {
            let base_path = std::path::Path::new(base);
            if let Ok(entries) = std::fs::read_dir(base_path) {
                let mut versions: Vec<_> =
                    entries.flatten().filter(|e| e.path().is_dir()).collect();
                // バージョン番号降順（新しいものを先頭に）
                versions.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
                for entry in versions {
                    let exe = entry.path().join("bin").join("gswin64c.exe");
                    if exe.exists() && verify_gs(&exe.to_string_lossy()) {
                        candidates.push(exe.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let paths = [
            "/usr/bin/gs",
            "/usr/local/bin/gs",
            "/opt/ghostscript/bin/gs",
        ];
        for p in &paths {
            if std::path::Path::new(p).exists() && verify_gs(p) {
                candidates.push(p.to_string());
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let paths = [
            "/usr/local/bin/gs",
            "/opt/homebrew/bin/gs",
            "/opt/local/bin/gs",
        ];
        for p in &paths {
            if std::path::Path::new(p).exists() && verify_gs(p) {
                candidates.push(p.to_string());
            }
        }
    }

    candidates
}
