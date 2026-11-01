// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/HayroStrokeControl.tsx
// hayro の細線・文字の太らせ補正 (オン / オフ / カスタム数値) の切替。
// パス (線) と文字の輪郭線を別々に指定できる。
// hayro を使わない設定 (描画エンジン = MuPDF) のときは何も表示しない。
import {
  CUSTOM_MAX,
  CUSTOM_MIN,
  changeHayroStroke,
  type HayroStrokeMode,
  useHayroStroke,
} from "../lib/hayroStroke";
import { useI18n } from "../lib/i18n";
import { useRenderEngine } from "../lib/renderEngine";
import { EngineDropdown } from "./EngineDropdown";
import { NumInput } from "./NumInput";

const MODES: HayroStrokeMode[] = ["on", "off", "custom"];
const formatNum = (val: number): string => Number(val.toFixed(10)).toString();

export function HayroStrokeControl() {
  const { t } = useI18n();
  const { engine, available } = useRenderEngine();
  const { mode, customPath, customText, recommendedPath, recommendedText } = useHayroStroke();
  if (available.length < 2 || engine === "mupdf") return null;
  const label = (id: HayroStrokeMode) =>
    id === "custom"
      ? `${t("hayro_stroke.custom")} ${customPath} / ${customText}`
      : t(`hayro_stroke.${id}`);
  const row = { display: "flex", alignItems: "center", gap: 8, padding: "6px 14px" } as const;
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
            ? t("hayro_stroke.on_desc")
                .replace("{path}", formatNum(recommendedPath))
                .replace("{text}", formatNum(recommendedText))
            : t(`hayro_stroke.${id}_desc`),
      }))}
      keepOpenIds={["custom"]}
      onPick={(id) => void changeHayroStroke(id as HayroStrokeMode).catch(() => {})}
      extra={
        <div style={{ padding: "4px 0" }} data-testid="hayro-stroke-custom">
          <label style={row}>
            <span style={{ fontSize: 12, minWidth: 56 }}>{t("hayro_stroke.path_value")}</span>
            <NumInput
              value={customPath}
              min={CUSTOM_MIN}
              max={CUSTOM_MAX}
              step={0.05}
              integer={false}
              aria-label={t("hayro_stroke.path_value")}
              style={{ width: 72 }}
              onChange={(n) => void changeHayroStroke("custom", { path: n }).catch(() => {})}
            />
            <span style={{ fontSize: 12 }}>px</span>
          </label>
          <label style={row}>
            <span style={{ fontSize: 12, minWidth: 56 }}>{t("hayro_stroke.text_value")}</span>
            <NumInput
              value={customText}
              min={CUSTOM_MIN}
              max={CUSTOM_MAX}
              step={0.05}
              integer={false}
              aria-label={t("hayro_stroke.text_value")}
              style={{ width: 72 }}
              onChange={(n) => void changeHayroStroke("custom", { text: n }).catch(() => {})}
            />
            <span style={{ fontSize: 12 }}>px</span>
          </label>
        </div>
      }
    />
  );
}
