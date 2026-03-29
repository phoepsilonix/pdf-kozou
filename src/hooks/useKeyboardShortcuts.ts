// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/hooks/useKeyboardShortcuts.ts
//
// キーボードショートカット管理フック。
//
// 使い方:
//   useKeyboardShortcuts({
//     "Ctrl+O":     () => handleOpenFile(),
//     "Ctrl+Enter": () => handleExecute(),
//     "Escape":     () => handleBack(),
//     "Alt+H":      () => handleHome(),
//     "Alt+T":      () => tts.toggle(),   // 読み上げトグル（入力中でも有効）
//     "Alt+L":      () => cycleLocale(),  // 言語切り替え（入力中でも有効）
//     "F1":         () => announceKey("shortcut.tool"),
//   });

import { useEffect } from "react";

export type ShortcutMap = Record<string, (() => void) | undefined>;

/** キーイベントから "Ctrl+O" 形式の文字列を生成 */
function normalizeKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");

  const key = e.key;
  if (key === "Enter") parts.push("Enter");
  else if (key === "Escape") parts.push("Escape");
  else if (key === "Tab") parts.push("Tab");
  else if (key === "ArrowLeft") parts.push("ArrowLeft");
  else if (key === "ArrowRight") parts.push("ArrowRight");
  else if (key === "ArrowUp") parts.push("ArrowUp");
  else if (key === "ArrowDown") parts.push("ArrowDown");
  else if (key.match(/^F\d+$/))
    parts.push(key); // F1-F12
  else if (key.length === 1) parts.push(key.toUpperCase());
  else parts.push(key);

  return parts.join("+");
}

// テキスト入力中でも常に通すキー
// Alt+T (読み上げ ON/OFF) と Alt+L (言語切り替え) は
// 目の不自由な方がどの状況でも操作できるよう常に有効にする
const ALWAYS_PASS = new Set(["Escape", "F1", "Alt+T", "Alt+L", "Alt+H"]);

export function useKeyboardShortcuts(
  shortcuts: ShortcutMap,
  /** テキスト入力中はショートカットを無効にするか (デフォルト: true) */
  disableInInput = true,
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const key = normalizeKey(e);

      if (disableInInput) {
        const tag = (e.target as HTMLElement)?.tagName;
        const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
        // 入力中でも ALWAYS_PASS のキーは通す
        if (isInput && !ALWAYS_PASS.has(key)) return;
      }

      const action = shortcuts[key];
      if (action) {
        e.preventDefault();
        action();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcuts, disableInInput]);
}
