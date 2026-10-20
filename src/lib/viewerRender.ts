// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------
// src/lib/viewerRender.ts — ビューワの描画解像度の選択と、描画済み画像のキャッシュ
//
// 設計：
//   - 画像の「論理サイズ」(CSS px) は常に 1pt = 96/72 px × ズーム。描画 dpi を変えても
//     見た目の大きさは変わらない（画像の幅 × 96/描画dpi × ズーム で表示する）。
//   - 描画 dpi は「表示される実画素数」= 96 × ズーム × (devicePixelRatio × UI倍率) に
//     合わせ、段階 (96/144/192/288) の切り上げで選ぶ。WebView が画像を拡大縮小する
//     ときの補間（小さい写真が半画素動いて見える原因）を、1:1 に近い組み合わせで避ける。
//   - キャッシュのキーは (パス, ページ, dpi段階)。総容量に上限を設け、古いものから捨てる。

import { useEffect, useState } from "react";

/** 論理ピクセルの基準 dpi（文字選択・リンクの座標系もこの dpi） */
export const BASE_DPI = 96;

/** 描画 dpi の段階（昇順）。最後の値が上限。 */
export const RENDER_DPI_STEPS: readonly number[] = [96, 144, 192, 288];

/**
 * 表示される実画素数に合わせた描画 dpi を段階から選ぶ。
 *
 * @param zoom         ビューワのズーム倍率 (1.0 = 100%)
 * @param deviceScale  CSS px 1 つあたりの実画素数 (devicePixelRatio × UI倍率)
 */
export function pickRenderDpi(zoom: number, deviceScale: number): number {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const d = Number.isFinite(deviceScale) && deviceScale > 0 ? deviceScale : 1;
  const target = BASE_DPI * z * d;
  // 目標より 3% 以内の不足は許容する（100% 表示・DPR 1 で 96dpi になるように）
  for (const step of RENDER_DPI_STEPS) {
    if (step * 1.03 >= target) return step;
  }
  return RENDER_DPI_STEPS[RENDER_DPI_STEPS.length - 1];
}

interface CacheEntry {
  path: string;
  page: number;
  dpi: number;
  b64: string;
}

/** 描画済みページ画像 (base64 JPEG) の LRU キャッシュ。総文字数で容量を制限する。 */
export class PageImageCache {
  // Map の挿入順 = 使用順（古いものが先頭）
  private map = new Map<string, CacheEntry>();
  private bytes = 0;

  private readonly maxBytes: number;

  constructor(maxBytes = 96 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }

  private static key(path: string, page: number, dpi: number): string {
    return `${path}\u0000${page}@${dpi}`;
  }

  /** 完全一致 (path, page, dpi) の画像を返す。使用済みとして並べ替える。 */
  get(path: string, page: number, dpi: number): string | undefined {
    const k = PageImageCache.key(path, page, dpi);
    const e = this.map.get(k);
    if (!e) return undefined;
    this.map.delete(k);
    this.map.set(k, e);
    return e.b64;
  }

  /** 同じページで最も dpi の高い画像を返す（描画待ちの暫定表示用）。 */
  getBest(path: string, page: number): { b64: string; dpi: number } | undefined {
    let best: CacheEntry | undefined;
    for (const e of this.map.values()) {
      if (e.path === path && e.page === page && (!best || e.dpi > best.dpi)) best = e;
    }
    return best ? { b64: best.b64, dpi: best.dpi } : undefined;
  }

  set(path: string, page: number, dpi: number, b64: string): void {
    const k = PageImageCache.key(path, page, dpi);
    const old = this.map.get(k);
    if (old) {
      this.bytes -= old.b64.length;
      this.map.delete(k);
    }
    this.map.set(k, { path, page, dpi, b64 });
    this.bytes += b64.length;
    // 容量超過: 古いものから捨てる（今追加したものは残す）
    while (this.bytes > this.maxBytes && this.map.size > 1) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined || oldest === k) break;
      const e = this.map.get(oldest);
      if (e) this.bytes -= e.b64.length;
      this.map.delete(oldest);
    }
  }

  /** キャッシュにあるパスの一覧（重複なし） */
  paths(): string[] {
    return [...new Set([...this.map.values()].map((e) => e.path))];
  }

  deletePath(path: string): void {
    for (const [k, e] of [...this.map.entries()]) {
      if (e.path === path) {
        this.bytes -= e.b64.length;
        this.map.delete(k);
      }
    }
  }
}

/** window.devicePixelRatio を、ブラウザのズームや画面移動による変化に追従して返す。 */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() =>
    typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    let mql: MediaQueryList | null = null;
    const onChange = () => {
      setDpr(window.devicePixelRatio || 1);
      listen();
    };
    const listen = () => {
      mql?.removeEventListener("change", onChange);
      // 現在の dppx から外れたときに発火する（変化のたびに張り直す）
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mql.addEventListener("change", onChange);
    };
    listen();
    return () => mql?.removeEventListener("change", onChange);
  }, []);
  return dpr;
}
