// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/FontScaleControl.tsx
//
// アプリ全体の表示サイズを調整するコントロール。
// ThemeSwitcher / A11yControls の隣に配置することを想定。
//
// クリックでポップオーバーを開き、スライダー・[−]/[＋]・リセットで
// 80%〜150% を 5% 刻みで調整する。値は localStorage に永続化され、
// #root 要素の zoom として即時反映される（レイアウト比率は維持）。

import { useCallback, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { F } from "../lib/theme";
import { FS } from "../lib/typography";
import {
  clampUiScale,
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP,
} from "../lib/uiScale";
import { FloatingMenu } from "./FloatingMenu";

interface Props {
  scale: number; // 現在の表示倍率(%)
  onChange: (pct: number) => void;
}

export function FontScaleControl({ scale, onChange }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const setClamped = useCallback((pct: number) => onChange(clampUiScale(pct)), [onChange]);
  const dec = useCallback(() => setClamped(scale - UI_SCALE_STEP), [scale, setClamped]);
  const inc = useCallback(() => setClamped(scale + UI_SCALE_STEP), [scale, setClamped]);
  const reset = useCallback(() => setClamped(UI_SCALE_DEFAULT), [setClamped]);

  const btnStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 10px",
    background: "var(--c-bg)",
    border: "1px solid var(--c-borderHi)",
    borderRadius: 7,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontFamily: F,
    fontSize: FS.small,
    flexShrink: 0,
  };

  const stepBtn: React.CSSProperties = {
    width: 26,
    height: 26,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--c-bg)",
    border: "1px solid var(--c-borderHi)",
    borderRadius: 6,
    color: "var(--c-text)",
    cursor: "pointer",
    fontFamily: F,
    fontSize: FS.subtitle,
    lineHeight: 1,
    flexShrink: 0,
  };

  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        onClick={() => setOpen((v) => !v)}
        style={btnStyle}
        aria-label={t("fontscale.select_aria")}
        title={t("fontscale.select_title")}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span style={{ fontSize: FS.label }}>🔎</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{scale}%</span>
        <span style={{ fontSize: 10, color: "var(--c-textDim)" }}>▾</span>
      </button>

      <FloatingMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef}>
        <div role="dialog" aria-label={t("fontscale.select_title")} style={{ minWidth: 230 }}>
          <div
            style={{
              fontSize: FS.caption,
              color: "var(--c-textDim)",
              letterSpacing: "0.1em",
              marginBottom: 10,
            }}
          >
            {t("fontscale.label")}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              style={stepBtn}
              onClick={dec}
              disabled={scale <= UI_SCALE_MIN}
              aria-label={t("fontscale.decrease")}
              title={t("fontscale.decrease")}
            >
              −
            </button>
            <input
              type="range"
              min={UI_SCALE_MIN}
              max={UI_SCALE_MAX}
              step={UI_SCALE_STEP}
              value={scale}
              onChange={(e) => setClamped(Number(e.target.value))}
              aria-label={t("fontscale.label")}
              aria-valuetext={`${scale}%`}
              style={{ flex: 1, accentColor: "var(--c-accent)", cursor: "pointer" }}
            />
            <button
              type="button"
              style={stepBtn}
              onClick={inc}
              disabled={scale >= UI_SCALE_MAX}
              aria-label={t("fontscale.increase")}
              title={t("fontscale.increase")}
            >
              ＋
            </button>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 10,
            }}
          >
            <span
              style={{
                fontSize: FS.subtitle,
                fontWeight: 700,
                color: "var(--c-accent)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {scale}%
            </span>
            <button
              type="button"
              onClick={reset}
              disabled={scale === UI_SCALE_DEFAULT}
              style={{
                padding: "3px 10px",
                background: "transparent",
                border: "1px solid var(--c-border)",
                borderRadius: 6,
                color: "var(--c-textSub)",
                cursor: scale === UI_SCALE_DEFAULT ? "default" : "pointer",
                opacity: scale === UI_SCALE_DEFAULT ? 0.45 : 1,
                fontFamily: F,
                fontSize: FS.small,
              }}
            >
              {t("fontscale.reset")}
            </button>
          </div>
        </div>
      </FloatingMenu>
    </>
  );
}
