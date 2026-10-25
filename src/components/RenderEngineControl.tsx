// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/RenderEngineControl.tsx
// 描画エンジン (MuPDF / hayro) の切替。hayro を含まないビルドでは何も表示しない。
import { useI18n } from "../lib/i18n";
import { changeRenderEngine, type RenderEngine, useRenderEngine } from "../lib/renderEngine";
import { EngineDropdown } from "./EngineDropdown";

export function RenderEngineControl() {
  const { t } = useI18n();
  const { engine, available } = useRenderEngine();
  if (available.length < 2) return null;
  return (
    <EngineDropdown
      title={t("render_engine.title")}
      short={t("render_engine.short")}
      value={engine}
      options={available.map((id) => ({
        id,
        label: t(`render_engine.${id}`),
        desc: t(`render_engine.${id}_desc`),
      }))}
      onPick={(id) => void changeRenderEngine(id as RenderEngine).catch(() => {})}
    />
  );
}
