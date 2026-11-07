// src/components/FileSortSelect.tsx
// ファイル一覧の並び替えセレクト(ホーム画面・結合画面で共用)。
// 項目を選ぶとその場で一覧を並び替え、表示は「並び替え」に戻る
// (一覧の現在の並びは手動の並び替えで変わるため、選択状態を保持しない)。
//
// compact: 狭い画面向け。文字の代わりに「長さの違う3本の横線+下向き矢印」のアイコンを
// 表示する。ネイティブの select は透明にして絶対配置で全面に重ねるので、
// レイアウト幅はアイコン分(固定)だけになり、選択肢の文字・ピッカーはそのまま使える。

import { type CSSProperties, useState } from "react";
import type { SortDirection, SortKey } from "../lib/fileSort";
import { useI18n } from "../lib/i18n";
import { F } from "../lib/theme";
import { FS } from "../lib/typography";

interface Props {
  onSort: (key: SortKey, direction: SortDirection) => void;
  disabled?: boolean;
  style?: CSSProperties;
  compact?: boolean;
}

const OPTIONS: { value: `${SortKey}:${SortDirection}`; labelKey: string }[] = [
  { value: "name:asc", labelKey: "file.sort_name_asc" },
  { value: "name:desc", labelKey: "file.sort_name_desc" },
  { value: "hash:asc", labelKey: "file.sort_hash_asc" },
  { value: "hash:desc", labelKey: "file.sort_hash_desc" },
  { value: "modified:asc", labelKey: "file.sort_modified_asc" },
  { value: "modified:desc", labelKey: "file.sort_modified_desc" },
];

export function FileSortSelect({ onSort, disabled, style, compact }: Props) {
  const { t } = useI18n();
  const [focused, setFocused] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const [key, direction] = e.target.value.split(":") as [SortKey, SortDirection];
    if (key && direction) onSort(key, direction);
    (e.currentTarget as HTMLSelectElement).blur();
  };

  // ドロップダウン(選択肢の一覧)もテーマに合わせる。select本体は透明/不可視のことがあり、
  // 一覧の背景・文字色はブラウザ既定(白地など)になりがちなので、option側にも指定する。
  // (ConvertOptionsPanel の select と同じ --c-bg / --c-text)
  const optionStyle: CSSProperties = { background: "var(--c-bg)", color: "var(--c-text)" };
  const options = (
    <>
      <option value="" disabled hidden style={optionStyle}>
        {t("file.sort")}
      </option>
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value} style={optionStyle}>
          {t(o.labelKey)}
        </option>
      ))}
    </>
  );

  if (compact) {
    // 見た目はラッパー(固定幅)+SVG、操作は全面に重ねた透明な select が受ける。
    // select が不可視でもキーボード操作が分かるよう、フォーカス時はラッパーに枠を出す。
    return (
      <span
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          alignSelf: "stretch",
          boxSizing: "border-box",
          flexShrink: 0,
          width: 36,
          minHeight: 30,
          border: "1px solid var(--c-borderHi)",
          borderRadius: 7,
          color: "var(--c-textSub)",
          opacity: disabled ? 0.5 : 1,
          outline: focused ? "2px solid var(--c-accent)" : "none",
          outlineOffset: 1,
          ...style,
        }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          style={{ pointerEvents: "none" }}
        >
          {/* 長さの違う3本線(上から長・中・短) */}
          <line x1="2.5" y1="5" x2="11" y2="5" />
          <line x1="2.5" y1="10" x2="8" y2="10" />
          <line x1="2.5" y1="15" x2="5" y2="15" />
          {/* 下向き矢印 */}
          <line x1="16" y1="4" x2="16" y2="16" />
          <polyline points="13,13 16,16 19,13" />
        </svg>
        <select
          value=""
          disabled={disabled}
          aria-label={t("file.sort_aria")}
          title={t("file.sort_aria")}
          onChange={handleChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            margin: 0,
            padding: 0,
            opacity: 0,
            cursor: disabled ? "default" : "pointer",
            // 一覧の表示(背景・文字色・大きさ)をテーマと通常表示に揃える
            background: "var(--c-bg)",
            color: "var(--c-text)",
            fontSize: FS.body,
            fontFamily: F,
          }}
        >
          {options}
        </select>
      </span>
    );
  }

  return (
    <select
      value=""
      disabled={disabled}
      aria-label={t("file.sort_aria")}
      title={t("file.sort_aria")}
      onChange={handleChange}
      style={{
        padding: "5px 10px",
        background: "transparent",
        border: "1px solid var(--c-borderHi)",
        borderRadius: 6,
        color: "var(--c-textSub)",
        cursor: disabled ? "default" : "pointer",
        fontSize: FS.small,
        fontFamily: F,
        ...style,
      }}
    >
      {options}
    </select>
  );
}
