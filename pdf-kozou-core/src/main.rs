// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

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
        /// 入力ファイルパス（PDF/EPUB/DOCX/XPS/CBZ/画像 等）
        path: String,
        /// 埋め込みフォント情報も取得する（PDF のみ有効）
        #[arg(long)]
        fonts: bool,
        /// 非 PDF ファイルを自動変換してから正確な情報を取得する
        /// （省略時: 非 PDF はダミー情報を返す）
        #[arg(long)]
        convert: bool,
        /// リフロー可能文書のレイアウト幅 (pt)。--convert 時に使用。省略時は 450pt
        #[arg(long)]
        layout_w: Option<f32>,
        /// リフロー可能文書のレイアウト高さ (pt)。--convert 時に使用。省略時は 600pt
        #[arg(long)]
        layout_h: Option<f32>,
        /// リフロー可能文書のフォントサイズ (pt)。--convert 時に使用。省略時は 12pt
        #[arg(long)]
        layout_em: Option<f32>,
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
        /// 出力フォーマット: jpeg | png | svg
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
        /// リフロー可能文書のレイアウト幅 (pt)。省略時は 450pt
        #[arg(long)]
        layout_w: Option<f32>,
        /// リフロー可能文書のレイアウト高さ (pt)。省略時は 600pt
        #[arg(long)]
        layout_h: Option<f32>,
        /// リフロー可能文書のフォントサイズ (pt)。省略時は 12pt
        #[arg(long)]
        layout_em: Option<f32>,
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
        /// CropBox 外の XObject を lopdf で削除してファイルサイズを削減する（試験的）
        /// 一部でも CropBox と重なる部品は保持するためレイアウトへの影響は最小限。
        #[arg(long)]
        crop_cleanup: bool,
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
        /// Type3 フォント検出時のラスタライズ DPI（--rewrite 時のみ有効、デフォルト 150）
        #[arg(long)]
        rasterize_dpi: Option<f32>,
        /// Type3 フォント検出時の JPEG 品質（--rewrite 時のみ有効、デフォルト 85）
        #[arg(long)]
        rasterize_quality: Option<i32>,
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
        /// JPEG 品質 0-100 (デフォルト: 85)
        #[arg(long, default_value = "85")]
        quality: i32,
        /// ページ指定 "1-3,5" 形式 (1ベース)。省略時は全ページ。
        #[arg(long)]
        page: Option<String>,
        /// PNG 埋め込みで画像 PDF を生成（可逆・無劣化）
        #[arg(long, default_value = "false")]
        png: bool,
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

    /// 非 PDF ファイル（EPUB, DOCX, XPS, HTML, 画像等）を PDF に変換する
    Convert {
        /// 入力ファイルパス
        input: String,
        /// 出力 PDF ファイルパス
        output: String,
        /// リフロー可能文書のレイアウト幅 (pt)。省略時は 450pt
        #[arg(long, default_value = "450")]
        layout_w: f32,
        /// リフロー可能文書のレイアウト高さ (pt)。省略時は 600pt
        #[arg(long, default_value = "600")]
        layout_h: f32,
        /// リフロー可能文書のベースフォントサイズ (pt)。省略時は 12pt
        #[arg(long, default_value = "12")]
        layout_em: f32,
    },
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
        // stdout を確実にフラッシュしてから終了
        let _ = {
            use std::io::Write;
            std::io::stdout().flush()
        };
        std::process::exit(1);
    }
    // MuPDF コンテキストの Drop 処理が Windows でフリーズすることがある。
    // （system-fonts feature の font_kit がフォントスキャンスレッドを持ち、
    //   プロセス終了時のクリーンアップでデッドロックする場合がある）
    // stdout を明示的にフラッシュしてから強制終了して回避する。
    let _ = {
        use std::io::Write;
        std::io::stdout().flush()
    };
    std::process::exit(0);
}

fn run(cli: Cli) -> anyhow::Result<()> {
    match cli.command {
        Commands::Info {
            path,
            fonts,
            convert,
            layout_w,
            layout_h,
            layout_em,
        } => {
            use pdf_kozou_core::convert::is_pdf;

            // --convert または非 PDF の場合は自動変換してから info 取得
            let needs_convert = convert || !is_pdf(&path);
            let _tmp = if needs_convert {
                auto_convert_if_needed(&path, layout_w, layout_h, layout_em, None, None, None)?
            } else {
                None
            };
            let actual_path = if let Some((_, ref p)) = _tmp {
                p.as_str()
            } else {
                &path
            };

            let mut resp = if fonts {
                pdf_kozou_core::info::info_with_fonts(actual_path)?
            } else {
                pdf_kozou_core::info::info(actual_path)?
            };

            // 変換した場合は file_size を元ファイルのサイズに戻す
            if _tmp.is_some() {
                resp.file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            }

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
            layout_w,
            layout_h,
            layout_em,
        } => {
            // SVG はビューワー／サムネイル描画でもソフトマスクが正しく出るよう、
            // 描画前に svg2pdf 経由の PDF へ変換する。MuPDF が SVG を直接開くと
            // 画像 luminance マスクを解釈できず透明部分が黒矩形になるため。
            // プレビューは元サイズ表示にしたいので page_w/h・auto_orient は渡さない
            // （ページサイズ固定は処理系の convert_to_pdf 側で別途適用される）。
            let _svg_tmp = if pdf_kozou_core::convert::is_svg(&path) {
                auto_convert_if_needed(&path, layout_w, layout_h, layout_em, None, None, None)?
            } else {
                None
            };
            let path = if let Some((_, ref p)) = _svg_tmp {
                p.clone()
            } else {
                path
            };

            let ext = match format.as_str() {
                "png" => "png",
                "svg" => "svg",
                _ => "jpg",
            };

            let page_spec = match page.as_deref() {
                None => PageSpec::Omitted,
                Some("all") => PageSpec::All,
                Some(s) => PageSpec::Indices(parse_string_pages(s)?),
            };

            match (page_spec, out_dir) {
                (PageSpec::Omitted, None) => {
                    anyhow::bail!(
                        "either --page <N|RANGE|all> or --out-dir <DIR> is required
                         hint: use --page all to get all pages as JSON,                          or --out-dir <DIR> to write files"
                    );
                }

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
                        layout_w,
                        layout_h,
                        layout_em,
                    )?;
                }

                (PageSpec::All, None) => {
                    let info = pdf_kozou_core::info::info(&path)?;
                    let indices: Vec<i32> = (0..info.page_count).collect();
                    render_to_json(
                        &path, &indices, &format, quality, dpi, layout_w, layout_h, layout_em,
                    )?;
                }

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
                        layout_w,
                        layout_h,
                        layout_em,
                    )?;
                }

                (PageSpec::Indices(ref indices), None) if indices.len() == 1 => {
                    let page_index = indices[0];
                    let req = pdf_kozou_core::render::RenderRequest {
                        path,
                        page_index,
                        dpi,
                        format: Some(format),
                        quality: Some(quality),
                        output,
                        layout_w,
                        layout_h,
                        layout_em,
                    };
                    let resp = pdf_kozou_core::render::render(&req)?;
                    println!("{}", serde_json::to_string(&resp)?);
                }

                (PageSpec::Indices(ref indices), None) => {
                    render_to_json(
                        &path, indices, &format, quality, dpi, layout_w, layout_h, layout_em,
                    )?;
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
            crop_cleanup,
        } => {
            let _tmp = auto_convert_if_needed(&input, None, None, None, None, None, None)?;
            let input = if let Some((_, ref p)) = _tmp {
                p.clone()
            } else {
                input
            };
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
                crop_cleanup,
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
            rasterize_dpi,
            rasterize_quality,
        } => {
            let _tmp = auto_convert_if_needed(&input, None, None, None, None, None, None)?;
            let input = if let Some((_, ref p)) = _tmp {
                p.clone()
            } else {
                input
            };
            let resp = if rewrite {
                let opts = rewrite_options
                    .as_deref()
                    .unwrap_or(pdf_kozou_core::compress::REWRITE_OPTIONS_DEFAULT);
                let fallback = {
                    use pdf_kozou_core::compress::{
                        RewriteFallbackParams, parse_rewrite_opt_bool, parse_rewrite_opt_i32,
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
                        rasterize_dpi,
                        rasterize_quality,
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

        Commands::Rasterize {
            input,
            output,
            dpi,
            quality,
            page,
            png,
        } => {
            let _tmp = auto_convert_if_needed(&input, None, None, None, None, None, None)?;
            let input = if let Some((_, ref p)) = _tmp {
                p.clone()
            } else {
                input
            };
            let pages = page.as_deref().map(parse_page_list).transpose()?;
            let resp = pdf_kozou_core::compress::rasterize_with_quality(
                &input,
                &output,
                dpi,
                quality,
                png,
                pages.as_deref(),
            )?;
            println!("{}", serde_json::to_string(&resp)?);
        }

        Commands::Split {
            input,
            out_dir,
            prefix,
            every,
            ranges,
        } => {
            let _tmp = auto_convert_if_needed(&input, None, None, None, None, None, None)?;
            let input = if let Some((_, ref p)) = _tmp {
                p.clone()
            } else {
                input
            };
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
                override_metadata: None,
            };
            let resp = pdf_kozou_core::split::split(&req)?;
            println!("{}", serde_json::to_string(&resp)?);
        }

        Commands::Merge { inputs, output } => {
            let mut tmps: Vec<(tempfile::NamedTempFile, String)> = Vec::new();
            let inputs = inputs
                .into_iter()
                .map(|inp| {
                    if let Ok(Some(converted)) =
                        auto_convert_if_needed(&inp, None, None, None, None, None, None)
                    {
                        let path = converted.1.clone();
                        tmps.push(converted);
                        path
                    } else {
                        inp
                    }
                })
                .collect::<Vec<_>>();
            let req = pdf_kozou_core::merge::MergeRequest { inputs, output };
            let resp = pdf_kozou_core::merge::merge(&req)?;
            drop(tmps);
            println!("{}", serde_json::to_string(&resp)?);
        }

        Commands::Rotate {
            input,
            output,
            angle,
            pages,
            page_angles,
        } => {
            let _tmp = auto_convert_if_needed(&input, None, None, None, None, None, None)?;
            let input = if let Some((_, ref p)) = _tmp {
                p.clone()
            } else {
                input
            };
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

        Commands::Convert {
            input,
            output,
            layout_w,
            layout_h,
            layout_em,
        } => {
            use pdf_kozou_core::convert::{ConvertRequest, convert_to_pdf};
            let req = ConvertRequest {
                input,
                output,
                layout_w: Some(layout_w),
                layout_h: Some(layout_h),
                layout_em: Some(layout_em),
                page_w_pt: None,
                page_h_pt: None,
                auto_orient: None,
            };
            let resp = convert_to_pdf(&req)?;
            println!("{}", serde_json::to_string(&resp)?);
        }
    }
    Ok(())
}

/// Tauri sidecar モード: stdin から JSON を1行ずつ読んで処理
///
/// Windows 対応のポイント:
///   1. serde_json::Deserializer::from_reader はストリーム終端まで待つため
///      Tauri の sidecar（1リクエスト1送信）でブロッキングになる。
///      → 行単位読み込みに戻す
///   2. Windows では stdout を明示的に flush しないと
///      Tauri 側が応答を受け取れない場合がある。
///   3. stdin は UTF-8 として読む（Windows のデフォルト CP932 対策）
fn run_json_mode() -> anyhow::Result<()> {
    use std::io::{BufRead, Write};

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[json-mode] stdin read error: {e}");
                break;
            }
        };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let response = dispatch_json(&line);
        {
            let mut out = stdout.lock();
            writeln!(out, "{response}").ok();
            out.flush().ok();
        }
        // Windows: 応答後すぐ exit して MuPDF Drop フリーズを回避
        // （JSON モードは 1リクエスト1プロセスのため EOF後に自然終了でよいが
        //   font_kit のスレッドが残りフリーズする場合がある）
        let _ = stdout.lock().flush();
        std::process::exit(0);
    }
    Ok(())
}

/// 非 PDF ファイルを一時 PDF に変換して、そのパスを返す
///
/// PDF なら Some(None)（変換不要）
/// 非 PDF かつ対応形式なら Some(Some((tmp_file, tmp_path)))
/// 非 PDF かつ非対応形式ならエラー
fn auto_convert_if_needed(
    input: &str,
    layout_w: Option<f32>,
    layout_h: Option<f32>,
    layout_em: Option<f32>,
    page_w_pt: Option<f32>,
    page_h_pt: Option<f32>,
    auto_orient: Option<bool>,
) -> anyhow::Result<Option<(tempfile::NamedTempFile, String)>> {
    use pdf_kozou_core::convert::{ConvertRequest, convert_to_pdf, is_mupdf_supported, is_pdf};

    if is_pdf(input) {
        return Ok(None); // PDF はそのまま
    }
    if !is_mupdf_supported(input) {
        anyhow::bail!("unsupported file format: {input}");
    }

    // ページサイズ固定は画像入力のときのみ適用する。
    // DOCX/EPUB 等の reflowable 文書は layout で制御し、ここでは固定しない。
    let is_image = {
        let ext = std::path::Path::new(input)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        matches!(
            ext.as_str(),
            "jpg" | "jpeg" | "png" | "bmp" | "gif" | "tiff" | "tif" | "webp" | "svg"
        )
    };
    let (pw, ph, ao) = if is_image {
        (page_w_pt, page_h_pt, auto_orient)
    } else {
        (None, None, None)
    };

    // <system_temp>/pdf-kozou/ 内に一時ファイルを作成
    // Tauri 側の kozou_temp_dir() と同じディレクトリで統一する
    let kozou_tmp_dir = std::env::temp_dir().join("pdf-kozou");
    let _ = std::fs::create_dir_all(&kozou_tmp_dir);

    let tmp = tempfile::Builder::new()
        .prefix("auto_convert_")
        .suffix(".pdf")
        .tempfile_in(&kozou_tmp_dir)
        .map_err(|e| anyhow::anyhow!("tempfile: {e}"))?;
    let tmp_path = tmp.path().to_string_lossy().to_string();

    eprintln!("[auto-convert] converting {input} → {tmp_path}");
    let req = ConvertRequest {
        input: input.to_string(),
        output: tmp_path.clone(),
        layout_w,
        layout_h,
        layout_em,
        page_w_pt: pw,
        page_h_pt: ph,
        auto_orient: ao,
    };
    convert_to_pdf(&req).map_err(|e| anyhow::anyhow!("convert failed: {e}"))?;

    Ok(Some((tmp, tmp_path)))
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
        // JSON から layout パラメータを取り出す共通ヘルパー
        // 各コマンドの JSON に layout_w/h/em が含まれていれば使用する
        #[derive(serde::Deserialize, Default)]
        struct LayoutParams {
            #[serde(default)]
            layout_w: Option<f32>,
            #[serde(default)]
            layout_h: Option<f32>,
            #[serde(default)]
            layout_em: Option<f32>,
            #[serde(default)]
            page_w_pt: Option<f32>,
            #[serde(default)]
            page_h_pt: Option<f32>,
            #[serde(default)]
            auto_orient: Option<bool>,
        }
        let lp: LayoutParams = serde_json::from_str(line).unwrap_or_default();
        let (lw, lh, lem) = (lp.layout_w, lp.layout_h, lp.layout_em);
        let (pw_pt, ph_pt) = (lp.page_w_pt, lp.page_h_pt);
        let auto_orient = lp.auto_orient;

        match tag.cmd.as_str() {
            "info" => {
                #[derive(serde::Deserialize)]
                struct Req {
                    path: String,
                    #[serde(default)]
                    fonts: bool,
                }
                let r: Req = serde_json::from_str(line)?;

                // 非 PDF は lw/lh/lem を考慮して一時 PDF に変換してから info 取得
                let _tmp = auto_convert_if_needed(&r.path, lw, lh, lem, None, None, None)?;
                let actual_path = if let Some((_, ref p)) = _tmp {
                    p.as_str()
                } else {
                    &r.path
                };

                let mut resp = if r.fonts {
                    pdf_kozou_core::info::info_with_fonts(actual_path)?
                } else {
                    pdf_kozou_core::info::info(actual_path)?
                };

                // 変換した場合は file_size を元ファイルのサイズに戻す
                if _tmp.is_some() {
                    resp.file_size = std::fs::metadata(&r.path).map(|m| m.len()).unwrap_or(0);
                }

                Ok(serde_json::to_string(&resp)?)
            }
            "render" => {
                let req: pdf_kozou_core::render::RenderRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&pdf_kozou_core::render::render(
                    &req,
                )?)?)
            }
            "trim" => {
                let mut req: pdf_kozou_core::trim::TrimRequest = serde_json::from_str(line)?;
                /* トリムは自然サイズで変換してから行う。ページサイズへのフィットは
                 * トリム後にフロント側で compose_imposition_pdf(1-up) で行う
                 * （マージンを自然サイズ基準のまま使えるようにするため）。 */
                let _tmp =
                    auto_convert_if_needed(&req.input.clone(), lw, lh, lem, None, None, None)?;
                if let Some((_, ref tmp_path)) = _tmp {
                    req.input = tmp_path.clone();
                }
                Ok(serde_json::to_string(&pdf_kozou_core::trim::trim(&req)?)?)
            }
            "compress" => {
                #[derive(serde::Deserialize)]
                struct Req {
                    #[serde(default)]
                    rewrite: bool,
                    #[serde(default)]
                    rewrite_options: Option<String>,
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
                    /// Type3 検出時のラスタライズ DPI（省略時 150）
                    #[serde(default)]
                    rasterize_dpi: Option<f32>,
                    /// Type3 検出時の JPEG 品質（省略時 85）
                    #[serde(default)]
                    rasterize_quality: Option<i32>,
                    #[serde(flatten)]
                    inner: pdf_kozou_core::compress::CompressRequest,
                }
                let mut r: Req = serde_json::from_str(line)?;
                let _tmp =
                    auto_convert_if_needed(&r.inner.input.clone(), lw, lh, lem, None, None, None)?;
                if let Some((_, ref tmp_path)) = _tmp {
                    r.inner.input = tmp_path.clone();
                }

                let resp = if r.rewrite {
                    let opts = r
                        .rewrite_options
                        .as_deref()
                        .unwrap_or(pdf_kozou_core::compress::REWRITE_OPTIONS_DEFAULT);
                    let fallback = {
                        use pdf_kozou_core::compress::{
                            RewriteFallbackParams, parse_rewrite_opt_bool, parse_rewrite_opt_i32,
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
                            rasterize_dpi: r.rasterize_dpi,
                            rasterize_quality: r.rasterize_quality,
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
                let mut req: pdf_kozou_core::split::SplitRequest = serde_json::from_str(line)?;
                let _tmp =
                    auto_convert_if_needed(&req.input.clone(), lw, lh, lem, None, None, None)?;
                if let Some((_, ref tmp_path)) = _tmp {
                    req.input = tmp_path.clone();
                }
                Ok(serde_json::to_string(&pdf_kozou_core::split::split(&req)?)?)
            }
            "merge" => {
                // merge は複数入力。各ファイルをチェックして非 PDF を変換する
                let mut req: pdf_kozou_core::merge::MergeRequest = serde_json::from_str(line)?;
                let mut tmps: Vec<(tempfile::NamedTempFile, String)> = Vec::new();
                for input in req.inputs.iter_mut() {
                    if let Some(converted) =
                        auto_convert_if_needed(input, lw, lh, lem, pw_pt, ph_pt, auto_orient)?
                    {
                        *input = converted.1.clone();
                        tmps.push(converted);
                    }
                }
                let res = pdf_kozou_core::merge::merge(&req)?;
                drop(tmps); // 一時ファイルを削除
                Ok(serde_json::to_string(&res)?)
            }
            "rotate" => {
                let mut req: pdf_kozou_core::rotate::RotateRequest = serde_json::from_str(line)?;
                let _tmp = auto_convert_if_needed(
                    &req.input.clone(),
                    lw,
                    lh,
                    lem,
                    pw_pt,
                    ph_pt,
                    auto_orient,
                )?;
                if let Some((_, ref tmp_path)) = _tmp {
                    req.input = tmp_path.clone();
                }
                Ok(serde_json::to_string(&pdf_kozou_core::rotate::rotate(
                    &req,
                )?)?)
            }
            "sanitize_hidden" => {
                let req: pdf_kozou_core::stext::SanitizeRequest = serde_json::from_str(line)?;
                // スタックサイズを 32MB に増やして実行（Windows デフォルト 1MB では不足）
                let result = std::thread::Builder::new()
                    .stack_size(32 * 1024 * 1024)
                    .spawn(move || pdf_kozou_core::stext::sanitize_hidden_text(&req))
                    .map_err(|e| anyhow::anyhow!("thread spawn: {e}"))?
                    .join()
                    .map_err(|_| anyhow::anyhow!("thread panicked"))??;
                Ok(serde_json::to_string(&result)?)
            }

            "render_imposition" => {
                let req: pdf_kozou_core::stext::RenderImpositionRequest =
                    serde_json::from_str(line)?;
                Ok(serde_json::to_string(
                    &pdf_kozou_core::stext::render_imposition(&req)?,
                )?)
            }

            "rasterize_imposition" => {
                let mut req: pdf_kozou_core::stext::RasterizeImpositionRequest =
                    serde_json::from_str(line)?;
                let _tmp =
                    auto_convert_if_needed(&req.input.clone(), lw, lh, lem, None, None, None)?;
                if let Some((_, ref tmp_path)) = _tmp {
                    req.input = tmp_path.clone();
                }
                Ok(serde_json::to_string(
                    &pdf_kozou_core::stext::rasterize_imposition(&req)?,
                )?)
            }

            "split_imposition_pdf" => {
                let mut req: pdf_kozou_core::stext::SplitImpositionPdfRequest =
                    serde_json::from_str(line)?;
                let _tmp =
                    auto_convert_if_needed(&req.input.clone(), lw, lh, lem, None, None, None)?;
                if let Some((_, ref tmp_path)) = _tmp {
                    req.input = tmp_path.clone();
                }
                Ok(serde_json::to_string(
                    &pdf_kozou_core::stext::split_imposition_pdf(&req)?,
                )?)
            }

            "compose_imposition_pdf" => {
                let mut req: pdf_kozou_core::stext::ComposeImpositionPdfRequest =
                    serde_json::from_str(line)?;
                let _tmp =
                    auto_convert_if_needed(&req.input.clone(), lw, lh, lem, None, None, None)?;
                if let Some((_, ref tmp_path)) = _tmp {
                    req.input = tmp_path.clone();
                }
                Ok(serde_json::to_string(
                    &pdf_kozou_core::stext::compose_imposition_pdf(&req)?,
                )?)
            }

            "split_cell_render" => {
                let mut req: pdf_kozou_core::stext::SplitCellRenderRequest =
                    serde_json::from_str(line)?;
                let _tmp =
                    auto_convert_if_needed(&req.input.clone(), lw, lh, lem, None, None, None)?;
                if let Some((_, ref tmp_path)) = _tmp {
                    req.input = tmp_path.clone();
                }
                Ok(serde_json::to_string(
                    &pdf_kozou_core::stext::split_cell_render(&req)?,
                )?)
            }

            "detect_control_chars" => {
                let req: pdf_kozou_core::stext::DetectControlCharsRequest =
                    serde_json::from_str(line)?;
                Ok(serde_json::to_string(
                    &pdf_kozou_core::stext::detect_control_chars(&req)?,
                )?)
            }

            "detect_buried" => {
                let req: pdf_kozou_core::stext::DetectBuriedRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(
                    &pdf_kozou_core::stext::detect_buried_text(&req)?,
                )?)
            }

            "detect_tiny" => {
                let req: pdf_kozou_core::stext::DetectTinyRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(
                    &pdf_kozou_core::stext::detect_tiny_text(&req)?,
                )?)
            }

            "detect_low_contrast" => {
                let req: pdf_kozou_core::stext::DetectLowContrastRequest =
                    serde_json::from_str(line)?;
                Ok(serde_json::to_string(
                    &pdf_kozou_core::stext::detect_low_contrast_text(&req)?,
                )?)
            }

            "detect_transparent" => {
                let req: pdf_kozou_core::stext::DetectTransparentRequest =
                    serde_json::from_str(line)?;
                Ok(serde_json::to_string(
                    &pdf_kozou_core::stext::detect_transparent_text(&req)?,
                )?)
            }

            "page_text" => {
                let req: pdf_kozou_core::stext::PageTextRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(
                    &pdf_kozou_core::stext::get_page_text(&req)?,
                )?)
            }
            "search" => {
                let req: pdf_kozou_core::stext::SearchRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&pdf_kozou_core::stext::search_page(
                    &req,
                )?)?)
            }
            "page_links" => {
                let req: pdf_kozou_core::stext::PageLinksRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(
                    &pdf_kozou_core::stext::get_page_links(&req)?,
                )?)
            }
            "convert" => {
                let req: pdf_kozou_core::convert::ConvertRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(
                    &pdf_kozou_core::convert::convert_to_pdf(&req)?,
                )?)
            }
            "rasterize" => {
                #[derive(serde::Deserialize)]
                struct Req {
                    input: String,
                    output: String,
                    #[serde(default)]
                    dpi: Option<f32>,
                    #[serde(default)]
                    quality: Option<i32>,
                    /// true=PNG埋め込み（可逆）, false/省略=JPEG埋め込み
                    #[serde(default)]
                    use_png: Option<bool>,
                    /// "1-3,5" 形式の1ベースページ指定。省略時は全ページ。
                    #[serde(default)]
                    pages: Option<String>,
                }
                let mut r: Req = serde_json::from_str(line)?;
                let _tmp = auto_convert_if_needed(&r.input.clone(), lw, lh, lem, None, None, None)?;
                if let Some((_, ref tmp_path)) = _tmp {
                    r.input = tmp_path.clone();
                }
                let pages = r.pages.as_deref().map(parse_page_list).transpose()?;
                Ok(serde_json::to_string(
                    &pdf_kozou_core::compress::rasterize_with_quality(
                        &r.input,
                        &r.output,
                        r.dpi.unwrap_or(150.0),
                        r.quality.unwrap_or(85),
                        r.use_png.unwrap_or(false),
                        pages.as_deref(),
                    )?,
                )?)
            }
            "is_pdf" => {
                #[derive(serde::Deserialize)]
                struct Req {
                    path: String,
                }
                let r: Req = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&serde_json::json!({
                    "ok": true,
                    "result": pdf_kozou_core::convert::is_pdf(&r.path)
                }))?)
            }
            "is_mupdf_supported" => {
                #[derive(serde::Deserialize)]
                struct Req {
                    path: String,
                }
                let r: Req = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&serde_json::json!({
                    "ok": true,
                    "result": pdf_kozou_core::convert::is_mupdf_supported(&r.path)
                }))?)
            }
            "set_metadata" => {
                #[derive(serde::Deserialize)]
                struct MetaField {
                    key: String,
                    value: String,
                }
                #[derive(serde::Deserialize)]
                struct Req {
                    path: String,
                    metadata: Vec<MetaField>,
                }
                //eprintln!("set_metadata");
                let r: Req = serde_json::from_str(line)?;
                let pairs: Vec<(String, String)> =
                    r.metadata.into_iter().map(|f| (f.key, f.value)).collect();
                pdf_kozou_core::compress::set_metadata(&r.path, &pairs)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                Ok(serde_json::to_string(&serde_json::json!({ "ok": true }))?)
            }
            "get_image_metadata" => {
                #[derive(serde::Deserialize)]
                struct Req {
                    path: String,
                }
                let r: Req = serde_json::from_str(line)?;
                let pairs = pdf_kozou_core::render::read_image_metadata(&r.path);
                let metadata: Vec<serde_json::Value> = pairs
                    .into_iter()
                    .map(|(k, v)| serde_json::json!({ "key": k, "value": v }))
                    .collect();
                Ok(serde_json::to_string(
                    &serde_json::json!({ "metadata": metadata }),
                )?)
            }
            "set_image_metadata" => {
                #[derive(serde::Deserialize)]
                struct MetaField {
                    key: String,
                    value: String,
                }
                #[derive(serde::Deserialize)]
                struct Req {
                    path: String,
                    metadata: Vec<MetaField>,
                    /// true の場合: 指定しなかったフィールドは既存値を保持（マージ）
                    /// false/省略: 渡したフィールドのみ書き込む（GUI のデフォルト動作）
                    #[serde(default)]
                    merge: bool,
                }
                let r: Req = serde_json::from_str(line)?;
                let mut pairs: Vec<(String, String)> =
                    r.metadata.into_iter().map(|f| (f.key, f.value)).collect();
                if r.merge {
                    // 既存メタデータを読み込んで new_fields でマージ
                    let existing = pdf_kozou_core::render::read_image_metadata(&r.path);
                    let mut merged = existing;
                    for (new_key, new_val) in &pairs {
                        if new_val.trim().is_empty() {
                            merged.retain(|(k, _)| k != new_key);
                        } else if let Some(entry) = merged.iter_mut().find(|(k, _)| k == new_key) {
                            entry.1 = new_val.clone();
                        } else {
                            merged.push((new_key.clone(), new_val.clone()));
                        }
                    }
                    pairs = merged;
                }
                pdf_kozou_core::render::write_image_metadata(&r.path, &pairs)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                Ok(serde_json::to_string(&serde_json::json!({ "ok": true }))?)
            }
            "sanitize_type3" => {
                let req: pdf_kozou_core::stext::SanitizeType3Request = serde_json::from_str(line)?;
                let resp = pdf_kozou_core::stext::sanitize_type3_text(&req)?;
                Ok(serde_json::to_string(&resp)?)
            }
            "embed_image_metadata" => {
                #[derive(serde::Deserialize)]
                struct Req {
                    image_path: String,
                    source_path: String,
                    #[serde(default)]
                    format: Option<String>,
                }
                let r: Req = serde_json::from_str(line)?;
                let metadata = pdf_kozou_core::compress::collect_metadata(&r.source_path);
                if !metadata.is_empty() {
                    // 画像ファイルを読み込んでメタデータを埋め込んで上書き
                    let img_bytes = std::fs::read(&r.image_path)
                        .map_err(|e| anyhow::anyhow!("read image: {e}"))?;
                    let fmt = r.format.as_deref().unwrap_or("jpeg");
                    let out_bytes = if fmt == "png" {
                        pdf_kozou_core::render::embed_metadata_png(img_bytes, &metadata)
                    } else {
                        pdf_kozou_core::render::embed_metadata_jpeg(img_bytes, &metadata)
                    };
                    std::fs::write(&r.image_path, &out_bytes)
                        .map_err(|e| anyhow::anyhow!("write image: {e}"))?;
                }
                Ok(serde_json::to_string(&serde_json::json!({ "ok": true }))?)
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
    _total: u32,
    start_number: Option<u32>,
    name_prefix: Option<&str>,
    out_dir: &str,
    format: &str,
    quality: u8,
    dpi: u32,
    ext: &str,
    layout_w: Option<f32>,
    layout_h: Option<f32>,
    layout_em: Option<f32>,
) -> anyhow::Result<()> {
    let (base, start_num) = resolve_name_prefix_and_start(
        name_prefix,
        start_number,
        path,
        indices.len() as u32, // ← 重要：今回の出力ページ数を使う
    );
    let mut file_list = Vec::new();

    let output_count = indices.len() as u32;
    let max_num = start_num + output_count.saturating_sub(1);
    let width = digit_width(max_num);

    for (seq, &page_index) in indices.iter().enumerate() {
        let num = start_num + seq as u32;
        let out_path = format!(
            "{}/{}{:0>width$}.{}",
            out_dir.trim_end_matches('/'),
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
            layout_w,
            layout_h,
            layout_em,
        };

        let resp = pdf_kozou_core::render::render(&req)?;

        file_list.push(serde_json::json!({
            "page":     page_index + 1,
            "file":     out_path,           // JSONにも同じパスを入れる
            "width_px": resp.width_px,
            "height_px": resp.height_px,
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
    layout_w: Option<f32>,
    layout_h: Option<f32>,
    layout_em: Option<f32>,
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
            layout_w,
            layout_h,
            layout_em,
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
