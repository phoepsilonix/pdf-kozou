# ライセンス情報

## このプロジェクトのライセンス

PDF小僧 (PDF-Kozou) は **GNU Affero General Public License v3.0 (AGPL-3.0)** のもとで公開されています。

AGPL-3.0 の全文は [LICENSE](AGPL-3.0-or-later.txt) ファイルを参照してください。

---

## AGPL-3.0 とは

AGPL-3.0 は GPL-3.0 の拡張版で、**ネットワーク越しにサービスとして提供する場合にもソースコード公開を義務付ける**ライセンスです。

主なポイント:

- **個人利用・研究利用:** 無料・自由に使用できます。
- **OSS として再配布:** ソースコードを同じ AGPL-3.0 で公開すれば無料で配布できます。
- **Web サービスとして提供:** ユーザーにソースコードへのアクセス手段を提供する必要があります (例: GitHub リポジトリへのリンク)。
- **プロプライエタリ製品への組み込み:** 商用ライセンスが必要です (後述)。

---

## 商用利用について

このプロジェクトが依存する **MuPDF** (Artifex Software 社) は AGPL-3.0 です。
MuPDF をプロプライエタリなソフトウェアに組み込む場合は、**Artifex 社との商用ライセンス契約**が必要です。

| 利用形態                                 | 要件                               |
| ---------------------------------------- | ---------------------------------- |
| 個人・研究・教育目的                     | 無料。AGPL の条件に従うだけでよい  |
| OSS プロジェクト (AGPL-3.0 で公開)       | 無料。ソースコードの公開が条件     |
| Web サービス (ソース公開あり)            | 無料。ユーザーへのソース開示が条件 |
| Web サービス (ソース非公開)              | Artifex 社の商用ライセンスが必要   |
| プロプライエタリ製品への組み込み・再配布 | Artifex 社の商用ライセンスが必要   |

商用ライセンスの問い合わせ先: https://artifex.com/licensing/

---

## 依存クレートのライセンス一覧

### コア依存 (pdf-kozou-core)

| クレート                                          | バージョン | ライセンス       | 説明                                            |
| ------------------------------------------------- | ---------- | ---------------- | ----------------------------------------------- |
| [mupdf](https://crates.io/crates/mupdf)           | 0.6        | AGPL-3.0         | MuPDF Rust バインディング。PDF 処理エンジン本体 |
| [clap](https://crates.io/crates/clap)             | 4          | MIT / Apache-2.0 | CLI 引数パーサー                                |
| [serde](https://crates.io/crates/serde)           | 1          | MIT / Apache-2.0 | シリアライズ・デシリアライズフレームワーク      |
| [serde_json](https://crates.io/crates/serde_json) | 1          | MIT / Apache-2.0 | JSON 処理                                       |
| [anyhow](https://crates.io/crates/anyhow)         | 1          | MIT / Apache-2.0 | エラーハンドリングユーティリティ                |
| [thiserror](https://crates.io/crates/thiserror)   | 1          | MIT / Apache-2.0 | カスタムエラー型の derive マクロ                |
| [base64](https://crates.io/crates/base64)         | 0.22       | MIT / Apache-2.0 | Base64 エンコード・デコード                     |
| [image](https://crates.io/crates/image)           | 0.25       | MIT              | 画像フォーマット変換 (JPEG/PNG)                 |
| [uuid](https://crates.io/crates/uuid)             | 1          | MIT / Apache-2.0 | 一時ファイル名などの UUID 生成                  |
| [tempfile](https://crates.io/crates/tempfile)     | 3          | MIT / Apache-2.0 | 一時ファイル・ディレクトリ管理                  |
| [tracing](https://crates.io/crates/tracing)       | 0.1        | MIT              | 構造化ロギング                                  |
| [tokio](https://crates.io/crates/tokio)           | 1          | MIT              | 非同期ランタイム                                |

### GUI 依存 (src-tauri)

| クレート                                                            | バージョン | ライセンス       | 説明                            |
| ------------------------------------------------------------------- | ---------- | ---------------- | ------------------------------- |
| [tauri](https://crates.io/crates/tauri)                             | 2          | MIT / Apache-2.0 | デスクトップ GUI フレームワーク |
| [tauri-build](https://crates.io/crates/tauri-build)                 | 2          | MIT / Apache-2.0 | Tauri ビルドスクリプト          |
| [tauri-plugin-shell](https://crates.io/crates/tauri-plugin-shell)   | 2          | MIT / Apache-2.0 | sidecar プロセス起動            |
| [tauri-plugin-dialog](https://crates.io/crates/tauri-plugin-dialog) | 2          | MIT / Apache-2.0 | ファイル選択ダイアログ          |
| [tauri-plugin-fs](https://crates.io/crates/tauri-plugin-fs)         | 2          | MIT / Apache-2.0 | ファイルシステムアクセス        |

> 全依存クレートの詳細なライセンス情報は `cargo license` コマンドで確認できます:
>
> ```bash
> cargo install cargo-license
> cargo license
> ```

---

## mupdf クレートについて

[mupdf crate](https://crates.io/crates/mupdf) (バージョン 0.6) は [messense](https://github.com/messense) 氏が開発・維持するオープンソースプロジェクトです。
MuPDF 1.27.0 の C ソースコードを `mupdf-sys` クレートを通じて静的にリンクします。

- GitHub: https://github.com/messense/mupdf-rs
- ライセンス: AGPL-3.0
- MuPDF 本体: https://mupdf.com/

---

## Tauri について

[Tauri](https://tauri.app/) は Rust 製のクロスプラットフォーム デスクトップアプリケーションフレームワークです。
フロントエンドに Web 技術 (HTML/CSS/JavaScript) を使い、バックエンドを Rust で実装します。
Electron と比較してバイナリサイズが小さく、メモリ消費が少ない傾向があります。

- GitHub: https://github.com/tauri-apps/tauri
- ライセンス: MIT / Apache-2.0
