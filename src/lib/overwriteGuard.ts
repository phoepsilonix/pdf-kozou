// src/lib/overwriteGuard.ts
// デスクトップ(Windows / Linux / macOS)のバッチ出力で、出力先フォルダに
// 同名ファイルが既にある場合の上書き確認。
//
// モバイルにはフォルダ内の同名ファイルを確認する仕組み(saveConflict.ts /
// batchSaveConflict.ts)があるが、デスクトップでは「出力フォルダを選ぶ」だけで
// ファイルを直接書き出していたため、同名ファイルがあると黙って上書きされていた。
// (単一ファイルの保存は OS 標準の「名前を付けて保存」ダイアログが上書き確認を
// 行うので対象外。)
//
// 使い方: バッチ1回の実行ごとに createOverwriteGuard() で1つ作り、
// 各出力ファイルを書き出す直前に resolve(予定パス) を呼んで、戻り値のパスへ
// 書き出す。null が返ったらユーザーがキャンセルしたので、残りの処理を中止する。
//
// 確認は1回だけ行い、選んだ方法(上書き / 連番を付けて保存)をその回の残りの
// 衝突にも適用する。出力が数十件になり得るため、1件ずつは確認しない。
// 出力名が事前に分かる処理は、進捗を始める前に precheck(予定パス一覧) で
// まとめて確認する(進捗の途中でダイアログが出ないようにするため)。
// 出力名が処理してみないと決まらない機能(PDF分割・画像書き出し等)は、
// 従来どおり最初に衝突した時点で resolve() が1回だけ確認する。
//
// モバイルでは何もしない(出力先は共有の一時ディレクトリで、本当の保存先への
// 衝突確認は commitGrouped() 側が行う)。

import { invoke } from "@tauri-apps/api/core";
import { useBatchSaveConflictStore } from "../store/useBatchSaveConflictStore";
import { isMobile, joinPath, pathExists } from "./tauri";

export interface OverwriteGuard {
  /**
   * 進捗を始める前に、出力予定のパスをまとめて渡して重複を確認する。
   * 既存ファイルと衝突するものがあれば、その件数を示して「すべて上書き /
   * 重複分だけ自動連番 / キャンセル」を1回だけ尋ね、選択をこの回の
   * 以降の resolve() にも適用する(書き出しの途中ではもう尋ねない)。
   * キャンセルなら false を返す(呼び出し側は進捗を始めずに中止すること)。
   * 衝突が無ければ何も尋ねず true。モバイルでは何もせず true。
   */
  precheck: (paths: string[]) => Promise<boolean>;
  /**
   * 書き出し先として使うパスを返す。キャンセル時は null。一度キャンセルされた
   * ガードは、以後のどの呼び出しにも(衝突の有無に関わらず) null を返す。
   */
  resolve: (path: string) => Promise<string | null>;
  /**
   * resolve() と同じだが、キャンセル時は null ではなく例外を投げる。
   * 出力ごとに try/catch で個別にエラーを記録する呼び出し側向け
   * (キャンセル後は上記のとおり以降も投げ続けるので、残りの処理も止まる)。
   */
  resolveOrThrow: (path: string) => Promise<string>;
  /** ユーザーが上書き確認でキャンセルしたか。真なら以降のファイルは処理しなくてよい。 */
  isCancelled: () => boolean;
}

/** "/a/b/sample.pdf" -> ["/a/b", "sample", ".pdf"] */
function splitPath(path: string): [string, string, string] {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dir = slash < 0 ? "" : path.slice(0, slash);
  const name = slash < 0 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return [dir, name, ""];
  return [dir, name.slice(0, dot), name.slice(dot)];
}

function folderLabel(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

/** `cancelledMessage`: resolveOrThrow() がキャンセル時に投げるエラーの文言(翻訳済み)。 */
export function createOverwriteGuard(cancelledMessage = "Cancelled"): OverwriteGuard {
  let decision: "overwrite" | "auto" | null = null;
  let cancelled = false;
  // この回で書き出し先に決めたパス。まだ書き出していない先行分と、
  // 連番の候補が重ならないようにする。
  const claimed = new Set<string>();
  // precheck() で渡された出力予定パス。自動連番の候補が、まだ書き出していない
  // 他の出力予定と重ならないようにするために使う。
  const planned = new Set<string>();

  // path 自身が衝突するか(ディスク上にある、またはこの回で既に書き出し先に決めた)
  const exists = async (p: string) => claimed.has(p) || (await pathExists(p));
  // 自動連番の候補として使えないか(上に加え、他の出力予定とも重ならないこと)
  const taken = async (p: string) => planned.has(p) || (await exists(p));

  async function nextFreeName(path: string): Promise<string> {
    const [dir, base, ext] = splitPath(path);
    const sep = dir.includes("\\") ? "\\" : "/";
    for (let n = 1; n <= 999; n++) {
      const candidate = `${dir}${sep}${base} (${n})${ext}`;
      if (!(await taken(candidate))) return candidate;
    }
    return `${dir}${sep}${base} (${Date.now()})${ext}`;
  }

  const resolve = async (path: string): Promise<string | null> => {
    if (await isMobile()) return path;
    if (cancelled) return null;
    if (!(await exists(path))) {
      claimed.add(path);
      return path;
    }
    if (decision === null) {
      const [dir, base, ext] = splitPath(path);
      const choice = await useBatchSaveConflictStore
        .getState()
        .ask(1, folderLabel(dir), `${base}${ext}`);
      if (choice.action === "cancel") {
        cancelled = true;
        return null;
      }
      decision = choice.action;
    }
    if (decision === "overwrite") {
      claimed.add(path);
      return path;
    }
    const renamed = await nextFreeName(path);
    claimed.add(renamed);
    return renamed;
  };

  const precheck = async (paths: string[]): Promise<boolean> => {
    if (await isMobile()) return true;
    if (cancelled) return false;
    for (const p of paths) planned.add(p);
    // 既に選択済み(同じガードで2回目以降の呼び出し)なら尋ね直さない
    if (decision !== null) return true;
    const conflicts: string[] = [];
    for (const p of new Set(paths)) {
      if (await pathExists(p)) conflicts.push(p);
    }
    if (conflicts.length === 0) return true;
    const [dir] = splitPath(conflicts[0]);
    const choice = await useBatchSaveConflictStore
      .getState()
      .ask(conflicts.length, folderLabel(dir));
    if (choice.action === "cancel") {
      cancelled = true;
      return false;
    }
    decision = choice.action;
    return true;
  };

  return {
    resolve,
    precheck,
    isCancelled: () => cancelled,
    async resolveOrThrow(path) {
      const out = await resolve(path);
      if (out === null) throw new Error(cancelledMessage);
      return out;
    },
  };
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * 出力ファイル名を Rust 側が決める処理(PDF分割・画像書き出し等)用。
 * 書き出し前に名前が分からず resolve() を呼べないため、いったんアプリ専用の
 * 作業フォルダへ出力させ、できたファイルを1つずつ guard.resolve() で確認して
 * 本来の出力先 `destDir` へ移す。戻り値は `files` を最終的な保存先パスに
 * 差し替えた結果。確認でキャンセルされたら null (作業フォルダに残った分は
 * 削除し、出力先には何も増やさない。ただしキャンセル前に移した分は残る)。
 *
 * モバイルでは何もせず produce(destDir) をそのまま呼ぶ。
 */
export async function withOverwriteGuard<R extends { files: string[] }>(
  guard: OverwriteGuard,
  destDir: string,
  produce: (dir: string) => Promise<R>,
): Promise<R | null> {
  if (await isMobile()) return await produce(destDir);
  if (guard.isCancelled()) return null; // 既にキャンセル済み: 無駄に書き出さない

  const token = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const stageDir = await invoke<string>("get_temp_path", { name: `stage_${token}` });
  const res = await produce(stageDir);

  const finalFiles: string[] = [];
  for (let i = 0; i < res.files.length; i++) {
    const src = res.files[i];
    const dest = await guard.resolve(joinPath(destDir, baseName(src)));
    if (dest === null) {
      // 残りの作業ファイルを片付ける
      for (const rest of res.files.slice(i)) {
        await invoke("remove_file", { path: rest }).catch(() => {});
      }
      return null;
    }
    await invoke("move_file", { src, dst: dest });
    finalFiles.push(dest);
  }
  return { ...res, files: finalFiles };
}
