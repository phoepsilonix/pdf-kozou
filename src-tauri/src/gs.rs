// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/gs.rs

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::JobCounter;
use std::sync::atomic::Ordering;
use tauri::State;

use serde::{Deserialize, Serialize};
use tauri::Emitter;

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

#[tauri::command]
pub async fn start_gs_job(
    gs_path: String,
    input: String,
    output: String,
    level: GsCompressionLevel,
    app: tauri::AppHandle,
    counter: State<'_, JobCounter>,
) -> Result<u64, String> {
    let job_id = counter.0.fetch_add(1, Ordering::Relaxed);

    tauri::async_runtime::spawn(async move {
        let result = run_gs_job_internal(gs_path, input, output, level).await;

        let _ = app.emit(
            "gs-job-finished",
            serde_json::json!({
                "job_id": job_id,
                "result": result,
            }),
        );
    });

    Ok(job_id)
}

/// Ghostscriptを使用してPDFを再構築・圧縮する
/// gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/printer -dEmbedAllFonts=true -dSubsetFonts=true -dColorConversionStrategy=/LeaveColorUnchanged -dNOPAUSE -dBATCH

#[cfg(target_os = "windows")]
async fn run_gs_job_internal(
    gs_path: String,
    input: String,
    output: String,
    level: GsCompressionLevel,
) -> Result<String, String> {
    use std::process::{Command, Stdio};

    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&gs_path);

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
            &format!("-sOutputFile={}", &output),
            &input,
        ]);

        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // ★ tokio::process::Command では効かない
        cmd.creation_flags(
            0x00000008 | // DETACHED_PROCESS
            0x00000200 | // CREATE_NEW_PROCESS_GROUP
            0x08000000, // CREATE_NO_WINDOW
        );

        cmd.output()
    })
    .await
    .map_err(|e| e.to_string())?;

    match out {
        Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).to_string()),
        Ok(o) => Err(String::from_utf8_lossy(&o.stderr).to_string()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(target_os = "windows"))]
async fn run_gs_job_internal(
    gs_path: String,
    input: String,
    output: String,
    level: GsCompressionLevel,
) -> Result<String, String> {
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
        &format!("-sOutputFile={}", &output),
        &input,
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());

    let out = cmd.output().await.map_err(|e| e.to_string())?;

    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn run_gs_optimize(
    gs_path: String,
    input: String,
    output: String,
    level: GsCompressionLevel,
) -> Result<String, String> {
    use std::process::{Command, Stdio};

    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&gs_path);

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
            &format!("-sOutputFile={}", &output),
            &input,
        ]);

        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // ★ tokio::process::Command では効かない
        cmd.creation_flags(
            0x00000008 | // DETACHED_PROCESS
            0x00000200 | // CREATE_NEW_PROCESS_GROUP
            0x08000000, // CREATE_NO_WINDOW
        );

        cmd.output()
    })
    .await
    .map_err(|e| e.to_string())?;

    match out {
        Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).to_string()),
        Ok(o) => Err(String::from_utf8_lossy(&o.stderr).to_string()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn run_gs_optimize(
    gs_path: String,
    input: String,
    output: String,
    level: GsCompressionLevel,
) -> Result<String, String> {
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
        &format!("-sOutputFile={}", &output),
        &input,
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());

    let out = cmd.output().await.map_err(|e| e.to_string())?;

    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}
