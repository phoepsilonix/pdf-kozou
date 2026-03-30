param (
    [Parameter(Mandatory=$true)]
    [string]$PfxPassword
)

# 1. package.json からバージョンを取得
if (Test-Path "package.json") {
    $packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json
    $PackageVersion = $packageJson.version
    Write-Host "--- Detected Version from package.json: $PackageVersion ---"
} else {
    Write-Error "package.json not found!"
    exit 1
}

# --- 設定セクション ---
$SourceDir = "target\release\ready_to_pack"
$PublisherId = "CN=1CB57BC7-DF63-47F3-83C8-6A33A692A2CF"
$PackageName = "phoepsilonix.PDF-Kozou"
# パラメータを使ってパスとマニフェスト用バージョンを生成
$targetMsix = "target\release\bundle\msi\PDF-Kozou_${PackageVersion}_universal.msix"
$manifestVersion = "${PackageVersion}.0" # MSIX用 (x.x.x.0)

#$pfxPath = "pdf-kozou.pfx" 
# github workflow secretsから生成
$pfxPath = "src-tauri/gen/windows/dev.pfx"
$pfxPassword = $PfxPassword

# --- ツールパスの自動取得 (これがないと '&' でエラーになります) ---
$makeAppx = Get-ChildItem -Path "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\makeappx.exe" | Select-Object -First 1 -ExpandProperty FullName
$signtool = Get-ChildItem -Path "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe" | Select-Object -First 1 -ExpandProperty FullName

if (-not $makeAppx -or -not $signtool) {
    Write-Error "Windows SDK tools (makeappx or signtool) not found! Please install Windows 10/11 SDK."
    exit 1
}

Write-Host "--- Creating Universal MSIX (ja-JP & en-US) ---"

# 1. Assetsフォルダの作成
New-Item -Path "$SourceDir\Assets" -ItemType Directory -Force -ErrorAction SilentlyContinue

# 2. 実行ファイルのコピー
Copy-Item "target\release\pdf-kozou.exe" -Destination "$SourceDir\" -Force
Copy-Item "target\release\pdf-kozou-core.exe" -Destination "$SourceDir\" -Force
Copy-Item "target\release\WebView2Loader.dll" -Destination "$SourceDir\" -Force

# 3. アイコンのコピー（Tauri標準のパスから）
if (Test-Path "src-tauri\icons") {
    Get-ChildItem "src-tauri\icons\*.png" | Copy-Item -Destination "$SourceDir\Assets\" -Force
}

# Wide310x150Logo.png がない場合に作成 (ImageMagickを使用)
$wideLogoPath = "$SourceDir\Assets\Wide310x150Logo.png"
if (-not (Test-Path $wideLogoPath)) {
    Write-Host "--- Generating Wide Logo using ImageMagick ---"
    # 150x150のロゴを中央に配置して310x150に広げる
    magick "public\app-icon.svg" -resize 150x150 -gravity center -background transparent -extent 310x150 $wideLogoPath
}


# 1. マニフェスト作成
$xml = @"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities" IgnorableNamespaces="uap rescap">
  <Identity Name="$PackageName" Publisher="$PublisherId" Version="$manifestVersion" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>PDF-Kozou</DisplayName>
    <PublisherDisplayName>phoepsilonix</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Resources>
    <Resource Language="ja-JP" />
    <Resource Language="en-US" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>
  <Applications>
    <Application Id="App" Executable="pdf-kozou.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="PDF-Kozou" Description="PDF-Kozou" BackgroundColor="transparent" Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\Wide310x150Logo.png" />
      </uap:VisualElements>
    </Application>
  </Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>
"@
[System.IO.File]::WriteAllText("$SourceDir/AppxManifest.xml", $xml)

# 2. パッキング
& "$makeAppx" pack /d "$SourceDir" /p "$targetMsix" /o /v

# 3. 署名
# --- 修正版：署名セクション ---
Write-Host "--- Signing Universal MSIX ---"

# 1. すべての引数を配列として定義する（スペース問題を回避）
$signArgs = @(
    "sign",
    "/fd", "SHA256",
    "/f", "$pfxPath",
    "/p", "$pfxPassword",
    "/v",
    "$targetMsix"
)

# 2. 実行（ツールのフルパスを確実に引用符で囲む）
& "$signtool" $signArgs

if ($LASTEXITCODE -eq 0) {
    Write-Host "--- Success! ---"
    Write-Host "Please upload this single file to Microsoft Store:"
    Write-Host "$targetMsix"
    # 署名の詳細を表示して検証するコマンド
    & "$signtool" verify /pa /v "$targetMsix"
} else {
    Write-Error "SignTool failed with exit code $LASTEXITCODE"
}
