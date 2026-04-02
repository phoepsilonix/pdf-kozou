// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/ThemeSwitcher.tsx
import { useState, useCallback } from "react";
//import { THEMES, getTheme, type ThemeId } from "../lib/themes";
import { THEMES, type ThemeId } from "../lib/themes";
import { useI18n } from "../lib/i18n";

interface Props {
  currentId: ThemeId;
  onChange: (id: ThemeId) => void;
}

export function ThemeSwitcher({ currentId, onChange }: Props) {
  const [open, setOpen] = useState(false);
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
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 12px",
          background: "transparent",
          border: `1px solid var(--c-borderHi)`,
          borderRadius: 7,
          color: "var(--c-textSub)",
          cursor: "pointer",
          fontFamily: F,
          fontSize: 12,
          transition: "all 0.12s",
        }}
        title={t("theme.switcher_title")}
      >
        <span style={{ fontSize: 15 }}>{cur.emoji}</span>
        <span>{cur.name}</span>
        <span style={{ fontSize: 10, color: "var(--c-textDim)" }}>▾</span>
      </button>

      {open && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999 }}
            onClick={() => setOpen(false)}
          />
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              right: 0,
              zIndex: 1000,
              background: "var(--c-bgCard)",
              border: `1px solid var(--c-border)`,
              borderRadius: 10,
              boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
              overflow: "hidden",
              minWidth: 190,
            }}
          >
            <div
              style={{
                padding: "8px 14px",
                fontSize: 11,
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
                  {[theme.bg, theme.bgCard, theme.accent].map((col, i) => (
                    <div
                      key={i}
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
                <span style={{ fontSize: 14 }}>{theme.emoji}</span>
                <span
                  style={{
                    fontSize: 13,
                    color: theme.id === currentId ? "var(--c-accent)" : "var(--c-text)",
                    fontWeight: theme.id === currentId ? 700 : 400,
                  }}
                >
                  {t(`theme.${theme.id}`)}
                </span>
                {theme.id === currentId && (
                  <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--c-accent)" }}>
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
