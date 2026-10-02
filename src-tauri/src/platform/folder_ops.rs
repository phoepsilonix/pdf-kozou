// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/platform/folder_ops.rs
//
// iOS: ユーザーが選んだ保存先フォルダ(security-scoped、Objective-C側がアクセスを保持)
// に対する、衝突判定・サブフォルダ作成・コピーの操作。
//
// OS 固有の API は使わず std のみで実装しているため、デスクトップ上で単体テスト
// できる(実際に呼ばれるのは iOS のみ)。

use std::path::{Component, Path, PathBuf};

/// フォルダ直下の名前(ファイル・サブフォルダ)として使える、区切り文字を含まない
/// 1要素の名前であることを確認する(`..` や `a/b` を拒否)。
fn single_component(name: &str, what: &str) -> Result<(), String> {
    let mut comps = Path::new(name).components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(_)), None) => Ok(()),
        _ => Err(format!("{what} が不正です: {name}")),
    }
}

/// フォルダ直下のエントリ名の一覧(ファイル・サブフォルダ)。
/// 保存前の同名ファイル衝突判定に使う。フォルダが読めない(アクセス権失効・
/// 削除など)場合はエラーを返す。
pub fn list_folder_names(dir: &Path) -> Result<Vec<String>, String> {
    let rd = std::fs::read_dir(dir)
        .map_err(|e| format!("フォルダを読み取れません ({}): {e}", dir.display()))?;
    let mut names = Vec::new();
    for ent in rd {
        let ent = ent.map_err(|e| format!("フォルダの列挙に失敗しました: {e}"))?;
        names.push(ent.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    Ok(names)
}

/// `base` 直下に `name` というサブフォルダを用意して(無ければ作成)そのパスを返す。
pub fn get_or_create_subfolder(base: &Path, name: &str) -> Result<PathBuf, String> {
    single_component(name, "サブフォルダ名")?;
    let dir = base.join(name);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("サブフォルダの作成に失敗しました ({}): {e}", dir.display()))?;
    Ok(dir)
}

/// `source` を `folder/target_name` へコピーする。
/// `overwrite == false` で同名が既にある場合は上書きせずエラーにする
/// (呼び出し側が衝突解決済みで一意な名前を渡す前提のため、通常は起きない)。
pub fn copy_entry(
    folder: &Path,
    source: &Path,
    target_name: &str,
    overwrite: bool,
) -> Result<PathBuf, String> {
    single_component(target_name, "保存ファイル名")?;
    let dest = folder.join(target_name);
    if !overwrite && dest.exists() {
        return Err(format!("同名のファイルが既に存在します: {target_name}"));
    }
    std::fs::copy(source, &dest).map_err(|e| {
        format!(
            "保存に失敗しました ({} → {}): {e}",
            source.display(),
            dest.display()
        )
    })?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "kozou_batch_copy_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    #[test]
    fn folder_helpers_list_create_and_copy() {
        let root = scratch("folder");
        let dest = root.join("picked");
        let src = root.join("src.pdf");
        fs::create_dir_all(&dest).unwrap();
        write(&src, "S");
        write(&dest.join("exists.pdf"), "E");

        let names = list_folder_names(&dest).unwrap();
        assert_eq!(names, vec!["exists.pdf".to_string()]);
        assert!(list_folder_names(&root.join("nope")).is_err());

        let sub = get_or_create_subfolder(&dest, "invoice1").unwrap();
        assert!(sub.is_dir());
        // 2回目も成功(既存でも可)
        assert_eq!(get_or_create_subfolder(&dest, "invoice1").unwrap(), sub);
        assert!(get_or_create_subfolder(&dest, "../x").is_err());
        assert!(get_or_create_subfolder(&dest, "a/b").is_err());

        let out = copy_entry(&sub, &src, "page_001.pdf", false).unwrap();
        assert_eq!(fs::read_to_string(out).unwrap(), "S");
        // 上書きなしで同名 → エラー、上書きありなら成功
        assert!(copy_entry(&sub, &src, "page_001.pdf", false).is_err());
        write(&src, "S2");
        copy_entry(&sub, &src, "page_001.pdf", true).unwrap();
        assert_eq!(fs::read_to_string(sub.join("page_001.pdf")).unwrap(), "S2");
        assert!(copy_entry(&sub, &src, "../esc.pdf", true).is_err());
        assert!(!dest.join("esc.pdf").exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
