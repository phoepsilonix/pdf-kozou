// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/split.rs
use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SplitMode {
    AllPages,
    Ranges { ranges: Vec<[i32; 2]> },
    EveryN { n: i32 },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SplitRequest {
    pub input: String,
    pub out_dir: String,
    pub prefix: Option<String>,
    pub mode: SplitMode,
    /// 分割前に編集したメタデータ。Some の場合は元ファイルのメタデータより優先して使用。
    /// None の場合は元ファイルのメタデータをそのまま引き継ぐ。
    #[serde(default)]
    pub override_metadata: Option<Vec<(String, String)>>,
}

#[derive(Serialize)]
pub struct SplitResponse {
    pub ok: bool,
    pub files: Vec<String>,
}

/// 分割のエントリポイント。
///
/// まず lopdf 実装を試し、読み込み不能・暗号化など lopdf が扱えない入力のときだけ
/// 従来の MuPDF 実装へフォールバックする（移行期間中の安全策）。
pub fn split(req: &SplitRequest) -> Result<SplitResponse> {
    match split_with_lopdf(req) {
        Ok(res) => Ok(res),
        Err(e @ CoreError::InvalidArg(_)) => Err(e),
        Err(e) => {
            eprintln!("[split] lopdf path failed ({e}); falling back to MuPDF");
            split_with_mupdf(req)
        }
    }
}

/// 抽出時に参照をたどる際の文脈。
struct Extract<'a> {
    src: &'a lopdf::Document,
    /// 元文書の全ページ
    all_pages: &'a std::collections::HashSet<lopdf::ObjectId>,
    /// 今回取り出すページ
    selected: std::collections::HashSet<lopdf::ObjectId>,
}

impl Extract<'_> {
    fn is_pages_node(&self, id: lopdf::ObjectId) -> bool {
        use lopdf::Object;
        matches!(
            self.src.objects.get(&id),
            Some(Object::Dictionary(d)) if matches!(d.get(b"Type"), Ok(Object::Name(n)) if n == b"Pages")
        )
    }

    /// 参照を走査する。取り出さないページ・ページツリーのノードへの参照は Null にして
    /// 切り離す（他ページや文書全体を巻き込まないため）。それ以外は stack に積む。
    fn visit(&self, obj: &mut lopdf::Object, stack: &mut Vec<lopdf::ObjectId>) {
        use lopdf::Object;
        match obj {
            Object::Reference(id) => {
                let id = *id;
                let foreign_page = self.all_pages.contains(&id) && !self.selected.contains(&id);
                if foreign_page || self.is_pages_node(id) {
                    *obj = Object::Null;
                } else {
                    stack.push(id);
                }
            }
            Object::Array(a) => a.iter_mut().for_each(|o| self.visit(o, stack)),
            Object::Dictionary(d) => d.iter_mut().for_each(|(_, v)| self.visit(v, stack)),
            Object::Stream(s) => s.dict.iter_mut().for_each(|(_, v)| self.visit(v, stack)),
            _ => {}
        }
    }
}

/// 取り出したページから到達できるオブジェクトだけを、元の番号のまま新しい文書へ複製する。
fn extract_pages(
    src: &lopdf::Document,
    all_pages: &std::collections::HashSet<lopdf::ObjectId>,
    selected: &[lopdf::ObjectId],
) -> lopdf::Document {
    use lopdf::{Dictionary, Document, Object};
    use std::collections::HashSet;

    let ctx = Extract {
        src,
        all_pages,
        selected: selected.iter().copied().collect(),
    };
    let mut dst = Document::with_version(src.version.clone());
    let mut seen: HashSet<lopdf::ObjectId> = HashSet::new();
    let mut stack: Vec<lopdf::ObjectId> = selected.to_vec();

    while let Some(id) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        let Some(orig) = src.objects.get(&id) else {
            continue;
        };
        let mut obj = orig.clone();
        if ctx.selected.contains(&id) {
            if let Object::Dictionary(d) = &mut obj {
                d.remove(b"Parent");
            }
        }
        ctx.visit(&mut obj, &mut stack);
        dst.objects.insert(id, obj);
    }
    dst.max_id = src.max_id;

    let pages_id = dst.new_object_id();
    let kids: Vec<Object> = selected.iter().map(|&p| Object::Reference(p)).collect();
    let mut pages = Dictionary::new();
    pages.set("Type", "Pages");
    pages.set("Count", kids.len() as i64);
    pages.set("Kids", Object::Array(kids));
    dst.objects.insert(pages_id, Object::Dictionary(pages));
    for &p in selected {
        if let Some(Object::Dictionary(d)) = dst.objects.get_mut(&p) {
            d.set("Parent", Object::Reference(pages_id));
        }
    }

    let mut catalog = Dictionary::new();
    catalog.set("Type", "Catalog");
    catalog.set("Pages", Object::Reference(pages_id));
    let catalog_id = dst.add_object(Object::Dictionary(catalog));
    dst.trailer.set("Root", Object::Reference(catalog_id));

    drop_dead_link_annots(&mut dst, selected);
    dst
}

/// 宛先ページが取り出し対象外で Null になったリンク注釈を、/Annots から外す。
fn drop_dead_link_annots(dst: &mut lopdf::Document, pages: &[lopdf::ObjectId]) {
    use lopdf::Object;

    fn dead_dest(obj: &Object) -> bool {
        matches!(obj, Object::Array(a) if matches!(a.first(), Some(Object::Null)))
    }

    for &pid in pages {
        // /Annots は配列そのもの、または配列への参照
        let annots_ref = match dst.objects.get(&pid) {
            Some(Object::Dictionary(d)) => match d.get(b"Annots") {
                Ok(Object::Reference(r)) => Some(*r),
                _ => None,
            },
            _ => None,
        };
        let Some(Object::Array(list)) = (match annots_ref {
            Some(r) => dst.objects.get(&r).cloned(),
            None => match dst.objects.get(&pid) {
                Some(Object::Dictionary(d)) => d.get(b"Annots").ok().cloned(),
                _ => None,
            },
        }) else {
            continue;
        };

        let keep: Vec<Object> = list
            .into_iter()
            .filter(|item| {
                let annot = match item {
                    Object::Reference(r) => dst.objects.get(r),
                    other => Some(other),
                };
                let Some(Object::Dictionary(a)) = annot else {
                    return true;
                };
                if a.get(b"Dest").map(dead_dest).unwrap_or(false) {
                    return false;
                }
                let action = match a.get(b"A") {
                    Ok(Object::Reference(r)) => dst.objects.get(r),
                    Ok(other) => Some(other),
                    Err(_) => None,
                };
                if let Some(Object::Dictionary(act)) = action {
                    if act.get(b"D").map(dead_dest).unwrap_or(false) {
                        return false;
                    }
                }
                true
            })
            .collect();

        match annots_ref {
            Some(r) => {
                dst.objects.insert(r, Object::Array(keep));
            }
            None => {
                if let Some(Object::Dictionary(d)) = dst.objects.get_mut(&pid) {
                    d.set("Annots", Object::Array(keep));
                }
            }
        }
    }
}

/// lopdf による分割。出力ごとに、取り出すページから到達できるオブジェクトだけを複製する
/// （入力全体を出力数ぶん複製しないので、全ページ分割でも出力数に比例して遅くならない）。
fn split_with_lopdf(req: &SplitRequest) -> Result<SplitResponse> {
    use lopdf::Document;
    use std::collections::HashSet;

    let mut src = Document::load(&req.input)
        .map_err(|e| CoreError::Parse(format!("{}: {e}", req.input)))?;
    if src.is_encrypted() {
        return Err(CoreError::Parse(format!("{}: encrypted PDF", req.input)));
    }
    let page_ids: Vec<lopdf::ObjectId> = src.get_pages().into_values().collect();
    if page_ids.is_empty() {
        return Err(CoreError::Parse(format!("{}: no pages", req.input)));
    }
    let page_count = page_ids.len() as i32;
    crate::merge::flatten_inherited_attrs(&mut src, &page_ids);
    let all_pages: HashSet<lopdf::ObjectId> = page_ids.iter().copied().collect();

    let prefix = req.prefix.as_deref().unwrap_or("page");
    let out_dir = std::path::Path::new(&req.out_dir);
    std::fs::create_dir_all(out_dir)?;

    let metadata: Vec<(String, String)> = if let Some(ref ov) = req.override_metadata {
        ov.clone()
    } else {
        crate::compress::collect_metadata(&req.input)
    };

    let ranges: Vec<Vec<i32>> = match &req.mode {
        SplitMode::AllPages => (0..page_count).map(|i| vec![i]).collect(),
        SplitMode::Ranges { ranges } => ranges
            .iter()
            .map(|r| {
                let start = (r[0] - 1).max(0);
                let end = (r[1] - 1).min(page_count - 1);
                (start..=end).collect()
            })
            .collect(),
        SplitMode::EveryN { n } => {
            if *n <= 0 {
                return Err(CoreError::InvalidArg(format!("every must be >= 1 (got {n})")));
            }
            (0..page_count)
                .step_by(*n as usize)
                .map(|start| (start..(start + n).min(page_count)).collect())
                .collect()
        }
    };

    let mut files = Vec::new();
    for page_indices in &ranges {
        if page_indices.is_empty() {
            return Err(CoreError::InvalidArg("page range is empty".into()));
        }
        let fname = if page_indices.len() == 1 {
            format!("{prefix}_{:04}.pdf", page_indices[0] + 1)
        } else {
            format!(
                "{prefix}_{:04}-{:04}.pdf",
                page_indices[0] + 1,
                page_indices.last().unwrap() + 1
            )
        };
        let out_path = out_dir.join(&fname);
        let selected: Vec<lopdf::ObjectId> =
            page_indices.iter().map(|&i| page_ids[i as usize]).collect();

        let mut dst = extract_pages(&src, &all_pages, &selected);
        dst.prune_objects();
        dst.compress();
        dst.save(&out_path)
            .map_err(|e| CoreError::Parse(format!("{}: {e}", out_path.display())))?;

        crate::compress::copy_metadata_after_write(out_path.to_str().unwrap(), &metadata);
        files.push(out_path.to_string_lossy().to_string());
    }

    Ok(SplitResponse { ok: true, files })
}

/// 従来の MuPDF 実装（lopdf 実装が失敗したときのフォールバック）。
fn split_with_mupdf(req: &SplitRequest) -> Result<SplitResponse> {
    use mupdf::pdf::PdfDocument;

    let src = PdfDocument::open(&req.input).map_err(|e| CoreError::MuPdf(e.to_string()))?;
    let page_count = src
        .page_count()
        .map_err(|e| CoreError::MuPdf(e.to_string()))?;

    let prefix = req.prefix.as_deref().unwrap_or("page");
    let out_dir = std::path::Path::new(&req.out_dir);
    std::fs::create_dir_all(out_dir)?;

    // メタデータ: override_metadata が指定されていればそれを優先、
    // なければ入力 PDF からそのまま引き継ぐ
    let metadata: Vec<(String, String)> = if let Some(ref ov) = req.override_metadata {
        ov.clone()
    } else {
        crate::compress::collect_metadata(&req.input)
    };

    let ranges: Vec<Vec<i32>> = match &req.mode {
        SplitMode::AllPages => (0..page_count).map(|i| vec![i]).collect(),
        SplitMode::Ranges { ranges } => ranges
            .iter()
            .map(|r| {
                let start = (r[0] - 1).max(0);
                let end = (r[1] - 1).min(page_count - 1);
                (start..=end).collect()
            })
            .collect(),
        SplitMode::EveryN { n } => (0..page_count)
            .step_by(*n as usize)
            .map(|start| {
                let end = (start + n).min(page_count);
                (start..end).collect()
            })
            .collect(),
    };

    let mut files = Vec::new();

    for page_indices in &ranges {
        let fname = if page_indices.len() == 1 {
            format!("{prefix}_{:04}.pdf", page_indices[0] + 1)
        } else {
            format!(
                "{prefix}_{:04}-{:04}.pdf",
                page_indices[0] + 1,
                page_indices.last().unwrap() + 1
            )
        };
        let out_path = out_dir.join(&fname);

        let mut dst = PdfDocument::new();
        let mut graft = dst
            .new_graft_map()
            .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;

        for &page_idx in page_indices {
            let src_page = src
                .find_page(page_idx)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
            let dst_page = graft
                .graft_object(&src_page)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
            // mupdf 0.6: -1 は無効。現在のページ数 = 末尾に追加
            let at = dst
                .page_count()
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
            dst.insert_page(at, &dst_page)
                .map_err(|e: mupdf::Error| CoreError::MuPdf(e.to_string()))?;
        }

        let mut opts = mupdf::pdf::PdfWriteOptions::default();
        // gc=2: 未参照オブジェクト除去のみ。サイズ削減は連携圧縮ができていないので2にしておく。
        //
        opts.set_incremental(false)
            .set_compress(true)
            .set_compress_fonts(true)
            .set_compress_images(true)
            .set_garbage_level(2)
            .set_sanitize(false)
            .set_clean(false);
        dst.save_with_options(out_path.to_str().unwrap(), opts)
            .map_err(|e| CoreError::MuPdf(e.to_string()))?;

        // 入力 PDF のメタデータを各出力ファイルに引き継ぐ
        crate::compress::copy_metadata_after_write(out_path.to_str().unwrap(), &metadata);

        files.push(out_path.to_string_lossy().to_string());
    }

    Ok(SplitResponse { ok: true, files })
}
