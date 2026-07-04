// src/hooks/useViewport.ts
// 画面幅（= window.innerWidth）に応じてレイアウトを切り替えるための共通フック。
// スマホ実機だけでなく、PC上でウィンドウを縦長に狭めた場合も同じ判定にするため、
// User-Agent ではなく実際のビューポート幅で判定する。
//
// 注意1: デスクトップ版は tauri.conf.json の window.minWidth によって
// ウィンドウの最小幅が制限される。この値が狭幅ブレークポイントより大きいと
// 「ウィンドウを狭めても縦積みレイアウトに切り替わらない」状態になるため、
// minWidth は NARROW_BREAKPOINT 以下に設定しておくこと。
//
// 注意2: #root には表示スケール（FontScaleControl）用に CSS の `zoom` が
// かかっている（lib/uiScale.ts）。zoom は window.innerWidth の値自体は
// 変えないが、#root 内側のレイアウトが実際に使える「CSS px」は
// window.innerWidth / scale になる（zoom=130% なら見た目上コンテンツが
// 1.3倍に拡大される＝レイアウト計算上はその分だけ狭い箱に収めようとする）。
// これを無視して window.innerWidth をそのまま閾値判定に使うと、表示スケールを
// 上げている環境では「ウィンドウ幅は768px以上あるのに実際のレイアウトは
// 768px相当より狭く描画されて崩れる／逆に縦積みに切り替わってほしいのに
// 切り替わらない」というズレが発生する。そのため常に scale で割った
// 実効幅（effective width）を使う。
//
// また、usePdfStore の layoutModeOverride で自動判定を上書きできる
// （"auto" = 幅で判定 / "narrow" = 常に縦積み / "wide" = 常に横並び）。
// 自動判定（画面/ウィンドウの実測サイズ）だけに頼らず手動切り替えも
// 用意しているのは、実機やウィンドウマネージャ・表示スケールの組み合わせに
// よっては意図した幅まで正確に検出できないことがあるため。
//
// width（実効px、上記の通り zoom 補正済み）も返している。
// align-items:center な flex コンテナの直下で width:"%" を使うと
// WebKitGTK 環境で子要素が意図しない幅に潰れる既知の事象があるため
// （App.tsx の listCard 参照）、狭幅レイアウトの幅計算ではパーセント指定を
// 避けてこの実効pxから計算したいケースがある。

import { useEffect, useState } from "react";
import { usePdfStore } from "../store/usePdfStore";
import { getUiScale } from "../lib/uiScale";

// この幅未満を「狭い画面（設定とプレビューを縦積みにする）」とみなす。
// （#root の zoom 補正後の実効px基準）
export const NARROW_BREAKPOINT = 768;

function computeEffectiveWidth(): number {
  if (typeof window === "undefined") return 1024;
  const scale = getUiScale() || 1;
  return window.innerWidth / scale;
}

export function useViewport() {
  const [width, setWidth] = useState(computeEffectiveWidth);
  const layoutModeOverride = usePdfStore((s) => s.layoutModeOverride);

  useEffect(() => {
    const onChange = () => setWidth(computeEffectiveWidth());
    window.addEventListener("resize", onChange);
    // uiScale（FontScaleControl）変更時は resize が発火しないため専用イベントで検知
    window.addEventListener("kozou-uiscale-change", onChange);
    return () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("kozou-uiscale-change", onChange);
    };
  }, []);

  const autoIsNarrow = width < NARROW_BREAKPOINT;
  const isNarrow =
    layoutModeOverride === "narrow" ? true : layoutModeOverride === "wide" ? false : autoIsNarrow;

  return { isNarrow, width, layoutModeOverride };
}
