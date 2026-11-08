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
// 5. 画面左側のアンカーで左にはみ出す問題:
//    パネルは基本的にアンカーの右端に右揃えで出す(ヘッダー右側のボタン向け)。
//    だが画像変換画面の左側パネルなどにアンカーがあると、右揃えではパネルの
//    左端が画面の外へはみ出して項目が読めなくなる。
//    → 描画後にパネルの実幅を測り、左端が画面外になる場合はアンカーの左端に
//      揃えて(さらに右端も画面内に収めて)配置し直す。
//
// 高さについても、固定の "70vh" のような割合ではなく、アンカーの下から
// 画面下端までの「実際に使える領域」を都度計算して使うようにしている
// （UI拡大率が高い場合でも、使える領域を最大限使う）。
// 画面下端は window.visualViewport から求める。モバイルではソフトキーボードが
// 出ても window.innerHeight が変わらない環境(Chrome系のAndroid、iOS)があり、
// innerHeight だけを見ると、下側の入力欄がキーボードの裏に隠れてしまうため。
// 入力欄にフォーカスしたとき、またはキーボードで高さが変わったときは、
// フォーカス中の入力欄がパネル内で見える位置になるようスクロールする。
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
//
// 4. キーボード操作時のタブ順序がわかりにくい問題:
//    パネルは document.body の末尾に Portal で追加されるため、DOM上の
//    タブ順序はアンカーボタンの直後ではなく、ページの最後になってしまう。
//    そのため「アンカーをキーボードで開いた流れのまま Tab で操作する」と、
//    パネルの中身ではなく、ページの他の要素に飛んでしまっていた。
//    → アンカーにフォーカスがある状態で Tab を押すと、パネル内の最初の
//      要素へ直接ジャンプするようにする。パネル内では Tab/Shift+Tab が
//      パネル内だけを循環し（先頭で Shift+Tab するとアンカーへ戻る）、
//      ページの他の部分へタブで抜けてしまわないようにする。
//      閉じたとき（選択・Esc・外側クリックいずれも）はアンカーへフォーカスを
//      戻し、キーボード操作の位置を見失わないようにする。

import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { getUiScale } from "../lib/uiScale";

const PANEL_MARKER = "data-kozou-floating-menu";
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null, // 非表示要素は除外
  );
}

interface FloatingMenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}

const MARGIN = 8;
const GAP = 6;
const MIN_PANEL_HEIGHT = 120;
// ソフトキーボード表示中(見える範囲が縮んでいるとき)の下限。横向きなどで
// 見える範囲が狭くても、パネルがその外にはみ出さないよう小さめにする。
const MIN_PANEL_HEIGHT_KEYBOARD = 80;

export function FloatingMenu({ open, onClose, anchorRef, children }: FloatingMenuProps) {
  const [pos, setPos] = useState<{ top: number; right: number; maxHeight: number } | null>(null);
  // #root 直下ではなく document.body 直下へ Portal するため、#root にかかる
  // 表示スケール（CSS zoom, lib/uiScale.ts）の対象外になり、UI拡大率を
  // 上げ下げしてもパネル自身の文字サイズ・余白だけ変わらず違和感があった。
  // 位置計算は実ビューポート座標のまま行い、実際に描画する top/right/maxHeight
  // は scale で割ってから渡す(zoom を適用した要素自身に非ゼロの px 値を
  // 指定すると、その値自体も他の長さと同様に scale 倍されて描画されるため)。
  // パネル自身の描画にだけ同じ倍率を掛けて他のUIと見た目を揃える。
  const [scale, setScale] = useState(() => getUiScale());
  // 右揃えだと左へはみ出すときの左端位置(実ビューポート px)。null なら右揃え。
  const [leftOverride, setLeftOverride] = useState<number | null>(null);
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
      setScale(getUiScale());
      const rect = el.getBoundingClientRect();
      const top = rect.bottom + GAP;
      // 画面下端(実際に見える範囲の下端)。ピンチズーム中は visualViewport が
      // 縮んで見えるだけでキーボードとは無関係なので、その間は innerHeight を使う。
      const vv = window.visualViewport;
      const useVv = !!vv && vv.scale <= 1.01;
      const visibleBottom = useVv && vv ? vv.offsetTop + vv.height : window.innerHeight;
      const keyboardShown = useVv && !!vv && vv.height < window.innerHeight - 1;
      const minHeight = keyboardShown ? MIN_PANEL_HEIGHT_KEYBOARD : MIN_PANEL_HEIGHT;
      // アンカー下端から画面下端までの実際に使える高さをそのまま使う
      const available = Math.max(minHeight, visibleBottom - top - MARGIN);
      const next = {
        top,
        right: Math.max(MARGIN, window.innerWidth - rect.right),
        maxHeight: available,
      };
      // visualViewport の scroll/resize やパネル内スクロールで頻繁に呼ばれるため、
      // 値が(1px未満の差で)変わらないときは state を更新せず再描画を避ける。
      setPos((prev) =>
        prev &&
        Math.abs(prev.top - next.top) < 1 &&
        Math.abs(prev.right - next.right) < 1 &&
        Math.abs(prev.maxHeight - next.maxHeight) < 1
          ? prev
          : next,
      );
    };
    update();
    const vv = window.visualViewport;
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("kozou-uiscale-change", update);
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("kozou-uiscale-change", update);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
    };
  }, [open, anchorRef]);

  // 描画後にパネルの実幅を測り、右揃えで左へはみ出すなら左端基準に切り替える。
  // pos(アンカー位置・スケール)が変わるたびに測り直す。
  const posTop = pos?.top;
  const posRight = pos?.right;
  // biome-ignore lint/correctness/useExhaustiveDependencies: posTop/posRight/scale の変化を契機に測り直したい。
  useLayoutEffect(() => {
    if (!open || posTop === undefined) {
      setLeftOverride(null);
      return;
    }
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (!panel || !anchor) return;
    const rect = panel.getBoundingClientRect();
    const width = rect.right - rect.left;
    const a = anchor.getBoundingClientRect();
    const rightAlignedLeft = a.right - width;
    let next: number | null = null;
    if (rightAlignedLeft < MARGIN) {
      // アンカーの左端に揃える。右端が画面外に出るなら画面内に収める。
      const maxLeft = window.innerWidth - MARGIN - width;
      next = Math.max(MARGIN, Math.min(a.left, maxLeft));
    }
    setLeftOverride((prev) =>
      prev === next || (prev !== null && next !== null && Math.abs(prev - next) < 1) ? prev : next,
    );
  }, [open, anchorRef, posTop, posRight, scale]);

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

  // アンカーにフォーカスがある状態で Tab を押したら、パネル内の先頭要素へ
  // 直接ジャンプする（DOM上はパネルが document.body 末尾にあるため、
  // 何もしないとページの他の要素へ飛んでしまう）。
  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const handleAnchorKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.shiftKey) return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = getFocusable(panel);
      if (focusables.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      focusables[0].focus();
    };
    anchor.addEventListener("keydown", handleAnchorKeyDown);
    return () => anchor.removeEventListener("keydown", handleAnchorKeyDown);
  }, [open, anchorRef]);

  // パネル内では Tab/Shift+Tab がパネル内だけを循環するようにする
  // （末尾で Tab → 先頭へ、先頭で Shift+Tab → アンカーへ戻る）。
  const handlePanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = getFocusable(panel);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      e.stopPropagation();
      (anchorRef.current ?? last).focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      e.stopPropagation();
      first.focus();
    }
  };

  // 閉じたとき（選択・Esc・外側クリックいずれの経路でも）はアンカーへ
  // フォーカスを戻し、キーボード操作の位置を見失わないようにする。
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (wasOpenRef.current && !open) {
      anchorRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open, anchorRef]);

  // フォーカス中の入力欄がパネル内で隠れていたら見える位置へスクロールする。
  // scrollIntoView の対象になるスクロール祖先は、このパネルだけ
  // (html/body は overflow:hidden でスクロール範囲もない)。
  // 要素の座標は CSS zoom 下でも自身と同じ座標系で処理されるため、
  // scrollTop を自前で換算せずに済む scrollIntoView を使う。
  const ensureFocusedVisible = () => {
    const panel = panelRef.current;
    const el = document.activeElement;
    if (!panel || !(el instanceof HTMLElement) || !panel.contains(el)) return;
    if (!el.matches("input, textarea, select")) return;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  // キーボードの表示/非表示などでパネルの最大高さが変わったとき(描画反映後)にも
  // 入力欄が見える位置に保つ。
  const maxHeight = pos?.maxHeight;
  // biome-ignore lint/correctness/useExhaustiveDependencies: maxHeight の変化だけを契機に実行したい(ensureFocusedVisible は ref のみ参照)。
  useEffect(() => {
    if (maxHeight === undefined) return;
    ensureFocusedVisible();
  }, [maxHeight]);

  if (!open || !pos || typeof document === "undefined") return null;

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: パネルの role は内容により様々なため固定できない。onKeyDown はフォーカストラップ用途のみ。
    <div
      ref={panelRef}
      {...{ [PANEL_MARKER]: true }}
      onKeyDown={handlePanelKeyDown}
      onFocus={() => {
        // フォーカス直後はキーボードがまだ出ていないことがあるため、描画後に1度。
        // その後のキーボード表示による高さ変化は上の effect が拾う。
        window.requestAnimationFrame(ensureFocusedVisible);
      }}
      style={
        {
          position: "fixed",
          // pos.top / pos.right は実ビューポート px(ズーム前)で計算済み。
          // #root の inset:0 は「0px」なので zoom を掛けても 0px のまま
          // 変わらないが、この top/right のような非ゼロの px 値は zoom を
          // 適用した要素自身に指定すると、その他の長さ(padding 等)と同様に
          // scale 倍されてレンダリングされてしまい、位置がズレる。
          // そのため先に scale で割っておき、zoom 適用後に実際の座標へ戻す。
          top: pos.top / scale,
          ...(leftOverride === null
            ? { right: pos.right / scale }
            : { left: leftOverride / scale }),
          zIndex: 1200,
          maxWidth: "calc(100vw - 16px)",
          // maxHeight も同様に、zoom で拡大される分を先に差し引いておく。
          maxHeight: pos.maxHeight / scale,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: 10,
          borderRadius: 10,
          border: "1px solid var(--c-border)",
          background: "var(--c-bgCard)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
          // #root と同じ CSS zoom を適用し、UI拡大率と見た目を連動させる。
          // 型定義に zoom が無いため CSSProperties を拡張してキャストする。
          zoom: scale,
        } as React.CSSProperties & { zoom?: number | string }
      }
    >
      {children}
    </div>,
    document.body,
  );
}
