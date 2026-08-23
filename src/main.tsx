// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./lib/i18n";
import { initUiScale } from "./lib/uiScale";

// 初回描画前に保存済みの表示スケールを #root へ適用しておく
// （高さ補正が初期レイアウトに間に合わないと一瞬崩れるため）
initUiScale();

// biome-ignore lint/style/noNonNullAssertion: index.htmlに常に<div id="root">が存在するVite/React標準の起動イディオム
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
