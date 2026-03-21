# アーキテクチャ

## 設計方針

PDF小僧は **GUI フレームワークと処理エンジンを完全に分離**した設計を採用しています。

```
pdf-kozou/                     (Cargo workspace)
├── pdf-kozou-core/            処理エンジン
│   ├── src/
│   │   ├── main.rs            CLI エントリポイント + JSON sidecar モード
│   │   ├── lib.rs             ライブラリ公開インターフェース
│   │   ├── render.rs          ページレンダリング
│   │   ├── info.rs            PDF メタ情報取得
│   │   ├── trim.rs            CropBox トリミング
│   │   ├── compress.rs        圧縮・最適化
│   │   ├── split.rs           PDF 分割
│   │   ├── merge.rs           PDF 結合
│   │   ├── rotate.rs          ページ回転
│   │   ├── pixmap.rs          ピクセルマップ → JPEG/PNG 変換
│   │   └── error.rs           エラー型定義
│   └── Cargo.toml             mupdf = "0.6" など
└── src-tauri/                 GUI (Tauri v2)
    ├── src/
    │   ├── main.rs
    │   ├── lib.rs
    │   ├── commands/
    │   │   ├── core.rs        pdf-kozou-core を sidecar 経由で呼ぶ
    │   │   └── platform.rs    OS 固有機能
    │   └── platform/
    │       ├── mod.rs
    │       └── linux.rs
    └── Cargo.toml             mupdf 依存なし・軽量
```

---

## pdf-kozou-core の役割

pdf-kozou-core は **永続的な資産**として設計されています。
GUI フレームワーク (Tauri) が将来別のものに変わっても、core はそのまま使い続けられます。

### 2つの動作モード

**1. CLI モード** — コマンドライン引数で動作

```bash
pdf-kozou-core info document.pdf
pdf-kozou-core compress input.pdf output.pdf --gc 4
```

**2. JSON sidecar モード** — stdin に JSON を流す (Tauri から呼ぶ際に使用)

```bash
echo '{"cmd":"info","path":"document.pdf"}' | pdf-kozou-core json
```

全コマンドは結果を **JSON (stdout)** で返します。エラー時も `{"ok":false,"error":"..."}` を stdout に出力し、exit code 1 で終了します。

---

## Tauri との通信

```
[フロントエンド JS]
    ↓ invoke("core_command", { line: JSON文字列 })
[src-tauri/commands/core.rs]
    ↓ tauri-plugin-shell で sidecar プロセス起動
[pdf-kozou-core (別プロセス)]
    stdin: JSON リクエスト
    stdout: JSON レスポンス
    ↓
[src-tauri/commands/core.rs]
    ↓ JSON をパースして JS へ返す
[フロントエンド JS]
```

Tauri の sidecar 機能を使うことで、MuPDF の C ライブラリをメインプロセスと分離し、
クラッシュ時の影響範囲を限定しています。

---

## MuPDF バインディングの実装

mupdf crate 0.6 (MuPDF 1.27.0 ベース) を使用します。

### GraftMap パターン (merge / split)

ページのコピーは `copy_page()` ではなく GraftMap パターンを使用します:

```rust
let mut dst = PdfDocument::new();
let mut graft = dst.new_graft_map()?;
for i in 0..n {
    let src_page = src.find_page(i)?;
    let dst_page = graft.graft_object(&src_page)?;
    dst.insert_page(-1, &dst_page)?;
}
```

### rotate の設計

MuPDF 0.6 では既存の Rotate 値の読み取り API が存在しないため、
回転角度は **GUI 側で累積計算して絶対角度として渡す**設計になっています。

---

## 将来の拡張

| 形態             | 状態        | 概要                                  |
| ---------------- | ----------- | ------------------------------------- |
| CLI              | ✅ 実装済み | pdf-kozou-core バイナリ               |
| デスクトップ GUI | 🚧 開発中   | Tauri v2                              |
| Web 版           | 📋 計画中   | mupdf.wasm + coi-serviceworker        |
| iOS / Android    | 📋 計画中   | PWA (Service Worker でオフライン動作) |

Web 版は [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) を使って
GitHub Pages など任意のホスティングサービスで動作させる予定です。
誰でもリポジトリをフォークして自分のサイトでホストできます。
