// pdf-kozou-core/src/font_subset.rs
//
// MuPDF unsafe FFI を使った PDF 直接書き出し。
//
// fz_new_context は C ヘッダ内のマクロ (FZ_VERSION を引数に取る) のため
// Rust から直接呼べない。C ラッパー kozou_fz_new_context 経由で使う。
//
// pdf_subset_fonts は mupdf-sys 0.6.0 (MuPDF 1.27.x) に存在しない。
// フォントの最適化は pdf_save_document の do_garbage オプションに委ねる。

use crate::error::{CoreError, Result};

// ------------------------------------------------------------------ //
// C ラッパーの extern 宣言 (src/c/mupdf_safe.c と対応)              //
// ------------------------------------------------------------------ //

#[repr(C)]
struct FfiResult {
    ok:      std::ffi::c_int,
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
    /// fz_new_context マクロ (FZ_VERSION付き) を C 側で展開して呼ぶ
    fn kozou_fz_new_context() -> *mut mupdf_sys::fz_context;

    /// fz_open_document の fz_try/fz_catch ラッパー
    fn kozou_fz_open_document(
        ctx:    *mut mupdf_sys::fz_context,
        path:   *const std::ffi::c_char,
        result: *mut FfiResult,
    ) -> *mut mupdf_sys::fz_document;

    /// pdf_document_from_fz_document の fz_try/fz_catch ラッパー
    fn kozou_pdf_document_from_fz_document(
        ctx:    *mut mupdf_sys::fz_context,
        doc:    *mut mupdf_sys::fz_document,
        result: *mut FfiResult,
    ) -> *mut mupdf_sys::pdf_document;

    /// pdf_save_document の fz_try/fz_catch ラッパー
    fn kozou_pdf_save_document(
        ctx:      *mut mupdf_sys::fz_context,
        doc:      *mut mupdf_sys::pdf_document,
        filename: *const std::ffi::c_char,
        opts:     *const mupdf_sys::pdf_write_options,
        result:   *mut FfiResult,
    );

    /// pdf_default_write_options (extern static) を C 経由でコピー
    fn kozou_pdf_default_write_options(out: *mut mupdf_sys::pdf_write_options);
}

// ------------------------------------------------------------------ //
// 公開型                                                              //
// ------------------------------------------------------------------ //

pub struct SubsetWriteResult {
    pub input_bytes:        u64,
    pub output_bytes:       u64,
    pub fell_back:          bool,
    pub has_type3:          bool,
    pub effective_gc:       i32,
    pub effective_clean:    bool,
    pub effective_sanitize: bool,
}

// ------------------------------------------------------------------ //
// 公開 API                                                            //
// ------------------------------------------------------------------ //

pub fn subset_and_write(
    input:           &str,
    output:          &str,
    gc:              i32,
    clean:           bool,
    sanitize:        bool,
    compress_images: bool,
    compress_fonts:  bool,
) -> Result<SubsetWriteResult> {
    let has_t3 = crate::compress::has_type3_fonts(input);

    // Type3 含有時は安全側のパラメータに制限
    // gc>=3 や sanitize はフォント構造を壊す可能性がある
    // clean はコンテンツストリームの正規化のみなので Type3 でも許容する
    let (effective_gc, effective_sanitize, fell_back) = if has_t3 {
        let safe_gc = gc.min(2);
        (safe_gc, false, gc > 2 || sanitize)
    } else {
        (gc, sanitize, false)
    };
    let effective_clean = clean;

    unsafe {
        ffi_run(
            input, output,
            effective_gc, effective_clean, effective_sanitize,
            compress_images, compress_fonts,
        )?;
    }

    let input_bytes  = std::fs::metadata(input) .map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);

    Ok(SubsetWriteResult {
        input_bytes,
        output_bytes,
        fell_back,
        has_type3: has_t3,
        effective_gc,
        effective_clean,
        effective_sanitize,
    })
}

// ------------------------------------------------------------------ //
// 内部実装 (unsafe FFI)                                              //
// ------------------------------------------------------------------ //

unsafe fn ffi_run(
    input:           &str,
    output:          &str,
    gc:              i32,
    clean:           bool,
    sanitize:        bool,
    compress_images: bool,
    compress_fonts:  bool,
) -> Result<()> {
    use std::ffi::CString;
    use mupdf_sys::*;

    let input_cstr = CString::new(input)
        .map_err(|_| CoreError::InvalidArg("input path contains null byte".into()))?;
    let output_cstr = CString::new(output)
        .map_err(|_| CoreError::InvalidArg("output path contains null byte".into()))?;

    // C ラッパー経由で fz_new_context を呼ぶ (FZ_VERSION マクロを C 側で展開)
    let ctx = kozou_fz_new_context();
    if ctx.is_null() {
        return Err(CoreError::MuPdf("fz_new_context failed".into()));
    }

    let result = ffi_with_ctx(
        ctx, &input_cstr, &output_cstr,
        gc, clean, sanitize, compress_images, compress_fonts,
    );

    fz_drop_context(ctx);
    result
}

unsafe fn ffi_with_ctx(
    ctx:             *mut mupdf_sys::fz_context,
    input_cstr:      &std::ffi::CStr,
    output_cstr:     &std::ffi::CStr,
    gc:              i32,
    clean:           bool,
    sanitize:        bool,
    compress_images: bool,
    compress_fonts:  bool,
) -> Result<()> {
    use mupdf_sys::*;

    // --- fz_open_document (fz_register_document_handlers も C 側で呼ぶ) ---
    let mut res = FfiResult::zeroed();
    let fz_doc = kozou_fz_open_document(ctx, input_cstr.as_ptr(), &mut res);
    if fz_doc.is_null() || !res.is_ok() {
        return Err(CoreError::MuPdf(format!(
            "fz_open_document failed: {}",
            if !res.is_ok() { res.error_message() } else { "null document".into() }
        )));
    }

    // --- fz_document → pdf_document ---
    let mut res = FfiResult::zeroed();
    let pdf_doc = kozou_pdf_document_from_fz_document(ctx, fz_doc, &mut res);
    if pdf_doc.is_null() || !res.is_ok() {
        fz_drop_document(ctx, fz_doc);
        return Err(CoreError::MuPdf(format!(
            "pdf_document_from_fz_document failed: {}",
            if !res.is_ok() { res.error_message() } else { "null pdf_document".into() }
        )));
    }

    // --- pdf_write_options を構築 ---
    // pdf_default_write_options は extern static なので C 経由でコピー
    let mut wopts: pdf_write_options = std::mem::zeroed();
    kozou_pdf_default_write_options(&mut wopts);
    wopts.do_compress        = 1;
    wopts.do_decompress      = 0;
    wopts.do_compress_images = if compress_images { 1 } else { 0 };
    wopts.do_compress_fonts  = if compress_fonts  { 1 } else { 0 };
    wopts.do_garbage         = gc;
    wopts.do_sanitize        = if sanitize { 1 } else { 0 };
    wopts.do_clean           = if clean    { 1 } else { 0 };
    wopts.do_linear          = 0;
    wopts.do_incremental     = 0;

    // --- pdf_save_document ---
    let mut res = FfiResult::zeroed();
    kozou_pdf_save_document(ctx, pdf_doc, output_cstr.as_ptr(), &wopts, &mut res);
    let write_result = res.into_result();

    fz_drop_document(ctx, fz_doc);
    write_result
}
