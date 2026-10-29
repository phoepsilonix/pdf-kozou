// src/lib/engineFallback.ts
// コアが送る `engine-fallback` イベント (hayro → MuPDF の自動フォールバック) を
// useEngineFallbackStore へ流し込む。起動時に一度だけ initEngineFallback() を呼ぶ。

import { listen } from "@tauri-apps/api/event";
import { type EngineFallbackPayload, useEngineFallbackStore } from "../store/useEngineFallbackStore";

/** 戻り値は購読解除関数。Tauri 外 (vite dev など) では何もせず空の関数を返す。 */
export async function initEngineFallback(): Promise<() => void> {
  try {
    return await listen<EngineFallbackPayload>("engine-fallback", (event) => {
      useEngineFallbackStore.getState().add(event.payload);
    });
  } catch {
    return () => {};
  }
}

/** パスからファイル名だけを取り出す */
export function baseName(path: string | null): string {
  if (!path) return "";
  return path.split(/[\\/]/).pop() ?? path;
}

/** ページ番号 (0 始まりの配列) を "3, 5, 7" のような表示用文字列にする。多いときは省略 */
export function formatPages(pages: number[], max = 5): string {
  const shown = pages.slice(0, max).map((p) => String(p + 1));
  return pages.length > max ? `${shown.join(", ")}…` : shown.join(", ");
}
