// pdf-kozou-core/src/gs.rs

use std::process::Command;

#[derive(Debug, Clone, Copy)]
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
pub fn optimize_with_gs(
    gs_path: &str,
    input: &str,
    output: &str,
    level: GsCompressionLevel,
) -> anyhow::Result<()> {
    let status = Command::new(gs_path)
        .args([
            "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.4",
            &format!("-dPDFSETTINGS={}", level.as_gs_setting()),
            "-dNOPAUSE",
            "-dQUIET",
            "-dBATCH",
            "-dEmbedAllFonts=true",
            "-dSubsetFonts=true",
            "-dColorConversionStrategy=/LeaveColorUnchanged",
            &format!("-sOutputFile={}", output),
            input,
        ])
        .status()?;

    if status.success() {
        Ok(())
    } else {
        Err(anyhow::anyhow!("Ghostscriptの実行に失敗しました"))
    }
}

// pdf-kozou-core/src/gs.rs

pub fn run_gs_preview(
    gs_path: &str,
    input: &str,
    temp_output: &str,
    level: GsCompressionLevel,
) -> anyhow::Result<()> {
    // プレビュー用なので、最初の1ページ目だけを処理対象にするオプションを追加
    // -dFirstPage=1 -dLastPage=1 を加えると爆速になります
    let status = Command::new(gs_path)
        .args([
            "-sDEVICE=pdfwrite",
            "-dFirstPage=1",
            "-dLastPage=1",
            "-dCompatibilityLevel=1.4",
            &format!("-dPDFSETTINGS={}", level.as_gs_setting()),
            "-dNOPAUSE", "-dQUIET", "-dBATCH",
            &format!("-sOutputFile={}", temp_output),
            input,
        ])
        .status()?;

    if status.success() {
        Ok(())
    } else {
        Err(anyhow::anyhow!("GS Preview failed"))
    }
}

