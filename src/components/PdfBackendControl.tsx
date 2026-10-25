// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src/components/PdfBackendControl.tsx
// PDF 操作 (結合・分割・回転・トリミング等) の実装エンジン (lopdf / MuPDF) の切替。
import { useI18n } from "../lib/i18n";
import { changePdfBackend, type PdfBackend, usePdfBackend } from "../lib/pdfBackend";
import { EngineDropdown } from "./EngineDropdown";

export function PdfBackendControl() {
  const { t } = useI18n();
  const { backend, available } = usePdfBackend();
  if (available.length < 2) return null;
  return (
    <EngineDropdown
      title={t("pdf_backend.title")}
      short={t("pdf_backend.short")}
      value={backend}
      options={available.map((id) => ({
        id,
        label: t(`pdf_backend.${id}`),
        desc: t(`pdf_backend.${id}_desc`),
      }))}
      onPick={(id) => void changePdfBackend(id as PdfBackend).catch(() => {})}
    />
  );
}
