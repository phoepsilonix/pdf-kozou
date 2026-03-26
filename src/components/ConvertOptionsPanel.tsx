// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------
// src/components/ConvertOptionsPanel.tsx
//
// リフロー可能文書（DOCX/EPUB/HTML）変換時のレイアウト設定パネル。
// 非 PDF ファイルが含まれる場合にのみ表示する。

import React from "react";
import type { ConvertOptions } from "../lib/tauri";

export interface ConvertOptionsPanelProps {
  options: ConvertOptions;
  onChange: (opts: ConvertOptions) => void;
}

// A4: 595 x 842 pt, A5: 420 x 595 pt, US Letter: 612 x 792 pt
const PRESETS: { label: string; w: number; h: number }[] = [
  { label: "mutool デフォルト (450×600)", w: 450, h: 600 },
  { label: "A4 (595×842)", w: 595, h: 842 },
  { label: "A5 (420×595)", w: 420, h: 595 },
  { label: "US Letter (612×792)", w: 612, h: 792 },
];

export function ConvertOptionsPanel({ options, onChange }: ConvertOptionsPanelProps) {
  const w = options.layoutW ?? 450;
  const h = options.layoutH ?? 600;
  const em = options.layoutEm ?? 12;

  const set = (partial: Partial<ConvertOptions>) => onChange({ ...options, ...partial });

  const applyPreset = (idx: number) => {
    const p = PRESETS[idx];
    set({ layoutW: p.w, layoutH: p.h });
  };

  const matchedPreset = PRESETS.findIndex((p) => p.w === w && p.h === h);

  return (
    <div style={s.panel}>
      <div style={s.header}>
        📐 リフロー文書レイアウト設定
        <span style={s.hint}>DOCX / EPUB / HTML のページサイズ指定</span>
      </div>

      {/* プリセット選択 */}
      <div style={s.row}>
        <label style={s.label}>プリセット</label>
        <select
          style={s.select}
          value={matchedPreset >= 0 ? matchedPreset : "custom"}
          onChange={(e) => {
            const v = e.target.value;
            if (v !== "custom") applyPreset(Number(v));
          }}
        >
          {PRESETS.map((p, i) => (
            <option key={i} value={i}>
              {p.label}
            </option>
          ))}
          {matchedPreset < 0 && <option value="custom">カスタム</option>}
        </select>
      </div>

      {/* 幅 / 高さ / em */}
      <div style={s.row}>
        <label style={s.label}>幅 (pt)</label>
        <input
          type="number"
          style={s.numInput}
          min={100}
          max={2000}
          step={1}
          value={w}
          onChange={(e) => set({ layoutW: Number(e.target.value) })}
        />
        <label style={{ ...s.label, marginLeft: 12 }}>高さ (pt)</label>
        <input
          type="number"
          style={s.numInput}
          min={100}
          max={2000}
          step={1}
          value={h}
          onChange={(e) => set({ layoutH: Number(e.target.value) })}
        />
        <label style={{ ...s.label, marginLeft: 12 }}>フォント (pt)</label>
        <input
          type="number"
          style={s.numInput}
          min={6}
          max={72}
          step={0.5}
          value={em}
          onChange={(e) => set({ layoutEm: Number(e.target.value) })}
        />
      </div>

      <div style={s.note}>※ PDF / 画像 / CBZ などレイアウト固定の形式には影響しません</div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  panel: {
    background: "var(--c-bgSub)",
    border: "1px solid var(--c-border)",
    borderRadius: 8,
    padding: "12px 16px",
    marginTop: 8,
  },
  header: {
    fontSize: 13,
    fontWeight: 700,
    color: "var(--c-accent)",
    marginBottom: 10,
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  hint: {
    fontSize: 11,
    color: "var(--c-textDim)",
    fontWeight: 400,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
  },
  label: {
    fontSize: 12,
    color: "var(--c-textSub)",
    whiteSpace: "nowrap",
  },
  select: {
    flex: 1,
    fontSize: 12,
    padding: "3px 6px",
    borderRadius: 4,
    border: "1px solid var(--c-border)",
    background: "var(--c-bg)",
    color: "var(--c-text)",
  },
  numInput: {
    width: 64,
    fontSize: 12,
    padding: "3px 6px",
    borderRadius: 4,
    border: "1px solid var(--c-border)",
    background: "var(--c-bg)",
    color: "var(--c-text)",
    textAlign: "right" as const,
  },
  note: {
    fontSize: 11,
    color: "var(--c-textDim)",
    marginTop: 4,
  },
};
