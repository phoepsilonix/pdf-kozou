// src-tauri/src/commands/core.rs
//
// pdf-kozou-core sidecar を呼び出す Tauri コマンド群
// 全処理は pdf-kozou-core に委譲し、JSON レスポンスをそのまま返す

use serde_json::Value;
use crate::error::{Error, Result};

/// pdf-kozou-core バイナリを呼び出して JSON レスポンスを返す
async fn call_core(args: Vec<String>) -> Result<Value> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri::Manager;

    // sidecar は tauri.conf.json の externalBin に登録された名前で呼ぶ
    // 開発時は同じ workspace の cargo build 成果物を使う
    let core_path = core_bin_path();

    let mut child = tokio::process::Command::new(&core_path)
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
    let mut args = vec![
        "render".into(), path,
        "--page".into(),   page.to_string(),
        "--dpi".into(),    dpi.to_string(),
        "--format".into(), format.unwrap_or_else(|| "jpeg".into()),
        "--quality".into(), quality.unwrap_or(85).to_string(),
    ];
    call_core(args).await
}

#[tauri::command]
pub async fn trim_pdf(request: Value) -> Result<Value> {
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
    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(json_line.as_bytes()).await
            .map_err(|e| Error::Core(e.to_string()))?;
        stdin.write_all(b"\n").await.ok();
    }

    let output = child.wait_with_output().await
        .map_err(|e| Error::Core(e.to_string()))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim())
        .map_err(|e| Error::Core(format!("JSON parse: {e}")))
}
