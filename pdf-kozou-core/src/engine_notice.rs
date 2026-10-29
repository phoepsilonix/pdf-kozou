// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/engine_notice.rs
//
// 描画エンジン "auto" (hayro を試し、失敗・未対応なら MuPDF) で、MuPDF へ
// フォールバックしたことを GUI へ伝えるための通知。
// PDF 操作のバックエンド (backend.rs) で lopdf 実装が無い・失敗したために MuPDF で
// 処理した場合 (圧縮など) も、from = "lopdf" として同じ経路で伝える。
//
// これまでは stderr (eprintln!) にしか出ていなかったため、GUI からはフォール
// バックしたかどうかが分からなかった。core は Tauri に依存しないので、通知は
// フック (set_hook) 経由で渡し、src-tauri 側が Tauri のイベントに変換する。

use std::sync::OnceLock;

/// hayro から MuPDF へのフォールバック 1 件分
#[derive(Debug, Clone)]
pub struct EngineFallback {
    /// どのエンジンから MuPDF へ切り替わったか: "hayro" (描画) / "lopdf" (PDF 操作)
    pub from: &'static str,
    /// 処理の種類: "render" / "rasterize" / "rasterize_no_text" / "keep-text" /
    /// "imposition" / "rasterize_imposition" (from = "hayro")、
    /// "compress" / "compress_subset" / "redact_crop" / "rewrite" (from = "lopdf")
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
    if f.from == "lopdf" {
        let file = f.file.as_deref().map(|p| format!(" ({p})")).unwrap_or_default();
        return format!(
            "[backend] {}: lopdf cannot handle this, using mupdf: {}{}",
            f.op, f.reason, file
        );
    }
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
    emit(EngineFallback {
        from: "hayro",
        op,
        file: file.map(str::to_string),
        page,
        reason: reason.to_string(),
    });
}

/// PDF 操作で lopdf 実装が無い・失敗したため MuPDF で処理したことを記録する。
/// (stderr へ出し、フックが登録されていれば GUI へ通知する)
pub fn report_pdf_fallback(op: &'static str, file: Option<&str>, reason: &str) {
    emit(EngineFallback {
        from: "lopdf",
        op,
        file: file.map(str::to_string),
        page: None,
        reason: reason.to_string(),
    });
}

fn emit(f: EngineFallback) {
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
            from: "hayro",
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
    fn lopdf_log_line() {
        let f = EngineFallback {
            from: "lopdf",
            op: "compress",
            file: Some("a.pdf".into()),
            page: None,
            reason: "not implemented".into(),
        };
        assert_eq!(
            log_line(&f),
            "[backend] compress: lopdf cannot handle this, using mupdf: not implemented (a.pdf)"
        );
    }

    #[test]
    fn report_without_hook_does_not_panic() {
        report_fallback("keep-text", Some("a.pdf"), None, "test");
        report_pdf_fallback("compress", Some("a.pdf"), "test");
    }
}
