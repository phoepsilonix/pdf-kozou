// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/tts.ts
//
// Web Speech API (window.speechSynthesis) による読み上げ実装。
// 追加パッケージ不要。Windows/macOS/Linux (WebKit) 対応。
//
// 設計:
//   - ユーザーが明示的にオンにするまでデフォルト無効
//   - Alt+T ショートカットで ON/OFF トグル
//   - 前の読み上げを中断して新しい読み上げを優先
//   - 読み上げ中にエラーが起きても UI に影響しない

import { getCurrentLocale } from "./i18n";

const STORAGE_ENABLED_KEY = "pdf-kozou-tts-enabled";
const STORAGE_RATE_KEY = "pdf-kozou-tts-rate";
const STORAGE_PITCH_KEY = "pdf-kozou-tts-pitch";

// ON/OFF 変化をコンポーネントに通知するためのコールバック
type EnabledListener = (enabled: boolean) => void;

class TtsService {
  private _enabled: boolean;
  private _rate: number;
  private _pitch: number;
  private _supported: boolean;
  private _listeners: Set<EnabledListener> = new Set();

  constructor() {
    this._supported = typeof window !== "undefined" && "speechSynthesis" in window;
    const stored = localStorage.getItem(STORAGE_ENABLED_KEY);
    this._enabled = stored === "true"; // デフォルト無効
    this._rate = parseFloat(localStorage.getItem(STORAGE_RATE_KEY) ?? "1.0");
    this._pitch = parseFloat(localStorage.getItem(STORAGE_PITCH_KEY) ?? "1.0");
  }

  get supported(): boolean {
    return this._supported;
  }
  get enabled(): boolean {
    return this._enabled;
  }
  get rate(): number {
    return this._rate;
  }
  get pitch(): number {
    return this._pitch;
  }

  // ── enabled の変更を購読 ────────────────────────────────────────────────────
  // React の useState と連動させるために使う

  addEnabledListener(fn: EnabledListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private _notifyListeners(): void {
    this._listeners.forEach((fn) => fn(this._enabled));
  }

  // ── 設定変更 ─────────────────────────────────────────────────────────────────

  setEnabled(v: boolean): void {
    this._enabled = v;
    localStorage.setItem(STORAGE_ENABLED_KEY, String(v));
    this._notifyListeners();
  }

  /** ON/OFF をトグルして新しい状態を返す */
  toggle(): boolean {
    const next = !this._enabled;
    this.setEnabled(next);
    // トグル後の状態を即座に読み上げる（setEnabled 前にキャンセルしない）
    if (next && this._supported) {
      this.stop();
      const lang = getCurrentLocale() === "ja" ? "ja-JP" : "en-US";
      const msg =
        getCurrentLocale() === "ja" ? "読み上げをオンにしました" : "Text to speech enabled";
      const utt = new SpeechSynthesisUtterance(msg);
      utt.lang = lang;
      utt.rate = this._rate;
      utt.pitch = this._pitch;
      utt.onerror = () => {};
      try {
        window.speechSynthesis.speak(utt);
      } catch {
        /* ignore */
      }
    }
    return next;
  }

  setRate(v: number): void {
    this._rate = v;
    localStorage.setItem(STORAGE_RATE_KEY, String(v));
  }

  setPitch(v: number): void {
    this._pitch = v;
    localStorage.setItem(STORAGE_PITCH_KEY, String(v));
  }

  // ── 読み上げ ─────────────────────────────────────────────────────────────────

  /** テキストを読み上げる。enabled=false または未対応環境では何もしない */
  speak(text: string, interrupt = true): void {
    if (!this._supported || !this._enabled || !text.trim()) return;
    try {
      if (interrupt) window.speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance(text);
      utt.lang = getCurrentLocale() === "ja" ? "ja-JP" : "en-US";
      utt.rate = this._rate;
      utt.pitch = this._pitch;
      utt.onerror = () => {};
      window.speechSynthesis.speak(utt);
    } catch {
      /* ignore */
    }
  }

  /** 現在の読み上げを停止 */
  stop(): void {
    if (this._supported) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    }
  }
}

export const tts = new TtsService();
