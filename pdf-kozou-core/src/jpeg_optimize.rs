// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/jpeg_optimize.rs
// JPEG の可逆最適化 (jpegtran 方式)。
//
//   - エントロピー符号化をやり直す (DCT 係数は変えない = 画素は不変)
//   - ハフマン表の最適化 (jpegtran -optimize)
//   - プログレッシブ化 (jpegtran -progressive)。ベースライン最適化と比べて小さい方を採用
//   - ICC プロファイルは保持。Adobe APP14 (色変換の判定に必要) と JFIF も保持。
//     EXIF / XMP / コメントなど、PDF の画像表示に不要なマーカーは落とす
//   - 結果は元の JPEG と画素が完全に一致することをデコードして確認し、
//     一致しない・元より大きい・処理に失敗した場合は None を返す (呼び出し側は元を使う)
//
// 実装は純 Rust の libjpeg-turbo-rs (係数領域の transform)。
// 画素を一切触らないため、再圧縮による画質劣化は無い。

use libjpeg_turbo_rs::{MarkerCopyMode, TransformOp, TransformOptions, transform_jpeg_with_options};

/// 最適化結果
pub struct Optimized {
    pub bytes: Vec<u8>,
    /// プログレッシブ JPEG として出力したか
    pub progressive: bool,
}

/// `data` を可逆最適化する。元より小さくなり、かつ画素が不変と確認できたときだけ Some。
pub fn optimize_jpeg(data: &[u8]) -> Option<Optimized> {
    // 標準的な Gray / 3 成分 (YCbCr, RGB) のみ対象。CMYK/YCCK 等は検証できないので触らない。
    if !is_supported(data) {
        return None;
    }

    let mut candidates: Vec<Optimized> = Vec::new();
    for progressive in [false, true] {
        let opts = TransformOptions {
            op: TransformOp::None,
            optimize: true,
            progressive,
            copy_markers: MarkerCopyMode::All,
            ..Default::default()
        };
        let Ok(out) = transform_jpeg_with_options(data, &opts) else {
            continue;
        };
        let bytes = strip_markers(&out).unwrap_or(out);
        if bytes.len() < data.len() {
            candidates.push(Optimized { bytes, progressive });
        }
    }
    // 小さい順に、画素が一致する最初の候補を採用
    candidates.sort_by_key(|c| c.bytes.len());
    let original = decode(data)?;
    candidates
        .into_iter()
        .find(|c| decode(&c.bytes).is_some_and(|px| px == original))
}

/// デコード結果 (寸法と画素)。デコードできなければ None。
fn decode(data: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let img = image::load_from_memory_with_format(data, image::ImageFormat::Jpeg).ok()?;
    let (w, h) = (img.width(), img.height());
    Some((w, h, img.into_bytes()))
}

// ── JPEG マーカーの走査 ──────────────────────────────────────────────────────

/// SOF から成分数を読み、1 または 3 成分なら対象とする (SOI で始まること)
fn is_supported(data: &[u8]) -> bool {
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return false;
    }
    let mut i = 2;
    while i + 4 <= data.len() {
        if data[i] != 0xFF {
            return false;
        }
        let m = data[i + 1];
        if m == 0xFF {
            i += 1;
            continue;
        }
        if m == 0xD9 || m == 0xDA {
            return false; // SOF が見つからないまま EOI / SOS
        }
        if (0xD0..=0xD7).contains(&m) || m == 0x01 || m == 0xD8 {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
        if len < 2 || i + 2 + len > data.len() {
            return false;
        }
        // SOF0..SOF15 (DHT=C4, JPG=C8, DAC=CC を除く)。算術符号化 (C9 以降) は対象外
        if (0xC0..=0xCF).contains(&m) && m != 0xC4 && m != 0xC8 && m != 0xCC {
            if !matches!(m, 0xC0..=0xC2) {
                return false; // ロスレス / 算術符号化 / 階層型など
            }
            let nf = *data.get(i + 9).unwrap_or(&0);
            return nf == 1 || nf == 3;
        }
        i += 2 + len;
    }
    false
}

/// SOS より前のマーカーのうち、表示に不要なものを落とす。
/// 残す: SOF/DHT/DQT/DRI などの構造マーカー、APP0 (JFIF)、APP2 (ICC)、APP14 (Adobe)。
/// 落とす: APP1 (EXIF/XMP)、その他の APPn、COM。
fn strip_markers(data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return None;
    }
    let mut out = Vec::with_capacity(data.len());
    out.extend_from_slice(&data[..2]);
    let mut i = 2;
    loop {
        if i + 2 > data.len() || data[i] != 0xFF {
            return None;
        }
        let m = data[i + 1];
        if m == 0xFF {
            i += 1;
            continue;
        }
        if m == 0xDA {
            // SOS 以降 (エントロピー符号化データ) はそのまま
            out.extend_from_slice(&data[i..]);
            return Some(out);
        }
        if (0xD0..=0xD7).contains(&m) || m == 0x01 {
            out.extend_from_slice(&data[i..i + 2]);
            i += 2;
            continue;
        }
        if i + 4 > data.len() {
            return None;
        }
        let len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
        if len < 2 || i + 2 + len > data.len() {
            return None;
        }
        let seg = &data[i..i + 2 + len];
        let keep = match m {
            0xE0 | 0xEE => true, // JFIF / Adobe
            0xE2 => seg.get(4..16) == Some(b"ICC_PROFILE\0"),
            0xE1 | 0xE3..=0xED | 0xEF | 0xFE => false,
            _ => true, // 構造マーカー
        };
        if keep {
            out.extend_from_slice(seg);
        }
        i += 2 + len;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_jpeg(w: u32, h: u32, quality: u8) -> Vec<u8> {
        // 滑らかな勾配 + 少しの模様 (ハフマン最適化の効果が出る程度)
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h {
            for x in 0..w {
                let v = ((x * 255 / w) as u8).wrapping_add(((y / 8) % 3) as u8 * 7);
                rgb.extend_from_slice(&[v, (y * 255 / h) as u8, 255 - v]);
            }
        }
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
            .encode(&rgb, w, h, image::ExtendedColorType::Rgb8)
            .unwrap();
        out
    }

    #[test]
    fn optimizes_losslessly() {
        let src = sample_jpeg(320, 240, 85);
        let opt = optimize_jpeg(&src).expect("should shrink");
        assert!(opt.bytes.len() < src.len());
        assert_eq!(decode(&src).unwrap(), decode(&opt.bytes).unwrap());
        // プログレッシブなら SOF2 (FFC2) を含む
        let has_sof2 = opt.bytes.windows(2).any(|w| w == [0xFF, 0xC2]);
        assert_eq!(has_sof2, opt.progressive);
    }

    #[test]
    fn rejects_non_jpeg() {
        assert!(optimize_jpeg(b"not a jpeg").is_none());
        assert!(optimize_jpeg(&[]).is_none());
    }

    #[test]
    fn strip_keeps_icc_and_adobe_drops_exif() {
        let mut j = vec![0xFF, 0xD8];
        // APP1 (EXIF) / APP2 (ICC) / APP14 (Adobe) / COM
        let seg = |m: u8, payload: &[u8]| {
            let mut v = vec![0xFF, m];
            v.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
            v.extend_from_slice(payload);
            v
        };
        j.extend(seg(0xE1, b"Exif\0\0data"));
        j.extend(seg(0xE2, b"ICC_PROFILE\0\x01\x01xxxx"));
        j.extend(seg(0xEE, b"Adobe\0\x64\0\0\0\0\x01"));
        j.extend(seg(0xFE, b"comment"));
        j.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02, 0x11, 0x22, 0xFF, 0xD9]);
        let out = strip_markers(&j).unwrap();
        let has = |m: u8| out.windows(2).any(|w| w == [0xFF, m]);
        assert!(!has(0xE1) && !has(0xFE));
        assert!(has(0xE2) && has(0xEE));
        assert!(out.ends_with(&[0xFF, 0xD9]));
    }
}
