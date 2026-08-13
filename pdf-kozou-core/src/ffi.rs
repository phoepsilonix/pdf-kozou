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

unsafe extern "C" {
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
        page_w_pt: f32,
        page_h_pt: f32,
        auto_orient: c_int,
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

    /// ページ内の透明テキスト（alpha <= alpha_threshold）を検出して JSON を out に書く。
    /// alpha_threshold: 0=完全透明のみ, 25=10%未満も対象, など 0-255 で指定。
    /// 文字色と背景色のコントラスト比が contrast_threshold 以下の文字を検出して JSON を out に書く。
    /// contrast_threshold: 1.0〜21.0 (推奨: 1.5 = ほぼ同色のみ, 3.0 = かなり見えにくい)
    /// フォントサイズが size_threshold pt 以下の文字を検出して JSON を out に書く。
    /// size_threshold: pt 単位 (デフォルト 2.0)
    /// 後から描画された不透明オブジェクトに覆われたテキストを検出して JSON を out に書く。
    /// cover_ratio: 0.0〜1.0 (デフォルト 0.8 = 80%以上覆われていれば隠蔽)
    /// 隠しテキストの文字コードをスペースに置き換え TJ カーニングで幅を補正する（試験的）。
    /// target_origins: 対象文字の origin 座標配列 [x0,y0, x1,y1, ...] (pt)
    /// n_origins: ペア数
    /// tolerance: 座標照合の許容距離 pt (推奨 1.0)
    pub fn kozou_sanitize_hidden_text(
        ctx: *mut mupdf_sys::fz_context,
        input_path: *const c_char,
        output_path: *const c_char,
        layout_w: f32,
        layout_h: f32,
        layout_em: f32,
        target_origins: *const f32,
        n_origins: c_int,
        tolerance: f32,
        target_render_class: *const c_int,
        // 並列配列: 各ターゲットが detect_transparent_text の
        // reason=="transparent" (ExtGState ca=0) 由来かどうか
        // (1=書き換え時に実際の ca も確認する, 0=不要)。NULL 可。
        target_alpha_gate: *const c_int,
        // 0-255: ca 照合時、この値以下を「実際に透明」とみなす。
        // 検出側の alpha_threshold と同じ値を渡すこと。
        alpha_threshold: c_int,
        result: *mut FfiResult,
    );

    /// 特殊制御文字（ゼロ幅・双方向制御・タグ文字等）を検出して JSON を out に書く。
    /// N-up/製本 面付けレンダリング。複数ページを1枚のpixmapに直接レンダリングして出力。
    /// JPEG/PNG圧縮は1回のみ行うため画質劣化が最小。
    pub fn kozou_render_imposition(
        ctx: *mut mupdf_sys::fz_context,
        path: *const c_char,
        layout_w: f32,
        layout_h: f32,
        layout_em: f32,
        page_nums: *const c_int, /* cols*rows 個の配置ページ番号(1始まり,0=空白) */
        n_pages: c_int,
        cols: c_int,
        rows: c_int,
        dpi: f32,
        format: c_int,  /* 0=JPEG, 1=PNG */
        quality: c_int, /* JPEG品質 1-100 */
        gap_px: c_int,  /* セル間ギャップ px */
        out: *mut mupdf_sys::fz_output,
        result: *mut FfiResult,
    );

    pub fn kozou_rasterize_imposition(
        ctx: *mut mupdf_sys::fz_context,
        input: *const c_char,
        output: *const c_char,
        layout_w: f32,
        layout_h: f32,
        layout_em: f32,
        sheet_pages: *const c_int, /* n_sheets*cells_per_sheet 個 (1始まり,0=空白) */
        n_sheets: c_int,
        cells_per_sheet: c_int, /* = cols*rows */
        cols: c_int,
        rows: c_int,
        dpi: f32,
        quality: c_int, /* JPEG品質 1-100 */
        use_png: c_int, /* 0=JPEG, 1=PNG */
        gap_px: c_int,
        tmp_dir: *const c_char,
        result: *mut FfiResult,
    );

    pub fn kozou_split_imposition_pdf(
        ctx: *mut mupdf_sys::fz_context,
        input: *const c_char,
        output: *const c_char,
        layout_w: f32,
        layout_h: f32,
        layout_em: f32,
        cells: *const c_int, /* n_cells*3 個: (page,row,col) 連結 */
        n_cells: c_int,
        cols: c_int,
        rows: c_int,
        dpi: f32,
        quality: c_int,
        use_png: c_int,
        tmp_dir: *const c_char,
        result: *mut FfiResult,
    );

    /// ベクター保持の面付け結合（n-up / 見開き製本 / ページサイズ変更）。
    /// 各元ページを出力ページ上に再生するためテキスト/ベクターが保持される。
    /// sheet_pages: n_sheets*(cols*rows) 個（出力順, 1始まりページ番号, 0=空白）。
    pub fn kozou_compose_imposition_pdf(
        ctx: *mut mupdf_sys::fz_context,
        input: *const c_char,
        output: *const c_char,
        layout_w: f32,
        layout_h: f32,
        layout_em: f32,
        target_w: f32,
        target_h: f32,
        cols: c_int,
        rows: c_int,
        sheet_pages: *const c_int,
        n_sheets: c_int,
        gutter: f32,
        margin: f32,
        auto_orient: c_int,
        result: *mut FfiResult,
    );

    pub fn kozou_split_cell_render(
        ctx: *mut mupdf_sys::fz_context,
        input: *const c_char,
        layout_w: f32,
        layout_h: f32,
        layout_em: f32,
        page: c_int, /* 1始まり */
        cols: c_int,
        rows: c_int,
        cell_row: c_int,
        cell_col: c_int,
        dpi: f32,
        format: c_int, /* 0=JPEG, 1=PNG, 2=SVG */
        quality: c_int,
        out: *mut mupdf_sys::fz_output,
        result: *mut FfiResult,
    );

    pub fn kozou_detect_control_chars(
        ctx: *mut mupdf_sys::fz_context,
        path: *const c_char,
        page_index: c_int,
        layout_w: f32,
        layout_h: f32,
        layout_em: f32,
        out: *mut mupdf_sys::fz_output,
        result: *mut FfiResult,
    );

    pub fn kozou_collect_xobj_bboxes(
        ctx: *mut mupdf_sys::fz_context,
        path: *const std::os::raw::c_char,
        page_index: std::os::raw::c_int,
        layout_w: f32,
        layout_h: f32,
        layout_em: f32,
        out: *mut mupdf_sys::fz_output,
        result: *mut FfiResult,
    );

    pub fn kozou_detect_buried_text(
        ctx: *mut mupdf_sys::fz_context,
        path: *const c_char,
        page_index: c_int,
        layout_w: f32,
        layout_h: f32,
        layout_em: f32,
        cover_ratio: f32,
        image_alpha_threshold: f32,
        out: *mut mupdf_sys::fz_output,
        result: *mut FfiResult,
    );

    pub fn kozou_detect_tiny_text(
        ctx: *mut mupdf_sys::fz_context,
        path: *const c_char,
        page_index: c_int,
        layout_w: f32,
        layout_h: f32,
        layout_em: f32,
        size_threshold: f32,
        out: *mut mupdf_sys::fz_output,
        result: *mut FfiResult,
    );

    pub fn kozou_detect_low_contrast_text(
        ctx: *mut mupdf_sys::fz_context,
        path: *const c_char,
        page_index: c_int,
        layout_w: f32,
        layout_h: f32,
        layout_em: f32,
        contrast_threshold: f32,
        out: *mut mupdf_sys::fz_output,
        result: *mut FfiResult,
    );

    pub fn kozou_detect_transparent_text(
        ctx: *mut mupdf_sys::fz_context,
        path: *const c_char,
        page_index: c_int,
        layout_w: f32,
        layout_h: f32,
        layout_em: f32,
        alpha_threshold: c_int,
        out: *mut mupdf_sys::fz_output,
        result: *mut FfiResult,
    );

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
    /// quality: JPEG 品質 0-100 (use_png=1 のときは無視)
    /// use_png: 0=JPEG埋め込み, 1=PNG埋め込み（可逆・無劣化）
    /// tmp_dir: 一時ファイルを置く pdf-kozou 専用 temp ディレクトリのパス
    /// page_indices: 0ベースのページ番号配列。NULL の場合は全ページ対象。
    /// page_indices_len: page_indices の要素数。
    pub fn kozou_rasterize(
        ctx: *mut mupdf_sys::fz_context,
        input: *const c_char,
        output: *const c_char,
        dpi: f32,
        quality: i32,
        use_png: c_int,
        tmp_dir: *const c_char,
        page_indices: *const c_int,
        page_indices_len: c_int,
        result: *mut FfiResult,
    );

    /// kozou_rasterize と同じ入出力だが、テキスト(Type3含む)を一切描画
    /// しない背景画像を生成する。画像PDF化(フォント保持版)の Stage 1
    /// 検証用: 「非テキスト要素だけが正しく1枚の画像に焼き込まれ、
    /// テキストが除外されているか」を確認するための関数。
    /// ページのテキストはこの出力には含まれない(Stage 2 で元の
    /// コンテンツストリームと合成する前段階のため)。
    pub fn kozou_rasterize_no_text(
        ctx: *mut mupdf_sys::fz_context,
        input: *const c_char,
        output: *const c_char,
        dpi: f32,
        quality: i32,
        use_png: c_int,
        tmp_dir: *const c_char,
        page_indices: *const c_int,
        page_indices_len: c_int,
        result: *mut FfiResult,
    );

    /// 画像PDF化(フォント保持版) Stage 2。
    /// 非テキスト要素を1枚の背景画像に焼き込みつつ、ページの
    /// テキスト(Type3含む)はベクターのまま(元のフォントオブジェクトを
    /// 無変更で)残す。/Rotate!=0 のページは通常の全面ラスタライズに
    /// 自動フォールバックする(テキストは保持されない)。
    pub fn kozou_compose_image_pdf_keep_text(
        ctx: *mut mupdf_sys::fz_context,
        input: *const c_char,
        output: *const c_char,
        dpi: f32,
        quality: i32,
        use_png: c_int,
        tmp_dir: *const c_char,
        page_indices: *const c_int,
        page_indices_len: c_int,
        result: *mut FfiResult,
    );
}

/// `fz_new_context()` で独立に作った `fz_context` は、mupdf-rs クレート
/// 自身が使う共有コンテキスト(メモリアロケータ/ロック/store/グリフキャッシュ)
/// とは完全に別物のグループになる。ところが `system-fonts`/`bundled-fonts-*`
/// のフォールバックフック実装は、内部で mupdf-rs 自身の共有コンテキスト
/// (`mupdf::context()`) を使って `fz_font` を生成するため、無関係な独立
/// コンテキストにその `fz_font` を渡す(`fz_keep_font` 等)と未定義動作になる
/// (メモリ破壊/クラッシュ/デッドロックとして顕在化し、フックを繋いだだけの
/// 前バージョンでこれが起きていた)。
///
/// `mupdf::new_context()` は mupdf-rs 自身の共有コンテキストの「クローン」
/// を返す(フックのインストールも内部で保証される)ため、この問題を起こさない。
/// 呼び出し側は従来通り `crate::ffi::kozou_new_context()` を呼ぶだけでよい。
pub fn kozou_new_context() -> *mut fz_context {
    unsafe { mupdf::new_context() }
}

/// [`kozou_new_context`] と同じ理由で、こちらのコンテキスト生成経路にも
/// `mupdf::new_context()` を使う。
pub fn kozou_fz_new_context() -> *mut fz_context {
    unsafe { mupdf::new_context() }
}
