// src/lib/formatDate.ts
// ファイル一覧に出す更新日時の表示用整形。

const fmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** UNIX エポックからのミリ秒を、ロケールに合わせた「日付 時:分」にする。不明(0/未設定)は空文字。 */
export function formatModified(ms: number | undefined): string {
  if (!ms || ms <= 0) return "";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : fmt.format(d);
}
