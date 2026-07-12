// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// src-tauri/src/platform/android_saf_folder.rs
//
// 単一ファイル保存(結合・圧縮・トリミング等の「保存」ボタン)向けの、
// フォルダ単位アクセス (`ACTION_OPEN_DOCUMENT_TREE`) によるファイル名
// 衝突判定・上書き・自動リネームのためのブリッジ。
//
// なぜ必要か(`ACTION_CREATE_DOCUMENT` = 従来方式では不十分な理由):
//   - `ACTION_CREATE_DOCUMENT` は「新規作成」専用の API で、同名ファイルが
//     既にある場合にどう振る舞うか(上書き確認を出す/自動リネームする/
//     何もせず新規に別ドキュメントとして複製する)はプロバイダ実装次第で、
//     アプリ側からは検知も制御もできない
//   - `ACTION_CREATE_DOCUMENT` はファイル単体への作成要求であり、フォルダの
//     中身を列挙する権限を伴わないため、アプリ側で「この名前は既に存在する
//     か」を事前に判定したり、自前で連番リネーム(`sample (1).pdf`)を
//     行ったりすることができない
//
//   `ACTION_OPEN_DOCUMENT_TREE` でフォルダそのものへのアクセス権を得れば、
//   `DocumentFile` 経由でその中身を列挙・存在確認でき、上書き/別名保存/
//   自動リネームのいずれもプロバイダ実装に依存せずアプリ側で確実に制御
//   できる。
//
// 設計のポイント: Kotlin 側には「ファイルを探す/新規作成する」ところ
// までしかやらせず、実際のバイトコピーは既存の `finalize_pending_save`
// (tauri_plugin_fs 経由の汎用コピー)に完全に任せる。
// `find_file`/`create_file` が返す `content://` URI 文字列を
// `tauri_plugin_fs::FilePath::Url` として組み立てて `PendingSaves` に
// 登録すれば、以降のコミット/破棄/メタデータ編集後の再コミットは
// 既存の仕組みがそのまま使える(Kotlin 側にファイルコピーのロジックを
// 重複して持たせない)。
//
// Kotlin 側の実装は
//   gen/android/app/src/main/java/phoepsilonix/pdfkozou/SafFolderPlugin.kt
// にある。

use serde::{Deserialize, Serialize};
use tauri::{
    Manager,
    plugin::{Builder, PluginHandle, TauriPlugin},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PickFolderResponse {
    tree_uri: Option<String>,
    folder_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FindFileArgs<'a> {
    tree_uri: &'a str,
    file_name: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindFileResponse {
    uri: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateFileArgs<'a> {
    tree_uri: &'a str,
    file_name: &'a str,
    mime_type: Option<&'a str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateFileResponse {
    uri: String,
    display_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListFolderNamesArgs<'a> {
    tree_uri: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListFolderNamesResponse {
    names: Vec<String>,
}

/// ユーザーが選んだ保存先フォルダ。`tree_uri` は次回以降の存在確認・
/// 保存呼び出しにそのまま使い回せる(`takePersistableUriPermission` 済み)。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFolder {
    pub tree_uri: String,
    pub folder_name: String,
}

/// 新規作成したファイルの情報。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedFile {
    pub uri: String,
    pub display_name: String,
}

/// Kotlin 側の `SafFolderPlugin` へのハンドル。
pub struct KozouSafFolder(PluginHandle<tauri::Wry>);

impl KozouSafFolder {
    /// `ACTION_OPEN_DOCUMENT_TREE` でフォルダを選ばせる。
    /// ユーザーがキャンセルした場合は `Ok(None)`。
    pub fn pick_folder(&self) -> Result<Option<PickedFolder>, String> {
        let resp = self
            .0
            .run_mobile_plugin::<PickFolderResponse>("pickFolder", ())
            .map_err(|e| e.to_string())?;
        match (resp.tree_uri, resp.folder_name) {
            (Some(tree_uri), Some(folder_name)) => Ok(Some(PickedFolder {
                tree_uri,
                folder_name,
            })),
            _ => Ok(None),
        }
    }

    /// 指定フォルダ内に同名ファイルが既に存在するか確認し、あればその
    /// `content://` URI を返す(上書き先として使う)。無ければ `None`。
    pub fn find_file(&self, tree_uri: &str, file_name: &str) -> Result<Option<String>, String> {
        let resp = self
            .0
            .run_mobile_plugin::<FindFileResponse>(
                "findFile",
                FindFileArgs {
                    tree_uri,
                    file_name,
                },
            )
            .map_err(|e| e.to_string())?;
        Ok(resp.uri)
    }

    /// 指定フォルダへ新規に空ファイルを作成する。呼び出し側が事前に
    /// 一意な名前であることを保証すること(このメソッド自体は重複
    /// チェックしない)。
    pub fn create_file(
        &self,
        tree_uri: &str,
        file_name: &str,
        mime_type: Option<&str>,
    ) -> Result<CreatedFile, String> {
        let resp = self
            .0
            .run_mobile_plugin::<CreateFileResponse>(
                "createFile",
                CreateFileArgs {
                    tree_uri,
                    file_name,
                    mime_type,
                },
            )
            .map_err(|e| e.to_string())?;
        Ok(CreatedFile {
            uri: resp.uri,
            display_name: resp.display_name,
        })
    }

    /// 指定フォルダ直下のファイル名一覧を返す(バッチ出力の事前衝突判定
    /// 用)。出力ファイル数だけ `find_file` を繰り返すと
    /// `O(出力件数 × フォルダ内ファイル数)` になってしまうため、一度だけ
    /// 列挙してフロント側でまとめて突き合わせる。
    pub fn list_folder_names(&self, tree_uri: &str) -> Result<Vec<String>, String> {
        let resp = self
            .0
            .run_mobile_plugin::<ListFolderNamesResponse>(
                "listFolderNames",
                ListFolderNamesArgs { tree_uri },
            )
            .map_err(|e| e.to_string())?;
        Ok(resp.names)
    }
}

/// アプリのパッケージに置いた `SafFolderPlugin` クラスをネイティブ
/// プラグインとして登録する。
pub fn kozou_saf_folder_plugin() -> TauriPlugin<tauri::Wry> {
    Builder::new("kozou-saf-folder")
        .setup(|app, api| {
            let handle = api.register_android_plugin("phoepsilonix.pdfkozou", "SafFolderPlugin")?;
            app.manage(KozouSafFolder(handle));
            Ok(())
        })
        .build()
}
