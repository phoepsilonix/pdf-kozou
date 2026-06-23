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

/**
 * フォーム部品（input/select/textarea）に紐づくラベル文字列を返す。
 * チェックボックスやラジオは要素自身に textContent が無いため、これが無いと
 * 「（無名）をオンにしました」のように何をオンにしたか分からなくなる。
 * 標準的な3経路（aria-labelledby ／ <label for> ／ 祖先の <label> でラップ）を
 * 順に調べる。いずれも純粋な DOM API なので WebKitGTK・WebView2(Blink) 双方で
 * 同じように動作する。見つからなければ空文字。
 */
function labelText(el: HTMLElement): string {
  // 1) aria-labelledby（複数 ID を空白区切りで参照）
  const lb = el.getAttribute("aria-labelledby");
  if (lb) {
    const txt = lb
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    const c = collapse(txt);
    if (c) return c;
  }
  // 2) <label for="id"> による関連付け
  const id = el.id;
  if (id) {
    const forLabel = document.querySelector<HTMLElement>(`label[for="${CSS.escape(id)}"]`);
    if (forLabel) {
      const c = collapse(forLabel.textContent || "");
      if (c) return c;
    }
  }
  // 3) 祖先の <label> でラップされている場合（このアプリの主パターン）。
  //    ラベル内に入力欄自身が含まれるので、複製してから input/select/textarea を
  //    取り除き、ラベル文言だけを取り出す（入力値の二重読みを防ぐ）。
  const wrap = el.closest("label");
  if (wrap) {
    const clone = wrap.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("input, select, textarea").forEach((n) => n.remove());
    const c = collapse(clone.textContent || "");
    if (c) return c;
  }
  return "";
}

/** 要素のアクセシブル名（aria-label > ラベル > テキスト > title > placeholder） */
function accName(el: HTMLElement): string {
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return collapse(aria);
  // フォーム部品は紐づくラベルから名前を得る（チェック/ラジオは自身に文言が無い）
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") {
    const lbl = labelText(el);
    if (lbl) return lbl.length > 80 ? lbl.slice(0, 80) + "…" : lbl;
  }
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
  // data-voice-skip が付いた要素（ステッパー等）はフォーカス時に読み上げない。
  // 値変更そのものは各操作箇所が明示的に読み上げるため、ボタン名の繰り返しは省く。
  if (el.closest("[data-voice-skip]")) return "";
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role");
  const name = accName(el);

  // role=checkbox は <button role="checkbox"> 等のカスタムチェックも含めてオン/オフで読む。
  // （button 判定より先に置く。後段の button 分岐に吸われると「選択中」になってしまう）
  if (role === "checkbox")
    return t(el.getAttribute("aria-checked") === "true" ? "voice.checkbox_on" : "voice.checkbox_off", {
      name,
    });

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
  if (role === "link") return name ? t("voice.link", { name }) : "";
  // それ以外は、明示的な名前と（role かフォーカス可能 tabindex）がある場合のみ名前を読む
  if (name && (role || (el.tabIndex !== undefined && el.tabIndex >= 0))) return name;
  return "";
}

/**
 * change イベント時の読み上げ文。
 * select / checkbox / radio のみを対象にする（これらはフォーカスを保ったまま
 * change が発火するため確実に読み上げできる）。テキスト・数値・スライダー等の
 * 連続入力は input イベント側（describeInput）で扱う。対象外は空文字。
 */
function describeChange(el: HTMLElement, t: TFn): string {
  const tag = el.tagName.toLowerCase();
  const name = accName(el);
  if (tag === "select") {
    const sel = el as HTMLSelectElement;
    const val = collapse(sel.options[sel.selectedIndex]?.text ?? sel.value ?? "");
    return t("voice.changed", { name, value: val });
  }
  if (tag !== "input") return "";
  const inp = el as HTMLInputElement;
  const type = (inp.type || "text").toLowerCase();
  if (type === "checkbox")
    return t(inp.checked ? "voice.checkbox_changed_on" : "voice.checkbox_changed_off", { name });
  if (type === "radio") return inp.checked ? t("voice.radio_selected", { name }) : "";
  // text / number / range / textarea などは input イベントで読み上げる
  return "";
}

/**
 * input イベント時の読み上げ文（テキスト・数値・スライダー等の連続入力）。
 * 入力中のフォーカス保持時に「〇〇 を □□ に変更しました」と現在値を読む。
 * チェック/ラジオ/ボタン系は change 側で扱うので空文字。
 */
function describeInput(el: HTMLElement, t: TFn): string {
  const tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea") return "";
  const inp = el as HTMLInputElement;
  const type = (inp.type || "text").toLowerCase();
  if (
    type === "checkbox" ||
    type === "radio" ||
    type === "button" ||
    type === "submit" ||
    type === "file"
  )
    return "";
  const name = accName(el);
  return t("voice.changed", { name, value: collapse(inp.value || "") });
}

/**
 * click イベント時の読み上げ文（選択系コントロールのみ）。
 * aria-pressed / aria-selected / aria-checked、または role が tab/radio/option/
 * checkbox の要素をクリックしたとき、更新後の状態で「〇〇 を選択しました」/
 * 「〇〇 未選択」と読む。通常のアクションボタン（マーカー無し）は空文字。
 */
function describeClick(el: HTMLElement, t: TFn): string {
  const role = el.getAttribute("role") || "";
  const hasState =
    el.hasAttribute("aria-pressed") ||
    el.hasAttribute("aria-selected") ||
    el.hasAttribute("aria-checked") ||
    role === "tab" ||
    role === "radio" ||
    role === "option" ||
    role === "checkbox";
  if (!hasState) return "";
  const name = accName(el);
  if (!name) return "";
  // role=checkbox は更新後の aria-checked でオン/オフを読む
  if (role === "checkbox") {
    const checked = el.getAttribute("aria-checked") === "true";
    return t(checked ? "voice.checkbox_changed_on" : "voice.checkbox_changed_off", { name });
  }
  const state =
    el.getAttribute("aria-pressed") ??
    el.getAttribute("aria-selected") ??
    el.getAttribute("aria-checked");
  if (state === "false") return t("voice.option_unselected", { name });
  return t("voice.selected", { name });
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
    // 値変更時（選択リスト・チェック・ラジオ）: 現在値を読み上げ
    const onChange = (e: Event) => {
      if (!tts.enabled) return;
      const el = e.target as HTMLElement | null;
      if (!el || el.nodeType !== 1) return;
      const msg = describeChange(el, t);
      if (msg) tts.speak(msg, true);
    };
    // テキスト・数値・スライダー等の連続入力: 入力が落ち着いてから現在値を読む
    let inputTimer: ReturnType<typeof setTimeout> | undefined;
    const onInput = (e: Event) => {
      if (!tts.enabled) return;
      const el = e.target as HTMLElement | null;
      if (!el || el.nodeType !== 1) return;
      if (el.tagName.toLowerCase() !== "input" && el.tagName.toLowerCase() !== "textarea") return;
      if (inputTimer) clearTimeout(inputTimer);
      inputTimer = setTimeout(() => {
        const msg = describeInput(el, t);
        if (msg) tts.speak(msg, true);
      }, 500);
    };
    // 選択系ボタン（aria-pressed/selected/checked, role=tab/radio/option）クリック:
    // React 更新後の状態で「〇〇 を選択しました」と読む。
    const onClick = (e: MouseEvent) => {
      if (!tts.enabled) return;
      const target = e.target as HTMLElement | null;
      if (!target || typeof target.closest !== "function") return;
      const el = target.closest<HTMLElement>(
        'button, [role="button"], [role="tab"], [role="radio"], [role="option"], [role="checkbox"]',
      );
      if (!el) return;
      // 状態更新が DOM に反映されてから読み上げる
      setTimeout(() => {
        const msg = describeClick(el, t);
        if (msg) tts.speak(msg, true);
      }, 0);
    };
    document.addEventListener("focusin", onFocus);
    document.addEventListener("change", onChange);
    document.addEventListener("input", onInput);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("change", onChange);
      document.removeEventListener("input", onInput);
      document.removeEventListener("click", onClick);
      if (inputTimer) clearTimeout(inputTimer);
    };
  }, [t]);
}
