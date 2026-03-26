// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/ffi.rs

use mupdf_sys;
use mupdf_sys::fz_context;
use mupdf_sys::pdf_document;

use std::ffi::c_char;
use std::ffi::c_int;
use std::fmt;

#[repr(C)]
pub struct FfiResult {
    pub ok: i32,
    pub message: [u8; 512],
}

impl Default for FfiResult {
    fn default() -> Self {
        FfiResult {
            ok: 0,
            message: [0u8; 512],
        }
    }
}

impl fmt::Display for FfiResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let end = self.message.iter().position(|&b| b == 0).unwrap_or(512);
        let s = String::from_utf8_lossy(&self.message[..end]);
        write!(f, "{s}")
    }
}

extern "C" {
    pub fn kozou_new_context() -> *mut fz_context;
    pub fn kozou_fz_new_context() -> *mut fz_context;

    pub fn kozou_fz_open_document(
        ctx: *mut fz_context,
        path: *const c_char,
        result: *mut FfiResult,
    ) -> *mut mupdf_sys::fz_document;

    pub fn kozou_pdf_document_from_fz_document(
        ctx: *mut fz_context,
        doc: *mut mupdf_sys::fz_document,
        result: *mut FfiResult,
    ) -> *mut pdf_document;

    pub fn kozou_pdf_subset_fonts(
        ctx: *mut fz_context,
        pdf: *mut pdf_document,
        page_count: c_int,
        result: *mut FfiResult,
    );

    pub fn kozou_pdf_save_document(
        ctx: *mut fz_context,
        pdf: *mut pdf_document,
        path: *const c_char,
        opts: *const mupdf_sys::pdf_write_options,
        result: *mut FfiResult,
    );

    pub fn kozou_pdf_default_write_options(opts: *mut mupdf_sys::pdf_write_options);

    pub fn enable_objstms(opts: *mut mupdf_sys::pdf_write_options);

    pub fn merge_duplicate_fonts(ctx: *mut fz_context, doc: *mut pdf_document);

    pub fn kozou_pdf_count_pages(
        ctx: *mut fz_context,
        pdf: *mut pdf_document,
        result: *mut FfiResult,
    ) -> c_int;

    pub fn kozou_set_pdf_info_key(
        ctx: *mut fz_context,
        pdf: *mut pdf_document,
        key: *const c_char,
        value: *const c_char,
        result: *mut FfiResult,
    );

    pub fn kozou_write_pdf_info(
        ctx: *mut fz_context,
        pdf: *mut pdf_document,
        path: *const c_char,
        gc: c_int,
        result: *mut FfiResult,
    );

    pub fn kozou_get_pdf_info_key(
        ctx: *mut fz_context,
        pdf: *mut pdf_document,
        key: *const c_char,
        buf: *mut c_char,
        buf_len: c_int,
        result: *mut FfiResult,
    ) -> c_int;

    pub fn kozou_pdf_purge_unused_fonts(
        ctx: *mut fz_context,
        pdf: *mut pdf_document,
        result: *mut FfiResult,
    );

    pub fn kozou_pdf_purge_and_save(
        ctx: *mut fz_context,
        input: *const c_char,
        output: *const c_char,
        result: *mut FfiResult,
    );

    /// mutool convert 相当のフローで非 PDF を PDF に変換する。
    pub fn kozou_convert_to_pdf(
        ctx: *mut mupdf_sys::fz_context,
        input: *const c_char,
        output: *const c_char,
        layout_w: f32,
        layout_h: f32,
        layout_em: f32,
        result: *mut FfiResult,
    );

    /// ドキュメントを開いてページ数・各ページの bounds を取得する。
    /// Rust バインディング（mupdf::Document::open）を使わないため
    /// Windows での font_kit フリーズが発生しない。
    pub fn kozou_get_doc_info(
        ctx: *mut mupdf_sys::fz_context,
        path: *const c_char,
        layout_w: f32,
        layout_h: f32,
        layout_em: f32,
        page_rects: *mut f32,
        out_page_count: *mut c_int,
        max_pages: c_int,
        result: *mut FfiResult,
    );

    /// 指定ページをレンダリングして JPEG/PNG バイト列を返す。
    /// Rust バインディング（mupdf::Document::open）を使わないため
    /// Windows での font_kit フリーズが発生しない。
    /// 戻り値の fz_buffer* は kozou_drop_buffer で解放すること。
    pub fn kozou_render_page(
        ctx: *mut mupdf_sys::fz_context,
        path: *const c_char,
        page_index: c_int,
        dpi: f32,
        layout_w: f32,
        layout_h: f32,
        layout_em: f32,
        format: c_int, /* 0=JPEG, 1=PNG */
        quality: c_int,
        out_width: *mut c_int,
        out_height: *mut c_int,
        out_page_w_pt: *mut f32,
        out_page_h_pt: *mut f32,
        result: *mut FfiResult,
    ) -> *mut mupdf_sys::fz_buffer;

    pub fn kozou_drop_buffer(ctx: *mut mupdf_sys::fz_context, buf: *mut mupdf_sys::fz_buffer);

    /// fz_buffer の内容ポインタと長さを返す
    pub fn kozou_buffer_get_data(
        ctx: *mut mupdf_sys::fz_context,
        buf: *mut mupdf_sys::fz_buffer,
        data_out: *mut *const u8,
    ) -> usize;

    /// Type3 フォントを保持しながら PDF を圧縮する。
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

    /// 各ページを DPI 指定でラスタライズして画像ページの PDF を生成する。
    /// quality: JPEG 品質 0-100
    pub fn kozou_rasterize(
        ctx: *mut mupdf_sys::fz_context,
        input: *const c_char,
        output: *const c_char,
        dpi: f32,
        quality: i32,
        result: *mut FfiResult,
    );
}
