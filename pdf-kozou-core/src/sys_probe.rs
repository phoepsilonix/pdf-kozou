// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/sys_probe.rs
// コンパイル時シンボル存在確認 (実行しない)

#[allow(dead_code)]
pub fn probe_symbols() {
    // fz_context ライフサイクル (引数4つ: alloc, locks, max_store, name)
    let _: unsafe extern "C" fn(_, _, _, _) -> _ = mupdf_sys::fz_new_context_imp;
    let _: unsafe extern "C" fn(_) = mupdf_sys::fz_drop_context;

    // ドキュメント操作
    let _: unsafe extern "C" fn(_) = mupdf_sys::fz_register_document_handlers;
    let _: unsafe extern "C" fn(_, _) -> _ = mupdf_sys::fz_open_document;
    let _: unsafe extern "C" fn(_, _) = mupdf_sys::fz_drop_document;
    let _: unsafe extern "C" fn(_, _) -> _ = mupdf_sys::pdf_document_from_fz_document;

    // フォントサブセット化
    let _: unsafe extern "C" fn(_, _, _, _) = mupdf_sys::pdf_subset_fonts;

    // 書き出し
    let _: unsafe extern "C" fn(_, _, _, _) = mupdf_sys::pdf_write_document;
    let _: unsafe extern "C" fn(_, _, _) -> _ = mupdf_sys::fz_new_output_with_path;
    let _: unsafe extern "C" fn(_, _) = mupdf_sys::fz_close_output;
    let _: unsafe extern "C" fn(_, _) = mupdf_sys::fz_drop_output;

    let _: unsafe extern "C" fn(_, _, _, _, _) -> _ = mupdf_sys::pdf_new_pdf_device;
}
