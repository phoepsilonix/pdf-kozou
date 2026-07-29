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
use pdf_kozou_core::api::auto_convert_if_needed;
use pdf_kozou_core::api::parse_page_list;
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
        /// CropBox 外を apply_redactions で物理的に削除しない
        /// (デフォルトでは CropBox が設定されたページの外側を自動的に消去する)
        #[arg(long)]
        no_redact_outside_crop: bool,
        /// CropBox 外側に持たせる余白 (pt、上下左右共通。デフォルト 100)
        #[arg(long)]
        redact_margin_pt: Option<f32>,
        /// 上方向の余白 (pt) を個別指定する場合 (未指定時は --redact-margin-pt を使用)
        #[arg(long)]
        redact_margin_top: Option<f32>,
        /// 下方向の余白 (pt) を個別指定する場合 (未指定時は --redact-margin-pt を使用)
        #[arg(long)]
        redact_margin_bottom: Option<f32>,
        /// 左方向の余白 (pt) を個別指定する場合 (未指定時は --redact-margin-pt を使用)
        #[arg(long)]
        redact_margin_left: Option<f32>,
        /// 右方向の余白 (pt) を個別指定する場合 (未指定時は --redact-margin-pt を使用)
        #[arg(long)]
        redact_margin_right: Option<f32>,
        /// 埋め込み画像を指定 DPI にダウンサンプルして再圧縮する
        /// (--no-compress-images とは独立して動作する。未指定ならダウンサンプルしない)
        #[arg(long)]
        image_dpi: Option<f32>,
        /// image_dpi 指定時の JPEG 品質 (1-100、デフォルト 85)
        #[arg(long)]
        image_jpeg_quality: Option<u8>,
        /// 埋め込み画像のうち、ページ上で実際に見えている範囲だけを残して
        /// ピクセルデータを切り詰める (image_dpi と併用可、単独でも動作する)
        #[arg(long)]
        crop_to_visible_image_area: bool,
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

    /// [Stage 1 検証用] テキスト(Type3含む)を除外した背景画像のみを生成する。
    ///
    /// 画像PDF化(フォント保持版)機能の開発中コマンド。
    /// Rasterize と違い、出力にはテキストが一切含まれない
    /// (元のテキストとの合成はまだ実装されていない)。
    /// 非テキスト要素だけが正しく1枚の画像に焼き込まれているかの
    /// 目視確認に使う。
    RasterizeNoText {
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

    /// [Stage 2] 画像PDF化(フォント保持版)。
    ///
    /// 非テキスト要素(画像・イラスト・ベクター図形)を1枚の背景画像に
    /// 焼き込みつつ、前面に見えているテキスト(Type3含む)は元の
    /// フォントオブジェクトを無変更のままベクターで残す。
    ///
    /// 既知の制限: Form XObject内部の描画命令(テキスト含む)は
    /// 対象外。/Rotate!=0のページは通常の全面ラスタライズに
    /// 自動フォールバックする。
    ComposeImagePdfKeepText {
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
        /// PNG 埋め込みで背景画像を生成（可逆・無劣化）
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
                Some(s) => PageSpec::Indices(pdf_kozou_core::api::parse_string_pages(s)?),
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
            no_redact_outside_crop,
            redact_margin_pt,
            redact_margin_top,
            redact_margin_bottom,
            redact_margin_left,
            redact_margin_right,
            image_dpi,
            image_jpeg_quality,
            crop_to_visible_image_area,
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
                    redact_outside_crop: Some(!no_redact_outside_crop),
                    redact_margin_pt,
                    redact_margin_top,
                    redact_margin_bottom,
                    redact_margin_left,
                    redact_margin_right,
                    image_dpi,
                    image_jpeg_quality,
                    crop_to_visible_image_area: if crop_to_visible_image_area {
                        Some(true)
                    } else {
                        None
                    },
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

        Commands::RasterizeNoText {
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
            let resp = pdf_kozou_core::compress::rasterize_no_text_with_quality(
                &input,
                &output,
                dpi,
                quality,
                png,
                pages.as_deref(),
            )?;
            println!("{}", serde_json::to_string(&resp)?);
        }

        Commands::ComposeImagePdfKeepText {
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
            let resp = pdf_kozou_core::compress::compose_image_pdf_keep_text_with_quality(
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
            if let Some(a) = angle
                && (a % 90 != 0 || a > 270)
            {
                anyhow::bail!("angle must be 0, 90, 180, or 270");
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
        let response = pdf_kozou_core::api::dispatch_json(&line);
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

// ── パース補助 ────────────────────────────────────────────────────────────────
// auto_convert_if_needed / dispatch_json / err_json / parse_page_list は
// pdf_kozou_core::api モジュールへ移動した（Android/iOS から直接リンクして
// 呼び出すため）。CLI からは pdf_kozou_core::api::dispatch_json を呼ぶだけ。

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
    let pages = pdf_kozou_core::api::parse_page_list(s)?;
    Ok(pdf_kozou_core::trim::PageSelection::Range { pages })
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
// ── render ヘルパー ───────────────────────────────────────────────────────────
// resolve_name_prefix_and_start / digit_width / render_to_dir は
// pdf_kozou_core::api へ移動した(export_images から直接リンクして
// 呼び出すため)。

/// --page の解釈結果
enum PageSpec {
    Omitted,
    All,
    Indices(Vec<i32>),
}

/// "1", "1-3", "1,3,5", "1-3,5,7" → 0始まりインデックスの Vec
/// 指定ページをファイルに書き出す (--out-dir あり共通処理)
/// pdf_kozou_core::api::render_to_dir を呼び、CLI では結果を stdout に出力する
#[allow(clippy::too_many_arguments)]
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
    layout_w: Option<f32>,
    layout_h: Option<f32>,
    layout_em: Option<f32>,
) -> anyhow::Result<()> {
    let resp = pdf_kozou_core::api::render_to_dir(
        path,
        indices,
        total,
        start_number,
        name_prefix,
        out_dir,
        format,
        quality,
        dpi,
        ext,
        layout_w,
        layout_h,
        layout_em,
    )?;
    println!("{}", serde_json::to_string(&resp)?);
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
