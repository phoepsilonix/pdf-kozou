// pdf-kozou-core/src/main.rs
//
// PDF小僧 処理エンジン CLI
//
// 使い方:
//   pdf-kozou-core <COMMAND> [OPTIONS]
//
// 全コマンドは結果を JSON (stdout) で返す。
// エラー時も JSON { "ok": false, "error": "..." } を stdout に出力し
// exit code 1 で終了する。
//
// GUI (Tauri) からは stdin に JSON を渡して実行する方式と
// コマンドライン引数で渡す方式の両方をサポートする。

use clap::{Parser, Subcommand};
use pdf_kozou_core::error::ErrorResponse;

#[derive(Parser)]
#[command(
    name    = "pdf-kozou-core",
    version = env!("CARGO_PKG_VERSION"),
    about   = "PDF小僧 処理エンジン — MuPDF ベース",
    long_about = None,
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// PDF の基本情報を取得
    Info {
        /// 入力 PDF ファイルパス
        path: String,
    },

    /// PDF ページを画像にレンダリング
    Render {
        /// 入力 PDF ファイルパス
        path: String,
        /// ページ番号 (0始まり)
        #[arg(long, default_value = "0")]
        page: i32,
        /// 解像度 DPI
        #[arg(long, default_value = "144")]
        dpi: u32,
        /// 出力フォーマット: jpeg | png
        #[arg(long, default_value = "jpeg")]
        format: String,
        /// JPEG クオリティ (0-100)
        #[arg(long, default_value = "85")]
        quality: u8,
    },

    /// PDF をトリミング (CropBox 設定)
    Trim {
        /// 入力 PDF
        input: String,
        /// 出力 PDF
        output: String,
        /// 左余白 (pt)
        #[arg(long)]
        left: f32,
        /// 右余白 (pt) — メディアボックス右端から
        #[arg(long)]
        right: f32,
        /// 下余白 (pt)
        #[arg(long)]
        bottom: f32,
        /// 上余白 (pt) — メディアボックス上端から
        #[arg(long)]
        top: f32,
        /// 対象ページ (例: "1,3,5-10")。省略時は全ページ
        #[arg(long)]
        pages: Option<String>,
    },

    /// PDF を圧縮・最適化
    Compress {
        /// 入力 PDF
        input: String,
        /// 出力 PDF
        output: String,
        /// 画像を圧縮しない
        #[arg(long)]
        no_compress_images: bool,
        /// フォントを圧縮しない
        #[arg(long)]
        no_compress_fonts: bool,
        /// ガベージコレクションレベル (0-4)
        #[arg(long, default_value = "4")]
        gc: i32,
        /// 線形化しない
        #[arg(long)]
        no_linearize: bool,
    },

    /// PDF を分割
    Split {
        /// 入力 PDF
        input: String,
        /// 出力ディレクトリ
        out_dir: String,
        /// 出力ファイルのプレフィックス
        #[arg(long, default_value = "page")]
        prefix: String,
        /// N ページごとに分割 (省略時は1ページずつ)
        #[arg(long)]
        every: Option<i32>,
        /// ページ範囲で分割 (例: "1-3,4-6,7-10")
        #[arg(long)]
        ranges: Option<String>,
    },

    /// PDF を結合
    Merge {
        /// 結合するファイル (複数指定)
        #[arg(required = true)]
        inputs: Vec<String>,
        /// 出力 PDF
        #[arg(long, short)]
        output: String,
    },

    /// PDF ページを回転
    Rotate {
        /// 入力 PDF
        input: String,
        /// 出力 PDF
        output: String,
        /// 回転角度: 90 | 180 | 270
        #[arg(long)]
        angle: u32,
        /// 対象ページ (例: "1,3,5")。省略時は全ページ
        #[arg(long)]
        pages: Option<String>,
    },

    /// stdin から JSON リクエストを受け取って実行 (Tauri sidecar モード)
    Json,
}

fn main() {
    let cli = Cli::parse();
    let result = run(cli);
    if let Err(e) = result {
        let resp = ErrorResponse { ok: false, error: e.to_string() };
        println!("{}", serde_json::to_string(&resp).unwrap());
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> anyhow::Result<()> {
    match cli.command {
        Commands::Info { path } => {
            let resp = pdf_kozou_core::info::info(&path)?;
            println!("{}", serde_json::to_string(&resp)?);
        }

        Commands::Render { path, page, dpi, format, quality } => {
            let req = pdf_kozou_core::render::RenderRequest {
                path,
                page_index: page,
                dpi,
                format:  Some(format),
                quality: Some(quality),
            };
            let resp = pdf_kozou_core::render::render(&req)?;
            println!("{}", serde_json::to_string(&resp)?);
        }

        Commands::Trim { input, output, left, right, bottom, top, pages } => {
            let page_sel = pages.as_deref().map(parse_page_selection).transpose()?;
            let req = pdf_kozou_core::trim::TrimRequest {
                input,
                output,
                margins: pdf_kozou_core::trim::Margins { left, right, bottom, top },
                pages: page_sel,
            };
            let resp = pdf_kozou_core::trim::trim(&req)?;
            println!("{}", serde_json::to_string(&resp)?);
        }

        Commands::Compress { input, output, no_compress_images, no_compress_fonts, gc, no_linearize } => {
            let req = pdf_kozou_core::compress::CompressRequest {
                input,
                output,
                compress_images: Some(!no_compress_images),
                compress_fonts:  Some(!no_compress_fonts),
                garbage_level:   Some(gc),
                linearize:       Some(!no_linearize),
            };
            let resp = pdf_kozou_core::compress::compress(&req)?;
            println!("{}", serde_json::to_string(&resp)?);
        }

        Commands::Split { input, out_dir, prefix, every, ranges } => {
            let mode = if let Some(r) = ranges {
                pdf_kozou_core::split::SplitMode::Ranges {
                    ranges: parse_ranges(&r)?,
                }
            } else if let Some(n) = every {
                pdf_kozou_core::split::SplitMode::EveryN { n }
            } else {
                pdf_kozou_core::split::SplitMode::AllPages
            };
            let req = pdf_kozou_core::split::SplitRequest {
                input,
                out_dir,
                prefix: Some(prefix),
                mode,
            };
            let resp = pdf_kozou_core::split::split(&req)?;
            println!("{}", serde_json::to_string(&resp)?);
        }

        Commands::Merge { inputs, output } => {
            let req = pdf_kozou_core::merge::MergeRequest { inputs, output };
            let resp = pdf_kozou_core::merge::merge(&req)?;
            println!("{}", serde_json::to_string(&resp)?);
        }

        Commands::Rotate { input, output, angle, pages } => {
            let angle = match angle {
                90  => pdf_kozou_core::rotate::Angle::Cw90,
                180 => pdf_kozou_core::rotate::Angle::Deg180,
                270 => pdf_kozou_core::rotate::Angle::Ccw90,
                _   => anyhow::bail!("angle must be 90, 180, or 270"),
            };
            let pages = pages.as_deref().map(parse_page_list).transpose()?;
            let req = pdf_kozou_core::rotate::RotateRequest { input, output, angle, pages };
            let resp = pdf_kozou_core::rotate::rotate(&req)?;
            println!("{}", serde_json::to_string(&resp)?);
        }

        Commands::Json => {
            run_json_mode()?;
        }
    }
    Ok(())
}

/// Tauri sidecar モード: stdin から JSON を1行ずつ読んで処理
fn run_json_mode() -> anyhow::Result<()> {
    use std::io::BufRead;
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() { continue; }
        let response = dispatch_json(&line);
        println!("{response}");
    }
    Ok(())
}

/// JSON リクエストをディスパッチして JSON レスポンスを返す
fn dispatch_json(line: &str) -> String {
    #[derive(serde::Deserialize)]
    struct Tagged { cmd: String }

    let tag: Tagged = match serde_json::from_str(line) {
        Ok(t)  => t,
        Err(e) => return err_json(&format!("JSON parse error: {e}")),
    };

    // ? を使うためにクロージャで包んで即時実行する
    let result: anyhow::Result<String> = (|| {
        match tag.cmd.as_str() {
            "info" => {
                #[derive(serde::Deserialize)]
                struct Req { path: String }
                let r: Req = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&pdf_kozou_core::info::info(&r.path)?)?)
            }
            "render" => {
                let req: pdf_kozou_core::render::RenderRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&pdf_kozou_core::render::render(&req)?)?)
            }
            "trim" => {
                let req: pdf_kozou_core::trim::TrimRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&pdf_kozou_core::trim::trim(&req)?)?)
            }
            "compress" => {
                let req: pdf_kozou_core::compress::CompressRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&pdf_kozou_core::compress::compress(&req)?)?)
            }
            "split" => {
                let req: pdf_kozou_core::split::SplitRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&pdf_kozou_core::split::split(&req)?)?)
            }
            "merge" => {
                let req: pdf_kozou_core::merge::MergeRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&pdf_kozou_core::merge::merge(&req)?)?)
            }
            "rotate" => {
                let req: pdf_kozou_core::rotate::RotateRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&pdf_kozou_core::rotate::rotate(&req)?)?)
            }
            cmd => Err(anyhow::anyhow!("unknown command: {cmd}")),
        }
    })();

    match result {
        Ok(s)  => s,
        Err(e) => err_json(&e.to_string()),
    }
}

fn err_json(msg: &str) -> String {
    format!(r#"{{"ok":false,"error":{}}}"#, serde_json::to_string(msg).unwrap())
}

// ── パース補助 ────────────────────────────────────────────────────────────────

/// "1,3,5-10" → PageSelection::Range
fn parse_page_selection(s: &str) -> anyhow::Result<pdf_kozou_core::trim::PageSelection> {
    let pages = parse_page_list(s)?;
    Ok(pdf_kozou_core::trim::PageSelection::Range { pages })
}

/// "1,3,5-10" → Vec<i32>
fn parse_page_list(s: &str) -> anyhow::Result<Vec<i32>> {
    let mut pages = Vec::new();
    for part in s.split(',') {
        let part = part.trim();
        if let Some((a, b)) = part.split_once('-') {
            let start: i32 = a.trim().parse()?;
            let end:   i32 = b.trim().parse()?;
            pages.extend(start..=end);
        } else {
            pages.push(part.parse()?);
        }
    }
    Ok(pages)
}

/// "1-3,4-6" → Vec<[i32; 2]>
fn parse_ranges(s: &str) -> anyhow::Result<Vec<[i32; 2]>> {
    s.split(',')
     .map(|part| {
         let (a, b) = part.trim().split_once('-')
             .ok_or_else(|| anyhow::anyhow!("invalid range: {part}"))?;
         Ok([a.trim().parse()?, b.trim().parse()?])
     })
     .collect()
}
