// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/FloatingMenu.tsx
//
// アンカー要素（トグルボタン）の下にドロップダウン表示するフローティングメニュー。
// document.body 直下へ React Portal でマウントすることで、以下の2つの問題を回避する。
//
// 1. クリッピング問題:
//    #root には表示スケール機能のため CSS zoom が常時適用されており
//    (lib/uiScale.ts, applyToRoot)、同時に overflow: hidden も設定されている。
//    この組み合わせの環境では #root 配下にネストした position:absolute の
//    フローティングパネルが実ビューポートではなく #root 自体を基準にクリップされる。
//    さらに、このパネルの中に別のドロップダウン（テーマ選択など、各コンポーネントが
//    自前で position:absolute + overflow を使って実装しているもの）を入れ子にすると、
//    実際にはその下に表示できる画面領域が十分あっても、パネル自身の
//    overflow/高さで再度クリップされてしまう。→ 全て document.body 直下に
//    position:fixed で描画し、実ビューポート座標で配置することで解消する。
//
// 2. 開いた直後に閉じてしまう問題:
//    以前は「全画面の透明オーバーレイに onClick={onClose} を仕込む」方式で
//    外側クリックを検知していたが、環境（Linux/WebKitGTK 等）によっては
//    開いた直後に閉じてしまい、パネル内の項目を選択できないことがあった。
//    → ネイティブの pointerdown リスナーを「次のイベントループ」まで登録を
//      遅延させる方式に変更し、開いた瞬間のクリックで即座に閉じないようにする。
//
// 高さについても、固定の "70vh" のような割合ではなく、アンカーの下から
// 画面下端までの「実際に使える領域」を都度計算して使うようにしている
// （UI拡大率が高い場合でも、使える領域を最大限使う）。
//
// 3. 入れ子になった FloatingMenu 同士の干渉:
//    テーマ選択などの各コントロールも自身のドロップダウンを FloatingMenu で
//    実装しているため、モバイル用メニュー（外側）の中に、それらのコントロール
//    （内側）が入れ子で存在する。だが Portal 先はどちらも同じ document.body
//    直下で、DOM上は兄弟関係（内側パネルは外側パネルの子孫ではない）になる。
//    この状態で内側パネルの項目をクリックすると、外側の「外側クリックで閉じる」
//    判定が「パネルの外がクリックされた」と誤認し、外側パネルを閉じてしまう。
//    すると選択に使ったボタン自体がその再描画で消えてしまい、React の click
//    イベントが発火する前に対象のボタンがDOMから消え、選択が反映されない
//    （pointerdown → 外側が閉じて対象ボタンがアンマウント → click が飛ばない）。
//    → 各パネルに data-kozou-floating-menu を付与し、クリック先が
//      「いずれかの FloatingMenu パネルの内部」であれば、自分のパネルの外で
//      あっても閉じないようにする。

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const PANEL_MARKER = "data-kozou-floating-menu";

interface FloatingMenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}

const MARGIN = 8;
const GAP = 6;
const MIN_PANEL_HEIGHT = 120;

export function FloatingMenu({ open, onClose, anchorRef, children }: FloatingMenuProps) {
  const [pos, setPos] = useState<{ top: number; right: number; maxHeight: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // アンカーの実座標から配置・高さを計算する。
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const top = rect.bottom + GAP;
      // アンカー下端から画面下端までの実際に使える高さをそのまま使う
      const available = Math.max(MIN_PANEL_HEIGHT, window.innerHeight - top - MARGIN);
      setPos({
        top,
        right: Math.max(MARGIN, window.innerWidth - rect.right),
        maxHeight: available,
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

  // 外側クリックで閉じる。全画面オーバーレイでの即時クローズは環境によって
  // 「開いた瞬間のクリックで即座に閉じる」不具合を起こすため、
  // ネイティブリスナーの登録自体を次のイベントループまで遅らせる。
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      // 入れ子になった別の FloatingMenu（テーマ選択など）の内部クリックは、
      // 自分のパネルの外であっても「外側クリック」として扱わない。
      if (target instanceof Element && target.closest(`[${PANEL_MARKER}]`)) return;
      onClose();
    };
    const timerId = window.setTimeout(() => {
      document.addEventListener("pointerdown", handlePointerDown, true);
    }, 0);
    return () => {
      window.clearTimeout(timerId);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [open, anchorRef, onClose]);

  // Esc キーでも閉じられるようにする
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open || !pos || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      {...{ [PANEL_MARKER]: true }}
      style={{
        position: "fixed",
        top: pos.top,
        right: pos.right,
        zIndex: 1200,
        maxWidth: "calc(100vw - 16px)",
        maxHeight: pos.maxHeight,
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
    >
      {children}
    </div>,
    document.body,
  );
}
