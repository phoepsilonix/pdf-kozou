// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/hooks/useFocusAnnouncer.ts
//
// アプリ全体のフォーカス読み上げ（ボイスガイダンス）。
// document の focusin を1か所で監視し、TTS 有効時にフォーカスが当たった
// 要素のアクセシブル名＋種別（ボタン／入力欄／選択リスト／チェック等）を
// 読み上げる。これにより、Tab 等でフォーカスを移動したときに「今どこに
// いるか」が分かるようにする。各コンポーネントに個別実装を足さなくても、
// 既存の aria-label やボタン文言を利用して全ページで一律に機能する。
//
// 使い方: App など最上位で一度だけ useFocusAnnouncer() を呼ぶ。

import { useEffect } from "react";
import { tts } from "../lib/tts";
import { useI18n } from "../lib/i18n";

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 要素のアクセシブル名（aria-label > テキスト > title > placeholder） */
function accName(el: HTMLElement): string {
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return collapse(aria);
  const text = collapse(el.textContent || "");
  if (text) return text.length > 80 ? text.slice(0, 80) + "…" : text;
  const title = el.getAttribute("title");
  if (title && title.trim()) return collapse(title);
  const ph = (el as HTMLInputElement).placeholder;
  if (ph && ph.trim()) return collapse(ph);
  return "";
}

type TFn = (key: string, vars?: Record<string, string>) => string;

/** フォーカス要素を説明する読み上げ文を組み立てる（対象外なら空文字） */
function describe(el: HTMLElement, t: TFn): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role");
  const name = accName(el);

  if (
    tag === "button" ||
    role === "button" ||
    role === "tab" ||
    role === "radio" ||
    role === "option"
  ) {
    // トグル/選択状態（aria-pressed / aria-selected / aria-checked）があれば反映
    const state =
      el.getAttribute("aria-pressed") ??
      el.getAttribute("aria-selected") ??
      el.getAttribute("aria-checked");
    if (state === "true") return t("voice.option_selected", { name });
    if (state === "false") return t("voice.option_unselected", { name });
    return name ? t("voice.button", { name }) : t("voice.button_unnamed");
  }
  if (tag === "a") return name ? t("voice.link", { name }) : "";
  if (tag === "select") {
    const sel = el as HTMLSelectElement;
    const val = collapse(sel.options[sel.selectedIndex]?.text ?? sel.value ?? "");
    return t("voice.select", { name, value: val });
  }
  if (tag === "input" || tag === "textarea") {
    const inp = el as HTMLInputElement;
    const type = (inp.type || "text").toLowerCase();
    if (type === "checkbox")
      return t(inp.checked ? "voice.checkbox_on" : "voice.checkbox_off", { name });
    if (type === "radio") return t(inp.checked ? "voice.radio_on" : "voice.radio_off", { name });
    if (type === "range") return t("voice.slider", { name, value: inp.value });
    if (type === "button" || type === "submit")
      return name ? t("voice.button", { name }) : t("voice.button_unnamed");
    return t("voice.input", { name, value: collapse(inp.value || "") });
  }
  // role ベースのウィジェット
  if (role === "checkbox")
    return t(
      el.getAttribute("aria-checked") === "true" ? "voice.checkbox_on" : "voice.checkbox_off",
      {
        name,
      },
    );
  if (role === "link") return name ? t("voice.link", { name }) : "";
  // それ以外は、明示的な名前と（role かフォーカス可能 tabindex）がある場合のみ名前を読む
  if (name && (role || (el.tabIndex !== undefined && el.tabIndex >= 0))) return name;
  return "";
}

/** 値変更時の読み上げ文（input/select/textarea のみ。対象外は空文字） */
function describeChange(el: HTMLElement, t: TFn): string {
  const tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "select" && tag !== "textarea") return "";
  const name = accName(el);
  if (tag === "select") {
    const sel = el as HTMLSelectElement;
    const val = collapse(sel.options[sel.selectedIndex]?.text ?? sel.value ?? "");
    return t("voice.changed", { name, value: val });
  }
  const inp = el as HTMLInputElement;
  const type = (inp.type || "text").toLowerCase();
  if (type === "checkbox")
    return t(inp.checked ? "voice.checkbox_changed_on" : "voice.checkbox_changed_off", { name });
  if (type === "radio") return inp.checked ? t("voice.radio_selected", { name }) : "";
  if (type === "button" || type === "submit") return "";
  return t("voice.changed", { name, value: collapse(inp.value || "") });
}

export function useFocusAnnouncer() {
  const { t } = useI18n();
  useEffect(() => {
    // フォーカス移動時: 対象を読み上げ（現在値も含む）
    const onFocus = (e: FocusEvent) => {
      if (!tts.enabled) return;
      const el = e.target as HTMLElement | null;
      if (!el || el === document.body || el.nodeType !== 1) return;
      const msg = describe(el, t);
      if (msg) tts.speak(msg, true);
    };
    // 値変更時: 「〇〇を□□に変更しました」と現在値を読み上げ
    const onChange = (e: Event) => {
      if (!tts.enabled) return;
      const el = e.target as HTMLElement | null;
      if (!el || el.nodeType !== 1) return;
      const msg = describeChange(el, t);
      if (msg) tts.speak(msg, true);
    };
    document.addEventListener("focusin", onFocus);
    document.addEventListener("change", onChange);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("change", onChange);
    };
  }, [t]);
}
