// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/hooks/useA11y.ts
//
// アクセシビリティ共通フック。全ページ・コンポーネントで使い回す。
//
// 使い方:
//   const { t, announce, announceScreen, announceSuccess, announceError } = useA11y();
//
//   // 画面表示時（遅延あり）
//   useEffect(() => { announceScreen("screen.split"); }, []);
//
//   // 処理完了
//   announceSuccess("done.split", { count: "3" });
//
//   // エラー
//   announceError("処理に失敗しました");
//
//   // 翻訳テキスト取得（aria-label 等に使う）
//   <button aria-label={t("action.execute")}>実行</button>

import { useCallback } from "react";
import { useI18n } from "../lib/i18n";
import { tts } from "../lib/tts";

export function useA11y() {
  const { t } = useI18n();

  /** 任意のテキストを読み上げ */
  const announce = useCallback((text: string, interrupt = true) => {
    tts.speak(text, interrupt);
  }, []);

  /** 翻訳キーを指定して読み上げ */
  const announceKey = useCallback(
    (key: string, vars?: Record<string, string>, interrupt = true) => {
      tts.speak(t(key, vars), interrupt);
    },
    [t],
  );

  /** 画面遷移時の読み上げ（DOM 描画後に読み上げるため少し遅延） */
  const announceScreen = useCallback(
    (screenKey: string) => {
      setTimeout(() => tts.speak(t(screenKey)), 150);
    },
    [t],
  );

  /** 処理成功時の読み上げ */
  const announceSuccess = useCallback(
    (key: string, vars?: Record<string, string>) => {
      tts.speak(t(key, vars));
    },
    [t],
  );

  /** エラー時の読み上げ */
  const announceError = useCallback(
    (msg: string) => {
      tts.speak(`${t("error.prefix")} ${msg}`);
    },
    [t],
  );

  return { t, announce, announceKey, announceScreen, announceSuccess, announceError };
}
