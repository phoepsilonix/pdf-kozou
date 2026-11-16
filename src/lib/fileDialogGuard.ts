// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/fileDialogGuard.ts
//
// ファイル/フォルダ選択ダイアログ(ネイティブ)を開いている間、および
// 出力(保存)処理を実行している間の、画面遷移ロックの状態管理。
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
//
// 出力(保存)処理中も同様に、別メニューへ遷移すると処理結果の表示先が失われる
// (バッチでは処理だけが裏で走り続ける)ため、各ページが useProcessingGuard() で
// 「処理中」を登録し、その間はメニュー・ショートカットによる遷移を止める。
// 処理中はキャンセルボタンを操作できる必要があるため、こちらは inert にはしない。

import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { create } from "zustand";

interface FileDialogState {
  /** 現在開いているダイアログの数。0 なら開いていない。 */
  count: number;
  /** 出力(保存)処理を実行中のページの数。0 なら実行中の処理は無い。 */
  processing: number;
}

export const useFileDialogStore = create<FileDialogState>(() => ({ count: 0, processing: 0 }));

/** Reactの外(ハンドラ内など)からでも使える。ダイアログを開いている間 true。 */
export function isFileDialogOpen(): boolean {
  return useFileDialogStore.getState().count > 0;
}

/** 出力(保存)処理を実行している間 true。 */
export function isProcessingActive(): boolean {
  return useFileDialogStore.getState().processing > 0;
}

/**
 * 画面遷移(別ツールへの切り替え・ホームへ戻る・ショートカット)を止めるべき間 true。
 * ファイルダイアログを開いている間、または出力処理の実行中。
 */
export function isNavigationLocked(): boolean {
  const { count, processing } = useFileDialogStore.getState();
  return count > 0 || processing > 0;
}

/** Reactコンポーネント内で、画面遷移ロックの有無を購読する(メニューの無効表示用)。 */
export function useNavigationLocked(): boolean {
  return useFileDialogStore((s) => s.count > 0 || s.processing > 0);
}

/**
 * ページが出力(保存)処理を実行している間(active が true の間)、画面遷移ロックを
 * 有効にする。アンマウント時も必ず解除される。
 */
export function useProcessingGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    useFileDialogStore.setState((s) => ({ processing: s.processing + 1 }));
    return () => {
      useFileDialogStore.setState((s) => ({ processing: Math.max(0, s.processing - 1) }));
    };
  }, [active]);
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
