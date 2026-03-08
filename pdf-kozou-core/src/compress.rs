// pdf-kozou-core/src/compress.rs
// MuPDF による PDF 圧縮・最適化
//
// フォント保護ポリシー:
//   PDFの最大の利点である埋め込みフォント（アウトラインデータ）を守ることを最優先とする。
//   - set_compress_fonts: フォントストリームを圧縮するだけで削除・変換しない → 安全
//   - set_garbage_level:  デフォルトは 2 (未参照オブジェクト削除+重複統合)
//                         3以上はフォントサブセットの統合も対象になるため注意
//   - set_clean:          コンテンツストリームを再構築する → デフォルト off
//   - set_sanitize:       ストリームを再解釈・再構築する → デフォルト off
//                         CIDフォント・Type3・サブセットフォントへの影響リスクあり
//
// 圧縮方式の選択:
//   compress()  — PdfWriteOptions ベース。安全・高速。Type3/CIDフォント完全対応。
//   rewrite()   — DocumentWriter + page.run() による再描画。TrueType のみ対応。
//                 Type3/Type1/CIDフontを検出したら rewrite_safe_fallback() へ移行。
//   font_subset_and_write() — mupdf-sys FFI で pdf_subset_fonts() を呼び出す高圧縮。
//                             Type3 を含まないフォントのサブセット化に特化。
//                             rewrite() の「TrueType のみ」制限を突破できる。
//
// フォールバック設計:
//   rewrite() がフォールバックする際は RewriteFallbackParams を使い、
//   CLI の --gc / --clean / --sanitize / --no-compress-* をそのまま引き継ぐ。
//   旧実装のように rewrite_options 文字列をパースし直す方式は廃止した。

use serde::{Deserialize, Serialize};
use crate::error::{CoreError, Result};

/// 圧縮レベルのプリセット
#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CompressPreset {
    /// 軽め: gc=1, 画像圧縮なし — サイズ削減小、フォント完全保護
    Light,
    /// 標準 (デフォルト): gc=2, 画像圧縮あり — バランス重視、フォント安全
    Standard,
    /// 強め: gc=3, sanitize=true — サイズ削減大。⚠️ 埋め込みフォントに影響する場合あり
    Aggressive,
    /// 最大: gc=4, sanitize=true — 最大圧縮。⚠️ 埋め込みフォントに影響する場合あり
    Maximum,
}

impl CompressPreset {
    fn to_params(&self) -> (bool, i32, bool, bool) {
        // (compress_images, garbage_level, clean, sanitize)
        // ⚠️ gc=2 + clean=true はレイアウト崩れの実績あり → clean はデフォルト false
        // gc=3/4 は sanitize 必須（なしだとレイアウト崩れが起きる）
        match self {
            Self::Light      => (false, 1, false, false),
            Self::Standard   => (true,  2, false, false),
            Self::Aggressive => (true,  3, true,  true),
            Self::Maximum    => (true,  4, true,  true),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CompressRequest {
    pub input:  String,
    pub output: String,

    /// 圧縮プリセット。指定時は個別パラメータより優先される
    #[serde(default)]
    pub preset: Option<CompressPreset>,

    /// 画像を再圧縮するか (default: true)
    #[serde(default)]
    pub compress_images: Option<bool>,
    /// フォントストリームを圧縮するか (default: true, フォントデータは削除しない)
    #[serde(default)]
    pub compress_fonts:  Option<bool>,
    /// ガベージコレクションレベル 0-4 (default: 2)
    #[serde(default)]
    pub garbage_level:   Option<i32>,
    /// コンテンツストリームを再構築するか (default: false)
    #[serde(default)]
    pub clean:           Option<bool>,
    /// ストリームを再解釈・再構築するか (default: false)
    /// ⚠️ CIDフォント・Type3・サブセットフォントへの影響リスクあり
    #[serde(default)]
    pub sanitize:        Option<bool>,

    /// 線形化は mupdf 0.6 で廃止済み — 互換のため残すが無視する
    #[serde(default)]
    pub linearize: Option<bool>,
}

#[derive(Serialize)]
pub struct CompressResponse {
    pub ok:           bool,
    pub input_bytes:  u64,
    pub output_bytes: u64,
    /// 圧縮率 (0.0-1.0, 小さいほど圧縮効果大)
    pub ratio:        f64,
    /// 実際に使用したパラメータ (デバッグ・UI表示用)
    pub params_used:  CompressParamsUsed,
    /// 警告メッセージ (Type3フォールバック等)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Serialize)]
pub struct CompressParamsUsed {
    pub compress_images: bool,
    pub compress_fonts:  bool,
    pub garbage_level:   i32,
    pub clean:           bool,
    pub sanitize:        bool,
    /// rewrite が要求されたが Type3 フォントのためフォールバックしたか
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub rewrite_fallback: bool,
}

pub fn compress(req: &CompressRequest) -> Result<CompressResponse> {
    use mupdf::pdf::PdfDocument;

    let (preset_images, preset_gc, preset_clean, preset_sanitize) = req.preset
        .as_ref()
        .map(|p| p.to_params())
        .unwrap_or_else(|| CompressPreset::Standard.to_params());

    let compress_images = req.compress_images.unwrap_or(preset_images);
    let compress_fonts  = req.compress_fonts .unwrap_or(true);
    let garbage_level   = req.garbage_level  .unwrap_or(preset_gc);
    // gc >= 3 では sanitize/clean が必須（なしだとレイアウト崩れが起きる）
    let clean    = req.clean   .unwrap_or(if garbage_level >= 3 { true } else { preset_clean });
    let sanitize = req.sanitize.unwrap_or(if garbage_level >= 3 { true } else { preset_sanitize });

    let doc = PdfDocument::open(&req.input)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let mut opts = mupdf::pdf::PdfWriteOptions::default();
    opts.set_compress(true)
        .set_decompress(false)
        .set_compress_images(compress_images)
        .set_compress_fonts(compress_fonts)
        .set_garbage_level(garbage_level)
        .set_clean(clean)
        .set_sanitize(sanitize);

    doc.save_with_options(&req.output, opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let input_bytes  = std::fs::metadata(&req.input) .map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);
    let ratio = if input_bytes > 0 {
        output_bytes as f64 / input_bytes as f64
    } else {
        1.0
    };

    Ok(CompressResponse {
        ok: true,
        input_bytes,
        output_bytes,
        ratio,
        params_used: CompressParamsUsed {
            compress_images,
            compress_fonts,
            garbage_level,
            clean,
            sanitize,
            rewrite_fallback: false,
        },
        warning: size_increased_warning(input_bytes, output_bytes),
    })
}

/// rewrite フォールバック時に通常圧縮へ引き継ぐパラメータ。
///
/// `rewrite_options` (MuPDF option文字列) とは独立して、
/// CLI の --gc / --clean / --sanitize / --no-compress-images / --no-compress-fonts
/// を直接受け取る。これにより「rewriteが失敗しても同じCLI引数で圧縮できる」設計になる。
#[derive(Debug, Default)]
pub struct RewriteFallbackParams {
    /// --gc N  (None = フォールバックデフォルト 2)
    pub garbage_level:   Option<i32>,
    /// --clean
    pub clean:           bool,
    /// --sanitize
    pub sanitize:        bool,
    /// --no-compress-images → false
    pub compress_images: Option<bool>,
    /// --no-compress-fonts → false
    pub compress_fonts:  Option<bool>,
}

/// DocumentWriter を使った PDF 再書き出し（ベクター保持・高圧縮）
///
/// # 処理の優先順位
///
/// 1. **TrueType のみ含む PDF** — DocumentWriter + page.run() で再描画。
///    最高品質のベクター保持と高圧縮を実現。
///
/// 2. **Type1 / CIDFontType0/2 / Type0 を含む PDF（Type3 を除く）** —
///    `font_subset::subset_and_write()` (mupdf-sys FFI) で処理。
///    pdf_subset_fonts() + pdf_write_document() でフォントを縮小しつつ安全に書き出す。
///    DocumentWriter の「TrueType しか通せない」制限を回避できる。
///
/// 3. **Type3 フォントを含む PDF** — `rewrite_safe_fallback()` で通常圧縮。
///    Type3 グリフは MuPDF の pdf_subset_fonts() も扱えないため、
///    ユーザー指定の gc / sanitize / clean でそのまま処理する。
///
/// `options` は DocumentWriter に渡す MuPDF オプション文字列（パス 1 のみ使用）。
/// `fallback` はパス 2/3 でフォールバックする際の CLI 由来パラメータ。
pub fn rewrite(
    input:    &str,
    output:   &str,
    options:  &str,
    fallback: &RewriteFallbackParams,
) -> Result<CompressResponse> {
    use mupdf::DocumentWriter;

    // フォント種別を分析
    let unsafe_fonts = detect_rewrite_unsafe_fonts(input);

    match unsafe_fonts {
        None => {
            // パス 1: TrueType のみ — DocumentWriter + page.run() で再描画
            let doc = mupdf::Document::open(input)
                .map_err(|e| CoreError::MuPdf(e.to_string()))?;

            let page_count = doc.page_count()
                .map_err(|e| CoreError::MuPdf(e.to_string()))?;

            let mut writer = DocumentWriter::new(output, "pdf", options)
                .map_err(|e| CoreError::MuPdf(e.to_string()))?;

            let identity = mupdf::Matrix::IDENTITY;

            for i in 0..page_count {
                let page = doc.load_page(i)
                    .map_err(|e| CoreError::MuPdf(e.to_string()))?;
                let bounds = page.bounds()
                    .map_err(|e| CoreError::MuPdf(e.to_string()))?;
                let pdf_device = writer.begin_page(bounds)
                    .map_err(|e| CoreError::MuPdf(e.to_string()))?;
                page.run(&pdf_device, &identity)
                    .map_err(|e| CoreError::MuPdf(e.to_string()))?;
                writer.end_page(pdf_device)
                    .map_err(|e| CoreError::MuPdf(e.to_string()))?;
            }

            drop(writer);

            let input_bytes  = std::fs::metadata(input) .map(|m| m.len()).unwrap_or(0);
            let output_bytes = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
            let ratio = if input_bytes > 0 {
                output_bytes as f64 / input_bytes as f64
            } else {
                1.0
            };

            let gc       = parse_rewrite_opt_i32(options, "garbage").unwrap_or(2);
            let clean    = parse_rewrite_opt_bool(options, "clean").unwrap_or(false);
            let sanitize = parse_rewrite_opt_bool(options, "sanitize").unwrap_or(false);
            let ci       = parse_rewrite_opt_bool(options, "compress-images").unwrap_or(true);
            let cf       = parse_rewrite_opt_bool(options, "compress-fonts").unwrap_or(true);

            Ok(CompressResponse {
                ok: true,
                input_bytes,
                output_bytes,
                ratio,
                params_used: CompressParamsUsed {
                    compress_images: ci,
                    compress_fonts:  cf,
                    garbage_level:   gc,
                    clean,
                    sanitize,
                    rewrite_fallback: false,
                },
                warning: size_increased_warning(input_bytes, output_bytes),
            })
        }

        Some(reason) if !reason.contains("Type3") => {
            // パス 2: Type1 / CIDFont / Type0 を含むが Type3 はない
            // → mupdf-sys FFI の pdf_subset_fonts() + pdf_write_document() で処理
            eprintln!("[rewrite] non-TrueType font ({reason}) — using font_subset FFI path");

            let gc       = fallback.garbage_level  .unwrap_or(2);
            let clean    = fallback.clean;
            let sanitize = fallback.sanitize;
            let ci       = fallback.compress_images.unwrap_or(true);
            let cf       = fallback.compress_fonts .unwrap_or(true);

            let result = crate::font_subset::subset_and_write(
                input, output, gc, clean, sanitize, ci, cf,
            )?;

            let ratio = if result.input_bytes > 0 {
                result.output_bytes as f64 / result.input_bytes as f64
            } else {
                1.0
            };

            let mut warning_parts: Vec<String> = vec![
                format!("{reason} のため、pdf_subset_fonts パスを使用しました。"),
            ];
            if result.fell_back {
                warning_parts.push(format!(
                    "gc={} に制限しました（指定値={gc}）。",
                    result.effective_gc,
                ));
            }
            if let Some(s) = size_increased_warning(result.input_bytes, result.output_bytes) {
                warning_parts.push(s);
            }

            Ok(CompressResponse {
                ok: true,
                input_bytes:  result.input_bytes,
                output_bytes: result.output_bytes,
                ratio,
                params_used: CompressParamsUsed {
                    compress_images: ci,
                    compress_fonts:  cf,
                    garbage_level:   result.effective_gc,
                    clean:           result.effective_clean,
                    sanitize:        result.effective_sanitize,
                    rewrite_fallback: result.fell_back,
                },
                warning: Some(warning_parts.join(" ")),
            })
        }

        Some(reason) => {
            // パス 3: Type3 フォントを含む — 通常圧縮（ユーザー指定パラメータをそのまま使用）
            eprintln!("[rewrite] Type3 font detected ({reason}) — falling back to safe compress");
            rewrite_safe_fallback(input, output, Some(reason), fallback)
        }
    }
}

/// フォールバック圧縮: CLI引数 (RewriteFallbackParams) を直接使って通常圧縮する。
///
/// `rewrite_options` 文字列に頼らないため、CLIの --gc / --clean / --sanitize 等が
/// 確実に反映される。gc の強制制限は行わず、ユーザー指定を尊重する（警告を付加）。
fn rewrite_safe_fallback(
    input:    &str,
    output:   &str,
    reason:   Option<String>,
    p:        &RewriteFallbackParams,
) -> Result<CompressResponse> {
    use mupdf::pdf::PdfDocument;

    // フォールバックデフォルト: gc=2, clean=false, sanitize=false
    // ユーザーが明示的に指定した値はすべて尊重する
    let gc       = p.garbage_level  .unwrap_or(2);
    let clean    = p.clean;
    let sanitize = p.sanitize;
    let ci       = p.compress_images.unwrap_or(true);
    let cf       = p.compress_fonts .unwrap_or(true);

    // gc >= 3 かつ Type1/Type3 フォント含有時は追加警告を付加するが処理は続行する
    let gc_warning = if gc >= 3 {
        Some("gc=3以上はフォントサブセット統合が発生する可能性があります。".to_string())
    } else {
        None
    };

    let doc = PdfDocument::open(input)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let mut opts = mupdf::pdf::PdfWriteOptions::default();
    opts.set_compress(true)
        .set_compress_images(ci)
        .set_compress_fonts(cf)
        .set_garbage_level(gc)
        .set_clean(clean)
        .set_sanitize(sanitize);

    doc.save_with_options(output, opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let input_bytes  = std::fs::metadata(input) .map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
    let ratio = if input_bytes > 0 {
        output_bytes as f64 / input_bytes as f64
    } else {
        1.0
    };

    let warning = {
        let mut parts: Vec<String> = Vec::new();
        if let Some(r) = reason.as_deref() {
            parts.push(format!("{r} のため、通常圧縮を使用します。"));
        } else {
            parts.push("通常圧縮を使用します。".to_string());
        }
        if let Some(w) = gc_warning {
            parts.push(w);
        }
        if output_bytes > input_bytes {
            parts.push(format!(
                "ファイルサイズが元より大きくなりました（{input_bytes} → {output_bytes} バイト）。\
                 元のファイルの使用を推奨します。"
            ));
        }
        Some(parts.join(" "))
    };

    Ok(CompressResponse {
        ok: true,
        input_bytes,
        output_bytes,
        ratio,
        params_used: CompressParamsUsed {
            compress_images: ci,
            compress_fonts:  cf,
            garbage_level:   gc,
            clean,
            sanitize,
            rewrite_fallback: true,
        },
        warning,
    })
}

/// PDF を全ページラスタライズして画像 PDF に変換
///
/// ⚠️ この操作はページ全体を画像化します:
///   - テキスト選択・検索が失われます
///   - コピー&ペーストができなくなります
///   - ベクター図形・フォントがすべてビットマップになります
///
/// Type3 フォントを含む PDF でも処理できますが、上記の制限があります。
/// 通常の圧縮が目的であれば compress または rewrite を使用してください。
pub fn rasterize(input: &str, output: &str, dpi: f32) -> Result<CompressResponse> {
    use mupdf::{DocumentWriter, Colorspace, Matrix};

    let doc = mupdf::Document::open(input)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let page_count = doc.page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    // 出力は pdf デバイスで画像を埋め込む
    let opts = "compress=yes,compress-images=yes";
    let mut writer = DocumentWriter::new(output, "pdf", opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let scale = Matrix::new_scale(dpi / 72.0, dpi / 72.0);

    for i in 0..page_count {
        let page = doc.load_page(i)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        let bounds = page.bounds()
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        // ページをラスタライズ
        let pixmap = page.to_pixmap(&scale, &Colorspace::device_rgb(), false, true)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        let pdf_device = writer.begin_page(bounds)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        // 元のページサイズに合わせて画像を配置
        let img_ctm = Matrix::new_scale(
            bounds.width()  / pixmap.width()  as f32,
            bounds.height() / pixmap.height() as f32,
        );
        let image = mupdf::Image::from_pixmap(&pixmap)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        pdf_device.fill_image(&image, &img_ctm, 1.0, mupdf::ColorParams::default())
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        writer.end_page(pdf_device)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    }

    drop(writer);

    let input_bytes  = std::fs::metadata(input) .map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
    let ratio = if input_bytes > 0 {
        output_bytes as f64 / input_bytes as f64
    } else {
        1.0
    };

    Ok(CompressResponse {
        ok: true,
        input_bytes,
        output_bytes,
        ratio,
        params_used: CompressParamsUsed {
            compress_images: true,
            compress_fonts:  false,
            garbage_level:   0,
            clean:           false,
            sanitize:        false,
            rewrite_fallback: false,
        },
        warning: Some(format!(
            "ラスタライズモード: 全ページを {dpi}dpi の画像 PDF に変換しました。\
             テキスト選択・検索・コピーはできません。"
        )),
    })
}

/// ファイルサイズが増加した場合の警告メッセージを返す
fn size_increased_warning(input_bytes: u64, output_bytes: u64) -> Option<String> {
    if output_bytes > input_bytes {
        Some(format!(
            "ファイルサイズが元より大きくなりました（{} → {} バイト）。             元のファイルの使用を推奨します。",
            input_bytes, output_bytes
        ))
    } else {
        None
    }
}

/// rewrite が安全に処理できないフォントを検出して理由を返す
///
/// DocumentWriter + page.run() で安全に再描画できるのは TrueType サブセットのみ。
/// それ以外（Type1, Type3, CIDFontType0/2, Type0）が含まれていたらフォールバック。
fn detect_rewrite_unsafe_fonts(input: &str) -> Option<String> {
    use mupdf::pdf::PdfDocument;
    let pdf = PdfDocument::open(input).ok()?;
    let page_count = pdf.page_count().unwrap_or(0);
    let mut unsafe_types: Vec<String> = Vec::new();
    for page_no in 0..page_count {
        let page_obj = match pdf.find_page(page_no) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let resources = page_obj.get_dict_inheritable("Resources")
            .or_else(|_| page_obj.get_dict("Resources"))
            .ok().flatten();
        let resources = match resources {
            Some(r) => r.resolve().ok().flatten().unwrap_or(r),
            None => continue,
        };
        collect_unsafe_font_types(&resources, &mut unsafe_types);
    }
    unsafe_types.sort();
    unsafe_types.dedup();
    if unsafe_types.is_empty() {
        None
    } else {
        Some(format!(
            "{} フォントの再描画には対応できない",
            unsafe_types.join(", ")
        ))
    }
}

fn collect_unsafe_font_types(resources: &mupdf::pdf::PdfObject, found: &mut Vec<String>) {
    if let Ok(Some(font_dict_raw)) = resources.get_dict("Font") {
        let font_dict = font_dict_raw.resolve().ok().flatten().unwrap_or(font_dict_raw);
        let len = font_dict.dict_len().unwrap_or(0);
        for i in 0..len as i32 {
            if let Some(font_obj) = font_dict.get_dict_val(i).ok().flatten()
                .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
            {
                let subtype = font_obj.get_dict("Subtype").ok().flatten()
                    .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                    .and_then(|o| o.as_name().ok().map(|b| String::from_utf8_lossy(b).to_string()));
                match subtype.as_deref() {
                    // TrueType のみ安全（サブセット再構築が正常に動く）
                    Some("TrueType") => {}
                    // それ以外はすべて unsafe
                    Some(t) => {
                        found.push(t.to_string());
                        // Type0 の場合は DescendantFonts の種別も追記
                        if t == "Type0" {
                            if let Ok(Some(desc_arr)) = font_obj.get_dict("DescendantFonts") {
                                if let Some(d) = desc_arr.get_dict_val(0).ok().flatten()
                                    .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                                {
                                    let ds = d.get_dict("Subtype").ok().flatten()
                                        .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                                        .and_then(|o| o.as_name().ok().map(|b| String::from_utf8_lossy(b).to_string()));
                                    if let Some(dt) = ds {
                                        found.push(dt);
                                    }
                                }
                            }
                        }
                    }
                    None => {}
                }
            }
        }
    }
    // XObject 内の Form を再帰確認
    if let Ok(Some(xobj_dict_raw)) = resources.get_dict("XObject") {
        let xobj_dict = xobj_dict_raw.resolve().ok().flatten().unwrap_or(xobj_dict_raw);
        let len = xobj_dict.dict_len().unwrap_or(0);
        for i in 0..len as i32 {
            if let Some(xobj) = xobj_dict.get_dict_val(i).ok().flatten()
                .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
            {
                let subtype = xobj.get_dict("Subtype").ok().flatten()
                    .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                    .and_then(|o| o.as_name().ok().map(|b| String::from_utf8_lossy(b).to_string()));
                if subtype.as_deref() == Some("Form") {
                    if let Ok(Some(inner_res_raw)) = xobj.get_dict("Resources") {
                        let inner_res = inner_res_raw.resolve().ok().flatten().unwrap_or(inner_res_raw);
                        collect_unsafe_font_types(&inner_res, found);
                    }
                }
            }
        }
    }
}

/// options文字列 "key=val,key2=val2" から整数値を取得
/// キーのハイフン・アンダーバーは同一視する（compress-images == compress_images）
pub fn parse_rewrite_opt_i32(options: &str, key: &str) -> Option<i32> {
    let key_norm = key.replace('-', "_");
    options.split(',')
        .find(|s| {
            let k = s.trim().split('=').next().unwrap_or("").replace('-', "_");
            k == key_norm
        })
        .and_then(|s| s.split('=').nth(1))
        .and_then(|v| v.trim().parse().ok())
}

/// options文字列から bool を取得（yes/no/true/false）
/// キーのハイフン・アンダーバーは同一視する
pub fn parse_rewrite_opt_bool(options: &str, key: &str) -> Option<bool> {
    let key_norm = key.replace('-', "_");
    options.split(',')
        .find(|s| {
            let k = s.trim().split('=').next().unwrap_or("").replace('-', "_");
            k == key_norm
        })
        .and_then(|s| s.split('=').nth(1))
        .map(|v| matches!(v.trim(), "yes" | "true" | "1"))
}

/// PDF に Type3 フォントが含まれるか判定
pub fn has_type3_fonts(input: &str) -> bool {
    use mupdf::pdf::PdfDocument;
    let pdf = match PdfDocument::open(input) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let page_count = pdf.page_count().unwrap_or(0);
    for page_no in 0..page_count {
        let page_obj = match pdf.find_page(page_no) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let resources = page_obj.get_dict_inheritable("Resources")
            .or_else(|_| page_obj.get_dict("Resources"))
            .ok().flatten();
        let resources = match resources {
            Some(r) => r.resolve().ok().flatten().unwrap_or(r),
            None => continue,
        };
        if resources_has_type3(&resources) {
            return true;
        }
    }
    false
}

fn resources_has_type3(resources: &mupdf::pdf::PdfObject) -> bool {
    if let Ok(Some(font_dict_raw)) = resources.get_dict("Font") {
        let font_dict = font_dict_raw.resolve().ok().flatten().unwrap_or(font_dict_raw);
        let len = font_dict.dict_len().unwrap_or(0);
        for i in 0..len as i32 {
            if let Some(font_obj) = font_dict.get_dict_val(i).ok().flatten()
                .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
            {
                let subtype = font_obj.get_dict("Subtype").ok().flatten()
                    .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                    .and_then(|o| o.as_name().ok().map(|b| String::from_utf8_lossy(b).to_string()));
                if subtype.as_deref() == Some("Type3") {
                    return true;
                }
            }
        }
    }
    if let Ok(Some(xobj_dict_raw)) = resources.get_dict("XObject") {
        let xobj_dict = xobj_dict_raw.resolve().ok().flatten().unwrap_or(xobj_dict_raw);
        let len = xobj_dict.dict_len().unwrap_or(0);
        for i in 0..len as i32 {
            if let Some(xobj) = xobj_dict.get_dict_val(i).ok().flatten()
                .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
            {
                let subtype = xobj.get_dict("Subtype").ok().flatten()
                    .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                    .and_then(|o| o.as_name().ok().map(|b| String::from_utf8_lossy(b).to_string()));
                if subtype.as_deref() == Some("Form") {
                    if let Ok(Some(inner_res_raw)) = xobj.get_dict("Resources") {
                        let inner_res = inner_res_raw.resolve().ok().flatten().unwrap_or(inner_res_raw);
                        if resources_has_type3(&inner_res) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

/// rewrite のデフォルトオプション文字列
///
/// ⚠️ garbage=4 + sanitize=yes はCIDフォント（CJK等）のサブセット追跡が
///    不完全になり文字化けの原因になることが確認されている。
///    garbage=2, clean=no, sanitize=no が安全な設定。
pub const REWRITE_OPTIONS_DEFAULT: &str =
    "compress=yes,compress-images=yes,compress-fonts=yes,garbage=2";
