// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/fileDialogGuard.ts
//
// ファイル/フォルダ選択ダイアログ(ネイティブ)を開いている間の状態管理。
//
// ネイティブのダイアログはWebViewとは別ウィンドウで、環境(特にLinux/GTK)に
// よってはダイアログを開いたままメイン画面のメニュー・ボタン・ショートカットが
// 操作できてしまう。その結果、ダイアログの結果を待つ処理(ファイル追加や保存)が
// 走っている最中に別のツールへ遷移し、結果が意図しない画面に適用される恐れがある。
//
// そこで、ダイアログを開く処理は必ず withFileDialog() / invokeDialog() を通し、
// 開いている間は
//   - useInertWhileFileDialog() が #root を inert にして、クリック・フォーカスを止める
//   - useKeyboardShortcuts と画面遷移ハンドラが isFileDialogOpen() で早期 return する
// ようにする。ダイアログは複数が重なり得るため、真偽値ではなくカウンタで持つ。

import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { create } from "zustand";

interface FileDialogState {
  /** 現在開いているダイアログの数。0 なら開いていない。 */
  count: number;
}

export const useFileDialogStore = create<FileDialogState>(() => ({ count: 0 }));

/** Reactの外(ハンドラ内など)からでも使える。ダイアログを開いている間 true。 */
export function isFileDialogOpen(): boolean {
  return useFileDialogStore.getState().count > 0;
}

/** Reactコンポーネント内でダイアログの開閉を購読する。 */
export function useFileDialogOpen(): boolean {
  return useFileDialogStore((s) => s.count > 0);
}

/**
 * ダイアログを開く処理 fn を実行し、完了(成功・失敗・キャンセル)まで
 * 「ダイアログを開いている」状態にする。
 */
export async function withFileDialog<T>(fn: () => Promise<T>): Promise<T> {
  useFileDialogStore.setState((s) => ({ count: s.count + 1 }));
  try {
    return await fn();
  } finally {
    useFileDialogStore.setState((s) => ({ count: Math.max(0, s.count - 1) }));
  }
}

/** invoke() のダイアログ版。pick_* 系コマンドはこちらを使うこと。 */
export function invokeDialog<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return withFileDialog(() => invoke<T>(cmd, args));
}

/**
 * ダイアログを開いている間、アプリ全体(#root)を inert にする。
 * inert はポインタ操作・フォーカス・支援技術からの操作をまとめて止める。
 * App のトップレベルで1回だけ呼ぶ。
 */
export function useInertWhileFileDialog(): void {
  const open = useFileDialogOpen();
  useEffect(() => {
    if (!open) return;
    const root = document.getElementById("root");
    if (!root) return;
    root.inert = true;
    return () => {
      root.inert = false;
    };
  }, [open]);
}
