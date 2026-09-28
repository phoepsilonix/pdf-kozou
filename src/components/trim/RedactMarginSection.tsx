// src/components/trim/RedactMarginSection.tsx
// トリミング後の圧縮(redact)で CropBox の外側に残す余白(pt)を設定するセクション。
// 値は圧縮画面と共通の設定(usePdfStore の redactMargin*)をそのまま読み書きするため、
// ここで変更した値は圧縮画面にも反映され、その逆も同様。

import { useEffect, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { FS } from "../../lib/typography";
import { usePdfStore } from "../../store/usePdfStore";

/** 0 以上の整数(pt)を入力するフィールド。確定(blur / Enter)時に値を丸めて反映する */
function MarginPtField({
  label,
  value,
  onChange,
  disabled,
  width = 64,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  width?: number;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Math.max(0, Math.round(Number(text)) || 0);
    onChange(n);
    setText(String(n));
  };
  return (
    <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <span style={{ fontSize: FS.caption, color: "var(--c-textDim)" }}>{label}</span>
      <input
        type="number"
        min={0}
        step={10}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        style={{ width, textAlign: "center" }}
      />
    </label>
  );
}

export function RedactMarginSection({ disabled = false }: { disabled?: boolean }) {
  const { t } = useI18n();
  const linked = usePdfStore((st) => st.redactMarginLinked);
  const setLinked = usePdfStore((st) => st.setRedactMarginLinked);
  const uniform = usePdfStore((st) => st.redactMarginPt);
  const setUniform = usePdfStore((st) => st.setRedactMarginPt);
  const top = usePdfStore((st) => st.redactMarginTop);
  const setTop = usePdfStore((st) => st.setRedactMarginTop);
  const bottom = usePdfStore((st) => st.redactMarginBottom);
  const setBottom = usePdfStore((st) => st.setRedactMarginBottom);
  const left = usePdfStore((st) => st.redactMarginLeft);
  const setLeft = usePdfStore((st) => st.setRedactMarginLeft);
  const right = usePdfStore((st) => st.redactMarginRight);
  const setRight = usePdfStore((st) => st.setRedactMarginRight);

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <h3
        style={{
          margin: 0,
          fontSize: FS.caption,
          letterSpacing: "0.1em",
          color: "var(--c-textDim)",
        }}
      >
        {t("trim.redact_margin_heading")}
      </h3>
      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: FS.caption }}>
        <input
          type="checkbox"
          checked={!linked}
          disabled={disabled}
          onChange={(e) => setLinked(!e.target.checked)}
        />
        {t("compress.redact_margin_individual_label")}
      </label>
      {linked ? (
        <MarginPtField
          label={t("compress.redact_margin_label")}
          value={uniform}
          onChange={setUniform}
          disabled={disabled}
          width={80}
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "70px 70px 70px",
            justifyItems: "center",
            justifyContent: "start",
            gap: 4,
          }}
        >
          <div style={{ gridColumn: "2 / 3", gridRow: 1 }}>
            <MarginPtField
              label={t("compress.margin_top")}
              value={top}
              onChange={setTop}
              disabled={disabled}
            />
          </div>
          <div style={{ gridColumn: "1 / 2", gridRow: 2 }}>
            <MarginPtField
              label={t("compress.margin_left")}
              value={left}
              onChange={setLeft}
              disabled={disabled}
            />
          </div>
          <div style={{ gridColumn: "3 / 4", gridRow: 2 }}>
            <MarginPtField
              label={t("compress.margin_right")}
              value={right}
              onChange={setRight}
              disabled={disabled}
            />
          </div>
          <div style={{ gridColumn: "2 / 3", gridRow: 3 }}>
            <MarginPtField
              label={t("compress.margin_bottom")}
              value={bottom}
              onChange={setBottom}
              disabled={disabled}
            />
          </div>
        </div>
      )}
      <span style={{ fontSize: FS.caption, color: "var(--c-textDim)", lineHeight: 1.4 }}>
        {t("trim.redact_margin_shared_note")}
      </span>
    </section>
  );
}
