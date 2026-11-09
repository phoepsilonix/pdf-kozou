// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/hidden_scan_lopdf.rs
// 隠しテキストの検出 (透明・低コントラスト・極小・制御文字・埋没) と無害化の lopdf 実装。
// MuPDF を使わない。stext.rs の同名の関数から、backend が mupdf 以外のときに呼ばれる。
//
// hidden_text_lopdf の走査 (内容ストリームをたどって、文字ごとに位置・色・不透明度・
// Unicode を記録する) の結果から、MuPDF 実装と同じ形の応答 (TransparentChar など) を作る。
// 座標はデバイス座標 (MuPDF と同じ。CropBox の左上が原点、y は下向き、/Rotate 適用後)。
//
// MuPDF 実装との違い:
//   - 文字の特定: 検出が、文字を含むストリームの番号 (xobj_xref。ページの内容は 0) と、
//     ストリームの中での Tj/TJ の通し番号 (xobj_tj_seq) を必ず確定する。無害化はこの 2 つと
//     文字コードで文字を照合するので、座標が近いだけの別の文字を巻き込まない。
//     (MuPDF の検出が返した、番号の数え方が違う結果は照合できず、対象が見つからない扱いになる)
//   - 無害化: 文字を空白に置き換えず、文字を取り除いて送り幅を TJ の位置調整で保つ。
//     後続の文字の位置は変わらない
//   - 低コントラスト: 描画した画素の外周 32 点の標本ではなく、文字より前に描かれた不透明な
//     矩形の塗りの色を背景とする (何も無ければ白)。画像・曲線・半透明の上は背景が分からない
//     ので検出しない。`ratio_threshold` は使わない
//   - 文字の Unicode: ToUnicode と単純フォントの Encoding だけ (tounicode_lopdf)。
//     MuPDF が補う CID → Unicode の対応などは無く、分からない文字は U+FFFD になる
//   - /Widths の無いフォント (標準 14 フォントなど) の文字は、幅が分からないので扱わない

use crate::hidden_text_lopdf::{GlyphRec, analysis_from_glyphs, apply_removals, scan_glyphs};
use crate::stext::{
    BuriedChar, ControlChar, DetectBuriedResponse, DetectControlCharsResponse,
    DetectLowContrastResponse, DetectTinyResponse, DetectTransparentResponse, LowContrastChar,
    SanitizeRequest, SanitizeResponse, TinyChar, TransparentChar,
};
use lopdf::Document;
use std::collections::HashSet;

fn load(path: &str) -> Result<Document, String> {
    crate::safe_load::load_checked(path)
        .map(|(d, _)| d)
        .map_err(|e| e.to_string())
}

fn scan(path: &str, page: i32) -> Result<Vec<GlyphRec>, String> {
    let mut doc = load(path)?;
    scan_glyphs(&mut doc, page)
}

/// 文字の最初のコードポイント
fn cp(g: &GlyphRec) -> u32 {
    g.text.chars().next().map_or(0xFFFD, |c| c as u32)
}

/// 無害な空白以外の空白系 (検出するが、無害化の対象にはしない reason = whitespace_only)
fn is_whitespace_cp(cp: u32) -> bool {
    matches!(cp, 0x00A0 | 0x3000 | 0x2000..=0x200A | 0x0009 | 0x000D)
}

/// 制御文字の分類 (zero_width など)
fn control_category(cp: u32) -> Option<&'static str> {
    match cp {
        0x200B..=0x200F => Some("zero_width"),
        0x202A..=0x202E => Some("bidi_control"),
        0x2028 | 0x2029 => Some("line_separator"),
        0xFEFF => Some("bom_zwnbsp"),
        0xE0000..=0xE007F => Some("tag_char"),
        _ => None,
    }
}

fn f2(p: (f64, f64)) -> [f32; 2] {
    [p.0 as f32, p.1 as f32]
}

fn f8(q: &[f64; 8]) -> [f32; 8] {
    let mut o = [0f32; 8];
    for (d, s) in o.iter_mut().zip(q) {
        *d = *s as f32;
    }
    o
}

/// 通常の空白 (U+0020) は、隠された情報を運ばないので検出しない
fn is_plain_space(g: &GlyphRec) -> bool {
    g.text == " "
}

/// 目に見える文字か (描画モードが塗り/線で、半分以上不透明)
fn is_visible(g: &GlyphRec) -> bool {
    (0..=2).contains(&g.tr) && g.ca >= 0.5
}

// ── 透明 ──────────────────────────────────────────────────────────────────

pub(crate) fn detect_transparent(
    path: &str,
    page: i32,
    alpha_threshold: u8,
) -> Result<DetectTransparentResponse, String> {
    let mut hits = Vec::new();
    for g in scan(path, page)? {
        if is_plain_space(&g) {
            continue;
        }
        // Tr 3 / 7 は描かれない (alpha 0 として扱う)
        let drawn = !matches!(g.tr, 3 | 7);
        let alpha = if drawn {
            (g.ca.clamp(0.0, 1.0) * 255.0).round() as u8
        } else {
            0
        };
        if alpha > alpha_threshold {
            continue;
        }
        let c = cp(&g);
        // 制御文字は detect_control_chars で検出する
        if control_category(c).is_some() {
            continue;
        }
        let fill = matches!(g.tr, 0 | 2 | 4 | 6);
        let stroke = matches!(g.tr, 1 | 2 | 5 | 6);
        let flags = i32::from(fill) * 16 + i32::from(stroke) * 32 + i32::from(g.tr >= 4) * 64;
        let reason = if is_whitespace_cp(c) {
            "whitespace_only"
        } else if g.tr == 3 {
            "invisible_mode"
        } else if g.tr == 7 {
            "clip_only_mode"
        } else {
            "transparent"
        };
        hits.push(TransparentChar {
            char: g.text.clone(),
            alpha,
            color_rgb: g.rgb.unwrap_or([0, 0, 0]),
            flags,
            reason: reason.into(),
            origin: f2(g.origin),
            quad: f8(&g.quad),
            size: g.size as f32,
            is_type3: g.is_type3,
            xobj_xref: g.xref,
            xobj_tj_seq: g.tj_seq,
            internal_origin: f2(g.origin),
        });
    }
    Ok(DetectTransparentResponse {
        ok: true,
        page,
        hits,
    })
}

// ── 極小フォント ──────────────────────────────────────────────────────────

pub(crate) fn detect_tiny(
    path: &str,
    page: i32,
    size_threshold: f32,
) -> Result<DetectTinyResponse, String> {
    let thr = if size_threshold <= 0.0 {
        2.0
    } else {
        size_threshold
    };
    let mut hits = Vec::new();
    for g in scan(path, page)? {
        if g.size as f32 > thr || is_plain_space(&g) {
            continue;
        }
        let c = cp(&g);
        let reason = if is_whitespace_cp(c) {
            "whitespace_only"
        } else {
            "tiny_font"
        };
        hits.push(TinyChar {
            char: g.text.clone(),
            size: g.size as f32,
            color_rgb: g.rgb.unwrap_or([0, 0, 0]),
            reason: reason.into(),
            origin: f2(g.origin),
            quad: f8(&g.quad),
            is_type3: g.is_type3,
            xobj_xref: g.xref,
            xobj_tj_seq: g.tj_seq,
            internal_origin: f2(g.origin),
        });
    }
    Ok(DetectTinyResponse {
        ok: true,
        page,
        hits,
    })
}

// ── 低コントラスト ────────────────────────────────────────────────────────

/// sRGB の 1 成分 (0-255) → 線形
fn lin(c: u8) -> f64 {
    let v = f64::from(c) / 255.0;
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// WCAG の相対輝度
fn luminance(c: [u8; 3]) -> f64 {
    0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
}

/// WCAG のコントラスト比 (1.0〜21.0)
fn contrast_ratio(a: [u8; 3], b: [u8; 3]) -> f64 {
    let (la, lb) = (luminance(a), luminance(b));
    let (hi, lo) = if la >= lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

/// sRGB → CIE L*a*b* (D65)
fn lab(c: [u8; 3]) -> [f64; 3] {
    let (r, g, b) = (lin(c[0]), lin(c[1]), lin(c[2]));
    let x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    let z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
    let f = |t: f64| {
        if t > 0.008856 {
            t.cbrt()
        } else {
            7.787 * t + 16.0 / 116.0
        }
    };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

fn delta_e76(a: [u8; 3], b: [u8; 3]) -> f64 {
    let (la, lb) = (lab(a), lab(b));
    ((la[0] - lb[0]).powi(2) + (la[1] - lb[1]).powi(2) + (la[2] - lb[2]).powi(2)).sqrt()
}

pub(crate) fn detect_low_contrast(
    path: &str,
    page: i32,
    contrast_threshold: Option<f32>,
) -> Result<DetectLowContrastResponse, String> {
    let thr = f64::from(contrast_threshold.unwrap_or(1.5).clamp(1.0, 21.0));
    let mut hits = Vec::new();
    for g in scan(path, page)? {
        if !is_visible(&g) || is_plain_space(&g) {
            continue;
        }
        let c = cp(&g);
        if control_category(c).is_some() {
            continue;
        }
        // 文字色と背景色が分からないものは判定できない
        let (Some(fg), Some(bg)) = (g.rgb, g.bg) else {
            continue;
        };
        let ratio = contrast_ratio(fg, bg);
        if ratio > thr {
            continue;
        }
        let reason = if is_whitespace_cp(c) {
            "whitespace_only"
        } else {
            "low_contrast"
        };
        hits.push(LowContrastChar {
            char: g.text.clone(),
            color_rgb: fg,
            bg_color_rgb: bg,
            contrast: ratio as f32,
            delta_e: delta_e76(fg, bg) as f32,
            reason: reason.into(),
            origin: f2(g.origin),
            quad: f8(&g.quad),
            size: g.size as f32,
            is_type3: g.is_type3,
            xobj_xref: g.xref,
            xobj_tj_seq: g.tj_seq,
            internal_origin: f2(g.origin),
        });
    }
    Ok(DetectLowContrastResponse {
        ok: true,
        page,
        hits,
    })
}

// ── 制御文字 ──────────────────────────────────────────────────────────────

pub(crate) fn detect_control_chars(
    path: &str,
    page: i32,
) -> Result<DetectControlCharsResponse, String> {
    let mut hits = Vec::new();
    for g in scan(path, page)? {
        let c = cp(&g);
        let Some(category) = control_category(c) else {
            continue;
        };
        hits.push(ControlChar {
            char: format!("U+{c:04X}"),
            codepoint: c,
            category: category.into(),
            reason: "control_char".into(),
            origin: f2(g.origin),
            quad: f8(&g.quad),
            size: g.size as f32,
            xobj_xref: g.xref,
            internal_origin: f2(g.origin),
        });
    }
    Ok(DetectControlCharsResponse {
        ok: true,
        page,
        hits,
    })
}

// ── 埋没 ──────────────────────────────────────────────────────────────────

pub(crate) fn detect_buried(
    path: &str,
    page: i32,
    cover_ratio: Option<f32>,
) -> Result<DetectBuriedResponse, String> {
    let ratio = f64::from(cover_ratio.unwrap_or(0.8).clamp(0.0, 1.0));
    let mut hits = Vec::new();
    for g in scan(path, page)? {
        // 候補 (見えるはずの文字) のうち、あとから描かれた不透明な覆いに ratio 以上覆われたもの
        if !g.cand || g.cover <= 0.0 || g.cover < ratio - 1e-9 || is_plain_space(&g) {
            continue;
        }
        let c = cp(&g);
        let reason = if is_whitespace_cp(c) {
            "whitespace_only"
        } else {
            "buried"
        };
        hits.push(BuriedChar {
            char: g.text.clone(),
            color_rgb: g.rgb.unwrap_or([0, 0, 0]),
            size: g.size as f32,
            reason: reason.into(),
            origin: f2(g.origin),
            quad: f8(&g.quad),
            is_type3: g.is_type3,
            xobj_xref: g.xref,
            xobj_tj_seq: g.tj_seq,
            internal_origin: f2(g.origin),
        });
    }
    Ok(DetectBuriedResponse {
        ok: true,
        page,
        hits,
    })
}

// ── 無害化 ────────────────────────────────────────────────────────────────

/// 対象の文字を、`input` の内容ストリームから取り除いて `output` に保存する。
///
/// 対象は、検出が返した `xobj_xref` と `xobj_tj_seq` で文字を含む Tj/TJ を特定し、その中で
/// 文字コードと位置 (許容距離 `tolerance`) が合う文字を取り除く。`xobj_tj_seq` が不明 (-1) の
/// 対象は、ページ内の位置・文字コード・サイズだけで照合する。見つからなかった対象は数えて、
/// warning で知らせる。
pub(crate) fn sanitize(req: &SanitizeRequest) -> Result<SanitizeResponse, String> {
    let mut doc = load(&req.input)?;
    let tol = f64::from(req.tolerance.unwrap_or(1.0).max(0.1));

    // ページごとに走査する (対象のページだけ)
    let mut pages: Vec<i32> = req.targets.iter().map(|t| t.page).collect();
    pages.sort_unstable();
    pages.dedup();
    let page_count = doc.get_pages().len() as i32;
    let all_pages: Vec<i32> = (0..page_count).collect();
    let scan_pages: Vec<i32> = if pages.iter().any(|&p| p < 0) {
        all_pages
    } else {
        pages
    };
    let mut glyphs: Vec<GlyphRec> = Vec::new();
    for p in scan_pages {
        glyphs.extend(scan_glyphs(&mut doc, p)?);
    }

    let mut chosen: HashSet<usize> = HashSet::new();
    let mut missing = 0usize;
    for t in &req.targets {
        let (tx, ty) = (f64::from(t.ox), f64::from(t.oy));
        let mut best: Option<(usize, f64)> = None;
        for (i, g) in glyphs.iter().enumerate() {
            if (t.page >= 0 && g.page != t.page) || chosen.contains(&i) {
                continue;
            }
            if t.xobj_tj_seq >= 0 && (g.tj_seq != t.xobj_tj_seq || g.xref != t.xobj_xref) {
                continue;
            }
            if t.codepoint >= 0 && i64::from(cp(g)) != i64::from(t.codepoint) {
                continue;
            }
            if t.size > 0.0 && (g.size - f64::from(t.size)).abs() > tol.max(0.5) {
                continue;
            }
            let d = ((g.origin.0 - tx).powi(2) + (g.origin.1 - ty).powi(2)).sqrt();
            if d > tol {
                continue;
            }
            if best.is_none_or(|(_, bd)| d < bd) {
                best = Some((i, d));
            }
        }
        match best {
            Some((i, _)) => {
                chosen.insert(i);
            }
            None => missing += 1,
        }
    }

    let picked: Vec<&GlyphRec> = chosen.iter().map(|&i| &glyphs[i]).collect();
    let analysis = analysis_from_glyphs(&picked);
    let replaced = apply_removals(&mut doc, &analysis);
    // 何も置き換えなくても、出力は作る (MuPDF 実装と同じ。呼び出し側は出力の存在を前提にする)
    doc.save(&req.output).map_err(|e| format!("save: {e}"))?;
    if replaced == 0 {
        return Ok(SanitizeResponse {
            ok: true,
            replaced: 0,
            warning: Some("no matching text found for the targets".into()),
        });
    }

    let mut warning = String::from(
        "⚠ 試験的機能: 全ての隠しテキスト手法を網羅できる保証はありません。\
         本機能の使用による損害について開発者は責任を負いません。",
    );
    if missing > 0 {
        warning.push_str(&format!(
            "\n{missing} 件の対象は、文字が見つからなかったため処理していません。"
        ));
    }
    Ok(SanitizeResponse {
        ok: true,
        replaced: replaced as i32,
        warning: Some(warning),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hidden_text_lopdf::tests::build;
    use crate::stext::SanitizeOrigin;
    use lopdf::{Dictionary, Object, dictionary};

    fn write(doc: &mut Document, name: &str) -> String {
        let p = std::env::temp_dir().join(format!("kozou_scan_{}_{name}.pdf", std::process::id()));
        doc.save(&p).unwrap();
        p.to_string_lossy().into_owned()
    }

    fn gs(alpha: f64) -> Dictionary {
        let mut ext = Dictionary::new();
        ext.set(
            "ExtGState",
            dictionary! { "G" => dictionary! { "ca" => alpha } },
        );
        ext
    }

    #[test]
    fn transparent_and_invisible_text_are_reported_with_device_coordinates() {
        // ページは 200x200。Tr 3 の "AB" と、ca 0 の "C"
        let mut doc = build(
            "BT 3 Tr /F1 20 Tf 10 100 Td (AB) Tj ET\n/G gs BT 0 Tr /F1 20 Tf 10 50 Td (C) Tj ET\n",
            &[],
            Some(gs(0.0)),
        );
        let path = write(&mut doc, "transparent");
        let r = detect_transparent(&path, 0, 0).unwrap();
        assert_eq!(r.hits.len(), 3);
        assert_eq!(r.hits[0].reason, "invisible_mode");
        assert_eq!(r.hits[0].flags, 0);
        assert_eq!(r.hits[2].reason, "transparent");
        // 原点: x = 10、y はページ上端からの距離 (200 - 100)
        assert!((r.hits[0].origin[0] - 10.0).abs() < 1e-3);
        assert!((r.hits[0].origin[1] - 100.0).abs() < 1e-3);
        assert_eq!(r.hits[0].xobj_xref, 0);
        // 1 つ目の Tj が 0、2 つ目が 1 (同じ Tj の文字は同じ番号)
        assert_eq!(r.hits[0].xobj_tj_seq, 0);
        assert_eq!(r.hits[1].xobj_tj_seq, 0);
        assert_eq!(r.hits[2].xobj_tj_seq, 1);
        assert_eq!(r.hits[0].char, "A");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rotation_and_cropbox_follow_device_space() {
        let mut doc = build("BT /F1 10 Tf 20 30 Td (A) Tj ET\n", &[], None);
        let page = *doc.get_pages().values().next().unwrap();
        {
            let d = doc.get_object_mut(page).unwrap().as_dict_mut().unwrap();
            d.set("Rotate", 90);
            d.set(
                "CropBox",
                vec![10.into(), 10.into(), 190.into(), 150.into()],
            );
        }
        let path = write(&mut doc, "rotate");
        let r = detect_tiny(&path, 0, 100.0).unwrap();
        assert_eq!(r.hits.len(), 1);
        // 90 度回転: x' = y - y0 = 30 - 10、y' = x - x0 = 20 - 10
        assert!(
            (r.hits[0].origin[0] - 20.0).abs() < 1e-3,
            "{:?}",
            r.hits[0].origin
        );
        assert!((r.hits[0].origin[1] - 10.0).abs() < 1e-3);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tiny_text_and_whitespace_reasons() {
        let mut doc = build(
            "BT /F1 1.5 Tf 10 100 Td (AB) Tj ET\nBT /F1 12 Tf 10 50 Td (CD) Tj ET\n",
            &[],
            None,
        );
        let path = write(&mut doc, "tiny");
        let r = detect_tiny(&path, 0, 2.0).unwrap();
        assert_eq!(r.hits.len(), 2);
        assert_eq!(r.hits[0].reason, "tiny_font");
        assert!((r.hits[0].size - 1.5).abs() < 1e-3);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn low_contrast_uses_the_fill_under_the_text() {
        // 灰色の矩形の上に、ほぼ同じ灰色の文字 (低コントラスト) と、黒い文字 (十分なコントラスト)
        let mut doc = build(
            "0.5 g 0 0 200 200 re f\n0.52 g BT /F1 20 Tf 10 100 Td (AB) Tj ET\n0 g BT /F1 20 Tf 10 50 Td (CD) Tj ET\n",
            &[],
            None,
        );
        let path = write(&mut doc, "lowc");
        let r = detect_low_contrast(&path, 0, Some(1.5)).unwrap();
        assert_eq!(r.hits.len(), 2);
        assert_eq!(r.hits[0].reason, "low_contrast");
        assert_eq!(r.hits[0].bg_color_rgb, [128, 128, 128]);
        assert!(r.hits[0].contrast < 1.5);
        // 白い背景の白い文字
        let mut doc = build("1 g BT /F1 20 Tf 10 100 Td (A) Tj ET\n", &[], None);
        let path2 = write(&mut doc, "lowc2");
        let r = detect_low_contrast(&path2, 0, Some(1.5)).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].bg_color_rgb, [255, 255, 255]);
        // 画像の上は背景が分からないので検出しない
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&path2);
    }

    #[test]
    fn low_contrast_skips_unknown_background() {
        // 曲線の塗りの上: 背景が分からない
        let mut doc = build(
            "0.5 g 0 90 m 100 90 l 100 130 100 130 50 130 c 0 130 l h f\n0.5 g BT /F1 20 Tf 10 100 Td (AB) Tj ET\n",
            &[],
            None,
        );
        let path = write(&mut doc, "lowc3");
        let r = detect_low_contrast(&path, 0, Some(1.5)).unwrap();
        assert!(r.hits.is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn control_characters_come_from_tounicode() {
        // CID フォント (幅 1000) の 2 バイト文字。ToUnicode で U+200B と U+0041 にする
        let mut doc = build("BT /F2 20 Tf 10 100 Td <00010002> Tj ET\n", &[], None);
        let page = *doc.get_pages().values().next().unwrap();
        let cmap = doc.add_object(lopdf::Stream::new(
            Dictionary::new(),
            b"beginbfchar <0001> <200B> <0002> <0041> endbfchar".to_vec(),
        ));
        {
            let d = doc.get_object(page).unwrap().as_dict().unwrap();
            let res = d.get(b"Resources").unwrap().as_dict().unwrap();
            let f2 = res.get(b"Font").unwrap().as_dict().unwrap();
            let id = f2.get(b"F2").unwrap().as_reference().unwrap();
            doc.get_object_mut(id)
                .unwrap()
                .as_dict_mut()
                .unwrap()
                .set("ToUnicode", Object::Reference(cmap));
        }
        let path = write(&mut doc, "ctrl");
        let r = detect_control_chars(&path, 0).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].char, "U+200B");
        assert_eq!(r.hits[0].category, "zero_width");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn buried_hits_follow_the_cover_ratio() {
        let mut doc = build(
            "BT /F1 20 Tf 10 100 Td (ABC) Tj ET\n0 90 25 40 re f\n",
            &[],
            None,
        );
        let path = write(&mut doc, "buried");
        // A (10..20) は完全に、B (20..30) は半分覆われる
        let r = detect_buried(&path, 0, Some(0.999)).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].char, "A");
        let r = detect_buried(&path, 0, Some(0.5)).unwrap();
        assert_eq!(r.hits.len(), 2);
        let _ = std::fs::remove_file(&path);
    }

    fn target_of(h_origin: [f32; 2], tj_seq: i32, cp: i32, size: f32) -> SanitizeOrigin {
        SanitizeOrigin {
            x: h_origin[0],
            y: h_origin[1],
            page: 0,
            xobj_xref: 0,
            internal_x: h_origin[0],
            internal_y: h_origin[1],
            ox: h_origin[0],
            oy: h_origin[1],
            is_buried: 0,
            render_invisible: -1,
            codepoint: cp,
            size,
            alpha_gate: 0,
            font_class: -1,
            xobj_tj_seq: tj_seq,
        }
    }

    fn req(input: &str, output: &str, targets: Vec<SanitizeOrigin>) -> SanitizeRequest {
        SanitizeRequest {
            input: input.into(),
            output: output.into(),
            targets,
            tolerance: Some(1.5),
            layout_w: None,
            layout_h: None,
            layout_em: None,
            alpha_threshold: None,
        }
    }

    #[test]
    fn sanitize_removes_only_the_detected_glyphs_and_keeps_the_rest() {
        // 不可視の "AB" と、見える "XYZ" が同じ座標に重なる
        let mut doc = build(
            "BT 3 Tr /F1 20 Tf 10 100 Td (AB) Tj ET\nBT 0 Tr /F1 20 Tf 10 100 Td (XYZ) Tj ET\n",
            &[],
            None,
        );
        let input = write(&mut doc, "san_in");
        let output = std::env::temp_dir()
            .join(format!("kozou_scan_{}_san_out.pdf", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let det = detect_transparent(&input, 0, 0).unwrap();
        assert_eq!(det.hits.len(), 2);
        let targets: Vec<_> = det
            .hits
            .iter()
            .map(|h| {
                target_of(
                    h.origin,
                    h.xobj_tj_seq,
                    h.char.chars().next().unwrap() as i32,
                    h.size,
                )
            })
            .collect();
        let resp = sanitize(&req(&input, &output, targets)).unwrap();
        assert_eq!(resp.replaced, 2);

        // 無害化後: 不可視の文字は無くなり、見える文字は残る。位置は変わらない
        assert!(detect_transparent(&output, 0, 0).unwrap().hits.is_empty());
        let r = detect_tiny(&output, 0, 100.0).unwrap();
        let text: String = r.hits.iter().map(|h| h.char.as_str()).collect();
        assert_eq!(text, "XYZ");
        assert!((r.hits[0].origin[0] - 10.0).abs() < 1e-3);
        let _ = std::fs::remove_file(&input);
        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn sanitize_distinguishes_layers_by_tj_seq_not_by_position() {
        // 同じ座標・同じ文字 "A" が 3 層 (見える / 不可視 / 見える)。不可視の層だけを対象にする
        let mut doc = build(
            "BT 0 Tr /F1 20 Tf 10 100 Td (A) Tj ET\nBT 3 Tr /F1 20 Tf 10 100 Td (A) Tj ET\nBT 0 Tr /F1 20 Tf 10 100 Td (A) Tj ET\n",
            &[],
            None,
        );
        let input = write(&mut doc, "san2_in");
        let output = std::env::temp_dir()
            .join(format!("kozou_scan_{}_san2_out.pdf", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let det = detect_transparent(&input, 0, 0).unwrap();
        assert_eq!(det.hits.len(), 1);
        assert_eq!(det.hits[0].xobj_tj_seq, 1);
        let h = &det.hits[0];
        let resp = sanitize(&req(
            &input,
            &output,
            vec![target_of(h.origin, h.xobj_tj_seq, 'A' as i32, h.size)],
        ))
        .unwrap();
        assert_eq!(resp.replaced, 1);
        let r = detect_tiny(&output, 0, 100.0).unwrap();
        assert_eq!(r.hits.len(), 2, "見える 2 層が残る");
        let _ = std::fs::remove_file(&input);
        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn sanitize_reports_targets_that_do_not_match() {
        let mut doc = build("BT 3 Tr /F1 20 Tf 10 100 Td (AB) Tj ET\n", &[], None);
        let input = write(&mut doc, "san3_in");
        let output = std::env::temp_dir()
            .join(format!("kozou_scan_{}_san3_out.pdf", std::process::id()))
            .to_string_lossy()
            .into_owned();
        // 1 つは合う (A)、1 つは番号が違う
        let t = vec![
            target_of([10.0, 100.0], 0, 'A' as i32, 20.0),
            target_of([20.0, 100.0], 7, 'B' as i32, 20.0),
        ];
        let resp = sanitize(&req(&input, &output, t)).unwrap();
        assert_eq!(resp.replaced, 1);
        assert!(resp.warning.unwrap().contains("1 件"));
        // どれにも合わなければ、出力を作らない
        let none = sanitize(&req(
            &input,
            &output,
            vec![target_of([150.0, 150.0], 0, 'Z' as i32, 20.0)],
        ))
        .unwrap();
        assert_eq!(none.replaced, 0);
        let _ = std::fs::remove_file(&input);
        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn form_text_gets_its_own_xref_and_sequence() {
        let mut doc = build(
            "BT 0 Tr /F1 20 Tf 10 150 Td (P) Tj ET\n/X1 Do\n",
            &[("X1", "BT 3 Tr /F1 20 Tf 10 100 Td (QR) Tj ET")],
            None,
        );
        let path = write(&mut doc, "form");
        let r = detect_transparent(&path, 0, 0).unwrap();
        assert_eq!(r.hits.len(), 2);
        assert_ne!(
            r.hits[0].xobj_xref, 0,
            "Form の中の文字は Form の番号を持つ"
        );
        // ページの Tj は 0 番、Form の中の Tj も、その Form の中で 0 番
        assert_eq!(r.hits[0].xobj_tj_seq, 0);
        let _ = std::fs::remove_file(&path);
    }
}
