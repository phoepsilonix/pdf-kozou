// src/lib/uniqueName.ts
// バッチ処理で、入力ファイル名の重複(別フォルダにある同名ファイルなど)により
// 出力ファイルが上書きされないよう、2つ目以降の入力名に連番を付ける。
//
// 規則(全機能で共通):
// - 重複していない名前は変更しない。
// - 重複した名前は、一覧の順で最初のものをそのまま残し、2つ目以降の拡張子の
//   前に " (1)" " (2)" ... を付ける(例: scan.pdf, scan (1).pdf, scan (2).pdf)。
//   Android の保存先での自動リネームと同じ書式。
// - 大文字小文字は区別せずに比較する(iOS/macOS/Windows のファイルシステムに合わせる)。
// - 連番の候補が、他の入力の元の名前と重なる場合は次の番号に進む。
//
// 出力名はこの名前から作る(例: scan (1)_compressed.pdf)ため、サフィックスの
// 指定とは独立して常に一意になる。

function splitExt(name: string): [string, string] {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return [name, ""];
  return [name.slice(0, idx), name.slice(idx)];
}

const keyOf = (name: string) => name.normalize("NFC").toLowerCase();

/** 入力と同じ並びの、重複のないファイル名の配列を返す。 */
export function uniqueFileNames(names: readonly string[]): string[] {
  const reserved = new Set(names.map(keyOf));
  const seen = new Set<string>();
  return names.map((name) => {
    const key = keyOf(name);
    if (!seen.has(key)) {
      seen.add(key);
      return name;
    }
    const [base, ext] = splitExt(name);
    for (let n = 1; n <= 9999; n++) {
      const candidate = `${base} (${n})${ext}`;
      const ck = keyOf(candidate);
      if (!reserved.has(ck)) {
        reserved.add(ck);
        seen.add(ck);
        return candidate;
      }
    }
    // 9999 件でも空きが無い場合のみ(通常は起こらない)タイムスタンプで回避する。
    return `${base} (${Date.now()})${ext}`;
  });
}
