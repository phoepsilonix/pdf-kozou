// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/convert.rs
//
// 非 PDF ファイル（EPUB, XPS, HTML, CBZ, 画像等）を PDF に変換する。
// MuPDF の DocumentWriter を使って各ページを再描画し PDF として書き出す。
//
// 対応形式（mupdf features に依存）:
//   epub, xps, cbz, html, svg,
//   jpg/jpeg/png/bmp/gif/tiff/webp（img feature）

use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};

/// MuPDF が認識・開けるファイルかどうかを確認する
///
/// Document::recognize は拡張子ベースの判定で不完全なため、
/// 実際に Document::open を試みて成功するかで判定する。
pub fn is_mupdf_supported(path: &str) -> bool {
    mupdf::Document::open(path)
        .map(|doc| doc.page_count().unwrap_or(0) > 0)
        .unwrap_or(false)
}

/// ファイルが PDF かどうかを拡張子で判定する
pub fn is_pdf(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".pdf")
}

#[derive(Debug, Deserialize)]
pub struct ConvertRequest {
    pub input: String,
    pub output: String,
}

#[derive(Serialize)]
pub struct ConvertResponse {
    pub ok: bool,
    pub page_count: i32,
    pub input_bytes: u64,
    pub output_bytes: u64,
}

/// 非 PDF ファイルを PDF に変換する
///
/// DocumentWriter で各ページをレンダリングして PDF として保存する。
/// メタデータ（タイトル等）は MuPDF が読める範囲で引き継ぐ。
pub fn convert_to_pdf(req: &ConvertRequest) -> Result<ConvertResponse> {
    use mupdf::{Document, DocumentWriter, Matrix};

    // 入力ファイルを汎用 Document として開く
    let doc =
        Document::open(&req.input).map_err(|e| CoreError::MuPdf(format!("open failed: {e}")))?;

    let page_count = doc
        .page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    if page_count == 0 {
        return Err(CoreError::InvalidArg("document has no pages".into()));
    }

    // DocumentWriter を "pdf" 形式で作成
    // オプション: compress=yes でストリームを圧縮
    let mut writer = DocumentWriter::new(&req.output, "pdf", "compress=yes")
        .map_err(|e| CoreError::MuPdf(format!("writer create failed: {e}")))?;

    for i in 0..page_count {
        let page = doc
            .load_page(i)
            .map_err(|e| CoreError::MuPdf(format!("load_page({i}) failed: {e}")))?;

        let bounds = page.bounds().map_err(|e| CoreError::MuPdf(e.to_string()))?;

        // begin_page で描画デバイスを取得
        let dev = writer
            .begin_page(bounds)
            .map_err(|e| CoreError::MuPdf(format!("begin_page({i}) failed: {e}")))?;

        // ページコンテンツを描画デバイスに流し込む
        page.run(&dev, &Matrix::IDENTITY)
            .map_err(|e| CoreError::MuPdf(format!("page.run({i}) failed: {e}")))?;

        writer
            .end_page(dev)
            .map_err(|e| CoreError::MuPdf(format!("end_page({i}) failed: {e}")))?;
    }

    // writer を drop することで PDF ファイルが確定（fz_close_document_writer）
    drop(writer);

    // メタデータを引き継ぐ（変換前の元ファイルから取得済み）
    // collect_metadata は mupdf::Document::open（汎用）を使うため
    // PDF・EPUB・DOCX 等どの形式でも取得可能
    let metadata = crate::compress::collect_metadata(&req.input);
    if !metadata.is_empty() {
        crate::compress::copy_metadata_after_write(&req.output, &metadata);
    }

    let input_bytes = std::fs::metadata(&req.input).map(|m| m.len()).unwrap_or(0);
    let output_bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);

    Ok(ConvertResponse {
        ok: true,
        page_count,
        input_bytes,
        output_bytes,
    })
}
