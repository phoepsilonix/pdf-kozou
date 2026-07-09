# PDF小僧 — バイナリ同梱 & Linux 動作要件

## オフライン動作について

PDF小僧はインターネット接続なしで完全動作します。  
以下のツールをアプリに同梱します。

| ツール                      | バージョン   | ライセンス | 用途                                 |
| --------------------------- | ------------ | ---------- | ------------------------------------ |
| Ghostscript                 | 10.x         | AGPL v3\*  | 変換・圧縮・透かし・ページ番号       |
| qpdf                        | 11.x         | Apache 2.0 | 事前最適化・分割・結合・回転・暗号化 |
| pdftoppm                    | Poppler 24.x | GPL v2     | ページラスタライズ (プレビュー)      |
| pdftotext                   | Poppler 24.x | GPL v2     | テキスト抽出                         |
| pdftohtml                   | Poppler 24.x | GPL v2     | HTML変換                             |
| pdftocairo                  | Poppler 24.x | GPL v2     | SVG変換                              |
| Tesseract                   | 5.x          | Apache 2.0 | OCR                                  |
| tessdata (eng/jpn/jpn_vert) | —            | Apache 2.0 | OCR言語データ                        |

> **Ghostscript 商用利用について:**  
> AGPL v3 の Ghostscript を商用製品に同梱する場合、  
> [Artifex 商用ライセンス](https://www.artifex.com/licensing/) の取得を検討してください。

---

## Linux 動作要件

### ✅ xdg-desktop-portal は不要

PDF小僧は `xdg-desktop-portal` を一切使用しません。  
ファイルダイアログは **GTK3 を直接使用** します。

### 必要なシステムライブラリ

```bash
# Ubuntu / Debian
sudo apt-get install \
  libgtk-3-0 \
  libwebkit2gtk-4.1-0 \
  libglib2.0-0 \
  libcairo2 \
  libpango-1.0-0

# Fedora / RHEL
sudo dnf install gtk3 webkit2gtk4.1 glib2 cairo pango

# Arch Linux
sudo pacman -S gtk3 webkit2gtk-4.1 glib2 cairo pango
```

### X11 での動作

```bash
# DISPLAY が設定されていれば自動検出
echo $DISPLAY   # :0 など
./pdf-kozou
```

追加インストール不要。`libX11` はほぼすべてのディストリに標準搭載。

### Wayland での動作

```bash
# WAYLAND_DISPLAY が設定されていれば自動検出
echo $WAYLAND_DISPLAY   # wayland-0 など
./pdf-kozou
```

GTK3 が Wayland ネイティブで動作します。XWayland 不要。

### X11/Wayland 両方ある環境

```
WAYLAND_DISPLAY=wayland-0
DISPLAY=:0
```

上記の場合、Wayland を優先 (XWayland も利用可能)。  
`GDK_BACKEND=x11` を設定することで X11 に強制できます。

### 環境変数リファレンス

| 変数                             | 値            | 効果                                |
| -------------------------------- | ------------- | ----------------------------------- |
| `GTK_USE_PORTAL`                 | `0`           | GTK がポータルを使わない (自動設定) |
| `GDK_BACKEND`                    | `wayland,x11` | バックエンドの優先順位を指定        |
| `GDK_BACKEND`                    | `x11`         | X11 に強制                          |
| `WEBKIT_DISABLE_DMABUF_RENDERER` | `1`           | 一部GPU環境での描画問題を回避       |
| `WAYLAND_DISPLAY`                | `wayland-0`   | Wayland ソケットを指定              |
| `DISPLAY`                        | `:0`          | X11 ディスプレイを指定              |

---

## 初期セットアップ

### バイナリのダウンロード

```bash
# Linux x86_64
./build-scripts/download-binaries.sh

# Windows (Git Bash)
./build-scripts/download-binaries.sh x86_64-pc-windows-msvc

# 特定ターゲットを指定
./build-scripts/download-binaries.sh aarch64-unknown-linux-gnu
```

### 開発サーバー起動

```bash
pnpm install
pnpm run tauri dev
```

### リリースビルド

```bash
pnpm run tauri build
```

---

## PDF 事前最適化について

すべての PDF 処理の前に以下の qpdf 処理を自動実行します:

```
qpdf --optimize-images \
     --object-streams=generate \
     --compress-streams=y \
     --decode-level=generalized \
     --linearize \
     input.pdf  optimized_tmp.pdf
```

**効果:**

- 重複オブジェクトをストリームに統合 → ファイルサイズ削減
- 画像の最適化 → 不要な高解像度データを削減
- クロスリファレンスを最新形式に更新 → 後続処理が高速・安定
- Linearize → Fast Web View 対応

処理後の一時ファイルは OS の temp ディレクトリに生成され、
処理完了後に自動削除されます。
