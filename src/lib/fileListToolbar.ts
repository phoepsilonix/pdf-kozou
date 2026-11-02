// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/fileListToolbar.ts — ファイル一覧ツールバー(追加・並び替え等)の配置
//
// ホーム画面と結合画面のそれぞれで、ツールバーを一覧の上側(標準)か下側に置ける。
// 選択は画面ごとに localStorage へ永続化する(片方を下にしても、もう片方は動かない)。

import { useSyncExternalStore } from "react";

export type FileListToolbarPosition = "top" | "bottom";

export const FILE_LIST_TOOLBAR_DEFAULT: FileListToolbarPosition = "top";

function isPosition(v: unknown): v is FileListToolbarPosition {
  return v === "top" || v === "bottom";
}

function createToolbarPositionStore(storageKey: string) {
  function load(): FileListToolbarPosition {
    try {
      const s = localStorage.getItem(storageKey);
      if (isPosition(s)) return s;
    } catch {}
    return FILE_LIST_TOOLBAR_DEFAULT;
  }

  let current: FileListToolbarPosition = load();
  const listeners = new Set<() => void>();

  function set(pos: FileListToolbarPosition) {
    if (pos === current) return;
    current = pos;
    try {
      localStorage.setItem(storageKey, pos);
    } catch {}
    for (const l of listeners) l();
  }

  function subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }

  function get(): FileListToolbarPosition {
    return current;
  }

  function getServer(): FileListToolbarPosition {
    return FILE_LIST_TOOLBAR_DEFAULT;
  }

  return { set, subscribe, get, getServer };
}

const homeStore = createToolbarPositionStore("pdf-kozou-file-list-toolbar");
const mergeStore = createToolbarPositionStore("pdf-kozou-merge-list-toolbar");

export function setFileListToolbarPosition(pos: FileListToolbarPosition) {
  homeStore.set(pos);
}

export function useFileListToolbarPosition(): FileListToolbarPosition {
  return useSyncExternalStore(homeStore.subscribe, homeStore.get, homeStore.getServer);
}

export function setMergeListToolbarPosition(pos: FileListToolbarPosition) {
  mergeStore.set(pos);
}

export function useMergeListToolbarPosition(): FileListToolbarPosition {
  return useSyncExternalStore(mergeStore.subscribe, mergeStore.get, mergeStore.getServer);
}
