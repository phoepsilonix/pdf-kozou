#!/usr/bin/env bash
# =============================================================================
# build-scripts/download-binaries.sh
#
# PDF小僧 — オフライン同梱バイナリ ダウンロード & 配置
#
# 同梱ツール:
#   Ghostscript  (AGPL v3)  — 変換・圧縮・透かし・ページ番号
#   qpdf         (Apache 2) — 分割・結合・回転・暗号化・事前最適化
#   Poppler utils(GPL v2)   — pdftoppm / pdftotext / pdftohtml / pdftocairo
#   Tesseract    (Apache 2) — OCR + 言語データ (eng / jpn / jpn_vert)
#   PDFBox CLI   (Apache 2) — JVM不要なGraalVM native-image版
#
# Linux: xdg-desktop-portal 不要
#        X11 (libX11) / Wayland (libwayland-client) は OS の共有ライブラリを使用
#        GTK3 (libgtk-3) のみ同梱対象外 (各ディストリに標準搭載)
#
# 使用方法:
#   ./build-scripts/download-binaries.sh [TARGET_TRIPLE]
#   例: ./build-scripts/download-binaries.sh x86_64-unknown-linux-gnu
#       ./build-scripts/download-binaries.sh x86_64-pc-windows-msvc
#       ./build-scripts/download-binaries.sh aarch64-linux-android
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BINARIES_BASE="${PROJECT_ROOT}/src-tauri/binaries"

# ── カラーログ ──────────────────────────────────────────────────────────────
R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' C='\033[0;36m' N='\033[0m'
info()    { echo -e "${C}[INFO]${N}  $*"; }
ok()      { echo -e "${G}[ OK ]${N}  $*"; }
warn()    { echo -e "${Y}[WARN]${N}  $*"; }
die()     { echo -e "${R}[ERR ]${N}  $*" >&2; exit 1; }

# ── ターゲット自動検出 ───────────────────────────────────────────────────────
detect_target() {
    local arch; arch="$(uname -m)"
    case "$(uname -s)" in
        Linux)           echo "${arch}-unknown-linux-gnu" ;;
        Darwin)          echo "${arch}-apple-darwin" ;;
        MINGW*|MSYS*)    echo "x86_64-pc-windows-msvc" ;;
        *) die "Unknown OS: $(uname -s)" ;;
    esac
}
TARGET="${1:-$(detect_target)}"
DEST="${BINARIES_BASE}/${TARGET}"
mkdir -p "${DEST}"

info "Target : ${TARGET}"
info "Output : ${DEST}"
echo ""

# ── バージョン ───────────────────────────────────────────────────────────────
GS_VER="10.03.1"
QPDF_VER="11.9.1"
TESS_VER="5.4.1"
POPPLER_VER="24.08.0"

# ── ヘルパー ─────────────────────────────────────────────────────────────────
_curl() { curl -fsSL --retry 3 --retry-delay 2 "$@"; }

extract_tgz() {    # name url destdir [strip]
    local tmp; tmp="$(mktemp /tmp/pkz_XXXXXX.tar.gz)"
    info "Downloading $1 ..."
    _curl -o "${tmp}" "$2"
    tar -xzf "${tmp}" --strip-components="${4:-1}" -C "$3" 2>/dev/null || true
    rm -f "${tmp}"; ok "$1 extracted"
}
extract_zip() {    # name url destdir
    local tmp; tmp="$(mktemp /tmp/pkz_XXXXXX.zip)"
    info "Downloading $1 ..."
    _curl -o "${tmp}" "$2"
    unzip -q -o "${tmp}" -d "$3"
    rm -f "${tmp}"; ok "$1 extracted"
}
copy_exe() {       # src dst
    cp "$1" "$2"; chmod +x "$2"
}

# =============================================================================
#  Linux x86_64
# =============================================================================
install_linux_x86_64() {
    info "══ Linux x86_64 ══"

    # ── GTK3 の有無を確認 (同梱はしないが必要) ──────────────────────────────
    if ! ldconfig -p 2>/dev/null | grep -q "libgtk-3"; then
        warn "libgtk-3 が見つかりません。"
        warn "  Ubuntu/Debian: sudo apt-get install libgtk-3-0"
        warn "  Fedora:        sudo dnf install gtk3"
        warn "  Arch:          sudo pacman -S gtk3"
        warn "libgtk-3 は xdg-desktop-portal 不要でファイルダイアログに使用します。"
    fi

    # ── Ghostscript (静的ビルド済み) ────────────────────────────────────────
    local GS_URL="https://github.com/ArtifexSoftware/ghostpdl-builds/releases/download/gs${GS_VER//./}/ghostscript-${GS_VER}-linux-x86_64.tgz"
    local GS_TMP; GS_TMP="$(mktemp /tmp/pkz_gs_XXXXXX.tgz)"
    info "Downloading Ghostscript ${GS_VER} ..."
    if _curl -o "${GS_TMP}" "${GS_URL}" 2>/dev/null; then
        tar -xzf "${GS_TMP}" -C "${DEST}" --wildcards "*/gs*" --strip-components=1 2>/dev/null || true
        # gs-X.YY.Z → gs にリネーム
        local gsbin; gsbin="$(find "${DEST}" -name "gs-*" -o -name "gs" | head -1)"
        [[ -n "${gsbin}" ]] && mv "${gsbin}" "${DEST}/gs" && chmod +x "${DEST}/gs"
        rm -f "${GS_TMP}"; ok "Ghostscript ${GS_VER}"
    else
        warn "Ghostscript ダウンロード失敗 — システムの gs を使用します"
        local sys_gs; sys_gs="$(which gs 2>/dev/null || true)"
        [[ -n "${sys_gs}" ]] && copy_exe "${sys_gs}" "${DEST}/gs" && ok "gs (system)"
    fi

    # ── qpdf ────────────────────────────────────────────────────────────────
    local QPDF_URL="https://github.com/qpdf/qpdf/releases/download/v${QPDF_VER}/qpdf-${QPDF_VER}-bin-linux-x86_64.zip"
    local QPDF_TMP; QPDF_TMP="$(mktemp -d /tmp/pkz_qpdf_XXXXXX)"
    info "Downloading qpdf ${QPDF_VER} ..."
    if extract_zip "qpdf" "${QPDF_URL}" "${QPDF_TMP}" 2>/dev/null; then
        find "${QPDF_TMP}" -name "qpdf" -not -name "*.so" -type f \
            -exec cp {} "${DEST}/qpdf" \; 2>/dev/null || true
        chmod +x "${DEST}/qpdf" 2>/dev/null || true
        # 依存 .so をコピー (静的リンクされていない場合)
        find "${QPDF_TMP}" -name "*.so*" \
            -exec cp {} "${DEST}/" \; 2>/dev/null || true
        rm -rf "${QPDF_TMP}"; ok "qpdf ${QPDF_VER}"
    else
        local sys_qpdf; sys_qpdf="$(which qpdf 2>/dev/null || true)"
        [[ -n "${sys_qpdf}" ]] && copy_exe "${sys_qpdf}" "${DEST}/qpdf" && ok "qpdf (system)"
    fi

    # ── Poppler utils ────────────────────────────────────────────────────────
    info "Poppler utils のインストール ..."
    local POPPLER_BINS=(pdftoppm pdftotext pdftohtml pdftocairo pdfinfo pdfseparate pdfunite)
    local found_all=true
    for bin in "${POPPLER_BINS[@]}"; do
        local src; src="$(which "${bin}" 2>/dev/null || true)"
        if [[ -n "${src}" ]]; then
            copy_exe "${src}" "${DEST}/${bin}"; ok "${bin} (system)"
        else
            found_all=false
            warn "${bin} が見つかりません"
        fi
    done

    if [[ "${found_all}" == "false" ]]; then
        warn "Poppler の一部が見つかりませんでした。"
        warn "  Ubuntu/Debian: sudo apt-get install poppler-utils"
        warn "  Fedora:        sudo dnf install poppler-utils"
        warn "  Arch:          sudo pacman -S poppler"
        # deb から直接抽出を試みる
        info "Ubuntu deb から Poppler を抽出中 ..."
        local DEB_URL="http://archive.ubuntu.com/ubuntu/pool/main/p/poppler/poppler-utils_24.04.0-1ubuntu4_amd64.deb"
        local DEB_TMP; DEB_TMP="$(mktemp /tmp/pkz_poppler_XXXXXX.deb)"
        local DEB_EXTRACT; DEB_EXTRACT="$(mktemp -d /tmp/pkz_poppler_dir_XXXXXX)"
        if _curl -o "${DEB_TMP}" "${DEB_URL}" 2>/dev/null; then
            dpkg-deb -x "${DEB_TMP}" "${DEB_EXTRACT}" 2>/dev/null || true
            for bin in "${POPPLER_BINS[@]}"; do
                find "${DEB_EXTRACT}" -name "${bin}" -type f \
                    -exec cp {} "${DEST}/${bin}" \; 2>/dev/null || true
                [[ -f "${DEST}/${bin}" ]] && chmod +x "${DEST}/${bin}"
            done
        fi
        rm -rf "${DEB_TMP}" "${DEB_EXTRACT}"
    fi

    # ── Tesseract ────────────────────────────────────────────────────────────
    info "Tesseract OCR のインストール ..."
    local sys_tess; sys_tess="$(which tesseract 2>/dev/null || true)"
    if [[ -n "${sys_tess}" ]]; then
        copy_exe "${sys_tess}" "${DEST}/tesseract"; ok "tesseract (system)"
    else
        warn "tesseract が見つかりません。"
        warn "  Ubuntu/Debian: sudo apt-get install tesseract-ocr"
        warn "  Fedora:        sudo dnf install tesseract"
        warn "  Arch:          sudo pacman -S tesseract"
    fi

    # ── Tesseract 言語データ ─────────────────────────────────────────────────
    local TESSDATA="${DEST}/tessdata"
    mkdir -p "${TESSDATA}"
    local TESS_LANGS=(eng jpn jpn_vert osd)
    info "Tesseract 言語データをダウンロード ..."
    for lang in "${TESS_LANGS[@]}"; do
        local tdata_url="https://github.com/tesseract-ocr/tessdata_best/raw/main/${lang}.traineddata"
        local tdata_out="${TESSDATA}/${lang}.traineddata"
        if [[ ! -f "${tdata_out}" ]]; then
            if _curl -o "${tdata_out}" "${tdata_url}" 2>/dev/null; then
                ok "tessdata: ${lang}"
            else
                warn "tessdata: ${lang} ダウンロード失敗"
            fi
        else
            ok "tessdata: ${lang} (既存)"
        fi
    done

    ok "Linux x86_64 バイナリ配置完了"
}

# =============================================================================
#  Linux aarch64
# =============================================================================
install_linux_aarch64() {
    info "══ Linux aarch64 ══"
    warn "aarch64 の静的バイナリは自動ダウンロード非対応のため、"
    warn "システムのバイナリをコピーします。"
    local bins=(gs qpdf pdftoppm pdftotext pdftohtml pdftocairo tesseract)
    for bin in "${bins[@]}"; do
        local src; src="$(which "${bin}" 2>/dev/null || true)"
        if [[ -n "${src}" ]]; then
            copy_exe "${src}" "${DEST}/${bin}"; ok "${bin}"
        else
            warn "${bin} not found on PATH"
        fi
    done
    # tessdata 共通
    install_tessdata "${DEST}"
}

# =============================================================================
#  Windows x86_64
# =============================================================================
install_windows_x86_64() {
    info "══ Windows x86_64 ══"

    # ── Ghostscript ─────────────────────────────────────────────────────────
    local GS_URL="https://github.com/ArtifexSoftware/ghostpdl-builds/releases/download/gs${GS_VER//./}/gs${GS_VER//./}w64.exe"
    local GS_EXTRACT; GS_EXTRACT="$(mktemp -d /tmp/pkz_gs_win_XXXXXX)"
    info "Downloading Ghostscript ${GS_VER} (Windows) ..."
    # Ghostscript NSIS インストーラを 7z で展開
    local GS_INST; GS_INST="$(mktemp /tmp/pkz_gs_XXXXXX.exe)"
    if _curl -o "${GS_INST}" "${GS_URL}" 2>/dev/null; then
        if command -v 7z &>/dev/null; then
            7z x -o"${GS_EXTRACT}" "${GS_INST}" -y &>/dev/null || true
            find "${GS_EXTRACT}" -name "gswin64c.exe" \
                -exec cp {} "${DEST}/gs.exe" \; 2>/dev/null || true
            ok "Ghostscript ${GS_VER} (Windows)"
        else
            warn "7z が必要です: sudo apt-get install p7zip-full"
        fi
        rm -f "${GS_INST}"; rm -rf "${GS_EXTRACT}"
    fi

    # ── qpdf ────────────────────────────────────────────────────────────────
    local QPDF_WIN_URL="https://github.com/qpdf/qpdf/releases/download/v${QPDF_VER}/qpdf-${QPDF_VER}-bin-msvc64.zip"
    local QPDF_TMP; QPDF_TMP="$(mktemp -d /tmp/pkz_qpdf_win_XXXXXX)"
    info "Downloading qpdf ${QPDF_VER} (Windows) ..."
    if extract_zip "qpdf-win" "${QPDF_WIN_URL}" "${QPDF_TMP}" 2>/dev/null; then
        find "${QPDF_TMP}" -name "qpdf.exe" \
            -exec cp {} "${DEST}/qpdf.exe" \; 2>/dev/null || true
        find "${QPDF_TMP}" -name "*.dll" \
            -exec cp {} "${DEST}/" \; 2>/dev/null || true
        rm -rf "${QPDF_TMP}"; ok "qpdf ${QPDF_VER} (Windows)"
    fi

    # ── Poppler for Windows ──────────────────────────────────────────────────
    local POPPLER_WIN_URL="https://github.com/oschwartz10612/poppler-windows/releases/download/v${POPPLER_VER}-0/Release-${POPPLER_VER}-0.zip"
    local POPPLER_TMP; POPPLER_TMP="$(mktemp -d /tmp/pkz_poppler_win_XXXXXX)"
    info "Downloading Poppler ${POPPLER_VER} (Windows) ..."
    if extract_zip "poppler-win" "${POPPLER_WIN_URL}" "${POPPLER_TMP}" 2>/dev/null; then
        for bin in pdftoppm pdftotext pdftohtml pdftocairo pdfinfo; do
            find "${POPPLER_TMP}" -name "${bin}.exe" \
                -exec cp {} "${DEST}/${bin}.exe" \; 2>/dev/null || true
        done
        find "${POPPLER_TMP}" -name "*.dll" \
            -exec cp {} "${DEST}/" \; 2>/dev/null || true
        rm -rf "${POPPLER_TMP}"; ok "Poppler (Windows)"
    fi

    # ── Tesseract for Windows ────────────────────────────────────────────────
    local TESS_WIN_URL="https://github.com/UB-Mannheim/tesseract/releases/download/v${TESS_VER}.20231030/tesseract-ocr-w64-setup-${TESS_VER}.20231030.exe"
    local TESS_INST; TESS_INST="$(mktemp /tmp/pkz_tess_XXXXXX.exe)"
    local TESS_EXTRACT; TESS_EXTRACT="$(mktemp -d /tmp/pkz_tess_dir_XXXXXX)"
    info "Downloading Tesseract ${TESS_VER} (Windows) ..."
    if _curl -o "${TESS_INST}" "${TESS_WIN_URL}" 2>/dev/null; then
        if command -v 7z &>/dev/null; then
            7z x -o"${TESS_EXTRACT}" "${TESS_INST}" -y &>/dev/null || true
            find "${TESS_EXTRACT}" -name "tesseract.exe" \
                -exec cp {} "${DEST}/tesseract.exe" \; 2>/dev/null || true
            find "${TESS_EXTRACT}" -name "*.dll" \
                -exec cp {} "${DEST}/" \; 2>/dev/null || true
        fi
        rm -f "${TESS_INST}"; rm -rf "${TESS_EXTRACT}"
        ok "Tesseract (Windows)"
    fi

    install_tessdata "${DEST}"
    ok "Windows x86_64 バイナリ配置完了"
}

# =============================================================================
#  Android (aarch64) — クロスコンパイル済みバイナリ
# =============================================================================
install_android_aarch64() {
    info "══ Android aarch64 ══"
    warn "Android 向けバイナリは NDK でクロスコンパイルが必要です。"
    warn "CI の build-android.yml で自動ビルドされます。"
    warn "iOS 同様、App Store / Google Play の制約により sidecar は最小限です。"
    warn "主要処理は Pure Rust (lopdf) + WASM (qpdf-wasm, mupdf-wasm) を使用。"
    mkdir -p "${DEST}"
    ok "Android aarch64: 手動ビルドが必要"
}

# =============================================================================
#  Tesseract 言語データ共通インストール
# =============================================================================
install_tessdata() {
    local dest_dir="$1/tessdata"
    mkdir -p "${dest_dir}"
    local langs=(eng jpn jpn_vert osd chi_sim chi_tra kor deu fra)
    for lang in "${langs[@]}"; do
        local out="${dest_dir}/${lang}.traineddata"
        [[ -f "${out}" ]] && { ok "tessdata/${lang} (skip)"; continue; }
        local url="https://github.com/tesseract-ocr/tessdata_best/raw/main/${lang}.traineddata"
        if _curl -o "${out}" "${url}" 2>/dev/null; then
            ok "tessdata/${lang}"
        else
            warn "tessdata/${lang} ダウンロード失敗 (スキップ)"
            rm -f "${out}"
        fi
    done
}

# =============================================================================
#  バイナリ存在チェック & レポート
# =============================================================================
check_binaries() {
    echo ""
    info "══ インストール済みバイナリ確認 ══"
    local required=(gs qpdf pdftoppm pdftotext tesseract)
    local all_ok=true
    for bin in "${required[@]}"; do
        local names=("${bin}" "${bin}.exe")
        local found=false
        for name in "${names[@]}"; do
            if [[ -f "${DEST}/${name}" ]]; then
                local size; size="$(du -sh "${DEST}/${name}" 2>/dev/null | cut -f1)"
                ok "${name} (${size})"
                found=true; break
            fi
        done
        [[ "${found}" == "false" ]] && { warn "${bin}: NOT FOUND"; all_ok=false; }
    done

    echo ""
    if [[ "${all_ok}" == "true" ]]; then
        ok "すべての必須バイナリが揃いました。オフライン動作可能です。"
    else
        warn "一部バイナリが不足しています。該当機能はシステムインストールが必要です。"
    fi

    info "tessdata:"
    for f in "${DEST}/tessdata/"*.traineddata 2>/dev/null; do
        [[ -f "$f" ]] && ok "  $(basename "${f}")"
    done

    echo ""
    info "合計サイズ: $(du -sh "${DEST}" 2>/dev/null | cut -f1)"
}

# =============================================================================
#  メイン
# =============================================================================
case "${TARGET}" in
    x86_64-unknown-linux-gnu)   install_linux_x86_64 ;;
    aarch64-unknown-linux-gnu)  install_linux_aarch64 ;;
    x86_64-pc-windows-msvc|\
    x86_64-pc-windows-gnu)      install_windows_x86_64 ;;
    aarch64-linux-android)      install_android_aarch64 ;;
    *)
        warn "未対応のターゲット: ${TARGET}"
        warn "システムのバイナリを手動で ${DEST}/ に配置してください。"
        ;;
esac

check_binaries
