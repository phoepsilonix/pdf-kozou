# PDF小僧 — Windows ビルド方法

xwin不要。
rustの基本機能でOK。
クロスコンパイルはインストーラーのビルドが無理なので、Windowsでビルドするべき。
Windowsにrust,make,mingw(gcc) or llvm(clang)、そしてmakensis.exeもインストールする。
GIT Bashなどで、ターゲットアーキテクチャはx86_64-pc-windows-gnuでビルドを行う。
msvc,nmakeは用いない。

# ビルド
cd pdf-kozou
#USE_MAKE=1 OS=mingw XCFLAGS="-UHAVE_OBJCOPY"

```sh
OS="mingw" HAVE_OBJCOPY="no" USE_MAKE=1 cargo build --release --target x86_64-pc-windows-gnu -p pdf-kozou-core
```

# Tauri アプリのビルド
#PDF_KOZOU_CORE=./target/x86_64-pc-windows-gnu/release/pdf-kozou-core.exe \

```sh
OS="mingw" HAVE_OBJCOPY="no" USE_MAKE=1 cargo tauri build --target x86_64-pc-windows-gnu
```


## 方法1: cargo (推奨・Linux/macOSから)

クロスコンパイル方法。xwin,cross不要。なくてもrustのツールチェインでクロスビルド可能。

# ターゲット追加
rustup target add x86_64-pc-windows-gnu

# ビルド
```sh
cd pdf-kozou
#USE_MAKE=1 OS=mingw XCFLAGS="-UHAVE_OBJCOPY"
OS=mingw HAVE_OBJCOPY=no USE_MAKE=1 cargo build --release --target x86_64-pc-windows-gnu -p pdf-kozou-core

# Tauri アプリのビルド
#PDF_KOZOU_CORE=./target/x86_64-pc-windows-gnu/release/pdf-kozou-core.exe \
OS="mingw" HAVE_OBJCOPY="no" USE_MAKE=1 cargo tauri build --target x86_64-pc-windows-gnu
```

> 初回実行時に Windows SDK (~3GB) を自動ダウンロードします。

# NSISインストーラー
クロスビルドは無理。makensis.exeを実行できない。
```sh
npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc
```
```sh
bun tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

---

## 方法3: GitHub Actions (CI/CD)

`.github/workflows/release.yml` でビルドを自動化する。

```yaml
name: Release
on:
  push:
    tags: ['v*']
jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
        working-directory: pdf-kozou
      - run: |
          cd pdf-kozou
          cargo build --release -p pdf-kozou-core
          $env:PDF_KOZOU_CORE="./target/release/pdf-kozou-core.exe"
          cargo tauri build
        shell: pwsh
      - uses: actions/upload-artifact@v4
        with:
          name: pdf-kozou-windows
          path: pdf-kozou/src-tauri/target/release/bundle/
```

---

## 方法4: Windows 上でネイティブビルド
これが現実的。
Windows 環境で直接ビルドする場合。
パス解釈でのトラブルを防止するためGIT Bashなどを用いてビルド。

```sh
# 前提: Visual Studio Build Tools + Rust + Node.js 20

# リポジトリをクローン
git clone <repo>
cd pdf-kozou/pdf-kozou

# 依存インストール
npm install

# コアをビルド
OS=mingw HAVE_OBJCOPY=no USE_MAKE=1 cargo build --release --target x86_64-pc-windows-gnu -p pdf-kozou-core

# Tauri アプリビルド
OS=mingw HAVE_OBJCOPY=no USE_MAKE=1 cargo tauri build --target x86_64-pc-windows-gnu 
```

### 成果物

```
src-tauri/target/release/bundle/
├── msi/          ← Windows インストーラー (.msi)
└── nsis/         ← NSIS インストーラー (.exe)
```

---

## MuPDF の Windows 対応

mupdf-sys 0.6.0 は Linux/macOS/Windows 全対応。
- WebView2がインストールされていない環境では、インストールが必要だが、それ以外は不要。
- exe自体のクロスビルドは可能になったが、インストーラーのクロスビルドは無理。

## ToDo
### アイコン差し替え

```bash
# 選択したアイコンの SVG を指定して Tauri アイコン一式を生成
cargo tauri icon path/to/chosen-icon.svg
# → src-tauri/icons/ に各サイズが自動生成される
```
