// src/hooks/useSectionToggle.ts
// 縦積みレイアウトで「設定」「プレビュー」のどちらを見ているかを判定し、
// 単一のトグルボタンで両者を行き来できるようにするためのフック。
//
// scrollContainerRef: overflowY:auto でページ全体をスクロールさせているコンテナ
// sectionBRef: 2つ目のセクション（プレビュー側）の先頭要素
//
// sectionBRef の上端が scrollContainerRef の上端に到達したら
// 「B（プレビュー）を表示中」とみなす、という単純な判定。
// IntersectionObserver ではなくスクロール位置の直接比較にしているのは、
// 「今どちらを見ているか」を都度スクロールのたびに正確に把握したいのと、
// 2セクションしかない単純なケースでは閾値調整が不要でわかりやすいため。

import { useEffect, useState, type RefObject } from "react";

export function useSectionToggle(
  scrollContainerRef: RefObject<HTMLElement | null>,
  sectionBRef: RefObject<HTMLElement | null>,
) {
  const [showingB, setShowingB] = useState(false);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const sectionB = sectionBRef.current;
    if (!container || !sectionB) return;

    const update = () => {
      const containerTop = container.getBoundingClientRect().top;
      const bTop = sectionB.getBoundingClientRect().top;
      // 数px の誤差を許容
      setShowingB(bTop - containerTop <= 8);
    };
    update();
    container.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      container.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  });

  const scrollToA = () => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };
  const scrollToB = () => {
    sectionBRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const toggle = () => (showingB ? scrollToA() : scrollToB());

  return { showingB, toggle };
}
