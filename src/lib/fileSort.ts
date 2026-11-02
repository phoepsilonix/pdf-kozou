// src/lib/fileSort.ts
// ファイル一覧(ホーム画面・結合画面)の並び替え。ファイル名と更新日時に対応する。
//
// ファイル名の比較は二種類。
//
// natural（「名前」）は一般的なファイラー(Explorer / Finder / Nautilus)に合わせる。
//   - 数字は数値として比較する(natural sort): "file2.pdf" は "file10.pdf" より前。
//   - 拡張子を除いた本体名を先に比較し、同じなら拡張子で比較する。拡張子込みで
//     比較すると "." が " " "-" "_" より後ろになり、"file.pdf" が "file (1).pdf" や
//     "file-1.pdf" の後ろに回ってしまう。
//   - 大文字小文字・全角半角・平仮名片仮名は本体名の比較では同順位とし、その差は
//     後段(同順位の再比較)で決める。ただし濁点・半濁点(か/が/は/ぱ)は区別する。
//     以前は sensitivity: "base" で濁点まで無視していたため、か/が が同順位となり
//     元の並びのまま残っていた。
//   - macOS / iOS 由来の NFD 名(が = か + 濁点)と NFC 名を同一視するため、比較前に
//     NFC へ正規化する。
//   - 照合順序は実行環境の既定ロケールではなくアプリの表示言語で決める
//     (WebKitGTK 等では既定が en-US/C になり、日本語の並びが期待とずれるため)。
//
// hash（「ハッシュ名」）はハッシュ値・UUID のような英数字の羅列向け。
//   - 数字を数値にまとめず、文字コード順で 1 文字ずつ比較する。
//     natural だと "ab10cd…" は "ab2cde…" より後ろ(10 > 2)になるが、
//     ハッシュとしては "ab10…" が先("1" < "2")である。
//   - 十六進数の大文字小文字(A/a)は同順位とし、表記だけ違うときは元の文字列で決める。
//   - 拡張子の分け方と NFC 正規化は natural と同じ。ロケール照合は使わない
//     (ASCII の並びが表示言語で揺れないようにする)。
//
// 更新日時が同じ(または取得できていない)もの同士はファイル名の natural 順にし、
// それでも同順位なら元の並びを保つ(Array.prototype.sort は安定ソート)。

import { getCurrentLocale } from "./i18n";

export type SortKey = "name" | "hash" | "modified";
export type SortDirection = "asc" | "desc";

interface Collators {
  /** 大文字小文字・かな種別・全角半角を無視。濁点・アクセントは区別する。 */
  loose: Intl.Collator;
  /** 全ての差を区別する(同順位の最終決定用)。 */
  strict: Intl.Collator;
}

const collatorCache = new Map<string, Collators>();

function collatorsFor(locale: string): Collators {
  let c = collatorCache.get(locale);
  if (!c) {
    c = {
      loose: new Intl.Collator(locale, { numeric: true, sensitivity: "accent" }),
      strict: new Intl.Collator(locale, { numeric: true, sensitivity: "variant" }),
    };
    collatorCache.set(locale, c);
  }
  return c;
}

/** 末尾の短い英数字拡張子(".pdf" 等)を本体名から分ける。拡張子と見なせなければ ext は空。 */
function splitExt(name: string): [string, string] {
  const m = /^(.+)\.([A-Za-z0-9]{1,5})$/.exec(name);
  return m ? [m[1] ?? name, m[2] ?? ""] : [name, ""];
}

function cmpCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** ASCII の A–Z だけを小文字にする。十六進数の桁であり、ロケールの大小変換は使わない。 */
function foldHexCase(s: string): string {
  return s.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

export function compareFilenames(a: string, b: string): number {
  const { loose, strict } = collatorsFor(getCurrentLocale());
  const na = a.normalize("NFC");
  const nb = b.normalize("NFC");
  const [sa, ea] = splitExt(na);
  const [sb, eb] = splitExt(nb);
  return (
    loose.compare(sa, sb) ||
    loose.compare(ea, eb) ||
    strict.compare(na, nb) ||
    // 照合上も完全に同じ場合の決定的な最終手段(コードポイント順)
    cmpCode(na, nb)
  );
}

/** ハッシュ名向け。数字の並びは数値ではなく文字として比較する。 */
function compareHashFilenames(a: string, b: string): number {
  const na = a.normalize("NFC");
  const nb = b.normalize("NFC");
  const [sa, ea] = splitExt(na);
  const [sb, eb] = splitExt(nb);
  return (
    cmpCode(foldHexCase(sa), foldHexCase(sb)) ||
    cmpCode(foldHexCase(ea), foldHexCase(eb)) ||
    cmpCode(na, nb)
  );
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
  const byName = key === "hash" ? compareHashFilenames : compareFilenames;
  return [...items].sort((x, y) => {
    if (key === "modified") {
      const d = (get.modified(x) ?? 0) - (get.modified(y) ?? 0);
      if (d !== 0) return sign * d;
      return sign * compareFilenames(get.name(x), get.name(y));
    }
    return sign * byName(get.name(x), get.name(y));
  });
}
