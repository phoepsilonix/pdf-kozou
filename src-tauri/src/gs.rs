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
/// Ghostscript 2段階実行:
///   1回目 (正規化): gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dNOPAUSE -dBATCH -sOutputFile=<一時ファイル> <input>
///   2回目 (本圧縮): gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/printer -dEmbedAllFonts=true -dSubsetFonts=true -dColorConversionStrategy=/LeaveColorUnchanged -dColorConversionStrategyForImages=/LeaveColorUnchanged -dNOPAUSE -dBATCH -sOutputFile=<output> <一時ファイル>

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

    // AppImage対策。AppImageで優先されている内部のライブラリを無視して、
    // システムのライブラリを優先してシステムのgsを呼び出すことで、整合性を保つ
    // --- LD_LIBRARY_PATH フィルタリング（Linux AppImage 対策）---
    #[cfg(target_os = "linux")]
    {
        let filtered = get_filtered_ld_path();
        if filtered.is_empty() {
            cmd.env_remove("LD_LIBRARY_PATH");
        } else {
            cmd.env("LD_LIBRARY_PATH", filtered);
        }
    }

    // その他の環境変数はそのまま継承（ユーザーのカスタマイズを尊重）
    // args をそのまま渡す

    // Ghostscript のバージョンによっては (ユーザー環境の GS 10.07.1 で確認)、
    // 元PDFに埋め込まれたICCプロファイルが何らかの理由で不正/非標準な形式に
    // なっていると、-dColorConversionStrategy(ForImages)=/LeaveColorUnchanged
    // を指定していても、書き出し時にICCプロファイルが壊れた(空の)ストリーム
    // になってしまう。
    //
    // 対策として、まず装飾的なカラー変換オプションを一切指定しない最小限の
    // pdfwrite 書き出しを一度行うと、GS がこの過程で不正なICCプロファイルを
    // 修復する("Invalid ICC colour profile, ... using /N to select a device
    // space" という警告が出ることがある)。その「矯正済み」の一時ファイルに
    // 対して、本来のフォント埋め込み・カラー保持オプション一式を適用する
    // 2段階処理にすることで、-dOverrideICC=true のように元のICCプロファイル
    // 自体を捨てることなく回避できる。
    let normalize_tmp = format!("{output}.gsnorm.tmp.pdf");
    {
        let mut normalize_cmd = std::process::Command::new(&gs_path);
        #[cfg(target_os = "linux")]
        {
            let filtered = get_filtered_ld_path();
            if filtered.is_empty() {
                normalize_cmd.env_remove("LD_LIBRARY_PATH");
            } else {
                normalize_cmd.env("LD_LIBRARY_PATH", filtered);
            }
        }
        normalize_cmd.args([
            "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.4",
            "-dNOPAUSE",
            "-dBATCH",
            &format!("-sOutputFile={}", &normalize_tmp),
            &input,
        ]);
        normalize_cmd
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            normalize_cmd.creation_flags(0x08000000);
        }
        let normalize_out = normalize_cmd
            .output()
            .map_err(|e| format!("GS(正規化パス) 起動失敗: {e}"))?;
        if !normalize_out.status.success() || !std::path::Path::new(&normalize_tmp).exists() {
            let stderr = String::from_utf8_lossy(&normalize_out.stderr).to_string();
            let stdout = String::from_utf8_lossy(&normalize_out.stdout).to_string();
            let detail = if !stderr.is_empty() { &stderr } else { &stdout };
            return Err(format!("GS(正規化パス)エラー:\n{detail}"));
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
        // -dColorConversionStrategy は主にベクター/テキストのカラー変換方針で、
        // 画像に埋め込まれたICCプロファイルの扱いは別枠(画像固有の色変換)に
        // なるGSのバージョン/ビルドがある。そちらもLeaveColorUnchangedに
        // 揃えないと、画像のICCプロファイルが空ストリームに壊されて
        // (Length=0)、閲覧環境によって色味がずれることがある。
        "-dColorConversionStrategyForImages=/LeaveColorUnchanged",
        "-dAutoRotatePages=/None",
        &format!("-sOutputFile={}", &output),
        &normalize_tmp,
    ]);

    // stdin/stdout/stderr をすべて明示する
    // Windows GUI サブシステムでは未指定だと INVALID_HANDLE_VALUE が渡される
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        // CREATE_NO_WINDOW フラグ (0x08000000)
        cmd.creation_flags(0x08000000);
    }

    let out = cmd.output().map_err(|e| format!("GS 起動失敗: {e}"))?;

    // 正規化パスの一時ファイルは成功・失敗どちらでも掃除する
    let _ = std::fs::remove_file(&normalize_tmp);

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
