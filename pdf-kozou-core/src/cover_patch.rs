// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/cover_patch.rs
// hayro 版キープテキスト画像化の「隠し直しパッチ」(画素差分の計算部分)。
//
// 背景: キープテキスト版は、非テキスト要素を 1 枚の背景画像に焼き込み、テキストをその上に
// ベクターで重ねる。元の PDF で「後から描いた図形・画像でテキストの一部を隠していた」場合、
// 隠していた物は背景画像に入る一方、テキストは常に最前面に来るため、隠れていた文字が見えてしまう。
//
// 対処 (MuPDF 実装の kozou_keeptext_add_partial_covers と同じ考え方):
//   full : 元のページ全体の描画 (テキスト込み)
//   nt   : テキストを除いた描画 (背景画像の元になった画素)
//   bg   : 実際に埋め込む背景画像を復号した画素 (JPEG の場合は圧縮後の画素)
//   comp : 出力 PDF のページ (背景 + ベクターのテキスト) を描いた画素
// full と comp が食い違う画素のうち、テキストが描かれている近傍だけを対象に、
//   パッチ画素 = bg + (full - nt)   (元の見た目でテキストが与えていた変化分だけを背景に足す)
// を、マスク付きの小さな画像としてテキストの上に重ねる。
// 不透明な物に隠れていた文字は full == nt なので、パッチは背景と同じ画素になり、文字が消える。
// 半透明の物越しに薄く見えていた文字は、その薄い見え方で再現される。
//
// hayro は full も comp も同じエンジンで描くため、本当に見え方が違う箇所だけが差分になる。
// このモジュールは hayro / lopdf に依存しない (単体でテストできるようにするため)。

/// パッチ 1 枚分 (画像座標は左上原点・画素単位)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Patch {
    pub x0: u32,
    pub y0: u32,
    pub w: u32,
    pub h: u32,
    /// RGB8 (w*h*3)
    pub rgb: Vec<u8>,
    /// 8 ビットのマスク (w*h)。255 = パッチを描く
    pub mask: Vec<u8>,
}

/// 判定のしきい値
#[derive(Debug, Clone, Copy)]
pub struct Params {
    /// comp と bg の差がこの値を超えた画素を「テキストが描かれている」とみなす (0-255)
    pub text_thr: i32,
    /// comp と full の差がこの値を超えた画素を「見え方が違う」とみなす (0-255)
    pub diff_thr: i32,
    /// 差分マスクの膨張半径 (画素)。文字の縁のにじみまで覆う
    pub dilate: u32,
    /// 近接する領域をまとめるためのタイルの大きさ (画素)
    pub tile: u32,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            text_thr: 10,
            diff_thr: 28,
            dilate: 2,
            tile: 32,
        }
    }
}

#[inline]
fn max_abs_diff(a: &[u8], b: &[u8]) -> i32 {
    let mut m = 0;
    for c in 0..3 {
        let d = (a[c] as i32 - b[c] as i32).abs();
        if d > m {
            m = d;
        }
    }
    m
}

/// 正方形 (半径 r) の膨張。横→縦の 2 段階 (O(n*r))
fn dilate(src: &[bool], w: usize, h: usize, r: usize) -> Vec<bool> {
    if r == 0 {
        return src.to_vec();
    }
    let mut tmp = vec![false; w * h];
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        for x in 0..w {
            if row[x] {
                let (a, b) = (x.saturating_sub(r), (x + r).min(w - 1));
                for t in &mut tmp[y * w + a..=y * w + b] {
                    *t = true;
                }
            }
        }
    }
    let mut out = vec![false; w * h];
    for y in 0..h {
        for x in 0..w {
            if tmp[y * w + x] {
                let (a, b) = (y.saturating_sub(r), (y + r).min(h - 1));
                for yy in a..=b {
                    out[yy * w + x] = true;
                }
            }
        }
    }
    out
}

/// 差分からパッチを求める。いずれの画素列も RGB8 で `w`×`h`。
/// 長さが合わないとき・差分が無いときは空を返す。
pub fn compute_patches(
    full: &[u8],
    nt: &[u8],
    comp: &[u8],
    bg: &[u8],
    w: u32,
    h: u32,
    p: &Params,
) -> Vec<Patch> {
    let (wu, hu) = (w as usize, h as usize);
    let n = wu * hu;
    if n == 0 || [full, nt, comp, bg].iter().any(|s| s.len() != n * 3) {
        return Vec::new();
    }

    // テキストが描かれている画素 / その中で元の見た目と違う画素
    let mut text = vec![false; n];
    let mut bad = vec![false; n];
    let mut any_bad = false;
    for i in 0..n {
        let o = i * 3;
        if max_abs_diff(&comp[o..o + 3], &bg[o..o + 3]) > p.text_thr {
            text[i] = true;
            if max_abs_diff(&comp[o..o + 3], &full[o..o + 3]) > p.diff_thr {
                bad[i] = true;
                any_bad = true;
            }
        }
    }
    if !any_bad {
        return Vec::new();
    }

    // 縁のにじみまで覆う。ただし、テキストの近傍からは広げない
    let r = p.dilate as usize;
    let text_d = dilate(&text, wu, hu, r);
    let mut mask = dilate(&bad, wu, hu, r);
    for (m, t) in mask.iter_mut().zip(text_d.iter()) {
        *m = *m && *t;
    }

    // タイルの占有を 8 近傍でつなぎ、塊ごとに 1 枚のパッチにする
    let tile = p.tile.max(4) as usize;
    let (tx, ty) = (wu.div_ceil(tile), hu.div_ceil(tile));
    let mut occ = vec![false; tx * ty];
    for y in 0..hu {
        for x in 0..wu {
            if mask[y * wu + x] {
                occ[(y / tile) * tx + x / tile] = true;
            }
        }
    }
    let mut seen = vec![false; tx * ty];
    let mut patches = Vec::new();
    for start in 0..tx * ty {
        if !occ[start] || seen[start] {
            continue;
        }
        // 塊のタイルを集める
        let mut stack = vec![start];
        seen[start] = true;
        let mut tiles = Vec::new();
        while let Some(t) = stack.pop() {
            tiles.push(t);
            let (cx, cy) = ((t % tx) as i64, (t / tx) as i64);
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let (nx, ny) = (cx + dx, cy + dy);
                    if nx < 0 || ny < 0 || nx >= tx as i64 || ny >= ty as i64 {
                        continue;
                    }
                    let ni = ny as usize * tx + nx as usize;
                    if occ[ni] && !seen[ni] {
                        seen[ni] = true;
                        stack.push(ni);
                    }
                }
            }
        }
        // 塊の中のマスク画素の外接矩形
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0usize, 0usize);
        for &t in &tiles {
            let (ax, ay) = ((t % tx) * tile, (t / tx) * tile);
            for y in ay..(ay + tile).min(hu) {
                for x in ax..(ax + tile).min(wu) {
                    if mask[y * wu + x] {
                        x0 = x0.min(x);
                        y0 = y0.min(y);
                        x1 = x1.max(x + 1);
                        y1 = y1.max(y + 1);
                    }
                }
            }
        }
        if x1 <= x0 || y1 <= y0 {
            continue;
        }
        let (pw, ph) = (x1 - x0, y1 - y0);
        let mut rgb = Vec::with_capacity(pw * ph * 3);
        let mut m = Vec::with_capacity(pw * ph);
        for y in y0..y1 {
            for x in x0..x1 {
                let i = y * wu + x;
                let o = i * 3;
                for c in 0..3 {
                    let v = bg[o + c] as i32 + (full[o + c] as i32 - nt[o + c] as i32);
                    rgb.push(v.clamp(0, 255) as u8);
                }
                m.push(if mask[i] { 255 } else { 0 });
            }
        }
        patches.push(Patch {
            x0: x0 as u32,
            y0: y0 as u32,
            w: pw as u32,
            h: ph as u32,
            rgb,
            mask: m,
        });
    }
    patches
}

/// 層分割 (覆いをベクターのまま文字層に残す) の検証に使う値。
///
/// 覆いを背景から抜いて文字層へ移すと、元の描画順で覆いより後に描かれる画像・図形が、
/// 覆いの下に回ってしまうことがある。そこで、
///   予測 = 覆いの層 (白地と黒地の 2 回の描画から色とアルファを復元) を、覆いを除いた背景の上に重ねたもの
/// が、元の「文字を除いた描画」(nt) と一致するかを画素で確かめる。文字は元の順序のまま文字層に
/// 残るので、ここでは文字を除いた描画だけを比べる。
pub const LAYER_ERR_THR: i32 = 24;
/// 許す食い違いの画素数 = `LAYER_BAD_BASE + 画素数 / LAYER_BAD_DIV`
pub const LAYER_BAD_BASE: usize = 120;
pub const LAYER_BAD_DIV: usize = 10_000;
/// 覆いが、文字の近く (`text_near` が真の画素) に掛かっている画素数の下限。
/// 文字に掛からない覆いは、層分割せず従来どおり一枚画像に焼き込む。
pub const LAYER_MIN_OVERLAP: usize = 30;
/// 文字の画素を、覆いとの重なりの判定のために広げる半径 (画素)
pub const LAYER_TEXT_DILATE: usize = 3;
/// `text_near_mask` で、full と nt の差がこの値を超えた画素を文字とみなす (0-255)
const TEXT_DIFF_THR: i32 = 10;

/// 層分割の検証結果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayerCheck {
    /// 予測と nt が `LAYER_ERR_THR` を超えて食い違う画素数
    pub bad: usize,
    /// 覆い (アルファがある画素) が、文字の近くに掛かる画素数
    pub text_overlap: usize,
}

impl LayerCheck {
    /// 描画順を保てているか (予測との食い違いが少ないか)
    pub fn order_ok(&self, pixels: usize) -> bool {
        self.bad <= LAYER_BAD_BASE + pixels / LAYER_BAD_DIV
    }

    /// 描画順を保てていて、かつ覆いが文字に掛かっているか
    pub fn accepted(&self, pixels: usize) -> bool {
        self.order_ok(pixels) && self.text_overlap >= LAYER_MIN_OVERLAP
    }
}

/// 文字の画素 (`full` = 元のページ、`nt` = そこから文字を除いたもの。差がある画素) を
/// `r` 画素だけ四方に広げたマスクを返す。長さが合わなければ None。
pub fn text_near_mask(full: &[u8], nt: &[u8], w: u32, h: u32, r: usize) -> Option<Vec<bool>> {
    let (w, h) = (w as usize, h as usize);
    let n = w * h;
    if n == 0 || full.len() != n * 3 || nt.len() != n * 3 {
        return None;
    }
    let mut m = vec![false; n];
    for i in 0..n {
        m[i] = max_abs_diff(&full[i * 3..i * 3 + 3], &nt[i * 3..i * 3 + 3]) > TEXT_DIFF_THR;
    }
    if r == 0 {
        return Some(m);
    }
    // 横方向 → 縦方向の順に、半径 r の箱で広げる
    let mut hz = vec![false; n];
    for y in 0..h {
        let row = &m[y * w..(y + 1) * w];
        for x in 0..w {
            let lo = x.saturating_sub(r);
            let hi = (x + r).min(w - 1);
            hz[y * w + x] = row[lo..=hi].iter().any(|&b| b);
        }
    }
    let mut out = vec![false; n];
    for y in 0..h {
        let lo = y.saturating_sub(r);
        let hi = (y + r).min(h - 1);
        for x in 0..w {
            out[y * w + x] = (lo..=hi).any(|yy| hz[yy * w + x]);
        }
    }
    Some(out)
}

/// `mask` (w×h) の、矩形 `r = [x0, y0, x1, y1]` (画素座標、左上原点) の中の真の画素数。
/// 矩形は画像の範囲に切り詰める。
pub fn count_in_rect(mask: &[bool], w: u32, h: u32, r: [f64; 4]) -> usize {
    let (w, h) = (w as usize, h as usize);
    if mask.len() != w * h || w == 0 || h == 0 {
        return 0;
    }
    let x0 = r[0].floor().max(0.0) as usize;
    let y0 = r[1].floor().max(0.0) as usize;
    let x1 = (r[2].ceil().max(0.0) as usize).min(w);
    let y1 = (r[3].ceil().max(0.0) as usize).min(h);
    if x0 >= x1 || y0 >= y1 {
        return 0;
    }
    let mut n = 0;
    for y in y0..y1 {
        n += mask[y * w + x0..y * w + x1].iter().filter(|&&b| b).count();
    }
    n
}

/// 層分割を検証する。
/// - `nt`: 元の、文字を除いた描画
/// - `below`: そこから覆いも除いた描画 (覆いの下層)
/// - `cw` / `cb`: 覆いだけの描画を、白地・黒地に描いたもの
/// - `text_near`: `text_near_mask` の結果
///
/// 覆いの層の、チャンネルごとの (アルファ, 色) は
///   cw = A·C + (1−A)·255,  cb = A·C   →   (1−A) = (cw − cb) / 255
/// で復元でき、背景の上に重ねた予測は `cb + (cw − cb)/255 · below` になる。
/// 長さが合わなければ None。
pub fn check_layering(
    nt: &[u8],
    below: &[u8],
    cw: &[u8],
    cb: &[u8],
    text_near: &[bool],
    w: u32,
    h: u32,
) -> Option<LayerCheck> {
    let n = (w as usize) * (h as usize);
    if n == 0
        || [nt.len(), below.len(), cw.len(), cb.len()].iter().any(|&l| l != n * 3)
        || text_near.len() != n
    {
        return None;
    }
    let (mut bad, mut overlap) = (0usize, 0usize);
    for i in 0..n {
        let o = i * 3;
        let mut worst = 0i32;
        let mut covered = false;
        for c in 0..3 {
            let (wv, bv) = (cw[o + c] as i32, cb[o + c] as i32);
            // 覆いが塗らない画素は cw == 255, cb == 0 (透明)
            let trans = (wv - bv).clamp(0, 255);
            if trans < 250 {
                covered = true;
            }
            let pred = bv + (trans * below[o + c] as i32 + 127) / 255;
            worst = worst.max((pred - nt[o + c] as i32).abs());
        }
        if worst > LAYER_ERR_THR {
            bad += 1;
        }
        if covered && text_near[i] {
            overlap += 1;
        }
    }
    Some(LayerCheck {
        bad,
        text_overlap: overlap,
    })
}

/// 行列の合成 (`a` を先に適用し、次に `b`)。PDF の [a b c d e f]
pub fn mul(a: [f32; 6], b: [f32; 6]) -> [f32; 6] {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

/// 背景画像 (単位正方形に置く行列 `bg_m`、`tw`×`th` 画素) の部分矩形
/// (左上原点・画素単位 [x0,x1) × [y0,y1)) を、同じ位置に置く行列。
pub fn patch_matrix(bg_m: [f32; 6], x0: u32, y0: u32, x1: u32, y1: u32, tw: u32, th: u32) -> [f32; 6] {
    let (tw, th) = (tw as f32, th as f32);
    let local = [
        (x1 - x0) as f32 / tw,
        0.0,
        0.0,
        (y1 - y0) as f32 / th,
        x0 as f32 / tw,
        1.0 - y1 as f32 / th,
    ];
    mul(local, bg_m)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, v: u8) -> Vec<u8> {
        vec![v; (w * h * 3) as usize]
    }

    fn fill(img: &mut [u8], w: u32, x0: u32, y0: u32, x1: u32, y1: u32, v: u8) {
        for y in y0..y1 {
            for x in x0..x1 {
                let o = ((y * w + x) * 3) as usize;
                img[o..o + 3].fill(v);
            }
        }
    }

    #[test]
    fn no_diff_no_patch() {
        let (w, h) = (64, 48);
        let bg = solid(w, h, 255);
        let mut comp = bg.clone();
        fill(&mut comp, w, 10, 10, 20, 14, 0);
        let mut full = bg.clone();
        fill(&mut full, w, 10, 10, 20, 14, 0); // 元でも見えている文字
        let p = compute_patches(&full, &bg, &comp, &bg, w, h, &Params::default());
        assert!(p.is_empty());
    }

    #[test]
    fn hidden_text_is_covered_with_background() {
        let (w, h) = (64, 48);
        let mut bg = solid(w, h, 255);
        fill(&mut bg, w, 0, 0, 64, 48, 200); // 背景は灰色
        let nt = bg.clone();
        let full = bg.clone(); // 元では文字は見えない
        let mut comp = bg.clone();
        fill(&mut comp, w, 10, 10, 20, 14, 0); // 出力では文字が見える
        let ps = compute_patches(&full, &nt, &comp, &bg, w, h, &Params::default());
        assert_eq!(ps.len(), 1);
        let p = &ps[0];
        // 文字を含み、縁の膨張分 (2) だけ広い
        assert!(p.x0 <= 10 && p.y0 <= 10 && p.x0 + p.w >= 20 && p.y0 + p.h >= 14);
        assert!(p.x0 >= 8 && p.y0 >= 8);
        // 文字の位置のパッチ画素は背景と同じ、マスクは 255
        let (lx, ly) = (12 - p.x0, 11 - p.y0);
        let o = (ly * p.w + lx) as usize;
        assert_eq!(&p.rgb[o * 3..o * 3 + 3], &[200, 200, 200]);
        assert_eq!(p.mask[o], 255);
    }

    #[test]
    fn translucent_cover_keeps_faint_text() {
        let (w, h) = (64, 48);
        let bg = solid(w, h, 255);
        let nt = bg.clone();
        let mut full = bg.clone();
        fill(&mut full, w, 10, 10, 20, 14, 180); // 薄く見えていた
        let mut comp = bg.clone();
        fill(&mut comp, w, 10, 10, 20, 14, 0); // 出力では濃く見える
        let ps = compute_patches(&full, &nt, &comp, &bg, w, h, &Params::default());
        assert_eq!(ps.len(), 1);
        let p = &ps[0];
        let (lx, ly) = (12 - p.x0, 11 - p.y0);
        let o = ((ly * p.w + lx) * 3) as usize;
        assert_eq!(&p.rgb[o..o + 3], &[180, 180, 180]);
    }

    #[test]
    fn layering_matches_when_cover_is_on_top() {
        let (w, h) = (40u32, 30u32);
        let below = solid(w, h, 200);
        // 覆い: 赤 (255,0,0) をアルファ 0.5 で、(10..30, 10..20) に
        let (mut cw, mut cb) = (solid(w, h, 255), solid(w, h, 0));
        let mut nt = below.clone();
        for y in 10..20 {
            for x in 10..30 {
                let o = ((y * w + x) * 3) as usize;
                // 白地: 0.5·C + 0.5·255, 黒地: 0.5·C
                cw[o..o + 3].copy_from_slice(&[255, 128, 128]);
                cb[o..o + 3].copy_from_slice(&[128, 0, 0]);
                // 元の nt: 背景 200 の上に重ねた結果
                nt[o..o + 3].copy_from_slice(&[228, 100, 100]);
            }
        }
        let mut near = vec![false; (w * h) as usize];
        for x in 5..35 {
            near[(12 * w + x) as usize] = true;
        }
        let c = check_layering(&nt, &below, &cw, &cb, &near, w, h).unwrap();
        assert_eq!(c.bad, 0);
        assert_eq!(c.text_overlap, 20);
        assert!(c.accepted((w * h) as usize) == (c.text_overlap >= LAYER_MIN_OVERLAP));
    }

    #[test]
    fn layering_detects_later_paint_hiding_the_cover() {
        let (w, h) = (200u32, 100u32);
        let below = solid(w, h, 200);
        let (mut cw, mut cb) = (solid(w, h, 255), solid(w, h, 0));
        // 覆いは広い範囲を塗るが、元の描画では、後から描かれた不透明な図形 (nt が青) で隠れている
        let mut nt = below.clone();
        for y in 10..90 {
            for x in 10..190 {
                let o = ((y * w + x) * 3) as usize;
                cw[o..o + 3].copy_from_slice(&[255, 128, 128]);
                cb[o..o + 3].copy_from_slice(&[128, 0, 0]);
                nt[o..o + 3].copy_from_slice(&[0, 0, 255]);
            }
        }
        let near = vec![true; (w * h) as usize];
        let c = check_layering(&nt, &below, &cw, &cb, &near, w, h).unwrap();
        assert!(c.bad > 10_000);
        assert!(!c.accepted((w * h) as usize));
    }

    #[test]
    fn cover_away_from_text_is_not_accepted() {
        let (w, h) = (60u32, 40u32);
        let below = solid(w, h, 255);
        let (mut cw, mut cb) = (solid(w, h, 255), solid(w, h, 0));
        let mut nt = below.clone();
        for y in 5..35 {
            for x in 5..55 {
                let o = ((y * w + x) * 3) as usize;
                cw[o..o + 3].copy_from_slice(&[255, 200, 200]);
                cb[o..o + 3].copy_from_slice(&[0, 0, 0]);
                nt[o..o + 3].copy_from_slice(&[255, 200, 200]);
            }
        }
        // 文字は覆いから離れた隅だけ
        let mut full = nt.clone();
        full[0] = 0;
        let near = text_near_mask(&full, &nt, w, h, LAYER_TEXT_DILATE).unwrap();
        let c = check_layering(&nt, &below, &cw, &cb, &near, w, h).unwrap();
        assert_eq!(c.bad, 0);
        assert!(c.text_overlap < LAYER_MIN_OVERLAP);
        assert!(!c.accepted((w * h) as usize));
    }

    #[test]
    fn count_in_rect_clips_to_image() {
        let (w, h) = (10u32, 8u32);
        let mut m = vec![false; (w * h) as usize];
        m[(2 * w + 3) as usize] = true;
        m[(7 * w + 9) as usize] = true;
        assert_eq!(count_in_rect(&m, w, h, [3.0, 2.0, 4.0, 3.0]), 1);
        assert_eq!(count_in_rect(&m, w, h, [-5.0, -5.0, 100.0, 100.0]), 2);
        assert_eq!(count_in_rect(&m, w, h, [4.0, 3.0, 9.0, 7.0]), 0);
        assert_eq!(count_in_rect(&m, w, h, [50.0, 50.0, 60.0, 60.0]), 0);
    }

    #[test]
    fn text_near_mask_dilates() {
        let (w, h) = (20u32, 20u32);
        let nt = solid(w, h, 255);
        let mut full = nt.clone();
        let o = ((10 * w + 10) * 3) as usize;
        full[o..o + 3].copy_from_slice(&[0, 0, 0]);
        let m = text_near_mask(&full, &nt, w, h, 2).unwrap();
        assert!(m[(10 * w + 10) as usize] && m[(12 * w + 12) as usize] && m[(8 * w + 8) as usize]);
        assert!(!m[(13 * w + 10) as usize]);
    }

    #[test]
    fn far_regions_make_separate_patches() {
        let (w, h) = (256, 128);
        let bg = solid(w, h, 255);
        let mut comp = bg.clone();
        fill(&mut comp, w, 10, 10, 20, 14, 0);
        fill(&mut comp, w, 200, 100, 210, 104, 0);
        let ps = compute_patches(&bg, &bg, &comp, &bg, w, h, &Params::default());
        assert_eq!(ps.len(), 2);
    }

    #[test]
    fn size_mismatch_is_ignored() {
        let bg = solid(8, 8, 255);
        let ps = compute_patches(&bg, &bg, &bg[..10], &bg, 8, 8, &Params::default());
        assert!(ps.is_empty());
    }

    #[test]
    fn matrix_for_unrotated_background() {
        // 背景: 画素 100x50 を [0,0]-[200,100] pt に置く
        let m = [200.0, 0.0, 0.0, 100.0, 0.0, 0.0];
        // 左上 (0,0)-(50,25) の画素 → 左上 4 分の 1 = x:[0,100], y:[50,100]
        let q = patch_matrix(m, 0, 0, 50, 25, 100, 50);
        assert_eq!(q, [100.0, 0.0, 0.0, 50.0, 0.0, 50.0]);
    }
}
