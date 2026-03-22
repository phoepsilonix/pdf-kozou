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
    //pub fn enable_objstms(opts: *mut PdfWriteOptions);

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
}
