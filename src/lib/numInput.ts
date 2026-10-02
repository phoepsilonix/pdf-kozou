// src/lib/numInput.ts
// 数値・ページ指定入力の正規化ユーティリティ。
// 日本語IME(全角)・他言語キーボードの数字(アラビア・インド数字など)を半角に直し、
// 「確定したのに入力されていない/0ページになる」問題を防ぐ。

/** 各文字体系の「0」のコードポイント(いずれも 0〜9 が連続して並ぶ) */
const DIGIT_ZEROS = [
  0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0e50,
  0x0ed0, 0x0f20, 0x1040, 0x17e0, 0xff10,
];

/** アラビア・インド数字、デーヴァナーガリー数字、全角数字などを ASCII 0-9 に変換 */
function mapDecimalDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const zero = DIGIT_ZEROS.find((z) => cp >= z && cp <= z + 9);
    out += zero === undefined ? ch : String(cp - zero);
  }
  return out;
}

/** 全角 ASCII (U+FF01-FF5E) と全角スペースを半角へ。数字は多言語の Nd も半角へ */
export function toHalfWidth(s: string): string {
  const full = s
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ");
  return mapDecimalDigits(full);
}

/** ハイフン・マイナスに見える各種文字(長音「ー」を含む) → "-" */
const DASH_RE = /[\u2010-\u2015\u2212\u30FC\uFF0D\uFE63\uFF70]/g;

/** 数値欄向け: 半角化し、符号・小数点・桁区切りを整える。数字以外の文字はそのまま残す */
export function normalizeNumberText(s: string): string {
  return toHalfWidth(s)
    .replace(DASH_RE, "-")
    .replace(/[\u3002\uFF0E\u00B7]/g, ".")
    .replace(/[\u066B]/g, ".") // アラビア語の小数点
    .replace(/[,\u3001\uFF0C\u066C\u060C]/g, "") // 桁区切り(,、，)は除去
    .replace(/\s+/g, "");
}

/** ページ指定欄向け: 半角化し、区切り・範囲記号・除外記号を ASCII に統一する */
export function normalizePageSpec(s: string): string {
  return toHalfWidth(s)
    .replace(DASH_RE, "-")
    .replace(/[~\u301C\u223C\uFF5E\u2053]/g, "-") // 「〜」「～」も範囲として扱う
    .replace(/[\u3001\uFF0C\u060C\uFE50\uFE51\uFF64\u3002\u00B7;；]/g, ",")
    .replace(/[\u2227\uFF3E]/g, "^")
    .replace(/[!！\u00AC]/g, "^");
}

/** 数値文字列を number に。空・不正は NaN */
export function parseNumberText(s: string): number {
  const t = normalizeNumberText(s);
  if (t === "" || t === "-" || t === "." || t === "-.") return Number.NaN;
  return Number(t);
}
