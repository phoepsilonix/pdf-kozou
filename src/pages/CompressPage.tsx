// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/pages/CompressPage.tsx
// フロー（単体）: プリセット選択 → プレビュー実行 → 結果確認 → [圧縮保存 / 圧縮せず保存]
// フロー（バッチ）: プリセット選択 → 出力{t("compress.select_folder")} → 全件処理 → 結果

export default CompressPage;

import { useState, useCallback, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSaveDialog } from "../hooks/useSaveDialog";
import { usePdfStore } from "../store/usePdfStore";
import {
  compressPdf,
  getTmpPath,
  moveFile,
  renderPage,
  type CompressPreset,
  type CompressResponse,
  type PdfInfo,
  joinPath,
} from "../lib/tauri";
import { F } from "../lib/theme";
import { FS } from "../lib/typography";
import { useA11y } from "../hooks/useA11y";
import { useBusyAnnouncer } from "../hooks/useBusyAnnouncer";
import { tts } from "../lib/tts";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { LiveRegion } from "../components/A11yControls";
import { useI18n } from "../lib/i18n";
import { buildName, appendName, stem } from "../lib/filename";
import { formatFilenameForSpeech } from "../lib/speakName";
import { MetadataEditModal, type PdfMeta } from "../components/MetadataEditModal";
import { Spinner } from "../components/common";

interface Props {
  filePath: string;
  pdfInfo: PdfInfo;
  sourceFile?: string; // 連携元ファイル（trim後など）
  /** 連携元（trim/rotate 等）から来た場合に、前の保存選択画面へ戻すコールバック。
   *  指定時はヘッダーに「← 前の画面に戻る」ボタンを表示する。 */
  onBack?: () => void;
  /** 連携元から引き継ぐ出力ベース名（拡張子・_圧縮なし）。
   *  例: trim から来たら "写真_トリミング"。圧縮保存で "..._圧縮.pdf" になる。 */
  outputBaseName?: string;
  batchFiles?: import("../store/usePdfStore").FileEntry[];
}

type Phase = "edit" | "processing" | "result" | "batchResult" | "error";

const PRESET_OPTIONS_KEYS: {
  id: CompressPreset;
  icon: string;
  labelKey: string;
  descKey: string;
  noteKey: string;
  color: string;
}[] = [
  {
    id: "light",
    icon: "☁",
    labelKey: "compress.preset_light_label",
    descKey: "compress.preset_light_desc",
    noteKey: "compress.preset_light_note",
    color: "#3a7a4a",
  },
  {
    id: "standard",
    icon: "⚖",
    labelKey: "compress.preset_standard_label",
    descKey: "compress.preset_standard_desc",
    noteKey: "compress.preset_standard_note",
    color: "#2a5a9a",
  },
  {
    id: "aggressive",
    icon: "⚡",
    labelKey: "compress.preset_aggressive_label",
    descKey: "compress.preset_aggressive_label",
    noteKey: "compress.preset_aggressive_note",
    color: "#7a5a1a",
  },
  {
    id: "maximum",
    icon: "🔥",
    labelKey: "compress.preset_maximum_label",
    descKey: "compress.preset_maximum_label",
    noteKey: "compress.preset_maximum_note",
    color: "#7a2020",
  },
];

// --- 追加：GS専用のプリセット定義 ---
const GS_PRESETS_KEYS: {
  id: "Prepress" | "Printer" | "Ebook";
  icon: string;
  labelKey: string;
  descKey: string;
  noteKey: string;
  color: string;
}[] = [
  {
    id: "Prepress",
    icon: "✨",
    labelKey: "compress.gs_prepress_label",
    descKey: "compress.gs_prepress_desc",
    noteKey: "compress.gs_prepress_note",
    color: "#2a5a9a",
  },
  {
    id: "Printer",
    icon: "🖨️",
    labelKey: "compress.gs_printer_label",
    descKey: "compress.gs_printer_desc",
    noteKey: "compress.gs_printer_note",
    color: "#3a7a4a",
  },
  {
    id: "Ebook",
    icon: "📱",
    labelKey: "compress.gs_ebook_label",
    descKey: "compress.gs_ebook_desc",
    noteKey: "compress.gs_ebook_note",
    color: "#7a5a1a",
  },
];

export function CompressPage({
  filePath,
  pdfInfo,
  sourceFile,
  onBack,
  outputBaseName,
  batchFiles,
}: Props) {
  const {
    setError,
    gsAvailable,
    setGsAvailable,
    activeCompressMode,
    setActiveCompressMode,
    useGsPreference,
    customGsPath,
    convertLayoutW,
    convertLayoutH,
    convertLayoutEm,
  } = usePdfStore();
  const { pickSave } = useSaveDialog();
  const { announceScreen, announceSuccess, announceError, announceKey } = useA11y();
  const { t } = useI18n();
  const [statusMsg, setStatusMsg] = useState("");
  const [metaEditOpen, setMetaEditOpen] = useState(false);
  const [savedFilePath, setSavedFilePath] = useState<string | null>(null);
  const PRESET_OPTIONS_I18N = useMemo(
    () =>
      PRESET_OPTIONS_KEYS.map((p) => ({
        ...p,
        label: t(p.labelKey),
        desc: t(p.descKey),
        note: t(p.noteKey),
      })),
    [t],
  );
  const GS_PRESETS_I18N = useMemo(
    () =>
      GS_PRESETS_KEYS.map((p) => ({
        ...p,
        label: t(p.labelKey),
        desc: t(p.descKey),
        note: t(p.noteKey),
      })),
    [t],
  );

  // 画面表示時の読み上げ
  useEffect(() => {
    announceScreen("screen.compress");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ショートカット
  useKeyboardShortcuts({
    "Ctrl+Enter": () => {
      if (phase === "edit") {
        tts.speak(t("shortcut.executing"));
        // edit では保存ダイアログに直行せず、実行して結果プレビュー画面へ遷移する
        // （画面の主ボタンと同じ handlePreview）。保存は結果画面で Ctrl+S。
        handlePreview();
      }
    },
    "Ctrl+S": () => {
      if (phase === "result") {
        tts.speak(t("shortcut.saving"));
        handleSaveCompressed();
      }
    },
    "Ctrl+Shift+S": () => {
      // 他ページでは「圧縮して保存」(連携圧縮)が割り当てられている。
      // 圧縮ページでは「保存」と意味が同じ。
      if (phase === "result") {
        tts.speak(t("shortcut.saving"));
        handleSaveCompressed();
      }
    },
    "Ctrl+Shift+O": () => {
      // 圧縮せず元のまま保存（結果画面の「圧縮せず保存」ボタンと同じ）
      if (phase === "result") {
        tts.speak(t("shortcut.save_original"));
        handleSaveOriginal();
      }
    },
    "Alt+D": () => {
      pickDir?.();
      tts.speak(t("aria.output_dir_btn"));
    },
    Escape: () => {
      if (phase === "result") {
        setTmpFile("");
        setPhase("edit");
        tts.speak(t("shortcut.back_to_edit"));
      }
    },
    F1: () => announceKey("shortcut.tool"),
  });

  const [currentSource, setCurrentSource] = useState(sourceFile ?? filePath);
  const isBatch = (batchFiles?.length ?? 0) > 1;
  const inputFile = currentSource;

  const [phase, setPhase] = useState<Phase>("edit");
  // 結果画面では自動フォーカスを与えない（縦幅の短い画面で上部の結果表示が
  // スクロールで隠れるのを避けるため）。保存は Ctrl+S（圧縮して保存）で行える。
  const [preset, setPreset] = useState<CompressPreset>("standard");
  const [objectStream, setObjectStream] = useState(false);
  const [mergeFonts, setMergeFonts] = useState(false);

  const [result, setResult] = useState<CompressResponse | null>(null);
  const [tmpFile, setTmpFile] = useState("");
  const [chainedFiles, setChainedFiles] = useState<string[]>([]); // 連携で作成した一時ファイル一覧
  const [preview, setPreview] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [outDir, setOutDir] = useState("");
  const [batchProg, setBatchProg] = useState<{
    cur: number;
    total: number;
    curFile: string;
    done: { file: string; pct: string; saved: string }[];
    errors: { file: string; msg: string }[];
  } | null>(null);

  // --- GS追加用 ---
  const [gsPath, setGsPath] = useState<string | null>(null);
  const [gsPreset, setGsPreset] = useState<"Prepress" | "Printer" | "Ebook">("Printer");
  const [useGs, setUseGs] = useState(useGsPreference && gsAvailable);

  useEffect(() => {
    if (useGsPreference && gsAvailable) {
      setUseGs(true);
    }
  }, [gsAvailable, useGsPreference]);

  useEffect(() => {
    // find_gs_executable で GS パスを取得し gsAvailable を設定
    // customGsPath を最優先で使用（Tauri が camelCase→snake_case 変換: customGsPath→custom_gs_path）
    invoke<string | null>("find_gs_executable", {
      customGsPath: customGsPath || null,
    })
      .then((path) => {
        setGsPath(path);
        setGsAvailable(!!path);
      })
      .catch(() => {
        setGsPath(null);
        setGsAvailable(false);
      });
  }, [customGsPath]); // customGsPath が変わったら再検出
  // ----------------

  const pickDir = useCallback(async (): Promise<string | null> => {
    const d = await invoke<string | null>("pick_output_dir").catch(() => null);
    if (d) setOutDir(d);
    return d;
  }, []);

  const handlePreview = useCallback(async () => {
    if (useGs && !gsPath) {
      setError(t("compress.err_gs_not_found"));
      return;
    }
    setSavedFilePath(null);
    setPhase("processing");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      const tmp = await getTmpPath("kozou_compress_preview.pdf");
      // 圧縮後サイズ ÷ 元サイズ（残存率）。読み上げ・表示はこの確定値を使う。
      // ※ React の result(state) は setResult 直後はまだ更新されておらず stale な
      //   ため、ここで参照すると初回は null→100% を読み上げてしまう。必ず今回の
      //   計算値をローカルで保持して使う。
      let ratioVal = 1;
      if (useGs && gsPath) {
        // 1. Ghostscript 実行
        const gsLog = await invoke<string>("run_gs_optimize", {
          gsPath: gsPath,
          input: inputFile,
          output: tmp,
          level: gsPreset,
        });
        console.log("GS Full Log:", gsLog);
        // GSにはMuPDFのような詳細なパラメータ報告がないため、
        // 便宜上、結果表示用のダミーレスポンスを作成します
        // 2. get_file_stat で入力と出力のサイズを取得
        // Rust側で json!({ "size": ... }) となっているので .size でアクセス
        const inStat = await invoke<{ size: number }>("get_file_stat", { path: inputFile });
        const outStat = await invoke<{ size: number }>("get_file_stat", { path: tmp });
        console.log("Stat Results:", { inStat, outStat });

        const inSize = inStat.size;
        const outSize = outStat.size;
        if (inSize === 0 || outSize === 0) {
          throw new Error(t("compress.err_gs_output_empty"));
        }

        ratioVal = outSize / inSize;
        setResult({
          ok: true,
          input_bytes: inSize,
          output_bytes: outSize,
          ratio: ratioVal,
          params_used: undefined as any,
        });
      } else {
        const res = await compressPdf(inputFile, tmp, {
          preset,
          merge_fonts: mergeFonts || undefined,
          object_stream: objectStream || undefined,
          layout_w: convertLayoutW,
          layout_h: convertLayoutH,
          layout_em: convertLayoutEm,
        });
        ratioVal = res.ratio;
        setResult(res);
      }

      setTmpFile(tmp);
      try {
        setPreview(
          await renderPage(tmp, 0, 108, {
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          }),
        );
      } catch (e) {
        setPreview("");
      }
      // 画面表示（−X%）と同じ「削減率」を読み上げる。負（増加）の場合は 0 とみなす。
      const reducedPct = Math.max(0, Math.round((1 - ratioVal) * 100));
      announceSuccess("done.compress", { ratio: String(reducedPct) });
      setPhase("result");
    } catch (e) {
      announceError(String(e));
      setErrMsg(String(e));
      setPhase("error");
      setError(String(e));
    }
  }, [
    currentSource,
    useGs,
    gsPath,
    inputFile,
    gsPreset,
    preset,
    mergeFonts,
    objectStream,
    pdfInfo,
    setError,
  ]);

  const handleChainNext = useCallback(async () => {
    if (!tmpFile) return;

    try {
      // kozou_compress_preview.pdf は次回のプレビューで上書きされるため、
      // 連携用の固定名か、タイムスタンプ付きのファイルに一度退避させる
      const chainedPath = await getTmpPath(`chained_step_${Date.now()}.pdf`);
      await invoke("copy_file", { src: tmpFile, dst: chainedPath });

      // 連携ファイルのパスを記録（リセット時に削除するため）
      setChainedFiles((prev) => [...prev, chainedPath]);

      // ステートを更新して「次の入力」としてセット
      setCurrentSource(chainedPath);

      // UIをリセットして設定画面へ
      setResult(null);
      setTmpFile("");
      setPhase("edit");

      // モードを自動で切り替える（GSならMuPDFへ、MuPDFならGSへ）
      setUseGs(!useGs);
      //setPreview("");            // プレビューも一旦クリア
    } catch (e) {
      setError(t("compress.err_chain_failed") + String(e));
    }
  }, [tmpFile, useGs, setError]);

  const handleResetSource = useCallback(async () => {
    // 連携で作成した一時ファイルを削除する
    for (const cf of chainedFiles) {
      try {
        await invoke("remove_file", { path: cf });
      } catch {
        // 削除失敗は無視（ファイルが既にない場合など）
      }
    }
    setChainedFiles([]);

    // Propsで渡された最初のファイルパス（sourceFile または filePath）に戻す
    setCurrentSource(sourceFile ?? filePath);
    setPhase("edit");
    setResult(null);
    setTmpFile("");
    setPreview("");
    // 必要ならモードも初期（MuPDF）に戻す
    //setUseGs(false);
  }, [sourceFile, filePath, chainedFiles]);

  const handleSaveCompressed = useCallback(async () => {
    const sp = await pickSave(appendName(outputBaseName ?? stem(filePath), ["compressed"]));
    if (!sp || (useGs && !gsPath)) return;
    setSaving(true);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      if (tmpFile) {
        // プレビュー時に作成済みの一時ファイルをユーザー指定パスへ移動するだけでよい。
        // move_file は同一ボリューム内なら rename(2) で一瞬で完了し、
        // クロスデバイスの場合は copy+delete にフォールバックする。
        // これにより再圧縮（run_gs_optimize / compressPdf の2回目呼び出し）を回避する。
        await moveFile(tmpFile, sp);
        // tmpFile を消費したのでリセット（再保存ボタン連打を防ぐ）
        setTmpFile("");
      } else {
        // 万一 tmpFile が消えていた場合のフォールバック（通常は到達しない）
        if (useGs && gsPath) {
          await invoke("run_gs_optimize", {
            gsPath: gsPath,
            input: inputFile,
            output: sp,
            level: gsPreset,
          });
        } else {
          await compressPdf(inputFile, sp, {
            preset,
            merge_fonts: mergeFonts || undefined,
            object_stream: objectStream || undefined,
            layout_w: convertLayoutW,
            layout_h: convertLayoutH,
            layout_em: convertLayoutEm,
          });
        }
      }
      setSavedFilePath(sp);
      announceSuccess("done.save", {
        name: formatFilenameForSpeech(sp.split(/[/\\]/).pop() ?? sp),
      });
      // 連携(trim/rotate/merge)時もここで親へ遷移せず、CompressPage 自身の
      // 「保存完了」画面（savedFilePath による文書情報編集つき）を表示する。
      // 即時に onDone() で親へ遷移すると、その編集画面に到達できないため呼ばない。
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [
    tmpFile,
    useGs,
    gsPath,
    inputFile,
    filePath,
    gsPreset,
    preset,
    mergeFonts,
    objectStream,
    pickSave,
    setError,
    outputBaseName,
  ]);

  const handleSaveOriginal = useCallback(async () => {
    const sp = await pickSave(appendName(outputBaseName ?? stem(filePath), []));
    if (!sp) return;
    setSaving(true);
    try {
      await invoke("copy_file", { src: inputFile, dst: sp });
      setSavedFilePath(sp);
      announceSuccess("done.save", {
        name: formatFilenameForSpeech(sp.split(/[/\\]/).pop() ?? sp),
      });
      // 同上: 親へ即時遷移せず、保存完了画面（文書情報編集つき）を表示する。
    } catch (e) {
      //await compressPdf(inputFile, sp, { preset: "light" });
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [inputFile, filePath, pickSave, setError, outputBaseName]);

  const handleBatch = useCallback(async () => {
    const resolvedDir = outDir || (await pickDir());
    if (!resolvedDir) return;
    if (useGs && !gsPath) {
      setError(t("compress.err_gs_path_not_found"));
      return;
    }

    setPhase("processing");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const prog = {
      cur: 0,
      total: batchFiles!.length,
      curFile: "",
      done: [] as any[],
      errors: [] as any[],
    };
    setBatchProg({ ...prog });

    for (let i = 0; i < batchFiles!.length; i++) {
      const f = batchFiles![i];
      prog.cur = i + 1;
      prog.curFile = f.filename;
      setBatchProg({ ...prog });
      const out = joinPath(resolvedDir, buildName(f.filename, ["compressed"]));
      try {
        let ratio = 0;

        if (useGs && gsPath) {
          // --- Ghostscript モードの一括処理 ---
          await invoke("run_gs_optimize", {
            gsPath: gsPath,
            input: f.path,
            output: out,
            level: gsPreset,
          });
          // GS実行後のファイルサイズを確認して圧縮率を計算
          // f.size は Store から渡される元のサイズ
          const o = await invoke<{ size: number }>("get_file_stat", { path: out });
          ratio = o.size / f.sizeBytes;
        } else {
          const res = await compressPdf(f.path, out, {
            preset,
            merge_fonts: mergeFonts || undefined,
            object_stream: objectStream || undefined,
            layout_w: convertLayoutW,
            layout_h: convertLayoutH,
            layout_em: convertLayoutEm,
          });
          ratio = res.ratio;
        }
        prog.done.push({
          file: f.filename,
          pct: ((1 - ratio) * 100).toFixed(1),
          saved: out.split(/[/\\]/).pop() ?? "",
        });
      } catch (e) {
        prog.errors.push({ file: f.filename, msg: String(e) });
        console.warn(`圧縮失敗: ${f.filename}. 元ファイルをコピーします。`);
        try {
          // 圧縮に失敗しても、出力フォルダにファイルがない状態を避けるためにコピー
          await invoke("copy_file", { src: f.path, dst: out });

          prog.errors.push({
            file: f.filename,
            msg: `${t("compress.err_compress_fallback")} (${String(e)})`,
          });
        } catch (copyErr) {
          // コピーすら失敗した場合（ディスクフルや権限エラーなど）
          prog.errors.push({
            file: f.filename,
            msg: `${t("compress.err_fatal")}${String(copyErr)}`,
          });
        }
      }
      setBatchProg({ ...prog });
    }
    setPhase("batchResult");
  }, [
    batchFiles,
    useGs,
    gsPath,
    gsPreset,
    preset,
    mergeFonts,
    objectStream,
    outDir,
    pickDir,
    setError,
  ]);

  // 圧縮・保存が長引くときは音声で「処理中です」と知らせる（独自スピナー使用のため個別に計測）。
  useBusyAnnouncer(
    (saving || phase === "processing") && !isBatch,
    saving ? t("common.saving") : t("compress.processing"),
  );

  if (saving && !isBatch) {
    return (
      <div style={c.center}>
        <div style={c.spinner} className="kozou-spinner" />
        <span style={c.spinSub}>{t("common.saving")}</span>
      </div>
    );
  }

  if (phase === "processing" && !isBatch) {
    return (
      <div style={c.center}>
        <Spinner label={t("compress.processing")} />;
      </div>
    );
  }
  if (phase === "processing" && isBatch && batchProg) {
    return (
      <div style={c.center}>
        <div style={c.bpTitle}>
          {t("compress.processing", {
            current: String(batchProg.cur),
            total: String(batchProg.total),
          })}
        </div>
        <div style={c.bpBarWrap}>
          <div style={{ ...c.bpBar, width: `${(batchProg.cur / batchProg.total) * 100}%` }} />
        </div>
        <div style={c.bpCurFile}>{batchProg.curFile}</div>
        <Spinner label={t("compress.processing")} />;
        <div style={c.bpLog}>
          {batchProg.done.map((d, i) => (
            <div key={i} style={c.bpRow}>
              <span style={{ color: "var(--c-accent)" }}>✓</span>
              <span style={c.bpFile}>{d.file}</span>
              <span style={c.bpPct}>
                {d.saved} -{d.pct}%
              </span>
            </div>
          ))}
          {batchProg.errors.map((e, i) => (
            <div key={i} style={c.bpRow}>
              <span style={{ color: "var(--c-err)" }}>✕</span>
              <span style={c.bpFile}>{e.file}</span>
              <span style={c.bpErrMsg}>{e.msg}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (phase === "error") {
    return (
      <div style={c.center}>
        <span style={{ fontSize: 38, color: "var(--c-err)" }}>✕</span>
        <span style={{ fontSize: FS.subtitle, fontWeight: 700, color: "var(--c-err)" }}>
          エラー
        </span>
        <pre style={c.errPre}>{errMsg}</pre>
        <button
          style={c.btnBackSm}
          onClick={() => {
            setPhase("edit");
            setTmpFile("");
            setErrMsg("");
          }}
        >
          {t("compress.back")}
        </button>
      </div>
    );
  }
  if (phase === "batchResult" && batchProg) {
    return (
      <div style={c.center}>
        <span
          style={{
            fontSize: 52,
            color: batchProg.errors.length ? "var(--c-warn)" : "var(--c-accent)",
          }}
        >
          {batchProg.errors.length ? "⚠" : "✓"}
        </span>
        <div style={c.bpTitle}>
          {t("compress.batch_done_title", { count: String(batchProg.done.length) })}
        </div>
        <div style={{ height: 10 }} />
        <div style={c.bpLog}>
          {batchProg.done.map((d, i) => (
            <div key={i} style={c.bpRow}>
              <span style={{ color: "var(--c-accent)" }}>✓</span>
              <span style={c.bpFile}>{d.file}</span>
              <span style={c.bpPct}>
                {d.saved} -{d.pct}%
              </span>
            </div>
          ))}
          {batchProg.errors.map((e, i) => (
            <div key={i} style={c.bpRow}>
              <span style={{ color: "var(--c-err)" }}>✕</span>
              <span style={c.bpFile}>{e.file}</span>
              <span style={c.bpErrMsg}>{e.msg}</span>
            </div>
          ))}
        </div>
        <button
          style={c.btnBackSm}
          onClick={() => {
            setPhase("edit");
            setBatchProg(null);
          }}
        >
          {t("compress.back2")}
        </button>
      </div>
    );
  }

  if (phase === "result" && result) {
    const inMB = (result.input_bytes / 1048576).toFixed(2);
    const outMB = (result.output_bytes / 1048576).toFixed(2);
    const pct = ((1 - result.ratio) * 100).toFixed(1);
    const gain = Number(pct) > 0;
    const p = result.params_used; // 原本の変数定義

    return (
      <div style={c.root}>
        <div style={c.header}>
          <button
            style={c.btnBack}
            onClick={() => {
              setSavedFilePath(null);
              setTmpFile("");
              setPhase("edit");
            }}
          >
            {t("compress.back2")}
          </button>
          <span style={c.title}>{t("compress.result_title")}</span>
        </div>
        <div style={c.resultBody}>
          <div style={c.prevCol}>
            {preview ? (
              <img src={`data:image/jpeg;base64,${preview}`} style={c.prevImg} alt="preview" />
            ) : (
              <div style={c.prevPh}>{t("compress.preview_none")}</div>
            )}
          </div>
          <div style={c.statsCol}>
            <div style={{ ...c.statBig, color: gain ? "var(--c-green)" : "var(--c-err)" }}>
              {gain ? `−${pct}%` : `+${Math.abs(Number(pct))}%`}
            </div>
            <div style={c.statInfo}>
              <div style={c.statLabel}>{t("compress.stat_label")}</div>
              <div style={c.statVal}>
                {inMB} MB →{" "}
                <span style={{ color: gain ? "var(--c-green)" : "var(--c-err)", fontWeight: 700 }}>
                  {outMB} MB
                </span>
              </div>
            </div>
            <div style={c.paramsBox}>
              {/* GSモードならGS専用バッジを表示 */}
              {useGs && (
                <span
                  style={{
                    ...c.paramBadge,
                    background: "var(--c-accentBg)",
                    color: "var(--c-accent)",
                    borderColor: "var(--c-accentBd)",
                  }}
                >
                  Ghostscript: {gsPreset}
                </span>
              )}

              {/* MuPDFのパラメータ (pが存在する場合のみ表示) */}
              {p && !useGs && (
                <>
                  {useGs && (
                    <span
                      style={{
                        ...c.paramBadge,
                        background: "var(--c-accentBg)",
                        color: "var(--c-accent)",
                      }}
                    >
                      Ghostscript: {gsPreset}
                    </span>
                  )}
                  <span style={c.paramsHd}>パラメータ</span>
                  <PRow label="プリセット" val={preset} />
                  <PRow label="GCレベル" val={String(p.garbage_level)} />
                  <PRow
                    label={t("compress.img_compress")}
                    val={p.compress_images ? t("common.yes") : t("common.no")}
                  />
                  <PRow
                    label={t("compress.font_compress")}
                    val={p.compress_fonts ? t("common.yes") : t("common.no")}
                  />
                  <PRow
                    label={t("compress.sanitize")}
                    val={p.sanitize ? t("common.yes") : t("common.no")}
                  />
                  <PRow
                    label={t("compress.clean")}
                    val={p.clean ? t("common.yes") : t("common.no")}
                  />
                  <PRow
                    label={t("compress.merge_fonts")}
                    val={p.merge_fonts ? t("common.yes") : t("common.no")}
                  />
                  <PRow
                    label={t("compress.object_stream")}
                    val={p.object_stream ? t("common.yes") : t("common.no")}
                  />
                </>
              )}
            </div>
            {result.warning && <div style={c.warnBox}>{result.warning}</div>}

            {gsAvailable && (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  border: "1px dashed var(--c-accentBd)",
                  borderRadius: 8,
                  background: "var(--c-accentBg)11",
                }}
              >
                <div
                  style={{
                    fontSize: FS.caption,
                    color: "var(--c-accent)",
                    fontWeight: 700,
                    marginBottom: 6,
                  }}
                >
                  {t("compress.chain_mode")}
                </div>
                <button style={c.btnChain} onClick={handleChainNext}>
                  {useGs ? t("compress.chain_hint_mupdf") : t("compress.chain_hint_gs")}
                </button>
                <div style={{ fontSize: FS.caption, color: "var(--c-textDim)", marginTop: 4 }}>
                  {t("compress.chain_note")}
                </div>
              </div>
            )}

            <div style={c.saveChoiceBox}>
              {savedFilePath ? (
                <>
                  <div
                    style={{
                      fontSize: FS.body,
                      fontWeight: 700,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span style={{ color: "var(--c-accent)" }}>✓</span>
                    {t("compress.saved_title")}
                  </div>
                  <div
                    style={{
                      fontSize: FS.caption,
                      color: "var(--c-textSub)",
                      wordBreak: "break-all",
                    }}
                  >
                    {savedFilePath}
                  </div>
                  <div style={c.saveChoiceBtns}>
                    <button
                      style={c.btnMetaEdit}
                      onClick={() => setMetaEditOpen(true)}
                      aria-label={t("meta_edit.title")}
                    >
                      ✏️ {t("meta_edit.title")}
                    </button>
                    <button
                      style={c.btnBack}
                      onClick={() => {
                        setSavedFilePath(null);
                        setTmpFile("");
                        setPhase("edit");
                      }}
                    >
                      {t("common.back")}
                    </button>
                  </div>
                </>
              ) : (
                <div style={c.saveChoiceBtns}>
                  <button style={c.btnSaveOriginal} onClick={handleSaveOriginal} disabled={saving}>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 12, textAlign: "left" }}
                    >
                      <span style={c.saveBtnIcon}>📄</span>
                      <div>
                        <div style={c.saveBtnMain}>{t("compress.save_original_main")}</div>
                        <div style={c.saveBtnSub}>{t("compress.save_original_sub")}</div>
                      </div>
                    </div>
                  </button>
                  <button
                    style={c.btnSaveCompressed}
                    onClick={handleSaveCompressed}
                    disabled={saving}
                  >
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 12, textAlign: "left" }}
                    >
                      <span style={c.saveBtnIcon}>📦</span>
                      <div>
                        <div style={c.saveBtnMain}>{t("compress.save_compressed_main")}</div>
                        <div style={c.saveBtnSub}>{t("compress.save_compressed_sub")}</div>
                      </div>
                    </div>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        {metaEditOpen && savedFilePath && (
          <MetadataEditModal
            filePath={savedFilePath}
            onClose={() => setMetaEditOpen(false)}
            isOutputFile
          />
        )}
      </div>
    );
  }

  const fname = inputFile.split(/[/\\]/).pop() ?? "";
  return (
    <div style={c.root}>
      <div style={c.header}>
        {onBack && (
          <button style={c.backBtn} onClick={onBack}>
            {t("compress.back_to_source")}
          </button>
        )}
        <span style={c.title}>{t("compress.settings_title")}</span>
        <span style={c.fileSub} title={fname}>
          {currentSource !== (sourceFile ?? filePath) ? `🔗 ${fname}` : fname}
        </span>
        {currentSource !== (sourceFile ?? filePath) && (
          <span style={c.chainBadge}>{t("compress.chain_badge")}</span>
        )}

        {gsAvailable && (
          <div style={{ display: "flex", gap: 4, marginLeft: 16 }}>
            <button
              style={{
                padding: "2px 10px",
                fontSize: FS.caption,
                borderRadius: 4,
                cursor: "pointer",
                border: "1px solid var(--c-borderHi)",
                background: !useGs ? "var(--c-accentBg)" : "transparent",
                color: !useGs ? "#000" : "var(--c-textSub)",
                fontFamily: F,
              }}
              aria-pressed={!useGs}
              onClick={() => setUseGs(false)}
            >
              {t("compress.standard_mupdf")}
            </button>
            <button
              style={{
                padding: "2px 10px",
                fontSize: FS.caption,
                borderRadius: 4,
                cursor: "pointer",
                border: "1px solid var(--c-borderHi)",
                background: useGs ? "var(--c-accentBg)" : "transparent",
                color: useGs ? "#000" : "var(--c-textSub)",
                fontFamily: F,
              }}
              aria-pressed={useGs}
              onClick={() => setUseGs(true)}
            >
              {t("compress.pro_gs")}
            </button>
          </div>
        )}

        {/* 圧縮内で再連携(GS↔MuPDF)した場合のみ、その連携を解除するリセットを表示。
            連携元(trim/rotate 等)へ戻るには上の「戻る」ボタンを使う。 */}
        {currentSource !== (sourceFile ?? filePath) && (
          <button
            style={{
              marginLeft: 12,
              padding: "4px 10px",
              fontSize: FS.caption,
              borderRadius: 4,
              background: "var(--c-errBg)",
              color: "var(--c-err)",
              border: "1px solid var(--c-errBd)",
              cursor: "pointer",
              fontFamily: F,
            }}
            onClick={handleResetSource}
          >
            {t("compress.reset_chain")}
          </button>
        )}

        <div style={{ flex: 1 }} />
        <span style={c.fileSub} title={fname}>
          {fname}
        </span>
        <span style={c.pageSub}>{t("common.pages", { count: String(pdfInfo.page_count) })}</span>
      </div>

      <div style={c.scrollArea}>
        {!useGs ? (
          <>
            <div style={c.presetGrid}>
              {PRESET_OPTIONS_I18N.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPreset(p.id)}
                  aria-label={p.label}
                  aria-pressed={preset === p.id}
                  style={{
                    ...c.card,
                    ...(preset === p.id
                      ? { borderColor: p.color, background: p.color + "22" }
                      : {}),
                  }}
                >
                  <span style={c.cardIcon}>{p.icon}</span>
                  <span style={c.cardLabel}>{p.label}</span>
                  <span style={c.cardDesc}>{p.desc}</span>
                  <span style={c.cardNote}>{p.note}</span>
                </button>
              ))}
            </div>
            <div style={c.optRow}>
              <label style={c.optLabel}>
                <input
                  type="checkbox"
                  checked={objectStream}
                  onChange={(e) => setObjectStream(e.target.checked)}
                  style={{ marginRight: 6 }}
                />
                {t("compress.obj_stream_label")}
              </label>
              <span style={c.optHint}>
                {objectStream ? t("compress.object_stream_on") : t("compress.merge_fonts_off")}
              </span>
            </div>
            <div style={c.optRow}>
              <label style={c.optLabel}>
                <input
                  type="checkbox"
                  checked={mergeFonts}
                  onChange={(e) => setMergeFonts(e.target.checked)}
                  style={{ marginRight: 6 }}
                />
                {t("compress.merge_fonts_label")}
              </label>
              <span style={c.optHint}>
                {mergeFonts ? t("compress.merge_fonts_on") : t("compress.merge_fonts_off")}
              </span>
            </div>
          </>
        ) : (
          <>
            {/* 新設：GSプリセット表示 */}
            <div style={c.presetGrid}>
              {GS_PRESETS_I18N.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setGsPreset(p.id)}
                  aria-label={p.label}
                  aria-pressed={gsPreset === p.id}
                  style={{
                    ...c.card,
                    ...(gsPreset === p.id
                      ? { borderColor: p.color, background: p.color + "22" }
                      : {}),
                  }}
                >
                  <span style={c.cardIcon}>{p.icon}</span>
                  <span style={c.cardLabel}>{p.label}</span>
                  <span style={c.cardDesc}>{p.desc}</span>
                  <span style={c.cardNote}>{p.note}</span>
                </button>
              ))}
            </div>
            <div
              style={{
                padding: "24px 22px",
                fontSize: FS.small,
                color: "var(--c-textDim)",
                lineHeight: 1.6,
              }}
            >
              <div style={{ marginBottom: 4, color: "var(--c-textSub)", fontWeight: 700 }}>
                {t("compress.gs_info_title")}
              </div>
              <div>{t("compress.gs_info_1")}</div>
              <div>{t("compress.gs_info_2")}</div>
              <div>{t("compress.gs_info_3")}</div>
            </div>
          </>
        )}
      </div>

      <div style={c.execArea}>
        {isBatch ? (
          <div style={c.batchExecBox}>
            <div style={c.dirRow}>
              <div style={c.dirPath}>{outDir || t("compress.no_dir_placeholder")}</div>
              <button style={c.dirPickBtn} onClick={pickDir}>
                {t("compress.select_folder")}
              </button>
            </div>
            <button
              style={c.btnExec}
              onClick={handleBatch}
              // useGs による制限を解除。gsPath があれば実行可能に
              disabled={useGs && !gsPath}
            >
              {useGs
                ? t("compress.batch_gs", { count: String(batchFiles!.length) })
                : t("compress.batch_mupdf", { count: String(batchFiles!.length) })}
            </button>
          </div>
        ) : (
          <div style={c.singleExecBox}>
            <button
              style={{ ...c.btnExec, ...(useGs && !gsPath ? c.btnExecDim : {}) }}
              onClick={handlePreview}
              // GSモードでも gsPath が見つかっていれば有効化
              disabled={useGs && !gsPath}
            >
              {useGs ? t("compress.gs_mode") : t("compress.preview_btn")}
            </button>
          </div>
        )}
      </div>
      <LiveRegion message={statusMsg} />
    </div>
  );
}

function PRow({ label, val }: { label: string; val: string | React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "4px 0",
        borderBottom: `1px solid var(--c-border)`,
        fontSize: FS.small,
      }}
    >
      <span style={{ color: "var(--c-textDim)" }}>{label}</span>
      <span style={{ color: "var(--c-text)" }}>{val}</span>
    </div>
  );
}

// 原本の c オブジェクトを完全コピー
const c: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "var(--c-bg)",
    color: "var(--c-text)",
    fontFamily: F,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 22px",
    borderBottom: `1px solid var(--c-border)`,
    flexShrink: 0,
  },
  chainBadge: {
    padding: "3px 10px",
    background: "var(--c-accentBg)",
    border: `1px solid var(--c-accentBd)`,
    borderRadius: 12,
    color: "var(--c-accent)",
    fontSize: FS.caption,
  },
  title: { fontSize: FS.title, fontWeight: 700, color: "var(--c-text)" },
  backBtn: {
    padding: "6px 14px",
    background: "transparent",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 7,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontSize: FS.body,
    fontFamily: F,
    flexShrink: 0,
    whiteSpace: "nowrap" as const,
  },
  fileSub: {
    fontSize: FS.small,
    color: "var(--c-textSub)",
    maxWidth: 160,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pageSub: { fontSize: FS.caption, color: "var(--c-textDim)" },

  scrollArea: { flex: 1, overflowY: "auto", minHeight: 0 },
  presetGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4,1fr)",
    gap: 14,
    padding: "24px 22px 0",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    padding: "22px 12px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 12,
    cursor: "pointer",
    transition: "all 0.15s",
    fontFamily: F,
    color: "var(--c-text)",
  },
  cardIcon: { fontSize: 30 },
  cardLabel: { fontSize: FS.subtitle, fontWeight: 700, color: "var(--c-text)" },
  cardDesc: { fontSize: FS.caption, color: "var(--c-textSub)", textAlign: "center" },
  cardNote: {
    fontSize: FS.caption,
    color: "var(--c-textDim)",
    textAlign: "center",
    lineHeight: 1.5,
  },

  optRow: { display: "flex", alignItems: "center", gap: 12, padding: "14px 22px 2px" },
  optLabel: {
    display: "flex",
    alignItems: "center",
    fontSize: FS.body,
    color: "var(--c-text)",
    cursor: "pointer",
  },
  optHint: { fontSize: FS.caption, color: "var(--c-textSub)" },

  execArea: {
    padding: "24px 22px",
    borderTop: `1px solid var(--c-border)`,
    display: "flex",
    justifyContent: "center",
    background: "var(--c-bg)",
    flexShrink: 0,
  },
  singleExecBox: { width: "100%", maxWidth: 400 },
  btnExec: {
    width: "100%",
    padding: "14px",
    background: "var(--c-accentBg)",
    border: `2px solid var(--c-accentBd)`,
    borderRadius: 10,
    color: "var(--c-accent)",
    fontWeight: 700,
    fontSize: FS.label,
    cursor: "pointer",
    fontFamily: F,
  },
  btnExecDim: { opacity: 0.5, cursor: "default" },

  batchExecBox: { width: "100%", maxWidth: 480, display: "flex", flexDirection: "column", gap: 14 },
  dirRow: { display: "flex", gap: 8 },
  dirPath: {
    flex: 1,
    padding: "9px 12px",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-border)`,
    borderRadius: 8,
    fontSize: FS.small,
    color: "var(--c-textSub)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  dirPickBtn: {
    padding: "0 16px",
    background: "var(--c-bgHover)",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 8,
    color: "var(--c-text)",
    fontSize: FS.small,
    cursor: "pointer",
    fontFamily: F,
  },

  center: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: 16,
    background: "var(--c-bg)",
    padding: 32,
  },
  spinner: {
    width: 32,
    height: 32,
    border: `3px solid var(--c-border)`,
    borderTop: `3px solid var(--c-accent)`,
    borderRadius: "50%",
    /* animation は kozou-spinner クラスで付与 */
  },
  spinSub: { color: "var(--c-textSub)", fontSize: FS.label },
  errPre: {
    fontSize: FS.caption,
    color: "var(--c-err)",
    background: "var(--c-errBg)",
    border: `1px solid var(--c-errBd)`,
    borderRadius: 6,
    padding: "10px 14px",
    maxWidth: 480,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  btnBack: {
    padding: "8px 22px",
    background: "transparent",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 7,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontSize: FS.body,
    fontFamily: F,
  },
  btnMetaEdit: {
    flex: 1,
    padding: "10px 18px",
    background: "var(--c-accentBg)",
    border: `1px solid var(--c-accentBd)`,
    borderRadius: 7,
    color: "var(--c-accent)",
    fontWeight: 700,
    cursor: "pointer",
    fontSize: FS.body,
    fontFamily: F,
  },
  btnBackSm: {
    padding: "6px 16px",
    background: "transparent",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 6,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontSize: FS.body,
    fontFamily: F,
  },

  resultBody: { flex: 1, display: "flex", gap: 24, padding: "20px 24px", overflow: "auto" },
  prevCol: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 10,
    flexShrink: 0,
  },
  prevImg: {
    maxWidth: 260,
    maxHeight: 360,
    borderRadius: 6,
    border: `1px solid var(--c-border)`,
    background: "#fff",
    boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
  },
  prevPh: {
    width: 220,
    height: 300,
    background: "var(--c-bgCard)",
    borderRadius: 6,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--c-textDim)",
    fontSize: FS.body,
  },
  statsCol: { flex: 1, display: "flex", flexDirection: "column", gap: 14, minWidth: 0 },
  statBig: {
    fontSize: 44,
    fontWeight: 800,
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    lineHeight: 1,
  },
  statInfo: { padding: "4px 0 12px" },
  statLabel: { fontSize: FS.caption, color: "var(--c-textDim)", marginBottom: 4 },
  statVal: { fontSize: FS.label, color: "var(--c-textSub)" },
  paramsBox: {
    padding: "12px 14px",
    background: "var(--c-bgCard)",
    borderRadius: 8,
    border: `1px solid var(--c-border)`,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  paramsHd: {
    fontSize: FS.caption,
    color: "var(--c-textDim)",
    letterSpacing: "0.1em",
    textTransform: "uppercase" as const,
    marginBottom: 6,
  },
  warnBox: {
    padding: "8px 12px",
    background: "var(--c-warnBg)",
    border: `1px solid var(--c-warnBd)`,
    borderRadius: 6,
    color: "var(--c-warn)",
    fontSize: FS.small,
  },
  infoBox: {
    padding: "8px 12px",
    background: "var(--c-accentBg)",
    border: `1px solid var(--c-accentBd)`,
    borderRadius: 6,
    color: "var(--c-textSub)",
    fontSize: FS.small,
  },
  saveChoiceBox: {
    marginTop: "auto",
    background: "var(--c-bgCard)",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 12,
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  saveChoiceBtns: { display: "flex", gap: 10 },
  btnSaveCompressed: {
    flex: 1,
    padding: "14px 10px",
    background: "var(--c-accentBg)",
    border: `2px solid var(--c-accentBd)`,
    borderRadius: 9,
    cursor: "pointer",
    fontFamily: F,
    transition: "all 0.12s",
  },
  btnSaveOriginal: {
    flex: 1,
    padding: "14px 10px",
    background: "var(--c-bgHover)",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 9,
    cursor: "pointer",
    fontFamily: F,
    transition: "all 0.12s",
  },
  saveBtnIcon: { fontSize: 22 },
  saveBtnMain: { fontSize: FS.label, fontWeight: 700, color: "var(--c-text)" },
  saveBtnSub: { fontSize: FS.caption, color: "var(--c-textSub)" },

  bpTitle: { fontSize: FS.subtitle, fontWeight: 700, color: "var(--c-text)" },
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
  bpCurFile: { fontSize: FS.small, color: "var(--c-textSub)" },
  bpOutDir: { fontSize: FS.caption, color: "var(--c-textDim)" },
  bpLog: {
    width: "100%",
    maxWidth: 480,
    display: "flex",
    flexDirection: "column",
    gap: 5,
    maxHeight: 280,
    overflowY: "auto",
  },
  bpRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "6px 10px",
    background: "var(--c-bgCard)",
    borderRadius: 6,
    border: `1px solid var(--c-border)`,
  },
  bpFile: {
    flex: 1,
    minWidth: 0,
    fontSize: FS.small,
    color: "var(--c-text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  bpPct: {
    flexShrink: 0,
    fontSize: FS.caption,
    color: "var(--c-textSub)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "45%",
  },
  btnChain: {
    flex: 1,
    padding: "8px 12px",
    background: "var(--c-accent)",
    color: "#000",
    border: "none",
    borderRadius: 6,
    fontSize: FS.small,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: F,
  },
  bpErrMsg: { fontSize: FS.caption, color: "var(--c-err)" },
};
