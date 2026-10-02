// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// iOS: バッチ出力の保存先フォルダを選ぶためのドキュメントピッカー。
//
// tauri-plugin-dialog はモバイルでフォルダ選択を提供しないため、最小の
// Objective-C を Rust クレートにそのまま組み込む(build.rs が `cc` でコンパイル)。
// Xcode のアプリターゲット側ではなく Rust のライブラリ側に置くのは、cargo が
// アプリの Rust ライブラリ(cdylib)をリンクする時点でシンボルが解決できる必要が
// あるため。Rust 側は src/platform/ios_folder.rs。
//
// 選んだフォルダは security-scoped URL。startAccessingSecurityScopedResource を
// 呼んだ状態を保持し続けるので、Rust 側は返されたパスに対して通常の std::fs で
// 読み書きできる(サブフォルダにもアクセス権は及ぶ)。新しいフォルダを選んだ時、
// 前のフォルダのアクセスは解放する。

#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

// status: 0=選択された / 1=キャンセル / 2=エラー。
// json は UTF-8 の JSON 文字列(呼び出し中のみ有効。Rust 側で即コピーすること)。
//   status 0: {"path": "...", "name": "..."}
//   status 2: {"error": "..."}
typedef void (*KozouFolderPickerCallback)(void *ctx, int32_t status, const char *json);

@interface KozouFolderPickerDelegate : NSObject <UIDocumentPickerDelegate>
@property(nonatomic, assign) void *ctx;
@property(nonatomic, assign) KozouFolderPickerCallback callback;
@end

// ピッカー表示中にデリゲートが解放されないよう保持する。
static KozouFolderPickerDelegate *gActiveDelegate = nil;
// アクセス中のフォルダ(次に選ぶまで保持)。
static NSURL *gAccessedURL = nil;

static void KozouFinish(KozouFolderPickerDelegate *delegate, int32_t status, NSDictionary *payload) {
  gActiveDelegate = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  NSString *text = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
  delegate.callback(delegate.ctx, status, (text ?: @"{}").UTF8String);
}

@implementation KozouFolderPickerDelegate

- (void)documentPicker:(UIDocumentPickerViewController *)controller
    didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
  NSURL *url = urls.firstObject;
  if (url == nil) {
    KozouFinish(self, 1, @{});
    return;
  }
  // 前回のフォルダへのアクセスを解放してから、今回のフォルダを開く。
  if (gAccessedURL != nil && ![gAccessedURL isEqual:url]) {
    [gAccessedURL stopAccessingSecurityScopedResource];
  }
  if (![url startAccessingSecurityScopedResource]) {
    gAccessedURL = nil;
    KozouFinish(self, 2, @{@"error" : @"選択したフォルダへのアクセス権を取得できませんでした"});
    return;
  }
  gAccessedURL = url;
  KozouFinish(self, 0, @{@"path" : url.path ?: @"", @"name" : url.lastPathComponent ?: @""});
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller {
  KozouFinish(self, 1, @{});
}

@end

// 最前面の ViewController を取得する(モーダル表示中ならその上に重ねる)。
static UIViewController *KozouTopViewController(void) {
  UIWindow *window = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) {
      continue;
    }
    UIWindowScene *windowScene = (UIWindowScene *)scene;
    for (UIWindow *w in windowScene.windows) {
      if (w.isKeyWindow) {
        window = w;
        break;
      }
    }
    if (window == nil) {
      window = windowScene.windows.firstObject;
    }
    if (window != nil) {
      break;
    }
  }
  UIViewController *top = window.rootViewController;
  while (top.presentedViewController != nil) {
    top = top.presentedViewController;
  }
  return top;
}

// フォルダ選択ピッカーを表示する。結果は callback で(メインスレッドから)通知する。
// 任意のスレッドから呼べる。
void kozou_ios_pick_folder(void *ctx, KozouFolderPickerCallback callback) {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *presenter = KozouTopViewController();
    if (presenter == nil) {
      callback(ctx, 2, "{\"error\":\"表示可能な画面が見つかりません\"}");
      return;
    }
    // asCopy:NO → 選んだフォルダそのものへの security-scoped URL が得られる。
    UIDocumentPickerViewController *picker =
        [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[ UTTypeFolder ]
                                                                    asCopy:NO];
    picker.allowsMultipleSelection = NO;
    KozouFolderPickerDelegate *delegate = [[KozouFolderPickerDelegate alloc] init];
    delegate.ctx = ctx;
    delegate.callback = callback;
    gActiveDelegate = delegate;
    picker.delegate = delegate;
    picker.modalPresentationStyle = UIModalPresentationFullScreen;
    [presenter presentViewController:picker animated:YES completion:nil];
  });
}
