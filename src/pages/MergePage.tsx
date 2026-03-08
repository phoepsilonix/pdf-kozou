// src/pages/MergePage.tsx
// 複数PDFをリスト管理（並べ替え・追加・削除）して結合する

import { useState, useCallback, useRef } from "react";
import { invoke }         from "@tauri-apps/api/core";
import { usePdfStore }    from "../store/usePdfStore";
import { useSaveDialog }  from "../hooks/useSaveDialog";
import { mergePdf, getPdfInfo, type MergeResponse } from "../lib/tauri";
import { Spinner, ErrorView } from "./SplitPage";

interface PdfEntry {
  id:        number;
  path:      string;
  filename:  string;
  pageCount: number;
}

type Phase = "edit" | "processing" | "result" | "error";

let nextId = 1;

export function MergePage() {
  const { setError } = usePdfStore();
  const { pickSave } = useSaveDialog();

  const [phase,     setPhase]    = useState<Phase>("edit");
  const [entries,   setEntries]  = useState<PdfEntry[]>([]);
  const [result,    setResult]   = useState<MergeResponse | null>(null);
  const [errMsg,    setErrMsg]   = useState("");
  const [dragOver,  setDragOver] = useState(false);
  const [dragging,  setDragging] = useState<number | null>(null);  // entry id
  const [dragTarget,setDragTarget] = useState<number | null>(null); // entry id

  // ── ファイル追加 ────────────────────────────────────────────────────
  const addFiles = useCallback(async (paths: string[]) => {
    for (const path of paths) {
      try {
        const info = await getPdfInfo(path);
        setEntries(prev => [...prev, {
          id: nextId++,
          path,
          filename: path.split(/[/\\]/).pop() ?? path,
          pageCount: info.page_count,
        }]);
      } catch (e) {
        setError(`${path}: ${e}`);
      }
    }
  }, [setError]);

  const pickFiles = useCallback(async () => {
    const paths = await invoke<string[]>("pick_open_files").catch(() => [] as string[]);
    if (paths.length > 0) await addFiles(paths);
  }, [addFiles]);

  // ── 削除 ────────────────────────────────────────────────────────────
  const removeEntry = (id: number) =>
    setEntries(prev => prev.filter(e => e.id !== id));

  // ── ドラッグ並べ替え ─────────────────────────────────────────────────
  const onDragStart = (id: number) => setDragging(id);
  const onDragEnter = (id: number) => setDragTarget(id);
  const onDragEnd   = () => {
    if (dragging !== null && dragTarget !== null && dragging !== dragTarget) {
      setEntries(prev => {
        const arr   = [...prev];
        const fromI = arr.findIndex(e => e.id === dragging);
        const toI   = arr.findIndex(e => e.id === dragTarget);
        const [item] = arr.splice(fromI, 1);
        arr.splice(toI, 0, item);
        return arr;
      });
    }
    setDragging(null);
    setDragTarget(null);
  };

  // ── 上下移動ボタン ───────────────────────────────────────────────────
  const moveUp = (i: number) => {
    if (i === 0) return;
    setEntries(prev => {
      const a = [...prev];
      [a[i-1], a[i]] = [a[i], a[i-1]];
      return a;
    });
  };
  const moveDown = (i: number) => {
    setEntries(prev => {
      if (i >= prev.length - 1) return prev;
      const a = [...prev];
      [a[i], a[i+1]] = [a[i+1], a[i]];
      return a;
    });
  };

  // ── 実行 ────────────────────────────────────────────────────────────
  const handleExecute = useCallback(async () => {
    if (entries.length < 2) return;
    const savePath = await pickSave("merged.pdf");
    if (!savePath) return;

    setPhase("processing");
    try {
      const res = await mergePdf(entries.map(e => e.path), savePath);
      setResult(res);
      setPhase("result");
    } catch (e) {
      setErrMsg(String(e));
      setPhase("error");
      setError(String(e));
    }
  }, [entries, pickSave, setError]);

  const totalPages = entries.reduce((s, e) => s + e.pageCount, 0);

  // ── 処理中・エラー ───────────────────────────────────────────────────
  if (phase === "processing") return <Spinner label="結合処理中…" />;
  if (phase === "error") return (
    <ErrorView msg={errMsg} onBack={() => { setPhase("edit"); setErrMsg(""); }} />
  );

  // ── 結果 ─────────────────────────────────────────────────────────────
  if (phase === "result" && result) {
    const mb = (result.output_bytes / 1048576).toFixed(2);
    return (
      <div style={s.root}>
        <div style={s.header}>
          <button style={s.btnBack}
            onClick={() => { setPhase("edit"); setResult(null); }}>
            ← 戻る
          </button>
          <span style={s.title}>結合完了</span>
        </div>
        <div style={s.resultBody}>
          <div style={s.resultIcon}>✓</div>
          <div style={s.resultStat}>{result.page_count} ページ / {mb} MB</div>
          <div style={s.resultSub}>{entries.length} ファイルを結合しました</div>
        </div>
      </div>
    );
  }

  // ── 設定画面 ─────────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      <div style={s.header}>
        <span style={s.title}>PDFを結合</span>
        {entries.length > 0 && (
          <>
            <span style={s.pageSub}>{entries.length} ファイル / 合計 {totalPages} ページ</span>
            <div style={{ flex:1 }} />
            <button style={s.btnClear}
              onClick={() => setEntries([])}>クリア</button>
          </>
        )}
        {entries.length === 0 && <div style={{ flex:1 }} />}
      </div>

      <div style={s.body}>
        {/* ドロップゾーン（リストが空の場合は大きく表示） */}
        {entries.length === 0 ? (
          <div
            style={{ ...s.dropZone, ...(dragOver ? s.dropZoneOn : {}) }}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => {
              e.preventDefault();
              setDragOver(false);
              const paths = Array.from(e.dataTransfer.files)
                .filter(f => f.name.endsWith(".pdf"))
                .map(f => (f as any).path as string)
                .filter(Boolean);
              if (paths.length) addFiles(paths);
            }}
          >
            <span style={s.dropIcon}>⊕</span>
            <span style={s.dropTitle}>PDFをここにドロップ</span>
            <span style={s.dropSub}>または</span>
            <button style={s.btnAddBig} onClick={pickFiles}>
              ファイルを選択…
            </button>
          </div>
        ) : (
          <div style={s.listArea}>
            {/* ドラッグ&ドロップ並べ替えリスト */}
            <div style={s.list}>
              {entries.map((entry, i) => (
                <div
                  key={entry.id}
                  draggable
                  onDragStart={() => onDragStart(entry.id)}
                  onDragEnter={() => onDragEnter(entry.id)}
                  onDragEnd={onDragEnd}
                  onDragOver={e => e.preventDefault()}
                  style={{
                    ...s.listItem,
                    ...(dragging  === entry.id  ? s.itemDragging  : {}),
                    ...(dragTarget === entry.id && dragging !== entry.id ? s.itemTarget : {}),
                  }}
                >
                  {/* 順番 */}
                  <span style={s.itemNum}>{i + 1}</span>

                  {/* ドラッグハンドル */}
                  <span style={s.dragHandle} title="ドラッグして並べ替え">⠿</span>

                  {/* ファイル情報 */}
                  <div style={s.itemInfo}>
                    <span style={s.itemName} title={entry.path}>{entry.filename}</span>
                    <span style={s.itemPages}>{entry.pageCount} ページ</span>
                  </div>

                  {/* 上下ボタン */}
                  <div style={s.moveButtons}>
                    <button style={s.moveBtn} onClick={() => moveUp(i)}
                      disabled={i === 0} title="上へ">↑</button>
                    <button style={s.moveBtn} onClick={() => moveDown(i)}
                      disabled={i === entries.length - 1} title="下へ">↓</button>
                  </div>

                  {/* 削除 */}
                  <button style={s.delBtn} onClick={() => removeEntry(entry.id)}
                    title="削除">✕</button>
                </div>
              ))}

              {/* リストの末尾にドロップゾーン */}
              <div
                style={{ ...s.addRow, ...(dragOver ? s.addRowOn : {}) }}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => {
                  e.preventDefault();
                  setDragOver(false);
                  const paths = Array.from(e.dataTransfer.files)
                    .filter(f => f.name.endsWith(".pdf"))
                    .map(f => (f as any).path as string)
                    .filter(Boolean);
                  if (paths.length) addFiles(paths);
                }}
              >
                <button style={s.btnAdd} onClick={pickFiles}>
                  ＋ PDFを追加
                </button>
                <span style={s.addHint}>ドロップでも追加できます</span>
              </div>
            </div>

            {/* 実行ボタン */}
            <div style={s.execArea}>
              <div style={s.summaryLine}>
                <span style={s.summaryFiles}>{entries.length} ファイル</span>
                <span style={s.summarySep}>·</span>
                <span style={s.summaryPages}>合計 {totalPages} ページ</span>
                <span style={s.summaryArrow}>→</span>
                <span style={s.summaryOut}>1 ファイル</span>
              </div>
              <button
                style={{ ...s.execBtn, ...(entries.length < 2 ? s.execDis : {}) }}
                onClick={handleExecute}
                disabled={entries.length < 2}
              >
                {entries.length < 2 ? "2ファイル以上必要です" : "⊕ 結合して保存"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── スタイル ──────────────────────────────────────────────────────────────────

const F = "'JetBrains Mono','Noto Sans JP',monospace";

const s: Record<string, React.CSSProperties> = {
  root:   { display:"flex", flexDirection:"column", height:"100%", background:"#0a0c10", color:"#e8eaf0", fontFamily:F, overflow:"hidden" },
  header: { display:"flex", alignItems:"center", gap:10, padding:"12px 20px", borderBottom:"1px solid #1a1d24", flexShrink:0 },
  title:  { fontSize:15, fontWeight:700, color:"#c8cad8" },
  pageSub:{ fontSize:11, color:"#4a5060" },
  btnBack:{ padding:"5px 14px", background:"transparent", border:"1px solid #2a2e38", borderRadius:6, color:"#5a6070", cursor:"pointer", fontSize:11, fontFamily:F },
  btnClear:{ padding:"5px 14px", background:"transparent", border:"1px solid #3a2020", borderRadius:6, color:"#6a3030", cursor:"pointer", fontSize:11, fontFamily:F },

  body: { flex:1, display:"flex", overflow:"hidden" },

  // 空状態のドロップゾーン
  dropZone:   { flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:14, margin:24, borderRadius:12, border:"2px dashed #1a1d24", background:"#0d1017", transition:"all 0.15s" },
  dropZoneOn: { borderColor:"#4f9eff", background:"#0a1a2a" },
  dropIcon:   { fontSize:48, color:"#2a3040" },
  dropTitle:  { fontSize:16, fontWeight:600, color:"#4a5060" },
  dropSub:    { fontSize:11, color:"#3a4050" },
  btnAddBig:  { padding:"10px 28px", background:"#1a4a8a", border:"1px solid #4f9eff", borderRadius:8, color:"#4f9eff", fontWeight:600, cursor:"pointer", fontSize:14, fontFamily:F },

  // リストエリア
  listArea: { flex:1, display:"flex", flexDirection:"column", overflow:"hidden", padding:"16px 20px", gap:0 },
  list:     { flex:1, overflowY:"auto", display:"flex", flexDirection:"column", gap:6, paddingBottom:8 },

  listItem:    { display:"flex", alignItems:"center", gap:8, padding:"10px 12px", background:"#0d1017", border:"1px solid #1a1d24", borderRadius:8, cursor:"grab", transition:"all 0.1s", userSelect:"none" },
  itemDragging:{ opacity:0.4, transform:"scale(0.98)" },
  itemTarget:  { borderColor:"#4f9eff", background:"#0a1a2a", transform:"translateY(-2px)" },

  itemNum:   { fontSize:11, color:"#3a4050", width:20, textAlign:"center", flexShrink:0 },
  dragHandle:{ fontSize:16, color:"#2a3040", cursor:"grab", flexShrink:0, letterSpacing:"-2px" },
  itemInfo:  { flex:1, display:"flex", flexDirection:"column", gap:2, minWidth:0 },
  itemName:  { fontSize:13, color:"#c8cad8", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  itemPages: { fontSize:10, color:"#4a5060" },

  moveButtons: { display:"flex", flexDirection:"column", gap:2, flexShrink:0 },
  moveBtn:     { padding:"1px 6px", background:"transparent", border:"1px solid #1a1d24", borderRadius:3, color:"#4a5060", cursor:"pointer", fontSize:10, fontFamily:F, lineHeight:1.4 },

  delBtn: { padding:"4px 8px", background:"transparent", border:"none", color:"#4a3030", cursor:"pointer", fontSize:13, flexShrink:0 },

  addRow:    { display:"flex", alignItems:"center", gap:10, padding:"8px 12px", borderRadius:8, border:"1px dashed #1a1d24", transition:"all 0.12s" },
  addRowOn:  { borderColor:"#4f9eff", background:"#0a1a2a" },
  btnAdd:    { padding:"6px 16px", background:"transparent", border:"1px solid #2a2e38", borderRadius:6, color:"#4a5060", cursor:"pointer", fontSize:12, fontFamily:F },
  addHint:   { fontSize:10, color:"#2a3040" },

  execArea:    { flexShrink:0, paddingTop:14, display:"flex", flexDirection:"column", gap:10, borderTop:"1px solid #1a1d24" },
  summaryLine: { display:"flex", alignItems:"center", gap:8, justifyContent:"center" },
  summaryFiles:{ fontSize:13, fontWeight:600, color:"#c8cad8" },
  summarySep:  { color:"#3a4050" },
  summaryPages:{ fontSize:13, color:"#5a6070" },
  summaryArrow:{ fontSize:16, color:"#3a4050" },
  summaryOut:  { fontSize:13, fontWeight:600, color:"#4f9eff" },
  execBtn:     { padding:"13px 0", background:"#1a4a8a", border:"1px solid #4f9eff", borderRadius:8, color:"#4f9eff", fontWeight:700, fontSize:14, cursor:"pointer", fontFamily:F, textAlign:"center" },
  execDis:     { opacity:0.35, cursor:"not-allowed", background:"#1a1d24", borderColor:"#2a2e38", color:"#4a5060" },

  // 結果
  resultBody: { flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:14 },
  resultIcon: { fontSize:56, color:"#4fe090" },
  resultStat: { fontSize:20, fontWeight:700, color:"#c8cad8" },
  resultSub:  { fontSize:12, color:"#5a6070" },
};
