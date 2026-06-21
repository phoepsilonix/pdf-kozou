// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/trim/TrimControls.tsx
// 余白指定パネル: 上下左右それぞれ「何mm削るか」を指定 + ページ範囲/抽出

import { useCallback } from "react";
import type { TrimMargins, PageSelection } from "../../lib/tauri";
import { PageSelector, resolvePageSpec } from "../PageSelector";
import { PageSizeSelector } from "../PageSizeSelector";
import { F } from "../../lib/theme";
import { FS } from "../../lib/typography";
import { useI18n } from "../../lib/i18n";
import { tts } from "../../lib/tts";

interface Props {
  margins: TrimMargins;
  pageW: number;
  pageH: number;
  trimPages: string;
  onPages: (v: string) => void;
  totalPages: number;
  onMargins: (m: TrimMargins) => void;
  onApply: () => void;
  onReset: () => void;
  processing: boolean;
  applyLabel?: string;
  cropCleanup?: boolean;
  onCropCleanupChange?: (v: boolean) => void;
  // バッチ用: 出力フォルダ選択
  outDir?: string;
  onPickDir?: () => void;
  // ページ除外指定 (トリミング除外対象)
  excludeSpec: string;
  onExclude: (v: string) => void;
  // ページ抽出 (出力に含めるページ)
  extractSpec: string;
  onExtract: (v: string) => void;
  topInputRef?: React.RefObject<HTMLInputElement | null>;
  rangeInputRef?: React.RefObject<HTMLInputElement | null>;
  /** 画像入力があるとき、画像用ページサイズ指定を表示する */
  showImagePageSize?: boolean;
}

const PT_TO_MM = 1 / 2.8346;
const MM_TO_PT = 2.8346;
const toMm = (pt: number) => +(pt * PT_TO_MM).toFixed(1);
const toPt = (mm: number) => mm * MM_TO_PT;

export function TrimControls({
  margins,
  pageW,
  pageH,
  trimPages,
  totalPages,
  onMargins,
  onPages,
  onApply,
  onReset,
  processing,
  applyLabel,
  cropCleanup = false,
  onCropCleanupChange,
  outDir,
  onPickDir,
  excludeSpec,
  onExclude,
  extractSpec,
  onExtract,
  topInputRef,
  rangeInputRef,
  showImagePageSize = false,
}: Props & {
  topInputRef?: React.RefObject<HTMLInputElement | null>;
  rangeInputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const { t } = useI18n();
  const set = useCallback(
    (key: keyof TrimMargins, mm: number) => {
      onMargins({ ...margins, [key]: toPt(Math.max(0, mm)) });
    },
    [margins, onMargins],
  );

  const trimW = toMm(pageW - margins.left - margins.right);
  const trimH = toMm(pageH - margins.top - margins.bottom);
  const origW = toMm(pageW);
  const origH = toMm(pageH);

  return (
    <div style={s.panel}>
      <div style={s.scrollBody}>
        {showImagePageSize && (
          <section style={s.section}>
            <PageSizeSelector compact />
          </section>
        )}
        <section style={s.section}>
          <h3 style={s.heading}>{t("trim_controls.margin_heading")}</h3>
          <div style={s.cross}>
            <div style={s.crossTop}>
              <MmField
                id="trim-margin-top"
                label={t("trim_controls.top")}
                value={toMm(margins.top)}
                max={toMm(pageH - margins.bottom - MM_TO_PT)}
                onChange={(v) => set("top", v)}
                ariaLabel={t("aria.margin_top")}
                inputRef={topInputRef}
              />
            </div>
            <div style={s.crossMid}>
              <MmField
                id="trim-margin-left"
                label={t("trim_controls.left")}
                value={toMm(margins.left)}
                max={toMm(pageW - margins.right - MM_TO_PT)}
                onChange={(v) => set("left", v)}
                ariaLabel={t("aria.margin_left")}
              />
              <div style={s.pageBox}>
                <span style={s.pageSize}>
                  {origW} × {origH}
                </span>
                <span style={s.pageUnit}>{t("trim_controls.margin_original")}</span>
                <span style={s.arrow}>↓</span>
                <span style={{ ...s.pageSize, color: "var(--c-accent)" }}>
                  {trimW} × {trimH}
                </span>
                <span style={s.pageUnit}>{t("trim_controls.margin_after")}</span>
              </div>
              <MmField
                id="trim-margin-right"
                label={t("trim_controls.right")}
                value={toMm(margins.right)}
                max={toMm(pageW - margins.left - MM_TO_PT)}
                onChange={(v) => set("right", v)}
                ariaLabel={t("aria.margin_right")}
              />
            </div>
            <div style={s.crossBot}>
              <MmField
                id="trim-margin-bottom"
                label={t("trim_controls.bottom")}
                value={toMm(margins.bottom)}
                max={toMm(pageH - margins.top - MM_TO_PT)}
                onChange={(v) => set("bottom", v)}
                ariaLabel={t("aria.margin_bottom")}
              />
            </div>
          </div>
        </section>

        {/* トリミング適用ページ - PageSelector に置き換え。基本は全ページ適用。 */}
        <section style={s.section}>
          <h3 style={s.heading}>{t("trim_controls.trim_pages_heading")}</h3>
          <PageSelector
            totalPages={totalPages}
            value={trimPages}
            onChange={onPages}
            label={t("trim_controls.trim_pages_label")}
            type="1"
            compact
            rangeInputRef={rangeInputRef}
          />
        </section>
        <section style={s.section}>
          <h3 style={s.heading}>{t("trim_controls.exclude_heading")}</h3>
          <PageSelector
            totalPages={totalPages}
            value={excludeSpec}
            onChange={onExclude}
            label={t("trim_controls.exclude_label")}
            type="2"
            compact
          />
        </section>

        <section style={s.section}>
          <h3 style={s.heading}>
            {t("trim_controls.extract_heading")}{" "}
            <span style={s.headingOpt}>{t("trim_controls.extract_optional")}</span>
          </h3>
          <p style={s.hint2}>{t("trim_controls.extract_hint")}</p>
          <PageSelector
            totalPages={totalPages}
            value={extractSpec}
            onChange={onExtract}
            label={t("trim_controls.extract_label")}
            type="1"
            compact
          />
        </section>

        {/* バッチ用: 出力フォルダ選択（実行ボタンの直上に配置） */}
        {onPickDir !== undefined && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: FS.caption, color: "var(--c-textDim)", marginBottom: 4 }}>
              {t("trim_controls.output_folder")}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <div
                style={{
                  flex: 1,
                  fontSize: FS.caption,
                  color: "var(--c-text)",
                  background: "var(--c-bgSub)",
                  border: "1px solid var(--c-border)",
                  borderRadius: 4,
                  padding: "4px 8px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {outDir || t("trim_controls.not_selected")}
              </div>
              <button
                type="button"
                style={{
                  fontSize: FS.caption,
                  padding: "4px 10px",
                  background: "var(--c-bgCard)",
                  border: "1px solid var(--c-border)",
                  borderRadius: 4,
                  cursor: "pointer",
                  color: "var(--c-text)",
                  whiteSpace: "nowrap",
                }}
                onClick={onPickDir}
                disabled={processing}
                aria-label={t("aria.output_dir_btn")}
              >
                {t("trim_controls.select_btn")}
              </button>
            </div>
          </div>
        )}

        <p style={s.hint}>{t("trim_controls.drag_hint")}</p>

        {/*
	<label
          style={{
            display: "flex",
            gap: 6,
            alignItems: "flex-start",
            padding: "6px 0 2px",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={cropCleanup}
            onChange={(e) => onCropCleanupChange?.(e.target.checked)}
            style={{ marginTop: 2, flexShrink: 0 }}
          />
          <span>
            <span style={{ fontSize: FS.caption }}>{t("trim.crop_cleanup" as any)}</span>
            <span
              style={{
                display: "block",
                fontSize: FS.caption,
                color: "var(--c-textDim)",
                lineHeight: 1.4,
                marginTop: 2,
              }}
            >
              {t("trim.crop_cleanup_note" as any)}
            </span>
          </span>
        </label>
	*/}
      </div>

      {/* 下部固定の操作帯（スクロールしない・常に最下部に表示） */}
      <section style={s.actions}>
        <button
          type="button"
          style={s.btnReset}
          onClick={onReset}
          disabled={processing}
          aria-label={t("trim_controls.reset")}
        >
          {t("trim_controls.reset")}
        </button>
        <button
          type="button"
          style={{ ...s.btnApply, ...(processing ? s.btnDisabled : {}) }}
          onClick={!outDir && onPickDir ? onPickDir : onApply}
          disabled={processing}
        >
          {processing ? t("trim_controls.processing") : (applyLabel ?? t("trim_controls.preview"))}
        </button>
      </section>
    </div>
  );
}

function MmField({
  label,
  value,
  max,
  onChange,
  id,
  ariaLabel,
  inputRef,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (v: number) => void;
  id?: string;
  ariaLabel?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div style={s.field}>
      <label style={s.fieldLabel} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        ref={inputRef}
        type="number"
        style={s.input}
        value={value}
        min={0}
        max={max}
        step={0.5}
        aria-label={ariaLabel ?? label}
        onFocus={() => ariaLabel && tts.speak(ariaLabel)}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
      <span style={s.unit}>mm</span>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    background: "var(--c-bgCard)",
    color: "var(--c-text)",
    fontFamily: F,
    fontSize: FS.label,
    height: "100%",
    overflow: "hidden",
  },
  scrollBody: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 18,
    padding: "18px 14px",
  },
  section: { display: "flex", flexDirection: "column", gap: 10 },
  heading: {
    margin: 0,
    fontSize: FS.caption,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--c-textDim)",
  },
  headingOpt: {
    fontSize: FS.caption,
    color: "var(--c-textDim)",
    fontWeight: 400,
    letterSpacing: 0,
    textTransform: "none",
  },
  hint2: { margin: 0, fontSize: FS.caption, color: "var(--c-textSub)", lineHeight: 1.5 },

  cross: { display: "flex", flexDirection: "column", alignItems: "center", gap: 8 },
  crossTop: { display: "flex", justifyContent: "center" },
  crossMid: { display: "flex", alignItems: "center", gap: 12 },
  crossBot: { display: "flex", justifyContent: "center" },

  pageBox: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    minWidth: 100,
  },
  pageSize: { fontSize: FS.small, color: "var(--c-textSub)" },
  pageUnit: { fontSize: FS.caption, color: "var(--c-textDim)" },
  arrow: { fontSize: FS.label, color: "var(--c-textDim)" },

  field: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
  fieldLabel: { fontSize: FS.small, color: "var(--c-textSub)", fontWeight: 600 },
  input: {
    width: 76,
    height: 42,
    padding: "4px 6px",
    boxSizing: "border-box" as const,
    background: "var(--c-bg)",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 7,
    color: "var(--c-text)",
    fontSize: FS.subtitle,
    lineHeight: "48px",
    textAlign: "center" as const,
    outline: "none",
    fontFamily: F,
    fontWeight: 700,
  },
  unit: { fontSize: FS.caption, color: "var(--c-textDim)" },

  chips: { display: "flex", gap: 6, flexWrap: "wrap" },
  chip: {
    padding: "6px 12px",
    borderRadius: 16,
    border: `1px solid var(--c-borderHi)`,
    background: "var(--c-bgCard)",
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontSize: FS.small,
    fontFamily: F,
    transition: "all 0.12s",
  },
  chipOn: {
    background: "var(--c-accentBg)",
    border: "1px solid var(--c-accentBd)",
    color: "var(--c-accent)",
  },

  actions: {
    flexShrink: 0,
    display: "flex",
    gap: 8,
    padding: "10px 14px",
    borderTop: "1px solid var(--c-border)",
    background: "var(--c-bgCard)",
  },
  btnReset: {
    padding: "10px 14px",
    background: "transparent",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 7,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontFamily: F,
    fontSize: FS.body,
  },
  btnApply: {
    flex: 1,
    padding: "10px 0",
    background: "var(--c-accentBg)",
    border: `1px solid var(--c-accentBd)`,
    borderRadius: 7,
    color: "var(--c-accent)",
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: F,
    fontSize: FS.label,
  },
  btnDisabled: { opacity: 0.4, cursor: "not-allowed" },
  hint: { margin: 0, fontSize: FS.caption, color: "var(--c-textDim)", lineHeight: 1.6 },
};
