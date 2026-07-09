// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------
//
// MediaStorePlugin.kt
//
// バッチ出力(複数ファイル書き出し)の結果を、ユーザーから見える
// 「ダウンロード」フォルダ配下へコピーするためのネイティブプラグイン。
//
// なぜこの方式か:
//   Android の SAF フォルダピッカー (ACTION_OPEN_DOCUMENT_TREE) を使えば
//   任意の場所を選ばせることもできるが、
//     - tauri-plugin-dialog はこの API を Android/iOS 向けに提供していない
//     - ツリーURIの永続化 (takePersistableUriPermission) や DocumentFile
//       経由の逐次書き込みなど実装量が大きい
//     - そもそもモバイルでは「毎回フォルダを選ばせる」UXが煩雑
//   という理由で今回は採用しない。
//
//   代わりに、Android 10 (API 29) 以降で使える
//   `MediaStore.Downloads` コレクションへ ContentResolver 経由で
//   直接書き込む方式を使う。この方式は:
//     - 権限ダイアログもフォルダピッカーも一切不要
//     - 「ダウンロード」フォルダ配下にサブフォルダ構造ごと見える形で
//       保存され、標準のファイルマネージャ/ダウンロードアプリから
//       たどれる
//     - アプリをアンインストールしてもファイルは残る (ユーザーの
//       成果物として自然な挙動)
//   という利点がある。

package phoepsilonix.pdfkozou

import android.content.ContentValues
import android.os.Build
import android.provider.MediaStore
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.IOException

@InvokeArg
class SaveFileArgs {
  lateinit var sourcePath: String
  lateinit var fileName: String
  /** "Download/" より下のパス。先頭・末尾のスラッシュは付けても付けなくても良い。 */
  lateinit var relativeDir: String
  var mimeType: String? = null
}

@TauriPlugin
class MediaStorePlugin(private val activity: android.app.Activity) : Plugin(activity) {

  @Command
  fun saveFile(invoke: Invoke) {
    // MediaStore.Downloads (と RELATIVE_PATH) は API 29 (Android 10) 以降のみ。
    // それより前のバージョンでは呼び出し元 (Rust) にエラーを返し、
    // 従来どおりアプリ専用の一時領域に留める(フォールバック)。
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      invoke.reject("MediaStore Downloads collection requires Android 10 (API 29) or later")
      return
    }

    try {
      val args = invoke.parseArgs(SaveFileArgs::class.java)
      val resolver = activity.contentResolver

      val trimmedSub = args.relativeDir.trim('/', ' ')
      val relPath = if (trimmedSub.isEmpty()) "Download/" else "Download/$trimmedSub/"

      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, args.fileName)
        put(MediaStore.MediaColumns.RELATIVE_PATH, relPath)
        args.mimeType?.let { put(MediaStore.MediaColumns.MIME_TYPE, it) }
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }

      val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
      val itemUri = resolver.insert(collection, values)
        ?: throw IOException("ContentResolver.insert() returned null")

      resolver.openOutputStream(itemUri).use { out ->
        if (out == null) throw IOException("openOutputStream() returned null")
        File(args.sourcePath).inputStream().use { input -> input.copyTo(out) }
      }

      val doneValues = ContentValues().apply {
        put(MediaStore.MediaColumns.IS_PENDING, 0)
      }
      resolver.update(itemUri, doneValues, null, null)

      // 実際に作成されたファイル名/パスを読み戻す。
      // 同名ファイルが既に存在する場合、システムが自動的に
      // "ファイル名 (1).pdf" のようにリネームすることがあるため、
      // こちらが指定した名前ではなく実際の結果を返す必要がある。
      var finalName = args.fileName
      var finalRelPath = relPath
      resolver.query(
        itemUri,
        arrayOf(MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.RELATIVE_PATH),
        null,
        null,
        null,
      )?.use { c ->
        if (c.moveToFirst()) {
          val nameIdx = c.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME)
          if (nameIdx >= 0) c.getString(nameIdx)?.let { finalName = it }
          val pathIdx = c.getColumnIndex(MediaStore.MediaColumns.RELATIVE_PATH)
          if (pathIdx >= 0) c.getString(pathIdx)?.let { finalRelPath = it }
        }
      }

      val result = JSObject()
      result.put("uri", itemUri.toString())
      result.put("displayName", finalName)
      result.put("relativePath", finalRelPath)
      invoke.resolve(result)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "failed to save file to Downloads")
    }
  }
}
