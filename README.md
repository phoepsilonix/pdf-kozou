# PDF小僧 (pdf-kozou)

> MuPDF ベースの PDF 処理ツール — CLI / デスクトップ GUI(Rust with Tauri) / (Web 対応 未定)

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-1.75%2B-orange.svg)](https://www.rust-lang.org/)

---

## 概要

PDF小僧は [MuPDF](https://mupdf.com/) を処理エンジンとする PDF ユーティリティです。

### 備考

トリミングCropBoxをもちいられたPDFのファイルサイズ削減、圧縮は、そこまで有能ではありません。  
そういうタイプのファイルはGhostScript連携の圧縮を試してみてください。

---

## 機能

| コマンド    | 内容                                                              |
| ----------- | ----------------------------------------------------------------- |
| `info`      | PDF の基本情報を取得 (ページ数・サイズなど)                       |
| `render`    | ページを JPEG / PNG / SVG 画像にレンダリング                      |
| `trim`      | CropBox を設定してトリミング                                      |
| `compress`  | ファイルサイズを最適化・圧縮(GSがある環境ではGSも呼び出せます。)  |
| `split`     | 1ページずつ・N ページごと・ページ範囲で分割                       |
| `merge`     | 複数の PDF を結合                                                 |
| `rotate`    | ページを 90 / 180 / 270 度回転                                    |
| `convert`   | 非 PDF ファイル（EPUB, DOCX, XPS, HTML, 画像等）を PDF に変換する |
| `rasterize` | PDF を全ページ画像化して PDF に再出力（ラスタライズ）             |
| `json`      | stdin から JSON リクエストを受け取って実行 (Tauri sidecar モード) |

- convertは、一部レイアウトが崩れる可能性あり。DOCX、XLSXなどでうまく動作しない場合もあります。

---

## インストール

### バイナリ (推奨)

[Releases](https://github.com/phoepsilonix/pdf-kozou/releases)  
macOS版の提供は未定。動作確認環境がないため。

※AppImage版について  
現時点のAppImage版は、日本語入力やキー入力に制約があります。  
`GTK_IM_MODULE=gtk-im-context-simple`を設定して、起動すればページ範囲などの数字入力は可能だと思います。  
現時点では設定しておかないとフリーズすると思います。またビューワーの検索で日本語入力ができないと思います。  
いずれは直したいですが使用しているユーザーの環境によるので、時間がかかるかもしれません。

| プラットフォーム      | ファイル                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| Windows (x64)         | `PDF-Kozou_${version}_x64-setup.exe` `PDF-Kozou_${version}_x64_en-US.msi`                                  |
| Linux (x64)           | `PDF-Kozou-${version}-1.x86_64.rpm` `PDF-Kozou_${version}_amd64.deb` `PDF-Kozou_${version}_amd64.AppImage` |
| macOS (Apple Silicon) | （未定）                                                                                                   |

### ソースからビルド

- **pdf-kozou-core** — CLI ツール兼ライブラリ。MuPDF の Rust バインディングで PDF を処理します。
- **src** — TauriとCLIを繋ぐ部分。
- **src-tauri** — Tauri v2 製のデスクトップ GUI。pdf-kozou-core を sidecar として呼び出します。

```
pdf-kozou/
├── pdf-kozou-core/   処理エンジン (CLI + lib)
├── src/              GUI(Tauri)とCLI(処理エンジン)をつなぐ部分(lib)
└── src-tauri/        デスクトップ GUI (Tauri v2)
```

```bash
git clone https://github.com/phoepsilonix/pdf-kozou.git
cd pdf-kozou
cargo build --release -p pdf-kozou-core
cargo tauri build
```

ビルド済みバイナリは `target/release/pdf-kozou-core` `target/release/pdf-kozou` に生成されます。  
Windowsは`WebView2Loader.dll`も同じフォルダに必要です。WebView2Loader.dllも`target/release`にあると思います。

> **注意:** ビルドには C/C++ ツールチェーン (cmake, clang, TypeScript など) が必要です。  
> 詳細は [BUILDING.md](BUILDING.md)、[WINDOWS_BUILD.md](WINDOWS_BUILD.md) を参照してください。

---

## 使い方 (CLI)

```bash
# PDF 情報の取得
pdf-kozou-core info document.pdf

# ページを JPEG にレンダリング (DPI=150, page=0)
pdf-kozou-core render document.pdf --page 0 --dpi 150 --format jpeg

# PDF を圧縮
pdf-kozou-core compress input.pdf output.pdf

# ページ 1〜3 と 7〜10 を分割
pdf-kozou-core split input.pdf ./out --ranges "1-3,7-10"

# 複数 PDF を結合
pdf-kozou-core merge a.pdf b.pdf c.pdf --output merged.pdf

# 全ページを 90 度回転
pdf-kozou-core rotate input.pdf output.pdf --angle 90

# Tauri sidecar / JSON モード (stdin に JSON を流す)
echo '{"cmd":"info","path":"document.pdf"}' | pdf-kozou-core json
```

全コマンドのヘルプ:

```bash
pdf-kozou-core --help
pdf-kozou-core <COMMAND> --help
```

## 使い方 (GUI)

```sh
pdf-kozou
```

---

## ライセンス

このプロジェクトは **GNU Affero General Public License v3.0 (AGPL-3.0)** のもとで公開されています。

詳細は [LICENSE](LICENSE) および [LICENSES.md](LICENSES.md) を参照してください。

> **商用利用について:** MuPDF は AGPL-3.0 のため、このソフトウェアを組み込んだ
> プロプライエタリ製品を配布する場合は Artifex 社との商用ライセンス契約が必要です。
> 詳細は [LICENSES.md](LICENSES.md) の「商用利用」セクションを参照してください。

---

## 貢献

Issue・PR 歓迎です。バグ報告は Issue に、コード変更は Fork → PR でお願いします。

---

## 関連リンク

- [MuPDF 公式サイト](https://mupdf.com/)
- [mupdf crate (crates.io)](https://crates.io/crates/mupdf)
- [Tauri 公式サイト](https://tauri.app/)
