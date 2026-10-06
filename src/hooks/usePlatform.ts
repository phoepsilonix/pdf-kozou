// src/hooks/usePlatform.ts
// 実行環境が実機の Android/iOS かどうかを同期的に扱うための軽量フック。
//
// useViewport() の isNarrow は「ウィンドウ幅が狭いか」だけを見ており、
// デスクトップでもウィンドウを狭めれば true になる。一方、ellipsis省略
// したファイル名などを「タップして全文表示」するポップアップ操作は、
// ホバーでtitle属性が見られないタッチ操作環境(=実機モバイル)でのみ
// 必要なもので、デスクトップではマウスホバーのtitleツールチップだけで
// 十分かつポップアップは煩わしい。そのため、この種のUIはisNarrowでは
// なくこのフック(実行環境そのもの)で分岐すること。
import { useEffect, useState } from "react";
import { isMobile } from "../lib/tauri";

export function useIsMobilePlatform(): boolean {
  return useMobilePlatformState() === true;
}

/**
 * useIsMobilePlatform() の判定結果が未確定の間を区別したい場合用。
 * 判定は非同期 (is_mobile コマンド) のため、確定するまでは null を返す。
 * 「モバイルでは表示しない」ものを、判定完了前に一瞬だけ見せてしまわない
 * ようにするには、`state === false` (デスクトップと確定) の時だけ表示する。
 */
export function useMobilePlatformState(): boolean | null {
  const [mobilePlatform, setMobilePlatform] = useState<boolean | null>(null);
  useEffect(() => {
    isMobile()
      .then(setMobilePlatform)
      .catch(() => setMobilePlatform(false));
  }, []);
  return mobilePlatform;
}
