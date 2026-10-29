// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/render_hayro.rs
// hayro (純 Rust 製 PDF ラスタライザ) によるページ描画。
//
// - feature "hayro" 有効時のみビルドされる。
// - 埋め込みフォントを持たない PDF では、OS にインストールされているフォントを
//   fontdb で探して代替に使う。見つからない場合のみ hayro 同梱の標準フォント
//   (Liberation 互換) にフォールバックする。
// - このモジュールは crate 内の他モジュールに依存しない (単体で検証できるようにするため)。
//   エラーは文字列で返し、呼び出し側 (render.rs) が MuPDF 描画へフォールバックする。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use hayro::hayro_interpret::font::{FallbackFontQuery, FontData, FontQuery};
use hayro::hayro_interpret::hayro_cmap::CidFamily;
use hayro::hayro_interpret::hayro_syntax::object::{Dict, Stream};
use hayro::hayro_interpret::hayro_syntax::page::{Page, Resources};
use hayro::hayro_interpret::{InterpreterSettings, hayro_syntax::Pdf};
use hayro::vello_cpu::{self, Pixmap, RenderContext};
use hayro::hayro_interpret::TransformExt;
use hayro::kurbo::Affine;
use hayro::{RenderCache, RenderSettings, render_into};
use hayro::vello_cpu::color::palette::css::WHITE;

/// hayro での描画結果 (エンコード済み画像)
pub struct HayroImage {
    pub bytes: Vec<u8>,
    pub width_px: u32,
    pub height_px: u32,
    pub page_w_pt: f32,
    pub page_h_pt: f32,
}

/// 描画できない場合は Err(理由)。呼び出し側は MuPDF にフォールバックする。
/// `supersample_max`: 高品質アンチエイリアス。1 以下 = 無効。2〜6 で dpi<300 のときだけ、
/// 内部を最大その倍率の高解像度で描いてから目標サイズへ縮小する (MuPDF 実装と同じ方針)。
pub fn render_page(
    path: &str,
    page_index: i32,
    dpi: u32,
    png: bool,
    quality: u8,
    supersample_max: i32,
) -> Result<HayroImage, String> {
    let pdf = load_pdf(path)?;
    let pages = pdf.pages();
    let idx = usize::try_from(page_index).map_err(|_| "negative page index".to_string())?;
    let page = pages
        .get(idx)
        .ok_or_else(|| format!("page {idx} out of range ({})", pages.len()))?;

    let dpi_f = dpi.max(1) as f32;
    let scale = dpi_f / 72.0;
    let (page_w_pt, page_h_pt) = page.render_dimensions();
    // 目標画素数は MuPDF と同様、ページ寸法×dpi/72 を切り上げる。倍率は軸ごとに
    // 「目標画素数 / ページ寸法」とし、画素格子をページ範囲にぴったり合わせる。
    let w = (page_w_pt * scale).ceil();
    let h = (page_h_pt * scale).ceil();
    // hayro の Pixmap は u16 サイズ。範囲外は MuPDF に任せる。
    if !(w >= 1.0 && h >= 1.0 && w <= u16::MAX as f32 && h <= u16::MAX as f32) {
        return Err(format!("unsupported pixmap size {w}x{h}"));
    }

    // hayro が未対応の機能を使うページは描画せず、呼び出し側 (MuPDF) に任せる
    if let Some(feature) = unsupported_feature(page) {
        return Err(format!("unsupported feature: {feature}"));
    }

    let settings = interpreter_settings();
    let cache = RenderCache::new();
    let (width_px, height_px) = (w as u32, h as u32);
    let rgb = raster_rgb(page, &cache, &settings, width_px, height_px, dpi_f, supersample_max)?;
    let out = encode_rgb(&rgb, width_px, height_px, png, quality)?;

    Ok(HayroImage {
        bytes: out,
        width_px,
        height_px,
        page_w_pt,
        page_h_pt,
    })
}

// ── 高品質アンチエイリアス (スーパーサンプリング) ────────────────────────────
//
// MuPDF 実装 (kozou_compute_supersample_mult) と同じ方針:
//   - dpi が 300 以上なら無効 (細線の消失は起きない)
//   - 内部 dpi は 600 を超えない / 内部ビットマップは 5,000 万画素を超えない
//   - 呼び出し側の指定 (supersample_max) を超えない
// 縮小は整数倍の箱平均 (面積平均)。目標サイズに整数倍でぴったり合わせて描くため、
// 端数のリサンプリングは生じない。

const SUPERSAMPLE_DPI_THRESHOLD: f32 = 300.0;
const SUPERSAMPLE_ABS_DPI_CAP: f32 = 600.0;
const SUPERSAMPLE_MAX_PIXELS: f64 = 50_000_000.0;

/// 超解像度の倍率 (1 = 無効)
pub(crate) fn supersample_mult(dpi: f32, supersample_max: i32, tw: u32, th: u32) -> u32 {
    if supersample_max <= 1 || dpi <= 0.0 || dpi >= SUPERSAMPLE_DPI_THRESHOLD {
        return 1;
    }
    let by_dpi = ((SUPERSAMPLE_ABS_DPI_CAP / dpi).floor() as i64).max(1);
    let target_px = tw as f64 * th as f64;
    let by_mem = if target_px > 0.0 {
        ((SUPERSAMPLE_MAX_PIXELS / target_px).sqrt().floor() as i64).max(1)
    } else {
        supersample_max as i64
    };
    // hayro の Pixmap は u16 サイズ
    let by_u16 = (u16::MAX as i64 / tw.max(th).max(1) as i64).max(1);
    (supersample_max as i64).min(by_dpi).min(by_mem).min(by_u16).max(1) as u32
}

/// ページを `width`×`height` の Pixmap に描く。倍率は軸ごとに「画素数 / ページ寸法」。
fn render_pixmap<'a>(
    page: &'a Page<'a>,
    cache: &RenderCache<'a>,
    settings: &InterpreterSettings,
    width: u16,
    height: u16,
) -> Pixmap {
    let (pw, ph) = page.render_dimensions();
    let sx = width as f64 / pw as f64;
    let sy = height as f64 / ph as f64;
    let mut ctx = RenderContext::new(width, height);
    let transform = Affine::scale_non_uniform(sx, sy) * page.initial_transform(true).to_kurbo();
    // 画像は常にバイリニア補間で描く。hayro は /Interpolate の無い画像を最近傍補間 (拡大するとブロック状)
    // で描くが、MuPDF や poppler など一般のビューアは拡大時にも補間して滑らかに描く。
    let render_settings = RenderSettings {
        force_image_interpolation: true,
    };
    render_into(page, cache, settings, &render_settings, &mut ctx, transform);
    ctx.flush();
    let mut pixmap = Pixmap::new(ctx.width(), ctx.height());
    ctx.render_with(
        &mut pixmap,
        &mut vello_cpu::Resources::default(),
        vello_cpu::RasterizerSettings {
            target_init: vello_cpu::TargetInit::Clear(WHITE),
            ..Default::default()
        },
    );
    pixmap
}

/// ページを `tw`×`th` の RGB8 に描画する。`supersample_max` > 1 なら高解像度で描いて縮小。
fn raster_rgb<'a>(
    page: &'a Page<'a>,
    cache: &RenderCache<'a>,
    settings: &InterpreterSettings,
    tw: u32,
    th: u32,
    dpi: f32,
    supersample_max: i32,
) -> Result<Vec<u8>, String> {
    if tw < 1 || th < 1 || tw > u16::MAX as u32 || th > u16::MAX as u32 {
        return Err(format!("unsupported pixmap size {tw}x{th}"));
    }
    let m = supersample_mult(dpi, supersample_max, tw, th);
    let pixmap = render_pixmap(page, cache, settings, (tw * m) as u16, (th * m) as u16);
    // 背景は不透明な白のため、premultiplied RGBA の RGB をそのまま使える
    let src = pixmap.data_as_u8_slice();
    let (tw, th, m) = (tw as usize, th as usize, m as usize);
    let mut rgb = Vec::with_capacity(tw * th * 3);
    if m == 1 {
        for px in src.chunks_exact(4) {
            rgb.extend_from_slice(&px[..3]);
        }
        return Ok(rgb);
    }
    // m×m の箱平均 (面積平均)
    let big_w = tw * m;
    let area = (m * m) as u32;
    for y in 0..th {
        for x in 0..tw {
            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
            for dy in 0..m {
                let row = ((y * m + dy) * big_w + x * m) * 4;
                for px in src[row..row + m * 4].chunks_exact(4) {
                    r += px[0] as u32;
                    g += px[1] as u32;
                    b += px[2] as u32;
                }
            }
            rgb.extend_from_slice(&[
                ((r + area / 2) / area) as u8,
                ((g + area / 2) / area) as u8,
                ((b + area / 2) / area) as u8,
            ]);
        }
    }
    Ok(rgb)
}

fn interpreter_settings() -> InterpreterSettings {
    InterpreterSettings {
        font_resolver: Arc::new(resolve_font),
        ..Default::default()
    }
}

/// RGB8 のピクセル列を PNG / JPEG にエンコードする
pub fn encode_rgb(
    rgb: &[u8],
    width_px: u32,
    height_px: u32,
    png: bool,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    if png {
        use image::ImageEncoder;
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(rgb, width_px, height_px, image::ExtendedColorType::Rgb8)
            .map_err(|e| format!("png encode: {e}"))?;
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100))
            .encode(rgb, width_px, height_px, image::ExtendedColorType::Rgb8)
            .map_err(|e| format!("jpeg encode: {e}"))?;
    }
    Ok(out)
}

fn load_pdf(path: &str) -> Result<Pdf, String> {
    let data = std::fs::read(path).map_err(|e| format!("read: {e}"))?;
    let head = &data[..data.len().min(1024)];
    if !head.windows(5).any(|w| w == b"%PDF-") {
        return Err("not a PDF".into());
    }
    Pdf::new(data).map_err(|e| format!("hayro load: {e:?}"))
}

// ── 面付け (シート合成) ──────────────────────────────────────────────────────
//
// MuPDF 実装 (mupdf_safe.c の kozou_render_imposition / kozou_compose_sheet_pixmap) と
// 同じ配置規則:
//   セルの大きさ = シート内の有効ページの最大幅・最大高さ (pt) × dpi/72 を四捨五入
//   各ページはセルに縦横比を保って収め、セル内で中央寄せ
//   セル間と外周に gap_px の隙間。空白セル (ページ番号 0 / 範囲外) は白のまま
// 高品質アンチエイリアス (supersample_max) も MuPDF と同じ方針で対応する (raster_rgb)。

/// 合成済みのシート (RGB8)
pub struct Sheet {
    pub rgb: Vec<u8>,
    pub width_px: u32,
    pub height_px: u32,
    /// セルの大きさ (pt)。画像 PDF のページ寸法の算出に使う
    pub cell_w_pt: f32,
    pub cell_h_pt: f32,
}

/// 入力 PDF を一度だけ開き、各シートを合成して順に `on_sheet` へ渡す
/// (メモリ上に同時に持つシートは 1 枚だけ)。
/// 描画できない場合 (PDF 以外、未対応機能、サイズ超過など) は Err。
pub fn compose_sheets(
    path: &str,
    sheets: &[&[i32]],
    cols: i32,
    rows: i32,
    dpi: f32,
    gap_px: i32,
    supersample_max: i32,
    mut on_sheet: impl FnMut(usize, Sheet) -> Result<(), String>,
) -> Result<(), String> {
    if cols < 1 || rows < 1 || !(dpi > 0.0) {
        return Err("invalid imposition parameters".into());
    }
    let pdf = load_pdf(path)?;
    let pages = pdf.pages();
    let settings = interpreter_settings();
    let cache = RenderCache::new();
    for (si, nums) in sheets.iter().enumerate() {
        let valid: Vec<Option<&Page<'_>>> = nums
            .iter()
            .map(|&n| usize::try_from(n - 1).ok().and_then(|i| pages.get(i)))
            .collect();
        let sheet = compose_one(&valid, &cache, &settings, cols, rows, dpi, gap_px, supersample_max)?;
        on_sheet(si, sheet)?;
    }
    Ok(())
}

fn compose_one<'a>(
    cells: &[Option<&'a Page<'a>>],
    cache: &RenderCache<'a>,
    settings: &InterpreterSettings,
    cols: i32,
    rows: i32,
    dpi: f32,
    gap_px: i32,
    supersample_max: i32,
) -> Result<Sheet, String> {
    // セルの大きさ: 有効ページの最大寸法 (有効ページが無ければ A4)
    let (mut max_w, mut max_h) = (595.0f32, 842.0f32);
    let mut first = true;
    for page in cells.iter().flatten() {
        if let Some(feature) = unsupported_feature(page) {
            return Err(format!("unsupported feature: {feature}"));
        }
        let (w, h) = page.render_dimensions();
        if first {
            (max_w, max_h) = (w, h);
            first = false;
        } else {
            max_w = max_w.max(w);
            max_h = max_h.max(h);
        }
    }
    let scale = dpi / 72.0;
    let cell_w = (max_w * scale + 0.5) as i64;
    let cell_h = (max_h * scale + 0.5) as i64;
    let g = gap_px.max(0) as i64;
    let (cols_l, rows_l) = (cols as i64, rows as i64);
    let total_w = cols_l * cell_w + (cols_l + 1) * g;
    let total_h = rows_l * cell_h + (rows_l + 1) * g;
    if cell_w < 1 || cell_h < 1 || cell_w > u16::MAX as i64 || cell_h > u16::MAX as i64 {
        return Err(format!("unsupported cell size {cell_w}x{cell_h}"));
    }
    let total_bytes = (total_w as u128) * (total_h as u128) * 3;
    if total_bytes > 1024 * 1024 * 1024 {
        return Err(format!(
            "imposition: output too large ({total_w}x{total_h} @ 3ch = {}MB > 1024MB)",
            total_bytes / (1024 * 1024)
        ));
    }

    let (tw, th) = (total_w as usize, total_h as usize);
    let mut rgb = vec![255u8; tw * th * 3];
    for (i, cell) in cells.iter().enumerate() {
        let (col, row) = (i as i64 % cols_l, i as i64 / cols_l);
        if row >= rows_l {
            break;
        }
        let Some(page) = cell else { continue }; // 空白セルは白のまま
        let (pw, ph) = page.render_dimensions();
        if !(pw > 0.0 && ph > 0.0) {
            continue;
        }
        let fit = (cell_w as f32 / pw).min(cell_h as f32 / ph);
        // セル内の目標画素数 (四捨五入)。倍率は軸ごとに画素数/ページ寸法で合わせる
        let rw = ((pw * fit + 0.5) as i64).clamp(1, cell_w);
        let rh = ((ph * fit + 0.5) as i64).clamp(1, cell_h);
        let cell_rgb = raster_rgb(page, cache, settings, rw as u32, rh as u32, dpi, supersample_max)?;
        let cell_x = g + col * (cell_w + g);
        let cell_y = g + row * (cell_h + g);
        let off_x = cell_x + (cell_w - rw) / 2;
        let off_y = cell_y + (cell_h - rh) / 2;
        let copy_w = rw.min(total_w - off_x);
        let copy_h = rh.min(total_h - off_y);
        if copy_w <= 0 || copy_h <= 0 {
            continue;
        }
        for r in 0..copy_h as usize {
            let s_start = r * rw as usize * 3;
            let d_start = ((off_y as usize + r) * tw + off_x as usize) * 3;
            let n = copy_w as usize * 3;
            rgb[d_start..d_start + n].copy_from_slice(&cell_rgb[s_start..s_start + n]);
        }
    }

    Ok(Sheet {
        rgb,
        width_px: total_w as u32,
        height_px: total_h as u32,
        cell_w_pt: max_w,
        cell_h_pt: max_h,
    })
}

/// 1 シートを合成して PNG / JPEG にエンコードして返す (render_imposition 用)
pub fn render_sheet_encoded(
    path: &str,
    page_nums: &[i32],
    cols: i32,
    rows: i32,
    dpi: f32,
    gap_px: i32,
    png: bool,
    quality: u8,
    supersample_max: i32,
) -> Result<Vec<u8>, String> {
    let mut out = None;
    compose_sheets(path, &[page_nums], cols, rows, dpi, gap_px, supersample_max, |_, sheet| {
        out = Some(encode_rgb(&sheet.rgb, sheet.width_px, sheet.height_px, png, quality)?);
        Ok(())
    })?;
    out.ok_or_else(|| "no sheet".to_string())
}

/// RGB8 のピクセル列から、PDF の画像 XObject (DeviceRGB, 8bit) を作る。
///  - JPEG: jpegtran 方式で可逆最適化してから DCT のまま埋め込む (再圧縮なし)
///  - PNG : RGB を Flate で可逆圧縮して埋め込む
fn image_stream(
    rgb: Vec<u8>,
    width_px: u32,
    height_px: u32,
    png: bool,
    quality: u8,
) -> Result<lopdf::Stream, String> {
    use lopdf::{Stream, dictionary};
    let mut dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => width_px as i64,
        "Height" => height_px as i64,
        "ColorSpace" => "DeviceRGB",
        "BitsPerComponent" => 8,
    };
    if png {
        let mut st = Stream::new(dict, rgb);
        st.compress().map_err(|e| format!("flate: {e}"))?;
        Ok(st)
    } else {
        let jpeg = encode_rgb(&rgb, width_px, height_px, false, quality)?;
        // jpegtran 方式の可逆最適化 (ハフマン表の最適化 / プログレッシブ化、画素は不変)。
        // 小さくならない・画素が一致しない場合は元の JPEG をそのまま使う。
        let jpeg = crate::jpeg_optimize::optimize_or_keep(jpeg);
        dict.set("Filter", "DCTDecode");
        Ok(Stream::new(dict, jpeg))
    }
}

/// 1 ページ 1 枚の画像化 PDF を書き出す (compress::rasterize 用)。
/// `pages` は 1 ベースのページ番号 (None = 全ページ)。ページ寸法は元ページと同じ。
pub fn rasterize_pdf(
    input: &str,
    output: &str,
    dpi: f32,
    png: bool,
    quality: u8,
    pages: Option<&[i32]>,
    supersample_max: i32,
) -> Result<(), String> {
    let list: Vec<i32> = match pages {
        Some(p) if !p.is_empty() => p.to_vec(),
        _ => {
            let n = load_pdf(input)?.pages().len();
            (1..=n as i32).collect()
        }
    };
    rasterize_imposition_pdf(input, output, &list, 1, 1, 1, dpi, 0, png, quality, supersample_max)
}

/// テキストを描かない 1 ページ 1 枚の画像化 PDF を書き出す (compress::rasterize_no_text 用)。
/// lopdf でテキスト描画命令 (Tj / TJ / \' / ") を除いた複製 PDF を作り、それを hayro で描く。
/// (hayro の描画デバイスは外から差し替えられないため、内容ストリーム側で除去する。)
pub fn rasterize_pdf_no_text(
    input: &str,
    output: &str,
    dpi: f32,
    png: bool,
    quality: u8,
    pages: Option<&[i32]>,
    supersample_max: i32,
) -> Result<(), String> {
    let data = std::fs::read(input).map_err(|e| format!("read: {e}"))?;
    let (stripped, stats) = crate::content_filter::remove_text_bytes(&data)?;
    eprintln!(
        "[render] no-text: removed {} text operator(s) in {} content stream(s)",
        stats.removed_ops, stats.streams
    );
    let dir = std::env::temp_dir().join("pdf-kozou");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("kozou_notext_{}.pdf", std::process::id()));
    std::fs::write(&tmp, &stripped).map_err(|e| format!("write temp: {e}"))?;
    let tmp_str = tmp.to_string_lossy().to_string();
    let result = rasterize_pdf(&tmp_str, output, dpi, png, quality, pages, supersample_max);
    let _ = std::fs::remove_file(&tmp);
    result
}

/// 面付け画像 PDF を書き出す (rasterize_imposition 用)。
/// 各シートを 1 枚の画像に合成し、1 PDF ページに埋め込む。PDF の組み立ては lopdf。
///  - JPEG: DCT のまま埋め込む (再圧縮なし)
///  - PNG : RGB を Flate で可逆圧縮して埋め込む
/// ページ寸法 (pt) は MuPDF 実装と同じ: cols*cell_w + (cols+1)*gap (gap は px→pt 換算)。
pub fn rasterize_imposition_pdf(
    input: &str,
    output: &str,
    sheet_pages: &[i32],
    cells_per_sheet: usize,
    cols: i32,
    rows: i32,
    dpi: f32,
    gap_px: i32,
    png: bool,
    quality: u8,
    supersample_max: i32,
) -> Result<(), String> {
    use lopdf::{Document, Object, Stream, dictionary};

    if cells_per_sheet == 0 {
        return Err("cells_per_sheet is 0".into());
    }
    let sheets: Vec<&[i32]> = sheet_pages.chunks(cells_per_sheet).collect();
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let mut kids: Vec<Object> = Vec::new();
    let g_pt = if gap_px > 0 { gap_px as f32 * 72.0 / dpi } else { 0.0 };

    compose_sheets(input, &sheets, cols, rows, dpi, gap_px, supersample_max, |_, sheet| {
        let img_stream = image_stream(sheet.rgb, sheet.width_px, sheet.height_px, png, quality)?;
        let img_id = doc.add_object(img_stream);

        let page_w = cols as f32 * sheet.cell_w_pt + (cols + 1) as f32 * g_pt;
        let page_h = rows as f32 * sheet.cell_h_pt + (rows + 1) as f32 * g_pt;
        let content = format!("q\n{page_w:.4} 0 0 {page_h:.4} 0 0 cm\n/Im0 Do\nQ\n");
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), page_w.into(), page_h.into()],
            "Resources" => dictionary! {
                "XObject" => dictionary! { "Im0" => img_id },
            },
            "Contents" => content_id,
        });
        kids.push(page_id.into());
        Ok(())
    })?;

    if kids.is_empty() {
        return Err("no sheets".into());
    }
    let count = kids.len() as i64;
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => count,
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);
    doc.save(output).map_err(|e| format!("save: {e}"))?;
    Ok(())
}

// ── キープテキスト (背景ラスタ + テキスト層) ─────────────────────────────────
//
// 非テキスト要素 (画像・図形) を 1 ページ 1 枚の背景ラスタに焼き込み、テキストは
// 元のフォントのままベクターで残す。流れ:
//   1. テキスト層: lopdf で内容ストリームからテキスト以外の描画を除く (content_filter::TextOnly)
//   2. 背景: lopdf でテキストを除いた複製を hayro で描く (content_filter::RemoveText)
//   3. 背景画像をページ内容の先頭に重ね、選ばれなかったページを落として保存
// ページの /Rotate は、背景画像の配置行列で吸収する (テキスト層はページの座標系のまま)。
//
// 未対応 (Err を返し、呼び出し側が MuPDF にフォールバックする):
//   - 部分的に隠れたテキストの隠し直し (呼び出し側が事前に検出して使い分ける)
//   - Tr 4〜7、外観ストリームを持つ注釈、種類不明の XObject、/UserUnit != 1
//   - ページ指定が昇順・重複なしでない場合

/// 数値オブジェクト (参照を含む) を f32 にする
fn num_of(doc: &lopdf::Document, o: &lopdf::Object) -> Option<f32> {
    use lopdf::Object;
    match o {
        Object::Integer(i) => Some(*i as f32),
        Object::Real(r) => Some(*r),
        Object::Reference(id) => doc.get_object(*id).ok().and_then(|o| num_of(doc, o)),
        _ => None,
    }
}

/// 継承を考慮してページの属性を探す (最も近い祖先のもの)
fn inherited<'a>(
    doc: &'a lopdf::Document,
    page_id: lopdf::ObjectId,
    key: &[u8],
) -> Option<&'a lopdf::Object> {
    let mut node = page_id;
    for _ in 0..32 {
        let d = doc.get_dictionary(node).ok()?;
        if let Ok(v) = d.get(key) {
            return Some(v);
        }
        node = d.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

fn box_of(doc: &lopdf::Document, page_id: lopdf::ObjectId, key: &[u8]) -> Option<[f32; 4]> {
    let obj = inherited(doc, page_id, key)?;
    let obj = match obj {
        lopdf::Object::Reference(id) => doc.get_object(*id).ok()?,
        o => o,
    };
    let a = obj.as_array().ok()?;
    if a.len() != 4 {
        return None;
    }
    let v: Vec<f32> = a.iter().filter_map(|o| num_of(doc, o)).collect();
    if v.len() != 4 {
        return None;
    }
    Some([v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])])
}

/// 表示領域 (CropBox ∩ MediaBox) と、正規化した /Rotate (0/90/180/270)
fn page_geometry(
    doc: &lopdf::Document,
    page_id: lopdf::ObjectId,
) -> Result<([f32; 4], i32), String> {
    let media = box_of(doc, page_id, b"MediaBox").ok_or("no MediaBox")?;
    let b = match box_of(doc, page_id, b"CropBox") {
        Some(c) => [
            media[0].max(c[0]),
            media[1].max(c[1]),
            media[2].min(c[2]),
            media[3].min(c[3]),
        ],
        None => media,
    };
    if !(b[2] > b[0] && b[3] > b[1]) {
        return Err("empty page box".into());
    }
    if let Some(u) = inherited(doc, page_id, b"UserUnit").and_then(|o| num_of(doc, o))
        && (u - 1.0).abs() > 1e-6
    {
        return Err("UserUnit != 1".into());
    }
    let rot = inherited(doc, page_id, b"Rotate")
        .and_then(|o| num_of(doc, o))
        .map(|r| (r as i32).rem_euclid(360))
        .unwrap_or(0);
    if rot % 90 != 0 {
        return Err(format!("unsupported /Rotate {rot}"));
    }
    Ok((b, rot))
}

/// 背景画像 (単位正方形) を表示領域 `b` いっぱいに、ページの回転 `rot` を打ち消して置く行列
fn background_matrix(b: [f32; 4], rot: i32) -> [f32; 6] {
    let (x0, y0, x1, y1) = (b[0], b[1], b[2], b[3]);
    let (w, h) = (x1 - x0, y1 - y0);
    match rot {
        90 => [0.0, h, -w, 0.0, x1, y0],
        180 => [-w, 0.0, 0.0, -h, x1, y1],
        270 => [0.0, -h, w, 0.0, x0, y1],
        _ => [w, 0.0, 0.0, h, x0, y0],
    }
}

/// 隠し直しパッチ (cover_patch) を作るために、ページごとに持っておく情報
struct CoverJob {
    pno: i32,
    page_id: lopdf::ObjectId,
    tw: u32,
    th: u32,
    /// テキストを除いた描画 (背景画像の元になった画素)
    nt: Vec<u8>,
    /// 実際に埋め込む背景画像を復号した画素 (JPEG のときは圧縮後の画素)
    bg: Vec<u8>,
    /// 背景画像を置く行列
    bg_m: [f32; 6],
}

/// 埋め込む JPEG を RGB8 に復号する (パッチの土台を、実際の背景画素に揃えるため)
fn decode_jpeg_rgb(jpeg: &[u8], tw: u32, th: u32) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg)
        .map_err(|e| format!("jpeg decode: {e}"))?
        .to_rgb8();
    if img.width() != tw || img.height() != th {
        return Err(format!(
            "jpeg decode: size mismatch {}x{} vs {tw}x{th}",
            img.width(),
            img.height()
        ));
    }
    Ok(img.into_raw())
}

/// キープテキストの画像化 PDF (1up) を書き出す。`pages` は 1 ベース・昇順・重複なし (None = 全ページ)。
///
/// `cover_pages`: 隠し直しパッチ (cover_patch) を試すページ (1 ベース。None = 選んだ全ページ)。
/// 元の PDF で後から描いた物にテキストの一部が隠れていたページを渡す。そのページだけ、
/// 元の描画と出力の描画を hayro で比べ、見え方が違う箇所を、背景の画素で作ったマスク付きパッチで
/// テキストの上から隠し直す。
pub fn keep_text_pdf(
    input: &str,
    output: &str,
    dpi: f32,
    png: bool,
    quality: u8,
    pages: Option<&[i32]>,
    supersample_max: i32,
    cover_pages: Option<&[i32]>,
) -> Result<(), String> {
    use crate::content_filter::{self, Mode};
    use lopdf::{Document, Object, Stream, dictionary};

    let data = std::fs::read(input).map_err(|e| format!("read: {e}"))?;
    if !data[..data.len().min(1024)].windows(5).any(|w| w == b"%PDF-") {
        return Err("not a PDF".into());
    }

    // 1) テキスト層
    let mut doc = Document::load_mem(&data).map_err(|e| format!("lopdf load: {e}"))?;
    if doc.is_encrypted() {
        return Err("encrypted".into());
    }
    let tstats = content_filter::transform(&mut doc, Mode::TextOnly)?;
    // 2) 背景 (テキストを除いた複製を hayro で描く)
    let (no_text, _) = content_filter::remove_text_bytes(&data)?;
    let nt_pdf = Pdf::new(no_text).map_err(|e| format!("hayro load: {e:?}"))?;
    let nt_pages = nt_pdf.pages();
    let lo_pages = doc.get_pages();
    if nt_pages.len() != lo_pages.len() {
        return Err("page count mismatch".into());
    }
    let n = lo_pages.len() as i32;
    let selected: Vec<i32> = match pages {
        Some(p) if !p.is_empty() => p.to_vec(),
        _ => (1..=n).collect(),
    };
    if selected.iter().any(|&p| p < 1 || p > n) || selected.windows(2).any(|w| w[0] >= w[1]) {
        return Err("page list must be ascending, unique and within the document".into());
    }

    let settings = interpreter_settings();
    let cache = RenderCache::new();
    let dpi_f = dpi.max(1.0);
    let scale = dpi_f / 72.0;
    let mut covers: Vec<CoverJob> = Vec::new();
    for &pno in &selected {
        let page = nt_pages
            .get((pno - 1) as usize)
            .ok_or_else(|| format!("page {pno} out of range"))?;
        if let Some(feature) = unsupported_feature(page) {
            return Err(format!("page {pno}: unsupported feature: {feature}"));
        }
        let (pw, ph) = page.render_dimensions();
        let (tw, th) = ((pw * scale).ceil(), (ph * scale).ceil());
        if !(tw >= 1.0 && th >= 1.0 && tw <= u16::MAX as f32 && th <= u16::MAX as f32) {
            return Err(format!("page {pno}: unsupported pixmap size {tw}x{th}"));
        }
        let (tw, th) = (tw as u32, th as u32);
        let rgb = raster_rgb(page, &cache, &settings, tw, th, dpi_f, supersample_max)?;
        let want_cover = match cover_pages {
            None => true,
            Some(c) => c.contains(&pno),
        };
        let nt_rgb = if want_cover { Some(rgb.clone()) } else { None };
        let bg_stream = image_stream(rgb, tw, th, png, quality)?;
        let cover_src = match nt_rgb {
            Some(nt) => {
                let bg = if png {
                    nt.clone()
                } else {
                    decode_jpeg_rgb(&bg_stream.content, tw, th)?
                };
                Some((nt, bg))
            }
            None => None,
        };
        let img_id = doc.add_object(bg_stream);

        // 表示領域とページ寸法の整合を確認してから背景を置く
        let page_id = lo_pages[&(pno as u32)];
        let (b, rot) = page_geometry(&doc, page_id)?;
        let (w, h) = (b[2] - b[0], b[3] - b[1]);
        let (ew, eh) = if rot % 180 == 0 { (w, h) } else { (h, w) };
        if (ew - pw).abs() > 1.0 || (eh - ph).abs() > 1.0 {
            return Err(format!("page {pno}: page box mismatch ({ew}x{eh} vs {pw}x{ph})"));
        }
        let m = background_matrix(b, rot);
        if let Some((nt, bg)) = cover_src {
            covers.push(CoverJob {
                pno,
                page_id,
                tw,
                th,
                nt,
                bg,
                bg_m: m,
            });
        }
        let content = format!(
            "q {:.5} {:.5} {:.5} {:.5} {:.5} {:.5} cm /KozouBg Do Q\n",
            m[0], m[1], m[2], m[3], m[4], m[5]
        );
        let bg_content = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
        // Contents の先頭に背景を重ねる (内容ストリームの並びは保つ)
        let mut contents: Vec<Object> = vec![bg_content.into()];
        contents.extend(doc.get_page_contents(page_id).into_iter().map(Object::from));
        // Resources (TextOnly 変換で、ページ自身の辞書として持たせてある) に背景を登録する
        let page_dict = doc
            .get_object_mut(page_id)
            .and_then(Object::as_dict_mut)
            .map_err(|e| format!("page dict: {e}"))?;
        page_dict.set("Contents", Object::Array(contents));
        let res = page_dict
            .get_mut(b"Resources")
            .and_then(Object::as_dict_mut)
            .map_err(|e| format!("page resources: {e}"))?;
        if !res.has(b"XObject") {
            res.set("XObject", Object::Dictionary(lopdf::Dictionary::new()));
        }
        res.get_mut(b"XObject")
            .and_then(Object::as_dict_mut)
            .map_err(|e| format!("page XObject: {e}"))?
            .set("KozouBg", Object::Reference(img_id));
    }

    // 部分的に隠れていたテキストを、背景の画素のパッチで隠し直す
    let mut n_patches = 0usize;
    if !covers.is_empty() {
        n_patches = add_cover_patches(&mut doc, &data, &covers, dpi_f, supersample_max, &settings)?;
    }

    // 選ばれなかったページを落とし、不要になったオブジェクトを捨てる
    let drop: Vec<u32> = lo_pages
        .keys()
        .copied()
        .filter(|k| !selected.contains(&(*k as i32)))
        .collect();
    if !drop.is_empty() {
        doc.delete_pages(&drop);
    }
    doc.prune_objects();
    doc.compress();
    doc.save(output).map_err(|e| format!("save: {e}"))?;
    eprintln!(
        "[render] keep-text: {} page(s); text layer: {} paint op(s) neutralized, {} image op(s) removed; cover patches: {}",
        selected.len(),
        tstats.neutralized_paints,
        tstats.removed_images,
        n_patches
    );
    Ok(())
}

/// 元のページと出力ページ (背景 + ベクターのテキスト) を hayro で描き比べ、見え方が違う箇所に
/// マスク付きパッチ画像をテキストの上へ重ねる。作ったパッチの数を返す。
///
/// ページの内容ストリームは `[背景, 元の内容...]` の並びになっている前提。元の内容を
/// `q` … `Q` で囲み (グラフィックス状態を元に戻して) から、最後にパッチを描く。
fn add_cover_patches(
    doc: &mut lopdf::Document,
    orig: &[u8],
    jobs: &[CoverJob],
    dpi: f32,
    supersample_max: i32,
    settings: &InterpreterSettings,
) -> Result<usize, String> {
    use crate::cover_patch::{Params, compute_patches, patch_matrix};
    use lopdf::{Object, Stream, dictionary};

    // 出力ページの描画用に、現時点の文書をメモリ上へ書き出す
    let mut buf = Vec::new();
    doc.save_to(&mut buf).map_err(|e| format!("cover: save: {e}"))?;
    let full_pdf = Pdf::new(orig.to_vec()).map_err(|e| format!("cover: hayro load (orig): {e:?}"))?;
    let comp_pdf = Pdf::new(buf).map_err(|e| format!("cover: hayro load (output): {e:?}"))?;
    let full_pages = full_pdf.pages();
    let comp_pages = comp_pdf.pages();
    let cache_full = RenderCache::new();
    let cache_comp = RenderCache::new();
    let params = Params::default();

    let mut total = 0usize;
    for job in jobs {
        let idx = (job.pno - 1) as usize;
        let fp = full_pages
            .get(idx)
            .ok_or_else(|| format!("cover: page {} missing in the original", job.pno))?;
        let cp = comp_pages
            .get(idx)
            .ok_or_else(|| format!("cover: page {} missing in the output", job.pno))?;
        let full = raster_rgb(fp, &cache_full, settings, job.tw, job.th, dpi, supersample_max)?;
        let comp = raster_rgb(cp, &cache_comp, settings, job.tw, job.th, dpi, supersample_max)?;
        let patches = compute_patches(&full, &job.nt, &comp, &job.bg, job.tw, job.th, &params);
        if patches.is_empty() {
            continue;
        }

        let mut tail = String::from("Q\n");
        let mut xobjs: Vec<(String, lopdf::ObjectId)> = Vec::new();
        for (k, p) in patches.iter().enumerate() {
            let mut mask = Stream::new(
                dictionary! {
                    "Type" => "XObject",
                    "Subtype" => "Image",
                    "Width" => p.w as i64,
                    "Height" => p.h as i64,
                    "ColorSpace" => "DeviceGray",
                    "BitsPerComponent" => 8,
                },
                p.mask.clone(),
            );
            mask.compress().map_err(|e| format!("cover: flate: {e}"))?;
            let mask_id = doc.add_object(mask);
            let mut img = Stream::new(
                dictionary! {
                    "Type" => "XObject",
                    "Subtype" => "Image",
                    "Width" => p.w as i64,
                    "Height" => p.h as i64,
                    "ColorSpace" => "DeviceRGB",
                    "BitsPerComponent" => 8,
                    "SMask" => Object::Reference(mask_id),
                },
                p.rgb.clone(),
            );
            img.compress().map_err(|e| format!("cover: flate: {e}"))?;
            let img_id = doc.add_object(img);
            let name = format!("KozouCov{k}");
            let m = patch_matrix(job.bg_m, p.x0, p.y0, p.x0 + p.w, p.y0 + p.h, job.tw, job.th);
            tail.push_str(&format!(
                "q {:.5} {:.5} {:.5} {:.5} {:.5} {:.5} cm /{name} Do Q\n",
                m[0], m[1], m[2], m[3], m[4], m[5]
            ));
            xobjs.push((name, img_id));
        }
        total += patches.len();

        let q_open = doc.add_object(Stream::new(dictionary! {}, b"q\n".to_vec()));
        let tail_id = doc.add_object(Stream::new(dictionary! {}, tail.into_bytes()));
        let page_dict = doc
            .get_object_mut(job.page_id)
            .and_then(Object::as_dict_mut)
            .map_err(|e| format!("cover: page dict: {e}"))?;
        let mut contents: Vec<Object> = page_dict
            .get(b"Contents")
            .and_then(Object::as_array)
            .map_err(|e| format!("cover: page contents: {e}"))?
            .clone();
        // contents[0] は背景。その直後 (元の内容の前) に q、最後に Q とパッチ
        contents.insert(1.min(contents.len()), q_open.into());
        contents.push(tail_id.into());
        page_dict.set("Contents", Object::Array(contents));
        let xo = page_dict
            .get_mut(b"Resources")
            .and_then(Object::as_dict_mut)
            .map_err(|e| format!("cover: page resources: {e}"))?
            .get_mut(b"XObject")
            .and_then(Object::as_dict_mut)
            .map_err(|e| format!("cover: page XObject: {e}"))?;
        for (name, id) in xobjs {
            xo.set(name, Object::Reference(id));
        }
    }
    Ok(total)
}

// ── 未対応機能の検出 ─────────────────────────────────────────────────────────
//
// hayro 0.8 で MuPDF と描画が食い違うことを確認済みの機能: ノックアウトグループ
// (透明グループ辞書の /K true)。ブレンドモード・アイソレーション・色キーマスクは
// 実測で一致したため検出対象にしていない (複合ケースは未検証)。

const MAX_DEPTH: usize = 16;

/// ページ (と、そこから辿れる Form XObject / SMask グループ) が未対応機能を使っていれば、
/// その名前を返す。
fn unsupported_feature(page: &Page<'_>) -> Option<&'static str> {
    if is_knockout_group(page.raw()) {
        return Some("knockout group");
    }
    let mut seen = std::collections::HashSet::new();
    scan_resources(page.resources(), 0, &mut seen)
}

fn is_knockout_group(dict: &Dict<'_>) -> bool {
    dict.get::<Dict<'_>>(b"Group")
        .and_then(|g| g.get::<bool>(b"K"))
        .unwrap_or(false)
}

fn scan_resources(
    res: &Resources<'_>,
    depth: usize,
    seen: &mut std::collections::HashSet<String>,
) -> Option<&'static str> {
    if depth > MAX_DEPTH {
        return None;
    }
    // Form XObject
    for key in res.x_objects.keys() {
        if let Some(stream) = res.x_objects.get::<Stream<'_>>(key.as_ref())
            && let Some(f) = scan_form(&stream, depth, seen)
        {
            return Some(f);
        }
    }
    // ExtGState の SMask グループ (/SMask << /G form >>)
    for key in res.ext_g_states.keys() {
        let Some(gs) = res.ext_g_states.get::<Dict<'_>>(key.as_ref()) else {
            continue;
        };
        if let Some(stream) = gs
            .get::<Dict<'_>>(b"SMask")
            .and_then(|sm| sm.get::<Stream<'_>>(b"G"))
            && let Some(f) = scan_form(&stream, depth, seen)
        {
            return Some(f);
        }
    }
    None
}

fn scan_form(
    stream: &Stream<'_>,
    depth: usize,
    seen: &mut std::collections::HashSet<String>,
) -> Option<&'static str> {
    // 循環参照・重複走査を避ける
    if !seen.insert(format!("{:?}", stream.obj_id())) {
        return None;
    }
    let dict = stream.dict();
    if is_knockout_group(dict) {
        return Some("knockout group");
    }
    let res = dict.get::<Dict<'_>>(b"Resources")?;
    scan_resources(&Resources::new(res), depth + 1, seen)
}

// ── フォント解決 ─────────────────────────────────────────────────────────────

/// hayro の font_resolver。
/// - 標準14フォント: hayro 同梱フォント (どの OS でも同じ見た目・メトリクス互換)
/// - 埋め込みなしフォント: 名前一致 → 文字集合(CJK等)・属性に応じた系統 →
///   hayro 同梱の標準フォント、の順で探す
fn resolve_font(query: &FontQuery) -> Option<(FontData, u32)> {
    match query {
        FontQuery::Standard(s) => Some(s.get_font_data()),
        FontQuery::Fallback(f) => system_fallback(f).or_else(|| Some(f.pick_standard_font().get_font_data())),
    }
}

struct SystemFonts {
    db: fontdb::Database,
    /// 読み込み済みフォントデータ (TTC は大きいので共有する)
    cache: Mutex<HashMap<fontdb::ID, FontData>>,
}

fn system_fonts() -> &'static SystemFonts {
    static FONTS: OnceLock<SystemFonts> = OnceLock::new();
    FONTS.get_or_init(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        // Android など fontdb が既定で見ないディレクトリ
        for dir in ["/system/fonts", "/system/font", "/data/fonts"] {
            if std::path::Path::new(dir).is_dir() {
                db.load_fonts_dir(dir);
            }
        }
        SystemFonts {
            db,
            cache: Mutex::new(HashMap::new()),
        }
    })
}

impl SystemFonts {
    fn data(&self, id: fontdb::ID) -> Option<(FontData, u32)> {
        let index = self.db.face(id)?.index;
        if let Some(d) = self.cache.lock().ok()?.get(&id) {
            return Some((d.clone(), index));
        }
        let bytes: Vec<u8> = self.db.with_face_data(id, |data, _| data.to_vec())?;
        let d: FontData = Arc::new(bytes);
        self.cache.lock().ok()?.insert(id, d.clone());
        Some((d, index))
    }
}

/// 比較用の正規化: 英数字のみ小文字化 ("MS-Gothic" と "MS Gothic" を同一視)
fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// "Arial-BoldMT" "MS-PGothic,Bold" 等から、スタイル語尾を除いたファミリ名を作る。
/// ("MS-Gothic" のようにハイフンがファミリ名の一部のものは壊さない)
fn family_stem(name: &str) -> String {
    const STYLES: &[&str] = &[
        "bold", "italic", "oblique", "regular", "roman", "light", "medium", "semibold",
        "bolditalic", "boldoblique", "boldmt", "italicmt", "bolditalicmt", "bt", "mt",
    ];
    let base = name.split(',').next().unwrap_or(name).trim();
    if let Some((head, tail)) = base.rsplit_once('-')
        && STYLES.contains(&norm(tail).as_str())
    {
        return head.to_string();
    }
    base.to_string()
}

fn system_fallback(q: &FallbackFontQuery) -> Option<(FontData, u32)> {
    let sf = system_fonts();
    if sf.db.is_empty() {
        return None;
    }

    // 1) 名前一致 (PostScript 名 → フォント名 → ファミリ名)
    if let Some(id) = find_by_name(&sf.db, q) {
        return sf.data(id);
    }

    // 2) 文字集合 (CID フォント) に応じた系統。ここで見つからなければ、
    //    日本語等を無理に Latin フォントで描くより同梱標準フォントに任せる。
    if let Some(cc) = &q.character_collection {
        let candidates: &[&str] = match cc.family {
            CidFamily::AdobeJapan1 => JA_FAMILIES,
            CidFamily::AdobeGB1 => ZH_HANS_FAMILIES,
            CidFamily::AdobeCNS1 => ZH_HANT_FAMILIES,
            CidFamily::AdobeKorea1 => KO_FAMILIES,
            // Identity / Custom は言語不明。日本語→中国語→韓国語の順で広く持つものを試す。
            _ => return find_by_families(&sf.db, q, &[JA_FAMILIES, ZH_HANS_FAMILIES, KO_FAMILIES])
                .and_then(|id| sf.data(id)),
        };
        return find_by_families(&sf.db, q, &[candidates]).and_then(|id| sf.data(id));
    }

    // 3) Latin 系: 等幅 / セリフ / サンセリフ
    let group: &[&str] = if q.is_fixed_pitch {
        MONO_FAMILIES
    } else if q.is_serif {
        SERIF_FAMILIES
    } else {
        SANS_FAMILIES
    };
    find_by_families(&sf.db, q, &[group]).and_then(|id| sf.data(id))
}

fn weight_of(q: &FallbackFontQuery) -> fontdb::Weight {
    if q.is_bold {
        fontdb::Weight::BOLD
    } else {
        fontdb::Weight(q.font_weight.clamp(100, 900) as u16)
    }
}

fn style_of(q: &FallbackFontQuery) -> fontdb::Style {
    if q.is_italic {
        fontdb::Style::Italic
    } else {
        fontdb::Style::Normal
    }
}

fn find_by_name(db: &fontdb::Database, q: &FallbackFontQuery) -> Option<fontdb::ID> {
    // PostScript 名の完全一致 (正規化比較)
    if let Some(ps) = q.post_script_name.as_deref().or(q.font_name.as_deref()) {
        let want = norm(ps);
        if let Some(f) = db.faces().find(|f| norm(&f.post_script_name) == want) {
            return Some(f.id);
        }
    }
    // ファミリ名 (スタイル語尾を除いたもの) + 太さ・斜体で最近傍
    let mut names: Vec<String> = Vec::new();
    for n in [&q.font_family, &q.post_script_name, &q.font_name]
        .into_iter()
        .flatten()
    {
        let stem = family_stem(n);
        if !stem.is_empty() && !names.contains(&stem) {
            names.push(stem);
        }
    }
    for stem in names {
        let want = norm(&stem);
        // PDF の BaseFont 名は "ArialMT" のように末尾に MT 等が付くことがある
        let alt = want.strip_suffix("mt").map(str::to_string);
        let family = db.faces().find_map(|f| {
            f.families
                .iter()
                .map(|(n, _)| n)
                .find(|n| {
                    let nn = norm(n);
                    nn == want || alt.as_deref() == Some(nn.as_str())
                })
                .cloned()
        });
        if let Some(fam) = family {
            let id = db.query(&fontdb::Query {
                families: &[fontdb::Family::Name(&fam)],
                weight: weight_of(q),
                stretch: fontdb::Stretch::Normal,
                style: style_of(q),
            });
            if id.is_some() {
                return id;
            }
        }
    }
    None
}

/// 候補ファミリ群を先頭から順に探し、最初に存在したもので最近傍の face を返す。
fn find_by_families(
    db: &fontdb::Database,
    q: &FallbackFontQuery,
    groups: &[&[&str]],
) -> Option<fontdb::ID> {
    for group in groups {
        for fam in *group {
            let want = norm(fam);
            let exists = db
                .faces()
                .any(|f| f.families.iter().any(|(n, _)| norm(n) == want));
            if !exists {
                continue;
            }
            let id = db.query(&fontdb::Query {
                families: &[fontdb::Family::Name(fam)],
                weight: weight_of(q),
                stretch: fontdb::Stretch::Normal,
                style: style_of(q),
            });
            if id.is_some() {
                return id;
            }
        }
    }
    None
}

// 系統ごとの代替候補 (優先順)。OS 標準のものを先に、次に Noto/Source Han 等の汎用フォント。
const JA_FAMILIES: &[&str] = &[
    // Windows
    "Yu Gothic UI", "Yu Gothic", "Meiryo UI", "Meiryo", "MS PGothic", "MS Gothic",
    // macOS / iOS
    "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Hiragino Kaku Gothic Pro", "Osaka",
    // Linux / Android / 汎用
    "Noto Sans CJK JP", "Noto Sans JP", "Source Han Sans JP", "Source Han Sans",
    "IPAexGothic", "IPAGothic", "IPAPGothic", "TakaoPGothic", "Takao Gothic",
    "VL Gothic", "VL PGothic", "Droid Sans Japanese", "Droid Sans Fallback",
    "Noto Serif CJK JP", "Noto Sans CJK SC", "WenQuanYi Micro Hei",
];
const ZH_HANS_FAMILIES: &[&str] = &[
    "Microsoft YaHei UI", "Microsoft YaHei", "SimSun", "SimHei", "PingFang SC",
    "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "Source Han Sans CN",
    "WenQuanYi Micro Hei", "WenQuanYi Zen Hei", "Droid Sans Fallback", "Noto Sans CJK JP",
];
const ZH_HANT_FAMILIES: &[&str] = &[
    "Microsoft JhengHei UI", "Microsoft JhengHei", "MingLiU", "PMingLiU", "PingFang TC",
    "Noto Sans CJK TC", "Noto Sans TC", "Source Han Sans TC", "Source Han Sans TW",
    "WenQuanYi Zen Hei", "Droid Sans Fallback", "Noto Sans CJK JP",
];
const KO_FAMILIES: &[&str] = &[
    "Malgun Gothic", "Gulim", "Batang", "Apple SD Gothic Neo", "AppleGothic",
    "Noto Sans CJK KR", "Noto Sans KR", "Source Han Sans K", "Source Han Sans KR",
    "NanumGothic", "Droid Sans Fallback", "Noto Sans CJK JP",
];
const SANS_FAMILIES: &[&str] = &[
    "Arial", "Helvetica", "Helvetica Neue", "Segoe UI", "Liberation Sans", "Arimo",
    "DejaVu Sans", "Noto Sans", "Roboto", "Droid Sans",
];
const SERIF_FAMILIES: &[&str] = &[
    "Times New Roman", "Times", "Liberation Serif", "Tinos", "DejaVu Serif",
    "Noto Serif", "Droid Serif",
];
const MONO_FAMILIES: &[&str] = &[
    "Courier New", "Courier", "Menlo", "Consolas", "Liberation Mono", "Cousine",
    "DejaVu Sans Mono", "Noto Sans Mono", "Droid Sans Mono",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_ignores_separators_and_case() {
        assert_eq!(norm("MS-PGothic"), norm("MS PGothic"));
        assert_eq!(family_stem("Arial-BoldMT"), "Arial");
        assert_eq!(family_stem("MS-PGothic,Bold"), "MS-PGothic");
        assert_eq!(family_stem("MS-Gothic"), "MS-Gothic");
    }
}
