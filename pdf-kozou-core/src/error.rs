// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/error.rs
use serde::Serialize;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, CoreError>;

#[derive(Debug, Error, Serialize)]
pub enum CoreError {
    #[error("IO: {0}")]
    Io(
        #[serde(skip)]
        #[from]
        std::io::Error,
    ),
    #[error("PDF parse: {0}")]
    Parse(String),
    #[error("MuPDF: {0}")]
    MuPdf(String),
    #[error("Image encode: {0}")]
    ImageEncode(String),
    #[error("Invalid argument: {0}")]
    InvalidArg(String),
    /// 実装が対応していない指定・入力 (lopdf 実装が MuPDF 実装へ引き継ぐときなど)
    #[error("Unsupported: {0}")]
    Unsupported(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

/// JSON エラーレスポンス
#[derive(Serialize)]
pub struct ErrorResponse {
    pub ok: bool,
    pub error: String,
}

impl From<CoreError> for ErrorResponse {
    fn from(e: CoreError) -> Self {
        ErrorResponse {
            ok: false,
            error: e.to_string(),
        }
    }
}
