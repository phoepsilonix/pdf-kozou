// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/error.rs
use serde::{Serialize, Serializer};
use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("core: {0}")]
    Core(String),
    #[error("io: {0}")]
    Io(String),
    //    #[error("platform: {0}")]
    //    Platform(String),
}

/// フロントエンドへは表示用の文字列として返す。
///
/// derive(Serialize) のままだと `{"Core":"..."}` というオブジェクトになり、
/// フロント側の `String(e)` が "[object Object]" になって原因が読めなくなる。
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e.to_string())
    }
}
