// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/HayroJpegControl.tsx
// hayro 描画結果の JPEG エンコード設定: 色差サブサンプリング (4:4:4 / 4:2:0) と
// トレリス量子化 (オン / オフ)。画像変換の出力に反映される。ビューワーの描画には、
// トレリスだけは使わない (ページ送りを遅くしないため)。
// hayro を使わない設定 (描画エンジン = MuPDF) のときは何も表示しない。
import { changeHayroJpeg, type JpegSubsampling, useHayroJpeg } from "../lib/hayroJpeg";
import { useI18n } from "../lib/i18n";
import { useRenderEngine } from "../lib/renderEngine";
import { FS } from "../lib/typography";
import { EngineDropdown } from "./EngineDropdown";

const SUBSAMPLING: JpegSubsampling[] = [444, 420];

export function HayroJpegControl() {
  const { t } = useI18n();
  const { engine, available } = useRenderEngine();
  const { subsampling, trellis } = useHayroJpeg();
  if (available.length < 2 || engine === "mupdf") return null;
  const label = (id: JpegSubsampling) => {
    const base = t(`hayro_jpeg.s${id}`);
    return id === subsampling && trellis ? `${base} + ${t("hayro_jpeg.trellis_short")}` : base;
  };
  return (
    <EngineDropdown
      title={t("hayro_jpeg.title")}
      short={t("hayro_jpeg.short")}
      value={String(subsampling)}
      options={SUBSAMPLING.map((id) => ({
        id: String(id),
        label: label(id),
        desc: t(`hayro_jpeg.s${id}_desc`),
      }))}
      keepOpenIds={SUBSAMPLING.map(String)}
      onPick={(id) =>
        void changeHayroJpeg({ subsampling: Number(id) as JpegSubsampling }).catch(() => {})
      }
      extra={
        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "10px 14px",
            cursor: "pointer",
          }}
          data-testid="hayro-jpeg-trellis"
        >
          <input
            type="checkbox"
            checked={trellis}
            onChange={(e) => void changeHayroJpeg({ trellis: e.target.checked }).catch(() => {})}
            style={{ marginTop: 3 }}
          />
          <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: FS.body, color: "var(--c-text)" }}>
              {t("hayro_jpeg.trellis")}
            </span>
            <span style={{ fontSize: FS.caption, color: "var(--c-textDim)" }}>
              {t("hayro_jpeg.trellis_desc")}
            </span>
          </span>
        </label>
      }
    />
  );
}
