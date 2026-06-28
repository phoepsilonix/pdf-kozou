// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/gs.rs

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};

#[cfg(target_os = "linux")]
use std::sync::OnceLock;

#[cfg(target_os = "linux")]
static FILTERED_LD_PATH: OnceLock<String> = OnceLock::new();

#[cfg(target_os = "linux")]
fn get_filtered_ld_path() -> &'static str {
    FILTERED_LD_PATH.get_or_init(|| {
        let orig = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
        let appdir = std::env::var("APPDIR").ok();

        let filtered: String = orig
            .split(':')
            .filter(|p| {
                let p = p.trim();
                if p.is_empty() {
                    return false;
                }
                if let Some(ref appdir) = appdir
                    && p.starts_with(appdir.as_str())
                {
                    return false;
                }
                true
            })
            .collect::<Vec<_>>()
            .join(":");

        filtered
    })
}

//#[derive(Debug, Clone, Copy)]
#[derive(Debug, Deserialize, Serialize)]
pub enum GsCompressionLevel {
    Prepress, // 高品質（300dpi, 低圧縮）
    Printer,  // 標準（300dpi, 中圧縮）
    Ebook,    // 軽量（150dpi, 高圧縮）
}

impl GsCompressionLevel {
    fn as_gs_setting(&self) -> &'static str {
        match self {
            GsCompressionLevel::Prepress => "/prepress",
            GsCompressionLevel::Printer => "/printer",
            GsCompressionLevel::Ebook => "/ebook",
        }
    }
}

/// Ghostscriptを使用してPDFを再構築・圧縮する
/// gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/printer -dEmbedAllFonts=true -dSubsetFonts=true -dColorConversionStrategy=/LeaveColorUnchanged -dNOPAUSE -dBATCH

#[tauri::command]
pub async fn run_gs_optimize(
    gs_path: String,
    input: String,
    output: String,
    level: GsCompressionLevel,
) -> Result<String, String> {
    use tokio::fs;

    // 入力ファイルの存在確認
    if fs::metadata(&input).await.is_err() {
        return Err(format!("入力ファイルが見つかりません: {input}"));
    }

    let input_canonical = fs::canonicalize(&input).await.map_err(|e| e.to_string())?;
    let output_parent = std::path::Path::new(&output)
        .parent()
        .ok_or("出力パスが無効です")?;

    fs::create_dir_all(output_parent)
        .await
        .map_err(|e| e.to_string())?;

    if fs::metadata(&output).await.is_ok() {
        let output_canonical = fs::canonicalize(&output).await.map_err(|e| e.to_string())?;
        if input_canonical == output_canonical {
            return Err("入力と出力が同じファイルです。別のパスを指定してください。".to_string());
        }
    }

    // ★ Ghostscript 実行を別スレッドに逃がす（UI が止まらない）
    let _output = output.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut cmd = tokio::process::Command::new(&gs_path);

        #[cfg(target_os = "linux")]
        {
            let filtered = get_filtered_ld_path();
            if filtered.is_empty() {
                cmd.env_remove("LD_LIBRARY_PATH");
            } else {
                cmd.env("LD_LIBRARY_PATH", filtered);
            }
        }

        cmd.args([
            "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.5",
            &format!("-dPDFSETTINGS={}", level.as_gs_setting()),
            "-dNOPAUSE",
            "-dBATCH",
            "-dEmbedAllFonts=true",
            "-dSubsetFonts=true",
            "-dColorConversionStrategy=/LeaveColorUnchanged",
            "-dAutoRotatePages=/None",
            &format!("-sOutputFile={}", &_output),
            &input,
        ]);

        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        // ★ tokio::process::Command のまま → Windows でも UI が止まらない
        cmd.output().await.map_err(|e| format!("GS 起動失敗: {e}"))
    });

    // spawn の結果を受け取る
    let out = handle.await.map_err(|e| format!("join error: {e}"))??;

    // Ghostscript の結果処理（元コードと同じ）
    if out.status.success() {
        if fs::metadata(&output).await.is_err() {
            return Err("GS は成功を返しましたが出力ファイルが生成されませんでした".to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let code = out.status.code().unwrap_or(-1);
        let detail = if !stderr.is_empty() { &stderr } else { &stdout };
        Err(format!("GS エラー (exit code {code}):\n{detail}"))
    }
}
