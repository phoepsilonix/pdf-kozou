// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------
// ページサイズ変更・製本（ベクター保持の面付け結合）
//   - n-up / 見開き製本 / ページサイズ変更 を「通常PDF」として出力する。
//   - 各元ページを出力ページ上に再生するためテキスト/ベクターを保持（ラスタ化しない）。
//   - 例: A4×4 → A3×2(見開き製本)

import { useState, useMemo, useCallback, useRef } from "react";
import { usePdfStore } from "../store/usePdfStore";
import { useSaveDialog } from "../hooks/useSaveDialog";
import { useI18n } from "../lib/i18n";
import { useA11y } from "../hooks/useA11y";
import { composeImpositionPdf, renderPage, type PdfInfo } from "../lib/tauri";
import type { FileEntry } from "../store/usePdfStore";
import { PAGE_SIZE_PT, type PageSizeId } from "../lib/pageSize";
import { calcComposeLayout, flattenComposeSheets, type ImpositionMode } from "../lib/imposition";
import { PageHeader, BtnPrimary, Spinner, ErrorView } from "../components/common";
import { F } from "../lib/theme";

type Props = {
  filePath: string;
  pdfInfo: PdfInfo | null;
  batchFiles?: FileEntry[];
};

type Orient = "portrait" | "landscape";
type Phase = "edit" | "processing" | "result" | "error";

const MODES: { id: ImpositionMode; labelKey: string }[] = [
  { id: "1up", labelKey: "booklet.mode_1up" },
  { id: "2up", labelKey: "booklet.mode_2up" },
  { id: "4up", labelKey: "booklet.mode_4up" },
  { id: "booklet", labelKey: "booklet.mode_booklet" },
];

const SIZE_IDS: Exclude<PageSizeId, "image">[] = ["A3", "A4", "A5", "B4", "B5"];

export default function PageSizeBookletPage({ filePath, pdfInfo }: Props) {
  const { setError, convertLayoutW, convertLayoutH, convertLayoutEm } = usePdfStore();
  const { pickSave } = useSaveDialog();
  const { t } = useI18n();
  const { announceSuccess, announceError } = useA11y();

  const [mode, setMode] = useState<ImpositionMode>("booklet");
  const [sizeId, setSizeId] = useState<Exclude<PageSizeId, "image">>("A3");
  const [orient, setOrient] = useState<Orient>("landscape");
  const [gutter, setGutter] = useState(0);
  const [margin, setMargin] = useState(0);
  const [phase, setPhase] = useState<Phase>("edit");
  const [errMsg, setErrMsg] = useState("");
  const [outBytes, setOutBytes] = useState(0);

  const totalPages = pdfInfo?.page_count ?? 0;

  // ── プレビュー（手動トリガ＋キャッシュで重さを回避） ─────────────────
  // 元ページのサムネは layout に依らず不変なので一度だけ描画してキャッシュし、
  // モード/サイズ変更時はセル配置(CSS)だけが更新される。
  const thumbCache = useRef<Map<number, string>>(new Map());
  const [thumbsReady, setThumbsReady] = useState(false);
  const [building, setBuilding] = useState(false);

  const buildPreview = useCallback(async () => {
    if (!filePath || totalPages <= 0) return;
    setBuilding(true);
    try {
      for (let i = 0; i < totalPages; i++) {
        if (thumbCache.current.has(i)) continue;
        try {
          const b64 = await renderPage(filePath, i, 48, {
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          });
          thumbCache.current.set(i, b64);
        } catch {
          /* 個別ページ失敗は空セル扱い */
        }
      }
      setThumbsReady(true);
    } finally {
      setBuilding(false);
    }
  }, [filePath, totalPages, convertLayoutW, convertLayoutH, convertLayoutEm]);

  // モード変更時に向きの初期値を自動調整（2up/booklet は横、1up/4up は縦）
  const onModeChange = (m: ImpositionMode) => {
    setMode(m);
    setOrient(m === "2up" || m === "booklet" ? "landscape" : "portrait");
  };

  const targetPt = useMemo(() => {
    const base = PAGE_SIZE_PT[sizeId];
    return orient === "landscape" ? { w: base.h, h: base.w } : { w: base.w, h: base.h };
  }, [sizeId, orient]);

  const layout = useMemo(() => calcComposeLayout(mode, totalPages), [mode, totalPages]);
  const nSheets = layout.sheets.length;

  const run = useCallback(async () => {
    if (!filePath || totalPages <= 0) return;
    const sp = await pickSave("composed.pdf");
    if (!sp) return;
    setPhase("processing");
    try {
      const { sheetPages, nSheets: ns } = flattenComposeSheets(layout);
      const res = await composeImpositionPdf({
        input: filePath,
        output: sp,
        targetW: targetPt.w,
        targetH: targetPt.h,
        cols: layout.cols,
        rows: layout.rows,
        sheetPages,
        nSheets: ns,
        gutter,
        margin,
        layoutW: convertLayoutW,
        layoutH: convertLayoutH,
        layoutEm: convertLayoutEm,
      });
      setOutBytes(res.output_bytes);
      announceSuccess("done.compose", { sheets: String(ns) });
      setPhase("result");
    } catch (e) {
      announceError(String(e));
      setErrMsg(String(e));
      setError(String(e));
      setPhase("error");
    }
  }, [
    filePath,
    totalPages,
    pickSave,
    layout,
    targetPt,
    gutter,
    margin,
    convertLayoutW,
    convertLayoutH,
    convertLayoutEm,
    setError,
    announceSuccess,
    announceError,
  ]);

  if (phase === "processing") return <Spinner label={t("booklet.processing")} />;
  if (phase === "error") return <ErrorView msg={errMsg} onBack={() => setPhase("edit")} />;

  if (phase === "result") {
    const mb = (outBytes / 1024 / 1024).toFixed(2);
    return (
      <div style={s.root}>
        <PageHeader>
          <span style={s.title}>{t("booklet.title")}</span>
        </PageHeader>
        <div style={s.center}>
          <span style={{ fontSize: 42, color: "var(--c-accent)" }}>✓</span>
          <span style={{ fontSize: 16, fontWeight: 600 }}>{t("booklet.done")}</span>
          <span style={{ color: "var(--c-textSub)" }}>
            {t("common.pages", { count: String(nSheets) })} / {mb} MB
          </span>
          <BtnPrimary onClick={() => setPhase("edit")}>{t("common.back_btn")}</BtnPrimary>
        </div>
      </div>
    );
  }

  if (!filePath || !pdfInfo) {
    return (
      <div style={s.root}>
        <PageHeader>
          <span style={s.title}>{t("booklet.title")}</span>
        </PageHeader>
        <div style={s.center}>
          <span style={{ color: "var(--c-textSub)" }}>{t("app.select_prompt")}</span>
        </div>
      </div>
    );
  }

  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>{t("booklet.title")}</span>
        <span style={s.sub}>{t("common.pages", { count: String(totalPages) })}</span>
        <div style={{ flex: 1 }} />
        <BtnPrimary onClick={run}>{t("booklet.run")}</BtnPrimary>
      </PageHeader>

      <div style={s.body}>
        {/* モード */}
        <section style={s.section}>
          <div style={s.label}>{t("booklet.mode")}</div>
          <div style={s.btnRow}>
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => onModeChange(m.id)}
                style={{ ...s.choice, ...(mode === m.id ? s.choiceSel : {}) }}
              >
                {t(m.labelKey)}
              </button>
            ))}
          </div>
        </section>

        {/* 出力ページサイズ */}
        <section style={s.section}>
          <div style={s.label}>{t("booklet.target_size")}</div>
          <div style={s.btnRow}>
            {SIZE_IDS.map((id) => (
              <button
                key={id}
                onClick={() => setSizeId(id)}
                style={{ ...s.choice, ...(sizeId === id ? s.choiceSel : {}) }}
              >
                {id}
              </button>
            ))}
          </div>
          <div style={{ ...s.btnRow, marginTop: 8 }}>
            {(["portrait", "landscape"] as Orient[]).map((o) => (
              <button
                key={o}
                onClick={() => setOrient(o)}
                style={{ ...s.choice, ...(orient === o ? s.choiceSel : {}) }}
              >
                {t(o === "portrait" ? "pagesize.orient_portrait" : "pagesize.orient_landscape")}
              </button>
            ))}
          </div>
        </section>

        {/* 余白・隙間 */}
        <section style={s.section}>
          <div style={s.label}>{t("booklet.spacing")}</div>
          <div style={s.btnRow}>
            <label style={s.numLabel}>
              {t("booklet.margin")}
              <input
                type="number"
                min={0}
                value={margin}
                onChange={(e) => setMargin(Math.max(0, Number(e.target.value) || 0))}
                style={s.num}
              />
              pt
            </label>
            <label style={s.numLabel}>
              {t("booklet.gutter")}
              <input
                type="number"
                min={0}
                value={gutter}
                onChange={(e) => setGutter(Math.max(0, Number(e.target.value) || 0))}
                style={s.num}
              />
              pt
            </label>
          </div>
        </section>

        {/* サマリ */}
        <section style={s.summary}>
          <div>
            {t("booklet.summary", {
              src: String(totalPages),
              cols: String(layout.cols),
              rows: String(layout.rows),
              size: `${sizeId} ${t(
                orient === "portrait" ? "pagesize.orient_portrait" : "pagesize.orient_landscape",
              )}`,
              sheets: String(nSheets),
            })}
          </div>
          {mode === "booklet" && totalPages % 4 !== 0 && (
            <div style={s.note}>{t("booklet.blank_note")}</div>
          )}
        </section>

        {/* 実行ボタン（本文にも明示） */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 4,
          }}
        >
          <button
            onClick={buildPreview}
            disabled={totalPages <= 0 || building}
            style={s.previewBtn}
          >
            {building ? t("booklet.preview_loading") : t("booklet.preview")}
          </button>
          <BtnPrimary onClick={run} disabled={totalPages <= 0}>
            {t("booklet.run")}
          </BtnPrimary>
        </div>

        {/* プレビュー（出力シートのレイアウト） */}
        {thumbsReady && (
          <section style={s.section}>
            <div style={s.label}>{t("booklet.preview")}</div>
            <div style={s.sheetsWrap}>
              {layout.sheets.map((sh, si) => {
                const W = targetPt.w >= targetPt.h ? 260 : 190; // 横長は広めに
                const H = W * (targetPt.h / targetPt.w);
                const scale = W / targetPt.w;
                return (
                  <div key={si} style={s.sheetCol}>
                    <div
                      style={{
                        width: W,
                        height: H,
                        background: "#ffffff",
                        border: "1px solid var(--c-border)",
                        boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
                        display: "grid",
                        gridTemplateColumns: `repeat(${layout.cols}, 1fr)`,
                        gridTemplateRows: `repeat(${layout.rows}, 1fr)`,
                        gap: gutter * scale,
                        padding: margin * scale,
                        boxSizing: "border-box",
                      }}
                    >
                      {Array.from({ length: layout.cols * layout.rows }).map((_, c) => {
                        const p = sh.pages[c] ?? 0;
                        const thumb = p > 0 ? thumbCache.current.get(p - 1) : undefined;
                        return (
                          <div key={c} style={s.cell}>
                            {thumb && (
                              <img
                                src={`data:image/jpeg;base64,${thumb}`}
                                alt=""
                                style={s.cellImg}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <span style={s.sheetLabel}>
                      {t("booklet.preview_sheet", { n: String(si + 1) })}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "var(--c-bg)",
    fontFamily: F,
  },
  title: { fontSize: 16, fontWeight: 700, color: "var(--c-text)" },
  sub: { fontSize: 13, color: "var(--c-textDim)", marginLeft: 8 },
  body: {
    flex: 1,
    overflowY: "auto",
    padding: "16px 22px",
    display: "flex",
    flexDirection: "column",
    gap: 18,
  },
  center: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
  },
  section: { display: "flex", flexDirection: "column", gap: 8 },
  label: { fontSize: 13, fontWeight: 600, color: "var(--c-textSub)" },
  btnRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  choice: {
    padding: "7px 16px",
    borderRadius: 8,
    border: "1px solid var(--c-border)",
    background: "var(--c-bgCard)",
    color: "var(--c-text)",
    cursor: "pointer",
    fontFamily: F,
    fontSize: 14,
  },
  choiceSel: {
    border: "1px solid var(--c-accent)",
    background: "var(--c-accentBg)",
    color: "var(--c-accent)",
  },
  numLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13,
    color: "var(--c-textSub)",
  },
  num: {
    width: 64,
    padding: "5px 8px",
    borderRadius: 6,
    border: "1px solid var(--c-border)",
    background: "var(--c-bgCard)",
    color: "var(--c-text)",
    fontFamily: F,
  },
  summary: {
    marginTop: 4,
    padding: "12px 14px",
    borderRadius: 10,
    border: "1px solid var(--c-border)",
    background: "var(--c-bgCard)",
    fontSize: 14,
    color: "var(--c-text)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  note: { fontSize: 12, color: "var(--c-textDim)" },
  previewBtn: {
    padding: "9px 18px",
    borderRadius: 8,
    border: "1px solid var(--c-border)",
    background: "var(--c-bgCard)",
    color: "var(--c-text)",
    cursor: "pointer",
    fontFamily: F,
    fontSize: 13,
  },
  sheetsWrap: { display: "flex", flexWrap: "wrap", gap: 18 },
  sheetCol: { display: "flex", flexDirection: "column", alignItems: "center", gap: 6 },
  cell: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    minWidth: 0,
    minHeight: 0,
  },
  cellImg: { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" },
  sheetLabel: { fontSize: 12, color: "var(--c-textSub)" },
};
