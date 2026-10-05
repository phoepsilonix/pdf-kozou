// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/trim/TrimControls.tsx
// 余白指定パネル: 上下左右それぞれ「何mm削るか」を指定 + ページ範囲/抽出

import { useCallback } from "react";
import { useI18n } from "../../lib/i18n";
import type { TrimMargins } from "../../lib/tauri";
import { F } from "../../lib/theme";
import { FS } from "../../lib/typography";
import { NumInput } from "../NumInput";
import { PageSelector } from "../PageSelector";
import { PageSizeSelector } from "../PageSizeSelector";
import { RedactMarginSection } from "./RedactMarginSection";

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
  /** プレビュー時に redact + オブジェクトストリーム有効の標準圧縮を掛けるか */
  previewCompress?: boolean;
  onPreviewCompressChange?: (v: boolean) => void;
  /** 文言の種別。"batch" は各ファイル出力時に圧縮する旨の文言にする */
  previewCompressVariant?: "preview" | "batch";
  /** トリミング後の大きさをそのままページサイズにする（MediaBox ← CropBox） */
  resizeToCrop?: boolean;
  onResizeToCropChange?: (v: boolean) => void;
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
  /** true のとき下部の操作帯(リセット/実行ボタン)を描画しない。
   * 呼び出し側で共通の固定実行ボタンを別途用意する場合に使う。 */
  hideActionBar?: boolean;
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
  previewCompress = false,
  onPreviewCompressChange,
  previewCompressVariant = "preview",
  resizeToCrop = false,
  onResizeToCropChange,
  outDir,
  onPickDir,
  excludeSpec,
  onExclude,
  extractSpec,
  onExtract,
  topInputRef,
  rangeInputRef,
  showImagePageSize = false,
  hideActionBar = false,
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

        {/* 狭幅時はチェックボックス本体が固定ナビ側にあり説明を出せないため、
            設定パネル側に説明(redact余白が圧縮画面の設定に従う旨)を出す */}
        {hideActionBar && onPreviewCompressChange && (
          <p style={s.hint}>
            <PreviewCompressNoteText variant={previewCompressVariant} />
          </p>
        )}

        {/* トリミング後のサイズをページサイズにする。狭幅時も固定ナビには出さず、
            説明が必要なためここ（設定パネル）に常に出す */}
        {onResizeToCropChange && (
          <label
            style={{
              display: "flex",
              gap: 6,
              alignItems: "flex-start",
              cursor: processing ? "not-allowed" : "pointer",
              opacity: processing ? 0.6 : 1,
            }}
          >
            <input
              type="checkbox"
              checked={resizeToCrop}
              disabled={processing}
              onChange={(e) => onResizeToCropChange(e.target.checked)}
              style={{ marginTop: 2, flexShrink: 0 }}
            />
            <span>
              <span style={{ fontSize: FS.caption }}>{t("trim.resize_to_crop")}</span>
              <span
                style={{
                  display: "block",
                  fontSize: FS.caption,
                  color: "var(--c-textDim)",
                  lineHeight: 1.4,
                  marginTop: 2,
                }}
              >
                {t("trim.resize_to_crop_note")}
              </span>
            </span>
          </label>
        )}

        {/* 圧縮時の redact 余白。圧縮画面と共通の設定を、ここでも変更できる */}
        {onPreviewCompressChange && <RedactMarginSection disabled={!previewCompress} />}
      </div>

      {/* 下部固定の操作帯（スクロールしない・常に最下部に表示）
          hideActionBar=true のときは実行ボタンのみ非表示にする
          （呼び出し側が共通の固定実行ボタンを別途用意している場合）。
          リセットは他に導線がないため常に表示する。 */}
      <section style={s.actions}>
        {/* プレビュー時の圧縮オプション。プレビューボタンの直上に置く。
            hideActionBar 時（狭幅）は呼び出し側の固定ナビ側に同等のものを出す。 */}
        {!hideActionBar && onPreviewCompressChange && (
          <PreviewCompressOption
            checked={previewCompress}
            onChange={onPreviewCompressChange}
            disabled={processing}
            variant={previewCompressVariant}
          />
        )}
        <div style={s.actionsRow}>
          <button
            type="button"
            style={s.btnReset}
            onClick={onReset}
            disabled={processing}
            aria-label={t("trim_controls.reset")}
          >
            {t("trim_controls.reset")}
          </button>
          {!hideActionBar && (
            <button
              type="button"
              style={{ ...s.btnApply, ...(processing ? s.btnDisabled : {}) }}
              onClick={!outDir && onPickDir ? onPickDir : onApply}
              disabled={processing}
            >
              {processing
                ? t("trim_controls.processing")
                : (applyLabel ?? t("trim_controls.preview"))}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

/** 圧縮オプションの説明文 */
function PreviewCompressNoteText({ variant }: { variant: "preview" | "batch" }) {
  const { t } = useI18n();
  return <>{t(`trim.preview_compress_note${variant === "batch" ? "_batch" : ""}`)}</>;
}

/** トリミングのプレビュー時に圧縮(redact + オブジェクトストリーム)を掛けるかのチェックボックス */
export function PreviewCompressOption({
  checked,
  onChange,
  disabled,
  compact = false,
  variant = "preview",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  compact?: boolean;
  variant?: "preview" | "batch";
}) {
  const { t } = useI18n();
  const suffix = variant === "batch" ? "_batch" : "";
  return (
    <label
      style={{
        display: "flex",
        gap: 6,
        alignItems: "flex-start",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2, flexShrink: 0 }}
      />
      <span>
        <span style={{ fontSize: FS.caption }}>{t(`trim.preview_compress${suffix}`)}</span>
        {!compact && (
          <span
            style={{
              display: "block",
              fontSize: FS.caption,
              color: "var(--c-textDim)",
              lineHeight: 1.4,
              marginTop: 2,
            }}
          >
            <PreviewCompressNoteText variant={variant} />
          </span>
        )}
      </span>
    </label>
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
      <NumInput
        id={id}
        inputRef={inputRef}
        style={s.input}
        value={value}
        min={0}
        max={max}
        step={0.5}
        integer={false}
        live
        aria-label={ariaLabel ?? label}
        onChange={onChange}
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
    flexDirection: "column",
    gap: 8,
    padding: "10px 14px",
    borderTop: "1px solid var(--c-border)",
    background: "var(--c-bgCard)",
  },
  actionsRow: { display: "flex", gap: 8 },
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
