// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/pages/ViewerPage.tsx
//
// MuPDF ベースビューア（pdfjs-dist 廃止）
//   - メインビュー: renderPage (MuPDF JPEG) → <img>
//   - テキスト選択: getPageText (stext) → 透明 div オーバーレイ
//   - 検索: searchPage → ハイライト矩形
//   - リンク: getPageLinks → クリック処理

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  renderPage,
  getPdfInfo,
  getPageText,
  searchPage,
  getPageLinks,
  type PdfInfo,
  type PdfMetadata,
  type STextBlock,
  type STextChar,
  type STextLine,
  type SearchHit,
  type PageLink,
  type BBox,
} from "../lib/tauri";
import { Spinner, PageHeader } from "../components/common";
import { type FileEntry } from "../store/usePdfStore";
import { F } from "../lib/theme";

// ── 定数 ────────────────────────────────────────────────────────────────────

const THUMB_DPI = 52;
const VIEW_DPI = 150; // メインビューの基本 DPI（高品質）

// ── 型 ──────────────────────────────────────────────────────────────────────

interface Props {
  filePath?: string;
  pdfInfo?: PdfInfo;
  fileList?: FileEntry[];
}

// ── ユーティリティ ────────────────────────────────────────────────────────────

function ptToMm(pt: number): string {
  return ((pt * 25.4) / 72).toFixed(1);
}

function formatDate(d: string): string {
  const s = d.startsWith("D:") ? d.slice(2) : d;
  if (s.length >= 8) {
    const yyyy = s.slice(0, 4),
      mm = s.slice(4, 6),
      dd = s.slice(6, 8);
    if (s.length >= 14) return `${yyyy}/${mm}/${dd} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
    return `${yyyy}/${mm}/${dd}`;
  }
  return d;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(2)} MB`;
}

function pageAspect(info: PdfInfo | null, i: number): number {
  if (!info?.pages[i]) return 1 / 1.414;
  const p = info.pages[i];
  return (p as any).rotate === 90 || (p as any).rotate === 270 ? p.h / p.w : p.w / p.h;
}

// ── テキストレイヤー ──────────────────────────────────────────────────────────
//
// stext の quad 座標（PDF pt × scale = 表示ピクセル）を使って
// 各文字に透明な <span> を配置する。
// ユーザーはブラウザのテキスト選択機能でそのまま選択・コピーできる。

interface TextLayerProps {
  blocks: STextBlock[];
  scale: number; // VIEW_DPI / 72
  width: number; // 表示幅 (px)
  height: number; // 表示高さ (px)
  searchHits: SearchHit[];
}

function TextLayer({ blocks, scale: _s, width, height, searchHits }: TextLayerProps) {
  // PDF の Y 座標は下から上だが、stext の quad は左上原点なのでそのまま使える
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width,
        height,
        overflow: "hidden",
        pointerEvents: "none",
        userSelect: "text",
      }}
    >
      {/* テキスト選択オーバーレイ */}
      <div style={{ position: "absolute", top: 0, left: 0, width, height, pointerEvents: "auto" }}>
        {blocks
          .filter((b) => b.type === "text")
          .map((block, bi) =>
            block.lines.map((line, li) => (
              <div key={`${bi}-${li}`} style={{ position: "absolute" }}>
                {line.chars.map((ch, ci) => {
                  const [ulx, uly, urx, , , lly] = ch.quad;
                  const w = Math.max(1, urx - ulx);
                  const h = Math.max(1, lly - uly);
                  return (
                    <span
                      key={ci}
                      style={{
                        position: "absolute",
                        left: ulx,
                        top: uly,
                        width: w,
                        height: h,
                        fontSize: ch.size,
                        lineHeight: 1,
                        color: "transparent",
                        whiteSpace: "pre",
                        cursor: "text",
                        transformOrigin: "top left",
                        // 文字の実際のサイズに合わせてスケール（フォント依存のずれを補正）
                        transform: `scaleX(${w / (ch.size * 0.6)})`,
                        userSelect: "text",
                      }}
                    >
                      {ch.c}
                    </span>
                  );
                })}
              </div>
            )),
          )}
      </div>

      {/* 検索ヒットのハイライト */}
      {searchHits.map((hit, i) => {
        const [ulx, uly, urx, , , lly] = hit.quad;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: ulx,
              top: uly,
              width: urx - ulx,
              height: lly - uly,
              background: "rgba(255, 200, 0, 0.45)",
              borderRadius: 2,
              pointerEvents: "none",
            }}
          />
        );
      })}
    </div>
  );
}

// ── リンクレイヤー ────────────────────────────────────────────────────────────

interface LinkLayerProps {
  links: PageLink[];
  onNavigate: (page: number) => void;
}

function LinkLayer({ links, onNavigate }: LinkLayerProps) {
  return (
    <>
      {links.map((link, i) => {
        const { x0, y0, x1, y1 } = link.bbox;
        return (
          <a
            key={i}
            href={link.dest_page != null ? undefined : link.uri}
            target={link.dest_page != null ? undefined : "_blank"}
            rel="noopener noreferrer"
            onClick={
              link.dest_page != null
                ? (e) => {
                    e.preventDefault();
                    onNavigate(link.dest_page!);
                  }
                : undefined
            }
            style={{
              position: "absolute",
              left: x0,
              top: y0,
              width: x1 - x0,
              height: y1 - y0,
              cursor: "pointer",
              display: "block",
            }}
            title={link.uri}
          />
        );
      })}
    </>
  );
}

// ── MetaRow / InfoDrawer ──────────────────────────────────────────────────────

function MetaRow({ label, value }: { label: string; value?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div style={ds.row}>
      <span style={ds.label}>{label}</span>
      <span style={ds.value} title={value}>
        {value}
      </span>
      <button
        style={{ ...ds.copyBtn, ...(copied ? ds.copyBtnDone : {}) }}
        onClick={() => {
          navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "✓" : "⎘"}
      </button>
    </div>
  );
}

function InfoDrawer({
  open,
  onClose,
  info,
  filePath,
  fileName,
}: {
  open: boolean;
  onClose: () => void;
  info: PdfInfo | null;
  filePath: string;
  fileName: string;
}) {
  const [allCopied, setAllCopied] = useState(false);
  const meta: PdfMetadata = info?.metadata ?? {};
  const firstPage = info?.pages?.[0];
  const pageSize = firstPage ? `${ptToMm(firstPage.w)} × ${ptToMm(firstPage.h)} mm` : null;
  const hasAnyMeta = !!(
    meta.title ||
    meta.author ||
    meta.subject ||
    meta.keywords ||
    meta.creator ||
    meta.producer ||
    meta.creation_date ||
    meta.mod_date
  );

  const handleCopyAll = () => {
    const lines = [
      fileName && `ファイル名: ${fileName}`,
      filePath && `パス: ${filePath}`,
      info?.file_size != null && `サイズ: ${formatBytes(info.file_size)}`,
      info?.page_count != null && `ページ数: ${info.page_count}`,
      meta.title && `タイトル: ${meta.title}`,
      meta.author && `作成者: ${meta.author}`,
      meta.subject && `件名: ${meta.subject}`,
      meta.keywords && `キーワード: ${meta.keywords}`,
      meta.creator && `アプリ: ${meta.creator}`,
      meta.producer && `変換: ${meta.producer}`,
      meta.creation_date && `作成日: ${formatDate(meta.creation_date)}`,
      meta.mod_date && `更新日: ${formatDate(meta.mod_date)}`,
    ]
      .filter(Boolean)
      .join("\n");
    navigator.clipboard.writeText(lines).then(() => {
      setAllCopied(true);
      setTimeout(() => setAllCopied(false), 1800);
    });
  };

  return (
    <div
      style={{
        ...ds.drawer,
        transform: open ? "translateX(0)" : "translateX(100%)",
        pointerEvents: open ? "auto" : "none",
      }}
    >
      <div style={ds.drawerHead}>
        <span style={ds.drawerTitle}>ℹ ファイル情報</span>
        <div style={{ flex: 1 }} />
        <button
          style={{ ...ds.copyBtn, padding: "3px 10px", fontSize: 11 }}
          onClick={handleCopyAll}
        >
          {allCopied ? "✓ コピー済" : "全コピー"}
        </button>
        <button style={ds.closeBtn} onClick={onClose}>
          ✕
        </button>
      </div>
      <div style={ds.drawerBody}>
        <div style={ds.section}>ファイル</div>
        <div style={ds.row}>
          <span style={ds.label}>ファイル名</span>
          <span style={{ ...ds.value, wordBreak: "break-all" }}>{fileName}</span>
          <button style={ds.copyBtn} onClick={() => navigator.clipboard.writeText(fileName)}>
            ⎘
          </button>
        </div>
        <div style={ds.row}>
          <span style={ds.label}>パス</span>
          <span style={{ ...ds.value, wordBreak: "break-all", fontSize: 10 }}>{filePath}</span>
          <button style={ds.copyBtn} onClick={() => navigator.clipboard.writeText(filePath)}>
            ⎘
          </button>
        </div>
        {info?.file_size != null && (
          <div style={ds.row}>
            <span style={ds.label}>サイズ</span>
            <span style={ds.value}>{formatBytes(info.file_size)}</span>
          </div>
        )}
        {info?.page_count != null && (
          <div style={ds.row}>
            <span style={ds.label}>ページ数</span>
            <span style={ds.value}>{info.page_count} ページ</span>
          </div>
        )}
        {pageSize && (
          <div style={ds.row}>
            <span style={ds.label}>ページサイズ</span>
            <span style={ds.value}>{pageSize}</span>
          </div>
        )}
        <div style={{ ...ds.section, marginTop: 14 }}>メタデータ</div>
        {hasAnyMeta ? (
          <>
            <MetaRow label="タイトル" value={meta.title} />
            <MetaRow label="作成者" value={meta.author} />
            <MetaRow label="件名" value={meta.subject} />
            <MetaRow label="キーワード" value={meta.keywords} />
            <MetaRow label="アプリ" value={meta.creator} />
            <MetaRow label="変換" value={meta.producer} />
            <MetaRow
              label="作成日"
              value={meta.creation_date ? formatDate(meta.creation_date) : undefined}
            />
            <MetaRow label="更新日" value={meta.mod_date ? formatDate(meta.mod_date) : undefined} />
          </>
        ) : (
          <div
            style={{
              color: "var(--c-textDim)",
              fontSize: 11,
              padding: "10px 0",
              textAlign: "center",
            }}
          >
            メタデータなし
          </div>
        )}
      </div>
    </div>
  );
}

// ── 検索バー ──────────────────────────────────────────────────────────────────

interface SearchBarProps {
  onSearch: (q: string) => void;
  hitCount: number;
  onClose: () => void;
}

function SearchBar({ onSearch, hitCount, onClose }: SearchBarProps) {
  const [q, setQ] = useState("");
  return (
    <div style={ss.bar}>
      <input
        style={ss.input}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          onSearch(e.target.value);
        }}
        placeholder="検索…"
        autoFocus
      />
      {q && <span style={ss.count}>{hitCount} 件</span>}
      <button
        style={ss.close}
        onClick={() => {
          setQ("");
          onSearch("");
          onClose();
        }}
      >
        ✕
      </button>
    </div>
  );
}

// ── メインコンポーネント ──────────────────────────────────────────────────────

export function ViewerPage({ filePath, pdfInfo, fileList = [] }: Props) {
  const isMulti = fileList.length > 1;
  const [activeIdx, setActiveIdx] = useState(0);
  const [activeInfo, setActiveInfo] = useState<PdfInfo | null>(pdfInfo ?? null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  const activePath = isMulti
    ? fileList[activeIdx]?.path || ""
    : filePath || (fileList.length > 0 ? fileList[0].path : "");

  const [viewPage, setViewPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [zoom, setZoom] = useState(1.0);

  // メインビュー画像
  const [mainImg, setMainImg] = useState<string>("");
  const [mainLoading, setMainLoading] = useState(false);

  // テキストレイヤー
  const [textBlocks, setTextBlocks] = useState<STextBlock[]>([]);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });

  // 検索
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);

  // リンク
  const [pageLinks, setPageLinks] = useState<PageLink[]>([]);

  // サムネイル
  const [thumbs, setThumbs] = useState<(string | undefined)[]>([]);
  const thumbCache = useRef<Map<string, (string | undefined)[]>>(new Map());
  const [fileCoverThumbs, setFileCoverThumbs] = useState<Map<string, string>>(new Map());

  // 1. ページ情報
  useEffect(() => {
    if (!isMulti) {
      if (pdfInfo) {
        setActiveInfo(pdfInfo);
        setTotal(pdfInfo.page_count);
      } else if (activePath)
        getPdfInfo(activePath).then((info) => {
          setActiveInfo(info);
          setTotal(info.page_count);
        });
      return;
    }
    const path = fileList[activeIdx]?.path;
    if (path)
      getPdfInfo(path).then((info) => {
        setActiveInfo(info);
        setTotal(info.page_count);
      });
  }, [activeIdx, isMulti, filePath, pdfInfo, fileList]);

  useEffect(() => {
    if (!pdfInfo && filePath) getPdfInfo(filePath).then((info) => setActiveInfo(info));
    else setActiveInfo(pdfInfo || null);
  }, [filePath, pdfInfo]);

  // 2. メインビューレンダリング（MuPDF JPEG）
  const renderMain = useCallback(async () => {
    if (!activePath) return;
    setMainLoading(true);
    setTextBlocks([]);
    setPageLinks([]);
    setSearchHits([]);
    try {
      const dpi = Math.round(VIEW_DPI * zoom);
      const b64 = await renderPage(activePath, viewPage, dpi);
      setMainImg(b64);

      // 画像の実際のサイズを取得
      const img = new Image();
      img.onload = () => setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
      img.src = `data:image/jpeg;base64,${b64}`;

      // stext テキストレイヤーを並行取得
      const scale = dpi / 72.0;
      getPageText(activePath, viewPage, scale)
        .then((res) => {
          if (res.ok) setTextBlocks(res.blocks);
        })
        .catch(() => {});

      // リンクも取得
      getPageLinks(activePath, viewPage, scale)
        .then((res) => {
          if (res.ok) setPageLinks(res.links);
        })
        .catch(() => {});
    } catch (e) {
      console.error("[viewer] render failed:", e);
    } finally {
      setMainLoading(false);
    }
  }, [activePath, viewPage, zoom]);

  useEffect(() => {
    renderMain();
  }, [renderMain]);

  // 3. 検索
  const handleSearch = useCallback(
    async (needle: string) => {
      if (!activePath || !needle.trim()) {
        setSearchHits([]);
        return;
      }
      const scale = Math.round(VIEW_DPI * zoom) / 72.0;
      try {
        const res = await searchPage(activePath, viewPage, needle.trim(), scale);
        if (res.ok) setSearchHits(res.hits);
      } catch {
        setSearchHits([]);
      }
    },
    [activePath, viewPage, zoom],
  );

  // 4. サムネイル
  useEffect(() => {
    if (!activePath || !activeInfo) {
      setThumbs([]);
      return;
    }
    const cached = thumbCache.current.get(activePath);
    if (cached) setThumbs([...cached]);
    else {
      const arr = new Array(activeInfo.page_count).fill(undefined);
      thumbCache.current.set(activePath, arr);
      setThumbs([]);
    }
    let cancelled = false;
    (async () => {
      const cur = thumbCache.current.get(activePath)!;
      for (let i = 0; i < activeInfo.page_count; i++) {
        if (cur[i]) continue;
        try {
          const b64 = await renderPage(activePath, i, THUMB_DPI);
          if (cancelled) return;
          cur[i] = b64;
          setThumbs([...cur]);
        } catch {}
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePath, activeInfo]);

  // 5. ファイルカバー
  useEffect(() => {
    if (!fileList.length) return;
    (async () => {
      const m = new Map(fileCoverThumbs);
      let changed = false;
      for (const f of fileList) {
        if (!m.has(f.path)) {
          try {
            m.set(f.path, await renderPage(f.path, 0, THUMB_DPI));
            changed = true;
          } catch {}
        }
      }
      if (changed) setFileCoverThumbs(new Map(m));
    })();
  }, [fileList]);

  if (!activeInfo && !mainLoading) return <Spinner label="読み込み中…" />;

  const fname = activePath.split(/[/\\]/).pop() ?? "";
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
        {/* 検索ボタン */}
        <button
          style={{ ...s.zBtn, ...(showSearch ? s.infoBtnOn : {}), marginRight: 4 }}
          onClick={() => setShowSearch((v) => !v)}
          title="テキスト検索 (Ctrl+F)"
        >
          🔍
        </button>
        {/* 情報ボタン */}
        <button
          style={{ ...s.zBtn, ...(infoOpen ? s.infoBtnOn : {}), marginRight: 8 }}
          onClick={() => setInfoOpen((v) => !v)}
          title="ファイル情報"
        >
          ℹ
        </button>
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

      {/* 検索バー */}
      {showSearch && (
        <SearchBar
          onSearch={handleSearch}
          hitCount={searchHits.length}
          onClose={() => {
            setShowSearch(false);
            setSearchHits([]);
          }}
        />
      )}

      <div style={s.body}>
        {/* 左ペイン: 複数ファイル */}
        {isMulti && (
          <div style={s.filePane}>
            <div style={s.paneHead}>ファイル ({fileList.length})</div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {fileList.map((f, i) => {
                const cover = fileCoverThumbs.get(f.path);
                return (
                  <button
                    key={f.id}
                    style={{ ...s.filePaneItem, ...(i === activeIdx ? s.filePaneItemOn : {}) }}
                    onClick={() => {
                      setActiveIdx(i);
                      setViewPage(0);
                      setInfoOpen(false);
                    }}
                  >
                    <div style={s.filePaneThumbBox}>
                      {cover ? (
                        <img
                          src={`data:image/jpeg;base64,${cover}`}
                          style={s.filePaneThumbImg}
                          alt=""
                        />
                      ) : (
                        <span style={s.filePaneIcon}>📄</span>
                      )}
                    </div>
                    <div style={s.filePaneInfo}>
                      <div style={s.filePaneName} title={f.filename}>
                        {f.filename || "無題"}
                      </div>
                      <div style={s.filePaneMeta}>{f.pageCount}p</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 中ペイン: サムネイル */}
        <div style={s.thumbPane}>
          <div style={s.paneHead}>
            {viewPage + 1} / {total}
          </div>
          <div>
            {Array.from({ length: total }, (_, i) => {
              const th = Math.round(THUMB_W / pageAspect(activeInfo, i));
              return (
                <button
                  key={i}
                  style={{ ...s.thumbItem, ...(i === viewPage ? s.thumbItemOn : {}) }}
                  onClick={() => setViewPage(i)}
                >
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
                        style={{ maxWidth: THUMB_W, maxHeight: th, objectFit: "contain" }}
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
        <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>
          <div style={s.mainView}>
            <div style={s.viewScroll}>
              <div style={s.viewInner}>
                {mainLoading && (
                  <div style={s.viewCenter}>
                    <div style={s.viewSpinner} />
                  </div>
                )}
                {mainImg && (
                  <div
                    style={{
                      position: "relative",
                      display: "inline-block",
                      boxShadow: "0 4px 32px rgba(0,0,0,0.7)",
                    }}
                  >
                    <img
                      src={`data:image/jpeg;base64,${mainImg}`}
                      alt={`ページ ${viewPage + 1}`}
                      style={{ display: "block", maxWidth: "100%" }}
                    />
                    {/* テキスト選択レイヤー */}
                    {textBlocks.length > 0 && imgSize.w > 0 && (
                      <TextLayer
                        blocks={textBlocks}
                        scale={Math.round(VIEW_DPI * zoom) / 72.0}
                        width={imgSize.w}
                        height={imgSize.h}
                        searchHits={searchHits}
                      />
                    )}
                    {/* リンクレイヤー */}
                    {pageLinks.length > 0 && (
                      <div
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: imgSize.w,
                          height: imgSize.h,
                        }}
                      >
                        <LinkLayer links={pageLinks} onNavigate={setViewPage} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ページナビゲーション */}
            <div style={s.pageNav}>
              <button
                style={s.navBtn}
                onClick={() => setViewPage((p) => Math.max(0, p - 1))}
                disabled={viewPage === 0}
              >
                ◀
              </button>
              <span style={s.pageInfo}>
                {viewPage + 1} / {total}
              </span>
              <button
                style={s.navBtn}
                onClick={() => setViewPage((p) => Math.min(total - 1, p + 1))}
                disabled={viewPage >= total - 1}
              >
                ▶
              </button>
            </div>
          </div>

          {/* 情報ドロワー */}
          <InfoDrawer
            open={infoOpen}
            onClose={() => setInfoOpen(false)}
            info={activeInfo}
            filePath={activePath}
            fileName={fname}
          />
        </div>
      </div>
    </div>
  );
}

// ── 検索バースタイル ──────────────────────────────────────────────────────────
const ss: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 12px",
    background: "var(--c-bgSub)",
    borderBottom: "1px solid var(--c-border)",
  },
  input: {
    flex: 1,
    maxWidth: 320,
    padding: "4px 8px",
    borderRadius: 4,
    border: "1px solid var(--c-border)",
    background: "var(--c-bg)",
    color: "var(--c-text)",
    fontSize: 13,
  },
  count: { fontSize: 11, color: "var(--c-textDim)", minWidth: 40 },
  close: {
    background: "transparent",
    border: "none",
    color: "var(--c-textDim)",
    cursor: "pointer",
    fontSize: 14,
  },
};

// ── ドロワースタイル ──────────────────────────────────────────────────────────
const ds: Record<string, React.CSSProperties> = {
  drawer: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: 300,
    background: "var(--c-bgSub, #1a1f1b)",
    borderLeft: "1px solid var(--c-border)",
    display: "flex",
    flexDirection: "column",
    zIndex: 20,
    transition: "transform 0.22s cubic-bezier(0.4, 0, 0.2, 1)",
    boxShadow: "-4px 0 24px rgba(0,0,0,0.4)",
  },
  drawerHead: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px",
    borderBottom: "1px solid var(--c-border)",
    position: "sticky",
    top: 0,
    background: "var(--c-bgSub, #1a1f1b)",
    zIndex: 1,
  },
  drawerTitle: { fontWeight: 700, fontSize: 13, color: "var(--c-text)" },
  drawerBody: { flex: 1, padding: "10px 12px", overflowY: "auto" },
  section: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.08em",
    color: "var(--c-textDim)",
    marginBottom: 6,
    paddingBottom: 4,
    borderBottom: "1px solid var(--c-border)",
  },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: 6,
    padding: "5px 0",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
  },
  label: { flexShrink: 0, width: 72, fontSize: 10, color: "var(--c-textDim)", paddingTop: 1 },
  value: {
    flex: 1,
    fontSize: 11,
    color: "var(--c-text)",
    wordBreak: "break-word",
    lineHeight: 1.5,
    minWidth: 0,
  },
  copyBtn: {
    flexShrink: 0,
    background: "transparent",
    border: "1px solid var(--c-border)",
    borderRadius: 4,
    color: "var(--c-textDim)",
    fontSize: 11,
    cursor: "pointer",
    padding: "1px 5px",
    lineHeight: 1.4,
    transition: "background 0.15s",
  },
  copyBtnDone: {
    background: "var(--c-accent, #3a7a4a)",
    color: "#fff",
    borderColor: "transparent",
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: "var(--c-textDim)",
    fontSize: 14,
    cursor: "pointer",
    padding: "2px 6px",
  },
};

// ── メインスタイル ────────────────────────────────────────────────────────────
const s: Record<string, React.CSSProperties> = {
  root: { height: "100%", display: "flex", flexDirection: "column", background: "var(--c-bg)" },
  body: { flex: 1, display: "flex", overflow: "hidden" },
  thumbPane: {
    width: 140,
    borderRight: "1px solid var(--c-border)",
    overflowY: "auto",
    padding: "10px",
  },
  thumbItem: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    marginBottom: 15,
    background: "none",
    border: "2px solid transparent",
    cursor: "pointer",
  },
  thumbItemOn: { borderColor: "var(--c-accent)" },
  thumbN: { fontSize: 10, marginTop: 4, color: "#ccc" },
  thumbNOn: { color: "var(--c-accent)" },
  filePane: {
    width: 220,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    borderRight: "1px solid var(--c-border)",
    background: "var(--c-bgSide)",
  },
  filePaneItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 12px",
    width: "100%",
    background: "transparent",
    border: "none",
    borderBottom: "1px solid rgba(255,255,255,0.05)",
    cursor: "pointer",
    overflow: "hidden",
  },
  filePaneItemOn: { background: "rgba(255,255,255,0.1)", borderLeft: "3px solid var(--c-accent)" },
  filePaneThumbBox: {
    width: 36,
    height: 48,
    flexShrink: 0,
    background: "#000",
    borderRadius: 2,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    boxShadow: "0 2px 4px rgba(0,0,0,0.3)",
  },
  filePaneThumbImg: { width: "100%", height: "100%", objectFit: "cover" },
  filePaneIcon: { fontSize: 18, opacity: 0.5 },
  filePaneInfo: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
    textAlign: "left",
  },
  filePaneName: {
    fontSize: 12,
    color: "var(--c-text)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontWeight: 500,
  },
  filePaneMeta: { fontSize: 10, color: "var(--c-textDim)" },
  mainView: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "#070e09",
  },
  viewScroll: { flex: 1, overflow: "auto" },
  viewInner: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    minWidth: "100%",
    minHeight: "100%",
    padding: 24,
  },
  viewCenter: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: 300 },
  viewSpinner: {
    width: 32,
    height: 32,
    borderRadius: "50%",
    border: "3px solid rgba(255,255,255,0.15)",
    borderTopColor: "var(--c-accent)",
    animation: "spin 0.8s linear infinite",
  },
  pageNav: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: "8px",
    borderTop: "1px solid var(--c-border)",
    background: "var(--c-bgSub)",
  },
  navBtn: {
    width: 32,
    height: 32,
    cursor: "pointer",
    borderRadius: 4,
    border: "1px solid var(--c-border)",
    background: "var(--c-bgSub)",
    color: "var(--c-text)",
    fontSize: 14,
  },
  pageInfo: { fontSize: 12, color: "var(--c-text)", minWidth: 80, textAlign: "center" },
  title: { fontWeight: 700, fontSize: 14, fontFamily: F },
  fileSub: {
    fontSize: 11,
    color: "var(--c-textDim)",
    maxWidth: 200,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pageBadge: {
    fontSize: 11,
    background: "var(--c-border)",
    padding: "2px 8px",
    borderRadius: 10,
    marginLeft: 8,
  },
  paneHead: {
    fontSize: 11,
    fontWeight: 700,
    padding: "8px 12px",
    color: "var(--c-textDim)",
    borderBottom: "1px solid var(--c-border)",
  },
  zoomRow: { display: "flex", alignItems: "center", gap: 8 },
  zBtn: {
    width: 28,
    height: 28,
    cursor: "pointer",
    borderRadius: 4,
    border: "1px solid var(--c-border)",
    background: "var(--c-bgSub)",
    color: "var(--c-text)",
    fontSize: 14,
  },
  infoBtnOn: { background: "var(--c-accent, #3a7a4a)", color: "#fff", borderColor: "transparent" },
  zBtnSm: {
    height: 24,
    padding: "0 8px",
    cursor: "pointer",
    fontSize: 11,
    borderRadius: 4,
    border: "1px solid var(--c-border)",
    background: "var(--c-bgSub)",
    color: "var(--c-text)",
  },
  zVal: { fontSize: 12, minWidth: 40, textAlign: "center" },
};
