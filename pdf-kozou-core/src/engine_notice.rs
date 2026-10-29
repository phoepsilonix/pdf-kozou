// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/engine_notice.rs
//
// 描画エンジン "auto" (hayro を試し、失敗・未対応なら MuPDF) で、MuPDF へ
// フォールバックしたことを GUI へ伝えるための通知。
//
// これまでは stderr (eprintln!) にしか出ていなかったため、GUI からはフォール
// バックしたかどうかが分からなかった。core は Tauri に依存しないので、通知は
// フック (set_hook) 経由で渡し、src-tauri 側が Tauri のイベントに変換する。

use std::sync::OnceLock;

/// hayro から MuPDF へのフォールバック 1 件分
#[derive(Debug, Clone)]
pub struct EngineFallback {
    /// 処理の種類: "render" / "rasterize" / "rasterize_no_text" / "keep-text" /
    /// "imposition" / "rasterize_imposition"
    pub op: &'static str,
    /// 入力 PDF のパス (分かるとき)
    pub file: Option<String>,
    /// 0 始まりのページ番号 (ページ単位の処理で分かるとき)
    pub page: Option<i32>,
    /// hayro が失敗・未対応とした理由
    pub reason: String,
}

type Hook = Box<dyn Fn(&EngineFallback) + Send + Sync>;

static HOOK: OnceLock<Hook> = OnceLock::new();

/// 通知の受け口を登録する (プロセスで 1 回だけ。2 回目以降は false を返して無視)。
pub fn set_hook(hook: impl Fn(&EngineFallback) + Send + Sync + 'static) -> bool {
    HOOK.set(Box::new(hook)).is_ok()
}

/// stderr に出すログ行 (従来の書式を維持する)
pub fn log_line(f: &EngineFallback) -> String {
    let page = match f.page {
        Some(p) => format!(" (page={p})"),
        None => String::new(),
    };
    format!(
        "[render] engine=hayro {} failed, falling back to mupdf: {}{}",
        f.op, f.reason, page
    )
}

/// フォールバックしたことを記録する。stderr へ出し、フックが登録されていれば通知する。
pub fn report_fallback(op: &'static str, file: Option<&str>, page: Option<i32>, reason: &str) {
    let f = EngineFallback {
        op,
        file: file.map(str::to_string),
        page,
        reason: reason.to_string(),
    };
    eprintln!("{}", log_line(&f));
    if let Some(hook) = HOOK.get() {
        hook(&f);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_line_keeps_the_existing_format() {
        let f = EngineFallback {
            op: "rasterize",
            file: None,
            page: None,
            reason: "unsupported feature: knockout group".into(),
        };
        assert_eq!(
            log_line(&f),
            "[render] engine=hayro rasterize failed, falling back to mupdf: \
             unsupported feature: knockout group"
        );
        let f = EngineFallback { op: "render", page: Some(3), ..f };
        assert!(log_line(&f).ends_with(": unsupported feature: knockout group (page=3)"));
    }

    #[test]
    fn report_without_hook_does_not_panic() {
        report_fallback("keep-text", Some("a.pdf"), None, "test");
    }
}
