// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------
//
// PendingFilesPlugin.kt
//
// 「共有(Share)」または「アプリで開く(Open with)」で PDF小僧に渡された
// ファイルの URI (content:// / file://) を受け取るための最小限のネイティブ
// ブリッジ。
//
// なぜこの設計か:
//   Intent (ACTION_VIEW / ACTION_SEND / ACTION_SEND_MULTIPLE) は
//   MainActivity にしか届かない。フロントエンドの起動タイミング
//   (コールドスタートではJS側のリスナー登録がまだ間に合っていない)や、
//   すでにアプリが起動中("singleTask" のため onNewIntent 経由で通知
//   される場合)のどちらでも取りこぼさないよう、プッシュ通知
//   (trigger)ではなく単純な静的キューに溜めておき、Rust/フロント側が
//   都合の良いタイミング(起動時・ウィンドウフォーカス時)で
//   `getPendingFiles` により能動的にドレインする方式にしている。
//
//   読み取り権限は Intent の FLAG_GRANT_READ_URI_PERMISSION により
//   このタスクが生存している間は有効なため、キューには URI文字列の
//   ままで保持しておき、実際のバイト読み込みは Rust 側の
//   `getPendingFiles` 呼び出し後(= フロントが処理できるタイミング)に
//   行う。

package phoepsilonix.pdfkozou

import android.app.Activity
import android.content.Intent
import android.net.Uri
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin
class PendingFilesPlugin(private val activity: Activity) : Plugin(activity) {

  @Command
  fun getPendingFiles(invoke: Invoke) {
    val r = JSObject()
    r.put("paths", JSArray(drain()))
    invoke.resolve(r)
  }

  companion object {
    private val pending = mutableListOf<String>()

    @Synchronized
    private fun drain(): List<String> {
      val out = pending.toList()
      pending.clear()
      return out
    }

    private fun extractUris(intent: Intent?): List<Uri> {
      if (intent == null) return emptyList()
      return when (intent.action) {
        Intent.ACTION_VIEW ->
          intent.data?.let { listOf(it) } ?: emptyList()
        Intent.ACTION_SEND -> {
          @Suppress("DEPRECATION")
          intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { listOf(it) }
            ?: emptyList()
        }
        Intent.ACTION_SEND_MULTIPLE -> {
          @Suppress("DEPRECATION")
          intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.toList()
            ?: emptyList()
        }
        else -> emptyList()
      }
    }

    // MainActivity の onCreate / onNewIntent から呼ぶ。
    // Open with / 共有(Share)で渡されたファイルの URI をキューへ積む。
    @Synchronized
    fun handleIntent(intent: Intent?) {
      val uris = extractUris(intent)
      if (uris.isEmpty()) return
      pending.addAll(uris.map { it.toString() })
    }
  }
}
