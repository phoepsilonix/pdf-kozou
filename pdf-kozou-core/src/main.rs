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

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
        /// 埋め込みフォント情報も取得する
        #[arg(long)]
        fonts: bool,
    },

    /// PDF ページを画像にレンダリング
    Render {
        /// 入力 PDF ファイルパス
        path: String,
        /// 出力ページ指定 (1始まり)。形式:
        ///   --page 1          単ページ
        ///   --page 1-3        範囲
        ///   --page 1,3,5      個別複数
        ///   --page 1-3,5,7    混在
        ///   --page all        全ページ (JSON stdout に base64 配列で返す)
        /// 省略時は --out-dir が必須となり全ページをファイル出力
        #[arg(long)]
        page: Option<String>,
        /// 解像度 DPI
        #[arg(long, default_value = "144")]
        dpi: u32,
        /// 出力フォーマット: jpeg | png
        #[arg(long, default_value = "jpeg")]
        format: String,
        /// JPEG クオリティ (0-100)
        #[arg(long, default_value = "85")]
        quality: u8,
        /// 単ページ出力先ファイルパス (--page で単ページ指定時のみ有効。省略時は JSON stdout)
        #[arg(long, short)]
        output: Option<String>,
        /// ファイル出力先ディレクトリ (--page 省略時に必須。--page 指定時も使用可)
        #[arg(long)]
        out_dir: Option<String>,
        /// ファイル出力時のファイル名プレフィックス。末尾が数字なら連番はその続きから。
        /// 例: "page-" → page-001.jpg / "slide_100" → slide_100.jpg, slide_101.jpg
        /// 省略時は入力ファイルのステム + "_p" (例: input_p001.jpg)
        #[arg(long)]
        name_prefix: Option<String>,
        /// ファイル出力時の連番開始番号 (省略時は --name-prefix 末尾の数字、またはデフォルト 1)
        #[arg(long)]
        start_number: Option<u32>,
    },

    /// PDF をトリミング (CropBox 設定)
    Trim {
        /// 入力 PDF
        input: String,
        /// 出力 PDF
        output: String,
        /// 左余白
        #[arg(long, default_value = "0")]
        left: f32,
        /// 右余白
        #[arg(long, default_value = "0")]
        right: f32,
        /// 下余白
        #[arg(long, default_value = "0")]
        bottom: f32,
        /// 上余白
        #[arg(long, default_value = "0")]
        top: f32,
        /// 単位指定: mm (デフォルト) | pt | cm | in
        #[arg(long, default_value = "mm")]
        unit: String,
        /// トリミング対象ページ (例: "1,3,5-10,all,odd,even")。省略時は全ページ。
        #[arg(long)]
        pages: Option<String>,
        /// 除外ページ (例:
        /// "none, 2,4-6,all,odd,even")。pagesで指定した範囲からトリミングを除外。省略時は対象ページすべてにトリミング適用。
        #[arg(long)]
        exclude: Option<String>,
        /// 抽出ページ (例:
        /// "2,4-6,all,odd,even")。トリミング無関係に、特定ページのみ残す指定。省略時はすべて残す。
        #[arg(long)]
        extract: Option<String>,
    },

    /// PDF を圧縮・最適化
    Compress {
        /// 入力 PDF
        input: String,
        /// 出力 PDF
        output: String,
        /// DocumentWriter で全ページ再描画して再圧縮 (gs 相当の高圧縮。ベクター・フォント保持)
        /// ⚠️ Type3 フォントを含む PDF は自動的に安全な通常圧縮にフォールバックします
        #[arg(long)]
        rewrite: bool,
        /// rewrite 時の追加オプション (MuPDF オプション文字列)
        #[arg(long)]
        rewrite_options: Option<String>,
        /// 圧縮プリセット: light | standard | aggressive | maximum
        /// (デフォルト: standard — gc=2, 画像圧縮あり, フォント安全)
        /// ⚠️  maximum は埋め込みフォントに影響する場合があります
        #[arg(long, default_value = "standard")]
        preset: String,
        /// 画像を圧縮しない (プリセットより優先)
        #[arg(long)]
        no_compress_images: bool,
        /// フォントストリームを圧縮しない (プリセットより優先)
        #[arg(long)]
        no_compress_fonts: bool,
        /// ガベージコレクションレベル 0-4 (プリセットより優先)
        #[arg(long)]
        gc: Option<i32>,
        /// コンテンツストリーム再構築を有効にする (プリセットより優先)
        #[arg(long)]
        clean: bool,
        /// ストリーム再解釈を有効にする ⚠️ フォントリスクあり (プリセットより優先)
        #[arg(long)]
        sanitize: bool,
        /// フォントサブセット化を有効にする (pdf_subset_fonts FFI)
        /// ⚠️ MuPDF バージョンによっては CJK/多言語フォントで不安定な場合があります
        #[arg(long)]
        font_subset: bool,
        /// 未使用埋め込みフォントを取り除く
        #[arg(long)]
        object_stream: bool,
        #[arg(long)]
        merge_fonts: bool,
    },

    /// PDF を全ページ画像化して PDF に再出力（ラスタライズ）
    ///
    /// ⚠️ この操作はページ全体を画像に変換します。
    ///   テキスト選択・検索・コピーが失われます。
    ///   Type3 フォントを含む PDF でも処理できます。
    ///   通常の圧縮が目的なら compress または compress --rewrite を使ってください。
    Rasterize {
        /// 入力 PDF
        input: String,
        /// 出力 PDF
        output: String,
        /// 解像度 DPI (デフォルト: 150)
        #[arg(long, default_value = "150")]
        dpi: f32,
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
        /// 全ページ共通の回転角度: 0 | 90 | 180 | 270
        /// --page-angles と併用可。--page-angles が優先される。
        #[arg(long)]
        angle: Option<u32>,
        /// 対象ページ (例: "1,3,5")。省略時は全ページ。--angle と組み合わせて使用。
        #[arg(long)]
        pages: Option<String>,
        /// ページ個別の回転角度 (例: "1:90,2:180,3:270")
        /// --angle より優先される。
        #[arg(long)]
        page_angles: Option<String>,
    },

    /// stdin から JSON リクエストを受け取って実行 (Tauri sidecar モード)
    Json,
}

fn main() {
    let cli = Cli::parse();
    let result = run(cli);
    if let Err(e) = result {
        let resp = ErrorResponse {
            ok: false,
            error: e.to_string(),
        };
        println!("{}", serde_json::to_string(&resp).unwrap());
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> anyhow::Result<()> {
    match cli.command {
        Commands::Info { path, fonts } => {
            let resp = if fonts {
                pdf_kozou_core::info::info_with_fonts(&path)?
            } else {
                pdf_kozou_core::info::info(&path)?
            };
            println!("{}", serde_json::to_string(&resp)?);
        }

        Commands::Render {
            path,
            page,
            dpi,
            format,
            quality,
            output,
            out_dir,
            name_prefix,
            start_number,
        } => {
            let ext = match format.as_str() {
                "png" => "png",
                "svg" => "svg",
                _ => "jpg",
            };

            // --page をパース → PageSpec に変換
            let page_spec = match page.as_deref() {
                None => PageSpec::Omitted,
                Some("all") => PageSpec::All,
                Some(s) => PageSpec::Indices(parse_string_pages(s)?),
            };

            match (page_spec, out_dir) {
                // ① --page 省略 + --out-dir なし → エラー
                (PageSpec::Omitted, None) => {
                    anyhow::bail!(
                        "either --page <N|RANGE|all> or --out-dir <DIR> is required
                         hint: use --page all to get all pages as JSON,                          or --out-dir <DIR> to write files"
                    );
                }

                // ② --page 省略 + --out-dir あり → 全ページをファイル出力
                (PageSpec::Omitted, Some(ref out_dir)) | (PageSpec::All, Some(ref out_dir)) => {
                    let out_dir = out_dir.clone();
                    std::fs::create_dir_all(&out_dir)?;
                    let info = pdf_kozou_core::info::info(&path)?;
                    let total = info.page_count as u32;
                    let indices: Vec<i32> = (0..info.page_count).collect();
                    render_to_dir(
                        &path,
                        &indices,
                        total,
                        start_number,
                        name_prefix.as_deref(),
                        &out_dir,
                        &format,
                        quality,
                        dpi,
                        ext,
                    )?;
                }

                // ③ --page all + --out-dir なし → 全ページ JSON stdout
                (PageSpec::All, None) => {
                    let info = pdf_kozou_core::info::info(&path)?;
                    let indices: Vec<i32> = (0..info.page_count).collect();
                    render_to_json(&path, &indices, &format, quality, dpi)?;
                }

                // ④ --page N/range + --out-dir あり → 指定ページをファイル出力
                (PageSpec::Indices(ref indices), Some(ref out_dir)) => {
                    let out_dir = out_dir.clone();
                    std::fs::create_dir_all(&out_dir)?;
                    let total = indices.len() as u32;
                    render_to_dir(
                        &path,
                        indices,
                        total,
                        start_number,
                        name_prefix.as_deref(),
                        &out_dir,
                        &format,
                        quality,
                        dpi,
                        ext,
                    )?;
                }

                // ⑤ --page N (単ページ) + --out-dir なし → JSON or ファイル (-o)
                (PageSpec::Indices(ref indices), None) if indices.len() == 1 => {
                    let page_index = indices[0];
                    let req = pdf_kozou_core::render::RenderRequest {
                        path,
                        page_index,
                        dpi,
                        format: Some(format),
                        quality: Some(quality),
                        output,
                    };
                    let resp = pdf_kozou_core::render::render(&req)?;
                    println!("{}", serde_json::to_string(&resp)?);
                }

                // ⑥ --page 複数指定 + --out-dir なし → 複数ページ JSON stdout
                (PageSpec::Indices(ref indices), None) => {
                    render_to_json(&path, indices, &format, quality, dpi)?;
                }
            }
        }

        Commands::Trim {
            input,
            output,
            left,
            right,
            bottom,
            top,
            unit,
            pages,
            exclude,
            extract,
        } => {
            // 単位をptに変換
            let to_pt = match unit.to_lowercase().as_str() {
                "pt" => 1.0_f32,
                "cm" => 28.3465,
                "in" | "inch" => 72.0,
                _ => 2.83465, // mm (デフォルト)
            };

            let trim_page = pages.as_deref().map(parse_page_selection).transpose()?;
            let exclude_page = exclude.as_deref().map(parse_page_selection).transpose()?;
            let extract_page = extract.as_deref().map(parse_page_selection).transpose()?;
            println!(
                "{:?} {:?} {:?}",
                trim_page.iter(),
                exclude_page,
                extract_page
            );
            let req = pdf_kozou_core::trim::TrimRequest {
                input,
                output,
                margins: pdf_kozou_core::trim::Margins {
                    left: left * to_pt,
                    right: right * to_pt,
                    bottom: bottom * to_pt,
                    top: top * to_pt,
                },
                unit: "pt".to_string(), // CLI側で変換済み
                pages: trim_page,
                exclude: exclude_page,
                extract: extract_page,
            };
            let resp = pdf_kozou_core::trim::trim(&req)?;
            println!("{}", serde_json::to_string(&resp)?);
        }

        Commands::Compress {
            input,
            output,
            rewrite,
            rewrite_options,
            preset,
            no_compress_images,
            no_compress_fonts,
            gc,
            clean,
            sanitize,
            font_subset,
            object_stream,
            merge_fonts,
        } => {
            let resp = if rewrite {
                let opts = rewrite_options
                    .as_deref()
                    .unwrap_or(pdf_kozou_core::compress::REWRITE_OPTIONS_DEFAULT);
                // フォールバック時のパラメータ優先順位:
                //   1. 明示的な CLI フラグ (--gc / --clean / --sanitize / --no-compress-*)
                //   2. --rewrite-options 文字列から parse（rewrite 失敗時でも同じ設定で圧縮）
                //   3. デフォルト値
                let fallback = {
                    use pdf_kozou_core::compress::{
                        parse_rewrite_opt_bool, parse_rewrite_opt_i32, RewriteFallbackParams,
                    };
                    RewriteFallbackParams {
                        garbage_level: gc.or_else(|| parse_rewrite_opt_i32(opts, "garbage")),
                        clean: clean || parse_rewrite_opt_bool(opts, "clean").unwrap_or(false),
                        sanitize: sanitize
                            || parse_rewrite_opt_bool(opts, "sanitize").unwrap_or(false),
                        compress_images: if no_compress_images {
                            Some(false)
                        } else {
                            parse_rewrite_opt_bool(opts, "compress-images")
                        },
                        compress_fonts: if no_compress_fonts {
                            Some(false)
                        } else {
                            parse_rewrite_opt_bool(opts, "compress-fonts")
                        },
                        object_stream: Some(
                            object_stream
                                || parse_rewrite_opt_bool(opts, "object_stream").unwrap_or(false),
                        ),
                        merge_fonts: Some(
                            merge_fonts
                                || parse_rewrite_opt_bool(opts, "merge_fonts").unwrap_or(false),
                        ),
                    }
                };
                pdf_kozou_core::compress::rewrite(&input, &output, opts, &fallback)?
            } else {
                use pdf_kozou_core::compress::CompressPreset;
                let preset = match preset.as_str() {
                    "light" => Some(CompressPreset::Light),
                    "aggressive" => Some(CompressPreset::Aggressive),
                    "maximum" => Some(CompressPreset::Maximum),
                    _ => Some(CompressPreset::Standard),
                };
                let req = pdf_kozou_core::compress::CompressRequest {
                    input,
                    output,
                    preset,
                    compress_images: if no_compress_images {
                        Some(false)
                    } else {
                        None
                    },
                    compress_fonts: if no_compress_fonts { Some(false) } else { None },
                    garbage_level: gc,
                    clean: if clean { Some(true) } else { None },
                    sanitize: if sanitize { Some(true) } else { None },
                    font_subset: if font_subset { Some(true) } else { None },
                    object_stream: Some(object_stream),
                    merge_fonts: Some(merge_fonts),
                };
                pdf_kozou_core::compress::compress(&req)?
            };
            println!("{}", serde_json::to_string(&resp)?);
        }

        Commands::Rasterize { input, output, dpi } => {
            let resp = pdf_kozou_core::compress::rasterize(&input, &output, dpi)?;
            println!("{}", serde_json::to_string(&resp)?);
        }

        Commands::Split {
            input,
            out_dir,
            prefix,
            every,
            ranges,
        } => {
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

        Commands::Rotate {
            input,
            output,
            angle,
            pages,
            page_angles,
        } => {
            // --angle: 0/90/180/270 のみ受け付ける
            if let Some(a) = angle {
                if a % 90 != 0 || a > 270 {
                    anyhow::bail!("angle must be 0, 90, 180, or 270");
                }
            }
            // --page-angles "1:90,2:180,3:270" をパース
            let rotations = page_angles
                .as_deref()
                .map(|s| {
                    s.split(',')
                        .map(|pair| {
                            let mut it = pair.splitn(2, ':');
                            let page = it
                                .next()
                                .unwrap_or("0")
                                .trim()
                                .parse::<i32>()
                                .map_err(|e| anyhow::anyhow!("invalid page: {}", e))?;
                            let deg = it
                                .next()
                                .unwrap_or("0")
                                .trim()
                                .parse::<i32>()
                                .map_err(|e| anyhow::anyhow!("invalid angle: {}", e))?;
                            Ok(pdf_kozou_core::rotate::PageRotation { page, angle: deg })
                        })
                        .collect::<anyhow::Result<Vec<_>>>()
                })
                .transpose()?;

            let pages = pages.as_deref().map(parse_page_list).transpose()?;
            let req = pdf_kozou_core::rotate::RotateRequest {
                input,
                output,
                angle: angle.map(|a| a as i32),
                pages,
                rotations,
            };
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
/*
fn run_json_mode() -> anyhow::Result<()> {
    use std::io::BufRead;
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = dispatch_json(&line);
        println!("{response}");
    }
    Ok(())
}
*/
fn run_json_mode() -> anyhow::Result<()> {
    let stdin = std::io::stdin();
    let reader = std::io::BufReader::new(stdin.lock());

    // 1行ずつではなく、ストリームからJSONオブジェクトを順次読み取る
    let stream = serde_json::Deserializer::from_reader(reader).into_iter::<serde_json::Value>();

    for value in stream {
        match value {
            Ok(v) => {
                // dispatch_json を &str ではなく Value を受け取るように変更するか
                // 一旦文字列に戻して渡す（既存の dispatch_json を活かす場合）
                let line = v.to_string();
                let response = dispatch_json(&line);
                println!("{response}");
            }
            Err(e) => {
                eprintln!("JSON parse error: {e}");
                // 致命的なエラーでなければ継続、あるいは exit
            }
        }
    }
    Ok(())
}

/// JSON リクエストをディスパッチして JSON レスポンスを返す
fn dispatch_json(line: &str) -> String {
    #[derive(serde::Deserialize)]
    struct Tagged {
        cmd: String,
    }

    let tag: Tagged = match serde_json::from_str(line) {
        Ok(t) => t,
        Err(e) => return err_json(&format!("JSON parse error: {e}")),
    };

    // ? を使うためにクロージャで包んで即時実行する
    let result: anyhow::Result<String> = (|| {
        match tag.cmd.as_str() {
            "info" => {
                #[derive(serde::Deserialize)]
                struct Req {
                    path: String,
                    #[serde(default)]
                    fonts: bool,
                }
                let r: Req = serde_json::from_str(line)?;
                let resp = if r.fonts {
                    pdf_kozou_core::info::info_with_fonts(&r.path)?
                } else {
                    pdf_kozou_core::info::info(&r.path)?
                };
                Ok(serde_json::to_string(&resp)?)
            }
            "render" => {
                let req: pdf_kozou_core::render::RenderRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&pdf_kozou_core::render::render(
                    &req,
                )?)?)
            }
            "trim" => {
                let req: pdf_kozou_core::trim::TrimRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&pdf_kozou_core::trim::trim(&req)?)?)
            }
            "compress" => {
                #[derive(serde::Deserialize)]
                struct Req {
                    #[serde(default)]
                    rewrite: bool,
                    #[serde(default)]
                    rewrite_options: Option<String>,
                    // フォールバック時のパラメータ (JSON API 用)
                    // CLI の --gc / --clean / --sanitize / --no-compress-* に相当
                    #[serde(default)]
                    fallback_gc: Option<i32>,
                    #[serde(default)]
                    fallback_clean: bool,
                    #[serde(default)]
                    fallback_sanitize: bool,
                    #[serde(default)]
                    fallback_compress_images: Option<bool>,
                    #[serde(default)]
                    fallback_compress_fonts: Option<bool>,
                    #[serde(flatten)]
                    inner: pdf_kozou_core::compress::CompressRequest,
                }
                let r: Req = serde_json::from_str(line)?;

                let resp = if r.rewrite {
                    let opts = r
                        .rewrite_options
                        .as_deref()
                        .unwrap_or(pdf_kozou_core::compress::REWRITE_OPTIONS_DEFAULT);
                    // 優先順位: 明示的な fallback_* フィールド > rewrite_options 文字列 > デフォルト
                    let fallback = {
                        use pdf_kozou_core::compress::{
                            parse_rewrite_opt_bool, parse_rewrite_opt_i32, RewriteFallbackParams,
                        };
                        RewriteFallbackParams {
                            garbage_level: r
                                .fallback_gc
                                .or_else(|| parse_rewrite_opt_i32(opts, "garbage")),
                            clean: r.fallback_clean
                                || parse_rewrite_opt_bool(opts, "clean").unwrap_or(false),
                            sanitize: r.fallback_sanitize
                                || parse_rewrite_opt_bool(opts, "sanitize").unwrap_or(false),
                            compress_images: r
                                .fallback_compress_images
                                .or_else(|| parse_rewrite_opt_bool(opts, "compress-images")),
                            compress_fonts: r
                                .fallback_compress_fonts
                                .or_else(|| parse_rewrite_opt_bool(opts, "compress-fonts")),
                            merge_fonts: Some(
                                parse_rewrite_opt_bool(opts, "merge_fonts").unwrap_or(false),
                            ),
                            object_stream: Some(
                                parse_rewrite_opt_bool(opts, "object_stream").unwrap_or(false),
                            ),
                        }
                    };
                    pdf_kozou_core::compress::rewrite(
                        &r.inner.input,
                        &r.inner.output,
                        opts,
                        &fallback,
                    )?
                } else {
                    pdf_kozou_core::compress::compress(&r.inner)?
                };
                Ok(serde_json::to_string(&resp)?)
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
                Ok(serde_json::to_string(&pdf_kozou_core::rotate::rotate(
                    &req,
                )?)?)
            }
            cmd => Err(anyhow::anyhow!("unknown command: {cmd}")),
        }
    })();

    match result {
        Ok(s) => s,
        Err(e) => err_json(&e.to_string()),
    }
}

fn err_json(msg: &str) -> String {
    format!(
        r#"{{"ok":false,"error":{}}}"#,
        serde_json::to_string(msg).unwrap()
    )
}

// ── パース補助 ────────────────────────────────────────────────────────────────

use pdf_kozou_core::trim::PageSelection;

/// "1,3,5-10" → PageSelection::Range
fn parse_page_selection(s: &str) -> anyhow::Result<pdf_kozou_core::trim::PageSelection> {
    if s.to_lowercase() == "none" {
        return Ok(PageSelection::None);
    }
    if s.to_lowercase() == "all" {
        return Ok(PageSelection::All);
    }
    if s.to_lowercase() == "odd" {
        return Ok(PageSelection::Odd);
    }
    if s.to_lowercase() == "even" {
        return Ok(PageSelection::Even);
    }
    if s.is_empty() {
        return Ok(PageSelection::All);
    }
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
            let end: i32 = b.trim().parse()?;
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
            let (a, b) = part
                .trim()
                .split_once('-')
                .ok_or_else(|| anyhow::anyhow!("invalid range: {part}"))?;
            Ok([a.trim().parse()?, b.trim().parse()?])
        })
        .collect()
}

// ── render 全ページ出力ヘルパー ───────────────────────────────────────────────

/// --name-prefix と --page-start からファイル名ベースと開始番号を決定する。
///
/// ルール:
///   1. --page-start が明示されていればそれを使う。
///   2. --name-prefix の末尾が数字なら、その数字を開始番号として分離し
///      プレフィックスはその手前の文字列とする。
///      例: "page-100" → base="page-", start=100
///   3. どちらも無い場合は start=1。
///   4. --name-prefix 自体が省略された場合は入力ファイルのステム + "_p" を使う。
fn resolve_name_prefix_and_start(
    name_prefix: Option<&str>,
    start_number: Option<u32>,
    input_path: &str,
    _total: u32,
) -> (String, u32) {
    let raw = match name_prefix {
        Some(p) => p.to_string(),
        None => {
            let stem = std::path::Path::new(input_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("page");
            format!("{}_p", stem)
        }
    };

    // 末尾の連続する数字を取り出す
    let tail_digits: String = raw
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect();

    if let Some(start) = start_number {
        // --page-start 明示: プレフィックスから末尾数字を除いてベースにする
        let base = if !tail_digits.is_empty() {
            raw[..raw.len() - tail_digits.len()].to_string()
        } else {
            raw
        };
        (base, start)
    } else if !tail_digits.is_empty() {
        // 末尾数字を開始番号として使う
        let start: u32 = tail_digits.parse().unwrap_or(1);
        let base = raw[..raw.len() - tail_digits.len()].to_string();
        (base, start)
    } else {
        // 末尾が区切り文字 or 純粋な文字列: 1始まり
        (raw, 1)
    }
}

/// 数値を表現するのに必要な桁数 (最低3桁)
fn digit_width(max_num: u32) -> u32 {
    let natural = if max_num == 0 {
        1
    } else {
        (max_num as f64).log10().floor() as u32 + 1
    };
    natural.max(3)
}

// ── render ヘルパー ───────────────────────────────────────────────────────────

/// --page の解釈結果
enum PageSpec {
    Omitted,
    All,
    Indices(Vec<i32>),
}

/// "1", "1-3", "1,3,5", "1-3,5,7" → 0始まりインデックスの Vec
fn parse_string_pages(s: &str) -> anyhow::Result<Vec<i32>> {
    let mut indices = Vec::new();
    for part in s.split(',') {
        let part = part.trim();
        if let Some((a, b)) = part.split_once('-') {
            let start: i32 = a.trim().parse()?;
            let end: i32 = b.trim().parse()?;
            for p in start..=end {
                indices.push(p - 1); // 1始まり → 0始まり
            }
        } else {
            let p: i32 = part.parse()?;
            indices.push(p - 1);
        }
    }
    Ok(indices)
}

/// 指定ページをファイルに書き出す (--out-dir あり共通処理)
fn render_to_dir(
    path: &str,
    indices: &[i32],
    total: u32,
    start_number: Option<u32>,
    name_prefix: Option<&str>,
    out_dir: &str,
    format: &str,
    quality: u8,
    dpi: u32,
    ext: &str,
) -> anyhow::Result<()> {
    let (base, start_num) = resolve_name_prefix_and_start(name_prefix, start_number, path, total);
    let mut file_list = Vec::new();

    for (seq, &page_index) in indices.iter().enumerate() {
        let num = start_num + seq as u32;
        let width = digit_width(start_num + total - 1);
        let out_path = format!(
            "{}/{}{:0>width$}.{}",
            out_dir,
            base,
            num,
            ext,
            width = width as usize
        );
        let req = pdf_kozou_core::render::RenderRequest {
            path: path.to_string(),
            page_index,
            dpi,
            format: Some(format.to_string()),
            quality: Some(quality),
            output: Some(out_path.clone()),
        };
        let resp = pdf_kozou_core::render::render(&req)?;
        file_list.push(serde_json::json!({
            "page":     page_index + 1,
            "file":     out_path,
            "width_px": resp.width_px,
            "height_px":resp.height_px,
        }));
    }
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "ok": true, "files": file_list,
        }))?
    );
    Ok(())
}

/// 指定ページを JSON (base64) で stdout に出力
fn render_to_json(
    path: &str,
    indices: &[i32],
    format: &str,
    quality: u8,
    dpi: u32,
) -> anyhow::Result<()> {
    let mut pages = Vec::new();
    for &page_index in indices {
        let req = pdf_kozou_core::render::RenderRequest {
            path: path.to_string(),
            page_index,
            dpi,
            format: Some(format.to_string()),
            quality: Some(quality),
            output: None,
        };
        let resp = pdf_kozou_core::render::render(&req)?;
        pages.push(serde_json::json!({
            "page":      page_index + 1,
            "image_b64": resp.image_b64,
            "format":    resp.format,
            "width_px":  resp.width_px,
            "height_px": resp.height_px,
        }));
    }
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "ok": true, "pages": pages,
        }))?
    );
    Ok(())
}
