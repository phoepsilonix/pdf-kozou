// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import React, { useEffect, useState } from "react";

import { usePdfStore } from "../store/usePdfStore";
import { useI18n } from "../lib/i18n";

const LicensePage: React.FC = () => {
  const [gsStatus, setGsStatus] = useState<"checking" | "found" | "missing">("checking");
  const [gsVersion, setGsVersion] = useState("");
  const { useGsPreference, setUseGsPreference } = usePdfStore();
  const { t } = useI18n();

  const openUrl = async (url: string) => {
    await open(url);
  };

  const checkGs = async () => {
    setGsStatus("checking");
    try {
      const res = await invoke<string | null>("find_gs_executable");
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
