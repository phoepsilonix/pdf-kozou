// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/lastTool.ts
//
// ユーザーが最後に使った機能(ツール)を localStorage に永続化する。
// ファイル追加後、ホーム画面のツール選択ボタンへ自動でフォーカスを移すために使う
// （「about」はツールとして数えない）。

const STORAGE_KEY = "pdf-kozou-last-tool";

const VALID_TOOL_IDS = [
  "split",
  "merge",
  "trim",
  "rotate",
  "compress",
  "image",
  "booklet",
  "hidden",
  "viewer",
] as const;

export type LastToolId = (typeof VALID_TOOL_IDS)[number];

export function loadLastTool(): LastToolId | null {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s && (VALID_TOOL_IDS as readonly string[]).includes(s)) return s as LastToolId;
  } catch {}
  return null;
}

export function saveLastTool(id: string) {
  if (!(VALID_TOOL_IDS as readonly string[]).includes(id)) return; // "about" 等は保存しない
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {}
}
