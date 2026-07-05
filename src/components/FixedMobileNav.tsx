// src/components/FixedMobileNav.tsx
// 縦積みレイアウト用の固定ナビゲーションバー。
// 「設定 ⇄ プレビュー」を1つのボタンで行き来するトグルと、
// 実行ボタン（呼び出し側から渡す）を、画面下部に固定表示する。
// セクションごとに別々のジャンプボタン・実行ボタンを作らずに済むよう、
// ページ全体で1つだけ描画する想定。

import type { ReactNode } from "react";

interface FixedMobileNavProps {
  showingSecondSection: boolean;
  onToggle: () => void;
  toSecondLabel: string;
  toFirstLabel: string;
  children?: ReactNode; // 実行ボタンなどを渡す
}

export function FixedMobileNav({
  showingSecondSection,
  onToggle,
  toSecondLabel,
  toFirstLabel,
  children,
}: FixedMobileNavProps) {
  return (
    <div
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
        borderTop: "1px solid var(--c-border)",
        background: "var(--c-bg)",
        boxShadow: "0 -2px 8px rgba(0,0,0,0.08)",
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
  );
}
