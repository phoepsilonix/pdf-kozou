// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/announce.ts
//
// 命令的に値変更を読み上げるためのヘルパー。
// ステッパー（三角ボタン等）やドラッグ操作のように、ネイティブの input
// イベントを発火しない値変更で使う。useFocusAnnouncer の input 監視では
// 拾えないため、これらの操作箇所から明示的に呼び出す。

import { getCurrentLocale, translate } from "./i18n";
import { tts } from "./tts";

/** 「〇〇 を □□ に変更しました」と即座に読み上げる（ステッパー等の値変更用）。 */
export function announceValueChange(name: string, value: string | number): void {
  if (!tts.enabled) return;
  tts.speak(translate(getCurrentLocale(), "voice.changed", { name, value: String(value) }), true);
}

const PT_TO_MM = 1 / 2.8346;
const mm = (pt: number) => (pt * PT_TO_MM).toFixed(1);

/** トリミング余白（pt単位）を mm に直して上下左右まとめて読み上げる（枠ドラッグ用）。 */
export function announceMargins(m: {
  top: number;
  bottom: number;
  left: number;
  right: number;
}): void {
  if (!tts.enabled) return;
  tts.speak(
    translate(getCurrentLocale(), "voice.margins_changed", {
      top: mm(m.top),
      bottom: mm(m.bottom),
      left: mm(m.left),
      right: mm(m.right),
    }),
    true,
  );
}
