// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// iOS: バッチ出力の保存先フォルダを選ぶためのドキュメントピッカー。
//
// tauri-plugin-dialog はモバイルでフォルダ選択を提供しないため、アプリ本体に
// 最小のSwiftを置き、Rust(src-tauri/src/platform/ios_folder.rs)から
// C ABI(@_cdecl)経由で呼ぶ。Tauriのプラグイン機構は使わない。
//
// 選んだフォルダは security-scoped URL。startAccessingSecurityScopedResource() を
// 呼んだ状態を保持し続けるため、Rust 側は返されたパスに対して通常の std::fs で
// 読み書きできる(サブフォルダにもアクセス権は及ぶ)。新しいフォルダを選んだ時、
// 前のフォルダのアクセスは解放する。

import UIKit
import UniformTypeIdentifiers

/// 結果通知コールバック。`status`: 0=選択された / 1=キャンセル / 2=エラー。
/// `json` は UTF-8 の JSON 文字列(呼び出し中のみ有効。Rust 側で即コピーすること)。
///   status 0: {"path": "...", "name": "..."}
///   status 2: {"error": "..."}
public typealias KozouFolderPickerCallback = @convention(c) (
  UnsafeMutableRawPointer?, Int32, UnsafePointer<CChar>?
) -> Void

private final class KozouFolderPickerDelegate: NSObject, UIDocumentPickerDelegate {
  /// ピッカー表示中にデリゲートが解放されないよう保持する。
  static var active: KozouFolderPickerDelegate?
  /// アクセス中のフォルダ(次に選ぶまで保持)。
  static var accessedURL: URL?

  private let ctx: UnsafeMutableRawPointer?
  private let callback: KozouFolderPickerCallback

  init(ctx: UnsafeMutableRawPointer?, callback: @escaping KozouFolderPickerCallback) {
    self.ctx = ctx
    self.callback = callback
  }

  private func finish(_ status: Int32, _ payload: [String: String]) {
    KozouFolderPickerDelegate.active = nil
    let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{}".utf8)
    let text = String(data: data, encoding: .utf8) ?? "{}"
    text.withCString { callback(ctx, status, $0) }
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let url = urls.first else {
      finish(1, [:])
      return
    }
    // 前回のフォルダへのアクセスを解放してから、今回のフォルダを開く。
    if let prev = KozouFolderPickerDelegate.accessedURL, prev != url {
      prev.stopAccessingSecurityScopedResource()
    }
    guard url.startAccessingSecurityScopedResource() else {
      KozouFolderPickerDelegate.accessedURL = nil
      finish(2, ["error": "選択したフォルダへのアクセス権を取得できませんでした"])
      return
    }
    KozouFolderPickerDelegate.accessedURL = url
    finish(0, ["path": url.path, "name": url.lastPathComponent])
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finish(1, [:])
  }
}

/// 最前面の ViewController を取得する(モーダル表示中ならその上に重ねる)。
private func kozouTopViewController() -> UIViewController? {
  let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
  let windows = scenes.flatMap { $0.windows }
  var top = (windows.first(where: { $0.isKeyWindow }) ?? windows.first)?.rootViewController
  while let presented = top?.presentedViewController {
    top = presented
  }
  return top
}

/// フォルダ選択ピッカーを表示する。結果は `callback` で(メインスレッドから)通知する。
@_cdecl("kozou_ios_pick_folder")
public func kozou_ios_pick_folder(
  _ ctx: UnsafeMutableRawPointer?,
  _ callback: @escaping KozouFolderPickerCallback
) {
  DispatchQueue.main.async {
    guard let presenter = kozouTopViewController() else {
      let text = "{\"error\":\"表示可能な画面が見つかりません\"}"
      text.withCString { callback(ctx, 2, $0) }
      return
    }
    // asCopy: false → 選んだフォルダそのものへの security-scoped URL が得られる。
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder], asCopy: false)
    picker.allowsMultipleSelection = false
    let delegate = KozouFolderPickerDelegate(ctx: ctx, callback: callback)
    KozouFolderPickerDelegate.active = delegate
    picker.delegate = delegate
    picker.modalPresentationStyle = .fullScreen
    presenter.present(picker, animated: true, completion: nil)
  }
}
