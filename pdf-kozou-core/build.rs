// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// build.rs — mupdf_safe.c をコンパイルして静的ライブラリにリンクする
//
// ヘッダバージョンの問題:
//   patch.crates-io で fork した mupdf-sys を使うと、
//   cargo registry のキャッシュ (mupdf-sys-0.6.0) が古いバージョンを持つ。
//   実際にリンクされるライブラリは fork 版 (例: 1.28.x) なので、
//   ヘッダも fork 版に合わせる必要がある。
//
// ヘッダパスの探索順:
//   1. 環境変数 MUPDF_INCLUDE_DIR (明示指定)
//   2. out/build/include — mupdf-sys がビルド時に生成するヘッダ
//      (patch.crates-io / git checkout 版はここに 1.28.x が入る)
//      target/{profile}/build/mupdf-sys-*/out/build/include
//   3. CARGO_HOME/git/checkouts — git で指定した fork のソースヘッダ
//      ~/.cargo/git/checkouts/mupdf-rs-*/*/mupdf-sys/mupdf/include
//   4. cargo registry ソースヘッダ (最高バージョン優先)
//      ~/.cargo/registry/src/.../mupdf-sys-X.Y.Z/mupdf/include
//   5. システムパス /usr/include

use std::{
    env,
    path::{Path, PathBuf},
};

fn main() {
    println!("cargo:rerun-if-changed=src/c/mupdf_safe.c");
    println!("cargo:rerun-if-env-changed=MUPDF_INCLUDE_DIR");

    let mupdf_include = find_mupdf_include();
    println!(
        "cargo:warning=kozou build: mupdf include = {}",
        mupdf_include.display()
    );

    // 実際に使うヘッダのバージョンを警告表示
    let version_h = mupdf_include.join("mupdf/fitz/version.h");
    if let Ok(content) = std::fs::read_to_string(&version_h) {
        for line in content.lines() {
            if line.contains("FZ_VERSION \"") {
                println!("cargo:warning=kozou build: header version = {line}");
                break;
            }
        }
    }
    //let target_os  = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    //let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    // let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    // let target      = env::var("TARGET").unwrap_or_default();
    if cfg!(target_os = "windows") && cfg!(target_env = "gnu") {
        println!("cargo:rustc-link-arg=--disable-auto-image-base");
    }

    cc::Build::new()
        .file("src/c/mupdf_safe.c")
        .include(&mupdf_include)
        .opt_level(2)
        .std("c99")
        .warnings(false)
        .compile("kozou_mupdf_safe");
}

fn find_mupdf_include() -> PathBuf {
    // 1. 環境変数 MUPDF_INCLUDE_DIR
    if let Ok(dir) = env::var("MUPDF_INCLUDE_DIR") {
        let p = PathBuf::from(&dir);
        if p.join("mupdf/fitz.h").exists() {
            println!("cargo:warning=kozou build: using MUPDF_INCLUDE_DIR");
            return p;
        }
        println!("cargo:warning=MUPDF_INCLUDE_DIR={dir} に fitz.h がありません (スキップ)");
    }

    // 2. out/build/include — patch.crates-io / git 版の mupdf-sys がビルド時に生成するヘッダ
    //    これがリンクされるライブラリと必ず一致するため最も信頼性が高い
    if let Ok(out_dir) = env::var("OUT_DIR") {
        let out_path = PathBuf::from(&out_dir);
        // OUT_DIR = target/{profile}/build/pdf-kozou-core-HASH/out
        // mupdf-sys の out は   target/{profile}/build/mupdf-sys-HASH/out
        // 共通の親は           target/{profile}/build/
        if let Some(build_dir) = out_path
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            && let Some(inc) = search_mupdf_sys_out_include(build_dir)
        {
            println!("cargo:warning=kozou build: using out/build/include (patch/git build)");
            return inc;
        }
    }

    // 3. CARGO_HOME/git/checkouts — patch.crates-io の git 指定 fork のソースヘッダ
    //    out/build が存在しない場合のフォールバック
    if let Some(p) = find_mupdf_sys_git_include() {
        println!("cargo:warning=kozou build: using git checkout source headers");
        return p;
    }

    // 4. cargo registry ソースヘッダ (最高バージョン優先)
    if let Some(p) = find_mupdf_sys_registry_include() {
        println!("cargo:warning=kozou build: using registry source headers");
        return p;
    }

    // 5. システムパス /usr/include
    let sys = PathBuf::from("/usr/include");
    if sys.join("mupdf/fitz.h").exists() {
        println!("cargo:warning=kozou build: using system /usr/include");
        return sys;
    }

    println!("cargo:warning=mupdf/fitz.h が見つかりません!");
    println!("cargo:warning=MUPDF_INCLUDE_DIR でヘッダパスを指定してください。");
    println!(
        "cargo:warning=例: MUPDF_INCLUDE_DIR=~/.cargo/git/checkouts/mupdf-rs-.../mupdf-sys/mupdf/include"
    );
    PathBuf::from("/nonexistent_please_set_MUPDF_INCLUDE_DIR")
}

/// target/{profile}/build/ 以下の mupdf-sys-*/out/build/include を探す。
/// 複数ある場合はヘッダの FZ_VERSION が最も高いものを選ぶ。
fn search_mupdf_sys_out_include(build_dir: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<((u64, u64, u64), PathBuf)> = Vec::new();

    let entries = std::fs::read_dir(build_dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.starts_with("mupdf-sys") && !name_str.starts_with("mupdf_sys") {
            continue;
        }
        for sub in &["out/build/include", "out/include", "include"] {
            let c = entry.path().join(sub);
            if c.join("mupdf/fitz/version.h").exists() || c.join("mupdf/fitz.h").exists() {
                let ver = read_fz_version(&c);
                candidates.push((ver, c));
                break;
            }
        }
    }

    candidates
        .into_iter()
        .max_by_key(|(ver, _)| *ver)
        .map(|(_, p)| p)
}

/// CARGO_HOME/git/checkouts 以下の mupdf-sys/mupdf/include を探す。
/// patch.crates-io で git リポジトリを指定した場合にここに展開される。
/// 複数ある場合はヘッダバージョンが最も高いものを選ぶ。
fn find_mupdf_sys_git_include() -> Option<PathBuf> {
    let cargo_home = cargo_home_path();
    let git_checkouts = cargo_home.join("git/checkouts");
    if !git_checkouts.exists() {
        return None;
    }

    let mut candidates: Vec<((u64, u64, u64), PathBuf)> = Vec::new();

    // git/checkouts/REPO-HASH/COMMIT/ の構造
    let repo_dirs = std::fs::read_dir(&git_checkouts).ok()?;
    for repo_dir in repo_dirs.flatten() {
        // "mupdf" を名前に含むリポジトリのみ
        let repo_name = repo_dir.file_name();
        let repo_name_str = repo_name.to_string_lossy().to_lowercase();
        if !repo_name_str.contains("mupdf") {
            continue;
        }
        // commit ディレクトリを列挙
        let commit_dirs = match std::fs::read_dir(repo_dir.path()) {
            Ok(d) => d,
            Err(_) => continue,
        };
        for commit_dir in commit_dirs.flatten() {
            if !commit_dir.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            // mupdf-sys/mupdf/include または mupdf/include
            for sub_path in &["mupdf-sys/mupdf/include", "mupdf/include"] {
                let c = commit_dir.path().join(sub_path);
                if c.join("mupdf/fitz.h").exists() {
                    let ver = read_fz_version(&c);
                    candidates.push((ver, c));
                    break;
                }
            }
        }
    }

    candidates
        .into_iter()
        .max_by_key(|(ver, _)| *ver)
        .map(|(_, p)| p)
}

/// cargo registry 内の mupdf-sys-*/mupdf/include を探す。
/// 複数バージョンがある場合は最も高いバージョンを返す。
fn find_mupdf_sys_registry_include() -> Option<PathBuf> {
    let registry_src = cargo_home_path().join("registry/src");
    if !registry_src.exists() {
        return None;
    }

    let mut candidates: Vec<((u64, u64, u64), PathBuf)> = Vec::new();

    let index_dirs = std::fs::read_dir(&registry_src).ok()?;
    for index_dir in index_dirs.flatten() {
        if !index_dir.file_type().ok()?.is_dir() {
            continue;
        }
        let crate_dirs = std::fs::read_dir(index_dir.path()).ok()?;
        for crate_dir in crate_dirs.flatten() {
            let name = crate_dir.file_name();
            let name_str = name.to_string_lossy();
            if let Some(ver_str) = name_str.strip_prefix("mupdf-sys-") {
                let candidate = crate_dir.path().join("mupdf/include");
                if candidate.join("mupdf/fitz.h").exists() {
                    let ver = parse_semver(ver_str);
                    candidates.push((ver, candidate));
                }
            }
        }
    }

    candidates
        .into_iter()
        .max_by_key(|(ver, _)| *ver)
        .map(|(_, path)| path)
}

/// ヘッダディレクトリから FZ_VERSION を読み取って semver タプルに変換する。
/// 読み取れない場合は (0,0,0)。
fn read_fz_version(include_dir: &Path) -> (u64, u64, u64) {
    let version_h = include_dir.join("mupdf/fitz/version.h");
    if let Ok(content) = std::fs::read_to_string(&version_h) {
        for line in content.lines() {
            // #define FZ_VERSION "1.28.0"
            if line.contains("FZ_VERSION \"")
                && let Some(start) = line.rfind('"')
            {
                let rest = &line[..start];
                if let Some(ver_start) = rest.rfind('"') {
                    let ver_str = &rest[ver_start + 1..];
                    return parse_semver(ver_str);
                }
            }
        }
    }
    (0, 0, 0)
}

/// CARGO_HOME のパスを返す。
fn cargo_home_path() -> PathBuf {
    env::var("CARGO_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = env::var("HOME").unwrap_or_else(|_| "/root".into());
            PathBuf::from(home).join(".cargo")
        })
}

/// "X.Y.Z" → (X, Y, Z) にパース。パース失敗は (0,0,0)。
fn parse_semver(s: &str) -> (u64, u64, u64) {
    let mut parts = s.splitn(3, '.');
    let major = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let patch = parts
        .next()
        .and_then(|x| {
            x.trim_end_matches(|c: char| !c.is_ascii_digit())
                .parse()
                .ok()
        })
        .unwrap_or(0);
    (major, minor, patch)
}
