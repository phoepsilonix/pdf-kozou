// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import {
  verifyGsPath,
  pickGsExecutable,
  findGsExecutable,
  findGsInDir,
  suggestGsCandidates,
} from "../lib/tauri";
import { open } from "@tauri-apps/plugin-shell";
import React, { useEffect, useState } from "react";

import { usePdfStore } from "../store/usePdfStore";
import { useI18n } from "../lib/i18n";
import { FS } from "../lib/typography";

// ── ShortcutGroup サブコンポーネント ────────────────────────────────────────

interface ShortcutRow {
  keys: string[];
  desc: string;
}

function ShortcutGroup({
  heading,
  badge,
  rows,
}: {
  heading: string;
  badge?: string;
  rows: ShortcutRow[];
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span
          style={{
            fontSize: FS.small,
            fontWeight: 700,
            color: "var(--c-textSub)",
            letterSpacing: "0.06em",
          }}
        >
          {heading}
        </span>
        {badge && (
          <span
            style={{
              fontSize: FS.caption,
              padding: "1px 6px",
              background: "rgba(var(--c-accent-rgb),0.15)",
              color: "var(--c-accent)",
              borderRadius: 3,
            }}
          >
            {badge}
          </span>
        )}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: FS.body }}>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: "1px solid var(--c-border)" }}>
              <td style={{ padding: "5px 0", width: "44%", verticalAlign: "middle" }}>
                {row.keys.map((k, j) =>
                  k === "〜" || k === "/" ? (
                    <span
                      key={j}
                      style={{ fontSize: FS.caption, color: "var(--c-textDim)", margin: "0 3px" }}
                    >
                      {k}
                    </span>
                  ) : (
                    <kbd
                      key={j}
                      style={{
                        display: "inline-block",
                        padding: "2px 7px",
                        background: "var(--c-bg)",
                        border: "1px solid var(--c-borderHi)",
                        borderRadius: 4,
                        fontFamily: "monospace",
                        fontSize: FS.small,
                        color: "var(--c-text)",
                        marginRight: 3,
                      }}
                    >
                      {k}
                    </kbd>
                  ),
                )}
              </td>
              <td
                style={{
                  padding: "5px 0 5px 12px",
                  color: "var(--c-textSub)",
                  verticalAlign: "middle",
                }}
              >
                {row.desc}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const LicensePage: React.FC = () => {
  const { useGsPreference, setUseGsPreference, customGsPath, setCustomGsPath } = usePdfStore();
  const { t } = useI18n();
  const [gsStatus, setGsStatus] = useState<"checking" | "found" | "missing">("checking");
  const [gsVersion, setGsVersion] = useState("");
  const [gsPathInput, setGsPathInput] = useState(customGsPath);
  const [gsVerifyMsg, setGsVerifyMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  const [gsVerifying, setGsVerifying] = useState(false);
  const [gsCandidates, setGsCandidates] = useState<string[]>([]);

  const openUrl = async (url: string) => {
    await open(url);
  };

  const checkGs = async (path?: string) => {
    setGsStatus("checking");
    try {
      // path が明示的に渡された場合はそれを使う（undefined は「引数なし」）
      // 渡されない場合は store の customGsPath を使い、空文字なら undefined
      const gsPath = path !== undefined ? path : customGsPath || undefined;
      const res = await findGsExecutable(gsPath);
      if (res) {
        setGsStatus("found");
        setGsVersion(res);
      } else {
        setGsStatus("missing");
      }
    } catch {
      setGsStatus("missing");
    }
  };

  const handleVerify = async () => {
    if (!gsPathInput.trim()) return;
    setGsVerifying(true);
    setGsVerifyMsg(null);
    try {
      const version = await verifyGsPath(gsPathInput.trim());
      setGsVerifyMsg({ ok: true, msg: `✅ GS ${version}` });
      setCustomGsPath(gsPathInput.trim());
      await checkGs(gsPathInput.trim());
    } catch (e) {
      setGsVerifyMsg({ ok: false, msg: `❌ ${String(e)}` });
    } finally {
      setGsVerifying(false);
    }
  };

  const handlePickGs = async () => {
    try {
      const picked = await pickGsExecutable();
      if (picked) {
        setGsPathInput(picked);
        setGsVerifyMsg(null);
      }
    } catch {
      /* キャンセルは無視 */
    }
  };

  const handlePickGsFolder = async () => {
    try {
      const dir = await invoke<string | null>("pick_output_dir").catch(() => null);
      if (!dir) return;
      setGsVerifying(true);
      setGsVerifyMsg(null);
      const found = await findGsInDir(dir);
      if (found) {
        setGsPathInput(found);
        setGsVerifyMsg({
          ok: true,
          msg: `✅ ${t("license.gs_found_in_dir")}: ${found.split(/[/\\]/).pop()}`,
        });
      } else {
        setGsVerifyMsg({ ok: false, msg: `❌ ${t("license.gs_not_found_in_dir")}` });
      }
    } catch {
      /* キャンセルは無視 */
    } finally {
      setGsVerifying(false);
    }
  };

  const handleClearCustomGs = async () => {
    setGsPathInput("");
    setGsVerifyMsg(null);
    setCustomGsPath("");
    // store 更新は非同期なので、空文字を明示的に渡して自動検索させる
    // path="" → gsPath="" → findGsExecutable(null) → 自動検索
    await checkGs("");
  };

  useEffect(() => {
    checkGs();
    // OS のデフォルト候補を取得
    suggestGsCandidates()
      .then(setGsCandidates)
      .catch(() => {});
  }, []);

  const openGitHub = async () => {
    try {
      openUrl("https://github.com/phoepsilonix/pdf-kozou");
    } catch (e) {
      console.error("Failed to open browser:", e);
    }
  };

  return (
    <div style={s.container}>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <h1 style={s.title}>{t("license.title")}</h1>

      {/* 対応形式セクション */}
      <section style={s.section}>
        <h2 style={s.h2}>{t("license.formats_heading")}</h2>
        <div style={s.card}>
          <p style={{ marginBottom: 12 }}>{t("license.formats_intro")}</p>
          <div style={s.featureGrid}>
            <div style={s.formatGroup}>
              <div style={s.formatLabel}>{t("license.formats_direct")}</div>
              <div style={s.formatList}>
                <span style={s.fmtTag}>PDF</span>
              </div>
            </div>
            <div style={s.formatGroup}>
              <div style={s.formatLabel}>{t("license.formats_convert")}</div>
              <div style={s.formatList}>
                {[
                  "EPUB",
                  "DOCX",
                  "XLSX",
                  "PPTX",
                  "XPS / OXPS",
                  "CBZ / CBR",
                  "HTML / XHTML",
                  "SVG",
                  "JPEG / PNG",
                  "BMP / GIF",
                  "TIFF / WebP",
                ].map((f) => (
                  <span key={f} style={s.fmtTag}>
                    {f}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div style={s.tip}>
            <strong>{t("license.formats_note_title")}</strong>
            <br />
            {t("license.formats_note_body")}
            <br />
            <span
              style={{
                color: "var(--c-textDim)",
                fontSize: FS.caption,
                marginTop: 6,
                display: "block",
              }}
            >
              {t("license.formats_note_caveat")}
            </span>
          </div>
        </div>
      </section>

      {/* GS モードの解説セクション */}
      <section style={s.section}>
        <h2 style={s.h2}>{t("license.gs_heading")}</h2>
        <div style={s.card}>
          <p>{t("license.gs_intro")}</p>
          <div style={s.featureGrid}>
            <div style={s.featureItem}>
              <div style={s.icon}>✂️</div>
              <div>
                <strong>{t("license.gs_feature1_title")}</strong>
                <p style={s.small}>{t("license.gs_feature1_desc")}</p>
              </div>
            </div>
            <div style={s.featureItem}>
              <div style={s.icon}>🖼️</div>
              <div>
                <strong>{t("license.gs_feature2_title")}</strong>
                <p style={s.small}>{t("license.gs_feature2_desc")}</p>
              </div>
            </div>
          </div>
          <div style={s.tip}>
            <strong>{t("license.gs_flow_title")}</strong>
            <br />
            1. {t("license.gs_flow_1")}
            <br />
            2. {t("license.gs_flow_2")}
            <br />
            3. {t("license.gs_flow_3")}
          </div>
        </div>
      </section>

      {/* システム診断セクション */}
      <section style={s.section}>
        <h2 style={s.h2}>{t("license.diag_heading")}</h2>
        <div
          style={{
            ...s.card,
            border: gsStatus === "missing" ? "1px solid var(--c-err)" : s.card.border,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <strong>{t("license.diag_gs_label")}</strong>
              <span
                style={{
                  marginLeft: 8,
                  color:
                    gsVerifying || gsStatus === "checking"
                      ? "var(--c-textDim)"
                      : gsStatus === "found"
                        ? "var(--c-ok)"
                        : "var(--c-err)",
                }}
              >
                {(gsVerifying || gsStatus === "checking") && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>
                      ⏳
                    </span>
                    {t("license.diag_checking")}
                  </span>
                )}
                {!gsVerifying &&
                  gsStatus === "found" &&
                  t("license.diag_found", { version: gsVersion })}
                {!gsVerifying && gsStatus === "missing" && t("license.diag_missing")}
              </span>
            </div>
            <button
              onClick={() => checkGs()}
              style={{
                ...s.btnSmall,
                ...(gsVerifying || gsStatus === "checking" ? s.btnDisabled : {}),
              }}
              disabled={gsVerifying || gsStatus === "checking"}
            >
              {gsStatus === "checking" ? t("license.diag_checking") : t("license.diag_recheck")}
            </button>
          </div>

          {gsStatus === "missing" && (
            <div style={s.downloadBox}>
              <p style={{ fontSize: "13px", marginBottom: "10px", lineHeight: "1.6" }}>
                <strong>{t("license.diag_mupdf_title")}</strong>
                <br />
                {t("license.diag_mupdf_body")}
                <br />
                <br />
                {t("license.diag_gs_hint")}
              </p>
              <button onClick={openGitHub} style={s.btnSmall}>
                {t("license.diag_github_btn")}
              </button>
            </div>
          )}
        </div>
      </section>

      {/* GS パス手動指定セクション（常時表示） */}
      <section style={s.section}>
        <h2 style={s.h2}>{t("license.gs_path_heading")}</h2>
        <div style={s.settingsCard}>
          <div style={s.settingText}>
            <div style={s.settingTitle}>{t("license.gs_path_title")}</div>
            <div style={s.settingDesc}>{t("license.gs_path_desc")}</div>
          </div>
          <div
            style={{
              display: "flex",
              gap: 6,
              marginTop: 8,
              alignItems: "center",
              flexWrap: "wrap" as const,
            }}
          >
            <input
              type="text"
              value={gsPathInput}
              onChange={(e) => {
                setGsPathInput(e.target.value);
                setGsVerifyMsg(null);
              }}
              placeholder={t("license.gs_path_placeholder")}
              style={s.pathInput}
              spellCheck={false}
            />
            <button
              style={s.btnSmall}
              onClick={handlePickGsFolder}
              title={t("license.gs_browse_folder_hint")}
            >
              📁 {t("license.gs_browse_folder")}
            </button>
            <button
              style={{ ...s.btnSmall, ...s.btnSecondary }}
              onClick={handlePickGs}
              title={t("license.gs_path_browse")}
            >
              🔍
            </button>
            <button
              style={{ ...s.btnSmall, ...(gsVerifying ? s.btnDisabled : {}) }}
              onClick={handleVerify}
              disabled={gsVerifying || !gsPathInput.trim()}
            >
              ✔ {gsVerifying ? t("license.gs_path_verifying") : t("license.gs_path_verify")}
            </button>
            {customGsPath && (
              <button style={{ ...s.btnSmall, ...s.btnClear }} onClick={handleClearCustomGs}>
                ✕ {t("license.gs_path_clear")}
              </button>
            )}
          </div>
          {/* 候補パス */}
          {gsCandidates.length > 0 && (
            <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap" as const, gap: 4 }}>
              <span
                style={{ fontSize: FS.caption, color: "var(--c-textDim)", alignSelf: "center" }}
              >
                {t("license.gs_candidates")}:
              </span>
              {gsCandidates.map((c) => (
                <button
                  key={c}
                  style={s.candidateBtn}
                  onClick={() => {
                    setGsPathInput(c);
                    setGsVerifyMsg(null);
                  }}
                  title={c}
                >
                  {c.split(/[/\\]/).pop()}
                </button>
              ))}
            </div>
          )}
          {gsVerifyMsg && (
            <div
              style={{
                ...s.verifyMsg,
                color: gsVerifyMsg.ok ? "var(--c-ok, #4caf50)" : "var(--c-err, #e55)",
              }}
            >
              {gsVerifyMsg.msg}
            </div>
          )}
          {customGsPath && (
            <div style={s.currentPath}>
              {t("license.gs_path_current")}: <code>{customGsPath}</code>
            </div>
          )}
        </div>
      </section>

      {/* 動作設定セクション（GS 検出時のみ） */}
      {gsStatus === "found" && (
        <section style={s.section}>
          <h2 style={s.h2}>{t("license.settings_heading")}</h2>
          <div style={s.settingsCard}>
            <label style={s.label}>
              <input
                type="checkbox"
                checked={useGsPreference}
                onChange={(e) => setUseGsPreference(e.target.checked)}
                style={s.checkbox}
              />
              <div style={s.settingText}>
                <div style={s.settingTitle}>{t("license.settings_gs_title")}</div>
                <div style={s.settingDesc}>{t("license.settings_gs_desc")}</div>
              </div>
            </label>
          </div>
        </section>
      )}

      {gsStatus === "missing" && <p style={s.hintSmall}>{t("license.settings_gs_hint")}</p>}

      {/* ライセンステーブル */}
      <section style={s.section}>
        <h2 style={s.h2}>{t("license.license_heading")}</h2>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Library</th>
              <th style={s.th}>License</th>
              <th style={s.th}>Usage</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={s.td}>MuPDF</td>
              <td style={s.td}>AGPL v3</td>
              <td style={s.td}>{t("license.license_usage_mupdf")}</td>
            </tr>
            <tr>
              <td style={s.td}>Ghostscript</td>
              <td style={s.td}>AGPL v3</td>
              <td style={s.td}>{t("license.license_usage_gs")}</td>
            </tr>
            <tr>
              <td style={s.td}>Tauri</td>
              <td style={s.td}>MIT / Apache</td>
              <td style={s.td}>{t("license.license_usage_tauri")}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* キーボードショートカット */}
      <section style={s.section}>
        <h2 style={s.h2}>{t("shortcuts.section_title")}</h2>
        <div style={s.card}>
          <ShortcutGroup
            heading={t("shortcuts.group_global")}
            badge={t("shortcuts.always_badge")}
            rows={[
              { keys: ["Alt+T"], desc: t("shortcuts.tts_toggle") },
              { keys: ["Alt+L"], desc: t("shortcuts.lang_toggle") },
              { keys: ["Alt+H"], desc: t("shortcuts.go_home") },
              { keys: ["F1"], desc: t("shortcuts.show_shortcuts") },
            ]}
          />
          <ShortcutGroup
            heading={t("shortcuts.group_home")}
            rows={[
              { keys: ["Ctrl+O"], desc: t("shortcuts.open_file") },
              { keys: ["Alt+1"], desc: t("shortcuts.tool_1") },
              { keys: ["Alt+2"], desc: t("shortcuts.tool_2") },
              { keys: ["Alt+3"], desc: t("shortcuts.tool_3") },
              { keys: ["Alt+4"], desc: t("shortcuts.tool_4") },
              { keys: ["Alt+5"], desc: t("shortcuts.tool_5") },
              { keys: ["Alt+6"], desc: t("shortcuts.tool_6") },
              { keys: ["Alt+7"], desc: t("shortcuts.tool_7") },
              { keys: ["Alt+8"], desc: t("shortcuts.tool_8") },
              { keys: ["Alt+9"], desc: t("shortcuts.tool_9") },
            ]}
          />
          <ShortcutGroup
            heading={t("shortcuts.group_tool")}
            rows={[
              { keys: ["Ctrl+Enter"], desc: t("shortcuts.execute") },
              { keys: ["Ctrl+S"], desc: t("shortcuts.save") },
              { keys: ["Ctrl+Shift+S"], desc: t("shortcuts.save_compress") },
              { keys: ["Ctrl+Shift+O"], desc: t("shortcuts.save_original") },
              { keys: ["Alt+D"], desc: t("shortcuts.output_dir") },
              { keys: ["Alt+R"], desc: t("shortcuts.range_focus") },
              { keys: ["Alt+M"], desc: t("shortcuts.margin_focus") },
              { keys: ["Escape"], desc: t("shortcuts.escape_desc") },
              { keys: ["Alt+1", "〜", "Alt+9"], desc: t("shortcuts.switch_tool") },
            ]}
          />
          <ShortcutGroup
            heading={t("shortcuts.group_viewer")}
            rows={[
              { keys: ["←", "→"], desc: t("shortcuts.prev_next_page") },
              { keys: ["Ctrl+F"], desc: t("shortcuts.search") },
              { keys: ["Ctrl+Wheel"], desc: t("shortcuts.zoom") },
            ]}
          />
          <ShortcutGroup
            heading={t("shortcuts.group_modal")}
            rows={[
              { keys: ["Ctrl+Enter"], desc: t("shortcuts.modal_save") },
              { keys: ["Escape"], desc: t("shortcuts.modal_close") },
            ]}
          />
        </div>
      </section>

      {/* ソースコード */}
      <section style={s.section}>
        <h2 style={s.h2}>{t("license.source_heading")}</h2>
        <div style={s.card}>
          <p style={{ fontSize: "14px", marginBottom: "12px" }}>{t("license.source_body")}</p>
          <button onClick={openGitHub} style={s.githubBtn}>
            <span style={{ fontSize: "18px" }}>{t("license.github_btn")}</span>
            <span style={{ fontSize: "12px", opacity: 0.8 }}> (External Link)</span>
          </button>
        </div>
      </section>

      <div style={s.footer}>
        © 2026 PDF Kozou Project.
        <br />
        Copyright (C) 2026 Masato TOYOSHIMA {"<phoepsilonix at gmail dot com>"}
        <br />
        SPDX-License-Identifier: AGPL-3.0-or-later
      </div>
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  container: {
    padding: "32px",
    color: "var(--c-text)",
    lineHeight: 1.5,
    overflowY: "auto",
    height: "100%",
  },
  title: { fontSize: "24px", marginBottom: "24px", fontWeight: 800 },
  section: { marginBottom: "32px" },
  h2: {
    fontSize: "16px",
    marginBottom: "12px",
    color: "var(--c-accent)",
    display: "flex",
    alignItems: "center",
  },
  card: {
    background: "var(--c-bgSub)",
    padding: "20px",
    borderRadius: "8px",
    border: "1px solid var(--c-border)",
  },
  featureGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginTop: "16px" },
  featureItem: { display: "flex", gap: "12px", alignItems: "flex-start" },
  icon: { fontSize: "20px" },
  small: { fontSize: "12px", color: "var(--c-textDim)", marginTop: "4px" },
  tip: {
    marginTop: "20px",
    padding: "12px",
    background: "rgba(var(--c-accent-rgb), 0.1)",
    borderRadius: "6px",
    fontSize: "13px",
    borderLeft: "4px solid var(--c-accent)",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "13px" },
  th: {
    textAlign: "left",
    padding: "8px",
    borderBottom: "2px solid var(--c-border)",
    color: "var(--c-textSub)",
  },
  td: { padding: "8px", borderBottom: "1px solid var(--c-border)" },
  // btnSmall は後方で定義（下記参照）
  downloadBox: {
    marginTop: "16px",
    padding: "16px",
    background: "var(--c-errBg)",
    borderRadius: "6px",
  },
  githubBtn: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 20px",
    background: "#24292e",
    color: "#ffffff",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: 600,
    transition: "transform 0.1s, background 0.2s",
  },
  settingsCard: {
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-borderHi)",
    borderRadius: "10px",
    padding: "16px",
    marginTop: "10px",
  },
  label: { display: "flex", alignItems: "flex-start", gap: "12px", cursor: "pointer" },
  checkbox: { marginTop: "4px", width: "18px", height: "18px", accentColor: "var(--c-accent)" },
  settingText: { flex: 1 },
  settingTitle: { fontSize: "14px", fontWeight: 700, color: "var(--c-text)" },
  settingDesc: { fontSize: "12px", color: "var(--c-textDim)", marginTop: "4px", lineHeight: "1.4" },
  formatGroup: { marginBottom: 12 },
  formatLabel: {
    fontSize: FS.small,
    fontWeight: 700,
    color: "var(--c-textDim)",
    marginBottom: 6,
    letterSpacing: "0.05em",
  },
  formatList: { display: "flex", flexWrap: "wrap" as const, gap: 6 },
  fmtTag: {
    display: "inline-block",
    padding: "2px 10px",
    background: "var(--c-bg)",
    border: "1px solid var(--c-border)",
    borderRadius: 12,
    fontSize: FS.small,
    color: "var(--c-text)",
    fontFamily: "monospace",
  },
  hintSmall: {
    fontSize: "11px",
    color: "var(--c-textDim)",
    textAlign: "center" as const,
    marginTop: "20px",
    fontStyle: "italic",
  },
  pathInput: {
    flex: 1,
    minWidth: 0,
    padding: "6px 10px",
    background: "var(--c-bg)",
    border: "1px solid var(--c-border)",
    borderRadius: 6,
    color: "var(--c-text)",
    fontSize: FS.small,
    fontFamily: "monospace",
  },
  btnSmall: {
    padding: "5px 12px",
    background: "transparent",
    border: "1px solid var(--c-border)",
    borderRadius: 6,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontSize: FS.small,
    fontFamily: "inherit",
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
  },
  btnClear: { borderColor: "var(--c-err, #e55)", color: "var(--c-err, #e55)" },
  btnSecondary: { padding: "5px 8px", opacity: 0.7 },
  candidateBtn: {
    padding: "3px 8px",
    background: "var(--c-accentBg)",
    border: "1px solid var(--c-accentBd)",
    borderRadius: 4,
    color: "var(--c-accent)",
    cursor: "pointer",
    fontSize: FS.caption,
    fontFamily: "inherit",
    maxWidth: 180,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  btnDisabled: { opacity: 0.5, cursor: "not-allowed" as const },
  verifyMsg: { marginTop: 6, fontSize: FS.small, fontWeight: 600 },
  currentPath: { marginTop: 6, fontSize: FS.caption, color: "var(--c-textDim)" },
  footer: { textAlign: "center", marginTop: "48px", fontSize: "11px", color: "var(--c-textDim)" },
};

export default LicensePage;
