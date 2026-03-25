// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

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

use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};

use crate::ffi::enable_objstms;
use crate::ffi::kozou_new_context;
use crate::ffi::merge_duplicate_fonts;

// ── メタデータ保持ユーティリティ ──────────────────────────────────────────────
/// 入力PDFの /Info 辞書からメタデータを収集する
///
/// `mupdf::Document::metadata(MetadataName)` を使用。
/// MuPDF が内部で fz_lookup_metadata を呼び、
/// PDFDocEncoding / UTF-16 BE を UTF-8 に変換して返す。
/// 空文字列が返った場合はそのキーが存在しないことを意味する。
pub fn collect_metadata(input: &str) -> Vec<(String, String)> {
    use mupdf::MetadataName;

    let doc = match mupdf::Document::open(input) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[metadata] collect: open failed for {input}: {e}");
            return vec![];
        }
    };

    // MetadataName enum と文字列キー名の対応
    let keys: &[(&str, MetadataName)] = &[
        ("Title", MetadataName::Title),
        ("Author", MetadataName::Author),
        ("Subject", MetadataName::Subject),
        ("Keywords", MetadataName::Keywords),
        ("Creator", MetadataName::Creator),
        ("Producer", MetadataName::Producer),
        ("CreationDate", MetadataName::CreationDate),
        ("ModDate", MetadataName::ModDate),
    ];

    let mut result = Vec::new();
    for (key_str, name) in keys {
        match doc.metadata(*name) {
            Ok(val) => {
                let s = val.trim().to_string();
                if !s.is_empty() {
                    result.push((key_str.to_string(), s));
                }
            }
            Err(e) => eprintln!("[metadata] collect: metadata({key_str}) error: {e}"),
        }
    }
    eprintln!("[metadata] collected {} keys from {input}", result.len());
    result
}

/// 出力 PDF ファイルの /Info 辞書にメタデータを書き戻す
///
/// Rust の `PdfDocument` API を使って直接 `/Info` 辞書を操作する。
/// - `/Info` が既存 → インクリメンタル保存で差分追記（高速・安全）
/// - `/Info` がない（新規 PDF）→ 新規辞書を作成して通常保存
///
/// `save_with_options()` で書き出した **後** に呼ぶ。
pub fn copy_metadata_after_write(output: &str, metadata: &[(String, String)]) {
    if metadata.is_empty() {
        return;
    }
    // まず /Info が存在するか確認
    let has_info = {
        use mupdf::pdf::PdfDocument;
        PdfDocument::open(output)
            .ok()
            .and_then(|doc| doc.trailer().ok())
            .and_then(|trailer| trailer.get_dict("Info").ok())
            .map(|opt| opt.is_some())
            .unwrap_or(false)
    };

    let result = if has_info {
        write_pdf_info(output, metadata)
    } else {
        write_pdf_info_new(output, metadata)
    };

    if let Err(e) = result {
        eprintln!("[metadata] write_pdf_info failed for {output}: {e}");
    }
}

/// PDF の /Info 辞書にメタデータを書き込んで保存する（Rust 実装）
///
/// incremental=true で差分追記するため、Windows でもファイルハンドル競合しない。
fn write_pdf_info(path: &str, metadata: &[(String, String)]) -> std::result::Result<(), String> {
    use mupdf::pdf::{PdfDocument, PdfObject, PdfWriteOptions};

    let doc = PdfDocument::open(path).map_err(|e| format!("open failed: {e}"))?;

    let trailer = doc.trailer().map_err(|e| format!("trailer failed: {e}"))?;

    let info_obj = trailer
        .get_dict("Info")
        .map_err(|e| format!("get Info failed: {e}"))?;

    let mut info = match info_obj {
        Some(obj) => obj
            .resolve()
            .map_err(|e| format!("resolve Info failed: {e}"))?
            .unwrap_or(obj),
        None => {
            eprintln!("[metadata] /Info dict not found in {path}, skipping");
            return Ok(());
        }
    };

    for (key, value) in metadata {
        let val_obj =
            PdfObject::new_string(value).map_err(|e| format!("new_string({key}) failed: {e}"))?;
        info.dict_put(key.as_str(), val_obj)
            .map_err(|e| format!("dict_put({key}) failed: {e}"))?;
    }

    // incremental=true: 差分追記なので既存ファイルを削除しない
    // → Windows でも PdfDocument がハンドルを保持したまま保存できる
    let mut opts = PdfWriteOptions::default();
    opts.set_incremental(true)
        .set_compress(true)
        .set_garbage_level(0)
        .set_clean(false);

    doc.save_with_options(path, opts)
        .map_err(|e| format!("save failed: {e}"))?;

    eprintln!("[metadata] wrote {} keys to {path}", metadata.len());
    Ok(())
}

/// /Info がない新規 PDF にメタデータを書き込む
///
/// 新規 /Info は incremental 保存で追加できないため通常保存を使う。
/// Windows でのファイルハンドル競合を避けるため、一時ファイルに保存後リネームする。
fn write_pdf_info_new(
    path: &str,
    metadata: &[(String, String)],
) -> std::result::Result<(), String> {
    use mupdf::pdf::{PdfDocument, PdfObject, PdfWriteOptions};

    // 一時ファイルのパスを決定（同ディレクトリに作成）
    let tmp_path = format!("{path}.kozou_tmp");

    let mut doc = PdfDocument::open(path).map_err(|e| format!("open failed: {e}"))?;

    let new_dict = doc
        .new_dict()
        .map_err(|e| format!("new_dict failed: {e}"))?;
    let info_ref = doc
        .add_object(&new_dict)
        .map_err(|e| format!("add_object failed: {e}"))?;

    {
        let mut trailer = doc.trailer().map_err(|e| format!("trailer failed: {e}"))?;
        trailer
            .dict_put("Info", info_ref.clone())
            .map_err(|e| format!("dict_put Info to trailer failed: {e}"))?;
    }

    let mut info = info_ref
        .resolve()
        .map_err(|e| format!("resolve failed: {e}"))?
        .ok_or_else(|| "resolved Info is null".to_string())?;

    for (key, value) in metadata {
        let val_obj =
            PdfObject::new_string(value).map_err(|e| format!("new_string({key}) failed: {e}"))?;
        info.dict_put(key.as_str(), val_obj)
            .map_err(|e| format!("dict_put({key}) failed: {e}"))?;
    }

    let mut opts = PdfWriteOptions::default();
    opts.set_incremental(false)
        .set_compress(true)
        .set_garbage_level(0)
        .set_clean(false);

    // 一時ファイルに保存（path ではなく tmp_path）
    doc.save_with_options(&tmp_path, opts)
        .map_err(|e| format!("save to tmp failed: {e}"))?;

    // doc を drop してファイルハンドルを解放してからリネーム
    drop(doc);

    // 一時ファイルを元のパスに移動（Windows でも上書き可能）
    std::fs::rename(&tmp_path, path).map_err(|e| {
        // rename が失敗した場合は一時ファイルを削除してエラーを返す
        let _ = std::fs::remove_file(&tmp_path);
        format!("rename tmp to {path} failed: {e}")
    })?;

    eprintln!(
        "[metadata] wrote {} keys to {path} (new Info)",
        metadata.len()
    );
    Ok(())
}

// ── 圧縮プリセット ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename_all = "snake_case")]
pub enum CompressPreset {
    /// 軽め: gc=1 — 最安全
    Light,
    /// 標準: gc=2 — デフォルト推奨
    Standard,
    /// 強め: gc=3 + sanitize — Standard より削減
    Aggressive,
    /// 最大: gc=3 + sanitize + clean — CJK等では注意
    Maximum,
}

impl CompressPreset {
    /// (compress_images, gc, clean, sanitize, do_subset, merge_fonts, object_stream)
    fn to_params(&self) -> (bool, i32, bool, bool, bool, bool, bool) {
        // (compress_images, gc, clean, sanitize, do_subset)
        // MuPDF 1.28: pdf_subset_fonts の挙動変化のため、
        //   デフォルトは subset=false で安全運転。
        //   明示的に font_subset=true を指定した場合のみ実行。
        match self {
            Self::Light => (false, 1, false, false, false, false, false),
            Self::Standard => (true, 2, false, false, false, false, false), // subset はデフォルト無効
            Self::Aggressive => (true, 2, false, true, false, false, false), // 同上
            Self::Maximum => (true, 3, true, true, false, false, false),    // 同上.clean
        }
    }
}

// ── リクエスト/レスポンス型 ───────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct CompressRequest {
    pub input: String,
    pub output: String,

    #[serde(default)]
    pub preset: Option<CompressPreset>,

    /// 画像を再圧縮するか (default: preset に従う)
    #[serde(default)]
    pub compress_images: Option<bool>,
    /// フォントストリームを圧縮するか (default: true)
    #[serde(default)]
    pub compress_fonts: Option<bool>,
    /// ガベージコレクションレベル 0-4 (default: preset に従う)
    #[serde(default)]
    pub garbage_level: Option<i32>,
    /// コンテンツストリームを再構築するか (default: preset に従う)
    #[serde(default)]
    pub clean: Option<bool>,
    /// ストリームを再解釈・再構築するか (default: preset に従う)
    #[serde(default)]
    pub sanitize: Option<bool>,
    /// フォントサブセット化を有効にするか (default: preset に従う)
    /// false にすると pdf_subset_fonts() をスキップする
    #[serde(default)]
    pub font_subset: Option<bool>,

    /// 全く参照されていないフォントオブジェクトを物理的に除去するか
    /// (renderパス相当の解析を行い、Resources辞書からパージする)
    //#[serde(default)]
    //pub purge_fonts: Option<bool>,

    #[serde(default)]
    pub merge_fonts: Option<bool>,

    #[serde(default)]
    pub object_stream: Option<bool>,
}

#[derive(Serialize)]
pub struct CompressResponse {
    pub ok: bool,
    pub input_bytes: u64,
    pub output_bytes: u64,
    /// 圧縮率 (0.0-1.0, 小さいほど圧縮効果大)
    pub ratio: f64,
    pub params_used: CompressParamsUsed,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Serialize)]
pub struct CompressParamsUsed {
    pub compress_images: bool,
    pub compress_fonts: bool,
    pub garbage_level: i32,
    pub clean: bool,
    pub sanitize: bool,
    pub merge_fonts: bool,
    pub object_stream: bool,
    /// 未参照フォントの除去を実行したか
    /// pdf_subset_fonts() を実行したか
    pub font_subset: bool,
    /// Type3 等でサブセット化をスキップ/制限したか
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub subset_skipped: bool,
}

// ── compress(): メイン圧縮関数 ───────────────────────────────────────────────

/// PDF を圧縮する。
///
/// Standard/Aggressive/Maximum プリセットでは pdf_subset_fonts() を実行し、
/// 使われていないフォントグリフを除去する。テキスト・アウトラインは保持。
pub fn compress(req: &CompressRequest) -> Result<CompressResponse> {
    let preset = req.preset.as_ref().unwrap_or(&CompressPreset::Standard);
    let (
        preset_ci,
        preset_gc,
        preset_clean,
        preset_sanitize,
        preset_subset,
        preset_merge_fonts,
        preset_object_stream,
    ) = preset.to_params();

    let compress_images = req.compress_images.unwrap_or(preset_ci);
    let compress_fonts = req.compress_fonts.unwrap_or(true);
    let garbage_level = req.garbage_level.unwrap_or(preset_gc);
    let clean = req.clean.unwrap_or(preset_clean);
    let sanitize = req.sanitize.unwrap_or(preset_sanitize);
    let merge_fonts = req.merge_fonts.unwrap_or(preset_merge_fonts);
    let object_stream = req.object_stream.unwrap_or(preset_object_stream);
    let do_subset = req.font_subset.unwrap_or(preset_subset);
    //let do_purge = req.purge_fonts.unwrap_or(false);
    // 処理の対象となる入力を保持する変数
    let current_input = req.input.clone();
    // 一時ファイルのパス（パージ用）
    //let temp_purge_path = format!("{}.purge.tmp", req.output);

    // 1. (オプション) 未参照リソースのパージ
    //if do_purge {
    //    execute_font_purge_pass(&current_input, &temp_purge_path)?;
    //    current_input = temp_purge_path.clone();
    //}

    let result_res: Result<CompressResponse> = if do_subset {
        // フォントサブセット化パス: font_subset::subset_and_write を呼ぶ
        let result = crate::font_subset::subset_and_write(
            &current_input,
            &req.output,
            garbage_level,
            clean,
            sanitize,
            compress_images,
            compress_fonts,
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
            input_bytes: result.input_bytes,
            output_bytes: result.output_bytes,
            ratio,
            params_used: CompressParamsUsed {
                compress_images,
                compress_fonts,
                garbage_level: result.effective_gc,
                clean: result.effective_clean,
                sanitize: result.effective_sanitize,
                font_subset: result.subset_applied,
                merge_fonts: merge_fonts,
                object_stream: object_stream,
                subset_skipped: false,
                //subset_skipped: result.fell_back || !result.subset_applied,
            },
            warning: if warnings.is_empty() {
                None
            } else {
                Some(warnings.join(" "))
            },
        })
    } else {
        // サブセット化なし: PdfWriteOptions のみで圧縮
        safe_compress_only(
            &current_input,
            &req.output,
            compress_images,
            compress_fonts,
            garbage_level,
            clean,
            sanitize,
            merge_fonts,
            object_stream,
        )
    };

    //if do_purge && std::path::Path::new(&temp_purge_path).exists() {
    // let _ = std::fs::remove_file(&temp_purge_path);
    //}

    result_res
}

// compress.rs
/*
fn execute_font_purge_pass(input: &str, output: &str) -> Result<()> {
    unsafe {
        // もし kozou_new_context で落ちるなら、ここで NULL ではなく
        // 適切なアロケータを渡しているか再確認が必要です。
        // 一旦、既存のコンテキスト作成関数を信じますが、
        // 戻り値が NULL でないことを厳格にチェックしてください。
        let ctx = kozou_new_context();
        if ctx.is_null() {
            return Err(CoreError::Internal("MuPDF context creation failed".into()));
        }

        let mut res = FfiResult::default();
        let c_input = CString::new(input).unwrap();
        let c_output = CString::new(output).unwrap();

        // 1. PDFドキュメントを読み込む (重要)
        // 引数: ctx, 入力パスのCポインタ
        let pdf = ffi::pdf_open_document(ctx, c_input.as_ptr());
        if pdf.is_null() {
            ffi::fz_drop_context(ctx);
            return Err(CoreError::Internal("Failed to open PDF for purging".into()));
        }

        purge_unused_fonts(ctx, pdf);

        // 2. 書き出しオプションの設定
        // パージした結果を temp_purge_path (c_output) に書き出す
        // ffi::pdf_write_options::default() が使えないため、
        let mut opts: ffi::pdf_write_options = std::mem::zeroed();
        opts.do_garbage = 2; // これでパージしたフォントを物理削除
        opts.do_compress = 0;
        opts.do_clean = 0; // 重要: 0
        opts.do_sanitize = 0; // 重要: 0

        // ここで物理ファイルが作成されます
        kozou_pdf_save_document(ctx, pdf, c_output.as_ptr(), &opts, &mut res);

        // 3. 後始末
        ffi::pdf_drop_document(ctx, pdf);
        ffi::fz_drop_context(ctx);

        if res.ok == 0 {
            return Err(CoreError::MuPdf(res.to_string()));
        }
    }
    Ok(())
}
*/
/*
fn execute_font_purge_pass(input: &str, output: &str) -> Result<()> {
    unsafe {
        // コンテキストの作成 (これは try/catch の外でOK)
        let ctx = kozou_new_context();
        if ctx.is_null() {
            return Err(CoreError::MuPdf("Failed to create context".into()));
        }

        let mut res = FfiResult::default();
        let c_input = CString::new(input).map_err(|e| CoreError::Internal(e.to_string()))?;
        let c_output = CString::new(output).map_err(|e| CoreError::Internal(e.to_string()))?;

        // C 側の「全部入り」関数を呼ぶ
//        kozou_pdf_purge_and_save(ctx, c_input.as_ptr(), c_output.as_ptr(), &mut res);
        ffi::kozou_pdf_render_scan_and_purge(ctx, pdf, c_output.as_ptr(), &mut res);
        // コンテキストの破棄
        ffi::fz_drop_context(ctx);

        // 結果の判定
        if res.ok == 0 {
            // ここで "cannot open..." というメッセージが返ってくるはず
            return Err(CoreError::MuPdf(res.to_string()));
        }
    }
    Ok(())
}
*/
/*
fn execute_font_purge_pass(input: &str, output: &str) -> Result<()> {
    unsafe {
        // コンテキスト作成時に NULL ではなく空文字を渡してみる（MuPDFのバージョンチェック対策）
        let ctx = kozou_new_context();

        if ctx.is_null() {
            return Err(CoreError::MuPdf("Failed to create context".into()));
        }
        ffi::fz_register_document_handlers(ctx);

        let c_input = CString::new(input).map_err(|e| CoreError::Internal(e.to_string()))?;
        let c_output = CString::new(output).map_err(|e| CoreError::Internal(e.to_string()))?;

        // ゼロ初期化ではなく、Default値を持った構造体を用意する（FfiResultなど）
        let mut res = FfiResult::default();

        let doc = ffi::fz_open_document(ctx, c_input.as_ptr());
        if doc.is_null() {
            ffi::fz_drop_context(ctx);
            return Err(CoreError::MuPdf("Failed to open document".into()));
        }

        let pdf = ffi::pdf_document_from_fz_document(ctx, doc);
        if pdf.is_null() {
            ffi::fz_drop_document(ctx, doc);
            ffi::fz_drop_context(ctx);
            return Err(CoreError::MuPdf("Not a PDF".into()));
        }

        // パージ実行
        kozou_pdf_purge_unused_fonts(ctx, pdf, &mut res);

        // pdf_write_options の初期化をより確実に
        // zeroed() の後に必ず default 設定関数を呼ぶ
        let mut opts: ffi::pdf_write_options = std::mem::zeroed();
        kozou_pdf_default_write_options(&mut opts);

        opts.do_garbage = 2;

        if res.ok != 0 {
             kozou_pdf_save_document(ctx, pdf, c_output.as_ptr(), &opts, &mut res);
        }

        ffi::fz_drop_document(ctx, doc);
        ffi::fz_drop_context(ctx);

        if res.ok == 0 {
            return Err(CoreError::MuPdf(res.to_string()));
        }
    }
    Ok(())
}
*/

/// サブセット化なしの通常圧縮 (Light プリセット or font_subset=false 時)
fn safe_compress_only(
    input: &str,
    output: &str,
    compress_images: bool,
    compress_fonts: bool,
    gc: i32,
    clean: bool,
    sanitize: bool,
    merge_fonts: bool,
    object_stream: bool,
) -> Result<CompressResponse> {
    use mupdf::pdf::PdfDocument;

    // メタデータを事前に収集（圧縮処理で /Info が失われる場合に備える）
    let metadata = collect_metadata(input);

    let doc = PdfDocument::open(input).map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let mut opts = mupdf::pdf::PdfWriteOptions::default();
    // MuPDF 1.28: set_compress_fonts は廃止 (compress=true で自動的にフォントも圧縮)
    opts.set_compress(true)
        .set_decompress(false)
        .set_compress_images(compress_images)
        .set_garbage_level(gc)
        .set_clean(clean)
        .set_sanitize(sanitize);

    /*
        unsafe {
            let raw_ptr = &mut opts as *mut PdfWriteOptions as *mut mupdf_sys::pdf_write_options;
            enable_objstms(raw_ptr);
        }
    */
    unsafe {
        // 1. PdfDocument は *mut pdf_document へキャスト可能なはずです
        // (NonNull<pdf_document> が唯一のフィールドであれば、構造体そのもののアドレスがそれです)
        let doc_ptr: *mut mupdf_sys::pdf_document =
            *(&doc as *const _ as *const *mut mupdf_sys::pdf_document);

        // 2. 最も重要な「コンテキスト」の取得
        // mupdf_sys ではなく、mupdf クレートが提供している context() 関数などを探してください。
        // もし見当たらない場合は、PdfDocument が開かれた際のコンテキストを共有する必要があります。
        // 多くの MuPDF ラッパーでは、fz_context はスレッドローカルかグローバルに保持されています。
        let ctx = kozou_new_context();
        if ctx.is_null() {
            return Err(CoreError::Internal("MuPDF context creation failed".into()));
        }

        if merge_fonts && !doc_ptr.is_null() && !ctx.is_null() {
            merge_duplicate_fonts(ctx, doc_ptr);
        }

        // 3. 保存オプション (Garbage 5 で重複フォントを物理削除)
        //let mut opts = PdfWriteOptions::default();
        //opts.set_garbage_level(5);
        //opts.set_compress(true);

        // Object Streams 有効化
        if object_stream {
            let raw_opts_ptr = &mut opts as *mut _ as *mut mupdf_sys::pdf_write_options;
            enable_objstms(raw_opts_ptr);
        }

        //   doc.save_with_options(output_path, opts)?;
    }

    // let mut raw_options = unsafe { std::mem::transmute::<PdfWriteOptions, mupdf_sys::pdf_write_options>(options) };
    //raw_options.do_use_objstms = 1; // これが GS の Metadata Stream: yes に相当する
    //
    doc.save_with_options(output, opts)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    // メタデータを書き戻す（gc 処理で /Info が消えた場合に復元）
    copy_metadata_after_write(output, &metadata);

    let ib = std::fs::metadata(input).map(|m| m.len()).unwrap_or(0);
    let ob = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);

    Ok(CompressResponse {
        ok: true,
        input_bytes: ib,
        output_bytes: ob,
        ratio: safe_ratio(ib, ob),
        params_used: CompressParamsUsed {
            compress_images,
            compress_fonts,
            garbage_level: gc,
            clean,
            sanitize,
            merge_fonts: merge_fonts,
            object_stream: object_stream,
            font_subset: false,
            subset_skipped: false,
        },
        warning: size_increased_warning(ib, ob),
    })
}

// ── rewrite(): DocumentWriter 再描画パス (上級向け) ─────────────────────────

#[derive(Debug, Default)]
pub struct RewriteFallbackParams {
    pub garbage_level: Option<i32>,
    pub clean: bool,
    pub sanitize: bool,
    pub compress_images: Option<bool>,
    pub compress_fonts: Option<bool>,
    pub merge_fonts: Option<bool>,
    pub object_stream: Option<bool>,
}

/// DocumentWriter + page.run() による PDF 再書き出し
///
/// # 処理の優先順位
/// 1. TrueType のみ含む PDF → DocumentWriter で再描画 (高圧縮)
/// 2. Type1/CIDFont を含む PDF → font_subset FFI パス
/// 3. Type3 を含む PDF → 通常圧縮フォールバック
pub fn rewrite(
    input: &str,
    output: &str,
    options: &str,
    fallback: &RewriteFallbackParams,
) -> Result<CompressResponse> {
    use mupdf::DocumentWriter;

    let unsafe_fonts = detect_rewrite_unsafe_fonts(input);

    match unsafe_fonts {
        None => {
            // TrueType のみ — DocumentWriter + page.run()
            // メタデータを事前に収集（DocumentWriter は /Info を引き継がない）
            let metadata = collect_metadata(input);

            let doc = mupdf::Document::open(input).map_err(|e| CoreError::MuPdf(e.to_string()))?;
            let page_count = doc
                .page_count()
                .map_err(|e| CoreError::MuPdf(e.to_string()))?;
            // MuPDF 1.28: compress-fonts オプションは廃止されたので除去
            let options_filtered = filter_obsolete_options(options);
            let mut writer = DocumentWriter::new(output, "pdf", &options_filtered)
                .map_err(|e| CoreError::MuPdf(e.to_string()))?;
            let identity = mupdf::Matrix::IDENTITY;
            for i in 0..page_count {
                let page = doc
                    .load_page(i)
                    .map_err(|e| CoreError::MuPdf(e.to_string()))?;
                let bounds = page.bounds().map_err(|e| CoreError::MuPdf(e.to_string()))?;
                let dev = writer
                    .begin_page(bounds)
                    .map_err(|e| CoreError::MuPdf(e.to_string()))?;
                page.run(&dev, &identity)
                    .map_err(|e| CoreError::MuPdf(e.to_string()))?;
                writer
                    .end_page(dev)
                    .map_err(|e| CoreError::MuPdf(e.to_string()))?;
            }
            drop(writer);

            // DocumentWriter は /Info を引き継がないため、ここで書き戻す
            copy_metadata_after_write(output, &metadata);

            let ib = std::fs::metadata(input).map(|m| m.len()).unwrap_or(0);
            let ob = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
            let gc = parse_rewrite_opt_i32(options, "garbage").unwrap_or(2);
            let clean = parse_rewrite_opt_bool(options, "clean").unwrap_or(false);
            let sanitize = parse_rewrite_opt_bool(options, "sanitize").unwrap_or(false);
            let ci = parse_rewrite_opt_bool(options, "compress-images").unwrap_or(true);
            let cf = parse_rewrite_opt_bool(options, "compress-fonts").unwrap_or(true);
            let merge_fonts = parse_rewrite_opt_bool(options, "merge_fonts").unwrap_or(true);
            let object_stream = parse_rewrite_opt_bool(options, "object_stream").unwrap_or(true);

            Ok(CompressResponse {
                ok: true,
                input_bytes: ib,
                output_bytes: ob,
                ratio: safe_ratio(ib, ob),
                params_used: CompressParamsUsed {
                    compress_images: ci,
                    compress_fonts: cf,
                    garbage_level: gc,
                    clean,
                    sanitize,
                    font_subset: false,
                    subset_skipped: false,
                    merge_fonts: merge_fonts,
                    object_stream: object_stream,
                },
                warning: size_increased_warning(ib, ob),
            })
        }

        Some(reason) if !reason.contains("Type3") => {
            // Type1/CIDFont → font_subset FFI
            eprintln!("[rewrite] non-TrueType ({reason}) → font_subset FFI");
            let gc = fallback.garbage_level.unwrap_or(2);
            let merge_fonts = fallback.merge_fonts.unwrap_or(false);
            let object_stream = fallback.object_stream.unwrap_or(false);
            let result = crate::font_subset::subset_and_write(
                input,
                output,
                gc,
                fallback.clean,
                fallback.sanitize,
                fallback.compress_images.unwrap_or(true),
                fallback.compress_fonts.unwrap_or(true),
            )?;
            let ratio = safe_ratio(result.input_bytes, result.output_bytes);
            let mut warns = vec![format!(
                "{reason} のため font_subset FFI パスを使用しました。"
            )];
            if result.fell_back {
                warns.push(format!("gc={} に制限 (指定={gc})。", result.effective_gc));
            }
            if let Some(w) = size_increased_warning(result.input_bytes, result.output_bytes) {
                warns.push(w);
            }
            Ok(CompressResponse {
                ok: true,
                input_bytes: result.input_bytes,
                output_bytes: result.output_bytes,
                ratio,
                params_used: CompressParamsUsed {
                    compress_images: fallback.compress_images.unwrap_or(true),
                    compress_fonts: fallback.compress_fonts.unwrap_or(true),
                    garbage_level: result.effective_gc,
                    clean: result.effective_clean,
                    sanitize: result.effective_sanitize,
                    font_subset: result.subset_applied,
                    subset_skipped: result.fell_back,
                    merge_fonts: merge_fonts,
                    object_stream: object_stream,
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
    input: &str,
    output: &str,
    reason: Option<String>,
    p: &RewriteFallbackParams,
) -> Result<CompressResponse> {
    let gc = p.garbage_level.unwrap_or(2);
    let clean = false;
    let sanitize = false;
    let ci = p.compress_images.unwrap_or(true);
    let cf = p.compress_fonts.unwrap_or(true);
    let merge_fonts = p.merge_fonts.unwrap_or(false);
    let object_stream = p.object_stream.unwrap_or(false);
    let mut res = safe_compress_only(
        input,
        output,
        ci,
        cf,
        gc,
        clean,
        sanitize,
        merge_fonts,
        object_stream,
    )?;
    let mut warns: Vec<String> = Vec::new();
    if let Some(r) = reason {
        warns.push(format!("{r} のため通常圧縮を使用します。"));
    }
    if gc >= 3 {
        warns.push("gc=3以上はフォントサブセット統合が発生する可能性があります。".into());
    }
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
    use mupdf::{Colorspace, DocumentWriter, Matrix};

    // メタデータを事前収集
    let metadata = collect_metadata(input);

    let doc = mupdf::Document::open(input).map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let page_count = doc
        .page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let opts = "compress=yes,compress-images=yes";
    let mut writer =
        DocumentWriter::new(output, "pdf", opts).map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let scale = Matrix::new_scale(dpi / 72.0, dpi / 72.0);
    for i in 0..page_count {
        let page = doc
            .load_page(i)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        let bounds = page.bounds().map_err(|e| CoreError::MuPdf(e.to_string()))?;
        let pixmap = page
            .to_pixmap(&scale, &Colorspace::device_rgb(), false, true)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        let dev = writer
            .begin_page(bounds)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        let img_ctm = Matrix::new_scale(
            bounds.width() / pixmap.width() as f32,
            bounds.height() / pixmap.height() as f32,
        );
        let image =
            mupdf::Image::from_pixmap(&pixmap).map_err(|e| CoreError::MuPdf(e.to_string()))?;
        dev.fill_image(&image, &img_ctm, 1.0, mupdf::ColorParams::default())
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
        writer
            .end_page(dev)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    }
    drop(writer);

    // DocumentWriter は /Info を引き継がないため書き戻す
    copy_metadata_after_write(output, &metadata);

    let ib = std::fs::metadata(input).map(|m| m.len()).unwrap_or(0);
    let ob = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
    Ok(CompressResponse {
        ok: true,
        input_bytes: ib,
        output_bytes: ob,
        ratio: safe_ratio(ib, ob),
        params_used: CompressParamsUsed {
            compress_images: true,
            compress_fonts: false,
            garbage_level: 0,
            clean: false,
            sanitize: false,
            font_subset: false,
            subset_skipped: false,
            merge_fonts: false,
            object_stream: false,
        },
        warning: Some(format!(
            "ラスタライズ: {dpi}dpi 画像PDFに変換。テキスト選択・検索・コピー不可。"
        )),
    })
}

// ── ユーティリティ ────────────────────────────────────────────────────────────

fn safe_ratio(input_bytes: u64, output_bytes: u64) -> f64 {
    if input_bytes > 0 {
        output_bytes as f64 / input_bytes as f64
    } else {
        1.0
    }
}

fn size_increased_warning(ib: u64, ob: u64) -> Option<String> {
    if ob > ib {
        Some(format!(
            "サイズが増加しました ({} → {} bytes)。元ファイルの使用を推奨します。",
            ib, ob
        ))
    } else {
        None
    }
}

/// rewrite が安全に処理できないフォントを検出
pub fn detect_rewrite_unsafe_fonts(input: &str) -> Option<String> {
    use mupdf::pdf::PdfDocument;
    let pdf = PdfDocument::open(input).ok()?;
    let page_count = pdf.page_count().unwrap_or(0);
    let mut unsafe_types: Vec<String> = Vec::new();
    for page_no in 0..page_count {
        let page_obj = match pdf.find_page(page_no) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let resources = page_obj
            .get_dict_inheritable("Resources")
            .or_else(|_| page_obj.get_dict("Resources"))
            .ok()
            .flatten();
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
    if let Ok(Some(fd_raw)) = resources.get_dict("Font") {
        let fd = fd_raw.resolve().ok().flatten().unwrap_or(fd_raw);
        let len = fd.dict_len().unwrap_or(0);
        for i in 0..len as i32 {
            if let Some(fo) = fd
                .get_dict_val(i)
                .ok()
                .flatten()
                .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
            {
                let sub = fo
                    .get_dict("Subtype")
                    .ok()
                    .flatten()
                    .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                    .and_then(|o| {
                        o.as_name()
                            .ok()
                            .map(|b| String::from_utf8_lossy(b).to_string())
                    });
                match sub.as_deref() {
                    Some("TrueType") => {}
                    Some(t) => {
                        found.push(t.to_string());
                        if t == "Type0" {
                            if let Ok(Some(da)) = fo.get_dict("DescendantFonts") {
                                if let Some(d) = da
                                    .get_dict_val(0)
                                    .ok()
                                    .flatten()
                                    .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                                {
                                    let ds = d
                                        .get_dict("Subtype")
                                        .ok()
                                        .flatten()
                                        .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                                        .and_then(|o| {
                                            o.as_name()
                                                .ok()
                                                .map(|b| String::from_utf8_lossy(b).to_string())
                                        });
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
    // Form XObject 内も再帰チェック
    if let Ok(Some(xd_raw)) = resources.get_dict("XObject") {
        let xd = xd_raw.resolve().ok().flatten().unwrap_or(xd_raw);
        let len = xd.dict_len().unwrap_or(0);
        for i in 0..len as i32 {
            if let Some(xo) = xd
                .get_dict_val(i)
                .ok()
                .flatten()
                .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
            {
                let st = xo
                    .get_dict("Subtype")
                    .ok()
                    .flatten()
                    .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                    .and_then(|o| {
                        o.as_name()
                            .ok()
                            .map(|b| String::from_utf8_lossy(b).to_string())
                    });
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

/// MuPDF バージョン間で廃止されたオプションを options 文字列から取り除く。
/// MuPDF 1.28: compress-fonts は廃止 (compress=yes で自動的にフォントも圧縮される)
fn filter_obsolete_options(options: &str) -> String {
    // 廃止されたキー一覧 (MuPDF 1.28+)
    const OBSOLETE_KEYS: &[&str] = &["compress-fonts", "compress_fonts"];
    options
        .split(',')
        .map(|s| s.trim())
        .filter(|s| {
            let key = s.split('=').next().unwrap_or("").trim();
            !OBSOLETE_KEYS.contains(&key)
        })
        .collect::<Vec<_>>()
        .join(",")
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
        let resources = page_obj
            .get_dict_inheritable("Resources")
            .or_else(|_| page_obj.get_dict("Resources"))
            .ok()
            .flatten();
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
    if let Ok(Some(fd_raw)) = resources.get_dict("Font") {
        let fd = fd_raw.resolve().ok().flatten().unwrap_or(fd_raw);
        let len = fd.dict_len().unwrap_or(0);
        for i in 0..len as i32 {
            if let Some(fo) = fd
                .get_dict_val(i)
                .ok()
                .flatten()
                .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
            {
                let sub = fo
                    .get_dict("Subtype")
                    .ok()
                    .flatten()
                    .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                    .and_then(|o| {
                        o.as_name()
                            .ok()
                            .map(|b| String::from_utf8_lossy(b).to_string())
                    });
                if sub.as_deref() == Some("Type3") {
                    return true;
                }
            }
        }
    }
    if let Ok(Some(xd_raw)) = resources.get_dict("XObject") {
        let xd = xd_raw.resolve().ok().flatten().unwrap_or(xd_raw);
        let len = xd.dict_len().unwrap_or(0);
        for i in 0..len as i32 {
            if let Some(xo) = xd
                .get_dict_val(i)
                .ok()
                .flatten()
                .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
            {
                let st = xo
                    .get_dict("Subtype")
                    .ok()
                    .flatten()
                    .and_then(|o| o.resolve().ok().flatten().or(Some(o)))
                    .and_then(|o| {
                        o.as_name()
                            .ok()
                            .map(|b| String::from_utf8_lossy(b).to_string())
                    });
                if st.as_deref() == Some("Form") {
                    if let Ok(Some(ir_raw)) = xo.get_dict("Resources") {
                        let ir = ir_raw.resolve().ok().flatten().unwrap_or(ir_raw);
                        if resources_has_type3(&ir) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

pub fn parse_rewrite_opt_i32(options: &str, key: &str) -> Option<i32> {
    let kn = key.replace('-', "_");
    options
        .split(',')
        .find(|s| s.trim().split('=').next().unwrap_or("").replace('-', "_") == kn)
        .and_then(|s| s.split('=').nth(1))
        .and_then(|v| v.trim().parse().ok())
}

pub fn parse_rewrite_opt_bool(options: &str, key: &str) -> Option<bool> {
    let kn = key.replace('-', "_");
    options
        .split(',')
        .find(|s| s.trim().split('=').next().unwrap_or("").replace('-', "_") == kn)
        .and_then(|s| s.split('=').nth(1))
        .map(|v| matches!(v.trim(), "yes" | "true" | "1"))
}

// MuPDF 1.28: compress-fonts オプションは廃止 (compress=yes 時は自動的に圧縮)
pub const REWRITE_OPTIONS_DEFAULT: &str = "compress=yes,compress-images=yes,garbage=2";
