// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/ThemeSwitcher.tsx
import { useCallback, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
//import { THEMES, getTheme, type ThemeId } from "../lib/themes";
import { THEMES, type ThemeId } from "../lib/themes";
import { FS } from "../lib/typography";
import { FloatingMenu } from "./FloatingMenu";

interface Props {
  currentId: ThemeId;
  onChange: (id: ThemeId) => void;
}

export function ThemeSwitcher({ currentId, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const { t } = useI18n();
  //const C = getTheme();
  const F = "'JetBrains Mono','Noto Sans JP',monospace";
  const cur = THEMES[currentId];

  const handlePick = useCallback(
    (id: ThemeId) => {
      onChange(id);
      setOpen(false);
    },
    [onChange],
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
          border: `1px solid var(--c-borderHi)`,
          borderRadius: 7,
          color: "var(--c-textSub)",
          cursor: "pointer",
          fontFamily: F,
          fontSize: FS.small,
          transition: "all 0.12s",
        }}
        title={t("theme.switcher_title")}
      >
        <span style={{ fontSize: FS.label }}>{cur.emoji}</span>
        <span>{t(`theme.${cur.id}`)}</span>
        <span style={{ fontSize: 10, color: "var(--c-textDim)" }}>▾</span>
      </button>

      <FloatingMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef}>
        <div style={{ minWidth: 190 }}>
          <div
            style={{
              padding: "8px 14px",
              fontSize: FS.caption,
              color: "var(--c-textDim)",
              letterSpacing: "0.1em",
              borderBottom: `1px solid var(--c-border)`,
              background: "var(--c-bgHover)",
            }}
          >
            {t("theme.switcher_label")}
          </div>
          {(Object.values(THEMES) as Array<(typeof THEMES)[ThemeId]>).map((theme) => (
            <button
              type="button"
              key={theme.id}
              onClick={() => handlePick(theme.id as ThemeId)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "10px 14px",
                background: theme.id === currentId ? "var(--c-accentBg)" : "transparent",
                border: "none",
                borderBottom: `1px solid var(--c-border)`,
                cursor: "pointer",
                fontFamily: F,
                textAlign: "left" as const,
                transition: "background 0.08s",
              }}
            >
              {/* カラースウォッチ */}
              <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                {(
                  [
                    ["bg", theme.bg],
                    ["bgCard", theme.bgCard],
                    ["accent", theme.accent],
                  ] as const
                ).map(([label, col]) => (
                  <div
                    key={label}
                    style={{
                      width: 11,
                      height: 11,
                      borderRadius: "50%",
                      background: col,
                      border: `1px solid ${theme.borderHi}`,
                    }}
                  />
                ))}
              </div>
              <span style={{ fontSize: FS.label }}>{theme.emoji}</span>
              <span
                style={{
                  fontSize: FS.body,
                  color: theme.id === currentId ? "var(--c-accent)" : "var(--c-text)",
                  fontWeight: theme.id === currentId ? 700 : 400,
                }}
              >
                {t(`theme.${theme.id}`)}
              </span>
              {theme.id === currentId && (
                <span style={{ marginLeft: "auto", fontSize: FS.body, color: "var(--c-accent)" }}>
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      </FloatingMenu>
    </>
  );
}
