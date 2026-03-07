# インストールガイド

## CLI ツール (pdf-kozou-core)

### Linux

```bash
# tar.gz をダウンロードして展開
tar xzf pdf-kozou_linux_x64.tar.gz

# パスの通った場所に配置 (例)
sudo mv pdf-kozou-core /usr/local/bin/

# 動作確認
pdf-kozou-core --version
```

### Windows

1. `pdf-kozou_windows_x64.zip` をダウンロード
2. 任意のフォルダに展開 (例: `C:\tools\pdf-kozou\`)
3. `pdf-kozou-core.exe` のあるフォルダを**システムの環境変数 PATH** に追加
   - スタートメニュー →「環境変数を編集」→ Path → 新規
4. コマンドプロンプト / PowerShell で確認:
   ```
   pdf-kozou-core --version
   ```

### macOS

```bash
# tar.gz をダウンロードして展開
tar xzf pdf-kozou_macos_aarch64.tar.gz

# パスの通った場所に配置
sudo mv pdf-kozou-core /usr/local/bin/

# Gatekeeper の確認ダイアログが出た場合
xattr -d com.apple.quarantine /usr/local/bin/pdf-kozou-core

# 動作確認
pdf-kozou-core --version
```

---

## デスクトップ GUI

### Linux

```bash
# AppImage
chmod +x pdf-kozou_linux_x64.AppImage
./pdf-kozou_linux_x64.AppImage
```

### Windows

`pdf-kozou_windows_x64_setup.exe` を実行してインストーラの指示に従ってください。

### macOS

`pdf-kozou_macos.dmg` を開き、アプリケーションフォルダにドラッグしてください。

---

## Web 版 (計画中)

Web 版は GitHub Pages で提供予定です。ブラウザでアクセスするだけで使用でき、
初回アクセス後はオフラインでも動作します。

```
https://phoepsilonix.github.io/pdf-kozou/
```

**対応ブラウザ:** Chrome / Firefox / Safari (最新版)

**iOS / Android:** ホーム画面に追加するとアプリライクに使えます。

---

## cargo でインストール (開発者向け)

Rust 環境がある場合、cargo から直接インストールできます:

```bash
cargo install pdf-kozou-core
```

ビルドには cmake と clang が必要です。詳細は [BUILDING.md](BUILDING.md) を参照してください。

---

## アンインストール

### CLI

配置した `pdf-kozou-core` (または `pdf-kozou-core.exe`) を削除するだけです。

### cargo でインストールした場合

```bash
cargo uninstall pdf-kozou-core
```

### Windows インストーラ版

「設定」→「アプリ」→「pdf-kozou」→「アンインストール」
