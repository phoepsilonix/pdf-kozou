// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/gs_detector.rs

#[cfg(target_os = "windows")]
use std::path::Path;

#[tauri::command]
pub async fn check_ghostscript_installed() -> bool {
    find_gs_executable().await.is_some()
}

#[tauri::command]
pub async fn find_gs_executable() -> Option<String> {
    // 1. PATH上の実行ファイルを優先 (gs, gswin64c, gswin32c)
    #[cfg(not(target_os = "windows"))]
    let bins = vec!["gs"];
    #[cfg(target_os = "windows")]
    let bins = vec!["gswin64c", "gswin32c", "gs", "gxpswin64", "gxpswin32" ];

    for bin in bins {
        if let Ok(path) = which::which(bin) {
            return Some(path.to_string_lossy().into_owned());
        }
    }

    // 2. Windowsの場合のみレジストリを深掘り
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
                                // DLLのパスから実行ファイル(exe)のパスを推測
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
