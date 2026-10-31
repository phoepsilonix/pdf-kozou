// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/HayroStrokeControl.tsx
// hayro の細線・文字の太らせ補正 (オン / オフ / カスタム数値) の切替。
// hayro を使わない設定 (描画エンジン = MuPDF) のときは何も表示しない。
import { useI18n } from "../lib/i18n";
import {
  CUSTOM_MAX,
  CUSTOM_MIN,
  changeHayroStroke,
  type HayroStrokeMode,
  useHayroStroke,
} from "../lib/hayroStroke";
import { useRenderEngine } from "../lib/renderEngine";
import { EngineDropdown } from "./EngineDropdown";
import { NumInput } from "./NumInput";

const MODES: HayroStrokeMode[] = ["on", "off", "custom"];

export function HayroStrokeControl() {
  const { t } = useI18n();
  const { engine, available } = useRenderEngine();
  const { mode, custom, recommended } = useHayroStroke();
  if (available.length < 2 || engine === "mupdf") return null;
  const label = (id: HayroStrokeMode) =>
    id === "custom" ? `${t("hayro_stroke.custom")} ${custom}` : t(`hayro_stroke.${id}`);
  return (
    <EngineDropdown
      title={t("hayro_stroke.title")}
      short={t("hayro_stroke.short")}
      value={mode}
      options={MODES.map((id) => ({
        id,
        label: label(id),
        desc:
          id === "on"
            ? t("hayro_stroke.on_desc").replace("{value}", String(recommended))
            : t(`hayro_stroke.${id}_desc`),
      }))}
      keepOpenIds={["custom"]}
      onPick={(id) => void changeHayroStroke(id as HayroStrokeMode).catch(() => {})}
      extra={
        <div
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px" }}
          data-testid="hayro-stroke-custom"
        >
          <span style={{ fontSize: 12 }}>{t("hayro_stroke.custom_value")}</span>
          <NumInput
            value={custom}
            min={CUSTOM_MIN}
            max={CUSTOM_MAX}
            step={0.05}
            integer={false}
            aria-label={t("hayro_stroke.custom_value")}
            style={{ width: 72 }}
            onChange={(n) => void changeHayroStroke("custom", n).catch(() => {})}
          />
          <span style={{ fontSize: 12 }}>px</span>
        </div>
      }
    />
  );
}
