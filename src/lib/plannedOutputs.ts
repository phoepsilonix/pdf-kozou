// src/lib/plannedOutputs.ts
// バッチ/複数ファイル出力で、実際に書き出す前に「出力されるファイル名」を計算する。
// 上書き確認(overwriteGuard.precheck)を進捗の開始前に行うために使う。
//
// 出力名はコア(Rust)側の命名規則に合わせてある。規則を変えた場合は両方を直すこと。
//   - 分割:        pdf-kozou-core/src/split.rs        `{prefix}_{0001}.pdf` / `{prefix}_{0001}-{0003}.pdf`
//   - 画像書き出し: pdf-kozou-core/src/api.rs render_to_dir `{prefix}{001}.{ext}` (最低3桁)
//
// ここでの計算が実際とずれても、書き出し時の overwriteGuard.resolve() が最初の
// 衝突で確認する(従来動作)ので、上書きが黙って起きることはない。

import type { SplitMode } from "./tauri";

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** 分割(split_pdf)が出力するファイル名の一覧。 */
export function splitOutputNames(prefix: string, mode: SplitMode, pageCount: number): string[] {
  if (pageCount <= 0) return [];
  // 各出力が含むページ範囲(0始まり、両端含む)
  const groups: [number, number][] = [];
  if (mode.type === "AllPages") {
    for (let i = 0; i < pageCount; i++) groups.push([i, i]);
  } else if (mode.type === "EveryN") {
    if (mode.n <= 0) return [];
    for (let s = 0; s < pageCount; s += mode.n) {
      groups.push([s, Math.min(s + mode.n, pageCount) - 1]);
    }
  } else {
    for (const [from, to] of mode.ranges) {
      const s = Math.max(from - 1, 0);
      const e = Math.min(to - 1, pageCount - 1);
      if (s <= e) groups.push([s, e]);
    }
  }
  return groups.map(([s, e]) =>
    s === e ? `${prefix}_${pad(s + 1, 4)}.pdf` : `${prefix}_${pad(s + 1, 4)}-${pad(e + 1, 4)}.pdf`,
  );
}

/**
 * 画像書き出し(export_images)が出力するファイル名の一覧。`prefix` は末尾が
 * 連番の区切り(\"_\")で終わるものとし、1 から `count` 件を最低3桁で連番にする。
 * 末尾が数字のプレフィックスはコア側で開始番号として解釈されるため、対象外(空配列)。
 */
export function renderOutputNames(prefix: string, count: number, ext: string): string[] {
  if (count <= 0 || /\d$/.test(prefix)) return [];
  const width = Math.max(3, String(count).length);
  return Array.from({ length: count }, (_, i) => `${prefix}${pad(i + 1, width)}.${ext}`);
}
