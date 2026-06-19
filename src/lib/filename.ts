// 出力ファイル名の生成を一元化するヘルパー。
// 操作サフィックス（_trimmed 等）はロケール（ja/en）で切り替える。
import { translate, getCurrentLocale } from "./i18n";

/** パスから拡張子なしのファイル名（ステム）を取り出す */
export function stem(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? "file";
  return name.replace(/\.[^/.]+$/, "") || "file";
}

/** 各処理に対応するファイル名サフィックスの種別 */
export type FileOp =
  | "trimmed"
  | "rotated"
  | "compressed"
  | "merged"
  | "composed"
  | "resized"
  | "sanitized"
  | "type3sanitized"
  | "deimposed"
  | "rasterized";

/** ロケールに応じた処理サフィックス（例: "_trimmed" / "_トリミング"） */
export function opSuffix(op: FileOp): string {
  return translate(getCurrentLocale(), `filename.suffix.${op}`);
}

/**
 * 元パス + 処理サフィックス列から出力ファイル名を作る。
 * 例: buildName("/x/写真.png", ["trimmed", "compressed"])
 *   ja → "写真_トリミング_圧縮.pdf" / en → "写真_trimmed_compressed.pdf"
 */
export function buildName(originalPath: string, ops: FileOp[], ext = "pdf"): string {
  return stem(originalPath) + ops.map(opSuffix).join("") + "." + ext;
}

/**
 * 既に決まっているベース名（拡張子なし・サフィックス付き可）に、さらにサフィックスを足す。
 * 連携処理（trim → compress 等）で前段のベース名を引き継ぐのに使う。
 * 例: appendName("写真_トリミング", ["compressed"]) → "写真_トリミング_圧縮.pdf"
 */
export function appendName(baseName: string, ops: FileOp[], ext = "pdf"): string {
  return baseName + ops.map(opSuffix).join("") + "." + ext;
}
