package phoepsilonix.pdfkozou

import android.content.Intent
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 「アプリで開く(Open with)」「共有(Share)」経由でのコールドスタート。
    PendingFilesPlugin.handleIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    // launchMode="singleTask" のため、既に起動中のインスタンスへ
    // 新しい共有/Open with が来た場合はこちらが呼ばれる。
    setIntent(intent)
    PendingFilesPlugin.handleIntent(intent)
  }
}
