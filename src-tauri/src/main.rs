// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/main.rs
// ⚠️  環境変数のセットアップは tauri::Builder より前に必ず実行する

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pdf_kozou_lib::setup_platform();
    pdf_kozou_lib::run();
}
