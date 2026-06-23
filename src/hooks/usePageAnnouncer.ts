// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/hooks/usePageAnnouncer.ts
//
// プレビュー（左ペインのページ一覧）で選択中ページが変わったとき、
// 音声で「〇ページ目、全〇ページ」と何ページ目かを読み上げる。
// トリミング・ビューワなどページを切り替える画面で使う。初回マウント時は
// 読み上げず、ページが実際に変化したときのみ通知する。

import { useEffect, useRef } from "react";
import { tts } from "../lib/tts";
import { useI18n } from "../lib/i18n";

export function usePageAnnouncer(pageIndex: number, totalPages: number) {
  const { t } = useI18n();
  const prev = useRef<number | null>(null);
  useEffect(() => {
    // 初回はページ変更ではないので読み上げない
    if (prev.current === null) {
      prev.current = pageIndex;
      return;
    }
    if (prev.current === pageIndex) return;
    prev.current = pageIndex;
    if (!tts.enabled) return;
    if (!Number.isFinite(pageIndex) || totalPages <= 0) return;
    tts.speak(
      t("voice.page_changed", { page: String(pageIndex + 1), total: String(totalPages) }),
      true,
    );
  }, [pageIndex, totalPages, t]);
}
