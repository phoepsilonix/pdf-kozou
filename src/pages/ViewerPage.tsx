// src/pages/ViewerPage.tsx — キーボード・マウス拡張ビューワー
import { useEffect, useState, useCallback, useRef } from "react";
import { renderPage, getPdfInfo, type PdfInfo } from "../lib/tauri";
import { Spinner, PageHeader } from "../components/common";
import { type FileEntry } from "../store/usePdfStore";
import { F } from "../lib/theme";

interface Props {
  filePath?: string;
  pdfInfo?: PdfInfo;
  fileList?: FileEntry[];
}

const THUMB_DPI = 52;
const VIEW_DPI = 160;

// ページのアスペクト比 (w/h) を取得。回転(90/270)なら逆転
function pageAspect(info: PdfInfo | null, pageIdx: number): number {
  if (!info || !info.pages[pageIdx]) return 1 / 1.414;
  const p = info.pages[pageIdx];
  const r = (p as any).rotate ?? 0;
  if (r === 90 || r === 270) return p.h / p.w;
  return p.w / p.h;
}

export function ViewerPage({ filePath, pdfInfo, fileList = [] }: Props) {
  const isMulti = fileList.length > 1;
  const [activeIdx, setActiveIdx] = useState(0);
  const [activeInfo, setActiveInfo] = useState<PdfInfo | null>(pdfInfo ?? null);
  const activePath = isMulti ? fileList[activeIdx]?.path : (filePath ?? "");

  useEffect(() => {
    if (!isMulti) {
      setActiveInfo(pdfInfo ?? null);
      return;
    }
    setActiveInfo(null);
    const path = fileList[activeIdx]?.path;
    if (path)
      getPdfInfo(path)
        .then(setActiveInfo)
        .catch(() => {});
  }, [activeIdx, isMulti]);

  const total = activeInfo?.page_count ?? 0;

  const thumbCache = useRef<Map<string, (string | undefined)[]>>(new Map());
  const [thumbs, setThumbs] = useState<(string | undefined)[]>([]);
  const [viewPage, setViewPage] = useState(0);
  const [viewImg, setViewImg] = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [zoom, setZoom] = useState(1.0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // サムネイル取得
  useEffect(() => {
    if (!activePath || !activeInfo) {
      setThumbs([]);
      return;
    }
    const cached = thumbCache.current.get(activePath);
    if (cached) setThumbs([...cached]);
    else {
      const arr: (string | undefined)[] = new Array(activeInfo.page_count).fill(undefined);
      thumbCache.current.set(activePath, arr);
      setThumbs([]);
    }
    let cancelled = false;
    const info = activeInfo;
    (async () => {
      const cur = thumbCache.current.get(activePath)!;
      for (let i = 0; i < info.page_count; i++) {
        if (cur[i]) continue;
        try {
          const b64 = await renderPage(activePath, i, THUMB_DPI);
          if (cancelled) return;
          cur[i] = b64;
          thumbCache.current.set(activePath, [...cur]);
          setThumbs([...cur]);
        } catch {}
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePath, activeInfo]);

  const openPage = useCallback(
    async (pageIdx: number) => {
      if (!activePath) return;
      setViewPage(pageIdx);
      setViewLoading(true);
      setViewImg(null);
      try {
        const b64 = await renderPage(activePath, pageIdx, VIEW_DPI);
        setViewImg(b64);
      } catch {
        setViewImg(null);
      }
      setViewLoading(false);
    },
    [activePath],
  );

  useEffect(() => {
    if (total > 0) openPage(0);
  }, [activePath, total]);

  // ── キーボード操作 ────────────────────────────────────────────────────────
  const viewPageRef = useRef(viewPage);
  viewPageRef.current = viewPage;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const vp = viewPageRef.current;
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown") {
        if (vp < total - 1) openPage(vp + 1);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") {
        if (vp > 0) openPage(vp - 1);
        return;
      }
      if (e.key === "Home") {
        openPage(0);
        return;
      }
      if (e.key === "End") {
        openPage(total - 1);
        return;
      }
      if (e.key === "+" || e.key === "=" || e.key === "ZoomIn") {
        e.preventDefault();
        e.stopPropagation();
        setZoom((z) => Math.min(4.0, Math.round((z + 0.15) * 100) / 100));
        return;
      }
      if (e.key === "-" || e.key === "ZoomOut") {
        e.preventDefault();
        e.stopPropagation();
        setZoom((z) => Math.max(0.2, Math.round((z - 0.15) * 100) / 100));
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        setZoom(1.0);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [total, openPage]);

  // ── ドラッグスクロール ────────────────────────────────────────────────────
  const dragRef = useRef<{ down: boolean; sx: number; sy: number; sl: number; st: number }>({
    down: false,
    sx: 0,
    sy: 0,
    sl: 0,
    st: 0,
  });

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const el = scrollRef.current!;
    dragRef.current = {
      down: true,
      sx: e.clientX,
      sy: e.clientY,
      sl: el.scrollLeft,
      st: el.scrollTop,
    };
    e.preventDefault();
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.down) return;
      const el = scrollRef.current;
      if (!el) return;
      el.scrollLeft = dragRef.current.sl - (e.clientX - dragRef.current.sx);
      el.scrollTop = dragRef.current.st - (e.clientY - dragRef.current.sy);
    };
    const onUp = () => {
      dragRef.current.down = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (e.altKey || e.shiftKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom((z) => Math.min(4.0, Math.max(0.2, Math.round((z + delta) * 100) / 100)));
    }
  }, []);

  if (!activeInfo) return <Spinner label="読み込み中…" />;
  const fname = activePath.split(/[/\\]/).pop() ?? "";

  // 左ペインのサムネイル幅: 110px固定。高さをアスペクト比で動的計算
  const THUMB_W = 104;

  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>ビューワー</span>
        <span style={s.fileSub} title={activePath}>
          {fname}
        </span>
        <span style={s.pageBadge}>{total}ページ</span>
        <div style={{ flex: 1 }} />
        <div style={s.zoomRow}>
          <button style={s.zBtn} onClick={() => setZoom((z) => Math.max(0.2, z - 0.25))}>
            −
          </button>
          <span style={s.zVal}>{Math.round(zoom * 100)}%</span>
          <button style={s.zBtn} onClick={() => setZoom((z) => Math.min(4.0, z + 0.25))}>
            ＋
          </button>
          <button style={s.zBtnSm} onClick={() => setZoom(1.0)}>
            100%
          </button>
          <button style={s.zBtnSm} onClick={() => setZoom(1.5)}>
            150%
          </button>
        </div>
      </PageHeader>

      <div style={s.body}>
        {/* 複数ファイルペイン */}
        {isMulti && (
          <div style={s.filePane}>
            <div style={s.paneHead}>ファイル ({fileList.length})</div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {fileList.map((f, i) => (
                <button
                  key={f.id}
                  style={{ ...s.filePaneItem, ...(i === activeIdx ? s.filePaneItemOn : {}) }}
                  onClick={() => {
                    setActiveIdx(i);
                    setZoom(1.0);
                  }}
                >
                  <span style={s.filePaneIcon}>📄</span>
                  <div style={s.filePaneInfo}>
                    <span style={s.filePaneName}>{f.filename}</span>
                    <span style={s.filePaneMeta}>{f.pageCount}p</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* サムネイルペイン — 横長ページも適切な高さで表示 */}
        <div style={s.thumbPane}>
          <div style={s.paneHead}>
            {viewPage + 1} / {total}
          </div>
          <div style={s.thumbList}>
            {Array.from({ length: total }, (_, i) => {
              const aspect = pageAspect(activeInfo, i);
              const th = Math.round(THUMB_W / aspect);
              return (
                <button
                  key={i}
                  style={{ ...s.thumbItem, ...(i === viewPage ? s.thumbItemOn : {}) }}
                  onClick={() => openPage(i)}
                  title={`ページ ${i + 1}`}
                >
                  {/* 高さをアスペクト比に合わせる */}
                  <div
                    style={{
                      width: THUMB_W,
                      height: th,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      overflow: "hidden",
                      background: "var(--c-bg)",
                      borderRadius: 2,
                    }}
                  >
                    {thumbs[i] ? (
                      <img
                        src={`data:image/jpeg;base64,${thumbs[i]}`}
                        style={{
                          maxWidth: THUMB_W,
                          maxHeight: th,
                          objectFit: "contain",
                          display: "block",
                        }}
                        alt=""
                      />
                    ) : (
                      <div style={{ width: THUMB_W, height: th, background: "var(--c-border)" }} />
                    )}
                  </div>
                  <span style={{ ...s.thumbN, ...(i === viewPage ? s.thumbNOn : {}) }}>
                    {i + 1}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* メインビュー */}
        <div style={s.mainView} onWheel={onWheel}>
          {viewLoading && (
            <div style={s.viewCenter}>
              <div style={s.viewSpinner} />
            </div>
          )}
          {!viewLoading && viewImg && (
            <div
              ref={scrollRef}
              style={s.viewScroll}
              onMouseDown={onMouseDown}
              title="ドラッグでスクロール / Alt+ホイール or +/- でズーム"
            >
              <div style={s.viewInner}>
                <img
                  src={`data:image/jpeg;base64,${viewImg}`}
                  draggable={false}
                  style={{
                    display: "block",
                    width: `${Math.round(zoom * 600)}px`,
                    height: "auto",
                    boxShadow: "0 4px 32px rgba(0,0,0,0.7)",
                    borderRadius: 2,
                    flexShrink: 0,
                    userSelect: "none",
                    pointerEvents: "none",
                  }}
                  alt={`ページ ${viewPage + 1}`}
                />
              </div>
            </div>
          )}
          {!viewLoading && !viewImg && (
            <div style={s.viewCenter}>
              <span style={{ color: "var(--c-textDim)", fontSize: 14 }}>表示できません</span>
            </div>
          )}

          <div style={s.pageNav}>
            <button
              style={s.pageNavBtn}
              disabled={viewPage === 0}
              onClick={() => openPage(viewPage - 1)}
            >
              ← 前
            </button>
            <span style={s.pageNavInfo}>
              {viewPage + 1} / {total}
            </span>
            <button
              style={s.pageNavBtn}
              disabled={viewPage >= total - 1}
              onClick={() => openPage(viewPage + 1)}
            >
              次 →
            </button>
          </div>
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
    color: "var(--c-text)",
    fontFamily: F,
    overflow: "hidden",
  },
  title: { fontSize: 16, fontWeight: 700, color: "var(--c-text)" },
  fileSub: {
    fontSize: 13,
    color: "var(--c-textSub)",
    maxWidth: 180,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pageBadge: {
    padding: "3px 11px",
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-border)",
    borderRadius: 11,
    fontSize: 12,
    color: "var(--c-textSub)",
  },
  zoomRow: { display: "flex", alignItems: "center", gap: 4 },
  zBtn: {
    width: 32,
    height: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-borderHi)",
    borderRadius: 5,
    cursor: "pointer",
    fontSize: 15,
    color: "var(--c-text)",
    fontFamily: F,
  },
  zVal: { fontSize: 13, color: "var(--c-textSub)", minWidth: 36, textAlign: "center" as const },
  zBtnSm: {
    padding: "5px 12px",
    background: "var(--c-bgCard)",
    border: "1px solid var(--c-borderHi)",
    borderRadius: 5,
    cursor: "pointer",
    fontSize: 10,
    color: "var(--c-textSub)",
    fontFamily: F,
  },
  body: { flex: 1, display: "flex", overflow: "hidden" },
  filePane: {
    width: 180,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    borderRight: "1px solid var(--c-border)",
    overflow: "hidden",
  },
  paneHead: {
    padding: "7px 10px",
    fontSize: 10,
    color: "var(--c-textDim)",
    letterSpacing: "0.06em",
    textTransform: "uppercase" as const,
    borderBottom: "1px solid var(--c-border)",
    flexShrink: 0,
    background: "var(--c-bgCard)",
  },
  filePaneItem: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "9px 10px",
    background: "transparent",
    border: "none",
    borderBottom: "1px solid var(--c-border)",
    cursor: "pointer",
    fontFamily: F,
    textAlign: "left" as const,
    transition: "background 0.08s",
    width: "100%",
  },
  filePaneItemOn: { background: "var(--c-accentBg)" },
  filePaneIcon: { fontSize: 14, flexShrink: 0 },
  filePaneInfo: { flex: 1, display: "flex", flexDirection: "column", gap: 1, minWidth: 0 },
  filePaneName: {
    fontSize: 13,
    color: "var(--c-text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  filePaneMeta: { fontSize: 9, color: "var(--c-textSub)" },
  thumbPane: {
    width: 128,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    borderRight: "1px solid var(--c-border)",
    overflow: "hidden",
    background: "var(--c-bgCard)",
  },
  thumbList: {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "6px 6px",
  },
  thumbItem: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    padding: "3px",
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: 5,
    cursor: "pointer",
    transition: "all 0.1s",
    fontFamily: F,
  },
  thumbItemOn: { border: "1px solid var(--c-accent)", background: "var(--c-accentBg)" },
  thumbN: { fontSize: 9, color: "var(--c-textDim)" },
  thumbNOn: { color: "var(--c-accent)", fontWeight: 700 },
  mainView: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "#070e09",
  },
  viewCenter: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center" },
  viewSpinner: {
    width: 28,
    height: 28,
    border: "3px solid var(--c-border)",
    borderTop: "3px solid var(--c-accent)",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  viewScroll: { flex: 1, overflow: "scroll", overscrollBehavior: "contain", cursor: "grab" },
  viewInner: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    minWidth: "100%",
    minHeight: "100%",
    padding: 24,
  },
  pageNav: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    padding: 8,
    borderTop: "1px solid var(--c-border)",
    background: "var(--c-bgCard)",
  },
  pageNavBtn: {
    padding: "5px 18px",
    background: "var(--c-accentBg)",
    border: "1px solid var(--c-accentBd)",
    borderRadius: 6,
    color: "var(--c-accent)",
    cursor: "pointer",
    fontSize: 12,
    fontFamily: F,
  },
  pageNavInfo: {
    fontSize: 14,
    color: "var(--c-textSub)",
    minWidth: 52,
    textAlign: "center" as const,
  },
};
