# PDF小僧 ライセンス情報

## 本ソフトウェア（PDF小僧）

Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0)  
Full license: AGPL-3.0-or-later.txt

本アプリはMuPDFを基盤とし、Tauriなどで構築されています。  
すべてのソースコードはGitHubで公開しています。

## 主なサードパーティライブラリ

- **MuPDF + mupdf / mupdf-sys**  
  Copyright (C) Artifex Software, Inc. + messense  
  License: AGPL-3.0  
  https://github.com/messense/mupdf-rs  
  （マルチプラットフォーム向けフォーク・調整部分もAGPL-3.0で提供）

- **Tauri**  
  Copyright (C) Tauri Contributors  
  License: MIT or Apache-2.0 (dual)  
  https://github.com/tauri-apps/tauri

- その他すべての依存クレート  
  （cargo tree -f "{p} {l}" で一覧取得し、以下に記載 or 別ファイルで全ライセンステキストをbundle）
  例: serde (MIT/Apache-2.0), tokio (MIT), etc.

詳細な全依存ライセンスは THIRD-PARTY.ymlを参照してください。
