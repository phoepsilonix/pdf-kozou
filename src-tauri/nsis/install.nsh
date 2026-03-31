; install.nsh

!macro NSIS_HOOK_POSTINSTALL
  ; both モードの選択結果（all または current）に合わせてコンテキストを切り替え
  ${If} $MultiUser.InstallMode == "AllUsers"
    SetShellVarContext all
  ${Else}
    SetShellVarContext current
  ${EndIf}

  DetailPrint "Installing libraries..."
  SetOutPath $INSTDIR
  File ..\..\WebView2Loader.dll
  ;File ..\..\pdf-kozou-core.exe

  DetailPrint "library installation complete to: $INSTDIR"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; both モードの選択結果（all または current）に合わせてコンテキストを切り替え
  ${If} $MultiUser.InstallMode == "AllUsers"
    SetShellVarContext all
  ${Else}
    SetShellVarContext current
  ${EndIf}
  ; インストールしたファイルを削除
  Delete "$INSTDIR\WebView2Loader.dll"
  ;Delete "$INSTDIR\pdf-kozou-core.exe"

  DetailPrint "library uninstallation complete to: $INSTDIR"
!macroend
