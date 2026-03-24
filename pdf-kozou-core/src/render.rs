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
    if metadata.is_empty() || png_bytes.len() < 33 {
        return png_bytes;
    }

    let sig_ihdr_end = 33; // 8+25

    let mut text_chunks = Vec::new();
    const PNG_TEXT_KEYS: &[(&str, &str)] = &[
        ("Title", "Title"),
        ("Author", "Author"),
        ("Subject", "Subject"),
        ("Keywords", "Keywords"),
        ("Creator", "Software"),
        ("Producer", "Comment"),
    ];

    for (meta_key, png_key) in PNG_TEXT_KEYS {
        if let Some((_, value)) = metadata.iter().find(|(k, _)| k == meta_key) {
            let chunk_data = build_png_itxt_chunk(png_key, value); // ← iTXt に変更
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

    // ── MuPDFには一時ファイルに書き出させる（名前を任せる） ─────
    let tmp_dir = std::env::temp_dir();
    //let uuid = uuid::Uuid::new_v4().simple();
    let mut temp_path = tmp_dir.join(format!("kozou_svg_temp_{}.svg", req.page_index));
    // MuPDF writerが末尾に１を勝手につけることがほとんどなので後でリネームするため。
    let temp_path_ = tmp_dir.join(format!("kozou_svg_temp_{}1.svg", req.page_index));
    let mut temp_str = temp_path.to_string_lossy().into_owned();
    let temp_str_ = temp_path_.to_string_lossy().into_owned();

    eprintln!("DEBUG: MuPDF will write to temporary file: {}", temp_str);

    // MuPDFに書き出させる
    {
        let mut writer = DocumentWriter::new(&temp_str, "svg", "text=text")
            .map_err(|e| CoreError::MuPdf(format!("svg writer: {e}")))?;

        let dev = writer
            .begin_page(*bounds)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        page.run(&dev, &mupdf::Matrix::IDENTITY)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        writer
            .end_page(dev)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;
    }

    // 少し待ってからファイルが存在するか確認
    std::thread::sleep(std::time::Duration::from_millis(100));

    if !temp_path.exists() && !temp_path_.exists() {
        return Err(CoreError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("MuPDF failed to create temporary SVG: {}", temp_str),
        )));
    }

    if !temp_path.exists() && temp_path_.exists() {
        temp_path = temp_path_.clone();
        temp_str = temp_str_.clone();
    }

    // ── 最終的な出力パスを決定 ───────────────────────────────────
    let final_path = if let Some(ref p) = req.output {
        eprintln!("DEBUG: Renaming to requested output: {}", p);
        p.clone()
    } else {
        temp_str.clone()
    };

    // リネーム実行
    if final_path != temp_str {
        if let Err(e) = std::fs::copy(&temp_path, &final_path) {
            eprintln!("Failed to copy {} -> {}: {}", temp_str, final_path, e);
            // リネーム失敗しても一時ファイルは残す
            return Err(CoreError::Io(e));
        }
        if let Err(e) = std::fs::remove_file(&temp_path) {
            eprintln!("Failed to remove {} -> {}", temp_str, e);
            // リネーム失敗しても一時ファイルは残す
            return Err(CoreError::Io(e));
        }
        eprintln!("DEBUG: Successfully renamed to: {}", final_path);
    }

    // ── メタデータ埋め込み ───────────────────────────────────────
    if !metadata.is_empty() {
        match std::fs::read_to_string(&final_path) {
            Ok(svg_str) => {
                let patched = embed_metadata_svg(svg_str, metadata);
                if let Err(e) = std::fs::write(&final_path, patched.as_bytes()) {
                    eprintln!("Metadata embed failed: {}", e);
                } else {
                    eprintln!("Metadata embedded successfully into {}", final_path);
                }
            }
            Err(e) => {
                eprintln!("Failed to read SVG for metadata: {}", e);
            }
        }
    }

    if req.output.is_some() {
        return Ok(RenderResponse {
            ok: true,
            image_b64: String::new(),
            format: "svg".to_string(),
            width_px: (page_w * req.dpi as f32 / 72.0) as u32,
            height_px: (page_h * req.dpi as f32 / 72.0) as u32,
            page_w_pt: page_w,
            page_h_pt: page_h,
            dpi: req.dpi,
            output: Some(final_path.clone()),
        });
    }

    // JSONモード時はbase64化して一時ファイルを削除
    let svg_bytes = std::fs::read(&final_path).map_err(CoreError::Io)?;
    let _ = std::fs::remove_file(&final_path);

    use base64::Engine as _;
    let image_b64 = base64::engine::general_purpose::STANDARD.encode(&svg_bytes);
    Ok(RenderResponse {
        ok: true,
        image_b64,
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
    lines.push(r#"<metadata>"#.to_string());
    lines.push(r#"  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#""#.to_string());
    lines.push(r#"           xmlns:dc="http://purl.org/dc/elements/1.1/">"#.to_string());
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

/// PNG iTXt チャンクを正しく構築（UTF-8対応 + フィールド完全）
fn build_png_itxt_chunk(keyword: &str, text: &str) -> Vec<u8> {
    let mut data: Vec<u8> = Vec::new();

    // 1. keyword (ASCIIのみ + NUL)
    data.extend_from_slice(keyword.as_bytes());
    data.push(0x00);

    // 2. compression flag (0 = uncompressed)
    data.push(0x00);

    // 3. compression method (0 = zlibなし)
    data.push(0x00);

    // 4. language tag (空 + NUL)
    data.push(0x00);

    // 5. translated keyword (空 + NUL)
    data.push(0x00);

    // 6. text (UTF-8 のまま)
    data.extend_from_slice(text.as_bytes());

    // チャンクヘッダ + CRC
    let length = data.len() as u32;
    let chunk_type = b"iTXt";
    let crc = png_crc(chunk_type, &data);

    let mut chunk = Vec::with_capacity(12 + data.len());
    chunk.extend_from_slice(&length.to_be_bytes());
    chunk.extend_from_slice(chunk_type);
    chunk.extend_from_slice(&data);
    chunk.extend_from_slice(&crc.to_be_bytes());
    chunk
}
