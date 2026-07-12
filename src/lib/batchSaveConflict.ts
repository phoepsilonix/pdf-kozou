// src/lib/batchSaveConflict.ts
// モバイルのバッチ出力(画像ファイル出力・バッチ画像PDF出力)向けの、
// ファイル名衝突の事前解決ロジック。
//
// 単一ファイル保存の saveConflict.ts はファイル1件ごとに
// checkSaveNameExists() を呼び、衝突があればその都度モーダルで確認する。
// バッチでは出力ファイルが数十件になり得るため、同じやり方だと
// (a) 確認ダイアログが件数分出て煩雑、(b) 存在確認のIPCも件数分発生し遅い。
//
// そこで listFolderNames() で選択フォルダの中身を一度だけ列挙し、
// 衝突の有無をローカルで判定した上で、衝突があれば
// 「すべて上書き / 重複分だけ自動連番 / キャンセル」を1回だけ確認する。

import { listFolderNames } from "./tauri";
import { useBatchSaveConflictStore } from "../store/useBatchSaveConflictStore";

/** "sample.png" -> ["sample", ".png"] / 拡張子なしなら ["name", ""] */
function splitExt(name: string): [string, string] {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return [name, ""];
  return [name.slice(0, idx), name.slice(idx)];
}

/**
 * `existing` に含まれない名前を、拡張子の前に "(n)" を挿入する形で探す
 * (例: sample.png -> sample (1).png -> sample (2).png ...)。ネットワーク
 * 往復が無いため、999件試しても見つからない場合のみタイムスタンプ付きの
 * 名前にフォールバックする。
 */
export function findAutoRenamedNameLocal(existing: Set<string>, fileName: string): string {
  if (!existing.has(fileName)) return fileName;
  const [base, ext] = splitExt(fileName);
  for (let n = 1; n <= 999; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

export interface ResolvedBatchEntry {
  finalName: string;
  overwrite: boolean;
}

/**
 * `plannedNames`(これから書き出す予定のファイル名一覧。呼び出し側で
 * あらかじめ一意であることを保証しておくこと)を選択フォルダの中身と
 * 突き合わせ、衝突を解決する。
 *
 * 戻り値は `plannedNames` の各要素をキーとした解決結果マップ。
 * ユーザーがキャンセルした場合は null。
 */
export async function resolveBatchSaveConflict(
  treeUri: string,
  plannedNames: string[],
  folderName: string,
): Promise<Map<string, ResolvedBatchEntry> | null> {
  const existingNames = new Set(await listFolderNames(treeUri));
  const conflictCount = plannedNames.filter((n) => existingNames.has(n)).length;

  const result = new Map<string, ResolvedBatchEntry>();

  if (conflictCount === 0) {
    for (const n of plannedNames) result.set(n, { finalName: n, overwrite: false });
    return result;
  }

  const choice = await useBatchSaveConflictStore.getState().ask(conflictCount, folderName);
  if (choice.action === "cancel") return null;

  if (choice.action === "overwrite") {
    for (const n of plannedNames) {
      result.set(n, { finalName: n, overwrite: existingNames.has(n) });
    }
    return result;
  }

  // choice.action === "auto"
  // 既存ファイル名に加えて、バッチ内で今まさに割り当てた新しい名前も
  // 逐次 reserved に加えることで、出力ファイル同士の衝突も防ぐ。
  const reserved = new Set(existingNames);
  for (const n of plannedNames) {
    const finalName = findAutoRenamedNameLocal(reserved, n);
    reserved.add(finalName);
    result.set(n, { finalName, overwrite: false });
  }
  return result;
}
