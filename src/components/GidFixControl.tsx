// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/GidFixControl.tsx
// GID 補正 (文字コードが GID の CID キー付き CFF フォントの charset を直す) のオン・オフの切替。
// PDF 操作エンジン・描画エンジンのどのモードでも表示する。
import { changeGidFix, type GidFixMode, useGidFix } from "../lib/gidFix";
import { useI18n } from "../lib/i18n";
import { EngineDropdown } from "./EngineDropdown";

const MODES: GidFixMode[] = ["on", "off"];

export function GidFixControl() {
  const { t } = useI18n();
  const { mode } = useGidFix();
  return (
    <EngineDropdown
      title={t("gid_fix.title")}
      short={t("gid_fix.short")}
      value={mode}
      options={MODES.map((id) => ({
        id,
        label: t(`gid_fix.${id}`),
        desc: t(`gid_fix.${id}_desc`),
      }))}
      onPick={(id) => void changeGidFix(id as GidFixMode).catch(() => {})}
    />
  );
}
