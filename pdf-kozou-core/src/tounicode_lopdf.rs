// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/tounicode_lopdf.rs
// フォントの文字コード → Unicode の対応表 (lopdf、MuPDF を使わない)。
//
// 隠しテキストの検出 (hidden_scan_lopdf) が、検出した文字を Unicode で報告するために使う。
//   1. /ToUnicode CMap (bfchar / bfrange)
//   2. 単純フォントは /Encoding (WinAnsi の上位 128 字、/Differences のグリフ名)
//   3. どちらでも分からない文字は U+FFFD
// MuPDF の stext は AGL や CID → Unicode の対応表をもっと持つので、ToUnicode の無い
// 非埋め込みフォントなどでは、報告する文字が MuPDF と食い違うことがある。

use crate::crop_redact_lopdf::{deref, num_deref};
use crate::image_recompress::content_stream_bytes_with_limit;
use lopdf::{Dictionary, Document, Object};
use std::collections::HashMap;

/// 文字コード → Unicode の文字列
#[derive(Debug, Default)]
pub(crate) struct UniMap {
    map: HashMap<u32, String>,
    /// 単純フォント (1 バイト文字コード) か
    simple: bool,
}

impl UniMap {
    /// `code` に対応する文字列。分からなければ U+FFFD
    pub(crate) fn get(&self, code: u32) -> String {
        if let Some(s) = self.map.get(&code) {
            return s.clone();
        }
        if self.simple && code < 0x80 && code >= 0x20 {
            return char::from_u32(code).map(String::from).unwrap_or_default();
        }
        "\u{FFFD}".to_string()
    }
}

const LIMIT: usize = 16 * 1024 * 1024;

/// フォント辞書から対応表を作る
pub(crate) fn build(doc: &Document, font: &Dictionary) -> UniMap {
    let subtype = font
        .get(b"Subtype")
        .ok()
        .and_then(|o| deref(doc, o).as_name().ok())
        .unwrap_or(b"");
    let simple = subtype != b"Type0";
    let mut out = UniMap {
        map: HashMap::new(),
        simple,
    };
    if simple {
        simple_encoding(doc, font, &mut out.map);
    }
    // ToUnicode は、Encoding より優先する
    if let Some(Object::Stream(s)) = font.get(b"ToUnicode").ok().map(|o| deref(doc, o))
        && let Ok(bytes) = content_stream_bytes_with_limit(s, LIMIT)
    {
        parse_cmap(&bytes, &mut out.map);
    }
    out
}

// ── ToUnicode CMap ────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
enum Tok {
    Hex(Vec<u8>),
    Open,
    Close,
    Word(String),
}

fn tokenize(data: &[u8]) -> Vec<Tok> {
    let mut toks = Vec::new();
    let mut i = 0;
    let n = data.len();
    while i < n {
        let c = data[i];
        match c {
            b'%' => {
                while i < n && data[i] != b'\n' && data[i] != b'\r' {
                    i += 1;
                }
            }
            b'<' if i + 1 < n && data[i + 1] == b'<' => i += 2,
            b'>' if i + 1 < n && data[i + 1] == b'>' => i += 2,
            b'<' => {
                i += 1;
                let mut hex = Vec::new();
                while i < n && data[i] != b'>' {
                    if data[i].is_ascii_hexdigit() {
                        hex.push(data[i]);
                    }
                    i += 1;
                }
                i += 1;
                if hex.len() % 2 == 1 {
                    hex.push(b'0');
                }
                let bytes = hex
                    .chunks(2)
                    .map(|p| {
                        let s = std::str::from_utf8(p).unwrap_or("0");
                        u8::from_str_radix(s, 16).unwrap_or(0)
                    })
                    .collect();
                toks.push(Tok::Hex(bytes));
            }
            b'[' => {
                toks.push(Tok::Open);
                i += 1;
            }
            b']' => {
                toks.push(Tok::Close);
                i += 1;
            }
            b'(' => {
                // 文字列は読み飛ばす (入れ子の括弧と \ のエスケープに対応)
                let mut depth = 1;
                i += 1;
                while i < n && depth > 0 {
                    match data[i] {
                        b'\\' => i += 1,
                        b'(' => depth += 1,
                        b')' => depth -= 1,
                        _ => {}
                    }
                    i += 1;
                }
            }
            c if c.is_ascii_whitespace() => i += 1,
            _ => {
                let start = i;
                while i < n
                    && !data[i].is_ascii_whitespace()
                    && !matches!(data[i], b'<' | b'>' | b'[' | b']' | b'(' | b'%')
                {
                    i += 1;
                }
                if i == start {
                    i += 1;
                } else {
                    toks.push(Tok::Word(
                        String::from_utf8_lossy(&data[start..i]).into_owned(),
                    ));
                }
            }
        }
    }
    toks
}

fn be_value(b: &[u8]) -> u32 {
    b.iter().take(4).fold(0u32, |a, &x| (a << 8) | u32::from(x))
}

fn utf16be(b: &[u8]) -> String {
    let units: Vec<u16> = b
        .chunks_exact(2)
        .map(|p| u16::from_be_bytes([p[0], p[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

fn parse_cmap(data: &[u8], map: &mut HashMap<u32, String>) {
    let toks = tokenize(data);
    let mut i = 0;
    while i < toks.len() {
        match &toks[i] {
            Tok::Word(w) if w == "beginbfchar" => {
                i += 1;
                while i + 1 < toks.len() {
                    if matches!(&toks[i], Tok::Word(w) if w == "endbfchar") {
                        break;
                    }
                    if let (Tok::Hex(src), Tok::Hex(dst)) = (&toks[i], &toks[i + 1]) {
                        map.insert(be_value(src), utf16be(dst));
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }
            Tok::Word(w) if w == "beginbfrange" => {
                i += 1;
                while i + 2 < toks.len() {
                    if matches!(&toks[i], Tok::Word(w) if w == "endbfrange") {
                        break;
                    }
                    let (Tok::Hex(lo), Tok::Hex(hi)) = (&toks[i], &toks[i + 1]) else {
                        i += 1;
                        continue;
                    };
                    let (lo, hi) = (be_value(lo), be_value(hi));
                    if hi < lo || hi - lo > 0xFFFF {
                        i += 3;
                        continue;
                    }
                    match &toks[i + 2] {
                        Tok::Hex(dst) => {
                            let mut units: Vec<u16> = dst
                                .chunks_exact(2)
                                .map(|p| u16::from_be_bytes([p[0], p[1]]))
                                .collect();
                            for code in lo..=hi {
                                map.insert(code, String::from_utf16_lossy(&units));
                                if let Some(last) = units.last_mut() {
                                    *last = last.wrapping_add(1);
                                }
                            }
                            i += 3;
                        }
                        Tok::Open => {
                            let mut j = i + 3;
                            let mut code = lo;
                            while j < toks.len() && toks[j] != Tok::Close {
                                if let Tok::Hex(dst) = &toks[j]
                                    && code <= hi
                                {
                                    map.insert(code, utf16be(dst));
                                    code += 1;
                                }
                                j += 1;
                            }
                            i = j + 1;
                        }
                        _ => i += 3,
                    }
                }
            }
            _ => i += 1,
        }
    }
}

// ── 単純フォントの Encoding ───────────────────────────────────────────────

/// WinAnsiEncoding の 0x80〜0x9F (それ以外の上位は Latin-1 と同じ)
const WIN_ANSI_80: [u32; 32] = [
    0x20AC, 0xFFFD, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039,
    0x0152, 0xFFFD, 0x017D, 0xFFFD, 0xFFFD, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0xFFFD, 0x017E, 0x0178,
];

fn simple_encoding(doc: &Document, font: &Dictionary, map: &mut HashMap<u32, String>) {
    let enc = font.get(b"Encoding").ok().map(|o| deref(doc, o));
    let (base, diffs): (Option<&[u8]>, Option<&Vec<Object>>) = match enc {
        Some(Object::Name(n)) => (Some(n.as_slice()), None),
        Some(Object::Dictionary(d)) => (
            d.get(b"BaseEncoding")
                .ok()
                .and_then(|o| deref(doc, o).as_name().ok()),
            d.get(b"Differences")
                .ok()
                .and_then(|o| deref(doc, o).as_array().ok()),
        ),
        _ => (None, None),
    };
    if base == Some(b"WinAnsiEncoding") {
        for code in 0x80u32..=0xFF {
            let cp = if code < 0xA0 {
                WIN_ANSI_80[(code - 0x80) as usize]
            } else {
                code
            };
            if let Some(c) = char::from_u32(cp) {
                map.insert(code, c.to_string());
            }
        }
    }
    if let Some(items) = diffs {
        let mut code = 0u32;
        for it in items {
            match deref(doc, it) {
                Object::Name(n) => {
                    if let Some(s) = glyph_name_to_unicode(&String::from_utf8_lossy(n)) {
                        map.insert(code, s);
                    }
                    code += 1;
                }
                other => {
                    if let Some(v) = num_deref(doc, other) {
                        code = v as u32;
                    }
                }
            }
        }
    }
}

/// グリフ名 → Unicode (Adobe Glyph List の一部。uniXXXX / uXXXX 形式にも対応)
fn glyph_name_to_unicode(name: &str) -> Option<String> {
    if let Some(h) = name.strip_prefix("uni")
        && h.len() >= 4
        && h.len() % 4 == 0
        && h.bytes().all(|b| b.is_ascii_hexdigit())
    {
        let units: Vec<u16> = (0..h.len() / 4)
            .filter_map(|k| u16::from_str_radix(&h[k * 4..k * 4 + 4], 16).ok())
            .collect();
        return Some(String::from_utf16_lossy(&units));
    }
    if let Some(h) = name.strip_prefix('u')
        && (4..=6).contains(&h.len())
        && h.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return u32::from_str_radix(h, 16)
            .ok()
            .and_then(char::from_u32)
            .map(String::from);
    }
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next())
        && c.is_ascii_alphabetic()
    {
        return Some(c.to_string());
    }
    let cp: u32 = match name {
        "space" => 0x20,
        "exclam" => 0x21,
        "quotedbl" => 0x22,
        "numbersign" => 0x23,
        "dollar" => 0x24,
        "percent" => 0x25,
        "ampersand" => 0x26,
        "quotesingle" => 0x27,
        "parenleft" => 0x28,
        "parenright" => 0x29,
        "asterisk" => 0x2A,
        "plus" => 0x2B,
        "comma" => 0x2C,
        "hyphen" => 0x2D,
        "minus" => 0x2212,
        "period" => 0x2E,
        "slash" => 0x2F,
        "zero" => 0x30,
        "one" => 0x31,
        "two" => 0x32,
        "three" => 0x33,
        "four" => 0x34,
        "five" => 0x35,
        "six" => 0x36,
        "seven" => 0x37,
        "eight" => 0x38,
        "nine" => 0x39,
        "colon" => 0x3A,
        "semicolon" => 0x3B,
        "less" => 0x3C,
        "equal" => 0x3D,
        "greater" => 0x3E,
        "question" => 0x3F,
        "at" => 0x40,
        "bracketleft" => 0x5B,
        "backslash" => 0x5C,
        "bracketright" => 0x5D,
        "asciicircum" => 0x5E,
        "underscore" => 0x5F,
        "grave" => 0x60,
        "braceleft" => 0x7B,
        "bar" => 0x7C,
        "braceright" => 0x7D,
        "asciitilde" => 0x7E,
        "nbspace" | "nonbreakingspace" => 0xA0,
        "bullet" => 0x2022,
        "endash" => 0x2013,
        "emdash" => 0x2014,
        "quoteleft" => 0x2018,
        "quoteright" => 0x2019,
        "quotedblleft" => 0x201C,
        "quotedblright" => 0x201D,
        "ellipsis" => 0x2026,
        "fi" => 0xFB01,
        "fl" => 0xFB02,
        _ => return None,
    };
    char::from_u32(cp).map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bfchar_and_bfrange() {
        let cmap = b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n\
            1 begincodespacerange <0000> <FFFF> endcodespacerange\n\
            2 beginbfchar <0003> <0020> <0004> <D83DDE00> endbfchar\n\
            2 beginbfrange <0010> <0012> <0041> <0020> <0021> [<0061> <0062>] endbfrange\n\
            endcmap";
        let mut m = HashMap::new();
        parse_cmap(cmap, &mut m);
        assert_eq!(m[&3], " ");
        assert_eq!(m[&4], "\u{1F600}");
        assert_eq!(m[&0x10], "A");
        assert_eq!(m[&0x12], "C");
        assert_eq!(m[&0x20], "a");
        assert_eq!(m[&0x21], "b");
    }

    #[test]
    fn glyph_names() {
        assert_eq!(glyph_name_to_unicode("A").as_deref(), Some("A"));
        assert_eq!(glyph_name_to_unicode("uni3042").as_deref(), Some("あ"));
        assert_eq!(
            glyph_name_to_unicode("u1F600").as_deref(),
            Some("\u{1F600}")
        );
        assert_eq!(glyph_name_to_unicode("space").as_deref(), Some(" "));
        assert_eq!(glyph_name_to_unicode("zzzz"), None);
    }
}
