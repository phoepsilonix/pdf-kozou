// src/components/FileSortSelect.tsx
// ファイル一覧の並び替えセレクト(ホーム画面・結合画面で共用)。
// 項目を選ぶとその場で一覧を並び替え、表示は「並び替え」に戻る
// (一覧の現在の並びは手動の並び替えで変わるため、選択状態を保持しない)。

import type { CSSProperties } from "react";
import type { SortDirection, SortKey } from "../lib/fileSort";
import { useI18n } from "../lib/i18n";
import { F } from "../lib/theme";
import { FS } from "../lib/typography";

interface Props {
  onSort: (key: SortKey, direction: SortDirection) => void;
  disabled?: boolean;
  style?: CSSProperties;
}

const OPTIONS: { value: `${SortKey}:${SortDirection}`; labelKey: string }[] = [
  { value: "name:asc", labelKey: "file.sort_name_asc" },
  { value: "name:desc", labelKey: "file.sort_name_desc" },
  { value: "modified:asc", labelKey: "file.sort_modified_asc" },
  { value: "modified:desc", labelKey: "file.sort_modified_desc" },
];

export function FileSortSelect({ onSort, disabled, style }: Props) {
  const { t } = useI18n();
  return (
    <select
      value=""
      disabled={disabled}
      aria-label={t("file.sort_aria")}
      title={t("file.sort_aria")}
      onChange={(e) => {
        const [key, direction] = e.target.value.split(":") as [SortKey, SortDirection];
        if (key && direction) onSort(key, direction);
        (e.currentTarget as HTMLSelectElement).blur();
      }}
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
      <option value="" disabled hidden>
        {t("file.sort")}
      </option>
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {t(o.labelKey)}
        </option>
      ))}
    </select>
  );
}
