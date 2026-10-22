// src/lib/fileSort.ts
// ファイル一覧(ホーム画面・結合画面)のファイル名による並び替え。
//
// 数字を数値として比較する(natural sort)ため、"file2.pdf" は "file10.pdf" より
// 前に並ぶ。大文字小文字・アクセント違いは同順位として扱い、同順位なら元の
// 並びを保つ(Array.prototype.sort は安定ソート)。

export type SortDirection = "asc" | "desc";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareFilenames(a: string, b: string): number {
  return collator.compare(a, b);
}

/** 新しい配列を返す(元の配列は変更しない)。 */
export function sortByFilename<T>(
  items: readonly T[],
  getName: (item: T) => string,
  direction: SortDirection,
): T[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...items].sort((x, y) => sign * compareFilenames(getName(x), getName(y)));
}
