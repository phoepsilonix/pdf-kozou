// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

/// iOS: フォルダ選択ピッカー(Objective-C)を Rust ライブラリへ組み込む。
///
/// アプリの Rust ライブラリは cargo が単体でリンクするため、Xcode のアプリ
/// ターゲット側にネイティブコードを置くとシンボル未解決でリンクに失敗する
/// (`_kozou_ios_pick_folder` が見つからない)。そこで `cc` で一緒にコンパイルする。
fn build_ios_native() {
    println!("cargo:rerun-if-changed=ios/kozou_folder_picker.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("ios") {
        return;
    }
    cc::Build::new()
        .file("ios/kozou_folder_picker.m")
        .flag("-fobjc-arc")
        .flag("-fmodules")
        // UTType などの iOS 14+ API を使う(Podfile / ビルド設定の 15.0 に合わせる)
        .flag("-miphoneos-version-min=15.0")
        .warnings(false)
        .compile("kozou_ios_native");
    println!("cargo:rustc-link-lib=framework=UIKit");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=UniformTypeIdentifiers");
}

fn main() {
    build_ios_native();
    if cfg!(debug_assertions) {
        println!("DEV BUILD");
        tauri_build::build();
    } else {
        let mut windows = tauri_build::WindowsAttributes::new();

        windows = windows.app_manifest(
            r#"
            <assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
            <dependency>
        <dependentAssembly>
          <assemblyIdentity
            type="win32"
            name="Microsoft.Windows.Common-Controls"
            version="6.0.0.0"
            processorArchitecture="*"
            publicKeyToken="6595b64144ccf1df"
            language="*"
          />
        </dependentAssembly>
      </dependency>
            <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
                <security>
                    <requestedPrivileges>
                        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
                    </requestedPrivileges>
                </security>
            </trustInfo>
            </assembly>
        "#,
        );

        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("failed to run build script");
    };
}
