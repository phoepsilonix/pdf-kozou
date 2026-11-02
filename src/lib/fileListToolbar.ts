// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/fileListToolbar.ts — ホーム画面のファイル一覧ツールバー(追加・並び替え等)の配置
//
// ツールバーはファイル一覧の上側(標準)か下側に置ける。選択は localStorage に永続化する。

import { useSyncExternalStore } from "react";

export type FileListToolbarPosition = "top" | "bottom";

export const FILE_LIST_TOOLBAR_DEFAULT: FileListToolbarPosition = "top";

const STORAGE_KEY = "pdf-kozou-file-list-toolbar";

function isPosition(v: unknown): v is FileListToolbarPosition {
  return v === "top" || v === "bottom";
}

function load(): FileListToolbarPosition {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (isPosition(s)) return s;
  } catch {}
  return FILE_LIST_TOOLBAR_DEFAULT;
}

let current: FileListToolbarPosition = load();
const listeners = new Set<() => void>();

export function setFileListToolbarPosition(pos: FileListToolbarPosition) {
  if (pos === current) return;
  current = pos;
  try {
    localStorage.setItem(STORAGE_KEY, pos);
  } catch {}
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useFileListToolbarPosition(): FileListToolbarPosition {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => FILE_LIST_TOOLBAR_DEFAULT,
  );
}
