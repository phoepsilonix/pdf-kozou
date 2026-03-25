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
// JPEG APP1 セグメント (FF E1) として EXIF を挿入する。
// EXIF は Windows エクスプローラ・macOS Finder・各種ビューアで
// タイトル・作者・著作権等として表示される標準フォーマット。
//
// COM セグメント (FF FE) も残してソフトウェアの互換性を確保する。
//
// 挿入順: SOI | APP1(EXIF) | COM | 元の残りデータ
fn embed_metadata_jpeg(jpeg_bytes: Vec<u8>, metadata: &[(String, String)]) -> Vec<u8> {
    if metadata.is_empty() || jpeg_bytes.len() < 2 {
        return jpeg_bytes;
    }

    // メタデータ値を取得するヘルパー
    let get = |key: &str| -> Option<&str> {
        metadata
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    };

    // COM セグメント（互換性用テキストコメント）を構築
    let comment = build_metadata_comment(metadata);
    let com_seg = if !comment.is_empty() {
        let cb = comment.as_bytes();
        let seg_len = (cb.len() + 2) as u16;
        let mut seg = Vec::with_capacity(4 + cb.len());
        seg.push(0xFF);
        seg.push(0xFE);
        seg.push((seg_len >> 8) as u8);
        seg.push((seg_len & 0xFF) as u8);
        seg.extend_from_slice(cb);
        seg
    } else {
        vec![]
    };

    // EXIF APP1 セグメントを構築
    let exif_payload = build_exif_payload(
        get("Title"),
        get("Author"),
        get("Creator"), // Software
        get("CreationDate"),
        get("ModDate"),
        get("Subject"),
        get("Keywords"),
    );

    let app1_seg = if !exif_payload.is_empty() {
        // APP1: FF E1 | length(2, BE, length フィールド自身含む) | "Exif\0\0" | TIFF
        let total_len = (exif_payload.len() + 2) as u16;
        let mut seg = Vec::with_capacity(4 + exif_payload.len());
        seg.push(0xFF);
        seg.push(0xE1);
        seg.push((total_len >> 8) as u8);
        seg.push((total_len & 0xFF) as u8);
        seg.extend_from_slice(&exif_payload);
        seg
    } else {
        vec![]
    };

    // 既存のAPP1(EXIF)とCOMを除いた残りを収集（二重挿入防止）
    let rest = skip_existing_app1_and_com(&jpeg_bytes[2..]);

    let mut result = Vec::with_capacity(2 + app1_seg.len() + com_seg.len() + rest.len());
    result.extend_from_slice(&jpeg_bytes[..2]); // SOI
    result.extend_from_slice(&app1_seg);
    result.extend_from_slice(&com_seg);
    result.extend_from_slice(rest);
    result
}

/// 既存の APP1(EXIF) と COM セグメントをスキップして残りを返す
fn skip_existing_app1_and_com(data: &[u8]) -> &[u8] {
    let mut pos = 0;
    while pos + 3 < data.len() {
        if data[pos] != 0xFF {
            break;
        }
        let marker = data[pos + 1];
        // COM (FF FE) または APP1 (FF E1) をスキップ
        if marker == 0xFE || marker == 0xE1 {
            let seg_len = ((data[pos + 2] as usize) << 8) | (data[pos + 3] as usize);
            pos += 2 + seg_len;
        } else {
            break;
        }
    }
    &data[pos..]
}

/// EXIF ペイロードを構築する（"Exif\0\0" + TIFF ヘッダ + IFD0 + Exif SubIFD）
///
/// 構造: "Exif\0\0" | TIFF-LE-header(8) | IFD0 | ExifSubIFD | value_area
/// TIFF ヘッダ: "II"(LE) | 0x002A | offset_to_IFD0(4)
///
/// Windows ファイルプロパティで表示される主要タグ:
///   IFD0:
///     0x010E ImageDescription (ASCII)  ← Title (ASCII のみ、互換性)
///     0x013B Artist            (ASCII)  ← Author
///     0x0131 Software          (ASCII)  ← Creator
///     0x8298 Copyright         (ASCII)  ← Keywords（著作権情報として転用）
///     0x0132 DateTime          (ASCII)  ← ModDate (YYYY:MM:DD HH:MM:SS)
///     0x8769 ExifIFD           (LONG)   ← Exif Sub IFD へのオフセット
///     0x9C9B XPTitle           (BYTE/UTF-16LE) ← Title（日本語対応）
///     0x9C9D XPAuthor          (BYTE/UTF-16LE) ← Author
///     0x9C9C XPComment         (BYTE/UTF-16LE) ← Subject
///     0x9C9F XPSubject         (BYTE/UTF-16LE) ← Subject
///     0x9C9E XPKeywords        (BYTE/UTF-16LE) ← Keywords
///   Exif SubIFD:
///     0x9003 DateTimeOriginal  (ASCII)  ← CreationDate
fn build_exif_payload(
    title: Option<&str>,
    artist: Option<&str>,
    software: Option<&str>,
    creation_date: Option<&str>,
    mod_date: Option<&str>,
    subject: Option<&str>,
    keywords: Option<&str>,
) -> Vec<u8> {
    // ASCII 形式タグに UTF-8 をそのまま格納（NUL終端）
    // EXIF 仕様上は ASCII 型だが UTF-8 を入れても
    // Windows・macOS・多くのビューアで読める。
    // XP タグ（UTF-16 LE）が主、こちらは補助的な格納。
    let to_ascii = |s: &str| -> Vec<u8> {
        // NUL バイトのみ除去してそのまま UTF-8 として格納
        let mut v: Vec<u8> = s.bytes().filter(|&b| b != 0).collect();
        v.push(0); // NUL 終端
        v
    };

    // UTF-16 LE 変換（XP タグ用、NUL終端）
    let to_utf16le = |s: &str| -> Vec<u8> {
        let mut v: Vec<u8> = s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        v.push(0);
        v.push(0);
        v
    };

    // PDF 日付 "D:YYYYMMDDHHmmSS..." → EXIF 日時 "YYYY:MM:DD HH:MM:SS\0"
    let to_exif_date = |s: &str| -> Vec<u8> {
        let s = if s.starts_with("D:") { &s[2..] } else { s };
        let date = if s.len() >= 14 {
            format!(
                "{}:{}:{} {}:{}:{}",
                &s[0..4],
                &s[4..6],
                &s[6..8],
                &s[8..10],
                &s[10..12],
                &s[12..14]
            )
        } else if s.len() >= 8 {
            format!("{}:{}:{} 00:00:00", &s[0..4], &s[4..6], &s[6..8])
        } else {
            return vec![];
        };
        let mut v = date.into_bytes();
        v.push(0);
        v
    };

    // ── IFD0 タグを構築 ────────────────────────────────────────────────────
    const TYPE_ASCII: u16 = 2;
    const TYPE_BYTE: u16 = 1;
    const TYPE_LONG: u16 = 4;
    const TYPE_UNDEFINED: u16 = 7; // UserComment 用

    // (tag_id, type, data)
    let mut ifd0_tags: Vec<(u16, u16, Vec<u8>)> = Vec::new();

    // 0x010E ImageDescription (UTF-8) ← Title
    // macOS Finder 詳細情報・Linux exiftool・Android ギャラリーで表示
    if let Some(v) = title {
        ifd0_tags.push((0x010E, TYPE_ASCII, to_ascii(v)));
        // Windows 用 XPTitle (UTF-16 LE)
        ifd0_tags.push((0x9C9B, TYPE_BYTE, to_utf16le(v)));
    }

    // 0x013B Artist (UTF-8) ← Author
    // macOS Finder・Android・Windows (Exif Artist) で表示
    if let Some(v) = artist {
        ifd0_tags.push((0x013B, TYPE_ASCII, to_ascii(v)));
        // Windows 用 XPAuthor (UTF-16 LE)
        ifd0_tags.push((0x9C9D, TYPE_BYTE, to_utf16le(v)));
    }

    // 0x8298 Copyright (UTF-8) ← Author を著作権者として格納
    // macOS Finder「著作権」・多くのビューアで表示
    if let Some(v) = artist {
        ifd0_tags.push((0x8298, TYPE_ASCII, to_ascii(v)));
    }

    // 0x0131 Software (UTF-8) ← Creator（作成ソフト）
    if let Some(v) = software {
        ifd0_tags.push((0x0131, TYPE_ASCII, to_ascii(v)));
    }

    // 0x0132 DateTime (ASCII) ← ModDate
    if let Some(v) = mod_date {
        let d = to_exif_date(v);
        if !d.is_empty() {
            ifd0_tags.push((0x0132, TYPE_ASCII, d));
        }
    }

    // Windows XP タグ（UTF-16 LE）
    if let Some(v) = subject {
        ifd0_tags.push((0x9C9C, TYPE_BYTE, to_utf16le(v))); // XPComment
        ifd0_tags.push((0x9C9F, TYPE_BYTE, to_utf16le(v))); // XPSubject
    }
    if let Some(v) = keywords {
        ifd0_tags.push((0x9C9E, TYPE_BYTE, to_utf16le(v))); // XPKeywords
    }

    // ExifSubIFD リンクは後で追加（オフセットが確定してから）
    // 0x8769 ExifIFD pointer を IFD0 に追加する

    // ── Exif SubIFD タグを構築 ─────────────────────────────────────────────
    let mut exif_sub_tags: Vec<(u16, u16, Vec<u8>)> = Vec::new();

    // 0x9003 DateTimeOriginal ← CreationDate
    // macOS Finder「作成日」・Android・exiftool で表示
    if let Some(v) = creation_date {
        let d = to_exif_date(v);
        if !d.is_empty() {
            exif_sub_tags.push((0x9003, TYPE_ASCII, d.clone()));
            exif_sub_tags.push((0x9004, TYPE_ASCII, d)); // DateTimeDigitized も同値
        }
    }

    // 0x9286 UserComment (UNICODE形式 UTF-16 BE) ← Subject + Keywords
    // macOS・Android・多くのビューアで日本語として表示される
    // 形式: "UNICODE\0" (8バイト識別子) + UTF-16 BE テキスト
    {
        let comment_parts: Vec<&str> = [
            subject.map(|s| ("Subject", s)),
            keywords.map(|s| ("Keywords", s)),
        ]
        .iter()
        .flatten()
        .map(|(_k, v)| *v)
        .collect();

        if !comment_parts.is_empty() {
            let combined = comment_parts.join("; ");
            // UserComment: "UNICODE\0" (8バイト) + UTF-16 BE
            let mut uc: Vec<u8> = b"UNICODE\0".to_vec();
            for unit in combined.encode_utf16() {
                uc.extend_from_slice(&unit.to_be_bytes()); // BE
            }
            exif_sub_tags.push((0x9286, TYPE_UNDEFINED, uc));
        }
    }

    let has_exif_sub = !exif_sub_tags.is_empty();

    if ifd0_tags.is_empty() && !has_exif_sub {
        return vec![];
    }

    // ExifIFD ポインタをソート前に追加（ダミー値 0、後で上書き）
    if has_exif_sub {
        ifd0_tags.push((0x8769, TYPE_LONG, vec![0, 0, 0, 0])); // ExifIFD オフセット（後で上書き）
    }

    // タグをタグ番号昇順にソート（TIFF 仕様要件）
    ifd0_tags.sort_by_key(|t| t.0);
    exif_sub_tags.sort_by_key(|t| t.0);

    // ── オフセット計算 ─────────────────────────────────────────────────────
    // TIFF ヘッダ: 8 バイト
    // IFD0: 2(count) + n*12(entries) + 4(next=0)
    // ExifSubIFD: 2(count) + m*12(entries) + 4(next=0)
    // value area: IFD0 の長い値 + ExifSubIFD の長い値

    let tiff_header_size: u32 = 8;
    let ifd0_n = ifd0_tags.len() as u32;
    let ifd0_size = 2 + ifd0_n * 12 + 4;

    let exif_sub_n = exif_sub_tags.len() as u32;
    let exif_sub_size = if has_exif_sub {
        2 + exif_sub_n * 12 + 4
    } else {
        0
    };

    let ifd0_start = tiff_header_size;
    let exif_sub_start = ifd0_start + ifd0_size;
    let value_area_start = exif_sub_start + exif_sub_size;

    // IFD0 の ExifIFD ポインタを正しいオフセットで上書き
    if has_exif_sub {
        if let Some(entry) = ifd0_tags.iter_mut().find(|(tag, _, _)| *tag == 0x8769) {
            entry.2 = exif_sub_start.to_le_bytes().to_vec();
        }
    }

    // ── IFD0 エントリを組み立て ────────────────────────────────────────────
    let mut value_area: Vec<u8> = Vec::new();
    let mut ifd0_entries: Vec<u8> = Vec::new();
    ifd0_entries.extend_from_slice(&(ifd0_n as u16).to_le_bytes());

    for (tag, typ, data) in &ifd0_tags {
        let count = data.len() as u32;
        ifd0_entries.extend_from_slice(&tag.to_le_bytes());
        ifd0_entries.extend_from_slice(&typ.to_le_bytes());
        ifd0_entries.extend_from_slice(&count.to_le_bytes());
        if data.len() <= 4 {
            let mut val = [0u8; 4];
            val[..data.len()].copy_from_slice(data);
            ifd0_entries.extend_from_slice(&val);
        } else {
            let offset = (value_area_start + value_area.len() as u32).to_le_bytes();
            ifd0_entries.extend_from_slice(&offset);
            value_area.extend_from_slice(data);
        }
    }
    ifd0_entries.extend_from_slice(&0u32.to_le_bytes()); // next IFD = 0

    // ── Exif SubIFD エントリを組み立て ────────────────────────────────────
    let mut exif_sub_entries: Vec<u8> = Vec::new();
    if has_exif_sub {
        exif_sub_entries.extend_from_slice(&(exif_sub_n as u16).to_le_bytes());
        for (tag, typ, data) in &exif_sub_tags {
            let count = data.len() as u32;
            exif_sub_entries.extend_from_slice(&tag.to_le_bytes());
            exif_sub_entries.extend_from_slice(&typ.to_le_bytes());
            exif_sub_entries.extend_from_slice(&count.to_le_bytes());
            if data.len() <= 4 {
                let mut val = [0u8; 4];
                val[..data.len()].copy_from_slice(data);
                exif_sub_entries.extend_from_slice(&val);
            } else {
                let offset = (value_area_start + value_area.len() as u32).to_le_bytes();
                exif_sub_entries.extend_from_slice(&offset);
                value_area.extend_from_slice(data);
            }
        }
        exif_sub_entries.extend_from_slice(&0u32.to_le_bytes()); // next IFD = 0
    }

    // ── TIFF ヘッダ組み立て ────────────────────────────────────────────────
    let mut tiff: Vec<u8> = Vec::new();
    tiff.extend_from_slice(b"II");
    tiff.extend_from_slice(&0x002Au16.to_le_bytes());
    tiff.extend_from_slice(&ifd0_start.to_le_bytes());
    tiff.extend_from_slice(&ifd0_entries);
    tiff.extend_from_slice(&exif_sub_entries);
    tiff.extend_from_slice(&value_area);

    // ── EXIF ペイロード = "Exif\0\0" + TIFF ──────────────────────────────
    let mut payload = Vec::with_capacity(6 + tiff.len());
    payload.extend_from_slice(b"Exif\0\0");
    payload.extend_from_slice(&tiff);
    payload
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
        //let mut writer = DocumentWriter::new(&temp_str, "svg", "text=text")
        let mut writer = DocumentWriter::new(&temp_str, "svg", "text=path")
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
