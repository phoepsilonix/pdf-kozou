// src-tauri/src/error.rs
use serde::Serialize;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error, Serialize)]
pub enum Error {
    #[error("core: {0}")]
    Core(String),
    #[error("io: {0}")]
    Io(String),
    #[error("platform: {0}")]
    Platform(String),
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self { Error::Io(e.to_string()) }
}
