# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# --- Tauri (app.tauri.*) ------------------------------------------------
# Tauri の Rust 側ランタイムは JNI 経由で Kotlin の @TauriPlugin /
# @Command / @InvokeArg が付いたクラス・メソッド・フィールドを実行時に
# リフレクションで探して呼び出す。ソースコード上に静的な呼び出し箇所が
# 無いため、R8 (full mode) が「使われていない」と判断して削除・改名
# ("public *;" レベルの keep では 不十分 -- private フィールド/引数
# クラスのメンバも含めて JNI 側から名前で参照される) してしまうと、
# 圧縮ONの release ビルドでのみ "アプリで開く" / 圧縮 / SAF フォルダ
# 保存 等の機能がクラッシュまたは無反応になる。
# 該当アノテーション付きクラス・メンバは丸ごと keep する。
-keep @app.tauri.annotation.TauriPlugin class * { *; }
-keepclassmembers class * {
    @app.tauri.annotation.Command <methods>;
}
-keep @app.tauri.annotation.InvokeArg class * { *; }
-keepclassmembers class * {
    @app.tauri.annotation.InvokeArg <fields>;
}
# app.tauri.* ランタイム本体(コアライブラリ側)もリフレクションで
# 相互参照するため、安全側で丸ごと除外対象から外す。
-keep class app.tauri.** { *; }
-dontwarn app.tauri.**

# アプリ独自の Tauri プラグインクラス自体も明示的に keep(上の
# @TauriPlugin ルールと重複するが、アノテーション経由の keep が
# 何らかの理由で効かない場合の保険として明示しておく)。
-keep class phoepsilonix.pdfkozou.MainActivity { *; }
-keep class phoepsilonix.pdfkozou.SafFolderPlugin { *; }
-keep class phoepsilonix.pdfkozou.MediaStorePlugin { *; }
-keep class phoepsilonix.pdfkozou.FsInfoPlugin { *; }
-keep class phoepsilonix.pdfkozou.PendingFilesPlugin { *; }

# JNI (external fun / native method) を含むクラス自体は
# proguard-android-optimize.txt のデフォルトルールで既に keep
# されるが、明示しておく。
-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}

# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile