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

// hooks/useSectionToggle.ts
import { useEffect, useState, useCallback, type RefObject } from "react";

export function useSectionToggle(
  scrollContainerRef: RefObject<HTMLElement | null>,
  sectionBRef: RefObject<HTMLElement | null>,
) {
  const [showingB, setShowingB] = useState(false);

  const update = useCallback(() => {
    const container = scrollContainerRef.current;
    const sectionB = sectionBRef.current;
    if (!container || !sectionB) return;

    // より信頼できる相対位置計算（scrollTop + offset）
    const containerRect = container.getBoundingClientRect();
    const bRect = sectionB.getBoundingClientRect();

    // container の可視上端に対する sectionB の相対位置
    const relativeTop = bRect.top - containerRect.top;
    // 少しの余裕を持たせる（ヘッダーや padding の影響を吸収）
    setShowingB(relativeTop <= 240); // 40 → 240 に緩和
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    update(); // 初回

    const rafUpdate = () => requestAnimationFrame(update);
    container.addEventListener("scroll", rafUpdate, { passive: true });
    window.addEventListener("resize", rafUpdate);

    // コンテンツ高さ変化を捕捉（MutationObserver）
    const observer = new MutationObserver(rafUpdate);
    observer.observe(container, { childList: true, subtree: true });

    return () => {
      container.removeEventListener("scroll", rafUpdate);
      window.removeEventListener("resize", rafUpdate);
      observer.disconnect();
    };
  }, [update]);

  const scrollToA = () => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const scrollToB = () => {
    sectionBRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const toggle = () => (showingB ? scrollToA() : scrollToB());

  return { showingB, toggle, forceUpdate: update };
}
