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
    /// "compress" / "compress_clean" / "compress_sanitize" / "compress_subset" / "redact_crop" / "rewrite" (from = "lopdf")、
    /// 画像の最適化を適用できなかった "image_opt_partial" / "image_opt_failed" (from = "lopdf"。
    /// MuPDF への切り替えではない。`is_image_opt`)
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

/// 画像の最適化 (DPI 指定・クロップ) の通知か。MuPDF への切り替えではない。
pub fn is_image_opt(op: &str) -> bool {
    op.starts_with("image_opt")
}

/// 画像の最適化を、一部の画像に適用できなかった
pub const OP_IMAGE_OPT_PARTIAL: &str = "image_opt_partial";
/// 画像の最適化を、PDF を処理できず適用できなかった
pub const OP_IMAGE_OPT_FAILED: &str = "image_opt_failed";

/// stderr に出すログ行 (従来の書式を維持する)
pub fn log_line(f: &EngineFallback) -> String {
    if is_image_opt(f.op) {
        let file = f.file.as_deref().map(|p| format!(" ({p})")).unwrap_or_default();
        return format!("[image-opt] {}: {}{}", f.op, f.reason, file);
    }
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

/// 画像の最適化 (DPI 指定・クロップ) を、すべて、または一部の画像に適用できなかったことを記録する。
/// この処理は lopdf だけで行っていて MuPDF の代替実装は無いため、MuPDF に切り替えるわけではない。
/// (stderr へ出し、フックが登録されていれば GUI へ通知する)
pub fn report_image_opt(op: &'static str, file: Option<&str>, reason: &str) {
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
    fn image_opt_log_line_does_not_claim_a_mupdf_switch() {
        let f = EngineFallback {
            from: "lopdf",
            op: OP_IMAGE_OPT_PARTIAL,
            file: Some("a.pdf".into()),
            page: None,
            reason: "3 image(s) left as is: content stream could not be parsed".into(),
        };
        let line = log_line(&f);
        assert_eq!(
            line,
            "[image-opt] image_opt_partial: 3 image(s) left as is: content stream could not be parsed (a.pdf)"
        );
        assert!(!line.contains("mupdf"));
        assert!(is_image_opt(OP_IMAGE_OPT_FAILED) && !is_image_opt("compress"));
    }

    #[test]
    fn report_without_hook_does_not_panic() {
        report_fallback("keep-text", Some("a.pdf"), None, "test");
        report_pdf_fallback("compress", Some("a.pdf"), "test");
        report_image_opt(OP_IMAGE_OPT_FAILED, Some("a.pdf"), "test");
    }
}
