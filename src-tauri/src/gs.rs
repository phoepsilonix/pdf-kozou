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
    // 入力ファイルの存在確認
    if !std::path::Path::new(&input).exists() {
        return Err(format!("入力ファイルが見つかりません: {input}"));
    }

    // input と output が同じパスの場合はエラー
    let input_canonical = std::fs::canonicalize(&input).map_err(|e| e.to_string())?;
    let output_parent = std::path::Path::new(&output)
        .parent()
        .ok_or("出力パスが無効です")?;
    std::fs::create_dir_all(output_parent).map_err(|e| e.to_string())?;
    // output はまだ存在しない場合があるので親ディレクトリで比較
    if std::path::Path::new(&output).exists() {
        let output_canonical = std::fs::canonicalize(&output).map_err(|e| e.to_string())?;
        if input_canonical == output_canonical {
            return Err("入力と出力が同じファイルです。別のパスを指定してください。".to_string());
        }
    }

    let mut cmd = std::process::Command::new(&gs_path);

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

    #[cfg(target_os = "windows")]
    {
        // CREATE_NO_WINDOW フラグ (0x08000000)
        cmd.creation_flags(0x08000000);
    }

    let out = cmd.output().map_err(|e| format!("GS 起動失敗: {e}"))?;

    if out.status.success() {
        // 出力ファイルの存在確認
        if !std::path::Path::new(&output).exists() {
            return Err("GS は成功を返しましたが出力ファイルが生成されませんでした".to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let code = out.status.code().unwrap_or(-1);
        // GS のエラーメッセージは stdout に出ることもある
        let detail = if !stderr.is_empty() { &stderr } else { &stdout };
        Err(format!("GS エラー (exit code {code}):\n{detail}"))
    }
}
