// src/components/JumpNav.tsx
// 狭い画面（縦積みレイアウト）で「設定」⇄「プレビュー」間を
// スクロールでジャンプするための共通ボタン。
// 状態やDOM構成には触れず、単に scrollIntoView するだけ。
// 広い画面（左右並び）では表示しない想定なので、呼び出し側で isNarrow を見て
// 描画するかどうかを判断する。

import type { CSSProperties, RefObject } from "react";

interface JumpButtonProps {
  targetRef: RefObject<HTMLElement>;
  label: string;
  direction: "down" | "up";
}

export function JumpButton({ targetRef, label, direction }: JumpButtonProps) {
  return (
    <button
      type="button"
      onClick={() => targetRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
      style={s.btn}
    >
      <span aria-hidden="true">{direction === "down" ? "\u25BC" : "\u25B2"}</span>
      <span>{label}</span>
    </button>
  );
}

const s: Record<string, CSSProperties> = {
  btn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    width: "100%",
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid var(--c-border)",
    background: "var(--c-bgCard)",
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontSize: 13,
    flexShrink: 0,
  },
};
