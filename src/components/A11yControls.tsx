// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/A11yControls.tsx
//
// 読み上げ ON/OFF トグルボタン + 言語切り替えセレクター。
// ThemeSwitcher の隣に配置することを想定。
//
// ショートカット:
//   Alt+T … 読み上げ ON/OFF トグル（目の不自由な方向けにグローバルで登録）
//   Alt+L … 言語切り替え
//
// 使い方:
//   <A11yControls />

import { useState, useEffect, useCallback, useRef } from "react";
import { tts } from "../lib/tts";
import { useI18n, SUPPORTED_LOCALES, LOCALE_LABELS } from "../lib/i18n";
import type { Locale } from "../lib/i18n";
import { F } from "../lib/theme";
import { FS } from "../lib/typography";
import { FloatingMenu } from "./FloatingMenu";

// ── 読み上げトグルボタン ──────────────────────────────────────────────────────

export function TtsToggleButton() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(tts.enabled);

  // tts の enabled 変化を購読（ショートカット経由の変化も反映）
  useEffect(() => {
    const unsub = tts.addEnabledListener(setEnabled);
    return unsub;
  }, []);

  const toggle = useCallback(() => {
    tts.toggle();
    // setEnabled は listener 経由で自動更新される
  }, []);

  // デバッグ: speechSynthesis の状態をコンソールに出力
  // Tauri WebKit で speechSynthesis が使えない場合はボタンをグレーアウト表示する
  const isSupported = tts.supported;

  const btnStyle: React.CSSProperties = {
    padding: "4px 10px",
    background: enabled ? "var(--c-bg)" : "var(--c-accentBg)",
    border: `1px solid ${enabled ? "var(--c-accent)" : "var(--c-borderHi)"}`,
    borderRadius: 7,
    color: enabled ? "var(--c-accent)" : "var(--c-textSub)",
    cursor: "pointer",
    fontFamily: F,
    fontSize: FS.small,
    display: "flex",
    alignItems: "center",
    gap: 4,
    transition: "all 0.12s",
    flexShrink: 0,
  };

  return (
    <button
      onClick={toggle}
      style={{
        ...btnStyle,
        opacity: isSupported ? 1 : 0.6,
        cursor: isSupported ? "pointer" : "not-allowed",
      }}
      title={
        !isSupported
          ? t("tts.not_supported_title")
          : `${enabled ? t("tts.disabled_hint") : t("tts.enabled_hint")} (Alt+T)`
      }
      aria-label={
        !isSupported
          ? t("tts.not_supported_aria")
          : enabled
            ? t("tts.on_aria", { label: t("tts.label") })
            : t("tts.off_aria", { label: t("tts.label") })
      }
      aria-pressed={enabled}
      aria-disabled={!isSupported}
    >
      <span style={{ fontSize: FS.label }}>{enabled ? "🔊" : "🔇"}</span>
      <span>{t("tts.label")}</span>
    </button>
  );
}

// ── 言語切り替えセレクター ────────────────────────────────────────────────────
// <select> は Linux WebKitGTK でネイティブスタイルが優先されテーマ連動しないため
// ThemeSwitcher と同じカスタムドロップダウン方式に変更

export function LocaleSelector() {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const handlePick = useCallback(
    (loc: Locale) => {
      setLocale(loc);
      setOpen(false);
      setTimeout(() => {
        const msg = loc === "ja" ? t("locale.changed_ja") : t("locale.changed_en");
        tts.speak(msg);
      }, 50);
    },
    [setLocale, t],
  );

  const btnStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 10px",
    background: "var(--c-bg)",
    border: "1px solid var(--c-borderHi)",
    borderRadius: 7,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontFamily: F,
    fontSize: FS.small,
    flexShrink: 0,
  };

  return (
    <>
      <button
        ref={anchorRef}
        onClick={() => setOpen((v) => !v)}
        style={btnStyle}
        aria-label={t("locale.select_aria")}
        title={t("locale.select_title")}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{LOCALE_LABELS[locale]}</span>
        <span style={{ fontSize: 10, color: "var(--c-textDim)" }}>▾</span>
      </button>

      <FloatingMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef}>
        <div role="listbox" style={{ minWidth: 110 }}>
          {SUPPORTED_LOCALES.map((loc) => (
            <button
              key={loc}
              role="option"
              aria-selected={loc === locale}
              onClick={() => handlePick(loc)}
              style={{
                display: "block",
                width: "100%",
                padding: "8px 14px",
                background: loc === locale ? "var(--c-accentBg)" : "transparent",
                border: "none",
                color: loc === locale ? "var(--c-accent)" : "var(--c-text)",
                fontWeight: loc === locale ? 700 : 400,
                cursor: "pointer",
                fontFamily: F,
                fontSize: FS.body,
                textAlign: "left" as const,
              }}
            >
              {LOCALE_LABELS[loc]}
            </button>
          ))}
        </div>
      </FloatingMenu>
    </>
  );
}

// ── まとめてレンダリング ──────────────────────────────────────────────────────

export function A11yControls() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <TtsToggleButton />
      <LocaleSelector />
    </div>
  );
}

// ── スクリーンリーダー専用の非表示 live region ───────────────────────────────

interface LiveRegionProps {
  message: string;
  politeness?: "polite" | "assertive";
}

/** 動的な状態変化をスクリーンリーダーに通知する非表示要素 */
export function LiveRegion({ message, politeness = "polite" }: LiveRegionProps) {
  return (
    <div
      role="status"
      aria-live={politeness}
      aria-atomic="true"
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        padding: 0,
        margin: -1,
        overflow: "hidden",
        clip: "rect(0, 0, 0, 0)",
        whiteSpace: "nowrap",
        border: 0,
      }}
    >
      {message}
    </div>
  );
}
