// mupdf-sys で使えるシンボルの探索
// このファイルは開発用。本実装前に削除する。

#[allow(dead_code)]
pub fn probe() {
    // mupdf-sys のシンボルが見えるか確認（コンパイルのみ、実行しない）
    let _ = mupdf_sys::FZ_VERSION;
}
