// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/FloatingMenu.tsx
//
// アンカー要素（トグルボタン）の下にドロップダウン表示するフローティングメニュー。
// document.body 直下へ React Portal でマウントすることで、
// #root にかかっている overflow:hidden / zoom（lib/uiScale.ts, applyToRoot 参照）
// による意図しないクリッピングを避ける。#root は表示スケール用に CSS zoom を
// 常時適用しており、zoom がかかった祖先の内側では position:fixed の子要素が
// 祖先基準でコンテインされてしまう（＝#root の overflow:hidden にそのまま
// クリップされる）環境があるため、#root の外（body 直下）に描画するのが安全。
//
// 位置はアンカーの getBoundingClientRect() から都度計算するため、
// #root 内側の zoom によるスケーリングの影響を受けず、実ビューポート座標で
// 正しく配置される。

import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

interface FloatingMenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function FloatingMenu({ open, onClose, anchorRef, children }: FloatingMenuProps) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const gap = 6;
      setPos({
        top: rect.bottom + gap,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("kozou-uiscale-change", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("kozou-uiscale-change", update);
    };
  }, [open, anchorRef]);

  if (!open || !pos || typeof document === "undefined") return null;

  return createPortal(
    <>
      {/* 外側クリックで閉じるための透明な全画面オーバーレイ */}
      <div style={{ position: "fixed", inset: 0, zIndex: 1199 }} onClick={onClose} />
      <div
        style={{
          position: "fixed",
          top: pos.top,
          right: pos.right,
          zIndex: 1200,
          maxWidth: "calc(100vw - 16px)",
          maxHeight: "70vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: 10,
          borderRadius: 10,
          border: "1px solid var(--c-border)",
          background: "var(--c-bgCard)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
        }}
        // パネル自体のクリックがオーバーレイへ伝播して即座に閉じないようにする
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
