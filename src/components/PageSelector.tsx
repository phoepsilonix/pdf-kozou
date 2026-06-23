// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------
import { useI18n } from "../lib/i18n";
import { FS } from "../lib/typography";

// src/components/PageSelector.tsx — 共通ページ範囲指定コンポーネント
// 対応表記: "1-3,5,7-", "odd", "even", "-5" (末尾から5ページ), "all"

import { useState, useCallback } from "react";
//import { getTheme } from "../lib/themes";

export interface PageSelectorProps {
  totalPages: number;
  value: string; // "" = 全ページ
  onChange: (v: string) => void;
  label?: string;
  type?: string;
  compact?: boolean;
  rangeInputRef?: React.RefObject<HTMLInputElement | null>;
}

type Mode = "" | "all" | "odd" | "even" | "range";

function modeOf(v: string): Mode {
  if (!v || v === "" || v === "all") return "all";
  if (v === "odd") return "odd";
  if (v === "even") return "even";
  return "range";
}

function modeOf2(v: string): Mode {
  if (!v || v === "") return "";
  if (v === "odd") return "odd";
  if (v === "even") return "even";
  if (v === "all") return "all";
  return "range";
}

export function PageSelector({
  totalPages,
  value,
  onChange,
  label,
  type,
  compact,
  rangeInputRef,
}: PageSelectorProps) {
  const { t } = useI18n();
  //const C = getTheme();
  const F = "'JetBrains Mono','Noto Sans JP',monospace";
  let mode;
  if (type === "1") {
    mode = modeOf(value);
  } else {
    mode = modeOf2(value);
  }

  const [rangeText, setRangeText] = useState(mode === "range" ? value : "");
  let handleMode;
  if (type === "1") {
    handleMode = useCallback(
      (m: Mode) => {
        if (m === "") {
          onChange("all");
        }
        if (m === "all") {
          onChange("all");
        }
        if (m === "odd") {
          onChange("odd");
        }
        if (m === "even") {
          onChange("even");
        }
        if (m === "range") {
          onChange(rangeText || "1");
        }
      },
      [rangeText, onChange],
    );
  } else {
    handleMode = useCallback(
      (m: Mode) => {
        if (m === "") {
          onChange("");
        }
        if (m === "all") {
          onChange("all");
        }
        if (m === "odd") {
          onChange("odd");
        }
        if (m === "even") {
          onChange("even");
        }
        if (m === "range") {
          onChange(rangeText || "1");
        }
      },
      [rangeText, onChange],
    );
  }
  const handleRange = useCallback(
    (v: string) => {
      setRangeText(v);
      onChange(v);
    },
    [onChange],
  );

  const btnBase: React.CSSProperties = {
    padding: compact ? "4px 10px" : "5px 13px",
    border: `1px solid var(--c-border)`,
    borderRadius: 6,
    cursor: "pointer",
    fontFamily: F,
    fontSize: compact ? 12 : 13,
    transition: "all 0.1s",
    background: "var(--c-bgCard)",
    color: "var(--c-textSub)",
  };
  const btnOn: React.CSSProperties = {
    ...btnBase,
    background: "var(--c-accentBg)",
    border: `1px solid var(--c-accentBd)`,
    color: "var(--c-accent)",
    fontWeight: 700,
  };
  // 読み上げ用のグループ名（label から末尾の "(all/even/odd/...)" を除いた部分）。
  // これを各選択肢の前に付けて、どの指定（適用/除外/抽出など）の選択かを分かるようにする。
  const groupName = (label ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  const ariaFor = (modeLabel: string) => (groupName ? `${groupName} ${modeLabel}` : modeLabel);
  const rangeAria = groupName ? `${groupName} ${t("aria.range_input")}` : t("aria.range_input");
  if (type === "1") {
    const modeLabel1 = (m: Mode) =>
      m === "all"
        ? t("page_selector.all")
        : m === "odd"
          ? t("page_selector.odd")
          : m === "even"
            ? t("page_selector.even")
            : t("page_selector.range");
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: compact ? 4 : 6 }}>
        {label && (
          <span
            style={{
              fontSize: FS.caption,
              color: "var(--c-textDim)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            {label}
          </span>
        )}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
          {(["all", "odd", "even", "range"] as Mode[]).map((m) => (
            <button
              key={m}
              style={mode === m ? btnOn : btnBase}
              onClick={() => handleMode(m)}
              aria-label={ariaFor(modeLabel1(m))}
              aria-pressed={mode === m}
            >
              {modeLabel1(m)}
            </button>
          ))}
        </div>
        {mode === "range" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <input
              ref={rangeInputRef}
              data-range-input
              aria-label={rangeAria}
              value={rangeText}
              onChange={(e) => handleRange(e.target.value)}
              placeholder={t("page_selector.placeholder")}
              style={{
                padding: "6px 10px",
                background: "var(--c-bgCard)",
                border: `1px solid var(--c-borderHi)`,
                borderRadius: 6,
                color: "var(--c-text)",
                fontSize: FS.subtitle,
                height: 36,
                fontFamily: F,
                width: "100%",
                boxSizing: "border-box",
              }}
            />
            <span style={{ fontSize: FS.caption, color: "var(--c-textDim)", lineHeight: 1.5 }}>
              書式: <code style={{ color: "var(--c-textSub)" }}>1-3,5,8-</code>{" "}
              {t("page_selector.hint")}
            </span>
          </div>
        )}
        {totalPages > 0 && (
          <span style={{ fontSize: FS.caption, color: "var(--c-textDim)" }}>
            {t("page_selector.total", { total: String(totalPages) })}
            {value && value !== "all" && t("page_selector.specified", { value })}
          </span>
        )}
      </div>
    );
  } else {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: compact ? 4 : 6 }}>
        {label && (
          <span
            style={{
              fontSize: FS.caption,
              color: "var(--c-textDim)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            {label}
          </span>
        )}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
          {(["", "odd", "even", "all", "range"] as Mode[]).map((m) => {
            const modeLabel =
              m === ""
                ? t("page_selector.exclude_none")
                : m === "odd"
                  ? t("page_selector.odd")
                  : m === "even"
                    ? t("page_selector.even")
                    : m === "all"
                      ? t("page_selector.all")
                      : t("page_selector.range");
            return (
              <button
                key={m}
                style={mode === m ? btnOn : btnBase}
                onClick={() => handleMode(m)}
                aria-label={ariaFor(modeLabel)}
                aria-pressed={mode === m}
              >
                {modeLabel}
              </button>
            );
          })}
        </div>
        {mode === "range" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <input
              ref={rangeInputRef}
              data-range-input
              aria-label={rangeAria}
              value={rangeText}
              onChange={(e) => handleRange(e.target.value)}
              placeholder={t("page_selector.placeholder")}
              style={{
                padding: "6px 10px",
                background: "var(--c-bgCard)",
                border: `1px solid var(--c-borderHi)`,
                borderRadius: 6,
                color: "var(--c-text)",
                fontSize: FS.body,
                fontFamily: F,
                width: "100%",
                boxSizing: "border-box",
              }}
            />
            <span style={{ fontSize: FS.caption, color: "var(--c-textDim)", lineHeight: 1.5 }}>
              書式: <code style={{ color: "var(--c-textSub)" }}>1-3,5,8-</code>{" "}
              {t("page_selector.hint")}
            </span>
          </div>
        )}
        {totalPages > 0 && (
          <span style={{ fontSize: FS.caption, color: "var(--c-textDim)" }}>
            {t("page_selector.total", { total: String(totalPages) })}
            {value && value !== "all" && t("page_selector.specified", { value })}
          </span>
        )}
      </div>
    );
  }
}

// ページ指定文字列を実際のページインデックス配列に展開
export function resolvePageSpec(spec: string, total: number): number[] {
  if (!spec || spec === "all") return Array.from({ length: total }, (_, i) => i);
  if (spec === "odd")
    return Array.from({ length: total }, (_, i) => i).filter((i) => (i + 1) % 2 === 1);
  if (spec === "even")
    return Array.from({ length: total }, (_, i) => i).filter((i) => (i + 1) % 2 === 0);

  // 除外ページを収集: ^N
  const excluded = new Set<number>();
  const parts = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const included: number[] = [];

  for (const part of parts) {
    if (part.startsWith("^")) {
      const n = parseInt(part.slice(1));
      if (!isNaN(n) && n >= 1 && n <= total) excluded.add(n - 1);
      continue;
    }
    if (part.includes("-")) {
      const [a, b] = part.split("-");
      const from = a ? parseInt(a) - 1 : 0;
      const to = b ? parseInt(b) - 1 : total - 1;
      for (let i = Math.max(0, from); i <= Math.min(total - 1, to); i++) included.push(i);
    } else {
      const n = parseInt(part) - 1;
      if (!isNaN(n) && n >= 0 && n < total) included.push(n);
    }
  }
  // 重複除去 + 除外適用
  return [...new Set(included)].filter((i) => !excluded.has(i)).sort((a, b) => a - b);
}
