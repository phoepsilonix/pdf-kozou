// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/speakName.ts
//
// ファイル名を音声ガイド向けに整形する。
//
// 背景:
//   Canva スマホ版などからダウンロードしたファイルは
//   "69a16bcc9e3ce73bebe61103.pdf" のような不透明な英数字ID名になることがある。
//   これを TTS（特に ja-JP 音声）にそのまま渡すと、辞書に無い英数字列を
//   「単語っぽく」無理に発音し、何のファイルか全く聞き取れない。
//
// 方針:
//   ファイル名を区切り（空白・_ - . () [] 等）でトークン分割し、各トークンを
//   「不透明なID」か「読める語」かに分類する。ID と判定したトークンだけを
//   1文字ずつ綴り読みさせ（文字間にスペースを挿入）、それ以外（普通の英単語・
//   末尾に数字が付く語・日本語などの非ラテン文字）はそのまま自然に読ませる。
//   これにより "test.pdf" は綴られず、ハッシュ名だけが綴り読みになる。
//
//   判定は ASCII の英数字トークンに限定する。日本語など非ラテン文字を含む
//   トークンはエンジンに任せて自然読みする（無理に綴ると過剰になるため）。
//   完全な判定は原理的に不可能なので、実害のあるハッシュ名を拾いつつ普通の
//   名前を巻き込まない保守的なしきい値にしている。
//
// プラットフォーム:
//   純粋な文字列処理のみ。Linux(WebKitGTK)・Windows(WebView2/Blink) 双方で
//   同じ結果になる。読み上げ品質はエンジン依存だが、綴り読みは区別の助けになる。

/** トークンが「不透明なID（ハッシュ・ランダム英数字）」っぽいか */
function isOpaqueId(tok: string): boolean {
  // 非ASCII（日本語・他言語）を含むものは自然読み（綴り対象外）
  if (/[^\x00-\x7F]/.test(tok)) return false;
  // 英字を含まない（数字のみ・記号のみ）は自然読み（数字はそのまま読める）
  if (!/[A-Za-z]/.test(tok)) return false;
  const len = tok.length;
  // 短いトークンは語として読ませる（test, v2, pdf, img ...）
  if (len <= 5) return false;
  // 1) 長い16進文字列（数字を含む）。例: 69a16bcc9e3ce73bebe61103
  if (len >= 12 && /^[0-9a-fA-F]+$/.test(tok) && /[0-9]/.test(tok)) return true;
  // 2) 英字と数字が「絡み合う」（数字の直後に英字が現れる）かつ長さ7以上。
  //    "report2024" は数字が末尾に固まるだけなので該当しない（自然読み）。
  if (len >= 7 && /[0-9][A-Za-z]/.test(tok)) return true;
  // 3) 母音が極端に少ない長いトークン（綴りとして発音不能なランダム列）
  if (len >= 10) {
    const vowels = (tok.match(/[aeiouAEIOU]/g) || []).length;
    if (vowels / len < 0.2) return true;
  }
  return false;
}

/** トークンを1文字ずつ綴らせる（文字間にスペースを挿入） */
function spellOut(tok: string): string {
  return Array.from(tok).join(" ");
}

/**
 * ファイル名（拡張子込み可）を音声ガイド向けに整形して返す。
 * - %XX を含むならパーセントデコードを試みる（壊れていれば元のまま）
 * - 不透明なID風トークンのみ綴り読み、それ以外は自然読みのまま
 */
export function formatFilenameForSpeech(name: string): string {
  let s = name;
  // URL エンコードされた日本語名などはデコードして元の文字で読ませる
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* 壊れたエスケープはそのまま */
    }
  }
  // 区切り（空白・_ - . + ( ) [ ]）以外の連続をトークンとして判定する。
  // 区切り自体は残すので、読み上げ時の区切れ（間）も保たれる。
  return s.replace(/[^\s_.+()[\]-]+/g, (tok) => (isOpaqueId(tok) ? spellOut(tok) : tok));
}
