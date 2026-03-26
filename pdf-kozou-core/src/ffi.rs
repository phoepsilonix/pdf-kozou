// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/ffi.rs
use mupdf_sys;
use mupdf_sys::fz_context;
use mupdf_sys::pdf_document;

use std::ffi::c_int;

use std::fmt;
use std::os::raw::c_char;

#[repr(C)]
pub struct FfiResult {
    pub ok: i32,
    pub message: [u8; 512],
}

impl Default for FfiResult {
    fn default() -> Self {
        Self {
            ok: 0,
            message: [0; 512],
        }
    }
}

impl fmt::Display for FfiResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let msg = unsafe {
            // Cのヌル終端文字列としてパース
            std::ffi::CStr::from_ptr(self.message.as_ptr() as *const std::os::raw::c_char)
                .to_string_lossy()
        };
        write!(f, "{}", msg)
    }
}

extern "C" {
    pub fn kozou_new_context() -> *mut mupdf_sys::fz_context;

    pub fn merge_duplicate_fonts(ctx: *mut fz_context, doc: *mut pdf_document);

    pub fn enable_objstms(opts: *mut mupdf_sys::pdf_write_options);

    pub fn purge_unused_fonts(ctx: *mut fz_context, pdf: *mut pdf_document) -> c_int;

    pub fn kozou_pdf_render_scan_and_save(
        ctx: *mut fz_context,
        input: *const c_char,
        output: *const c_char,
        res: *mut FfiResult,
    );

    pub fn kozou_pdf_purge_and_save(
        ctx: *mut mupdf_sys::fz_context,
        input: *const std::os::raw::c_char,
        output: *const std::os::raw::c_char,
        result: *mut FfiResult,
    );

    pub fn kozou_pdf_purge_unused_fonts(
        ctx: *mut mupdf_sys::fz_context,
        pdf: *mut mupdf_sys::pdf_document,
        result: *mut FfiResult,
    );

    pub fn kozou_pdf_default_write_options(opts: *mut mupdf_sys::pdf_write_options);

    pub fn kozou_pdf_save_document(
        ctx: *mut mupdf_sys::fz_context,
        doc: *mut mupdf_sys::pdf_document,
        filename: *const c_char,
        opts: *const mupdf_sys::pdf_write_options,
        result: *mut FfiResult,
    );

    /// mutool convert 相当のフローで非 PDF を PDF に変換する。
    /// fz_layout_document を呼んでから pdf_page_write + fz_run_page で変換し
    /// gc=4 付きで保存する。DocumentWriter 方式より小さいファイルを生成する。
    pub fn kozou_convert_to_pdf(
        ctx: *mut mupdf_sys::fz_context,
        input: *const c_char,
        output: *const c_char,
        layout_w: f32,
        layout_h: f32,
        layout_em: f32,
        result: *mut FfiResult,
    );

    /// Type3 フォントを保持しながら PDF を圧縮する。
    /// pdf_graft_mapped_object で全オブジェクト（CharProcs 含む）を移植し
    /// gc=0-2 で保存する（gc>=3 は Type3 破壊リスクがあるため使用しない）。
    pub fn kozou_compress_preserving_type3(
        ctx: *mut mupdf_sys::fz_context,
        input: *const c_char,
        output: *const c_char,
        gc: c_int,
        compress: c_int,
        compress_images: c_int,
        clip_to_cropbox: c_int,
        result: *mut FfiResult,
    );

    /// Type3 フォントを含む PDF でも動作する（fz_new_draw_device でラスタライズ）。
    /// quality: JPEG 品質 0-100 (0 = デフォルト 85)
    pub fn kozou_rasterize(
        ctx: *mut mupdf_sys::fz_context,
        input: *const c_char,
        output: *const c_char,
        dpi: f32,
        quality: i32,
        result: *mut FfiResult,
    );
}
