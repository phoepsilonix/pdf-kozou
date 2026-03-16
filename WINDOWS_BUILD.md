# PDF小僧 — Windows ビルド方法

## 方法1: cargo-xwin (推奨・Linux/macOSから)

最も簡単なクロスコンパイル方法。

```bash
# 前提: cargo-xwin + LLVM インストール
cargo install cargo-xwin
# LLVM (Ubuntu)
sudo apt install llvm clang lld

# ターゲット追加
rustup target add x86_64-pc-windows-msvc

# ビルド
cd pdf-kozou
#USE_MAKE=1 OS=mingw XCFLAGS="-UHAVE_OBJCOPY" HAVE_OBJCOPY=no
OS=mingw HAVE_OBJCOPY=no USE_MAKE=1 cargo xwin build --release --target x86_64-pc-windows-msvc -p pdf-kozou-core

# Tauri アプリのビルド
PDF_KOZOU_CORE=./target/x86_64-pc-windows-msvc/release/pdf-kozou-core.exe \
cargo-xwin tauri build --target x86_64-pc-windows-msvc
```

> 初回実行時に Windows SDK (~3GB) を自動ダウンロードします。

# NSISインストーラー
クロスビルドは無理だと考える。
```sh
npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc
```
```sh
bun tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

---

## 方法2: cross (Docker ベース)
おそらく、これも無理。
Docker が使える環境向け。
```bash
cargo install cross --git https://github.com/cross-rs/cross

# cross.toml を作成
cat > Cross.toml << 'TOML'
[target.x86_64-pc-windows-gnu]
image = "ghcr.io/cross-rs/x86_64-pc-windows-gnu:main"
TOML

cross build --release --target x86_64-pc-windows-gnu -p pdf-kozou-core
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
現実的
Windows 環境で直接ビルドする場合。

```powershell
# 前提: Visual Studio Build Tools + Rust + Node.js 20

# リポジトリをクローン
git clone <repo>
cd pdf-kozou/pdf-kozou

# 依存インストール
npm install

# コアをビルド
cargo build --release -p pdf-kozou-core

# Tauri アプリビルド
$env:PDF_KOZOU_CORE=".\target\release\pdf-kozou-core.exe"
cargo tauri build
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
- 静的リンクのため DLL 配布不要
- MSVC (cargo-xwin) と MinGW (cross) 両方でビルド可能

## アイコン差し替え

```bash
# 選択したアイコンの SVG を指定して Tauri アイコン一式を生成
cargo tauri icon path/to/chosen-icon.svg
# → src-tauri/icons/ に各サイズが自動生成される
```
