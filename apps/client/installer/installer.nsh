; NSIS Custom Installer Hooks for Lumina Drift (.lumina File Association & Windows Explorer IThumbnailProvider)
!ifndef BUILD_UNINSTALLER
!define MUI_CUSTOMFUNCTION_GUIINIT LuminaGlassGuiInit
Var LuminaGlassModule
Var LuminaAction
Var LuminaProgress
Var LuminaResult
Var LuminaIsUpdate
InstallButtonText "$LuminaAction"

!macro customHeader
  Function LuminaGlassGuiInit
    ${If} ${Silent}
      Return
    ${EndIf}
    InitPluginsDir
    File "/oname=$PLUGINSDIR\LuminaGlassUI.dll" "${PROJECT_DIR}\resources\installer\LuminaGlassUI.dll"
    File "/oname=$PLUGINSDIR\lumina-icon.png" "${PROJECT_DIR}\resources\icon.png"
    ; NSIS 3.04 accepts quoted paths as arguments to LoadLibraryW.
    System::Call 'kernel32::LoadLibraryW(w "$PLUGINSDIR\LuminaGlassUI.dll") p .s'
    Pop $LuminaGlassModule
    ${If} $LuminaGlassModule != 0
      System::Call 'LuminaGlassUI.dll::AttachInstallerGlass(p $HWNDPARENT, w "$PLUGINSDIR\lumina-icon.png") v'
    ${EndIf}
  FunctionEnd

  Function .onGUIEnd
    ${If} ${Silent}
      Return
    ${EndIf}
    ${If} $LuminaGlassModule != ""
    ${AndIf} $LuminaGlassModule != 0
      System::Call 'LuminaGlassUI.dll::DetachInstallerGlass() v ?u'
    ${EndIf}
  FunctionEnd
!macroend
!endif

; This hook runs before electron-builder inserts its license page.
!macro customWelcomePage
  !define MUI_LICENSEPAGE_CHECKBOX
!macroend

!macro luminaInstallerText install update installing updating installed updated
  ${If} $LuminaIsUpdate == 1
    StrCpy $LuminaAction "${update}"
    StrCpy $LuminaProgress "${updating}"
    StrCpy $LuminaResult "${updated}"
  ${Else}
    StrCpy $LuminaAction "${install}"
    StrCpy $LuminaProgress "${installing}"
    StrCpy $LuminaResult "${installed}"
  ${EndIf}
!macroend

!macro customInit
  StrCpy $LuminaIsUpdate 0
  ${If} ${isUpdated}
  ${OrIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrCpy $LuminaIsUpdate 1
  ${EndIf}
  ${Switch} $LANGUAGE
    ${Case} 1028 ; zh-TW
      !insertmacro luminaInstallerText "安裝" "更新" "正在安裝 Lumina Drift" "正在更新 Lumina Drift" "安裝完成" "更新完成"
      ${Break}
    ${Case} 2052 ; zh-CN
      !insertmacro luminaInstallerText "安装" "更新" "正在安装 Lumina Drift" "正在更新 Lumina Drift" "安装完成" "更新完成"
      ${Break}
    ${Case} 1041 ; ja-JP
      !insertmacro luminaInstallerText "インストール" "更新" "Lumina Drift をインストール中" "Lumina Drift を更新中" "インストール完了" "更新完了"
      ${Break}
    ${Default}
      !insertmacro luminaInstallerText "&Install" "&Update" "Installing Lumina Drift" "Updating Lumina Drift" "Installation complete" "Update complete"
  ${EndSwitch}
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_HEADER_TEXT "$LuminaProgress"
  !define MUI_PAGE_HEADER_SUBTEXT "${PRODUCT_NAME} ${VERSION}"
!macroend

!macro customFinishPage
  Function LuminaStartApp
    ${If} ${isUpdated}
      StrCpy $1 "--updated"
    ${Else}
      StrCpy $1 ""
    ${EndIf}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_TITLE "$LuminaResult"
  !define MUI_FINISHPAGE_TEXT "${PRODUCT_NAME} ${VERSION}"
  !ifndef HIDE_RUN_AFTER_FINISH
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "LuminaStartApp"
  !endif
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customInstall
  ; Register .lumina IThumbnailProvider COM Shell Extension (x64) if bundled in resources
  IfFileExists "$INSTDIR\resources\LuminaThumbProvider.dll" 0 +6
    WriteRegStr HKCU "Software\Classes\CLSID\{8E4A9D21-5C7B-4F3A-9B1E-6D2C8A4F0E19}" "" "Lumina Drift Thumbnail Provider"
    WriteRegStr HKCU "Software\Classes\CLSID\{8E4A9D21-5C7B-4F3A-9B1E-6D2C8A4F0E19}\InprocServer32" "" "$INSTDIR\resources\LuminaThumbProvider.dll"
    WriteRegStr HKCU "Software\Classes\CLSID\{8E4A9D21-5C7B-4F3A-9B1E-6D2C8A4F0E19}\InprocServer32" "ThreadingModel" "Apartment"
    WriteRegStr HKCU "Software\Classes\.lumina\ShellEx\{e357fccd-a995-4576-b01f-234630154e96}" "" "{8E4A9D21-5C7B-4F3A-9B1E-6D2C8A4F0E19}"
    ExecWait 'regsvr32.exe /s "$INSTDIR\resources\LuminaThumbProvider.dll"'

  ; Notify Windows Shell to refresh file icons and thumbnails immediately (SHCNE_ASSOCCHANGED)
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  IfFileExists "$INSTDIR\resources\LuminaThumbProvider.dll" 0 +2
    ExecWait 'regsvr32.exe /u /s "$INSTDIR\resources\LuminaThumbProvider.dll"'
  DeleteRegKey HKCU "Software\Classes\CLSID\{8E4A9D21-5C7B-4F3A-9B1E-6D2C8A4F0E19}"
  DeleteRegKey HKCU "Software\Classes\.lumina\ShellEx\{e357fccd-a995-4576-b01f-234630154e96}"
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
