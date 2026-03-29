// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------
// src/pages/ViewerPage.tsx — MuPDF ビューア（軽量版）
//
// 設計：
//   - レンダリング DPI=96 固定（軽量）、ズームは CSS transform のみ
//   - テキストは行単位の透明 div（DOM 軽量、文字ごとの span は廃止）
//   - 画像表示後に stext を遅延取得
//   - 前後1ページをプリフェッチ

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
  type PageLink,
} from "../lib/tauri";
import { Spinner, PageHeader } from "../components/common";
import { type FileEntry, usePdfStore } from "../store/usePdfStore";
import { F } from "../lib/theme";
import { useA11y } from "../hooks/useA11y";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

// ── 定数 ─────────────────────────────────────────────────────────────────────
const THUMB_DPI = 52;
const RENDER_DPI = 96; // 固定。ズームは CSS transform で対応

// ── ユーティリティ ────────────────────────────────────────────────────────────
function pageAspect(info: PdfInfo | null, i: number): number {
  if (!info?.pages[i]) return 1 / 1.414;
  const p = info.pages[i];
  return (p as any).rotate === 90 || (p as any).rotate === 270 ? p.h / p.w : p.w / p.h;
}
function ptToMm(pt: number) {
  return ((pt * 25.4) / 72).toFixed(1);
}
function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(2)} MB`;
}
function formatDate(d: string) {
  const s = d.startsWith("D:") ? d.slice(2) : d;
  if (s.length >= 8) {
    const [y, m, dd] = [s.slice(0, 4), s.slice(4, 6), s.slice(6, 8)];
    if (s.length >= 14) return `${y}/${m}/${dd} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
    return `${y}/${m}/${dd}`;
  }
  return d;
}

// ── TextLayer ─────────────────────────────────────────────────────────────────
// 行単位の透明 div を配置するだけ。
// ブラウザのテキスト選択は div の中の textContent で行われる。
// 文字ごとの span は廃止（DOM 重い・フォント依存のズレが大きい）
interface TextLayerProps {
  blocks: STextBlock[];
  containerW: number;
  containerH: number;
  searchHits: GlobalHit[];
  currentHit?: GlobalHit | null;
}

function TextLayer({ blocks, containerW, containerH, searchHits, currentHit }: TextLayerProps) {
  // canvas.measureText で実際のブラウザ描画幅を計測するキャンバス（再利用）
  const measureCanvas = useMemo(
    () =>
      typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null,
    [],
  );

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: containerW,
        height: containerH,
        overflow: "visible",
      }}
    >
      {/*
       * テキスト選択オーバーレイ
       *
       * 設計:
       *   - 行ごとに position:absolute の div を配置（ダブルクリック・行選択が機能する）
       *   - 行テキスト全体を1つの span に入れる（フロー要素なのでブラウザ選択が自然）
       *   - canvas.measureText で実際の描画幅を計測し scaleX で pdf bbox に合わせる
       *   - 各行は行の左端 (line.bbox.x0) から始まり、scaleX で右端 (x1) に合わせる
       *
       * ダブルクリック動作:
       *   ブラウザは span 内の連続テキストに対して単語・行選択を行うので
       *   position:static / inline のテキストなら機能する。
       */}
      {blocks
        .filter((b) => b.type === "text")
        .map((block, bi) => (
          // ブロック（段落・見出しなどの塊）ごとに div でグループ化
          // → ブロック内でのダブルクリック単語選択・トリプルクリック行選択が機能する
          <div
            key={`block-${bi}`}
            style={{
              position: "absolute",
              left: block.bbox.x0,
              top: block.bbox.y0,
              width: Math.max(1, block.bbox.x1 - block.bbox.x0),
              height: Math.max(1, block.bbox.y1 - block.bbox.y0),
              overflow: "visible",
              userSelect: "text",
              pointerEvents: "auto",
            }}
          >
            {block.lines.map((line, li) => {
              const text = line.chars.map((c) => c.c).join("");
              if (!text.trim()) return null;

              const { x0, y0, x1, y1 } = line.bbox;
              const bboxW = Math.max(1, x1 - x0);
              const bboxH = Math.max(1, y1 - y0);
              const fs = bboxH * 0.85;

              // canvas.measureText で実際の描画幅を計測
              let renderedW = fs * 0.55 * text.length;
              if (measureCanvas) {
                measureCanvas.font = `${fs}px sans-serif`;
                const m = measureCanvas.measureText(text).width;
                if (m > 1) renderedW = m;
              }
              const scaleX = bboxW / renderedW;

              // ブロック座標からの相対位置
              const relX = x0 - block.bbox.x0;
              const relY = y0 - block.bbox.y0;

              return (
                <div
                  key={`line-${li}`}
                  style={{
                    position: "absolute",
                    left: relX,
                    top: relY,
                    width: renderedW,
                    height: bboxH,
                    lineHeight: `${bboxH}px`,
                    transformOrigin: "top left",
                    transform: `scaleX(${scaleX})`,
                    cursor: "text",
                    userSelect: "text",
                    whiteSpace: "pre",
                    overflow: "visible",
                    pointerEvents: "auto",
                  }}
                >
                  <span
                    style={{
                      fontSize: fs,
                      color: "transparent",
                      userSelect: "text",
                    }}
                  >
                    {text}
                  </span>
                </div>
              );
            })}
          </div>
        ))}

      {/* 検索ハイライト */}
      {searchHits.map((hit, i) => {
        const [ulx, uly, urx, , , lly] = hit.quad;
        const isCurrent =
          currentHit &&
          hit.page === currentHit.page &&
          hit.quad[0] === currentHit.quad[0] &&
          hit.quad[1] === currentHit.quad[1];
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: ulx,
              top: uly,
              width: urx - ulx,
              height: lly - uly,
              background: isCurrent ? "rgba(255,160,0,0.65)" : "rgba(255,220,0,0.35)",
              border: isCurrent ? "2px solid rgba(255,120,0,0.8)" : "none",
              borderRadius: 2,
              pointerEvents: "none",
            }}
          />
        );
      })}
    </div>
  );
}

// ── LinkLayer ─────────────────────────────────────────────────────────────────
function LinkLayer({ links, onNavigate }: { links: PageLink[]; onNavigate: (p: number) => void }) {
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
        onClick={() =>
          navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
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
      info?.file_size && `サイズ: ${formatBytes(info.file_size)}`,
      info?.page_count && `ページ数: ${info.page_count}`,
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

// ── SearchBar ────────────────────────────────────────────────────────────────
// 全ページ検索 + ヒット間ナビゲーション対応

interface GlobalHit {
  page: number;
  quad: [number, number, number, number, number, number, number, number];
}

interface SearchBarProps {
  path: string;
  totalPages: number;
  currentPage: number;
  onNavigate: (page: number, hit: GlobalHit) => void;
  onAllHits: (hits: GlobalHit[]) => void;
  onClose: () => void;
}

function SearchBar({
  path,
  totalPages,
  currentPage,
  onNavigate,
  onAllHits,
  onClose,
}: SearchBarProps) {
  const [q, setQ] = useState("");
  const [allHits, setAllHits] = useState<GlobalHit[]>([]);
  const [current, setCurrent] = useState(0);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<AbortController | null>(null);

  const doSearch = useCallback(
    async (needle: string) => {
      // 前の検索をキャンセル
      searchRef.current?.abort();
      if (!needle.trim()) {
        setAllHits([]);
        setCurrent(0);
        onAllHits([]);
        return;
      }

      setSearching(true);
      const controller = new AbortController();
      searchRef.current = controller;
      const hits: GlobalHit[] = [];
      const scale = RENDER_DPI / 72.0;

      try {
        // 全ページを検索（現在ページを優先して先に検索）
        const pages = [...Array.from({ length: totalPages }, (_, i) => i)].sort((a, b) => {
          // 現在ページを先頭に
          if (a === currentPage) return -1;
          if (b === currentPage) return 1;
          return a - b;
        });

        for (const p of pages) {
          if (controller.signal.aborted) break;
          try {
            const res = await searchPage(path, p, needle.trim(), scale);
            if (controller.signal.aborted) break;
            if (res.ok && res.hits.length > 0) {
              const pageHits = res.hits.map((h) => ({ page: p, quad: h.quad }));
              hits.push(...pageHits);
              hits.sort((a, b) => a.page - b.page);
              setAllHits([...hits]);
              // 親に全ヒットを通知（ページフィルタは親側で行う）
              onAllHits([...hits]);
            }
          } catch {
            /* ページエラーは無視 */
          }
        }
      } finally {
        setSearching(false);
        if (hits.length > 0) {
          const firstIdx = hits.findIndex((h) => h.page >= currentPage);
          const idx = firstIdx >= 0 ? firstIdx : 0;
          setCurrent(idx);
          onNavigate(hits[idx].page, hits[idx]);
          onAllHits([...hits]);
        }
      }
    },
    [path, totalPages, onNavigate, onAllHits],
  );

  const go = (delta: number) => {
    if (allHits.length === 0) return;
    const next = (current + delta + allHits.length) % allHits.length;
    setCurrent(next);
    const hit = allHits[next];
    onNavigate(hit.page, hit);
    onAllHits([...allHits]); // ページが変わっても全ヒットを保持
  };

  const handleClose = () => {
    setQ("");
    setAllHits([]);
    setCurrent(0);
    onAllHits([]);
    onClose();
  };

  return (
    <div style={ss.bar}>
      <input
        style={ss.input}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          doSearch(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") go(e.shiftKey ? -1 : 1);
          if (e.key === "Escape") handleClose();
        }}
        placeholder="全ページ検索… (Enter で次へ)"
        autoFocus
      />
      {searching && <span style={{ fontSize: 11, color: "var(--c-textDim)" }}>検索中…</span>}
      {!searching && q && (
        <span style={ss.count}>
          {allHits.length === 0 ? "0件" : `${current + 1} / ${allHits.length} 件`}
        </span>
      )}
      {allHits.length > 0 && (
        <>
          <button style={ss.navBtn} onClick={() => go(-1)} title="前のヒット (Shift+Enter)">
            ◀
          </button>
          <button style={ss.navBtn} onClick={() => go(1)} title="次のヒット (Enter)">
            ▶
          </button>
        </>
      )}
      <button style={ss.close} onClick={handleClose}>
        ✕
      </button>
    </div>
  );
}

// ── メインコンポーネント ──────────────────────────────────────────────────────
interface Props {
  filePath?: string;
  pdfInfo?: PdfInfo;
  fileList?: FileEntry[];
}

export function ViewerPage({ filePath, pdfInfo, fileList = [] }: Props) {
  const isMulti = fileList.length > 1;
  const [activeIdx, setActiveIdx] = useState(0);
  const { announceScreen, announceKey, announce } = useA11y();

  // 画面表示時の読み上げ
  useEffect(() => {
    announceScreen("screen.viewer");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ショートカット（ビューワー固有）
  useKeyboardShortcuts({
    ArrowLeft: () => setViewPage((p) => Math.max(0, p - 1)),
    ArrowRight: () => setViewPage((p) => Math.min(total - 1, p + 1)),
    "Ctrl+F": () => setShowSearch((v) => !v),
    F1: () => announceKey("shortcut.viewer"),
  });
  const [activeInfo, setActiveInfo] = useState<PdfInfo | null>(pdfInfo ?? null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [viewPage, setViewPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [zoom, setZoom] = useState(1.0);

  // ホーム画面のレイアウト設定（リフロー可能文書用）
  const { convertLayoutW, convertLayoutH, convertLayoutEm } = usePdfStore();

  // メイン画像キャッシュ（path → page → b64）
  const imgCache = useRef<Map<string, Map<number, string>>>(new Map());

  // 表示中ページの状態
  const [mainImg, setMainImg] = useState<string>("");
  const [mainLoading, setMainLoading] = useState(false);
  const [imgNaturalW, setImgNaturalW] = useState(0);
  const [imgNaturalH, setImgNaturalH] = useState(0);

  // stext（遅延取得）
  const [textBlocks, setTextBlocks] = useState<STextBlock[]>([]);
  const [pageLinks, setPageLinks] = useState<PageLink[]>([]);
  // 検索: 全ヒット一覧（SearchBar が管理）+ カレントヒット
  const [allSearchHits, setAllSearchHits] = useState<GlobalHit[]>([]);
  const [currentHit, setCurrentHit] = useState<GlobalHit | null>(null);
  // viewPage から派生: 現在ページのヒットのみ（別ページのヒット混入を防ぐ）
  const pageSearchHits = allSearchHits.filter((h) => h.page === viewPage);

  // サムネイル
  const thumbCache = useRef<Map<string, (string | undefined)[]>>(new Map());
  const [thumbs, setThumbs] = useState<(string | undefined)[]>([]);
  const [fileCoverThumbs, setFileCoverThumbs] = useState<Map<string, string>>(new Map());

  // スクロールコンテナの ref（ヒット位置へのスクロール用）
  const scrollRef = useRef<HTMLDivElement>(null);
  // ページジャンプ後にスクロールすべきヒット座標
  const pendingScrollHit = useRef<GlobalHit | null>(null);

  // ヒット位置へスクロールする共通処理
  const scrollToHit = useCallback(
    (hit: GlobalHit) => {
      if (!scrollRef.current) return;
      const [ulx, uly, urx, , , lly] = hit.quad;
      const hitCenterX = ((ulx + urx) / 2) * zoom;
      const hitCenterY = ((uly + lly) / 2) * zoom;
      const container = scrollRef.current;
      container.scrollTo({
        left: hitCenterX - container.clientWidth / 2 + 24,
        top: hitCenterY - container.clientHeight / 2 + 24,
        behavior: "smooth",
      });
    },
    [zoom],
  );

  const activePath = isMulti
    ? fileList[activeIdx]?.path || ""
    : filePath || fileList[0]?.path || "";

  // currentHit が変わったとき（同ページ内移動）スクロール
  useEffect(() => {
    if (!currentHit || !scrollRef.current) return;
    // pendingScrollHit がある場合は onLoad 側で処理（別ページジャンプ直後）
    if (pendingScrollHit.current) return;
    scrollToHit(currentHit);
  }, [currentHit, zoom]);

  // ページジャンプ後、キャッシュ済み画像では onLoad が発火しない場合のフォールバック
  useEffect(() => {
    if (!pendingScrollHit.current) return;
    const hit = pendingScrollHit.current;
    if (hit.page !== viewPage) return;
    // 少し待ってから（レンダリング後）スクロール
    const timer = setTimeout(() => {
      if (pendingScrollHit.current === hit) {
        pendingScrollHit.current = null;
        scrollToHit(hit);
      }
    }, 80);
    return () => clearTimeout(timer);
  }, [viewPage]);

  // ── 1. ページ情報 ──────────────────────────────────────────────────────────
  // パスまたはレイアウトが変わったときのみ getPdfInfo を呼ぶ
  const lastInfoKey = useRef<string>("");

  useEffect(() => {
    const path = isMulti ? fileList[activeIdx]?.path || "" : activePath;

    if (!path) {
      if (pdfInfo) {
        setActiveInfo(pdfInfo);
        setTotal(pdfInfo.page_count);
      }
      return;
    }

    // パスとレイアウトの組み合わせが変わったときだけ再取得
    const infoKey = `${path}::${convertLayoutW}x${convertLayoutH}em${convertLayoutEm}`;
    if (infoKey === lastInfoKey.current) return;
    lastInfoKey.current = infoKey;

    // PDF かつ pdfInfo が既に渡されていれば再取得不要
    const isPdf = path.toLowerCase().endsWith(".pdf");
    if (isPdf && pdfInfo && !isMulti) {
      setActiveInfo(pdfInfo);
      setTotal(pdfInfo.page_count);
      return;
    }

    getPdfInfo(path, {
      layoutW: convertLayoutW,
      layoutH: convertLayoutH,
      layoutEm: convertLayoutEm,
    })
      .then((i) => {
        setActiveInfo(i);
        setTotal(i.page_count);
      })
      .catch(() => {
        if (pdfInfo) {
          setActiveInfo(pdfInfo);
          setTotal(pdfInfo.page_count);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, isMulti, activePath, convertLayoutW, convertLayoutH, convertLayoutEm]);

  // レイアウト変更時にレンダリングキャッシュをクリア（非 PDF 用）
  const lastLayoutKey = useRef(`${convertLayoutW}x${convertLayoutH}em${convertLayoutEm}`);
  useEffect(() => {
    const key = `${convertLayoutW}x${convertLayoutH}em${convertLayoutEm}`;
    if (key === lastLayoutKey.current) return;
    lastLayoutKey.current = key;
    // 非 PDF のキャッシュのみクリア（PDF はレイアウト不変）
    for (const path of [...imgCache.current.keys()]) {
      if (!path.toLowerCase().endsWith(".pdf")) {
        imgCache.current.delete(path);
        thumbCache.current.delete(path);
      }
    }
    // infoKey もリセットして再取得を促す
    lastInfoKey.current = "";
  }, [convertLayoutW, convertLayoutH, convertLayoutEm]);

  // 非 PDF ファイルの変換済みパスキャッシュ（変換は1回だけ）
  // ── 2. メイン画像レンダリング（キャッシュ付き）────────────────────────────
  const getOrRender = useCallback(
    async (path: string, page: number): Promise<string> => {
      if (!imgCache.current.has(path)) imgCache.current.set(path, new Map());
      const pageMap = imgCache.current.get(path)!;
      if (pageMap.has(page)) return pageMap.get(page)!;
      const b64 = await renderPage(path, page, RENDER_DPI, {
        layoutW: convertLayoutW,
        layoutH: convertLayoutH,
        layoutEm: convertLayoutEm,
      });
      pageMap.set(page, b64);
      return b64;
    },
    [convertLayoutW, convertLayoutH, convertLayoutEm],
  );

  // プリフェッチ（前後1ページ）
  const prefetch = useCallback(
    (path: string, page: number, max: number) => {
      [page - 1, page + 1]
        .filter((p) => p >= 0 && p < max)
        .forEach((p) => {
          getOrRender(path, p).catch(() => {});
        });
    },
    [getOrRender],
  );

  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;

    setTextBlocks([]);
    setPageLinks([]);
    // 検索ヒットはページが変わってもクリアしない（SearchBar が管理）

    // キャッシュがあれば即表示
    const cached = imgCache.current.get(activePath)?.get(viewPage);
    if (cached) {
      setMainImg(cached);
      setMainLoading(false);
    } else {
      setMainLoading(true);
    }

    (async () => {
      try {
        const b64 = await getOrRender(activePath, viewPage);
        if (cancelled) return;
        setMainImg(b64);
        setMainLoading(false);

        // 画像の実サイズを取得
        const img = new window.Image();
        img.onload = () => {
          if (!cancelled) {
            setImgNaturalW(img.naturalWidth);
            setImgNaturalH(img.naturalHeight);
          }
        };
        img.src = `data:image/jpeg;base64,${b64}`;

        // PDF のみ stext/links/prefetch を実行（非 PDF は変換のたびにプロセスが起動するため抑制）
        const isPdf = activePath.toLowerCase().endsWith(".pdf");
        if (isPdf) {
          // stext を遅延取得（非同期、失敗しても表示には影響なし）
          const scale = RENDER_DPI / 72.0;
          getPageText(activePath, viewPage, scale)
            .then((r) => {
              if (!cancelled && r.ok) setTextBlocks(r.blocks);
            })
            .catch(() => {});
          getPageLinks(activePath, viewPage, scale)
            .then((r) => {
              if (!cancelled && r.ok) setPageLinks(r.links);
            })
            .catch(() => {});

          // 前後プリフェッチ
          prefetch(activePath, viewPage, total);
        }
      } catch (e) {
        if (!cancelled) {
          console.error("[viewer] render failed:", e);
          setMainLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activePath, viewPage, getOrRender, prefetch, total]);

  // ── 4. サムネイル ──────────────────────────────────────────────────────────
  // ページ移動時に読み上げ
  useEffect(() => {
    if (total > 0) {
      announce(`${viewPage + 1}ページ`, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewPage]);

  useEffect(() => {
    if (!activePath || !activeInfo) {
      setThumbs([]);
      return;
    }
    const cached = thumbCache.current.get(activePath);
    if (cached) setThumbs([...cached]);
    else {
      const a = new Array(activeInfo.page_count).fill(undefined);
      thumbCache.current.set(activePath, a);
      setThumbs([]);
    }
    let cancelled = false;
    (async () => {
      const cur = thumbCache.current.get(activePath)!;
      for (let i = 0; i < activeInfo.page_count; i++) {
        if (cur[i]) continue;
        try {
          const b64 = await renderPage(activePath, i, THUMB_DPI, {
            layoutW: convertLayoutW,
            layoutH: convertLayoutH,
            layoutEm: convertLayoutEm,
          });
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

  // ── 5. ファイルカバー ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!fileList.length) return;
    (async () => {
      const m = new Map(fileCoverThumbs);
      let changed = false;
      for (const f of fileList) {
        if (!m.has(f.path)) {
          try {
            m.set(
              f.path,
              await renderPage(f.path, 0, THUMB_DPI, {
                layoutW: convertLayoutW,
                layoutH: convertLayoutH,
                layoutEm: convertLayoutEm,
              }),
            );
            changed = true;
          } catch {}
        }
      }
      if (changed) setFileCoverThumbs(new Map(m));
    })();
  }, [fileList]);

  // ── Ctrl+ホイール でズーム（non-passive で preventDefault を効かせる）──────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom((z) => +Math.min(4.0, Math.max(0.25, z + delta)).toFixed(2));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  if (!activeInfo && !mainLoading) return <Spinner label="読み込み中…" />;
  const fname = activePath.split(/[/\\]/).pop() ?? "";
  const THUMB_W = 104;

  // 表示サイズ（zoom は CSS transform で）
  const displayW = imgNaturalW;
  const displayH = imgNaturalH;

  return (
    <div style={s.root}>
      <PageHeader>
        <span style={s.title}>ビューワー</span>
        <span style={s.fileSub} title={activePath}>
          {fname}
        </span>
        <span style={s.pageBadge}>{total}ページ</span>
        <div style={{ flex: 1 }} />
        <button
          style={{ ...s.zBtn, ...(showSearch ? s.btnOn : {}), marginRight: 4 }}
          onClick={() => setShowSearch((v) => !v)}
          title="検索 (Ctrl+F)"
          aria-label="検索を開く Ctrl+F"
          aria-expanded={showSearch}
        >
          🔍
        </button>
        <button
          style={{ ...s.zBtn, ...(infoOpen ? s.btnOn : {}), marginRight: 8 }}
          onClick={() => setInfoOpen((v) => !v)}
          title="ファイル情報"
        >
          ℹ
        </button>
        <div style={s.zoomRow}>
          <button
            style={s.zBtn}
            onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2)))}
          >
            −
          </button>
          <span style={s.zVal}>{Math.round(zoom * 100)}%</span>
          <button
            style={s.zBtn}
            onClick={() => setZoom((z) => Math.min(4.0, +(z + 0.25).toFixed(2)))}
          >
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

      {showSearch && (
        <SearchBar
          path={activePath}
          totalPages={total}
          currentPage={viewPage}
          onNavigate={(page, hit) => {
            if (page !== viewPage) {
              // ページが変わる場合: onLoad 後にスクロールするため pending にセット
              pendingScrollHit.current = hit;
              setViewPage(page);
            }
            // currentHit を更新（同ページの場合は useEffect でスクロール）
            setCurrentHit(hit);
          }}
          onAllHits={(hits) => setAllSearchHits(hits)}
          onClose={() => {
            setShowSearch(false);
            setAllSearchHits([]);
            setCurrentHit(null);
            pendingScrollHit.current = null;
          }}
        />
      )}

      <div style={s.body}>
        {/* 左ペイン */}
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

        {/* サムネイルペイン */}
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

        {/* メインビュー + ドロワー */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>
          <div style={s.mainView}>
            <div
              style={s.viewScroll}
              ref={scrollRef}
              tabIndex={0}
              onKeyDown={(e) => {
                if (!e.ctrlKey) return;
                if (e.key === "+" || e.key === "=") {
                  e.preventDefault();
                  setZoom((z) => +Math.min(4.0, z + 0.25).toFixed(2));
                } else if (e.key === "-") {
                  e.preventDefault();
                  setZoom((z) => +Math.max(0.25, z - 0.25).toFixed(2));
                } else if (e.key === "0") {
                  e.preventDefault();
                  setZoom(1.0);
                }
              }}
            >
              <div style={s.viewInner}>
                {mainLoading && !mainImg && (
                  <div style={s.viewCenter}>
                    <div style={s.viewSpinner} />
                  </div>
                )}
                {mainImg && (
                  <div
                    style={{
                      position: "relative",
                      display: "inline-block",
                      boxShadow: `0 4px ${Math.round(32 * zoom)}px rgba(0,0,0,0.7)`,
                      transform: `scale(${zoom})`,
                      transformOrigin: "top left",
                      marginRight: displayW * (zoom - 1),
                      marginBottom: displayH * (zoom - 1),
                    }}
                  >
                    <img
                      src={`data:image/jpeg;base64,${mainImg}`}
                      alt={`ページ ${viewPage + 1}`}
                      style={{ display: "block" }}
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        setImgNaturalW(img.naturalWidth);
                        setImgNaturalH(img.naturalHeight);
                        // ページジャンプ後のヒット位置へスクロール
                        const hit = pendingScrollHit.current;
                        if (hit) {
                          pendingScrollHit.current = null;
                          scrollToHit(hit);
                        }
                      }}
                    />
                    {/* テキストオーバーレイ（stext 取得後に表示） */}
                    {textBlocks.length > 0 && displayW > 0 && (
                      <TextLayer
                        blocks={textBlocks}
                        containerW={displayW}
                        containerH={displayH}
                        searchHits={pageSearchHits}
                        currentHit={currentHit}
                      />
                    )}
                    {/* リンクレイヤー */}
                    {pageLinks.length > 0 && displayW > 0 && (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: displayW,
                          height: displayH,
                        }}
                      >
                        <LinkLayer links={pageLinks} onNavigate={setViewPage} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ページナビ */}
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

// ── スタイル ──────────────────────────────────────────────────────────────────
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
  count: { fontSize: 11, color: "var(--c-textDim)", minWidth: 60, textAlign: "center" as const },
  navBtn: {
    width: 26,
    height: 26,
    cursor: "pointer",
    borderRadius: 4,
    border: "1px solid var(--c-border)",
    background: "var(--c-bgSub)",
    color: "var(--c-text)",
    fontSize: 12,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  close: {
    background: "transparent",
    border: "none",
    color: "var(--c-textDim)",
    cursor: "pointer",
    fontSize: 14,
  },
};

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
    padding: "24px 24px 0",
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
  btnOn: { background: "var(--c-accent, #3a7a4a)", color: "#fff", borderColor: "transparent" },
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
