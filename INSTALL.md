# インストールガイド

## CLI ツール (pdf-kozou-core)

### Linux

7zip版アーカイブをダウンロード。

```sh
wget https://github.com/phoepsilonix/pdf-kozou/releases/download/v1.5.4/PDF-Kozou_1.5.4_amd64-linux.7z
7z x PDF-Kozou_1.5.4_amd64-linux.7z
./PDF-Kozou/pdf-kozou
```

```sh
# パスの通った場所に配置 (例)
sudo mv PDF-Kozou/pdf-kozou-core /usr/local/bin/

# 動作確認
pdf-kozou-core --version
```

### Windows

https://github.com/phoepsilonix/pdf-kozou/releases/download/v1.5.4/PDF-Kozou_1.5.4_x64-setup.exe

1. インストーラーをダウンロード
2. インストール先のフォルダ`pdf-kozou-core.exe` のあるフォルダを**システムの環境変数 PATH** に追加
   - スタートメニュー →「環境変数を編集」→ Path → 新規
3. コマンドプロンプト / PowerShell で確認:
   ```
   pdf-kozou-core --version
   ```

### macOS

未定

---

## デスクトップ GUI

### Linux

`webkit2gtk-4.1`があれば、7-zip版アーカイブのバイナリも動作するかもしれません。Arch系でも動いています。

```sh
wget https://github.com/phoepsilonix/pdf-kozou/releases/download/v1.5.4/PDF-Kozou_1.5.4_amd64-linux.7z
7z x PDF-Kozou_1.5.4_amd64-linux.7z
./PDF-Kozou/pdf-kozou
```

環境によって制約がありますがAppImage版。

```bash
wget https://github.com/phoepsilonix/pdf-kozou/releases/download/v1.5.4/PDF-Kozou_1.5.4_amd64.AppImage
# AppImage
chmod +x PDF-Kozou_1.5.4_amd64.AppImage
./PDF-Kozou_1.5.4_amd64.AppImage
```

### Windows

[MicrosoftStore](https://apps.microsoft.com/detail/9P2HDLPTT5WR?hl=ja-jp&gl=JP&ocid=pdpshare)からインストールできます。  
Githubからの場合には`PDF-Kozou_1.5.4_x64-setup.exe`または`PDF-Kozou_1.5.4_x64_ja-JP.msi`をダウンロードして、インストールしてください。

### macOS

未定

---

## Web 版（未定）

未定。

---

## アンインストール

Windows版は、Windowsの設定画面のアプリから、アンインストールできます。  
Linux版は、バイナリを削除してください。

### CLI

配置した `pdf-kozou-core` (または `pdf-kozou-core.exe`) を削除するだけです。

### cargo でインストールした場合

```bash
cargo uninstall pdf-kozou-core
```

### Windows インストーラ版

「設定」→「アプリ」→「pdf-kozou」→「アンインストール」
