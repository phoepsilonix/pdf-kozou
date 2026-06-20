// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------
// ページサイズ変更・製本（ベクター保持の面付け結合）
//   - n-up / 見開き製本 / ページサイズ変更 を「通常PDF」として出力する。
//   - 各元ページを出力ページ上に再生するためテキスト/ベクターを保持（ラスタ化しない）。
//   - 例: A4×4 → A3×2(見開き製本)

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePdfStore } from "../store/usePdfStore";
import { useSaveDialog } from "../hooks/useSaveDialog";
import { useI18n } from "../lib/i18n";
import { useA11y } from "../hooks/useA11y";
import { composeImpositionPdf, renderPage, getPdfInfo, joinPath, type PdfInfo } from "../lib/tauri";
import type { FileEntry } from "../store/usePdfStore";
import { PAGE_SIZE_PT, type PageSizeId } from "../lib/pageSize";
import { calcComposeLayout, flattenComposeSheets, type ImpositionMode } from "../lib/imposition";
import { PageOrientation } from "../lib/pageSize";
import { PageHeader, BtnBack, BtnPrimary, Spinner, ErrorView } from "../components/common";
import { F } from "../lib/theme";

type Props = {
  filePath: string;
  pdfInfo: PdfInfo | null;
  batchFiles?: FileEntry[];
};

type Orient = "auto" | "portrait" | "landscape";
type Phase = "edit" | "processing" | "result" | "error";

const MODES: { id: ImpositionMode; labelKey: string }[] = [
  { id: "1up", labelKey: "booklet.mode_1up" },
  { id: "2up", labelKey: "booklet.mode_2up" },
  { id: "4up", labelKey: "booklet.mode_4up" },
  { id: "booklet", labelKey: "booklet.mode_booklet" },
];

const SIZE_IDS: Exclude<PageSizeId, "image">[] = ["A3", "A4", "A5", "B4", "B5"];

// バッチ実行の進捗
interface BatchProgress {
  current: number;
  total: number;
  currentFile: string;
  done: { file: string; sheets: number }[];
  errors: { file: string; msg: string }[];
}

export default function PageSizeBookletPage({ filePath, pdfInfo, batchFiles }: Props) {
  const { setError, convertLayoutW, convertLayoutH, convertLayoutEm } = usePdfStore();
  const { pickSave } = useSaveDialog();
  const { t } = useI18n();
  const { announceSuccess, announceError } = useA11y();
  const isBatch = (batchFiles?.length ?? 0) > 1;

  const {
    pageSizeId,
    pageOrientation,
    impositionMode,
    setPageSize,
    setImpositionMode,
    setOrientation,
    autoDetectOrientation,
  } = usePdfStore();

  const [mode, setMode] = useState<ImpositionMode>(impositionMode);
  const [sizeId, setSizeId] = useState<Exclude<PageSizeId, "image">>(pageSizeId as any);
  const [orient, setOrient] = useState<Orient>(pageOrientation);

  const [gutter, setGutter] = useState(0);
  const [margin, setMargin] = useState(0);
  const [phase, setPhase] = useState<Phase>("edit");
  const [errMsg, setErrMsg] = useState("");
  const [outBytes, setOutBytes] = useState(0);
  const [outDir, setOutDir] = useState("");
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);

  // ── 出力ファイル名（画像変換ページと同じ「元名トグル＋ラベル＋プレビュー」方式）──
  const [keepOriginalName, setKeepOriginalName] = useState(true);
  const [label, setLabel] = useState("");
  const [labelEdited, setLabelEdited] = useState(false);

  const totalPages = pdfInfo?.page_count ?? 0;

  // 入力ファイルのステム（拡張子なし）
  const srcStem = useMemo(
    () =>
      filePath
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.[^/.]+$/, "") || "output",
    [filePath],
  );
  // 既定ラベル: サイズ変更のみ=ページサイズ（例 A4）/
  //   n-up・製本=ページサイズ＋面数トークン（例 A4_2面 / A4_中綴じ）
  const defaultLabel = useMemo(() => {
    if (mode === "1up") return sizeId;
    return `${sizeId}_${t(`filename.label.${mode}` as any)}`;
  }, [mode, sizeId, t]);
  // ラベル未編集ならモード/サイズ/言語の切替に追従
  useEffect(() => {
    if (!labelEdited) setLabel(defaultLabel);
  }, [defaultLabel, labelEdited]);
  // 出力ファイル名 {元名_}{ラベル}.pdf
  const composePdfName = useCallback(
    (stem: string, keep: boolean): string => {
      const parts: string[] = [];
      if (keep && stem) parts.push(stem);
      if (label) parts.push(label);
      return `${parts.join("_") || "output"}.pdf`;
    },
    [label],
  );
  // ライブプレビュー（バッチは1フォルダへ複数出力するため常に元名付き）
  const namePreview = useMemo(
    () => composePdfName(srcStem, isBatch ? true : keepOriginalName),
    [composePdfName, srcStem, isBatch, keepOriginalName],
  );

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

  // 初期ロード時に自動判定
  useEffect(() => {
    if (impositionMode !== mode) {
      setMode(mode);
      setImpositionMode(mode);
    }
  }, [impositionMode]);

  // モード変更時に向きの初期値を自動調整（2up/booklet は横、1up/4up は縦）
  const onModeChange = (m: ImpositionMode) => {
    setMode(m);
    setImpositionMode(m);
    setOrient((prev) =>
      prev === "auto" ? "auto" : m === "2up" || m === "booklet" ? "landscape" : "portrait",
    );
    setOrientation(
      pageOrientation === "auto"
        ? "auto"
        : m === "2up" || m === "booklet"
          ? "landscape"
          : "portrait",
    );
  };
  const onPageSizeChange = (id: Exclude<PageSizeId, "image">) => {
    setSizeId(id);
    setPageSize(id, orient);
  };

  const onOrientChange = (o: Orient) => {
    setOrient(o);
    setOrientation(o);
  };

  const layout = useMemo(() => calcComposeLayout(mode, totalPages), [mode, totalPages]);
  const nSheets = layout.sheets.length;

  // 自動向き判定: 元ページ群の代表アスペクト比（中央値）を使う。
  const sourceAspect = useMemo(() => {
    const aspects = (pdfInfo?.pages ?? [])
      .map((p) => (p.w > 0 && p.h > 0 ? p.w / p.h : undefined))
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
    if (!aspects.length) return undefined;
    const sorted = [...aspects].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }, [pdfInfo]);

  const resolvedOrient = useMemo<Exclude<Orient, "auto">>(() => {
    if (orient === "portrait" || orient === "landscape") return orient;
    if (sourceAspect === undefined) {
      return mode === "2up" || mode === "booklet" ? "landscape" : "portrait";
    }
    // 面付け時はシート比だけでなくセル比（= シート比 × rows/cols）で判定する。
    const adjustedAspect = sourceAspect * (layout.cols / layout.rows);
    return adjustedAspect > 1 ? "landscape" : "portrait";
  }, [orient, sourceAspect, mode, layout.cols, layout.rows]);

  const targetPt = useMemo(() => {
    const base = PAGE_SIZE_PT[sizeId];
    return resolvedOrient === "landscape" ? { w: base.h, h: base.w } : { w: base.w, h: base.h };
  }, [sizeId, resolvedOrient]);

  // C 側 kozou_compose_imposition_pdf と同じ規則でシートごとの出力サイズを返す。
  // 向き「自動」かつ 1ページ面付け(per==1)のときは、各シートの向きをそのページの
  // 表示向き(pdfInfo.pages[i].w/h は Rotate 考慮済み)に合わせる。
  // それ以外（向き固定 / n-up）は全シート共通の targetPt を使う。
  const sheetTargetPt = useCallback(
    (pages: number[]): { w: number; h: number } => {
      const per = layout.cols * layout.rows;
      if (orient === "auto" && per === 1) {
        const pageNo = pages[0] ?? 0;
        const pg = pageNo > 0 ? pdfInfo?.pages?.[pageNo - 1] : undefined;
        if (pg && pg.w > 0 && pg.h > 0) {
          const base = PAGE_SIZE_PT[sizeId];
          const big = Math.max(base.w, base.h);
          const small = Math.min(base.w, base.h);
          return pg.w > pg.h ? { w: big, h: small } : { w: small, h: big };
        }
      }
      return targetPt;
    },
    [orient, layout.cols, layout.rows, pdfInfo, sizeId, targetPt],
  );

  const pickDir = useCallback(async (): Promise<string | null> => {
    const dir = await invoke<string | null>("pick_output_dir").catch(() => null);
    if (dir) setOutDir(dir);
    return dir;
  }, []);

  const run = useCallback(async () => {
    if (!filePath || totalPages <= 0) return;
    const sp = await pickSave(composePdfName(srcStem, keepOriginalName));
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
        autoOrient: orient === "auto",
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
    composePdfName,
    srcStem,
    keepOriginalName,
    layout,
    targetPt,
    gutter,
    margin,
    orient,
    convertLayoutW,
    convertLayoutH,
    convertLayoutEm,
    setError,
    announceSuccess,
    announceError,
  ]);

  // ── 実行（バッチ）: 各ファイルを {元名}_{ラベル}.pdf として出力フォルダへ ──
  const handleBatch = useCallback(async () => {
    const dir = outDir || (await pickDir());
    if (!dir) return;
    const files = batchFiles!;
    setPhase("processing");
    const progress: BatchProgress = {
      current: 0,
      total: files.length,
      currentFile: "",
      done: [],
      errors: [],
    };
    setBatchProgress({ ...progress });
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      progress.current = i + 1;
      progress.currentFile = f.filename;
      setBatchProgress({ ...progress });
      try {
        // ページ数はファイルごとに異なるので個別に取得してレイアウトを計算
        const info = await getPdfInfo(f.path, {
          layoutW: convertLayoutW,
          layoutH: convertLayoutH,
          layoutEm: convertLayoutEm,
        });
        const fLayout = calcComposeLayout(mode, info.page_count);
        const { sheetPages, nSheets: ns } = flattenComposeSheets(fLayout);
        const stem = f.filename.replace(/\.[^/.]+$/, "");
        const out = joinPath(dir, composePdfName(stem, true));
        await composeImpositionPdf({
          input: f.path,
          output: out,
          targetW: targetPt.w,
          targetH: targetPt.h,
          cols: fLayout.cols,
          rows: fLayout.rows,
          sheetPages,
          nSheets: ns,
          gutter,
          margin,
          autoOrient: orient === "auto",
          layoutW: convertLayoutW,
          layoutH: convertLayoutH,
          layoutEm: convertLayoutEm,
        });
        progress.done.push({ file: f.filename, sheets: ns });
      } catch (e) {
        progress.errors.push({ file: f.filename, msg: String(e) });
      }
      setBatchProgress({ ...progress });
    }
    announceSuccess("done.image");
    setPhase("result");
  }, [
    batchFiles,
    outDir,
    pickDir,
    mode,
    composePdfName,
    targetPt,
    gutter,
    margin,
    orient,
    convertLayoutW,
    convertLayoutH,
    convertLayoutEm,
    announceSuccess,
  ]);

  // ── バッチ進捗・結果（単体フローより先に分岐）──
  if (phase === "processing" && isBatch && batchProgress)
    return (
      <div style={s.root}>
        <div style={s.batchProgress}>
          <div style={s.bpTitle}>
            {t("booklet.batch_processing", {
              current: String(batchProgress.current),
              total: String(batchProgress.total),
            })}
          </div>
          <div style={s.bpBar}>
            <div
              style={{
                ...s.bpFill,
                width: `${(batchProgress.current / batchProgress.total) * 100}%`,
              }}
            />
          </div>
          <div style={s.bpCurrent}>{batchProgress.currentFile}</div>
        </div>
      </div>
    );

  if (phase === "result" && isBatch && batchProgress)
    return (
      <div style={s.root}>
        <PageHeader>
          <BtnBack
            onClick={() => {
              setPhase("edit");
              setBatchProgress(null);
            }}
          />
          <span style={s.title}>{t("booklet.batch_done_title")}</span>
        </PageHeader>
        <div style={s.center}>
          <span
            style={{
              fontSize: 42,
              color: batchProgress.errors.length ? "var(--c-warn)" : "var(--c-accent)",
            }}
          >
            {batchProgress.errors.length ? "⚠" : "✓"}
          </span>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {t("split.success_count", { count: String(batchProgress.done.length) })}
            {batchProgress.errors.length > 0 &&
              t("split.error_count", { count: String(batchProgress.errors.length) })}
          </div>
          <div style={{ fontSize: 12, color: "var(--c-textSub)" }}>{outDir}</div>
          <div style={s.bpLog}>
            {batchProgress.done.map((d, i) => (
              <div key={i} style={s.bpLogRow}>
                <span style={{ color: "var(--c-accent)" }}>✓</span>
                <span style={s.bpLogFile}>{d.file}</span>
                <span style={s.bpLogMeta}>
                  {t("booklet.sheets_count", { count: String(d.sheets) })}
                </span>
              </div>
            ))}
            {batchProgress.errors.map((e, i) => (
              <div key={`e${i}`} style={s.bpLogRow}>
                <span style={{ color: "var(--c-err)" }}>✕</span>
                <span style={s.bpLogFile}>{e.file}</span>
                <span style={{ ...s.bpLogMeta, color: "var(--c-err)" }}>{e.msg}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );

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
        <span style={s.title}>
          {isBatch
            ? t("booklet.title_batch", { count: String(batchFiles!.length) })
            : t("booklet.title")}
        </span>
        {!isBatch && <span style={s.sub}>{t("common.pages", { count: String(totalPages) })}</span>}
      </PageHeader>

      <div style={s.main}>
        {/* ── 左: 設定（スクロール）＋ 下部固定の操作帯 ── */}
        <div style={s.leftCol}>
          <div style={s.settingsScroll}>
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
                    onClick={() => onPageSizeChange(id)}
                    style={{ ...s.choice, ...(sizeId === id ? s.choiceSel : {}) }}
                  >
                    {id}
                  </button>
                ))}
              </div>
              <div style={{ ...s.btnRow, marginTop: 8 }}>
                {(["auto", "portrait", "landscape"] as Orient[]).map((o) => (
                  <button
                    key={o}
                    onClick={() => onOrientChange(o)}
                    style={{ ...s.choice, ...(orient === o ? s.choiceSel : {}) }}
                  >
                    {t(
                      o === "auto"
                        ? "pagesize.orient_auto"
                        : o === "portrait"
                          ? "pagesize.orient_portrait"
                          : "pagesize.orient_landscape",
                    )}
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

            {/* 出力ファイル名: 元名トグル ＋ ラベル自由入力 ＋ ライブプレビュー */}
            <section style={s.section}>
              <div style={s.label}>{t("image.outname_label")}</div>
              {!isBatch && (
                <label style={s.keepNameRow}>
                  <input
                    type="checkbox"
                    checked={keepOriginalName}
                    onChange={(e) => setKeepOriginalName(e.target.checked)}
                  />
                  <span>{t("image.outname_keep_original")}</span>
                </label>
              )}
              <input
                type="text"
                value={label}
                placeholder={defaultLabel}
                aria-label={t("image.outname_label")}
                onChange={(e) => {
                  setLabel(e.target.value);
                  setLabelEdited(true);
                }}
                style={s.nameInput}
              />
              <div style={s.namePreview} title={namePreview}>
                {t("image.outname_preview")} → <span style={s.namePreviewName}>{namePreview}</span>
              </div>
            </section>

            {/* バッチ: 出力フォルダ */}
            {isBatch && (
              <section style={s.section}>
                <div style={s.label}>{t("split.output_dir")}</div>
                <div style={s.dirRow}>
                  <div style={s.dirPath} title={outDir}>
                    {outDir || t("common.select_dir")}
                  </div>
                  <button style={s.dirPickBtn} onClick={pickDir}>
                    {t("common.browse")}
                  </button>
                </div>
              </section>
            )}

            {/* サマリ */}
            <section style={s.summary}>
              <div>
                {t("booklet.summary", {
                  src: String(totalPages),
                  cols: String(layout.cols),
                  rows: String(layout.rows),
                  size:
                    orient === "auto"
                      ? `${sizeId} ${t("pagesize.orient_auto")}(${t(
                          resolvedOrient === "portrait"
                            ? "pagesize.orient_portrait"
                            : "pagesize.orient_landscape",
                        )})`
                      : `${sizeId} ${t(
                          resolvedOrient === "portrait"
                            ? "pagesize.orient_portrait"
                            : "pagesize.orient_landscape",
                        )}`,
                  sheets: String(nSheets),
                })}
              </div>
              {mode === "booklet" && totalPages % 4 !== 0 && (
                <div style={s.note}>{t("booklet.blank_note")}</div>
              )}
            </section>
          </div>

          {/* 下部固定の操作帯（スクロールしない・常に左下に表示） */}
          <div style={s.actionBar}>
            <button
              onClick={buildPreview}
              disabled={totalPages <= 0 || building}
              style={s.previewBtn}
            >
              {building ? t("booklet.preview_loading") : t("booklet.preview")}
            </button>
            <BtnPrimary
              onClick={isBatch ? handleBatch : run}
              disabled={isBatch ? false : totalPages <= 0}
            >
              {isBatch
                ? t("booklet.execute_batch", { count: String(batchFiles!.length) })
                : t("booklet.run")}
            </BtnPrimary>
          </div>
        </div>

        {/* ── 右: プレビューペイン ── */}
        <div style={s.rightCol}>
          {thumbsReady ? (
            <div style={s.sheetsWrap}>
              {layout.sheets.map((sh, si) => {
                const sPt = sheetTargetPt(sh.pages);
                const W = sPt.w >= sPt.h ? 260 : 190; // 横長は広めに
                const H = W * (sPt.h / sPt.w);
                const scale = W / sPt.w;
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
          ) : (
            <div style={s.previewEmpty}>
              {building ? t("booklet.preview_loading") : t("booklet.preview_hint")}
            </div>
          )}
        </div>
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
  main: { flex: 1, display: "flex", minHeight: 0, overflow: "hidden" },
  leftCol: {
    width: 360,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    borderRight: "1px solid var(--c-border)",
  },
  settingsScroll: {
    flex: 1,
    overflowY: "auto",
    padding: "16px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 18,
  },
  actionBar: {
    flexShrink: 0,
    display: "flex",
    gap: 10,
    justifyContent: "flex-end",
    alignItems: "center",
    padding: "10px 14px",
    borderTop: "1px solid var(--c-border)",
    background: "var(--c-bg)",
  },
  rightCol: {
    flex: 1,
    minWidth: 0,
    overflowY: "auto",
    padding: 18,
    background: "var(--c-bg)",
  },
  previewBtn: {
    padding: "9px 18px",
    borderRadius: 8,
    border: "1px solid var(--c-border)",
    background: "var(--c-bg)",
    color: "var(--c-text)",
    cursor: "pointer",
    fontFamily: F,
    fontSize: 13,
    transition: "background 0.2s, color 0.2s", // テーマ切り替え時を滑らかにする場合
  },
  previewEmpty: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--c-textDim)",
    fontSize: 13,
    textAlign: "center",
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
  btnRow: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
  },
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
  keepNameRow: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    fontSize: 13,
    color: "var(--c-text)",
    cursor: "pointer",
  },
  nameInput: {
    width: "100%",
    boxSizing: "border-box",
    padding: "7px 10px",
    borderRadius: 6,
    border: "1px solid var(--c-border)",
    background: "var(--c-bgCard)",
    color: "var(--c-text)",
    fontFamily: F,
    fontSize: 14,
  },
  namePreview: {
    fontSize: 12,
    color: "var(--c-textSub)",
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-border)",
    borderRadius: 6,
    padding: "6px 9px",
    lineHeight: 1.5,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  namePreviewName: { color: "var(--c-text)", fontWeight: 600 },
  dirRow: { display: "flex", gap: 7 },
  dirPath: {
    flex: 1,
    padding: "7px 9px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 6,
    color: "var(--c-textSub)",
    fontSize: 11,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  dirPickBtn: {
    padding: "7px 14px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 6,
    color: "var(--c-text)",
    cursor: "pointer",
    fontSize: 12,
    fontFamily: F,
    flexShrink: 0,
  },
  batchProgress: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
    padding: 40,
  },
  bpTitle: { fontSize: 16, fontWeight: 700, color: "var(--c-text)" },
  bpBar: {
    width: "100%",
    maxWidth: 480,
    height: 8,
    background: "var(--c-border)",
    borderRadius: 4,
    overflow: "hidden",
  },
  bpFill: {
    height: "100%",
    background: "var(--c-accent)",
    borderRadius: 4,
    transition: "width 0.3s",
  },
  bpCurrent: { fontSize: 13, color: "var(--c-textSub)" },
  bpLog: {
    width: "100%",
    maxWidth: 480,
    display: "flex",
    flexDirection: "column",
    gap: 5,
    maxHeight: 280,
    overflowY: "auto",
  },
  bpLogRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "6px 10px",
    background: "var(--c-bgCard)",
    borderRadius: 6,
    border: `1px solid var(--c-border)`,
  },
  bpLogFile: {
    flex: 1,
    fontSize: 12,
    color: "var(--c-text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  bpLogMeta: { fontSize: 11, color: "var(--c-textSub)", flexShrink: 0 },
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
