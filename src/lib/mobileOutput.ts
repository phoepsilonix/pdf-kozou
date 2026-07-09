// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/lib/mobileOutput.ts
//
// Android: バッチ出力(複数ファイル書き出し)を、ユーザーから見える
// 「ダウンロード」フォルダ配下へ保存するためのヘルパー。
//
// Android にはモバイル向けの「フォルダ選択ダイアログ」が存在しない
// (tauri-plugin-dialog が提供していない) ため、フォルダを選ばせる
// 代わりに、決め打ちのサブフォルダ名 (日時 + 元ファイル名から生成) を
// 使い、実行前に「保存先プレビュー」として表示する。
//
// 実行後は同じ名前で `commit_saved_batch` を呼び、一時ディレクトリの
// 中身を実際に `ダウンロード/{relativeDir}/` へコピーする。プレビュー
// 表示と実際の保存呼び出しに同じ文字列を使うことで、「ここに保存され
// ます」の表示と「ここに保存しました」の結果表示を一致させている。

import { invoke } from "@tauri-apps/api/core";

export interface MobileSavedFileInfo {
  uri: string;
  displayName: string;
  relativePath: string;
  /** 一時ディレクトリを起点とした相対パス (例: "請求書/page01.png") */
  sourceRelative: string;
}

/** ファイル名・フォルダ名として使えない文字を除去/置換する */
function sanitizeForPath(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 80);
  return cleaned || "output";
}

function timestampLabel(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * バッチ出力用のサブフォルダ名を生成する ("Download/" は含まない)。
 *
 * 例: buildMobileOutputSubfolder("請求書一式")
 *     → "pdf-kozou/2026-07-09_141530_請求書一式"
 *
 * 実行前のプレビュー表示 (`mobileOutputPreviewLabel`) と、実行後の
 * `commitSavedBatch` 呼び出しの両方で同じ戻り値を使うこと。
 */
export function buildMobileOutputSubfolder(sourceLabel: string): string {
  return `pdf-kozou/${timestampLabel()}_${sanitizeForPath(sourceLabel)}`;
}

/** UIに出す「保存先プレビュー」の表示用パス (先頭に "ダウンロード/" を付ける) */
export function mobileOutputPreviewLabel(relativeDir: string): string {
  return `ダウンロード/${relativeDir}/`;
}

/**
 * `tempDir` 以下に core が書き出したファイル群を、Android では
 * `ダウンロード/{relativeDir}/` 配下へコピーする。
 *
 * デスクトップ / iOS (未対応) では常に空配列が返る
 * (呼び出し側は isMobile() 等で事前に分岐し、Android のみで呼ぶ想定)。
 */
export async function commitSavedBatch(
  tempDir: string,
  relativeDir: string,
): Promise<MobileSavedFileInfo[]> {
  return invoke<MobileSavedFileInfo[]>("commit_saved_batch", {
    tempDir,
    relativeDir,
  });
}
