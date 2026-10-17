// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// pdf-kozou-core/src/jpeg_lossless.rs
//
// ベースライン(逐次・ハフマン)JPEG の無劣化トリミング (jpegtran -crop 相当)。
//
// JPEG を一度ピクセルへ復号して切り出し、再エンコードすると、画質が劣化する
// うえ、切り出し位置が 8x8 (または 16x16) ブロック格子とずれるためブロック歪みも
// 増える。ここでは DCT 係数のまま MCU 単位で必要な範囲だけを残し、エントロピー
// 符号だけを書き直す。量子化テーブル・色空間・APPn(ICC 等)は元のまま引き継ぐ。
//
// 条件 (満たさなければ Err を返す。呼び出し側は従来の再エンコードに戻す):
//   - SOF0/SOF1 (ベースライン/拡張逐次ハフマン)、精度 8bit、スキャン 1 つ、
//     全成分を 1 スキャンに含む (インターリーブ、または 1 成分のみ)
//   - 切り出し位置 (x, y) が MCU の整数倍
//
// 出力のハフマンテーブルは、出力の符号頻度から作り直す (jpegtran -optimize 相当)。
// 元のテーブルに無い符号 (DC 差分が変わるため生じうる) が必要になっても失敗しない。
// リスタートマーカ (DRI) は出力では使わない。

/// 解析済みの JPEG の寸法と MCU 寸法。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JpegGeometry {
    pub width: u32,
    pub height: u32,
    /// MCU の大きさ (画素)。この整数倍の位置でだけ無劣化に切り出せる。
    pub mcu_w: u32,
    pub mcu_h: u32,
}

#[derive(Clone, Copy)]
struct Comp {
    id: u8,
    h: u8,
    v: u8,
}

struct Segment<'a> {
    marker: u8,
    /// マーカ(2バイト) + 長さ(2バイト) + 本体
    raw: &'a [u8],
}

struct Parsed<'a> {
    segs: Vec<Segment<'a>>,
    sof_index: usize,
    width: u32,
    height: u32,
    comps: Vec<Comp>,
    restart_interval: usize,
    /// スキャン内の成分の (frame 内インデックス, DC テーブル ID, AC テーブル ID)
    scan: Vec<(usize, u8, u8)>,
    sos_raw: &'a [u8],
    entropy: &'a [u8],
    dc_tables: [Option<DecTable>; 4],
    ac_tables: [Option<DecTable>; 4],
}

struct DecTable {
    mincode: [i32; 18],
    maxcode: [i32; 18],
    valptr: [i32; 18],
    vals: Vec<u8>,
}

impl DecTable {
    fn new(bits: &[u8; 17], vals: &[u8]) -> Result<DecTable, String> {
        let mut mincode = [0i32; 18];
        let mut maxcode = [-1i32; 18];
        let mut valptr = [0i32; 18];
        let mut code: i32 = 0;
        let mut k: i32 = 0;
        for l in 1..=16usize {
            valptr[l] = k;
            mincode[l] = code;
            code += bits[l] as i32;
            k += bits[l] as i32;
            maxcode[l] = if bits[l] > 0 { code - 1 } else { -1 };
            if code > (1 << l) {
                return Err("huffman table overflow".into());
            }
            code <<= 1;
        }
        if k as usize > vals.len() {
            return Err("huffman table truncated".into());
        }
        Ok(DecTable {
            mincode,
            maxcode,
            valptr,
            vals: vals.to_vec(),
        })
    }
}

fn be16(b: &[u8]) -> usize {
    ((b[0] as usize) << 8) | b[1] as usize
}

fn parse(data: &[u8]) -> Result<Parsed<'_>, String> {
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return Err("not a JPEG".into());
    }
    let mut pos = 2usize;
    let mut segs: Vec<Segment> = Vec::new();
    let mut sof_index = usize::MAX;
    let (mut width, mut height) = (0u32, 0u32);
    let mut comps: Vec<Comp> = Vec::new();
    let mut restart_interval = 0usize;
    let mut dc_tables: [Option<DecTable>; 4] = [None, None, None, None];
    let mut ac_tables: [Option<DecTable>; 4] = [None, None, None, None];
    loop {
        // マーカの前の 0xFF 詰めを読み飛ばす
        while pos < data.len() && data[pos] == 0xFF && pos + 1 < data.len() && data[pos + 1] == 0xFF
        {
            pos += 1;
        }
        if pos + 2 > data.len() || data[pos] != 0xFF {
            return Err("marker expected".into());
        }
        let marker = data[pos + 1];
        match marker {
            0xD9 => return Err("EOI before SOS".into()),
            0x01 | 0xD0..=0xD7 => {
                pos += 2;
                continue;
            }
            _ => {}
        }
        if pos + 4 > data.len() {
            return Err("truncated segment".into());
        }
        let len = be16(&data[pos + 2..]);
        if len < 2 || pos + 2 + len > data.len() {
            return Err("bad segment length".into());
        }
        let raw = &data[pos..pos + 2 + len];
        let body = &raw[4..];
        match marker {
            0xC0 | 0xC1 => {
                if sof_index != usize::MAX {
                    return Err("multiple SOF".into());
                }
                if body.len() < 6 || body[0] != 8 {
                    return Err("unsupported precision".into());
                }
                height = be16(&body[1..]) as u32;
                width = be16(&body[3..]) as u32;
                let nf = body[5] as usize;
                if height == 0 || width == 0 || nf == 0 || nf > 4 || body.len() < 6 + nf * 3 {
                    return Err("bad SOF".into());
                }
                comps.clear();
                for i in 0..nf {
                    let c = &body[6 + i * 3..];
                    let (h, v) = (c[1] >> 4, c[1] & 15);
                    if h == 0 || v == 0 || h > 4 || v > 4 {
                        return Err("bad sampling factor".into());
                    }
                    comps.push(Comp { id: c[0], h, v });
                }
                sof_index = segs.len();
            }
            0xC2 | 0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => {
                return Err("progressive/lossless/arithmetic JPEG not supported".into());
            }
            0xC4 => {
                let mut p = 0usize;
                while p < body.len() {
                    if p + 17 > body.len() {
                        return Err("bad DHT".into());
                    }
                    let tc = body[p] >> 4;
                    let th = (body[p] & 15) as usize;
                    let mut bits = [0u8; 17];
                    bits[1..17].copy_from_slice(&body[p + 1..p + 17]);
                    let n: usize = bits[1..].iter().map(|&b| b as usize).sum();
                    if th > 3 || tc > 1 || p + 17 + n > body.len() {
                        return Err("bad DHT".into());
                    }
                    let t = DecTable::new(&bits, &body[p + 17..p + 17 + n])?;
                    if tc == 0 {
                        dc_tables[th] = Some(t);
                    } else {
                        ac_tables[th] = Some(t);
                    }
                    p += 17 + n;
                }
            }
            0xDD => {
                if body.len() < 2 {
                    return Err("bad DRI".into());
                }
                restart_interval = be16(body);
            }
            0xDA => {
                if sof_index == usize::MAX {
                    return Err("SOS before SOF".into());
                }
                let ns = body[0] as usize;
                if ns == 0 || ns > 4 || body.len() < 1 + ns * 2 + 3 {
                    return Err("bad SOS".into());
                }
                if ns != comps.len() {
                    return Err("multi-scan JPEG not supported".into());
                }
                let (ss, se, ahl) = (body[1 + ns * 2], body[2 + ns * 2], body[3 + ns * 2]);
                if ss != 0 || se != 63 || ahl != 0 {
                    return Err("not a sequential scan".into());
                }
                let mut scan = Vec::new();
                for i in 0..ns {
                    let cid = body[1 + i * 2];
                    let tt = body[2 + i * 2];
                    let fi = comps
                        .iter()
                        .position(|c| c.id == cid)
                        .ok_or("scan component not in frame")?;
                    if (tt >> 4) > 3 || (tt & 15) > 3 {
                        return Err("bad table id".into());
                    }
                    if scan.iter().any(|&(f, _, _)| f == fi) {
                        return Err("duplicate scan component".into());
                    }
                    scan.push((fi, tt >> 4, tt & 15));
                }
                let entropy = &data[pos + 2 + len..];
                return Ok(Parsed {
                    segs,
                    sof_index,
                    width,
                    height,
                    comps,
                    restart_interval,
                    scan,
                    sos_raw: raw,
                    entropy,
                    dc_tables,
                    ac_tables,
                });
            }
            _ => {}
        }
        segs.push(Segment { marker, raw });
        pos += 2 + len;
    }
}

/// 出力に引き継ぐマーカかどうか。
///
/// 切り出し後の画像に、切り落とした範囲の情報が残ってはならない。EXIF/XMP (APP1)
/// や Photoshop (APP13) にはサムネイルや元の寸法が、MPF (APP2) には別画像への
/// オフセットが入りうるし、コメントにも任意の文字列が入る。そのため、色の再現に
/// 必要なものだけ残す:
///   - 量子化テーブル (DQT)・フレーム (SOF)
///   - ICC プロファイル (APP2 "ICC_PROFILE")
///   - Adobe (APP14 "Adobe": 色変換の指定)
///   - JFIF (APP0 "JFIF") は、サムネイルが無い場合のみ
fn keep_segment(s: &Segment) -> bool {
    let body = &s.raw[4..];
    match s.marker {
        0xDB | 0xC0 | 0xC1 => true,
        0xE0 => body.len() >= 14 && &body[..5] == b"JFIF\0" && body[12] == 0 && body[13] == 0,
        0xE2 => body.len() >= 12 && &body[..12] == b"ICC_PROFILE\0",
        0xEE => body.len() >= 5 && &body[..5] == b"Adobe",
        _ => false,
    }
}

fn geometry_of(p: &Parsed) -> JpegGeometry {
    let (hmax, vmax) = if p.comps.len() == 1 {
        (1u32, 1u32)
    } else {
        (
            p.comps.iter().map(|c| c.h as u32).max().unwrap_or(1),
            p.comps.iter().map(|c| c.v as u32).max().unwrap_or(1),
        )
    };
    JpegGeometry {
        width: p.width,
        height: p.height,
        mcu_w: 8 * hmax,
        mcu_h: 8 * vmax,
    }
}

/// 無劣化トリミングの対象にできる JPEG なら、寸法と MCU 寸法を返す。
pub fn jpeg_geometry(data: &[u8]) -> Option<JpegGeometry> {
    parse(data).ok().map(|p| geometry_of(&p))
}

// ---------------------------------------------------------------------
// エントロピー復号
// ---------------------------------------------------------------------

struct BitReader<'a> {
    d: &'a [u8],
    pos: usize,
    acc: u32,
    nbits: u32,
}

impl<'a> BitReader<'a> {
    fn new(d: &'a [u8]) -> Self {
        BitReader {
            d,
            pos: 0,
            acc: 0,
            nbits: 0,
        }
    }

    fn get_bit(&mut self) -> Result<u32, String> {
        if self.nbits == 0 {
            self.fill_some()?;
        }
        let b = self.acc >> 31;
        self.acc <<= 1;
        self.nbits -= 1;
        Ok(b)
    }

    /// 1 バイトだけ補充する (マーカ直前でも、残りビットがあれば読めるように)。
    fn fill_some(&mut self) -> Result<(), String> {
        let b = *self.d.get(self.pos).ok_or("unexpected end of scan")?;
        if b == 0xFF {
            let nx = *self.d.get(self.pos + 1).ok_or("unexpected end of scan")?;
            if nx != 0x00 {
                return Err("marker in scan".into());
            }
            self.pos += 2;
        } else {
            self.pos += 1;
        }
        self.acc |= (b as u32) << (24 - self.nbits);
        self.nbits += 8;
        Ok(())
    }

    fn receive(&mut self, n: u32) -> Result<i32, String> {
        let mut v = 0i32;
        for _ in 0..n {
            v = (v << 1) | self.get_bit()? as i32;
        }
        Ok(v)
    }

    /// リスタート区間の境界: 残りビットを捨て、RSTn マーカを 1 つ読み飛ばす。
    fn restart(&mut self) -> Result<(), String> {
        self.acc = 0;
        self.nbits = 0;
        // 詰めバイト 0xFF を許容してマーカを探す
        while self.pos < self.d.len() && self.d[self.pos] != 0xFF {
            self.pos += 1; // 区間末尾の端数ビットのバイトは捨てる (通常は存在しない)
        }
        while self.pos + 1 < self.d.len() && self.d[self.pos] == 0xFF && self.d[self.pos + 1] == 0xFF
        {
            self.pos += 1;
        }
        if self.pos + 1 >= self.d.len() {
            return Err("restart marker missing".into());
        }
        let m = self.d[self.pos + 1];
        if !(0xD0..=0xD7).contains(&m) {
            return Err("restart marker expected".into());
        }
        self.pos += 2;
        Ok(())
    }
}

fn decode_sym(br: &mut BitReader, t: &DecTable) -> Result<u8, String> {
    let mut code: i32 = 0;
    for l in 1..=16usize {
        code = (code << 1) | br.get_bit()? as i32;
        if t.maxcode[l] >= 0 && code <= t.maxcode[l] && code >= t.mincode[l] {
            let idx = (t.valptr[l] + code - t.mincode[l]) as usize;
            return t.vals.get(idx).copied().ok_or_else(|| "bad huffman code".into());
        }
    }
    Err("bad huffman code".into())
}

fn extend(v: i32, t: u32) -> i32 {
    if t == 0 {
        0
    } else if v < (1 << (t - 1)) {
        v - (1 << t) + 1
    } else {
        v
    }
}

// ---------------------------------------------------------------------
// エントロピー符号化 (出力側)
// ---------------------------------------------------------------------

struct BitWriter {
    out: Vec<u8>,
    acc: u64,
    nbits: u32,
}

impl BitWriter {
    fn new() -> Self {
        BitWriter {
            out: Vec::new(),
            acc: 0,
            nbits: 0,
        }
    }
    fn put(&mut self, code: u32, len: u32) {
        if len == 0 {
            return;
        }
        self.acc = (self.acc << len) | (code as u64 & ((1u64 << len) - 1));
        self.nbits += len;
        while self.nbits >= 8 {
            let b = ((self.acc >> (self.nbits - 8)) & 0xFF) as u8;
            self.out.push(b);
            if b == 0xFF {
                self.out.push(0x00);
            }
            self.nbits -= 8;
        }
    }
    fn finish(mut self) -> Vec<u8> {
        if self.nbits > 0 {
            let pad = 8 - self.nbits;
            self.put((1u32 << pad) - 1, pad);
        }
        self.out
    }
}

struct EncTable {
    code: [u32; 256],
    len: [u8; 256],
    bits: [u8; 17],
    vals: Vec<u8>,
}

/// jpeg_gen_optimal_table (libjpeg, jchuff.c) と同じ手順で、頻度から最適な
/// ハフマンテーブル (符号長 16 ビット以下) を作る。
fn build_optimal(freq_in: &[u64; 256]) -> EncTable {
    let mut freq = [0i64; 257];
    for i in 0..256 {
        freq[i] = freq_in[i] as i64;
    }
    freq[256] = 1; // 全て 1 の符号が出現しないようにする予約記号
    let mut codesize = [0i32; 257];
    let mut others = [-1i32; 257];
    loop {
        let mut c1: i32 = -1;
        let mut v = i64::MAX;
        for i in 0..=256usize {
            if freq[i] != 0 && freq[i] <= v {
                v = freq[i];
                c1 = i as i32;
            }
        }
        let mut c2: i32 = -1;
        v = i64::MAX;
        for i in 0..=256usize {
            if freq[i] != 0 && freq[i] <= v && i as i32 != c1 {
                v = freq[i];
                c2 = i as i32;
            }
        }
        if c2 < 0 {
            break;
        }
        freq[c1 as usize] += freq[c2 as usize];
        freq[c2 as usize] = 0;
        let mut a = c1;
        codesize[a as usize] += 1;
        while others[a as usize] >= 0 {
            a = others[a as usize];
            codesize[a as usize] += 1;
        }
        others[a as usize] = c2;
        let mut b = c2;
        codesize[b as usize] += 1;
        while others[b as usize] >= 0 {
            b = others[b as usize];
            codesize[b as usize] += 1;
        }
    }
    let mut bits = [0i32; 64];
    for i in 0..=256usize {
        if codesize[i] > 0 {
            let l = (codesize[i] as usize).min(63);
            bits[l] += 1;
        }
    }
    // 符号長を 16 ビット以下に収める (Annex K.2 Figure K.3)
    let mut i = 63usize;
    while i > 16 {
        while bits[i] > 0 {
            let mut j = i - 2;
            while bits[j] == 0 {
                j -= 1;
            }
            bits[i] -= 2;
            bits[i - 1] += 1;
            bits[j + 1] += 2;
            bits[j] -= 1;
        }
        i -= 1;
    }
    // 予約記号の分を除く
    let mut i = 16usize;
    while bits[i] == 0 {
        i -= 1;
    }
    bits[i] -= 1;

    let mut vals: Vec<u8> = Vec::new();
    for l in 1..=32usize {
        for s in 0..256usize {
            if codesize[s] as usize == l {
                vals.push(s as u8);
            }
        }
    }
    let mut tb = [0u8; 17];
    for l in 1..=16usize {
        tb[l] = bits[l] as u8;
    }
    // 正準ハフマン符号の割り当て
    let mut t = EncTable {
        code: [0; 256],
        len: [0; 256],
        bits: tb,
        vals,
    };
    let mut code: u32 = 0;
    let mut k = 0usize;
    for l in 1..=16usize {
        for _ in 0..t.bits[l] {
            let s = t.vals[k] as usize;
            t.code[s] = code;
            t.len[s] = l as u8;
            code += 1;
            k += 1;
        }
        code <<= 1;
    }
    t
}

fn size_of(v: i32) -> u32 {
    let a = v.unsigned_abs();
    32 - a.leading_zeros()
}

// ---------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------

/// 無劣化トリミング。`x`,`y` は MCU 寸法の整数倍、`w`,`h` は 1 以上で
/// `x+w <= width`, `y+h <= height`。成功すると、寸法が w×h の JPEG を返す。
pub fn crop_jpeg_lossless(data: &[u8], x: u32, y: u32, w: u32, h: u32) -> Result<Vec<u8>, String> {
    let p = parse(data)?;
    let g = geometry_of(&p);
    if w == 0 || h == 0 || x.checked_add(w).is_none_or(|e| e > g.width)
        || y.checked_add(h).is_none_or(|e| e > g.height)
    {
        return Err("crop rect out of range".into());
    }
    if x % g.mcu_w != 0 || y % g.mcu_h != 0 {
        return Err("crop origin is not MCU aligned".into());
    }
    for &(_, td, ta) in &p.scan {
        if p.dc_tables[td as usize].is_none() || p.ac_tables[ta as usize].is_none() {
            return Err("missing huffman table".into());
        }
    }

    let mcus_x = g.width.div_ceil(g.mcu_w) as usize;
    let mcus_y = g.height.div_ceil(g.mcu_h) as usize;
    let kx0 = (x / g.mcu_w) as usize;
    let ky0 = (y / g.mcu_h) as usize;
    let kx1 = ((x + w).div_ceil(g.mcu_w) as usize).min(mcus_x);
    let ky1 = ((y + h).div_ceil(g.mcu_h) as usize).min(mcus_y);
    let out_mx = kx1 - kx0;
    let out_my = ky1 - ky0;

    // スキャン内の各成分の 1 MCU あたりのブロック数
    let single = p.comps.len() == 1;
    let blocks_per_comp: Vec<usize> = p
        .scan
        .iter()
        .map(|&(fi, _, _)| {
            if single {
                1
            } else {
                p.comps[fi].h as usize * p.comps[fi].v as usize
            }
        })
        .collect();
    let blocks_per_mcu: usize = blocks_per_comp.iter().sum();

    // 残す MCU の係数だけを保持する (DC は絶対値、AC はそのまま)
    let mut kept: Vec<i16> = Vec::with_capacity(out_mx * out_my * blocks_per_mcu * 64);

    let mut br = BitReader::new(p.entropy);
    let mut pred = vec![0i32; p.scan.len()];
    let mut mcu_count = 0usize;
    'rows: for my in 0..mcus_y {
        if my >= ky1 {
            break 'rows;
        }
        for mx in 0..mcus_x {
            if p.restart_interval > 0 && mcu_count > 0 && mcu_count % p.restart_interval == 0 {
                br.restart()?;
                pred.iter_mut().for_each(|v| *v = 0);
            }
            mcu_count += 1;
            let keep = my >= ky0 && mx >= kx0 && mx < kx1;
            for (ci, &(_, td, ta)) in p.scan.iter().enumerate() {
                let dct = p.dc_tables[td as usize].as_ref().unwrap();
                let act = p.ac_tables[ta as usize].as_ref().unwrap();
                for _ in 0..blocks_per_comp[ci] {
                    let mut blk = [0i16; 64];
                    let t = decode_sym(&mut br, dct)? as u32;
                    if t > 15 {
                        return Err("bad DC category".into());
                    }
                    let diff = if t == 0 { 0 } else { extend(br.receive(t)?, t) };
                    pred[ci] += diff;
                    blk[0] = pred[ci] as i16;
                    let mut k = 1usize;
                    while k < 64 {
                        let rs = decode_sym(&mut br, act)?;
                        let (r, s) = ((rs >> 4) as usize, (rs & 15) as u32);
                        if s == 0 {
                            if r == 15 {
                                k += 16;
                                continue;
                            }
                            break;
                        }
                        k += r;
                        if k > 63 {
                            return Err("AC index overflow".into());
                        }
                        blk[k] = extend(br.receive(s)?, s) as i16;
                        k += 1;
                    }
                    if keep {
                        kept.extend_from_slice(&blk);
                    }
                }
            }
        }
    }
    if kept.len() != out_mx * out_my * blocks_per_mcu * 64 {
        return Err("kept block count mismatch".into());
    }

    // ---- 符号頻度を数えて最適テーブルを作る ----
    let mut dc_freq = [[0u64; 256]; 4];
    let mut ac_freq = [[0u64; 256]; 4];
    {
        let mut pred = vec![0i32; p.scan.len()];
        let mut off = 0usize;
        for _ in 0..out_mx * out_my {
            for (ci, &(_, td, ta)) in p.scan.iter().enumerate() {
                for _ in 0..blocks_per_comp[ci] {
                    let blk = &kept[off..off + 64];
                    off += 64;
                    let diff = blk[0] as i32 - pred[ci];
                    pred[ci] = blk[0] as i32;
                    dc_freq[td as usize][size_of(diff) as usize] += 1;
                    let mut run = 0u32;
                    for &c in &blk[1..] {
                        if c == 0 {
                            run += 1;
                        } else {
                            while run > 15 {
                                ac_freq[ta as usize][0xF0] += 1;
                                run -= 16;
                            }
                            ac_freq[ta as usize][((run << 4) | size_of(c as i32)) as usize] += 1;
                            run = 0;
                        }
                    }
                    if run > 0 {
                        ac_freq[ta as usize][0x00] += 1;
                    }
                }
            }
        }
    }
    let mut dc_enc: [Option<EncTable>; 4] = [None, None, None, None];
    let mut ac_enc: [Option<EncTable>; 4] = [None, None, None, None];
    for i in 0..4 {
        if dc_freq[i].iter().any(|&f| f > 0) {
            dc_enc[i] = Some(build_optimal(&dc_freq[i]));
        }
        if ac_freq[i].iter().any(|&f| f > 0) {
            ac_enc[i] = Some(build_optimal(&ac_freq[i]));
        }
    }

    // ---- 符号化 ----
    let mut bw = BitWriter::new();
    {
        let mut pred = vec![0i32; p.scan.len()];
        let mut off = 0usize;
        for _ in 0..out_mx * out_my {
            for (ci, &(_, td, ta)) in p.scan.iter().enumerate() {
                let dt = dc_enc[td as usize].as_ref().unwrap();
                let at = ac_enc[ta as usize].as_ref().unwrap();
                for _ in 0..blocks_per_comp[ci] {
                    let blk = &kept[off..off + 64];
                    off += 64;
                    let diff = blk[0] as i32 - pred[ci];
                    pred[ci] = blk[0] as i32;
                    let s = size_of(diff);
                    bw.put(dt.code[s as usize], dt.len[s as usize] as u32);
                    if s > 0 {
                        let v = if diff < 0 { diff - 1 } else { diff };
                        bw.put(v as u32, s);
                    }
                    let mut run = 0u32;
                    for &c in &blk[1..] {
                        if c == 0 {
                            run += 1;
                        } else {
                            while run > 15 {
                                bw.put(at.code[0xF0], at.len[0xF0] as u32);
                                run -= 16;
                            }
                            let sz = size_of(c as i32);
                            let sym = ((run << 4) | sz) as usize;
                            bw.put(at.code[sym], at.len[sym] as u32);
                            let v = if c < 0 { c as i32 - 1 } else { c as i32 };
                            bw.put(v as u32, sz);
                            run = 0;
                        }
                    }
                    if run > 0 {
                        bw.put(at.code[0x00], at.len[0x00] as u32);
                    }
                }
            }
        }
    }
    let scan_data = bw.finish();

    // ---- ファイルを組み立てる ----
    let mut out: Vec<u8> = Vec::with_capacity(scan_data.len() + 1024);
    out.extend_from_slice(&[0xFF, 0xD8]);
    for (i, s) in p.segs.iter().enumerate() {
        match s.marker {
            0xC4 | 0xDD => continue, // DHT は作り直し、DRI は使わない
            _ => {}
        }
        if !keep_segment(s) {
            continue;
        }
        if i == p.sof_index {
            let mut raw = s.raw.to_vec();
            raw[5] = (h >> 8) as u8;
            raw[6] = h as u8;
            raw[7] = (w >> 8) as u8;
            raw[8] = w as u8;
            out.extend_from_slice(&raw);
        } else {
            out.extend_from_slice(s.raw);
        }
    }
    for (class, tabs) in [(0u8, &dc_enc), (1u8, &ac_enc)] {
        for (id, t) in tabs.iter().enumerate() {
            if let Some(t) = t {
                let n = t.vals.len();
                let len = 2 + 1 + 16 + n;
                out.extend_from_slice(&[0xFF, 0xC4, (len >> 8) as u8, len as u8]);
                out.push((class << 4) | id as u8);
                out.extend_from_slice(&t.bits[1..17]);
                out.extend_from_slice(&t.vals);
            }
        }
    }
    out.extend_from_slice(p.sos_raw);
    out.extend_from_slice(&scan_data);
    out.extend_from_slice(&[0xFF, 0xD9]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::jpeg::JpegEncoder;
    use image::{ColorType, ImageEncoder};

    fn gradient_rgb(w: u32, h: u32) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h {
            for x in 0..w {
                v.push(((x * 7 + y * 3) % 256) as u8);
                v.push(((x * 2 + y * 11 + (x * y) / 5) % 256) as u8);
                v.push(((x * 13 ^ y * 5) % 256) as u8);
            }
        }
        v
    }

    fn encode_rgb(w: u32, h: u32, q: u8) -> Vec<u8> {
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, q)
            .write_image(&gradient_rgb(w, h), w, h, ColorType::Rgb8.into())
            .unwrap();
        out
    }

    fn decode(d: &[u8]) -> image::RgbImage {
        image::load_from_memory_with_format(d, image::ImageFormat::Jpeg)
            .unwrap()
            .to_rgb8()
    }

    #[test]
    fn lossless_crop_matches_decoded_crop() {
        let src = encode_rgb(203, 157, 85);
        let g = jpeg_geometry(&src).expect("supported");
        assert_eq!((g.width, g.height), (203, 157));
        let (x, y) = (g.mcu_w * 2, g.mcu_h * 3);
        let (w, h) = (203 - x - 5, 157 - y - 2);
        let out = crop_jpeg_lossless(&src, x, y, w, h).unwrap();
        let a = decode(&src);
        let b = decode(&out);
        assert_eq!((b.width(), b.height()), (w, h));
        for j in 0..h {
            for i in 0..w {
                assert_eq!(a.get_pixel(x + i, y + j), b.get_pixel(i, j), "px {i},{j}");
            }
        }
        assert!(out.len() < src.len());
    }

    #[test]
    fn full_frame_is_bit_exact_pixels() {
        let src = encode_rgb(64, 48, 90);
        let out = crop_jpeg_lossless(&src, 0, 0, 64, 48).unwrap();
        assert_eq!(decode(&src), decode(&out));
    }

    #[test]
    fn rejects_unaligned_origin() {
        let src = encode_rgb(64, 48, 90);
        assert!(crop_jpeg_lossless(&src, 3, 0, 32, 32).is_err());
    }

    #[test]
    fn gray_crop() {
        let (w, h) = (96u32, 80u32);
        let g: Vec<u8> = (0..w * h).map(|i| ((i * 31 + i / 7) % 256) as u8).collect();
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, 80)
            .write_image(&g, w, h, ColorType::L8.into())
            .unwrap();
        let geo = jpeg_geometry(&out).unwrap();
        assert_eq!((geo.mcu_w, geo.mcu_h), (8, 8));
        let c = crop_jpeg_lossless(&out, 16, 8, 50, 40).unwrap();
        let a = image::load_from_memory(&out).unwrap().to_luma8();
        let b = image::load_from_memory(&c).unwrap().to_luma8();
        for j in 0..40 {
            for i in 0..50 {
                assert_eq!(a.get_pixel(16 + i, 8 + j), b.get_pixel(i, j));
            }
        }
    }

    /// EXIF (サムネイルを含みうる) とコメントは、出力に残らない。
    #[test]
    fn metadata_that_could_leak_cropped_area_is_dropped() {
        let src = encode_rgb(64, 48, 90);
        let mut with_meta = vec![0xFFu8, 0xD8];
        let exif: &[u8] = b"Exif\0\0THUMBNAIL-OF-WHOLE-IMAGE";
        with_meta.extend_from_slice(&[0xFF, 0xE1, 0, (exif.len() + 2) as u8]);
        with_meta.extend_from_slice(exif);
        let com: &[u8] = b"SECRET-COMMENT";
        with_meta.extend_from_slice(&[0xFF, 0xFE, 0, (com.len() + 2) as u8]);
        with_meta.extend_from_slice(com);
        with_meta.extend_from_slice(&src[2..]);
        let out = crop_jpeg_lossless(&with_meta, 0, 0, 40, 40).unwrap();
        let has = |needle: &[u8]| out.windows(needle.len()).any(|w| w == needle);
        assert!(!has(b"THUMBNAIL") && !has(b"SECRET") && !has(b"Exif"));
        assert_eq!(decode(&out).width(), 40);
    }

    #[test]
    fn progressive_is_rejected() {
        // SOF2 を含む最小のダミー
        let d = [
            0xFFu8, 0xD8, 0xFF, 0xC2, 0x00, 0x0B, 8, 0, 8, 0, 8, 1, 1, 0x11, 0, 0xFF, 0xD9,
        ];
        assert!(jpeg_geometry(&d).is_none());
    }
}
