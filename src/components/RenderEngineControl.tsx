// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/RenderEngineControl.tsx
// 描画エンジン (MuPDF / hayro) の切替。ThemeSwitcher と同じドロップダウン方式。
// hayro を含まないビルド (選択肢が mupdf のみ) では何も表示しない。
import { useCallback, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { changeRenderEngine, type RenderEngine, useRenderEngine } from "../lib/renderEngine";
import { FS } from "../lib/typography";
import { FloatingMenu } from "./FloatingMenu";

export function RenderEngineControl() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const { t } = useI18n();
  const { engine, available } = useRenderEngine();
  const F = "'JetBrains Mono','Noto Sans JP',monospace";

  const handlePick = useCallback((id: RenderEngine) => {
    setOpen(false);
    void changeRenderEngine(id).catch(() => {});
  }, []);

  if (available.length < 2) return null;

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
        title={t("render_engine.title")}
        aria-label={t("render_engine.title")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span>{t("render_engine.short")}</span>
        <span>{t(`render_engine.${engine}`)}</span>
        <span style={{ fontSize: 10, color: "var(--c-textDim)" }}>▾</span>
      </button>

      <FloatingMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef}>
        <div style={{ minWidth: 240 }}>
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
            {t("render_engine.title")}
          </div>
          {available.map((id) => (
            <button
              type="button"
              key={id}
              onClick={() => handlePick(id)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 2,
                width: "100%",
                padding: "10px 14px",
                background: id === engine ? "var(--c-accentBg)" : "transparent",
                border: "none",
                borderBottom: "1px solid var(--c-border)",
                cursor: "pointer",
                fontFamily: F,
                textAlign: "left" as const,
              }}
            >
              <span
                style={{
                  fontSize: FS.body,
                  color: id === engine ? "var(--c-accent)" : "var(--c-text)",
                  fontWeight: id === engine ? 700 : 400,
                }}
              >
                {id === engine ? "✓ " : ""}
                {t(`render_engine.${id}`)}
              </span>
              <span style={{ fontSize: FS.caption, color: "var(--c-textDim)" }}>
                {t(`render_engine.${id}_desc`)}
              </span>
            </button>
          ))}
        </div>
      </FloatingMenu>
    </>
  );
}
