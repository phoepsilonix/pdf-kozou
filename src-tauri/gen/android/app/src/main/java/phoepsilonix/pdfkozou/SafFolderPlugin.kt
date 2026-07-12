// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------
//
// SafFolderPlugin.kt
//
// 単一ファイル保存(結合・圧縮・トリミング等)向けの、フォルダ単位アクセス
// (ACTION_OPEN_DOCUMENT_TREE) によるファイル名衝突判定・上書き・自動
// リネームのためのネイティブプラグイン。
//
// なぜ必要か:
//   これまでの ACTION_CREATE_DOCUMENT (単一ファイルの「新規作成」要求)は、
//   同名ファイルが既にある場合にどう振る舞うか(上書き確認/自動リネーム/
//   何もせず新規に別ドキュメントとして複製する)がプロバイダ実装に
//   委ねられており、アプリ側からは検知も制御もできなかった。また
//   フォルダの中身を列挙する権限を伴わないため、自前でのファイル名衝突
//   判定・連番リネームもできなかった。
//
//   ACTION_OPEN_DOCUMENT_TREE でフォルダそのものへのアクセス権を得れば、
//   DocumentFile 経由でその中身を列挙・存在確認でき、上書き/別名保存/
//   自動リネームのいずれもプロバイダ実装に依存せずアプリ側で確実に
//   制御できる。
//
// 設計方針:
//   実際のファイル内容のコピーはこのプラグインでは行わない。
//   findFile/createFile が返す content:// URI を Rust 側が
//   `tauri_plugin_fs::FilePath::Url` として扱い、既存の
//   `finalize_pending_save` (tauri-plugin-fs 経由の汎用コピー) が
//   バイトコピーを担う。ここでは「ファイルを探す/新規作成する」ところ
//   までしか行わない。

package phoepsilonix.pdfkozou

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import androidx.documentfile.provider.DocumentFile
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.IOException

@InvokeArg
class FindFileArgs {
  lateinit var treeUri: String
  lateinit var fileName: String
}

@InvokeArg
class CreateFileArgs {
  lateinit var treeUri: String
  lateinit var fileName: String
  var mimeType: String? = null
}

@InvokeArg
class ListFolderNamesArgs {
  lateinit var treeUri: String
}

@TauriPlugin
class SafFolderPlugin(private val activity: Activity) : Plugin(activity) {

  @Command
  fun pickFolder(invoke: Invoke) {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
    startActivityForResult(invoke, intent, "handlePickFolder")
  }

  @ActivityCallback
  fun handlePickFolder(invoke: Invoke, result: ActivityResult) {
    if (result.resultCode != Activity.RESULT_OK) {
      // ユーザーがキャンセルした場合。デスクトップの保存ダイアログを
      // キャンセルした場合と同じく、エラーではなく「未選択」として返す。
      val r = JSObject()
      r.put("treeUri", null as String?)
      r.put("folderName", null as String?)
      invoke.resolve(r)
      return
    }
    val uri = result.data?.data
    if (uri == null) {
      invoke.reject("no folder uri returned")
      return
    }
    try {
      activity.contentResolver.takePersistableUriPermission(
        uri,
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
      )
    } catch (_: SecurityException) {
      // 権限の永続化に失敗しても、今回のプロセス内では引き続き使えるので
      // ここでは失敗させない(次回起動時に再度選び直しになるだけ)。
    }
    val doc = DocumentFile.fromTreeUri(activity, uri)
    val r = JSObject()
    r.put("treeUri", uri.toString())
    r.put("folderName", doc?.name ?: uri.lastPathSegment ?: "")
    invoke.resolve(r)
  }

  @Command
  fun findFile(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(FindFileArgs::class.java)
      val tree = DocumentFile.fromTreeUri(activity, Uri.parse(args.treeUri))
        ?: throw IOException("invalid tree uri")
      val existing = tree.findFile(args.fileName)
      val r = JSObject()
      r.put("uri", existing?.uri?.toString())
      invoke.resolve(r)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "failed to check existing file")
    }
  }

  @Command
  fun createFile(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(CreateFileArgs::class.java)
      val tree = DocumentFile.fromTreeUri(activity, Uri.parse(args.treeUri))
        ?: throw IOException("invalid tree uri")
      val created = tree.createFile(args.mimeType ?: "application/octet-stream", args.fileName)
        ?: throw IOException("failed to create file: ${args.fileName}")

      // 一部プロバイダは拡張子の補完・変更を行うことがあるため、
      // 指定した名前をそのまま信用せず実際の名前を読み戻す。
      val r = JSObject()
      r.put("uri", created.uri.toString())
      r.put("displayName", created.name ?: args.fileName)
      invoke.resolve(r)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "failed to create file")
    }
  }

  // バッチ出力向け。findFile() を出力ファイル数だけ繰り返すと
  // (DocumentFile.findFile() は内部で毎回 listFiles() 相当を行うため)
  // O(件数 × フォルダ内ファイル数) になってしまう。事前に一度だけ
  // フォルダの中身を列挙し、フロント側でまとめて突き合わせる。
  @Command
  fun listFolderNames(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ListFolderNamesArgs::class.java)
      val tree = DocumentFile.fromTreeUri(activity, Uri.parse(args.treeUri))
        ?: throw IOException("invalid tree uri")
      val names = tree.listFiles().mapNotNull { it.name }
      val r = JSObject()
      r.put("names", JSArray(names))
      invoke.resolve(r)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "failed to list folder contents")
    }
  }
}
