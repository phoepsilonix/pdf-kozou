// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/commands/core.rs
//
// pdf-kozou-core sidecar を呼び出す Tauri コマンド群
// 全処理は pdf-kozou-core に委譲し、JSON レスポンスをそのまま返す

use crate::error::{Error, Result};
use crate::CORE_BIN_PATH;
use serde_json::Value;

/// pdf-kozou-core バイナリを呼び出して JSON レスポンスを返す
async fn call_core(args: Vec<String>) -> Result<Value> {
    let core_path = core_bin_path();

    let child = tokio::process::Command::new(&core_path)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| Error::Core(format!("failed to spawn core: {e}")))?;

    // タイムアウト: 120秒（DOCX変換等の重い処理を考慮）
    // wait_with_output は self を consume するため、timeout 後の kill は
    // Command::kill_on_drop(true) で対応する
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        child.wait_with_output(),
    )
    .await;

    match output {
        Err(_) => {
            // タイムアウト — kill_on_drop により子プロセスは自動終了する
            Err(Error::Core("core process timed out (120s)".into()))
        }
        Ok(Err(e)) => Err(Error::Core(format!("core process error: {e}"))),
        Ok(Ok(out)) => {
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                return Err(Error::Core(format!("core exited with error: {stderr}")));
            }
            let stdout = String::from_utf8_lossy(&out.stdout);
            serde_json::from_str(stdout.trim())
                .map_err(|e| Error::Core(format!("JSON parse error: {e}\nraw: {stdout}")))
        }
    }
}

/// pdf-kozou-core バイナリのパスを解決
fn core_bin_path() -> std::path::PathBuf {
    // グローバル変数から取り出す。もし未設定ならデフォルトを返す
    CORE_BIN_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| std::path::PathBuf::from("pdf-kozou-core"))
}

// ── Tauri コマンド ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_pdf_info(
    path: String,
    layout_w: Option<f32>,
    layout_h: Option<f32>,
    layout_em: Option<f32>,
) -> Result<Value> {
    // 非 PDF は --convert でレイアウト指定付き変換→info
    // PDF は --convert なしで高速取得
    // どちらも同じ CLI args 経由で統一
    let is_pdf = path.to_lowercase().ends_with(".pdf");
    if is_pdf {
        call_core(vec!["info".into(), path]).await
    } else {
        let mut args = vec!["info".into(), path, "--convert".into()];
        if let Some(w) = layout_w {
            args.push("--layout-w".into());
            args.push(w.to_string());
        }
        if let Some(h) = layout_h {
            args.push("--layout-h".into());
            args.push(h.to_string());
        }
        if let Some(em) = layout_em {
            args.push("--layout-em".into());
            args.push(em.to_string());
        }
        call_core(args).await
    }
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
    let page_1based = page + 1;
    let mut args = vec![
        "render".into(),
        path,
        "--page".into(),
        page_1based.to_string(),
        "--dpi".into(),
        dpi.to_string(),
        "--format".into(),
        format.unwrap_or_else(|| "jpeg".into()),
        "--quality".into(),
        quality.unwrap_or(85).to_string(),
    ];
    if let Some(w) = layout_w {
        args.push("--layout-w".into());
        args.push(w.to_string());
    }
    if let Some(h) = layout_h {
        args.push("--layout-h".into());
        args.push(h.to_string());
    }
    if let Some(em) = layout_em {
        args.push("--layout-em".into());
        args.push(em.to_string());
    }
    call_core(args).await
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
/// 文字色と背景色のコントラスト比が contrast_threshold 以下の文字を検出
#[tauri::command]
pub async fn detect_low_contrast_text(
    path: String,
    page: i32,
    contrast_threshold: Option<f32>,
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
/// render CLI の `--out-dir` に渡すだけで全ページ一括変換される。
/// `pdf-kozou-core render <path> --out-dir <dir> [--dpi N] [--format jpeg|png]
///   [--quality N] [--name-prefix PREFIX]`
///
/// render --out-dir は処理が終わっても JSON を stdout に出さない (空)。
/// 代わりにページ数を先に info コマンドで取得し、コアが生成するファイル名
/// (`{prefix}_{0001..}.{ext}`) を Rust 側で組み立てて返す。
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
    let prefix = name_prefix.unwrap_or_else(|| "page".into());

    std::fs::create_dir_all(&out_dir).map_err(|e| Error::Core(format!("mkdir {out_dir}: {e}")))?;

    let mut args: Vec<String> = vec![
        "render".into(),
        path.clone(),
        "--out-dir".into(),
        out_dir.clone(),
        "--dpi".into(),
        dpi_val.to_string(),
        "--format".into(),
        fmt.clone(),
        "--name-prefix".into(),
        prefix.clone(),
    ];
    if let Some(ref pg) = pages {
        if !pg.is_empty() && pg != "all" {
            args.push("--page".into());
            args.push(pg.clone());
        }
    }
    if let Some(q) = quality {
        args.push("--quality".into());
        args.push(q.to_string());
    }
    if let Some(w) = layout_w {
        args.push("--layout-w".into());
        args.push(w.to_string());
    }
    if let Some(h) = layout_h {
        args.push("--layout-h".into());
        args.push(h.to_string());
    }
    if let Some(em) = layout_em {
        args.push("--layout-em".into());
        args.push(em.to_string());
    }

    let output = tokio::process::Command::new(core_bin_path())
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| Error::Core(format!("spawn: {e}")))?
        .wait_with_output()
        .await
        .map_err(|e| Error::Core(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(Error::Core(format!("render: {}", stderr.trim())));
    }

    /*
        // ④ 選択フォーマットの拡張子のみフィルタして返す
        let ext_filter: &[&str] = match fmt.as_str() {
            "png" => &[".png"],
            "svg" => &[".svg"],
            _ => &[".jpg", ".jpeg"],
        };
        let mut files: Vec<String> = std::fs::read_dir(&out_dir)
            .map_err(|e| Error::Core(format!("readdir {out_dir}: {e}")))?
            .filter_map(|e| e.ok())
            .map(|e| e.path().display().to_string())
            .filter(|p| {
                let pl = p.to_lowercase();
                ext_filter.iter().any(|ext| pl.ends_with(*ext))
            })
            .collect();
        files.sort();
    */
    let stdout = String::from_utf8_lossy(&output.stdout);
    let response: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| Error::Core(format!("JSON parse: {e}\nraw: {stdout}")))?;

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
    if let Some(parent) = std::path::Path::new(&out_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| Error::Core(format!("mkdir: {e}")))?;
        }
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
        Ok(p) => {
            p
        }
        Err(_) => {
            let p = std::path::PathBuf::from(&out_dir);
            p
        }
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

/// JSON モードで core を呼ぶ (stdin 経由)
async fn call_core_json(cmd: &str, mut payload: Value) -> Result<Value> {
    payload["cmd"] = serde_json::Value::String(cmd.to_string());
    let json_line = serde_json::to_string(&payload).map_err(|e| Error::Core(e.to_string()))?;

    let core_path = core_bin_path();

    let mut child = tokio::process::Command::new(&core_path)
        .arg("json")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| Error::Core(format!("failed to spawn core: {e}")))?;

    use tokio::io::AsyncWriteExt;
    eprintln!("{:?}", json_line);
    // stdin に JSON を書き込んだ後、明示的に drop して EOF を送る。
    // drop しないと run_json_mode の BufRead::lines() が EOF を待ち続けて
    // フリーズする（特に Windows で顕著）。
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(json_line.as_bytes())
            .await
            .map_err(|e| Error::Core(e.to_string()))?;
        stdin.write_all(b"\n").await.ok();
        stdin.flush().await.ok();
        // ここで stdin を drop → パイプの書き込み端が閉じられ EOF が伝わる
    } // stdin がスコープを抜けて drop される

    let timeout_result = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        child.wait_with_output(),
    )
    .await;

    let output = match timeout_result {
        Err(_) => {
            // タイムアウト — kill_on_drop により子プロセスは自動終了する
            return Err(Error::Core("core json process timed out (120s)".into()));
        }
        Ok(Err(e)) => return Err(Error::Core(e.to_string())),
        Ok(Ok(out)) => out,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        return Err(Error::Core(format!(
            "core error (exit {}): {}\n{}",
            output.status.code().unwrap_or(-1),
            stderr.trim(),
            stdout.trim(),
        )));
    }

    if stdout.trim().is_empty() {
        return Err(Error::Core(format!(
            "core returned empty output. stderr: {}",
            stderr.trim()
        )));
    }

    serde_json::from_str(stdout.trim())
        .map_err(|e| Error::Core(format!("JSON parse: {e}\nraw: {stdout}")))
}

/// 一時ファイルパスを返す (pdf-kozou temp dir + name)
#[tauri::command]
pub async fn get_temp_path(name: String) -> Result<String> {
    let path = crate::tempdir::kozou_temp_path(&name);
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
