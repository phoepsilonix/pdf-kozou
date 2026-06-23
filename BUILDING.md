# ビルドガイド

## 必要環境

### 共通

| ツール               | バージョン | 用途                       |
| -------------------- | ---------- | -------------------------- |
| Rust                 | 1.75 以上  | コンパイラ                 |
| C/C++ ツールチェーン | —          | mupdf-sys のビルド         |
| cmake                | 3.15 以上  | mupdf-sys のビルドシステム |
| clang / LLVM         | —          | bindgen (FFI 自動生成)     |

### Linux (Debian / Ubuntu 系)

```bash
sudo apt install build-essential cmake clang libclang-dev pkg-config \
    libfreetype6-dev libharfbuzz-dev libjpeg-dev libopenjp2-7-dev \
    libgumbo-dev libmujs-dev
```

### macOS

未調整

```bash
xcode-select --install
brew install cmake llvm
```

### Windows

**cargoでビルドできます。(x86_64-pc-windows-gnu)  
**msvcターゲットの場合、cargo-xwin でできるかもしれません。未調整。できないかも。  
詳しくは[WINDOWS_BUILD.md](WINDOWS_BUILD.md)をご覧ください。

```sh
OS="mingw" HAVE_OBJCOPY="no" USE_MAKE=1 cargo build --release -p pdf-kozou-core --target x86_64-pc-windows-gnu
```

通常の Windows 環境でビルドする場合:

- [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) をインストール
- cmake と LLVM (clang) を PATH に追加
- node.jsなどをインストール
- make,bashなども用意。

---

## CLI のビルド

```bash
git clone https://github.com/phoepsilonix/pdf-kozou.git
cd pdf-kozou

# デバッグビルド
cargo build -p pdf-kozou-core

# リリースビルド
cargo build --release -p pdf-kozou-core

# 動作確認
./target/release/pdf-kozou-core --help
```

---

## GUI (Tauri) のビルド

### 追加要件

| ツール      | 用途                      |
| ----------- | ------------------------- |
| Node.js 18+ | フロントエンドのビルド    |
| npm / pnpm  | パッケージ管理            |
| Tauri CLI   | `cargo install tauri-cli` |

### Linux 追加パッケージ

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
    librsvg2-dev patchelf
```

### ビルド手順

```bash
# フロントエンド依存のインストール
npm install

# 開発モード起動
npm run tauri:dev

# リリースビルド
npm run build
```

---

## クロスコンパイル

### Linux → Windows (cargo-xwin 推奨)

cargoでビルドできます。MSVCターゲットは未調整。
[cargo-xwin](https://github.com/rust-cross/cargo-xwin)でできるかも。
Windowsでのビルド推奨。Linuxでビルドできても、一部で機能不全が起きるかもしれません。
makeコマンドが必要です。環境変数OSはLinux以外ならなんでもいいです。OBJCOPYがないことを明示してください。

```bash
# インストール
cargo install cargo-xwin

# ビルド
USE_MAKE=1 OS=mingw HAVE_OBJCOPY=no cargo build --release -p pdf-kozou-core --target x86_64-pc-windows-gnu
```

MSVCターゲット未調整。できないかも。

```
USE_MAKE=1 OS=mingw HAVE_OBJCOPY=no cargo xwin build --release -p pdf-kozou-core --target x86_64-pc-windows-msvc
```

### Linux → Linux (別アーキテクチャ)

```bash
# cross をインストール (Docker が必要)
cargo install cross

# aarch64 Linux 向けビルド
cross build --release -p pdf-kozou-core --target aarch64-unknown-linux-gnu
```

---

## GitHub Actions での CI/CD

未調整。
`.github/workflows/release.yml` の例:

```yaml
jobs:
  build-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: sudo apt install cmake clang libclang-dev pkg-config
      - run: cargo build --release -p pdf-kozou-core

  build-windows:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: x86_64-pc-windows-msvc
      - run: cargo install cargo-xwin
      - run: cargo xwin build --release -p pdf-kozou-core --target x86_64-pc-windows-msvc
```

---

## トラブルシューティング

### `bindgen` が失敗する

```
error: failed to run custom build command for `mupdf-sys`
```

clang が見つからない場合に発生します。

```bash
# Linux
sudo apt install libclang-dev clang

# macOS
export LIBCLANG_PATH=$(brew --prefix llvm)/lib
```

### cmake が見つからない

```bash
# Linux
sudo apt install cmake

# macOS
brew install cmake

# Windows (cargo-xwin 使用時は自動解決されます)
```

### Windows で MSVC のエラー

`cargo-xwin` を使うと Linux 環境から MSVC ABI でビルドでき、ほとんどの問題を回避できます。  
ただmupdf-sysは、link.exeも必要で、うまくいかないと思います。特にクロスビルドは難しいと思います。  
また、すべての他のライブラリも含めてビルドできないと、最終的にリンクできないので、調整できていません。  
ネイティブ Windows ビルドの場合は Visual Studio Build Tools と cmake の PATH 設定を確認してください。
MSVCターゲットは未調整、未確認です。
作者はWindows上で、x86_64-pc-windows-gnuでのビルドのみ確認済みです。
