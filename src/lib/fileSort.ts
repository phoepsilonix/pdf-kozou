// src/lib/fileSort.ts
// ファイル一覧(ホーム画面・結合画面)の並び替え。ファイル名と更新日時に対応する。
//
// ファイル名は数字を数値として比較する(natural sort)ため、"file2.pdf" は
// "file10.pdf" より前に並ぶ。大文字小文字・アクセント違いは同順位として扱う。
// 更新日時が同じ(または取得できていない)もの同士はファイル名順にし、それでも
// 同順位なら元の並びを保つ(Array.prototype.sort は安定ソート)。

export type SortKey = "name" | "modified";
export type SortDirection = "asc" | "desc";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareFilenames(a: string, b: string): number {
  return collator.compare(a, b);
}

/**
 * 新しい配列を返す(元の配列は変更しない)。
 * `modified` が 0/未設定のものは更新日時が不明として扱い、昇順では先頭、
 * 降順では末尾に集まる。
 */
export function sortFileEntries<T>(
  items: readonly T[],
  get: { name: (item: T) => string; modified: (item: T) => number | undefined },
  key: SortKey,
  direction: SortDirection,
): T[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...items].sort((x, y) => {
    if (key === "modified") {
      const d = (get.modified(x) ?? 0) - (get.modified(y) ?? 0);
      if (d !== 0) return sign * d;
      return sign * compareFilenames(get.name(x), get.name(y));
    }
    return sign * compareFilenames(get.name(x), get.name(y));
  });
}
