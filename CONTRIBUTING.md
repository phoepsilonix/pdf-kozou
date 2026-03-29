# コントリビューションガイド

バグ報告・機能提案・コードの改善、いずれも歓迎します。

## バグ報告

[GitHub Issues](https://github.com/phoepsilonix/pdf-kozou/issues) に以下の情報を添えて報告してください:

- OS・バージョン (例: Ubuntu 24.04, Windows 11)
- pdf-kozou-core のバージョン (`pdf-kozou-core --version`)
- 再現手順と実際の出力
- 期待していた動作

## 機能提案

Issues で `enhancement` ラベルを付けて提案してください。

## プルリクエスト

1. リポジトリを Fork
2. `git checkout -b feature/your-feature` でブランチを作成
3. 変更をコミット
4. Fork 元の `main` ブランチに向けて PR を作成

### コードスタイル

```bash
# フォーマット確認
cargo fmt --check

# lint
cargo clippy -- -D warnings

# テスト
cargo test -p pdf-kozou-core
```

```sh
prettier -c src
```

```sh
prettier -w src
```

PR 作成前にこれらが通ることを確認してください。

## ライセンスについて

コントリビューションされたコードは、このプロジェクトのライセンス (AGPL-3.0) のもとで
公開されることに同意したものとみなします。
