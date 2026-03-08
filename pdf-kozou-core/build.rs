// build.rs — mupdf_safe.c をコンパイルして静的ライブラリにリンクする
//
// ヘッダバージョンの問題:
//   mupdf-sys の out/build/include は古い 1.22.2 のまま残っている場合がある。
//   実際にリンクされるライブラリは 1.27.x なので、ヘッダも 1.27.x を使う必要がある。
//
// ヘッダパスの探索順 (バージョン一致を優先):
//   1. 環境変数 MUPDF_INCLUDE_DIR (明示指定)
//   2. mupdf-sys クレートのソース内ヘッダ (cargo registry キャッシュ)
//      ~/.cargo/registry/src/.../mupdf-sys-0.6.0/mupdf/include
//   3. システムパス /usr/include
//   4. out/build/include (最終フォールバック、バージョンが古い可能性あり)

use std::{env, path::{Path, PathBuf}};

fn main() {
    println!("cargo:rerun-if-changed=src/c/mupdf_safe.c");
    println!("cargo:rerun-if-env-changed=MUPDF_INCLUDE_DIR");

    let mupdf_include = find_mupdf_include();
    println!("cargo:warning=kozou build: mupdf include = {}", mupdf_include.display());

    // ヘッダのバージョンを警告表示
    let version_h = mupdf_include.join("mupdf/fitz/version.h");
    if let Ok(content) = std::fs::read_to_string(&version_h) {
        for line in content.lines() {
            if line.contains("FZ_VERSION \"") {
                println!("cargo:warning=kozou build: header version = {line}");
                break;
            }
        }
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

    // 2. mupdf-sys クレートのソース内ヘッダ (cargo registry キャッシュ)
    //    OUT_DIR から CARGO_HOME を逆算するか、HOME から探す
    if let Some(p) = find_mupdf_sys_source_include() {
        println!("cargo:warning=kozou build: using mupdf-sys source headers");
        return p;
    }

    // 3. システムパス /usr/include
    let sys = PathBuf::from("/usr/include");
    if sys.join("mupdf/fitz.h").exists() {
        println!("cargo:warning=kozou build: using system /usr/include");
        return sys;
    }

    // 4. out/build/include (フォールバック、バージョン不一致の可能性あり)
    if let Ok(out_dir) = env::var("OUT_DIR") {
        let out_path = PathBuf::from(&out_dir);
        if let Some(build_dir) = out_path.parent().and_then(|p| p.parent()) {
            if let Some(inc) = search_mupdf_sys_out_include(build_dir) {
                println!("cargo:warning=kozou build: using out/build/include (may have version mismatch!)");
                return inc;
            }
        }
    }

    println!("cargo:warning=mupdf/fitz.h が見つかりません!");
    println!("cargo:warning=MUPDF_INCLUDE_DIR でヘッダパスを指定してください。");
    println!("cargo:warning=例: MUPDF_INCLUDE_DIR=~/.cargo/registry/src/.../mupdf-sys-0.6.0/mupdf/include");
    PathBuf::from("/nonexistent_please_set_MUPDF_INCLUDE_DIR")
}

/// cargo registry 内の mupdf-sys-*/mupdf/include を探す。
/// 複数バージョンがある場合は最も高いバージョンを返す。
fn find_mupdf_sys_source_include() -> Option<PathBuf> {
    let cargo_home = env::var("CARGO_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = env::var("HOME").unwrap_or_else(|_| "/root".into());
            PathBuf::from(home).join(".cargo")
        });

    let registry_src = cargo_home.join("registry/src");
    if !registry_src.exists() {
        return None;
    }

    // (semver_tuple, path) を収集して最高バージョンを選ぶ
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
            // "mupdf-sys-X.Y.Z" の形式
            if let Some(ver_str) = name_str.strip_prefix("mupdf-sys-") {
                let candidate = crate_dir.path().join("mupdf/include");
                if candidate.join("mupdf/fitz.h").exists() {
                    let ver = parse_semver(ver_str);
                    candidates.push((ver, candidate));
                }
            }
        }
    }

    // 最高バージョンを選択
    candidates.into_iter().max_by_key(|(ver, _)| *ver).map(|(_, path)| path)
}

/// "X.Y.Z" → (X, Y, Z) にパース。パース失敗は (0,0,0)
fn parse_semver(s: &str) -> (u64, u64, u64) {
    let mut parts = s.splitn(3, '.');
    let major = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let patch = parts.next().and_then(|x| x.trim_end_matches(|c: char| !c.is_numeric()).parse().ok()).unwrap_or(0);
    (major, minor, patch)
}

/// target/{profile}/build/ から mupdf-sys-*/out/build/include を探す (フォールバック用)
fn search_mupdf_sys_out_include(build_dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(build_dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.starts_with("mupdf-sys") && !name_str.starts_with("mupdf_sys") {
            continue;
        }
        for sub in &["out/build/include", "out/include", "include"] {
            let c = entry.path().join(sub);
            if c.join("mupdf/fitz.h").exists() {
                return Some(c);
            }
        }
    }
    None
}
