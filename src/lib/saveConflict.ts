// src/lib/saveConflict.ts
// モバイル単一ファイル保存(ACTION_OPEN_DOCUMENT_TREE によるB方式)向けの、
// ファイル名衝突解決ロジック。useSaveDialog フックと、それを経由しない
// RotatePage の直接呼び出しの両方から共有で使う。

import { useSaveConflictStore } from "../store/useSaveConflictStore";
import { checkSaveNameExists } from "./tauri";

/** "sample.pdf" -> ["sample", ".pdf"] / 拡張子なしなら ["name", ""] */
function splitExt(name: string): [string, string] {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return [name, ""];
  return [name.slice(0, idx), name.slice(idx)];
}

/**
 * 拡張子の前に "(n)" を挿入する形で、指定フォルダ内で衝突しない名前を
 * 探す(例: sample.pdf -> sample (1).pdf -> sample (2).pdf ...)。
 * 999件試しても空きが見つからない場合はタイムスタンプ付きの名前を返す
 * (無限ループ防止。実運用でここまで衝突することはまず無い想定)。
 */
export async function findAutoRenamedName(treeUri: string, fileName: string): Promise<string> {
  const [base, ext] = splitExt(fileName);
  for (let n = 1; n <= 999; n++) {
    const candidate = `${base} (${n})${ext}`;
    const exists = await checkSaveNameExists(treeUri, candidate);
    if (!exists) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

/**
 * 指定フォルダ内で defaultName の衝突を確認し、衝突していれば
 * SaveConflictModal 経由でユーザーに解決させる。
 *
 * 戻り値: 最終的なファイル名と上書きフラグ。ユーザーがキャンセルした
 * 場合は null。
 */
export async function resolveSaveConflict(
  treeUri: string,
  defaultName: string,
  folderName: string,
): Promise<{ fileName: string; overwrite: boolean } | null> {
  let fileName = defaultName;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const exists = await checkSaveNameExists(treeUri, fileName);
    if (!exists) return { fileName, overwrite: false };

    const choice = await useSaveConflictStore.getState().ask(fileName, folderName);

    if (choice.action === "cancel") return null;
    if (choice.action === "overwrite") return { fileName, overwrite: true };
    if (choice.action === "auto") {
      const auto = await findAutoRenamedName(treeUri, fileName);
      return { fileName: auto, overwrite: false };
    }
    // choice.action === "rename": ユーザーが指定した名前で再度チェックする
    fileName = choice.fileName;
  }
}
