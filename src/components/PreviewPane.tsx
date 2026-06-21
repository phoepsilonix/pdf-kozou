// src/components/PreviewPane.tsx
// 機能ページのプレビューエリアをラップする共通コンポーネント。
// ヘッダー右端にトグルボタンを置き、非表示時はプレースホルダーを表示する。
// サムネイル読み込みの停止は呼び元側で enabled を見て制御する。

import type { CSSProperties, ReactNode } from "react";
import { useI18n } from "../lib/i18n";
import { usePreview } from "../hooks/usePreview";

interface PreviewPaneProps {
  pageKey: string;
  label: string;
  children: ReactNode;
}

export function PreviewPane({ pageKey, label, children }: PreviewPaneProps) {
  const { t } = useI18n();
  const { enabled, toggle } = usePreview(pageKey);

  return (
    <div style={s.root}>
      <div style={s.head}>
        <span style={s.headLabel}>{label}</span>
        <button
          style={s.toggleBtn}
          onClick={toggle}
          title={enabled ? t("preview.hide") : t("preview.show")}
        >
          {enabled ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
              <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          )}
          <span>{enabled ? t("preview.hide") : t("preview.show")}</span>
        </button>
      </div>

      {enabled ? (
        <div style={s.body}>{children}</div>
      ) : (
        <div style={s.placeholder}>
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: "var(--c-textDim)" }}
          >
            <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
          <span style={s.placeholderText}>{t("preview.hidden_note")}</span>
          <button style={s.showBtn} onClick={toggle}>
            {t("preview.show")}
          </button>
        </div>
      )}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    overflow: "hidden",
    // flex 子がスクロール可能になる必須設定（無いと内容の高さまで膨らみクリップされる）
    minHeight: 0,
    minWidth: 0,
  },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 16px",
    fontSize: 12,
    color: "var(--c-textSub)",
    borderBottom: "1px solid var(--c-border)",
    flexShrink: 0,
    letterSpacing: "0.04em",
    gap: 8,
  },
  headLabel: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  toggleBtn: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "3px 8px",
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-border)",
    borderRadius: 5,
    cursor: "pointer",
    fontSize: 11,
    color: "var(--c-textSub)",
    fontFamily: "inherit",
    flexShrink: 0,
    whiteSpace: "nowrap",
  },
  body: {
    flex: 1,
    overflow: "auto",
    display: "flex",
    flexDirection: "column",
    // flex 子がスクロール可能になる必須設定
    minHeight: 0,
  },
  placeholder: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  placeholderText: {
    fontSize: 12,
    color: "var(--c-textDim)",
  },
  showBtn: {
    marginTop: 4,
    padding: "5px 14px",
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-border)",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 12,
    color: "var(--c-textSub)",
    fontFamily: "inherit",
  },
};
