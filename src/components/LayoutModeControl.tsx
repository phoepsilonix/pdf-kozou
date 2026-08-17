// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/LayoutModeControl.tsx
//
// 設定/プレビューを「横並び」にするか「縦積み」にするかを手動で強制するための
// コントロール。既定は "auto"（画面幅で自動判定）。
// デスクトップの min-width 制約や、実機・ウィンドウマネージャによっては
// 自動判定だけでは意図した幅を検出できないことがあるため、手動切り替えの
// 逃げ道として用意している。

import { useCallback, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { FS } from "../lib/typography";
import { FloatingMenu } from "./FloatingMenu";

export type LayoutMode = "auto" | "narrow" | "wide";

interface Props {
  mode: LayoutMode;
  onChange: (mode: LayoutMode) => void;
  floatingNarrow: boolean;
  floatingWide: boolean;
  onFloatingNarrowChange: (v: boolean) => void;
  onFloatingWideChange: (v: boolean) => void;
}

const F = "'JetBrains Mono','Noto Sans JP',monospace";

export function LayoutModeControl({
  mode,
  onChange,
  floatingNarrow,
  floatingWide,
  onFloatingNarrowChange,
  onFloatingWideChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const { t } = useI18n();

  const handlePick = useCallback(
    (m: LayoutMode) => {
      onChange(m);
      setOpen(false);
    },
    [onChange],
  );

  const icon = mode === "narrow" ? "📱" : mode === "wide" ? "🖥️" : "🔁";

  const toggleRow = (label: string, value: boolean, onSet: (v: boolean) => void) => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "8px 14px",
      }}
    >
      <span style={{ fontSize: FS.body, color: "var(--c-text)" }}>{label}</span>
      <div style={{ display: "flex", gap: 4 }}>
        <button
          type="button"
          onClick={() => onSet(false)}
          aria-pressed={!value}
          style={{
            padding: "2px 8px",
            fontSize: FS.caption,
            borderRadius: 4,
            cursor: "pointer",
            border: "1px solid var(--c-borderHi)",
            background: !value ? "var(--c-accentBg)" : "transparent",
            color: !value ? "var(--c-accent)" : "var(--c-textSub)",
            fontWeight: !value ? 700 : 400,
            fontFamily: F,
          }}
        >
          {t("layout.floating_off")}
        </button>
        <button
          type="button"
          onClick={() => onSet(true)}
          aria-pressed={value}
          style={{
            padding: "2px 8px",
            fontSize: FS.caption,
            borderRadius: 4,
            cursor: "pointer",
            border: "1px solid var(--c-borderHi)",
            background: value ? "var(--c-accentBg)" : "transparent",
            color: value ? "var(--c-accent)" : "var(--c-textSub)",
            fontWeight: value ? 700 : 400,
            fontFamily: F,
          }}
        >
          {t("layout.floating_on")}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 12px",
          background: "var(--c-bg)",
          border: "1px solid var(--c-borderHi)",
          borderRadius: 7,
          color: "var(--c-textSub)",
          cursor: "pointer",
          fontFamily: F,
          fontSize: FS.small,
          transition: "all 0.12s",
        }}
        title={t("layout.switcher_title")}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span style={{ fontSize: FS.label }}>{icon}</span>
        <span>{t(`layout.mode_${mode}`)}</span>
        <span style={{ fontSize: 10, color: "var(--c-textDim)" }}>▾</span>
      </button>

      <FloatingMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef}>
        <div role="dialog" aria-label={t("layout.switcher_title")} style={{ minWidth: 210 }}>
          <div
            style={{
              padding: "8px 14px",
              fontSize: FS.caption,
              color: "var(--c-textDim)",
              letterSpacing: "0.1em",
              borderBottom: "1px solid var(--c-border)",
              background: "var(--c-bgHover)",
            }}
          >
            {t("layout.switcher_label")}
          </div>
          {(["auto", "narrow", "wide"] as LayoutMode[]).map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => handlePick(m)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "10px 14px",
                background: m === mode ? "var(--c-accentBg)" : "transparent",
                border: "none",
                borderBottom: "1px solid var(--c-border)",
                cursor: "pointer",
                fontFamily: F,
                textAlign: "left" as const,
                transition: "background 0.08s",
              }}
            >
              <span style={{ fontSize: FS.label }}>
                {m === "narrow" ? "📱" : m === "wide" ? "🖥️" : "🔁"}
              </span>
              <span
                style={{
                  fontSize: FS.body,
                  color: m === mode ? "var(--c-accent)" : "var(--c-text)",
                  fontWeight: m === mode ? 700 : 400,
                }}
              >
                {t(`layout.mode_${m}`)}
              </span>
              {m === mode && (
                <span style={{ marginLeft: "auto", fontSize: FS.body, color: "var(--c-accent)" }}>
                  ✓
                </span>
              )}
            </button>
          ))}

          <div
            style={{
              padding: "8px 14px 4px",
              fontSize: FS.caption,
              color: "var(--c-textDim)",
              letterSpacing: "0.1em",
              borderTop: "1px solid var(--c-border)",
              borderBottom: "1px solid var(--c-border)",
              background: "var(--c-bgHover)",
              marginTop: 4,
            }}
          >
            {t("layout.floating_section")}
          </div>
          {toggleRow(t("layout.floating_narrow"), floatingNarrow, onFloatingNarrowChange)}
          {toggleRow(t("layout.floating_wide"), floatingWide, onFloatingWideChange)}
        </div>
      </FloatingMenu>
    </>
  );
}
