// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/i18n.ts
//
// 軽量 i18n 実装。外部ライブラリ不要。
// - ブラウザ/OS の言語設定を自動検出
// - localStorage でユーザー設定を永続化
// - {{variable}} 形式の変数展開に対応
// - React Context で言語切り替え時にリロード不要

import { createContext, type ReactNode, useCallback, useContext, useState } from "react";
import en from "../locales/en.json";
import ja from "../locales/ja.json";

export type Locale = "ja" | "en";
export const SUPPORTED_LOCALES: Locale[] = ["ja", "en"];
export const LOCALE_LABELS: Record<Locale, string> = {
  ja: "🇯🇵 日本語",
  en: "🇺🇸 English",
};

type TranslationDict = Record<string, unknown>;
const LOCALES: Record<Locale, TranslationDict> = { ja, en };
const STORAGE_KEY = "pdf-kozou-locale";

// ── ロケール検出 ──────────────────────────────────────────────────────────────

export function detectLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "ja" || stored === "en") return stored;
  const lang = navigator.language || "en";
  return lang.startsWith("ja") ? "ja" : "en";
}

// ── ネストしたキーへのアクセス ────────────────────────────────────────────────

function getNestedValue(obj: TranslationDict, keyPath: string): string | undefined {
  const keys = keyPath.split(".");
  let cur: unknown = obj;
  for (const key of keys) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : undefined;
}

// ── 変数展開 ─────────────────────────────────────────────────────────────────

function interpolate(tmpl: string, vars?: Record<string, string>): string {
  if (!vars) return tmpl;
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

// ── 翻訳関数（純粋関数） ──────────────────────────────────────────────────────

export function translate(locale: Locale, key: string, vars?: Record<string, string>): string {
  const val = getNestedValue(LOCALES[locale], key);
  if (val !== undefined) return interpolate(val, vars);
  // フォールバック: en
  if (locale !== "en") {
    const fb = getNestedValue(LOCALES.en, key);
    if (fb !== undefined) return interpolate(fb, vars);
  }
  return key; // キーをそのまま返す（開発時デバッグ用）
}

// ── React Context ─────────────────────────────────────────────────────────────

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: Record<string, string>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: "ja",
  setLocale: () => {},
  t: (key) => key,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    localStorage.setItem(STORAGE_KEY, next);
    // tts.ts のシングルトンにも同期
    syncLocaleToSingleton(next);
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string>) => translate(locale, key, vars),
    [locale],
  );

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

/** コンポーネント内で翻訳・言語切り替えを使うフック */
export function useI18n() {
  return useContext(I18nContext);
}

// ── tts.ts など React 外から現在ロケールを参照するためのシングルトン ────────────

let _currentLocale: Locale = detectLocale();

export function getCurrentLocale(): Locale {
  return _currentLocale;
}

export function syncLocaleToSingleton(locale: Locale): void {
  _currentLocale = locale;
}
