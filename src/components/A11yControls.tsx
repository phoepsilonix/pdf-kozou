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

import { useState, useEffect, useCallback } from "react";
import { tts } from "../lib/tts";
import { useI18n, SUPPORTED_LOCALES, LOCALE_LABELS } from "../lib/i18n";
import type { Locale } from "../lib/i18n";
import { F } from "../lib/theme";

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
    background: enabled ? "var(--c-accentBg)" : "transparent",
    border: `1px solid ${enabled ? "var(--c-accent)" : "var(--c-borderHi)"}`,
    borderRadius: 7,
    color: enabled ? "var(--c-accent)" : "var(--c-textSub)",
    cursor: "pointer",
    fontFamily: F,
    fontSize: 12,
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
        opacity: isSupported ? 1 : 0.4,
        cursor: isSupported ? "pointer" : "not-allowed",
      }}
      title={
        !isSupported
          ? "このブラウザ/環境では音声読み上げに対応していません"
          : `${enabled ? t("tts.disabled_hint") : t("tts.enabled_hint")} (Alt+T)`
      }
      aria-label={
        !isSupported
          ? "音声読み上げ非対応環境"
          : enabled
            ? `${t("tts.label")} オン。Alt+Tでオフにできます`
            : `${t("tts.label")} オフ。Alt+Tでオンにできます`
      }
      aria-pressed={enabled}
      aria-disabled={!isSupported}
    >
      <span style={{ fontSize: 14 }}>{enabled ? "🔊" : "🔇"}</span>
      <span>{t("tts.label")}</span>
    </button>
  );
}

// ── 言語切り替えセレクター ────────────────────────────────────────────────────
// select 要素を使うことでキーボード操作・スクリーンリーダーが確実に動く

export function LocaleSelector() {
  const { locale, setLocale } = useI18n();

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setLocale(e.target.value as Locale);
      // 変更後の言語で読み上げ
      setTimeout(() => {
        const next = e.target.value as Locale;
        const msg = next === "ja" ? "言語を日本語に変更しました" : "Language changed to English";
        tts.speak(msg);
      }, 50);
    },
    [setLocale],
  );

  const selectStyle: React.CSSProperties = {
    padding: "4px 8px",
    background: "transparent",
    border: "1px solid var(--c-borderHi)",
    borderRadius: 7,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontFamily: F,
    fontSize: 12,
    flexShrink: 0,
  };

  return (
    <select
      value={locale}
      onChange={handleChange}
      style={selectStyle}
      aria-label="表示言語を選択 (Alt+L)"
      title="言語切り替え (Alt+L)"
    >
      {SUPPORTED_LOCALES.map((loc) => (
        <option key={loc} value={loc}>
          {LOCALE_LABELS[loc]}
        </option>
      ))}
    </select>
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
