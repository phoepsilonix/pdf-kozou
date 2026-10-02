// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/platform/ios_folder.rs
//
// iOS: 保存先フォルダ選択(UIDocumentPickerViewController)の呼び出し。
//
// 実体は Objective-C(ios/kozou_folder_picker.m の `kozou_ios_pick_folder`)で、
// build.rs が `cc` で Rust ライブラリへ一緒にコンパイル・リンクする。
// (Xcode のアプリターゲット側に置くと、cargo の cdylib リンク時にシンボルが
// 解決できずビルドが失敗する。)
// 選ばれたフォルダは security-scoped で、Objective-C 側がアクセス開始状態を
// 保持するため、返したパスには通常の std::fs でアクセスできる。

use std::ffi::{CStr, c_char, c_void};
use std::sync::mpsc;

unsafe extern "C" {
    fn kozou_ios_pick_folder(
        ctx: *mut c_void,
        callback: extern "C" fn(*mut c_void, i32, *const c_char),
    );
}

type Reply = (i32, String);

/// Objective-C 側から1回だけ呼ばれる。`ctx` は `pick_folder` が Box 化した Sender。
extern "C" fn on_result(ctx: *mut c_void, status: i32, json: *const c_char) {
    // SAFETY: ctx は pick_folder が Box::into_raw で渡したもので、ここで一度だけ回収する。
    let tx = unsafe { Box::from_raw(ctx as *mut mpsc::Sender<Reply>) };
    let text = if json.is_null() {
        String::new()
    } else {
        // SAFETY: Objective-C 側が呼び出し中のみ有効な NUL 終端文字列を渡す。即座にコピーする。
        unsafe { CStr::from_ptr(json) }
            .to_string_lossy()
            .into_owned()
    };
    let _ = tx.send((status, text));
}

pub struct PickedFolder {
    /// 選択フォルダの絶対パス
    pub path: String,
    /// 表示用のフォルダ名
    pub name: String,
}

/// フォルダ選択ピッカーを表示し、選ばれたフォルダを返す。キャンセル時は `Ok(None)`。
pub async fn pick_folder() -> Result<Option<PickedFolder>, String> {
    let (tx, rx) = mpsc::channel::<Reply>();
    let ctx = Box::into_raw(Box::new(tx)) as *mut c_void;
    // SAFETY: コールバックは1回だけ呼ばれ、ctx はそこで回収される。
    unsafe { kozou_ios_pick_folder(ctx, on_result) };

    let (status, json) = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| format!("フォルダ選択が中断されました: {e}"))?
        .map_err(|e| format!("フォルダ選択の結果を受け取れませんでした: {e}"))?;

    match status {
        0 => {
            let v: serde_json::Value = serde_json::from_str(&json)
                .map_err(|e| format!("フォルダ選択の結果を解析できません: {e}"))?;
            let path = v["path"].as_str().unwrap_or_default().to_string();
            if path.is_empty() {
                return Err("選択されたフォルダのパスが空です".to_string());
            }
            let name = v["name"].as_str().unwrap_or_default().to_string();
            Ok(Some(PickedFolder { path, name }))
        }
        1 => Ok(None),
        _ => {
            let msg = serde_json::from_str::<serde_json::Value>(&json)
                .ok()
                .and_then(|v| v["error"].as_str().map(str::to_string))
                .unwrap_or_else(|| "フォルダ選択に失敗しました".to_string());
            Err(msg)
        }
    }
}
