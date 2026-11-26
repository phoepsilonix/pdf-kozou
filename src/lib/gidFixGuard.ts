// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/gidFixGuard.ts — GID 補正がオフのときの、通知と出力前の確認
//
// 補正がオンなら、全機能で補正して出力するので、何もしない。オフのときだけ:
//   - ファイルの情報を読んだとき、補正が必要なフォントがあれば、通知する (GidFixNotice)
//   - 補正が必要なファイルから出力を作る前に、確認する (GidFixConfirmModal):
//       補正をオンにして出力 / このまま出力 / キャンセル
//     「このまま出力」を選ぶと、補正がオフのあいだは、確認しない (バッチで何度も聞かないため)。
//     「キャンセル」は、出力を止める (バッチは、次のファイル以降を処理しない)。
//
// 画像の出力 (画像・画像 PDF) は、MuPDF 描画のときだけ確認する。hayro 描画は、補正がオフでも
// 文字が出るため。

import { useGidFixConfirmStore } from "../store/useGidFixConfirmStore";
import { useGidFixNoticeStore } from "../store/useGidFixNoticeStore";
import { requestBatchCancel } from "./batchCancel";
import { changeGidFix, getGidFixMode, subscribeGidFix } from "./gidFix";
import { getCurrentLocale, translate } from "./i18n";
import { getRenderEngine } from "./renderEngine";
import { getGidFixNeed, type OutputGuardKind, setInfoHook, setOutputGuard } from "./tauri";

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

/** アプリが内部で作る一時ファイル (出力処理の途中の中間ファイル)。元のファイルで確認済みなので対象にしない */
function isInternalTemp(p: string): boolean {
  return /[/\\]pdf-kozou[/\\]/.test(p);
}

/** 「このまま出力」を選んだ。補正がオンになるまで、確認しない */
let suppress = false;

/** 確認は 1 つずつ (バッチの並行呼び出しで、ダイアログが重ならないように) */
let chain: Promise<void> = Promise.resolve();

async function decide(kind: OutputGuardKind, paths: string[]): Promise<void> {
  if (getGidFixMode() === "on" || suppress) return;
  if (kind === "image" && getRenderEngine() !== "mupdf") return;
  const targets = [...new Set(paths)].filter((p) => p && !isInternalTemp(p));
  const needs: { path: string; count: number }[] = [];
  for (const path of targets) {
    const count = await getGidFixNeed(path);
    if (count > 0) needs.push({ path, count });
  }
  if (needs.length === 0) return;

  const choice = await useGidFixConfirmStore.getState().ask({
    files: needs.map((n) => baseName(n.path)),
    count: needs.reduce((a, n) => a + n.count, 0),
    kind,
  });
  if (choice === "on") {
    await changeGidFix("on");
    return;
  }
  if (choice === "continue") {
    suppress = true;
    return;
  }
  requestBatchCancel();
  throw new Error(translate(getCurrentLocale(), "gid_fix.confirm_cancelled"));
}

async function noteNeed(path: string): Promise<void> {
  if (getGidFixMode() === "on" || isInternalTemp(path)) return;
  const count = await getGidFixNeed(path);
  if (count > 0 && getGidFixMode() === "off") {
    useGidFixNoticeStore.getState().note(path, count);
  }
}

/** 起動時に一度呼ぶ。出力前の確認と、ファイル情報を読んだときの通知を有効にする (戻り値で解除) */
export function installGidFixGuard(): () => void {
  setOutputGuard((kind, paths) => {
    chain = chain.catch(() => {}).then(() => decide(kind, paths));
    return chain;
  });
  setInfoHook((path) => {
    void noteNeed(path);
  });
  const unsubscribe = subscribeGidFix(() => {
    if (getGidFixMode() === "on") {
      suppress = false;
      useGidFixNoticeStore.getState().clear();
    }
  });
  return () => {
    setOutputGuard(null);
    setInfoHook(null);
    unsubscribe();
  };
}
