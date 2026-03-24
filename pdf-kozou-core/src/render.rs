// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/render.rs
// ページレンダリング (JPEG / PNG / SVG 対応)

use crate::error::{CoreError, Result};
use crate::pixmap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct RenderRequest {
    pub path: String,
    pub page_index: i32,
    pub dpi: u32,
    /// "jpeg" / "png" / "svg"
    pub format: Option<String>,
    pub quality: Option<u8>,
    pub output: Option<String>,
}

#[derive(Serialize)]
pub struct RenderResponse {
    pub ok: bool,
    pub image_b64: String,
    pub format: String,
    pub width_px: u32,
    pub height_px: u32,
    pub page_w_pt: f32,
    pub page_h_pt: f32,
    pub dpi: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

pub fn render(req: &RenderRequest) -> Result<RenderResponse> {
    let doc = mupdf::Document::open(&req.path).map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let page = doc
        .load_page(req.page_index)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let bounds = page.bounds().map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let format = req.format.as_deref().unwrap_or("jpeg");
    let quality = req.quality.unwrap_or(85);

    // PDF メタデータを収集（画像への埋め込み用）
    let metadata = crate::compress::collect_metadata(&req.path);

    if format == "svg" {
        return render_svg(req, &page, &bounds, &metadata);
    }

    let scale = req.dpi as f32 / 72.0;
    let matrix = mupdf::Matrix::new_scale(scale, scale);
    let pm = page
        .to_pixmap(&matrix, &mupdf::Colorspace::device_rgb(), false, false)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let image_bytes_raw: Vec<u8> = match format {
        "png" => pixmap::pixmap_to_png(&pm)?,
        _ => pixmap::pixmap_to_jpeg(&pm, quality)?,
    };

    // メタデータを画像バイト列に埋め込む
    let image_bytes = match format {
        "png" => embed_metadata_png(image_bytes_raw, &metadata),
        _ => embed_metadata_jpeg(image_bytes_raw, &metadata),
    };

    if let Some(out_path) = &req.output {
        std::fs::write(out_path, &image_bytes)?;
        return Ok(RenderResponse {
            ok: true,
            image_b64: String::new(),
            format: format.to_string(),
            width_px: pm.width(),
            height_px: pm.height(),
            page_w_pt: bounds.x1 - bounds.x0,
            page_h_pt: bounds.y1 - bounds.y0,
            dpi: req.dpi,
            output: Some(out_path.clone()),
        });
    }

    use base64::Engine as _;
    let image_b64 = base64::engine::general_purpose::STANDARD.encode(&image_bytes);
    Ok(RenderResponse {
        ok: true,
        image_b64,
        format: format.to_string(),
        width_px: pm.width(),
        height_px: pm.height(),
        page_w_pt: bounds.x1 - bounds.x0,
        page_h_pt: bounds.y1 - bounds.y0,
        dpi: req.dpi,
        output: None,
    })
}

// ── JPEG メタデータ埋め込み ─────────────────────────────────────────────────
//
// JPEG の構造: SOI(FF D8) | APP0(FF E0) | ... | SOS(FF DA) | データ | EOI
// メタデータは JPEG COM セグメント (FF FE) として SOI の直後に挿入する。
// COM セグメント: FF FE | length_hi | length_lo | data...
// length はセグメント長 (length フィールド自身の2バイト + データ長)
//
// 引き継ぐキー: Title, Author, Subject, Keywords, Creator, Producer
fn embed_metadata_jpeg(jpeg_bytes: Vec<u8>, metadata: &[(String, String)]) -> Vec<u8> {
    if metadata.is_empty() || jpeg_bytes.len() < 2 {
        return jpeg_bytes;
    }
    // メタデータをテキスト形式にまとめる
    let comment = build_metadata_comment(metadata);
    if comment.is_empty() {
        return jpeg_bytes;
    }
    let comment_bytes = comment.as_bytes();
    // COM セグメントを構築: FF FE | length(2) | data
    let seg_len = (comment_bytes.len() + 2) as u16; // length フィールド含む
    let mut com_seg = Vec::with_capacity(4 + comment_bytes.len());
    com_seg.push(0xFF);
    com_seg.push(0xFE);
    com_seg.push((seg_len >> 8) as u8);
    com_seg.push((seg_len & 0xFF) as u8);
    com_seg.extend_from_slice(comment_bytes);

    // SOI (2バイト) の直後に COM セグメントを挿入
    let mut result = Vec::with_capacity(jpeg_bytes.len() + com_seg.len());
    result.extend_from_slice(&jpeg_bytes[..2]); // SOI: FF D8
    result.extend_from_slice(&com_seg);
    result.extend_from_slice(&jpeg_bytes[2..]);
    result
}

// ── PNG メタデータ埋め込み ──────────────────────────────────────────────────
//
// PNG の tEXt チャンク: keyword + NUL + text
// keyword には ISO-8859-1 の制約があるため ASCII のみ使用
// 引き継ぐキー: Title, Author, Subject, Keywords, Creator
// tEXt チャンクを IDAT の直前に挿入する
fn embed_metadata_png(png_bytes: Vec<u8>, metadata: &[(String, String)]) -> Vec<u8> {
    if metadata.is_empty() || png_bytes.len() < 8 {
        return png_bytes;
    }

    // PNG シグネチャ (8バイト) + IHDR チャンク を先頭として保持し、
    // その後に tEXt チャンクを挿入、残りを追記する。
    // IHDR チャンクのサイズ: 4(length) + 4(type) + 13(data) + 4(CRC) = 25バイト
    let sig_ihdr_end = 8 + 4 + 4 + 13 + 4; // = 33
    if png_bytes.len() < sig_ihdr_end {
        return png_bytes;
    }

    // tEXt チャンクを各メタデータキーごとに生成
    // PNG の keyword → ISO 8859-1 キー名のマッピング
    const PNG_TEXT_KEYS: &[(&str, &str)] = &[
        ("Title", "Title"),
        ("Author", "Author"),
        ("Subject", "Subject"),
        ("Keywords", "Keywords"),
        ("Creator", "Software"), // PNG では Software キーが一般的
        ("Producer", "Comment"),
    ];

    let mut text_chunks: Vec<u8> = Vec::new();
    for (meta_key, png_key) in PNG_TEXT_KEYS {
        if let Some((_, value)) = metadata.iter().find(|(k, _)| k == meta_key) {
            let chunk_data = build_png_text_chunk(png_key, value);
            text_chunks.extend_from_slice(&chunk_data);
        }
    }

    if text_chunks.is_empty() {
        return png_bytes;
    }

    let mut result = Vec::with_capacity(png_bytes.len() + text_chunks.len());
    result.extend_from_slice(&png_bytes[..sig_ihdr_end]);
    result.extend_from_slice(&text_chunks);
    result.extend_from_slice(&png_bytes[sig_ihdr_end..]);
    result
}

/// PNG tEXt チャンクを生成する
/// 構造: length(4BE) | "tEXt"(4) | keyword + NUL + text | CRC(4)
fn build_png_text_chunk(keyword: &str, text: &str) -> Vec<u8> {
    // keyword と text を結合（NUL 区切り）
    let mut data: Vec<u8> = Vec::new();
    data.extend_from_slice(keyword.as_bytes());
    data.push(0x00); // NUL 区切り
    // text はLatin-1に収まらない文字があれば ? に置換（安全優先）
    for ch in text.chars() {
        if ch as u32 <= 0xFF {
            data.push(ch as u8);
        } else {
            data.push(b'?');
        }
    }

    let length = data.len() as u32;
    let chunk_type = b"tEXt";
    let crc = png_crc(chunk_type, &data);

    let mut chunk = Vec::with_capacity(12 + data.len());
    chunk.extend_from_slice(&length.to_be_bytes());
    chunk.extend_from_slice(chunk_type);
    chunk.extend_from_slice(&data);
    chunk.extend_from_slice(&crc.to_be_bytes());
    chunk
}

/// PNG CRC-32 計算 (チャンクタイプ + データに対して)
fn png_crc(chunk_type: &[u8], data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in chunk_type.iter().chain(data.iter()) {
        let idx = ((crc ^ byte as u32) & 0xFF) as usize;
        crc = CRC_TABLE[idx] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

/// CRC-32 テーブル (IEEE 多項式)
static CRC_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            if c & 1 != 0 {
                c = 0xEDB8_8320 ^ (c >> 1);
            } else {
                c >>= 1;
            }
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
};

// ── SVG メタデータ埋め込み ──────────────────────────────────────────────────
//
// SVG の <metadata> 要素に Dublin Core (dc:) 形式で埋め込む。
// MuPDF が生成した SVG の <svg ...> タグの直後に挿入する。
fn render_svg(
    req: &RenderRequest,
    page: &mupdf::Page,
    bounds: &mupdf::Rect,
    metadata: &[(String, String)],
) -> Result<RenderResponse> {
    use mupdf::DocumentWriter;
    let page_w = bounds.x1 - bounds.x0;
    let page_h = bounds.y1 - bounds.y0;

    // tmp ファイルに書き出してから読む
    let tmp = format!("/tmp/kozou_svg_{}.svg", std::process::id());
    let actual_out = req.output.as_deref().unwrap_or(&tmp);

    // text-as-path=yes: フォントアウトラインを完全保持
    let mut writer = DocumentWriter::new(actual_out, "svg", "text-as-path=yes")
        .map_err(|e| CoreError::MuPdf(format!("svg writer: {e}")))?;
    let dev = writer
        .begin_page(*bounds)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    page.run(&dev, &mupdf::Matrix::IDENTITY)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    writer
        .end_page(dev)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    drop(writer);

    // SVG ファイルにメタデータを埋め込む
    if !metadata.is_empty() {
        if let Ok(svg_str) = std::fs::read_to_string(actual_out) {
            let patched = embed_metadata_svg(svg_str, metadata);
            let _ = std::fs::write(actual_out, patched.as_bytes());
        }
    }

    if req.output.is_some() {
        return Ok(RenderResponse {
            ok: true,
            image_b64: String::new(),
            format: "svg".into(),
            width_px: (page_w * req.dpi as f32 / 72.0) as u32,
            height_px: (page_h * req.dpi as f32 / 72.0) as u32,
            page_w_pt: page_w,
            page_h_pt: page_h,
            dpi: req.dpi,
            output: req.output.clone(),
        });
    }

    let svg_bytes = std::fs::read(&tmp).map_err(CoreError::Io)?;
    let _ = std::fs::remove_file(&tmp);
    use base64::Engine as _;
    Ok(RenderResponse {
        ok: true,
        image_b64: base64::engine::general_purpose::STANDARD.encode(&svg_bytes),
        format: "svg".into(),
        width_px: (page_w * req.dpi as f32 / 72.0) as u32,
        height_px: (page_h * req.dpi as f32 / 72.0) as u32,
        page_w_pt: page_w,
        page_h_pt: page_h,
        dpi: req.dpi,
        output: None,
    })
}

/// SVG 文字列の <svg ...> タグの直後に <metadata> ブロックを挿入する
fn embed_metadata_svg(svg: String, metadata: &[(String, String)]) -> String {
    // <svg ...> の閉じ `>` を探し、その直後に <metadata> を挿入
    // MuPDF が生成する SVG は必ず <svg で始まる
    let insert_after = if let Some(pos) = find_svg_tag_end(&svg) {
        pos
    } else {
        return svg; // SVG タグが見つからなければそのまま返す
    };

    let meta_block = build_svg_metadata(metadata);
    let mut result = String::with_capacity(svg.len() + meta_block.len());
    result.push_str(&svg[..insert_after]);
    result.push('\n');
    result.push_str(&meta_block);
    result.push_str(&svg[insert_after..]);
    result
}

/// SVG の <svg ...> タグの終端 `>` の位置（次の文字のインデックス）を返す
fn find_svg_tag_end(svg: &str) -> Option<usize> {
    // "<svg" で始まる最初のタグを探す
    let start = svg.find("<svg")?;
    let rest = &svg[start..];
    // タグの終わり `>` を探す（属性値内の `>` を避けるため状態機械で走査）
    let mut in_quote = false;
    let mut quote_char = '"';
    for (i, ch) in rest.char_indices() {
        match ch {
            '"' | '\'' if !in_quote => {
                in_quote = true;
                quote_char = ch;
            }
            c if in_quote && c == quote_char => {
                in_quote = false;
            }
            '>' if !in_quote => {
                return Some(start + i + 1);
            }
            _ => {}
        }
    }
    None
}

/// SVG <metadata> ブロックを生成する（Dublin Core 形式）
fn build_svg_metadata(metadata: &[(String, String)]) -> String {
    let mut lines = Vec::new();
    lines.push(
        r#"<metadata>"#.to_string(),
    );
    lines.push(
        r#"  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#""#.to_string(),
    );
    lines.push(
        r#"           xmlns:dc="http://purl.org/dc/elements/1.1/">"#.to_string(),
    );
    lines.push(r#"    <rdf:Description>"#.to_string());

    for (key, value) in metadata {
        let escaped = xml_escape(value);
        let dc_key = pdf_key_to_dc(key);
        if let Some(dk) = dc_key {
            lines.push(format!("      <dc:{dk}>{escaped}</dc:{dk}>"));
        }
    }

    lines.push(r#"    </rdf:Description>"#.to_string());
    lines.push(r#"  </rdf:RDF>"#.to_string());
    lines.push(r#"</metadata>"#.to_string());
    lines.join("\n")
}

/// PDF /Info キー名を Dublin Core 要素名にマッピング
fn pdf_key_to_dc(key: &str) -> Option<&'static str> {
    match key {
        "Title" => Some("title"),
        "Author" => Some("creator"),
        "Subject" => Some("description"),
        "Keywords" => Some("subject"),
        "Creator" => Some("source"),
        "Producer" => Some("publisher"),
        "CreationDate" => Some("date"),
        _ => None,
    }
}

/// XML エスケープ
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

// ── 共通: メタデータをテキストコメント形式にまとめる ────────────────────────
fn build_metadata_comment(metadata: &[(String, String)]) -> String {
    let parts: Vec<String> = metadata
        .iter()
        .filter(|(k, _)| {
            matches!(
                k.as_str(),
                "Title" | "Author" | "Subject" | "Keywords" | "Creator" | "Producer"
            )
        })
        .map(|(k, v)| format!("{k}: {v}"))
        .collect();
    parts.join("; ")
}

