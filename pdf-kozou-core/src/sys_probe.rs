// pdf-kozou-core/src/sys_probe.rs
//
// mupdf-sys で使えるシンボルの存在確認（コンパイルのみ・実行しない）。
// font_subset.rs が使う全シンボルをここで宣言し、ビルドエラーで早期発見する。
// 本番運用前に削除またはコメントアウトする。

#[allow(dead_code)]
pub fn probe_symbols() {
    // fz_context ライフサイクル
    let _ = mupdf_sys::fz_new_context as unsafe fn(_, _, _) -> _;
    let _ = mupdf_sys::fz_drop_context as unsafe fn(_);

    // ドキュメント操作
    let _ = mupdf_sys::fz_register_document_handlers as unsafe fn(_);
    let _ = mupdf_sys::fz_open_document as unsafe fn(_, _) -> _;
    let _ = mupdf_sys::fz_drop_document as unsafe fn(_, _);
    let _ = mupdf_sys::pdf_document_from_fz_document as unsafe fn(_, _) -> _;

    // フォントサブセット化
    let _ = mupdf_sys::pdf_subset_fonts as unsafe fn(_, _, _, _);

    // 書き出し
    let _ = mupdf_sys::pdf_write_document as unsafe fn(_, _, _, _);
    let _ = mupdf_sys::fz_new_output_with_path as unsafe fn(_, _, _) -> _;
    let _ = mupdf_sys::fz_close_output as unsafe fn(_, _);
    let _ = mupdf_sys::fz_drop_output as unsafe fn(_, _);

    // バージョン確認
    let _ = mupdf_sys::FZ_VERSION;
}
