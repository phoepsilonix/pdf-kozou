# PDF小僧 (PDF-Kozou)

> MuPDF ベースの PDF 処理ツール — CLI / デスクトップ GUI(Rust with Tauri) / (Web 対応 未定)

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSES.md)
[![Rust](https://img.shields.io/badge/rust-1.75%2B-orange.svg)](https://www.rust-lang.org/)

---

## 概要

PDF小僧は [MuPDF](https://mupdf.com/) を処理エンジンとする PDF ユーティリティです。
分割、結合、回転、トリミング、圧縮、画像変換、簡易ビューワーなどの機能を備えています。

PDF小僧は、標準で強力な MuPDF エンジンを搭載しており、インストール後すぐに PDF の分割・結合・トリミング・回転・圧縮・画像変換などが可能です。  
さらに、より高度な画質調整やクリーンアップを求めるプロユーザー向けに、外部エンジン（Ghostscript）との連携オプションも提供しています。

The app is a fully functional PDF tool out-of-the-box using the built-in MuPDF engine.  
Ghostscript is strictly an optional enhancement for advanced users.  
We have updated the UI to clarify that all core features, including compression, work without any external software.

## プロ(GS連携)モード利用のシステム要件

GhostScriptがセットアップされているシステムの場合、パスなどでGSが検出されましたら利用可能になります。  
またGhostScriptがインストールされているフォルダなどを手動で指定する機能も追加しました。  
自動認識よりも、ユーザーが指定したものが優先して使用されます。  
優先順位はユーザー指定、環境変数、自動検出の順番になります。

### Windows

Windowsの方は、[GhostScript for Windows版](https://ghostscript.com/releases/gsdnld.html)のセットアップをご検討ください。  
管理者権限でのインストールが難しい場合、ユーザー権限でPortable版をインストールすることもご検討ください。  
[Ghostscript Portable](https://portableapps.com/apps/utilities/ghostscript_portable)

v1.4.5以降  
インストール後、ユーザー環境変数のPATHに`gswin64c`がある場所のPATHを設定するか、あるいは環境変数`PDF_KOZOU_GS_HOME`または`GHOSTSCRIPTHOME`にGhostScriptをインストールしたフォルダ(gswin64cがある一つ上のフォルダ)のPATHを設定してみてください。

v1.4.6以降
PDF小僧が使用するGhostScriptをユーザーが明示的に指定できるようにしました。  
GhostScriptがインストールされているフォルダを指定するなどで、GhostScriptを認識させることができます。  
複数バージョン混在の環境でも、ユーザーが明示的に指定したものを優先して用いる形になります。

### 環境変数の設定例

#### Windows

##### 環境変数の設定

環境変数を設定していても、ユーザーが明示的にGSのインストール先を指定している場合、そちらが優先されます。
Downloadsフォルダの下に展開してインストールした例。user_nameは適宜、置き換えてください。

```pwsh
[Environment]::SetEnvironmentVariable("PDF_KOZOU_GS_HOME", "C:\Users\user_name\Downloads\Ghostscript", "User")
```

##### 環境変数の確認

```pwsh
[Environment]::GetEnvironmentVariable("PDF_KOZOU_GS_HOME", "User")
```

##### 環境変数の取り消し

```pwsh
[Environment]::SetEnvironmentVariable("PDF_KOZOU_GS_HOME", "", "User")
```

または

```pwsh
[Environment]::SetEnvironmentVariable("PDF_KOZOU_GS_HOME", $null, "User")
```

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
ページ範囲の選択やビューワーの検索ボタンを押してフリーズする場合があります。
その場合には、環境変数の`GTK_IM_MODULE=gtk-im-context-simple`を追加してAppImageを起動することで、問題が改善する場合があります。(この回避策では日本語入力はできませんが、コピーペーストはできます。)  
いずれは直したいですが使用しているユーザーの環境によるので、すぐには難しそうです。  
tar.bz2版のバイナリ(v1.4.8〜)が起動できる場合には、そちらの利用もご検討ください。


| プラットフォーム      | ファイル                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| Windows (x64)         | `PDF-Kozou_${version}_x64-setup.exe` `PDF-Kozou_${version}_x64_en-US.msi`                                  |
| Linux (x64)           | `PDF-Kozou-${version}-1.x86_64.rpm` `PDF-Kozou_${version}_amd64.deb` `PDF-Kozou_${version}_amd64.AppImage` |
| macOS (Apple Silicon) | （未定）                                                                                                   |

### Microsoft Store(Windows)

[PDF-Kozou(PDF小僧)](https://apps.microsoft.com/detail/9P2HDLPTT5WR?hl=ja-jp&gl=JP&ocid=pdpshare)

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

## キーボードショートカット / Keyboard Shortcuts

### 全画面共通 / Global (always active, even while typing)

| キー / Key | 動作 / Action                                         |
| ---------- | ----------------------------------------------------- |
| `Alt+T`    | 読み上げ ON/OFF / Toggle text-to-speech               |
| `Alt+L`    | 言語切り替え / Switch language (JA ↔ EN)              |
| `Alt+H`    | ホームに戻る / Go back to home                        |
| `F1`       | ショートカット一覧を読み上げ / Read out shortcut list |

### ホーム画面 / Home screen

| キー / Key | 動作 / Action                             |
| ---------- | ----------------------------------------- |
| `Ctrl+O`   | ファイルを開く / Open files               |
| `Alt+1`    | 分割ツールを起動 / Launch split tool      |
| `Alt+2`    | 結合ツールを起動 / Launch merge tool      |
| `Alt+3`    | トリミングを起動 / Launch trim tool       |
| `Alt+4`    | 回転ツールを起動 / Launch rotate tool     |
| `Alt+5`    | 圧縮ツールを起動 / Launch compress tool   |
| `Alt+6`    | 画像変換を起動 / Launch image export tool |
| `Alt+7`    | ビューワーを起動 / Launch viewer          |

### 各ツール画面（共通）/ Tool screens (common)

| キー / Key         | 動作 / Action                                                                         |
| ------------------ | ------------------------------------------------------------------------------------- |
| `Ctrl+Enter`       | 実行 / プレビュー / Execute or preview                                                |
| `Ctrl+S`           | 保存（結果画面で有効）/ Save (active on result screen)                                |
| `Ctrl+Shift+S`     | 続けて圧縮して保存 / Compress then save                                               |
| `Alt+D`            | 出力先フォルダを選択 / Select output folder (D = Destination)                         |
| `Alt+R`            | ページ範囲入力にフォーカス / Focus page range input (R = Range)                       |
| `Alt+M`            | 余白入力にフォーカス（TrimPage のみ）/ Focus margin input (M = Margin, TrimPage only) |
| `Escape`           | 結果 → 設定 / 設定 → ホーム / Result → settings / settings → home                     |
| `Alt+1` 〜 `Alt+7` | 別のツールに切り替え / Switch to another tool                                         |

### ビューワー / Viewer

| キー / Key                     | 動作 / Action                              |
| ------------------------------ | ------------------------------------------ |
| `←` `→`                        | 前 / 次のページ / Previous / next page     |
| `Ctrl+F`                       | 全ページ検索を開く / Open full-page search |
| `Ctrl+ホイール` / `Ctrl+Wheel` | ズームイン / ズームアウト / Zoom in / out  |

### メタデータ編集モーダル / Metadata editor modal

| キー / Key   | 動作 / Action  |
| ------------ | -------------- |
| `Ctrl+Enter` | 保存 / Save    |
| `Escape`     | 閉じる / Close |

---

## ライセンス

このプロジェクトは **GNU Affero General Public License v3.0 (AGPL-3.0)** のもとで公開されています。

詳細は [LICENSES](LICENSES.md) を参照してください。

> **商用利用について:** MuPDF は AGPL-3.0 のため、このソフトウェアを組み込んだ
> プロプライエタリ製品を(クローズド)配布する場合は Artifex 社との商用ライセンス契約が必要です。
> 詳細は [LICENSES](LICENSES.md) の「商用利用」セクションを参照してください。

---

## 貢献

Issue・PR 歓迎です。バグ報告は Issue に、コード変更は Fork → PR でお願いします。

---

## 関連リンク

- [MuPDF 公式サイト](https://mupdf.com/)
- [mupdf crate (crates.io)](https://crates.io/crates/mupdf)
- [Tauri 公式サイト](https://tauri.app/)
