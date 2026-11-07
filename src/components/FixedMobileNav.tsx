// src/components/FixedMobileNav.tsx
// 縦積みレイアウト用の固定ナビゲーションバー。
// 「設定 ⇄ プレビュー」を1つのボタンで行き来するトグルと、
// 実行ボタン（呼び出し側から渡す）を、画面下部に固定表示する。
// セクションごとに別々のジャンプボタン・実行ボタンを作らずに済むよう、
// ページ全体で1つだけ描画する想定。
//
// reserveSpace: ナビは position:fixed のため、ページ末尾の要素(下部のボタンなど)は
// スクロールの最下端でもナビの裏に隠れる。iPhone ではゴムバンドで一瞬見えても
// すぐ戻って押せないため、true のときはナビの高さ(実測)ぶんの空きを
// スクロールコンテンツの末尾に確保する。呼び出し側のスクロール領域
// (flex column) の直下に置くこと。既に自前で下余白を取っているページは指定しない。

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

interface FixedMobileNavProps {
  showingSecondSection: boolean;
  onToggle: () => void;
  toSecondLabel: string;
  toFirstLabel: string;
  children?: ReactNode; // 実行ボタンなどを渡す
  reserveSpace?: boolean;
}

export function FixedMobileNav({
  showingSecondSection,
  onToggle,
  toSecondLabel,
  toFirstLabel,
  children,
  reserveSpace,
}: FixedMobileNavProps) {
  const navRef = useRef<HTMLDivElement>(null);
  const [navHeight, setNavHeight] = useState(0);

  // 実行ボタン列の折り返しや safe-area で高さが変わるため、固定値ではなく実測する。
  useLayoutEffect(() => {
    if (!reserveSpace) return;
    const el = navRef.current;
    if (!el) return;
    const measure = () => setNavHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [reserveSpace]);

  return (
    <>
      {reserveSpace && <div aria-hidden="true" style={{ flexShrink: 0, height: navHeight }} />}
      <div
        ref={navRef}
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          // safe-area を env() で直接指定（--safe-bottom 変数より信頼性が高い）
          paddingBottom: "calc(8px + env(safe-area-inset-bottom))",
          borderTop: "1px solid var(--c-border)",
          background: "var(--c-bg)",
          boxShadow: "0 -2px 8px rgba(0,0,0,0.08)",
          // zoom 影響を最小化（transform ではなく直接 viewport 固定）
        }}
      >
        <button
          type="button"
          onClick={onToggle}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            flexShrink: 0,
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid var(--c-border)",
            background: "var(--c-bgCard)",
            color: "var(--c-textSub)",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          <span aria-hidden="true">{showingSecondSection ? "\u25B2" : "\u25BC"}</span>
          <span>{showingSecondSection ? toFirstLabel : toSecondLabel}</span>
        </button>
        <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>{children}</div>
      </div>
    </>
  );
}
