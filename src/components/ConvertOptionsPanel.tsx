// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------
// src/components/ConvertOptionsPanel.tsx
//
// リフロー可能文書（DOCX/EPUB/HTML）変換時のレイアウト設定パネル。
// 非 PDF ファイルが含まれる場合にのみ表示する。

import React, { useState, useEffect, useRef, useCallback } from "react";
import type { ConvertOptions } from "../lib/tauri";
import { useI18n } from "../lib/i18n";

export interface ConvertOptionsPanelProps {
  options: ConvertOptions;
  onChange: (opts: ConvertOptions) => void;
}

// A4: 595 x 842 pt, A5: 420 x 595 pt, US Letter: 612 x 792 pt
// ラベルは翻訳不要（サイズ表記は世界共通）
const PRESETS: { label: string; w: number; h: number }[] = [
  { label: "mutool default (450×600)", w: 450, h: 600 },
  { label: "A4 (595×842)", w: 595, h: 842 },
  { label: "A5 (420×595)", w: 420, h: 595 },
  { label: "US Letter (612×792)", w: 612, h: 792 },
];

const DEBOUNCE_MS = 600; // 数値入力確定までの待機時間

export function ConvertOptionsPanel({ options, onChange }: ConvertOptionsPanelProps) {
  const { t } = useI18n();
  // 内部 state で入力中の値を保持（props と分離）
  const [localW, setLocalW] = useState(options.layoutW ?? 450);
  const [localH, setLocalH] = useState(options.layoutH ?? 600);
  const [localEm, setLocalEm] = useState(options.layoutEm ?? 12);

  // props が外部から変わった場合（初期化時など）に同期
  const prevOptions = useRef(options);
  useEffect(() => {
    if (
      options.layoutW !== prevOptions.current.layoutW ||
      options.layoutH !== prevOptions.current.layoutH ||
      options.layoutEm !== prevOptions.current.layoutEm
    ) {
      setLocalW(options.layoutW ?? 450);
      setLocalH(options.layoutH ?? 600);
      setLocalEm(options.layoutEm ?? 12);
      prevOptions.current = options;
    }
  }, [options]);

  // debounce タイマー
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const emitDebounced = useCallback(
    (w: number, h: number, em: number) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        onChange({ layoutW: w, layoutH: h, layoutEm: em });
      }, DEBOUNCE_MS);
    },
    [onChange],
  );

  // プリセット選択は即時反映（debounce なし）
  const applyPreset = (idx: number) => {
    const p = PRESETS[idx];
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    setLocalW(p.w);
    setLocalH(p.h);
    onChange({ layoutW: p.w, layoutH: p.h, layoutEm: localEm });
  };

  const matchedPreset = PRESETS.findIndex((p) => p.w === localW && p.h === localH);

  return (
    <div style={s.panel}>
      <div style={s.header}>
        {t("convert_options.panel_title")}
        <span style={s.hint}>{t("convert_options.hint")}</span>
      </div>

      {/* プリセット選択 */}
      <div style={s.row}>
        <label style={s.label}>{t("convert_options.preset_label")}</label>
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
          {matchedPreset < 0 && <option value="custom">{t("convert_options.custom")}</option>}
        </select>
      </div>

      {/* 幅 / 高さ / em — 入力中は内部 state のみ更新、確定後に onChange */}
      <div style={s.row}>
        <label style={s.label}>{t("convert_options.width_pt")}</label>
        <input
          type="number"
          style={s.numInput}
          min={100}
          max={2000}
          step={1}
          value={localW}
          onChange={(e) => {
            const v = Number(e.target.value);
            setLocalW(v);
            emitDebounced(v, localH, localEm);
          }}
        />
        <label style={{ ...s.label, marginLeft: 12 }}>{t("convert_options.height_pt")}</label>
        <input
          type="number"
          style={s.numInput}
          min={100}
          max={2000}
          step={1}
          value={localH}
          onChange={(e) => {
            const v = Number(e.target.value);
            setLocalH(v);
            emitDebounced(localW, v, localEm);
          }}
        />
        <label style={{ ...s.label, marginLeft: 12 }}>{t("convert_options.font_pt")}</label>
        <input
          type="number"
          style={s.numInput}
          min={6}
          max={72}
          step={0.5}
          value={localEm}
          onChange={(e) => {
            const v = Number(e.target.value);
            setLocalEm(v);
            emitDebounced(localW, localH, v);
          }}
        />
      </div>

      <div style={s.note}>{t("convert_options.note")}</div>
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
