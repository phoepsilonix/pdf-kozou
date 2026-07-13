// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/api.rs
//
// GUI (Tauri) や他の Rust クレートから直接呼び出すための公開 API。
// 元々は CLI バイナリ (main.rs) の中で stdin/stdout 経由（sidecar 方式）
// のためだけに実装されていたが、Android/iOS では外部プロセスの起動が
// できないため、ライブラリ内の純粋な関数として切り出した。
//
// CLI (main.rs) 側は run_json_mode() から dispatch_json() を呼ぶだけの
// 薄いラッパーになっており、挙動は変わらない。

pub fn auto_convert_if_needed(
    input: &str,
    layout_w: Option<f32>,
    layout_h: Option<f32>,
    layout_em: Option<f32>,
    page_w_pt: Option<f32>,
    page_h_pt: Option<f32>,
    auto_orient: Option<bool>,
) -> anyhow::Result<Option<(tempfile::NamedTempFile, String)>> {
    use crate::convert::{ConvertRequest, convert_to_pdf, is_mupdf_supported, is_pdf};

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
pub fn dispatch_json(line: &str) -> String {
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
                    crate::info::info_with_fonts(actual_path)?
                } else {
                    crate::info::info(actual_path)?
                };

                // 変換した場合は file_size を元ファイルのサイズに戻す
                if _tmp.is_some() {
                    resp.file_size = std::fs::metadata(&r.path).map(|m| m.len()).unwrap_or(0);
                }

                Ok(serde_json::to_string(&resp)?)
            }
            "render" => {
                let req: crate::render::RenderRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&crate::render::render(&req)?)?)
            }
            "trim" => {
                let mut req: crate::trim::TrimRequest = serde_json::from_str(line)?;
                /* トリムは自然サイズで変換してから行う。ページサイズへのフィットは
                 * トリム後にフロント側で compose_imposition_pdf(1-up) で行う
                 * （マージンを自然サイズ基準のまま使えるようにするため）。 */
                let _tmp =
                    auto_convert_if_needed(&req.input.clone(), lw, lh, lem, None, None, None)?;
                if let Some((_, ref tmp_path)) = _tmp {
                    req.input = tmp_path.clone();
                }
                Ok(serde_json::to_string(&crate::trim::trim(&req)?)?)
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
                    inner: crate::compress::CompressRequest,
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
                        .unwrap_or(crate::compress::REWRITE_OPTIONS_DEFAULT);
                    let fallback = {
                        use crate::compress::{
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
                    crate::compress::rewrite(&r.inner.input, &r.inner.output, opts, &fallback)?
                } else {
                    crate::compress::compress(&r.inner)?
                };
                Ok(serde_json::to_string(&resp)?)
            }
            "split" => {
                let mut req: crate::split::SplitRequest = serde_json::from_str(line)?;
                let _tmp =
                    auto_convert_if_needed(&req.input.clone(), lw, lh, lem, None, None, None)?;
                if let Some((_, ref tmp_path)) = _tmp {
                    req.input = tmp_path.clone();
                }
                Ok(serde_json::to_string(&crate::split::split(&req)?)?)
            }
            "merge" => {
                // merge は複数入力。各ファイルをチェックして非 PDF を変換する
                let mut req: crate::merge::MergeRequest = serde_json::from_str(line)?;
                let mut tmps: Vec<(tempfile::NamedTempFile, String)> = Vec::new();
                for input in req.inputs.iter_mut() {
                    if let Some(converted) =
                        auto_convert_if_needed(input, lw, lh, lem, pw_pt, ph_pt, auto_orient)?
                    {
                        *input = converted.1.clone();
                        tmps.push(converted);
                    }
                }
                let res = crate::merge::merge(&req)?;
                drop(tmps); // 一時ファイルを削除
                Ok(serde_json::to_string(&res)?)
            }
            "rotate" => {
                let mut req: crate::rotate::RotateRequest = serde_json::from_str(line)?;
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
                Ok(serde_json::to_string(&crate::rotate::rotate(&req)?)?)
            }
            "sanitize_hidden" => {
                let req: crate::stext::SanitizeRequest = serde_json::from_str(line)?;
                // スタックサイズを 32MB に増やして実行（Windows デフォルト 1MB では不足）
                let result = std::thread::Builder::new()
                    .stack_size(32 * 1024 * 1024)
                    .spawn(move || crate::stext::sanitize_hidden_text(&req))
                    .map_err(|e| anyhow::anyhow!("thread spawn: {e}"))?
                    .join()
                    .map_err(|_| anyhow::anyhow!("thread panicked"))??;
                Ok(serde_json::to_string(&result)?)
            }

            "render_imposition" => {
                let req: crate::stext::RenderImpositionRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&crate::stext::render_imposition(
                    &req,
                )?)?)
            }

            "rasterize_imposition" => {
                let mut req: crate::stext::RasterizeImpositionRequest = serde_json::from_str(line)?;
                let _tmp =
                    auto_convert_if_needed(&req.input.clone(), lw, lh, lem, None, None, None)?;
                if let Some((_, ref tmp_path)) = _tmp {
                    req.input = tmp_path.clone();
                }
                Ok(serde_json::to_string(&crate::stext::rasterize_imposition(
                    &req,
                )?)?)
            }

            "split_imposition_pdf" => {
                let mut req: crate::stext::SplitImpositionPdfRequest = serde_json::from_str(line)?;
                let _tmp =
                    auto_convert_if_needed(&req.input.clone(), lw, lh, lem, None, None, None)?;
                if let Some((_, ref tmp_path)) = _tmp {
                    req.input = tmp_path.clone();
                }
                Ok(serde_json::to_string(&crate::stext::split_imposition_pdf(
                    &req,
                )?)?)
            }

            "compose_imposition_pdf" => {
                let mut req: crate::stext::ComposeImpositionPdfRequest =
                    serde_json::from_str(line)?;
                let _tmp =
                    auto_convert_if_needed(&req.input.clone(), lw, lh, lem, None, None, None)?;
                if let Some((_, ref tmp_path)) = _tmp {
                    req.input = tmp_path.clone();
                }
                Ok(serde_json::to_string(
                    &crate::stext::compose_imposition_pdf(&req)?,
                )?)
            }

            "split_cell_render" => {
                let mut req: crate::stext::SplitCellRenderRequest = serde_json::from_str(line)?;
                let _tmp =
                    auto_convert_if_needed(&req.input.clone(), lw, lh, lem, None, None, None)?;
                if let Some((_, ref tmp_path)) = _tmp {
                    req.input = tmp_path.clone();
                }
                Ok(serde_json::to_string(&crate::stext::split_cell_render(
                    &req,
                )?)?)
            }

            "detect_control_chars" => {
                let req: crate::stext::DetectControlCharsRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&crate::stext::detect_control_chars(
                    &req,
                )?)?)
            }

            "detect_buried" => {
                let req: crate::stext::DetectBuriedRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&crate::stext::detect_buried_text(
                    &req,
                )?)?)
            }

            "detect_tiny" => {
                let req: crate::stext::DetectTinyRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&crate::stext::detect_tiny_text(
                    &req,
                )?)?)
            }

            "detect_low_contrast" => {
                let req: crate::stext::DetectLowContrastRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(
                    &crate::stext::detect_low_contrast_text(&req)?,
                )?)
            }

            "detect_transparent" => {
                let req: crate::stext::DetectTransparentRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(
                    &crate::stext::detect_transparent_text(&req)?,
                )?)
            }

            "page_text" => {
                let req: crate::stext::PageTextRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&crate::stext::get_page_text(&req)?)?)
            }
            "search" => {
                let req: crate::stext::SearchRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&crate::stext::search_page(&req)?)?)
            }
            "page_links" => {
                let req: crate::stext::PageLinksRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&crate::stext::get_page_links(&req)?)?)
            }
            "convert" => {
                let req: crate::convert::ConvertRequest = serde_json::from_str(line)?;
                Ok(serde_json::to_string(&crate::convert::convert_to_pdf(
                    &req,
                )?)?)
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
                    &crate::compress::rasterize_with_quality(
                        &r.input,
                        &r.output,
                        r.dpi.unwrap_or(150.0),
                        r.quality.unwrap_or(85),
                        r.use_png.unwrap_or(false),
                        pages.as_deref(),
                    )?,
                )?)
            }
            "rasterize_no_text" => {
                // 画像PDF化(フォント保持版) Stage 1 検証用コマンド。
                // rasterize と同じ入出力形式で、テキスト(Type3含む)を
                // 除外した背景画像のみを生成する。まだ元のテキストとの
                // 合成(Stage 2)は行わないため、出力PDFにテキストは無い。
                #[derive(serde::Deserialize)]
                struct Req {
                    input: String,
                    output: String,
                    #[serde(default)]
                    dpi: Option<f32>,
                    #[serde(default)]
                    quality: Option<i32>,
                    #[serde(default)]
                    use_png: Option<bool>,
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
                    &crate::compress::rasterize_no_text_with_quality(
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
                    "result": crate::convert::is_pdf(&r.path)
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
                    "result": crate::convert::is_mupdf_supported(&r.path)
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
                crate::compress::set_metadata(&r.path, &pairs)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                Ok(serde_json::to_string(&serde_json::json!({ "ok": true }))?)
            }
            "get_image_metadata" => {
                #[derive(serde::Deserialize)]
                struct Req {
                    path: String,
                }
                let r: Req = serde_json::from_str(line)?;
                let pairs = crate::render::read_image_metadata(&r.path);
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
                    let existing = crate::render::read_image_metadata(&r.path);
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
                crate::render::write_image_metadata(&r.path, &pairs)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                Ok(serde_json::to_string(&serde_json::json!({ "ok": true }))?)
            }
            "sanitize_type3" => {
                let req: crate::stext::SanitizeType3Request = serde_json::from_str(line)?;
                let resp = crate::stext::sanitize_type3_text(&req)?;
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
                let metadata = crate::compress::collect_metadata(&r.source_path);
                if !metadata.is_empty() {
                    // 画像ファイルを読み込んでメタデータを埋め込んで上書き
                    let img_bytes = std::fs::read(&r.image_path)
                        .map_err(|e| anyhow::anyhow!("read image: {e}"))?;
                    let fmt = r.format.as_deref().unwrap_or("jpeg");
                    let out_bytes = if fmt == "png" {
                        crate::render::embed_metadata_png(img_bytes, &metadata)
                    } else {
                        crate::render::embed_metadata_jpeg(img_bytes, &metadata)
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

pub fn parse_page_list(s: &str) -> anyhow::Result<Vec<i32>> {
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

/// "1", "1-3", "1,3,5", "1-3,5,7" → 0始まりインデックスの Vec
pub fn parse_string_pages(s: &str) -> anyhow::Result<Vec<i32>> {
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

// ── バッチレンダリング(export_images 用) ──────────────────────────────────────
// 元は main.rs の render_to_dir だったが、GUI (Tauri) からも直接呼べるように
// ライブラリ側へ移動。CLI 版は stdout に println! していたが、こちらは
// 呼び出し元が JSON を自由に扱えるよう Value を返す形にしている。

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

/// 複数ページをファイルとして書き出し、結果一覧を JSON (Value) で返す
#[allow(clippy::too_many_arguments)]
pub fn render_to_dir(
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
) -> anyhow::Result<serde_json::Value> {
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

        let req = crate::render::RenderRequest {
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

        let resp = crate::render::render(&req)?;

        file_list.push(serde_json::json!({
            "page":     page_index + 1,
            "file":     out_path,
            "width_px": resp.width_px,
            "height_px": resp.height_px,
        }));
    }

    Ok(serde_json::json!({ "ok": true, "files": file_list }))
}
