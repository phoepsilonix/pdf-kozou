// src-tauri/src/commands/core.rs
//
// pdf-kozou-core sidecar を呼び出す Tauri コマンド群
// 全処理は pdf-kozou-core に委譲し、JSON レスポンスをそのまま返す

use serde_json::Value;
use crate::error::{Error, Result};

/// pdf-kozou-core バイナリを呼び出して JSON レスポンスを返す
async fn call_core(args: Vec<String>) -> Result<Value> {
    
    

    // sidecar は tauri.conf.json の externalBin に登録された名前で呼ぶ
    // 開発時は同じ workspace の cargo build 成果物を使う
    let core_path = core_bin_path();

    let child = tokio::process::Command::new(&core_path)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| Error::Core(format!("failed to spawn core: {e}")))?;

    let output = child.wait_with_output().await
        .map_err(|e| Error::Core(format!("core process error: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(Error::Core(format!("core exited with error: {stderr}")));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim())
        .map_err(|e| Error::Core(format!("JSON parse error: {e}\nraw: {stdout}")))
}

/// pdf-kozou-core バイナリのパスを解決
fn core_bin_path() -> std::path::PathBuf {
    // 1. 環境変数 PDF_KOZOU_CORE で上書き可能 (開発・テスト用)
    if let Ok(p) = std::env::var("PDF_KOZOU_CORE") {
        return p.into();
    }
    // 2. 自身の実行ファイルと同じディレクトリを探す (同梱 sidecar)
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.parent().unwrap_or(std::path::Path::new("."))
            .join(if cfg!(target_os = "windows") {
                "pdf-kozou-core.exe"
            } else {
                "pdf-kozou-core"
            });
        if sibling.exists() {
            return sibling;
        }
    }
    // 3. PATH から探す (fallback)
    std::path::PathBuf::from("pdf-kozou-core")
}

// ── Tauri コマンド ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_pdf_info(path: String) -> Result<Value> {
    call_core(vec!["info".into(), path]).await
}

#[tauri::command]
pub async fn render_page(
    path:    String,
    page:    i32,
    dpi:     u32,
    format:  Option<String>,
    quality: Option<u8>,
) -> Result<Value> {
    // --page は 1始まり、page 引数は 0始まりなので +1 する
    let page_1based = page + 1;
    let args = vec![
        "render".into(), path,
        "--page".into(),    page_1based.to_string(),
        "--dpi".into(),     dpi.to_string(),
        "--format".into(),  format.unwrap_or_else(|| "jpeg".into()),
        "--quality".into(),  quality.unwrap_or(85).to_string(),
    ];
    call_core(args).await
}

#[tauri::command]
pub async fn trim_pdf(request: Value) -> Result<Value> {
    // request に page_selection と extract_spec を追加で受け取る
    // 例: {
    //   "input": "/path/to/input.pdf",
    //   "output": "/path/to/output.pdf",
    //   "margins": { "left": 10.0, "right": 10.0, "top": 10.0, "bottom": 10.0 },
    //   トリミング適用ページ(オプション、省略時全ページ)
    //   "pages": { "type": "Ranges", "ranges": [[1,3], [5,5]] },
    //   "exclude": "1-10,12"   // トリミング除外ページ（オプション）
    //   "extract": "1-10,12"   // 出力に残すページ（オプション）
    // }
    call_core_json("trim", request).await
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
    path:        String,
    out_dir:     String,
    format:      Option<String>,
    dpi:         Option<u32>,
    quality:     Option<u8>,
    name_prefix: Option<String>,
    pages:       Option<String>,  // ページ指定 "1-3,5,7-" etc.
) -> Result<Value> {
    use serde_json::json;

    let fmt     = format.unwrap_or_else(|| "jpeg".into());
    let dpi_val = dpi.unwrap_or(150);
    let prefix  = name_prefix.unwrap_or_else(|| "page".into());

    // ② 出力先ディレクトリを作成
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| Error::Core(format!("mkdir {out_dir}: {e}")))?;

    // ③ render --out-dir で一括変換 (pages 指定があれば --page で渡す)
    let mut args: Vec<String> = vec![
        "render".into(),
        path.clone(),
        "--out-dir".into(),     out_dir.clone(),
        "--dpi".into(),         dpi_val.to_string(),
        "--format".into(),      fmt.clone(),
        "--name-prefix".into(), prefix.clone(),
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

    let output = tokio::process::Command::new(core_bin_path())
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| Error::Core(format!("spawn: {e}")))?
        .wait_with_output().await
        .map_err(|e| Error::Core(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(Error::Core(format!("render: {}", stderr.trim())));
    }

    // ④ 選択フォーマットの拡張子のみフィルタして返す
    let ext_filter: &[&str] = match fmt.as_str() {
        "png"  => &[".png"],
        "svg"  => &[".svg"],
        _      => &[".jpg", ".jpeg"],
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

    Ok(json!({ "ok": true, "files": files }))
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
        .or_else(|| dirs::home_dir())
        .unwrap_or_else(std::env::temp_dir);

    Ok(path.display().to_string())
}

#[tauri::command]
pub async fn get_tmp_path(filename: String) -> Result<String> {
    let mut path = std::env::temp_dir();
    path.push(filename);
    Ok(path.display().to_string())
}

/// ファイルのメタ情報（サイズ）を返す
#[tauri::command]
pub async fn get_file_stat(path: String) -> Result<Value> {
    use serde_json::json;
    let meta = std::fs::metadata(&path)
        .map_err(|e| Error::Core(format!("stat {path}: {e}")))?;
    Ok(json!({ "size": meta.len() }))
}
/// JSON モードで core を呼ぶ (stdin 経由)
async fn call_core_json(cmd: &str, mut payload: Value) -> Result<Value> {
    payload["cmd"] = serde_json::Value::String(cmd.to_string());
    let json_line = serde_json::to_string(&payload)
        .map_err(|e| Error::Core(e.to_string()))?;

    let core_path = core_bin_path();

    let mut child = tokio::process::Command::new(&core_path)
        .arg("json")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| Error::Core(format!("failed to spawn core: {e}")))?;

    use tokio::io::AsyncWriteExt;
    eprintln!("{:?}", json_line);
    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(json_line.as_bytes()).await
            .map_err(|e| Error::Core(e.to_string()))?;
        stdin.write_all(b"\n").await.ok();
    }

    let output = child.wait_with_output().await
        .map_err(|e| Error::Core(e.to_string()))?;

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
            "core returned empty output. stderr: {}", stderr.trim()
        )));
    }

    serde_json::from_str(stdout.trim())
        .map_err(|e| Error::Core(format!("JSON parse: {e}\nraw: {stdout}")))
}


/// 一時ファイルパスを返す (OS の temp dir + name)
#[tauri::command]
pub async fn get_temp_path(name: String) -> Result<String> {
    let dir = std::env::temp_dir();
    Ok(dir.join(&name).display().to_string())
}

/// ファイルを移動 (rename → 失敗なら copy + delete)
#[tauri::command]
pub async fn move_file(src: String, dst: String) -> Result<()> {
    if let Ok(_) = std::fs::rename(&src, &dst) {
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
