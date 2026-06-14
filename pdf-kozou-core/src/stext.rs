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
    /// Type3 フォント（無害化困難）
    #[serde(default)]
    pub is_type3: bool,
    #[serde(default)]
    pub xobj_xref: i32,
    #[serde(default)]
    pub internal_origin: [f32; 2],
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
        FfiResult, kozou_buffer_get_data, kozou_detect_transparent_text, kozou_drop_buffer,
        kozou_new_context,
    };
    use std::ffi::CString;
    use std::os::raw::c_int;

    let c_path = CString::new(req.path.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid path".into()))?;

    let alpha_threshold = req.alpha_threshold.unwrap_or(0) as c_int;
    let layout_w = req.layout_w.unwrap_or(0.0);
    let layout_h = req.layout_h.unwrap_or(0.0);
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
        #[serde(default)]
        is_type3: bool,
        #[serde(default)]
        xobj_xref: i32,
        #[serde(default)]
        internal_origin: [f32; 2],
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
                is_type3: h.is_type3,
                xobj_xref: h.xobj_xref,
                internal_origin: h.internal_origin,
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
    /// 知覚色差 ΔE76 (0=同色, 大きいほど見える)。第2レイヤー/確信度表示用
    #[serde(default)]
    pub delta_e: f32,
    /// "low_contrast" | "sanitized" | "whitespace_only"
    pub reason: String,
    /// 文字の原点座標 [x, y] pt
    pub origin: [f32; 2],
    /// 四隅座標
    pub quad: [f32; 8],
    /// フォントサイズ pt
    pub size: f32,
    /// Type3 フォント（無害化困難）
    #[serde(default)]
    pub is_type3: bool,
    #[serde(default)]
    pub xobj_xref: i32,
    #[serde(default)]
    pub internal_origin: [f32; 2],
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
        FfiResult, kozou_buffer_get_data, kozou_detect_low_contrast_text, kozou_drop_buffer,
        kozou_new_context,
    };
    use std::ffi::CString;

    let c_path = CString::new(req.path.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid path".into()))?;

    let contrast_threshold = req.contrast_threshold.unwrap_or(1.5);
    let layout_w = req.layout_w.unwrap_or(0.0);
    let layout_h = req.layout_h.unwrap_or(0.0);
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
        #[serde(default)]
        delta_e: f32,
        reason: String,
        origin: [f32; 2],
        quad: [f32; 8],
        size: f32,
        #[serde(default)]
        is_type3: bool,
        #[serde(default)]
        xobj_xref: i32,
        #[serde(default)]
        internal_origin: [f32; 2],
    }
    #[derive(serde::Deserialize)]
    struct RawResp {
        ok: bool,
        page: i32,
        hits: Vec<RawHit>,
    }

    let raw: RawResp = serde_json::from_str(&json_str)
        .map_err(|e| CoreError::MuPdf(format!("JSON parse error: {e}\nraw: {json_str}")))?;

    Ok(DetectLowContrastResponse {
        ok: raw.ok,
        page: raw.page,
        hits: raw
            .hits
            .into_iter()
            .map(|h| LowContrastChar {
                char: h.char,
                color_rgb: h.color_rgb,
                bg_color_rgb: h.bg_color_rgb,
                contrast: h.contrast,
                delta_e: h.delta_e,
                reason: h.reason,
                origin: h.origin,
                quad: h.quad,
                size: h.size,
                is_type3: h.is_type3,
                xobj_xref: h.xobj_xref,
                internal_origin: h.internal_origin,
            })
            .collect(),
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
    /// Type3 フォント（無害化困難）
    #[serde(default)]
    pub is_type3: bool,
    #[serde(default)]
    pub xobj_xref: i32,
    #[serde(default)]
    pub internal_origin: [f32; 2],
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
        FfiResult, kozou_buffer_get_data, kozou_detect_tiny_text, kozou_drop_buffer,
        kozou_new_context,
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
        #[serde(default)]
        is_type3: bool,
        #[serde(default)]
        xobj_xref: i32,
        #[serde(default)]
        internal_origin: [f32; 2],
    }
    #[derive(serde::Deserialize)]
    struct RawResp {
        ok: bool,
        page: i32,
        hits: Vec<RawHit>,
    }

    let raw: RawResp = serde_json::from_str(&json_str)
        .map_err(|e| CoreError::MuPdf(format!("JSON parse error: {e}\nraw: {json_str}")))?;

    Ok(DetectTinyResponse {
        ok: raw.ok,
        page: raw.page,
        hits: raw
            .hits
            .into_iter()
            .map(|h| TinyChar {
                char: h.char,
                size: h.size,
                color_rgb: h.color_rgb,
                reason: h.reason,
                origin: h.origin,
                quad: h.quad,
                is_type3: h.is_type3,
                xobj_xref: h.xobj_xref,
                internal_origin: h.internal_origin,
            })
            .collect(),
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
    /// Type3 フォント（無害化困難）
    #[serde(default)]
    pub is_type3: bool,
    /// 所属 XObject の xref (0=トップレベル)
    #[serde(default)]
    pub xobj_xref: i32,
    /// XObject 内部座標
    #[serde(default)]
    pub internal_origin: [f32; 2],
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
        FfiResult, kozou_buffer_get_data, kozou_detect_buried_text, kozou_drop_buffer,
        kozou_new_context,
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
        size: f32,
        reason: String,
        origin: [f32; 2],
        quad: [f32; 8],
        #[serde(default)]
        is_type3: bool,
        #[serde(default)]
        xobj_xref: i32,
        #[serde(default)]
        internal_origin: [f32; 2],
    }
    #[derive(serde::Deserialize)]
    struct RawResp {
        ok: bool,
        page: i32,
        hits: Vec<RawHit>,
    }

    let raw: RawResp = serde_json::from_str(&json_str)
        .map_err(|e| CoreError::MuPdf(format!("JSON parse error: {e}\nraw: {json_str}")))?;

    Ok(DetectBuriedResponse {
        ok: raw.ok,
        page: raw.page,
        hits: raw
            .hits
            .into_iter()
            .map(|h| BuriedChar {
                char: h.char,
                color_rgb: h.color_rgb,
                size: h.size,
                reason: h.reason,
                origin: h.origin,
                quad: h.quad,
                is_type3: h.is_type3,
                xobj_xref: h.xobj_xref,
                internal_origin: h.internal_origin,
            })
            .collect(),
    })
}

// ── 隠しテキスト置き換え（試験的） ──────────────────────────────────────────

fn default_minus_one() -> i32 {
    -1
}

/// 置き換え対象の文字原点座標
#[derive(Debug, Deserialize)]
pub struct SanitizeOrigin {
    pub x: f32,
    pub y: f32,
    /// 0-indexed page number for per-page filtering
    #[serde(default = "default_minus_one")]
    pub page: i32,
    /// 所属 XObject の xref (0=ページトップレベル, 現状常に0)
    #[serde(default)]
    pub xobj_xref: i32,
    /// XObject 内部座標 (Tm座標)
    #[serde(default)]
    pub internal_x: f32,
    #[serde(default)]
    pub internal_y: f32,
    /// デバイス座標 (MuPDF Y下向き, XObject特定に使用)
    #[serde(default)]
    pub ox: f32,
    #[serde(default)]
    pub oy: f32,
    /// buried 検出フラグ (1=XObject書き換えが必要)
    #[serde(default)]
    pub is_buried: i32,
    /// 描画モード (取り違え防止): 1=不可視(Tr=3/7)として検出, 0=可視として検出,
    /// -1=不明(座標のみで照合, 従来動作)。同一座標に重なる別グリフの誤無害化を防ぐ。
    #[serde(default = "default_minus_one")]
    pub render_invisible: i32,
}

#[derive(Debug, Serialize)]
pub struct SanitizeResponse {
    pub ok: bool,
    /// 実際に置き換えた文字数（0 の場合は対象が見つからなかった）
    pub replaced: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

// ── Type3 フォント無害化 ─────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct SanitizeType3Response {
    pub ok: bool,
    /// 削除した BT ブロック数
    pub removed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SanitizeType3Request {
    pub input: String,
    pub output: String,
}

pub fn sanitize_type3_text(req: &SanitizeType3Request) -> Result<SanitizeType3Response> {
    let removed = crate::type3_sanitize::sanitize_type3_blocks(&req.input, &req.output)
        .map_err(CoreError::MuPdf)?;

    // メタデータを引き継ぐ
    let metadata = crate::compress::collect_metadata(&req.input);
    if !metadata.is_empty() {
        crate::compress::copy_metadata_after_write(&req.output, &metadata);
    }

    Ok(SanitizeType3Response {
        ok: true,
        removed,
        warning: if removed == 0 {
            Some("Type3 フォントを使う BT ブロックが見つかりませんでした。".into())
        } else {
            None
        },
    })
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
    use crate::ffi::{FfiResult, kozou_new_context, kozou_sanitize_hidden_text};
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

    // origin 座標を [x, y, xobj_xref(f32), internal_x, internal_y, ...] の9要素フラット配列に変換
    // (ストライドは 9 のまま維持。描画モードは別の並列配列で渡し互換性を壊さない)
    let origins: Vec<f32> = req
        .targets
        .iter()
        .flat_map(|o| {
            [
                o.x,
                o.y,
                o.xobj_xref as f32,
                o.internal_x,
                o.internal_y,
                o.ox,
                o.oy,
                o.is_buried as f32,
                o.page as f32,
            ]
        })
        .collect();
    // 描画モード (取り違え防止) の並列配列。要素数は n_origins と一致する。
    let render_class: Vec<std::os::raw::c_int> = req
        .targets
        .iter()
        .map(|o| o.render_invisible as std::os::raw::c_int)
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
            render_class.as_ptr(),
            &mut res,
        );
        mupdf_sys::fz_drop_context(ctx);
        if res.ok == 0 {
            return Err(CoreError::MuPdf(format!("{res}")));
        }
    }

    // 入力ファイルのメタデータを出力ファイルに引き継ぐ
    // C層の pdf_save_document は /Info を引き継がないため書き戻す
    let metadata = crate::compress::collect_metadata(&req.input);
    if !metadata.is_empty() {
        crate::compress::copy_metadata_after_write(&req.output, &metadata);
    }

    Ok(SanitizeResponse {
        ok: true,
        replaced: n_origins, // 実際の置き換え数はC層で計上していないため目標数を返す
        warning: Some(
            "⚠ 試験的機能: 全ての隠しテキスト手法を網羅できる保証はありません。\
             本機能の使用による損害について開発者は責任を負いません。"
                .into(),
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

pub fn detect_control_chars(req: &DetectControlCharsRequest) -> Result<DetectControlCharsResponse> {
    use crate::ffi::{
        FfiResult, kozou_buffer_get_data, kozou_detect_control_chars, kozou_drop_buffer,
        kozou_new_context,
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
    struct RawResp {
        ok: bool,
        page: i32,
        hits: Vec<RawHit>,
    }

    let raw: RawResp = serde_json::from_str(&json_str)
        .map_err(|e| CoreError::MuPdf(format!("JSON parse error: {e}\nraw: {json_str}")))?;

    Ok(DetectControlCharsResponse {
        ok: raw.ok,
        page: raw.page,
        hits: raw
            .hits
            .into_iter()
            .map(|h| ControlChar {
                char: h.char,
                codepoint: h.codepoint,
                category: h.category,
                reason: h.reason,
                origin: h.origin,
                quad: h.quad,
                size: h.size,
            })
            .collect(),
    })
}

// ── N-up / 製本 面付けレンダリング ──────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RenderImpositionRequest {
    pub path: String,
    /// cols * rows 個の配置ページ番号 (1始まり、0=空白セル)
    pub page_nums: Vec<i32>,
    pub cols: i32,
    pub rows: i32,
    pub dpi: f32,
    /// "jpeg" | "png"
    #[serde(default)]
    pub format: Option<String>,
    /// JPEG品質 1-100
    #[serde(default)]
    pub quality: Option<i32>,
    /// セル間ギャップ px（出力解像度基準）
    #[serde(default)]
    pub gap_px: Option<i32>,
    #[serde(default)]
    pub layout_w: Option<f32>,
    #[serde(default)]
    pub layout_h: Option<f32>,
    #[serde(default)]
    pub layout_em: Option<f32>,
}

#[derive(Debug, Serialize)]
pub struct RenderImpositionResponse {
    pub ok: bool,
    /// base64エンコードされた画像データ
    pub image_b64: String,
    pub format: String,
}

/// N-up / 製本 面付けレンダリング。
/// 複数ページを1枚のpixmapに直接レンダリングして返す。
/// JPEG/PNG圧縮は1回のみ → 画質劣化最小。
pub fn render_imposition(req: &RenderImpositionRequest) -> Result<RenderImpositionResponse> {
    use crate::ffi::{
        FfiResult, kozou_buffer_get_data, kozou_drop_buffer, kozou_new_context,
        kozou_render_imposition,
    };
    use std::ffi::CString;

    let c_path = CString::new(req.path.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid path".into()))?;

    let fmt_str = req.format.as_deref().unwrap_or("jpeg");
    let fmt_int: i32 = if fmt_str == "png" { 1 } else { 0 };
    let quality = req.quality.unwrap_or(85);
    let gap_px = req.gap_px.unwrap_or(0);

    let image_b64 = unsafe {
        let ctx = kozou_new_context();
        if ctx.is_null() {
            return Err(CoreError::MuPdf("kozou_new_context failed".into()));
        }
        let buf = mupdf_sys::fz_new_buffer(ctx, 1024 * 1024);
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
        kozou_render_imposition(
            ctx,
            c_path.as_ptr(),
            req.layout_w.unwrap_or(0.0),
            req.layout_h.unwrap_or(0.0),
            req.layout_em.unwrap_or(0.0),
            req.page_nums.as_ptr(),
            req.page_nums.len() as i32,
            req.cols,
            req.rows,
            req.dpi,
            fmt_int,
            quality,
            gap_px,
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
        let b64 = if len > 0 && !data_ptr.is_null() {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .encode(std::slice::from_raw_parts(data_ptr, len))
        } else {
            String::new()
        };
        kozou_drop_buffer(ctx, buf);
        mupdf_sys::fz_drop_context(ctx);
        b64
    };

    Ok(RenderImpositionResponse {
        ok: true,
        image_b64,
        format: fmt_str.to_string(),
    })
}

// ── 面付け画像PDF出力 ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RasterizeImpositionRequest {
    pub input: String,
    pub output: String,
    /// 全シートのページ番号を連結した配列 (1始まり、0=空白)。
    /// 長さ = n_sheets * (cols*rows)。
    pub sheet_pages: Vec<i32>,
    pub n_sheets: i32,
    pub cols: i32,
    pub rows: i32,
    pub dpi: f32,
    #[serde(default)]
    pub quality: Option<i32>,
    /// true=PNG埋め込み（可逆）, false/省略=JPEG埋め込み
    #[serde(default)]
    pub use_png: Option<bool>,
    #[serde(default)]
    pub gap_px: Option<i32>,
    #[serde(default)]
    pub layout_w: Option<f32>,
    #[serde(default)]
    pub layout_h: Option<f32>,
    #[serde(default)]
    pub layout_em: Option<f32>,
}

#[derive(Debug, Serialize)]
pub struct RasterizeImpositionResponse {
    pub ok: bool,
    pub output_bytes: u64,
}

/// 面付け画像PDFを出力する。
/// 各シート（cols*rows ページ）を1枚に合成し、1つのPDFページとして埋め込む。
/// 例: A4×4ページを booklet 面付けして A3×2ページの見開き製本PDFを作る。
pub fn rasterize_imposition(
    req: &RasterizeImpositionRequest,
) -> Result<RasterizeImpositionResponse> {
    use crate::ffi::{FfiResult, kozou_new_context, kozou_rasterize_imposition};
    use std::ffi::CString;

    let cells_per_sheet = (req.cols * req.rows).max(1);
    let expected = (req.n_sheets * cells_per_sheet) as usize;
    if req.sheet_pages.len() != expected {
        return Err(CoreError::InvalidArg(format!(
            "sheet_pages length {} != n_sheets*cells_per_sheet {}",
            req.sheet_pages.len(),
            expected
        )));
    }

    let c_input = CString::new(req.input.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid input path".into()))?;
    let c_output = CString::new(req.output.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid output path".into()))?;

    // 出力先ディレクトリを作成
    if let Some(parent) = std::path::Path::new(&req.output).parent()
        && !parent.as_os_str().is_empty()
    {
        let _ = std::fs::create_dir_all(parent);
    }

    let tmp_dir = {
        let base = std::env::temp_dir().join("pdf-kozou");
        let _ = std::fs::create_dir_all(&base);
        base
    };
    let c_tmp_dir = CString::new(tmp_dir.to_string_lossy().as_ref())
        .map_err(|_| CoreError::InvalidArg("invalid tmp_dir path".into()))?;

    let quality = req.quality.unwrap_or(85);
    let use_png = if req.use_png.unwrap_or(false) { 1 } else { 0 };
    let gap_px = req.gap_px.unwrap_or(0);

    unsafe {
        let ctx = kozou_new_context();
        if ctx.is_null() {
            return Err(CoreError::MuPdf("kozou_new_context failed".into()));
        }
        let mut res = FfiResult::default();
        kozou_rasterize_imposition(
            ctx,
            c_input.as_ptr(),
            c_output.as_ptr(),
            req.layout_w.unwrap_or(0.0),
            req.layout_h.unwrap_or(0.0),
            req.layout_em.unwrap_or(0.0),
            req.sheet_pages.as_ptr(),
            req.n_sheets,
            cells_per_sheet,
            req.cols,
            req.rows,
            req.dpi,
            quality,
            use_png,
            gap_px,
            c_tmp_dir.as_ptr(),
            &mut res,
        );
        mupdf_sys::fz_drop_context(ctx);
        if res.ok == 0 {
            return Err(CoreError::MuPdf(format!("{res}")));
        }
    }

    // 入力PDFのメタデータ（/Info）を出力に継承する（他の画像PDF出力と同様）
    let metadata = crate::compress::collect_metadata(&req.input);
    if !metadata.is_empty() {
        crate::compress::copy_metadata_after_write(&req.output, &metadata);
    }

    let ob = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);
    Ok(RasterizeImpositionResponse {
        ok: true,
        output_bytes: ob,
    })
}

// ── 面付け解除（split / de-imposition）────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SplitImpositionPdfRequest {
    pub input: String,
    pub output: String,
    /// 出力順に並んだセル指定。各要素は [page(1始まり), row(0始まり), col(0始まり)]。
    pub cells: Vec<[i32; 3]>,
    pub cols: i32,
    pub rows: i32,
    pub dpi: f32,
    #[serde(default)]
    pub quality: Option<i32>,
    #[serde(default)]
    pub use_png: Option<bool>,
    #[serde(default)]
    pub layout_w: Option<f32>,
    #[serde(default)]
    pub layout_h: Option<f32>,
    #[serde(default)]
    pub layout_em: Option<f32>,
}

#[derive(Debug, Serialize)]
pub struct SplitImpositionPdfResponse {
    pub ok: bool,
    pub output_bytes: u64,
}

/// 面付け解除して画像PDFを出力する。
/// 各セルを1ページ（A4相当）として、cells で指定された順に並べた画像PDFを作る。
/// 例: A3×2(booklet)を A4×4(読み順)に戻す。
pub fn split_imposition_pdf(req: &SplitImpositionPdfRequest) -> Result<SplitImpositionPdfResponse> {
    use crate::ffi::{FfiResult, kozou_new_context, kozou_split_imposition_pdf};
    use std::ffi::CString;

    let c_input = CString::new(req.input.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid input path".into()))?;
    let c_output = CString::new(req.output.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid output path".into()))?;

    if let Some(parent) = std::path::Path::new(&req.output).parent()
        && !parent.as_os_str().is_empty()
    {
        let _ = std::fs::create_dir_all(parent);
    }

    let tmp_dir = {
        let base = std::env::temp_dir().join("pdf-kozou");
        let _ = std::fs::create_dir_all(&base);
        base
    };
    let c_tmp_dir = CString::new(tmp_dir.to_string_lossy().as_ref())
        .map_err(|_| CoreError::InvalidArg("invalid tmp_dir path".into()))?;

    // [[page,row,col],...] を平坦化
    let flat: Vec<i32> = req.cells.iter().flat_map(|c| c.iter().copied()).collect();
    let n_cells = req.cells.len() as i32;

    let quality = req.quality.unwrap_or(85);
    let use_png = if req.use_png.unwrap_or(false) { 1 } else { 0 };

    unsafe {
        let ctx = kozou_new_context();
        if ctx.is_null() {
            return Err(CoreError::MuPdf("kozou_new_context failed".into()));
        }
        let mut res = FfiResult::default();
        kozou_split_imposition_pdf(
            ctx,
            c_input.as_ptr(),
            c_output.as_ptr(),
            req.layout_w.unwrap_or(0.0),
            req.layout_h.unwrap_or(0.0),
            req.layout_em.unwrap_or(0.0),
            flat.as_ptr(),
            n_cells,
            req.cols,
            req.rows,
            req.dpi,
            quality,
            use_png,
            c_tmp_dir.as_ptr(),
            &mut res,
        );
        mupdf_sys::fz_drop_context(ctx);
        if res.ok == 0 {
            return Err(CoreError::MuPdf(format!("{res}")));
        }
    }

    // 入力PDFのメタデータ（/Info）を出力に継承する（他の画像PDF出力と同様）
    let metadata = crate::compress::collect_metadata(&req.input);
    if !metadata.is_empty() {
        crate::compress::copy_metadata_after_write(&req.output, &metadata);
    }

    let ob = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);
    Ok(SplitImpositionPdfResponse {
        ok: true,
        output_bytes: ob,
    })
}

#[derive(Debug, Deserialize)]
pub struct ComposeImpositionPdfRequest {
    pub input: String,
    pub output: String,
    /// 出力シートサイズ(pt)。
    pub target_w: f32,
    pub target_h: f32,
    pub cols: i32,
    pub rows: i32,
    /// 出力順のセル配列。n_sheets*(cols*rows) 個（1始まりページ番号, 0=空白セル）。
    pub sheet_pages: Vec<i32>,
    pub n_sheets: i32,
    #[serde(default)]
    pub gutter: Option<f32>,
    #[serde(default)]
    pub margin: Option<f32>,
    #[serde(default)]
    pub layout_w: Option<f32>,
    #[serde(default)]
    pub layout_h: Option<f32>,
    #[serde(default)]
    pub layout_em: Option<f32>,
}

#[derive(Debug, Serialize)]
pub struct ComposeImpositionPdfResponse {
    pub ok: bool,
    pub output_bytes: u64,
}

/// ベクター保持の面付け結合（n-up / 見開き製本 / ページサイズ変更）。
/// 各元ページを出力ページ上に再生するためテキスト/ベクターが保持される。
pub fn compose_imposition_pdf(
    req: &ComposeImpositionPdfRequest,
) -> Result<ComposeImpositionPdfResponse> {
    use crate::ffi::{FfiResult, kozou_compose_imposition_pdf, kozou_new_context};
    use std::ffi::CString;

    let per = (req.cols * req.rows).max(1);
    let expected = (req.n_sheets * per) as usize;
    if req.sheet_pages.len() != expected {
        return Err(CoreError::InvalidArg(format!(
            "sheet_pages length {} != n_sheets*(cols*rows) {}",
            req.sheet_pages.len(),
            expected
        )));
    }
    if req.target_w <= 1.0 || req.target_h <= 1.0 {
        return Err(CoreError::InvalidArg("invalid target page size".into()));
    }

    let c_input = CString::new(req.input.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid input path".into()))?;
    let c_output = CString::new(req.output.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid output path".into()))?;

    if let Some(parent) = std::path::Path::new(&req.output).parent()
        && !parent.as_os_str().is_empty()
    {
        let _ = std::fs::create_dir_all(parent);
    }

    unsafe {
        let ctx = kozou_new_context();
        if ctx.is_null() {
            return Err(CoreError::MuPdf("kozou_new_context failed".into()));
        }
        let mut res = FfiResult::default();
        kozou_compose_imposition_pdf(
            ctx,
            c_input.as_ptr(),
            c_output.as_ptr(),
            req.layout_w.unwrap_or(0.0),
            req.layout_h.unwrap_or(0.0),
            req.layout_em.unwrap_or(0.0),
            req.target_w,
            req.target_h,
            req.cols,
            req.rows,
            req.sheet_pages.as_ptr(),
            req.n_sheets,
            req.gutter.unwrap_or(0.0),
            req.margin.unwrap_or(0.0),
            &mut res,
        );
        mupdf_sys::fz_drop_context(ctx);
        if res.ok == 0 {
            return Err(CoreError::MuPdf(format!("{res}")));
        }
    }

    // 入力PDFのメタデータ(/Info)を出力に継承する
    let metadata = crate::compress::collect_metadata(&req.input);
    if !metadata.is_empty() {
        crate::compress::copy_metadata_after_write(&req.output, &metadata);
    }

    let ob = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);
    Ok(ComposeImpositionPdfResponse {
        ok: true,
        output_bytes: ob,
    })
}

#[derive(Debug, Deserialize)]
pub struct SplitCellRenderRequest {
    pub input: String,
    pub page: i32, // 1始まり
    pub cols: i32,
    pub rows: i32,
    pub cell_row: i32,
    pub cell_col: i32,
    pub dpi: f32,
    /// "jpeg" | "png" | "svg"
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub quality: Option<i32>,
    #[serde(default)]
    pub layout_w: Option<f32>,
    #[serde(default)]
    pub layout_h: Option<f32>,
    #[serde(default)]
    pub layout_em: Option<f32>,
}

#[derive(Debug, Serialize)]
pub struct SplitCellRenderResponse {
    pub ok: bool,
    /// base64エンコードされた画像データ（JPEG/PNG）または SVG テキストのbase64
    pub data_b64: String,
    pub format: String,
}

/// 面付け解除した1セルを画像（JPEG/PNG/SVG）としてレンダリングし base64 で返す。
/// 個別画像ファイル出力用。呼び出し側が出力順にループして保存する。
pub fn split_cell_render(req: &SplitCellRenderRequest) -> Result<SplitCellRenderResponse> {
    use crate::ffi::{
        FfiResult, kozou_buffer_get_data, kozou_drop_buffer, kozou_new_context,
        kozou_split_cell_render,
    };
    use std::ffi::CString;

    let c_input = CString::new(req.input.as_str())
        .map_err(|_| CoreError::InvalidArg("invalid input path".into()))?;

    let fmt_str = req.format.as_deref().unwrap_or("jpeg");
    let fmt_int: i32 = match fmt_str {
        "png" => 1,
        "svg" => 2,
        _ => 0,
    };
    let quality = req.quality.unwrap_or(85);

    let data_b64 = unsafe {
        let ctx = kozou_new_context();
        if ctx.is_null() {
            return Err(CoreError::MuPdf("kozou_new_context failed".into()));
        }
        let buf = mupdf_sys::fz_new_buffer(ctx, 1024 * 1024);
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
        kozou_split_cell_render(
            ctx,
            c_input.as_ptr(),
            req.layout_w.unwrap_or(0.0),
            req.layout_h.unwrap_or(0.0),
            req.layout_em.unwrap_or(0.0),
            req.page,
            req.cols,
            req.rows,
            req.cell_row,
            req.cell_col,
            req.dpi,
            fmt_int,
            quality,
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
        let b64 = if len > 0 && !data_ptr.is_null() {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .encode(std::slice::from_raw_parts(data_ptr, len))
        } else {
            String::new()
        };
        kozou_drop_buffer(ctx, buf);
        mupdf_sys::fz_drop_context(ctx);
        b64
    };

    // SVG 出力の場合、入力PDFのメタデータを <metadata> ブロックとして埋め込む
    // （通常の画像変換 render_svg と同じ仕組みを流用）。
    // JPEG/PNG は save_base64_image 側で EXIF/PNG チャンクとして埋め込まれる。
    let data_b64 = if fmt_int == 2 && !data_b64.is_empty() {
        use base64::Engine;
        match base64::engine::general_purpose::STANDARD.decode(&data_b64) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(svg_str) => {
                    let metadata = crate::compress::collect_metadata(&req.input);
                    if metadata.is_empty() {
                        data_b64
                    } else {
                        let patched = crate::render::embed_metadata_svg(svg_str, &metadata);
                        base64::engine::general_purpose::STANDARD.encode(patched.as_bytes())
                    }
                }
                Err(_) => data_b64,
            },
            Err(_) => data_b64,
        }
    } else {
        data_b64
    };

    Ok(SplitCellRenderResponse {
        ok: true,
        data_b64,
        format: fmt_str.to_string(),
    })
}
