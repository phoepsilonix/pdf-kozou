// pdf-kozou-core/src/gs.rs

use serde::{Deserialize, Serialize};
use std::process::Command;

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
    let out = Command::new(&gs_path)
        .args([
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
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string()) // 成功時のログを返す
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string()) // 失敗時の詳細エラーを返す
    }
}

// pdf-kozou-core/src/gs.rs

#[tauri::command]
pub async fn run_gs_preview(
    gs_path: String,
    input: String,
    temp_output: String,
    level: GsCompressionLevel,
) -> Result<(), String> {
    // プレビュー用なので、最初の1ページ目だけを処理対象にするオプションを追加
    // -dFirstPage=1 -dLastPage=1 を加えると爆速になります
    let status = Command::new(&gs_path)
        .args([
            "-sDEVICE=pdfwrite",
            "-dFirstPage=1",
            "-dLastPage=1",
            "-dCompatibilityLevel=1.4",
            &format!("-dPDFSETTINGS={}", level.as_gs_setting()),
            "-dNOPAUSE",
            "-dQUIET",
            "-dBATCH",
            &format!("-sOutputFile={}", &temp_output),
            &input,
        ])
        .status()
        .map_err(|e| format!("Ghostscriptプレビューの起動に失敗しました: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err("Ghostscriptプレビューの生成に失敗しました".to_string())
    }
}
