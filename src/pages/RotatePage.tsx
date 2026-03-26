// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/pages/RotatePage.tsx — 単体 & バッチ対応
import { useEffect, useState, useCallback } from "react";
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
} from "../lib/tauri";
import { PageSelector, resolvePageSpec } from "../components/PageSelector";
import { F } from "../lib/theme";
import { CompressPage } from "./CompressPage";

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
  const { setError, convertLayoutW, convertLayoutH, convertLayoutEm } = usePdfStore();
  const isBatch = (batchFiles?.length ?? 0) > 1;

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

  useEffect(() => {
    if (!isBatch) return;
    const path = batchFiles![batchIdx].path;
    getPdfInfo(path)
      .then((info) => {
        setCurPageCount(info.page_count);
        setRotations(new Array(info.page_count).fill(globalRot));
        setThumbs([]);
      })
      .catch(() => {});
  }, [batchIdx, isBatch]);

  useEffect(() => {
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
  }, [curPath, curPageCount]);

  useEffect(() => {
    if (!isBatch || !batchFiles) return;
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
  }, [isBatch, batchFiles]);

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

  const pickDir = useCallback(async () => {
    const dir = await invoke<string | null>("pick_output_dir").catch(() => null);
    if (dir) setOutDir(dir);
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
      await rotatePdf(
        filePath,
        saveTo,
        changedPages,
        convertLayoutW,
        convertLayoutH,
        convertLayoutEm,
      );
      setSavedPath(saveTo);
      setPhase("preview");
    } catch (e) {
      setErrMsg(String(e));
      setPhase("error");
      setError(String(e));
    }
  }, [filePath, changedPages, setError]);

  const handleExecuteBatch = useCallback(async () => {
    if (!outDir) {
      await pickDir();
      return;
    }
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
        const info = await getPdfInfo(f.path);
        const pages = rotations
          .slice(0, info.page_count)
          .map((v, idx) => ({ page: idx + 1, angle: v }))
          .filter((p) => p.angle !== 0);
        if (pages.length > 0) {
          const out = `${outDir}/${f.filename.replace(/\.[^/.]+$/, "")}_rotated.pdf`;
          await rotatePdf(f.path, out, pages, convertLayoutW, convertLayoutH, convertLayoutEm);
        }
        prog.done.push({ file: f.filename });
      } catch (e) {
        prog.errors.push({ file: f.filename, msg: String(e) });
      }
      setBatchProgress({ ...prog });
    }
    setPhase("result");
  }, [batchFiles, rotations, outDir, pickDir]);

  // ── フェーズ ──────────────────────────────────────────────────────────────
  if (phase === "processing" && !isBatch) return <Spinner label="回転処理中…" />;

  if (phase === "processing" && isBatch && batchProgress)
    return (
      <div style={s.root}>
        <div style={s.batchProgress}>
          <div style={s.bpTitle}>
            回転処理中… {batchProgress.current}/{batchProgress.total}
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
    const base =
      filePath
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.[^/.]+$/, "") ?? "file";
    const doSave = async () => {
      const sp = await invoke<string | null>("pick_save_file", {
        defaultName: `${base}_rotated.pdf`,
        initialDir: outDir || undefined,
      }).catch(() => null);
      if (!sp) return;
      await moveFile(savedPath, sp).catch(async () => {
        await rotatePdf(filePath, sp, changedPages);
      });
      setSavedPath(sp);
      setPhase("result");
    };
    return (
      <div style={s.root}>
        <PageHeader>
          <BtnBack onClick={() => setPhase("edit")} />
          <span style={s.title}>回転プレビュー</span>
          <span style={s.sub}>{changedPages.length}ページを回転済み</span>
        </PageHeader>
        <div style={s.previewPhase}>
          <span style={{ fontSize: 52, color: "var(--c-accent)" }}>↻</span>
          <span style={s.previewTitle}>{changedPages.length}ページを回転しました</span>
          <span style={s.previewSub}>保存方法を選択してください</span>
          <div style={s.previewBtns}>
            <button style={s.saveBtnPrimary} onClick={doSave}>
              💾 そのまま保存
            </button>
            <button style={s.compressBtn} onClick={() => setPhase("compress")}>
              ⊙ 圧縮してから保存
            </button>
          </div>
          <button style={s.btnBack2} onClick={() => setPhase("edit")}>
            ← やり直す
          </button>
        </div>
      </div>
    );
  }

  if (phase === "compress" && savedPath)
    return (
      <CompressPage
        filePath={filePath}
        pdfInfo={pdfInfo}
        sourceFile={savedPath}
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
          <span style={s.title}>{isBatch ? "バッチ回転完了" : "回転完了"}</span>
        </PageHeader>
        <div style={s.resultBody}>
          <div style={s.resultIcon}>{batchProgress?.errors.length ? "⚠" : "✓"}</div>
          {isBatch && batchProgress ? (
            <>
              <div style={s.resultStat}>
                {batchProgress.done.length}件処理完了
                {batchProgress.errors.length > 0 ? ` · ${batchProgress.errors.length}件エラー` : ""}
              </div>
              <div style={s.resultDir}>{outDir}</div>
            </>
          ) : (
            <div style={s.resultStat}>{changedPages.length}ページを回転して保存しました</div>
          )}
        </div>
      </div>
    );

  // ── 設定画面 ──────────────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>回転{isBatch ? ` — ${batchFiles!.length}件バッチ` : ""}</span>
        {!isBatch && <span style={s.sub}>{filePath.split(/[/\\]/).pop()}</span>}
        <span style={s.pageBadge}>{n}ページ</span>
        <div style={{ flex: 1 }} />
        {changedPages.length > 0 && (
          <span style={s.changeBadge}>{changedPages.length}ページ変更</span>
        )}
      </PageHeader>

      {/* バッチモード時の上部ファイル選択リスト（前の提案通り） */}
      {isBatch && (
        <div style={s.batchFileSelector}>
          <div style={s.secLabel}>対象ファイル ({batchFiles!.length}件)</div>
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
          <div style={s.secLabel}>対象ページ</div>
          <PageSelector totalPages={n} value={pageSpec} onChange={setPageSpec} type="1" compact />

          <div style={s.secLabel}>個別設定</div>
          <p style={s.hint}>各ページの ↺↻ ボタンで個別回転できます。</p>
          <button style={s.resetBtn} onClick={resetAll}>
            選択範囲をリセット
          </button>

          <div style={{ flex: 1 }} />

          {isBatch ? (
            <>
              <div style={s.secLabel}>出力フォルダ</div>
              <div style={s.dirRow}>
                <div style={s.dirPath} title={outDir}>
                  {outDir || "（未選択）"}
                </div>
                <button style={s.dirPickBtn} onClick={pickDir}>
                  参照…
                </button>
              </div>
              <BtnPrimary onClick={handleExecuteBatch} disabled={changedPages.length === 0}>
                {outDir ? `↻ ${batchFiles!.length}件まとめて回転` : "📁 出力先を選択して実行"}
              </BtnPrimary>
            </>
          ) : (
            <BtnPrimary onClick={handleExecuteSingle} disabled={changedPages.length === 0}>
              {changedPages.length === 0
                ? "回転なし"
                : `↻ ${changedPages.length}ページを回転して保存`}
            </BtnPrimary>
          )}
        </div>

        {/* 右側プレビューエリア */}
        <div style={s.rightArea}>
          {/* 一括回転ボタンをここに移動（プレビューを見ながら操作しやすい） */}
          <div style={s.globalBtnsWrapper}>
            <div style={s.secLabel}>
              一括回転（{pageSpec.trim() === "" ? "全ページ" : "選択範囲"}に適用）
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
                  title={`選択範囲を${deg === 0 ? "元に戻す" : deg + "°回転"}`}
                >
                  <span style={s.rotIcon}>{rotIcon(deg)}</span>
                  <span>{deg === 0 ? "元に戻す" : `${deg}°`}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ページグリッド（仮想化なしのまま、元のスタイル） */}
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
                      <button style={s.rotBtn} onClick={() => rotate(i, -90)} title="左90°">
                        ↺
                      </button>
                      <button style={s.rotBtn} onClick={() => rotate(i, 90)} title="右90°">
                        ↻
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
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
  title: { fontSize: 16, fontWeight: 700, color: "var(--c-text)" },
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
  body: { flex: 1, display: "flex", overflow: "hidden" },
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
  globalBtns: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 },
  globalBtn: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 5,
    padding: "11px 8px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 14,
    color: "var(--c-text)",
    fontFamily: F,
    transition: "all 0.12s",
  },
  globalBtnOn: {
    borderColor: "var(--c-accent)",
    background: "var(--c-accentBg)",
    color: "var(--c-accent)",
  },
  rotIcon: { fontSize: 22 },
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
    flex: 1,
    overflowY: "auto",
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
    color: "#0a1a10",
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
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
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
