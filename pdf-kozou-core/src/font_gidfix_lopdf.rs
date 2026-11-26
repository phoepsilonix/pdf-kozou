// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/font_gidfix_lopdf.rs
// 文字コードがグリフ番号 (GID) になっている CID キー付き CFF フォントを、どのビューワでも
// 同じ字形で表示できるように直す (lopdf、MuPDF を使わない)。
//
// 症状: Canva が書く PDF には、/Subtype /CIDFontType0 の子孫フォントに OpenType (CFF) を
// 埋め込み、内容ストリームの文字コードに CID ではなく GID を書くものがある。規格どおりなら
// CID を CFF の charset で引くので、charset に無い番号は .notdef (何も描かれない) になる。
// Windows のブラウザは、コードをそのまま GID として引くので描ける。MuPDF、モバイルや Linux の
// ビューワなど、charset で引く実装では、◀ (U+25C0) のような字が欠ける。
//
// 直し方: charset を CID = GID の恒等表に差し替える。内容ストリーム、/W、ToUnicode は
// 変えずに、どちらの引き方でも同じグリフになる。OpenType の包みは残し、`CFF ` テーブルだけを
// 入れ替える (縦書き用の VORG / vhea / vmtx などもそのまま残る)。
//
// 同じフォントファイルを他のフォントが使っていても壊さないよう、元のオブジェクトは書き換えず、
// 直すフォントごとに、直したフォントファイルと、それを指す FontDescriptor / CIDFont の
// コピーを作って、Type0 フォントの参照だけを付け替える (copy-on-write)。元のファイルは、
// 他から使われなくなれば、あとの prune で取り除かれる。
//
// 直すのは、次の証拠が揃った埋め込みフォントだけ:
//   - ToUnicode が示す文字を、フォントの cmap で引いたグリフ番号が文字コードと同じ (GID のコード)
//   - 文字コードを CID として charset で引いたグリフが、cmap が示すグリフと同じ例が 1 つも無い
// ToUnicode の無いフォント、規格どおり CID のコードを使うフォント、charset が既に
// 恒等のフォントは、そのまま残す。

use crate::crop_redact_lopdf::deref;
use crate::image_recompress::content_stream_bytes_with_limit;
use crate::tounicode_lopdf;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use std::collections::HashMap;
use std::io::Write;

const FONT_LIMIT: usize = 64 * 1024 * 1024;

/// `fixed_copy_file` が作った一時ファイル。捨てるとき (早期の return を含む) に消える。
pub(crate) struct FixedCopy {
    path: std::path::PathBuf,
}

impl FixedCopy {
    pub(crate) fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for FixedCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// MuPDF で描く前に、`input` の、文字コードが GID の CID キー付き CFF フォントを直した一時コピーを
/// `tmp_dir` に作る。
///
/// MuPDF は、CID を CFF の charset で引くので、文字コードが GID のフォントでは ◀ (U+25C0) のような
/// 字が .notdef になり、描けない (画像化で背景に焼き込む文字も、キープテキストで残す文字も欠ける)。
/// 直したコピーを MuPDF に渡せば、描画も、出力のテキスト層のフォントも直ったものになる。
///
/// 直すフォントが無い・読めない・暗号化・書き出しの失敗のときは None (呼び出し側は `input` をそのまま
/// 使う)。GID 補正がオフ (gid_fix) のときも None。lopdf を使う設定 (backend) とは関係なく動く。
pub(crate) fn fixed_copy_file(input: &str, tmp_dir: &std::path::Path) -> Option<FixedCopy> {
    if !crate::gid_fix::enabled() || is_fixed_copy_name(input) || !quick_may_need_fix(input) {
        return None;
    }
    let (mut doc, _bytes) = crate::safe_load::load_checked(input).ok()?;
    if doc.is_encrypted() || doc.was_encrypted() {
        return None;
    }
    let n = fix_gid_coded_cid_fonts(&mut doc);
    if n == 0 {
        return None;
    }
    // 直す前のフォントファイルは、ここで取り除く
    doc.prune_objects();
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = tmp_dir.join(format!(
        "kozou_gidfixed_{}_{unique:x}.pdf",
        std::process::id()
    ));
    if let Err(e) = doc.save(&path) {
        eprintln!("[gid-fix] could not write a fixed copy: {e}");
        let _ = std::fs::remove_file(&path);
        return None;
    }
    eprintln!("[gid-fix] fixed {n} GID-coded CID font(s) before rendering with MuPDF");
    Some(FixedCopy { path })
}

/// MuPDF に渡す入力 (元のパス、または直した一時コピー)。持っている間は、一時コピーが消えない。
pub(crate) struct MuInput {
    path: String,
    _keep: Option<std::sync::Arc<FixedCopy>>,
}

impl MuInput {
    pub(crate) fn path(&self) -> &str {
        &self.path
    }
}

struct CacheEntry {
    key: (String, u64, Option<std::time::SystemTime>),
    copy: Option<std::sync::Arc<FixedCopy>>,
}

/// 直したコピーのキャッシュ (パス・サイズ・更新時刻ごと。直すものが無いファイルも覚える)。
/// ビューワーは 1 ページごとに描画を呼ぶので、同じファイルを何度も lopdf で読み直さないため。
static CACHE: std::sync::OnceLock<std::sync::Mutex<Vec<CacheEntry>>> = std::sync::OnceLock::new();
const CACHE_MAX: usize = 4;

/// 前回までに残った一時コピー (異常終了などで消えなかったもの) を、1 日たったら取り除く。
fn purge_stale(dir: &std::path::Path) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let limit = std::time::Duration::from_secs(24 * 60 * 60);
        for e in rd.flatten() {
            let name = e.file_name();
            if !name.to_string_lossy().starts_with("kozou_gidfixed_") {
                continue;
            }
            let old = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > limit);
            if old {
                let _ = std::fs::remove_file(e.path());
            }
        }
    });
}

/// すでに直したコピー (この module か api::auto_convert_if_needed が作ったもの) か。もう一度は読まない。
fn is_fixed_copy_name(path: &str) -> bool {
    std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("gid_fixed_") || n.starts_with("kozou_gidfixed_"))
}

/// 直す必要のあるフォントがありうるか、ファイルの生のバイト列だけで先読みする。
/// `/CIDFontType0` が無く、オブジェクトストリーム (`/ObjStm`: フォントの辞書が圧縮されて隠れうる) も
/// 無い PDF は、直すものが無いので、lopdf で読まない (大きな PDF の操作が遅くならないように)。
/// 読めないときは、後段の判断に任せて true。
fn quick_may_need_fix(path: &str) -> bool {
    use std::io::Read;
    const PATTERNS: [&[u8]; 2] = [b"/CIDFontType0", b"/ObjStm"];
    const CHUNK: usize = 4 * 1024 * 1024;
    const KEEP: usize = 12; // 最長のパターン (13 バイト) より 1 短い
    let Ok(mut f) = std::fs::File::open(path) else {
        return true;
    };
    let mut buf = vec![0u8; CHUNK + KEEP];
    let mut carry = 0usize;
    loop {
        let n = match f.read(&mut buf[carry..carry + CHUNK]) {
            Ok(0) => return false,
            Ok(n) => n,
            Err(_) => return true,
        };
        let end = carry + n;
        if PATTERNS
            .iter()
            .any(|p| buf[..end].windows(p.len()).any(|w| w == *p))
        {
            return true;
        }
        // 次の読み出しで、チャンクの境目をまたぐパターンを見落とさないよう、末尾を先頭へ残す
        let keep = KEEP.min(end);
        buf.copy_within(end - keep..end, 0);
        carry = keep;
    }
}

/// 直したフォントのある PDF の、直した一時コピー (api::auto_convert_if_needed が入力として返す)。
/// 直すものが無い・補正がオフ・PDF でないときは None。MuPDF の描画と同じキャッシュを使う。
pub(crate) fn fixed_tempfile(input: &str) -> Option<tempfile::NamedTempFile> {
    let m = mupdf_input(input);
    m._keep.as_ref()?;
    let dir = std::env::temp_dir().join("pdf-kozou");
    let _ = std::fs::create_dir_all(&dir);
    let mut tmp = tempfile::Builder::new()
        .prefix("gid_fixed_")
        .suffix(".pdf")
        .tempfile_in(&dir)
        .ok()?;
    let mut src = std::fs::File::open(m.path()).ok()?;
    std::io::copy(&mut src, tmp.as_file_mut()).ok()?;
    Some(tmp)
}

/// 先頭に PDF のヘッダがあるか (EPUB・XPS・画像など、PDF 以外を lopdf で読まないため)
fn looks_like_pdf(path: &str) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 1024];
    let n = f.read(&mut head).unwrap_or(0);
    head[..n].windows(5).any(|w| w == b"%PDF-")
}

/// `cond` が真のときだけ `mupdf_input` する (偽なら、元のパスをそのまま返す)。
pub(crate) fn mupdf_input_if(cond: bool, input: &str) -> MuInput {
    if cond && crate::gid_fix::enabled() {
        mupdf_input(input)
    } else {
        MuInput {
            path: input.to_string(),
            _keep: None,
        }
    }
}

/// MuPDF で描く (画像化・ビューワー・面付けなど) ときに渡すパス。文字コードが GID の CID キー付き CFF
/// フォント (◀ など) があるファイルは、直した一時コピー、それ以外は元のパス。
///
/// MuPDF は、CID を CFF の charset で引くので、そのようなフォントの字が .notdef になり描けない。
/// 直したコピーを渡せば、MuPDF の描画 (ビューワーも、通常の画像化も) で字が出る。
/// 結果は、パス・サイズ・更新時刻ごとにキャッシュする (最大 4 件。追い出されたコピーは、使っている
/// 描画が終われば消える)。
pub(crate) fn mupdf_input(input: &str) -> MuInput {
    let orig = || MuInput {
        path: input.to_string(),
        _keep: None,
    };
    if !crate::gid_fix::enabled() || is_fixed_copy_name(input) {
        return orig();
    }
    let Ok(meta) = std::fs::metadata(input) else {
        return orig();
    };
    let key = (input.to_string(), meta.len(), meta.modified().ok());
    let wrap = |copy: Option<std::sync::Arc<FixedCopy>>| match copy {
        Some(c) => MuInput {
            path: c.path().to_string_lossy().into_owned(),
            _keep: Some(c),
        },
        None => orig(),
    };
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    if let Ok(mut g) = cache.lock()
        && let Some(pos) = g.iter().position(|e| e.key == key)
    {
        let e = g.remove(pos);
        let copy = e.copy.clone();
        g.push(e); // 最近使ったものを末尾へ
        return wrap(copy);
    }

    // 作成は、ロックの外で行う (lopdf で読むので重い)
    let copy = if looks_like_pdf(input) {
        let dir = std::env::temp_dir().join("pdf-kozou");
        let _ = std::fs::create_dir_all(&dir);
        purge_stale(&dir);
        fixed_copy_file(input, &dir).map(std::sync::Arc::new)
    } else {
        None
    };
    if let Ok(mut g) = cache.lock()
        && !g.iter().any(|e| e.key == key)
    {
        g.push(CacheEntry {
            key,
            copy: copy.clone(),
        });
        while g.len() > CACHE_MAX {
            g.remove(0);
        }
    }
    wrap(copy)
}

/// 直したフォントの数を返す。直せないものは黙って残す。
pub(crate) fn fix_gid_coded_cid_fonts(doc: &mut Document) -> usize {
    if !crate::gid_fix::enabled() {
        return 0;
    }
    // 直すフォント (Type0 の番号と、元のフォントファイルの番号) と、フォントファイルごとの直した中身
    let mut targets: Vec<(ObjectId, ObjectId)> = Vec::new();
    let mut fixed_files: HashMap<ObjectId, Vec<u8>> = HashMap::new();
    for (id, obj) in &doc.objects {
        let Object::Dictionary(font) = obj else {
            continue;
        };
        let Some((file_id, otf)) = analyze(doc, font) else {
            continue;
        };
        fixed_files.entry(file_id).or_insert(otf);
        targets.push((*id, file_id));
    }

    let mut new_files: HashMap<ObjectId, ObjectId> = HashMap::new();
    let mut fixed = 0;
    for (font_id, file_id) in targets {
        let new_file = match new_files.get(&file_id) {
            Some(id) => *id,
            None => {
                let Some(stream) = fixed_files.get(&file_id).and_then(|b| open_type_stream(b))
                else {
                    continue;
                };
                let id = doc.add_object(Object::Stream(stream));
                new_files.insert(file_id, id);
                id
            }
        };
        if repoint_font(doc, font_id, new_file).is_some() {
            fixed += 1;
        }
    }
    fixed
}

/// 直した OpenType を入れた、FontFile3 のストリーム
fn open_type_stream(otf: &[u8]) -> Option<Stream> {
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(otf).ok()?;
    let compressed = enc.finish().ok()?;
    let mut dict = Dictionary::new();
    dict.set("Subtype", "OpenType");
    dict.set("Filter", "FlateDecode");
    dict.set("Length", compressed.len() as i64);
    Some(Stream::new(dict, compressed))
}

/// Type0 フォントが、直したフォントファイルを指すように付け替える。
/// FontDescriptor と CIDFont はコピーを作り、元のものは変えない。
fn repoint_font(doc: &mut Document, font_id: ObjectId, new_file: ObjectId) -> Option<()> {
    let mut font = match doc.objects.get(&font_id)? {
        Object::Dictionary(d) => d.clone(),
        _ => return None,
    };
    let mut desc = match deref(doc, font.get(b"DescendantFonts").ok()?) {
        Object::Array(a) => a.clone(),
        _ => return None,
    };
    let mut cid_font = match deref(doc, desc.first()?) {
        Object::Dictionary(d) => d.clone(),
        _ => return None,
    };
    let mut descriptor = match deref(doc, cid_font.get(b"FontDescriptor").ok()?) {
        Object::Dictionary(d) => d.clone(),
        _ => return None,
    };

    descriptor.set("FontFile3", Object::Reference(new_file));
    let descriptor_id = doc.add_object(Object::Dictionary(descriptor));
    cid_font.set("FontDescriptor", Object::Reference(descriptor_id));
    let cid_font_id = doc.add_object(Object::Dictionary(cid_font));
    desc[0] = Object::Reference(cid_font_id);
    font.set("DescendantFonts", Object::Array(desc));
    doc.objects.insert(font_id, Object::Dictionary(font));
    Some(())
}

fn name_of<'a>(doc: &'a Document, d: &'a Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    d.get(key).ok().and_then(|o| deref(doc, o).as_name().ok())
}

/// 直す必要があるフォントなら、フォントファイルの番号と、直した OpenType
fn analyze(doc: &Document, font: &Dictionary) -> Option<(ObjectId, Vec<u8>)> {
    if name_of(doc, font, b"Subtype")? != b"Type0" {
        return None;
    }
    if !matches!(
        name_of(doc, font, b"Encoding")?,
        b"Identity-H" | b"Identity-V"
    ) {
        return None;
    }
    let Object::Array(desc) = deref(doc, font.get(b"DescendantFonts").ok()?) else {
        return None;
    };
    let Object::Dictionary(cid_font) = deref(doc, desc.first()?) else {
        return None;
    };
    if name_of(doc, cid_font, b"Subtype")? != b"CIDFontType0" {
        return None;
    }
    let Object::Dictionary(descriptor) = deref(doc, cid_font.get(b"FontDescriptor").ok()?) else {
        return None;
    };
    let Object::Reference(file_id) = descriptor.get(b"FontFile3").ok()? else {
        return None;
    };
    let Some(Object::Stream(file)) = doc.objects.get(file_id) else {
        return None;
    };
    if file.dict.get(b"Subtype").ok()?.as_name().ok()? != b"OpenType" {
        return None;
    }
    let bytes = content_stream_bytes_with_limit(file, FONT_LIMIT).ok()?;

    let mut uni = Vec::new();
    for (code, text) in tounicode_lopdf::build(doc, font).entries() {
        let mut chars = text.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            uni.push((code, c as u32));
        }
    }
    if uni.is_empty() {
        return None;
    }

    let cff = identity_charset_cff(&bytes, &uni)?;
    let otf = replace_cff_table(&bytes, &cff)?;
    Some((*file_id, otf))
}

// ── 読み取りの道具 ────────────────────────────────────────────────────────

fn be16(d: &[u8], o: usize) -> Option<u32> {
    Some(u16::from_be_bytes(d.get(o..o.checked_add(2)?)?.try_into().ok()?) as u32)
}

fn be32(d: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        d.get(o..o.checked_add(4)?)?.try_into().ok()?,
    ))
}

/// OpenType のテーブル (オフセット, 長さ)
fn table(d: &[u8], tag: &[u8; 4]) -> Option<(usize, usize)> {
    if d.get(0..4)? != b"OTTO" {
        return None;
    }
    let n = be16(d, 4)? as usize;
    for i in 0..n {
        let rec = 12 + i * 16;
        if d.get(rec..rec + 4)? == tag {
            let off = be32(d, rec + 8)? as usize;
            let len = be32(d, rec + 12)? as usize;
            d.get(off..off.checked_add(len)?)?;
            return Some((off, len));
        }
    }
    None
}

/// Unicode → グリフ番号 (cmap の format 4 と 12)
fn read_cmap(d: &[u8], off: usize) -> HashMap<u32, u32> {
    let mut map = HashMap::new();
    let n = be16(d, off + 2).unwrap_or(0) as usize;
    for i in 0..n {
        let rec = off + 4 + i * 8;
        let (Some(platform), Some(encoding), Some(sub)) =
            (be16(d, rec), be16(d, rec + 2), be32(d, rec + 4))
        else {
            break;
        };
        if !(platform == 0 || (platform == 3 && (encoding == 1 || encoding == 10))) {
            continue;
        }
        let sub = off + sub as usize;
        let _ = match be16(d, sub) {
            Some(4) => cmap4(d, sub, &mut map),
            Some(12) => cmap12(d, sub, &mut map),
            _ => None,
        };
    }
    map
}

fn cmap4(d: &[u8], sub: usize, map: &mut HashMap<u32, u32>) -> Option<()> {
    let segs = be16(d, sub + 6)? as usize / 2;
    let end_o = sub + 14;
    let start_o = end_o + segs * 2 + 2;
    let delta_o = start_o + segs * 2;
    let range_o = delta_o + segs * 2;
    for s in 0..segs {
        let end = be16(d, end_o + 2 * s)?;
        let start = be16(d, start_o + 2 * s)?;
        let delta = be16(d, delta_o + 2 * s)?;
        let ro = be16(d, range_o + 2 * s)? as usize;
        for c in start..=end {
            if c == 0xFFFF {
                break;
            }
            let gid = if ro == 0 {
                (c + delta) & 0xFFFF
            } else {
                let g = be16(d, range_o + 2 * s + ro + 2 * (c - start) as usize)?;
                if g == 0 { 0 } else { (g + delta) & 0xFFFF }
            };
            if gid != 0 {
                map.entry(c).or_insert(gid);
            }
        }
    }
    Some(())
}

fn cmap12(d: &[u8], sub: usize, map: &mut HashMap<u32, u32>) -> Option<()> {
    let groups = be32(d, sub + 12)? as usize;
    for g in 0..groups {
        let o = sub + 16 + g * 12;
        let (start, end, gid) = (be32(d, o)?, be32(d, o + 4)?, be32(d, o + 8)?);
        if end < start || end - start > 0x10FFFF {
            return None;
        }
        for c in start..=end {
            map.entry(c).or_insert(gid + (c - start));
        }
    }
    Some(())
}

struct Index {
    /// 各オブジェクトの開始位置 (base からの相対)。最後は終端
    offsets: Vec<usize>,
    base: usize,
    end: usize,
}

impl Index {
    fn count(&self) -> usize {
        self.offsets.len().saturating_sub(1)
    }

    fn range(&self, i: usize) -> Option<(usize, usize)> {
        Some((
            self.base + *self.offsets.get(i)?,
            self.base + *self.offsets.get(i + 1)?,
        ))
    }
}

fn parse_index(d: &[u8], pos: usize) -> Option<Index> {
    let count = be16(d, pos)? as usize;
    if count == 0 {
        return Some(Index {
            offsets: vec![],
            base: pos + 2,
            end: pos + 2,
        });
    }
    let size = *d.get(pos + 2)? as usize;
    if !(1..=4).contains(&size) {
        return None;
    }
    let arr = pos + 3;
    let mut offsets = Vec::with_capacity(count + 1);
    for k in 0..=count {
        let mut v = 0usize;
        for b in 0..size {
            v = (v << 8) | *d.get(arr + k * size + b)? as usize;
        }
        offsets.push(v);
    }
    let base = arr + (count + 1) * size - 1;
    let end = base + *offsets.last()?;
    d.get(..end)?;
    Some(Index { offsets, base, end })
}

struct DictEntry {
    op: u16,
    /// 最後のオペランドの位置、長さ、値
    start: usize,
    len: usize,
    value: i64,
}

const OP_CHARSET: u16 = 15;
const OP_CHARSTRINGS: u16 = 17;
const OP_ROS: u16 = 0x0c1e;

fn parse_dict(d: &[u8], start: usize, end: usize) -> Option<Vec<DictEntry>> {
    let mut out = Vec::new();
    let mut i = start;
    let mut last: Option<(usize, usize, i64)> = None;
    while i < end {
        let b = *d.get(i)?;
        match b {
            0..=21 => {
                let (op, n) = if b == 12 {
                    (0x0c00 | *d.get(i + 1)? as u16, 2)
                } else {
                    (b as u16, 1)
                };
                let (s, l, v) = last.take().unwrap_or((i, 0, 0));
                out.push(DictEntry {
                    op,
                    start: s,
                    len: l,
                    value: v,
                });
                i += n;
            }
            28 => {
                let v = i16::from_be_bytes([*d.get(i + 1)?, *d.get(i + 2)?]) as i64;
                last = Some((i, 3, v));
                i += 3;
            }
            29 => {
                let v = i32::from_be_bytes(d.get(i + 1..i + 5)?.try_into().ok()?) as i64;
                last = Some((i, 5, v));
                i += 5;
            }
            30 => {
                let s = i;
                i += 1;
                loop {
                    let x = *d.get(i)?;
                    i += 1;
                    if x & 0x0f == 0x0f || x >> 4 == 0x0f {
                        break;
                    }
                }
                last = Some((s, i - s, 0));
            }
            32..=246 => {
                last = Some((i, 1, b as i64 - 139));
                i += 1;
            }
            247..=250 => {
                let b1 = *d.get(i + 1)? as i64;
                last = Some((i, 2, (b as i64 - 247) * 256 + b1 + 108));
                i += 2;
            }
            251..=254 => {
                let b1 = *d.get(i + 1)? as i64;
                last = Some((i, 2, -(b as i64 - 251) * 256 - b1 - 108));
                i += 2;
            }
            _ => return None,
        }
    }
    Some(out)
}

/// charset: グリフ番号 → CID (グリフ 0 は 0)
fn read_charset(d: &[u8], off: usize, n: usize) -> Option<Vec<u32>> {
    let format = *d.get(off)?;
    let mut p = off + 1;
    let mut cids = vec![0u32];
    match format {
        0 => {
            while cids.len() < n {
                cids.push(be16(d, p)?);
                p += 2;
            }
        }
        1 | 2 => {
            while cids.len() < n {
                let first = be16(d, p)?;
                p += 2;
                let left = if format == 1 {
                    let v = *d.get(p)? as u32;
                    p += 1;
                    v
                } else {
                    let v = be16(d, p)?;
                    p += 2;
                    v
                };
                for k in 0..=left {
                    if cids.len() >= n {
                        break;
                    }
                    cids.push(first + k);
                }
            }
        }
        _ => return None,
    }
    Some(cids)
}

/// `uni`: (文字コード, Unicode) の組。直すべきなら、charset を恒等にした CFF
fn identity_charset_cff(font: &[u8], uni: &[(u32, u32)]) -> Option<Vec<u8>> {
    let (cff_off, cff_len) = table(font, b"CFF ")?;
    let (cmap_off, _) = table(font, b"cmap")?;
    let mut cff = font[cff_off..cff_off + cff_len].to_vec();

    // ヘッダ、Name INDEX、Top DICT INDEX
    let hdr = *cff.get(2)? as usize;
    let names = parse_index(&cff, hdr)?;
    let tops = parse_index(&cff, names.end)?;
    let (ts, te) = tops.range(0)?;
    let top = parse_dict(&cff, ts, te)?;
    if !top.iter().any(|e| e.op == OP_ROS) {
        return None; // CID キーではない
    }
    let charset = top.iter().find(|e| e.op == OP_CHARSET)?;
    let strings = top.iter().find(|e| e.op == OP_CHARSTRINGS)?;
    let n = parse_index(&cff, usize::try_from(strings.value).ok()?)?.count();
    if n < 2 || charset.value <= 2 || !(charset.len == 5 || charset.len == 3) {
        return None;
    }
    let cids = read_charset(&cff, usize::try_from(charset.value).ok()?, n)?;
    if cids.iter().enumerate().all(|(g, c)| *c as usize == g) {
        return None; // 既に恒等
    }

    // 証拠: ToUnicode の文字を cmap で引いたグリフ番号と、文字コードの関係
    let cmap = read_cmap(font, cmap_off);
    let (mut gid_coded, mut cid_coded) = (0, 0);
    for (code, ch) in uni {
        let Some(&gid) = cmap.get(ch) else {
            continue;
        };
        let gid = gid as usize;
        let Some(&cid) = cids.get(gid) else {
            continue;
        };
        if gid as u32 == *code && cid != *code {
            gid_coded += 1;
        } else if cid == *code && gid as u32 != *code {
            cid_coded += 1;
        }
    }
    if gid_coded == 0 || cid_coded > 0 {
        return None;
    }

    // 恒等の charset (format 2: CID 1 から n - 1 個) を末尾に足し、Top DICT の参照先を差し替える
    let new_off = cff.len();
    let left = (n - 2) as u16;
    cff.extend_from_slice(&[2, 0, 1, (left >> 8) as u8, left as u8]);
    if charset.len == 5 {
        let v = i32::try_from(new_off).ok()?;
        cff[charset.start] = 29;
        cff[charset.start + 1..charset.start + 5].copy_from_slice(&v.to_be_bytes());
    } else {
        let v = i16::try_from(new_off).ok()?;
        cff[charset.start] = 28;
        cff[charset.start + 1..charset.start + 3].copy_from_slice(&v.to_be_bytes());
    }
    Some(cff)
}

fn checksum(d: &[u8]) -> u32 {
    let mut sum = 0u32;
    for chunk in d.chunks(4) {
        let mut b = [0u8; 4];
        b[..chunk.len()].copy_from_slice(chunk);
        sum = sum.wrapping_add(u32::from_be_bytes(b));
    }
    sum
}

/// OpenType (CFF) の `CFF ` テーブルだけを入れ替え、テーブルの並びと、チェックサム
/// (各テーブルと head の checkSumAdjustment) を組み直す。他のテーブルは変えない。
fn replace_cff_table(font: &[u8], new_cff: &[u8]) -> Option<Vec<u8>> {
    if font.get(0..4)? != b"OTTO" {
        return None;
    }
    let n = be16(font, 4)? as usize;
    let mut tables: Vec<([u8; 4], Vec<u8>)> = Vec::with_capacity(n);
    for i in 0..n {
        let rec = 12 + i * 16;
        let tag: [u8; 4] = font.get(rec..rec + 4)?.try_into().ok()?;
        let off = be32(font, rec + 8)? as usize;
        let len = be32(font, rec + 12)? as usize;
        let data = if &tag == b"CFF " {
            new_cff.to_vec()
        } else {
            font.get(off..off.checked_add(len)?)?.to_vec()
        };
        tables.push((tag, data));
    }
    // head の checkSumAdjustment は、全体のチェックサムを出す前は 0
    for (tag, data) in tables.iter_mut() {
        if tag == b"head" && data.len() >= 12 {
            data[8..12].fill(0);
        }
    }

    let mut out = Vec::new();
    out.extend_from_slice(font.get(0..12)?);
    let mut offset = 12 + 16 * n;
    let mut head_offset = None;
    for (tag, data) in &tables {
        if tag == b"head" {
            head_offset = Some(offset);
        }
        out.extend_from_slice(tag);
        out.extend_from_slice(&checksum(data).to_be_bytes());
        out.extend_from_slice(&u32::try_from(offset).ok()?.to_be_bytes());
        out.extend_from_slice(&u32::try_from(data.len()).ok()?.to_be_bytes());
        offset += data.len().div_ceil(4) * 4;
    }
    for (_, data) in &tables {
        out.extend_from_slice(data);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
    if let Some(h) = head_offset
        && out.len() >= h + 12
    {
        let adjustment = 0xB1B0_AFBAu32.wrapping_sub(checksum(&out));
        out[h + 8..h + 12].copy_from_slice(&adjustment.to_be_bytes());
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dict_operands() {
        // 1000 (28), 5 (144), 70000 (29), 超えた実数 (30)、charset=15、CharStrings=17
        let d = [
            28, 0x03, 0xE8, 15, //
            144, 17, //
            29, 0, 1, 0x11, 0x70, 12, 30,
        ];
        let e = parse_dict(&d, 0, d.len()).unwrap();
        assert_eq!(e.len(), 3);
        assert_eq!((e[0].op, e[0].value, e[0].len), (OP_CHARSET, 1000, 3));
        assert_eq!((e[1].op, e[1].value, e[1].len), (OP_CHARSTRINGS, 5, 1));
        assert_eq!((e[2].op, e[2].value, e[2].len), (OP_ROS, 70000, 5));
    }

    #[test]
    fn charset_formats() {
        // format 0: グリフ 1 と 2 の CID が 700 と 9
        let f0 = [0, 0x02, 0xBC, 0x00, 0x09];
        assert_eq!(read_charset(&f0, 0, 3).unwrap(), vec![0, 700, 9]);
        // format 2: CID 5 から 3 個
        let f2 = [2, 0x00, 0x05, 0x00, 0x02];
        assert_eq!(read_charset(&f2, 0, 4).unwrap(), vec![0, 5, 6, 7]);
        // format 1: CID 5 から 3 個
        let f1 = [1, 0x00, 0x05, 0x02];
        assert_eq!(read_charset(&f1, 0, 4).unwrap(), vec![0, 5, 6, 7]);
    }

    #[test]
    fn index_ranges() {
        // count 2, offSize 1, offsets 1 3 4, data "ab" "c"
        let d = [0, 2, 1, 1, 3, 4, b'a', b'b', b'c'];
        let i = parse_index(&d, 0).unwrap();
        assert_eq!(i.count(), 2);
        assert_eq!(&d[i.range(0).unwrap().0..i.range(0).unwrap().1], b"ab");
        assert_eq!(&d[i.range(1).unwrap().0..i.range(1).unwrap().1], b"c");
        assert_eq!(i.end, 9);
    }

    #[test]
    fn replaces_the_cff_table_and_keeps_the_rest() {
        // OTTO, 2 テーブル (CFF と head)
        let mut font = Vec::new();
        font.extend_from_slice(b"OTTO");
        font.extend_from_slice(&[0, 2, 0, 32, 0, 1, 0, 0]);
        let head = {
            let mut h = vec![0u8; 54];
            h[8..12].copy_from_slice(&0x1234_5678u32.to_be_bytes());
            h
        };
        let old_cff = b"oldcff!".to_vec();
        let (cff_off, head_off) = (44usize, 52usize);
        for (tag, off, data) in [(b"CFF ", cff_off, &old_cff), (b"head", head_off, &head)] {
            font.extend_from_slice(tag);
            font.extend_from_slice(&0u32.to_be_bytes());
            font.extend_from_slice(&(off as u32).to_be_bytes());
            font.extend_from_slice(&(data.len() as u32).to_be_bytes());
        }
        font.extend_from_slice(&old_cff);
        font.push(0);
        font.extend_from_slice(&head);

        let new_cff = b"a much longer replacement CFF table".to_vec();
        let out = replace_cff_table(&font, &new_cff).unwrap();

        let (o, l) = table(&out, b"CFF ").unwrap();
        assert_eq!(&out[o..o + l], &new_cff[..]);
        let (o, l) = table(&out, b"head").unwrap();
        assert_eq!(l, 54);
        assert_eq!(o % 4, 0);
        assert_eq!(out.len() % 4, 0);
        // 全体のチェックサムが、規定値になる
        assert_eq!(checksum(&out), 0xB1B0_AFBA);
        // 他のテーブルは、checkSumAdjustment 以外そのまま
        assert_eq!(&out[o..o + 8], &head[..8]);
        assert_eq!(&out[o + 12..o + 54], &head[12..]);
    }
}
