// src/hooks/useViewport.ts
// 画面幅（= window.innerWidth）に応じてレイアウトを切り替えるための共通フック。
// スマホ実機だけでなく、PC上でウィンドウを縦長に狭めた場合も同じ判定にするため、
// User-Agent ではなく実際のビューポート幅で判定する。

import { useEffect, useState } from "react";

// この幅未満を「狭い画面（設定とプレビューを縦積みにする）」とみなす。
export const NARROW_BREAKPOINT = 768;

function computeIsNarrow(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth < NARROW_BREAKPOINT;
}

export function useViewport() {
  const [isNarrow, setIsNarrow] = useState(computeIsNarrow);

  useEffect(() => {
    const onResize = () => setIsNarrow(computeIsNarrow());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { isNarrow };
}
