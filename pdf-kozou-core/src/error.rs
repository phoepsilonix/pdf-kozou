// pdf-kozou-core/src/error.rs
use serde::Serialize;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, CoreError>;

#[derive(Debug, Error, Serialize)]
pub enum CoreError {
    #[error("IO: {0}")]
    Io(#[serde(skip)] #[from] std::io::Error),
    #[error("PDF parse: {0}")]
    Parse(String),
    #[error("MuPDF: {0}")]
    MuPdf(String),
    #[error("Image encode: {0}")]
    ImageEncode(String),
    #[error("Invalid argument: {0}")]
    InvalidArg(String),
}

/// JSON エラーレスポンス
#[derive(Serialize)]
pub struct ErrorResponse {
    pub ok:      bool,
    pub error:   String,
}

impl From<CoreError> for ErrorResponse {
    fn from(e: CoreError) -> Self {
        ErrorResponse { ok: false, error: e.to_string() }
    }
}
