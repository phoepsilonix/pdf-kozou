// pdf-kozou-core/src/compress.rs
// MuPDF による PDF 圧縮・最適化
//
// フォント保護ポリシー:
//   PDFの最大の利点である埋め込みフォント（アウトラインデータ）を最優先で保護する。
//   - テキスト選択・コピー・検索は必ず維持する
//   - 拡大縮小に強いベクターアウトラインを保持する
//   - ビットマップ化は絶対しない（最終手段として UI にのみ存在）
//   - 使われていないフォントグリフだけを pdf_subset_fonts() で除去する
//
// 圧縮戦略 (compress() 関数のプリセット別):
//   Light      : gc=1 + compress のみ。未参照オブジェクトを除去しない安全運転
//   Standard   : gc=2 + 画像圧縮 + フォントサブセット化。最もバランスが良い
//   Aggressive : gc=2 + フォントサブセット化 + clean。レイアウト崩れリスク低
//   Maximum    : gc=3 + フォントサブセット化 + sanitize。CJKフォントに注意

use serde::{Deserialize, Serialize};
use crate::error::{CoreError, Result};

// ── 圧縮プリセット ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename_all = "snake_case")]
pub enum CompressPreset {
    /// 軽め: gc=1、画像圧縮なし、フォントサブセットなし — 最安全
    Light,
    /// 標準: gc=2、画像圧縮あり、フォントサブセットあり — デフォルト推奨
    Standard,
    /// 強め: gc=2、フォントサブセット + clean — Standard より削減
    Aggressive,
    /// 最大: gc=3、フォントサブセット + sanitize — CJK等では注意
    Maximum,
}

impl CompressPreset {
    /// (compress_images, gc, clean, sanitize, do_subset)
    fn to_params(&self) -> (bool, i32, bool, bool, bool) {
        match self {
            Self::Light      => (false, 1, false, false, false),
            Self::Standard   => (true,  2, false, false, true),
            Self::Aggressive => (true,  2, true,  false, true),
            Self::Maximum    => (true,  3, false, true,  true),
        }
    }
}

// ── リクエスト/レスポンス型 ───────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct CompressRequest {
    pub input:  String,
    pub output: String,

    #[serde(default)]
    pub preset: Option<CompressPreset>,

    /// 画像を再圧縮するか (default: preset に従う)
    #[serde(default)]
    pub compress_images: Option<bool>,
    /// フォントストリームを圧縮するか (default: true)
    #[serde(default)]
    pub compress_fonts:  Option<bool>,
    /// ガベージコレクションレベル 0-4 (default: preset に従う)
    #[serde(default)]
    pub garbage_level:   Option<i32>,
    /// コンテンツストリームを再構築するか (default: preset に従う)
    #[serde(default)]
    pub clean:           Option<bool>,
    /// ストリームを再解釈・再構築するか (default: preset に従う)
    #[serde(default)]
    pub sanitize:        Option<bool>,
    /// フォントサブセット化を有効にするか (default: preset に従う)
    /// false にすると pdf_subset_fonts() をスキップする
    #[serde(default)]
    pub font_subset:     Option<bool>,

    #[serde(default)]
    pub linearize: Option<bool>,  // 互換維持のため残す (無視)
}

#[derive(Serialize)]
pub struct CompressResponse {
    pub ok:           bool,
    pub input_bytes:  u64,
    pub output_bytes: u64,
    /// 圧縮率 (0.0-1.0, 小さいほど圧縮効果大)
    pub ratio:        f64,
    pub params_used:  CompressParamsUsed,
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
    /// pdf_subset_fonts() を実行したか
    pub font_subset:     bool,
    /// Type3 等でサブセット化をスキップ/制限したか
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub subset_skipped:  bool,
}

// ── compress(): メイン圧縮関数 ───────────────────────────────────────────────

/// PDF を圧縮する。
///
/// Standard/Aggressive/Maximum プリセットでは pdf_subset_fonts() を実行し、
/// 使われていないフォントグリフを除去する。テキスト・アウトラインは保持。
pub fn compress(req: &CompressRequest) -> Result<CompressResponse> {
    let preset = req.preset.as_ref().unwrap_or(&CompressPreset::Standard);
    let (preset_ci, preset_gc, preset_clean, preset_sanitize, preset_subset) = preset.to_params();

    let compress_images = req.compress_images.unwrap_or(preset_ci);
    let compress_fonts  = req.compress_fonts .unwrap_or(true);
    let garbage_level   = req.garbage_level  .unwrap_or(preset_gc);
    let clean           = req.clean    .unwrap_or(preset_clean);
    let sanitize        = req.sanitize .unwrap_or(preset_sanitize);
    let do_subset       = req.font_subset.unwrap_or(preset_subset);

    if do_subset {
        // フォントサブセット化パス: font_subset::subset_and_write を呼ぶ
        let result = crate::font_subset::subset_and_write(
            &req.input, &req.output,
            garbage_level, clean, sanitize,
            compress_images, compress_fonts,
        )?;

        let ratio = safe_ratio(result.input_bytes, result.output_bytes);

        let mut warnings: Vec<String> = Vec::new();
        if result.fell_back {
            warnings.push(format!(
                "Type3フォントのため gc={} に制限しました (指定値={garbage_level})。",
                result.effective_gc
            ));
        }
        if !result.subset_applied {
            warnings.push("Type3フォントのためサブセット化をスキップしました。".into());
        }
        if let Some(w) = size_increased_warning(result.input_bytes, result.output_bytes) {
            warnings.push(w);
        }

        Ok(CompressResponse {
            ok: true,
            input_bytes:  result.input_bytes,
            output_bytes: result.output_bytes,
            ratio,
            params_used: CompressParamsUsed {
                compress_images,
                compress_fonts,
                garbage_level:  result.effective_gc,
                clean:          result.effective_clean,
                sanitize:       result.effective_sanitize,
                font_subset:    result.subset_applied,
                subset_skipped: result.fell_back || !result.subset_applied,
            },
            warning: if warnings.is_empty() { None } else { Some(warnings.join(" ")) },
        })
    } else {
        // サブセット化なし: PdfWriteOptions のみで圧縮
        safe_compress_only(
            &req.input, &req.output,
            compress_images, compress_fonts,
            garbage_level, clean, sanitize,
        )
    }
}

/// サブセット化なしの通常圧縮 (Light プリセット or font_subset=false 時)
fn safe_compress_only(
    input:           &str,
    output:          &str,
    compress_images: bool,
    compress_fonts:  bool,
    gc:              i32,
    clean:           bool,
    sanitize:        bool,
) -> Result<CompressResponse> {
    use mupdf::pdf::PdfDocument;

    let doc = PdfDocument::open(input)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let mut opts = mupdf::pdf::PdfWriteOptions::default();
    opts.set_compress(true)
        .set_decompress(false)
        .set_compress_images(compress_images)
        .set_compress_fonts(compress_fonts)
        .set_garbage_level(gc)
        .set_clean(clean)
        .set_sanitize(sanitize);

    doc.save_with_options(output, opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let ib = std::fs::metadata(input) .map(|m| m.len()).unwrap_or(0);
    let ob = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);

    Ok(CompressResponse {
        ok: true,
        input_bytes:  ib,
        output_bytes: ob,
        ratio: safe_ratio(ib, ob),
        params_used: CompressParamsUsed {
            compress_images,
            compress_fonts,
            garbage_level: gc,
            clean,
            sanitize,
            font_subset:   false,
            subset_skipped: false,
        },
        warning: size_increased_warning(ib, ob),
    })
}

// ── rewrite(): DocumentWriter 再描画パス (上級向け) ─────────────────────────

#[derive(Debug, Default)]
pub struct RewriteFallbackParams {
    pub garbage_level:   Option<i32>,
    pub clean:           bool,
    pub sanitize:        bool,
    pub compress_images: Option<bool>,
    pub compress_fonts:  Option<bool>,
}

/// DocumentWriter + page.run() による PDF 再書き出し
///
/// # 処理の優先順位
/// 1. TrueType のみ含む PDF → DocumentWriter で再描画 (高圧縮)
/// 2. Type1/CIDFont を含む PDF → font_subset FFI パス
/// 3. Type3 を含む PDF → 通常圧縮フォールバック
pub fn rewrite(
    input:    &str,
    output:   &str,
    options:  &str,
    fallback: &RewriteFallbackParams,
) -> Result<CompressResponse> {
    use mupdf::DocumentWriter;

    let unsafe_fonts = detect_rewrite_unsafe_fonts(input);

    match unsafe_fonts {
        None => {
            // TrueType のみ — DocumentWriter + page.run()
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
                let dev = writer.begin_page(bounds)
                    .map_err(|e| CoreError::MuPdf(e.to_string()))?;
                page.run(&dev, &identity)
                    .map_err(|e| CoreError::MuPdf(e.to_string()))?;
                writer.end_page(dev)
                    .map_err(|e| CoreError::MuPdf(e.to_string()))?;
            }
            drop(writer);

            let ib = std::fs::metadata(input) .map(|m| m.len()).unwrap_or(0);
            let ob = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
            let gc       = parse_rewrite_opt_i32(options,  "garbage").unwrap_or(2);
            let clean    = parse_rewrite_opt_bool(options, "clean").unwrap_or(false);
            let sanitize = parse_rewrite_opt_bool(options, "sanitize").unwrap_or(false);
            let ci = parse_rewrite_opt_bool(options, "compress-images").unwrap_or(true);
            let cf = parse_rewrite_opt_bool(options, "compress-fonts").unwrap_or(true);

            Ok(CompressResponse {
                ok: true, input_bytes: ib, output_bytes: ob,
                ratio: safe_ratio(ib, ob),
                params_used: CompressParamsUsed {
                    compress_images: ci, compress_fonts: cf,
                    garbage_level: gc, clean, sanitize,
                    font_subset: false, subset_skipped: false,
                },
                warning: size_increased_warning(ib, ob),
            })
        }

        Some(reason) if !reason.contains("Type3") => {
            // Type1/CIDFont → font_subset FFI
            eprintln!("[rewrite] non-TrueType ({reason}) → font_subset FFI");
            let gc = fallback.garbage_level.unwrap_or(2);
            let result = crate::font_subset::subset_and_write(
                input, output, gc,
                fallback.clean, fallback.sanitize,
                fallback.compress_images.unwrap_or(true),
                fallback.compress_fonts.unwrap_or(true),
            )?;
            let ratio = safe_ratio(result.input_bytes, result.output_bytes);
            let mut warns = vec![
                format!("{reason} のため font_subset FFI パスを使用しました。"),
            ];
            if result.fell_back {
                warns.push(format!("gc={} に制限 (指定={gc})。", result.effective_gc));
            }
            if let Some(w) = size_increased_warning(result.input_bytes, result.output_bytes) {
                warns.push(w);
            }
            Ok(CompressResponse {
                ok: true,
                input_bytes: result.input_bytes, output_bytes: result.output_bytes, ratio,
                params_used: CompressParamsUsed {
                    compress_images: fallback.compress_images.unwrap_or(true),
                    compress_fonts:  fallback.compress_fonts.unwrap_or(true),
                    garbage_level: result.effective_gc,
                    clean: result.effective_clean, sanitize: result.effective_sanitize,
                    font_subset: result.subset_applied, subset_skipped: result.fell_back,
                },
                warning: Some(warns.join(" ")),
            })
        }

        Some(reason) => {
            // Type3 → 通常圧縮
            eprintln!("[rewrite] Type3 detected ({reason}) → safe fallback");
            rewrite_safe_fallback(input, output, Some(reason), fallback)
        }
    }
}

fn rewrite_safe_fallback(
    input: &str, output: &str,
    reason: Option<String>,
    p: &RewriteFallbackParams,
) -> Result<CompressResponse> {
    let gc       = p.garbage_level.unwrap_or(2);
    let clean    = p.clean;
    let sanitize = p.sanitize;
    let ci       = p.compress_images.unwrap_or(true);
    let cf       = p.compress_fonts.unwrap_or(true);
    let mut res  = safe_compress_only(input, output, ci, cf, gc, clean, sanitize)?;
    let mut warns: Vec<String> = Vec::new();
    if let Some(r) = reason { warns.push(format!("{r} のため通常圧縮を使用します。")); }
    if gc >= 3 { warns.push("gc=3以上はフォントサブセット統合が発生する可能性があります。".into()); }
    if !warns.is_empty() {
        let prev = res.warning.take().unwrap_or_default();
        let sep = if prev.is_empty() { "" } else { " " };
        res.warning = Some(format!("{}{}{}", warns.join(" "), sep, prev));
    }
    res.params_used.subset_skipped = true;
    Ok(res)
}

// ── rasterize(): ラスタライズ (最終手段) ────────────────────────────────────

/// PDF を全ページ画像化 (テキスト・アウトライン失う — 非推奨)
pub fn rasterize(input: &str, output: &str, dpi: f32) -> Result<CompressResponse> {
    use mupdf::{DocumentWriter, Colorspace, Matrix};

    let doc = mupdf::Document::open(input)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let page_count = doc.page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let opts = "compress=yes,compress-images=yes";
    let mut writer = DocumentWriter::new(output, "pdf", opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let scale = Matrix::new_scale(dpi / 72.0, dpi / 72.0);
    for i in 0..page_count {
        let page = doc.load_page(i).map_err(|e| CoreError::MuPdf(e.to_string()))?;
        let bounds = page.bounds().map_err(|e| CoreError::MuPdf(e.to_string()))?;
        let pixmap = page.to_pixmap(&scale, &Colorspace::device_rgb(), false, true)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        let dev = writer.begin_page(bounds).map_err(|e| CoreError::MuPdf(e.to_string()))?;
        let img_ctm = Matrix::new_scale(
            bounds.width()  / pixmap.width()  as f32,
            bounds.height() / pixmap.height() as f32,
        );
        let image = mupdf::Image::from_pixmap(&pixmap)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        dev.fill_image(&image, &img_ctm, 1.0, mupdf::ColorParams::default())
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        writer.end_page(dev).map_err(|e| CoreError::MuPdf(e.to_string()))?;
    }
    drop(writer);
    let ib = std::fs::metadata(input) .map(|m| m.len()).unwrap_or(0);
    let ob = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
    Ok(CompressResponse {
        ok: true, input_bytes: ib, output_bytes: ob, ratio: safe_ratio(ib, ob),
        params_used: CompressParamsUsed {
            compress_images: true, compress_fonts: false,
            garbage_level: 0, clean: false, sanitize: false,
            font_subset: false, subset_skipped: false,
        },
        warning: Some(format!(
            "ラスタライズ: {dpi}dpi 画像PDFに変換。テキスト選択・検索・コピー不可。"
        )),
    })
}

// ── ユーティリティ ────────────────────────────────────────────────────────────

fn safe_ratio(input_bytes: u64, output_bytes: u64) -> f64 {
    if input_bytes > 0 { output_bytes as f64 / input_bytes as f64 } else { 1.0 }
}

fn size_increased_warning(ib: u64, ob: u64) -> Option<String> {
    if ob > ib {
        Some(format!(
            "サイズが増加しました ({} → {} bytes)。元ファイルの使用を推奨します。",
            ib, ob
        ))
    } else { None }
}

/// rewrite が安全に処理できないフォントを検出
pub fn detect_rewrite_unsafe_fonts(input: &str) -> Option<String> {
    use mupdf::pdf::PdfDocument;
    let pdf = PdfDocument::open(input).ok()?;
    let page_count = pdf.page_count().unwrap_or(0);
    let mut unsafe_types: Vec<String> = Vec::new();
    for page_no in 0..page_count {
        let page_obj = match pdf.find_page(page_no) { Ok(p) => p, Err(_) => continue };
        let resources = page_obj.get_dict_inheritable("Resources")
            .or_else(|_| page_obj.get_dict("Resources")).ok().flatten();
        let resources = match resources {
            Some(r) => r.resolve().ok().flatten().unwrap_or(r),
            None => continue,
        };
        collect_unsafe_font_types(&resources, &mut unsafe_types);
    }
    unsafe_types.sort(); unsafe_types.dedup();
    if unsafe_types.is_empty() { None }
    else { Some(format!("{} フォントの再描画には対応できない", unsafe_types.join(", "))) }
}

fn collect_unsafe_font_types(resources: &mupdf::pdf::PdfObject, found: &mut Vec<String>) {
    if let Ok(Some(fd_raw)) = resources.get_dict("Font") {
        let fd = fd_raw.resolve().ok().flatten().unwrap_or(fd_raw);
        let len = fd.dict_len().unwrap_or(0);
        for i in 0..len as i32 {
            if let Some(fo) = fd.get_dict_val(i).ok().flatten()
                .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
            {
                let sub = fo.get_dict("Subtype").ok().flatten()
                    .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                    .and_then(|o| o.as_name().ok()
                        .map(|b| String::from_utf8_lossy(b).to_string()));
                match sub.as_deref() {
                    Some("TrueType") => {}
                    Some(t) => {
                        found.push(t.to_string());
                        if t == "Type0" {
                            if let Ok(Some(da)) = fo.get_dict("DescendantFonts") {
                                if let Some(d) = da.get_dict_val(0).ok().flatten()
                                    .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                                {
                                    let ds = d.get_dict("Subtype").ok().flatten()
                                        .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                                        .and_then(|o| o.as_name().ok()
                                            .map(|b| String::from_utf8_lossy(b).to_string()));
                                    if let Some(dt) = ds { found.push(dt); }
                                }
                            }
                        }
                    }
                    None => {}
                }
            }
        }
    }
    // Form XObject 内も再帰チェック
    if let Ok(Some(xd_raw)) = resources.get_dict("XObject") {
        let xd = xd_raw.resolve().ok().flatten().unwrap_or(xd_raw);
        let len = xd.dict_len().unwrap_or(0);
        for i in 0..len as i32 {
            if let Some(xo) = xd.get_dict_val(i).ok().flatten()
                .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
            {
                let st = xo.get_dict("Subtype").ok().flatten()
                    .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                    .and_then(|o| o.as_name().ok()
                        .map(|b| String::from_utf8_lossy(b).to_string()));
                if st.as_deref() == Some("Form") {
                    if let Ok(Some(ir_raw)) = xo.get_dict("Resources") {
                        let ir = ir_raw.resolve().ok().flatten().unwrap_or(ir_raw);
                        collect_unsafe_font_types(&ir, found);
                    }
                }
            }
        }
    }
}

/// PDF に Type3 フォントが含まれるか判定
pub fn has_type3_fonts(input: &str) -> bool {
    use mupdf::pdf::PdfDocument;
    let pdf = match PdfDocument::open(input) { Ok(p) => p, Err(_) => return false };
    let page_count = pdf.page_count().unwrap_or(0);
    for page_no in 0..page_count {
        let page_obj = match pdf.find_page(page_no) { Ok(p) => p, Err(_) => continue };
        let resources = page_obj.get_dict_inheritable("Resources")
            .or_else(|_| page_obj.get_dict("Resources")).ok().flatten();
        let resources = match resources {
            Some(r) => r.resolve().ok().flatten().unwrap_or(r),
            None => continue,
        };
        if resources_has_type3(&resources) { return true; }
    }
    false
}

fn resources_has_type3(resources: &mupdf::pdf::PdfObject) -> bool {
    if let Ok(Some(fd_raw)) = resources.get_dict("Font") {
        let fd = fd_raw.resolve().ok().flatten().unwrap_or(fd_raw);
        let len = fd.dict_len().unwrap_or(0);
        for i in 0..len as i32 {
            if let Some(fo) = fd.get_dict_val(i).ok().flatten()
                .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
            {
                let sub = fo.get_dict("Subtype").ok().flatten()
                    .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                    .and_then(|o| o.as_name().ok()
                        .map(|b| String::from_utf8_lossy(b).to_string()));
                if sub.as_deref() == Some("Type3") { return true; }
            }
        }
    }
    if let Ok(Some(xd_raw)) = resources.get_dict("XObject") {
        let xd = xd_raw.resolve().ok().flatten().unwrap_or(xd_raw);
        let len = xd.dict_len().unwrap_or(0);
        for i in 0..len as i32 {
            if let Some(xo) = xd.get_dict_val(i).ok().flatten()
                .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
            {
                let st = xo.get_dict("Subtype").ok().flatten()
                    .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                    .and_then(|o| o.as_name().ok()
                        .map(|b| String::from_utf8_lossy(b).to_string()));
                if st.as_deref() == Some("Form") {
                    if let Ok(Some(ir_raw)) = xo.get_dict("Resources") {
                        let ir = ir_raw.resolve().ok().flatten().unwrap_or(ir_raw);
                        if resources_has_type3(&ir) { return true; }
                    }
                }
            }
        }
    }
    false
}

pub fn parse_rewrite_opt_i32(options: &str, key: &str) -> Option<i32> {
    let kn = key.replace('-', "_");
    options.split(',')
        .find(|s| s.trim().split('=').next().unwrap_or("").replace('-', "_") == kn)
        .and_then(|s| s.split('=').nth(1))
        .and_then(|v| v.trim().parse().ok())
}

pub fn parse_rewrite_opt_bool(options: &str, key: &str) -> Option<bool> {
    let kn = key.replace('-', "_");
    options.split(',')
        .find(|s| s.trim().split('=').next().unwrap_or("").replace('-', "_") == kn)
        .and_then(|s| s.split('=').nth(1))
        .map(|v| matches!(v.trim(), "yes" | "true" | "1"))
}

pub const REWRITE_OPTIONS_DEFAULT: &str =
    "compress=yes,compress-images=yes,compress-fonts=yes,garbage=2";
