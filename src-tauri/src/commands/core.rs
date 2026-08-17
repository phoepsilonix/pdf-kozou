// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/commands/core.rs
//
// pdf-kozou-core を直接リンクして呼び出す Tauri コマンド群。
//
// 以前は別プロセス(sidecar)として起動し、stdin/stdout 経由で JSON をやり取り
// していたが、Android/iOS では外部プロセスの起動ができないため廃止した。
// 現在は pdf_kozou_core クレートを rlib として直接リンクし、
// pdf_kozou_core::api::dispatch_json() をそのままインプロセスで呼び出す。
// JSON のプロトコル(cmd フィールドを持つリクエスト/レスポンス)は
// sidecar 時代と完全に同じなので、各 #[tauri::command] 関数側の実装は
// 変更していない。

use crate::error::{Error, Result};
use serde_json::Value;

/// JSON モードで core を呼ぶ（旧: stdin 経由 → 現: 直接関数呼び出し）
///
/// MuPDF 処理は CPU バウンドで時間がかかりうるため、tokio の非同期ランタイムを
/// ブロックしないよう spawn_blocking の中で実行する。
async fn call_core_json(cmd: &str, mut payload: Value) -> Result<Value> {
    payload["cmd"] = serde_json::Value::String(cmd.to_string());
    let json_line = serde_json::to_string(&payload).map_err(|e| Error::Core(e.to_string()))?;

    let response = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        tokio::task::spawn_blocking(move || pdf_kozou_core::api::dispatch_json(&json_line)),
    )
    .await
    .map_err(|_| Error::Core("core call timed out (120s)".into()))?
    .map_err(|e| Error::Core(format!("core task join error: {e}")))?;

    if response.trim().is_empty() {
        return Err(Error::Core("core returned empty output".into()));
    }

    let value: Value = serde_json::from_str(&response)
        .map_err(|e| Error::Core(format!("JSON parse error: {e}\nraw: {response}")))?;

    if value.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let msg = value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown core error");
        return Err(Error::Core(msg.to_string()));
    }

    Ok(value)
}

// ── Tauri コマンド ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_pdf_info(
    path: String,
    layout_w: Option<f32>,
    layout_h: Option<f32>,
    layout_em: Option<f32>,
) -> Result<Value> {
    // dispatch_json 側の "info" ハンドラが auto_convert_if_needed を内部で
    // 呼んでおり、PDF の場合は no-op になるため、PDF/非PDF を区別せず
    // 常に layout パラメータを渡してよい（sidecar 時代の --convert 分岐は不要）。
    call_core_json(
        "info",
        serde_json::json!({
            "path": path,
            "fonts": false,
            "layout_w": layout_w,
            "layout_h": layout_h,
            "layout_em": layout_em,
        }),
    )
    .await
}

#[tauri::command]
pub async fn render_page(
    path: String,
    page: i32,
    dpi: u32,
    format: Option<String>,
    quality: Option<u8>,
    layout_w: Option<f32>,
    layout_h: Option<f32>,
    layout_em: Option<f32>,
) -> Result<Value> {
    // sidecar 時代の CLI 単ページレンダリング処理(main.rs の
    // Commands::Render 単ページ分岐)と同じ手順を踏襲する:
    //   SVG のみ事前に PDF へ変換してからレンダリングする
    //  （MuPDF が SVG を直接開くと luminance マスクを解釈できず
    //    透過部分が黒くなるため）。
    let format = format.unwrap_or_else(|| "jpeg".into());
    let quality = quality.unwrap_or(85);

    let response = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        tokio::task::spawn_blocking(move || -> std::result::Result<String, String> {
            let is_svg = pdf_kozou_core::convert::is_svg(&path);
            let _tmp = if is_svg {
                pdf_kozou_core::api::auto_convert_if_needed(
                    &path, layout_w, layout_h, layout_em, None, None, None,
                )
                .map_err(|e| e.to_string())?
            } else {
                None
            };
            let actual_path = if let Some((_, ref p)) = _tmp {
                p.clone()
            } else {
                path
            };

            let req = pdf_kozou_core::render::RenderRequest {
                path: actual_path,
                page_index: page,
                dpi,
                format: Some(format),
                quality: Some(quality),
                output: None,
                layout_w,
                layout_h,
                layout_em,
            };
            let resp = pdf_kozou_core::render::render(&req).map_err(|e| e.to_string())?;
            serde_json::to_string(&resp).map_err(|e| e.to_string())
        }),
    )
    .await
    .map_err(|_| Error::Core("render call timed out (120s)".into()))?
    .map_err(|e| Error::Core(format!("core task join error: {e}")))?
    .map_err(Error::Core)?;

    serde_json::from_str(&response)
        .map_err(|e| Error::Core(format!("JSON parse error: {e}\nraw: {response}")))
}

#[tauri::command]
pub async fn trim_pdf(request: Value) -> Result<Value> {
    call_core_json("trim", request).await
}

/// 非 PDF ファイル（EPUB, XPS, HTML, CBZ, 画像等）を PDF に変換する
/// layout_w/h/em: リフロー可能文書（DOCX, EPUB, HTML）のレイアウト指定 (pt)
/// 省略時はデフォルト値（w=450, h=600, em=12）が使用される
#[tauri::command]
pub async fn convert_to_pdf(
    input: String,
    output: String,
    layout_w: Option<f32>,
    layout_h: Option<f32>,
    layout_em: Option<f32>,
) -> Result<Value> {
    let mut payload = serde_json::json!({
        "input": input,
        "output": output,
    });
    if let Some(w) = layout_w {
        payload["layout_w"] = w.into();
    }
    if let Some(h) = layout_h {
        payload["layout_h"] = h.into();
    }
    if let Some(em) = layout_em {
        payload["layout_em"] = em.into();
    }
    call_core_json("convert", payload).await
}

/// MuPDF がそのファイルを開けるか確認する（sidecar 経由）
/// → pdf_kozou_core を直接リンクせず sidecar プロセス経由で呼び出す
#[tauri::command]
pub async fn is_mupdf_supported(path: String) -> Result<bool> {
    let res = call_core_json("is_mupdf_supported", serde_json::json!({ "path": path })).await?;
    Ok(res["result"].as_bool().unwrap_or(false))
}

/// ファイルが PDF かどうかを確認する（sidecar 経由）
/// → pdf_kozou_core を直接リンクせず sidecar プロセス経由で呼び出す
#[tauri::command]
pub async fn is_pdf_file(path: String) -> Result<bool> {
    let res = call_core_json("is_pdf", serde_json::json!({ "path": path })).await?;
    Ok(res["result"].as_bool().unwrap_or(false))
}
/// 隠しテキストの文字コードをスペースに置き換える（試験的機能）
///
/// ⚠ 全ての隠しテキスト手法を網羅できる保証はありません。
///   本機能の使用による損害について開発者は責任を負いません。
#[tauri::command]
pub async fn sanitize_hidden_text(request: Value) -> Result<Value> {
    call_core_json("sanitize_hidden", request).await
}

#[tauri::command]
pub async fn sanitize_type3_text(request: Value) -> Result<Value> {
    call_core_json("sanitize_type3", request).await
}

/// base64エンコードされた画像データをファイルに保存する
/// パスの区切り文字（/ と \）の混在をRustのPathで正規化する
#[tauri::command]
pub async fn save_base64_image(
    data: String,
    path: String,
    source_path: Option<String>,
) -> Result<Value> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| Error::Core(format!("base64 decode: {e}")))?;

    // スラッシュ混在を正規化（Windows対応）
    let normalized = std::path::Path::new(&path);
    if let Some(parent) = normalized.parent() {
        std::fs::create_dir_all(parent).map_err(|e| Error::Core(format!("mkdir: {e}")))?;
    }
    std::fs::write(normalized, &bytes)
        .map_err(|e| Error::Core(format!("write {:?}: {e}", normalized)))?;

    // メタデータ埋め込み: source_path が指定された場合は
    // コアバイナリ経由で EXIF/PNG テキストチャンクを書き込む
    if let Some(src) = source_path {
        let ext = normalized
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let fmt = if ext == "png" { "png" } else { "jpeg" };
        // fire-and-forget: メタデータ埋め込み失敗は画像保存には影響しない
        let _ = call_core_json(
            "embed_image_metadata",
            serde_json::json!({
                "image_path": path,
                "source_path": src,
                "format": fmt,
            }),
        )
        .await;
    }

    Ok(serde_json::json!({ "ok": true, "path": normalized.to_string_lossy() }))
}

/// N-up / 製本 面付けレンダリング
/// 複数ページを1枚のpixmapに直接レンダリング（JPEG/PNG圧縮1回のみ）
#[tauri::command]
pub async fn render_imposition(request: Value) -> Result<Value> {
    call_core_json("render_imposition", request).await
}

/// 面付け画像PDF出力
/// 各シート（cols*rows ページ）を1枚に合成し、1つのPDFページとして埋め込む。
/// 例: A4×4ページ booklet → A3×2ページの見開き製本PDF
#[tauri::command]
pub async fn rasterize_imposition(request: Value) -> Result<Value> {
    // 出力先ディレクトリを自動作成
    if let Some(out) = request.get("output").and_then(|v| v.as_str())
        && let Some(parent) = std::path::Path::new(out).parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|e| Error::Core(format!("mkdir: {e}")))?;
    }
    call_core_json("rasterize_imposition", request).await
}

/// 面付け解除 → 画像PDF出力
/// A3見開きなどを左右(または2×2)に分割し、読み順に並べた画像PDFを作る。
/// 例: A3×2ページ(booklet) → A4×4ページ(読み順)
#[tauri::command]
pub async fn split_imposition_pdf(request: Value) -> Result<Value> {
    if let Some(out) = request.get("output").and_then(|v| v.as_str())
        && let Some(parent) = std::path::Path::new(out).parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|e| Error::Core(format!("mkdir: {e}")))?;
    }
    call_core_json("split_imposition_pdf", request).await
}

/// 面付け結合（ベクター保持）→ 通常PDF出力
/// n-up / 見開き製本 / ページサイズ変更。各元ページを出力ページ上に再生するため
/// テキスト・ベクターが保持される（ラスタ化しない）。
/// 例: A4×4ページ → A3×2ページ(見開き製本)
#[tauri::command]
pub async fn compose_imposition_pdf(request: Value) -> Result<Value> {
    if let Some(out) = request.get("output").and_then(|v| v.as_str())
        && let Some(parent) = std::path::Path::new(out).parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|e| Error::Core(format!("mkdir: {e}")))?;
    }
    call_core_json("compose_imposition_pdf", request).await
}

/// 面付け解除した1セルを画像(JPEG/PNG/SVG)としてレンダリングし base64 で返す。
/// 個別画像ファイル出力用。
#[tauri::command]
pub async fn split_cell_render(request: Value) -> Result<Value> {
    call_core_json("split_cell_render", request).await
}

/// 特殊制御文字（ゼロ幅・双方向制御・タグ文字等）を検出
#[tauri::command]
pub async fn detect_control_chars(
    path: String,
    page: i32,
    layout_w: Option<f32>,
    layout_h: Option<f32>,
    layout_em: Option<f32>,
) -> Result<Value> {
    call_core_json(
        "detect_control_chars",
        serde_json::json!({
            "path": path,
            "page": page,
            "layout_w": layout_w,
            "layout_h": layout_h,
            "layout_em": layout_em,
        }),
    )
    .await
}

/// 後から描画された不透明オブジェクトに覆われたテキストを検出
#[tauri::command]
pub async fn detect_buried_text(
    path: String,
    page: i32,
    cover_ratio: Option<f32>,
    image_alpha_threshold: Option<f32>,
    layout_w: Option<f32>,
    layout_h: Option<f32>,
    layout_em: Option<f32>,
) -> Result<Value> {
    call_core_json(
        "detect_buried",
        serde_json::json!({
            "path": path,
            "page": page,
            "cover_ratio": cover_ratio,
            "image_alpha_threshold": image_alpha_threshold,
            "layout_w": layout_w,
            "layout_h": layout_h,
            "layout_em": layout_em,
        }),
    )
    .await
}

/// フォントサイズが size_threshold pt 以下の文字を検出
#[tauri::command]
pub async fn detect_tiny_text(
    path: String,
    page: i32,
    size_threshold: Option<f32>,
    layout_w: Option<f32>,
    layout_h: Option<f32>,
    layout_em: Option<f32>,
) -> Result<Value> {
    call_core_json(
        "detect_tiny",
        serde_json::json!({
            "path": path,
            "page": page,
            "size_threshold": size_threshold,
            "layout_w": layout_w,
            "layout_h": layout_h,
            "layout_em": layout_em,
        }),
    )
    .await
}

/// 文字色と背景色のコントラスト比が contrast_threshold 以下の文字を検出
#[tauri::command]
pub async fn detect_low_contrast_text(
    path: String,
    page: i32,
    contrast_threshold: Option<f32>,
    ratio_threshold: Option<f32>,
    layout_w: Option<f32>,
    layout_h: Option<f32>,
    layout_em: Option<f32>,
) -> Result<Value> {
    call_core_json(
        "detect_low_contrast",
        serde_json::json!({
            "path": path,
            "page": page,
            "contrast_threshold": contrast_threshold,
            "ratio_threshold": ratio_threshold,
            "layout_w": layout_w,
            "layout_h": layout_h,
            "layout_em": layout_em,
        }),
    )
    .await
}

/// ページ内の透明テキストを検出（alpha <= alpha_threshold の文字を返す）
#[tauri::command]
pub async fn detect_transparent_text(
    path: String,
    page: i32,
    alpha_threshold: Option<u8>,
    layout_w: Option<f32>,
    layout_h: Option<f32>,
    layout_em: Option<f32>,
) -> Result<Value> {
    call_core_json(
        "detect_transparent",
        serde_json::json!({
            "path": path,
            "page": page,
            "alpha_threshold": alpha_threshold,
            "layout_w": layout_w,
            "layout_h": layout_h,
            "layout_em": layout_em,
        }),
    )
    .await
}

/// テキスト選択・コピーのためのオーバーレイ生成に使用
#[tauri::command]
pub async fn get_page_text(path: String, page: i32, scale: f32) -> Result<Value> {
    call_core_json(
        "page_text",
        serde_json::json!({
            "path": path,
            "page": page,
            "scale": scale,
        }),
    )
    .await
}

/// ページ内テキスト検索
#[tauri::command]
pub async fn search_page(path: String, page: i32, needle: String, scale: f32) -> Result<Value> {
    call_core_json(
        "search",
        serde_json::json!({
            "path": path,
            "page": page,
            "needle": needle,
            "scale": scale,
        }),
    )
    .await
}

/// ページのリンク一覧を取得する
#[tauri::command]
pub async fn get_page_links(path: String, page: i32, scale: f32) -> Result<Value> {
    call_core_json(
        "page_links",
        serde_json::json!({
            "path": path,
            "page": page,
            "scale": scale,
        }),
    )
    .await
}

#[tauri::command]
pub async fn compress_pdf(request: Value) -> Result<Value> {
    call_core_json("compress", request).await
}

#[tauri::command]
pub async fn split_pdf(request: Value) -> Result<Value> {
    call_core_json("split", request).await
}

#[tauri::command]
pub async fn merge_pdf(request: Value) -> Result<Value> {
    call_core_json("merge", request).await
}

#[tauri::command]
pub async fn rotate_pdf(request: Value) -> Result<Value> {
    call_core_json("rotate", request).await
}

/// 全ページを画像ファイルとして出力する
///
/// 旧: pdf-kozou-core を `render --out-dir <dir> ...` で sidecar 起動していたが、
/// 直接リンクした pdf_kozou_core::api::render_to_dir を spawn_blocking 経由で
/// 呼ぶ形に変更した。
#[tauri::command]
pub async fn export_images(
    path: String,
    out_dir: String,
    format: Option<String>,
    dpi: Option<u32>,
    quality: Option<u8>,
    name_prefix: Option<String>,
    pages: Option<String>,
    layout_w: Option<f32>,
    layout_h: Option<f32>,
    layout_em: Option<f32>,
) -> Result<Value> {
    use serde_json::json;

    let fmt = format.unwrap_or_else(|| "jpeg".into());
    let dpi_val = dpi.unwrap_or(150);
    let quality_val = quality.unwrap_or(85);
    let prefix = name_prefix.unwrap_or_else(|| "page".into());
    let ext = match fmt.as_str() {
        "png" => "png",
        "svg" => "svg",
        _ => "jpg",
    };

    std::fs::create_dir_all(&out_dir).map_err(|e| Error::Core(format!("mkdir {out_dir}: {e}")))?;

    let response = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        tokio::task::spawn_blocking(move || -> std::result::Result<Value, String> {
            // ページ範囲指定が無い(または "all")場合は info から全ページ数を取得
            let indices: Vec<i32> = match pages.as_deref() {
                None => {
                    let info = pdf_kozou_core::info::info(&path).map_err(|e| e.to_string())?;
                    (0..info.page_count).collect()
                }
                Some(p) if p.is_empty() || p == "all" => {
                    let info = pdf_kozou_core::info::info(&path).map_err(|e| e.to_string())?;
                    (0..info.page_count).collect()
                }
                Some(p) => pdf_kozou_core::api::parse_string_pages(p).map_err(|e| e.to_string())?,
            };
            let total = indices.len() as u32;

            pdf_kozou_core::api::render_to_dir(
                &path,
                &indices,
                total,
                None,
                Some(&prefix),
                &out_dir,
                &fmt,
                quality_val,
                dpi_val,
                ext,
                layout_w,
                layout_h,
                layout_em,
            )
            .map_err(|e| e.to_string())
        }),
    )
    .await
    .map_err(|_| Error::Core("export_images timed out (120s)".into()))?
    .map_err(|e| Error::Core(format!("core task join error: {e}")))?
    .map_err(Error::Core)?;

    let files: Vec<String> = response["files"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|item| item["file"].as_str().map(|s| s.to_string()))
        .collect();

    Ok(json!({ "ok": true, "files": files }))
}

/// 指定ページを DPI でラスタライズして 1 つの画像 PDF に書き出す。
///
/// pages: "1-3,5" 形式の 1 ベースページ指定。None で全ページ。
/// out_path: 出力先のフルパス (.pdf)
#[tauri::command]
pub async fn export_image_pdf(
    path: String,
    out_path: String,
    dpi: Option<f32>,
    quality: Option<i32>,
    use_png: Option<bool>,
    pages: Option<String>,
    layout_w: Option<f32>,
    layout_h: Option<f32>,
    layout_em: Option<f32>,
) -> Result<Value> {
    use serde_json::json;

    // 出力先ディレクトリを自動作成
    if let Some(parent) = std::path::Path::new(&out_path).parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|e| Error::Core(format!("mkdir: {e}")))?;
    }

    let request = json!({
        "input":   path,
        "output":  out_path,
        "dpi":     dpi.unwrap_or(150.0),
        "quality": quality.unwrap_or(85),
        "use_png": use_png.unwrap_or(false),
        "pages":   pages,
        "layout_w":  layout_w,
        "layout_h":  layout_h,
        "layout_em": layout_em,
    });

    call_core_json("rasterize", request).await
}

#[tauri::command]
pub async fn check_path_conflict(
    input_path: String,
    out_dir: String,
    pdf_name: Option<String>,
    is_batch: bool,
    batch_files: Option<Vec<(String, String)>>,
) -> Result<Vec<String>> {
    use std::path::Path;

    let mut conflicts = Vec::new();

    let normalize = |p: &str| -> Result<String> {
        let path = Path::new(p);
        match std::fs::canonicalize(path) {
            Ok(canon) => {
                let s = canon.to_string_lossy().to_string();
                Ok(s)
            }
            Err(_e) => {
                let abs = if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    std::env::current_dir().unwrap_or_default().join(path)
                };
                let normalized = abs.to_string_lossy().replace('\\', "/").to_lowercase();
                Ok(normalized)
            }
        }
    };

    // out_dir の正規化
    let out_dir_norm = match std::fs::canonicalize(&out_dir) {
        Ok(p) => p,
        Err(_) => std::path::PathBuf::from(&out_dir),
    };

    if is_batch {
        if let Some(files) = batch_files {
            for (filename, path) in files {
                let stem = Path::new(&filename)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&filename);

                let out_path = out_dir_norm.join(format!("{}.pdf", stem));

                let input_norm = normalize(&path)?;
                let output_norm = match std::fs::canonicalize(&out_path) {
                    Ok(c) => c.to_string_lossy().to_string(),
                    Err(_) => out_path.to_string_lossy().replace('\\', "/").to_lowercase(),
                };

                if input_norm.eq_ignore_ascii_case(&output_norm) {
                    conflicts.push(filename);
                }
            }
        }
    } else {
        let name = pdf_name.unwrap_or_else(|| "output".to_string());
        let out_path = out_dir_norm.join(format!("{}.pdf", name));

        let input_norm = normalize(&input_path)?;
        let output_norm = match std::fs::canonicalize(&out_path) {
            Ok(c) => c.to_string_lossy().to_string(),
            Err(_) => out_path.to_string_lossy().replace('\\', "/").to_lowercase(),
        };

        if input_norm.eq_ignore_ascii_case(&output_norm) {
            conflicts.push(
                Path::new(&input_path)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("input.pdf")
                    .to_string(),
            );
        }
    }

    Ok(conflicts)
}

/// デフォルト保存ディレクトリを返す
///
/// `dirs` クレートが OS 標準 API を使って取得する:
///   - Linux   : XDG user-dirs (`~/.config/user-dirs.dirs` / xdg-user-dirs)
///   - macOS   : `NSFileManager` の `documentDirectory`
///   - Windows : `SHGetKnownFolderPath` (FOLDERID_Documents)
///
/// 優先順位: Documents → Downloads → home → temp
#[tauri::command]
pub async fn get_default_save_dir() -> Result<String> {
    // dirs::document_dir() は各 OS の標準ドキュメントフォルダを返す
    // (言語・ユーザー設定に関わらず正しいパスが得られる)
    let path = dirs::document_dir()
        .filter(|p| p.exists())
        .or_else(|| dirs::download_dir().filter(|p| p.exists()))
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir);

    Ok(path.display().to_string())
}

#[tauri::command]
pub async fn get_tmp_path(filename: String) -> Result<String> {
    let path = crate::tempdir::kozou_temp_path(&filename);
    Ok(path.display().to_string())
}

/// ファイルのメタ情報（サイズ）を返す
#[tauri::command]
pub async fn get_file_stat(path: String) -> Result<Value> {
    use serde_json::json;
    let meta = std::fs::metadata(&path).map_err(|e| Error::Core(format!("stat {path}: {e}")))?;
    Ok(json!({ "size": meta.len() }))
}

/// 一時ファイルパスを返す (pdf-kozou temp dir + name)
#[tauri::command]
pub async fn get_temp_path(name: String) -> Result<String> {
    let path = crate::tempdir::kozou_temp_path(&name);
    Ok(path.display().to_string())
}

/// UUID付きの一意な一時ファイルパスを返す (`{prefix}_{uuid}.{ext}`)。
/// 固定ファイル名だと複数ウィンドウ/バッチ処理間で衝突しうる箇所で使う。
#[tauri::command]
pub async fn get_unique_temp_path(prefix: String, ext: String) -> Result<String> {
    let path = crate::tempdir::kozou_temp_unique_path(&prefix, &ext);
    Ok(path.display().to_string())
}

/// ファイルを移動 (rename → 失敗なら copy + delete)
#[tauri::command]
pub async fn move_file(src: String, dst: String) -> Result<()> {
    if std::fs::rename(&src, &dst).is_ok() {
        return Ok(());
    }
    std::fs::copy(&src, &dst).map_err(|e| Error::Core(e.to_string()))?;
    let _ = std::fs::remove_file(&src);
    Ok(())
}

/// ファイルをコピー
#[tauri::command]
pub async fn copy_file(src: String, dst: String) -> Result<()> {
    std::fs::copy(&src, &dst).map_err(|e| Error::Core(e.to_string()))?;
    Ok(())
}

/// ファイルを削除 (存在しない場合はエラーにしない)
#[tauri::command]
pub async fn remove_file(path: String) -> Result<()> {
    match std::fs::remove_file(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Error::Core(format!("remove {path}: {e}"))),
    }
}

/// PDF のメタデータ（タイトル・作者・件名・キーワード等）を直接編集して上書き保存する。
/// metadata は [{ key: "Title", value: "..." }, ...] 形式の JSON 配列。
/// value が空文字列のフィールドは削除扱い。
/// pdf-kozou-core sidecar の "set_metadata" コマンド経由で処理する。
#[tauri::command]
pub async fn set_pdf_metadata(path: String, metadata: Value) -> Result<()> {
    let payload = serde_json::json!({
        "path": path,
        "metadata": metadata,
    });
    call_core_json("set_metadata", payload).await?;
    Ok(())
}

/// 画像ファイル（JPEG/PNG/SVG）のメタデータを読み込む
#[tauri::command]
pub async fn get_image_metadata(path: String) -> Result<Value> {
    let payload = serde_json::json!({ "path": path });
    call_core_json("get_image_metadata", payload).await
}

/// 画像ファイル（JPEG/PNG/SVG）のメタデータを上書き保存する
#[tauri::command]
pub async fn set_image_metadata(path: String, metadata: Value) -> Result<()> {
    let payload = serde_json::json!({
        "path": path,
        "metadata": metadata,
    });
    call_core_json("set_image_metadata", payload).await?;
    Ok(())
}
