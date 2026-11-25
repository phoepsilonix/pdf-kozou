// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/tounicode_fix_lopdf.rs
// キープテキスト版の出力 PDF の ToUnicode CMap のうち、変換先が「康熙部首 (U+2F00-2FD5)」または
// 「CJK 互換漢字 (U+F900-FAFF)」になっているものを、対応する通常の漢字に書き換える (lopdf)。
//
// mupdf_safe.c の kozou_keeptext_fix_tounicode_radicals と同じ仕様の移植。
//
// Canva などの書き出し PDF では、一部のフォントの ToUnicode が、グリフを康熙部首 (⽟⼊⾦⽉ など) や
// CJK 互換漢字に対応づけている。見た目は同じ字形でも別の文字として扱われるので、コピーした文字が
// 部首文字のままになり、「玉入れ」で検索しても「⽟⼊れ」にヒットしない。ToUnicode はコピー・検索・
// 読み上げ用の対応表で、ページの描画 (グリフ・内容ストリーム) には使われないため、見た目は変わらない。
//
// - 対象は U+2F00-2FD5 と U+F900-FAFF (NFKC の変換結果が BMP の 1 文字になるもの) だけ。
//   全角/半角や記号などには触れない (NFKC 全体は適用しない)。
// - 変換対象を含む ToUnicode だけ、新規ストリームを作ってフォント辞書の /ToUnicode を差し替える。
//   対象を含まない ToUnicode には触れない (バイト単位で同一のまま)。
// - bfchar / bfrange (単一の変換先・配列の変換先) に対応する。変換対象を含む bfrange は、対象の要素だけ
//   1 件ずつの範囲に展開し、対象外の区間は範囲のまま残す。想定外の構造 (空白を含む 16 進など) は、
//   その ToUnicode 全体に触れずに残す。

use crate::image_recompress::content_stream_bytes_with_limit;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use std::collections::HashMap;

/// U+2F00..U+2FD5 の NFKC の変換結果
const KANGXI: [u16; 214] = [
    0x4E00, 0x4E28, 0x4E36, 0x4E3F, 0x4E59, 0x4E85, 0x4E8C, 0x4EA0, 0x4EBA, 0x513F, 0x5165, 0x516B,
    0x5182, 0x5196, 0x51AB, 0x51E0, 0x51F5, 0x5200, 0x529B, 0x52F9, 0x5315, 0x531A, 0x5338, 0x5341,
    0x535C, 0x5369, 0x5382, 0x53B6, 0x53C8, 0x53E3, 0x56D7, 0x571F, 0x58EB, 0x5902, 0x590A, 0x5915,
    0x5927, 0x5973, 0x5B50, 0x5B80, 0x5BF8, 0x5C0F, 0x5C22, 0x5C38, 0x5C6E, 0x5C71, 0x5DDB, 0x5DE5,
    0x5DF1, 0x5DFE, 0x5E72, 0x5E7A, 0x5E7F, 0x5EF4, 0x5EFE, 0x5F0B, 0x5F13, 0x5F50, 0x5F61, 0x5F73,
    0x5FC3, 0x6208, 0x6236, 0x624B, 0x652F, 0x6534, 0x6587, 0x6597, 0x65A4, 0x65B9, 0x65E0, 0x65E5,
    0x66F0, 0x6708, 0x6728, 0x6B20, 0x6B62, 0x6B79, 0x6BB3, 0x6BCB, 0x6BD4, 0x6BDB, 0x6C0F, 0x6C14,
    0x6C34, 0x706B, 0x722A, 0x7236, 0x723B, 0x723F, 0x7247, 0x7259, 0x725B, 0x72AC, 0x7384, 0x7389,
    0x74DC, 0x74E6, 0x7518, 0x751F, 0x7528, 0x7530, 0x758B, 0x7592, 0x7676, 0x767D, 0x76AE, 0x76BF,
    0x76EE, 0x77DB, 0x77E2, 0x77F3, 0x793A, 0x79B8, 0x79BE, 0x7A74, 0x7ACB, 0x7AF9, 0x7C73, 0x7CF8,
    0x7F36, 0x7F51, 0x7F8A, 0x7FBD, 0x8001, 0x800C, 0x8012, 0x8033, 0x807F, 0x8089, 0x81E3, 0x81EA,
    0x81F3, 0x81FC, 0x820C, 0x821B, 0x821F, 0x826E, 0x8272, 0x8278, 0x864D, 0x866B, 0x8840, 0x884C,
    0x8863, 0x897E, 0x898B, 0x89D2, 0x8A00, 0x8C37, 0x8C46, 0x8C55, 0x8C78, 0x8C9D, 0x8D64, 0x8D70,
    0x8DB3, 0x8EAB, 0x8ECA, 0x8F9B, 0x8FB0, 0x8FB5, 0x9091, 0x9149, 0x91C6, 0x91CC, 0x91D1, 0x9577,
    0x9580, 0x961C, 0x96B6, 0x96B9, 0x96E8, 0x9751, 0x975E, 0x9762, 0x9769, 0x97CB, 0x97ED, 0x97F3,
    0x9801, 0x98A8, 0x98DB, 0x98DF, 0x9996, 0x9999, 0x99AC, 0x9AA8, 0x9AD8, 0x9ADF, 0x9B25, 0x9B2F,
    0x9B32, 0x9B3C, 0x9B5A, 0x9CE5, 0x9E75, 0x9E7F, 0x9EA5, 0x9EBB, 0x9EC3, 0x9ECD, 0x9ED1, 0x9EF9,
    0x9EFD, 0x9F0E, 0x9F13, 0x9F20, 0x9F3B, 0x9F4A, 0x9F52, 0x9F8D, 0x9F9C, 0x9FA0,
];

/// U+F900..U+FAFF の NFKC の変換結果 (0 は変換なし)
const COMPAT: [u16; 512] = [
    0x8C48, 0x66F4, 0x8ECA, 0x8CC8, 0x6ED1, 0x4E32, 0x53E5, 0x9F9C, 0x9F9C, 0x5951, 0x91D1, 0x5587,
    0x5948, 0x61F6, 0x7669, 0x7F85, 0x863F, 0x87BA, 0x88F8, 0x908F, 0x6A02, 0x6D1B, 0x70D9, 0x73DE,
    0x843D, 0x916A, 0x99F1, 0x4E82, 0x5375, 0x6B04, 0x721B, 0x862D, 0x9E1E, 0x5D50, 0x6FEB, 0x85CD,
    0x8964, 0x62C9, 0x81D8, 0x881F, 0x5ECA, 0x6717, 0x6D6A, 0x72FC, 0x90CE, 0x4F86, 0x51B7, 0x52DE,
    0x64C4, 0x6AD3, 0x7210, 0x76E7, 0x8001, 0x8606, 0x865C, 0x8DEF, 0x9732, 0x9B6F, 0x9DFA, 0x788C,
    0x797F, 0x7DA0, 0x83C9, 0x9304, 0x9E7F, 0x8AD6, 0x58DF, 0x5F04, 0x7C60, 0x807E, 0x7262, 0x78CA,
    0x8CC2, 0x96F7, 0x58D8, 0x5C62, 0x6A13, 0x6DDA, 0x6F0F, 0x7D2F, 0x7E37, 0x964B, 0x52D2, 0x808B,
    0x51DC, 0x51CC, 0x7A1C, 0x7DBE, 0x83F1, 0x9675, 0x8B80, 0x62CF, 0x6A02, 0x8AFE, 0x4E39, 0x5BE7,
    0x6012, 0x7387, 0x7570, 0x5317, 0x78FB, 0x4FBF, 0x5FA9, 0x4E0D, 0x6CCC, 0x6578, 0x7D22, 0x53C3,
    0x585E, 0x7701, 0x8449, 0x8AAA, 0x6BBA, 0x8FB0, 0x6C88, 0x62FE, 0x82E5, 0x63A0, 0x7565, 0x4EAE,
    0x5169, 0x51C9, 0x6881, 0x7CE7, 0x826F, 0x8AD2, 0x91CF, 0x52F5, 0x5442, 0x5973, 0x5EEC, 0x65C5,
    0x6FFE, 0x792A, 0x95AD, 0x9A6A, 0x9E97, 0x9ECE, 0x529B, 0x66C6, 0x6B77, 0x8F62, 0x5E74, 0x6190,
    0x6200, 0x649A, 0x6F23, 0x7149, 0x7489, 0x79CA, 0x7DF4, 0x806F, 0x8F26, 0x84EE, 0x9023, 0x934A,
    0x5217, 0x52A3, 0x54BD, 0x70C8, 0x88C2, 0x8AAA, 0x5EC9, 0x5FF5, 0x637B, 0x6BAE, 0x7C3E, 0x7375,
    0x4EE4, 0x56F9, 0x5BE7, 0x5DBA, 0x601C, 0x73B2, 0x7469, 0x7F9A, 0x8046, 0x9234, 0x96F6, 0x9748,
    0x9818, 0x4F8B, 0x79AE, 0x91B4, 0x96B8, 0x60E1, 0x4E86, 0x50DA, 0x5BEE, 0x5C3F, 0x6599, 0x6A02,
    0x71CE, 0x7642, 0x84FC, 0x907C, 0x9F8D, 0x6688, 0x962E, 0x5289, 0x677B, 0x67F3, 0x6D41, 0x6E9C,
    0x7409, 0x7559, 0x786B, 0x7D10, 0x985E, 0x516D, 0x622E, 0x9678, 0x502B, 0x5D19, 0x6DEA, 0x8F2A,
    0x5F8B, 0x6144, 0x6817, 0x7387, 0x9686, 0x5229, 0x540F, 0x5C65, 0x6613, 0x674E, 0x68A8, 0x6CE5,
    0x7406, 0x75E2, 0x7F79, 0x88CF, 0x88E1, 0x91CC, 0x96E2, 0x533F, 0x6EBA, 0x541D, 0x71D0, 0x7498,
    0x85FA, 0x96A3, 0x9C57, 0x9E9F, 0x6797, 0x6DCB, 0x81E8, 0x7ACB, 0x7B20, 0x7C92, 0x72C0, 0x7099,
    0x8B58, 0x4EC0, 0x8336, 0x523A, 0x5207, 0x5EA6, 0x62D3, 0x7CD6, 0x5B85, 0x6D1E, 0x66B4, 0x8F3B,
    0x884C, 0x964D, 0x898B, 0x5ED3, 0x5140, 0x55C0, 0x0000, 0x0000, 0x585A, 0x0000, 0x6674, 0x0000,
    0x0000, 0x51DE, 0x732A, 0x76CA, 0x793C, 0x795E, 0x7965, 0x798F, 0x9756, 0x7CBE, 0x7FBD, 0x0000,
    0x8612, 0x0000, 0x8AF8, 0x0000, 0x0000, 0x9038, 0x90FD, 0x0000, 0x0000, 0x0000, 0x98EF, 0x98FC,
    0x9928, 0x9DB4, 0x90DE, 0x96B7, 0x4FAE, 0x50E7, 0x514D, 0x52C9, 0x52E4, 0x5351, 0x559D, 0x5606,
    0x5668, 0x5840, 0x58A8, 0x5C64, 0x5C6E, 0x6094, 0x6168, 0x618E, 0x61F2, 0x654F, 0x65E2, 0x6691,
    0x6885, 0x6D77, 0x6E1A, 0x6F22, 0x716E, 0x722B, 0x7422, 0x7891, 0x793E, 0x7949, 0x7948, 0x7950,
    0x7956, 0x795D, 0x798D, 0x798E, 0x7A40, 0x7A81, 0x7BC0, 0x7DF4, 0x7E09, 0x7E41, 0x7F72, 0x8005,
    0x81ED, 0x8279, 0x8279, 0x8457, 0x8910, 0x8996, 0x8B01, 0x8B39, 0x8CD3, 0x8D08, 0x8FB6, 0x9038,
    0x96E3, 0x97FF, 0x983B, 0x6075, 0x0000, 0x8218, 0x0000, 0x0000, 0x4E26, 0x51B5, 0x5168, 0x4F80,
    0x5145, 0x5180, 0x52C7, 0x52FA, 0x559D, 0x5555, 0x5599, 0x55E2, 0x585A, 0x58B3, 0x5944, 0x5954,
    0x5A62, 0x5B28, 0x5ED2, 0x5ED9, 0x5F69, 0x5FAD, 0x60D8, 0x614E, 0x6108, 0x618E, 0x6160, 0x61F2,
    0x6234, 0x63C4, 0x641C, 0x6452, 0x6556, 0x6674, 0x6717, 0x671B, 0x6756, 0x6B79, 0x6BBA, 0x6D41,
    0x6EDB, 0x6ECB, 0x6F22, 0x701E, 0x716E, 0x77A7, 0x7235, 0x72AF, 0x732A, 0x7471, 0x7506, 0x753B,
    0x761D, 0x761F, 0x76CA, 0x76DB, 0x76F4, 0x774A, 0x7740, 0x78CC, 0x7AB1, 0x7BC0, 0x7C7B, 0x7D5B,
    0x7DF4, 0x7F3E, 0x8005, 0x8352, 0x83EF, 0x8779, 0x8941, 0x8986, 0x8996, 0x8ABF, 0x8AF8, 0x8ACB,
    0x8B01, 0x8AFE, 0x8AED, 0x8B39, 0x8B8A, 0x8D08, 0x8F38, 0x9072, 0x9199, 0x9276, 0x967C, 0x96E3,
    0x9756, 0x97DB, 0x97FF, 0x980B, 0x983B, 0x9B12, 0x9F9C, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x9F43, 0x9F8E, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
];

/// 康熙部首・CJK 互換漢字なら、対応する通常の漢字。それ以外は、そのまま
fn han_from_radical(cp: u32) -> u32 {
    if (0x2F00..=0x2FD5).contains(&cp) {
        return KANGXI[(cp - 0x2F00) as usize] as u32;
    }
    if (0xF900..=0xFAFF).contains(&cp) {
        let v = COMPAT[(cp - 0xF900) as usize] as u32;
        return if v != 0 { v } else { cp };
    }
    cp
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Tok {
    Eof,
    /// 「<」「>」を除いた 16 進の桁の範囲 (開始, 長さ)
    Hex(usize, usize),
    Lb,
    Rb,
    /// 語の範囲 (開始, 長さ)
    Word(usize, usize),
    /// 想定外 (空白を含む 16 進、辞書など)
    Bad,
}

fn hexdigit(c: u8) -> Option<u32> {
    (c as char).to_digit(16)
}

fn is_ws(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\r' | b'\n' | 0x0c | 0)
}

/// 次のトークンを読む
fn next_tok(d: &[u8], pos: &mut usize) -> Tok {
    let len = d.len();
    let mut i = *pos;
    loop {
        while i < len && is_ws(d[i]) {
            i += 1;
        }
        if i < len && d[i] == b'%' {
            while i < len && d[i] != b'\n' && d[i] != b'\r' {
                i += 1;
            }
            continue;
        }
        break;
    }
    if i >= len {
        *pos = i;
        return Tok::Eof;
    }
    match d[i] {
        b'[' => {
            *pos = i + 1;
            return Tok::Lb;
        }
        b']' => {
            *pos = i + 1;
            return Tok::Rb;
        }
        b'<' => {
            if i + 1 < len && d[i + 1] == b'<' {
                *pos = i + 2;
                return Tok::Bad;
            }
            let s = i + 1;
            let mut j = s;
            while j < len && d[j] != b'>' {
                if hexdigit(d[j]).is_none() {
                    return Tok::Bad;
                }
                j += 1;
            }
            if j >= len {
                return Tok::Bad;
            }
            *pos = j + 1;
            return Tok::Hex(s, j - s);
        }
        _ => {}
    }
    let mut j = i;
    while j < len && !is_ws(d[j]) && !b"()<>[]{}/%".contains(&d[j]) {
        j += 1;
    }
    if j == i {
        j = i + 1;
    }
    *pos = j;
    Tok::Word(i, j - i)
}

fn hexval(d: &[u8], s: usize, n: usize) -> Option<u64> {
    if n == 0 || n > 8 {
        return None;
    }
    let mut r = 0u64;
    for &c in &d[s..s + n] {
        r = r * 16 + hexdigit(c)? as u64;
    }
    Some(r)
}

/// 変換先 (UTF-16BE の 16 進) を 16 ビット単位にしたもの
struct Dst(Vec<u32>);

fn parse_dst(d: &[u8], s: usize, n: usize) -> Option<Dst> {
    if n == 0 || n % 4 != 0 || n > 32 {
        return None;
    }
    let mut u = Vec::with_capacity(n / 4);
    for i in 0..n / 4 {
        u.push(hexval(d, s + i * 4, 4)? as u32);
    }
    Some(Dst(u))
}

impl Dst {
    /// 最後の単位に `add` を足した i 番目の単位
    fn unit(&self, i: usize, add: u64) -> u32 {
        let last = i + 1 == self.0.len();
        ((self.0[i] as u64 + if last { add } else { 0 }) & 0xFFFF) as u32
    }

    /// 最後の単位に `add` を足したとき、部首文字などに変換される単位があるか
    fn affected(&self, add: u64) -> bool {
        (0..self.0.len()).any(|i| {
            let u = self.unit(i, add);
            han_from_radical(u) != u
        })
    }

    fn emit(&self, out: &mut Vec<u8>, add: u64) {
        out.push(b'<');
        for i in 0..self.0.len() {
            push_hex(out, han_from_radical(self.unit(i, add)) as u64, 4);
        }
        out.push(b'>');
    }
}

/// 16 進 (大文字) を width 桁、0 埋めで書く
fn push_hex(out: &mut Vec<u8>, v: u64, width: usize) {
    out.extend_from_slice(format!("{v:0width$X}").as_bytes());
}

fn emit_hex(out: &mut Vec<u8>, d: &[u8], s: usize, n: usize) {
    out.push(b'<');
    out.extend_from_slice(&d[s..s + n]);
    out.push(b'>');
}

/// 作成中のセクション (bfchar / bfrange) の行
struct Sec {
    chunk: Vec<u8>,
    cnt: usize,
    is_range: bool,
}

impl Sec {
    fn flush(&mut self, out: &mut Vec<u8>) {
        if self.cnt == 0 {
            return;
        }
        let kind = if self.is_range { "bfrange" } else { "bfchar" };
        out.extend_from_slice(format!("{} begin{kind}\n", self.cnt).as_bytes());
        out.extend_from_slice(&self.chunk);
        out.extend_from_slice(format!("end{kind}\n").as_bytes());
        self.chunk.clear();
        self.cnt = 0;
    }

    /// 仕様上の上限 (1 セクション 100 項目) に合わせて区切る
    fn item_done(&mut self, out: &mut Vec<u8>) {
        self.cnt += 1;
        if self.cnt >= 100 {
            self.flush(out);
        }
    }
}

fn find_begin(d: &[u8], from: usize) -> Option<(usize, bool)> {
    let mut i = from;
    while i < d.len() {
        if d[i] == b'b' {
            if d[i..].starts_with(b"beginbfchar") {
                return Some((i, false));
            }
            if d[i..].starts_with(b"beginbfrange") {
                return Some((i, true));
            }
        }
        i += 1;
    }
    None
}

/// 1 つの ToUnicode で、展開する要素数の上限 (想定外に大きいものは触れずに残す)
const MAX_EXPANDED: usize = 4096;

/// ToUnicode CMap を変換する。変換対象が無い、または想定外の構造なら None
fn fix_cmap(d: &[u8]) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::with_capacity(d.len() + 256);
    let mut sc = Sec { chunk: Vec::new(), cnt: 0, is_range: false };
    let mut changed = false;
    let mut expanded = 0usize;
    let mut pos = 0usize;

    loop {
        let Some((idx, is_range)) = find_begin(d, pos) else {
            out.extend_from_slice(&d[pos..]);
            break;
        };
        // 直前の項目数 (「12 beginbfchar」の 12) は書き直すので除く
        let mut cstart = idx;
        let mut q = idx;
        while q > pos && is_ws(d[q - 1]) {
            q -= 1;
        }
        let mut q2 = q;
        while q2 > pos && d[q2 - 1].is_ascii_digit() {
            q2 -= 1;
        }
        if q2 < q {
            cstart = q2;
        }
        out.extend_from_slice(&d[pos..cstart]);

        let mut p = idx + if is_range { 12 } else { 11 };
        sc.is_range = is_range;
        sc.cnt = 0;
        sc.chunk.clear();
        let end_word: &[u8] = if is_range { b"endbfrange" } else { b"endbfchar" };

        loop {
            let (as_, an) = match next_tok(d, &mut p) {
                Tok::Word(s, n) if &d[s..s + n] == end_word => break,
                Tok::Hex(s, n) => (s, n),
                _ => return None,
            };
            let Tok::Hex(bs, bn) = next_tok(d, &mut p) else {
                return None;
            };

            if !is_range {
                emit_hex(&mut sc.chunk, d, as_, an);
                sc.chunk.push(b' ');
                if let Some(x) = parse_dst(d, bs, bn) {
                    if x.affected(0) {
                        changed = true;
                    }
                    x.emit(&mut sc.chunk, 0);
                } else {
                    emit_hex(&mut sc.chunk, d, bs, bn);
                }
                sc.chunk.push(b'\n');
                sc.item_done(&mut out);
                continue;
            }

            let lo = hexval(d, as_, an)?;
            let hi = hexval(d, bs, bn)?;
            if hi < lo {
                return None;
            }
            match next_tok(d, &mut p) {
                Tok::Hex(cs, cn) => {
                    let Some(x) = parse_dst(d, cs, cn) else {
                        // 想定外の形式はそのまま
                        emit_hex(&mut sc.chunk, d, as_, an);
                        sc.chunk.push(b' ');
                        emit_hex(&mut sc.chunk, d, bs, bn);
                        sc.chunk.push(b' ');
                        emit_hex(&mut sc.chunk, d, cs, cn);
                        sc.chunk.push(b'\n');
                        sc.item_done(&mut out);
                        continue;
                    };
                    // 変換対象を含まない区間はそのまま範囲で、含む要素だけを 1 件ずつの範囲に展開する
                    let total = hi - lo + 1;
                    let mut k = 0u64;
                    while k < total {
                        let mut k2 = k + 1;
                        sc.chunk.push(b'<');
                        if !x.affected(k) {
                            while k2 < total && !x.affected(k2) {
                                k2 += 1;
                            }
                            push_hex(&mut sc.chunk, lo + k, an);
                            sc.chunk.extend_from_slice(b"> <");
                            push_hex(&mut sc.chunk, lo + k2 - 1, an);
                        } else {
                            expanded += 1;
                            if expanded > MAX_EXPANDED {
                                return None;
                            }
                            changed = true;
                            push_hex(&mut sc.chunk, lo + k, an);
                            sc.chunk.extend_from_slice(b"> <");
                            push_hex(&mut sc.chunk, lo + k, an);
                        }
                        sc.chunk.extend_from_slice(b"> ");
                        x.emit(&mut sc.chunk, k);
                        sc.chunk.push(b'\n');
                        sc.item_done(&mut out);
                        k = k2;
                    }
                }
                Tok::Lb => {
                    emit_hex(&mut sc.chunk, d, as_, an);
                    sc.chunk.push(b' ');
                    emit_hex(&mut sc.chunk, d, bs, bn);
                    sc.chunk.extend_from_slice(b" [");
                    loop {
                        match next_tok(d, &mut p) {
                            Tok::Rb => break,
                            Tok::Hex(cs, cn) => {
                                sc.chunk.push(b' ');
                                if let Some(x) = parse_dst(d, cs, cn) {
                                    if x.affected(0) {
                                        changed = true;
                                    }
                                    x.emit(&mut sc.chunk, 0);
                                } else {
                                    emit_hex(&mut sc.chunk, d, cs, cn);
                                }
                            }
                            _ => return None,
                        }
                    }
                    sc.chunk.extend_from_slice(b" ]\n");
                    sc.item_done(&mut out);
                }
                _ => return None,
            }
        }
        sc.flush(&mut out);
        pos = p;
    }
    changed.then_some(out)
}

// ---- lopdf ----

/// ToUnicode の読み出しの上限 (バイト)
const LIMIT: usize = 4 * 1024 * 1024;

/// 変換した ToUnicode の内容 (変換対象が無い・想定外の構造・読めないときは None)
fn fixed_cmap_bytes(doc: &Document, id: ObjectId) -> Option<Vec<u8>> {
    let Some(Object::Stream(s)) = doc.objects.get(&id) else {
        return None;
    };
    let bytes = content_stream_bytes_with_limit(s, LIMIT).ok()?;
    if bytes.is_empty() {
        return None;
    }
    fix_cmap(&bytes)
}

/// 文書内の全フォントの ToUnicode のうち、康熙部首・CJK 互換漢字に対応づけているものを、通常の漢字に
/// 書き換える。書き換えた ToUnicode ストリームの数を返す。見た目 (グリフ・内容ストリーム) は変わらない。
/// 元のストリームは、他から使われなくなれば、あとの prune で取り除かれる。
pub(crate) fn fix_tounicode_radicals(doc: &mut Document) -> usize {
    // ToUnicode を持つ辞書と、その ToUnicode (間接参照のストリーム)
    let refs: Vec<(ObjectId, ObjectId)> = doc
        .objects
        .iter()
        .filter_map(|(id, obj)| match obj {
            Object::Dictionary(d) => match d.get(b"ToUnicode") {
                Ok(Object::Reference(t)) => Some((*id, *t)),
                _ => None,
            },
            _ => None,
        })
        .collect();
    if refs.is_empty() {
        return 0;
    }

    // 同じ ToUnicode を複数のフォントが使うことがあるので、ストリームごとに 1 回だけ変換する
    let mut repl: HashMap<ObjectId, Option<ObjectId>> = HashMap::new();
    let mut fixed = 0usize;
    for &(_, t) in &refs {
        if repl.contains_key(&t) {
            continue;
        }
        let new_id = fixed_cmap_bytes(doc, t).map(|bytes| {
            fixed += 1;
            doc.add_object(Object::Stream(Stream::new(Dictionary::new(), bytes)))
        });
        repl.insert(t, new_id);
    }
    for (id, t) in refs {
        if let Some(Some(n)) = repl.get(&t)
            && let Some(Object::Dictionary(d)) = doc.objects.get_mut(&id)
        {
            d.set("ToUnicode", Object::Reference(*n));
        }
    }
    fixed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(b: &[u8]) -> String {
        String::from_utf8_lossy(b).into_owned()
    }

    #[test]
    fn table_samples() {
        assert_eq!(han_from_radical(0x2F00), 0x4E00);
        assert_eq!(han_from_radical(0x2FD5), 0x9FA0);
        assert_eq!(han_from_radical(0xF900), 0x8C48);
        assert_eq!(han_from_radical(0xFA6C), 0xFA6C); // NFKC が BMP の外 → そのまま
        assert_eq!(han_from_radical(0x4E00), 0x4E00);
        assert_eq!(han_from_radical(0xFF21), 0xFF21); // 全角は触れない
    }

    #[test]
    fn bfchar_radical_is_fixed() {
        let src = b"/CIDInit /ProcSet findresource begin\n2 beginbfchar\n<0001> <2F1F>\n<0002> <0041>\nendbfchar\nendcmap\n";
        let out = fix_cmap(src).expect("changed");
        let t = s(&out);
        assert!(t.contains("<0001> <571F>"), "{t}"); // ⼟ → 土
        assert!(t.contains("<0002> <0041>"), "{t}");
        assert!(t.contains("2 beginbfchar"), "{t}");
        assert!(t.trim_end().ends_with("endcmap"), "{t}");
    }

    #[test]
    fn no_target_is_untouched() {
        let src = b"1 beginbfchar\n<0001> <0041>\nendbfchar\n";
        assert!(fix_cmap(src).is_none());
    }

    #[test]
    fn bfrange_is_split_around_targets() {
        // <0010>-<0014> -> <2EFF>.. : 0x2F00 以降 (部首) は 0x2F00, 0x2F01, 0x2F02 の 3 件
        let src = b"1 beginbfrange\n<0010> <0014> <2EFE>\nendbfrange\n";
        let out = fix_cmap(src).expect("changed");
        let t = s(&out);
        // 0x2EFE は部首の範囲の外 (そのまま範囲)、0x2EFF も外
        assert!(t.contains("<0010> <0011> <2EFE>"), "{t}");
        // 0x2F00 -> 4E00, 0x2F01 -> 4E28, 0x2F02 -> 4E36 は 1 件ずつ
        assert!(t.contains("<0012> <0012> <4E00>"), "{t}");
        assert!(t.contains("<0013> <0013> <4E28>"), "{t}");
        assert!(t.contains("<0014> <0014> <4E36>"), "{t}");
        assert!(t.contains("4 beginbfrange"), "{t}");
    }

    #[test]
    fn bfrange_array_form() {
        let src = b"1 beginbfrange\n<0001> <0002> [<2F00> <0041>]\nendbfrange\n";
        let out = fix_cmap(src).expect("changed");
        let t = s(&out);
        assert!(t.contains("<0001> <0002> [ <4E00> <0041> ]"), "{t}");
    }

    #[test]
    fn multi_unit_destination() {
        // 「⽟⼊」の 2 文字を 1 つの文字コードに対応づけている
        let src = b"1 beginbfchar\n<0005> <2F5F2F0A>\nendbfchar\n";
        let out = fix_cmap(src).expect("changed");
        assert!(s(&out).contains("<0005> <"), "{}", s(&out));
    }

    #[test]
    fn unexpected_structure_is_left_alone() {
        // 空白を含む 16 進
        let src = b"1 beginbfchar\n<00 01> <2F00>\nendbfchar\n";
        assert!(fix_cmap(src).is_none());
    }

    #[test]
    fn sections_are_split_at_100() {
        let mut src = String::from("150 beginbfchar\n");
        for i in 0..150u32 {
            src.push_str(&format!("<{:04X}> <2F00>\n", i));
        }
        src.push_str("endbfchar\n");
        let out = fix_cmap(src.as_bytes()).expect("changed");
        let t = s(&out);
        assert!(t.contains("100 beginbfchar"), "{t}");
        assert!(t.contains("50 beginbfchar"), "{t}");
        assert_eq!(t.matches("<4E00>").count(), 150);
    }
}
