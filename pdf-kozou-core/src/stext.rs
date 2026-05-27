// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/stext.rs
//
// MuPDF stext (structured text) を使ったテキスト抽出・検索・リンク取得。
// ViewerPage のテキスト選択・検索機能のバックエンド。

use crate::error::{CoreError, Result};
extern crate mupdf_sys;
use serde::{Deserialize, Serialize};

// ── リクエスト/レスポンス型 ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct PageTextRequest {
    pub path: String,
    /// 0始まりページ番号
    pub page: i32,
    /// スケール係数（レンダリング DPI / 72.0）。座標をピクセル単位に変換するために使用
    #[serde(default = "default_scale")]
    pub scale: f32,
}

fn default_scale() -> f32 {
    1.0
}

#[derive(Debug, Serialize)]
pub struct PageTextResponse {
    pub ok: bool,
    pub page: i32,
    pub width_pt: f32,
    pub height_pt: f32,
    pub blocks: Vec<TextBlock>,
}

#[derive(Debug, Serialize)]
pub struct TextBlock {
    pub r#type: String, // "text" | "image"
    pub bbox: BBox,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lines: Vec<TextLine>,
}

#[derive(Debug, Serialize)]
pub struct TextLine {
    pub bbox: BBox,
    pub wmode: u8, // 0=水平, 1=垂直
    pub chars: Vec<TextChar>,
}

#[derive(Debug, Serialize)]
pub struct TextChar {
    pub c: String,        // Unicode 文字
    pub quad: [f32; 8],   // [ul.x, ul.y, ur.x, ur.y, ll.x, ll.y, lr.x, lr.y]
    pub size: f32,        // フォントサイズ (pt)
    pub origin: [f32; 2], // [x, y]
}

#[derive(Debug, Serialize, Clone, Copy)]
pub struct BBox {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

// ── 検索リクエスト/レスポンス ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SearchRequest {
    pub path: String,
    pub page: i32,
    pub needle: String,
    #[serde(default = "default_scale")]
    pub scale: f32,
}

#[derive(Debug, Serialize)]
pub struct SearchResponse {
    pub ok: bool,
    pub hits: Vec<SearchHit>,
}

#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub page: i32,
    pub quad: [f32; 8], // [ul.x, ul.y, ur.x, ur.y, ll.x, ll.y, lr.x, lr.y]
}

// ── リンクリクエスト/レスポンス ────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct PageLinksRequest {
    pub path: String,
    pub page: i32,
    #[serde(default = "default_scale")]
    pub scale: f32,
}

#[derive(Debug, Serialize)]
pub struct PageLinksResponse {
    pub ok: bool,
    pub links: Vec<PageLink>,
}

#[derive(Debug, Serialize)]
pub struct PageLink {
    pub bbox: BBox,
    pub uri: String,
    /// 内部リンクの場合の 0始まりページ番号
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dest_page: Option<i32>,
}

// ── 実装 ──────────────────────────────────────────────────────────────────────

/// ページの構造化テキストを取得する
///
/// stext の座標は PDF ポイント単位。scale を掛けてピクセル単位に変換する。
pub fn get_page_text(req: &PageTextRequest) -> Result<PageTextResponse> {
    use mupdf::{Document, TextPageFlags};

    let doc = Document::open(&req.path).map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let page = doc
        .load_page(req.page)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let bounds = page.bounds().map_err(|e| CoreError::MuPdf(e.to_string()))?;

    // PRESERVE_WHITESPACE: スペースを保持
    // ACCURATE_BBOXES: より正確な文字バウンディングボックス
    let flags = TextPageFlags::PRESERVE_WHITESPACE | TextPageFlags::ACCURATE_BBOXES;
    let text_page = page
        .to_text_page(flags)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let s = req.scale;
    let mut blocks = Vec::new();

    for block in text_page.blocks() {
        use mupdf::text_page::TextBlockType;
        let block_bbox = block.bounds();
        let bbox = BBox {
            x0: block_bbox.x0 * s,
            y0: block_bbox.y0 * s,
            x1: block_bbox.x1 * s,
            y1: block_bbox.y1 * s,
        };

        match block.r#type() {
            TextBlockType::Text => {
                let mut lines = Vec::new();
                for line in block.lines() {
                    let lb = line.bounds();
                    let wmode = line.wmode() as u8;
                    let mut chars = Vec::new();
                    for ch in line.chars() {
                        if let Some(c) = ch.char() {
                            let q = ch.quad();
                            let o = ch.origin();
                            chars.push(TextChar {
                                c: c.to_string(),
                                quad: [
                                    q.ul.x * s,
                                    q.ul.y * s,
                                    q.ur.x * s,
                                    q.ur.y * s,
                                    q.ll.x * s,
                                    q.ll.y * s,
                                    q.lr.x * s,
                                    q.lr.y * s,
                                ],
                                size: ch.size() * s,
                                origin: [o.x * s, o.y * s],
                            });
                        }
                    }
                    if !chars.is_empty() {
                        lines.push(TextLine {
                            bbox: BBox {
                                x0: lb.x0 * s,
                                y0: lb.y0 * s,
                                x1: lb.x1 * s,
                                y1: lb.y1 * s,
                            },
                            wmode,
                            chars,
                        });
                    }
                }
                blocks.push(TextBlock {
                    r#type: "text".into(),
                    bbox,
                    lines,
                });
            }
            TextBlockType::Image => {
                blocks.push(TextBlock {
                    r#type: "image".into(),
                    bbox,
                    lines: vec![],
                });
            }
            _ => {}
        }
    }

    Ok(PageTextResponse {
        ok: true,
        page: req.page,
        width_pt: (bounds.x1 - bounds.x0) * s,
        height_pt: (bounds.y1 - bounds.y0) * s,
        blocks,
    })
}

/// ページ内を検索してヒット座標を返す
pub fn search_page(req: &SearchRequest) -> Result<SearchResponse> {
    use mupdf::{Document, TextPageFlags};

    let doc = Document::open(&req.path).map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let page = doc
        .load_page(req.page)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let text_page = page
        .to_text_page(TextPageFlags::empty())
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let quads = text_page
        .search(&req.needle)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let s = req.scale;
    let hits = quads
        .iter()
        .map(|q| SearchHit {
            page: req.page,
            quad: [
                q.ul.x * s,
                q.ul.y * s,
                q.ur.x * s,
                q.ur.y * s,
                q.ll.x * s,
                q.ll.y * s,
                q.lr.x * s,
                q.lr.y * s,
            ],
        })
        .collect();

    Ok(SearchResponse { ok: true, hits })
}

/// ページのリンク一覧を取得する
pub fn get_page_links(req: &PageLinksRequest) -> Result<PageLinksResponse> {
    use mupdf::Document;

    let doc = Document::open(&req.path).map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let page = doc
        .load_page(req.page)
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let link_iter = page.links().map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let s = req.scale;
    let mut links = Vec::new();

    for link in link_iter {
        let b = link.bounds;
        let dest_page = link.dest.map(|d| d.loc.page_number as i32);
        links.push(PageLink {
            bbox: BBox {
                x0: b.x0 * s,
                y0: b.y0 * s,
                x1: b.x1 * s,
                y1: b.y1 * s,
            },
            uri: link.uri,
            dest_page,
        });
    }

    Ok(PageLinksResponse { ok: true, links })
}

// ── 隠しテキスト検出 ─────────────────────────────────────────────────────────

/// 透明テキスト検出の1文字分の結果
#[derive(Debug, Serialize)]
pub struct TransparentChar {
    /// Unicode 文字
    pub char: String,
    /// アルファ値 0-255（0=完全透明）
    pub alpha: u8,
    /// RGB 色 [R, G, B] 各 0-255
    pub color_rgb: [u8; 3],
    /// fz_stext_char.flags (FZ_STEXT_FILLED=16, FZ_STEXT_STROKED=32)
    /// flags=0 → Tr=3/7 invisible, flags=16 → 通常描画でalpha=0
    pub flags: i32,
    /// 検出理由:
    ///   "invisible_mode" → Tr=3 (完全不可視、描画なし)
    ///   "clip_only_mode" → Tr=7 (クリップパスのみ、塗りなし)
    ///   "transparent"    → ExtGState fill alpha=0 による透明
    pub reason: String,
    /// 文字の原点座標 [x, y] pt 単位
    pub origin: [f32; 2],
    /// 文字の四隅座標 [ul.x,ul.y, ur.x,ur.y, ll.x,ll.y, lr.x,lr.y]
    pub quad: [f32; 8],
    /// フォントサイズ pt
    pub size: f32,
}

#[derive(Debug, Serialize)]
pub struct DetectTransparentResponse {
    pub ok: bool,
    pub page: i32,
    pub hits: Vec<TransparentChar>,
}

#[derive(Debug, Deserialize)]
pub struct DetectTransparentRequest {
    pub path: String,
    /// 0始まりページ番号
    pub page: i32,
    /// この値以下の alpha を透明と見なす（0-255）。デフォルト 0 = 完全透明のみ。
    #[serde(default)]
    pub alpha_threshold: Option<u8>,
    #[serde(default)]
    pub layout_w: Option<f32>,
    #[serde(default)]
    pub layout_h: Option<f32>,
    #[serde(default)]
    pub layout_em: Option<f32>,
}

/// ページ内の透明テキストを検出する
pub fn detect_transparent_text(
    req: &DetectTransparentRequest,
) -> Result<DetectTransparentResponse> {
    use crate::ffi::{
        kozou_buffer_get_data, kozou_detect_transparent_text, kozou_drop_buffer,
        kozou_new_context, FfiResult,
    };
    use std::ffi::CString;
    use std::os::raw::c_int;

    let c_path = CString::new(req.path.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid path".into()))?;

    let alpha_threshold = req.alpha_threshold.unwrap_or(0) as c_int;
    let layout_w  = req.layout_w.unwrap_or(0.0);
    let layout_h  = req.layout_h.unwrap_or(0.0);
    let layout_em = req.layout_em.unwrap_or(0.0);

    let json_str = unsafe {
        let ctx = kozou_new_context();
        if ctx.is_null() {
            return Err(CoreError::MuPdf("kozou_new_context failed".into()));
        }

        // fz_output をバッファに向ける
        let buf = mupdf_sys::fz_new_buffer(ctx, 4096);
        if buf.is_null() {
            mupdf_sys::fz_drop_context(ctx);
            return Err(CoreError::MuPdf("fz_new_buffer failed".into()));
        }
        let out = mupdf_sys::fz_new_output_with_buffer(ctx, buf);
        if out.is_null() {
            mupdf_sys::fz_drop_buffer(ctx, buf);
            mupdf_sys::fz_drop_context(ctx);
            return Err(CoreError::MuPdf("fz_new_output_with_buffer failed".into()));
        }

        let mut res = FfiResult::default();
        kozou_detect_transparent_text(
            ctx,
            c_path.as_ptr(),
            req.page as c_int,
            layout_w,
            layout_h,
            layout_em,
            alpha_threshold,
            out,
            &mut res,
        );

        // out を閉じてバッファを確定
        mupdf_sys::fz_close_output(ctx, out);
        mupdf_sys::fz_drop_output(ctx, out);

        if res.ok == 0 {
            mupdf_sys::fz_drop_buffer(ctx, buf);
            mupdf_sys::fz_drop_context(ctx);
            return Err(CoreError::MuPdf(format!("{res}")));
        }

        // バッファから文字列を取得
        let mut data_ptr: *const u8 = std::ptr::null();
        let len = kozou_buffer_get_data(ctx, buf, &mut data_ptr);
        let s = if len > 0 && !data_ptr.is_null() {
            String::from_utf8_lossy(std::slice::from_raw_parts(data_ptr, len)).into_owned()
        } else {
            String::new()
        };

        kozou_drop_buffer(ctx, buf);
        mupdf_sys::fz_drop_context(ctx);
        s
    };

    // C層が生成した JSON をそのままパースして返す
    #[derive(serde::Deserialize)]
    struct RawHit {
        char: String,
        alpha: u8,
        color_rgb: [u8; 3],
        flags: i32,
        reason: String,
        origin: [f32; 2],
        quad: [f32; 8],
        size: f32,
    }
    #[derive(serde::Deserialize)]
    struct RawResp {
        ok: bool,
        page: i32,
        hits: Vec<RawHit>,
    }

    let raw: RawResp = serde_json::from_str(&json_str)
        .map_err(|e| CoreError::MuPdf(format!("JSON parse error: {e}\nraw: {json_str}")))?;

    Ok(DetectTransparentResponse {
        ok: raw.ok,
        page: raw.page,
        hits: raw
            .hits
            .into_iter()
            .map(|h| TransparentChar {
                char: h.char,
                alpha: h.alpha,
                color_rgb: h.color_rgb,
                flags: h.flags,
                reason: h.reason,
                origin: h.origin,
                quad: h.quad,
                size: h.size,
            })
            .collect(),
    })
}

// ── ③ 見えにくい色検出 ───────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct LowContrastChar {
    /// Unicode 文字
    pub char: String,
    /// 文字色 [R, G, B] 各 0-255
    pub color_rgb: [u8; 3],
    /// 背景色 [R, G, B] 各 0-255
    pub bg_color_rgb: [u8; 3],
    /// WCAG コントラスト比 (1.0=同色, 21.0=白黒)
    pub contrast: f32,
    /// "low_contrast" | "sanitized" | "whitespace_only"
    pub reason: String,
    /// 文字の原点座標 [x, y] pt
    pub origin: [f32; 2],
    /// 四隅座標
    pub quad: [f32; 8],
    /// フォントサイズ pt
    pub size: f32,
}

#[derive(Debug, Serialize)]
pub struct DetectLowContrastResponse {
    pub ok: bool,
    pub page: i32,
    pub hits: Vec<LowContrastChar>,
}

#[derive(Debug, Deserialize)]
pub struct DetectLowContrastRequest {
    pub path: String,
    pub page: i32,
    /// コントラスト比の閾値 (1.0〜21.0)。デフォルト 1.5。
    #[serde(default)]
    pub contrast_threshold: Option<f32>,
    #[serde(default)]
    pub layout_w: Option<f32>,
    #[serde(default)]
    pub layout_h: Option<f32>,
    #[serde(default)]
    pub layout_em: Option<f32>,
}

pub fn detect_low_contrast_text(
    req: &DetectLowContrastRequest,
) -> Result<DetectLowContrastResponse> {
    use crate::ffi::{
        kozou_buffer_get_data, kozou_detect_low_contrast_text, kozou_drop_buffer,
        kozou_new_context, FfiResult,
    };
    use std::ffi::CString;

    let c_path = CString::new(req.path.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid path".into()))?;

    let contrast_threshold = req.contrast_threshold.unwrap_or(1.5);
    let layout_w  = req.layout_w.unwrap_or(0.0);
    let layout_h  = req.layout_h.unwrap_or(0.0);
    let layout_em = req.layout_em.unwrap_or(0.0);

    let json_str = unsafe {
        let ctx = kozou_new_context();
        if ctx.is_null() {
            return Err(CoreError::MuPdf("kozou_new_context failed".into()));
        }

        let buf = mupdf_sys::fz_new_buffer(ctx, 65536);
        if buf.is_null() {
            mupdf_sys::fz_drop_context(ctx);
            return Err(CoreError::MuPdf("fz_new_buffer failed".into()));
        }
        let out = mupdf_sys::fz_new_output_with_buffer(ctx, buf);
        if out.is_null() {
            mupdf_sys::fz_drop_buffer(ctx, buf);
            mupdf_sys::fz_drop_context(ctx);
            return Err(CoreError::MuPdf("fz_new_output_with_buffer failed".into()));
        }

        let mut res = FfiResult::default();
        kozou_detect_low_contrast_text(
            ctx,
            c_path.as_ptr(),
            req.page,
            layout_w,
            layout_h,
            layout_em,
            contrast_threshold,
            out,
            &mut res,
        );

        mupdf_sys::fz_close_output(ctx, out);
        mupdf_sys::fz_drop_output(ctx, out);

        if res.ok == 0 {
            mupdf_sys::fz_drop_buffer(ctx, buf);
            mupdf_sys::fz_drop_context(ctx);
            return Err(CoreError::MuPdf(format!("{res}")));
        }

        let mut data_ptr: *const u8 = std::ptr::null();
        let len = kozou_buffer_get_data(ctx, buf, &mut data_ptr);
        let s = if len > 0 && !data_ptr.is_null() {
            String::from_utf8_lossy(std::slice::from_raw_parts(data_ptr, len)).into_owned()
        } else {
            String::new()
        };

        kozou_drop_buffer(ctx, buf);
        mupdf_sys::fz_drop_context(ctx);
        s
    };

    #[derive(serde::Deserialize)]
    struct RawHit {
        char: String,
        color_rgb: [u8; 3],
        bg_color_rgb: [u8; 3],
        contrast: f32,
        reason: String,
        origin: [f32; 2],
        quad: [f32; 8],
        size: f32,
    }
    #[derive(serde::Deserialize)]
    struct RawResp { ok: bool, page: i32, hits: Vec<RawHit> }

    let raw: RawResp = serde_json::from_str(&json_str)
        .map_err(|e| CoreError::MuPdf(format!("JSON parse error: {e}\nraw: {json_str}")))?;

    Ok(DetectLowContrastResponse {
        ok: raw.ok,
        page: raw.page,
        hits: raw.hits.into_iter().map(|h| LowContrastChar {
            char: h.char,
            color_rgb: h.color_rgb,
            bg_color_rgb: h.bg_color_rgb,
            contrast: h.contrast,
            reason: h.reason,
            origin: h.origin,
            quad: h.quad,
            size: h.size,
        }).collect(),
    })
}

// ── ④ 極小フォント検出 ───────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct TinyChar {
    pub char: String,
    /// フォントサイズ pt
    pub size: f32,
    /// 文字色 [R, G, B] 各 0-255
    pub color_rgb: [u8; 3],
    /// "tiny_font" | "sanitized" | "whitespace_only"
    pub reason: String,
    pub origin: [f32; 2],
    pub quad: [f32; 8],
}

#[derive(Debug, Serialize)]
pub struct DetectTinyResponse {
    pub ok: bool,
    pub page: i32,
    pub hits: Vec<TinyChar>,
}

#[derive(Debug, Deserialize)]
pub struct DetectTinyRequest {
    pub path: String,
    pub page: i32,
    /// サイズ閾値 pt (デフォルト 2.0)。この値以下のフォントサイズを検出。
    #[serde(default)]
    pub size_threshold: Option<f32>,
    #[serde(default)]
    pub layout_w: Option<f32>,
    #[serde(default)]
    pub layout_h: Option<f32>,
    #[serde(default)]
    pub layout_em: Option<f32>,
}

pub fn detect_tiny_text(req: &DetectTinyRequest) -> Result<DetectTinyResponse> {
    use crate::ffi::{
        kozou_buffer_get_data, kozou_detect_tiny_text, kozou_drop_buffer,
        kozou_new_context, FfiResult,
    };
    use std::ffi::CString;

    let c_path = CString::new(req.path.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid path".into()))?;

    let size_threshold = req.size_threshold.unwrap_or(2.0);

    let json_str = unsafe {
        let ctx = kozou_new_context();
        if ctx.is_null() {
            return Err(CoreError::MuPdf("kozou_new_context failed".into()));
        }
        let buf = mupdf_sys::fz_new_buffer(ctx, 65536);
        if buf.is_null() {
            mupdf_sys::fz_drop_context(ctx);
            return Err(CoreError::MuPdf("fz_new_buffer failed".into()));
        }
        let out = mupdf_sys::fz_new_output_with_buffer(ctx, buf);
        if out.is_null() {
            mupdf_sys::fz_drop_buffer(ctx, buf);
            mupdf_sys::fz_drop_context(ctx);
            return Err(CoreError::MuPdf("fz_new_output_with_buffer failed".into()));
        }

        let mut res = FfiResult::default();
        kozou_detect_tiny_text(
            ctx,
            c_path.as_ptr(),
            req.page,
            req.layout_w.unwrap_or(0.0),
            req.layout_h.unwrap_or(0.0),
            req.layout_em.unwrap_or(0.0),
            size_threshold,
            out,
            &mut res,
        );

        mupdf_sys::fz_close_output(ctx, out);
        mupdf_sys::fz_drop_output(ctx, out);

        if res.ok == 0 {
            mupdf_sys::fz_drop_buffer(ctx, buf);
            mupdf_sys::fz_drop_context(ctx);
            return Err(CoreError::MuPdf(format!("{res}")));
        }

        let mut data_ptr: *const u8 = std::ptr::null();
        let len = kozou_buffer_get_data(ctx, buf, &mut data_ptr);
        let s = if len > 0 && !data_ptr.is_null() {
            String::from_utf8_lossy(std::slice::from_raw_parts(data_ptr, len)).into_owned()
        } else {
            String::new()
        };
        kozou_drop_buffer(ctx, buf);
        mupdf_sys::fz_drop_context(ctx);
        s
    };

    #[derive(serde::Deserialize)]
    struct RawHit {
        char: String,
        size: f32,
        color_rgb: [u8; 3],
        reason: String,
        origin: [f32; 2],
        quad: [f32; 8],
    }
    #[derive(serde::Deserialize)]
    struct RawResp { ok: bool, page: i32, hits: Vec<RawHit> }

    let raw: RawResp = serde_json::from_str(&json_str)
        .map_err(|e| CoreError::MuPdf(format!("JSON parse error: {e}\nraw: {json_str}")))?;

    Ok(DetectTinyResponse {
        ok: raw.ok,
        page: raw.page,
        hits: raw.hits.into_iter().map(|h| TinyChar {
            char: h.char,
            size: h.size,
            color_rgb: h.color_rgb,
            reason: h.reason,
            origin: h.origin,
            quad: h.quad,
        }).collect(),
    })
}

// ── ⑤ 埋没テキスト検出 ───────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct BuriedChar {
    pub char: String,
    pub color_rgb: [u8; 3],
    pub size: f32,
    /// "buried" | "sanitized" | "whitespace_only"
    pub reason: String,
    pub origin: [f32; 2],
    pub quad: [f32; 8],
}

#[derive(Debug, Serialize)]
pub struct DetectBuriedResponse {
    pub ok: bool,
    pub page: i32,
    pub hits: Vec<BuriedChar>,
}

#[derive(Debug, Deserialize)]
pub struct DetectBuriedRequest {
    pub path: String,
    pub page: i32,
    /// 覆われ率の閾値 0.0〜1.0 (デフォルト 0.8)
    #[serde(default)]
    pub cover_ratio: Option<f32>,
    #[serde(default)]
    pub layout_w: Option<f32>,
    #[serde(default)]
    pub layout_h: Option<f32>,
    #[serde(default)]
    pub layout_em: Option<f32>,
}

pub fn detect_buried_text(req: &DetectBuriedRequest) -> Result<DetectBuriedResponse> {
    use crate::ffi::{
        kozou_buffer_get_data, kozou_detect_buried_text, kozou_drop_buffer,
        kozou_new_context, FfiResult,
    };
    use std::ffi::CString;

    let c_path = CString::new(req.path.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid path".into()))?;

    let json_str = unsafe {
        let ctx = kozou_new_context();
        if ctx.is_null() {
            return Err(CoreError::MuPdf("kozou_new_context failed".into()));
        }
        let buf = mupdf_sys::fz_new_buffer(ctx, 65536);
        if buf.is_null() {
            mupdf_sys::fz_drop_context(ctx);
            return Err(CoreError::MuPdf("fz_new_buffer failed".into()));
        }
        let out = mupdf_sys::fz_new_output_with_buffer(ctx, buf);
        if out.is_null() {
            mupdf_sys::fz_drop_buffer(ctx, buf);
            mupdf_sys::fz_drop_context(ctx);
            return Err(CoreError::MuPdf("fz_new_output_with_buffer failed".into()));
        }

        let mut res = FfiResult::default();
        kozou_detect_buried_text(
            ctx,
            c_path.as_ptr(),
            req.page,
            req.layout_w.unwrap_or(0.0),
            req.layout_h.unwrap_or(0.0),
            req.layout_em.unwrap_or(0.0),
            req.cover_ratio.unwrap_or(0.8),
            out,
            &mut res,
        );

        mupdf_sys::fz_close_output(ctx, out);
        mupdf_sys::fz_drop_output(ctx, out);

        if res.ok == 0 {
            mupdf_sys::fz_drop_buffer(ctx, buf);
            mupdf_sys::fz_drop_context(ctx);
            return Err(CoreError::MuPdf(format!("{res}")));
        }

        let mut data_ptr: *const u8 = std::ptr::null();
        let len = kozou_buffer_get_data(ctx, buf, &mut data_ptr);
        let s = if len > 0 && !data_ptr.is_null() {
            String::from_utf8_lossy(std::slice::from_raw_parts(data_ptr, len)).into_owned()
        } else { String::new() };
        kozou_drop_buffer(ctx, buf);
        mupdf_sys::fz_drop_context(ctx);
        s
    };

    #[derive(serde::Deserialize)]
    struct RawHit {
        char: String,
        color_rgb: [u8; 3],
        size: f32,
        reason: String,
        origin: [f32; 2],
        quad: [f32; 8],
    }
    #[derive(serde::Deserialize)]
    struct RawResp { ok: bool, page: i32, hits: Vec<RawHit> }

    let raw: RawResp = serde_json::from_str(&json_str)
        .map_err(|e| CoreError::MuPdf(format!("JSON parse error: {e}\nraw: {json_str}")))?;

    Ok(DetectBuriedResponse {
        ok: raw.ok,
        page: raw.page,
        hits: raw.hits.into_iter().map(|h| BuriedChar {
            char: h.char,
            color_rgb: h.color_rgb,
            size: h.size,
            reason: h.reason,
            origin: h.origin,
            quad: h.quad,
        }).collect(),
    })
}

// ── 隠しテキスト置き換え（試験的） ──────────────────────────────────────────

/// 置き換え対象の文字原点座標
#[derive(Debug, Deserialize)]
pub struct SanitizeOrigin {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Serialize)]
pub struct SanitizeResponse {
    pub ok: bool,
    /// 実際に置き換えた文字数（0 の場合は対象が見つからなかった）
    pub replaced: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SanitizeRequest {
    pub input: String,
    pub output: String,
    /// 置き換え対象の origin 座標リスト（detect_* の hits から収集）
    pub targets: Vec<SanitizeOrigin>,
    /// 座標照合の許容距離 pt (省略時 1.0)
    #[serde(default)]
    pub tolerance: Option<f32>,
    #[serde(default)]
    pub layout_w: Option<f32>,
    #[serde(default)]
    pub layout_h: Option<f32>,
    #[serde(default)]
    pub layout_em: Option<f32>,
}

/// 隠しテキストの文字コードをスペースに置き換える（試験的）。
///
/// ⚠ この機能は試験的です。全ての隠しテキスト手法を網羅できる保証はなく、
///   本機能の使用による損害について開発者は責任を負いません。
pub fn sanitize_hidden_text(req: &SanitizeRequest) -> Result<SanitizeResponse> {
    use crate::ffi::{kozou_new_context, kozou_sanitize_hidden_text, FfiResult};
    use std::ffi::CString;

    if req.targets.is_empty() {
        return Ok(SanitizeResponse {
            ok: true,
            replaced: 0,
            warning: Some("no targets specified".into()),
        });
    }

    let c_input = CString::new(req.input.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid input path".into()))?;
    let c_output = CString::new(req.output.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid output path".into()))?;

    // origin 座標を [x0,y0, x1,y1, ...] のフラット配列に変換
    let origins: Vec<f32> = req.targets.iter()
        .flat_map(|o| [o.x, o.y])
        .collect();
    let n_origins = req.targets.len() as i32;
    let tolerance = req.tolerance.unwrap_or(1.0);

    unsafe {
        let ctx = kozou_new_context();
        if ctx.is_null() {
            return Err(CoreError::MuPdf("kozou_new_context failed".into()));
        }
        let mut res = FfiResult::default();
        kozou_sanitize_hidden_text(
            ctx,
            c_input.as_ptr(),
            c_output.as_ptr(),
            req.layout_w.unwrap_or(0.0),
            req.layout_h.unwrap_or(0.0),
            req.layout_em.unwrap_or(0.0),
            origins.as_ptr(),
            n_origins,
            tolerance,
            &mut res,
        );
        mupdf_sys::fz_drop_context(ctx);
        if res.ok == 0 {
            return Err(CoreError::MuPdf(format!("{res}")));
        }
    }

    Ok(SanitizeResponse {
        ok: true,
        replaced: n_origins,  // 実際の置き換え数はC層で計上していないため目標数を返す
        warning: Some(
            "⚠ 試験的機能: 全ての隠しテキスト手法を網羅できる保証はありません。\
             本機能の使用による損害について開発者は責任を負いません。".into(),
        ),
    })
}

// ── 特殊制御文字検出 ─────────────────────────────────────────────────────────

/// 制御文字検出の1文字分の結果
#[derive(Debug, Serialize)]
pub struct ControlChar {
    /// コードポイント表記 (例: "U+200B")
    pub char: String,
    /// コードポイント十進数
    pub codepoint: u32,
    /// 分類: "zero_width" | "bidi_control" | "line_separator" | "bom_zwnbsp" | "tag_char"
    pub category: String,
    /// "control_char" | "sanitized"
    pub reason: String,
    pub origin: [f32; 2],
    pub quad: [f32; 8],
    pub size: f32,
}

#[derive(Debug, Serialize)]
pub struct DetectControlCharsResponse {
    pub ok: bool,
    pub page: i32,
    pub hits: Vec<ControlChar>,
}

#[derive(Debug, Deserialize)]
pub struct DetectControlCharsRequest {
    pub path: String,
    pub page: i32,
    #[serde(default)]
    pub layout_w: Option<f32>,
    #[serde(default)]
    pub layout_h: Option<f32>,
    #[serde(default)]
    pub layout_em: Option<f32>,
}

pub fn detect_control_chars(
    req: &DetectControlCharsRequest,
) -> Result<DetectControlCharsResponse> {
    use crate::ffi::{
        kozou_buffer_get_data, kozou_detect_control_chars, kozou_drop_buffer,
        kozou_new_context, FfiResult,
    };
    use std::ffi::CString;

    let c_path = CString::new(req.path.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid path".into()))?;

    let json_str = unsafe {
        let ctx = kozou_new_context();
        if ctx.is_null() {
            return Err(CoreError::MuPdf("kozou_new_context failed".into()));
        }
        let buf = mupdf_sys::fz_new_buffer(ctx, 65536);
        if buf.is_null() {
            mupdf_sys::fz_drop_context(ctx);
            return Err(CoreError::MuPdf("fz_new_buffer failed".into()));
        }
        let out = mupdf_sys::fz_new_output_with_buffer(ctx, buf);
        if out.is_null() {
            mupdf_sys::fz_drop_buffer(ctx, buf);
            mupdf_sys::fz_drop_context(ctx);
            return Err(CoreError::MuPdf("fz_new_output_with_buffer failed".into()));
        }

        let mut res = FfiResult::default();
        kozou_detect_control_chars(
            ctx,
            c_path.as_ptr(),
            req.page,
            req.layout_w.unwrap_or(0.0),
            req.layout_h.unwrap_or(0.0),
            req.layout_em.unwrap_or(0.0),
            out,
            &mut res,
        );

        mupdf_sys::fz_close_output(ctx, out);
        mupdf_sys::fz_drop_output(ctx, out);

        if res.ok == 0 {
            mupdf_sys::fz_drop_buffer(ctx, buf);
            mupdf_sys::fz_drop_context(ctx);
            return Err(CoreError::MuPdf(format!("{res}")));
        }

        let mut data_ptr: *const u8 = std::ptr::null();
        let len = kozou_buffer_get_data(ctx, buf, &mut data_ptr);
        let s = if len > 0 && !data_ptr.is_null() {
            String::from_utf8_lossy(std::slice::from_raw_parts(data_ptr, len)).into_owned()
        } else {
            String::new()
        };
        kozou_drop_buffer(ctx, buf);
        mupdf_sys::fz_drop_context(ctx);
        s
    };

    #[derive(serde::Deserialize)]
    struct RawHit {
        char: String,
        codepoint: u32,
        category: String,
        reason: String,
        origin: [f32; 2],
        quad: [f32; 8],
        size: f32,
    }
    #[derive(serde::Deserialize)]
    struct RawResp { ok: bool, page: i32, hits: Vec<RawHit> }

    let raw: RawResp = serde_json::from_str(&json_str)
        .map_err(|e| CoreError::MuPdf(format!("JSON parse error: {e}\nraw: {json_str}")))?;

    Ok(DetectControlCharsResponse {
        ok: raw.ok,
        page: raw.page,
        hits: raw.hits.into_iter().map(|h| ControlChar {
            char: h.char,
            codepoint: h.codepoint,
            category: h.category,
            reason: h.reason,
            origin: h.origin,
            quad: h.quad,
            size: h.size,
        }).collect(),
    })
}
