// src/pages/CompressPage.tsx
// フロー（単体）: プリセット選択 → プレビュー実行 → 結果確認 → [圧縮保存 / 圧縮せず保存]
// フロー（バッチ）: プリセット選択 → 出力フォルダ選択 → 全件処理 → 結果

import { useState, useCallback, useEffect } from "react"; // useEffectを追加
import { invoke } from "@tauri-apps/api/core";
import { useSaveDialog } from "../hooks/useSaveDialog";
import { usePdfStore } from "../store/usePdfStore";
import {
  compressPdf,
  getTmpPath,
  renderPage,
  type CompressPreset,
  type CompressResponse,
  type PdfInfo,
} from "../lib/tauri";
import { F } from "../lib/theme";

interface Props {
  filePath: string;
  pdfInfo: PdfInfo;
  sourceFile?: string; // 連携元ファイル（trim後など）
  onDone?: () => void;
  batchFiles?: import("../store/usePdfStore").FileEntry[];
}

type Phase = "edit" | "processing" | "result" | "batchResult" | "error";

const PRESETS: {
  id: CompressPreset;
  icon: string;
  label: string;
  desc: string;
  note: string;
  color: string;
}[] = [
  {
    id: "light",
    icon: "☁",
    label: "軽め",
    desc: "GC=1、画像圧縮なし",
    note: "フォント完全保護。効果小さめ",
    color: "#3a7a4a",
  },
  {
    id: "standard",
    icon: "⚖",
    label: "標準",
    desc: "GC=2、画像圧縮あり",
    note: "バランス重視。ほとんどのPDFに安全",
    color: "#2a5a9a",
  },
  {
    id: "aggressive",
    icon: "⚡",
    label: "強め",
    desc: "GC=2、sanitize,merge-fonts,object-stream",
    note: "⚠ 埋め込みフォントに影響する場合あり",
    color: "#7a5a1a",
  },
  {
    id: "maximum",
    icon: "🔥",
    label: "最大",
    desc: "GC=3、sanitize,clean,merge-fonts,object-stream",
    note: "⚠ 最大圧縮",
    color: "#7a2020",
  },
];

// --- 追加：GS専用のプリセット定義 ---
const GS_PRESETS: {
  id: "Prepress" | "Printer" | "Ebook";
  icon: string;
  label: string;
  desc: string;
  note: string;
  color: string;
}[] = [
  {
    id: "Prepress",
    icon: "✨",
    label: "高品質(prepress)",
    desc: "300dpi / 低圧縮",
    note: "印刷・商業出版向け。画質を最優先",
    color: "#2a5a9a",
  },
  {
    id: "Printer",
    icon: "🖨️",
    label: "プリント(printer)",
    desc: "300dpi / 中圧縮",
    note: "一般的な配布・印刷用。標準的",
    color: "#3a7a4a",
  },
  {
    id: "Ebook",
    icon: "📱",
    label: "電子書籍,Web向け(ebook)",
    desc: "150dpi / 高圧縮",
    note: "画面閲覧・メール送信用。軽量化",
    color: "#7a5a1a",
  },
];

export function CompressPage({ filePath, pdfInfo, sourceFile, onDone, batchFiles }: Props) {
  const { setError } = usePdfStore();
  const { pickSave } = useSaveDialog();

  const [currentSource, setCurrentSource] = useState(sourceFile ?? filePath);
  const isBatch = (batchFiles?.length ?? 0) > 1;
  const inputFile = currentSource;

  const [phase, setPhase] = useState<Phase>("edit");
  const [preset, setPreset] = useState<CompressPreset>("standard");
  const [objectStream, setObjectStream] = useState(false);
  const [mergeFonts, setMergeFonts] = useState(false);

  const [result, setResult] = useState<CompressResponse | null>(null);
  const [tmpFile, setTmpFile] = useState("");
  const [preview, setPreview] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [outDir, setOutDir] = useState("");
  const [batchProg, setBatchProg] = useState<{
    cur: number;
    total: number;
    curFile: string;
    done: { file: string; pct: string }[];
    errors: { file: string; msg: string }[];
  } | null>(null);

  // --- GS追加用 ---
  const [gsPath, setGsPath] = useState<string | null>(null);
  const [useGs, setUseGs] = useState(false);
  const [gsAvailable, setGsAvailable] = useState(false);
  const [gsPreset, setGsPreset] = useState<"Prepress" | "Printer" | "Ebook">("Printer");

  useEffect(() => {
    invoke<string | null>("find_gs_executable")
      .then((path) => {
        setGsPath(path);
        // パスが見つかれば GS 利用可能とする
        setGsAvailable(!!path);
      })
      .catch(() => setGsAvailable(false));
  }, []);

  useEffect(() => {
    invoke<boolean>("check_ghostscript_installed")
      .then(setGsAvailable)
      .catch(() => setGsAvailable(false));
  }, []);
  // ----------------

  const pickDir = useCallback(async () => {
    const d = await invoke<string | null>("pick_output_dir").catch(() => null);
    if (d) setOutDir(d);
  }, []);

  const handlePreview = useCallback(async () => {
    if (useGs && !gsPath) {
      setError("Ghostscriptが見つかりません。");
      return;
    }
    setPhase("processing");
    try {
      const tmp = await getTmpPath("kozou_compress_preview.pdf");
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
          throw new Error("GS出力ファイルのサイズが0です。変換に失敗した可能性があります。");
        }

        setResult({
          input_bytes: inSize,
          output_bytes: outSize,
          ratio: outSize / inSize,
          params_used: undefined as any,
        });
      } else {
        const res = await compressPdf(inputFile, tmp, {
          preset,
          merge_fonts: mergeFonts || undefined,
          object_stream: objectStream || undefined,
        });
        setResult(res);
      }

      setTmpFile(tmp);
      try {
        setPreview(await renderPage(tmp, 0, 108));
      } catch (e) {
        setPreview("");
      }
      setPhase("result");
    } catch (e) {
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

      // ステートを更新して「次の入力」としてセット
      setCurrentSource(chainedPath);

      // UIをリセットして設定画面へ
      setResult(null);
      setPhase("edit");

      // モードを自動で切り替える（GSならMuPDFへ、MuPDFならGSへ）
      setUseGs(!useGs);
      //setPreview("");            // プレビューも一旦クリア
    } catch (e) {
      setError("連携ファイルの作成に失敗しました: " + String(e));
    }
  }, [tmpFile, useGs, setError]);

  const handleResetSource = useCallback(() => {
    // Propsで渡された最初のファイルパス（sourceFile または filePath）に戻す
    setCurrentSource(sourceFile ?? filePath);
    setPhase("edit");
    setResult(null);
    setPreview("");
    // 必要ならモードも初期（MuPDF）に戻す
    //setUseGs(false);
  }, [sourceFile, filePath]);

  const handleSaveCompressed = useCallback(async () => {
    const base =
      filePath
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.pdf$/i, "") ?? "file";
    const sp = await pickSave(`${base}_compressed.pdf`);
    if (!sp || (useGs && !gsPath)) return;
    setSaving(true);
    try {
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
        });
      }
      if (onDone) onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [
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
    onDone,
  ]);

  const handleSaveOriginal = useCallback(async () => {
    const base =
      filePath
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.pdf$/i, "") ?? "file";
    const sp = await pickSave(`${base}.pdf`);
    if (!sp) return;
    setSaving(true);
    try {
      await invoke("copy_file", { src: inputFile, dst: sp });
      if (onDone) onDone();
    } catch (e) {
      //await compressPdf(inputFile, sp, { preset: "light" });
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [inputFile, filePath, pickSave, setError, onDone]);

  const handleBatch = useCallback(async () => {
    if (!outDir) {
      await pickDir();
      return;
    }
    if (useGs && !gsPath) {
      setError("Ghostscriptのパスが見つかりません。");
      return;
    }

    setPhase("processing");
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
      try {
        const out = `${outDir}/${f.filename.replace(/\.pdf$/i, "")}_compressed.pdf`;
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
          });
          ratio = res.ratio;
        }
        prog.done.push({ file: f.filename, pct: ((1 - ratio) * 100).toFixed(1) });
      } catch (e) {
        prog.errors.push({ file: f.filename, msg: String(e) });
        console.warn(`圧縮失敗: ${f.filename}. 元ファイルをコピーします。`);
        try {
          // 圧縮に失敗しても、出力フォルダにファイルがない状態を避けるためにコピー
          await invoke("copy_file", { src: f.path, dst: out });

          prog.errors.push({
            file: f.filename,
            msg: `圧縮エラーのため未圧縮でコピーしました (${String(e)})`,
          });
        } catch (copyErr) {
          // コピーすら失敗した場合（ディスクフルや権限エラーなど）
          prog.errors.push({ file: f.filename, msg: `致命的なエラー: ${String(copyErr)}` });
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

  if (phase === "processing" && !isBatch) {
    return (
      <div style={c.center}>
        <div style={c.spinner} />
        <span style={c.spinSub}>圧縮処理中…</span>
      </div>
    );
  }
  if (phase === "processing" && isBatch && batchProg) {
    return (
      <div style={c.center}>
        <div style={c.bpTitle}>
          圧縮処理中… {batchProg.cur}/{batchProg.total}
        </div>
        <div style={c.bpBarWrap}>
          <div style={{ ...c.bpBar, width: `${(batchProg.cur / batchProg.total) * 100}%` }} />
        </div>
        <div style={c.bpCurFile}>{batchProg.curFile}</div>
      </div>
    );
  }
  if (phase === "error") {
    return (
      <div style={c.center}>
        <span style={{ fontSize: 38, color: "var(--c-err)" }}>✕</span>
        <span style={{ fontSize: 16, fontWeight: 700, color: "var(--c-err)" }}>エラー</span>
        <pre style={c.errPre}>{errMsg}</pre>
        <button
          style={c.btnBackSm}
          onClick={() => {
            setPhase("edit");
            setErrMsg("");
          }}
        >
          ← 戻る
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
        <div style={c.bpTitle}>バッチ圧縮完了 — {batchProg.done.length}件</div>
        <div style={{ height: 10 }} />
        <div style={c.bpLog}>
          {batchProg.done.map((d, i) => (
            <div key={i} style={c.bpRow}>
              <span style={{ color: "#4fe090" }}>✓</span>
              <span style={c.bpFile}>{d.file}</span>
              <span style={c.bpPct}>-{d.pct}%</span>
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
          ← 設定に戻る
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
          <button style={c.btnBack} onClick={() => setPhase("edit")}>
            ← 設定に戻る
          </button>
          <span style={c.title}>圧縮プレビュー結果</span>
        </div>
        <div style={c.resultBody}>
          <div style={c.prevCol}>
            {preview ? (
              <img src={`data:image/jpeg;base64,${preview}`} style={c.prevImg} alt="preview" />
            ) : (
              <div style={c.prevPh}>プレビューなし</div>
            )}
          </div>
          <div style={c.statsCol}>
            <div style={{ ...c.statBig, color: gain ? "#4fe090" : "#ff6060" }}>
              {gain ? `−${pct}%` : `+${Math.abs(Number(pct))}%`}
            </div>
            <div style={c.statInfo}>
              <div style={c.statLabel}>ファイルサイズ変化</div>
              <div style={c.statVal}>
                {inMB} MB →{" "}
                <span style={{ color: gain ? "#4fe090" : "#ff6060", fontWeight: 700 }}>
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
                  <PRow label="画像圧縮" val={p.compress_images ? "あり" : "なし"} />
                  <PRow label="フォント圧縮" val={p.compress_fonts ? "あり" : "なし"} />
                  <PRow label="merge_fonts" val={p.merge_fonts ? "あり" : "なし"} />
                  <PRow label="object_stream" val={p.object_stream ? "あり" : "なし"} />
                  <PRow label="sanitize" val={p.sanitize ? "あり" : "なし"} />
                  <PRow label="clean" val={p.clean ? "あり" : "なし"} />
                </>
              )}
            </div>
            {result.warning && <div style={c.warnBox}>{result.warning}</div>}

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
                style={{ fontSize: 11, color: "var(--c-accent)", fontWeight: 700, marginBottom: 6 }}
              >
                🔗 連続圧縮モード
              </div>
              <button style={c.btnChain} onClick={handleChainNext}>
                {useGs ? "この結果を MuPDF でさらに最適化する" : "この結果を GS でさらに再構築する"}
              </button>
              <div style={{ fontSize: 10, color: "var(--c-textDim)", marginTop: 4 }}>
                ※ 現在の圧縮結果を「入力ファイル」として再セットします
              </div>
            </div>

            <div style={c.saveChoiceBox}>
              <div style={c.saveChoiceBtns}>
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
                      <div style={c.saveBtnMain}>圧縮して保存</div>
                      <div style={c.saveBtnSub}>最適化されたファイルを保存します</div>
                    </div>
                  </div>
                </button>
                <button style={c.btnSaveOriginal} onClick={handleSaveOriginal} disabled={saving}>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 12, textAlign: "left" }}
                  >
                    <span style={c.saveBtnIcon}>📄</span>
                    <div>
                      <div style={c.saveBtnMain}>圧縮せず保存</div>
                      <div style={c.saveBtnSub}>元のファイルをコピーして保存します</div>
                    </div>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const fname = inputFile.split(/[/\\]/).pop() ?? "";
  return (
    <div style={c.root}>
      <div style={c.header}>
        <span style={c.fileSub} title={fname}>
          {currentSource !== (sourceFile ?? filePath) ? `🔗 ${fname}` : fname}
        </span>
        {currentSource && <span style={c.chainBadge}>✂ 連携ファイルを圧縮</span>}
        <span style={c.title}>圧縮設定</span>

        {gsAvailable && (
          <div style={{ display: "flex", gap: 4, marginLeft: 16 }}>
            <button
              style={{
                padding: "2px 10px",
                fontSize: 11,
                borderRadius: 4,
                cursor: "pointer",
                border: "1px solid var(--c-borderHi)",
                background: !useGs ? "var(--c-accent)" : "transparent",
                color: !useGs ? "#000" : "var(--c-textSub)",
                fontFamily: F,
              }}
              onClick={() => setUseGs(false)}
            >
              標準 (MuPDF)
            </button>
            <button
              style={{
                padding: "2px 10px",
                fontSize: 11,
                borderRadius: 4,
                cursor: "pointer",
                border: "1px solid var(--c-borderHi)",
                background: useGs ? "var(--c-accent)" : "transparent",
                color: useGs ? "#000" : "var(--c-textSub)",
                fontFamily: F,
              }}
              onClick={() => setUseGs(true)}
            >
              プロ (GS)
            </button>
          </div>
        )}

        {/* 連携中（初期ファイルと異なる）場合のみリセットボタンを表示 */}
        {currentSource !== (sourceFile ?? filePath) && (
          <button
            style={{
              marginLeft: 12,
              padding: "4px 10px",
              fontSize: 11,
              borderRadius: 4,
              background: "var(--c-errBg)",
              color: "var(--c-err)",
              border: "1px solid var(--c-errBd)",
              cursor: "pointer",
              fontFamily: F,
            }}
            onClick={handleResetSource}
          >
            ↩ 連携を解除して最初からやり直す
          </button>
        )}

        <div style={{ flex: 1 }} />
        <span style={c.fileSub} title={fname}>
          {fname}
        </span>
        <span style={c.pageSub}>{pdfInfo.page_count}ページ</span>
      </div>

      <div style={c.scrollArea}>
        {!useGs ? (
          <>
            <div style={c.presetGrid}>
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPreset(p.id)}
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
                オブジェクトのストリーム圧縮
              </label>
              <span style={c.optHint}>
                {objectStream ? "有効 (MuPDFのデフォルト設定を上書き)" : "無効"}
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
                CIDフォント統合 (merge-fonts)
              </label>
              <span style={c.optHint}>
                {mergeFonts ? "有効 (フォントを再利用して削減)" : "無効"}
              </span>
            </div>
          </>
        ) : (
          <>
            {/* 新設：GSプリセット表示 */}
            <div style={c.presetGrid}>
              {GS_PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setGsPreset(p.id)} // GS用のステートを更新
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
                fontSize: 12,
                color: "var(--c-textDim)",
                lineHeight: 1.6,
              }}
            >
              <div style={{ marginBottom: 4, color: "var(--c-textSub)", fontWeight: 700 }}>
                Ghostscript プロモードについて
              </div>
              <div>• 外部プログラムのGhostScriptを呼び出して、高度な再構築を行います。</div>
              <div>• MuPDFに比べて処理時間はかかりますが、互換性の高いPDFが生成されます。</div>
              <div>• 特にトリミングされたPDFにおいて、高い圧縮効果が期待できます。</div>
            </div>
          </>
        )}
      </div>

      <div style={c.execArea}>
        {isBatch ? (
          <div style={c.batchExecBox}>
            <div style={c.dirRow}>
              <div style={c.dirPath}>{outDir || "出力先フォルダを選択してください..."}</div>
              <button style={c.dirPickBtn} onClick={pickDir}>
                フォルダ選択
              </button>
            </div>
            <button
              style={{ ...c.btnExec, ...(!outDir ? c.btnExecDim : {}) }}
              onClick={handleBatch}
              // useGs による制限を解除。gsPath があれば実行可能に
              disabled={!outDir || (useGs && !gsPath)}
            >
              {useGs
                ? `プロモードで一括圧縮 (${batchFiles!.length}個)`
                : `一括圧縮を開始 (${batchFiles!.length}個)`}
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
              {useGs ? "プロモードで全ページ圧縮" : "プレビューを実行する"}
            </button>
          </div>
        )}
      </div>
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
        fontSize: 12,
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
    fontSize: 11,
  },
  title: { fontSize: 14, fontWeight: 700, color: "var(--c-text)" },
  fileSub: {
    fontSize: 12,
    color: "var(--c-textSub)",
    maxWidth: 160,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pageSub: { fontSize: 11, color: "var(--c-textDim)" },

  scrollArea: { flex: 1, overflowY: "auto" },
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
  cardLabel: { fontSize: 16, fontWeight: 700, color: "var(--c-text)" },
  cardDesc: { fontSize: 11, color: "var(--c-textSub)", textAlign: "center" },
  cardNote: { fontSize: 10, color: "var(--c-textDim)", textAlign: "center", lineHeight: 1.5 },

  optRow: { display: "flex", alignItems: "center", gap: 12, padding: "14px 22px 2px" },
  optLabel: {
    display: "flex",
    alignItems: "center",
    fontSize: 13,
    color: "var(--c-text)",
    cursor: "pointer",
  },
  optHint: { fontSize: 11, color: "var(--c-textSub)" },

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
    fontSize: 15,
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
    fontSize: 12,
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
    fontSize: 12,
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
    animation: "spin 0.8s linear infinite",
  },
  spinSub: { color: "var(--c-textSub)", fontSize: 14 },
  errPre: {
    fontSize: 11,
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
    fontSize: 13,
    fontFamily: F,
  },
  btnBackSm: {
    padding: "6px 16px",
    background: "transparent",
    border: `1px solid var(--c-borderHi)`,
    borderRadius: 6,
    color: "var(--c-textSub)",
    cursor: "pointer",
    fontSize: 13,
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
    fontSize: 13,
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
  statLabel: { fontSize: 11, color: "var(--c-textDim)", marginBottom: 4 },
  statVal: { fontSize: 15, color: "var(--c-textSub)" },
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
    fontSize: 10,
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
    fontSize: 12,
  },
  infoBox: {
    padding: "8px 12px",
    background: "var(--c-accentBg)",
    border: `1px solid var(--c-accentBd)`,
    borderRadius: 6,
    color: "var(--c-textSub)",
    fontSize: 12,
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
  saveBtnMain: { fontSize: 14, fontWeight: 700, color: "var(--c-text)" },
  saveBtnSub: { fontSize: 11, color: "var(--c-textSub)" },

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
  bpCurFile: { fontSize: 12, color: "var(--c-textSub)" },
  bpOutDir: { fontSize: 11, color: "var(--c-textDim)" },
  bpLog: {
    width: "100%",
    maxWidth: 480,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    maxHeight: 300,
    overflowY: "auto",
  },
  bpRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "5px 10px",
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
  bpPct: { fontSize: 12, fontWeight: 700, color: "#4fe090" },
  btnChain: {
    flex: 1,
    padding: "8px 12px",
    background: "var(--c-accent)",
    color: "#000",
    border: "none",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: F,
  },
  bpErrMsg: { fontSize: 11, color: "var(--c-err)" },
};
