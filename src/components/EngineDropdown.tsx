// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/EngineDropdown.tsx
// エンジン選択用のドロップダウン (ThemeSwitcher と同じ方式)。
// 描画エンジン (RenderEngineControl) と PDF 操作エンジン (PdfBackendControl) で共用する。
import { type ReactNode, useRef, useState } from "react";
import { FS } from "../lib/typography";
import { FloatingMenu } from "./FloatingMenu";

export interface EngineOption {
  id: string;
  label: string;
  desc: string;
}

interface Props {
  /** ボタンのツールチップとメニュー見出し */
  title: string;
  /** ボタン先頭の短い見出し (例: 「描画」) */
  short: string;
  value: string;
  options: EngineOption[];
  onPick: (id: string) => void;
  /** 選んでもメニューを閉じない選択肢 (続けて値を入力させたいとき) */
  keepOpenIds?: string[];
  /** 選択肢の下に出す追加の内容 (数値入力欄など) */
  extra?: ReactNode;
}

export function EngineDropdown({
  title,
  short,
  value,
  options,
  onPick,
  keepOpenIds,
  extra,
}: Props) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const F = "'JetBrains Mono','Noto Sans JP',monospace";
  const current = options.find((o) => o.id === value);

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
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span>{short}</span>
        <span>{current?.label ?? value}</span>
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
            {title}
          </div>
          {options.map((o) => (
            <button
              type="button"
              key={o.id}
              onClick={() => {
                if (!keepOpenIds?.includes(o.id)) setOpen(false);
                onPick(o.id);
              }}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 2,
                width: "100%",
                padding: "10px 14px",
                background: o.id === value ? "var(--c-accentBg)" : "transparent",
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
                  color: o.id === value ? "var(--c-accent)" : "var(--c-text)",
                  fontWeight: o.id === value ? 700 : 400,
                }}
              >
                {o.id === value ? "✓ " : ""}
                {o.label}
              </span>
              <span style={{ fontSize: FS.caption, color: "var(--c-textDim)" }}>{o.desc}</span>
            </button>
          ))}
          {extra}
        </div>
      </FloatingMenu>
    </>
  );
}
