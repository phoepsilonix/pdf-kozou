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
use hayro::{PixmapSettings, RenderCache, RenderSettings, render};
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
pub fn render_page(
    path: &str,
    page_index: i32,
    dpi: u32,
    png: bool,
    quality: u8,
) -> Result<HayroImage, String> {
    let data = std::fs::read(path).map_err(|e| format!("read: {e}"))?;
    // PDF 以外 (EPUB/XPS/SVG/画像等) は hayro の対象外
    let head = &data[..data.len().min(1024)];
    if !head.windows(5).any(|w| w == b"%PDF-") {
        return Err("not a PDF".into());
    }

    let pdf = Pdf::new(data).map_err(|e| format!("hayro load: {e:?}"))?;
    let pages = pdf.pages();
    let idx = usize::try_from(page_index).map_err(|_| "negative page index".to_string())?;
    let page = pages
        .get(idx)
        .ok_or_else(|| format!("page {idx} out of range ({})", pages.len()))?;

    let scale = dpi.max(1) as f32 / 72.0;
    let (page_w_pt, page_h_pt) = page.render_dimensions();
    let w = (page_w_pt * scale).floor();
    let h = (page_h_pt * scale).floor();
    // hayro の Pixmap は u16 サイズ。範囲外は MuPDF に任せる。
    if !(w >= 1.0 && h >= 1.0 && w <= u16::MAX as f32 && h <= u16::MAX as f32) {
        return Err(format!("unsupported pixmap size {w}x{h}"));
    }

    // hayro が未対応の機能を使うページは描画せず、呼び出し側 (MuPDF) に任せる
    if let Some(feature) = unsupported_feature(page) {
        return Err(format!("unsupported feature: {feature}"));
    }

    let settings = interpreter_settings();
    let render_settings = RenderSettings::default();
    let pixmap_settings = PixmapSettings {
        x_scale: scale,
        y_scale: scale,
        bg_color: WHITE,
    };
    let cache = RenderCache::new();
    let pixmap = render(page, &cache, &settings, &render_settings, &pixmap_settings);

    let (width_px, height_px) = (pixmap.width() as u32, pixmap.height() as u32);
    // 背景は不透明な白で塗っているため、premultiplied RGBA の RGB をそのまま使える
    let rgba = pixmap.data_as_u8_slice();
    let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
    for px in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&px[..3]);
    }

    let out = encode_rgb(&rgb, width_px, height_px, png, quality)?;

    Ok(HayroImage {
        bytes: out,
        width_px,
        height_px,
        page_w_pt,
        page_h_pt,
    })
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
// 差異: hayro には高品質アンチエイリアス (supersample_max) が無いため無視する。
//       ページ画像の寸法は切り捨てのため、MuPDF と最大 1px 異なることがある。

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
        let sheet = compose_one(&valid, &cache, &settings, cols, rows, dpi, gap_px)?;
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
    let render_settings = RenderSettings::default();

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
        let pixmap = render(
            page,
            cache,
            settings,
            &render_settings,
            &PixmapSettings {
                x_scale: fit,
                y_scale: fit,
                bg_color: WHITE,
            },
        );
        let (rw, rh) = (pixmap.width() as i64, pixmap.height() as i64);
        let cell_x = g + col * (cell_w + g);
        let cell_y = g + row * (cell_h + g);
        let off_x = cell_x + (cell_w - rw) / 2;
        let off_y = cell_y + (cell_h - rh) / 2;
        let copy_w = rw.min(total_w - off_x);
        let copy_h = rh.min(total_h - off_y);
        if copy_w <= 0 || copy_h <= 0 {
            continue;
        }
        // 背景は不透明な白のため、premultiplied RGBA の RGB をそのまま使える
        let src = pixmap.data_as_u8_slice();
        for r in 0..copy_h as usize {
            let s_row = &src[(r * rw as usize) * 4..];
            let d_start = ((off_y as usize + r) * tw + off_x as usize) * 3;
            let d_row = &mut rgb[d_start..d_start + copy_w as usize * 3];
            for (c, d) in d_row.chunks_exact_mut(3).enumerate() {
                d.copy_from_slice(&s_row[c * 4..c * 4 + 3]);
            }
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
) -> Result<Vec<u8>, String> {
    let mut out = None;
    compose_sheets(path, &[page_nums], cols, rows, dpi, gap_px, |_, sheet| {
        out = Some(encode_rgb(&sheet.rgb, sheet.width_px, sheet.height_px, png, quality)?);
        Ok(())
    })?;
    out.ok_or_else(|| "no sheet".to_string())
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

    compose_sheets(input, &sheets, cols, rows, dpi, gap_px, |_, sheet| {
        let mut img_dict = dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => sheet.width_px as i64,
            "Height" => sheet.height_px as i64,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
        };
        let img_stream = if png {
            let mut st = Stream::new(img_dict, sheet.rgb);
            st.compress().map_err(|e| format!("flate: {e}"))?;
            st
        } else {
            let jpeg = encode_rgb(&sheet.rgb, sheet.width_px, sheet.height_px, false, quality)?;
            // jpegtran 方式の可逆最適化 (ハフマン表の最適化 / プログレッシブ化、画素は不変)。
            // 小さくならない・画素が一致しない場合は元の JPEG をそのまま使う。
            let jpeg = match crate::jpeg_optimize::optimize_jpeg(&jpeg) {
                Some(o) => {
                    eprintln!(
                        "[render] jpeg optimized: {} -> {} bytes ({})",
                        jpeg.len(),
                        o.bytes.len(),
                        if o.progressive { "progressive" } else { "baseline" }
                    );
                    o.bytes
                }
                None => jpeg,
            };
            img_dict.set("Filter", "DCTDecode");
            Stream::new(img_dict, jpeg)
        };
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
