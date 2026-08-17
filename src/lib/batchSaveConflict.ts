// src/lib/batchSaveConflict.ts
// モバイルのバッチ出力(画像ファイル出力・バッチ画像PDF出力)向けの、
// ファイル名衝突の事前解決ロジック。
//
// 単一ファイル保存の saveConflict.ts はファイル1件ごとに
// checkSaveNameExists() を呼び、衝突があればその都度モーダルで確認する。
// バッチでは出力ファイルが数十件になり得るため、同じやり方だと
// (a) 確認ダイアログが件数分出て煩雑、(b) 存在確認のIPCも件数分発生し遅い。
//
// そこで listFolderNames() で対象フォルダの中身を一度だけ列挙し、
// 衝突の有無をローカルで判定した上で、衝突があれば
// 「すべて上書き / 重複分だけ自動連番 / キャンセル」を1回だけ確認する。
//
// デスクトップ版のバッチ画像出力は入力PDFごとにサブフォルダを作るため、
// 保存先も「ルート」と「PDFごとのサブフォルダ」の複数フォルダにまたがる
// ことがある。フォルダごとに確認を出すと、後のフォルダでキャンセルした
// 場合に前のフォルダ分だけ保存されてしまう(中途半端な状態)。そのため
// 全フォルダ分をまとめて事前スキャンしてから、確認は1回だけ行う。

import { useBatchSaveConflictStore } from "../store/useBatchSaveConflictStore";
import { listFolderNames } from "./tauri";

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

/** 事前スキャン対象の1フォルダ分。 */
export interface PlannedGroup {
  /** そのフォルダの content:// tree URI (ルートまたはサブフォルダ) */
  treeUri: string;
  /** そのフォルダへ書き出す予定のファイル名一覧(グループ内で一意なこと) */
  plannedNames: string[];
}

/**
 * 複数フォルダ分をまとめて事前スキャンし、衝突があれば1回だけ確認する。
 * 戻り値は `treeUri` → (`plannedName` → 解決結果) のマップ。
 * ユーザーがキャンセルした場合は null(どのフォルダにも書き込まないこと)。
 */
export async function resolveGroupsSaveConflict(
  groups: PlannedGroup[],
  folderLabel: string,
): Promise<Map<string, Map<string, ResolvedBatchEntry>> | null> {
  const existingByGroup = new Map<string, Set<string>>();
  let conflictCount = 0;
  for (const g of groups) {
    const existing = new Set(await listFolderNames(g.treeUri));
    existingByGroup.set(g.treeUri, existing);
    conflictCount += g.plannedNames.filter((n) => existing.has(n)).length;
  }

  const result = new Map<string, Map<string, ResolvedBatchEntry>>();

  if (conflictCount === 0) {
    for (const g of groups) {
      const m = new Map<string, ResolvedBatchEntry>();
      for (const n of g.plannedNames) m.set(n, { finalName: n, overwrite: false });
      result.set(g.treeUri, m);
    }
    return result;
  }

  const choice = await useBatchSaveConflictStore.getState().ask(conflictCount, folderLabel);
  if (choice.action === "cancel") return null;

  for (const g of groups) {
    const existing = existingByGroup.get(g.treeUri)!;
    const m = new Map<string, ResolvedBatchEntry>();

    if (choice.action === "overwrite") {
      for (const n of g.plannedNames) m.set(n, { finalName: n, overwrite: existing.has(n) });
    } else {
      // choice.action === "auto"
      // 既存ファイル名に加えて、今まさに割り当てた新しい名前も逐次
      // reserved に加えることで、同一フォルダ内の出力ファイル同士の
      // 衝突も防ぐ(フォルダが分かれていれば同名でも問題ないため、
      // reserved はグループごとに独立させる)。
      const reserved = new Set(existing);
      for (const n of g.plannedNames) {
        const finalName = findAutoRenamedNameLocal(reserved, n);
        reserved.add(finalName);
        m.set(n, { finalName, overwrite: false });
      }
    }
    result.set(g.treeUri, m);
  }
  return result;
}

/** 単一フォルダのみの場合の簡易版(resolveGroupsSaveConflict の薄いラッパー)。 */
export async function resolveBatchSaveConflict(
  treeUri: string,
  plannedNames: string[],
  folderName: string,
): Promise<Map<string, ResolvedBatchEntry> | null> {
  const result = await resolveGroupsSaveConflict([{ treeUri, plannedNames }], folderName);
  return result?.get(treeUri) ?? null;
}
