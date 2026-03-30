// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import React, { useEffect, useState } from "react";

import { usePdfStore } from "../store/usePdfStore";

const LicensePage: React.FC = () => {
  const [gsStatus, setGsStatus] = useState<"checking" | "found" | "missing">("checking");
  const [gsVersion, setGsVersion] = useState("");

  const { gsAvailable, useGsPreference, setUseGsPreference } = usePdfStore();

  const openUrl = async (url: string) => {
    await open(url);
  };
  // 起動時、またはボタン押下時にGSの存在を確認
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
    } catch (e) {
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
      <h1 style={s.title}>About PDF小僧(PDF Kozou)</h1>

      {/* 対応形式セクション */}
      <section style={s.section}>
        <h2 style={s.h2}>📂 対応ファイル形式</h2>
        <div style={s.card}>
          <p style={{ marginBottom: 12 }}>
            PDF小僧は <strong>PDF 以外のファイル形式にも対応しています</strong>。 非 PDF
            ファイルを開くと内部で自動的に PDF に変換してから、
            分割・結合・トリミング・圧縮・画像変換などの各操作を行い、 PDF
            または画像として保存できます。
          </p>
          <div style={s.featureGrid}>
            <div style={s.formatGroup}>
              <div style={s.formatLabel}>✅ 直接対応（PDF として処理）</div>
              <div style={s.formatList}>
                <span style={s.fmtTag}>PDF</span>
              </div>
            </div>
            <div style={s.formatGroup}>
              <div style={s.formatLabel}>🔄 自動変換して対応</div>
              <div style={s.formatList}>
                <span style={s.fmtTag}>EPUB</span>
                <span style={s.fmtTag}>DOCX</span>
                <span style={s.fmtTag}>XLSX</span>
                <span style={s.fmtTag}>PPTX</span>
                <span style={s.fmtTag}>XPS / OXPS</span>
                <span style={s.fmtTag}>CBZ / CBR</span>
                <span style={s.fmtTag}>HTML / XHTML</span>
                <span style={s.fmtTag}>SVG</span>
                <span style={s.fmtTag}>JPEG / PNG</span>
                <span style={s.fmtTag}>BMP / GIF</span>
                <span style={s.fmtTag}>TIFF / WebP</span>
              </div>
            </div>
          </div>
          <div style={s.tip}>
            <strong>💡 変換について:</strong>
            <br />
            変換は <strong>MuPDF</strong> エンジンが行います。
            元ファイルのメタデータ（タイトル・作者・日付等）は、 MuPDF が読み取れる範囲で PDF
            に引き継がれます。 フォント・レイアウトの再現精度は MuPDF
            のレンダリング品質に依存します。
            <br />
            <span
              style={{ color: "var(--c-textDim)", fontSize: 11, marginTop: 6, display: "block" }}
            >
              ※ DOCX / XLSX / PPTX は MuPDF 1.28 以降で対応。
              複雑なレイアウトは完全には再現されない場合があります。
            </span>
          </div>
        </div>
      </section>

      {/* GSモードの解説セクション */}
      <section style={s.section}>
        <h2 style={s.h2}>⚡ Ghostscript (GS) と連携して圧縮できます</h2>
        <div style={s.card}>
          <p>
            本アプリの圧縮「プロモード」は、世界標準のPDFエンジン <strong>Ghostscript</strong>{" "}
            を呼び出します。
          </p>
          <div style={s.featureGrid}>
            <div style={s.featureItem}>
              <div style={s.icon}>✂️</div>
              <div>
                <strong>枠外データの完全抹消</strong>
                <p style={s.small}>
                  トリミングで見えなくなっている隠れたデータを上手に削除し、ファイルをクリーンアップします。
                </p>
              </div>
            </div>
            <div style={s.featureItem}>
              <div style={s.icon}>🖼️</div>
              <div>
                <strong>高度な再サンプリング</strong>
                <p style={s.small}>
                  バイリニア補間等を用い、見た目の美しさを維持したまま画像の解像度を最適化します。
                </p>
              </div>
            </div>
          </div>
          <div style={s.tip}>
            <strong>💡 おすすめの黄金フロー:</strong>
            <br />
            1. <strong>GSモード</strong>で「高品質」「圧縮」を行う
            <br />
            2. <strong>MuPDFモード</strong>
            で「論理的な最適化（オブジェクトストリーム、フォント統合等）」を行う
            <br />
            3. MuPDFモードで<strong>オブジェクトストリーム</strong>、
            <strong>フォント統合（リスク大き目。単一ページ向け）</strong>、をONにして圧縮後、
            <strong>GSモード</strong>
            で続けて圧縮するのもオススメです。何度か交互に繰り返すことで、それぞれのツールが活かされて更にサイズを減らせる場合もあります。
          </div>
        </div>
      </section>
      <section style={s.section}>
        <h2 style={s.h2}>🛠️ システム診断</h2>
        <div
          style={{
            ...s.card,
            border: gsStatus === "missing" ? "1px solid var(--c-err)" : s.card.border,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <strong>Ghostscript の状態:</strong>
              <span
                style={{
                  marginLeft: 8,
                  color: gsStatus === "found" ? "var(--c-ok)" : "var(--c-err)",
                }}
              >
                {gsStatus === "checking" && "確認中..."}
                {gsStatus === "found" && `✅ インストール済み (${gsVersion})`}
                {gsStatus === "missing" && "❌ 未検出"}
              </span>
            </div>
            <button onClick={checkGs} style={s.btnSmall}>
              再チェック
            </button>
          </div>

          {gsStatus === "missing" && (
            <div style={s.downloadBox}>
              <p style={{ fontSize: "13px", marginBottom: "10px", lineHeight: "1.6" }}>
                <strong>標準モード（MuPDF）で動作中:</strong>
                <br />
                現在、標準のエンジンで PDF
                の最適化・圧縮が可能です。通常の使用には十分な性能を備えています。
                <br />
                <br />
                さらに高度な「プロモード（Ghostscript 連携）」を利用したい場合は、システムに
                Ghostscript を導入することで、画像の再サンプリング等の拡張機能が有効になります。
                <br />
                詳細はプロジェクトのリポジトリ（GitHub）を参照してください。
              </p>
              <button onClick={openGitHub} style={s.btnSmall}>
                GitHub で技術仕様を確認
              </button>
            </div>
          )}
        </div>
      </section>

      {gsStatus === "found" && (
        <section style={s.section}>
          <h2 style={s.h2}>⚙️ 動作設定</h2>
          <div style={s.settingsCard}>
            <label style={s.label}>
              <input
                type="checkbox"
                checked={useGsPreference}
                onChange={(e) => setUseGsPreference(e.target.checked)}
                style={s.checkbox}
              />
              <div style={s.settingText}>
                <div style={s.settingTitle}>Ghostscript (GS) モードを優先する</div>
                <div style={s.settingDesc}>
                  オンにすると、他の機能から連携した際や起動時に、自動的にプロモード（GS）が選択されます。
                </div>
              </div>
            </label>
          </div>
        </section>
      )}

      {/* GSがない場合の説明（オプション） */}
      {gsStatus === "missing" && (
        <p style={s.hintSmall}>
          ※ Ghostscriptをインストールすると、ここに優先モードの設定が表示されます。
        </p>
      )}

      {/* ライセンスセクション */}
      <section style={s.section}>
        <h2 style={s.h2}>📜 オープンソース・ライセンス</h2>
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
              <td style={s.td}>PDF構造最適化 / フォント結合</td>
            </tr>
            <tr>
              <td style={s.td}>Ghostscript</td>
              <td style={s.td}>AGPL v3</td>
              <td style={s.td}>画像再構築 / 高度な圧縮</td>
            </tr>
            <tr>
              <td style={s.td}>Tauri</td>
              <td style={s.td}>MIT / Apache</td>
              <td style={s.td}>アプリフレームワーク</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section style={s.section}>
        <h2 style={s.h2}>🐙 Source Code</h2>
        <div style={s.card}>
          <p style={{ fontSize: "14px", marginBottom: "12px" }}>
            PDF小僧はオープンソースプロジェクトとして開発されています。
            <br />
            機能要望やバグ報告、最新のソースコード確認はリポジトリまで。
          </p>
          <button onClick={openGitHub} style={s.githubBtn}>
            <span style={{ fontSize: "18px" }}>GitHub</span>
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

// スタイル定義 (CSS-in-JS)
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
  linkBtn: {
    display: "inline-block",
    padding: "8px 16px",
    background: "var(--c-accent)",
    color: "#000",
    borderRadius: "6px",
    textDecoration: "none",
    fontWeight: 700,
    fontSize: "13px",
  },
  githubBtn: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 20px",
    background: "#24292e", // GitHub Dark Gray
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
  label: {
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
    cursor: "pointer",
  },
  checkbox: {
    marginTop: "4px",
    width: "18px",
    height: "18px",
    accentColor: "var(--c-accent)",
  },
  settingText: {
    flex: 1,
  },
  settingTitle: {
    fontSize: "14px",
    fontWeight: 700,
    color: "var(--c-text)",
  },
  settingDesc: {
    fontSize: "12px",
    color: "var(--c-textDim)",
    marginTop: "4px",
    lineHeight: "1.4",
  },
  hint: {
    marginTop: "20px",
    padding: "12px",
    background: "rgba(var(--c-accent-rgb), 0.1)",
    borderRadius: "6px",
    fontSize: "13px",
    borderLeft: "4px solid var(--c-accent)",
  },
  formatGroup: {
    marginBottom: 12,
  },
  formatLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: "var(--c-textDim)",
    marginBottom: 6,
    letterSpacing: "0.05em",
  },
  formatList: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 6,
  },
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
