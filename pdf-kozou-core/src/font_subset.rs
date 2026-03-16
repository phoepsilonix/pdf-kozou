// pdf-kozou-core/src/font_subset.rs
//
// MuPDF unsafe FFI による フォントサブセット化 + PDF書き出し。
//
// 目的:
//   埋め込みフォントの「使われていないグリフデータ」を除去して圧縮する。
//   テキスト選択・コピー・検索・拡大縮小は完全に維持する。
//
// フォントポリシー:
//   - TrueType/CFF/Type1 (アウトライン) : pdf_subset_fonts() でグリフ削減 → 安全
//   - Type3 (手書きPDFグリフ)           : サブセット化をスキップ → 完全保護
//   - ビットマップフォント              : 変換せず埋め込みデータをそのまま保護
//   - CIDFont (日中韓フォント)          : gc=2 で未参照オブジェクト削除のみ
//
// フォールバック設計:
//   has_type3=true  → gc を min(gc, 2) に制限し、pdf_subset_fonts はスキップ
//   その他のエラー  → 通常の gc 圧縮にフォールバック

use crate::error::{CoreError, Result};

// ------------------------------------------------------------------ //
// C ラッパーの extern 宣言 (src/c/mupdf_safe.c と対応)              //
// ------------------------------------------------------------------ //

#[repr(C)]
struct FfiResult {
    ok: std::ffi::c_int,
    message: [std::ffi::c_char; 512],
}

impl FfiResult {
    fn zeroed() -> Self {
        unsafe { std::mem::zeroed() }
    }
    fn is_ok(&self) -> bool {
        self.ok != 0
    }
    fn error_message(&self) -> String {
        let cstr = unsafe { std::ffi::CStr::from_ptr(self.message.as_ptr()) };
        cstr.to_string_lossy().into_owned()
    }
    fn into_result(self) -> Result<()> {
        if self.is_ok() {
            Ok(())
        } else {
            Err(CoreError::MuPdf(self.error_message()))
        }
    }
}

extern "C" {
    fn kozou_fz_new_context() -> *mut mupdf_sys::fz_context;
    fn kozou_fz_open_document(
        ctx: *mut mupdf_sys::fz_context,
        path: *const std::ffi::c_char,
        result: *mut FfiResult,
    ) -> *mut mupdf_sys::fz_document;
    fn kozou_pdf_document_from_fz_document(
        ctx: *mut mupdf_sys::fz_context,
        doc: *mut mupdf_sys::fz_document,
        result: *mut FfiResult,
    ) -> *mut mupdf_sys::pdf_document;
    /// フォントサブセット化: 使われていないグリフデータを除去
    fn kozou_pdf_subset_fonts(
        ctx: *mut mupdf_sys::fz_context,
        pdf: *mut mupdf_sys::pdf_document,
        page_count: std::ffi::c_int,
        result: *mut FfiResult,
    );
    fn kozou_pdf_save_document(
        ctx: *mut mupdf_sys::fz_context,
        doc: *mut mupdf_sys::pdf_document,
        filename: *const std::ffi::c_char,
        opts: *const mupdf_sys::pdf_write_options,
        result: *mut FfiResult,
    );
    fn kozou_pdf_default_write_options(out: *mut mupdf_sys::pdf_write_options);
    fn kozou_pdf_count_pages(
        ctx: *mut mupdf_sys::fz_context,
        pdf_doc: *mut mupdf_sys::pdf_document,
        count_res: *mut FfiResult,
    ) -> std::ffi::c_int;

}

// ------------------------------------------------------------------ //
// 公開型                                                              //
// ------------------------------------------------------------------ //

pub struct SubsetWriteResult {
    pub input_bytes: u64,
    pub output_bytes: u64,
    /// Type3 フォント等の理由でサブセット化をスキップした
    pub fell_back: bool,
    pub has_type3: bool,
    /// 実際に適用した gc レベル
    pub effective_gc: i32,
    pub effective_clean: bool,
    pub effective_sanitize: bool,
    /// pdf_subset_fonts を実行したか
    pub subset_applied: bool,
}

// ------------------------------------------------------------------ //
// 公開 API                                                            //
// ------------------------------------------------------------------ //

/// フォントサブセット化 + PDF書き出し
///
/// # 処理フロー
/// 1. PDF を開く (fz_open_document → pdf_document_from_fz_document)
/// 2. Type3 フォント検出
/// 3. Type3 なし → pdf_subset_fonts() で不要グリフを除去
///    Type3 あり → サブセット化をスキップ (安全を優先)
/// 4. pdf_save_document() で gc + compress オプション付きで書き出し
///
/// # 保護される内容
/// - アウトラインフォント (TrueType/CFF) の形状データ
/// - テキストレイヤー (選択・コピー・検索)
/// - 拡大縮小時の品質
/// - ビットマップ画像
pub fn subset_and_write(
    input: &str,
    output: &str,
    gc: i32,
    clean: bool,
    sanitize: bool,
    compress_images: bool,
    compress_fonts: bool,
) -> Result<SubsetWriteResult> {
    let has_t3 = crate::compress::has_type3_fonts(input);

    // Type3 含有時は安全側に制限
    // - gc >= 3 はフォントサブセット統合が発生する可能性
    // - sanitize はストリーム再構築で Type3 グリフを破壊する可能性
    let (effective_gc, effective_sanitize, fell_back) = if has_t3 {
        let safe_gc = gc.min(2);
        (safe_gc, false, gc > 2 || sanitize)
    } else {
        (gc, sanitize, false)
    };
    let effective_clean = clean;

    // Type3 なしの場合のみ pdf_subset_fonts を実行
    let subset_applied = !has_t3;

    unsafe {
        ffi_run(
            input,
            output,
            effective_gc,
            effective_clean,
            effective_sanitize,
            compress_images,
            compress_fonts,
            subset_applied,
        )?;
    }

    let input_bytes = std::fs::metadata(input).map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);

    Ok(SubsetWriteResult {
        input_bytes,
        output_bytes,
        fell_back,
        has_type3: has_t3,
        effective_gc,
        effective_clean,
        effective_sanitize,
        subset_applied,
    })
}

// ------------------------------------------------------------------ //
// 内部実装 (unsafe FFI)                                              //
// ------------------------------------------------------------------ //

unsafe fn ffi_run(
    input: &str,
    output: &str,
    gc: i32,
    clean: bool,
    sanitize: bool,
    compress_images: bool,
    compress_fonts: bool,
    do_subset: bool,
) -> Result<()> {
    use mupdf_sys::*;
    use std::ffi::CString;

    let input_cstr =
        CString::new(input).map_err(|_| CoreError::InvalidArg("input path: null byte".into()))?;
    let output_cstr =
        CString::new(output).map_err(|_| CoreError::InvalidArg("output path: null byte".into()))?;

    let ctx = kozou_fz_new_context();
    if ctx.is_null() {
        return Err(CoreError::MuPdf("fz_new_context failed".into()));
    }

    let result = ffi_with_ctx(
        ctx,
        &input_cstr,
        &output_cstr,
        gc,
        clean,
        sanitize,
        compress_images,
        compress_fonts,
        do_subset,
    );

    fz_drop_context(ctx);
    result
}

unsafe fn ffi_with_ctx(
    ctx: *mut mupdf_sys::fz_context,
    input_cstr: &std::ffi::CStr,
    output_cstr: &std::ffi::CStr,
    gc: i32,
    clean: bool,
    sanitize: bool,
    compress_images: bool,
    _compress_fonts: bool, // MuPDF 1.28: 廃止 (compress=yes で自動圧縮)
    do_subset: bool,
) -> Result<()> {
    use mupdf_sys::*;

    // ── fz_open_document ──────────────────────────────────────────────
    let mut res = FfiResult::zeroed();
    let fz_doc = kozou_fz_open_document(ctx, input_cstr.as_ptr(), &mut res);
    if fz_doc.is_null() || !res.is_ok() {
        return Err(CoreError::MuPdf(format!(
            "fz_open_document: {}",
            if !res.is_ok() {
                res.error_message()
            } else {
                "null".into()
            }
        )));
    }

    // ── pdf_document_from_fz_document ─────────────────────────────────
    let mut res = FfiResult::zeroed();
    let pdf_doc = kozou_pdf_document_from_fz_document(ctx, fz_doc, &mut res);
    if pdf_doc.is_null() || !res.is_ok() {
        fz_drop_document(ctx, fz_doc);
        return Err(CoreError::MuPdf(format!(
            "pdf_document_from_fz_document: {}",
            if !res.is_ok() {
                res.error_message()
            } else {
                "null".into()
            }
        )));
    }

    // ── pdf_subset_fonts (フォントグリフ除去) ─────────────────────────
    // do_subset=true の場合のみ実行 (Type3 なし、または明示的に有効化)
    if do_subset {
        // ページ数を取得して明示的なページ範囲で pdf_subset_fonts を呼ぶ
        // (MuPDF 1.28: nranges=0/NULL の全ページ指定が変化した可能性への対応)
        let mut count_res = FfiResult::zeroed();
        let page_count = kozou_pdf_count_pages(ctx, pdf_doc, &mut count_res);
        let count_to_use = if count_res.is_ok() && page_count > 0 {
            page_count
        } else {
            0 // フォールバック: C 側で nranges=0 パスに入る
        };

        let mut res = FfiResult::zeroed();
        kozou_pdf_subset_fonts(ctx, pdf_doc, count_to_use, &mut res);
        if !res.is_ok() {
            // サブセット化失敗は致命的ではない — 警告ログのみで続行
            eprintln!(
                "[font_subset] pdf_subset_fonts warning: {} — proceeding without subset",
                res.error_message()
            );
        }
    }

    // ── pdf_write_options 構築 ────────────────────────────────────────
    let mut wopts: pdf_write_options = std::mem::zeroed();
    kozou_pdf_default_write_options(&mut wopts);
    wopts.do_compress = 1;
    wopts.do_decompress = 0;
    wopts.do_compress_images = if compress_images { 1 } else { 0 };
    // do_compress_fonts: MuPDF 1.28 で削除 (compress=1 時は自動的にフォントも圧縮)
    wopts.do_garbage = gc;
    wopts.do_sanitize = if sanitize { 1 } else { 0 };
    wopts.do_clean = if clean { 1 } else { 0 };
    wopts.do_linear = 0;
    wopts.do_incremental = 0;

    // ── pdf_save_document ─────────────────────────────────────────────
    let mut res = FfiResult::zeroed();
    kozou_pdf_save_document(ctx, pdf_doc, output_cstr.as_ptr(), &wopts, &mut res);
    let write_result = res.into_result();

    fz_drop_document(ctx, fz_doc);
    write_result
}
