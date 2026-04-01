// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import React, { useEffect, useState } from "react";

import { usePdfStore } from "../store/usePdfStore";
import { useI18n } from "../lib/i18n";

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
            fontSize: 12,
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
              fontSize: 10,
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
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: "1px solid var(--c-border)" }}>
              <td style={{ padding: "5px 0", width: "44%", verticalAlign: "middle" }}>
                {row.keys.map((k, j) =>
                  k === "〜" || k === "/" ? (
                    <span
                      key={j}
                      style={{ fontSize: 11, color: "var(--c-textDim)", margin: "0 3px" }}
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
                        fontSize: 12,
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
  const [gsStatus, setGsStatus] = useState<"checking" | "found" | "missing">("checking");
  const [gsVersion, setGsVersion] = useState("");
  const { useGsPreference, setUseGsPreference, customGsPath, setCustomGsPath } = usePdfStore();
  const [gsPathInput, setGsPathInput] = useState(customGsPath);
  const [verifyStatus, setVerifyStatus] = useState<"idle" | "ok" | "error">("idle");
  const [verifyMsg, setVerifyMsg] = useState("");
  const { t } = useI18n();

  const openUrl = async (url: string) => {
    await open(url);
  };

  const checkGs = async () => {
    setGsStatus("checking");
    try {
      const res = await invoke<string | null>("find_gs_executable", {
        customGsPath: customGsPath || null,
      });
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

  const handlePickGs = async () => {
    const picked = await invoke<string | null>("pick_gs_executable").catch(() => null);
    if (picked) setGsPathInput(picked);
  };

  const handleVerifyAndSave = async () => {
    const p = gsPathInput.trim();
    if (!p) {
      // 空文字でクリア
      setCustomGsPath("");
      setVerifyStatus("idle");
      setVerifyMsg("");
      await checkGs();
      return;
    }
    setVerifyStatus("idle");
    try {
      const version = await invoke<string>("verify_gs_path", { path: p });
      setCustomGsPath(p);
      setVerifyStatus("ok");
      setVerifyMsg(`GS ${version}`);
      await checkGs();
    } catch (e) {
      setVerifyStatus("error");
      setVerifyMsg(String(e));
    }
  };

  useEffect(() => {
    checkGs();
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
              style={{ color: "var(--c-textDim)", fontSize: 11, marginTop: 6, display: "block" }}
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
                  color: gsStatus === "found" ? "var(--c-ok)" : "var(--c-err)",
                }}
              >
                {gsStatus === "checking" && t("license.diag_checking")}
                {gsStatus === "found" && t("license.diag_found", { version: gsVersion })}
                {gsStatus === "missing" && t("license.diag_missing")}
              </span>
            </div>
            <button onClick={checkGs} style={s.btnSmall}>
              {t("license.diag_recheck")}
            </button>
          </div>

          {/* GS パス手動指定 */}
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 12, color: "var(--c-textSub)", marginBottom: 2 }}>
              {t("license.custom_gs_path_label")}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="text"
                value={gsPathInput}
                onChange={(e) => {
                  setGsPathInput(e.target.value);
                  setVerifyStatus("idle");
                }}
                placeholder={t("license.custom_gs_path_placeholder")}
                style={{
                  flex: 1,
                  padding: "5px 8px",
                  background: "var(--c-bg)",
                  border: "1px solid var(--c-border)",
                  borderRadius: 6,
                  color: "var(--c-text)",
                  fontSize: 12,
                  fontFamily: "inherit",
                }}
              />
              <button onClick={handlePickGs} style={s.btnSmall}>
                {t("license.custom_gs_browse")}
              </button>
              <button onClick={handleVerifyAndSave} style={s.btnSmall}>
                {t("license.custom_gs_apply")}
              </button>
              {customGsPath && (
                <button
                  onClick={() => {
                    setCustomGsPath("");
                    setGsPathInput("");
                    setVerifyStatus("idle");
                    checkGs();
                  }}
                  style={{ ...s.btnSmall, color: "var(--c-err)" }}
                >
                  ✕
                </button>
              )}
            </div>
            {verifyStatus === "ok" && (
              <span style={{ fontSize: 11, color: "var(--c-ok)" }}>✅ {verifyMsg}</span>
            )}
            {verifyStatus === "error" && (
              <span style={{ fontSize: 11, color: "var(--c-err)" }}>❌ {verifyMsg}</span>
            )}
            {customGsPath && verifyStatus === "idle" && (
              <span style={{ fontSize: 11, color: "var(--c-textDim)" }}>
                📌 {t("license.custom_gs_saved")}: {customGsPath.split(/[/\\]/).pop()}
              </span>
            )}
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
            ]}
          />
          <ShortcutGroup
            heading={t("shortcuts.group_tool")}
            rows={[
              { keys: ["Ctrl+Enter"], desc: t("shortcuts.execute") },
              { keys: ["Ctrl+S"], desc: t("shortcuts.save") },
              { keys: ["Ctrl+Shift+S"], desc: t("shortcuts.save_compress") },
              { keys: ["Alt+D"], desc: t("shortcuts.output_dir") },
              { keys: ["Alt+R"], desc: t("shortcuts.range_focus") },
              { keys: ["Alt+M"], desc: t("shortcuts.margin_focus") },
              { keys: ["Escape"], desc: t("shortcuts.escape_desc") },
              { keys: ["Alt+1", "〜", "Alt+7"], desc: t("shortcuts.switch_tool") },
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
  btnSmall: {
    padding: "4px 12px",
    borderRadius: "4px",
    border: "1px solid var(--c-border)",
    background: "none",
    color: "var(--c-text)",
    cursor: "pointer",
    fontSize: "12px",
  },
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
    fontSize: 12,
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
    fontSize: 12,
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
  footer: { textAlign: "center", marginTop: "48px", fontSize: "11px", color: "var(--c-textDim)" },
};

export default LicensePage;
