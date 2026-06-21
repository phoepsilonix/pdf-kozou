// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/pages/RotatePage.tsx — 単体 & バッチ対応
export default RotatePage;
import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Spinner, ErrorView, PageHeader, BtnBack, BtnPrimary } from "../components/common";
import { usePdfStore, type FileEntry } from "../store/usePdfStore";
import {
  renderPage,
  rotatePdf,
  getPdfInfo,
  moveFile,
  getTempPath,
  type PdfInfo,
  joinPath,
} from "../lib/tauri";
import { PageSelector, resolvePageSpec } from "../components/PageSelector";
import { PageSizeSelector } from "../components/PageSizeSelector";
import { hasImage } from "../lib/fileTypes";
import { buildName, stem, opSuffix } from "../lib/filename";
import { resolvePageSizePt } from "../lib/pageSize";
import { F } from "../lib/theme";
import { FS } from "../lib/typography";
import { useA11y } from "../hooks/useA11y";
import { tts } from "../lib/tts";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { LiveRegion } from "../components/A11yControls";
import { useI18n } from "../lib/i18n";
import { PreviewPane } from "../components/PreviewPane";
import { usePreview } from "../hooks/usePreview";
import { CompressPage } from "./CompressPage";
import { MetadataEditModal, type PdfMeta } from "../components/MetadataEditModal";

interface Props {
  filePath: string;
  pdfInfo: PdfInfo;
  batchFiles?: FileEntry[];
}

type Phase = "edit" | "processing" | "preview" | "result" | "error" | "compress";
const THUMB_DPI = 80;

interface BatchProgress {
  current: number;
  total: number;
  currentFile: string;
  done: { file: string }[];
  errors: { file: string; msg: string }[];
}

export function RotatePage({ filePath, pdfInfo, batchFiles }: Props) {
  const { setError, convertLayoutW, convertLayoutH, convertLayoutEm, pageSizeId, pageOrientation } =
    usePdfStore();
  const isBatch = (batchFiles?.length ?? 0) > 1;
  const { announceScreen, announceSuccess, announceError, announceKey } = useA11y();
  const { t } = useI18n();
  const [statusMsg, setStatusMsg] = useState("");
  const [metaEditOpen, setMetaEditOpen] = useState(false);
  const { enabled: previewEnabled } = usePreview("rotate");
  // Ctrl+S からプレビュー画面の doSave を呼ぶための ref
  const saveHandlerRef = useRef<(() => void) | null>(null);
  const compressHandlerRef = useRef<(() => void) | null>(null);
  // 回転後（preview 遷移直後）に「そのまま保存」へフォーカスするための ref
  const saveBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    announceScreen("screen.rotate");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useKeyboardShortcuts({
    "Ctrl+Enter": () => {
      if (phase === "edit") {
        tts.speak(t("shortcut.executing"));
        isBatch ? handleExecuteBatch() : handleExecuteSingle();
      }
    },
    "Ctrl+S": () => {
      if (phase === "preview") {
        tts.speak(t("shortcut.saving"));
        saveHandlerRef.current?.();
      }
    },
    "Ctrl+Shift+S": () => {
      if (phase === "preview") {
        tts.speak(t("shortcut.compress_saving"));
        compressHandlerRef.current?.();
      }
    },
    "Alt+D": () => {
      pickDir();
      tts.speak(t("aria.output_dir_btn"));
    },
    Escape: () => {
      if (phase === "preview" || phase === "result") {
        setPhase("edit");
        tts.speak(t("shortcut.back_to_edit"));
      }
    },
    F1: () => announceKey("shortcut.tool"),
  });

  const [batchIdx, setBatchIdx] = useState(0);
  const curPath = isBatch ? batchFiles![batchIdx].path : filePath;
  const [curPageCount, setCurPageCount] = useState(pdfInfo.page_count);

  const [phase, setPhase] = useState<Phase>("edit");
  const [thumbs, setThumbs] = useState<(string | undefined)[]>([]);
  const [rotations, setRotations] = useState<number[]>(() => new Array(pdfInfo.page_count).fill(0));
  const [globalRot, setGlobalRot] = useState<0 | 90 | 180 | 270>(0);
  const [errMsg, setErrMsg] = useState("");
  const [outDir, setOutDir] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [batchThumbs, setBatchThumbs] = useState<(string | undefined)[]>([]);
  const [pageSpec, setPageSpec] = useState("");

  // 回転後の preview 画面に入ったら「そのまま保存」ボタンへフォーカス
  useEffect(() => {
    if (phase === "preview") {
      // レンダリング確定後にフォーカス
      const id = window.setTimeout(() => saveBtnRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [phase]);

  useEffect(() => {
    if (!isBatch) return;
    const path = batchFiles![batchIdx].path;
    getPdfInfo(path, {
      layoutW: convertLayoutW,
      layoutH: convertLayoutH,
      layoutEm: convertLayoutEm,
    })
      .then((info) => {
        setCurPageCount(info.page_count);
        setRotations(new Array(info.page_count).fill(globalRot));
        setThumbs([]);
      })
      .catch(() => {});
  }, [batchIdx, isBatch]);

  useEffect(() => {
    if (!previewEnabled) {
      setThumbs([]);
      return;
    }
    let cancelled = false;
    setThumbs([]);
    const n = isBatch ? curPageCount : pdfInfo.page_count;
    (async () => {
      for (let i = 0; i < n; i++) {
        try {
          const b64 = await renderPage(curPath, i, THUMB_DPI, {
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          });
          if (cancelled) return;
          setThumbs((p) => {
            const a = [...p];
            a[i] = b64;
            return a;
          });
        } catch {}
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [curPath, curPageCount, previewEnabled]);

  useEffect(() => {
    if (!isBatch || !batchFiles) return;
    if (!previewEnabled) {
      setBatchThumbs([]);
      return;
    }
    let cancelled = false;
    setBatchThumbs(new Array(batchFiles.length).fill(undefined));
    (async () => {
      for (let i = 0; i < batchFiles.length; i++) {
        try {
          const b64 = await renderPage(batchFiles[i].path, 0, 52, {
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          });
          if (cancelled) return;
          setBatchThumbs((p) => {
            const a = [...p];
            a[i] = b64;
            return a;
          });
        } catch {}
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isBatch, batchFiles, previewEnabled]);

  const n = isBatch ? curPageCount : pdfInfo.page_count;

  const rotate = (idx: number, delta: 90 | -90) =>
    setRotations((r) => r.map((v, i) => (i === idx ? (v + delta + 360) % 360 : v)));

  /*
  const applyGlobal = (deg: 0|90|180|270) => {
    setGlobalRot(deg);
    setRotations(new Array(n).fill(deg));
  };
  const resetAll = () => { setRotations(new Array(n).fill(0)); setGlobalRot(0); };
*/
  // applyGlobal を以下のように修正
  const applyGlobal = (deg: 0 | 90 | 180 | 270) => {
    setGlobalRot(deg);

    setRotations((r) => {
      if (pageSpec.trim() === "" || pageSpec === "all") {
        // 範囲指定なし → 全ページに適用
        return new Array(r.length).fill(deg);
      } else {
        // 範囲指定あり → 指定範囲のみ適用
        return r.map((v, i) => (targetIndices.includes(i) ? deg : v));
      }
    });
  };

  // resetAll も同様に調整（範囲指定なしなら全リセット）
  const resetAll = () => {
    setGlobalRot(0);
    setRotations((r) => {
      if (pageSpec.trim() === "" || pageSpec === "all") {
        return new Array(r.length).fill(0);
      } else {
        return r.map((v, i) => (targetIndices.includes(i) ? 0 : v));
      }
    });
  };

  const targetIndices = pageSpec
    ? resolvePageSpec(pageSpec, n)
    : Array.from({ length: n }, (_, i) => i);

  const changedPages = rotations
    .map((v, i) => ({ page: i + 1, angle: v }))
    .filter((p) => p.angle !== 0 && targetIndices.includes(p.page - 1));

  const pickDir = useCallback(async (): Promise<string | null> => {
    const dir = await invoke<string | null>("pick_output_dir").catch(() => null);
    if (dir) setOutDir(dir);
    return dir;
  }, []);

  const handleExecuteSingle = useCallback(async () => {
    if (changedPages.length === 0) return;
    const base =
      filePath
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.[^/.]+$/, "") ?? "file";
    const saveTo = await getTempPath(`${base}_rotated_tmp.pdf`).catch(
      () => `/tmp/${base}_rotated_tmp.pdf`,
    );
    setPhase("processing");
    try {
      const psize = resolvePageSizePt(pageSizeId, pageOrientation);
      await rotatePdf(
        filePath,
        saveTo,
        changedPages,
        convertLayoutW,
        convertLayoutH,
        convertLayoutEm,
        psize?.w,
        psize?.h,
        pageOrientation === "auto" && pageSizeId !== "image",
      );
      setSavedPath(saveTo);
      setPhase("preview");
    } catch (e) {
      announceError(String(e));
      setErrMsg(String(e));
      setPhase("error");
      setError(String(e));
    }
  }, [filePath, changedPages, setError, announceError, pageSizeId, pageOrientation]);

  const handleExecuteBatch = useCallback(async () => {
    const resolvedDir = outDir || (await pickDir());
    if (!resolvedDir) return;
    const files = batchFiles!;
    setPhase("processing");
    const prog: BatchProgress = {
      current: 0,
      total: files.length,
      currentFile: "",
      done: [],
      errors: [],
    };
    setBatchProgress({ ...prog });
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      prog.current = i + 1;
      prog.currentFile = f.filename;
      setBatchProgress({ ...prog });
      try {
        const info = await getPdfInfo(f.path, {
          layoutW: convertLayoutW,
          layoutH: convertLayoutH,
          layoutEm: convertLayoutEm,
        });
        const pages = rotations
          .slice(0, info.page_count)
          .map((v, idx) => ({ page: idx + 1, angle: v }))
          .filter((p) => p.angle !== 0);
        if (pages.length > 0) {
          const out = joinPath(resolvedDir, buildName(f.filename, ["rotated"]));
          const psize = resolvePageSizePt(pageSizeId, pageOrientation);
          await rotatePdf(
            f.path,
            out,
            pages,
            convertLayoutW,
            convertLayoutH,
            convertLayoutEm,
            psize?.w,
            psize?.h,
            pageOrientation === "auto" && pageSizeId !== "image",
          );
        }
        prog.done.push({ file: f.filename });
      } catch (e) {
        prog.errors.push({ file: f.filename, msg: String(e) });
      }
      setBatchProgress({ ...prog });
    }
    announceSuccess("done.rotate", { count: String(changedPages.length) });
    setPhase("result");
  }, [batchFiles, rotations, outDir, pickDir, announceSuccess, pageSizeId, pageOrientation]);

  // ── フェーズ ──────────────────────────────────────────────────────────────
  if (phase === "processing" && !isBatch) return <Spinner label={t("rotate.processing")} />;

  if (phase === "processing" && isBatch && batchProgress)
    return (
      <div style={s.root}>
        <div style={s.batchProgress}>
          <div style={s.bpTitle}>
            {t("rotate.batch_processing", {
              current: String(batchProgress.current),
              total: String(batchProgress.total),
            })}
          </div>
          <div style={s.bpBarWrap}>
            <div
              style={{
                ...s.bpBar,
                width: `${(batchProgress.current / batchProgress.total) * 100}%`,
              }}
            />
          </div>
          <div style={s.bpCurrent}>{batchProgress.currentFile}</div>
          <div style={s.bpLog}>
            {batchProgress.done.map((d, i) => (
              <div key={i} style={s.bpRow}>
                <span style={{ color: "var(--c-accent)" }}>✓</span>
                <span style={s.bpFile}>{d.file}</span>
              </div>
            ))}
            {batchProgress.errors.map((e, i) => (
              <div key={`e${i}`} style={s.bpRow}>
                <span style={{ color: "var(--c-err)" }}>✕</span>
                <span style={s.bpFile}>{e.file}</span>
                <span style={{ fontSize: 10, color: "var(--c-err)" }}>{e.msg}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );

  if (phase === "error")
    return (
      <ErrorView
        msg={errMsg}
        onBack={() => {
          setPhase("edit");
          setErrMsg("");
        }}
      />
    );

  if (phase === "preview" && savedPath) {
    const doSave = async () => {
      const sp = await invoke<string | null>("pick_save_file", {
        defaultName: buildName(filePath, ["rotated"]),
        initialDir: outDir || undefined,
      }).catch(() => null);
      if (!sp) return;
      await moveFile(savedPath, sp).catch(async () => {
        const psize = resolvePageSizePt(pageSizeId, pageOrientation);
        await rotatePdf(
          filePath,
          sp,
          changedPages,
          convertLayoutW,
          convertLayoutH,
          convertLayoutEm,
          psize?.w,
          psize?.h,
          pageOrientation === "auto" && pageSizeId !== "image",
        );
      });
      setSavedPath(sp);
      announceSuccess("done.save", { name: sp.split(/[/\\]/).pop() ?? sp });
      setPhase("result");
    };
    // Ctrl+S でアクセスできるよう ref に登録
    saveHandlerRef.current = doSave;
    compressHandlerRef.current = () => setPhase("compress");
    return (
      <div style={s.root}>
        <PageHeader>
          <BtnBack onClick={() => setPhase("edit")} />
          <span style={s.title}>{t("rotate.preview_title")}</span>
          <span style={s.sub}>
            {t("rotate.rotated_count", { count: String(changedPages.length) })}
          </span>
        </PageHeader>
        <div style={s.previewPhase}>
          <span style={{ fontSize: 52, color: "var(--c-accent)" }}>↻</span>
          <span style={s.previewTitle}>
            {t("rotate.rotated_result", { count: String(changedPages.length) })}
          </span>
          <span style={s.previewSub}>{t("rotate.select_save_method")}</span>
          <div style={s.previewBtns}>
            <button
              style={s.metaBtn}
              onClick={() => setMetaEditOpen(true)}
              aria-label={t("meta_edit.title")}
            >
              ✏️ {t("meta_edit.title")}
            </button>
            <button
              style={s.compressBtn}
              onClick={() => setPhase("compress")}
              aria-label={t("aria.compress_save_btn")}
            >
              {t("rotate.save_compress")}
            </button>
            <button
              ref={saveBtnRef}
              style={s.saveBtnPrimary}
              onClick={doSave}
              aria-label={t("aria.save_btn")}
            >
              {t("rotate.save")}
            </button>
          </div>
          <button style={s.btnBack2} onClick={() => setPhase("edit")}>
            {t("rotate.redo")}
          </button>
        </div>
        {metaEditOpen && (
          <MetadataEditModal
            filePath={savedPath}
            onClose={() => setMetaEditOpen(false)}
            isOutputFile
          />
        )}
      </div>
    );
  }

  if (phase === "compress" && savedPath)
    return (
      <CompressPage
        filePath={filePath}
        pdfInfo={pdfInfo}
        sourceFile={savedPath}
        outputBaseName={stem(filePath) + opSuffix("rotated")}
        onDone={() => setPhase("result")}
      />
    );

  if (phase === "result")
    return (
      <div style={s.root}>
        <PageHeader>
          <BtnBack
            onClick={() => {
              setPhase("edit");
              setBatchProgress(null);
              setSavedPath("");
            }}
          />
          <span style={s.title}>
            {isBatch ? t("rotate.batch_done_title") : t("rotate.done_title")}
          </span>
        </PageHeader>
        <div style={s.resultBody}>
          <div style={s.resultIcon}>{batchProgress?.errors.length ? "⚠" : "✓"}</div>
          {isBatch && batchProgress ? (
            <>
              <div style={s.resultStat}>
                {t("rotate.done_count", { count: String(batchProgress.done.length) })}
                {batchProgress.errors.length > 0
                  ? t("rotate.error_count", { count: String(batchProgress.errors.length) })
                  : ""}
              </div>
              <div style={s.resultDir}>{outDir}</div>
            </>
          ) : (
            <div style={s.resultStat}>
              {t("rotate.done_stat", { count: String(changedPages.length) })}
            </div>
          )}
        </div>
      </div>
    );

  // ── 設定画面 ──────────────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>
          {isBatch
            ? t("rotate.title_batch", { count: String(batchFiles!.length) })
            : t("rotate.title_single")}
        </span>
        {!isBatch && <span style={s.sub}>{filePath.split(/[/\\]/).pop()}</span>}
        <span style={s.pageBadge}>{t("common.pages", { count: String(n) })}</span>
        <div style={{ flex: 1 }} />
        {changedPages.length > 0 && (
          <span style={s.changeBadge}>
            {t("rotate.change_badge", { count: String(changedPages.length) })}
          </span>
        )}
      </PageHeader>

      {/* バッチモード時の上部ファイル選択リスト（前の提案通り） */}
      {isBatch && (
        <div style={s.batchFileSelector}>
          <div style={s.secLabel}>
            {t("rotate.target_files", { count: String(batchFiles!.length) })}
          </div>
          <div style={s.batchFileListHorizontal}>
            {batchFiles!.map((f, i) => (
              <button
                key={f.id}
                type="button"
                style={{
                  ...s.batchFileCard,
                  ...(i === batchIdx ? s.batchFileCardActive : {}),
                }}
                onClick={() => setBatchIdx(i)}
              >
                {batchThumbs[i] ? (
                  <img
                    src={`data:image/jpeg;base64,${batchThumbs[i]}`}
                    style={s.batchCardThumb}
                    alt=""
                  />
                ) : (
                  <div style={s.batchCardThumbPh} />
                )}
                <div style={s.batchCardName}>{f.filename}</div>
                <div style={s.batchCardMeta}>{f.pageCount}p</div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={s.body}>
        {/* 左パネル（対象ページ・個別設定・出力など） */}
        <div style={s.panel}>
          {(isBatch ? batchFiles!.some((f) => hasImage([f.filename])) : hasImage([filePath])) && (
            <div style={{ marginBottom: 12 }}>
              <PageSizeSelector compact />
            </div>
          )}
          <div style={s.secLabel}>{t("rotate.target_pages")}</div>
          <PageSelector totalPages={n} value={pageSpec} onChange={setPageSpec} type="1" compact />

          <div style={s.secLabel}>{t("rotate.individual_settings")}</div>
          <p style={s.hint}>{t("rotate.individual_hint")}</p>
          <button style={s.resetBtn} onClick={resetAll}>
            {t("rotate.reset_range")}
          </button>

          <div style={{ flex: 1 }} />

          {isBatch ? (
            <>
              <div style={s.secLabel}>{t("rotate.output_dir")}</div>
              <div style={s.dirRow}>
                <div style={s.dirPath} title={outDir}>
                  {outDir || t("common.select_dir")}
                </div>
                <button style={s.dirPickBtn} onClick={pickDir}>
                  {t("common.browse")}
                </button>
              </div>
              <BtnPrimary onClick={handleExecuteBatch} disabled={changedPages.length === 0}>
                {outDir
                  ? t("rotate.execute_batch", { count: String(batchFiles!.length) })
                  : t("common.no_dir_btn")}
              </BtnPrimary>
            </>
          ) : (
            <BtnPrimary onClick={handleExecuteSingle} disabled={changedPages.length === 0}>
              {changedPages.length === 0
                ? t("rotate.no_change")
                : t("rotate.execute", { count: String(changedPages.length) })}
            </BtnPrimary>
          )}
        </div>

        {/* 右側プレビューエリア：一括回転とプレビューを兄弟として並べ、
            右ペイン(rightArea)全体をスクロール対象にする。
            一括回転は PreviewPane の外なのでプレビューのオンオフに影響されない。 */}
        <div style={s.rightArea}>
          {/* 一括回転 */}
          <div style={s.globalBtnsWrapper}>
            <div style={s.secLabel}>
              {t("rotate.bulk_label", {
                range: pageSpec.trim() === "" ? t("rotate.all_pages") : t("rotate.selected_range"),
              })}
            </div>
            <div style={s.globalBtns}>
              {([0, 90, 180, 270] as const).map((deg) => (
                <button
                  key={deg}
                  style={{
                    ...s.globalBtn,
                    ...(globalRot === deg ? s.globalBtnOn : {}),
                  }}
                  onClick={() => applyGlobal(deg)}
                  title={
                    deg === 0 ? t("rotate.reset_to") : t("rotate.rotate_deg", { deg: String(deg) })
                  }
                >
                  <span style={s.rotIcon}>{rotIcon(deg)}</span>
                  <span>
                    {deg === 0
                      ? t("rotate.reset_to")
                      : t("rotate.rotate_deg", { deg: String(deg) })}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* ページグリッド（PreviewPane は内部スクロールせず親に委ねる） */}
          <PreviewPane
            pageKey="rotate"
            label={t("common.preview_pages", { count: String(n) })}
            fill={false}
          >
            <div style={s.grid}>
              {Array.from({ length: n }, (_, i) => {
                const rot = rotations[i] ?? 0;
                const changed = rot !== 0;
                const inTarget = targetIndices.includes(i);
                const isLandscape = rot === 90 || rot === 270;
                const cardW = isLandscape ? 168 : 120;
                const cardH = isLandscape ? 120 : 168;
                const imgW = isLandscape ? 150 : 106;
                const imgH = isLandscape ? 106 : 150;

                return (
                  <div
                    key={i}
                    style={{
                      ...s.pageCard,
                      ...(changed ? s.pageCardChanged : {}),
                      ...(!inTarget ? s.pageCardDimmed : {}),
                      width: cardW,
                    }}
                  >
                    <div
                      style={{
                        ...s.pageImgWrap,
                        width: cardW,
                        height: cardH,
                        overflow: "hidden",
                        transition: "all 0.3s",
                      }}
                    >
                      {thumbs[i] ? (
                        <img
                          src={`data:image/jpeg;base64,${thumbs[i]}`}
                          style={{
                            width: imgW,
                            height: imgH,
                            objectFit: "contain",
                            transform: `rotate(${rot}deg)`,
                            transition: "transform 0.3s",
                          }}
                          alt=""
                        />
                      ) : (
                        <div
                          style={{
                            width: imgW,
                            height: imgH,
                            background: "var(--c-border)",
                            borderRadius: 3,
                          }}
                        />
                      )}
                    </div>
                    <div style={s.pageCardBottom}>
                      <span style={s.pageNum}>p.{i + 1}</span>
                      {changed && <span style={s.rotBadge}>{rot}°</span>}
                      <div style={s.rotateBtns}>
                        <button
                          style={s.rotBtn}
                          onClick={() => rotate(i, -90)}
                          title={t("rotate.rotate_left")}
                        >
                          ↺
                        </button>
                        <button
                          style={s.rotBtn}
                          onClick={() => rotate(i, 90)}
                          title={t("rotate.rotate_right")}
                        >
                          ↻
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </PreviewPane>
        </div>
      </div>
      <LiveRegion message={statusMsg} />
    </div>
  );
}

function rotIcon(deg: number) {
  return deg === 0 ? "⟳" : deg === 90 ? "↻" : deg === 180 ? "↕" : "↺";
}

const s: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "var(--c-bg)",
    color: "var(--c-text)",
    fontFamily: F,
    overflow: "hidden",
  },
  title: { fontSize: FS.title, fontWeight: 700, color: "var(--c-text)" },
  sub: {
    fontSize: 13,
    color: "var(--c-textSub)",
    maxWidth: 200,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pageBadge: {
    padding: "3px 10px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 11,
    fontSize: 12,
    color: "var(--c-textSub)",
  },
  changeBadge: {
    padding: "3px 11px",
    background: "var(--c-accentBg)",
    border: `1px solid var(--c-accentBd)`,
    borderRadius: 11,
    fontSize: 13,
    color: "var(--c-accent)",
    fontWeight: 600,
  },
  body: { flex: 1, display: "flex", overflow: "hidden", minHeight: 0 },
  panel: {
    width: 260,
    flexShrink: 0,
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    borderRight: `1px solid var(--c-border)`,
    overflowY: "auto",
  },
  secLabel: {
    fontSize: 11,
    color: "var(--c-textSub)",
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
  },
  globalBtns: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 },
  globalBtn: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "6px 8px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 13,
    color: "var(--c-text)",
    fontFamily: F,
    whiteSpace: "nowrap" as const,
    minWidth: 0,
    transition: "all 0.12s",
  },
  globalBtnOn: {
    borderColor: "var(--c-accent)",
    background: "var(--c-accentBg)",
    color: "var(--c-accent)",
  },
  rotIcon: { fontSize: 16 },
  hint: { fontSize: 12, color: "var(--c-textSub)", lineHeight: 1.6, margin: 0 },
  resetBtn: {
    padding: "9px 0",
    background: "transparent",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 7,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontSize: 13,
    fontFamily: F,
  },
  fileList: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    maxHeight: 320,
    overflowY: "auto",
    minHeight: 100,
  },
  fileItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 8px",
    background: "transparent",
    border: `1px solid transparent`,
    borderRadius: 6,
    cursor: "pointer",
    fontFamily: F,
    textAlign: "left" as const,
    transition: "all 0.1s",
  },
  fileItemOn: { background: "var(--c-accentBg)", borderColor: "var(--c-accentBd)" },
  fileThumb: {
    width: 44,
    maxHeight: 62,
    objectFit: "contain" as const,
    borderRadius: 3,
    flexShrink: 0,
    background: "var(--c-bg)",
  },
  fileThumbPh: {
    width: 44,
    height: 62,
    background: "var(--c-border)",
    borderRadius: 3,
    flexShrink: 0,
  },
  fileItemInfo: { flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  fileItemName: {
    fontSize: 11,
    color: "var(--c-text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fileItemMeta: { fontSize: 10, color: "var(--c-textSub)" },
  dirRow: { display: "flex", gap: 6 },
  dirPath: {
    flex: 1,
    padding: "7px 9px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 6,
    color: "var(--c-textSub)",
    fontSize: 12,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  dirPickBtn: {
    padding: "7px 12px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 6,
    color: "var(--c-text)",
    cursor: "pointer",
    fontSize: 12,
    fontFamily: F,
    flexShrink: 0,
  },
  grid: {
    overflow: "visible",
    padding: 14,
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 10,
    alignContent: "flex-start",
  },
  pageCard: {
    display: "flex",
    flexDirection: "column",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 9,
    overflow: "hidden",
    transition: "all 0.15s",
  },
  pageCardChanged: { borderColor: "var(--c-accentBd)", background: "var(--c-accentBg)" },
  pageCardDimmed: { opacity: 0.4 },
  pageImgWrap: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--c-bg)",
  },
  pageCardBottom: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "6px 8px",
    borderTop: `1px solid var(--c-border)`,
  },
  pageNum: { fontSize: 11, color: "var(--c-textDim)" },
  rotBadge: {
    fontSize: 10,
    padding: "1px 6px",
    background: "var(--c-accentBg)",
    border: `1px solid var(--c-accentBd)`,
    borderRadius: 9,
    color: "var(--c-accent)",
  },
  rotateBtns: { display: "flex", gap: 3, marginLeft: "auto" },
  rotBtn: {
    width: 30,
    height: 30,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--c-bg)",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 5,
    cursor: "pointer",
    fontSize: 18,
    color: "var(--c-text)",
    fontFamily: F,
  },
  previewPhase: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    padding: 32,
  },
  previewTitle: { fontSize: 20, fontWeight: 700, color: "var(--c-text)" },
  previewSub: { fontSize: 13, color: "var(--c-textSub)" },
  previewBtns: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap" as const,
    justifyContent: "center",
    marginTop: 8,
  },
  saveBtnPrimary: {
    padding: "12px 32px",
    background: "var(--c-accent)",
    border: "none",
    borderRadius: 9,
    color: "var(--c-accentText)",
    fontWeight: 700,
    cursor: "pointer",
    fontSize: 15,
    fontFamily: F,
  },
  compressBtn: {
    padding: "12px 28px",
    background: "var(--c-accentBg)",
    border: `1px solid var(--c-accentBd)`,
    borderRadius: 9,
    color: "var(--c-accent)",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: 15,
    fontFamily: F,
  },
  btnBack2: {
    padding: "8px 20px",
    background: "transparent",
    border: `1px solid var(--c-border)`,
    borderRadius: 7,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontSize: 13,
    fontFamily: F,
  },
  resultBody: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
  },
  resultIcon: { fontSize: 56, color: "var(--c-accent)" },
  resultStat: { fontSize: 20, fontWeight: 700, color: "var(--c-text)" },
  resultDir: { fontSize: 12, color: "var(--c-textSub)" },
  batchProgress: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 32,
  },
  bpTitle: { fontSize: 16, fontWeight: 700, color: "var(--c-text)" },
  bpBarWrap: {
    width: "100%",
    maxWidth: 440,
    height: 8,
    background: "var(--c-border)",
    borderRadius: 4,
    overflow: "hidden",
  },
  bpBar: {
    height: "100%",
    background: "var(--c-accent)",
    borderRadius: 4,
    transition: "width 0.3s",
  },
  bpCurrent: { fontSize: 13, color: "var(--c-textSub)" },
  bpLog: {
    width: "100%",
    maxWidth: 440,
    display: "flex",
    flexDirection: "column",
    gap: 5,
    maxHeight: 260,
    overflowY: "auto",
  },
  bpRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    background: "var(--c-bgCard)",
    borderRadius: 6,
    border: `1px solid var(--c-border)`,
  },
  bpFile: {
    flex: 1,
    fontSize: 12,
    color: "var(--c-text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  batchFileSelector: {
    padding: "8px 16px",
    borderBottom: "1px solid var(--c-border)",
    background: "var(--c-bgCard)",
    maxHeight: 140,
    overflowY: "hidden",
  },
  batchFileListHorizontal: {
    display: "flex",
    flexDirection: "row",
    gap: 12,
    overflowX: "auto",
    paddingBottom: 8,
    scrollBehavior: "smooth",
  },
  batchFileCard: {
    minWidth: 140,
    width: 140,
    padding: 8,
    background: "var(--c-bg)",
    border: "1px solid var(--c-border)",
    borderRadius: 8,
    cursor: "pointer",
    textAlign: "center",
    transition: "all 0.15s",
  },
  batchFileCardActive: {
    borderColor: "var(--c-accent)",
    background: "var(--c-accentBg)",
    boxShadow: "0 0 0 3px var(--c-accentShadow)",
  },
  batchCardThumb: {
    width: "100%",
    height: 80,
    objectFit: "contain",
    borderRadius: 4,
    marginBottom: 6,
  },
  batchCardThumbPh: {
    width: "100%",
    height: 80,
    background: "var(--c-border)",
    borderRadius: 4,
    marginBottom: 6,
  },
  batchCardName: {
    fontSize: 12,
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  batchCardMeta: {
    fontSize: 11,
    color: "var(--c-textSub)",
  },
  rightArea: {
    flex: 1,
    // 一括回転＋プレビューをまとめてスクロールさせる対象
    overflowY: "auto",
    minHeight: 0,
  },
  globalBtnsWrapper: {
    padding: "8px 16px",
    borderBottom: "1px solid var(--c-border)",
    background: "var(--c-bgCard)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
};
