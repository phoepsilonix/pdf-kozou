// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/hooks/useBusyAnnouncer.ts
//
// 処理中（スピナー表示中）の音声ガイド。
// 処理が一定時間より長くかかる場合のみ「処理中です…」と読み上げ、
// さらに長引くときは一定間隔で再通知する。短時間で終わる処理では鳴らさない。
//
// 使い方:
//   - 共通 Spinner では useBusyAnnouncer(true, label)（マウント中=処理中）。
//   - 独自のビジー表示を持つ画面では useBusyAnnouncer(active, label) を呼ぶ。
//     active が true の間だけ計測し、false で停止する。

import { useEffect } from "react";
import { tts } from "../lib/tts";
import { useI18n } from "../lib/i18n";

const DELAY_MS = 4000; // この時間を超えて処理が続くと最初の通知
const REPEAT_MS = 12000; // さらに長引くときの再通知間隔

export function useBusyAnnouncer(active: boolean, label?: string) {
  const { t } = useI18n();
  useEffect(() => {
    if (!active || !tts.enabled) return;
    const msg = label && label.trim() ? label : t("voice.processing");
    let interval: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      tts.speak(msg, false);
      interval = setInterval(() => tts.speak(msg, false), REPEAT_MS);
    }, DELAY_MS);
    return () => {
      clearTimeout(start);
      if (interval) clearInterval(interval);
    };
  }, [active, label, t]);
}
