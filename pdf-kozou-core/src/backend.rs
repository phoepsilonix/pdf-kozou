// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/backend.rs
// PDF 操作 (結合・分割・回転・トリミング・ページサイズ化・情報取得・メタデータ・面付け)
// の実装エンジンの選択。
//
// 各操作には lopdf 実装と従来の MuPDF 実装がある。既定では lopdf を先に試し、
// lopdf が扱えない入力のときだけ MuPDF にフォールバックする。
//
//   auto  : lopdf を試し、失敗したら MuPDF へフォールバック (既定)
//   mupdf : lopdf を使わず、従来の MuPDF 実装だけを使う
//   lopdf : lopdf だけを使う。失敗はフォールバックせずエラーにする
//           (MuPDF への依存がどの操作に残っているかを調べる検証用)
//
// 設定の優先順位: set_backend (GUI) → 環境変数 PDF_KOZOU_PDF_BACKEND → auto
// 描画 (ラスタライズ) エンジンの選択 (render::Engine) とは独立。

use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Auto,
    MuPdf,
    Lopdf,
}

impl Backend {
    fn parse(v: &str) -> Option<Self> {
        match v.trim().to_ascii_lowercase().as_str() {
            "auto" => Some(Backend::Auto),
            "mupdf" => Some(Backend::MuPdf),
            "lopdf" => Some(Backend::Lopdf),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Backend::Auto => "auto",
            Backend::MuPdf => "mupdf",
            Backend::Lopdf => "lopdf",
        }
    }

    fn code(self) -> u8 {
        match self {
            Backend::Auto => 1,
            Backend::MuPdf => 2,
            Backend::Lopdf => 3,
        }
    }

    fn from_code(c: u8) -> Option<Self> {
        match c {
            1 => Some(Backend::Auto),
            2 => Some(Backend::MuPdf),
            3 => Some(Backend::Lopdf),
            _ => None,
        }
    }
}

/// GUI 等から設定するプロセス全体の既定 (0 = 未設定)
static OVERRIDE: AtomicU8 = AtomicU8::new(0);

/// 現在のバックエンド (set_backend → 環境変数 → auto)
pub fn current() -> Backend {
    if let Some(b) = Backend::from_code(OVERRIDE.load(Ordering::Relaxed)) {
        return b;
    }
    if let Ok(v) = std::env::var("PDF_KOZOU_PDF_BACKEND")
        && !v.trim().is_empty()
    {
        match Backend::parse(&v) {
            Some(b) => return b,
            None => eprintln!(
                "[backend] unknown PDF_KOZOU_PDF_BACKEND={v:?} (use auto|mupdf|lopdf); using auto"
            ),
        }
    }
    Backend::Auto
}

/// プロセス全体のバックエンドを設定する。"auto" | "mupdf" | "lopdf"。
/// 空文字 / "default" で未設定に戻す (環境変数に従う)。不正な値は Err。
pub fn set_backend(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() || n.eq_ignore_ascii_case("default") {
        OVERRIDE.store(0, Ordering::Relaxed);
        return Ok(());
    }
    let b = Backend::parse(n).ok_or_else(|| format!("unknown backend: {name:?}"))?;
    OVERRIDE.store(b.code(), Ordering::Relaxed);
    Ok(())
}

pub fn current_name() -> &'static str {
    current().name()
}

/// lopdf 実装を試すか。mupdf 指定のときは false (その旨をログに出す)。
pub fn try_lopdf(op: &str) -> bool {
    if current() == Backend::MuPdf {
        eprintln!("[{op}] backend=mupdf: skipping lopdf");
        false
    } else {
        true
    }
}

/// lopdf 実装が失敗したときの扱い。戻り値 true = フォールバックせずエラーにする。
/// (false のときは「MuPDF へフォールバックする」ログを出す)
pub fn abort_on_lopdf_failure(op: &str, err: &dyn std::fmt::Display) -> bool {
    if current() == Backend::Lopdf {
        eprintln!("[{op}] lopdf path failed ({err}); MuPDF fallback disabled (backend=lopdf)");
        true
    } else {
        eprintln!("[{op}] lopdf path failed ({err}); falling back to MuPDF");
        false
    }
}

/// lopdf 実装がまだ無く MuPDF でしか処理できない操作 (圧縮など) の冒頭で呼ぶ。
/// - mupdf 指定: 明示的な選択なので通知しない
/// - auto / lopdf 指定: MuPDF で処理することを stderr と GUI (engine-fallback) へ通知する
///   (lopdf 指定でもまだ MuPDF にフォールバックするため、その旨を理由に付ける)
pub fn note_mupdf_only(op: &'static str, file: &str, reason: &str) {
    match current() {
        Backend::MuPdf => {}
        Backend::Auto => crate::engine_notice::report_pdf_fallback(op, Some(file), reason),
        Backend::Lopdf => crate::engine_notice::report_pdf_fallback(
            op,
            Some(file),
            &format!("{reason} (backend=lopdf, but MuPDF is still used)"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_override() {
        assert_eq!(Backend::parse(" LOPDF "), Some(Backend::Lopdf));
        assert_eq!(Backend::parse("x"), None);
        assert!(set_backend("bogus").is_err());
        set_backend("mupdf").unwrap();
        assert_eq!(current(), Backend::MuPdf);
        assert!(!try_lopdf("test"));
        set_backend("lopdf").unwrap();
        assert!(abort_on_lopdf_failure("test", &"boom"));
        set_backend("default").unwrap();
    }
}
