// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/MetadataEditModal.tsx
//
// PDF メタデータ編集モーダル。ViewerPage・TrimPage・MergePage から共通利用。
//
// 使い方:
//   <MetadataEditModal
//     filePath="/path/to/file.pdf"
//     initialMeta={{ title: "...", author: "..." }}
//     onClose={() => setOpen(false)}
//     onSaved={(newMeta) => { /* 保存後の処理 */ }}
//   />

import { useState, useCallback, useEffect } from "react";
import { setPdfMetadata, getPdfInfo, getImageMetadata, setImageMetadata } from "../lib/tauri";
import { useI18n } from "../lib/i18n";
import { tts } from "../lib/tts";
import { F } from "../lib/theme";

// ── 型定義 ─────────────────────────────────────────────────────────────────

export interface PdfMeta {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modDate?: string;
}

interface Props {
  filePath: string;
  initialMeta?: PdfMeta;
  onClose: () => void;
  onSaved?: (meta: PdfMeta) => void;
  /** true = 処理後の出力ファイル（元ファイル不変を明示）、false/省略 = 元ファイルを直接編集 */
  isOutputFile?: boolean;
  /** 保存ボタンのラベルを上書きする（例: 「確定」）。省略時は t("meta_edit.save") */
  saveLabel?: string;
}

// ── 編集可能フィールド定義 ──────────────────────────────────────────────────

const EDITABLE_FIELDS: { key: keyof PdfMeta; labelKey: string; pdfKey: string }[] = [
  { key: "title", labelKey: "meta_edit.title_field", pdfKey: "Title" },
  { key: "author", labelKey: "meta_edit.author", pdfKey: "Author" },
  { key: "subject", labelKey: "meta_edit.subject", pdfKey: "Subject" },
  { key: "keywords", labelKey: "meta_edit.keywords", pdfKey: "Keywords" },
  { key: "creator", labelKey: "meta_edit.creator", pdfKey: "Creator" },
];

const READONLY_FIELDS: { key: keyof PdfMeta; labelKey: string }[] = [
  { key: "producer", labelKey: "meta_edit.producer" },
  { key: "creationDate", labelKey: "meta_edit.creation_date" },
  { key: "modDate", labelKey: "meta_edit.mod_date" },
];

// ── コンポーネント ─────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "svg"]);
function isImageFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

export function MetadataEditModal({
  filePath,
  initialMeta,
  onClose,
  onSaved,
  isOutputFile = false,
  saveLabel,
}: Props) {
  const { t } = useI18n();
  const [form, setForm] = useState<PdfMeta>(initialMeta ?? {});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // filePath からメタデータを読み込んで初期値にする
  // initialMeta が undefined の場合のみ getPdfInfo で自動取得する
  // （明示的に渡された場合はたとえ空でも自動取得しない）
  useEffect(() => {
    if (initialMeta !== undefined) return; // 明示的に渡された場合はスキップ
    setLoading(true);
    if (isImageFile(filePath)) {
      // 画像ファイル: getImageMetadata で EXIF/XMP を読み込む
      getImageMetadata(filePath)
        .then((fields) => {
          const m: PdfMeta = {};
          for (const { key, value } of fields) {
            if (key === "Title") m.title = value;
            else if (key === "Author") m.author = value;
            else if (key === "Subject") m.subject = value;
            else if (key === "Keywords") m.keywords = value;
            else if (key === "Creator") m.creator = value;
            else if (key === "CreationDate") m.creationDate = value;
            else if (key === "ModDate") m.modDate = value;
          }
          setForm(m);
        })
        .catch(() => {
          /* 取得失敗は無視 */
        })
        .finally(() => setLoading(false));
    } else {
      getPdfInfo(filePath, {})
        .then((info) => {
          const m = info.metadata ?? {};
          setForm({
            title: m.title,
            author: m.author,
            subject: m.subject,
            keywords: m.keywords,
            creator: m.creator,
            producer: m.producer,
            creationDate: m.creation_date,
            modDate: m.mod_date,
          });
        })
        .catch(() => {
          /* 取得失敗は無視して空のまま */
        })
        .finally(() => setLoading(false));
    }
  }, [filePath, initialMeta]);

  // モーダルを開いた時に読み上げ
  useEffect(() => {
    tts.speak(t("meta_edit.modal_opened"));
  }, [t]);

  const handleChange = useCallback((key: keyof PdfMeta, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      if (saveLabel) {
        // saveLabel がある場合はファイル保存せず onSaved に form を渡すだけ
        // （SplitPage など「確定」モードで使用）
        onSaved?.(form);
        setSaving(false);
        return;
      }
      const metadata = EDITABLE_FIELDS.map(({ key, pdfKey }) => ({
        key: pdfKey,
        value: form[key] ?? "",
      }));
      if (isImageFile(filePath)) {
        await setImageMetadata(filePath, metadata);
      } else {
        await setPdfMetadata(filePath, metadata);
      }
      setSaved(true);
      tts.speak(t("meta_edit.saved"));
      onSaved?.(form);
    } catch (e) {
      const msg = String(e);
      setError(msg);
      tts.speak(t("meta_edit.save_error") + " " + msg);
    } finally {
      setSaving(false);
    }
  }, [filePath, form, t, onSaved, saveLabel]);

  // Escape で閉じる / Ctrl+Enter で保存（handleSave の後に定義）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, handleSave]);

  return (
    <>
      {/* オーバーレイ */}
      <div style={s.overlay} onClick={onClose} aria-hidden />

      {/* モーダル本体 */}
      <div role="dialog" aria-modal="true" aria-label={t("meta_edit.title")} style={s.modal}>
        {/* ヘッダ */}
        <div style={s.header}>
          <span style={s.headerTitle}>
            {isOutputFile ? t("meta_edit.title_output") : t("meta_edit.title_source")}
          </span>
          <button
            style={s.closeBtn}
            onClick={onClose}
            aria-label={t("meta_edit.close")}
            title={t("meta_edit.close") + " (Escape)"}
          >
            ✕
          </button>
        </div>

        {/* ファイルパス */}
        <div style={s.filepath}>
          <span style={{ color: "var(--c-textDim)", marginRight: 6, fontSize: 10 }}>
            {isOutputFile ? t("meta_edit.file_label_output") : t("meta_edit.file_label_source")}
          </span>
          <span>{filePath.split(/[/\\]/).pop()}</span>
        </div>
        {isOutputFile && <div style={s.outputNote}>✅ {t("meta_edit.output_note")}</div>}

        {/* 編集フォーム */}
        <div style={s.body}>
          {loading && (
            <div style={{ color: "var(--c-textDim)", fontSize: 13, padding: "8px 0" }}>
              {t("meta_edit.loading")}
            </div>
          )}
          {EDITABLE_FIELDS.map(({ key, labelKey }) => (
            <div key={key} style={s.fieldRow}>
              <label style={s.label} htmlFor={`meta-${key}`}>
                {t(labelKey)}
              </label>
              <input
                id={`meta-${key}`}
                style={s.input}
                type="text"
                value={form[key] ?? ""}
                onChange={(e) => handleChange(key, e.target.value)}
                onFocus={() => tts.speak(t(labelKey))}
                aria-label={t(labelKey)}
                placeholder={t("meta_edit.empty_hint")}
              />
            </div>
          ))}

          {/* 読み取り専用フィールド */}
          {READONLY_FIELDS.some(({ key }) => form[key]) && (
            <div style={s.readonlySection}>
              <div style={s.readonlyHeading}>{t("meta_edit.readonly_heading")}</div>
              {READONLY_FIELDS.map(({ key, labelKey }) =>
                form[key] ? (
                  <div key={key} style={s.fieldRow}>
                    <span style={s.label}>{t(labelKey)}</span>
                    <span style={{ ...s.input, ...s.readonlyValue }}>{form[key]}</span>
                  </div>
                ) : null,
              )}
            </div>
          )}
        </div>

        {/* エラー表示 */}
        {error && (
          <div style={s.errorMsg} role="alert">
            {t("meta_edit.save_error")}: {error}
          </div>
        )}

        {/* 保存完了メッセージ */}
        {saved && !error && (
          <div style={s.savedMsg} role="status">
            ✅ {t("meta_edit.saved")}
          </div>
        )}

        {/* フッタボタン */}
        <div style={s.footer}>
          <button style={s.cancelBtn} onClick={onClose} aria-label={t("meta_edit.close")}>
            {t("meta_edit.close")}
          </button>
          <button
            style={{ ...s.saveBtn, ...(saving ? s.saveBtnDisabled : {}) }}
            onClick={handleSave}
            disabled={saving}
            aria-label={t("meta_edit.save") + " Ctrl+Enter"}
            onFocus={() => tts.speak(t("meta_edit.save") + "。Ctrl+Enterでも実行できます。")}
          >
            {saving ? t("meta_edit.saving") : (saveLabel ?? t("meta_edit.save"))}
          </button>
        </div>
      </div>
    </>
  );
}

// ── スタイル ───────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    zIndex: 200,
  },
  modal: {
    // position: fixed + right:0 でウィンドウ右端に寄せる
    // ドロワー内から開いても右側が切れない
    position: "fixed",
    top: "50%",
    right: 0,
    transform: "translateY(-50%)",
    zIndex: 201,
    width: "min(480px, 100vw)",
    maxWidth: "100vw",
    maxHeight: "90vh",
    display: "flex",
    flexDirection: "column",
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-borderHi)",
    borderLeft: "3px solid var(--c-accent)",
    borderRadius: "12px 0 0 12px",
    boxShadow: "-4px 0 32px rgba(0,0,0,0.5)",
    fontFamily: F,
    overflow: "hidden",
    boxSizing: "border-box" as const,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 18px",
    borderBottom: "1px solid var(--c-border)",
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: "var(--c-text)",
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontSize: 16,
    padding: "2px 6px",
    borderRadius: 4,
  },
  filepath: {
    padding: "6px 18px",
    fontSize: 11,
    color: "var(--c-textDim)",
    borderBottom: "1px solid var(--c-border)",
    flexShrink: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  body: {
    flex: 1,
    overflowY: "auto",
    padding: "16px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  fieldRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  label: {
    width: 82,
    flexShrink: 0,
    fontSize: 12,
    color: "var(--c-textSub)",
    textAlign: "right" as const,
  },
  input: {
    flex: 1,
    padding: "6px 10px",
    background: "var(--c-bg)",
    border: "1px solid var(--c-border)",
    borderRadius: 6,
    color: "var(--c-text)",
    fontSize: 13,
    fontFamily: F,
    outline: "none",
  },
  readonlySection: {
    marginTop: 8,
    paddingTop: 10,
    borderTop: "1px dashed var(--c-border)",
  },
  readonlyHeading: {
    fontSize: 11,
    color: "var(--c-textDim)",
    marginBottom: 8,
    letterSpacing: "0.06em",
  },
  readonlyValue: {
    color: "var(--c-textDim)",
    fontSize: 12,
    background: "transparent",
    border: "1px solid transparent",
    cursor: "default",
  },
  errorMsg: {
    margin: "0 18px 10px",
    padding: "8px 12px",
    background: "var(--c-errBg)",
    border: "1px solid var(--c-errBd)",
    borderRadius: 6,
    fontSize: 12,
    color: "#cc5555",
    flexShrink: 0,
  },
  savedMsg: {
    margin: "0 18px 10px",
    padding: "8px 12px",
    background: "rgba(var(--c-accent-rgb), 0.1)",
    border: "1px solid var(--c-accent)",
    borderRadius: 6,
    fontSize: 12,
    color: "var(--c-accent)",
    flexShrink: 0,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    alignItems: "center",
    flexWrap: "wrap" as const,
    gap: 8,
    padding: "10px 14px",
    borderTop: "1px solid var(--c-border)",
    flexShrink: 0,
    background: "var(--c-bgCard)",
  },
  cancelBtn: {
    padding: "7px 14px",
    background: "transparent",
    border: "1px solid var(--c-border)",
    borderRadius: 7,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontSize: 13,
    fontFamily: F,
    flexShrink: 0,
  },
  saveBtn: {
    padding: "8px 20px",
    background: "var(--c-accent)",
    border: "none",
    borderRadius: 7,
    color: "#000",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 700,
    fontFamily: F,
    minWidth: 80,
    flexShrink: 0,
  },
  saveBtnDisabled: {
    opacity: 0.5,
    cursor: "not-allowed",
  },
  outputNote: {
    padding: "6px 18px",
    fontSize: 11,
    color: "var(--c-ok, #4caf50)",
    background: "rgba(76,175,80,0.08)",
    borderBottom: "1px solid var(--c-border)",
    flexShrink: 0,
  },
};
