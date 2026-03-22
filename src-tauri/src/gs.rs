// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/gs.rs

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};

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
    let mut cmd = std::process::Command::new(&gs_path);

    cmd.args([
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.4",
        &format!("-dPDFSETTINGS={}", level.as_gs_setting()),
        "-dNOPAUSE",
        //           "-dQUIET",
        "-dBATCH",
        "-dEmbedAllFonts=true",
        "-dSubsetFonts=true",
        "-dColorConversionStrategy=/LeaveColorUnchanged",
        &format!("-sOutputFile={}", &output),
        &input,
    ]);

    #[cfg(target_os = "windows")]
    {
        // CREATE_NO_WINDOW フラグ (0x08000000)
        cmd.creation_flags(0x08000000);
    }

    let out = cmd.output().map_err(|e| e.to_string())?;

    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}
