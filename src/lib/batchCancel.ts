// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/batchCancel.ts
//
// バッチ出力の「キャンセル」要求。
//
// バックエンド(Rust)の処理は途中で中断できないため、キャンセルは「いま処理中の
// ファイルが終わった時点で、次のファイル以降を処理しない」という意味になる。
// すでに書き出した分はそのまま残す(上書き確認のキャンセルと同じ扱い)。
//
// 使い方(バッチ実行側):
//   resetBatchCancel();                        // 実行開始時に1回
//   for (...) {
//     if (isBatchCancelRequested()) { ...記録して break; }
//     ...
//   }
// キャンセルボタンは <BatchCancelButton /> を進捗画面に置く。

import { create } from "zustand";

interface BatchCancelState {
  requested: boolean;
}

export const useBatchCancelStore = create<BatchCancelState>(() => ({ requested: false }));

export function requestBatchCancel(): void {
  useBatchCancelStore.setState({ requested: true });
}

export function resetBatchCancel(): void {
  useBatchCancelStore.setState({ requested: false });
}

export function isBatchCancelRequested(): boolean {
  return useBatchCancelStore.getState().requested;
}
