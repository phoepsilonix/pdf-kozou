// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------
//
// FsInfoPlugin.kt
//
// SAF (Storage Access Framework) が返す content:// URI から、元のファイル名
// (日本語等の Unicode を含む) を取得するための最小限のネイティブプラグイン。
//
// なぜ必要か:
//   content:// URI の末尾セグメント(ドキュメントID)は、プロバイダによって
//   フォーマットが異なる。ExternalStorageProvider (例: 「ダウンロード」の
//   一部の実装) はパスをそのまま含む ID を返すが、MediaStore 由来の
//   ドキュメントプロバイダ (Google フォト等) は "msf:1000000123" のような
//   完全に不透明な ID を返すことがあり、この場合 URI をいくら
//   percent-decode してもファイル名は復元できない。
//
//   正しいファイル名を得る唯一の方法は、Android の ContentResolver に
//   OpenableColumns.DISPLAY_NAME を問い合わせること
//   (ContentResolver は Cursor 越しに通常の Kotlin String を返すため、
//   日本語を含む任意の Unicode ファイル名も正しく取得できる)。

package phoepsilonix.pdfkozou

import android.net.Uri
import android.provider.OpenableColumns
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class GetDisplayNameArgs {
  lateinit var uri: String
}

@TauriPlugin
class FsInfoPlugin(private val activity: android.app.Activity) : Plugin(activity) {

  @Command
  fun getDisplayName(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(GetDisplayNameArgs::class.java)
      val uri = Uri.parse(args.uri)

      var name: String? = null
      val projection = arrayOf(OpenableColumns.DISPLAY_NAME)
      val cursor = activity.contentResolver.query(uri, projection, null, null, null)
      cursor?.use {
        if (it.moveToFirst()) {
          val idx = it.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (idx >= 0) {
            name = it.getString(idx)
          }
        }
      }

      val result = JSObject()
      result.put("name", name)
      invoke.resolve(result)
    } catch (ex: Exception) {
      // 呼び出し元 (Rust) はこれを「取得できなかった」として扱い、
      // 従来の URI ベースの推測にフォールバックする。
      invoke.reject(ex.message ?: "failed to query display name")
    }
  }
}
