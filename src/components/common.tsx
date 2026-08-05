// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/common.tsx — 共通 UI コンポーネント
//import { C, F } from "../lib/theme";
import { useState } from "react";
import { F } from "../lib/theme";
import { FS } from "../lib/typography";
import { useI18n } from "../lib/i18n";
import { useBusyAnnouncer } from "../hooks/useBusyAnnouncer";

/** kozou-spinner クラスと @keyframes kozou-spin の CSS 文字列。
 *  WebKitGTK / WebView2(Blink) ではインラインスタイルの animation から
 *  グローバルの @keyframes を参照できないため、スピナーを使う各箇所で
 *  <style>{SPINNER_CSS}</style> を直接埋め込む。 */
export const SPINNER_CSS = `@keyframes kozou-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}.kozou-spinner{animation:kozou-spin 1.6s ease-in-out infinite}`;

export function Spinner({ label }: { label?: string }) {
  // スピナー表示中（=処理中）に長引いたら音声で知らせる。
  useBusyAnnouncer(true, label);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        gap: 18,
        background: "var(--c-bg)",
      }}
    >
      {/* WebKitGTK では @keyframes をインラインスタイルから参照できないため
          <style> タグをコンポーネント内に直接埋め込む。
          kozou-spin という固有名でグローバルの spin と衝突しない。
          1.6s/回転・ease-in-out で「ゆっくり動いている」感を演出。 */}
      <style>{SPINNER_CSS}</style>
      <div
        className="kozou-spinner"
        style={{
          width: 36,
          height: 36,
          border: `3px solid var(--c-border)`,
          borderTop: `3px solid var(--c-accent)`,
          borderRadius: "50%",
        }}
      />
      {label && (
        <span style={{ color: "var(--c-textSub)", fontSize: FS.label, fontFamily: F }}>
          {label}
        </span>
      )}
    </div>
  );
}

export function ErrorView({ msg, onBack }: { msg: string; onBack: () => void }) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        gap: 16,
        background: "var(--c-bg)",
        fontFamily: F,
      }}
    >
      <span style={{ fontSize: 42, color: "var(--c-err)" }}>✕</span>
      <span style={{ fontSize: FS.subtitle, fontWeight: 600, color: "#ff7070" }}>
        {t("error.prefix")}
      </span>
      <pre
        style={{
          fontSize: FS.small,
          color: "#cc5555",
          background: "var(--c-errBg)",
          border: `1px solid var(--c-errBd)`,
          borderRadius: 8,
          padding: "12px 18px",
          maxWidth: 520,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {msg}
      </pre>
      <button
        style={{
          padding: "9px 24px",
          background: "transparent",
          border: `1px solid var(--c-errBd)`,
          borderRadius: 8,
          color: "#cc5555",
          cursor: "pointer",
          fontSize: FS.label,
          fontFamily: F,
        }}
        onClick={onBack}
      >
        {t("common.back_btn")}
      </button>
    </div>
  );
}

export function PageHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 22px",
        height: 52,
        borderBottom: `1px solid var(--c-border)`,
        flexShrink: 0,
        background: "var(--c-bg)",
      }}
    >
      {children}
    </div>
  );
}

/**
 * ellipsis省略されたファイル名などを、狭い場所でも確認できるようにする
 * 共通コンポーネント。
 *
 * デスクトップ: マウスホバーで title 属性のツールチップが出るだけで
 * 十分なため、従来通り <span title=...> のまま。
 *
 * モバイル実機(mobilePlatform=true): ホバー操作が無いため、タップすると
 * すぐ下に全文を短時間(既定2.2秒)だけポップアップ表示して自動的に消える。
 * window.alert() のようなOKタップが必要なダイアログは、デスクトップの
 * ホバー表示に比べて煩わしいため使わない。
 */
export function TapRevealText({
  text,
  fullText,
  mobilePlatform,
  style,
  toastMs = 2200,
}: {
  text: string;
  fullText: string;
  mobilePlatform: boolean;
  style?: React.CSSProperties;
  toastMs?: number;
}) {
  const [toastOpen, setToastOpen] = useState(false);

  if (!mobilePlatform) {
    return (
      <span style={style} title={fullText}>
        {text}
      </span>
    );
  }

  return (
    <span style={{ position: "relative", display: "inline-block", minWidth: 0 }}>
      <button
        type="button"
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          fontFamily: F,
          cursor: "pointer",
          textAlign: "left",
          display: "block",
          width: "100%",
          minWidth: 0,
          ...style,
        }}
        title={fullText}
        onClick={() => {
          setToastOpen(true);
          window.setTimeout(() => setToastOpen(false), toastMs);
        }}
      >
        {/* <button>に直接overflow/ellipsis/nowrapを当てても、Android実機の
            WebViewでは効かず2行に折り返されてしまうことがあるため、
            確実に1行省略できる素のspanをここに1枚挟む */}
        <span
          style={{
            display: "block",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {text}
        </span>
      </button>
      {toastOpen && (
        <div
          role="status"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 4,
            maxWidth: "80vw",
            padding: "6px 10px",
            background: "var(--c-text)",
            color: "var(--c-bg)",
            fontSize: FS.small,
            borderRadius: 6,
            boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
            zIndex: 1000,
            wordBreak: "break-all",
          }}
        >
          {fullText}
        </div>
      )}
    </span>
  );
}

export function BtnBack({
  onClick,
}: {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 16px",
        background: "transparent",
        border: `1px solid var(--c-borderHi)`,
        borderRadius: 7,
        color: "var(--c-textSub)",
        cursor: "pointer",
        fontSize: FS.body,
        fontFamily: F,
      }}
    >
      {t("common.back_btn")}
    </button>
  );
}

export function BtnPrimary({
  onClick,
  disabled,
  children,
  autoFocus,
  ariaLabel,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  autoFocus?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      style={{
        padding: "11px 28px",
        background: disabled ? "var(--c-bgCard)" : "var(--c-accentBg)",
        border: `1px solid ${disabled ? "var(--c-border)" : "var(--c-accentBd)"}`,
        borderRadius: 8,
        color: disabled ? "var(--c-textDim)" : "var(--c-accent)",
        fontWeight: 700,
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: FS.label,
        fontFamily: F,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

// サムネイルカード (共通)
export function ThumbCard({
  b64,
  pageNum,
  width = 80,
  selected = false,
  aspectRatio,
  pageColor,
  onClick,
}: {
  b64?: string;
  pageNum: number;
  width?: number;
  selected?: boolean;
  aspectRatio?: number;
  /** ページ領域の背景色。結合プレビュー等で実際のページ色(白)を表示し、
   *  ターゲットページサイズに対する余白(レターボックス)を見せるために使う。
   *  省略時は従来どおりカード背景色。 */
  pageColor?: string;
  onClick?: () => void;
}) {
  // aspectRatio = w/h。横長(>1)でも縦長(<1)でも適切な高さに
  const ratio = aspectRatio ?? 1 / 1.414;
  const h = Math.round(width / ratio);
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 5,
        padding: "6px 5px",
        borderRadius: 7,
        border: `1px solid ${selected ? "var(--c-accent)" : "var(--c-border)"}`,
        background: selected ? "var(--c-accentBg)" : "var(--c-bgCard)",
        cursor: onClick ? "pointer" : "default",
        transition: "all 0.1s",
        fontFamily: F,
      }}
    >
      <div
        style={{
          width,
          height: h,
          background: pageColor ?? "var(--c-bgCard)",
          borderRadius: 3,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {b64 ? (
          <img
            src={`data:image/jpeg;base64,${b64}`}
            style={{
              maxWidth: width,
              maxHeight: h,
              objectFit: "contain",
              borderRadius: 3,
              display: "block",
            }}
            alt=""
          />
        ) : (
          <div style={{ width, height: h, background: "var(--c-border)", borderRadius: 3 }} />
        )}
      </div>
      <span style={{ fontSize: FS.body, color: selected ? "var(--c-accent)" : "var(--c-textDim)" }}>
        {pageNum}
      </span>
    </button>
  );
}
