// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/gid_fix.rs
// GID 補正のオン・オフ。
//
// 補正とは、文字コードが GID の CID キー付き CFF フォント (Canva の PDF の ◀ ★ など) を、charset を
// CID = GID の恒等表にして、charset で CID を引くビューワ (MuPDF・Firefox・モバイルのブラウザなど) でも
// 表示できるようにすること (font_gidfix_lopdf)。字形は変わらず、フォントの charset だけを直す。
//
// 補正は、lopdf・MuPDF のどちらのモードでも、同じ設定で動く:
//   - 読み込み (api::auto_convert_if_needed) で、直したフォントのある PDF は、直した一時コピーを入力にする
//   - ビューワー・画像化などの MuPDF の描画 (font_gidfix_lopdf::mupdf_input) も、直したコピーを描く
//   - lopdf の圧縮・キープテキストは、出力する文書のフォントを直す
//
// 設定の優先順位: set_enabled (GUI) → 環境変数 PDF_KOZOU_GID_FIX (on | off) → オン (既定)

use std::sync::atomic::{AtomicU8, Ordering};

/// GUI 等から設定するプロセス全体の指定 (0 = 未設定, 1 = オン, 2 = オフ)
static OVERRIDE: AtomicU8 = AtomicU8::new(0);

fn parse(v: &str) -> Option<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "on" | "1" | "true" | "yes" | "enable" | "enabled" => Some(true),
        "off" | "0" | "false" | "no" | "disable" | "disabled" => Some(false),
        _ => None,
    }
}

/// 補正を行うか (set_enabled → 環境変数 → オン)
pub fn enabled() -> bool {
    match OVERRIDE.load(Ordering::Relaxed) {
        1 => return true,
        2 => return false,
        _ => {}
    }
    if let Ok(v) = std::env::var("PDF_KOZOU_GID_FIX")
        && !v.trim().is_empty()
    {
        match parse(&v) {
            Some(b) => return b,
            None => eprintln!("[gid-fix] unknown PDF_KOZOU_GID_FIX={v:?} (use on|off); using on"),
        }
    }
    true
}

/// 現在の設定の名前 ("on" | "off")
pub fn current_name() -> &'static str {
    if enabled() { "on" } else { "off" }
}

/// プロセス全体の指定を設定する ("on" | "off" | "default" (未設定に戻す))。
/// 以降の読み込み・描画から反映される。
pub fn set_enabled(spec: &str) -> Result<(), String> {
    let v = spec.trim().to_ascii_lowercase();
    if v.is_empty() || v == "default" {
        OVERRIDE.store(0, Ordering::Relaxed);
        return Ok(());
    }
    match parse(&v) {
        Some(true) => OVERRIDE.store(1, Ordering::Relaxed),
        Some(false) => OVERRIDE.store(2, Ordering::Relaxed),
        None => {
            return Err(format!(
                "unknown gid-fix setting {spec:?} (use on|off|default)"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_values() {
        assert_eq!(parse("ON"), Some(true));
        assert_eq!(parse(" 0 "), Some(false));
        assert_eq!(parse("false"), Some(false));
        assert_eq!(parse("bogus"), None);
    }

    #[test]
    fn override_wins_and_resets() {
        assert!(set_enabled("bogus").is_err());
        set_enabled("off").unwrap();
        assert!(!enabled());
        assert_eq!(current_name(), "off");
        set_enabled("on").unwrap();
        assert!(enabled());
        set_enabled("default").unwrap();
        // 環境変数が無ければ、既定はオン (環境変数のあるテスト環境では、その値)
        let expect = std::env::var("PDF_KOZOU_GID_FIX")
            .ok()
            .and_then(|v| parse(&v))
            .unwrap_or(true);
        assert_eq!(enabled(), expect);
    }
}
